#!/usr/bin/env bash
# Wipe ALL MeshCentral / Atomic Center SQLite data on AWS (fresh start).
# Removes users, meshes, devices, registrations, events — everything in SQLite.
# Keeps config.json and TLS certificates.
#
# Usage (from your laptop):
#   export AWS_SSH_KEY=/home/rajat/Documents/new_atomo_forge/atomo_web.pem
#   ./scripts/reset-aws-database.sh
#
# Environment (optional):
#   AWS_HOST=ubuntu@3.108.185.253
#   AWS_MESH_DIR=new/atomic/MeshCentral-master
#   MESHCENTRAL_URL=https://3.108.185.253:4434

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
AWS_HOST="${AWS_HOST:-ubuntu@3.108.185.253}"
AWS_MESH_DIR="${AWS_MESH_DIR:-new/atomic/MeshCentral-master}"
AWS_SSH_KEY="${AWS_SSH_KEY:-$ROOT/atomo_web.pem}"
MESHCENTRAL_URL="${MESHCENTRAL_URL:-https://3.108.185.253:4434}"
RESTART_SCRIPT="$ROOT/scripts/meshcentral-remote-restart.sh"
LOCAL_VIEWS="$ROOT/atomic/MeshCentral-master/meshcentral-data/atomic-center-views.sql"

SSH=(ssh -o ConnectTimeout=20 -o StrictHostKeyChecking=accept-new)
if [[ -f "$AWS_SSH_KEY" ]]; then
  SSH+=( -i "$AWS_SSH_KEY" )
else
  echo "Warning: SSH key not found at $AWS_SSH_KEY"
fi

echo "=============================================="
echo "  AWS SQLite FULL RESET"
echo "  Host: $AWS_HOST"
echo "  This deletes ALL users, devices, meshes, etc."
echo "=============================================="
read -r -p "Type YES to continue: " confirm
if [[ "$confirm" != "YES" ]]; then
  echo "Aborted."
  exit 1
fi

echo "Stopping MeshCentral on AWS…"
"${SSH[@]}" "$AWS_HOST" bash -s <<'REMOTE'
set -euo pipefail
for p in $(sudo lsof -t -i:4434 2>/dev/null || true); do
  sudo kill -9 "$p" 2>/dev/null || true
done
for p in $(sudo lsof -t -i:4433 2>/dev/null || true); do
  sudo kill -9 "$p" 2>/dev/null || true
done
sleep 2
echo "MeshCentral stopped."
REMOTE

echo "Backing up and wiping SQLite files…"
"${SSH[@]}" "$AWS_HOST" "AWS_MESH_DIR=$AWS_MESH_DIR" bash -s <<'REMOTE'
set -euo pipefail
DATA="$HOME/$AWS_MESH_DIR/meshcentral-data"
TS="$(date +%Y%m%d%H%M%S)"
BACKUP="$DATA/backups/pre-reset-$TS"
mkdir -p "$BACKUP"

for f in \
  atomic-center.sqlite atomic-center.sqlite-wal atomic-center.sqlite-shm \
  meshcentral-events.db meshcentral-events.db-wal meshcentral-events.db-shm \
  meshcentral-power.db meshcentral-power.db-wal meshcentral-power.db-shm \
  meshcentral-stats.db meshcentral-stats.db-wal meshcentral-stats.db-shm
do
  if [[ -f "$DATA/$f" ]]; then
    cp -a "$DATA/$f" "$BACKUP/" 2>/dev/null || sudo cp -a "$DATA/$f" "$BACKUP/"
    rm -f "$DATA/$f" 2>/dev/null || sudo rm -f "$DATA/$f"
    echo "Removed: $f"
  fi
done

echo "Backup saved to: $BACKUP"
echo "SQLite wipe complete."
REMOTE

if [[ -f "$LOCAL_VIEWS" ]]; then
  echo "Uploading atomic-center-views.sql…"
  SCP=(scp -o ConnectTimeout=20 -o StrictHostKeyChecking=accept-new)
  if [[ -f "$AWS_SSH_KEY" ]]; then SCP+=( -i "$AWS_SSH_KEY" ); fi
  "${SCP[@]}" "$LOCAL_VIEWS" "$AWS_HOST:/tmp/atomic-center-views.sql"
fi

echo "Restarting MeshCentral…"
"${SSH[@]}" "$AWS_HOST" "bash -s" < "$RESTART_SCRIPT"

echo "Waiting for health check…"
for _ in $(seq 1 20); do
  if curl -sk --connect-timeout 3 "$MESHCENTRAL_URL/api/atomoforge/health" | grep -q '"ok":true'; then
    echo "MeshCentral is up."
    break
  fi
  sleep 2
done

# Re-apply SQLite views after new DB is created
if [[ -f "$LOCAL_VIEWS" ]]; then
  echo "Applying DB console views…"
  "${SSH[@]}" "$AWS_HOST" bash -s <<REMOTE || true
set -euo pipefail
DATA="\$HOME/$AWS_MESH_DIR/meshcentral-data"
if [[ -f "\$DATA/atomic-center.sqlite" && -f /tmp/atomic-center-views.sql ]]; then
  sqlite3 "\$DATA/atomic-center.sqlite" < /tmp/atomic-center-views.sql
  echo "Views applied."
fi
REMOTE
fi

curl -sk "$MESHCENTRAL_URL/api/atomoforge/health" | head -c 300
echo
echo ""
echo "Done. AWS database is empty — create fresh users via signup."
echo "Also reset local device if needed: ./scripts/reset-local-data.sh"
