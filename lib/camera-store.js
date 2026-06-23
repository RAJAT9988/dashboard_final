const crypto = require('crypto');
const fs = require('fs');
const Database = require('better-sqlite3');
const { getDeviceBindingDbPath } = require('./device-config');

let db;

function getDb() {
  if (db) return db;
  const dbPath = getDeviceBindingDbPath();
  fs.mkdirSync(require('path').dirname(dbPath), { recursive: true });
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS cameras (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      rtsp_url TEXT NOT NULL,
      zone TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL
    );
  `);
  return db;
}

function rowToCamera(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    rtspUrl: row.rtsp_url,
    zone: row.zone || null,
    status: row.status || 'active',
    createdAt: row.created_at,
  };
}

function listCameras() {
  const rows = getDb()
    .prepare('SELECT * FROM cameras ORDER BY created_at ASC')
    .all();
  return rows.map(rowToCamera);
}

function getCameraStats() {
  const cameras = listCameras();
  const total = cameras.length;
  const active = cameras.filter((c) => c.status === 'active').length;
  return { total, active, offline: Math.max(0, total - active), cameras };
}

function addCamera({ name, type, rtspUrl, zone }) {
  const id = crypto.randomUUID();
  const now = Date.now();
  getDb()
    .prepare(
      `INSERT INTO cameras (id, name, type, rtsp_url, zone, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?)`
    )
    .run(id, name, type, rtspUrl, zone || null, now);
  return rowToCamera(getDb().prepare('SELECT * FROM cameras WHERE id = ?').get(id));
}

function deleteCamera(id) {
  const result = getDb().prepare('DELETE FROM cameras WHERE id = ?').run(String(id || ''));
  return result.changes > 0;
}

module.exports = {
  listCameras,
  getCameraStats,
  addCamera,
  deleteCamera,
};
