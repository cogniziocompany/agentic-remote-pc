# Cognizio's Agent skill brdige to your PC
# Connect any A.i. / LLM providers to your PC via a skill
## agentic-remote-pc

> Turn any PC — Windows or Linux — into a secure, agent-controllable workstation.
> One authenticated gateway exposes your real shells **and** a whole fleet of coding-agent CLIs over **REST + MCP**, so cloud agents (ChatGPT, Claude, Cursor, Codex, Gemini) can drive your actual machine from anywhere.

Most AI coding agents live locked in the cloud or a single IDE. **agentic-remote-pc** is the missing remote-control layer for agentic coding: bring-your-own-agent, bring-your-own-PC. Run real commands on real hardware, chain one agent's output into another, and let a cloud model orchestrate a local fleet — through one bearer-protected endpoint you control.

```text
Remote agent (ChatGPT / Claude / Cursor / Codex / Gemini / curl)
        │
        ▼
   your-host.example.com        ◀── Cloudflare Tunnel  OR  self-hosted relay (frp/rathole/bore/chisel)
        │
        ▼
   localhost:7334               (Node.js, runs natively on the host)
        │
        ├──▶ pwsh / powershell / cmd        (Windows shells)
        ├──▶ bash / zsh                     (Linux/macOS shells)
        ├──▶ claude  cursor  aider  opencode
        └──▶ gemini  codex  copilot  goose  amp  qwen  crush
```

Two protocol heads share one engine (`src/runner.js`):

- **REST** — `/exec`, `/claude`, `/cursor`, `/<agent>`, `/task`, … for scripts, `curl`, Perplexity Computer, custom orchestrators.
- **MCP** — `/mcp` (Streamable HTTP) for ChatGPT (developer mode), OpenAI Codex, Claude Code, Cursor, and Gemini.

Both are protected by the same `RUNNER_API_KEY` bearer.

**This is the whole point of the tool.** agentic-remote-pc is the bridge every
assistant connects to: one host, one endpoint, and each of your assistants can
drive that machine.

- ChatGPT (web + Windows app), OpenAI Codex, Claude (Code CLI / Desktop / Claude.ai), Cursor, Gemini — over **MCP** at /mcp.
- Perplexity, curl, scripts, n8n, custom orchestrators — over **REST**.
- LiteLLM-type LLM gateways — register the runner as an MCP server so any model through the gateway gets host tools.

Full per-client setup: **[docs/connect-clients.md](docs/connect-clients.md)**.  Gateway wiring: **[docs/litellm-gateway.md](docs/litellm-gateway.md)**.

---

## Why

- **Real hardware, not sandboxes.** Agents run against your actual filesystem, services, build tooling, and network — no cloud sandbox approximation.
- **Every agent, one bridge.** Don't pick a vendor; expose Claude, Cursor, Gemini, Codex, Copilot, Aider, OpenCode, Goose, Amp, Qwen, and Crush behind one consistent API.
- **Agent-to-agent orchestration.** A cloud model can call `run_command` to drive a *local* coding agent, then validate the result with a second one — the built-in pattern for parallel implementation + review.
- **Self-hosted by default.** No vendor tunnel required: run your own relay on a $5 VPS and a domain you own, or use Cloudflare Tunnel if you prefer zero infrastructure.

---

## Quick Start

### Prerequisites

- **Node.js** 18+
- A shell: **PowerShell 7+** (`winget install Microsoft.PowerShell`) on Windows, or **bash/zsh** on Linux/macOS
- Any coding-agent CLIs you want to expose (all optional — absent CLIs fail gracefully)
- **Docker** — only if you use the Cloudflare Tunnel sidecar

### 1. Clone & install

```bash
git clone https://github.com/cogniziocompany/agentic-remote-pc.git
cd agentic-remote-pc
npm install
```

### 2. Configure

```bash
cp .env.example .env
```

At minimum set an API key (generate one with `node -e "console.log(require('crypto').randomUUID())"`):

```ini
RUNNER_API_KEY=your-secret-key-here
```

Optionally point the `*_PATH` variables at the agent CLIs you have installed. See `.env.example` for the full list.

### 3. Run the server

**Windows (NSSM service — recommended for always-on)**

```powershell
# First-time setup (run as admin):
$nssm = 'C:\Tools\nssm\nssm.exe'   # or wherever you installed NSSM
& $nssm install agentic-remote-pc-runner "C:\Program Files\nodejs\node.exe" "$PWD\src\server.js"
& $nssm set agentic-remote-pc-runner AppDirectory "$PWD"
& $nssm set agentic-remote-pc-runner Start SERVICE_AUTO_START
& $nssm start agentic-remote-pc-runner
```

Manage it:

```powershell
sc.exe query agentic-remote-pc-runner
C:\Tools\nssm\nssm.exe restart agentic-remote-pc-runner   # pick up code changes
```

**Linux (systemd service — recommended for always-on)**

```bash
sudo ./deploy/install-linux.sh        # installs + enables the unit, then starts it
sudo systemctl restart agentic-remote-pc   # pick up code changes
```

The unit file is `deploy/agentic-remote-pc.service` (runs `node src/server.js` from the repo dir).

**Dev (either OS)**

```bash
npm run dev    # auto-restart on file changes
```

### 4. Expose it (pick one)

**Option A — Cloudflare Tunnel (managed, zero infra)**

1. Create a tunnel in the [Cloudflare Zero Trust dashboard](https://one.dash.cloudflare.com/).
2. Add a public hostname pointing at `http://host.docker.internal:7334`.
3. Put the tunnel token in `.env` as `CLOUDFLARE_TUNNEL_TOKEN`.
4. Run the sidecar:

   ```bash
   docker compose up -d
   ```

**Option B — Self-hosted relay (no vendor lock-in)**

Run your own relay on a VPS + a domain you own. `frp` (Fast Reverse Proxy) is the documented default; `rathole`, `bore`, and `chisel` are covered too. See **[docs/self-hosted-tunnel.md](docs/self-hosted-tunnel.md)** — includes sample `frps.toml`/`frpc.toml` and TLS via Caddy + Let's Encrypt.

### 5. Verify

```bash
curl https://your-host.example.com/health

curl -X POST https://your-host.example.com/exec \
  -H "Authorization: Bearer $RUNNER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"shell":"pwsh","command":"Get-Date"}'
```

---

## Supported shells & agents

| Shell | What it runs | Notes |
|---|---|---|
| `pwsh` / `powershell` / `cmd` | Windows shells | `pwsh` is cross-platform PowerShell 7+ |
| `bash` / `zsh` | POSIX shells | native on Linux/macOS |
| `claude` | Claude Code CLI | `npm i -g @anthropic-ai/claude-code` |
| `cursor` | Cursor agent CLI | ships with Cursor IDE |
| `aider` | Aider | `pip install aider-chat`, multi-backend |
| `opencode` | OpenCode | open-source coding agent |
| `gemini` | Google Gemini CLI | `npm i -g @google/gemini-cli` |
| `codex` | OpenAI Codex CLI | `npm i -g @openai/codex` |
| `copilot` | GitHub Copilot CLI | GitHub auth |
| `goose` | Block Goose | open-source |
| `amp` | Sourcegraph Amp | open-source |
| `qwen` | Qwen Code | open-source |
| `crush` | Charm Crush | open-source |

All four shells and every agent CLI are optional. Provider paths and prompt flags are configurable via env (`*_PATH`); if a CLI uses a different headless flag than the default, wrap it in a one-line script and point `*_PATH` at it. Adding a new CLI is a few lines in `AGENT_PROVIDERS` (`src/runner.js`) — the REST routes and MCP tools pick it up automatically.

---

## API Reference

All endpoints except `/health` require `Authorization: Bearer <RUNNER_API_KEY>` or `X-API-Key: <RUNNER_API_KEY>`.

### POST /exec

```json
{ "shell": "pwsh", "command": "Get-Date", "cwd": "C:\\Projects", "timeout": 60000, "env": { "FOO": "bar" } }
```

Add `?async=true` to return a task id immediately (poll via `GET /task/:id`).

### POST /exec/stream

Same as `/exec` but Server-Sent Events (`stdout`, `stderr`, `done`, `error`).

### POST /<agent>

`/claude`, `/cursor`, `/aider`, `/opencode`, `/gemini`, `/codex`, `/copilot`, `/goose`, `/amp`, `/qwen`, `/crush` — each accepts `{ "prompt": "...", "cwd": "...", "model": "...", "files": [...] }` (plus agent-specific options for `claude`/`cursor`) and returns a task result.

### POST /claude/session · POST /cursor/session

Continue/resume an agent session in a workspace.

### GET /task/:id · GET /tasks · DELETE /tasks

Async task status, history, and clearing. Task store is in-memory (cleared on restart).

### GET /health (no auth) · GET /info

Health check and the full endpoint/tool catalog.

### ALL /mcp

The Model Context Protocol head (Streamable HTTP, stateless). See below.

---

## MCP Interface (ChatGPT / Codex / Claude / Cursor / Gemini)

The same engine is exposed over MCP at ALL /mcp (Streamable HTTP, stateless JSON
for broad client compatibility). MCP clients discover tools via tools/list and
invoke them via tools/call, authenticated by the same RUNNER_API_KEY bearer.

**Tools (18):** run_command, claude_prompt, claude_session, cursor_prompt,
cursor_session, aider_prompt, opencode_prompt, gemini_prompt, codex_prompt,
copilot_prompt, goose_prompt, amp_prompt, qwen_prompt, crush_prompt, get_task,
list_tasks, host_health, host_info.

**Connect each assistant** (endpoint https://your-host.example.com/mcp, bearer =
RUNNER_API_KEY) — full step-by-step for every client in
[docs/connect-clients.md](docs/connect-clients.md):

| Client | How |
|---|---|
| ChatGPT (web + Windows app) | Settings -> Connectors -> Custom MCP, URL + API key |
| OpenAI Codex (CLI/IDE/Cloud) | ~/.codex/config.toml [mcp_servers.*] |
| Claude Code CLI | claude mcp add --transport http |
| Claude Desktop / Claude.ai | Connectors UI |
| Cursor | mcp.json (url + headers) |
| Gemini CLI | ~/.gemini/settings.json |
| Perplexity | REST API (/exec, /<agent>) — no MCP-client config |
| LiteLLM / LLM gateways | register /mcp in gateway mcp_servers — see docs/litellm-gateway.md |

> ChatGPT caches the tool list at connect time. If the catalog changes, fully
> remove and re-add the connector.

## Test app & smoke tests

- `npm run smoke` runs `e2e/runner-smoke.mjs` — a no-server import test that asserts the shell/endpoint/MCP-tool surface wires up correctly.
- `e2e/harness-e2e.mjs` exercises the live REST API against a running server.
- `examples/drive-runner.mjs` is a minimal end-to-end demo: health → run a shell command → drive an agent CLI → poll a task. See [examples/](examples/).

---

## Security

- **Always set `RUNNER_API_KEY`** before exposing the server. Without it, anyone who reaches the URL has full shell access to your machine.
- The server runs with the permissions of the user/service account that starts it — it can do anything that account can.
- Add Cloudflare Access (or your relay's auth/TLS) on top of the tunnel for a second auth layer.
- The task store is in-memory and cleared on restart; `DELETE /tasks` wipes sensitive output.
- Treat `run_command` and all `*_prompt` tools as destructive: they execute arbitrary commands on your host.
- If you commit a key by accident, **rotate it** — removing the file does not scrub git history.

---

## Configuration

| Env var | Default | Description |
|---|---|---|
| `RUNNER_API_KEY` | (none) | Auth key. **Set before exposing.** |
| `RUNNER_PORT` | `7334` | HTTP server port |
| `PWSH_PATH` / `CMD_PATH` / `ZSH_PATH` | `pwsh`/`cmd`/`zsh` | Shell executables |
| `CLAUDE_PATH` … `CRUSH_PATH` | CLI names | Coding-agent CLI paths |
| `MAX_TIMEOUT_MS` | `300000` | Max command time (5 min) |
| `MAX_OUTPUT_BYTES` | `5242880` | Max output buffer (5 MB) |
| `LITELLM_BASE_URL` / `LITELLM_MASTER_KEY` | (none) | Optional OpenAI-compatible gateway for Aider/OpenCode |
| `RUNNER_EVENTS_*` | off | Optional signed completion-event webhooks |
| `CLAUDE_SKIP_PERMISSIONS` | `0` | `--dangerously-skip-permissions` for full-auto Claude |
| `CLOUDFLARE_TUNNEL_TOKEN` | (none) | Tunnel token for the docker-compose sidecar |

Full list in `.env.example`.

---

## Remote-PC skills

`created-skills/` ships one ready-to-install skill per assistant, all
secret-free: Claude Code, OpenAI Codex, ChatGPT (web + Windows app), Cursor,
Gemini CLI, and Perplexity. Each teaches the assistant the runner contract
(health-first, read-only discovery, confirm destructive actions, keep secrets
out, report evidence) and where to install for that platform.

See **[created-skills/README.md](created-skills/README.md)** for per-platform
install steps and the shared contract. Copy a skill, set your host URL +
RUNNER_API_KEY in the connection config, and install it.

## License

This project is dual-licensed (see [LICENSE](LICENSE)):

- **Private and non-commercial use** is free of charge, including use by
  open-source projects.
- **Commercial or organizational use** (use by/for a business, organization, or
  government, use in a paid product or service, internal business operations,
  consulting engagements, or any production deployment) requires a separate
  commercial license from Cognizio Company.

Copyright (c) 2026 Cognizio Company. Contact Cognizio Company for commercial
licensing.
