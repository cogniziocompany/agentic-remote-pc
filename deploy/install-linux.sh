#!/usr/bin/env bash
# Install + enable the agentic-remote-pc systemd service.
#
# Usage:
#   sudo ./deploy/install-linux.sh [repo-dir]
#
# Defaults to the parent directory of this script (the repo root). Installs
# npm dependencies, installs the unit file, enables + starts it.
set -euo pipefail

REPO="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
UNIT_SRC="$REPO/deploy/agentic-remote-pc.service"
UNIT_DST="/etc/systemd/system/agentic-remote-pc.service"
NODE_BIN="$(command -v node || true)"

if [ -z "$NODE_BIN" ]; then
  echo "node not found on PATH. Install Node.js 18+ first." >&2
  exit 1
fi

echo "Repo:       $REPO"
echo "Node:       $NODE_BIN"
echo "Unit dest:  $UNIT_DST"

# Make sure dependencies are installed.
( cd "$REPO" && npm install --omit=dev )

# Patch ExecStart/WorkingDirectory to match this machine, if needed.
TMP_UNIT="$(mktemp)"
sed -e "s|^WorkingDirectory=.*|WorkingDirectory=$REPO|" \
    -e "s|^ExecStart=.*|ExecStart=$NODE_BIN src/server.js|" \
    -e "s|^EnvironmentFile=.*|EnvironmentFile=-$REPO/.env|" \
    "$UNIT_SRC" > "$TMP_UNIT"
install -m 0644 "$TMP_UNIT" "$UNIT_DST"
rm -f "$TMP_UNIT"

systemctl daemon-reload
systemctl enable agentic-remote-pc
systemctl restart agentic-remote-pc
echo "Installed and started. Check with:  systemctl status agentic-remote-pc"
