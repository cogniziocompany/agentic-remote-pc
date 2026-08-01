// ═══════════════════════════════════════════════════════════════════════════
//  agentic-remote-pc — Remote Agent Runner
//  Cognizio Company
//
//  Exposes a host's shells (PowerShell, CMD, bash, zsh) and a fleet of coding-
//  agent CLIs (Claude Code, Cursor, Aider, OpenCode, Gemini, Codex, Copilot,
//  Goose, Amp, Qwen, Crush) over HTTP. Two protocol heads share one engine
//  (src/runner.js):
//    • REST  — /exec, /claude, /cursor, /<agent>, /task, …  (scripts, curl, agents)
//    • MCP   — /mcp  (Streamable HTTP)  (ChatGPT, Codex, Claude, Cursor, Gemini)
//
//  Runs NATIVELY on a Windows or Linux host (not inside Docker) and can be
//  exposed through Cloudflare Tunnel or any self-hosted reverse tunnel you like.
// ═══════════════════════════════════════════════════════════════════════════

import 'dotenv/config';      // ← loads .env into process.env
import express from 'express';
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { hostname, platform } from 'os';

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpServer } from './mcp.js';

import {
  SHELL_MAP, safeExe, needsShell, spawnCli, MAX_TIMEOUT,
  ValidationError, ExecError,
  startShell, execShell, runClaude, runClaudeSession, runCursor, runCursorSession, runAider, runOpencode,
  runAgent, GENERIC_AGENT_NAMES,
  getTask, listTasks, clearTasks, healthPayload, infoPayload
} from './runner.js';

const app = express();
app.use(express.json({ limit: '5mb' }));

// ─── Configuration ──────────────────────────────────────────────────────────
const PORT    = parseInt(process.env.RUNNER_PORT, 10) || 7334;
const API_KEY = process.env.RUNNER_API_KEY || null;

// ─── Auth middleware ────────────────────────────────────────────────────────
// One static bearer protects everything except /health — REST and MCP alike.
// MCP clients (ChatGPT dev mode, Codex, Claude Code, Cursor, Gemini) all send
// this same `Authorization: Bearer <RUNNER_API_KEY>` header, so /mcp needs no
// extra auth.
function requireAuth(req, res, next) {
  if (req.path === '/health') return next();        // health check is always open
  if (!API_KEY) return next();                      // no key configured = open (dev mode)

  const auth = req.headers.authorization;
  const key  = req.headers['x-api-key'];

  // Accept the key however a client sends it: "Bearer <key>", a raw Authorization
  // value, or X-API-Key. ChatGPT's API-key connector mode is matched by all forms.
  if (auth && auth.startsWith('Bearer ') && auth.slice(7) === API_KEY) return next();
  if (auth && auth === API_KEY) return next();
  if (key && key === API_KEY) return next();

  return res.status(401).json({ error: 'Unauthorized', hint: 'Provide Authorization: Bearer <key> or X-API-Key header' });
}

app.use(requireAuth);

// Force an MCP-spec-compliant Accept header so the Streamable HTTP transport
// never 406s a client (e.g. a ChatGPT tools/list probe) that sends only
// application/json. The SDK reads req.rawHeaders via @hono/node-server, so the
// value must be patched there; req.headers is updated too for consistency.
function forceAcceptHeader(req) {
  const want = 'application/json, text/event-stream';
  const raw = req.rawHeaders;
  let found = false;
  for (let i = 0; i < raw.length; i += 2) {
    if (raw[i].toLowerCase() === 'accept') { raw[i + 1] = want; found = true; }
  }
  if (!found) raw.push('Accept', want);
  req.headers['accept'] = want;
}

// Map a thrown runner error to the right HTTP response.
function sendError(res, err) {
  if (err instanceof ValidationError) return res.status(400).json({ error: err.message, ...err.extra });
  if (err instanceof ExecError)       return res.status(500).json({ error: err.message, ...err.payload });
  return res.status(500).json({ error: err.message });
}

// ═══════════════════════════════════════════════════════════════════════════
//  HEALTH & INFO
// ═══════════════════════════════════════════════════════════════════════════

app.get('/health', (req, res) => res.json(healthPayload()));
app.get('/info',   (req, res) => res.json(infoPayload()));

// ═══════════════════════════════════════════════════════════════════════════
//  COMMAND EXECUTION
// ═══════════════════════════════════════════════════════════════════════════

app.post('/exec', async (req, res) => {
  try {
    // Fire-and-forget — return a task id immediately
    if (req.query.async === 'true') return res.json(startShell(req.body));

    // Synchronous — wait for result (non-zero exit → 500, matching REST history)
    const result = await execShell(req.body);
    if (result.status === 'failed') return res.status(500).json(result);
    res.json(result);
  } catch (err) {
    sendError(res, err);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  STREAMING COMMAND EXECUTION (SSE)
// ═══════════════════════════════════════════════════════════════════════════

app.post('/exec/stream', (req, res) => {
  const { shell = 'pwsh', command, cwd, timeout, env } = req.body;

  if (!command) return res.status(400).json({ error: 'command is required' });

  const cfg = SHELL_MAP[shell];
  if (!cfg) return res.status(400).json({ error: `Unknown shell: ${shell}` });

  const taskId = randomUUID().slice(0, 8);
  const timeoutMs = Math.min(timeout || MAX_TIMEOUT, MAX_TIMEOUT);

  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Task-Id', taskId);

  const mergedEnv = { ...process.env, ...(env || {}) };
  const proc = spawnCli(cfg.exe, [...cfg.args, command], {
    cwd: cwd || process.cwd(),
    env: mergedEnv,
    windowsHide: true
  });

  let output = '';

  const timer = setTimeout(() => {
    proc.kill('SIGTERM');
    res.write(`event: error\ndata: ${JSON.stringify({ error: 'timeout', timeout_ms: timeoutMs })}\n\n`);
    res.end();
  }, timeoutMs);

  proc.stdout.on('data', (chunk) => {
    const text = chunk.toString();
    output += text;
    res.write(`event: stdout\ndata: ${JSON.stringify({ text })}\n\n`);
  });

  proc.stderr.on('data', (chunk) => {
    const text = chunk.toString();
    output += text;
    res.write(`event: stderr\ndata: ${JSON.stringify({ text })}\n\n`);
  });

  proc.on('close', (code) => {
    clearTimeout(timer);
    res.write(`event: done\ndata: ${JSON.stringify({ exitCode: code, taskId })}\n\n`);
    res.end();
  });

  proc.on('error', (err) => {
    clearTimeout(timer);
    res.write(`event: error\ndata: ${JSON.stringify({ error: err.message })}\n\n`);
    res.end();
  });

  req.on('close', () => {
    clearTimeout(timer);
    proc.kill('SIGTERM');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  CLAUDE CODE SHORTCUTS
// ═══════════════════════════════════════════════════════════════════════════

app.post('/claude', async (req, res) => {
  try { res.json(await runClaude(req.body)); }
  catch (err) { sendError(res, err); }
});

app.post('/claude/session', async (req, res) => {
  try { res.json(await runClaudeSession(req.body)); }
  catch (err) { sendError(res, err); }
});

// ═══════════════════════════════════════════════════════════════════════════
//  CURSOR CLI SHORTCUTS
// ═══════════════════════════════════════════════════════════════════════════

app.post('/cursor', async (req, res) => {
  try { res.json(await runCursor(req.body)); }
  catch (err) { sendError(res, err); }
});

app.post('/cursor/session', async (req, res) => {
  try { res.json(await runCursorSession(req.body)); }
  catch (err) { sendError(res, err); }
});

// ═══════════════════════════════════════════════════════════════════════════
//  AIDER + OPENCODE + GENERIC AGENT SHORTCUTS
// ═══════════════════════════════════════════════════════════════════════════

app.post('/aider', async (req, res) => {
  try { res.json(await runAider(req.body)); }
  catch (err) { sendError(res, err); }
});

app.post('/opencode', async (req, res) => {
  try { res.json(await runOpencode(req.body)); }
  catch (err) { sendError(res, err); }
});

// Data-driven shortcuts for every provider in AGENT_PROVIDERS (runner.js):
// /gemini, /codex, /copilot, /goose, /amp, /qwen, /crush. Each accepts
// { prompt, cwd?, model?, files? } and returns a task result.
for (const name of GENERIC_AGENT_NAMES) {
  app.post(`/${name}`, async (req, res) => {
    try { res.json(await runAgent({ name, ...req.body })); }
    catch (err) { sendError(res, err); }
  });
}

// ═══════════════════════════════════════════════════════════════════════════
//  TASK MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════

app.get('/task/:id', (req, res) => {
  try { res.json(getTask(req.params.id)); }
  catch (err) {
    if (err instanceof ValidationError) return res.status(404).json({ error: err.message });
    sendError(res, err);
  }
});

app.get('/tasks',    (req, res) => res.json(listTasks()));
app.delete('/tasks', (req, res) => res.json(clearTasks()));

// ═══════════════════════════════════════════════════════════════════════════
//  MCP — Model Context Protocol (Streamable HTTP transport, STATELESS)
//
//  Stateless on purpose: ChatGPT's backend is distributed and does NOT reliably
//  replay the mcp-session-id, so a session-based (stateful) server makes its
//  tools/list probe fail and ChatGPT reports "no functions". With
//  sessionIdGenerator:undefined the SDK skips session + initialize validation,
//  so a bare tools/list works. We spin up a fresh server+transport per POST and
//  return plain JSON. Protected by requireAuth above.
// ═══════════════════════════════════════════════════════════════════════════

async function handleMcpPost(req, res) {
  // The transport 406s any client whose Accept header lacks BOTH application/json
  // and text/event-stream. Some ChatGPT probes send only application/json, so we
  // force a spec-compliant Accept header (responses are JSON either way).
  // NOTE: the SDK's Node→Web conversion (@hono/node-server) reads req.rawHeaders,
  // NOT req.headers — so the Accept value must be patched in rawHeaders.
  forceAcceptHeader(req);

  try {
    const server = createMcpServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,   // stateless — no session handshake required
      enableJsonResponse: true         // respond with JSON, not an SSE stream
    });
    // Tear down the per-request server/transport when the response closes.
    res.on('close', () => { transport.close(); server.close(); });
    await server.connect(transport);

    // express.json() already parsed the body — hand it to the transport.
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: `Internal error: ${err.message || err}` },
        id: null
      });
    }
  }
}

// MCP is mounted at /mcp (canonical) AND at / (root) so the connector works
// whether or not the configured URL includes the /mcp path — a common and
// hard-to-spot setup mistake (e.g. a ChatGPT connector pointed at the bare
// domain). Both routes share one stateless handler.
app.post('/mcp', handleMcpPost);
app.post('/', handleMcpPost);

// Stateless server: no standalone SSE stream (GET) or session teardown (DELETE).
const mcpMethodNotAllowed = (req, res) => res.status(405).json({
  jsonrpc: '2.0',
  error: { code: -32000, message: 'Method Not Allowed: stateless MCP server, use POST /mcp' },
  id: null
});
app.get('/mcp', mcpMethodNotAllowed);
app.delete('/mcp', mcpMethodNotAllowed);

// ─── Error handler ───────────────────────────────────────────────────────────
// Return a proper JSON-RPC parse error (not Express's default HTML 400) when a
// client posts malformed JSON to an MCP endpoint (/mcp or the root alias);
// otherwise surface a generic 500.
app.use((err, req, res, _next) => {
  if (err && (err.type === 'entity.parse.failed' || err instanceof SyntaxError)) {
    if (req.path === '/mcp' || req.path === '/') {
      return res.status(400).json({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null });
    }
    return res.status(400).json({ error: 'Invalid JSON body' });
  }
  console.error('[error]', err?.stack || err?.message || err);
  if (!res.headersSent) res.status(500).json({ error: err?.message || 'Internal error' });
});

// ─── Start server ───────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('');
  console.log('╔═══════════════════════════════════════════════════════════╗');
  console.log('║  agentic-remote-pc — remote agent runner                 ║');
  console.log(`║  Listening on :${String(PORT).padEnd(42)}║`);
  console.log(`║  Platform:  ${platform().padEnd(45)}║`);
  console.log(`║  Hostname:  ${hostname().padEnd(45)}║`);
  console.log(`║  Auth:      ${(API_KEY ? 'API key required' : 'OPEN (no key set)').padEnd(45)}║`);
  console.log('║                                                           ║');
  console.log('║  Endpoints:                                               ║');
  console.log('║    POST /exec          — Run a shell/agent command         ║');
  console.log('║    POST /exec/stream   — Run with SSE streaming           ║');
  console.log('║    POST /claude        — Claude Code one-shot prompt      ║');
  console.log('║    POST /cursor        — Cursor agent one-shot prompt     ║');
  console.log('║    POST /aider         — Aider (open-source IDE)          ║');
  console.log('║    POST /opencode      — OpenCode (open-source IDE)       ║');
  console.log('║    POST /gemini        — Gemini CLI one-shot              ║');
  console.log('║    POST /codex         — Codex CLI one-shot               ║');
  console.log('║    POST /copilot       — GitHub Copilot CLI one-shot      ║');
  console.log('║    POST /goose         — Block Goose one-shot             ║');
  console.log('║    POST /amp           — Sourcegraph Amp one-shot         ║');
  console.log('║    POST /qwen          — Qwen Code one-shot               ║');
  console.log('║    POST /crush         — Charm Crush one-shot             ║');
  console.log('║    ALL  /mcp           — MCP (ChatGPT/Codex/Claude/Cursor)║');
  console.log('║    GET  /task/:id      — Get task result                  ║');
  console.log('║    GET  /tasks         — List all tasks                   ║');
  console.log('║    GET  /health        — Health check                     ║');
  console.log('║    GET  /info          — API documentation                ║');
  console.log('╚═══════════════════════════════════════════════════════════╝');
  console.log('');
  if (!API_KEY) {
    console.log('  ⚠  WARNING: No RUNNER_API_KEY set — server is OPEN.');
    console.log('  ⚠  Set RUNNER_API_KEY env var before exposing via a tunnel.');
    console.log('');
  }
});
