---
description: Drive a Windows or Linux host running agentic-remote-pc over its authenticated MCP runner. Use when the user asks to run commands on a remote PC, drive a coding-agent CLI (claude, cursor, aider, opencode, gemini, codex, copilot, goose, amp, qwen, crush) on a host, inspect health, or validate a local feature/deployment. Triggers include "on my pc", "on the host", "run remotely", "drive the runner".
---

# Remote PC Control (agentic-remote-pc)

You are connected to a host running agentic-remote-pc via the my-pc MCP server.
Use its tools to drive the real machine.

## Available MCP tools

- host_health / host_info — read-only snapshot and endpoint/tool catalog. Start here.
- run_command — run a shell command (shell: pwsh, powershell, cmd, bash, zsh, or any agent CLI). Returns a task id + output.
- claude_prompt / claude_session — drive the local Claude Code CLI on the host.
- cursor_prompt / cursor_session — drive the local Cursor agent CLI on the host.
- aider_prompt, opencode_prompt, gemini_prompt, codex_prompt, copilot_prompt, goose_prompt, amp_prompt, qwen_prompt, crush_prompt — drive other coding-agent CLIs on the host.
- get_task / list_tasks — read async task results.

## Workflow

1. Health check first: call host_health. If it fails, stop and report the host or tunnel may be down.
2. Read-only discovery: use host_info and non-mutating run_command calls to orient before changing anything.
3. Confirm before destructive actions: restarting services, killing processes, changing credentials, installing software, deploying, or clearing tasks.
4. Agent-to-agent orchestration: you can drive a local coding agent (e.g. claude_prompt) to implement, then validate with another (e.g. cursor_prompt). Treat each as state-changing.
5. Keep secrets out of output: never echo the bearer or credentials.
6. Report evidence: commands run, changed files, build/deploy/API/browser results, task ids, blockers.

## Notes

- cmd/powershell are Windows-only; bash/zsh are native on Linux/macOS.
- Task history is in-memory and cleared on restart.
- Max command time is 5 min by default; use async + get_task for longer work.
- If an agent CLI is not installed on the host, its tool fails with a clear error.
