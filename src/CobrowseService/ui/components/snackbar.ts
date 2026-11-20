// Material-style snackbar for errors and session notices.
import {css, html, LitElement} from 'lit';
import {customElement, property, state} from 'lit/decorators.js';

declare global {
  interface HTMLElementTagNameMap {
    'cb-snackbar': CbSnackbar;
  }
}

@customElement('cb-snackbar')
export class CbSnackbar extends LitElement {
  @property()
  message = '';

  @property()
  tone: 'info' | 'error' = 'info';

  /** Change this to show the same message again. */
  @property({type: Number})
  stamp = 0;

  @state()
  private open = false;

  private timer: ReturnType<typeof setTimeout> | null = null;

  static styles = css`
    :host {
      position: fixed;
      left: 0;
      right: 0;
      bottom: 1rem;
      z-index: 1000;
      display: flex;
      justify-content: center;
      padding: 0 1rem;
      pointer-events: none;
    }

    .surface {
      pointer-events: auto;
      display: flex;
      align-items: center;
      gap: .75rem;
      max-width: min(560px, 100%);
      padding: .7rem .7rem .7rem 1rem;
      border-radius: 8px;
      background: var(--md-sys-color-inverse-surface);
      color: var(--md-sys-color-inverse-on-surface);
      box-shadow: 0 3px 8px rgba(0, 0, 0, .28);
      font: 500 .86rem/1.4 var(--md-ref-typeface-plain);
      opacity: 0;
      visibility: hidden;
      transform: translateY(12px);
      transition: opacity .18s ease, transform .18s ease, visibility .18s;
    }

    .surface.open {
      opacity: 1;
      visibility: visible;
      transform: none;
    }

    .surface.error {
      background: var(--md-sys-color-error-container);
      color: var(--md-sys-color-on-error-container);
    }

    .text { min-width: 0; }

    button {
      flex: 0 0 auto;
      border: 0;
      border-radius: 4px;
      padding: .35rem .5rem;
      background: transparent;
      color: inherit;
      font: inherit;
      font-weight: 600;
      cursor: pointer;
    }

    button:hover {
      background: color-mix(in srgb, currentColor 12%, transparent);
    }
  `;

  protected updated(changed: Map<string, unknown>) {
    if (changed.has('stamp') && this.message) this.show();
  }

  disconnectedCallback() {
    clearTimeout(this.timer!);
    this.timer = null;
    super.disconnectedCallback();
  }

  private show() {
    this.open = true;
    clearTimeout(this.timer!);
    this.timer = setTimeout(() => {
      this.open = false;
    }, 5000);
  }

  private dismiss() {
    this.open = false;
    clearTimeout(this.timer!);
    this.timer = null;
  }

  protected render() {
    return html`
      <div class="surface ${this.open ? 'open' : ''} ${this.tone}" role="status" aria-live="polite">
        <span class="text">${this.message}</span>
        <button type="button" @click=${() => this.dismiss()}>Dismiss</button>
      </div>
    `;
  }
}
