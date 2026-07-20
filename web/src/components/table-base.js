import { LitElement, html, nothing } from 'lit'

import { toggleSort } from '../lib/table-client.js'
import {
  clampPage,
  DEFAULT_PAGE_SIZE,
  pageCount,
  rangeLabel,
} from '../lib/zone-records-query.js'

/**
 * Shared behavior for the NicTool object tables (zones, zone records,
 * nameservers, users). Renders into light DOM so the app's Bootstrap styles
 * apply, and centralizes the authed fetch, sort/search/deleted toggles, the
 * server-side pager, and the soft-delete → undo-toast → restore flow.
 *
 * Subclasses provide:
 *   _entityPath        the REST collection, e.g. '/nameserver'
 *   async _load()      fetch and populate `_rows` (+ `_total`/`_filtered`)
 *   render()           the table markup
 *   _itemLabel(item)   short label for toasts/confirms (override)
 *   _confirmDeleteText(item)  optional; defaults to `Delete <label>?`
 */
export class NtTableBase extends LitElement {
  static properties = {
    token: { attribute: false },
    apiBase: { attribute: 'api-base' },
    confirmDeletes: { attribute: false },
    pageSize: { attribute: 'page-size', type: Number },
    _rows: { state: true },
    _total: { state: true },
    _filtered: { state: true },
    _page: { state: true },
    _search: { state: true },
    _sortBy: { state: true },
    _sortDir: { state: true },
    _showDeleted: { state: true },
    _loading: { state: true },
    _error: { state: true },
    _deletingId: { state: true },
    _notice: { state: true },
  }

  // Light DOM: inherit the app's Bootstrap/theme styles.
  createRenderRoot() {
    return this
  }

  constructor() {
    super()
    this.token = null
    this.apiBase = '/api'
    this.confirmDeletes = false
    this.pageSize = DEFAULT_PAGE_SIZE
    this._rows = []
    this._total = 0
    this._filtered = 0
    this._page = 1
    this._search = ''
    this._sortBy = ''
    this._sortDir = 'asc'
    this._showDeleted = false
    this._loading = false
    this._error = ''
    this._deletingId = null
    this._notice = null
    this._searchTimer = null
    this._noticeTimer = null
  }

  disconnectedCallback() {
    super.disconnectedCallback()
    clearTimeout(this._searchTimer)
    clearTimeout(this._noticeTimer)
  }

  /** Public: refetch the current page (the app calls this after edit/create). */
  refresh() {
    return this._load()
  }

  // --- data ---------------------------------------------------------------

  async _api(path, opts = {}) {
    const res = await fetch(`${this.apiBase}${path}`, {
      ...opts,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        ...opts.headers,
      },
    })
    return res.json()
  }

  _emit(name, detail) {
    this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true }))
  }

  // --- toolbar interactions ----------------------------------------------

  _onSearchInput(e) {
    const value = e.target.value
    clearTimeout(this._searchTimer)
    this._searchTimer = setTimeout(() => {
      this._search = value
      this._page = 1
      this._load()
    }, 300)
  }

  _sortByColumn(column) {
    const next = toggleSort({ sortBy: this._sortBy, sortDir: this._sortDir }, column)
    this._sortBy = next.sortBy
    this._sortDir = next.sortDir
    this._page = 1
    this._load()
  }

  _toggleShowDeleted(e) {
    this._showDeleted = e.target.checked
    this._page = 1
    this._dismissNotice()
    this._load()
  }

  _goToPage(page) {
    const next = clampPage(page, this._filtered, this.pageSize)
    if (next === this._page) return
    this._page = next
    this._load()
  }

  // --- soft-delete / restore / undo --------------------------------------

  _itemLabel(item) {
    return `${item.id}`
  }

  _confirmDeleteText(item) {
    return `Delete ${this._itemLabel(item)}?`
  }

  _stepBackIfLast() {
    if (this._rows.length === 1 && this._page > 1) this._page -= 1
  }

  async _deleteRecord(item) {
    if (this.confirmDeletes && !window.confirm(this._confirmDeleteText(item))) return
    this._deletingId = item.id
    try {
      const res = await this._api(`${this._entityPath}/${item.id}`, { method: 'DELETE' })
      if (res?.error) throw new Error(res.message ?? 'delete failed')
      // Drop the row in place so it collapses smoothly, instead of refetching
      // the page (which reflows the table and flashes in a replacement row).
      this._rows = this._rows.filter((r) => r.id !== item.id)
      this._filtered = Math.max(0, this._filtered - 1)
      this._total = Math.max(0, this._total - 1)
      if (this._rows.length === 0 && this._page > 1) {
        this._page -= 1
        await this._load()
      }
      this._showNotice(`Deleted ${this._itemLabel(item)}`, item)
    } catch {
      this._error = 'Delete failed'
    } finally {
      this._deletingId = null
    }
  }

  async _undoDelete(item) {
    this._dismissNotice()
    await this._restore(item)
  }

  async _restoreRecord(item) {
    if (await this._restore(item))
      this._showNotice(`Restored ${this._itemLabel(item)}`, null)
  }

  async _restore(item) {
    try {
      const res = await this._api(`${this._entityPath}/${item.id}`, {
        method: 'PUT',
        body: JSON.stringify({ deleted: false }),
      })
      if (res?.error) throw new Error(res.message ?? 'restore failed')
      this._stepBackIfLast()
      await this._load()
      return true
    } catch {
      this._error = 'Restore failed'
      return false
    }
  }

  // --- notice / toast -----------------------------------------------------

  _showNotice(text, item) {
    clearTimeout(this._noticeTimer)
    this._notice = { text, item }
    this._noticeTimer = setTimeout(() => this._dismissNotice(), 6000)
    this._noticeTimer?.unref?.() // don't hold the process open under node/tests
  }

  _dismissNotice() {
    clearTimeout(this._noticeTimer)
    this._notice = null
  }

  // --- shared render pieces ----------------------------------------------

  _sortableTh(label, column, align = '') {
    const active = this._sortBy === column
    const arrow = active ? (this._sortDir === 'asc' ? '▲' : '▼') : ''
    return html`
      <th
        class=${align}
        role="button"
        aria-sort=${active ? (this._sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
        @click=${() => this._sortByColumn(column)}
        style="cursor: pointer; user-select: none"
      >
        ${label} <span class="text-body-tertiary">${arrow}</span>
      </th>
    `
  }

  _renderRangeLabel() {
    if (this._loading) return 'Loading…'
    const label = rangeLabel({
      page: this._page,
      pageSize: this.pageSize,
      filtered: this._filtered,
    })
    if (this._filtered < this._total) {
      const total = this._total.toLocaleString('en-US')
      return html`${label}<span
          class="d-block text-body-tertiary"
          style="font-size: 0.78em"
          >(filtered from ${total} total entries)</span
        >`
    }
    return label
  }

  _renderPager() {
    const pages = pageCount(this._filtered, this.pageSize)
    if (pages <= 1) return nothing
    return html`
      <nav class="d-flex align-items-center gap-2 justify-content-end">
        <button
          type="button"
          class="btn btn-sm btn-outline-secondary"
          ?disabled=${this._page <= 1 || this._loading}
          @click=${() => this._goToPage(this._page - 1)}
        >
          ‹ Prev
        </button>
        <span class="small text-body-secondary">Page ${this._page} of ${pages}</span>
        <button
          type="button"
          class="btn btn-sm btn-outline-secondary"
          ?disabled=${this._page >= pages || this._loading}
          @click=${() => this._goToPage(this._page + 1)}
        >
          Next ›
        </button>
      </nav>
    `
  }

  _renderNotice() {
    if (!this._notice) return nothing
    const { text, item } = this._notice
    return html`
      <div
        class="position-fixed bottom-0 end-0 p-3"
        style="z-index: 1090"
        role="status"
        aria-live="polite"
      >
        <div class="toast show align-items-center border-0 shadow">
          <div class="d-flex">
            <div class="toast-body">${text}</div>
            ${
              item
                ? html`<button
                    type="button"
                    class="btn btn-sm btn-link text-decoration-none nt-undo-btn"
                    @click=${() => this._undoDelete(item)}
                  >
                    Undo
                  </button>`
                : nothing
            }
            <button
              type="button"
              class="btn-close me-2 m-auto"
              aria-label="Dismiss"
              @click=${() => this._dismissNotice()}
            ></button>
          </div>
        </div>
      </div>
    `
  }
}
