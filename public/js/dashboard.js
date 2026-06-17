/* ATOMO FORGE — Command Deck (wired to live APIs) */

(function () {
  const root = document.documentElement;
  const POLL_MS = 5000;

  let sessionId = sessionStorage.getItem('atomoSessionId');
  let meshcentralUrl = null;
  let lastSyncAt = null;

  const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
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
  }

  async function loadDeviceProfile() {
    try {
      const res = await fetch('/api/device/profile');
      if (!res.ok) return;
      const data = await res.json();
      meshcentralUrl = data.meshcentralUrl || data.profile?.meshcentralUrl || null;
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
  const sparkBars = [1, 1, 1, 1, 1, 1, 1];
  const detectionLog = [];

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
    state.power = stats.device?.power || '—';

    const cams = stats.cameras || {};
    state.camerasTotal = cams.total ?? 0;
    state.camerasActive = cams.active ?? 0;
    state.camerasOffline = cams.offline ?? 0;

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

    pushHistoryPoint();
    const alertBar = clamp(state.alertsToday, 1, 12);
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

    for (let i = 0; i < history.max; i++) pushHistoryPoint();

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
    settings: { eyebrow: 'Device', title: 'Settings' },
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
    buildCharts();
    renderAll();

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
