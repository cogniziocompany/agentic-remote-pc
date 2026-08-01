# Remote PC Control (agentic-remote-pc) — Gemini CLI context

You have an MCP server named my-pc connected to a host running agentic-remote-pc.
Use its tools to drive the real machine.

## MCP tools

- host_health, host_info — read-only host snapshot and tool/endpoint catalog. Start here.
- run_command — run a shell command. shell options: pwsh, powershell, cmd (Windows); bash, zsh (Linux/macOS); or an agent CLI name (claude, cursor, aider, opencode, gemini, codex, copilot, goose, amp, qwen, crush). Returns a task id + output.
- claude_prompt, claude_session, cursor_prompt, cursor_session — drive the local Claude Code or Cursor agent CLI on the host.
- aider_prompt, opencode_prompt, gemini_prompt, codex_prompt, copilot_prompt, goose_prompt, amp_prompt, qwen_prompt, crush_prompt — drive other coding-agent CLIs on the host.
- get_task, list_tasks — read async task results.

## Workflow

1. Call host_health first; stop and report if it fails (the host or tunnel may be down).
2. Read-only discovery before changes.
3. Confirm before destructive actions (restart services, kill processes, change credentials, install software, deploy, clear tasks).
4. Orchestrate agents when useful: implement with claude_prompt, validate with cursor_prompt or another.
5. Keep secrets out of output.
6. Report evidence: commands, changed files, build/deploy results, task ids, blockers.

## Notes

- cmd/powershell are Windows-only; bash/zsh are native on Linux/macOS.
- Task history is in-memory and cleared on restart.
- 5-minute default timeout; use async + get_task for longer work.
- Missing CLIs fail with a clear error.
