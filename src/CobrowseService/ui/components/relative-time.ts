// Live relative-time label, e.g. "accepted 0m 38s ago". Renders into light DOM
// so it inherits the surrounding typography.
import {html, LitElement} from 'lit';
import {customElement, property} from 'lit/decorators.js';

declare global {
  interface HTMLElementTagNameMap {
    'cb-relative-time': CbRelativeTime;
  }
}

const live = new Set<CbRelativeTime>();
let ticker: ReturnType<typeof setInterval> | null = null;

function startTicker() {
  if (ticker) return;
  ticker = setInterval(() => {
    for (const element of live) element.requestUpdate();
  }, 1000);
}

@customElement('cb-relative-time')
export class CbRelativeTime extends LitElement {
  /** ISO-8601 timestamp. */
  @property()
  since = '';

  protected createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    live.add(this);
    startTicker();
  }

  disconnectedCallback() {
    live.delete(this);
    if (live.size === 0) {
      clearInterval(ticker!);
      ticker = null;
    }
    super.disconnectedCallback();
  }

  protected render() {
    return html`${formatAge(this.since)}`;
  }
}

function formatAge(since: string) {
  const started = Date.parse(since);
  if (!Number.isFinite(started)) return '—';

  let seconds = Math.max(0, Math.floor((Date.now() - started) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  if (hours >= 1) return `${hours}h ${minutes}m`;

  seconds %= 60;
  return `${minutes}m ${seconds}s`;
}
