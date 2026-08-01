#!/usr/bin/env node
/**
 * Runner smoke test — validates the engine wires up correctly without needing
 * a live HTTP server or any installed CLI. Imports the shared engine and MCP
 * factory directly and asserts the shell/endpoint/MCP-tool surface.
 *
 *   node e2e/runner-smoke.mjs
 */
import { infoPayload, healthPayload, GENERIC_AGENT_NAMES, AGENT_PROVIDERS, SHELL_MAP } from '../src/runner.js';
import { createMcpServer } from '../src/mcp.js';

const info = infoPayload();
const lines = [];
let fail = false;
const expectedAgents = ['gemini', 'codex', 'copilot', 'goose', 'amp', 'qwen', 'crush'];
const expectedShells = ['pwsh', 'powershell', 'cmd', 'bash', 'zsh', 'claude', 'cursor', 'aider', 'opencode'];

for (const s of expectedShells) {
  if (SHELL_MAP[s] === undefined) { lines.push('FAIL SHELL_MAP missing: ' + s); fail = true; }
}
for (const a of expectedAgents) {
  if (info.shells[a] === undefined) { lines.push('FAIL missing shell: ' + a); fail = true; }
  if (info.endpoints['POST /' + a] === undefined) { lines.push('FAIL missing endpoint: /' + a); fail = true; }
  if (info.mcp.tools.indexOf(a + '_prompt') === -1) { lines.push('FAIL missing mcp tool: ' + a + '_prompt'); fail = true; }
  if (SHELL_MAP[a] === undefined) { lines.push('FAIL SHELL_MAP missing: ' + a); fail = true; }
  if (AGENT_PROVIDERS[a] === undefined) { lines.push('FAIL AGENT_PROVIDERS missing: ' + a); fail = true; }
}
if (info.shells.zsh === undefined) { lines.push('FAIL missing zsh'); fail = true; }
if (GENERIC_AGENT_NAMES.length === 7) lines.push('ok generic-agent count: 7');
else { lines.push('FAIL generic count: ' + GENERIC_AGENT_NAMES.length); fail = true; }

const h = healthPayload();
if (h.ok === true) lines.push('ok healthPayload');
else { lines.push('FAIL healthPayload'); fail = true; }

const srv = createMcpServer();
lines.push('mcp-server-built: ' + (srv ? 'yes' : 'no'));
lines.push('service: ' + info.service + ' version: ' + info.version);
lines.push('shells: ' + Object.keys(info.shells).join(','));
lines.push('mcp-tools(' + info.mcp.tools.length + '): ' + info.mcp.tools.join(','));
lines.push('RESULT: ' + (fail ? 'FAIL' : 'PASS'));
console.log(lines.join('\n'));
if (fail) process.exitCode = 1;
