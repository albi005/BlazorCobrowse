// Cobrowse browser client for the tenant page.
//
// Owns the SignalR connection to CobrowseService, the rrweb capture loop, the
// on-page support banner, and the conversion of agent control messages into DOM
// events on this page. State is mirrored back to Blazor via a DotNetObjectReference
// so the in-page button stays in sync.
//
// Loaded with a dynamic `import()` from App.Cobrowse, so it is an ES module and
// resolves its static assets relative to its own URL.

import {
  BLOCK_CLASS,
  applyControl,
  clearControlFocus,
  createCapture,
  hideAgentCursor,
  showAgentCursor,
  startTagging,
  stopTagging
} from './cobrowse-capture.js';

const CAPABILITIES = ['rrweb-v1', 'control-v1', 'resnapshot-v1', 'batch-v1'];
const FLUSH_INTERVAL_MS = 60;
const MAX_BATCH_SIZE = 250;

let current = null;
let signalRLoading = null;

function loadSignalR() {
  if (window.signalR) return Promise.resolve();

  signalRLoading ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = new URL('../lib/signalr/signalr.min.js', import.meta.url).toString();
    script.async = false;
    script.onload = () => (window.signalR ? resolve() : reject(new Error('SignalR did not initialise')));
    script.onerror = () => reject(new Error('SignalR failed to load'));
    document.head.appendChild(script);
  });

  return signalRLoading;
}

function ensureBannerStyles() {
  const href = new URL('../css/cobrowse-banner.css', import.meta.url).toString();
  if (document.querySelector(`link[data-cobrowse-banner="${href}"]`)) return;

  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  link.dataset.cobrowseBanner = href;
  document.head.appendChild(link);
}

const END_MESSAGES = {
  'agent-ended': 'The agent ended the support session.',
  'customer-ended': 'You ended the support session.',
  'customer-cancelled': 'Support request cancelled.',
  'pagehide': 'The page was closed.',
  'expired': 'The support session timed out.',
  'replaced': 'Support was handed over to another tab.',
  'connection-lost': 'The connection to support was lost.',
  'circuit-disposed': 'The support session ended.'
};

class CobrowseSession {
  constructor(options, dotNetRef) {
    this.options = options;
    this.dotNetRef = dotNetRef;
    this.connection = null;
    this.capture = null;
    this.capturePending = null;
    this.buffer = [];
    this.flushTimer = null;
    this.seq = 0;
    this.state = 'creating';
    this.view = true;
    this.control = !!options.allowControl;
    this.agentName = null;
    this.agentOnline = false;
    this.message = null;
    this.isError = false;
    this.finished = false;
    this.banner = null;
    this.heartbeat = null;
    this.debugEvents = [];
    this.flushQueued = false;
    this.onPageHide = () => this.endFromPageHide();
    this.onVisibility = () => {
      if (document.hidden) this.flush();
    };
  }

  async start() {
    ensureBannerStyles();
    this.renderBanner();
    window.__cbCustomer = this;

    this.connection = new window.signalR.HubConnectionBuilder()
      .withUrl(this.options.hubUrl, { withCredentials: false })
      .withAutomaticReconnect([0, 1000, 3000, 6000, 12000, 30000])
      .configureLogging(window.signalR.LogLevel.Warning)
      .build();

    this.wire();
    await this.connection.start();
    await this.join();

    window.addEventListener('pagehide', this.onPageHide);
    document.addEventListener('visibilitychange', this.onVisibility);
    this.heartbeat = setInterval(() => {
      if (this.connection?.state === window.signalR.HubConnectionState.Connected) {
        this.connection.send('Ping').catch(() => { /* best effort */ });
      }
    }, 25000);
  }

  wire() {
    const connection = this.connection;

    connection.on('joined', (payload) => this.onJoined(payload));

    connection.on('agent-changed', (payload) => {
      this.agentOnline = !!payload.online;
      this.agentName = payload.displayName || this.agentName;
      // The request becomes active when an agent joins; the server sends this
      // event rather than a second `joined` message.
      if (this.agentOnline) this.state = 'active';
      else if (this.state === 'active') this.state = 'pending';

      // No agent, no controlled focus ring.
      if (!this.agentOnline) {
        clearControlFocus();
        hideAgentCursor();
      }

      this.renderBanner();
      this.push();
    });

    connection.on('consent-changed', (payload) => {
      this.view = !!payload.view;
      this.control = !!payload.control;
      if (this.view) this.ensureCapture();
      else this.pauseCapture();
      this.renderBanner();
      this.push();
    });

    connection.on('control', (payload) => {
      if (this.view && this.control) {
        applyControl(payload.nodeId, payload.action, payload.value);
      }
    });

    connection.on('cursor', (payload) =>
      showAgentCursor(payload.x, payload.y, payload.docX, payload.docY));
    connection.on('snapshot-request', () => this.capture?.takeSnapshot());

    connection.on('ended', (payload) => {
      const reason = payload?.reason || 'ended';
      this.finish(reason, END_MESSAGES[reason] ?? 'The support session ended.', false);
    });

    connection.onreconnecting(() => {
      this.state = 'reconnecting';
      this.renderBanner();
    });

    connection.onreconnected(async () => {
      this.state = 'active';
      try {
        await this.join();
        this.renderBanner();
      } catch (error) {
        console.warn('[cobrowse] rejoin failed', error);
      }
    });

    connection.onclose(() => {
      if (!this.finished) {
        this.finish('connection-lost', END_MESSAGES['connection-lost'], true);
      }
    });
  }

  async join() {
    await this.connection.invoke('JoinAsCustomer', {
      token: this.options.joinToken,
      protocol: this.options.protocol ?? 1,
      minProtocol: this.options.minProtocol ?? 1,
      capabilities: CAPABILITIES,
      client: this.options.client ?? 'App.Cobrowse'
    });
  }

  onJoined(payload) {
    this.state = payload.state === 'active' ? 'active' : 'pending';
    this.view = payload.consent?.view ?? true;
    this.control = payload.consent?.control ?? !!this.options.allowControl;
    this.agentOnline = !!payload.agentOnline;
    this.agentName = payload.agentName ?? null;
    if (this.view) this.ensureCapture();
    this.renderBanner();
    this.push();
  }

  ensureCapture() {
    if (this.capture || this.capturePending) return;
    if (this.finished) return;

    startTagging();
    this.capturePending = createCapture({
      maskPasswords: this.options.maskPasswords !== false,
      onEvent: (event) => this.queueEvent(event)
    })
      .then((capture) => {
        if (this.finished) {
          capture.stop();
          return;
        }
        this.capture = capture;
      })
      .catch((error) => {
        console.error('[cobrowse] capture failed', error);
        this.finish('capture-failed', 'Screen sharing could not start in this browser.', true);
      })
      .finally(() => {
        this.capturePending = null;
      });
  }

  pauseCapture() {
    clearControlFocus();
    this.buffer = [];
    clearTimeout(this.flushTimer);
    this.flushTimer = null;
    try {
      this.capture?.stop();
    } catch {
      // Already stopped.
    }
    this.capture = null;
  }

  queueEvent(event) {
    if (this.finished || !this.view) return;

    this.debugEvents.push(event);
    if (this.debugEvents.length > 20) this.debugEvents.shift();

    this.buffer.push(event);
    if (this.buffer.length >= MAX_BATCH_SIZE) {
      this.flush();
      return;
    }

    // Browsers throttle timers to ~1s in a hidden/occluded tab. Feedback then
    // stalls: the agent's click applies at once but the events that prove it
    // wait for the batcher. A microtask is not throttled, so flush there.
    if (document.hidden) {
      if (!this.flushQueued) {
        this.flushQueued = true;
        queueMicrotask(() => {
          this.flushQueued = false;
          this.flush();
        });
      }
      return;
    }

    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flush(), FLUSH_INTERVAL_MS);
    }
  }

  flush() {
    clearTimeout(this.flushTimer);
    this.flushTimer = null;

    if (!this.buffer.length) return;

    const events = this.buffer;
    this.buffer = [];

    if (this.connection?.state !== window.signalR.HubConnectionState.Connected) {
      // Dropped on purpose: the server notices the sequence gap and asks for a
      // fresh snapshot, which is cheaper than replaying a broken history.
      return;
    }

    this.seq += 1;
    this.connection.send('CustomerEvents', { seq: this.seq, events }).catch((error) => {
      console.warn('[cobrowse] event batch failed', error);
    });
  }

  async toggleControl() {
    if (!this.connection) return;
    try {
      await this.connection.invoke('SetConsent', { view: this.view, control: !this.control });
    } catch (error) {
      console.warn('[cobrowse] consent change failed', error);
    }
  }

  async end() {
    if (!this.connection) {
      this.finish('customer-ended', END_MESSAGES['customer-ended'], false);
      return;
    }
    try {
      await this.connection.invoke('EndSession', { reason: 'customer-ended' });
    } catch {
      this.finish('customer-ended', END_MESSAGES['customer-ended'], false);
    }
  }

  endFromPageHide() {
    try {
      this.connection?.send('EndSession', { reason: 'pagehide' });
    } catch {
      // The socket is already going away.
    }
    this.finish('pagehide', END_MESSAGES.pagehide, false, { notify: false });
  }

  finish(reason, message, isError, { notify = true } = {}) {
    if (this.finished) return;
    this.finished = true;
    this.isError = isError;
    this.message = message;
    this.state = isError ? 'error' : 'ended';

    clearInterval(this.heartbeat);
    clearTimeout(this.flushTimer);
    this.buffer = [];
    this.pauseCapture();
    stopTagging();
    hideAgentCursor();
    this.removeBanner();
    window.removeEventListener('pagehide', this.onPageHide);
    document.removeEventListener('visibilitychange', this.onVisibility);

    const connection = this.connection;
    this.connection = null;
    try {
      connection?.stop();
    } catch {
      // Already closed.
    }

    if (notify) this.push();
    if (current === this) current = null;
  }

  uiState() {
    if (this.state === 'error') return 'error';
    if (this.state === 'ended') return 'ended';
    if (this.state === 'active') return 'active';
    return 'pending';
  }

  push() {
    const payload = {
      state: this.uiState(),
      message: this.message,
      agent: this.agentName,
      view: this.view,
      control: this.control
    };
    try {
      this.dotNetRef?.invokeMethodAsync('OnStateChanged', payload).catch(() => { /* circuit gone */ });
    } catch {
      // Circuit gone.
    }
  }

  // ---- banner -----------------------------------------------------------

  renderBanner() {
    if (this.finished) return;

    if (!this.banner) this.banner = this.buildBanner();

    const title = this.banner.querySelector('.cbx-banner-title');
    const detail = this.banner.querySelector('.cbx-banner-detail');
    const dot = this.banner.querySelector('.cbx-banner-dot');
    const controlButton = this.banner.querySelector('[data-action="control"]');

    let detailText;
    if (this.state === 'reconnecting') detailText = 'Reconnecting to support…';
    else if (!this.view) detailText = 'Sharing paused';
    else if (this.agentOnline) {
      detailText = this.control
        ? `${this.agentName || 'An agent'} is connected · has control`
        : `${this.agentName || 'An agent'} is connected · view only`;
    } else detailText = 'Waiting for an agent…';

    if (title) title.textContent = 'Remote support';
    if (detail) detail.textContent = detailText;
    if (dot) dot.className = 'cbx-banner-dot ' + (this.agentOnline && this.view ? 'is-live' : 'is-waiting');

    if (controlButton) {
      const canToggle = this.options.allowControl && this.agentOnline && this.view;
      controlButton.hidden = !canToggle;
      controlButton.textContent = this.control ? 'Disable control' : 'Allow control';
    }
  }

  buildBanner() {
    const banner = document.createElement('div');
    banner.className = 'cbx-banner ' + BLOCK_CLASS;
    banner.setAttribute('role', 'status');

    const dot = document.createElement('span');
    dot.className = 'cbx-banner-dot is-waiting';

    const text = document.createElement('div');
    text.className = 'cbx-banner-text';

    const title = document.createElement('strong');
    title.className = 'cbx-banner-title';
    title.textContent = 'Remote support';

    const detail = document.createElement('span');
    detail.className = 'cbx-banner-detail';
    detail.textContent = 'Waiting for an agent…';

    text.append(title, detail);

    const control = document.createElement('button');
    control.type = 'button';
    control.dataset.action = 'control';
    control.textContent = 'Disable control';
    control.hidden = true;
    control.addEventListener('click', () => this.toggleControl());

    const end = document.createElement('button');
    end.type = 'button';
    end.dataset.action = 'end';
    end.textContent = 'End';
    end.addEventListener('click', () => this.end());

    banner.append(dot, text, control, end);
    document.body.appendChild(banner);
    return banner;
  }

  removeBanner() {
    this.banner?.remove();
    this.banner = null;
  }
}

/** Start (or replace) the browser-side session for this tab. */
export async function start(options, dotNetRef) {
  if (current) await stop('replaced');

  try {
    await loadSignalR();
  } catch (error) {
    console.error('[cobrowse] cannot load transport', error);
    try {
      await dotNetRef?.invokeMethodAsync('OnStateChanged', {
        state: 'error',
        message: 'The support widget could not load in this browser.',
        view: false,
        control: false
      });
    } catch {
      // Circuit gone.
    }
    return;
  }

  current = new CobrowseSession(options, dotNetRef);

  try {
    await current.start();
  } catch (error) {
    console.error('[cobrowse] session failed to start', error);
    const failed = current;
    current = null;
    failed.finish('connection-lost', 'Could not connect to the support service.', true);
  }
}

/** Stop the session from the server side (customer pressed the in-page button). */
export async function stop(reason = 'customer-ended') {
  const session = current;
  current = null;
  if (!session) return;
  session.finish(reason, END_MESSAGES[reason] ?? 'The support session ended.', false);
}
