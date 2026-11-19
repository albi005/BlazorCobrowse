// Cobrowse capture layer — runs inside the tenant app's page.
//
// Responsibilities:
//   * tag the live DOM with stable `data-cb-id` attributes (rrweb serialises
//     attributes, so the agent can send the same id back for control),
//   * record the DOM with rrweb and hand events to the caller,
//   * apply control commands from the agent.
//
// The plugin UI (banner, agent cursor, click flash) is marked with `cbx-block`
// so rrweb leaves it out of the stream.

const ID_ATTR = 'data-cb-id';
export const BLOCK_CLASS = 'cbx-block';
const MASK_CLASS = 'cbx-mask';

let seq = 0;
let tagObserver = null;
let rrwebLoading = null;

export function tagTree(root) {
  if (!root) return;
  if (root.nodeType === 1) {
    if (!root.hasAttribute(ID_ATTR)) root.setAttribute(ID_ATTR, 'cb' + ++seq);
    for (const child of root.children) tagTree(child);
  } else if (root.nodeType === 11 || root.nodeType === 9) {
    for (const child of root.children) tagTree(child);
  }
}

export function startTagging() {
  tagTree(document.body);
  if (tagObserver) return;

  tagObserver = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) tagTree(node);
    }
  });
  tagObserver.observe(document.documentElement, { childList: true, subtree: true });
}

export function stopTagging() {
  tagObserver?.disconnect();
  tagObserver = null;
}

export function ensureRrweb() {
  if (window.rrweb) return Promise.resolve();

  rrwebLoading ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = new URL('../lib/rrweb/rrweb.umd.min.js', import.meta.url).toString();
    script.async = false;
    script.onload = () => (window.rrweb ? resolve() : reject(new Error('rrweb did not initialise')));
    script.onerror = () => reject(new Error('rrweb failed to load'));
    document.head.appendChild(script);
  });

  return rrwebLoading;
}

/**
 * Start recording. Returns a controller with `takeSnapshot()` and `stop()`.
 * `onEvent` receives raw rrweb events, in order.
 */
export async function createCapture({ maskPasswords, onEvent }) {
  await ensureRrweb();

  const stopRecording = window.rrweb.record({
    emit: onEvent,

    // Product decision: no content redaction. Passwords are still masked by
    // default because they are credentials, not support context.
    maskAllInputs: false,
    maskInputOptions: maskPasswords ? { password: true } : {},
    maskTextClass: MASK_CLASS,
    blockClass: BLOCK_CLASS,

    recordCanvas: false,
    recordCrossOriginIframes: false,
    collectFonts: false,
    inlineStylesheet: true,
    sampling: { mousemove: 50, scroll: 100, input: 'last' }
  });

  return {
    takeSnapshot() {
      try {
        window.rrweb.takeFullSnapshot(true);
      } catch {
        // Not recording (anymore); the next start produces a snapshot anyway.
      }
    },
    stop() {
      try {
        stopRecording?.();
      } catch {
        // Already stopped.
      }
    }
  };
}

function cssEscape(value) {
  return window.CSS?.escape ? CSS.escape(value) : String(value).replace(/"/g, '\\"');
}

function resolve(nodeId) {
  if (!nodeId) return null;
  return document.querySelector(`[${ID_ATTR}="${cssEscape(nodeId)}"]`);
}

function fire(el, types) {
  for (const type of types) {
    const ctor = type.startsWith('pointer') && window.PointerEvent ? PointerEvent : MouseEvent;
    el.dispatchEvent(new ctor(type, {
      bubbles: true,
      cancelable: true,
      view: window,
      button: 0,
      buttons: 1
    }));
  }
}

function setNativeValue(el, value) {
  if (el instanceof HTMLSelectElement) {
    el.value = value;
  } else if (el.isContentEditable) {
    el.textContent = value;
  } else {
    const proto = el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
  }

  // Blazor's @bind listens to `change`; @bind:event="oninput" listens to `input`.
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

function flash(el) {
  const rect = el.getBoundingClientRect();
  const box = document.createElement('div');
  box.className = 'cbx-flash ' + BLOCK_CLASS;
  box.style.cssText =
    `position:fixed;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;` +
    'pointer-events:none;z-index:2147483000;border:2px solid #ef4444;border-radius:4px;' +
    'box-shadow:0 0 0 3px rgba(239,68,68,.25);transition:opacity .6s;';
  document.body.appendChild(box);
  setTimeout(() => { box.style.opacity = '0'; }, 150);
  setTimeout(() => box.remove(), 800);
}

/** Apply one control command from the agent. Consent is enforced server-side too. */
export function applyControl(nodeId, action, value) {
  if (action === 'scroll') {
    // Relative scroll, the same protocol the PoC used. The value is either a
    // bare number (legacy) or a JSON object { top, left }. Relative deltas
    // cannot fight each other the way absolute positions do.
    const delta = parseScrollTarget(value);
    if (!delta) return;

    const top = Number(delta.top) || 0;
    const left = Number(delta.left) || 0;
    const el = nodeId ? resolve(nodeId) : null;
    if (el) el.scrollBy({ top, left, behavior: 'smooth' });
    else window.scrollBy({ top, left, behavior: 'smooth' });
    return;
  }

  if (action === 'scrollTo') {
    // Absolute scroll position. Parsed defensively because the value travels
    // as a string on the wire so protocol 1 peers can keep ignoring it.
    const target = parseScrollTarget(value);
    if (!target) return;

    const el = nodeId ? resolve(nodeId) : null;
    const scroller = el || document.scrollingElement || document.documentElement;
    const maxTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    const maxLeft = Math.max(0, scroller.scrollWidth - scroller.clientWidth);

    // Map by proportion when the two viewports have different document
    // heights. A phone and a desktop mirror rarely agree on pixel offsets.
    const top = target.maxTop > 0 ? Math.round((target.top / target.maxTop) * maxTop) : target.top;
    const left = target.maxLeft > 0 ? Math.round((target.left / target.maxLeft) * maxLeft) : target.left;

    if (el) el.scrollTo({ top, left, behavior: 'auto' });
    else window.scrollTo({ top, left, behavior: 'auto' });
    return;
  }

  const el = resolve(nodeId);
  if (!el) return;

  if (action === 'click') {
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    fire(el, ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']);
    flash(el);
    pulseCursor();
  } else if (action === 'setValue') {
    setNativeValue(el, value ?? '');
    flash(el);
  } else if (action === 'highlight') {
    flash(el);
  }
}

function parseScrollTarget(value) {
  if (value == null) return null;

  if (typeof value === 'object') {
    const top = Number(value.top);
    const left = Number(value.left);
    const maxTop = Number(value.maxTop);
    const maxLeft = Number(value.maxLeft);
    return {
      top: Number.isFinite(top) ? top : 0,
      left: Number.isFinite(left) ? left : 0,
      maxTop: Number.isFinite(maxTop) ? maxTop : 0,
      maxLeft: Number.isFinite(maxLeft) ? maxLeft : 0
    };
  }

  const text = String(value).trim();
  if (!text) return null;

  if (text.startsWith('{')) {
    try {
      return parseScrollTarget(JSON.parse(text));
    } catch {
      return null;
    }
  }

  const top = Number(text);
  return Number.isFinite(top) ? { top, left: 0, maxTop: 0, maxLeft: 0 } : null;
}

let cursorEl = null;

/** Draw the agent's pointer on the customer's page (excluded from the stream). */
export function showAgentCursor(xPct, yPct, docX, docY) {
  if (!cursorEl) {
    cursorEl = document.createElement('div');
    cursorEl.className = 'cbx-remote-cursor ' + BLOCK_CLASS;
    const label = document.createElement('span');
    label.className = 'cbx-cursor-label';
    label.textContent = 'Agent';
    cursorEl.appendChild(label);
    document.body.appendChild(cursorEl);
  }

  // Prefer document coordinates. The pointer then stays anchored to the same
  // spot in the page when either side scrolls, instead of drifting with the
  // viewport. Fall back to viewport percentages for older agents.
  const dx = Number(docX);
  const dy = Number(docY);
  if (Number.isFinite(dx) && Number.isFinite(dy)) {
    cursorEl.style.position = 'absolute';
    cursorEl.style.transition = 'none';
    cursorEl.style.left = `${dx}px`;
    cursorEl.style.top = `${dy}px`;
  } else {
    cursorEl.style.position = 'fixed';
    cursorEl.style.transition = '';
    cursorEl.style.left = `${Number(xPct) * 100}%`;
    cursorEl.style.top = `${Number(yPct) * 100}%`;
  }

  clearTimeout(cursorEl._hide);
  cursorEl._hide = setTimeout(() => hideAgentCursor(), 2500);
}

export function hideAgentCursor() {
  cursorEl?.remove();
  cursorEl = null;
}

function pulseCursor() {
  if (!cursorEl) return;
  cursorEl.classList.remove('pulse');
  void cursorEl.offsetWidth;
  cursorEl.classList.add('pulse');
}
