// ═══════════════════════════════════════════════════════════════════════════
//  Runner Engine — shared execution core
//  Cognizio Company
//
//  Plain (transport-agnostic) helpers that actually run things on the host.
//  Imported by BOTH protocol heads:
//    • src/server.js — REST routes (/exec, /claude, /cursor, …)
//    • src/mcp.js     — MCP tools (run_command, claude_prompt, …)
//
//  Keeping the engine here (instead of inside Express handlers) lets the REST
//  API and the MCP server share one implementation and avoids a circular
//  import between server.js and mcp.js.
// ═══════════════════════════════════════════════════════════════════════════

import { execFile, spawn } from 'child_process';
import { randomUUID, createHmac } from 'crypto';
import { hostname, platform, cpus, totalmem, freemem, uptime } from 'os';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

// On Windows, .cmd/.bat files need shell:true to spawn correctly.
// When shell:true is used, paths with spaces must be quoted.
const IS_WIN = platform() === 'win32';
export function needsShell(exe) {
  return IS_WIN && (exe.endsWith('.cmd') || exe.endsWith('.bat'));
}
export function safeExe(exe) {
  if (needsShell(exe) && exe.includes(' ') && !exe.startsWith('"')) {
    return `"${exe}"`;
  }
  return exe;
}

// ─── Configuration ──────────────────────────────────────────────────────────
export const PWSH_PATH   = process.env.PWSH_PATH   || 'pwsh';
export const CMD_PATH    = process.env.CMD_PATH    || 'cmd';
export const CLAUDE_PATH = process.env.CLAUDE_PATH || 'claude';
export const CURSOR_PATH = process.env.CURSOR_PATH || 'agent';
export const AIDER_PATH    = process.env.AIDER_PATH    || 'aider';
export const OPENCODE_PATH = process.env.OPENCODE_PATH || 'opencode';

// ─── Additional coding-agent CLIs (data-driven; paths & flags overridable) ──
// Each is exposed at /<name>, as an MCP tool (<name>_prompt), and as a `shell`
// option on /exec (run_command). promptArgs are the tokens prepended before the
// prompt; modelFlag (if set) becomes `--model <model>` when a model is supplied.
// Flags vary between CLI versions — override <NAME>_PATH via env if yours differs.
export const GEMINI_PATH   = process.env.GEMINI_PATH   || 'gemini';
export const CODEX_PATH    = process.env.CODEX_PATH    || 'codex';
export const COPILOT_PATH  = process.env.COPILOT_PATH  || 'copilot';
export const GOOSE_PATH    = process.env.GOOSE_PATH    || 'goose';
export const AMP_PATH      = process.env.AMP_PATH      || 'amp';
export const QWEN_PATH     = process.env.QWEN_PATH     || 'qwen';
export const CRUSH_PATH    = process.env.CRUSH_PATH    || 'crush';
export const ZSH_PATH      = process.env.ZSH_PATH      || 'zsh';

export const MAX_TIMEOUT   = parseInt(process.env.MAX_TIMEOUT_MS, 10) || 300000;        // 5 min
export const MAX_OUTPUT    = parseInt(process.env.MAX_OUTPUT_BYTES, 10) || 5 * 1024 * 1024; // 5MB

// ─── Environment builders for open-source IDE harnesses ──────────────────────
// Aider supports multiple backends selected by model prefix:
//   openai/...  → OpenAI-compatible gateway (optional, e.g. LiteLLM)
//   ollama/...  → Ollama local inference
//   anthropic/... → Anthropic direct (requires ANTHROPIC_API_KEY_ENABLED=1)
// OpenCode routes through an OpenAI-compatible gateway by default when configured.
// No vendor endpoint is hardcoded — leave LITELLM_BASE_URL unset to use CLI defaults.
// ────────────────────────────────────────────────────────────────────────────
export function buildAiderEnv(baseEnv = process.env, model = '') {
  const env = { ...baseEnv };
  const prefix = String(model || baseEnv.AIDER_MODEL || '').split('/')[0];

  if (prefix === 'ollama') {
    env.OLLAMA_API_BASE = baseEnv.OLLAMA_API_BASE || 'http://localhost:11434';
    delete env.ANTHROPIC_API_KEY;
  } else if (prefix === 'anthropic') {
    if (baseEnv.ANTHROPIC_API_KEY && baseEnv.ANTHROPIC_API_KEY_ENABLED !== '1') {
      delete env.ANTHROPIC_API_KEY;
    }
  } else {
    const gatewayUrl = baseEnv.LITELLM_BASE_URL || '';
    const gatewayToken = baseEnv.LITELLM_MASTER_KEY || '';
    if (gatewayUrl) env.OPENAI_API_BASE = gatewayUrl;
    if (gatewayToken) env.OPENAI_API_KEY = gatewayToken;
    delete env.ANTHROPIC_API_KEY;
  }
  return env;
}

export function buildOpencodeEnv(baseEnv = process.env) {
  const env = { ...baseEnv };
  const gatewayUrl = baseEnv.LITELLM_BASE_URL || '';
  const gatewayToken = baseEnv.LITELLM_MASTER_KEY || '';
  if (gatewayUrl) env.LOCAL_ENDPOINT = gatewayUrl + '/v1';
  if (gatewayToken) env.OPENAI_API_KEY = gatewayToken;
  delete env.ANTHROPIC_API_KEY;
  return env;
}

// ─── Outbound completion events (OFF by default) ─────────────────────────────
// When enabled, the runner POSTs a signed "task finished" event to RUNNER_EVENT_URL
// (e.g. an n8n webhook) so an orchestrator can react and choose the next step.
// Fire-and-forget and fail-open — emitting an event must NEVER block or break a task.
const EVENTS_ENABLED   = process.env.RUNNER_EVENTS_ENABLED === '1';
const EVENT_URL        = process.env.RUNNER_EVENT_URL || '';
const EVENT_SECRET     = process.env.RUNNER_EVENT_SECRET || '';
const EVENT_SIG_HEADER = process.env.RUNNER_EVENT_SIG_HEADER || 'X-Convoy-Signature';
const EVENT_MAX_DEPTH  = parseInt(process.env.RUNNER_EVENT_MAX_DEPTH, 10) || 5;

function emitCompletionEvent(task) {
  if (!EVENTS_ENABLED || !EVENT_URL || !task) return;
  if (typeof task.chainDepth === 'number' && task.chainDepth >= EVENT_MAX_DEPTH) return;
  try {
    const payload = {
      id: task.id ?? null,
      host: hostname(),
      shell: task.shell,
      status: task.status,
      exitCode: task.exitCode ?? null,
      error: task.error ?? null,
      command: task.command,
      output: (task.output || '').slice(-4000),
      durationMs: (task.finished && task.started) ? (new Date(task.finished) - new Date(task.started)) : null,
      correlationId: task.correlationId ?? null,
      chainDepth: typeof task.chainDepth === 'number' ? task.chainDepth : 0,
      timestamp: new Date().toISOString()
    };
    const bodyStr = JSON.stringify(payload);
    const headers = { 'content-type': 'application/json', 'user-agent': 'agentic-remote-pc-events/1.0' };
    if (EVENT_SECRET) headers[EVENT_SIG_HEADER] = createHmac('sha256', EVENT_SECRET).update(bodyStr).digest('hex');
    fetch(EVENT_URL, { method: 'POST', headers, body: bodyStr }).catch(() => {});
  } catch { /* never let event emission affect the task */ }
}

// ─── In-memory stores ───────────────────────────────────────────────────────
export const sessions = new Map();   // sessionId → { shell, cwd, history[] }
export const tasks    = new Map();   // taskId → { status, shell, command, output, … }

// ─── Typed errors (callers map these to HTTP status / MCP isError) ───────────
export class ValidationError extends Error {
  constructor(message, extra = {}) { super(message); this.name = 'ValidationError'; this.extra = extra; }
}
export class ExecError extends Error {
  constructor(message, payload = {}) { super(message); this.name = 'ExecError'; this.payload = payload; }
}

// ─── Shell registry ─────────────────────────────────────────────────────────
export const SHELL_MAP = {
  pwsh:       { exe: PWSH_PATH,    args: ['-NoProfile', '-NonInteractive', '-Command'] },
  powershell: { exe: 'powershell', args: ['-NoProfile', '-NonInteractive', '-Command'] },
  cmd:        { exe: CMD_PATH,     args: ['/C'] },
  bash:       { exe: 'bash',       args: ['-c'] },
  zsh:        { exe: ZSH_PATH,     args: ['-c'] },
  claude:     { exe: CLAUDE_PATH,  args: ['-p'] },
  cursor:     { exe: CURSOR_PATH,  args: ['-p'] },
  aider:      { exe: AIDER_PATH,   args: ['--message'] },
  opencode:   { exe: OPENCODE_PATH, args: ['--prompt'] },
  gemini:     { exe: GEMINI_PATH,  args: ['-p'] },
  codex:      { exe: CODEX_PATH,   args: ['exec'] },
  copilot:    { exe: COPILOT_PATH, args: ['-p'] },
  goose:      { exe: GOOSE_PATH,   args: ['-p'] },
  amp:        { exe: AMP_PATH,     args: ['-p'] },
  qwen:       { exe: QWEN_PATH,    args: ['-p'] },
  crush:      { exe: CRUSH_PATH,   args: ['-p'] }
};

// ─── Data-driven coding-agent providers ─────────────────────────────────────
// Bespoke helpers (below) cover claude/cursor/aider/opencode because they have
// session or flag quirks. Every other CLI is wired through this table + runAgent.
export const AGENT_PROVIDERS = {
  gemini:  { exe: GEMINI_PATH,  promptArgs: ['-p'],  modelFlag: '--model' },
  codex:   { exe: CODEX_PATH,   promptArgs: ['exec'], modelFlag: '-m' },
  copilot: { exe: COPILOT_PATH, promptArgs: ['-p'],  modelFlag: '--model' },
  goose:   { exe: GOOSE_PATH,   promptArgs: ['-p'],  modelFlag: '--model' },
  amp:     { exe: AMP_PATH,     promptArgs: ['-p'],  modelFlag: '--model' },
  qwen:    { exe: QWEN_PATH,    promptArgs: ['-p'],  modelFlag: '--model' },
  crush:   { exe: CRUSH_PATH,   promptArgs: ['-p'],  modelFlag: '--model' }
};
export const GENERIC_AGENT_NAMES = Object.keys(AGENT_PROVIDERS);

// Quote an argument so cmd.exe (shell:true, required for .cmd) treats it as ONE
// token. Without this, a multi-word prompt gets word-split and the CLI receives
// only the first token. (% and ! still risk cmd var-expansion — rare in prompts.)
function winQuote(a) {
  a = String(a);
  if (a === '') return '""';
  if (!/[ \t"&|<>^()%!,;=]/.test(a)) return a;
  return '"' + a.replace(/"/g, '\\"') + '"';
}

// execFile a CLI safely on Windows: when the exe is a .cmd/.bat (needs shell:true),
// build a single properly-quoted command string; otherwise pass the args array.
function execCli(exePath, args, opts = {}) {
  if (needsShell(exePath)) {
    const cmdline = [safeExe(exePath), ...args.map(winQuote)].join(' ');
    return execFileAsync(cmdline, { ...opts, shell: true });
  }
  return execFileAsync(exePath, args, { ...opts, shell: false });
}

// spawn() variant of execCli for streaming callers (runCommand, /exec/stream).
// Same quoting fix: a .cmd CLI under shell:true needs its args pre-quoted.
export function spawnCli(exePath, args, opts = {}) {
  if (needsShell(exePath)) {
    const cmdline = [safeExe(exePath), ...args.map(winQuote)].join(' ');
    return spawn(cmdline, { ...opts, shell: true });
  }
  return spawn(exePath, args, { ...opts, shell: false });
}

function taskResult(taskId) {
  const t = tasks.get(taskId);
  return {
    id: taskId,
    status: t.status,
    exitCode: t.exitCode,
    output: t.output,
    duration_ms: t.finished ? new Date(t.finished) - new Date(t.started) : null,
    error: t.error
  };
}

// Validate + register a task. Throws ValidationError on bad input.
function prepareShell({ shell = 'pwsh', command, cwd, timeout, env, correlationId, chainDepth } = {}) {
  if (!command) throw new ValidationError('command is required');
  const cfg = SHELL_MAP[shell];
  if (!cfg) throw new ValidationError(`Unknown shell: ${shell}`, { available: Object.keys(SHELL_MAP) });

  const taskId = randomUUID().slice(0, 8);
  const timeoutMs = Math.min(timeout || MAX_TIMEOUT, MAX_TIMEOUT);

  tasks.set(taskId, {
    status: 'running', shell, command, output: '',
    started: new Date().toISOString(), finished: null, error: null, exitCode: null,
    correlationId: correlationId ?? null, chainDepth: typeof chainDepth === 'number' ? chainDepth : 0
  });

  return { taskId, cfg, timeoutMs, cwd, env, command };
}

// Fire-and-forget: returns a task id immediately (REST ?async=true).
export function startShell(opts) {
  const { taskId, cfg, timeoutMs, cwd, env, command } = prepareShell(opts);
  runCommand(taskId, cfg, command, { cwd, timeout: timeoutMs, env }).catch(() => {});
  return { id: taskId, status: 'running' };
}

// Synchronous: waits for completion. Always resolves with a result object —
// a non-zero exit is reported via result.status === 'failed', not thrown.
export async function execShell(opts) {
  const { taskId, cfg, timeoutMs, cwd, env, command } = prepareShell(opts);
  try {
    await runCommand(taskId, cfg, command, { cwd, timeout: timeoutMs, env });
  } catch {
    // runCommand has already recorded status/error/output on the task.
  }
  return taskResult(taskId);
}

// ─── Claude Code CLI ─────────────────────────────────────────────────────────
export async function runClaude({ prompt, cwd, outputFormat = 'json', maxTurns, allowedTools, verbose = false, correlationId, chainDepth, skipPermissions } = {}) {
  if (!prompt) throw new ValidationError('prompt is required');

  const args = ['-p', prompt, '--output-format', outputFormat];
  if (maxTurns)     args.push('--max-turns', String(maxTurns));
  if (allowedTools) args.push('--allowedTools', Array.isArray(allowedTools) ? allowedTools.join(',') : allowedTools);
  if (verbose)      args.push('--verbose');
  // Full-auto dev: let the agent edit files and run commands without prompts.
  // Env-gated (CLAUDE_SKIP_PERMISSIONS=1) with a per-call override (skipPermissions).
  if (skipPermissions ?? (process.env.CLAUDE_SKIP_PERMISSIONS === '1')) args.push('--dangerously-skip-permissions');

  const taskId = randomUUID().slice(0, 8);
  tasks.set(taskId, {
    status: 'running', shell: 'claude', command: `claude ${args.join(' ')}`, output: '',
    started: new Date().toISOString(), finished: null, error: null, exitCode: null,
    correlationId: correlationId ?? null, chainDepth: typeof chainDepth === 'number' ? chainDepth : 0
  });

  try {
    const result = await execCli(CLAUDE_PATH, args, {
      cwd: cwd || process.cwd(), timeout: MAX_TIMEOUT, maxBuffer: MAX_OUTPUT,
      env: process.env, windowsHide: true
    });
    const task = tasks.get(taskId);
    task.status = 'completed';
    task.output = result.stdout + (result.stderr || '');
    task.finished = new Date().toISOString();
    task.exitCode = 0;
    emitCompletionEvent(task);
    return { id: taskId, status: 'completed', output: result.stdout, stderr: result.stderr || '', duration_ms: new Date(task.finished) - new Date(task.started) };
  } catch (err) {
    const task = tasks.get(taskId);
    if (task) {
      task.status = 'failed'; task.error = err.message;
      task.output = (err.stdout || '') + (err.stderr || '');
      task.finished = new Date().toISOString(); task.exitCode = err.code || 1;
    }
    emitCompletionEvent(tasks.get(taskId));
    throw new ExecError(err.message, { id: taskId, status: 'failed', output: err.stdout || '', stderr: err.stderr || '', exitCode: err.code || 1 });
  }
}

export async function runClaudeSession({ prompt, sessionId, cwd, outputFormat = 'json' } = {}) {
  if (!prompt) throw new ValidationError('prompt is required');

  const args = ['-p', prompt, '--output-format', outputFormat];
  if (sessionId) args.push('--resume', sessionId);
  else           args.push('--continue');

  try {
    const result = await execCli(CLAUDE_PATH, args, {
      cwd: cwd || process.cwd(), timeout: MAX_TIMEOUT, maxBuffer: MAX_OUTPUT,
      env: process.env, windowsHide: true
    });
    let parsedSessionId = sessionId;
    try { const parsed = JSON.parse(result.stdout); if (parsed.session_id) parsedSessionId = parsed.session_id; } catch {}
    return { status: 'completed', session_id: parsedSessionId, output: result.stdout, stderr: result.stderr || '' };
  } catch (err) {
    throw new ExecError(err.message, { status: 'failed', output: err.stdout || '', stderr: err.stderr || '' });
  }
}

// ─── Cursor CLI agent ────────────────────────────────────────────────────────
export async function runCursor({ prompt, cwd, outputFormat = 'text', trust = true, yolo = false, correlationId, chainDepth } = {}) {
  if (!prompt) throw new ValidationError('prompt is required');

  const args = ['-p', prompt, '--output-format', outputFormat];
  if (trust) args.push('--force');
  if (yolo)  args.push('--force');

  const taskId = randomUUID().slice(0, 8);
  tasks.set(taskId, {
    status: 'running', shell: 'cursor', command: `agent ${args.join(' ')}`, output: '',
    started: new Date().toISOString(), finished: null, error: null, exitCode: null,
    correlationId: correlationId ?? null, chainDepth: typeof chainDepth === 'number' ? chainDepth : 0
  });

  try {
    const result = await execCli(CURSOR_PATH, args, {
      cwd: cwd || process.cwd(), timeout: MAX_TIMEOUT, maxBuffer: MAX_OUTPUT,
      env: process.env, windowsHide: true
    });
    const task = tasks.get(taskId);
    task.status = 'completed';
    task.output = result.stdout + (result.stderr || '');
    task.finished = new Date().toISOString();
    task.exitCode = 0;
    emitCompletionEvent(task);
    return { id: taskId, status: 'completed', output: result.stdout, stderr: result.stderr || '', duration_ms: new Date(task.finished) - new Date(task.started) };
  } catch (err) {
    const task = tasks.get(taskId);
    if (task) {
      task.status = 'failed'; task.error = err.message;
      task.output = (err.stdout || '') + (err.stderr || '');
      task.finished = new Date().toISOString(); task.exitCode = err.code || 1;
    }
    emitCompletionEvent(tasks.get(taskId));
    throw new ExecError(err.message, { id: taskId, status: 'failed', output: err.stdout || '', stderr: err.stderr || '', exitCode: err.code || 1 });
  }
}

export async function runCursorSession({ prompt, cwd, outputFormat = 'text', trust = true, yolo = false } = {}) {
  if (!prompt) throw new ValidationError('prompt is required');
  if (!cwd)    throw new ValidationError('cwd is required for cursor/session — point it at your project directory');

  const args = ['-p', prompt, '--output-format', outputFormat];
  if (trust) args.push('--force');
  if (yolo)  args.push('--force');

  try {
    const result = await execCli(CURSOR_PATH, args, {
      cwd, timeout: MAX_TIMEOUT, maxBuffer: MAX_OUTPUT,
      env: process.env, windowsHide: true
    });
    return { status: 'completed', cwd, output: result.stdout, stderr: result.stderr || '' };
  } catch (err) {
    throw new ExecError(err.message, { status: 'failed', cwd, output: err.stdout || '', stderr: err.stderr || '' });
  }
}

// ─── Aider CLI ────────────────────────────────────────────────────────────────
export async function runAider({ prompt, cwd, model, files, correlationId, chainDepth } = {}) {
  if (!prompt) throw new ValidationError('prompt is required');

  const resolvedModel = model || process.env.AIDER_MODEL || '';
  const args = ['--message', prompt];
  if (resolvedModel) args.push('--model', resolvedModel);
  if (files && files.length) args.push(...files);

  const taskId = randomUUID().slice(0, 8);
  tasks.set(taskId, {
    status: 'running', shell: 'aider', command: `aider ${args.join(' ')}`, output: '',
    started: new Date().toISOString(), finished: null, error: null, exitCode: null,
    correlationId: correlationId ?? null, chainDepth: typeof chainDepth === 'number' ? chainDepth : 0
  });

  try {
    const result = await execCli(AIDER_PATH, args, {
      cwd: cwd || process.cwd(), timeout: MAX_TIMEOUT, maxBuffer: MAX_OUTPUT,
      env: buildAiderEnv(process.env, resolvedModel), windowsHide: true
    });
    const task = tasks.get(taskId);
    task.status = 'completed';
    task.output = result.stdout + (result.stderr || '');
    task.finished = new Date().toISOString();
    task.exitCode = 0;
    emitCompletionEvent(task);
    return { id: taskId, status: 'completed', output: result.stdout, stderr: result.stderr || '', duration_ms: new Date(task.finished) - new Date(task.started) };
  } catch (err) {
    const task = tasks.get(taskId);
    if (task) {
      task.status = 'failed'; task.error = err.message;
      task.output = (err.stdout || '') + (err.stderr || '');
      task.finished = new Date().toISOString(); task.exitCode = err.code || 1;
    }
    emitCompletionEvent(tasks.get(taskId));
    throw new ExecError(err.message, { id: taskId, status: 'failed', output: err.stdout || '', stderr: err.stderr || '', exitCode: err.code || 1 });
  }
}

// ─── OpenCode CLI ─────────────────────────────────────────────────────────────
export async function runOpencode({ prompt, cwd, model, files, correlationId, chainDepth } = {}) {
  if (!prompt) throw new ValidationError('prompt is required');

  const resolvedModel = model || process.env.OPENCODE_MODEL || '';
  const args = ['--prompt', prompt];
  if (resolvedModel) args.push('--model', resolvedModel);
  if (files && files.length) args.push(...files);

  const taskId = randomUUID().slice(0, 8);
  tasks.set(taskId, {
    status: 'running', shell: 'opencode', command: `opencode ${args.join(' ')}`, output: '',
    started: new Date().toISOString(), finished: null, error: null, exitCode: null,
    correlationId: correlationId ?? null, chainDepth: typeof chainDepth === 'number' ? chainDepth : 0
  });

  try {
    const result = await execCli(OPENCODE_PATH, args, {
      cwd: cwd || process.cwd(), timeout: MAX_TIMEOUT, maxBuffer: MAX_OUTPUT,
      env: buildOpencodeEnv(process.env), windowsHide: true
    });
    const task = tasks.get(taskId);
    task.status = 'completed';
    task.output = result.stdout + (result.stderr || '');
    task.finished = new Date().toISOString();
    task.exitCode = 0;
    emitCompletionEvent(task);
    return { id: taskId, status: 'completed', output: result.stdout, stderr: result.stderr || '', duration_ms: new Date(task.finished) - new Date(task.started) };
  } catch (err) {
    const task = tasks.get(taskId);
    if (task) {
      task.status = 'failed'; task.error = err.message;
      task.output = (err.stdout || '') + (err.stderr || '');
      task.finished = new Date().toISOString(); task.exitCode = err.code || 1;
    }
    emitCompletionEvent(tasks.get(taskId));
    throw new ExecError(err.message, { id: taskId, status: 'failed', output: err.stdout || '', stderr: err.stderr || '', exitCode: err.code || 1 });
  }
}

// ─── Generic coding-agent providers (data-driven) ───────────────────────────
// Runs any of the AGENT_PROVIDERS CLIs with task tracking + completion events,
// mirroring the bespoke helpers above. To add another CLI: add an entry to
// AGENT_PROVIDERS, a line to SHELL_MAP, a REST route in server.js, and an MCP
// tool in mcp.js.
export async function runAgent({ name, prompt, cwd, model, files, extraArgs = [], correlationId, chainDepth } = {}) {
  if (!prompt) throw new ValidationError('prompt is required');
  const prov = AGENT_PROVIDERS[name];
  if (!prov) throw new ValidationError(`Unknown agent provider: ${name}`, { available: GENERIC_AGENT_NAMES });

  const args = [...prov.promptArgs, prompt];
  if (model && prov.modelFlag) args.push(prov.modelFlag, model);
  if (Array.isArray(extraArgs) && extraArgs.length) args.push(...extraArgs);
  if (Array.isArray(files) && files.length) args.push(...files);

  const taskId = randomUUID().slice(0, 8);
  tasks.set(taskId, {
    status: 'running', shell: name, command: `${prov.exe} ${args.join(' ')}`, output: '',
    started: new Date().toISOString(), finished: null, error: null, exitCode: null,
    correlationId: correlationId ?? null, chainDepth: typeof chainDepth === 'number' ? chainDepth : 0
  });

  try {
    const result = await execCli(prov.exe, args, {
      cwd: cwd || process.cwd(), timeout: MAX_TIMEOUT, maxBuffer: MAX_OUTPUT,
      env: process.env, windowsHide: true
    });
    const task = tasks.get(taskId);
    task.status = 'completed';
    task.output = result.stdout + (result.stderr || '');
    task.finished = new Date().toISOString();
    task.exitCode = 0;
    emitCompletionEvent(task);
    return { id: taskId, status: 'completed', output: result.stdout, stderr: result.stderr || '', duration_ms: new Date(task.finished) - new Date(task.started) };
  } catch (err) {
    const task = tasks.get(taskId);
    if (task) {
      task.status = 'failed'; task.error = err.message;
      task.output = (err.stdout || '') + (err.stderr || '');
      task.finished = new Date().toISOString(); task.exitCode = err.code || 1;
    }
    emitCompletionEvent(tasks.get(taskId));
    throw new ExecError(err.message, { id: taskId, status: 'failed', output: err.stdout || '', stderr: err.stderr || '', exitCode: err.code || 1 });
  }
}

// ─── Task management ─────────────────────────────────────────────────────────
export function getTask(id) {
  const task = tasks.get(id);
  if (!task) throw new ValidationError('Not found', { id });
  return { id, ...task };
}

export function listTasks() {
  const list = [...tasks.entries()].map(([id, t]) => ({ id, ...t }));
  list.sort((a, b) => new Date(b.started) - new Date(a.started));
  return list.map(t => ({
    ...t,
    output: t.output.length > 500 ? t.output.slice(0, 500) + '...[truncated]' : t.output
  }));
}

export function clearTasks() {
  const count = tasks.size;
  tasks.clear();
  return { ok: true, cleared: count };
}

// ─── Health / info payloads (shared by REST + MCP) ───────────────────────────
export function healthPayload() {
  return {
    ok: true,
    hostname: hostname(),
    platform: platform(),
    uptime_hours: Math.round(uptime() / 3600 * 10) / 10,
    cpus: cpus().length,
    memory_gb: {
      total: Math.round(totalmem() / 1073741824 * 10) / 10,
      free: Math.round(freemem() / 1073741824 * 10) / 10
    },
    active_tasks: [...tasks.values()].filter(t => t.status === 'running').length,
    total_tasks: tasks.size,
    sessions: sessions.size
  };
}

export function infoPayload() {
  return {
    service: 'agentic-remote-pc',
    version: '2.0.0',
    hostname: hostname(),
    platform: platform(),
    shells: {
      pwsh: PWSH_PATH, powershell: 'powershell', cmd: CMD_PATH, bash: 'bash', zsh: ZSH_PATH,
      claude: CLAUDE_PATH, cursor: CURSOR_PATH, aider: AIDER_PATH, opencode: OPENCODE_PATH,
      gemini: GEMINI_PATH, codex: CODEX_PATH, copilot: COPILOT_PATH,
      goose: GOOSE_PATH, amp: AMP_PATH, qwen: QWEN_PATH, crush: CRUSH_PATH
    },
    endpoints: {
      'POST /exec':            'Execute a one-shot command in any shell or agent CLI',
      'POST /exec/stream':     'Execute with streaming SSE output',
      'POST /claude':          'Claude Code one-shot prompt',
      'POST /claude/session':  'Continue a Claude Code session',
      'POST /cursor':          'Cursor agent one-shot prompt',
      'POST /cursor/session':  'Cursor agent in a workspace',
      'POST /aider':           'Aider (open-source, multi-backend)',
      'POST /opencode':        'OpenCode (open-source, gateway-routed)',
      'POST /gemini':          'Google Gemini CLI one-shot',
      'POST /codex':           'OpenAI Codex CLI one-shot',
      'POST /copilot':         'GitHub Copilot CLI one-shot',
      'POST /goose':           'Block Goose one-shot',
      'POST /amp':             'Sourcegraph Amp one-shot',
      'POST /qwen':            'Qwen Code one-shot',
      'POST /crush':           'Charm Crush one-shot',
      'GET  /task/:id':        'Get task status and output',
      'GET  /tasks':           'List all tasks',
      'DELETE /tasks':         'Clear task history',
      'GET  /health':          'Health check (no auth required)',
      'GET  /info':            'This endpoint',
      'ALL  /mcp':             'Model Context Protocol (Streamable HTTP) — ChatGPT / Codex / Claude / Cursor / Gemini'
    },
    mcp: {
      endpoint: '/mcp',
      transport: 'streamable-http',
      tools: ['run_command', 'claude_prompt', 'claude_session', 'cursor_prompt', 'cursor_session',
        'aider_prompt', 'opencode_prompt', 'gemini_prompt', 'codex_prompt', 'copilot_prompt',
        'goose_prompt', 'amp_prompt', 'qwen_prompt', 'crush_prompt',
        'get_task', 'list_tasks', 'host_health', 'host_info']
    }
  };
}

// ─── Low-level spawn helper (used by execShell/startShell) ───────────────────
function runCommand(taskId, cfg, command, opts = {}) {
  return new Promise((resolve, reject) => {
    const mergedEnv = { ...process.env, ...(opts.env || {}) };
    const proc = spawnCli(cfg.exe, [...cfg.args, command], {
      cwd: opts.cwd || process.cwd(),
      env: mergedEnv,
      windowsHide: true
    });

    let output = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGTERM');
    }, opts.timeout || MAX_TIMEOUT);

    proc.stdout.on('data', (chunk) => {
      output += chunk.toString();
      if (output.length > MAX_OUTPUT) proc.kill('SIGTERM');
    });

    proc.stderr.on('data', (chunk) => { output += chunk.toString(); });

    proc.on('close', (code) => {
      clearTimeout(timer);
      const task = tasks.get(taskId);
      if (task) {
        task.output = output;
        task.exitCode = code;
        task.finished = new Date().toISOString();
        task.status = code === 0 ? 'completed' : 'failed';
        task.error = timedOut ? 'Timed out' : (code !== 0 ? `Exit code ${code}` : null);
      }
      // NOTE: /exec (shell) tasks do NOT emit completion events — only the
      // dev-agent helpers (runClaude/runCursor/…) do. This keeps ad-hoc shell
      // calls from triggering spurious orchestrator reviews.
      code === 0 ? resolve(output) : reject(new Error(timedOut ? 'Timed out' : `Exit code ${code}`));
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      const task = tasks.get(taskId);
      if (task) {
        task.output = output;
        task.status = 'failed';
        task.error = err.message;
        task.finished = new Date().toISOString();
      }
      reject(err);
    });
  });
}
