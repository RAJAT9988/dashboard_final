#!/usr/bin/env bash
# Wipe all local Atomo Forge data (SQLite, device id, session, agent config).
# Does NOT touch AWS / MeshCentral cloud data.
#
# Usage:
#   ./scripts/reset-local-data.sh
#
# Stop server.js first if it is running (script tries to free port 3000).

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DATA="$ROOT/data"

echo "Stopping local server on port 3000 (if any)…"
for p in $(lsof -t -i:3000 2>/dev/null || true); do
  kill "$p" 2>/dev/null || true
done
sleep 1

echo "Removing local data in $DATA …"
rm -f \
  "$DATA/device-binding.sqlite" \
  "$DATA/device-binding.sqlite-wal" \
  "$DATA/device-binding.sqlite-shm" \
  "$DATA/device.json" \
  "$DATA/active-session.json"

# Agent install artifacts from prior registration
rm -f "$ROOT/meshagent.msh"

mkdir -p "$DATA"

echo "Done. Local state is empty."
echo ""
echo "Next:"
echo "  1. Clear browser storage: sessionStorage.removeItem('atomoSessionId')"
echo "     (or open DevTools → Application → Session Storage → clear)"
echo "  2. Start fresh: node server.js"
echo "  3. Open http://localhost:3000/signup or /login"
