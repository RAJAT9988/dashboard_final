const { proxyJson, isNetworkError } = require('./meshcentral-client');
const deviceBinding = require('./device-binding');

// After this many failed (non-network) attempts we give up and drop the queued
// change so it cannot retry forever. The user can still recover via the
// email-verification (cloud) password reset flow.
const MAX_ATTEMPTS = 8;

let inFlight = null;

/**
 * Push a pending local password change to Atomic Center. Safe to call often:
 * it no-ops when there is nothing queued and de-duplicates concurrent runs.
 */
async function syncPending() {
  if (inFlight) return inFlight;

  const pending = deviceBinding.getPendingPasswordSync();
  if (!pending) return { ok: true, synced: false };

  inFlight = (async () => {
    try {
      const result = await proxyJson(
        '/api/atomoforge/password-change',
        'POST',
        {
          username: pending.username,
          currentPassword: pending.oldPassword,
          newPassword: pending.newPassword,
        },
        {},
        8000
      );

      if (result.status >= 200 && result.status < 300 && result.data && result.data.success) {
        deviceBinding.clearPendingPasswordSync();
        console.log('[PasswordSync] Atomic Center password updated for', pending.username);
        return { ok: true, synced: true };
      }

      // Atomic Center is reachable but rejected the change. A 401/400/404 means
      // the old password is no longer valid there (e.g. it was changed out of
      // band) or the account is gone — retrying cannot fix this, so drop it.
      if ([400, 401, 403, 404].includes(result.status)) {
        deviceBinding.clearPendingPasswordSync();
        console.warn(
          '[PasswordSync] Dropping unsyncable password change for',
          pending.username,
          '-',
          (result.data && result.data.error) || result.status
        );
        return { ok: false, synced: false, dropped: true, error: result.data && result.data.error };
      }

      deviceBinding.markPendingPasswordSyncAttempt((result.data && result.data.error) || `HTTP ${result.status}`);
      return { ok: false, synced: false, error: result.data && result.data.error };
    } catch (e) {
      deviceBinding.markPendingPasswordSyncAttempt(e.message);
      // Network errors are expected while offline — keep the item and retry later.
      if (!isNetworkError(e)) {
        const after = deviceBinding.getPendingPasswordSync();
        if (after && after.attempts >= MAX_ATTEMPTS) {
          deviceBinding.clearPendingPasswordSync();
          console.warn('[PasswordSync] Giving up on password sync after', after.attempts, 'attempts.');
          return { ok: false, synced: false, dropped: true, error: e.message };
        }
      }
      return { ok: false, synced: false, error: e.message, network: isNetworkError(e) };
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

function hasPending() {
  return deviceBinding.getPendingPasswordSync() != null;
}

function startBackgroundSync({ isOnline, intervalMs = 20000 }) {
  if (typeof isOnline !== 'function') throw new Error('password-sync: isOnline is required');

  setInterval(async () => {
    try {
      if (!hasPending()) return;
      const online = await isOnline();
      if (!online) return;
      await syncPending();
    } catch {
      // best-effort
    }
  }, intervalMs);
}

module.exports = {
  syncPending,
  hasPending,
  startBackgroundSync,
};
