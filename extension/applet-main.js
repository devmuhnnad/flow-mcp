// Runs in the MAIN world of every frame on *.scf.usercontent.goog.
// Only the frame that receives window.FLOW_PORT (the applet frame) activates.
// It sends raw Flow SDK messages (FLOW_GEN_IMAGE, ...) on that port and
// relays FLOW_RESPONSE back to the isolated bridge script via window.postMessage.
(() => {
  const TAG = '__flowMcp';
  let port = null;
  let nextId = 1e9; // far above the SDK's own ids, so they never collide
  const pending = new Map(); // portId -> bridge request id

  function attach(p) {
    if (port || !p) return;
    port = p;
    port.addEventListener('message', (e) => {
      const d = e.data;
      if (!d || d.type !== 'FLOW_RESPONSE' || !pending.has(d.id)) return;
      const reqId = pending.get(d.id);
      pending.delete(d.id);
      window.postMessage(
        { [TAG]: 'res', id: reqId, payload: d.payload, error: d.error },
        '*'
      );
    });
    port.start(); // harmless if the SDK already set onmessage
    window.postMessage({ [TAG]: 'ready' }, '*');
  }

  function tryAttach() {
    if (window.FLOW_PORT) attach(window.FLOW_PORT);
    return !!port;
  }

  window.addEventListener('flow_port_ready', tryAttach);
  if (!tryAttach()) {
    // FLOW_PORT may be assigned without the event; poll briefly.
    const t = setInterval(() => { if (tryAttach()) clearInterval(t); }, 250);
    setTimeout(() => clearInterval(t), 60000);
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || d[TAG] !== 'req') return;
    if (!port) {
      window.postMessage({ [TAG]: 'res', id: d.id, error: 'Applet port not ready' }, '*');
      return;
    }
    const portId = ++nextId;
    pending.set(portId, d.id);
    port.postMessage({ type: d.type, payload: d.payload ?? {}, id: portId });
  });

  // Let the bridge re-ask after it connects (ordering between worlds isn't guaranteed).
  window.addEventListener('message', (e) => {
    if (e.source === window && e.data && e.data[TAG] === 'ping' && port) {
      window.postMessage({ [TAG]: 'ready' }, '*');
    }
  });
})();
