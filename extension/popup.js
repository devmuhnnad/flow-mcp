// Popup: renders the live bridge state pushed by the background worker.
const api = globalThis.browser ?? globalThis.chrome;
const $ = (id) => document.getElementById(id);

let latest = null;
let port = null;

// ------------------------------------------------------------------ helpers

const REQ_LABEL = {
  FLOW_GEN_IMAGE: 'Generate image',
  FLOW_GEN_VIDEO: 'Generate video',
  FLOW_GEN_TEXT: 'Generate text',
  FLOW_MEDIA_GET_URL: 'Get media URL',
};

function clockTime(ts) {
  // 24-hour keeps the column one line wide whatever the locale.
  return new Date(ts).toLocaleTimeString([], {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function duration(ms) {
  if (ms == null) return '';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  return `${m}m ${Math.round((ms % 60_000) / 1000)}s`;
}

function sinceLabel(ts) {
  if (!ts) return '';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

function appletLabel(a) {
  if (a.title && a.title !== 'Flow applet') return a.title;
  return `Applet #${a.key}`;
}

let toastTimer = null;
function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.classList.add('toast--show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('toast--show'), 1600);
}

/** Build an element tree without touching innerHTML. */
function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2).toLowerCase(), v);
    else node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) if (c) node.appendChild(c);
  return node;
}

function svgIcon(path) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(ns, 'path');
  p.setAttribute('d', path);
  svg.appendChild(p);
  return svg;
}

// ------------------------------------------------------------------- render

function render(s) {
  latest = s;
  $('version').textContent = `v${s.version} · port ${s.port}`;

  renderStatus(s);
  renderTiles(s);
  renderConnection(s);
  renderClients(s);
  renderApplets(s);
  renderActivity(s);

  $('wake').hidden = s.appletCount === 0;
}

function renderStatus(s) {
  const pill = $('pill');
  const text = $('pill-text');
  const banner = $('banner');

  let cls = 'pill pill--bad';
  let label = 'Disconnected';
  let problem = null;
  let hint = null;

  if (s.wsStatus === 'connecting') {
    cls = 'pill pill--idle';
    label = 'Connecting…';
  } else if (s.wsStatus !== 'open') {
    problem = `No MCP server on port ${s.port}`;
    hint = 'Start a chat or agent that uses the Flow MCP server. The first one to start owns the bridge.';
  } else if (s.appletCount === 0) {
    cls = 'pill pill--warn';
    label = 'No applet';
    problem = 'MCP server connected, but no Flow applet is open';
    hint = 'Open any applet at flow.google.com and keep that tab open.';
  } else if (s.appletsAwake === 0) {
    cls = 'pill pill--warn';
    label = 'Asleep';
    problem = 'The browser has suspended the Flow tab';
    hint = 'A suspended tab runs no code, so requests cannot be answered. It is woken automatically on the next request, or press Wake now.';
  } else if (s.inflight > 0) {
    cls = 'pill pill--ok pill--busy';
    label = s.inflight === 1 ? 'Working…' : `Working (${s.inflight})`;
  } else {
    cls = 'pill pill--ok';
    label = 'Ready';
  }

  pill.className = cls;
  text.textContent = label;

  if (problem) {
    banner.hidden = false;
    banner.classList.toggle('banner--bad', s.wsStatus !== 'open');
    $('banner-title').textContent = problem;
    $('banner-hint').textContent = hint;
  } else {
    banner.hidden = true;
  }
}

function renderTiles(s) {
  $('stat-clients').textContent = s.wsStatus === 'open' ? s.mcpClientCount : '—';
  $('stat-applets').textContent =
    s.appletCount > 0 && s.appletsAwake !== s.appletCount
      ? `${s.appletsAwake}/${s.appletCount}`
      : s.appletCount;
  $('stat-inflight').textContent = s.inflight;
}

function renderConnection(s) {
  const socket = s.wsStatus === 'open'
    ? `127.0.0.1:${s.port}`
    : s.wsStatus === 'connecting' ? 'connecting…' : 'not reachable';
  $('kv-socket').textContent = socket;
  $('kv-hub').textContent = s.hubPid ? `pid ${s.hubPid}` : '—';

  const { requests, ok, failed } = s.stats;
  $('kv-requests').textContent = requests === 0 ? 'none yet' : `${requests} · ${ok} ok · ${failed} failed`;
  $('uptime').textContent = s.connectedAt ? `up ${sinceLabel(s.connectedAt)}` : '';
}

function renderClients(s) {
  const list = $('clients');
  list.textContent = '';
  const clients = s.wsStatus === 'open' ? s.mcpClients : [];
  $('clients-count').textContent = clients.length;
  $('clients-empty').hidden = clients.length > 0;

  for (const c of clients) {
    list.appendChild(el('li', { class: 'row' }, [
      el('span', { class: c.inflight > 0 ? 'row-dot row-dot--busy' : 'row-dot' }),
      el('span', { class: 'row-main' }, [
        el('span', { class: 'row-title', text: c.name || 'mcp-client' }),
        el('span', {
          class: 'row-sub',
          text: [
            c.pid ? `pid ${c.pid}` : null,
            c.startedAt ? `up ${sinceLabel(c.startedAt)}` : null,
            c.inflight > 0 ? `${c.inflight} in flight` : null,
          ].filter(Boolean).join(' · '),
        }),
      ]),
      el('span', {
        class: c.role === 'hub' ? 'row-tag row-tag--hub' : 'row-tag',
        text: c.role === 'hub' ? 'hub' : 'peer',
        title: c.role === 'hub'
          ? 'Owns the browser link and routes for the others'
          : 'Shares the browser link through the hub',
      }),
    ]));
  }
}

function renderApplets(s) {
  const list = $('applets');
  list.textContent = '';
  $('applets-count').textContent = s.appletCount;
  $('applets-empty').hidden = s.appletCount > 0;

  for (const a of s.applets) {
    const focus = el('button', {
      class: 'icon-btn',
      type: 'button',
      title: 'Focus this tab',
      'aria-label': 'Focus this tab',
      onclick: () => send({ type: 'focusTab', tabId: a.tabId }),
    }, [svgIcon('M14 3h7v7h-2V6.4l-8.3 8.3-1.4-1.4L17.6 5H14V3ZM5 5h5V3H3v18h18v-7h-2v5H5V5Z')]);
    if (a.tabId == null) focus.disabled = true;

    list.appendChild(el('li', { class: 'row' }, [
      el('span', {
        class: a.awake === false
          ? 'row-dot row-dot--asleep'
          : a.inflight > 0 ? 'row-dot row-dot--busy' : 'row-dot',
      }),
      el('span', { class: 'row-main' }, [
        el('span', { class: 'row-title', text: appletLabel(a), title: a.url || '' }),
        el('span', {
          class: 'row-sub',
          text: [
            a.awake === false ? 'suspended' : a.inflight > 0 ? `${a.inflight} in flight` : 'idle',
            `${a.ok} ok`,
            a.failed > 0 ? `${a.failed} failed` : null,
            `up ${sinceLabel(a.connectedAt)}`,
          ].filter(Boolean).join(' · '),
        }),
      ]),
      focus,
    ]));
  }
}

function renderActivity(s) {
  const list = $('activity');
  list.textContent = '';
  // Only completed requests and link events; "started" lines would double up.
  const rows = s.activity.filter((e) => e.state !== 'started');
  $('activity-empty').hidden = rows.length > 0;

  for (const e of rows.slice(0, 40)) {
    let cls = 'log-row log-row--info';
    let text;
    if (e.kind === 'req') {
      cls = `log-row log-row--${e.ok ? 'ok' : 'bad'}`;
      const label = REQ_LABEL[e.type] || e.type;
      text = e.ok ? label : `${label} — ${e.error || 'failed'}`;
    } else {
      text = e.text || e.kind;
    }
    list.appendChild(el('li', { class: cls }, [
      el('span', { class: 'log-time', text: clockTime(e.ts) }),
      el('span', { class: 'log-text', text }),
      e.ms != null ? el('span', { class: 'log-ms', text: duration(e.ms) }) : null,
    ]));
  }
}

// ---------------------------------------------------------------- messaging

function send(msg) {
  try { port?.postMessage(msg); } catch {}
}

function connect() {
  port = api.runtime.connect({ name: 'flow-popup' });
  port.onMessage.addListener((msg) => {
    if (msg?.type === 'state') render(msg.state);
  });
  port.onDisconnect.addListener(() => {
    port = null;
    // The worker was suspended; reconnecting wakes it again.
    setTimeout(connect, 300);
  });
}

// ------------------------------------------------------------------ actions

$('reconnect').addEventListener('click', () => {
  send({ type: 'reconnect' });
  toast('Reconnecting…');
});

$('open-flow').addEventListener('click', () => send({ type: 'openFlow' }));

$('wake').addEventListener('click', () => {
  send({ type: 'wakeApplets' });
  toast('Waking the Flow tab…');
});


$('clear-log').addEventListener('click', () => {
  send({ type: 'clearLog' });
  toast('Activity cleared');
});

// Keep the relative "up 12s" labels moving while the popup is open.
setInterval(() => { if (latest) render(latest); }, 1000);

connect();
