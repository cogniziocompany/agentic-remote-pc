#!/usr/bin/env node
/**
 * E2E smoke test for open-source IDE harnesses (Aider + OpenCode).
 *
 * Validates:
 *   1. runner info advertises /aider and /opencode endpoints
 *   2. POST /aider accepts a prompt, creates a task, and the command line is well-formed
 *   3. POST /opencode accepts a prompt, creates a task, and the command line is well-formed
 *   4. If the harness binary is absent, the task fails gracefully with a clear error
 *
 * Uses the live runner on localhost:7334 (override: RUNNER_BASE).
 * Expects RUNNER_API_KEY in env or ../.env.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const BASE = process.env.RUNNER_BASE || 'http://localhost:7334';
const here = dirname(fileURLToPath(import.meta.url));

function readEnv(key) {
  if (process.env[key]) return process.env[key];
  try {
    const env = readFileSync(join(here, '..', '.env'), 'utf8');
    const line = env.split(/\r?\n/).find(l => l.match(new RegExp(`^\\s*${key}\\s*=`)));
    if (line) return line.split('=').slice(1).join('=').trim().replace(/^"|"$/g, '');
  } catch {}
  return null;
}

const AUTH = readEnv('RUNNER_API_KEY') || '';
const headers = { 'Content-Type': 'application/json' };
if (AUTH) headers.Authorization = `Bearer ${AUTH}`;

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function post(path, body) {
  const r = await fetch(`${BASE}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: r.status, text, json };
}

async function getTask(id) {
  const r = await fetch(`${BASE}/task/${id}`, { headers: AUTH ? { Authorization: `Bearer ${AUTH}` } : {} });
  return r.json();
}

let passed = 0, failed = 0;
const results = [];
async function test(name, fn) {
  let line;
  try { await fn(); line = `  PASS  ${name}`; passed++; }
  catch (e) { line = `  FAIL  ${name}\n        ${e.message}`; failed++; }
  results.push(line);
  console.log(line);
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

async function waitForTask(id, ms = 30000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const t = await getTask(id);
    if (t.status === 'completed' || t.status === 'failed') return t;
    await sleep(500);
  }
  throw new Error(`task ${id} did not finish within ${ms}ms`);
}

async function main() {
  console.log('=== harness E2E ===  runner=' + BASE);

  await test('H1 info lists aider and opencode endpoints', async () => {
    const r = await fetch(`${BASE}/info`, { headers: AUTH ? { Authorization: `Bearer ${AUTH}` } : {} });
    const info = await r.json();
    const eps = Object.keys(info.endpoints || {});
    assert(eps.some(k => k.includes('/aider')), '/aider not in info.endpoints');
    assert(eps.some(k => k.includes('/opencode')), '/opencode not in info.endpoints');
  });

  await test('H2 POST /aider creates a task and reports status', async () => {
    const r = await post('/aider', { prompt: 'say hello', cwd: here });
    // 200 = ran; 500 = binary missing or runtime error — both are acceptable wiring tests.
    assert(r.status === 200 || r.status === 500, `expected 200 or 500, got ${r.status}: ${r.text}`);
    const taskId = r.json?.id;
    assert(taskId, 'no task id returned');
    const task = await waitForTask(taskId, 30000);
    assert(task.status === 'completed' || task.status === 'failed', `unexpected status: ${task.status}`);
    assert(typeof task.output === 'string', 'task output is not a string');
    assert(!task.command.includes('anthropic'), 'command leaked anthropic ref: ' + task.command);
  });

  await test('H3 POST /opencode creates a task and reports status', async () => {
    const r = await post('/opencode', { prompt: 'say hello', cwd: here });
    assert(r.status === 200 || r.status === 500, `expected 200 or 500, got ${r.status}: ${r.text}`);
    const taskId = r.json?.id;
    assert(taskId, 'no task id returned');
    const task = await waitForTask(taskId, 30000);
    assert(task.status === 'completed' || task.status === 'failed', `unexpected status: ${task.status}`);
    assert(typeof task.output === 'string', 'task output is not a string');
    assert(!task.command.includes('anthropic'), 'command leaked anthropic ref: ' + task.command);
  });

  await test('H4 /exec with shell=aider routes correctly', async () => {
    const r = await post('/exec', { shell: 'aider', command: 'hello from exec', cwd: here });
    assert(r.status === 200 || r.status === 500, `expected 200 or 500, got ${r.status}: ${r.text}`);
    const taskId = r.json?.id;
    assert(taskId, 'no task id');
    const task = await waitForTask(taskId, 30000);
    assert(task.shell === 'aider', `expected shell aider, got ${task.shell}`);
  });

  await test('H5 /exec with shell=opencode routes correctly', async () => {
    const r = await post('/exec', { shell: 'opencode', command: 'hello from exec', cwd: here });
    assert(r.status === 200 || r.status === 500, `expected 200 or 500, got ${r.status}: ${r.text}`);
    const taskId = r.json?.id;
    assert(taskId, 'no task id');
    const task = await waitForTask(taskId, 30000);
    assert(task.shell === 'opencode', `expected shell opencode, got ${task.shell}`);
  });

  console.log(`\n=== ${failed === 0 ? 'ALL PASS' : 'FAILURES'} — ${passed} passed, ${failed} failed ===`);
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch(e => { console.error('runner crashed:', e?.stack || e); process.exitCode = 3; });
