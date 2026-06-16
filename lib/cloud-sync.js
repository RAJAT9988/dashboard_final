const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const { getDeviceBindingDbPath } = require('./device-config');

let db;

function getDb() {
  if (db) return db;
  const dbPath = getDeviceBindingDbPath();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS cloud_sync_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      user_id TEXT,
      username TEXT,
      payload_json TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      done_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_cloud_sync_queue_done ON cloud_sync_queue(done_at);
    CREATE INDEX IF NOT EXISTS idx_cloud_sync_queue_created ON cloud_sync_queue(created_at);
  `);
  return db;
}

function enqueueDeviceProfile({ userId, username, profilePayload, reason }) {
  const now = Date.now();
  const payload = {
    reason: reason || null,
    profilePayload,
  };
  const stmt = getDb().prepare(
    `INSERT INTO cloud_sync_queue (kind, user_id, username, payload_json, attempts, last_error, created_at, updated_at, done_at)
     VALUES ('deviceProfile', ?, ?, ?, 0, NULL, ?, ?, NULL)`
  );
  const info = stmt.run(String(userId || '').trim() || null, String(username || '').trim() || null, JSON.stringify(payload), now, now);
  return { id: info.lastInsertRowid, createdAt: now };
}

function getPendingCount() {
  const row = getDb()
    .prepare('SELECT COUNT(1) AS c FROM cloud_sync_queue WHERE done_at IS NULL')
    .get();
  return row?.c || 0;
}

function peekNextPending() {
  return getDb()
    .prepare(
      `SELECT id, kind, user_id as userId, username, payload_json as payloadJson, attempts, last_error as lastError
       FROM cloud_sync_queue
       WHERE done_at IS NULL
       ORDER BY created_at ASC
       LIMIT 1`
    )
    .get();
}

function markAttempt(id, { attempts, lastError }) {
  const now = Date.now();
  getDb()
    .prepare('UPDATE cloud_sync_queue SET attempts = ?, last_error = ?, updated_at = ? WHERE id = ?')
    .run(attempts, lastError || null, now, id);
}

function markDone(id) {
  const now = Date.now();
  getDb().prepare('UPDATE cloud_sync_queue SET done_at = ?, updated_at = ? WHERE id = ?').run(now, now, id);
}

async function processNext({ saveDeviceProfileToCloud }) {
  const row = peekNextPending();
  if (!row) return { ok: true, processed: 0 };

  if (row.kind !== 'deviceProfile') {
    markAttempt(row.id, { attempts: row.attempts + 1, lastError: `Unknown queue kind: ${row.kind}` });
    return { ok: false, processed: 1, error: `Unknown queue kind: ${row.kind}` };
  }

  let parsed;
  try {
    parsed = JSON.parse(row.payloadJson);
  } catch (e) {
    markAttempt(row.id, { attempts: row.attempts + 1, lastError: `Bad payload JSON: ${e.message}` });
    return { ok: false, processed: 1, error: 'Bad payload JSON' };
  }

  const profilePayload = parsed?.profilePayload;
  if (!profilePayload || typeof profilePayload !== 'object') {
    markAttempt(row.id, { attempts: row.attempts + 1, lastError: 'Missing profilePayload in queued item' });
    return { ok: false, processed: 1, error: 'Missing profilePayload' };
  }

  try {
    const result = await saveDeviceProfileToCloud({
      userId: row.userId,
      username: row.username,
      profilePayload,
    });
    if (result?.ok) {
      markDone(row.id);
      return { ok: true, processed: 1, deviceRecordId: result.deviceRecordId || null };
    }
    markAttempt(row.id, { attempts: row.attempts + 1, lastError: result?.error || 'Cloud save failed' });
    return { ok: false, processed: 1, error: result?.error || 'Cloud save failed' };
  } catch (e) {
    markAttempt(row.id, { attempts: row.attempts + 1, lastError: e.message });
    return { ok: false, processed: 1, error: e.message };
  }
}

function startBackgroundSync({ isOnline, saveDeviceProfileToCloud, intervalMs = 15000, maxPerTick = 3 }) {
  if (typeof isOnline !== 'function') throw new Error('cloud-sync: isOnline is required');
  if (typeof saveDeviceProfileToCloud !== 'function') throw new Error('cloud-sync: saveDeviceProfileToCloud is required');

  getDb();

  setInterval(async () => {
    try {
      const online = await isOnline();
      if (!online) return;

      for (let i = 0; i < maxPerTick; i++) {
        const peek = peekNextPending();
        if (!peek) return;
        await processNext({ saveDeviceProfileToCloud });
      }
    } catch {
      // background sync is best-effort
    }
  }, intervalMs);
}

module.exports = {
  enqueueDeviceProfile,
  getPendingCount,
  processNext,
  startBackgroundSync,
};

