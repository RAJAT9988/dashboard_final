/* ATOMO FORGE — Command Deck (wired to live APIs) */

(function () {
  const root = document.documentElement;
  const POLL_MS = 5000;

  let sessionId = sessionStorage.getItem('atomoSessionId');
  let meshcentralUrl = null;
  let lastSyncAt = null;

  const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
  const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
  const randFloat = (min, max) => min + Math.random() * (max - min);
  const jitter = (value, min, max, delta = 4) => clamp(value + (Math.random() - 0.5) * delta * 2, min, max);
  const pick = (arr) => arr[randInt(0, arr.length - 1)];
  const getVar = (name) => getComputedStyle(root).getPropertyValue(name).trim();

  const fmtPct = (v) => (v == null || Number.isNaN(v) ? '—' : `${Math.round(v)}%`);
  const fmtTemp = (v) => (v == null || Number.isNaN(v) ? '—' : `${v.toFixed(1)}°C`);
  const fmtBps = (v) => {
    if (v == null || Number.isNaN(v)) return '—';
    if (v < 1024) return `${Math.round(v)} B/s`;
    if (v < 1024 * 1024) return `${Math.round(v / 1024)} KB/s`;
    return `${(v / (1024 * 1024)).toFixed(1)} MB/s`;
  };
  const fmtUptime = (s) => {
    if (s == null || Number.isNaN(s)) return '—';
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
  };
  const fmtAgo = (s) => {
    if (s == null || Number.isNaN(s)) return '—';
    if (s < 60) return `${Math.round(s)}s ago`;
    if (s < 3600) return `${Math.round(s / 60)}m ago`;
    return `${Math.round(s / 3600)}h ago`;
  };
  const setText = (id, value) => { const el = document.getElementById(id); if (el) el.textContent = value; };

  function initials(name) {
    const s = String(name || '').trim();
    if (!s) return '?';
    const parts = s.split(/\s+/);
    if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    return s.slice(0, 2).toUpperCase();
  }

  function showToast(message) {
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = message;
    document.body.appendChild(el);
    requestAnimationFrame(() => el.classList.add('is-visible'));
    setTimeout(() => {
      el.classList.remove('is-visible');
      setTimeout(() => el.remove(), 220);
    }, 2600);
  }

  function apiUrl(path) {
    if (!sessionId) return path;
    const sep = path.includes('?') ? '&' : '?';
    return `${path}${sep}sessionId=${encodeURIComponent(sessionId)}`;
  }

  async function ensureSession() {
    const res = await fetch(apiUrl('/api/session'));
    if (!res.ok) {
      sessionStorage.removeItem('atomoSessionId');
      window.location.href = '/login';
      return null;
    }
    const data = await res.json();
    if (!data.authenticated) {
      sessionStorage.removeItem('atomoSessionId');
      window.location.href = '/login';
      return null;
    }
    if (!data.onboardingComplete) {
      window.location.href = '/device-registration';
      return null;
    }
    if (data.sessionId) {
      sessionId = data.sessionId;
      sessionStorage.setItem('atomoSessionId', sessionId);
    }
    return data;
  }

  function applyProfile(sessionData) {
    const profile = sessionData.profile || {};
    const displayName = profile.adminName || sessionData.username || 'Operator';
    setText('userLabel', displayName);
    setText('operatorAvatar', initials(displayName));
    setText('deviceName', profile.deviceName || 'Electron device');
    setText('deviceSerial', profile.deviceSerial ? `Serial ${profile.deviceSerial}` : 'Serial —');
    setText('orgName', profile.organizationName || '—');
    const loc = [profile.city, profile.country].filter(Boolean).join(', ');
    setText('orgLocation', loc || '—');

    const role = String(profile.adminRole || 'Operator');
    setText('roleValue', role);
    const typeLine = [profile.deviceType, profile.operatingSystem].filter(Boolean).join(' · ');
    setText('roleSub', typeLine || 'Edge AI unit');
    populateSettings(sessionData);
  }

  function setInput(id, value) {
    const el = document.getElementById(id);
    if (el) el.value = value ?? '';
  }

  function populateSettings(sessionData) {
    const profile = sessionData.profile || {};
    const loc = [profile.city, profile.country].filter(Boolean).join(', ');
    setInput('setDeviceName', profile.deviceName || '');
    setInput('setDeviceSerial', profile.deviceSerial || '');
    setInput('setDeviceType', profile.deviceType || '');
    setInput('setOs', profile.operatingSystem || '');
    setInput('setOrgName', profile.organizationName || '');
    setInput('setLocation', loc);
    setInput('setAdminName', profile.adminName || sessionData.username || '');
    setInput('setNotifyEmail', profile.email || sessionData.email || '');
    setInput('setMeshGroup', profile.meshGroupName || '');
    setInput('setAtomicUrl', meshcentralUrl || '');
    setText('setCurrentUser', sessionData.username || profile.adminName || '—');
  }

  function updateSettingsLiveFields() {
    setInput('setStoragePct', state.storage != null ? `${Math.round(state.storage)}% used` : '—');
    setInput('setSyncStatus', state.atomicOnline ? (state.atomicQueue > 0 ? 'Syncing' : 'Synced') : 'Offline');
    setInput('setMasterSlaveRole', document.getElementById('roleSub')?.textContent || '—');
  }

  const SETTINGS_SECTION_KEY = 'atomoSettingsSection';

  function showSettingsSection(sectionId) {
    document.querySelectorAll('.settings-link').forEach((btn) => {
      btn.classList.toggle('is-active', btn.dataset.settings === sectionId);
    });
    document.querySelectorAll('.settings-section').forEach((panel) => {
      panel.classList.toggle('is-hidden', panel.dataset.settingsPanel !== sectionId);
    });
    try { sessionStorage.setItem(SETTINGS_SECTION_KEY, sectionId); } catch (_) { /* ignore */ }
  }

  function wireSettingsNav() {
    document.querySelectorAll('.settings-link').forEach((btn) => {
      btn.addEventListener('click', () => showSettingsSection(btn.dataset.settings));
    });
    const saved = sessionStorage.getItem(SETTINGS_SECTION_KEY) || 'device';
    showSettingsSection(saved);

    document.getElementById('settingsSyncBtn')?.addEventListener('click', () => requestCloudSync(false));
    document.getElementById('settingsOpenAtomicBtn')?.addEventListener('click', () => {
      if (meshcentralUrl) window.open(meshcentralUrl, '_blank', 'noopener,noreferrer');
      else showToast('Atomic Centre URL is not configured on this device.');
    });
    document.getElementById('settingsFactoryResetBtn')?.addEventListener('click', () => {
      showToast('Run scripts/reset-local-data.sh on the device to factory reset.');
    });
  }

  const FIRE_MODULE_KEY = 'atomoFireModuleConfig';

  const FIRE_MODULE_DEFAULTS = {
    features: {
      fireDetect: true, smokeDetect: true, zoneMonitor: true, falsePositiveReduction: true,
      criticalAlerts: true, snapshot: true, eventClip: true,
    },
    confidence: 80,
    frameCount: 3,
    alerts: {
      fireDetected: true, smokeDetected: true, zoneFire: true, repeatedFire: true, cameraOffline: true,
    },
  };

  const SAFETY_MODULE_DEFAULTS = {
    features: {
      helmet: true, vest: true, mask: true, gloves: true, shoes: true, noPpe: true,
    },
    alerts: {
      noHelmet: true, noVest: true, noMask: true, violation: true, repeatedViolation: true,
    },
  };

  const SAFETY_MODULE_KEY = 'atomoSafetyModuleConfig';

  const FACE_MODULE_KEY = 'atomoFaceModuleConfig';

  const FACE_MODULE_DEFAULTS = {
    features: {
      faceDetect: true, faceEnroll: true, faceDatabase: true, knownRecognition: true,
      unknownDetect: true, authMarking: true, multiGroups: true, profileMgmt: true,
    },
    groups: {
      staff: true, vip: true, contractors: true, visitors: true, blacklist: true,
    },
    matchConfidence: 85,
    unknownThreshold: 70,
    alerts: {
      unknownFace: true, unauthorized: true, vip: true, blacklisted: true,
    },
  };

  function readModuleCheckboxes(name) {
    const values = {};
    document.querySelectorAll(`input[name="${name}"]`).forEach((input) => {
      values[input.value] = input.checked;
    });
    return values;
  }

  function applyModuleCheckboxes(name, values) {
    document.querySelectorAll(`input[name="${name}"]`).forEach((input) => {
      if (Object.prototype.hasOwnProperty.call(values, input.value)) {
        input.checked = values[input.value];
      }
    });
  }

  function wireRangeSlider(inputId, labelId, format) {
    const input = document.getElementById(inputId);
    const label = document.getElementById(labelId);
    if (!input || !label) return;
    const update = () => { label.textContent = format(input.value); };
    input.addEventListener('input', update);
    update();
  }

  function wireFireModule() {
    wireRangeSlider('fireConfidence', 'fireConfValue', (v) => `${v}%`);
    wireRangeSlider('fireFrameCount', 'fireFrameCountValue', (v) => v);

    const load = () => {
      try {
        const raw = localStorage.getItem(FIRE_MODULE_KEY);
        if (!raw) return;
        const saved = JSON.parse(raw);
        if (saved.features) applyModuleCheckboxes('fireFeature', saved.features);
        if (saved.alerts) applyModuleCheckboxes('fireAlert', saved.alerts);
        if (saved.confidence != null) {
          const input = document.getElementById('fireConfidence');
          if (input) {
            input.value = saved.confidence;
            setText('fireConfValue', `${saved.confidence}%`);
          }
        }
        if (saved.frameCount != null) {
          const input = document.getElementById('fireFrameCount');
          if (input) {
            input.value = saved.frameCount;
            setText('fireFrameCountValue', String(saved.frameCount));
          }
        }
      } catch (_) { /* ignore */ }
    };

    load();

    document.getElementById('fireSaveBtn')?.addEventListener('click', () => {
      const payload = {
        features: readModuleCheckboxes('fireFeature'),
        alerts: readModuleCheckboxes('fireAlert'),
        confidence: Number(document.getElementById('fireConfidence')?.value || FIRE_MODULE_DEFAULTS.confidence),
        frameCount: Number(document.getElementById('fireFrameCount')?.value || FIRE_MODULE_DEFAULTS.frameCount),
      };
      try { localStorage.setItem(FIRE_MODULE_KEY, JSON.stringify(payload)); } catch (_) { /* ignore */ }
      showToast('Fire & smoke settings saved.');
    });

    document.getElementById('fireResetBtn')?.addEventListener('click', () => {
      applyModuleCheckboxes('fireFeature', FIRE_MODULE_DEFAULTS.features);
      applyModuleCheckboxes('fireAlert', FIRE_MODULE_DEFAULTS.alerts);
      const conf = document.getElementById('fireConfidence');
      if (conf) {
        conf.value = FIRE_MODULE_DEFAULTS.confidence;
        setText('fireConfValue', `${FIRE_MODULE_DEFAULTS.confidence}%`);
      }
      const frames = document.getElementById('fireFrameCount');
      if (frames) {
        frames.value = FIRE_MODULE_DEFAULTS.frameCount;
        setText('fireFrameCountValue', String(FIRE_MODULE_DEFAULTS.frameCount));
      }
      localStorage.removeItem(FIRE_MODULE_KEY);
      showToast('Fire & smoke settings reset to defaults.');
    });

    document.querySelectorAll('#fireFeaturesList input, #fireAlertsList input').forEach((el) => {
      el.addEventListener('change', updateFireModuleStatus);
    });
  }

  function updateFireModuleStatus() {
    const fireOn = document.querySelector('#fireFeaturesList input[value="fireDetect"]')?.checked;
    const smokeOn = document.querySelector('#fireFeaturesList input[value="smokeDetect"]')?.checked;
    const active = !!(fireOn || smokeOn) && state.activeModels.has('fire');
    const label = document.getElementById('fireModuleStatusLabel');
    if (label) label.textContent = active ? 'Live' : 'Inactive';
    document.getElementById('fireModuleStatus')?.classList.toggle('is-live', active);
  }

  function wireSafetyModule() {
    const load = () => {
      try {
        const raw = localStorage.getItem(SAFETY_MODULE_KEY);
        if (!raw) return;
        const saved = JSON.parse(raw);
        if (saved.features) applyModuleCheckboxes('safetyFeature', saved.features);
        if (saved.alerts) applyModuleCheckboxes('safetyAlert', saved.alerts);
      } catch (_) { /* ignore */ }
    };

    load();

    document.getElementById('safetySaveBtn')?.addEventListener('click', () => {
      const payload = {
        features: readModuleCheckboxes('safetyFeature'),
        alerts: readModuleCheckboxes('safetyAlert'),
      };
      try { localStorage.setItem(SAFETY_MODULE_KEY, JSON.stringify(payload)); } catch (_) { /* ignore */ }
      showToast('Safety compliance settings saved.');
    });

    document.getElementById('safetyResetBtn')?.addEventListener('click', () => {
      applyModuleCheckboxes('safetyFeature', SAFETY_MODULE_DEFAULTS.features);
      applyModuleCheckboxes('safetyAlert', SAFETY_MODULE_DEFAULTS.alerts);
      localStorage.removeItem(SAFETY_MODULE_KEY);
      showToast('Safety compliance settings reset to defaults.');
    });

    document.querySelectorAll('#safetyFeaturesList input, #safetyAlertsList input').forEach((el) => {
      el.addEventListener('change', updateSafetyModuleStatus);
    });
  }

  function updateSafetyModuleStatus() {
    const active = state.activeModels.has('safety');
    const label = document.getElementById('safetyModuleStatusLabel');
    if (label) label.textContent = active ? 'Running' : 'Inactive';
    document.getElementById('safetyModuleStatus')?.classList.toggle('is-live', active);
  }

  function applyFaceConfig(saved) {
    const cfg = saved || FACE_MODULE_DEFAULTS;
    if (cfg.features) applyModuleCheckboxes('faceFeature', cfg.features);
    if (cfg.groups) applyModuleCheckboxes('faceGroup', cfg.groups);
    if (cfg.alerts) applyModuleCheckboxes('faceAlert', cfg.alerts);
    if (cfg.matchConfidence != null) {
      const input = document.getElementById('faceMatchConfidence');
      if (input) {
        input.value = cfg.matchConfidence;
        setText('faceConfValue', `${cfg.matchConfidence}%`);
      }
    }
    if (cfg.unknownThreshold != null) {
      const input = document.getElementById('faceUnknownThreshold');
      if (input) {
        input.value = cfg.unknownThreshold;
        setText('faceUnknownValue', `${cfg.unknownThreshold}%`);
      }
    }
    updateFaceGroupsVisibility();
    updateFaceModuleStatus();
  }

  function updateFaceGroupsVisibility() {
    const multiOn = document.querySelector('#faceFeaturesList input[value="multiGroups"]')?.checked;
    document.getElementById('faceGroupsCard')?.classList.toggle('is-hidden', !multiOn);
  }

  function wireFaceModule() {
    wireRangeSlider('faceMatchConfidence', 'faceConfValue', (v) => `${v}%`);
    wireRangeSlider('faceUnknownThreshold', 'faceUnknownValue', (v) => `${v}%`);

    const load = () => {
      try {
        const raw = localStorage.getItem(FACE_MODULE_KEY);
        if (!raw) {
          applyFaceConfig(FACE_MODULE_DEFAULTS);
          return;
        }
        applyFaceConfig(JSON.parse(raw));
      } catch (_) {
        applyFaceConfig(FACE_MODULE_DEFAULTS);
      }
    };

    load();

    document.getElementById('faceSaveBtn')?.addEventListener('click', () => {
      const payload = {
        features: readModuleCheckboxes('faceFeature'),
        groups: readModuleCheckboxes('faceGroup'),
        alerts: readModuleCheckboxes('faceAlert'),
        matchConfidence: Number(document.getElementById('faceMatchConfidence')?.value || FACE_MODULE_DEFAULTS.matchConfidence),
        unknownThreshold: Number(document.getElementById('faceUnknownThreshold')?.value || FACE_MODULE_DEFAULTS.unknownThreshold),
      };
      try { localStorage.setItem(FACE_MODULE_KEY, JSON.stringify(payload)); } catch (_) { /* ignore */ }
      showToast('Face recognition settings saved.');
    });

    document.getElementById('faceResetBtn')?.addEventListener('click', () => {
      applyFaceConfig(FACE_MODULE_DEFAULTS);
      localStorage.removeItem(FACE_MODULE_KEY);
      showToast('Face recognition settings reset to defaults.');
    });

    document.querySelectorAll('#faceFeaturesList input, #faceAlertsList input').forEach((el) => {
      el.addEventListener('change', () => {
        updateFaceGroupsVisibility();
        updateFaceModuleStatus();
      });
    });

    document.getElementById('faceCaptureBtn')?.addEventListener('click', () => {
      showToast('Camera capture opens when a camera feed is selected and face enrollment is enabled.');
    });

    const uploadInput = document.getElementById('faceUploadInput');
    document.getElementById('faceUploadBtn')?.addEventListener('click', () => uploadInput?.click());
    uploadInput?.addEventListener('change', () => {
      const file = uploadInput.files?.[0];
      if (file) showToast(`Queued "${file.name}" for face enrollment.`);
      uploadInput.value = '';
    });

    const bulkInput = document.getElementById('faceBulkUploadInput');
    document.getElementById('faceBulkUploadBtn')?.addEventListener('click', () => bulkInput?.click());
    bulkInput?.addEventListener('change', () => {
      const count = bulkInput.files?.length || 0;
      if (count) showToast(`Queued ${count} image${count === 1 ? '' : 's'} for bulk enrollment.`);
      bulkInput.value = '';
    });

    const importInput = document.getElementById('faceImportInput');
    document.getElementById('faceImportDbBtn')?.addEventListener('click', () => importInput?.click());
    importInput?.addEventListener('change', () => {
      const file = importInput.files?.[0];
      if (file) showToast(`Importing face database from "${file.name}"…`);
      importInput.value = '';
    });

    document.getElementById('faceManualEntryBtn')?.addEventListener('click', () => {
      showToast('Manual person entry: add name, group and access level in the profile table (backend sync pending).');
    });
  }

  function updateFaceModuleStatus() {
    const detectOn = document.querySelector('#faceFeaturesList input[value="faceDetect"]')?.checked;
    const recognitionOn = document.querySelector('#faceFeaturesList input[value="knownRecognition"]')?.checked;
    const active = !!(detectOn || recognitionOn) && state.activeModels.has('face');
    const label = document.getElementById('faceModuleStatusLabel');
    if (label) label.textContent = active ? 'Live' : 'Inactive';
    document.getElementById('faceModuleStatus')?.classList.toggle('is-live', active);
  }

  function updateModuleStatus(modelKey, statusId, labelId) {
    const active = state.activeModels.has(modelKey);
    const label = document.getElementById(labelId);
    if (label) label.textContent = active ? 'Running' : 'Inactive';
    document.getElementById(statusId)?.classList.toggle('is-live', active);
  }

  const PERSON_CONFIG_KEY = 'atomoPersonModuleConfig';
  const PERSON_DEFAULTS = {
    features: {
      detect: true, count: true, boxes: true, track: false,
      countLogs: true, filterSmall: true, presence: true,
    },
    minConfidence: 75,
    alerts: {
      detected: true, notDetected: false, tooMany: true, restricted: true,
    },
  };

  function personConfigKey() {
    return sessionId ? `${PERSON_CONFIG_KEY}:${sessionId}` : PERSON_CONFIG_KEY;
  }

  function readPersonConfigFromUi() {
    const features = {};
    document.querySelectorAll('#personFeaturesList input[name="personFeature"]').forEach((el) => {
      features[el.value] = el.checked;
    });
    const alerts = {};
    document.querySelectorAll('#personAlertsList input[name="personAlert"]').forEach((el) => {
      alerts[el.value] = el.checked;
    });
    return {
      features,
      minConfidence: Number(document.getElementById('personMinConfidence')?.value || 75),
      alerts,
    };
  }

  function applyPersonConfig(cfg) {
    const c = cfg || PERSON_DEFAULTS;
    document.querySelectorAll('#personFeaturesList input[name="personFeature"]').forEach((el) => {
      if (c.features && el.value in c.features) el.checked = c.features[el.value];
    });
    document.querySelectorAll('#personAlertsList input[name="personAlert"]').forEach((el) => {
      if (c.alerts && el.value in c.alerts) el.checked = c.alerts[el.value];
    });
    const slider = document.getElementById('personMinConfidence');
    if (slider && c.minConfidence != null) slider.value = c.minConfidence;
    updatePersonConfLabel();
    updatePersonModuleStatus();
  }

  function loadPersonConfig() {
    try {
      const raw = localStorage.getItem(personConfigKey());
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  function savePersonConfig() {
    try {
      localStorage.setItem(personConfigKey(), JSON.stringify(readPersonConfigFromUi()));
      showToast('Person module settings saved.');
    } catch {
      showToast('Could not save settings.');
    }
  }

  function updatePersonConfLabel() {
    const v = document.getElementById('personMinConfidence')?.value;
    setText('personConfValue', v != null ? `${v}%` : '—');
  }

  function updatePersonModuleStatus() {
    const cfg = readPersonConfigFromUi();
    const active = !!cfg.features?.detect && state.activeModels.has('person');
    const label = document.getElementById('personModuleStatusLabel');
    if (label) label.textContent = active ? 'Live' : 'Inactive';
  }

  function wirePersonModule() {
    const slider = document.getElementById('personMinConfidence');
    if (slider) slider.addEventListener('input', updatePersonConfLabel);

    applyPersonConfig(loadPersonConfig());

    document.getElementById('personSaveBtn')?.addEventListener('click', savePersonConfig);
    document.getElementById('personResetBtn')?.addEventListener('click', () => {
      applyPersonConfig(PERSON_DEFAULTS);
      localStorage.removeItem(personConfigKey());
      showToast('Person module reset to defaults.');
    });

    document.querySelectorAll('#personFeaturesList input, #personAlertsList input').forEach((el) => {
      el.addEventListener('change', updatePersonModuleStatus);
    });
  }

  async function loadDeviceProfile() {
    try {
      const res = await fetch('/api/device/profile');
      if (!res.ok) return;
      const data = await res.json();
      meshcentralUrl = data.meshcentralUrl || data.profile?.meshcentralUrl || null;
      setInput('setAtomicUrl', meshcentralUrl || '');
    } catch (_) { /* ignore */ }
  }

  const state = {
    cpu: 0, npu: null, ram: 0, storage: 0, temp: null,
    rx: 0, tx: 0,
    uptimeSeconds: 0,
    camerasTotal: 0, camerasActive: 0, camerasOffline: 0,
    aiModelsTotal: 4, aiModelsRunning: 0,
    activeModels: new Set(),
    alertsToday: 0, alertsCritical: 0, alertsWarning: 0, alertsInfo: 0,
    atomicQueue: 0, atomicOnline: false, lastSyncSeconds: null,
    power: '—', battery: null,
  };

  const history = { labels: [], cpu: [], ram: [], storage: [], rx: [], tx: [], max: 26 };
  const sparkBars = [];
  const detectionLog = [];
  let cameras = [];
  let statsPollCount = 0;

  const demo = {
    seeded: false,
    camerasTotal: 0,
    camerasActive: 0,
    alertsToday: 0,
    cpu: 0,
    ram: 0,
    storage: 0,
    npu: 0,
    rx: 0,
    tx: 0,
    temp: 0,
  };

  const DETECTION_SAMPLES = [
    { label: 'Person', accent: 'violet', zones: ['Loading dock', 'Warehouse A', 'Perimeter — east', 'Lobby'], details: ['1 person in zone', '2 persons detected', 'Loitering alert', 'Entry detected'] },
    { label: 'Fire & smoke', accent: 'amber', zones: ['Kitchen', 'Storage B', 'Roof access'], details: ['Smoke signature', 'Heat anomaly', 'Visual smoke trace', 'Thermal spike'] },
    { label: 'Face match', accent: 'cyan', zones: ['Main gate', 'Reception', 'Staff entrance'], details: ['Watchlist match', 'Unknown face', 'Enrolled identity', 'High-confidence match'] },
    { label: 'Safety', accent: 'green', zones: ['Assembly line', 'Zone C', 'Forklift path'], details: ['No hard hat', 'Vest missing', 'Restricted zone entry', 'PPE compliant'] },
  ];

  function seedDemoBaselines() {
    if (demo.seeded) return;
    demo.seeded = true;
    demo.camerasTotal = randInt(10, 18);
    demo.camerasActive = randInt(Math.max(6, demo.camerasTotal - 3), demo.camerasTotal);
    demo.alertsToday = randInt(22, 48);
    demo.cpu = randFloat(28, 52);
    demo.ram = randFloat(44, 68);
    demo.storage = randFloat(48, 72);
    demo.npu = randFloat(42, 76);
    demo.rx = randFloat(280000, 920000);
    demo.tx = randFloat(120000, 480000);
    demo.temp = randFloat(41, 57);

    for (let i = 0; i < 7; i++) {
      sparkBars.push(randInt(4, 12));
    }
  }

  function seedChartHistory() {
    let cpu = demo.cpu;
    let ram = demo.ram;
    let storage = demo.storage;
    let rx = demo.rx;
    let tx = demo.tx;

    history.labels.length = 0;
    history.cpu.length = 0;
    history.ram.length = 0;
    history.storage.length = 0;
    history.rx.length = 0;
    history.tx.length = 0;

    for (let i = 0; i < history.max; i++) {
      cpu = jitter(cpu, 18, 74, 5);
      ram = jitter(ram, 32, 84, 4);
      storage = jitter(storage, 38, 78, 2.5);
      rx = jitter(rx, 90000, 1400000, 95000);
      tx = jitter(tx, 45000, 720000, 55000);
      history.labels.push('');
      history.cpu.push(cpu);
      history.ram.push(ram);
      history.storage.push(storage);
      history.rx.push(rx);
      history.tx.push(tx);
    }

    demo.cpu = cpu;
    demo.ram = ram;
    demo.storage = storage;
    demo.rx = rx;
    demo.tx = tx;
  }

  function formatLogTime(date = new Date()) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function makeDetectionEntry() {
    const sample = pick(DETECTION_SAMPLES);
    return {
      time: formatLogTime(),
      label: sample.label,
      accent: sample.accent,
      zone: pick(sample.zones),
      detail: pick(sample.details),
      confidence: randInt(78, 99),
    };
  }

  function seedDetectionLog() {
    detectionLog.length = 0;
    for (let i = 0; i < randInt(7, 10); i++) {
      detectionLog.push(makeDetectionEntry());
    }
  }

  function maybeAppendDetection() {
    if (statsPollCount % 3 !== 0) return;
    detectionLog.unshift(makeDetectionEntry());
    if (detectionLog.length > 14) detectionLog.length = 14;
  }

  function applyDemoAnalytics() {
    seedDemoBaselines();

    if (state.camerasTotal === 0) {
      state.camerasTotal = demo.camerasTotal;
      state.camerasActive = demo.camerasActive;
      state.camerasOffline = Math.max(0, demo.camerasTotal - demo.camerasActive);
    }

    state.aiModelsRunning = randInt(2, 4);
    state.activeModels = new Set(['person', 'fire', 'face', 'safety'].slice(0, state.aiModelsRunning));

    demo.alertsToday = jitter(demo.alertsToday, 14, 58, 4);
    state.alertsToday = Math.round(demo.alertsToday);
    state.alertsCritical = randInt(1, Math.min(7, state.alertsToday));
    state.alertsWarning = randInt(4, Math.min(16, state.alertsToday - state.alertsCritical));
    state.alertsInfo = Math.max(0, state.alertsToday - state.alertsCritical - state.alertsWarning);

    demo.cpu = jitter(state.cpu > 3 ? state.cpu : demo.cpu, 20, 72, 5);
    demo.ram = jitter(state.ram > 3 ? state.ram : demo.ram, 34, 82, 4);
    demo.storage = jitter(state.storage > 3 ? state.storage : demo.storage, 40, 76, 2.5);
    demo.npu = jitter(demo.npu, 36, 84, 6);
    demo.rx = jitter(state.rx > 1000 ? state.rx : demo.rx, 85000, 1500000, 110000);
    demo.tx = jitter(state.tx > 1000 ? state.tx : demo.tx, 40000, 780000, 65000);
    demo.temp = jitter(state.temp ?? demo.temp, 37, 63, 1.8);

    state.cpu = demo.cpu;
    state.ram = demo.ram;
    state.storage = demo.storage;
    state.npu = demo.npu;
    state.rx = demo.rx;
    state.tx = demo.tx;
    state.temp = demo.temp;

    if (!state.power || state.power === '—') state.power = pick(['AC mains', 'PoE+', 'Battery + AC']);

    state.atomicQueue = randInt(0, 3);
    state.atomicOnline = true;
    if (state.lastSyncSeconds == null) {
      state.lastSyncSeconds = randInt(18, 320);
    }
  }

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  const LAYOUT_STORAGE_PREFIX = 'atomoOverviewCardOrder';
  const OVERVIEW_ROWS = ['row-identity', 'row-gauges', 'row-charts', 'row-log'];
  const DEFAULT_CARD_ORDER = {
    'row-identity': ['device', 'site', 'role'],
    'row-gauges': ['cameras', 'add-camera', 'ai', 'alerts', 'atomic'],
    'row-charts': ['util', 'chart-stack'],
    'row-log': ['detection'],
  };

  let sortableInstances = [];
  let layoutEditing = false;

  function formatPower(power) {
    if (power == null) return '—';
    if (typeof power === 'string') return power;
    if (typeof power === 'object') {
      return power.source || power.status || power.type || power.label || '—';
    }
    return String(power);
  }

  function pushHistoryPoint() {
    history.labels.push('');
    history.cpu.push(state.cpu ?? 0);
    history.ram.push(state.ram ?? 0);
    history.storage.push(state.storage ?? 0);
    history.rx.push(state.rx ?? 0);
    history.tx.push(state.tx ?? 0);
    if (history.labels.length > history.max) {
      ['labels', 'cpu', 'ram', 'storage', 'rx', 'tx'].forEach((k) => history[k].shift());
    }
  }

  function applyStats(stats) {
    const res = stats.resources || {};
    state.cpu = res.cpu?.percent ?? 0;
    state.npu = res.npu?.percent ?? null;
    state.ram = res.ram?.percent ?? 0;
    state.storage = res.storage?.percent ?? 0;
    state.temp = stats.device?.temperatureC ?? null;
    state.rx = res.network?.rxBps ?? 0;
    state.tx = res.network?.txBps ?? 0;
    state.uptimeSeconds = stats.device?.uptimeSeconds ?? 0;
    state.power = formatPower(stats.device?.power);

    const cams = stats.cameras || {};
    state.camerasTotal = cams.total ?? 0;
    state.camerasActive = cams.active ?? 0;
    state.camerasOffline = cams.offline ?? 0;
    cameras = Array.isArray(cams.items) ? cams.items : [];

    state.aiModelsRunning = stats.ai?.modelsRunning ?? 0;
    const modelKeys = ['person', 'face', 'safety', 'fire'];
    state.activeModels = new Set(modelKeys.slice(0, state.aiModelsRunning));

    const alerts = stats.alerts || {};
    state.alertsToday = alerts.today ?? 0;
    state.alertsCritical = alerts.critical ?? 0;
    state.alertsWarning = Math.max(0, state.alertsToday - state.alertsCritical);
    state.alertsInfo = 0;

    const atomic = stats.atomicCenter || {};
    state.atomicQueue = atomic.pendingQueue ?? 0;
    state.atomicOnline = !!atomic.online;
    if (atomic.url) meshcentralUrl = atomic.url;

    if (lastSyncAt) {
      state.lastSyncSeconds = (Date.now() - lastSyncAt) / 1000;
    } else {
      state.lastSyncSeconds = null;
    }

    const role = stats.device?.role || 'master';
    const ms = stats.device?.masterSlave || 'master';
    setText('roleValue', role.charAt(0).toUpperCase() + role.slice(1));
    setText('roleSub', ms === 'slave' ? 'Slave node' : ms === 'master' ? 'Master node' : String(ms));

    setInput('setFirmwareVersion', stats.device?.firmwareVersion || '—');
    setInput('setLicenseStatus', stats.device?.licenseStatus || 'Unknown');

    applyDemoAnalytics();
    maybeAppendDetection();

    pushHistoryPoint();
    const alertBar = clamp(state.alertsToday, 4, 14);
    sparkBars.push(alertBar);
    if (sparkBars.length > 7) sparkBars.shift();

    if (charts.util) {
      charts.util.data.labels = history.labels;
      charts.util.data.datasets[0].data = history.cpu;
      charts.util.data.datasets[1].data = history.ram;
      charts.util.data.datasets[2].data = history.storage;
    }
    if (charts.net) {
      charts.net.data.labels = history.labels;
      charts.net.data.datasets[0].data = history.rx;
      charts.net.data.datasets[1].data = history.tx;
    }
  }

  async function loadStats() {
    try {
      const res = await fetch(apiUrl('/api/dashboard/stats'));
      if (res.status === 401) {
        sessionStorage.removeItem('atomoSessionId');
        window.location.href = '/login';
        return;
      }
      if (!res.ok) return;
      const stats = await res.json();
      statsPollCount += 1;
      applyStats(stats);
      renderAll();
    } catch (_) { /* ignore transient errors */ }
  }

  let charts = {};

  const centerTextPlugin = {
    id: 'centerText',
    afterDraw(chart, _args, opts) {
      const meta = chart.getDatasetMeta(0);
      if (!meta?.data?.length) return;
      const { ctx } = chart;
      const { x, y } = meta.data[0];
      ctx.save();
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = opts.color || getVar('--ink');
      ctx.font = `700 ${opts.size || 18}px Space Grotesk, sans-serif`;
      ctx.fillText(opts.text || '', x, y - (opts.sub ? 7 : 0));
      if (opts.sub) {
        ctx.fillStyle = opts.subColor || getVar('--ink-faint');
        ctx.font = '600 9.5px IBM Plex Mono, monospace';
        ctx.fillText(opts.sub, x, y + 11);
      }
      ctx.restore();
    },
  };

  function donut(canvasId, valueA, valueB, colorA, colorBVar, text, sub, size) {
    const ctx = document.getElementById(canvasId);
    if (!ctx || !window.Chart) return null;
    const a = valueA ?? 0;
    const b = valueB ?? 0;
    return new Chart(ctx, {
      type: 'doughnut',
      data: { datasets: [{ data: [a, Math.max(0, b)], backgroundColor: [colorA, getVar(colorBVar)], borderWidth: 0 }] },
      options: {
        responsive: false,
        cutout: '72%',
        animation: false,
        plugins: { legend: { display: false }, tooltip: { enabled: false }, centerText: { text, sub, size } },
      },
      plugins: [centerTextPlugin],
    });
  }

  function buildLineCommon() {
    return {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: getVar('--panel-2'),
          borderColor: getVar('--line-strong'),
          borderWidth: 1,
          titleColor: getVar('--ink'),
          bodyColor: getVar('--ink-dim'),
          padding: 8,
        },
      },
      scales: {
        x: { display: false },
        y: { display: false },
      },
    };
  }

  function hexA(hex, alpha) {
    if (!hex || hex.startsWith('rgb')) return hex || `rgba(128,128,128,${alpha})`;
    const h = hex.replace('#', '');
    const r = parseInt(h.substring(0, 2), 16), g = parseInt(h.substring(2, 4), 16), b = parseInt(h.substring(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  function buildCharts() {
    if (!window.Chart) return;

    seedDemoBaselines();
    seedChartHistory();

    charts.util = new Chart(document.getElementById('utilChart'), {
      type: 'line',
      data: {
        labels: history.labels,
        datasets: [
          { data: history.cpu, borderColor: getVar('--cyan'), backgroundColor: hexA(getVar('--cyan'), 0.12), tension: 0.35, fill: true, pointRadius: 0, borderWidth: 2 },
          { data: history.ram, borderColor: getVar('--violet'), backgroundColor: hexA(getVar('--violet'), 0.1), tension: 0.35, fill: true, pointRadius: 0, borderWidth: 2 },
          { data: history.storage, borderColor: getVar('--green'), backgroundColor: hexA(getVar('--green'), 0.08), tension: 0.35, fill: true, pointRadius: 0, borderWidth: 2 },
        ],
      },
      options: { ...buildLineCommon(), scales: { x: { display: false }, y: { min: 0, max: 100, display: false } } },
    });

    charts.net = new Chart(document.getElementById('netChart'), {
      type: 'line',
      data: {
        labels: history.labels,
        datasets: [
          { data: history.rx, borderColor: getVar('--amber'), backgroundColor: hexA(getVar('--amber'), 0.1), tension: 0.35, fill: true, pointRadius: 0, borderWidth: 2 },
          { data: history.tx, borderColor: getVar('--red'), backgroundColor: hexA(getVar('--red'), 0.08), tension: 0.35, fill: true, pointRadius: 0, borderWidth: 2 },
        ],
      },
      options: { ...buildLineCommon(), scales: { x: { display: false }, y: { display: false, beginAtZero: true } } },
    });

    charts.cameras = donut('camerasDonut', state.camerasActive, state.camerasOffline, getVar('--cyan'), '--muted-soft', `${state.camerasActive}/${state.camerasTotal}`, 'ONLINE', 17);
    charts.ai = donut('aiDonut', state.aiModelsRunning, state.aiModelsTotal - state.aiModelsRunning, getVar('--violet'), '--muted-soft', `${state.aiModelsRunning}`, 'LIVE', 19);
    charts.npu = donut('npuDial', state.npu ?? 0, 100 - (state.npu ?? 0), getVar('--violet'), '--muted-soft', state.npu != null ? `${Math.round(state.npu)}%` : '—', '', 13);
    charts.cpu = donut('cpuDial', state.cpu, 100 - state.cpu, getVar('--cyan'), '--muted-soft', `${Math.round(state.cpu)}%`, '', 13);
  }

  function refreshChartColors() {
    if (!charts.util) return;
    charts.util.data.datasets[0].borderColor = getVar('--cyan');
    charts.util.data.datasets[0].backgroundColor = hexA(getVar('--cyan'), 0.12);
    charts.util.data.datasets[1].borderColor = getVar('--violet');
    charts.util.data.datasets[1].backgroundColor = hexA(getVar('--violet'), 0.1);
    charts.util.data.datasets[2].borderColor = getVar('--green');
    charts.util.data.datasets[2].backgroundColor = hexA(getVar('--green'), 0.08);
    charts.net.data.datasets[0].borderColor = getVar('--amber');
    charts.net.data.datasets[0].backgroundColor = hexA(getVar('--amber'), 0.1);
    charts.net.data.datasets[1].borderColor = getVar('--red');
    charts.net.data.datasets[1].backgroundColor = hexA(getVar('--red'), 0.08);
    if (charts.cameras) charts.cameras.data.datasets[0].backgroundColor = [getVar('--cyan'), getVar('--muted-soft')];
    if (charts.ai) charts.ai.data.datasets[0].backgroundColor = [getVar('--violet'), getVar('--muted-soft')];
    if (charts.npu) charts.npu.data.datasets[0].backgroundColor = [getVar('--violet'), getVar('--muted-soft')];
    if (charts.cpu) charts.cpu.data.datasets[0].backgroundColor = [getVar('--cyan'), getVar('--muted-soft')];
    Object.values(charts).forEach((c) => c && c.update('none'));
  }

  function renderSparkline() {
    const wrap = document.getElementById('alertSparkline');
    if (!wrap) return;
    const max = Math.max(...sparkBars, 1);
    wrap.innerHTML = sparkBars
      .map((v) => `<span style="height:${Math.max(10, (v / max) * 100)}%"></span>`)
      .join('');
  }

  function renderDetections() {
    const table = document.getElementById('detectionLog');
    if (!table) return;
    const head = '<div class="log-row log-row-head"><span>Time</span><span>Model</span><span>Zone / camera</span><span>Detail</span><span>Confidence</span></div>';
    if (!detectionLog.length) {
      table.innerHTML = `${head}<div class="log-row log-row-empty"><span>—</span><span>—</span><span colspan="3">No detections yet</span><span>—</span></div>`;
      return;
    }
    const rows = detectionLog.map((d) => {
      const confClass = d.confidence >= 90 ? 'is-high' : d.confidence >= 80 ? 'is-mid' : 'is-low';
      return `<div class="log-row">
        <span class="log-time">${d.time}</span>
        <span><span class="log-model-tag" data-accent="${d.accent}">${d.label}</span></span>
        <span class="log-zone">${d.zone}</span>
        <span class="log-detail">${d.detail}</span>
        <span class="log-conf ${confClass}">${d.confidence}%</span>
      </div>`;
    }).join('');
    table.innerHTML = head + rows;
  }

  function renderModelChips() {
    document.querySelectorAll('#modelChips .chip').forEach((chip) => {
      chip.classList.toggle('is-live', state.activeModels.has(chip.dataset.model));
    });
  }

  function renderCameraFeeds() {
    const section = document.getElementById('row-camera-feeds');
    const grid = document.getElementById('cameraFeedsGrid');
    if (!section || !grid) return;

    section.classList.toggle('is-hidden', cameras.length === 0);
    if (!cameras.length) {
      grid.innerHTML = '';
      return;
    }

    grid.innerHTML = cameras.map((cam) => {
      const isActive = cam.status === 'active';
      const zone = cam.zone ? `<span>${escapeHtml(cam.zone)}</span>` : '';
      return `<article class="camera-feed-card" data-camera-id="${escapeHtml(cam.id)}">
        <div class="camera-feed-preview">
          <span class="camera-feed-status${isActive ? '' : ' is-offline'}">
            <span class="status-dot" aria-hidden="true"></span>${isActive ? 'Live' : 'Offline'}
          </span>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
            <path d="M4 8h2l2-3h8l2 3h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V10a2 2 0 0 1 2-2z"/>
            <circle cx="12" cy="14" r="3.2"/>
          </svg>
        </div>
        <div class="camera-feed-body">
          <h3 class="camera-feed-name">${escapeHtml(cam.name)}</h3>
          <div class="camera-feed-meta">
            <span class="camera-feed-type">${escapeHtml(cam.type)}</span>
            ${zone}
          </div>
          <p class="camera-feed-url" title="${escapeHtml(cam.rtspUrl)}">${escapeHtml(cam.rtspUrl)}</p>
        </div>
      </article>`;
    }).join('');
  }

  function renderSettingsCameras() {
    const empty = document.getElementById('settingsCamerasEmpty');
    const tableWrap = document.getElementById('settingsCamerasTableWrap');
    const tbody = document.getElementById('settingsCamerasBody');
    if (!empty || !tableWrap || !tbody) return;

    const hasCameras = cameras.length > 0;
    empty.classList.toggle('is-hidden', hasCameras);
    tableWrap.classList.toggle('is-hidden', !hasCameras);

    if (!hasCameras) {
      tbody.innerHTML = '';
      return;
    }

    tbody.innerHTML = cameras.map((cam) => {
      const isActive = cam.status === 'active';
      return `<tr>
        <td>${escapeHtml(cam.name)}</td>
        <td>${escapeHtml(cam.type)}</td>
        <td>${escapeHtml(cam.zone || '—')}</td>
        <td><span class="settings-badge ${isActive ? 'is-ok' : ''}">${isActive ? 'Active' : 'Offline'}</span></td>
      </tr>`;
    }).join('');
  }

  function openAddCameraModal() {
    const modal = document.getElementById('addCameraModal');
    const form = document.getElementById('addCameraForm');
    const errorEl = document.getElementById('addCameraError');
    if (!modal || !form) return;
    form.reset();
    if (errorEl) {
      errorEl.textContent = '';
      errorEl.classList.add('is-hidden');
    }
    modal.classList.remove('is-hidden');
    document.getElementById('cameraName')?.focus();
  }

  function closeAddCameraModal() {
    document.getElementById('addCameraModal')?.classList.add('is-hidden');
  }

  async function submitAddCamera(e) {
    e.preventDefault();
    const errorEl = document.getElementById('addCameraError');
    const submitBtn = document.getElementById('addCameraSubmitBtn');
    const name = document.getElementById('cameraName')?.value.trim();
    const type = document.getElementById('cameraType')?.value.trim();
    const zone = document.getElementById('cameraZone')?.value.trim();
    const rtspUrl = document.getElementById('cameraRtspUrl')?.value.trim();

    const showError = (msg) => {
      if (!errorEl) return;
      errorEl.textContent = msg;
      errorEl.classList.remove('is-hidden');
    };

    if (!name || !type || !rtspUrl) {
      showError('Please fill in camera name, type and RTSP URL.');
      return;
    }
    if (!/^rtsps?:\/\//i.test(rtspUrl)) {
      showError('RTSP URL must start with rtsp:// or rtsps://.');
      return;
    }

    if (submitBtn) submitBtn.disabled = true;
    try {
      const res = await fetch(apiUrl('/api/cameras'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, type, rtspUrl, zone: zone || undefined }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        showError(data.error || 'Failed to add camera.');
        return;
      }
      closeAddCameraModal();
      showToast(`Camera "${name}" added.`);
      await loadStats();
    } catch (_) {
      showError('Network error — could not save camera.');
    } finally {
      if (submitBtn) submitBtn.disabled = false;
    }
  }

  function wireAddCameraModal() {
    document.getElementById('addCameraBtn')?.addEventListener('click', openAddCameraModal);
    document.getElementById('settingsAddCameraBtn')?.addEventListener('click', openAddCameraModal);
    document.getElementById('addCameraCancelBtn')?.addEventListener('click', closeAddCameraModal);
    document.getElementById('addCameraModalBackdrop')?.addEventListener('click', closeAddCameraModal);
    document.getElementById('addCameraForm')?.addEventListener('submit', submitAddCamera);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !document.getElementById('addCameraModal')?.classList.contains('is-hidden')) {
        closeAddCameraModal();
      }
    });
  }

  function renderAll() {
    setText('rNpu', fmtPct(state.npu));
    setText('rCpu', fmtPct(state.cpu));
    setText('rRam', fmtPct(state.ram));
    setText('rStorage', fmtPct(state.storage));
    setText('rTemp', fmtTemp(state.temp));
    setText('rUptime', fmtUptime(state.uptimeSeconds));
    setText('rNetwork', `${fmtBps(state.rx)} / ${fmtBps(state.tx)}`);
    setText('rPower', state.power);

    setText('camTotal', state.camerasTotal);
    setText('camActive', state.camerasActive);
    setText('camOffline', state.camerasOffline);

    setText('alertsToday', state.alertsToday);
    setText('alertsCritical', state.alertsCritical);
    setText('alertsWarning', state.alertsWarning);
    setText('alertsInfo', state.alertsInfo);
    setText('alertsCriticalBadge', `${state.alertsCritical} critical`);

    setText('atomicQueue', state.atomicQueue);
    setText('atomicOnline', state.atomicOnline ? 'Yes' : 'No');
    setText('atomicLastSync', state.lastSyncSeconds != null ? fmtAgo(state.lastSyncSeconds) : '—');

    const chip = document.getElementById('atomicStatusChip');
    if (chip) {
      const busy = state.atomicQueue > 0;
      chip.textContent = busy ? 'Syncing' : state.atomicOnline ? 'Synced' : 'Offline';
      chip.classList.toggle('is-busy', busy);
    }

    renderSparkline();
    renderDetections();
    renderModelChips();
    renderCameraFeeds();
    renderSettingsCameras();

    if (charts.cameras) {
      charts.cameras.data.datasets[0].data = [state.camerasActive, Math.max(0, state.camerasOffline)];
      charts.cameras.options.plugins.centerText.text = `${state.camerasActive}/${state.camerasTotal}`;
      charts.cameras.update('none');
    }
    if (charts.ai) {
      charts.ai.data.datasets[0].data = [state.aiModelsRunning, Math.max(0, state.aiModelsTotal - state.aiModelsRunning)];
      charts.ai.options.plugins.centerText.text = `${state.aiModelsRunning}`;
      charts.ai.update('none');
    }
    if (charts.npu) {
      const npu = state.npu ?? 0;
      charts.npu.data.datasets[0].data = [npu, Math.max(0, 100 - npu)];
      charts.npu.options.plugins.centerText.text = state.npu != null ? `${Math.round(state.npu)}%` : '—';
      charts.npu.update('none');
    }
    if (charts.cpu) {
      charts.cpu.data.datasets[0].data = [state.cpu, Math.max(0, 100 - state.cpu)];
      charts.cpu.options.plugins.centerText.text = `${Math.round(state.cpu)}%`;
      charts.cpu.update('none');
    }
    if (charts.util) charts.util.update('none');
    if (charts.net) charts.net.update('none');
    updateSettingsLiveFields();
    updatePersonModuleStatus();
    updateFireModuleStatus();
    updateSafetyModuleStatus();
    updateFaceModuleStatus();
  }

  function applyTheme(theme) {
    root.dataset.theme = theme === 'light' ? 'light' : 'dark';
    const icon = document.getElementById('themeIcon');
    if (icon) {
      icon.innerHTML = theme === 'light'
        ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="4"></circle><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"></path></svg>'
        : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M21 12.8A9 9 0 1111.2 3 7 7 0 0021 12.8z"></path></svg>';
    }
    refreshChartColors();
  }

  let currentTheme = 'dark';

  const TAB_META = {
    overview: { eyebrow: 'Live overview', title: 'Command Deck' },
    person: { eyebrow: 'Module', title: 'Person Detection' },
    fire: { eyebrow: 'Module', title: 'Fire & Smoke' },
    safety: { eyebrow: 'Module', title: 'Safety Compliance' },
    face: { eyebrow: 'Module', title: 'Face Recognition' },
    models: { eyebrow: 'Module', title: 'AI Models' },
    settings: { eyebrow: 'Configuration', title: 'Settings' },
  };

  async function requestCloudSync(forceRun) {
    const syncBtn = document.getElementById('syncCloudBtn');
    const original = syncBtn?.textContent;
    if (syncBtn) {
      syncBtn.disabled = true;
      syncBtn.textContent = 'Syncing…';
    }
    try {
      const enqueueRes = await fetch(apiUrl('/api/device/cloud-sync/enqueue-current'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      });
      const enqueueData = await enqueueRes.json().catch(() => ({}));
      if (!enqueueRes.ok && !enqueueData.ok) {
        showToast(enqueueData.error || 'Sync request failed.');
        return;
      }
      if (enqueueData.synced) {
        lastSyncAt = Date.now();
        showToast(enqueueData.message || 'Profile synced to AWS.');
      } else {
        showToast(enqueueData.message || 'Sync queued.');
      }
      if (forceRun) {
        const runRes = await fetch('/api/device/cloud-sync/run', { method: 'POST' });
        const runData = await runRes.json().catch(() => ({}));
        if (runRes.ok && runData.ok !== false) {
          lastSyncAt = Date.now();
          showToast('Atomic Center sync processed.');
        }
      }
      await loadStats();
    } catch (e) {
      showToast(e.message || 'Sync failed.');
    } finally {
      if (syncBtn) {
        syncBtn.disabled = false;
        syncBtn.textContent = original;
      }
    }
  }

  function layoutStorageKey() {
    return sessionId ? `${LAYOUT_STORAGE_PREFIX}:${sessionId}` : LAYOUT_STORAGE_PREFIX;
  }

  function loadSavedLayout() {
    try {
      const raw = localStorage.getItem(layoutStorageKey());
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  function getCurrentCardOrder() {
    const order = {};
    OVERVIEW_ROWS.forEach((rowId) => {
      const row = document.getElementById(rowId);
      if (!row) return;
      order[rowId] = [...row.querySelectorAll(':scope > .overview-card')].map((el) => el.dataset.cardId);
    });
    return order;
  }

  function applyCardOrder(order) {
    if (!order) return;
    OVERVIEW_ROWS.forEach((rowId) => {
      const ids = order[rowId];
      const row = document.getElementById(rowId);
      if (!row || !Array.isArray(ids)) return;
      const map = {};
      [...row.querySelectorAll(':scope > .overview-card')].forEach((el) => {
        map[el.dataset.cardId] = el;
      });
      ids.forEach((id) => { if (map[id]) row.appendChild(map[id]); });
    });
  }

  function saveOverviewLayout() {
    try {
      localStorage.setItem(layoutStorageKey(), JSON.stringify(getCurrentCardOrder()));
    } catch (_) { /* ignore quota errors */ }
  }

  function resizeCharts() {
    requestAnimationFrame(() => {
      Object.values(charts).forEach((c) => {
        if (c && typeof c.resize === 'function') c.resize();
      });
    });
  }

  function setLayoutEditMode(on) {
    layoutEditing = on;
    document.getElementById('panel-overview')?.classList.toggle('is-layout-edit', on);
    sortableInstances.forEach((s) => s.option('disabled', !on));
    document.getElementById('layoutEditBtn')?.classList.toggle('is-hidden', on);
    document.getElementById('layoutEditBtn')?.classList.toggle('is-active', on);
    document.getElementById('layoutDoneBtn')?.classList.toggle('is-hidden', !on);
    document.getElementById('layoutResetBtn')?.classList.toggle('is-hidden', !on);
    document.getElementById('layoutHint')?.classList.toggle('is-hidden', !on);
    if (!on) saveOverviewLayout();
  }

  function updateLayoutNavVisibility(tab) {
    const controls = document.getElementById('layoutNavControls');
    controls?.classList.toggle('is-hidden', tab !== 'overview');
    if (tab !== 'overview' && layoutEditing) setLayoutEditMode(false);
  }

  function resetOverviewLayout() {
    applyCardOrder(DEFAULT_CARD_ORDER);
    localStorage.removeItem(layoutStorageKey());
    resizeCharts();
    showToast('Card order restored to default.');
  }

  function initOverviewSortable() {
    if (!window.Sortable) return;
    applyCardOrder(loadSavedLayout() || DEFAULT_CARD_ORDER);

    OVERVIEW_ROWS.forEach((rowId) => {
      const el = document.getElementById(rowId);
      if (!el || el.querySelectorAll(':scope > .overview-card').length < 2) return;
      sortableInstances.push(Sortable.create(el, {
        animation: 180,
        easing: 'cubic-bezier(0.2, 0, 0, 1)',
        handle: '.card-drag-handle',
        draggable: '.overview-card',
        ghostClass: 'overview-card-ghost',
        chosenClass: 'overview-card-chosen',
        disabled: true,
        onEnd() {
          if (layoutEditing) saveOverviewLayout();
          resizeCharts();
        },
      }));
    });
  }

  function wireUi() {
    const atomicLink = document.getElementById('atomicCenterLink');
    if (atomicLink) {
      atomicLink.addEventListener('click', (e) => {
        e.preventDefault();
        if (meshcentralUrl) {
          window.open(meshcentralUrl, '_blank', 'noopener,noreferrer');
        } else {
          showToast('Atomic Center URL is not configured on this device.');
        }
      });
    }

    const themeToggle = document.getElementById('themeToggle');
    if (themeToggle) {
      themeToggle.addEventListener('click', () => {
        currentTheme = currentTheme === 'light' ? 'dark' : 'light';
        applyTheme(currentTheme);
      });
    }

    document.querySelectorAll('.rail-link').forEach((btn) => {
      btn.addEventListener('click', () => {
        const tab = btn.dataset.tab;
        document.querySelectorAll('.rail-link').forEach((b) => b.classList.toggle('is-active', b === btn));
        document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('is-hidden', p.id !== `panel-${tab}`));
        const meta = TAB_META[tab];
        if (meta) { setText('pageEyebrow', meta.eyebrow); setText('pageTitle', meta.title); }
        updateLayoutNavVisibility(tab);
      });
    });

    const logoutBtn = document.getElementById('logoutBtn');
    if (logoutBtn) {
      logoutBtn.addEventListener('click', async () => {
        try {
          await fetch('/api/logout', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId }),
          });
        } catch (_) { /* ignore */ }
        sessionStorage.removeItem('atomoSessionId');
        window.location.href = '/login';
      });
    }

    const syncBtn = document.getElementById('syncCloudBtn');
    if (syncBtn) syncBtn.addEventListener('click', () => requestCloudSync(false));

    const forceSyncBtn = document.getElementById('forceSyncBtn');
    if (forceSyncBtn) forceSyncBtn.addEventListener('click', () => requestCloudSync(true));

    document.getElementById('layoutEditBtn')?.addEventListener('click', () => setLayoutEditMode(true));
    document.getElementById('layoutDoneBtn')?.addEventListener('click', () => setLayoutEditMode(false));
    document.getElementById('layoutResetBtn')?.addEventListener('click', resetOverviewLayout);

    wireAddCameraModal();
    wireSettingsNav();
    wirePersonModule();
    wireFireModule();
    wireSafetyModule();
    wireFaceModule();
    updateLayoutNavVisibility('overview');
  }

  async function boot() {
    const sessionData = await ensureSession();
    if (!sessionData) return;

    applyProfile(sessionData);
    await loadDeviceProfile();
    wireUi();

    const prefersLight = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;
    currentTheme = prefersLight ? 'light' : 'dark';
    applyTheme(currentTheme);
    seedDemoBaselines();
    seedChartHistory();
    seedDetectionLog();
    applyDemoAnalytics();
    buildCharts();
    initOverviewSortable();
    renderAll();
    resizeCharts();

    await loadStats();
    setInterval(loadStats, POLL_MS);
    setInterval(() => {
      if (lastSyncAt) {
        state.lastSyncSeconds = (Date.now() - lastSyncAt) / 1000;
        setText('atomicLastSync', fmtAgo(state.lastSyncSeconds));
      }
    }, 1000);
  }

  if (window.Chart) boot();
  else window.addEventListener('load', boot);
})();
