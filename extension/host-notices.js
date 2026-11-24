// Runs in the top frame of flow.google.com.
//
// Flow's applet SDK flattens backend failures into a generic string: a prompt
// refused for policy reasons comes back as "Video generation service
// unavailable. Please try again." The specific reason ("...harmful content
// related to minors", "...usage limit", and so on) is still shown in Flow's own
// UI, so we read it there and hand it to the worker, which attaches it to the
// failing request's error.
//
// Deliberately generic: it watches ARIA live regions and snackbar-ish
// containers rather than Flow-specific class names, which change often, and it
// reads only text Flow has already put on screen. Nothing leaves the machine.
(() => {
  const api = globalThis.browser ?? globalThis.chrome;

  const SELECTOR = [
    '[role="alert"]',
    '[role="status"]',
    '[aria-live="assertive"]',
    '[aria-live="polite"]',
    '[class*="snack" i]',
    '[class*="toast" i]',
    '[class*="notification" i]',
  ].join(',');

  // Buttons and links inside a notification are chrome, not the message: a
  // snackbar's "Close" action sits in its own container and would otherwise be
  // captured as if it were the reason.
  const CONTROL = 'button,[role="button"],a[href],[role="link"],input,select,textarea';

  // Long enough to exclude dismiss labels ("Close", "OK", "إغلاق") in any
  // language, short enough for a real one-line message.
  const MIN_LEN = 12;
  const MAX_LEN = 400;
  const DEDUPE_MS = 4_000;

  // One toast usually triggers several mutations (the node is added, then its
  // text is filled in), so drop anything already seen in the last few seconds -
  // even if other notices came in between.
  const recent = new Map(); // text -> ts

  function report(raw) {
    const text = (raw || '').replace(/\s+/g, ' ').trim();
    if (text.length < MIN_LEN || text.length > MAX_LEN) return;

    const now = Date.now();
    for (const [seen, ts] of recent) {
      if (now - ts > DEDUPE_MS) recent.delete(seen);
    }
    if (recent.has(text)) return;
    recent.set(text, now);

    try {
      Promise.resolve(api.runtime.sendMessage({ __hostNotice: text })).catch(() => {});
    } catch {}
  }

  /** The element's own words, with any buttons or links removed. */
  function messageText(el) {
    try {
      const clone = el.cloneNode(true);
      for (const control of clone.querySelectorAll(CONTROL)) control.remove();
      return clone.textContent;
    } catch {
      return '';
    }
  }

  function consider(el) {
    // Skip anything that is itself part of a control.
    if (el.closest(CONTROL)) return;
    report(messageText(el));
  }

  function scan(node) {
    if (!node || node.nodeType !== 1) return;
    try {
      if (node.matches(SELECTOR)) consider(node);
      for (const el of node.querySelectorAll(SELECTOR)) consider(el);
    } catch {}
  }

  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.type === 'childList') {
        for (const node of m.addedNodes) scan(node);
      } else if (m.type === 'characterData') {
        // A live region often keeps its element and only swaps the text.
        const host = m.target.parentElement?.closest?.(SELECTOR);
        if (host) consider(host);
      }
    }
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
  });
})();
