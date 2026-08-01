// ═══════════════════════════════════════════════════════════════════════════
//  MCP Server — Model Context Protocol head
//  Cognizio Company
//
//  Advertises the runner's capabilities as MCP tools so MCP clients
//  (ChatGPT developer-mode connectors, OpenAI Codex, Claude Code, Cursor,
//  Gemini CLI) can discover them via tools/list and invoke them via tools/call.
//
//  Every tool is a thin wrapper over a shared helper in src/runner.js — the
//  exact same engine the REST routes use. Transport (Streamable HTTP) and auth
//  (Bearer RUNNER_API_KEY) are handled in src/server.js.
// ═══════════════════════════════════════════════════════════════════════════

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  execShell, runClaude, runClaudeSession, runCursor, runCursorSession,
  runAider, runOpencode, runAgent, GENERIC_AGENT_NAMES,
  getTask, listTasks, healthPayload, infoPayload,
  ValidationError, ExecError
} from './runner.js';

const SERVER_VERSION = '2.0.0';

// Render a helper's result as an MCP tool result. The JSON lives in a text
// block (what the model reads) and is mirrored in structuredContent.
function ok(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }], structuredContent: Array.isArray(data) ? { items: data } : data };
}

function fail(err) {
  const extra =
    err instanceof ExecError ? err.payload :
    err instanceof ValidationError ? err.extra :
    {};
  const body = { error: err.message || String(err), ...extra };
  return { content: [{ type: 'text', text: JSON.stringify(body, null, 2) }], isError: true };
}

// Run a helper and convert success/failure into an MCP tool result. Helpers
// throw ValidationError/ExecError; this keeps tool calls from crashing the
// transport and surfaces failures as isError instead.
async function run(fn) {
  try { return ok(await fn()); }
  catch (err) { return fail(err); }
}

const OUTPUT_FORMATS = ['text', 'json', 'stream-json'];
const SHELL_NAMES = ['pwsh', 'powershell', 'cmd', 'bash', 'zsh', 'claude', 'cursor', 'aider', 'opencode', 'gemini', 'codex', 'copilot', 'goose', 'amp', 'qwen', 'crush'];

// Friendly one-line descriptions for the data-driven generic agent tools.
const AGENT_BLURBS = {
  gemini:  'Google Gemini CLI',
  codex:   'OpenAI Codex CLI',
  copilot: 'GitHub Copilot CLI',
  goose:   'Block Goose',
  amp:     'Sourcegraph Amp',
  qwen:    'Qwen Code',
  crush:   'Charm Crush'
};

export function createMcpServer() {
  const server = new McpServer(
    { name: 'agentic-remote-pc-runner', version: SERVER_VERSION },
    {
      instructions:
        'Remote control of a real Windows or Linux host exposed through an authenticated REST/MCP runner. ' +
        'Start with host_health or host_info when the runner state or tool catalog is unknown. ' +
        'Use pwsh, powershell, cmd (Windows) or bash/zsh (Linux/macOS) for shell work. ' +
        'The claude, cursor, aider, opencode, gemini, codex, copilot, goose, amp, qwen, and crush shells route to ' +
        'host-local coding-agent CLIs. Treat run_command and the *_prompt tools as state-changing. Confirm before ' +
        'rebooting, restarting services, killing processes, changing credentials, installing software, deploying, ' +
        'or clearing tasks. Finish with concrete evidence such as commands run, changed files, build/deploy/browser/API ' +
        'results, task ids, and remaining risks.'
    }
  );

  // ── run_command — general shell execution ────────────────────────────────
  server.registerTool(
    'run_command',
    {
      title: 'Run a shell command',
      description:
        'Execute a one-shot command on the host and return stdout/stderr, the exit code, and a task id. ' +
        'Use pwsh/powershell/cmd on Windows, bash/zsh on Linux/macOS. The claude/cursor/aider/opencode/gemini/codex/' +
        'copilot/goose/amp/qwen/crush shells route the command as a prompt to the host-local coding-agent CLIs.',
      inputSchema: {
        command: z.string().describe('The command (or prompt, for agent CLIs) to run'),
        shell: z.enum(SHELL_NAMES).default('pwsh')
          .describe('Which interpreter/CLI to run the command in'),
        cwd: z.string().optional().describe('Working directory for the command'),
        timeout: z.number().int().positive().optional().describe('Timeout in ms (capped by the server MAX_TIMEOUT)'),
        env: z.record(z.string(), z.string()).optional().describe('Extra environment variables')
      },
      annotations: { title: 'Run a shell command', readOnlyHint: false, destructiveHint: true, openWorldHint: true }
    },
    async (args) => run(() => execShell(args))
  );

  // ── claude_prompt — Claude Code one-shot ─────────────────────────────────
  server.registerTool(
    'claude_prompt',
    {
      title: 'Claude Code one-shot',
      description:
        'Send a single prompt to the Claude Code CLI and return its structured result. ' +
        'Use for independent validation, code review, runtime diagnosis, and deployment work.',
      inputSchema: {
        prompt: z.string().describe('Prompt for Claude Code'),
        cwd: z.string().optional().describe('Project directory to run in'),
        outputFormat: z.enum(OUTPUT_FORMATS).default('json'),
        maxTurns: z.number().int().positive().optional().describe('Cap the number of agent turns'),
        allowedTools: z.array(z.string()).optional().describe('Tool allow-list passed to --allowedTools'),
        verbose: z.boolean().default(false)
      },
      annotations: { title: 'Claude Code one-shot', readOnlyHint: false, destructiveHint: true, openWorldHint: true }
    },
    async (args) => run(() => runClaude(args))
  );

  // ── claude_session — continue / resume a Claude Code session ─────────────
  server.registerTool(
    'claude_session',
    {
      title: 'Claude Code session',
      description:
        'Continue the latest Claude Code session, or resume a specific one by sessionId. Use for iterative ' +
        'validation, deployment follow-up, and narrowing disagreements found by other agents or shell checks.',
      inputSchema: {
        prompt: z.string().describe('Next prompt for the session'),
        sessionId: z.string().optional().describe('Resume this session id; omit to --continue the latest session'),
        cwd: z.string().optional().describe('Project directory'),
        outputFormat: z.enum(OUTPUT_FORMATS).default('json')
      },
      annotations: { title: 'Claude Code session', readOnlyHint: false, destructiveHint: true, openWorldHint: true }
    },
    async (args) => run(() => runClaudeSession(args))
  );

  // ── cursor_prompt — Cursor agent one-shot ────────────────────────────────
  server.registerTool(
    'cursor_prompt',
    {
      title: 'Cursor agent one-shot',
      description:
        'Send a single prompt to the Cursor CLI agent. Use for implementation, rapid iteration, ' +
        'and first-pass live testing.',
      inputSchema: {
        prompt: z.string().describe('Prompt for the Cursor agent'),
        cwd: z.string().optional().describe('Project directory'),
        outputFormat: z.enum(OUTPUT_FORMATS).default('text'),
        trust: z.boolean().default(true).describe('Skip the workspace-trust prompt (--force)'),
        yolo: z.boolean().default(false).describe('Skip confirmation dialogs (--force)')
      },
      annotations: { title: 'Cursor agent one-shot', readOnlyHint: false, destructiveHint: true, openWorldHint: true }
    },
    async (args) => run(() => runCursor(args))
  );

  // ── cursor_session — Cursor agent in a workspace ─────────────────────────
  server.registerTool(
    'cursor_session',
    {
      title: 'Cursor agent in a workspace',
      description:
        'Run the Cursor CLI agent targeted at a specific workspace directory (cwd is required). ' +
        'Cursor can take 10-15 seconds on first connection.',
      inputSchema: {
        prompt: z.string().describe('Prompt for the Cursor agent'),
        cwd: z.string().describe('Workspace/project directory (required)'),
        outputFormat: z.enum(OUTPUT_FORMATS).default('text'),
        trust: z.boolean().default(true).describe('Skip the workspace-trust prompt (--force)'),
        yolo: z.boolean().default(false).describe('Skip confirmation dialogs (--force)')
      },
      annotations: { title: 'Cursor agent in a workspace', readOnlyHint: false, destructiveHint: true, openWorldHint: true }
    },
    async (args) => run(() => runCursorSession(args))
  );

  // ── aider_prompt — Aider one-shot ────────────────────────────────────────
  server.registerTool(
    'aider_prompt',
    {
      title: 'Aider one-shot',
      description:
        'Send a single prompt to the Aider CLI — an open-source AI pair-programming harness that supports ' +
        'multiple backends (OpenAI-compatible gateway, Ollama, or Anthropic). Use for implementation, refactoring, ' +
        'and code generation.',
      inputSchema: {
        prompt: z.string().describe('Prompt for Aider'),
        cwd: z.string().optional().describe('Project directory'),
        model: z.string().optional().describe('Override model (e.g. ollama/llama3); omit to use AIDER_MODEL env or default'),
        files: z.array(z.string()).optional().describe('Files to add to the Aider context')
      },
      annotations: { title: 'Aider one-shot', readOnlyHint: false, destructiveHint: true, openWorldHint: true }
    },
    async (args) => run(() => runAider(args))
  );

  // ── opencode_prompt — OpenCode one-shot ───────────────────────────────────
  server.registerTool(
    'opencode_prompt',
    {
      title: 'OpenCode one-shot',
      description:
        'Send a single prompt to the OpenCode CLI — an open-source AI coding agent that routes through an ' +
        'OpenAI-compatible gateway when one is configured. Use for implementation, rapid iteration, and first-pass ' +
        'live testing.',
      inputSchema: {
        prompt: z.string().describe('Prompt for OpenCode'),
        cwd: z.string().optional().describe('Project directory'),
        model: z.string().optional().describe('Override model; omit to use OPENCODE_MODEL env or default'),
        files: z.array(z.string()).optional().describe('Files to add to the OpenCode context')
      },
      annotations: { title: 'OpenCode one-shot', readOnlyHint: false, destructiveHint: true, openWorldHint: true }
    },
    async (args) => run(() => runOpencode(args))
  );

  // ── generic agent prompts (Gemini, Codex, Copilot, Goose, Amp, Qwen, Crush) ──
  // Registered from the same AGENT_PROVIDERS table the REST routes use, so the
  // MCP tool catalog and the REST surface stay in sync automatically.
  for (const name of GENERIC_AGENT_NAMES) {
    const blurb = AGENT_BLURBS[name] || name;
    server.registerTool(
      `${name}_prompt`,
      {
        title: `${blurb} one-shot`,
        description:
          `Send a single prompt to the ${blurb} CLI on the host. Use for implementation, testing, or any task that ` +
          `fits that agent. Paths and prompt flags are configurable via env (<NAME>_PATH).`,
        inputSchema: {
          prompt: z.string().describe(`Prompt for ${blurb}`),
          cwd: z.string().optional().describe('Project directory'),
          model: z.string().optional().describe('Override model; omit to use the CLI default'),
          files: z.array(z.string()).optional().describe('Files to add to the agent context')
        },
        annotations: { title: `${blurb} one-shot`, readOnlyHint: false, destructiveHint: true, openWorldHint: true }
      },
      async (args) => run(() => runAgent({ name, ...args }))
    );
  }

  // ── get_task — read one async task ───────────────────────────────────────
  server.registerTool(
    'get_task',
    {
      title: 'Get task result',
      description:
        'Fetch status and full output for an async task id returned by run_command or any agent prompt. ' +
        'Tasks are in-memory and disappear when the runner service restarts.',
      inputSchema: { id: z.string().describe('Task id') },
      annotations: { title: 'Get task result', readOnlyHint: true, openWorldHint: false }
    },
    async ({ id }) => run(() => getTask(id))
  );

  // ── list_tasks — read recent tasks ───────────────────────────────────────
  server.registerTool(
    'list_tasks',
    {
      title: 'List tasks',
      description:
        'List recent runner tasks newest-first with output truncated to 500 characters each. Read-only; ' +
        'use before restarting the runner if active work may be in progress.',
      inputSchema: {},
      annotations: { title: 'List tasks', readOnlyHint: true, openWorldHint: false }
    },
    async () => run(async () => listTasks())
  );

  // ── host_health — resource snapshot ──────────────────────────────────────
  server.registerTool(
    'host_health',
    {
      title: 'Host health',
      description:
        'Read-only health/resource snapshot of the host: hostname, platform, CPU count, memory, uptime, and task counts.',
      inputSchema: {},
      annotations: { title: 'Host health', readOnlyHint: true, openWorldHint: false }
    },
    async () => run(async () => healthPayload())
  );

  // ── host_info — service metadata ─────────────────────────────────────────
  server.registerTool(
    'host_info',
    {
      title: 'Host info',
      description:
        'Read-only service metadata: configured shell paths, REST endpoints, MCP tool catalog, transport notes, ' +
        'and runner caveats.',
      inputSchema: {},
      annotations: { title: 'Host info', readOnlyHint: true, openWorldHint: false }
    },
    async () => run(async () => infoPayload())
  );

  return server;
}
