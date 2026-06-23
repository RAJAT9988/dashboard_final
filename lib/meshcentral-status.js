const { checkHealth } = require('./meshcentral-client');

const CACHE_MS = 20000;

let reachable = false;
let lastCheck = 0;
let lastHealth = null;
let refreshPromise = null;

function getReachable() {
  return reachable;
}

function isStale() {
  return Date.now() - lastCheck > CACHE_MS;
}

function getSnapshot() {
  return {
    reachable,
    stale: isStale(),
    health: lastHealth,
    checkedAt: lastCheck,
  };
}

function markUnreachable() {
  reachable = false;
  lastCheck = Date.now();
}

function markReachable(healthData) {
  reachable = true;
  lastCheck = Date.now();
  if (healthData && typeof healthData === 'object') {
    lastHealth = healthData;
  }
}

function refreshInBackground() {
  if (!refreshPromise) {
    refresh().catch(() => {});
  }
}

async function refresh() {
  if (refreshPromise) return refreshPromise;

  refreshPromise = checkHealth()
    .then((health) => {
      reachable = health.ok;
      lastCheck = Date.now();
      if (health.data && typeof health.data === 'object') {
        lastHealth = health.data;
      }
      return reachable;
    })
    .catch(() => {
      reachable = false;
      lastCheck = Date.now();
      return false;
    })
    .finally(() => {
      refreshPromise = null;
    });

  return refreshPromise;
}

/** Use cached status; only block on refresh when forced with maxWaitMs. */
async function isReachableFast({ maxWaitMs = 900 } = {}) {
  if (!isStale()) return reachable;

  refreshInBackground();
  if (!maxWaitMs) return reachable;

  const refreshRace = refresh();
  const timeout = new Promise((resolve) => {
    setTimeout(() => resolve(reachable), maxWaitMs);
  });
  return Promise.race([refreshRace, timeout]);
}

function startBackgroundRefresh(intervalMs = CACHE_MS) {
  refresh().catch(() => {});
  setInterval(() => {
    refresh().catch(() => {});
  }, intervalMs);
}

module.exports = {
  getReachable,
  getSnapshot,
  isStale,
  markUnreachable,
  markReachable,
  refresh,
  refreshInBackground,
  isReachableFast,
  startBackgroundRefresh,
};
