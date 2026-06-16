const express = require('express');
const path = require('path');
const os = require('os');

const { getMeshcentralUrl, offlineLoginEnabled, singleUserPerDevice } = require('./lib/device-config');
const { proxyJson, checkHealth, isNetworkError } = require('./lib/meshcentral-client');
const meshcentralStatus = require('./lib/meshcentral-status');
const { login: authLogin, completeSignupBind } = require('./lib/auth-service');
const { canAutoInstall } = require('./lib/mesh-agent-install');
const { runAtomicRegistration } = require('./lib/registration-pipeline');
const { saveDeviceProfileToCloud } = require('./lib/meshcentral-register');
const cloudSync = require('./lib/cloud-sync');
const deviceBinding = require('./lib/device-binding');
const deviceProfile = require('./lib/device-profile');
const { syncOnboardingWithCloud } = require('./lib/cloud-registration');
const session = require('./lib/session');

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';

const meshcentralUrl = getMeshcentralUrl();
if (!meshcentralUrl) {
  console.error('meshcentralUrl is required in app-config.json (or set MESHCENTRAL_URL).');
  console.error('Example: "meshcentralUrl": "https://3.108.185.253:4434"');
  process.exit(1);
}

function getLocalIp() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) {
        return net.address;
      }
    }
  }
  return 'localhost';
}

const pendingSignups = new Map();

function normalizeUsername(username) {
  return String(username || '').trim().toLowerCase();
}

function sendProxy(res, { status, data }) {
  return res.status(status).json(data);
}

function validateOnboardingEmail(sessRecord, formEmail) {
  const accountEmail = sessRecord.email;
  const normalizedForm = formEmail ? String(formEmail).trim() : null;

  if (accountEmail && normalizedForm) {
    if (!deviceProfile.emailsMatch(accountEmail, normalizedForm)) {
      return {
        ok: false,
        error: `Registration email must match your account email (${accountEmail}).`,
      };
    }
  } else if (accountEmail && !normalizedForm) {
    return {
      ok: false,
      error: `Enter your account email (${accountEmail}) to complete one-time device registration.`,
    };
  }

  return {
    ok: true,
    email: normalizedForm || accountEmail || null,
  };
}

function markOnboardingComplete(sessRecord, formEmail) {
  const validated = validateOnboardingEmail(sessRecord, formEmail);
  if (!validated.ok) return validated;
  deviceProfile.markUserOnboarded({
    meshUserId: sessRecord.meshUserId,
    email: validated.email,
  });
  return { ok: true };
}

function deviceStatusPayload() {
  const binding = deviceBinding.getBinding();
  return {
    deviceId: deviceBinding.getDeviceId(),
    deviceSerial: deviceBinding.getDeviceSerial(),
    bound: deviceBinding.isBound(),
    boundUser: binding
      ? { username: binding.username, userId: binding.meshUserId, email: binding.email }
      : null,
    deviceRegistered: deviceProfile.isRegistered(),
    singleUserPerDevice: singleUserPerDevice(),
    offlineLoginEnabled: offlineLoginEnabled(),
    activeSession: session.getActiveSession()
      ? { username: session.getActiveSession().username }
      : null,
  };
}

const SIGNUP_OFFLINE_ERROR =
  'Account creation requires an internet connection to Atomic Center. Please connect and try again.';

async function isAtomicCenterOnline() {
  if (!meshcentralStatus.isStale()) {
    return meshcentralStatus.getReachable();
  }
  try {
    return await meshcentralStatus.refresh();
  } catch {
    return false;
  }
}

async function requireOnlineForSignup(res) {
  if (await isAtomicCenterOnline()) return true;
  res.status(503).json({ error: SIGNUP_OFFLINE_ERROR });
  return false;
}

async function verifyMeshCentralOnStartup() {
  try {
    const online = await meshcentralStatus.refresh();
    if (online) {
      console.log('MeshCentral reachable at', meshcentralUrl);
      return true;
    }
    console.warn('[Startup] MeshCentral health check failed.');
    return false;
  } catch (e) {
    const detail = e.cause?.message || e.message;
    meshcentralStatus.markUnreachable();
    console.warn('[Startup] Atomic Center not reachable — app runs locally (offline login if bound).');
    console.warn('[Startup]', detail);
    if (offlineLoginEnabled() && deviceBinding.isBound()) {
      const b = deviceBinding.getBinding();
      console.warn(`[Startup] Offline login ready for "${b.username}" (${b.meshUserId})`);
    }
    return false;
  }
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (_req, res) => {
  res.redirect('/login');
});

app.get('/login', (_req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'login.html'));
});

app.get('/signup', (_req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'signup.html'));
});

app.get('/device-registration', (_req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'device-registration.html'));
});

app.get('/dashboard', (_req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'dashboard.html'));
});

function resolveSession(req) {
  const sessionId =
    req.body?.sessionId ||
    req.query?.sessionId ||
    req.headers['x-session-id'];
  if (sessionId) {
    const sess = session.getSessionRecord(sessionId);
    if (sess) return sess;
    // IMPORTANT: If a sessionId was provided but is invalid/expired,
    // do NOT fall back to the active session. That causes "old user"
    // sessions to leak into new signup/login flows in the browser.
    return null;
  }
  return session.getSessionRecord(session.getActiveSession()?.sessionId);
}

app.get('/api/session', async (req, res) => {
  const sess = resolveSession(req);
  if (!sess) {
    return res.status(401).json({ authenticated: false });
  }

  let onboardingComplete = deviceProfile.isUserOnboarded(sess.meshUserId);
  let cloudRegistrationReset = false;

  if (onboardingComplete && (await isAtomicCenterOnline())) {
    const cloudSync = await syncOnboardingWithCloud({
      meshUserId: sess.meshUserId,
      username: sess.username,
    });
    onboardingComplete = cloudSync.onboardingComplete;
    cloudRegistrationReset = cloudSync.reset === true;
  }

  const profile = deviceProfile.getProfile();
  res.json({
    authenticated: true,
    username: sess.username,
    userId: sess.meshUserId,
    email: sess.email || null,
    sessionId: sess.sessionId,
    deviceRegistered: deviceProfile.isRegistered(),
    onboardingComplete,
    cloudRegistrationReset,
    redirectTo: onboardingComplete ? '/dashboard' : '/device-registration',
    profile,
  });
});

app.get('/api/device/profile', (_req, res) => {
  const profile = deviceProfile.getProfile();
  res.json({
    registered: deviceProfile.isRegistered(),
    profile,
    deviceId: deviceBinding.getDeviceId(),
    deviceSerial: deviceBinding.getDeviceSerial(),
    meshcentralUrl,
  });
});

app.post('/api/device/register', async (req, res) => {
  const sessRecord = resolveSession(req);
  if (!sessRecord) {
    return res.status(401).json({ error: 'You must be signed in to register this device.' });
  }

  const {
    deviceSerial,
    deviceName,
    deviceType,
    operatingSystem,
    organizationName,
    adminName,
    adminRole,
    email,
    phone,
    country,
    city,
    registerMeshCentral,
    meshGroupName,
    sudoPassword,
  } = req.body;

  const missing = [];
  if (!deviceName) missing.push('Device Name');
  if (!deviceType) missing.push('Device Type');
  if (!operatingSystem) missing.push('Operating System');
  if (!organizationName) missing.push('Organization Name');
  if (!adminName) missing.push('Administrator Name');
  if (!adminRole) missing.push('Role / Designation');
  if (!country) missing.push('Country');
  if (!city) missing.push('City');
  if (registerMeshCentral && !meshGroupName) missing.push('MeshCentral Device Group Name');
  if (registerMeshCentral && canAutoInstall(operatingSystem) && !sudoPassword) {
    missing.push('Device password (sudo)');
  }

  if (missing.length) {
    return res.status(400).json({ error: `Required fields missing: ${missing.join(', ')}.` });
  }

  if (deviceProfile.isUserOnboarded(sessRecord.meshUserId)) {
    return res.json({
      success: true,
      alreadyRegistered: true,
      message: 'You have already completed device registration.',
      profile: deviceProfile.getProfile(),
      redirectTo: '/dashboard',
    });
  }

  const onboardingCheck = validateOnboardingEmail(sessRecord, email);
  if (!onboardingCheck.ok) {
    return res.status(400).json({ error: onboardingCheck.error });
  }

  const serial = deviceSerial || deviceBinding.getDeviceSerial();
  const profilePayload = {
    deviceId: deviceBinding.getDeviceId(),
    deviceSerial: serial,
    deviceName: String(deviceName).trim(),
    deviceType: String(deviceType).trim(),
    operatingSystem: String(operatingSystem).trim(),
    organizationName: String(organizationName).trim(),
    adminName: String(adminName).trim(),
    adminRole: String(adminRole).trim(),
    email: email ? String(email).trim() : null,
    phone: phone ? String(phone).trim() : null,
    country: String(country).trim(),
    city: String(city).trim(),
    registerMeshCentral: !!registerMeshCentral,
    meshGroupName: meshGroupName ? String(meshGroupName).trim() : null,
    registeredBy: sessRecord.username,
  };

  try {
    const profile = deviceProfile.saveProfile(profilePayload);

    let cloudSave = { ok: false };
    if (await isAtomicCenterOnline()) {
      cloudSave = await saveDeviceProfileToCloud({
        userId: sessRecord.meshUserId,
        username: sessRecord.username,
        profilePayload,
      });
      if (cloudSave.ok) {
        console.log('[API] Device profile saved to AWS database:', cloudSave.deviceRecordId);
      } else {
        console.warn('[API] AWS profile save failed:', cloudSave.error);
      }
    } else {
      cloudSave = { ok: false, error: 'Atomic Center is offline. Profile saved locally only.' };
    }

    if (!cloudSave.ok) {
      try {
        const queued = cloudSync.enqueueDeviceProfile({
          userId: sessRecord.meshUserId,
          username: sessRecord.username,
          profilePayload,
          reason: cloudSave.error || 'Cloud save failed',
        });
        console.warn('[API] Queued device profile for AWS sync:', queued.id);
      } catch (e) {
        console.warn('[API] Failed to queue AWS sync:', e.message);
      }
    }

    const cloudFields = {
      sessionId: sessRecord.sessionId,
      profileStoredOnCloud: cloudSave.ok,
      deviceRecordId: cloudSave.deviceRecordId || null,
      cloudSaveError: cloudSave.ok ? null : cloudSave.error,
    };

    if (!registerMeshCentral) {
      markOnboardingComplete(sessRecord, profilePayload.email);
      return res.json({
        success: true,
        message: cloudSave.ok
          ? 'Device registered and saved to Atomic Center database.'
          : 'Device registered locally. Cloud save failed — see cloudSaveError.',
        profile,
        onboardingComplete: true,
        redirectTo: '/dashboard',
        ...cloudFields,
      });
    }

    if (!sessRecord.password) {
      return res.status(401).json({
        error:
          'Your details were saved, but the session expired. Sign in again to install the MeshCentral agent.',
        profile,
        ...cloudFields,
      });
    }

    try {
      const result = await runAtomicRegistration({
        username: sessRecord.username,
        atomicPassword: sessRecord.password,
        userId: sessRecord.meshUserId,
        profilePayload,
        operatingSystem,
        sudoPassword,
      });

      session.clearSessionPassword(sessRecord.sessionId);

      markOnboardingComplete(sessRecord, profilePayload.email);

      return res.json({
        success: true,
        partial: result.partial,
        message: result.message,
        profile,
        phases: result.phases,
        meshCentral: {
          ...result.meshCentral,
          profileStoredOnCloud: result.meshCentral?.profileStoredOnCloud || cloudSave.ok,
          deviceRecordId: result.meshCentral?.deviceRecordId || cloudSave.deviceRecordId || null,
          cloudSaveError: result.meshCentral?.cloudSaveError || cloudSave.error || null,
        },
        agentInstall: result.agentInstall,
        onboardingComplete: true,
        redirectTo: '/dashboard',
        ...cloudFields,
      });
    } catch (e) {
      console.error('[API] Atomic Center registration failed:', e.message);
      if (cloudSave.ok) {
        markOnboardingComplete(sessRecord, profilePayload.email);
      }
      return res.status(cloudSave.ok ? 200 : 503).json({
        success: cloudSave.ok,
        partial: true,
        error: e.message,
        message: cloudSave.ok
          ? 'Profile saved to AWS. MeshCentral agent setup failed — you can retry after signing in again.'
          : e.message,
        profile,
        phases: e.phases || [],
        onboardingComplete: cloudSave.ok,
        redirectTo: cloudSave.ok ? '/dashboard' : undefined,
        ...cloudFields,
      });
    }
  } catch (e) {
    console.error('[API] POST /api/device/register failed:', e.message);
    return res.status(500).json({ error: 'Failed to save device registration.' });
  }
});

app.get('/api/device/status', (_req, res) => {
  if (meshcentralStatus.isStale()) {
    meshcentralStatus.refresh().catch(() => {});
  }
  res.json({
    ...deviceStatusPayload(),
    meshcentralReachable: meshcentralStatus.getReachable(),
    online: meshcentralStatus.getReachable(),
  });
});

app.get('/api/device/cloud-sync', async (_req, res) => {
  try {
    const online = await isAtomicCenterOnline();
    res.json({
      online,
      pending: cloudSync.getPendingCount(),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Force-sync the currently saved local device profile to AWS.
// Useful after an admin deletes AWS registrations but the device is already onboarded.
app.post('/api/device/cloud-sync/enqueue-current', async (req, res) => {
  let sessRecord = resolveSession(req);
  // Easy fallback: if the device is already bound (single-user device),
  // allow a forced cloud sync using the bound user identity.
  if (!sessRecord && deviceBinding.isBound()) {
    const binding = deviceBinding.getBinding();
    // Prefer the username that originally registered the device (if present),
    // because AWS will reject unknown/mismatched users.
    const localProfile = deviceProfile.getProfile();
    const preferredUsername = String(localProfile?.registeredBy || binding?.username || '').trim();
    const fallbackUser = String(binding?.username || '').trim();
    const chosen = preferredUsername || fallbackUser;
    sessRecord = chosen
      ? {
          meshUserId: binding?.meshUserId || `user//${chosen.toLowerCase()}`,
          username: chosen,
          email: binding?.email || null,
        }
      : null;
  }
  if (!sessRecord) return res.status(401).json({ ok: false, error: 'You must be signed in.' });

  const profile = deviceProfile.getProfile();
  if (!profile) {
    return res.status(400).json({ ok: false, error: 'No local device registration found to sync.' });
  }

  const profilePayload = {
    deviceId: deviceBinding.getDeviceId(),
    deviceSerial: profile.deviceSerial || deviceBinding.getDeviceSerial(),
    deviceName: profile.deviceName,
    deviceType: profile.deviceType,
    operatingSystem: profile.operatingSystem,
    organizationName: profile.organizationName,
    adminName: profile.adminName,
    adminRole: profile.adminRole,
    email: profile.email || null,
    phone: profile.phone || null,
    country: profile.country,
    city: profile.city,
    registerMeshCentral: !!profile.registerMeshCentral,
    meshGroupName: profile.meshGroupName || null,
    registeredBy: profile.registeredBy || sessRecord.username,
  };

  // Try immediate save first if online, else queue.
  try {
    if (await isAtomicCenterOnline()) {
      const cloudSave = await saveDeviceProfileToCloud({
        userId: sessRecord.meshUserId,
        username: sessRecord.username,
        profilePayload,
      });
      if (cloudSave.ok) {
        return res.json({
          ok: true,
          synced: true,
          deviceRecordId: cloudSave.deviceRecordId || null,
          message: 'Profile synced to AWS.',
        });
      }
      // fall through and queue below
      cloudSync.enqueueDeviceProfile({
        userId: sessRecord.meshUserId,
        username: sessRecord.username,
        profilePayload,
        reason: cloudSave.error || 'Cloud save failed',
      });
      return res.status(202).json({
        ok: true,
        synced: false,
        queued: true,
        message: 'AWS sync queued (cloud save failed).',
        error: cloudSave.error || null,
      });
    }

    cloudSync.enqueueDeviceProfile({
      userId: sessRecord.meshUserId,
      username: sessRecord.username,
      profilePayload,
      reason: 'Atomic Center offline',
    });
    return res.status(202).json({
      ok: true,
      synced: false,
      queued: true,
      message: 'AWS is offline — sync queued.',
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/device/cloud-sync/run', async (_req, res) => {
  try {
    if (!(await isAtomicCenterOnline())) {
      return res.status(503).json({ ok: false, error: 'Atomic Center is offline.' });
    }
    const result = await cloudSync.processNext({ saveDeviceProfileToCloud });
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/logout', (req, res) => {
  const sessionId = req.body?.sessionId;
  session.destroySession(sessionId);
  res.json({ success: true });
});

app.get('/api/health', async (_req, res) => {
  const device = deviceStatusPayload();
  try {
    const remote = await checkHealth();
    res.json({
      ok: remote.ok,
      meshcentralUrl,
      meshcentralReachable: true,
      ...device,
      remote: remote.data,
      deviceIp: getLocalIp(),
    });
  } catch (e) {
    console.error('[API] GET /api/health failed:', e.message, e.cause?.message || '');
    const canWorkOffline = offlineLoginEnabled() && deviceBinding.isBound();
    res.status(canWorkOffline ? 200 : 503).json({
      ok: canWorkOffline,
      meshcentralUrl,
      meshcentralReachable: false,
      ...device,
      error: e.message,
      deviceIp: getLocalIp(),
    });
  }
});

app.get('/api/config', async (_req, res) => {
  try {
    const { status, data } = await proxyJson('/api/atomoforge/health', 'GET');
    const online = status === 200 && data.ok === true;
    res.status(status).json({
      emailVerificationEnabled: !!data.emailVerificationEnabled,
      online,
      meshcentralReachable: online,
      meshcentralUrl,
      ...deviceStatusPayload(),
    });
  } catch (e) {
    console.error('[API] GET /api/config failed:', e.message, e.cause?.message || '');
    res.status(503).json({
      emailVerificationEnabled: false,
      online: false,
      meshcentralReachable: false,
      error: e.message,
      ...deviceStatusPayload(),
    });
  }
});

app.post('/api/signup/init', async (req, res) => {
  if (!(await requireOnlineForSignup(res))) return;

  const username = String(req.body.username || '').trim();
  const email = String(req.body.email || '').trim();
  const { password, confirmPassword } = req.body;

  if (!username || !email || !password || !confirmPassword) {
    return res.status(400).json({ error: 'All fields are required.' });
  }

  try {
    const result = await proxyJson('/api/atomoforge/signup/init', 'POST', {
      username,
      email,
      password,
      confirmPassword,
    });

    if (result.status >= 200 && result.status < 300 && result.data.otpId) {
      pendingSignups.set(normalizeUsername(username), {
        username,
        email,
        password,
        otpId: result.data.otpId,
        createdAt: Date.now(),
      });
    }

    return sendProxy(res, result);
  } catch (e) {
    console.error('[API] POST /api/signup/init failed:', e.message, e.cause?.message || '');
    const msg = isNetworkError(e)
      ? 'Signup requires internet to reach Atomic Center and send the verification email.'
      : e.message;
    return res.status(503).json({ error: msg });
  }
});

app.post('/api/signup/resend', async (req, res) => {
  if (!(await requireOnlineForSignup(res))) return;

  const username = String(req.body.username || '').trim();
  const pending = pendingSignups.get(normalizeUsername(username));

  if (!pending || !pending.otpId) {
    return res.status(404).json({ error: 'Signup session expired. Please start again.' });
  }

  try {
    const result = await proxyJson('/api/atomoforge/signup/resend', 'POST', {
      otpId: pending.otpId,
    });
    return sendProxy(res, result);
  } catch (e) {
    console.error('[API] POST /api/signup/resend failed:', e.message, e.cause?.message || '');
    return res.status(503).json({ error: e.message });
  }
});

app.post('/api/signup/verify-2fa', async (req, res) => {
  if (!(await requireOnlineForSignup(res))) return;

  const username = String(req.body.username || '').trim();
  const { token } = req.body;

  if (!username || !token) {
    return res.status(400).json({ error: 'Username and verification code are required.' });
  }

  const pending = pendingSignups.get(normalizeUsername(username));
  if (!pending) {
    return res.status(404).json({ error: 'Signup session expired. Please start again.' });
  }

  try {
    const result = await proxyJson('/api/atomoforge/signup/verify', 'POST', {
      otpId: pending.otpId,
      token,
      username: pending.username,
    });

    if (result.status >= 200 && result.status < 300 && result.data.success) {
      try {
        const bindResult = await completeSignupBind({
          username: pending.username,
          email: pending.email,
          password: pending.password,
          userId: result.data.userId,
        });
        pendingSignups.delete(normalizeUsername(username));
        return sendProxy(res, bindResult);
      } catch (bindErr) {
        console.error('[Auth] Signup bind failed:', bindErr.message);
        return res.status(500).json({ error: 'Account created on server but device binding failed.' });
      }
    }

    return sendProxy(res, result);
  } catch (e) {
    console.error('[API] POST /api/signup/verify-2fa failed:', e.message, e.cause?.message || '');
    return res.status(503).json({ error: e.message });
  }
});

app.post('/api/login', async (req, res) => {
  const username = String(req.body.username || '').trim();
  const { password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required.' });
  }

  try {
    const result = await authLogin(username, password);
    return sendProxy(res, result);
  } catch (e) {
    console.error('[API] POST /api/login failed:', e.message, e.cause?.message || '');
    return res.status(503).json({ error: e.message });
  }
});

setInterval(() => {
  const cutoff = Date.now() - 15 * 60 * 1000;
  for (const [key, value] of pendingSignups.entries()) {
    if (value.createdAt < cutoff) {
      pendingSignups.delete(key);
    }
  }
}, 60 * 1000);

async function startServer() {
  const device = deviceStatusPayload();
  console.log('Device ID:', device.deviceId);
  if (device.bound) {
    console.log(`Device bound to: ${device.boundUser.username} (${device.boundUser.userId})`);
  } else {
    console.log('Device not bound yet — first signup/login will bind this device.');
  }

  meshcentralStatus.markUnreachable();

  app.listen(PORT, HOST, () => {
    const ip = getLocalIp();
    console.log(`Atomo Forge listening on ${HOST}:${PORT}`);
    console.log(`  On this device:  http://localhost:${PORT}`);
    console.log(`  On your network: http://${ip}:${PORT}`);
    console.log(`  MeshCentral:     ${meshcentralUrl}`);
    if (offlineLoginEnabled()) {
      console.log(`  Offline login:   ${device.bound ? 'ready' : 'needs one online bind first'}`);
    }
  });

  meshcentralStatus.startBackgroundRefresh();
  verifyMeshCentralOnStartup().catch(() => {});

  cloudSync.startBackgroundSync({
    isOnline: isAtomicCenterOnline,
    saveDeviceProfileToCloud,
    intervalMs: 15000,
    maxPerTick: 3,
  });
}

startServer();
