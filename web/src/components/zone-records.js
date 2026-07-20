import { html, nothing } from 'lit'
import { live } from 'lit/directives/live.js'
import * as RR from '@nictool/dns-resource-record'

import { NtTableBase } from './table-base.js'
import { formatZoneRecordTtl, getRdataPreview } from '../lib/format.js'
import { syntheticOwnerDisplay, unqualifyHost } from '../lib/zone-name.js'
import { buildZoneRecordQuery } from '../lib/zone-records-query.js'

const fqdn = (name) => (`${name}`.endsWith('.') ? `${name}` : `${name}.`)

function ownerForZone(owner, zoneFqdn) {
  if (owner === zoneFqdn) return owner
  return owner.endsWith(zoneFqdn) ? owner : `${owner}.${zoneFqdn}`
}

/**
 * <nt-zone-records .zone=${zone} .token=${jwt}>
 *
 * Server-side paginated records table for one zone. Renders the zone's SOA and
 * NS as synthetic (read-only) rows above the editable records, and computes each
 * record's presentation rdata via dns-resource-record. Emits `zr-edit` /
 * `zr-create` for the shared edit modal.
 */
export class ZoneRecords extends NtTableBase {
  static properties = {
    zone: { attribute: false },
    _nsRows: { state: true },
  }

  constructor() {
    super()
    this.zone = null
    this._nsRows = []
    this._sortBy = 'owner'
    this._entityPath = '/zone_record'
  }

  willUpdate(changed) {
    if (changed.has('zone') && this.zone) {
      clearTimeout(this._noticeTimer)
      this._reset()
      this._loadNs()
      this._load()
    }
  }

  updated(changed) {
    if (changed.has('zone') && this.zone) {
      this.querySelector('input[type="search"]')?.focus()
    }
  }

  _reset() {
    this._rows = []
    this._nsRows = []
    this._total = 0
    this._filtered = 0
    this._page = 1
    this._search = ''
    this._sortBy = 'owner'
    this._sortDir = 'asc'
    this._showDeleted = false
    this._error = ''
    this._deletingId = null
    this._notice = null
  }

  async _load() {
    if (!this.zone) return
    this._loading = true
    this._error = ''
    try {
      const qs = buildZoneRecordQuery({
        zid: this.zone.id,
        page: this._page,
        pageSize: this.pageSize,
        search: this._search,
        sortBy: this._sortBy,
        sortDir: this._sortDir,
        deleted: this._showDeleted,
      })
      const data = await this._api(`/zone_record?${qs}`)
      const pg = data?.meta?.pagination ?? {}
      this._rows = (data?.zone_record ?? []).map((zr) => this._decorate(zr))
      this._total = pg.total ?? this._rows.length
      this._filtered = pg.filtered ?? this._rows.length
    } catch {
      this._error = 'Failed to load records'
      this._rows = []
    } finally {
      this._loading = false
    }
  }

  async _loadNs() {
    try {
      const data = await this._api(`/zone/${this.zone.id}/ns`)
      this._nsRows = data?.ns ?? []
    } catch {
      this._nsRows = []
    }
  }

  _decorate(zr) {
    const zoneFqdn = fqdn(this.zone.zone)
    let rdata = ''
    try {
      const owner = ownerForZone(zr.owner, zoneFqdn)
      const asRR = new RR[zr.type]({ ...zr, owner, type: zr.type })
      rdata = asRR
        .getRdataFields()
        .map((f) =>
          zr.type === 'AAAA' && f === 'address' ? asRR.getCompressed() : asRR.get(f),
        )
        .join(' ')
    } catch {
      /* unparseable record — leave rdata blank */
    }
    return { ...zr, _rdata: rdata }
  }

  _itemLabel(zr) {
    return `${zr.owner} ${zr.type}`
  }

  _onRowClick(e, zr) {
    if (e.target.closest('button')) return
    this._emit('zr-edit', { zone: this.zone, zr })
  }

  // --- render -------------------------------------------------------------

  render() {
    if (!this.zone) return nothing
    const hasDescriptions = this._rows.some((r) => r.description)
    const showSynthetic = this._page === 1 && !this._search && !this._showDeleted
    const cols = 5 + (hasDescriptions ? 1 : 0)

    return html`
      <div class="d-flex align-items-center gap-2 mb-2 zone-records-toolbar">
        <input
          type="search"
          class="form-control form-control-sm"
          style="max-width: 20rem"
          placeholder="Search owner or data…"
          .value=${live(this._search)}
          @input=${this._onSearchInput}
        />
        <button
          type="button"
          class="btn btn-sm btn-outline-secondary"
          @click=${() => this._emit('zr-create', { zone: this.zone })}
        >
          + Add record
        </button>
        <div class="form-check form-switch mb-0 ms-1">
          <input
            class="form-check-input nt-show-deleted"
            type="checkbox"
            role="switch"
            id="nt-show-deleted"
            .checked=${live(this._showDeleted)}
            @change=${this._toggleShowDeleted}
          />
          <label class="form-check-label small text-body-secondary" for="nt-show-deleted">
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
            ${this._sortableTh('Owner', 'owner')} ${this._sortableTh('Type', 'type')}
            <th>Data</th>
            ${this._sortableTh('TTL', 'ttl')}
            ${hasDescriptions ? html`<th>Description</th>` : nothing}
            <th class="text-center" style="width: 5rem">Actions</th>
          </tr>
        </thead>
        <tbody>
          ${showSynthetic ? this._renderSoaRow(hasDescriptions) : nothing}
          ${showSynthetic ? this._nsRows.map((ns) => this._renderNsRow(ns, hasDescriptions)) : nothing}
          ${this._rows.map((zr) => this._renderRecordRow(zr, hasDescriptions))}
          ${
            !this._loading && this._rows.length === 0
              ? html`<tr>
                  <td colspan=${cols} class="text-center text-body-secondary py-3">
                    ${this._search ? 'No records match your search.' : 'No records.'}
                  </td>
                </tr>`
              : nothing
          }
        </tbody>
      </table>

      ${this._renderPager()}
    `
  }

  _renderSoaRow(hasDescriptions) {
    const z = this.zone
    const zoneFqdn = fqdn(z.zone)
    const mname =
      Array.isArray(z.nameservers) && z.nameservers.length
        ? fqdn(z.nameservers[0])
        : `ns1.${zoneFqdn}`
    const rname = z.mailaddr ? fqdn(z.mailaddr) : `hostmaster.${zoneFqdn}`
    const rdata = `${unqualifyHost(mname, zoneFqdn)} ${unqualifyHost(rname, zoneFqdn)} ${z.serial ?? 0} ${z.refresh ?? 86400} ${z.retry ?? 7200} ${z.expire ?? 1209600} ${z.minimum ?? 3600}`
    return html`
      <tr class="zone-record-soa small text-muted">
        <td>@</td>
        <td>SOA</td>
        <td class="text-truncate" style="max-width: 24rem" title=${rdata}>${rdata}</td>
        <td>${formatZoneRecordTtl(z.ttl)}</td>
        ${hasDescriptions ? html`<td></td>` : nothing}
        <td></td>
      </tr>
    `
  }

  _renderNsRow(ns, hasDescriptions) {
    const zoneFqdn = fqdn(this.zone.zone)
    return html`
      <tr class="zone-record-synthetic small text-muted">
        <td>${syntheticOwnerDisplay(ns.owner, this.zone)}</td>
        <td>NS</td>
        <td>${unqualifyHost(ns.dname ?? '', zoneFqdn)}</td>
        <td>${formatZoneRecordTtl(ns.ttl)}</td>
        ${hasDescriptions ? html`<td></td>` : nothing}
        <td></td>
      </tr>
    `
  }

  _renderRecordRow(zr, hasDescriptions) {
    const zoneFqdn = fqdn(this.zone.zone)
    const ownerDisplay = zr.owner === zoneFqdn ? '@' : zr.owner
    const preview = getRdataPreview(zr._rdata)
    const deleted = zr.deleted === true
    return html`
      <tr
        class="zone-record-row ${deleted ? 'text-body-secondary' : ''} ${this._deletingId === zr.id ? 'opacity-50' : ''}"
        data-zr-id=${zr.id}
        style=${deleted ? '' : 'cursor: pointer'}
        @click=${deleted ? undefined : (e) => this._onRowClick(e, zr)}
      >
        <td class="small">${ownerDisplay}</td>
        <td class="small">${zr.type}</td>
        <td class="small text-truncate" style="max-width: 24rem" title=${preview.full}>
          ${preview.preview}
        </td>
        <td class="small">${formatZoneRecordTtl(zr.ttl)}</td>
        ${hasDescriptions ? html`<td class="small text-muted">${zr.description ?? ''}</td>` : nothing}
        <td class="text-center text-nowrap">
          ${
            deleted
              ? html`<button
                  type="button"
                  class="btn btn-sm btn-link text-success p-0 zr-restore-btn"
                  title="Restore record"
                  @click=${() => this._restoreRecord(zr)}
                >
                  ↩ Restore
                </button>`
              : html`<button
                    type="button"
                    class="btn btn-sm btn-link text-body-secondary p-0 me-2 zr-edit-btn"
                    title="Edit record"
                    @click=${() => this._emit('zr-edit', { zone: this.zone, zr })}
                  >
                    ✎
                  </button>
                  <button
                    type="button"
                    class="btn btn-sm btn-link text-body-secondary p-0 zr-delete-btn"
                    title="Delete record"
                    ?disabled=${this._deletingId === zr.id}
                    @click=${() => this._deleteRecord(zr)}
                  >
                    🗑
                  </button>`
          }
        </td>
      </tr>
    `
  }
}

customElements.define('nt-zone-records', ZoneRecords)
