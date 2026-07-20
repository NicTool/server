import { html, nothing } from 'lit'
import { live } from 'lit/directives/live.js'

import { NtTableBase } from './table-base.js'

const SORT_COLUMNS = ['zone', 'description']

const FILTERS_OPEN_KEY = 'nt-zone-filters-open'
const readFiltersOpen = () => {
  try {
    return globalThis.localStorage?.getItem(FILTERS_OPEN_KEY) === '1'
  } catch {
    return false
  }
}
const writeFiltersOpen = (open) => {
  try {
    globalThis.localStorage?.setItem(FILTERS_OPEN_KEY, open ? '1' : '0')
  } catch {
    /* storage unavailable — non-fatal */
  }
}

/**
 * <nt-zone-table .gid=${gid} .token=${jwt}>
 *
 * Server-side paginated zone table (zones can number in the thousands per
 * group). Clicking a zone opens its records modal. "In zones" mode instead
 * searches zone records across every zone (e.g. all TXT records containing
 * "spf"). Emits: `zone-open-records`, `zone-create`, `zone-edit`,
 * `zone-add-record`, `subgroups-change`.
 */
export class ZoneTable extends NtTableBase {
  static properties = {
    gid: { attribute: false },
    includeSubgroups: { attribute: false },
    _filtersOpen: { state: true },
    _inZones: { state: true },
    _zvers: { state: true },
  }

  constructor() {
    super()
    this.gid = null
    this.includeSubgroups = false
    this._sortBy = 'zone'
    this._entityPath = '/zone'
    this._filtersOpen = readFiltersOpen()
    this._inZones = false
    this._recordsMode = false
    this._zoneCache = new Map()
    this._zvers = 0
  }

  willUpdate(changed) {
    if (changed.has('gid') || changed.has('includeSubgroups')) {
      this._page = 1
      this._load()
    }
  }

  get _term() {
    return this._search.trim()
  }

  async _load() {
    this._recordsMode = this._inZones && this._term !== ''
    this._loading = true
    this._error = ''
    try {
      if (this._recordsMode) {
        await this._loadRecords()
      } else {
        await this._loadZones()
      }
    } catch {
      this._error = this._recordsMode
        ? 'Failed to search records'
        : 'Failed to load zones'
      this._rows = []
    } finally {
      this._loading = false
    }
  }

  async _loadZones() {
    const params = new URLSearchParams()
    params.set('limit', `${this.pageSize}`)
    params.set('offset', `${Math.max(0, (this._page - 1) * this.pageSize)}`)
    if (this.gid) params.set('gid', `${this.gid}`)
    if (this._showDeleted) params.set('deleted', 'true')
    if (this.includeSubgroups) params.set('include_subgroups', 'true')
    if (this._term) params.set('search', this._term)
    if (SORT_COLUMNS.includes(this._sortBy)) {
      params.set('sort_by', this._sortBy)
      params.set('sort_dir', this._sortDir === 'desc' ? 'desc' : 'asc')
    }
    const data = await this._api(`/zone?${params.toString()}`)
    const pg = data?.meta?.pagination ?? {}
    this._rows = data?.zone ?? []
    this._total = pg.total ?? this._rows.length
    this._filtered = pg.filtered ?? this._rows.length
  }

  async _loadRecords() {
    const params = new URLSearchParams()
    params.set('limit', `${this.pageSize}`)
    params.set('offset', `${Math.max(0, (this._page - 1) * this.pageSize)}`)
    params.set('search', this._term)
    if (this._showDeleted) params.set('deleted', 'true')
    const data = await this._api(`/zone_record?${params.toString()}`)
    const pg = data?.meta?.pagination ?? {}
    this._rows = data?.zone_record ?? []
    this._total = pg.total ?? this._rows.length
    this._filtered = pg.filtered ?? this._rows.length
    await this._resolveZones(this._rows.map((r) => r.zid))
  }

  // Cross-zone record results carry only a zone id; look up the zone objects so
  // rows can show the fqdn and open the right records modal.
  async _resolveZones(zids) {
    const missing = [...new Set(zids)].filter((z) => z != null && !this._zoneCache.has(z))
    if (!missing.length) return
    await Promise.all(
      missing.map(async (zid) => {
        const res = await this._api(`/zone/${zid}`)
        const z = Array.isArray(res?.zone) ? res.zone[0] : res?.zone
        this._zoneCache.set(zid, z ?? null)
      }),
    )
    this._zvers++
  }

  _itemLabel(zone) {
    return `zone ${zone.zone}`
  }

  _confirmDeleteText(zone) {
    return `Delete zone ${zone.zone}? This hides it from default views.`
  }

  _toggleFilters() {
    this._filtersOpen = !this._filtersOpen
    writeFiltersOpen(this._filtersOpen)
  }

  _toggleSubgroups(e) {
    this.includeSubgroups = e.target.checked
    this._emit('subgroups-change', { value: this.includeSubgroups })
    // willUpdate reloads on the includeSubgroups change
  }

  _toggleInZones(e) {
    this._inZones = e.target.checked
    this._page = 1
    this._load()
  }

  render() {
    return html`
      <div class="d-flex align-items-center gap-2 mb-2 flex-wrap">
        <input
          type="search"
          class="form-control form-control-sm"
          style="max-width: 20rem"
          placeholder=${this._inZones ? 'Search records in all zones…' : 'Search zones…'}
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
        <button
          type="button"
          class="btn btn-sm btn-link text-body-secondary text-decoration-none nt-zone-filters-toggle"
          aria-expanded=${this._filtersOpen ? 'true' : 'false'}
          @click=${this._toggleFilters}
        >
          ${this._filtersOpen ? '▾' : '▸'} Filters
        </button>
        ${this._filtersOpen ? this._renderFilters() : nothing}
        <span class="ms-auto small text-body-secondary">${this._renderRangeLabel()}</span>
      </div>

      ${this._error ? html`<div class="alert alert-danger py-1 px-2 small">${this._error}</div>` : nothing}
      ${this._renderNotice()}
      ${this._recordsMode ? this._renderRecordsTable() : this._renderZonesTable()}
      ${this._renderPager()}
    `
  }

  _renderFilters() {
    return html`
      <div class="d-flex align-items-center gap-3 nt-zone-filters">
        <div class="form-check form-switch mb-0">
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
        <div class="form-check form-switch mb-0">
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
        <div class="form-check form-switch mb-0">
          <input
            class="form-check-input nt-in-zones"
            type="checkbox"
            role="switch"
            id="nt-zone-in-zones"
            .checked=${live(this._inZones)}
            @change=${this._toggleInZones}
          />
          <label
            class="form-check-label small text-body-secondary"
            for="nt-zone-in-zones"
            title="Search zone records across every zone"
          >
            In zones
          </label>
        </div>
      </div>
    `
  }

  _renderZonesTable() {
    return html`
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

  _renderRecordsTable() {
    return html`
      <table class="table table-sm table-striped table-hover align-middle mb-2">
        <thead>
          <tr>
            <th>Zone</th>
            <th>Name</th>
            <th style="width: 5rem">Type</th>
            <th>Value</th>
            <th class="text-end" style="width: 5rem">TTL</th>
          </tr>
        </thead>
        <tbody>
          ${this._rows.map((zr) => this._renderRecordRow(zr))}
          ${
            !this._loading && this._rows.length === 0
              ? html`<tr>
                  <td colspan="5" class="text-center text-body-secondary py-3">
                    No records match your search.
                  </td>
                </tr>`
              : nothing
          }
        </tbody>
      </table>
    `
  }

  _renderRecordRow(zr) {
    const zone = this._zoneCache.get(zr.zid)
    const zoneName = zone?.zone ?? `#${zr.zid}`
    const open = zone ? () => this._emit('zone-open-records', { zone }) : undefined
    return html`
      <tr class="zone-record-hit" data-zr-id=${zr.id}>
        <td
          class="zone-name-toggle text-truncate"
          style=${zone ? 'cursor: pointer; max-width: 16rem' : 'max-width: 16rem'}
          title=${zoneName}
          @click=${open}
        >
          ${zoneName}
        </td>
        <td>${zr.owner ?? ''}</td>
        <td>${zr.type ?? ''}</td>
        <td class="text-truncate" style="max-width: 24rem" title=${zr.address ?? ''}>
          ${zr.address ?? ''}
        </td>
        <td class="text-end">${zr.ttl ?? ''}</td>
      </tr>
    `
  }
}

customElements.define('nt-zone-table', ZoneTable)
