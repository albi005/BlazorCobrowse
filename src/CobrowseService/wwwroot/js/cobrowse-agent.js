// Cobrowse agent console — runs in the support agent's browser.
//
// Connects to CobrowseService, joins an accepted request with a short-lived
// agent ticket, rebuilds the customer's DOM from the rrweb stream, and turns
// clicks / typing in the mirror into control messages for the customer.
//
// The page owns the queue and the accept action; this module owns the live
// session and reports coarse state back through a DotNetObjectReference.
window.cobrowseAgent = (function () {
  let connection = null;
  let replayer = null;
  let requestId = null;
  let ticket = null;
  let dotNetRef = null;
  let pending = [];
  let queue = [];
  let ready = false;
  let selectedNode = null;
  let consent = { view: false, control: false };
  let customerOnline = false;
  let finished = false;
  let assetsLoading = null;
  // Scroll sync is relative, like the PoC: the agent sends deltas and the
  // customer applies them with scrollBy. The mirror is then driven by the
  // customer's replayed scroll, so there is only one source of truth.
  let scrollFlushTimer = null;
  let pendingScroll = new Map();
  let lastCursorSent = 0;
  let lastCursor = null;
  let attachedDoc = null;
  let detachControls = null;

  function el(id) { return document.getElementById(id); }

  function setPill(id, text, kind) {
    const node = el(id);
    if (!node) return;
    node.textContent = text;
    node.className = 'cb-pill' + (kind ? ' ' + kind : '');
  }

  function setToolState(text, kind) {
    setPill('cb-tool-state', text, kind);
  }

  function notify(method, ...args) {
    try {
      dotNetRef?.invokeMethodAsync(method, ...args).catch(() => { /* circuit gone */ });
    } catch {
      // Circuit gone.
    }
  }

  function loadAssets() {
    if (assetsLoading) return assetsLoading;

    assetsLoading = (async () => {
      if (!window.signalR) {
        await loadScript('/lib/signalr/signalr.min.js', () => window.signalR);
      }
      if (!window.rrweb) {
        await loadScript('/lib/rrweb/rrweb.umd.min.js', () => window.rrweb);
      }
      ensureStyles('/lib/rrweb/style.min.css');
    })();

    return assetsLoading;
  }

  function loadScript(src, readyCheck) {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = src;
      script.async = false;
      script.onload = () => (readyCheck() ? resolve() : reject(new Error(src + ' did not initialise')));
      script.onerror = () => reject(new Error(src + ' failed to load'));
      document.head.appendChild(script);
    });
  }

  function ensureStyles(href) {
    if (document.querySelector(`link[data-cobrowse-asset="${href}"]`)) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    link.dataset.cobrowseAsset = href;
    document.head.appendChild(link);
  }

  function resetMirror() {
    detachControls?.();
    detachControls = null;
    attachedDoc = null;
    if (replayer) {
      try { replayer.destroy(); } catch { /* ignore */ }
      replayer = null;
    }
    selectedNode = null;
    pending = [];
    queue = [];
    ready = false;
    clearTimeout(scrollFlushTimer);
    scrollFlushTimer = null;
    pendingScroll = new Map();
    lastCursor = null;
    lastCursorSent = 0;
    const mirror = el('cb-mirror');
    if (mirror) mirror.innerHTML = '';
    setToolState('no element selected');
  }

  async function connect(options) {
    await loadAssets();

    requestId = options.requestId;
    ticket = options.ticket;
    dotNetRef = options.dotNetRef;
    finished = false;
    consent = { view: false, control: false };
    customerOnline = false;
    resetMirror();

    if (connection) {
      try { await connection.stop(); } catch { /* ignore */ }
      connection = null;
    }

    connection = new window.signalR.HubConnectionBuilder()
      .withUrl('/hubs/cobrowse')
      .withAutomaticReconnect([0, 1000, 3000, 6000, 12000, 30000])
      .configureLogging(window.signalR.LogLevel.Warning)
      .build();

    wire();

    try {
      await connection.start();
      await join();
      setPill('cb-link', 'connected', 'ok');
      notify('OnAgentState', 'connected', null);
    } catch (error) {
      console.error('[cobrowse] agent connect failed', error);
      setPill('cb-link', 'connection failed', 'err');
      notify('OnAgentState', 'error', String(error?.message ?? error));
    }
  }

  async function join() {
    await connection.invoke('JoinAsAgent', { requestId, ticket });
  }

  function wire() {
    const c = connection;

    c.on('session-state', (payload) => {
      consent = payload.consent ?? consent;
      customerOnline = !!payload.customerOnline;
      updateConsentPill();
      setPill('cb-user-state', customerOnline ? 'customer online' : 'customer offline', customerOnline ? 'ok' : 'err');
      notify('OnSessionState', customerOnline, consent.view, consent.control);
    });

    c.on('backlog', (payload) => {
      for (const event of payload.events ?? []) onEvent(event);
    });

    c.on('backlog-complete', (payload) => {
      setPill('cb-link', `receiving stream (${payload.count ?? 0} backlog)`, 'ok');
    });

    c.on('events', (payload) => {
      for (const event of payload.events ?? []) onEvent(event);
    });

    c.on('consent-changed', (payload) => {
      consent = { view: !!payload.view, control: !!payload.control };
      updateConsentPill();
      notify('OnConsent', consent.view, consent.control);
    });

    c.on('customer-state', (payload) => {
      customerOnline = !!payload.online;
      setPill('cb-user-state', customerOnline ? 'customer online' : 'customer offline', customerOnline ? 'ok' : 'err');
      notify('OnCustomerState', customerOnline);
    });

    c.on('ended', (payload) => {
      finish(payload?.reason ?? 'ended', payload?.message ?? 'The support session ended.');
    });

    c.onreconnecting(() => setPill('cb-link', 'reconnecting…', 'warn'));

    c.onreconnected(async () => {
      setPill('cb-link', 'connected', 'ok');
      resetMirror();
      try {
        await join();
      } catch (error) {
        console.warn('[cobrowse] agent rejoin failed', error);
      }
    });

    c.onclose(() => {
      if (!finished) {
        setPill('cb-link', 'connection lost', 'err');
        notify('OnAgentState', 'disconnected', 'The connection to the support service was lost.');
      }
    });
  }

  function updateConsentPill() {
    setPill(
      'cb-consent-state',
      !consent.view ? 'no consent' : consent.control ? 'view + control' : 'view only',
      consent.view ? (consent.control ? 'ok' : 'warn') : 'err');
  }

  function apply(event) {
    // The mirror is only ever driven by the customer's stream. Agent scrolls
    // are sent as relative commands and never move the mirror locally, so
    // replaying a scroll here cannot bounce back as another command.
    if (event.type === 3) {
      replayer.addEvent({ ...event, timestamp: 0 });
    } else {
      replayer.addEvent(event);
    }
  }

  function onRebuilt() {
    ready = true;
    attachControls();
    const flush = queue;
    queue = [];
    for (const event of flush) apply(event);
  }

  function initReplayer() {
    replayer = new window.rrweb.Replayer([], {
      root: el('cb-mirror'),
      liveMode: true,
      useVirtualDom: false,
      showDebug: false,
      showWarning: false,
      mouseTail: false,
      blockClass: 'cbx-block',
      maskTextClass: 'cbx-mask'
    });

    replayer.startLive(Date.now());
    replayer.enableInteract();
    replayer.on('fullsnapshot-rebuilded', onRebuilt);
    window.__cbReplayer = replayer;

    const buffered = pending;
    pending = [];
    const snapshot = buffered.findIndex((event) => event.type === 2);
    if (snapshot < 0) return;

    for (let i = 0; i < snapshot; i++) replayer.addEvent(buffered[i]);
    ready = false;
    replayer.addEvent(buffered[snapshot]);
    queue.push(...buffered.slice(snapshot + 1));
  }

  function onEvent(event) {
    if (!replayer) {
      pending.push(event);
      if (event.type === 2) initReplayer();
      return;
    }

    if (event.type === 2) {
      ready = false;
      replayer.addEvent(event);
      return;
    }

    if (!ready) {
      queue.push(event);
      return;
    }

    apply(event);
  }

  function fitMirror() {
    const shell = document.querySelector('.cb-mirror-shell');
    const wrapper = replayer?.wrapper;
    if (!shell || !wrapper) return;
    const width = wrapper.offsetWidth || 1280;
    const height = wrapper.offsetHeight || 900;
    const scale = Math.min(1, (shell.clientWidth - 2) / width);
    wrapper.style.transformOrigin = 'top left';
    wrapper.style.transform = `scale(${scale})`;
    shell.style.height = `${Math.min(window.innerHeight * 0.7, height * scale)}px`;
  }

  function queueScroll(nodeId, dx, dy) {
    if (!dx && !dy) return;
    const key = nodeId || '';
    const pending = pendingScroll.get(key) ?? { nodeId: key, x: 0, y: 0 };
    pending.x += dx;
    pending.y += dy;
    pendingScroll.set(key, pending);

    if (scrollFlushTimer) return;
    scrollFlushTimer = setTimeout(() => {
      scrollFlushTimer = null;
      const batch = [...pendingScroll.values()];
      pendingScroll.clear();
      for (const entry of batch) {
        if (!entry.x && !entry.y) continue;
        connection?.invoke('Control', {
          requestId,
          nodeId: entry.nodeId,
          action: 'scroll',
          value: JSON.stringify({ top: entry.y, left: entry.x })
        }).catch((error) => console.warn('[cobrowse] scroll failed', error));
      }
    }, 40);
  }

  function sendCursor(doc, force = false) {
    if (!lastCursor) return;
    const now = performance.now();
    if (!force && now - lastCursorSent < 40) return;
    lastCursorSent = now;

    const width = doc.documentElement.clientWidth || 1;
    const height = doc.documentElement.clientHeight || 1;
    const scroller = doc.scrollingElement || doc.documentElement;
    connection?.invoke('Cursor', {
      requestId,
      x: lastCursor.x / width,
      y: lastCursor.y / height,
      docX: lastCursor.x + (scroller?.scrollLeft || 0),
      docY: lastCursor.y + (scroller?.scrollTop || 0)
    }).catch(() => { /* best effort */ });
  }

  function attachControls() {
    fitMirror();
    const doc = replayer?.iframe?.contentDocument;
    if (!doc) return;

    // Re-attach whenever rrweb replaces the iframe document. The old listeners
    // are removed first so a re-snapshot cannot stack duplicate handlers.
    if (attachedDoc === doc && detachControls) return;
    detachControls?.();
    attachedDoc = doc;

    const onResize = () => fitMirror();
    const onClick = (event) => {
      event.preventDefault();
      event.stopPropagation();
      const node = event.target;
      const target = node && node.nodeType === 1 ? node.closest('[data-cb-id]') : null;
      if (!target) return;

      selectedNode = target.getAttribute('data-cb-id');
      const tag = target.tagName.toLowerCase();
      const label = (target.textContent || '').trim().slice(0, 40);
      setToolState(`selected <${tag}> · ${selectedNode}${label ? ' · "' + label + '"' : ''}`, 'ok');

      connection?.invoke('Control', {
        requestId,
        nodeId: selectedNode,
        action: 'click',
        value: null
      }).catch((error) => console.warn('[cobrowse] control failed', error));
    };
    const onSubmit = (event) => event.preventDefault();
    const onMouseMove = (event) => {
      lastCursor = { x: event.clientX, y: event.clientY };
      sendCursor(doc);
    };
    const onScroll = () => {
      // The pointer's viewport position does not change when the mirror
      // scrolls, but its document position does. Refresh the dot so it stays
      // under the agent's pointer. Scroll commands are only sent from the
      // wheel/touch/key handlers, never from this replay-driven event.
      sendCursor(doc, true);
    };

    // Wheel, touch and scroll keys are sent as relative deltas and the native
    // scroll is suppressed. The mirror is then driven only by the customer's
    // replayed scroll, so the two sides cannot fight over the position.
    const onWheel = (event) => {
      event.preventDefault();
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? doc.documentElement.clientHeight : 1;
      lastCursor = { x: event.clientX, y: event.clientY };
      sendCursor(doc);
      queueScroll('', event.deltaX * unit, event.deltaY * unit);
    };

    let touchLast = null;
    const onTouchStart = (event) => {
      const touch = event.touches[0];
      if (touch) touchLast = { x: touch.clientX, y: touch.clientY };
    };
    const onTouchMove = (event) => {
      const touch = event.touches[0];
      if (!touch || !touchLast) return;
      event.preventDefault();
      const dx = touchLast.x - touch.clientX;
      const dy = touchLast.y - touch.clientY;
      touchLast = { x: touch.clientX, y: touch.clientY };
      lastCursor = { x: touch.clientX, y: touch.clientY };
      sendCursor(doc);
      queueScroll('', dx, dy);
    };
    const onTouchEnd = () => { touchLast = null; };

    const onKeyDown = (event) => {
      const scroller = doc.scrollingElement || doc.documentElement;
      let dy = 0;
      if (event.key === 'ArrowDown') dy = 40;
      else if (event.key === 'ArrowUp') dy = -40;
      else if (event.key === 'PageDown' || event.key === ' ') dy = scroller.clientHeight * 0.9;
      else if (event.key === 'PageUp') dy = -scroller.clientHeight * 0.9;
      else if (event.key === 'Home') dy = -scroller.scrollHeight;
      else if (event.key === 'End') dy = scroller.scrollHeight;
      if (!dy) return;
      event.preventDefault();
      queueScroll('', 0, dy);
    };

    window.addEventListener('resize', onResize);
    doc.addEventListener('click', onClick, true);
    doc.addEventListener('submit', onSubmit, true);
    doc.addEventListener('mousemove', onMouseMove, true);
    doc.addEventListener('scroll', onScroll, true);
    doc.addEventListener('wheel', onWheel, { passive: false, capture: true });
    doc.addEventListener('touchstart', onTouchStart, { passive: true, capture: true });
    doc.addEventListener('touchmove', onTouchMove, { passive: false, capture: true });
    doc.addEventListener('touchend', onTouchEnd, { passive: true, capture: true });
    doc.addEventListener('keydown', onKeyDown, true);

    detachControls = () => {
      window.removeEventListener('resize', onResize);
      doc.removeEventListener('click', onClick, true);
      doc.removeEventListener('submit', onSubmit, true);
      doc.removeEventListener('mousemove', onMouseMove, true);
      doc.removeEventListener('scroll', onScroll, true);
      doc.removeEventListener('wheel', onWheel, true);
      doc.removeEventListener('touchstart', onTouchStart, true);
      doc.removeEventListener('touchmove', onTouchMove, true);
      doc.removeEventListener('touchend', onTouchEnd, true);
      doc.removeEventListener('keydown', onKeyDown, true);
    };
  }

  function sendText() {
    const input = el('cb-type-input');
    const value = input?.value ?? '';
    if (!selectedNode) {
      setToolState('select an element in the mirror first', 'warn');
      return;
    }

    connection?.invoke('Control', {
      requestId,
      nodeId: selectedNode,
      action: 'setValue',
      value
    }).catch((error) => console.warn('[cobrowse] setValue failed', error));
  }

  function scrollDown() {
    const doc = replayer?.iframe?.contentDocument;
    const scroller = doc?.scrollingElement || doc?.documentElement;
    const step = Math.max(200, Math.round((scroller?.clientHeight || 700) * 0.8));

    // Relative scroll, exactly like the PoC. The customer scrolls; rrweb
    // replays that scroll into the mirror, so the mirror follows without a
    // second, competing position message.
    connection?.invoke('Control', {
      requestId,
      nodeId: '',
      action: 'scroll',
      value: JSON.stringify({ top: step, left: 0 })
    }).catch((error) => console.warn('[cobrowse] scroll failed', error));
  }

  async function end() {
    if (!connection) {
      finish('agent-ended', 'The agent ended the support session.');
      return;
    }

    try {
      await connection.invoke('EndSession', { requestId, reason: 'agent-ended' });
    } catch {
      finish('agent-ended', 'The agent ended the support session.');
    }
  }

  async function disconnect() {
    finished = true;
    resetMirror();

    const c = connection;
    connection = null;
    try { await c?.stop(); } catch { /* already closed */ }
  }

  function finish(reason, message) {
    if (finished) return;
    finished = true;

    resetMirror();
    setPill('cb-link', 'ended', 'warn');
    setPill('cb-user-state', 'customer offline', 'err');
    setPill('cb-consent-state', 'no consent', 'err');

    const c = connection;
    connection = null;
    try { c?.stop(); } catch { /* already closed */ }

    notify('OnSessionEnded', reason, message);
  }

  return { connect, end, disconnect, sendText, scrollDown };
})();
