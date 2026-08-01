#!/usr/bin/env node
/**
 * agentic-remote-pc — minimal end-to-end demo driver.
 *
 * Walks the core contract against a live runner:
 *   1. GET  /health                 — confirm the runner is up
 *   2. POST /exec {shell,command}    — run a real shell command
 *   3. POST /<agent> {prompt}        — drive a coding-agent CLI (default: claude)
 *   4. GET  /task/:id                — poll an async task (if any)
 *
 * Configure with env vars (or a .env in the repo root, which dotenv loads
 * when the server runs — for this script, export them in your shell):
 *
 *   RUNNER_BASE   default http://localhost:7334
 *   RUNNER_API_KEY required if the server has a key set
 *   DEMO_AGENT     default claude  (claude|cursor|aider|opencode|gemini|codex|copilot|goose|amp|qwen|crush)
 *
 *   node examples/drive-runner.mjs
 */
const BASE = process.env.RUNNER_BASE || 'http://localhost:7334';
const KEY = process.env.RUNNER_API_KEY || '';
const AGENT = process.env.DEMO_AGENT || 'claude';

const headers = { 'Content-Type': 'application/json' };
if (KEY) headers.Authorization = `Bearer ${KEY}`;

async function call(method, path, body) {
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, json };
}

const log = (...a) => console.log(...a);

async function main() {
  log(`\n=== agentic-remote-pc demo driver (base ${BASE}, agent ${AGENT}) ===`);

  // 1. health
  const h = await call('GET', '/health');
  log(`[1] /health -> ${h.status}  ${JSON.stringify(h.json)}`);

  // 2. shell command
  const shell = process.platform === 'win32' ? 'pwsh' : 'bash';
  const cmd = process.platform === 'win32' ? 'Get-Date' : 'date';
  const e = await call('POST', '/exec', { shell, command: cmd, timeout: 8000 });
  log(`[2] /exec ${shell} "${cmd}" -> ${e.status}  status=${e.json?.status}  output=${JSON.stringify((e.json?.output || '').trim())}`);

  // 3. drive an agent
  const prompt = 'In one short sentence, say what you are and that you are running behind agentic-remote-pc.';
  const a = await call('POST', `/${AGENT}`, { prompt, timeout: 60000 });
  log(`[3] /${AGENT} -> ${a.status}  status=${a.json?.status || a.json?.error}`);
  if (a.json?.output) log(`    output: ${JSON.stringify(a.json.output.trim().slice(0, 200))}`);
  if (a.json?.error) log(`    error:  ${a.json.error}`);

  // 4. poll a task if async
  if (a.json?.id) {
    const t = await call('GET', `/task/${a.json.id}`);
    log(`[4] /task/${a.json.id} -> ${t.status}  status=${t.json?.status}`);
  }

  log('\nDone. See README for the full API and MCP tool list.\n');
}

main().catch(err => { console.error('demo failed:', err); process.exitCode = 1; });
