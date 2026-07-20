import { LitElement, css, html } from 'lit'

export const STATE = {
  IDLE: 'idle',
  CHECKING: 'checking',
  OK: 'ok',
  ERROR: 'error',
}

/**
 * True when a DSN string is complete enough to be worth a server round-trip:
 * a mysql:// URL with a host and a database name. Keeps us from probing on
 * every keystroke while the user is still typing.
 */
export function looksComplete(dsn) {
  if (!dsn) return false
  try {
    const u = new URL(dsn)
    return (
      u.protocol === 'mysql:' &&
      u.hostname.length > 0 &&
      u.pathname.replace(/^\//, '').length > 0
    )
  } catch {
    return false
  }
}

/**
 * <nt-dsn-status dsn="mysql://user:pass@host:3306/db">
 *
 * A live connectivity indicator for a MySQL DSN. When `dsn` changes it
 * debounces, asks the server (`endpoint`, default /nt/check-dsn) to actually
 * open a connection, and renders a green/red pill with the result. Emits a
 * `dsn-check` event ({ ok, dsn, error }) so a host page can react to it.
 */
export class DsnStatus extends LitElement {
  static properties = {
    dsn: { type: String },
    endpoint: { type: String },
    debounceMs: { type: Number, attribute: 'debounce-ms' },
    _state: { state: true },
    _message: { state: true },
  }

  static styles = css`
    :host {
      display: inline-flex;
      font: inherit;
    }
    .pill {
      display: inline-flex;
      align-items: center;
      gap: 0.35rem;
      padding: 0.1rem 0.5rem;
      border-radius: 999px;
      font-size: 0.8rem;
      line-height: 1.4;
      border: 1px solid transparent;
    }
    .idle {
      display: none;
    }
    .checking {
      color: #7a5c00;
      background: #fff6d6;
      border-color: #efd88a;
    }
    .ok {
      color: #0f5132;
      background: #d1e7dd;
      border-color: #a3cfbb;
    }
    .error {
      color: #842029;
      background: #f8d7da;
      border-color: #f1aeb5;
    }
    .dot {
      width: 0.5rem;
      height: 0.5rem;
      border-radius: 50%;
      background: currentColor;
    }
    .checking .dot {
      animation: pulse 1s ease-in-out infinite;
    }
    @keyframes pulse {
      0%,
      100% {
        opacity: 0.35;
      }
      50% {
        opacity: 1;
      }
    }
  `

  constructor() {
    super()
    this.dsn = ''
    this.endpoint = '/nt/check-dsn'
    this.debounceMs = 500
    this._state = STATE.IDLE
    this._message = ''
    this._timer = null
    this._controller = null
    // Resolves after the most recently scheduled check settles; tests await it.
    this._lastCheck = Promise.resolve()
  }

  willUpdate(changed) {
    if (changed.has('dsn')) this._schedule()
  }

  disconnectedCallback() {
    super.disconnectedCallback()
    clearTimeout(this._timer)
    this._controller?.abort()
  }

  _schedule() {
    clearTimeout(this._timer)
    this._controller?.abort()

    if (!looksComplete(this.dsn)) {
      this._state = STATE.IDLE
      this._message = ''
      return
    }

    this._state = STATE.CHECKING
    this._message = ''
    this._lastCheck = new Promise((resolve) => {
      this._timer = setTimeout(() => resolve(this.check()), this.debounceMs)
    })
  }

  /**
   * Probe the DSN immediately (bypassing the debounce) and update state.
   * Returns { ok, dsn, error } for callers/tests that want the result.
   */
  async check() {
    const dsn = this.dsn
    if (!looksComplete(dsn)) {
      this._state = STATE.IDLE
      return { ok: false, dsn }
    }

    this._controller = new AbortController()
    this._state = STATE.CHECKING

    let result
    try {
      const res = await fetch(`${this.endpoint}?dsn=${encodeURIComponent(dsn)}`, {
        signal: this._controller.signal,
      })
      const data = await res.json()
      result = { ok: !!data.ok, error: data.error, dsn }
    } catch (err) {
      if (err.name === 'AbortError') return { ok: false, aborted: true, dsn }
      result = { ok: false, error: err.message, dsn }
    }

    // Drop a stale response if the DSN changed while the request was in flight.
    if (dsn !== this.dsn) return result

    this._state = result.ok ? STATE.OK : STATE.ERROR
    this._message = result.ok ? 'Connected' : result.error || 'Connection failed'
    this.dispatchEvent(
      new CustomEvent('dsn-check', { detail: result, bubbles: true, composed: true }),
    )
    return result
  }

  render() {
    const label = {
      [STATE.CHECKING]: 'Checking…',
      [STATE.OK]: this._message || 'Connected',
      [STATE.ERROR]: this._message || 'Connection failed',
    }[this._state]

    return html`
      <span
        class="pill ${this._state}"
        role="status"
        aria-live="polite"
        title=${this._message}
      >
        <span class="dot"></span>${label}
      </span>
    `
  }
}

customElements.define('nt-dsn-status', DsnStatus)
