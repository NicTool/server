import { html, nothing } from 'lit'
import { live } from 'lit/directives/live.js'

import { NtTableBase } from './table-base.js'

const SORT_COLUMNS = ['zone', 'description']

/**
 * <nt-zone-table .gid=${gid} .token=${jwt}>
 *
 * Server-side paginated zone table (zones can number in the thousands per
 * group). Clicking a zone opens its records modal. Emits: `zone-open-records`,
 * `zone-create`, `zone-edit`, `zone-add-record`, `subgroups-change`.
 */
export class ZoneTable extends NtTableBase {
  static properties = {
    gid: { attribute: false },
    includeSubgroups: { attribute: false },
  }

  constructor() {
    super()
    this.gid = null
    this.includeSubgroups = false
    this._sortBy = 'zone'
    this._entityPath = '/zone'
  }

  willUpdate(changed) {
    if (changed.has('gid') || changed.has('includeSubgroups')) {
      this._page = 1
      this._load()
    }
  }

  async _load() {
    this._loading = true
    this._error = ''
    try {
      const params = new URLSearchParams()
      params.set('limit', `${this.pageSize}`)
      params.set('offset', `${Math.max(0, (this._page - 1) * this.pageSize)}`)
      if (this.gid) params.set('gid', `${this.gid}`)
      if (this._showDeleted) params.set('deleted', 'true')
      if (this.includeSubgroups) params.set('include_subgroups', 'true')
      const term = this._search.trim()
      if (term) params.set('search', term)
      if (SORT_COLUMNS.includes(this._sortBy)) {
        params.set('sort_by', this._sortBy)
        params.set('sort_dir', this._sortDir === 'desc' ? 'desc' : 'asc')
      }
      const data = await this._api(`/zone?${params.toString()}`)
      const pg = data?.meta?.pagination ?? {}
      this._rows = data?.zone ?? []
      this._total = pg.total ?? this._rows.length
      this._filtered = pg.filtered ?? this._rows.length
    } catch {
      this._error = 'Failed to load zones'
      this._rows = []
    } finally {
      this._loading = false
    }
  }

  _itemLabel(zone) {
    return `zone ${zone.zone}`
  }

  _confirmDeleteText(zone) {
    return `Delete zone ${zone.zone}? This hides it from default views.`
  }

  _toggleSubgroups(e) {
    this.includeSubgroups = e.target.checked
    this._emit('subgroups-change', { value: this.includeSubgroups })
    // willUpdate reloads on the includeSubgroups change
  }

  render() {
    return html`
      <div class="d-flex align-items-center gap-2 mb-2">
        <input
          type="search"
          class="form-control form-control-sm"
          style="max-width: 20rem"
          placeholder="Search zones…"
          .value=${live(this._search)}
          @input=${this._onSearchInput}
        />
        <button
          type="button"
          class="btn btn-sm btn-outline-secondary"
          @click=${() => this._emit('zone-create', {})}
        >
          + Create
        </button>
        <div class="form-check form-switch mb-0 ms-1">
          <input
            class="form-check-input nt-subgroups"
            type="checkbox"
            role="switch"
            id="nt-zone-subgroups"
            .checked=${live(this.includeSubgroups)}
            @change=${this._toggleSubgroups}
          />
          <label
            class="form-check-label small text-body-secondary"
            for="nt-zone-subgroups"
          >
            Subgroups
          </label>
        </div>
        <div class="form-check form-switch mb-0 ms-1">
          <input
            class="form-check-input nt-show-deleted"
            type="checkbox"
            role="switch"
            id="nt-zone-show-deleted"
            .checked=${live(this._showDeleted)}
            @change=${this._toggleShowDeleted}
          />
          <label
            class="form-check-label small text-body-secondary"
            for="nt-zone-show-deleted"
          >
            Deleted
          </label>
        </div>
        <span class="ms-auto small text-body-secondary">${this._renderRangeLabel()}</span>
      </div>

      ${this._error ? html`<div class="alert alert-danger py-1 px-2 small">${this._error}</div>` : nothing}
      ${this._renderNotice()}

      <table class="table table-sm table-striped table-hover align-middle mb-2">
        <thead>
          <tr>
            <th style="width: 2rem"></th>
            ${this._sortableTh('Zone', 'zone')}
            ${this._sortableTh('Description', 'description')}
            <th class="text-center" style="width: 6rem">Actions</th>
          </tr>
        </thead>
        <tbody>
          ${this._rows.map((zone) => this._renderRow(zone))}
          ${
            !this._loading && this._rows.length === 0
              ? html`<tr>
                  <td colspan="4" class="text-center text-body-secondary py-3">
                    ${this._search ? 'No zones match your search.' : 'No zones.'}
                  </td>
                </tr>`
              : nothing
          }
        </tbody>
      </table>

      ${this._renderPager()}
    `
  }

  _renderRow(zone) {
    const deleted = zone.deleted === true
    const openRecords = () => this._emit('zone-open-records', { zone })
    return html`
      <tr
        class="zone-row ${deleted ? 'text-body-secondary' : ''} ${this._deletingId === zone.id ? 'opacity-50' : ''}"
        data-zone-id=${zone.id}
      >
        <td
          class="text-center zone-disclosure"
          title="View zone records"
          style=${deleted ? '' : 'cursor: pointer'}
          @click=${deleted ? undefined : openRecords}
        >
          <span class="text-body-tertiary" aria-hidden="true">▸</span>
        </td>
        <td
          class="zone-name-toggle"
          style=${deleted ? '' : 'cursor: pointer'}
          @click=${deleted ? undefined : openRecords}
        >
          ${zone.zone ?? ''}
        </td>
        <td>${zone.description ?? ''}</td>
        <td class="text-center text-nowrap">
          ${
            deleted
              ? html`<button
                  type="button"
                  class="btn btn-sm btn-link text-success p-0 zone-restore-btn"
                  title="Restore zone"
                  @click=${() => this._restoreRecord(zone)}
                >
                  ↩ Restore
                </button>`
              : html`<button
                    type="button"
                    class="btn btn-sm btn-link text-body-secondary p-0 me-2 zone-add-zr-btn"
                    title="Add resource record"
                    @click=${() => this._emit('zone-add-record', { zone })}
                  >
                    +
                  </button>
                  <button
                    type="button"
                    class="btn btn-sm btn-link text-body-secondary p-0 me-2 zone-edit-btn"
                    title="Edit zone"
                    @click=${() => this._emit('zone-edit', { zone })}
                  >
                    ✎
                  </button>
                  <button
                    type="button"
                    class="btn btn-sm btn-link text-body-secondary p-0 zone-delete-btn"
                    title="Delete zone"
                    ?disabled=${this._deletingId === zone.id}
                    @click=${() => this._deleteRecord(zone)}
                  >
                    🗑
                  </button>`
          }
        </td>
      </tr>
    `
  }
}

customElements.define('nt-zone-table', ZoneTable)
