// Runs in the ISOLATED world of every frame on *.scf.usercontent.goog.
// Once the MAIN-world script says the applet port is ready, it opens a
// long-lived connection to the background worker and relays requests.
//
// It also answers liveness pings. A browser-suspended tab runs no tasks at
// all, so silence here is how the worker learns the tab is asleep - that works
// on every browser, unlike querying a frozen flag.
(() => {
  const api = globalThis.browser ?? globalThis.chrome;
  const TAG = '__flowMcp';
  let bgPort = null;

  function connect() {
    if (bgPort) return;
    bgPort = api.runtime.connect({ name: 'flow-applet' });
    bgPort.onMessage.addListener((msg) => {
      // Liveness probe: answer immediately, without involving the page.
      if (msg && msg.__ping !== undefined) {
        try { bgPort.postMessage({ __pong: msg.__ping }); } catch {}
        return;
      }
      // msg: { id, type, payload }
      window.postMessage({ [TAG]: 'req', id: msg.id, type: msg.type, payload: msg.payload }, '*');
    });
    bgPort.onDisconnect.addListener(() => {
      bgPort = null;
      // Service worker restarted; reconnect.
      setTimeout(connect, 1000);
    });
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || !d[TAG]) return;
    if (d[TAG] === 'ready') connect();
    else if (d[TAG] === 'res' && bgPort) {
      bgPort.postMessage({ id: d.id, payload: d.payload, error: d.error });
    }
  });

  // Where the Page Lifecycle API exists, say so the moment the page is frozen
  // or resumed. Purely an optimisation - the ping/ack above is the source of
  // truth, and these events are not available in every browser.
  for (const [event, frozen] of [['freeze', true], ['resume', false]]) {
    document.addEventListener(event, () => {
      try { bgPort?.postMessage({ __lifecycle: frozen ? 'frozen' : 'resumed' }); } catch {}
    });
  }

  window.postMessage({ [TAG]: 'ping' }, '*');
})();
