const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { singleSessionEnabled, getSessionTtlMs } = require('./device-config');

let activeSession = null;

const SESSION_FILE = path.join(__dirname, '..', 'data', 'active-session.json');

function loadFromDisk() {
  try {
    const raw = fs.readFileSync(SESSION_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return;
    // Never persist password. Session is for UI auth + cloud sync after restarts.
    if (parsed.password) delete parsed.password;
    if (parsed.sessionId && parsed.meshUserId && parsed.username && parsed.expiresAt) {
      activeSession = parsed;
    }
  } catch {
    // ignore
  }
}

function saveToDisk() {
  try {
    fs.mkdirSync(path.dirname(SESSION_FILE), { recursive: true });
    const safe = activeSession ? sanitizeSession(activeSession) : null;
    if (!safe) return;
    fs.writeFileSync(SESSION_FILE, JSON.stringify(safe, null, 2));
  } catch {
    // ignore
  }
}

function clearOnDisk() {
  try {
    fs.unlinkSync(SESSION_FILE);
  } catch {
    // ignore
  }
}

loadFromDisk();

function createSession({ meshUserId, username, password, email }) {
  if (!singleSessionEnabled()) {
    return { sessionId: null, meshUserId, username, email: email || null };
  }

  const sessionId = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  activeSession = {
    sessionId,
    meshUserId,
    username,
    email: email || null,
    password: password || null,
    createdAt: now,
    expiresAt: now + getSessionTtlMs(),
  };
  saveToDisk();
  return sanitizeSession(activeSession);
}

function sanitizeSession(sess) {
  if (!sess) return null;
  const { password, ...safe } = sess;
  return { ...safe };
}

function getSessionRecord(sessionId) {
  if (!singleSessionEnabled() || !activeSession) return null;
  if (sessionId && activeSession.sessionId !== sessionId) return null;
  if (Date.now() > activeSession.expiresAt) {
    activeSession = null;
    clearOnDisk();
    return null;
  }
  return activeSession;
}

function getSession(sessionId) {
  return sanitizeSession(getSessionRecord(sessionId));
}

function clearSessionPassword(sessionId) {
  const sess = getSessionRecord(sessionId);
  if (!sess) return;
  delete sess.password;
}

function destroySession(sessionId) {
  if (!activeSession) return false;
  if (sessionId && activeSession.sessionId !== sessionId) return false;
  activeSession = null;
  clearOnDisk();
  return true;
}

function getActiveSession() {
  return getSession(activeSession?.sessionId);
}

module.exports = {
  createSession,
  getSession,
  getSessionRecord,
  clearSessionPassword,
  destroySession,
  getActiveSession,
};
