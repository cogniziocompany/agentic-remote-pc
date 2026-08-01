# Remote-PC skills — install one per assistant

Each folder here is a "skill" that teaches one assistant how to drive a host
running agentic-remote-pc. A skill is just a small instruction file (plus, for
MCP clients, the MCP server connection). All of them are secret-free — paste
your own RUNNER_API_KEY and host URL where shown.

| Assistant | Skill folder | Connection | Install target |
|---|---|---|---|
| Claude Code | claude-code/remote-pc/ | MCP | ~/.claude/skills/ or .claude/skills/ |
| OpenAI Codex | codex/remote-pc/ | MCP | ~/.codex/ (skill + config.toml) |
| ChatGPT (web + Windows app) | chatgpt/ | MCP (Connector) | Custom GPT builder + Connectors |
| Cursor | cursor/ | MCP | .cursor/rules/ + .cursor/mcp.json |
| Gemini CLI | gemini/ | MCP | GEMINI.md + ~/.gemini/settings.json |
| Perplexity | perplexity/ | REST | Perplexity Agent API / Pro custom instructions |

## Shared contract (every skill teaches this)

- Base URL: https://your-host.example.com
- Auth header: Authorization: Bearer <RUNNER_API_KEY>  (or X-API-Key)
- Health (no auth): GET /health
- Run a command: POST /exec  { shell, command, cwd?, timeout?, env? }
- Drive an agent CLI: POST /<agent>  { prompt, cwd?, model?, files? }  (claude, cursor, aider, opencode, gemini, codex, copilot, goose, amp, qwen, crush)
- MCP endpoint (for MCP clients): POST /mcp  (Streamable HTTP, stateless)
- Async: add ?async=true to /exec or /<agent>, then GET /task/:id
- Workflow: health-check first, read-only discovery before changes, confirm
  before destructive actions, keep secrets out of output, report evidence
  (commands, changed files, build/deploy results, task ids).

---

## Claude Code

1. Install the skill (personal, all projects):

       mkdir -p ~/.claude/skills/remote-pc
       cp created-skills/claude-code/remote-pc/SKILL.md ~/.claude/skills/remote-pc/SKILL.md

   Or project-scoped: created-skills/claude-code/remote-pc/SKILL.md -> .claude/skills/remote-pc/SKILL.md

2. Register the runner as an MCP server:

       claude mcp add --transport http my-pc https://your-host.example.com/mcp \
         --header "Authorization: Bearer <RUNNER_API_KEY>"

3. Use it: type /remote-pc in Claude Code, or let it auto-trigger from the
   description. Verify with: claude mcp list

Skills follow the Agent Skills open standard (SKILL.md + YAML frontmatter), so
the same file works in other tools that support that standard.

## OpenAI Codex (CLI / IDE extension / Codex Cloud)

1. Install the skill:

       mkdir -p ~/.codex/skills/remote-pc/agents
       cp created-skills/codex/remote-pc/SKILL.md ~/.codex/skills/remote-pc/SKILL.md
       cp created-skills/codex/remote-pc/agents/openai.yaml ~/.codex/skills/remote-pc/agents/openai.yaml

   (Codex skills follow the Agent Skills open standard. If your Codex version
   reads skills from a different path, check "codex skills" in your CLI help and
   adjust — the SKILL.md content is unchanged.)

2. Register the runner as an MCP server in ~/.codex/config.toml:

       [mcp_servers.my-pc]
       url = "https://your-host.example.com/mcp"
       http_headers = { Authorization = "Bearer <RUNNER_API_KEY>" }

3. Verify: codex mcp list  (or the equivalent in your Codex version).

Codex also reads AGENTS.md for project context — the repo already ships one.

## ChatGPT (web and the Windows desktop app)

ChatGPT does not load file-based skills; the equivalent is a Custom GPT whose
Instructions are the skill body and whose Connector is the runner.

1. Create a GPT: chatgpt.com -> New GPT (or Create in the Windows app).
2. In Configure, paste the contents of created-skills/chatgpt/instructions.md
   into the Instructions field.
3. Add the runner as a Connector: Settings -> Connectors -> Add a connector ->
   Custom -> MCP -> Server URL https://your-host.example.com/mcp -> Authentication
   API key = <RUNNER_API_KEY>. Enable it. (Connectors need Pro/Team/Enterprise.)
4. In the GPT, ensure the connector is enabled for that GPT.

Refresh tip: ChatGPT caches tools/list at connect time. If the runner catalog
changes, fully remove and re-add the connector.

## Cursor

1. Install the rule (project-scoped):

       cp created-skills/cursor/remote-pc.mdc .cursor/rules/remote-pc.mdc

   Or user-scoped: ~/.cursor/rules/remote-pc.mdc

2. Register the runner MCP server in .cursor/mcp.json (merge into existing):

       {
         "mcpServers": {
           "my-pc": {
             "url": "https://your-host.example.com/mcp",
             "headers": { "Authorization": "Bearer <RUNNER_API_KEY>" }
           }
         }
       }

3. The rule (frontmatter description + alwaysApply) tells Cursor when/how to use
   the runner tools. Cursor can take 10-15s on first connection.

## Gemini CLI

1. Add the runner MCP server to ~/.gemini/settings.json (merge mcpServers):

       See created-skills/gemini/settings.json

2. Add project context: copy created-skills/gemini/GEMINI.md to your project
   root as GEMINI.md (Gemini CLI reads GEMINI.md like AGENTS.md/CLAUDE.md), or
   to ~/.gemini/GEMINI.md for all projects.

3. Verify the server is loaded: gemini mcp list  (or /mcp in a session).

Note: the HTTP-server key in settings.json is url (Streamable HTTP) in current
Gemini CLI; if your version differs, check "gemini mcp --help".

## Perplexity

Perplexity has no user-facing custom-MCP-client config, so the "skill" is a
system prompt that tells Perplexity (Agent API, Perplexity CLI, or Pro custom
instructions) how to drive the runner over REST.

1. Use created-skills/perplexity/instructions.md as:
   - the system prompt for a Perplexity Agent API / CLI agent, or
   - the Custom Instructions in Perplexity Pro (Settings -> Customize).
2. The prompt instructs the model to call the REST endpoints with the bearer
   (GET /health, POST /exec, POST /<agent>, GET /task/:id).

Note: you mentioned you will add your own Perplexity skill from another branch —
this file is a starter template you can replace.

---

## Security

Every skill is destructive in effect: run_command and *_prompt execute real
commands on a real host. Set RUNNER_API_KEY before exposing the runner, keep
skills secret-free (never paste a real key into a committed file), and prefer
TLS plus an extra auth layer in front of your tunnel/relay.
