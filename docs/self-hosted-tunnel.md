# Self-hosted tunnel for agentic-remote-pc
#
# If you'd rather not depend on Cloudflare's edge, run your own relay on a
# cheap VPS and a domain you own. Nothing here is vendor-specific. The runner
# stays on your host (localhost:7334); the relay just forwards a public
# hostname to it.
#
# The documented default is **frp** (Fast Reverse Proxy, Apache-2.0). Lighter
# alternatives are listed at the bottom.
#
# ─────────────────────────────────────────────────────────────────────────────
# 1. frp — https://github.com/fatedier/frp
# ─────────────────────────────────────────────────────────────────────────────
# Architecture:  your-host (frpc) ──▶ VPS (frps) ◀─── public DNS ─── pc.yourdomain.com
#
# On the VPS:
#   - Point a DNS A record for pc.yourdomain.com at the VPS IP.
#   - Copy deploy/frps.toml, set auth.token, run `./frps -c frps.toml`.
#
# On the host running agentic-remote-pc:
#   - Copy deploy/frpc.toml, set YOUR_VPS_IP + customDomains + auth.token.
#   - Run `./frpc -c frpc.toml`.
#
# TLS: frp's `https` vhost uses a cert for customDomains. The simplest setup is
# to terminate TLS with Caddy in front of frps and proxy to the frp vhost, or
# use the raw-TCP proxy variant and put Caddy/Let's Encrypt on the VPS:
#
#   # Caddyfile (VPS) — automatic HTTPS
#   pc.yourdomain.com {
#     reverse_proxy 127.0.0.1:7334   # the frp tcp remotePort, or frps directly
#   }
#
# Auth: keep RUNNER_API_KEY on the runner. Add the relay's TLS + (optionally)
# an auth policy at Caddy for defense in depth.
#
# ─────────────────────────────────────────────────────────────────────────────
# 2. Lighter alternatives (same idea: a client on your host, a server on a VPS)
# ─────────────────────────────────────────────────────────────────────────────
# - rathole  — https://github.com/rapiz1/rathole   (Rust, very lightweight)
# - bore     — https://github.com/ekzhang/bore     (minimal TCP tunnel; use a
#              public bore server or self-host `bore server`)
# - chisel   — https://github.com/jpillora/chisel  (SSH-style TCP over HTTP;
#              handy when only HTTPS egress is allowed from your host)
#
# ─────────────────────────────────────────────────────────────────────────────
# 3. Other self-hosted options (not "DNS relay", but no vendor edge either)
# ─────────────────────────────────────────────────────────────────────────────
# - Tailscale / WireGuard — a private mesh; expose the runner only to your
#   tailnet and connect agents over the tailnet IP. Simplest "no public
#   hostname" option.
# - Plain SSH reverse tunnel — `ssh -R 7334:localhost:7334 you@vps`, then
#   Caddy/nginx on the VPS fronts it with HTTPS. Zero new binaries.
# - ngrok / Cloudflare Quick Tunnels — quick for dev, but vendor-hosted edge.
#
# Whichever you pick: ALWAYS set RUNNER_API_KEY before going public, and prefer
# TLS + an extra auth layer in front of the relay.
