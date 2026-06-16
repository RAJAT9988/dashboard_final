#!/usr/bin/env bash
# Repair MeshCentral user.links for users listed in mesh.links (fixes agent-connect crash).
# Run on the MeshCentral server (AWS EC2), with MeshCentral stopped.
#
# Usage:
#   cd ~/new/atomic/MeshCentral-master
#   bash /path/to/fix-meshcentral-user-links.sh
#
# Optional env:
#   MESH_DIR=~/new/atomic/MeshCentral-master
#   DB=meshcentral-data/atomic-center.sqlite

set -euo pipefail

MESH_DIR="${MESH_DIR:-$HOME/new/atomic/MeshCentral-master}"
DB="${DB:-$MESH_DIR/meshcentral-data/atomic-center.sqlite}"

if [[ ! -f "$DB" ]]; then
  echo "Database not found: $DB"
  exit 1
fi

if command -v lsof >/dev/null 2>&1 && lsof -t -i:4434 >/dev/null 2>&1; then
  echo "Stop MeshCentral first (port 4434 is in use):"
  echo "  for p in \$(sudo lsof -t -i:4434); do sudo kill -9 \"\$p\"; done"
  exit 1
fi

echo "Backing up database…"
cp -a "$DB" "${DB}.bak.$(date +%Y%m%d%H%M%S)"

echo "Meshes and linked users:"
sqlite3 "$DB" <<'SQL'
.headers on
.mode column
SELECT id AS mesh_id, json_extract(doc, '$.name') AS mesh_name
FROM main
WHERE type = 'mesh' AND id LIKE 'mesh/%';
SQL

python3 - "$DB" <<'PY'
import json
import sqlite3
import sys

db_path = sys.argv[1]
conn = sqlite3.connect(db_path)
conn.row_factory = sqlite3.Row
cur = conn.cursor()

cur.execute("SELECT id, doc FROM main WHERE type = 'mesh' AND id LIKE 'mesh/%'")
meshes = cur.fetchall()
fixed = 0

for row in meshes:
    mesh_id = row["id"]
    doc = json.loads(row["doc"])
    links = doc.get("links") or {}
    for user_id, link in links.items():
        if not user_id.startswith("user/"):
            continue
        cur.execute("SELECT id, doc FROM main WHERE id = ?", (user_id,))
        user_row = cur.fetchone()
        if user_row is None:
            print(f"WARN: mesh {mesh_id} links missing user {user_id}")
            continue
        user_doc = json.loads(user_row["doc"])
        user_links = user_doc.get("links")
        rights = (link or {}).get("rights", 4294967295)
        if user_links is None:
            user_links = {}
        if mesh_id not in user_links:
            user_links[mesh_id] = {"rights": rights}
            user_doc["links"] = user_links
            cur.execute(
                "UPDATE main SET doc = ? WHERE id = ?",
                (json.dumps(user_doc, separators=(",", ":")), user_id),
            )
            fixed += 1
            print(f"FIXED: {user_id} -> added link to {mesh_id}")

conn.commit()
conn.close()
print(f"Done. Updated {fixed} user record(s).")
PY

echo "Verify users now have links:"
sqlite3 "$DB" <<'SQL'
.headers on
.mode column
SELECT id, json_extract(doc, '$.links') AS user_links
FROM main
WHERE type = 'user';
SQL
