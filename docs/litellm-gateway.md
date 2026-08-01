# Wire agentic-remote-pc into LiteLLM (and other LLM gateways)

A LiteLLM-type gateway sits between your models and their tools. agentic-remote-pc
is a standard MCP server (Streamable HTTP at /mcp), so it plugs into such a
gateway in two directions:

- Gateway -> runner (runner as a tool source): register the runner /mcp in the
  gateway mcp_servers config. Every model routed through the gateway can then
  call run_command, claude_prompt, cursor_prompt, ... i.e. drive a real host.
  This is the usual "wire it into LiteLLM" case.
- Runner -> gateway (gateway as the model backend): the runner open-source agent
  CLIs (Aider, OpenCode) can route their own LLM calls through the gateway via
  LITELLM_BASE_URL / LITELLM_MASTER_KEY. Already supported; see .env.example.

Both use the same RUNNER_API_KEY bearer.

> Note: the per-host mcp-* branches in this repo only added the MCP interface
> itself (now unified into release/public). The LiteLLM gateway config lives in
  your gateway deployment; the snippets below are all you need to point it at a
  runner.

---

## Direction A - register the runner as an MCP server in LiteLLM

Add the runner to your litellm_config.yaml under mcp_servers:

    model_list:
      - model_name: local-qwen
        litellm_params:
          model: ollama/qwen2.5:32b
          api_base: http://localhost:11434

    mcp_servers:
      my-pc:
        type: url                                # Streamable HTTP (some LiteLLM versions use type: http)
        url: https://your-host.example.com/mcp
        headers:
          Authorization: "Bearer <RUNNER_API_KEY>"

Start the gateway:

    litellm --config litellm_config.yaml --port 4000

Now any client hitting the gateway can ask a model to use the runner tools. The
runner appears as one MCP server exposing all 18 tools (run_command,
claude_prompt, ... host_info). LiteLLM proxies the model tools/call to the
runner /mcp, the runner spawns the real shell/CLI on the host, and the result
flows back to the model.

Why this matters: it is how you give a local or open model (Ollama, vLLM,
LM Studio, etc. fronted by LiteLLM) the ability to act on a real machine - the
model gets tool access, the runner does the real work, the gateway handles model
routing and keys.

Version note: LiteLLM key for Streamable HTTP is type: url in recent versions
(older/newer builds may use type: http). Some versions accept auth_token instead
of headers. If tools/list against the runner does not resolve, check your LiteLLM
version MCP docs and switch the type/header keys accordingly. The runner itself
is transport-stable: stateless Streamable HTTP, JSON responses, no
mcp-session-id required.

## Direction B - route the runner agent CLIs through the gateway

Aider and OpenCode (invoked via POST /aider and POST /opencode) can use the
gateway as their LLM backend instead of direct vendor APIs. In the runner .env:

    LITELLM_BASE_URL=https://litellm.yourdomain.com
    LITELLM_MASTER_KEY=<your-gateway-key>
    AIDER_MODEL=ollama/qwen2.5:32b
    OPENCODE_MODEL=ollama/qwen2.5:32b

When LITELLM_BASE_URL is set, the runner points those CLIs at the gateway
(OPENAI_API_BASE / LOCAL_ENDPOINT). When unset, each CLI uses its own native
configuration - nothing is hardcoded.

## Other MCP-aware gateways / routers

The same pattern works for any router that can register a remote MCP server
(OpenRouter-style tool routers, custom MCP aggregators, etc.). Point them at
https://your-host.example.com/mcp with an Authorization: Bearer <RUNNER_API_KEY>
header.

## Security

Registering the runner in a gateway exposes its tools to every model/client the
gateway serves. Set RUNNER_API_KEY, keep the gateway behind its own auth, and
treat run_command + *_prompt as destructive (arbitrary host execution).
