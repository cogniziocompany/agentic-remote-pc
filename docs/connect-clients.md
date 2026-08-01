# Connect your assistants to the host

> **This is what agentic-remote-pc is for.** It is the bridge between your
> assistants — ChatGPT, Codex, Claude, Cursor, Gemini, Perplexity — and a real
> machine. One host runs the runner; every assistant connects to the same
> authenticated endpoint and can then run real commands and drive local
> coding-agent CLIs on that host. One bridge, every agent, one PC.

The runner speaks **two protocols over one engine**:

- **MCP** at `POST /mcp` (Streamable HTTP, stateless) — for assistants that are
  MCP clients (ChatGPT, Codex, Claude, Cursor, Gemini). They discover tools via
  `tools/list` and invoke them via `tools/call`.
- **REST** at `/exec`, `/<agent>`, `/task`, … — for everything that speaks HTTP
  (Perplexity, `curl`, scripts, n8n, custom orchestrators).

Both are protected by the same `RUNNER_API_KEY` bearer. In every snippet below,
replace `https://your-host.example.com` with your tunnel/relay URL and
`<RUNNER_API_KEY>` with your key.

| Assistant | Protocol | How to connect |
|---|---|---|
| ChatGPT (web + Windows app) | MCP | Connectors UI (developer mode) |
| OpenAI Codex (CLI / IDE / Cloud) | MCP | `~/.codex/config.toml` |
| Claude Code CLI | MCP | `claude mcp add` |
| Claude Desktop / Claude.ai | MCP | Connectors UI |
| Cursor | MCP | `mcp.json` |
| Gemini CLI | MCP | `~/.gemini/settings.json` |
| Perplexity | REST | HTTP calls to `/exec`, `/<agent>` |
| curl / scripts / n8n | REST | HTTP + bearer |

---

## ChatGPT (web and the Windows desktop app)

ChatGPT's custom Connectors speak remote MCP, so the runner works unchanged in
both `chatgpt.com` and the ChatGPT **Windows app** (and the Mac app).

1. In ChatGPT, open **Settings → Connectors → Add a connector → Custom**.
2. Choose type **MCP**.
3. **Server URL:** `https://your-host.example.com/mcp`
4. **Authentication:** API key — paste the raw `RUNNER_API_KEY` (ChatGPT sends
   it as the `Authorization` header).
5. Save and enable the connector.

Notes:
- The connector is **private to your workspace**. A public "Apps in ChatGPT"
  directory listing is a separate OpenAI review process and not unlocked by this.
- ChatGPT **caches the tool list at connect time**. If the runner's tool catalog
  changes, fully **remove and re-add** the connector — a disconnect/reconnect
  will not re-fetch `tools/list`.

## OpenAI Codex (CLI / IDE extension / Codex Cloud)

Codex shares one config file (`~/.codex/config.toml`) across the CLI, the IDE
extension, and Codex Cloud:

```toml
[mcp_servers.my-pc]
url = "https://your-host.example.com/mcp"
http_headers = { Authorization = "Bearer <RUNNER_API_KEY>" }
```

Alternatively, reference an env var instead of inlining the key:

```toml
[mcp_servers.my-pc]
url = "https://your-host.example.com/mcp"
bearer_token_env_var = "RUNNER_API_KEY"
```

Verify with `codex mcp list` (or the equivalent in your Codex version).

## Claude

### Claude Code CLI

```bash
claude mcp add --transport http my-pc https://your-host.example.com/mcp \
  --header "Authorization: Bearer <RUNNER_API_KEY>"
claude mcp list        # verify it appears
```

The runner can also **drive the local Claude Code CLI** via `POST /claude`
(`claude_prompt` MCP tool) — make sure `claude login` has been run on the host
first.

### Claude Desktop and Claude.ai

Both support **remote MCP** through their Connectors UI:

1. **Settings → Connectors → Add custom connector.**
2. Server URL: `https://your-host.example.com/mcp`
3. Authentication: API key / bearer = `<RUNNER_API_KEY>`.
4. Enable it.

(Claude Desktop additionally supports *local* stdio MCP servers via
`claude_desktop_config.json`, but for a remote host like this the Connectors UI
is the right path.)

## Cursor

Add the server to `.cursor/mcp.json` (project-scoped) or `~/.cursor/mcp.json`
(global):

```json
{
  "mcpServers": {
    "my-pc": {
      "url": "https://your-host.example.com/mcp",
      "headers": { "Authorization": "Bearer <RUNNER_API_KEY>" }
    }
  }
}
```

Cursor can take 10–15 seconds on first connection while it initializes — known
Cursor behavior, not a runner bug.

## Gemini CLI

Google's Gemini CLI reads `~/.gemini/settings.json`:

```json
{
  "mcpServers": {
    "my-pc": {
      "url": "https://your-host.example.com/mcp",
      "headers": { "Authorization": "Bearer <RUNNER_API_KEY>" }
    }
  }
}
```

The HTTP-server key is `url` (Streamable HTTP) in current Gemini CLI versions;
if your version uses a different field name, check `gemini mcp --help`.

## Perplexity

Perplexity does **not** expose a custom-MCP-client configuration for end users,
so connect via the **REST API** instead. Perplexity Computer / agents that can
make HTTP calls drive the runner directly:

```bash
# Liveness (no auth)
curl https://your-host.example.com/health

# Run a real command on the host
curl -X POST https://your-host.example.com/exec \
  -H "Authorization: Bearer <RUNNER_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"shell":"pwsh","command":"Get-Date"}'

# Drive a local coding-agent CLI on the host
curl -X POST https://your-host.example.com/claude \
  -H "Authorization: Bearer <RUNNER_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"prompt":"Summarize the repo in src/"}'
```

If you orchestrate Perplexity from another tool (n8n, a script, its API), point
that tool at the same REST endpoints with the bearer.

## REST — anything else (curl, scripts, n8n, custom orchestrators)

Same base URL + bearer. Useful endpoints:

| Method | Path | Body |
|---|---|---|
| `GET` | `/health` | — |
| `GET` | `/info` | — |
| `POST` | `/exec` | `{ shell, command, cwd?, timeout?, env? }` |
| `POST` | `/<agent>` | `{ prompt, cwd?, model?, files? }` |
| `POST` | `/exec?async=true` | same — returns a task id |
| `GET` | `/task/:id` | — |
| `POST` | `/mcp` | raw JSON-RPC (`tools/list`, `tools/call`) |

---

## How it works under the hood

1. An assistant calls the runner (MCP `tools/call` or a REST `POST`).
2. `src/runner.js` spawns the requested shell or coding-agent CLI **on the host**
   with the host's real filesystem, services, and network.
3. stdout/stderr + exit code are captured as a task and returned to the
   assistant.
4. Because every assistant hits the same endpoint, one assistant can drive a
   *local* coding agent (e.g. ChatGPT → `claude_prompt`) and another can
   validate the result (e.g. Claude → `cursor_prompt`). That agent-to-agent
   orchestration is the core workflow this tool enables.

Security reminder: `run_command` and every `*_prompt` tool are destructive —
they execute arbitrary commands on your host. Always set `RUNNER_API_KEY` before
exposing the runner, and prefer TLS + an extra auth layer in front of your
tunnel/relay.

---

## LLM gateways (LiteLLM and similar)

To wire the runner into a LiteLLM-type gateway — so every model routed through
the gateway gets the runner tools, or so the runner agent CLIs use the gateway as
their model backend — see docs/litellm-gateway.md. It covers both directions
(gateway -> runner as an MCP tool source, and runner -> gateway as the model
backend) with config snippets, plus an Ollama-via-LiteLLM example for giving a
local model tool access to a real host.
