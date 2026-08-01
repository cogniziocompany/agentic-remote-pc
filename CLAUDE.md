# AGENTS.md — Project Intelligence

> AGENTS.md and CLAUDE.md are a byte-identical pair: each toolchain looks up
> project intelligence under its own filename (Claude Code reads CLAUDE.md,
> Codex and others read AGENTS.md). Edit one, copy it over the other. The
> pre-commit hook in `.githooks/` fails the commit if they diverge — enable it
> once per clone with `npm run hooks:install`.

## What is this?

**agentic-remote-pc** is an HTTP shell proxy that exposes a Windows or Linux
host's shells and a fleet of coding-agent CLIs over authenticated **REST and
MCP** endpoints. It runs natively (not containerized) and can be exposed through
a Cloudflare Tunnel or any self-hosted relay you operate. The same
`RUNNER_API_KEY` bearer protects both — REST for scripts/agents, MCP for
ChatGPT / Codex / Claude Code / Cursor / Gemini.

## Architecture

```
Remote agent (ChatGPT / Claude / Cursor / Codex / Gemini / curl)
        │
        ▼
   your-host.example.com   (Cloudflare Tunnel  OR  self-hosted relay)
        │
        ▼
   localhost:7334  (Node.js Express server running on the host)
        ├──▶ pwsh / powershell / cmd / bash / zsh
        ├──▶ claude  cursor  aider  opencode
        └──▶ gemini  codex  copilot  goose  amp  qwen  crush
```

## Key Files

- `src/server.js` — Express app: REST routes + MCP transport mount + auth + banner
- `src/runner.js` — Shared execution engine (spawns shells/CLIs, task store). Used
  by BOTH the REST routes and the MCP tools — change command behavior here, not
  in a route. Houses `SHELL_MAP` and the data-driven `AGENT_PROVIDERS` table.
- `src/mcp.js` — MCP server: wraps the runner helpers as MCP tools (`createMcpServer()`)
- `.env.example` — Config template (copy to `.env`)
- `docker-compose.yml` — Only runs the Cloudflare Tunnel sidecar (server runs on host)
- `deploy/` — Linux systemd unit + installer, and self-hosted relay (frp) configs
- `docs/self-hosted-tunnel.md` — Self-hosted tunnel alternatives (frp/rathole/bore/chisel)
- `e2e/` — smoke + harness tests; `examples/` — demo driver
- `created-skills/` — one secret-free skill per assistant (Claude Code, Codex,
  ChatGPT, Cursor, Gemini, Perplexity) + install guide (created-skills/README.md)

## Shell Endpoints

| Endpoint | Purpose |
|---|---|
| `POST /exec` | Run a command in any supported shell/CLI |
| `POST /exec/stream` | Same, SSE streaming |
| `POST /claude` / `/claude/session` | Claude Code one-shot / continue |
| `POST /cursor` / `/cursor/session` | Cursor agent one-shot / workspace |
| `POST /aider` · `/opencode` | Open-source coding agents |
| `POST /gemini` · `/codex` · `/copilot` · `/goose` · `/amp` · `/qwen` · `/crush` | Other agent CLIs |
| `ALL /mcp` | MCP (Streamable HTTP) — ChatGPT / Codex / Claude / Cursor / Gemini |
| `GET /task/:id` · `GET /tasks` · `DELETE /tasks` | Async task results + history |
| `GET /health` · `GET /info` | Health (no auth) + API docs |

## Auth

All endpoints except `/health` require `Authorization: Bearer <key>` or
`X-API-Key: <key>`. The key is `RUNNER_API_KEY`. If unset, the server runs open
(dev mode). The MCP endpoint (`/mcp`) is protected by the same bearer via the
global `requireAuth` middleware.

## MCP interface

Streamable HTTP transport, stateless (`sessionIdGenerator: undefined`) so
clients like ChatGPT that don't replay `mcp-session-id` work without a session
handshake. The tool catalog mirrors the REST capabilities (see Key Files).

Connect clients to https://your-host.example.com/mcp with the bearer.
Per-client setup for ChatGPT (web + Windows app), Codex, Claude (Code CLI /
Desktop / Claude.ai), Cursor, Gemini, and Perplexity (REST) is in
docs/connect-clients.md. Wiring the runner into LiteLLM-type LLM gateways
(so any model through the gateway gets host tools, or the runner CLIs use the
gateway as their model backend) is in docs/litellm-gateway.md. This
connectivity is the core function of the tool: one bridge every assistant
connects to.
README "MCP Interface" for per-client snippets).

## Runtime

### Windows — NSSM service
- Service name: `agentic-remote-pc-runner`
- Restart after code changes: `nssm restart agentic-remote-pc-runner` (elevated)
- Run `npm install` first if dependencies changed.

### Linux — systemd service
- Unit: `deploy/agentic-remote-pc.service` (install via `deploy/install-linux.sh`)
- Restart after code changes: `sudo systemctl restart agentic-remote-pc`

### Cloudflare Tunnel sidecar
- `docker compose up -d` runs only `cloudflared`; the Node server stays on the host.

### Startup order after reboot
1. Docker/systemd starts the tunnel/relay sidecar (auto-restart).
2. The runner service starts automatically on port 7334.
3. Traffic flows once the relay connects to its edge/server.

## Adding a coding-agent CLI

1. Add an entry to `AGENT_PROVIDERS` in `src/runner.js` (`exe`, `promptArgs`, `modelFlag`).
2. Add a matching line to `SHELL_MAP`.
3. The REST route (`POST /<name>`) and MCP tool (`<name>_prompt`) are registered
   automatically from `GENERIC_AGENT_NAMES`.

## Important Notes

- The server MUST run natively on the host, not in a container — it needs real
  access to host shells and CLIs.
- Docker compose is ONLY for the Cloudflare Tunnel sidecar.
- On Windows, `.cmd`/`.bat` CLIs need `shell:true` spawning (handled by
  `needsShell()`/`safeExe()` in runner.js); on Linux/macOS CLIs spawn directly.
- Max timeout is 5 minutes by default (`MAX_TIMEOUT_MS`); use `?async=true` +
  `/task/:id` for longer work.
- Task store is in-memory only — tasks are lost on restart.
- If a key is committed by accident, rotate it; removing the file does not
  scrub git history.
