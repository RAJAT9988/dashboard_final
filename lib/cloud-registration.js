const { proxyJson } = require('./meshcentral-client');
const deviceProfile = require('./device-profile');
const deviceBinding = require('./device-binding');

async function checkCloudRegistration({ userId, username, deviceSerial }) {
  const serial = String(deviceSerial || deviceBinding.getDeviceSerial() || '').trim();
  if (!serial) {
    return { ok: true, registered: false, reason: 'missing_serial' };
  }

  try {
    const result = await proxyJson('/api/atomoforge/devices/check', 'POST', {
      userId,
      username,
      deviceSerial: serial,
    });

    if (result.status === 404) {
      return { ok: true, registered: false, reason: 'api_not_deployed' };
    }

    if (result.status >= 200 && result.status < 300 && result.data) {
      return {
        ok: true,
        registered: result.data.registered === true,
        reason: result.data.reason || null,
        deviceRecordId: result.data.deviceRecordId || null,
      };
    }

    return {
      ok: false,
      registered: null,
      error: result.data?.error || `Cloud check failed (HTTP ${result.status}).`,
    };
  } catch (e) {
    return { ok: false, registered: null, error: e.message };
  }
}

/**
 * If AWS no longer has this user's device registration, clear local onboarding
 * so login/session redirects to device-registration again.
 */
async function syncOnboardingWithCloud({ meshUserId, username }) {
  if (!deviceProfile.isUserOnboarded(meshUserId)) {
    return { onboardingComplete: false, reset: false, cloudChecked: false };
  }

  const cloud = await checkCloudRegistration({
    userId: meshUserId,
    username,
    deviceSerial: deviceProfile.getProfile()?.deviceSerial || deviceBinding.getDeviceSerial(),
  });

  if (!cloud.ok || cloud.registered === null) {
    return {
      onboardingComplete: true,
      reset: false,
      cloudChecked: false,
      cloudError: cloud.error || null,
    };
  }

  if (cloud.registered) {
    return { onboardingComplete: true, reset: false, cloudChecked: true };
  }

  if (cloud.reason === 'api_not_deployed') {
    return {
      onboardingComplete: true,
      reset: false,
      cloudChecked: false,
      cloudError: 'Cloud registration check API not deployed on AWS.',
    };
  }

  deviceProfile.resetLocalRegistration(meshUserId);
  console.warn(
    `[Cloud] AWS registration missing for "${username}" — local onboarding reset (reason: ${cloud.reason || 'not_found'})`
  );

  return {
    onboardingComplete: false,
    reset: true,
    cloudChecked: true,
    reason: cloud.reason || 'not_found',
  };
}

module.exports = {
  checkCloudRegistration,
  syncOnboardingWithCloud,
};
