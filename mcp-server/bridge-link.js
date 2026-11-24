// Link layer between an MCP server process and the Flow MCP Bridge extension.
//
// Several MCP server processes normally run at once (one per agent / chat), but
// only one process can bind the bridge port and only one WebSocket reaches the
// extension. So the processes elect a hub:
//
//   * HUB  - owns the WebSocketServer on 127.0.0.1:<port>. Talks to the browser
//            extension, and routes requests on behalf of every peer process.
//   * PEER - failed to bind (EADDRINUSE), so it connects to the hub as a client
//            and multiplexes its requests through it.
//
// If the hub process exits, peers notice the socket close and race to bind the
// port again; the winner becomes the new hub and the extension reconnects.
import { EventEmitter } from 'node:events';
import { WebSocketServer, WebSocket } from 'ws';

export const PROTOCOL_VERSION = 1;

const HEARTBEAT_MS = 15_000;
const HEARTBEAT_TIMEOUT_MS = 45_000;
const HELLO_TIMEOUT_MS = 5_000;
const RELINK_MAX_MS = 10_000;

const jitter = (base, spread) => base + Math.floor(Math.random() * spread);

export class BridgeLink extends EventEmitter {
  constructor({ port = 8765, log = () => {}, clientName = 'mcp-client', maxPayload } = {}) {
    super();
    this.port = port;
    this.log = log;
    this.clientName = clientName;
    // Uploads cross this link base64-encoded, so the frame ceiling has to stay
    // comfortably above the largest file we accept.
    this.maxPayload = maxPayload ?? 100 * 1024 * 1024;
    this.clientId = `${process.pid.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    this.startedAt = Date.now();

    this.role = 'starting'; // starting | hub | peer | offline | closed
    this.closed = false;

    // Requests this process originated, whatever the role.
    this.nextLocalId = 1;
    this.localPending = new Map(); // localId -> { resolve, reject, timer, type }

    // --- hub state ---
    this.wss = null;
    this.extLinks = new Map(); // ws -> { origin, version, applets, appletList, lastPong }
    this.peerLinks = new Map(); // ws -> { clientId, name, pid, startedAt, inflight:Set, lastPong }
    this.routes = new Map(); // hubId -> route
    this.nextHubId = 1;

    // --- peer state ---
    this.sock = null;
    this.lastHubPong = null;
    this.sawWelcome = false;
    this.mirror = {
      extensionConnected: false,
      applets: 0,
      appletsAwake: 0,
      appletList: [],
      mcpClients: 1,
      clients: [],
      hubPid: null,
    };

    this.relinkTimer = null;
    this.heartbeatTimer = null;
    // Consecutive failed link attempts, used to back off. Reset as soon as we
    // either own the port or get a welcome from a hub that speaks our protocol.
    this.failStreak = 0;
  }

  // ---------------------------------------------------------------- lifecycle

  start() {
    this.attemptHub();
    this.heartbeatTimer = setInterval(() => this.heartbeat(), HEARTBEAT_MS);
    this.heartbeatTimer.unref?.();
    return this;
  }

  close() {
    this.closed = true;
    this.role = 'closed';
    clearTimeout(this.relinkTimer);
    clearInterval(this.heartbeatTimer);
    this.rejectAllLocal('Bridge link closed');
    try { this.sock?.close(); } catch {}
    try { this.wss?.close(); } catch {}
    for (const ws of [...this.extLinks.keys(), ...this.peerLinks.keys()]) {
      try { ws.close(); } catch {}
    }
  }

  /**
   * Re-run the election. A first attempt after a healthy link is near-instant
   * so failover is quick; repeated failures (an incompatible or wedged process
   * holding the port) back off instead of spinning.
   */
  relink(delay) {
    if (this.closed) return;
    const wait = delay ?? jitter(Math.min(200 * 2 ** this.failStreak, RELINK_MAX_MS), 400);
    clearTimeout(this.relinkTimer);
    this.relinkTimer = setTimeout(() => this.attemptHub(), wait);
    this.relinkTimer.unref?.();
  }

  noteLinkFailure() {
    this.failStreak++;
    if (this.failStreak === 4) {
      this.log(
        `cannot link to the bridge on port ${this.port}: something is holding it but not speaking the bridge protocol. ` +
        'An older Flow MCP server is probably still running - restart it, or set FLOW_MCP_WS_PORT to another port.',
      );
    }
  }

  // --------------------------------------------------------------- public API

  /** Snapshot of everything the bridge knows, for flow_status and diagnostics. */
  get state() {
    if (this.role === 'hub') {
      let applets = 0;
      let appletsAwake = 0;
      const appletList = [];
      for (const info of this.extLinks.values()) {
        applets += info.applets;
        appletsAwake += info.appletsAwake;
        appletList.push(...info.appletList);
      }
      return {
        role: 'hub',
        port: this.port,
        hubPid: process.pid,
        extensionConnected: this.extLinks.size > 0,
        extensionLinks: this.extLinks.size,
        applets,
        appletsAwake,
        appletList,
        mcpClients: 1 + this.peerLinks.size,
        clients: this.hubClientList(),
        inflight: this.routes.size,
      };
    }
    if (this.role === 'peer') {
      return {
        role: 'peer',
        port: this.port,
        hubPid: this.mirror.hubPid,
        extensionConnected: this.mirror.extensionConnected,
        extensionLinks: this.mirror.extensionConnected ? 1 : 0,
        applets: this.mirror.applets,
        appletsAwake: this.mirror.appletsAwake,
        appletList: this.mirror.appletList,
        mcpClients: this.mirror.mcpClients,
        clients: this.mirror.clients,
        inflight: this.localPending.size,
      };
    }
    return {
      role: this.role,
      port: this.port,
      hubPid: null,
      extensionConnected: false,
      extensionLinks: 0,
      applets: 0,
      appletsAwake: 0,
      appletList: [],
      mcpClients: 0,
      clients: [],
      inflight: 0,
    };
  }

  /** Resolves true once the extension is connected with at least one applet. */
  async waitForBridge(timeoutMs = 0) {
    const ready = () => {
      const s = this.state;
      // A suspended tab cannot answer, so it does not count as ready.
      return s.extensionConnected && s.applets > 0 && s.appletsAwake > 0;
    };
    if (ready()) return true;
    if (timeoutMs <= 0) return false;
    return new Promise((resolve) => {
      const done = (v) => {
        clearTimeout(timer);
        this.off('state', onState);
        resolve(v);
      };
      const timer = setTimeout(() => done(ready()), timeoutMs);
      timer.unref?.();
      const onState = () => { if (ready()) done(true); };
      this.on('state', onState);
    });
  }

  /** Send one request to the extension and await its reply. */
  request(type, payload, timeoutMs = 180_000) {
    if (this.closed) return Promise.reject(new Error('Bridge link closed'));
    const id = this.nextLocalId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.localPending.delete(id);
        reject(new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${type}`));
      }, timeoutMs);
      timer.unref?.();
      this.localPending.set(id, { resolve, reject, timer, type });

      try {
        if (this.role === 'hub') {
          this.hubDispatch({ type, payload, timeoutMs, origin: null, originId: id });
        } else if (this.role === 'peer' && this.sock?.readyState === WebSocket.OPEN) {
          this.send(this.sock, { kind: 'req', id, type, payload, timeoutMs });
        } else {
          throw new Error('Flow bridge is not linked yet. Retry in a moment.');
        }
      } catch (e) {
        this.settleLocal(id, { error: e instanceof Error ? e.message : String(e) });
      }
    });
  }

  settleLocal(id, { payload, error }) {
    const p = this.localPending.get(id);
    if (!p) return;
    this.localPending.delete(id);
    clearTimeout(p.timer);
    if (error !== undefined && error !== null) p.reject(new Error(String(error)));
    else p.resolve(payload);
  }

  rejectAllLocal(message) {
    for (const id of [...this.localPending.keys()]) this.settleLocal(id, { error: message });
  }

  emitState() {
    this.emit('state', this.state);
  }

  // -------------------------------------------------------------------- HUB

  attemptHub() {
    if (this.closed) return;
    this.role = 'starting';

    let wss;
    try {
      wss = new WebSocketServer({ host: '127.0.0.1', port: this.port, maxPayload: this.maxPayload });
    } catch {
      this.attemptPeer();
      return;
    }

    const onEarlyError = (err) => {
      // Almost always EADDRINUSE: another process already holds the hub role.
      wss.removeAllListeners();
      try { wss.close(); } catch {}
      if (err?.code !== 'EADDRINUSE') this.log('hub bind failed:', err?.message || err);
      this.attemptPeer();
    };
    wss.once('error', onEarlyError);

    wss.once('listening', () => {
      wss.off('error', onEarlyError);
      this.wss = wss;
      this.role = 'hub';
      this.failStreak = 0;
      this.log(`hub: listening on ws://127.0.0.1:${this.port} (pid ${process.pid})`);
      wss.on('error', (err) => this.log('hub error:', err?.message || err));
      wss.on('close', () => {
        if (this.wss !== wss || this.closed) return;
        this.wss = null;
        this.failoverFromHub();
      });
      wss.on('connection', (ws, req) => this.hubOnConnection(ws, req));
      this.emitState();
    });
  }

  failoverFromHub() {
    this.log('hub: socket server closed, re-linking');
    this.role = 'offline';
    this.rejectAllLocal('Flow bridge hub was lost. Retry the call.');
    this.emitState();
    this.relink();
  }

  hubOnConnection(ws, req) {
    const origin = req.headers.origin || '';
    const addr = req.socket.remoteAddress || '';
    if (!(addr === '127.0.0.1' || addr === '::ffff:127.0.0.1' || addr === '::1')) {
      this.log('hub: rejected non-local connection from', addr);
      ws.close(1008, 'local only');
      return;
    }

    // Every client must identify itself promptly.
    const helloTimer = setTimeout(() => {
      this.log('hub: client never said hello, closing');
      try { ws.close(1008, 'hello timeout'); } catch {}
    }, HELLO_TIMEOUT_MS);
    helloTimer.unref?.();

    let role = null;

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      if (!role) {
        if (msg.kind !== 'hello') return;
        clearTimeout(helloTimer);
        if (msg.role === 'extension') {
          if (!origin.startsWith('chrome-extension://')) {
            this.log('hub: rejected extension hello from origin', origin || '(none)');
            try { ws.close(1008, 'bad origin'); } catch {}
            return;
          }
          role = 'extension';
          this.extLinks.set(ws, {
            origin,
            version: msg.version || null,
            applets: 0,
            appletsAwake: 0,
            appletList: [],
            lastPong: Date.now(),
          });
          this.log(`hub: extension connected (${origin})`);
          this.send(ws, { kind: 'welcome', hubPid: process.pid });
          this.hubBroadcastClients();
          this.emitState();
        } else if (msg.role === 'peer') {
          role = 'peer';
          this.peerLinks.set(ws, {
            clientId: msg.clientId || 'unknown',
            name: msg.name || 'mcp-client',
            pid: msg.pid ?? null,
            startedAt: msg.startedAt ?? Date.now(),
            inflight: new Set(),
            lastPong: Date.now(),
          });
          this.log(`hub: peer joined (${msg.name || 'mcp-client'} pid ${msg.pid}) - now ${1 + this.peerLinks.size} MCP clients`);
          this.send(ws, { kind: 'welcome', hubPid: process.pid, state: this.state });
          this.hubBroadcastStatus();
          this.hubBroadcastClients();
        } else {
          try { ws.close(1008, 'unknown role'); } catch {}
        }
        return;
      }

      if (role === 'extension') this.hubOnExtMessage(ws, msg);
      else this.hubOnPeerMessage(ws, msg);
    });

    ws.on('close', () => {
      clearTimeout(helloTimer);
      if (role === 'extension') {
        this.extLinks.delete(ws);
        this.log('hub: extension disconnected');
        // Fail everything that was in flight on this browser link.
        for (const [hubId, route] of [...this.routes]) {
          if (route.extWs === ws) {
            this.hubSettle(hubId, { error: 'Browser extension disconnected before responding' });
          }
        }
        this.hubBroadcastStatus();
        this.emitState();
      } else if (role === 'peer') {
        const info = this.peerLinks.get(ws);
        this.peerLinks.delete(ws);
        for (const hubId of info?.inflight ?? []) {
          const route = this.routes.get(hubId);
          if (route) { clearTimeout(route.timer); this.routes.delete(hubId); }
        }
        this.log(`hub: peer left (${info?.name} pid ${info?.pid}) - now ${1 + this.peerLinks.size} MCP clients`);
        this.hubBroadcastStatus();
        this.hubBroadcastClients();
        this.emitState();
      }
    });

    ws.on('error', () => {});
  }

  hubOnExtMessage(ws, msg) {
    const info = this.extLinks.get(ws);
    if (!info) return;
    switch (msg.kind) {
      case 'status':
        info.applets = Number(msg.applets) || 0;
        // Older extensions do not report this; assume every applet is awake.
        info.appletsAwake = msg.appletsAwake === undefined
          ? info.applets
          : Number(msg.appletsAwake) || 0;
        info.appletList = Array.isArray(msg.appletList) ? msg.appletList : [];
        this.hubBroadcastStatus();
        this.emitState();
        break;
      case 'res':
        this.hubSettle(msg.id, { payload: msg.payload, error: msg.error });
        break;
      case 'pong':
        info.lastPong = Date.now();
        break;
      case 'ping':
        this.send(ws, { kind: 'pong' });
        break;
    }
  }

  hubOnPeerMessage(ws, msg) {
    const info = this.peerLinks.get(ws);
    if (!info) return;
    switch (msg.kind) {
      case 'req':
        this.hubDispatch({
          type: msg.type,
          payload: msg.payload,
          timeoutMs: Number(msg.timeoutMs) || 180_000,
          origin: ws,
          originId: msg.id,
        });
        break;
      case 'pong':
        info.lastPong = Date.now();
        break;
      case 'ping':
        this.send(ws, { kind: 'pong' });
        break;
    }
  }

  /** Pick the browser link most able to take work. */
  pickExt() {
    let best = null;
    let bestApplets = -1;
    for (const [ws, info] of this.extLinks) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      if (info.applets > bestApplets) {
        best = ws;
        bestApplets = info.applets;
      }
    }
    // When no link has an applet we still forward: the extension returns a
    // clearer "open an applet" error than we can phrase here.
    return best;
  }

  hubDispatch({ type, payload, timeoutMs, origin, originId }) {
    const extWs = this.pickExt();
    if (!extWs) {
      const error = 'Browser extension not connected. Open Chrome with the Flow MCP Bridge extension loaded.';
      if (origin) this.send(origin, { kind: 'res', id: originId, error });
      else this.settleLocal(originId, { error });
      return;
    }

    const hubId = this.nextHubId++;
    const timer = setTimeout(() => {
      this.hubSettle(hubId, {
        error: `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${type}`,
      });
    }, timeoutMs + 5_000);
    timer.unref?.();

    this.routes.set(hubId, { origin, originId, extWs, timer, type, startedAt: Date.now() });
    if (origin) this.peerLinks.get(origin)?.inflight.add(hubId);

    this.send(extWs, { kind: 'req', id: hubId, type, payload });
    this.hubBroadcastClients();
  }

  hubSettle(hubId, { payload, error }) {
    const route = this.routes.get(hubId);
    if (!route) return;
    this.routes.delete(hubId);
    clearTimeout(route.timer);
    if (route.origin) {
      this.peerLinks.get(route.origin)?.inflight.delete(hubId);
      this.send(route.origin, { kind: 'res', id: route.originId, payload, error });
    } else {
      this.settleLocal(route.originId, { payload, error });
    }
    this.hubBroadcastClients();
  }

  hubBroadcastStatus() {
    const s = this.state;
    const msg = {
      kind: 'status',
      extensionConnected: s.extensionConnected,
      applets: s.applets,
      appletsAwake: s.appletsAwake,
      appletList: s.appletList,
      mcpClients: s.mcpClients,
      clients: this.hubClientList(),
      hubPid: process.pid,
    };
    for (const ws of this.peerLinks.keys()) this.send(ws, msg);
  }

  /** Every MCP client (agent / chat) attached to this hub, the hub included. */
  hubClientList() {
    return [
      {
        clientId: this.clientId,
        name: this.clientName,
        pid: process.pid,
        startedAt: this.startedAt,
        role: 'hub',
        inflight: [...this.routes.values()].filter((r) => !r.origin).length,
      },
      ...[...this.peerLinks.values()].map((p) => ({
        clientId: p.clientId,
        name: p.name,
        pid: p.pid,
        startedAt: p.startedAt,
        role: 'peer',
        inflight: p.inflight.size,
      })),
    ];
  }

  /** Tell the browser how many MCP clients (agents / chats) are attached. */
  hubBroadcastClients() {
    const clients = this.hubClientList();
    const msg = { kind: 'clients', clientCount: clients.length, clients, hubPid: process.pid };
    for (const ws of this.extLinks.keys()) this.send(ws, msg);
  }

  // ------------------------------------------------------------------- PEER

  attemptPeer() {
    if (this.closed) return;
    this.role = 'starting';
    let sock;
    try {
      sock = new WebSocket(`ws://127.0.0.1:${this.port}`, { maxPayload: this.maxPayload });
    } catch {
      this.noteLinkFailure();
      this.relink();
      return;
    }

    const fail = () => {
      if (this.sock === sock) this.sock = null;
      sock.removeAllListeners();
      try { sock.terminate(); } catch {}
      if (this.role === 'peer') {
        this.role = 'offline';
        this.lastHubPong = null;
        this.rejectAllLocal('Flow bridge hub was lost. Retry the call.');
        this.emitState();
      }
      // A link that never got a welcome means the holder of the port is not a
      // bridge hub we can talk to; back off instead of hammering it.
      if (!this.sawWelcome) this.noteLinkFailure();
      this.sawWelcome = false;
      // The hub may have exited; race for the port again.
      this.relink();
    };

    sock.on('open', () => {
      this.sock = sock;
      this.role = 'peer';
      this.lastHubPong = Date.now();
      this.log(`peer: attached to hub on ws://127.0.0.1:${this.port}`);
      this.send(sock, {
        kind: 'hello',
        role: 'peer',
        clientId: this.clientId,
        name: this.clientName,
        pid: process.pid,
        startedAt: this.startedAt,
      });
      this.emitState();
    });

    sock.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      switch (msg.kind) {
        case 'welcome':
          this.sawWelcome = true;
          this.failStreak = 0;
          if (msg.state) this.peerApplyStatus({ ...msg.state, hubPid: msg.hubPid });
          break;
        case 'status':
          this.peerApplyStatus(msg);
          break;
        case 'res':
          this.settleLocal(msg.id, { payload: msg.payload, error: msg.error });
          break;
        case 'pong':
          this.lastHubPong = Date.now();
          break;
        case 'ping':
          this.send(sock, { kind: 'pong' });
          break;
      }
    });

    sock.on('close', fail);
    sock.on('error', () => {});
  }

  peerApplyStatus(msg) {
    this.mirror = {
      extensionConnected: !!msg.extensionConnected,
      applets: Number(msg.applets) || 0,
      appletsAwake: Number(msg.appletsAwake) || 0,
      appletList: Array.isArray(msg.appletList) ? msg.appletList : [],
      mcpClients: Number(msg.mcpClients) || 1,
      clients: Array.isArray(msg.clients) ? msg.clients : [],
      hubPid: msg.hubPid ?? this.mirror.hubPid,
    };
    this.emitState();
  }

  // -------------------------------------------------------------- heartbeat

  heartbeat() {
    if (this.closed) return;
    const cutoff = Date.now() - HEARTBEAT_TIMEOUT_MS;

    if (this.role === 'hub') {
      for (const [ws, info] of [...this.extLinks]) {
        if (info.lastPong < cutoff) {
          this.log('hub: extension link stale, dropping');
          try { ws.terminate(); } catch {}
          continue;
        }
        this.send(ws, { kind: 'ping' });
      }
      for (const [ws, info] of [...this.peerLinks]) {
        if (info.lastPong < cutoff) {
          this.log('hub: peer link stale, dropping');
          try { ws.terminate(); } catch {}
          continue;
        }
        this.send(ws, { kind: 'ping' });
      }
      return;
    }

    if (this.role === 'peer' && this.sock?.readyState === WebSocket.OPEN) {
      if (this.lastHubPong !== null && this.lastHubPong < cutoff) {
        this.log('peer: hub stopped answering, re-linking');
        try { this.sock.terminate(); } catch {}
        return;
      }
      this.send(this.sock, { kind: 'ping' });
      return;
    }

    if (this.role === 'offline' || this.role === 'starting') this.relink(0);
  }

  send(ws, msg) {
    if (ws?.readyState !== WebSocket.OPEN) return;
    try { ws.send(JSON.stringify({ v: PROTOCOL_VERSION, ...msg })); } catch {}
  }
}
