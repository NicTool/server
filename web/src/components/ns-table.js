import { html, nothing } from 'lit'
import { live } from 'lit/directives/live.js'

import { NtTableBase } from './table-base.js'
import { filterRows, sortRows } from '../lib/table-client.js'

const FIELDS = ['name', 'description', 'address', 'address6', 'export.type']

/**
 * <nt-ns-table .gid=${gid} .token=${jwt}>
 *
 * Client-side sortable/searchable nameserver table (the set is small, so no
 * server pagination). Emits `ns-edit` / `ns-create` for the app's offcanvas pane.
 */
export class NsTable extends NtTableBase {
  static properties = {
    gid: { attribute: false },
  }

  constructor() {
    super()
    this.gid = null
    this._sortBy = 'name'
    this._entityPath = '/nameserver'
  }

  willUpdate(changed) {
    if (changed.has('gid')) this._load()
  }

  async _load() {
    this._loading = true
    this._error = ''
    try {
      const params = new URLSearchParams()
      if (this.gid) params.set('gid', `${this.gid}`)
      if (this._showDeleted) params.set('deleted', 'true')
      const data = await this._api(`/nameserver?${params.toString()}`)
      this._rows = data?.nameserver ?? []
    } catch {
      this._error = 'Failed to load nameservers'
      this._rows = []
    } finally {
      this._loading = false
    }
  }

  _itemLabel(ns) {
    return ns.name
  }

  _confirmDeleteText(ns) {
    return `Delete nameserver ${ns.name}?`
  }

  _onRowClick(e, ns) {
    if (e.target.closest('button')) return
    this._emit('ns-edit', { ns })
  }

  render() {
    const view = sortRows(
      filterRows(this._rows, this._search, FIELDS),
      this._sortBy,
      this._sortDir,
    )
    return html`
      <div class="d-flex align-items-center gap-2 mb-2">
        <input
          type="search"
          class="form-control form-control-sm"
          style="max-width: 20rem"
          placeholder="Search nameservers…"
          .value=${live(this._search)}
          @input=${(e) => (this._search = e.target.value)}
        />
        <button
          type="button"
          class="btn btn-sm btn-outline-secondary"
          @click=${() => this._emit('ns-create', {})}
        >
          + Create
        </button>
        <div class="form-check form-switch mb-0 ms-1">
          <input
            class="form-check-input nt-show-deleted"
            type="checkbox"
            role="switch"
            id="nt-ns-show-deleted"
            .checked=${live(this._showDeleted)}
            @change=${this._toggleShowDeleted}
          />
          <label
            class="form-check-label small text-body-secondary"
            for="nt-ns-show-deleted"
          >
            Deleted
          </label>
        </div>
        <span class="ms-auto small text-body-secondary">
          ${this._loading ? 'Loading…' : `${view.length} nameserver${view.length === 1 ? '' : 's'}`}
        </span>
      </div>

      ${this._error ? html`<div class="alert alert-danger py-1 px-2 small">${this._error}</div>` : nothing}
      ${this._renderNotice()}

      <table class="table table-sm table-striped table-hover align-middle mb-0">
        <thead>
          <tr>
            ${this._sortableTh('Name', 'name')}
            ${this._sortableTh('Description', 'description')}
            ${this._sortableTh('IPv4', 'address', 'text-end')}
            ${this._sortableTh('IPv6', 'address6', 'text-end')}
            ${this._sortableTh('Format', 'export.type', 'text-center')}
            <th class="text-center" style="width: 5rem">Actions</th>
          </tr>
        </thead>
        <tbody>
          ${view.map((ns) => this._renderRow(ns))}
          ${
            !this._loading && view.length === 0
              ? html`<tr>
                  <td colspan="6" class="text-center text-body-secondary py-3">
                    ${this._search ? 'No nameservers match your search.' : 'No nameservers.'}
                  </td>
                </tr>`
              : nothing
          }
        </tbody>
      </table>
    `
  }

  _renderRow(ns) {
    const deleted = ns.deleted === true
    const missingDot = ns.name && !ns.name.endsWith('.')
    return html`
      <tr
        class="ns-row ${deleted ? 'text-body-secondary' : ''} ${this._deletingId === ns.id ? 'opacity-50' : ''}"
        data-ns-id=${ns.id}
        style=${deleted ? '' : 'cursor: pointer'}
        @click=${deleted ? undefined : (e) => this._onRowClick(e, ns)}
      >
        <td>
          ${ns.name ?? ''}${
            missingDot
              ? html`<span
                  class="badge text-bg-warning ms-1"
                  title="Name is missing a trailing dot"
                  >!</span
                >`
              : nothing
          }
        </td>
        <td>${ns.description ?? ''}</td>
        <td class="text-end">${ns.address ?? ''}</td>
        <td class="text-end">${ns.address6 ?? ''}</td>
        <td class="text-center">${ns.export?.type ?? ''}</td>
        <td class="text-center text-nowrap">
          ${
            deleted
              ? html`<button
                  type="button"
                  class="btn btn-sm btn-link text-success p-0 ns-restore-btn"
                  title="Restore nameserver"
                  @click=${() => this._restoreRecord(ns)}
                >
                  ↩ Restore
                </button>`
              : html`<button
                    type="button"
                    class="btn btn-sm btn-link text-body-secondary p-0 me-2 ns-edit-btn"
                    title="Edit nameserver"
                    @click=${() => this._emit('ns-edit', { ns })}
                  >
                    ✎
                  </button>
                  <button
                    type="button"
                    class="btn btn-sm btn-link text-body-secondary p-0 ns-delete-btn"
                    title="Delete nameserver"
                    ?disabled=${this._deletingId === ns.id}
                    @click=${() => this._deleteRecord(ns)}
                  >
                    🗑
                  </button>`
          }
        </td>
      </tr>
    `
  }
}

customElements.define('nt-ns-table', NsTable)
