#!/usr/bin/env bash
# Runs on AWS via: ssh ubuntu@host 'bash -s' < scripts/meshcentral-remote-restart.sh
set -euo pipefail

NODE="${NODE:-$HOME/.nvm/versions/node/v24.16.0/bin/node}"
DIR="${DIR:-$HOME/new/atomic/MeshCentral-master}"
LEGACY_DIR="${LEGACY_DIR:-$HOME/MeshCentral-master}"

if [[ ! -x "$NODE" ]]; then
  export NVM_DIR="$HOME/.nvm"
  # shellcheck source=/dev/null
  [[ -s "$NVM_DIR/nvm.sh" ]] && . "$NVM_DIR/nvm.sh"
  NODE="$(command -v node)"
fi

if [[ ! -d "$DIR" ]]; then
  echo "MeshCentral directory not found: $DIR" >&2
  exit 1
fi

if [[ ! -f "$DIR/views/login.handlebars" ]]; then
  echo "Missing login view templates in $DIR/views — reinstall MeshCentral." >&2
  exit 1
fi

# Keep legacy path working if scripts/docs still reference ~/MeshCentral-master.
if [[ "$DIR" != "$LEGACY_DIR" && ! -e "$LEGACY_DIR" ]]; then
  ln -sfn "$DIR" "$LEGACY_DIR"
fi

for p in $(sudo lsof -t -i:4434 2>/dev/null || true); do
  sudo kill -9 "$p" 2>/dev/null || true
done
sleep 2

cd "$DIR"
nohup "$NODE" meshcentral.js >> /tmp/meshcentral.log 2>&1 &
echo "MeshCentral starting (pid $!) from $DIR — log: /tmp/meshcentral.log"
