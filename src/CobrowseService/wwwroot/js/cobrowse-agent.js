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
  // customer applies them with scrollBy. The mirror scrolls natively so the
  // agent gets instant feedback; replay echoes are ignored while the agent is
  // driving so the mirror cannot be pushed back mid-gesture.
  let agentScrollUntil = 0;
  let agentScrollTarget = null;
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
    agentScrollUntil = 0;
    agentScrollTarget = null;
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
    const now = performance.now();
    const isScroll = event.type === 3 && event.data?.source === 3;

    // While the agent is scrolling, the customer's replay of the same scroll
    // would push the mirror back to an older position. Ignore those echoes
    // until the replay reaches the position the agent already scrolled to.
    if (isScroll && event.data?.id === 1 && agentScrollTarget) {
      if (now > agentScrollTarget.until) {
        agentScrollTarget = null;
      } else {
        const y = Number(event.data.y);
        const x = Number(event.data.x);
        if (Math.abs(y - agentScrollTarget.top) <= 2 &&
            Math.abs(x - agentScrollTarget.left) <= 2) {
          agentScrollTarget = null;
        }
        return;
      }
    }

    if (isScroll && now < agentScrollUntil) return;

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
    // rrweb's replay applies scrolls with behavior:'smooth' unless the event is
    // marked synchronous. That animation fights the agent's own scroll and
    // makes the mirror drift back and forth. Force instant scrolls.
    if (typeof replayer.applyScroll === 'function') {
      const originalApplyScroll = replayer.applyScroll.bind(replayer);
      replayer.applyScroll = (event) => originalApplyScroll(event, true);
    }
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
    const height = wrapper.offsetHeight || 900;

    // Render the mirror at the customer's native viewport size, like the PoC.
    // Scaling the mirror made wheel deltas and document deltas disagree, which
    // is what made agent-driven scrolling wobble. The shell scrolls/pans when
    // the customer's viewport is wider than the agent's panel.
    wrapper.style.transformOrigin = 'top left';
    wrapper.style.transform = 'none';
    shell.style.height = `${Math.min(window.innerHeight * 0.7, height)}px`;
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

  function setScrollTarget(scroller, top, left) {
    const maxTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    const maxLeft = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
    agentScrollTarget = {
      top: Math.max(0, Math.min(top, maxTop)),
      left: Math.max(0, Math.min(left, maxLeft)),
      until: performance.now() + 1500
    };
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

  // ---------------------------------------------------------- input forwarding
  //
  // The mirror is only a picture of the customer's DOM, so it cannot type for
  // itself. Keystrokes in a mirror field are forwarded to the customer, where
  // the field really lives. This follows the screen-sharing PoC: focus and
  // caret belong to the customer's page, and the value comes back over rrweb.

  function taggedNode(node) {
    return node && node.nodeType === 1 ? node.closest('[data-cb-id]') : null;
  }

  function isEditable(node) {
    return !!node && node.nodeType === 1 &&
      (node.tagName === 'INPUT' || node.tagName === 'TEXTAREA' || node.isContentEditable);
  }

  function sendControl(nodeId, action, value) {
    if (!nodeId) return;
    connection?.invoke('Control', {
      requestId,
      nodeId,
      action,
      value
    }).catch((error) => console.warn(`[cobrowse] ${action} failed`, error));
  }

  function selectTarget(target) {
    const nodeId = target.getAttribute('data-cb-id');
    selectedNode = nodeId;
    const tag = target.tagName.toLowerCase();
    const label = (target.textContent || '').trim().slice(0, 40);
    setToolState(`selected <${tag}> · ${nodeId}${label ? ' · "' + label + '"' : ''}`, 'ok');
  }

  function forwardKey(event, target) {
    const key = event.key;
    if (!key || event.isComposing) return false;

    // The agent's own browser keeps these; everything else belongs to the
    // customer's page.
    if (['F5', 'F11', 'F12', 'Tab', 'Escape', 'CapsLock', 'Process', 'Dead'].includes(key)) return false;

    const nodeId = target.getAttribute('data-cb-id');
    const ctrl = event.ctrlKey || event.metaKey;

    if (ctrl) {
      const k = key.toLowerCase();
      if (k === 'v') {
        // Paste runs in the customer's document, where the caret is. Send the
        // agent's clipboard text along when the browser lets us read it.
        event.preventDefault();
        pasteFromClipboard(nodeId);
        return true;
      }
      if (k === 'a') {
        event.preventDefault();
        sendControl(nodeId, 'key', JSON.stringify({
          key: 'a', code: event.code, ctrl: true, shift: event.shiftKey, alt: event.altKey
        }));
        return true;
      }
      // Ctrl+C / Ctrl+X copy the mirror's own text; leaving them native lets
      // the agent copy what it sees without a round trip.
      return false;
    }

    if (['Shift', 'Control', 'Alt', 'Meta'].includes(key)) return false;

    const printable = key.length === 1;
    // The customer's page is the only editor: stop the mirror from applying
    // the key locally as well. Its value arrives back through rrweb.
    event.preventDefault();

    sendControl(nodeId, 'key', JSON.stringify({
      key,
      code: event.code,
      text: printable ? key : undefined,
      ctrl: false,
      shift: event.shiftKey,
      alt: event.altKey,
      meta: event.metaKey
    }));
    return true;
  }

  function pasteFromClipboard(nodeId) {
    if (!navigator.clipboard?.readText) {
      setToolState('clipboard is not available here', 'warn');
      return;
    }

    navigator.clipboard.readText().then((text) => {
      if (!text) {
        setToolState('clipboard is empty', 'warn');
        return;
      }
      sendControl(nodeId, 'paste', text);
      setToolState(`pasted ${text.length} chars`, 'ok');
    }).catch(() => setToolState('clipboard permission denied', 'warn'));
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
      const target = taggedNode(event.target);
      const inputType = target?.tagName === 'INPUT' ? target.type : '';

      // Native controls keep their own behaviour in the mirror. A dropdown has
      // to open its popup; a range has to move under the pointer. The chosen
      // value is forwarded from `change` / the coalesced `input` below.
      if (target?.tagName === 'SELECT' || inputType === 'range') {
        selectTarget(target);
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      if (!target) return;

      selectTarget(target);
      sendControl(target.getAttribute('data-cb-id'), 'click', null);
    };

    // Selects, checkboxes and radios change the customer's value rather than
    // firing a meaningful click. Checkboxes already toggle through the click
    // path; a select only reports its new option here.
    const onChange = (event) => {
      const target = taggedNode(event.target);
      if (!target) return;

      if (target.tagName === 'SELECT') {
        selectTarget(target);
        const values = target.multiple
          ? JSON.stringify([...target.selectedOptions].map((option) => option.value))
          : target.value;
        sendControl(target.getAttribute('data-cb-id'), 'setValue', values);
      }
    };

    // Dragging a range fires a burst of input events. Send the latest value
    // per node at most every 40ms so the customer's thumb tracks the agent's
    // without flooding the hub.
    let rangeTimer = null;
    const pendingRange = new Map();
    const flushRanges = () => {
      rangeTimer = null;
      for (const [nodeId, value] of pendingRange) sendControl(nodeId, 'setValue', value);
      pendingRange.clear();
    };
    const onInput = (event) => {
      const target = taggedNode(event.target);
      if (!target || target.tagName !== 'INPUT' || target.type !== 'range') return;
      pendingRange.set(target.getAttribute('data-cb-id'), target.value);
      rangeTimer ??= setTimeout(flushRanges, 40);
    };
    const onSubmit = (event) => event.preventDefault();
    const onMouseMove = (event) => {
      lastCursor = { x: event.clientX, y: event.clientY };
      sendCursor(doc);
    };
    const onScroll = () => {
      // The pointer's viewport position does not change when the mirror
      // scrolls, but its document position does. Refresh the dot so it stays
      // under the agent's pointer. Scroll commands are sent from the gesture
      // handlers below, never from this replay-driven event.
      sendCursor(doc, true);
    };

    const markAgentScroll = () => {
      agentScrollUntil = performance.now() + 600;
    };

    // Desktop wheel: let the mirror scroll natively for instant feedback and
    // send the same delta to the customer. The replay echo is ignored while
    // the gesture is active, so it cannot pull the mirror back.
    const onWheel = (event) => {
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? doc.documentElement.clientHeight : 1;
      const scroller = doc.scrollingElement || doc.documentElement;
      const dx = event.deltaX * unit;
      const dy = event.deltaY * unit;
      lastCursor = { x: event.clientX, y: event.clientY };
      sendCursor(doc);
      markAgentScroll();
      // The browser may apply the native scroll before dispatching the wheel
      // event to JS. Read the real position next frame instead of predicting
      // scrollTop + delta, or the echo guard waits for a position that never
      // arrives and the mirror stops following the customer.
      requestAnimationFrame(() => {
        setScrollTarget(scroller, scroller.scrollTop, scroller.scrollLeft);
      });
      queueScroll('', dx, dy);
    };

    // Touch: drive the mirror manually so finger deltas and the customer's
    // scroll stay in lockstep (native momentum would overshoot the delta).
    let touchLast = null;
    const onTouchStart = (event) => {
      const touch = event.touches[0];
      if (touch) touchLast = { x: touch.clientX, y: touch.clientY };
      markAgentScroll();
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
      markAgentScroll();
      const scroller = doc.scrollingElement || doc.documentElement;
      scroller.scrollTop += dy;
      scroller.scrollLeft += dx;
      setScrollTarget(scroller, scroller.scrollTop, scroller.scrollLeft);
      queueScroll('', dx, dy);
    };
    const onTouchEnd = () => { touchLast = null; };

    const onKeyDown = (event) => {
      // Keys typed into a mirror field go to the customer's field; only keys
      // pressed outside an editable element drive the scroll shortcuts.
      const field = isEditable(event.target) ? taggedNode(event.target) : null;
      if (field) {
        // A focused range owns its arrows/Home/End natively; the coalesced
        // input handler forwards the resulting value.
        if (field.tagName === 'INPUT' && field.type === 'range') return;

        // Not a relayed key (Shift, Tab, F-key) is still not a scroll key: the
        // field owns the keyboard while it has focus.
        if (forwardKey(event, field) && selectedNode !== field.getAttribute('data-cb-id')) {
          selectTarget(field);
        }
        return;
      }

      const scroller = doc.scrollingElement || doc.documentElement;
      let dy = 0;
      if (event.key === 'ArrowDown') dy = 40;
      else if (event.key === 'ArrowUp') dy = -40;
      else if (event.key === 'PageDown' || event.key === ' ') dy = Math.round(scroller.clientHeight * 0.8);
      else if (event.key === 'PageUp') dy = -Math.round(scroller.clientHeight * 0.8);
      else if (event.key === 'Home') dy = -scroller.scrollHeight;
      else if (event.key === 'End') dy = scroller.scrollHeight;
      if (!dy) return;
      event.preventDefault();
      markAgentScroll();
      scroller.scrollTop += dy;
      setScrollTarget(scroller, scroller.scrollTop, scroller.scrollLeft);
      queueScroll('', 0, dy);
    };

    // Menu paste (or Ctrl+V the browser handles itself) still has clipboard
    // data; read it before the mirror applies it locally.
    const onPaste = (event) => {
      const field = taggedNode(event.target);
      if (!field || !isEditable(event.target)) return;
      const text = event.clipboardData?.getData('text/plain') ?? '';
      if (!text) return;
      event.preventDefault();
      sendControl(field.getAttribute('data-cb-id'), 'paste', text);
    };

    window.addEventListener('resize', onResize);
    doc.addEventListener('click', onClick, true);
    doc.addEventListener('submit', onSubmit, true);
    doc.addEventListener('mousemove', onMouseMove, true);
    doc.addEventListener('scroll', onScroll, true);
    doc.addEventListener('wheel', onWheel, { passive: true, capture: true });
    doc.addEventListener('touchstart', onTouchStart, { passive: true, capture: true });
    doc.addEventListener('touchmove', onTouchMove, { passive: false, capture: true });
    doc.addEventListener('touchend', onTouchEnd, { passive: true, capture: true });
    doc.addEventListener('keydown', onKeyDown, true);
    doc.addEventListener('paste', onPaste, true);
    doc.addEventListener('change', onChange, true);
    doc.addEventListener('input', onInput, true);

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
      doc.removeEventListener('paste', onPaste, true);
      doc.removeEventListener('change', onChange, true);
      doc.removeEventListener('input', onInput, true);
      if (rangeTimer) clearTimeout(rangeTimer);
      rangeTimer = null;
      pendingRange.clear();
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
    if (!scroller) return;

    const step = Math.max(200, Math.round(scroller.clientHeight * 0.8));

    // Move the mirror immediately so the agent gets instant feedback, then
    // send the same delta to the customer. Replay echoes are ignored while
    // the gesture is active.
    agentScrollUntil = performance.now() + 600;
    scroller.scrollTop += step;
    setScrollTarget(scroller, scroller.scrollTop, scroller.scrollLeft);
    queueScroll('', 0, step);
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
