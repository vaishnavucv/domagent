/* ── DOMAgent — Options Page ────────────────────────────────────── */

const DEFAULTS = { host: '127.0.0.1', port: 18792, path: '/extension' };

const OVERLAY_DEFAULTS = {
  overlayClickEnabled: true,
  overlayClickOpacity: 75,
  overlayTypeEnabled: true,
  overlayTypeOpacity: 75,
  overlayTextEnabled: true,
  overlayTextOpacity: 50,
};

const STATUS_POLL_MS = 5000;
const HEARTBEAT_MS = 6000;

const $ = (id) => document.getElementById(id);

const els = {
  host: $('host'),
  port: $('port'),
  path: $('path'),
  relayUrl: $('relay-url'),
  save: $('save'),
  reset: $('reset'),
  saveStatus: $('save-status'),
  banner: $('status-banner'),
  title: $('status-title'),
  detail: $('status-detail'),
  recheck: $('btn-recheck'),
  // Overlay controls
  clickEnabled: $('overlay-click-enabled'),
  clickOpacity: $('overlay-click-opacity'),
  valClickOpacity: $('val-click-opacity'),
  previewClick: $('preview-click'),
  rowClick: $('row-click'),
  typeEnabled: $('overlay-type-enabled'),
  typeOpacity: $('overlay-type-opacity'),
  valTypeOpacity: $('val-type-opacity'),
  previewType: $('preview-type'),
  rowType: $('row-type'),
  textEnabled: $('overlay-text-enabled'),
  textOpacity: $('overlay-text-opacity'),
  valTextOpacity: $('val-text-opacity'),
  previewText: $('preview-text'),
  rowText: $('row-text'),
  // Heartbeat
  heartbeatDot: $('heartbeat-dot'),
  heartbeatLabel: $('heartbeat-label'),
  heartbeatLatency: $('heartbeat-latency'),
};

/* ── Relay URL preview ─────────────────────────────────────────── */
function updateRelayUrl() {
  const h = els.host.value || DEFAULTS.host;
  const p = els.port.value || DEFAULTS.port;
  const w = els.path.value || DEFAULTS.path;
  els.relayUrl.textContent = `ws://${h}:${p}${w}`;
}

/* ── Load saved settings ───────────────────────────────────────── */
function loadSettings() {
  chrome.storage.local.get({ ...DEFAULTS, ...OVERLAY_DEFAULTS }, (items) => {
    els.host.value = items.host;
    els.port.value = items.port;
    els.path.value = items.path;
    // Overlay settings
    els.clickEnabled.checked = items.overlayClickEnabled;
    els.clickOpacity.value = items.overlayClickOpacity;
    els.typeEnabled.checked = items.overlayTypeEnabled;
    els.typeOpacity.value = items.overlayTypeOpacity;
    els.textEnabled.checked = items.overlayTextEnabled;
    els.textOpacity.value = items.overlayTextOpacity;
    updateRelayUrl();
    updateAllPreviews();
    checkConnection();
    checkHeartbeat();
  });
}

/* ── Save settings ─────────────────────────────────────────────── */
function saveSettings() {
  const settings = {
    host: els.host.value.trim() || DEFAULTS.host,
    port: parseInt(els.port.value, 10) || DEFAULTS.port,
    path: els.path.value.trim() || DEFAULTS.path,
  };
  chrome.storage.local.set(settings, () => {
    els.saveStatus.classList.add('visible');
    setTimeout(() => els.saveStatus.classList.remove('visible'), 2000);
    updateRelayUrl();
    checkConnection();
  });
}

/* ── Save overlay settings (auto-save on change) ───────────────── */
function saveOverlaySettings() {
  const overlaySettings = {
    overlayClickEnabled: els.clickEnabled.checked,
    overlayClickOpacity: parseInt(els.clickOpacity.value, 10),
    overlayTypeEnabled: els.typeEnabled.checked,
    overlayTypeOpacity: parseInt(els.typeOpacity.value, 10),
    overlayTextEnabled: els.textEnabled.checked,
    overlayTextOpacity: parseInt(els.textOpacity.value, 10),
  };
  chrome.storage.local.set(overlaySettings);
}

/* ── Reset to defaults ─────────────────────────────────────────── */
function resetDefaults() {
  els.host.value = DEFAULTS.host;
  els.port.value = DEFAULTS.port;
  els.path.value = DEFAULTS.path;
  // Reset overlays too
  els.clickEnabled.checked = OVERLAY_DEFAULTS.overlayClickEnabled;
  els.clickOpacity.value = OVERLAY_DEFAULTS.overlayClickOpacity;
  els.typeEnabled.checked = OVERLAY_DEFAULTS.overlayTypeEnabled;
  els.typeOpacity.value = OVERLAY_DEFAULTS.overlayTypeOpacity;
  els.textEnabled.checked = OVERLAY_DEFAULTS.overlayTextEnabled;
  els.textOpacity.value = OVERLAY_DEFAULTS.overlayTextOpacity;
  updateAllPreviews();
  saveOverlaySettings();
  saveSettings();
}

/* ── Live preview updates ──────────────────────────────────────── */

function updatePreview(kind) {
  if (kind === 'click' || kind === 'all') {
    const enabled = els.clickEnabled.checked;
    const opacity = parseInt(els.clickOpacity.value, 10) / 100;
    els.valClickOpacity.textContent = els.clickOpacity.value + '%';
    els.previewClick.style.borderColor = `rgba(234, 179, 8, ${opacity})`;
    els.previewClick.style.background = `rgba(234, 179, 8, ${opacity * 0.1})`;
    els.rowClick.classList.toggle('disabled', !enabled);
  }
  if (kind === 'type' || kind === 'all') {
    const enabled = els.typeEnabled.checked;
    const opacity = parseInt(els.typeOpacity.value, 10) / 100;
    els.valTypeOpacity.textContent = els.typeOpacity.value + '%';
    els.previewType.style.borderColor = `rgba(34, 197, 94, ${opacity})`;
    els.previewType.style.background = `rgba(34, 197, 94, ${opacity * 0.1})`;
    els.rowType.classList.toggle('disabled', !enabled);
  }
  if (kind === 'text' || kind === 'all') {
    const enabled = els.textEnabled.checked;
    const opacity = parseInt(els.textOpacity.value, 10) / 100;
    els.valTextOpacity.textContent = els.textOpacity.value + '%';
    els.previewText.style.borderColor = `rgba(0, 210, 255, ${opacity})`;
    els.previewText.style.background = `rgba(0, 210, 255, ${opacity * 0.07})`;
    els.rowText.classList.toggle('disabled', !enabled);
  }
}

function updateAllPreviews() {
  updatePreview('all');
}

/* ── Connection check ──────────────────────────────────────────── */
let pollTimer = null;

function setStatus(state, title, detail) {
  els.banner.setAttribute('data-state', state);
  els.title.textContent = title;
  els.detail.textContent = detail;
}

async function checkConnection() {
  const h = els.host.value || DEFAULTS.host;
  const p = els.port.value || DEFAULTS.port;

  setStatus('checking', 'Checking connection…', `Reaching ${h}:${p}`);

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);

    const res = await fetch(`http://${h}:${p}/health`, {
      method: 'GET',
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (res.ok) {
      setStatus('connected', 'Bridge connected', `Server running at ${h}:${p}`);
    } else {
      setStatus('disconnected', 'Connection failed', `Server returned ${res.status}`);
    }
  } catch (err) {
    setStatus('disconnected', 'Bridge unreachable', `Cannot reach ${h}:${p} — is the MCP server running?`);
  }

  clearTimeout(pollTimer);
  pollTimer = setTimeout(checkConnection, STATUS_POLL_MS);
}

/* ── MCP Heartbeat probe ───────────────────────────────────────── */
let heartbeatTimer = null;

function setHeartbeat(state, label, latency) {
  els.heartbeatDot.className = 'heartbeat-dot ' + state;
  els.heartbeatLabel.textContent = label;
  els.heartbeatLatency.textContent = latency || '';
}

async function checkHeartbeat() {
  const h = els.host.value || DEFAULTS.host;
  const p = els.port.value || DEFAULTS.port;

  try {
    const start = performance.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);

    const res = await fetch(`http://${h}:${p}/health`, {
      method: 'GET',
      signal: controller.signal,
    });
    clearTimeout(timeout);

    const ms = Math.round(performance.now() - start);

    if (res.ok) {
      setHeartbeat('alive', 'MCP heartbeat: alive', `${ms}ms`);
    } else {
      setHeartbeat('dead', `MCP heartbeat: error (${res.status})`, '');
    }
  } catch {
    setHeartbeat('dead', 'MCP heartbeat: no response', '');
  }

  clearTimeout(heartbeatTimer);
  heartbeatTimer = setTimeout(checkHeartbeat, HEARTBEAT_MS);
}

/* ── Event listeners ───────────────────────────────────────────── */
// Connection settings
els.host.addEventListener('input', updateRelayUrl);
els.port.addEventListener('input', updateRelayUrl);
els.path.addEventListener('input', updateRelayUrl);
els.save.addEventListener('click', saveSettings);
els.reset.addEventListener('click', resetDefaults);
els.recheck.addEventListener('click', () => {
  clearTimeout(pollTimer);
  clearTimeout(heartbeatTimer);
  checkConnection();
  checkHeartbeat();
});

// Overlay toggles — live preview + auto-save
els.clickEnabled.addEventListener('change', () => { updatePreview('click'); saveOverlaySettings(); });
els.clickOpacity.addEventListener('input', () => { updatePreview('click'); saveOverlaySettings(); });
els.typeEnabled.addEventListener('change', () => { updatePreview('type'); saveOverlaySettings(); });
els.typeOpacity.addEventListener('input', () => { updatePreview('type'); saveOverlaySettings(); });
els.textEnabled.addEventListener('change', () => { updatePreview('text'); saveOverlaySettings(); });
els.textOpacity.addEventListener('input', () => { updatePreview('text'); saveOverlaySettings(); });

/* ── Init ──────────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', loadSettings);
