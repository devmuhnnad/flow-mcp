// Background worker (service worker on Chrome/Safari, event page on Firefox).
//
// Holds the single WebSocket link to the Flow MCP bridge hub (one of possibly
// many MCP server processes) and fans requests out to the open Flow applet
// frames. Also keeps the stats and activity log the popup renders.
//
// Browsers suspend background tabs: a suspended tab runs no tasks, so a
// request posted into it never gets answered and the MCP call hangs until it
// times out. We detect that by pinging the applet and requiring a prompt
// answer, then wake the tab by activating it. Both work in every browser;
// Chrome's tabs.frozen flag is not portable, so nothing here depends on it.
const api = globalThis.browser ?? globalThis.chrome;

const DEFAULT_PORT = 8765;
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 15_000;
const HEARTBEAT_MS = 20_000;
const PING_TIMEOUT_MS = 2_000;
const WAKE_SETTLE_MS = 450;
const LOG_LIMIT = 60;
const PROTOCOL_VERSION = 1;

const VERSION = api.runtime.getManifest().version;

// ----------------------------------------------------------------- live state

let wsPort = DEFAULT_PORT;
let ws = null;
let wsStatus = 'idle'; // idle | connecting | open | closed
let lastWsError = null;
let connectedAt = null;
let reconnectDelay = RECONNECT_MIN_MS;
let reconnectTimer = null;
let hubPid = null;

/** User-settable behaviour, persisted in storage.local. */
let settings = {
  autoWake: true, // activate a sleeping applet tab to wake it
  focusWindowToWake: false, // also focus its window (steals focus; opt-in)
};

/** MCP clients (agents / chats) reported by the hub. */
let mcpClients = [];

/** Connected applet frames. key: appletKey */
const applets = new Map();
let nextAppletKey = 1;

/** id -> { appletKey, type, startedAt } */
const inflight = new Map();

/**
 * Text Flow showed in its own UI, per tab. The applet SDK flattens backend
 * failures into a generic string, so when a request fails we look here for the
 * specific reason Flow displayed while that request was running.
 */
const hostNotices = new Map(); // tabId -> [{ text, ts }]
const HOST_NOTICE_KEEP = 8;

/** pingId -> resolve(true) */
const pendingPings = new Map();
let nextPingId = 1;

const popupPorts = new Set();

let stats = { requests: 0, ok: 0, failed: 0, byType: {}, lastRequestAt: null, lastError: null };
let activity = [];

const log = (...a) => console.log('[flow-mcp]', ...a);
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// --------------------------------------------------------------- persistence

// The worker is torn down when idle, so counters live in session storage.
let saveQueued = false;
function persist() {
  if (saveQueued) return;
  saveQueued = true;
  setTimeout(() => {
    saveQueued = false;
    Promise.resolve(api.storage.session.set({ stats, activity })).catch(() => {});
  }, 400);
}

async function restore() {
  try {
    const local = await api.storage.local.get({ wsPort: DEFAULT_PORT, settings: null });
    wsPort = Number(local.wsPort) || DEFAULT_PORT;
    if (local.settings) settings = { ...settings, ...local.settings };
  } catch {}
  try {
    const sess = await api.storage.session.get({ stats: null, activity: null });
    if (sess.stats) stats = { ...stats, ...sess.stats };
    if (Array.isArray(sess.activity)) activity = sess.activity;
  } catch {}
}

// ----------------------------------------------------------------- reporting

function appletSummaries() {
  return [...applets.values()].map((a) => ({
    key: a.key,
    tabId: a.tabId,
    title: a.title,
    url: a.frameUrl,
    inflight: a.inflight.size,
    connectedAt: a.connectedAt,
    ok: a.ok,
    failed: a.failed,
    awake: a.awake,
    checkedAt: a.checkedAt,
  }));
}

function awakeCount() {
  let n = 0;
  for (const a of applets.values()) if (a.awake !== false) n++;
  return n;
}

function snapshot() {
  return {
    version: VERSION,
    port: wsPort,
    wsStatus,
    lastWsError,
    connectedAt,
    hubPid,
    settings,
    serverConnected: wsStatus === 'open',
    mcpClients,
    mcpClientCount: mcpClients.length,
    applets: appletSummaries(),
    appletCount: applets.size,
    appletsAwake: awakeCount(),
    inflight: inflight.size,
    stats,
    activity,
    ready: wsStatus === 'open' && awakeCount() > 0,
  };
}

function broadcast() {
  const state = snapshot();
  for (const p of popupPorts) {
    try { p.postMessage({ type: 'state', state }); } catch {}
  }
  updateBadge();
}

function record(entry) {
  activity.unshift({ ts: Date.now(), ...entry });
  if (activity.length > LOG_LIMIT) activity.length = LOG_LIMIT;
  persist();
}

// --------------------------------------------------------------------- badge

function updateBadge() {
  const awake = awakeCount();
  let text = '';
  let color = '#6b7280';
  let title;

  if (wsStatus !== 'open') {
    text = '!';
    color = '#ef4444';
    title = `Flow MCP Bridge - MCP server not reachable on port ${wsPort}`;
  } else if (applets.size === 0) {
    text = '0';
    color = '#f59e0b';
    title = 'Flow MCP Bridge - open an applet at flow.google.com';
  } else if (awake === 0) {
    text = 'z';
    color = '#f59e0b';
    title = 'Flow MCP Bridge - the Flow tab is suspended by the browser; click it to wake it';
  } else {
    text = inflight.size > 0 ? String(inflight.size) : String(applets.size);
    color = inflight.size > 0 ? '#3b82f6' : '#10b981';
    title = `Flow MCP Bridge - ${applets.size} applet(s), ${mcpClients.length} MCP client(s)`;
  }

  Promise.resolve(api.action.setBadgeText({ text })).catch(() => {});
  Promise.resolve(api.action.setBadgeBackgroundColor({ color })).catch(() => {});
  Promise.resolve(api.action.setTitle({ title })).catch(() => {});

  const variant = wsStatus === 'open' && awake > 0 ? '' : '-off';
  Promise.resolve(api.action.setIcon({
    path: {
      16: `icons/icon16${variant}.png`,
      32: `icons/icon32${variant}.png`,
      48: `icons/icon48${variant}.png`,
      128: `icons/icon128${variant}.png`,
    },
  })).catch(() => {});
}

// -------------------------------------------------------- applet liveness

/** True if the applet frame answers within the timeout. */
function pingApplet(entry, timeoutMs = PING_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const pingId = nextPingId++;
    const timer = setTimeout(() => {
      pendingPings.delete(pingId);
      resolve(false);
    }, timeoutMs);
    pendingPings.set(pingId, () => {
      clearTimeout(timer);
      pendingPings.delete(pingId);
      resolve(true);
    });
    try {
      entry.port.postMessage({ __ping: pingId });
    } catch {
      clearTimeout(timer);
      pendingPings.delete(pingId);
      resolve(false);
    }
  });
}

function setAwake(entry, awake) {
  const changed = entry.awake !== awake;
  entry.awake = awake;
  entry.checkedAt = Date.now();
  if (changed) {
    log(`applet ${entry.key} is ${awake ? 'awake' : 'suspended'}`);
    record({
      kind: 'applet',
      appletKey: entry.key,
      text: awake ? 'Applet tab woke up' : 'Applet tab suspended by the browser',
    });
    sendStatus();
  }
}

/**
 * Wake a suspended tab. Activating it is enough in most cases and does not
 * focus its window, so a Flow tab living in its own window wakes invisibly.
 * Focusing the window does steal focus, so it stays opt-in.
 */
async function wakeApplet(entry) {
  if (entry.tabId == null || !api.tabs?.update) return false;

  try {
    await api.tabs.update(entry.tabId, { active: true });
  } catch {
    return false;
  }
  await delay(WAKE_SETTLE_MS);
  if (await pingApplet(entry)) return true;

  if (!settings.focusWindowToWake || !api.windows?.update) return false;
  try {
    const tab = await api.tabs.get(entry.tabId);
    if (tab?.windowId != null) await api.windows.update(tab.windowId, { focused: true });
  } catch {
    return false;
  }
  await delay(WAKE_SETTLE_MS);
  return pingApplet(entry);
}

/** Check an applet, waking it if allowed. Resolves to whether it can take work. */
async function ensureLive(entry) {
  if (await pingApplet(entry)) {
    setAwake(entry, true);
    return true;
  }
  setAwake(entry, false);
  if (!settings.autoWake) return false;

  const woke = await wakeApplet(entry);
  setAwake(entry, woke);
  if (woke) record({ kind: 'applet', appletKey: entry.key, text: 'Woke the applet tab to run a request' });
  return woke;
}

/** Spread work over live applets: fewest in-flight first, newest to break ties. */
function candidateOrder() {
  return [...applets.values()].sort((a, b) => {
    if ((a.awake !== false) !== (b.awake !== false)) return a.awake !== false ? -1 : 1;
    if (a.inflight.size !== b.inflight.size) return a.inflight.size - b.inflight.size;
    return b.connectedAt - a.connectedAt;
  });
}

async function pickLiveApplet() {
  for (const entry of candidateOrder()) {
    if (!applets.has(entry.key)) continue;
    if (await ensureLive(entry)) return entry;
  }
  return null;
}

/** Periodic check so the popup and flow_status reflect reality. */
async function sweepApplets() {
  for (const entry of [...applets.values()]) {
    const alive = await pingApplet(entry);
    setAwake(entry, alive);
    // Only force a wake when work is riding on it - a long video can be lost
    // behind a tab that fell asleep mid-generation.
    if (!alive && entry.inflight.size > 0 && settings.autoWake) {
      const woke = await wakeApplet(entry);
      setAwake(entry, woke);
    }
  }
  sendStatus();
  broadcast();
}

// ----------------------------------------------------------- WebSocket link

function send(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ v: PROTOCOL_VERSION, ...msg }));
    return true;
  }
  return false;
}

function sendStatus() {
  send({
    kind: 'status',
    applets: applets.size,
    appletsAwake: awakeCount(),
    appletList: appletSummaries(),
  });
}

function connectWs(reason = 'auto') {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  clearTimeout(reconnectTimer);

  wsStatus = 'connecting';
  broadcast();

  let sock;
  try {
    sock = new WebSocket(`ws://127.0.0.1:${wsPort}`);
  } catch (e) {
    lastWsError = String(e?.message || e);
    wsStatus = 'closed';
    scheduleReconnect();
    broadcast();
    return;
  }
  ws = sock;

  sock.onopen = () => {
    if (ws !== sock) return;
    wsStatus = 'open';
    lastWsError = null;
    connectedAt = Date.now();
    reconnectDelay = RECONNECT_MIN_MS;
    log(`connected to MCP bridge hub on port ${wsPort} (${reason})`);
    send({ kind: 'hello', role: 'extension', version: VERSION });
    sendStatus();
    record({ kind: 'link', text: `Connected to MCP bridge on port ${wsPort}` });
    broadcast();
  };

  sock.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    switch (msg.kind) {
      case 'welcome':
        hubPid = msg.hubPid ?? null;
        broadcast();
        break;
      case 'clients':
        mcpClients = Array.isArray(msg.clients) ? msg.clients : [];
        hubPid = msg.hubPid ?? hubPid;
        broadcast();
        break;
      case 'req':
        dispatch(msg);
        break;
      case 'ping':
        send({ kind: 'pong' });
        break;
      case 'pong':
        break;
    }
  };

  sock.onerror = () => {
    if (ws === sock) lastWsError = `Could not reach ws://127.0.0.1:${wsPort}`;
  };

  sock.onclose = () => {
    if (ws !== sock) return;
    ws = null;
    wsStatus = 'closed';
    connectedAt = null;
    hubPid = null;
    mcpClients = [];
    for (const [id, info] of inflight) applets.get(info.appletKey)?.inflight.delete(id);
    inflight.clear();
    scheduleReconnect();
    broadcast();
  };
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => connectWs('retry'), reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
}

// ------------------------------------------------------------------ dispatch

const SLEEP_HINT =
  'The Flow tab is suspended by the browser and did not respond. Browsers freeze background tabs after a few ' +
  'minutes, and a frozen tab runs no code. Click the Flow tab once to wake it, or keep it in its own visible ' +
  'window. Auto-wake can be enabled in the extension popup.';

async function dispatch(msg) {
  const applet = await pickLiveApplet();

  if (!applet) {
    const asleep = applets.size > 0;
    const error = asleep
      ? SLEEP_HINT
      : 'No Flow applet is open. Open any applet at flow.google.com and retry.';
    send({ kind: 'res', id: msg.id, error });
    stats.requests++;
    stats.failed++;
    stats.lastError = asleep ? 'Applet tab suspended' : 'No Flow applet open';
    stats.lastRequestAt = Date.now();
    record({ kind: 'req', type: msg.type, ok: false, error: stats.lastError });
    broadcast();
    return;
  }

  stats.requests++;
  stats.byType[msg.type] = (stats.byType[msg.type] || 0) + 1;
  stats.lastRequestAt = Date.now();

  inflight.set(msg.id, { appletKey: applet.key, type: msg.type, startedAt: Date.now() });
  applet.inflight.add(msg.id);

  try {
    applet.port.postMessage({ id: msg.id, type: msg.type, payload: msg.payload });
  } catch (e) {
    finish(msg.id, { error: `Applet frame unreachable: ${e?.message || e}` });
    return;
  }
  broadcast();
}

function finish(id, { payload, error }) {
  const info = inflight.get(id);
  inflight.delete(id);
  const applet = info ? applets.get(info.appletKey) : null;
  applet?.inflight.delete(id);

  const ms = info ? Date.now() - info.startedAt : null;
  if (error !== undefined && error !== null) {
    // Flow's generic "service unavailable" often hides a specific reason that
    // it did show on screen. Carry that through to the caller.
    const reason = hostReasonFor(applet, info?.startedAt);
    if (reason && !String(error).includes(reason)) {
      error = `${error}

Flow showed: "${reason}"`;
    }
    stats.failed++;
    stats.lastError = String(error);
    if (applet) applet.failed++;
  } else {
    stats.ok++;
    if (applet) applet.ok++;
  }
  record({
    kind: 'req',
    type: info?.type || 'unknown',
    appletKey: info?.appletKey,
    ms,
    ok: !error,
    error: error ? String(error) : undefined,
    state: 'done',
  });
  send({ kind: 'res', id, payload, error });
  broadcast();
}

// ------------------------------------------------------- host page notices

api.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || msg.__hostNotice === undefined) return;
  const tabId = sender?.tab?.id;
  if (tabId == null) return;
  const list = hostNotices.get(tabId) || [];
  list.push({ text: String(msg.__hostNotice), ts: Date.now() });
  while (list.length > HOST_NOTICE_KEEP) list.shift();
  hostNotices.set(tabId, list);
});

/**
 * What Flow displayed in this applet's tab while the request was running.
 * Bounded by the request's own start time so an earlier, unrelated toast is
 * never blamed.
 *
 * Picks the longest candidate rather than the most recent: a notification
 * renders in pieces, and the last fragment to appear is often a stray control
 * label rather than the sentence explaining the failure.
 */
function hostReasonFor(applet, startedAt) {
  if (!applet || applet.tabId == null) return null;
  const list = hostNotices.get(applet.tabId);
  if (!list?.length) return null;

  const from = (startedAt ?? Date.now()) - 1_000;
  let best = null;
  for (const notice of list) {
    if (notice.ts < from) continue;
    if (!best || notice.text.length > best.text.length) best = notice;
  }
  return best?.text ?? null;
}

// -------------------------------------------------- applet frame connections

api.runtime.onConnect.addListener((port) => {
  if (port.name === 'flow-popup') { attachPopup(port); return; }
  if (port.name !== 'flow-applet') return;

  const key = nextAppletKey++;
  const entry = {
    key,
    port,
    tabId: port.sender?.tab?.id ?? null,
    frameUrl: port.sender?.url || '',
    title: port.sender?.tab?.title || 'Flow applet',
    inflight: new Set(),
    connectedAt: Date.now(),
    ok: 0,
    failed: 0,
    awake: true, // it just connected, so it is running
    checkedAt: Date.now(),
  };
  applets.set(key, entry);
  log('applet connected', entry.frameUrl);
  record({ kind: 'applet', text: 'Applet frame connected', appletKey: key });

  // Fill in a friendlier label from the host tab when we can.
  if (entry.tabId != null && api.tabs?.get) {
    Promise.resolve(api.tabs.get(entry.tabId)).then((tab) => {
      if (!applets.has(key) || !tab) return;
      entry.title = tab.title || entry.title;
      broadcast();
    }).catch(() => {});
  }

  connectWs('applet');
  sendStatus();
  broadcast();

  port.onMessage.addListener((msg) => {
    if (!msg) return;
    if (msg.__pong !== undefined) {
      pendingPings.get(msg.__pong)?.();
      return;
    }
    if (msg.__lifecycle !== undefined) {
      // Page Lifecycle hint, where the browser provides it.
      setAwake(entry, msg.__lifecycle === 'resumed');
      broadcast();
      return;
    }
    if (msg.id === undefined) return;
    finish(msg.id, { payload: msg.payload, error: msg.error });
  });

  port.onDisconnect.addListener(() => {
    applets.delete(key);
    if (entry.tabId != null && ![...applets.values()].some((a) => a.tabId === entry.tabId)) {
      hostNotices.delete(entry.tabId);
    }
    log('applet disconnected', entry.frameUrl);
    record({ kind: 'applet', text: 'Applet frame disconnected', appletKey: key });
    for (const id of entry.inflight) {
      inflight.delete(id);
      send({ kind: 'res', id, error: 'Applet frame closed before responding' });
      stats.failed++;
    }
    sendStatus();
    broadcast();
  });
});

// ------------------------------------------------------------ popup channel

function attachPopup(port) {
  popupPorts.add(port);
  try { port.postMessage({ type: 'state', state: snapshot() }); } catch {}
  if (wsStatus !== 'open') connectWs('popup');
  // Opening the popup is a good moment to refresh what we know.
  sweepApplets();

  port.onMessage.addListener(async (msg) => {
    switch (msg?.type) {
      case 'reconnect':
        reconnectDelay = RECONNECT_MIN_MS;
        try { ws?.close(); } catch {}
        ws = null;
        connectWs('manual');
        break;
      case 'setPort': {
        const next = Number(msg.port);
        if (!Number.isInteger(next) || next < 1 || next > 65535) return;
        wsPort = next;
        await api.storage.local.set({ wsPort: next });
        reconnectDelay = RECONNECT_MIN_MS;
        try { ws?.close(); } catch {}
        ws = null;
        connectWs('port-change');
        break;
      }
      case 'setSetting': {
        if (!(msg.key in settings)) return;
        settings = { ...settings, [msg.key]: !!msg.value };
        await api.storage.local.set({ settings });
        broadcast();
        break;
      }
      case 'wakeApplets':
        for (const entry of [...applets.values()]) {
          const woke = (await pingApplet(entry)) || (await wakeApplet(entry));
          setAwake(entry, woke);
        }
        broadcast();
        break;
      case 'clearLog':
        activity = [];
        stats = { requests: 0, ok: 0, failed: 0, byType: {}, lastRequestAt: null, lastError: null };
        persist();
        broadcast();
        break;
      case 'focusTab':
        if (msg.tabId != null) {
          try {
            const tab = await api.tabs.update(msg.tabId, { active: true });
            if (tab?.windowId != null && api.windows?.update) {
              await api.windows.update(tab.windowId, { focused: true });
            }
          } catch {}
        }
        break;
      case 'openFlow':
        Promise.resolve(api.tabs.create({ url: 'https://flow.google.com/' })).catch(() => {});
        break;
      case 'refresh':
        sweepApplets();
        break;
    }
  });

  port.onDisconnect.addListener(() => popupPorts.delete(port));
}

// ----------------------------------------------------------------- lifecycle

api.alarms.create('flow-mcp-keepalive', { periodInMinutes: 0.5 });
api.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== 'flow-mcp-keepalive') return;
  if (wsStatus === 'open') {
    send({ kind: 'ping' }); // traffic also keeps the worker alive
    sweepApplets();
  } else {
    connectWs('alarm');
  }
});

// While the worker is awake, keep the link warm and the applet state current.
setInterval(() => {
  if (wsStatus !== 'open') return;
  send({ kind: 'ping' });
  if (inflight.size > 0) sweepApplets();
}, HEARTBEAT_MS);

api.runtime.onStartup.addListener(() => boot('startup'));
api.runtime.onInstalled.addListener(() => boot('installed'));

async function boot(reason) {
  await restore();
  updateBadge();
  connectWs(reason);
}

boot('load');
