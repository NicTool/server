import { escapeHtml, formatZoneRecordTtl } from './format.js'
import { syntheticOwnerDisplay, unqualifyHost } from './zone-name.js'

// The zone-records table renders two synthetic (read-only) rows ahead of the
// editable records: the zone's SOA and its NS set. Both must match the table's
// column count exactly — the hidden first cell is a fixed sort key (0 = SOA,
// 1 = NS, 2 = record) that keeps them pinned above the editable rows.

export function buildSyntheticSoaRow(zone) {
  const zoneFqdn = `${zone.zone}`.endsWith('.') ? zone.zone : `${zone.zone}.`
  const mname =
    Array.isArray(zone.nameservers) && zone.nameservers.length
      ? zone.nameservers[0].endsWith('.')
        ? zone.nameservers[0]
        : `${zone.nameservers[0]}.`
      : `ns1.${zoneFqdn}`
  const rname = zone.mailaddr
    ? zone.mailaddr.endsWith('.')
      ? zone.mailaddr
      : `${zone.mailaddr}.`
    : `hostmaster.${zoneFqdn}`
  const serial = zone.serial ?? 0
  const refresh = zone.refresh ?? 86400
  const retry = zone.retry ?? 7200
  const expire = zone.expire ?? 1209600
  const minimum = zone.minimum ?? 3600
  const rdata = `${unqualifyHost(mname, zoneFqdn)} ${unqualifyHost(rname, zoneFqdn)} ${serial} ${refresh} ${retry} ${expire} ${minimum}`

  const row = document.createElement('tr')
  row.classList.add('zone-record-soa')
  row.innerHTML = `
    <td style="display:none">0</td>
    <td class="small text-muted">@</td>
    <td class="small text-muted">SOA</td>
    <td class="small text-muted" style="width: 50%;">
      <span class="text-truncate" style="display:inline-block;max-width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${escapeHtml(rdata)}">${escapeHtml(rdata)}</span>
    </td>
    <td class="small text-muted">${escapeHtml(formatZoneRecordTtl(zone.ttl))}</td>
    <td class="small text-center"></td>
  `
  return row
}

export function buildSyntheticNsRow(zr, zone) {
  const zoneFqdn = `${zone.zone}`.endsWith('.') ? zone.zone : `${zone.zone}.`
  const ownerDisplay = escapeHtml(syntheticOwnerDisplay(zr.owner, zone))
  const rdata = escapeHtml(unqualifyHost(zr.dname ?? '', zoneFqdn))
  const row = document.createElement('tr')
  row.classList.add('zone-record-synthetic')
  row.innerHTML = `
    <td style="display:none">1</td>
    <td class="small text-muted">${ownerDisplay}</td>
    <td class="small text-muted">NS</td>
    <td class="small text-muted" style="width: 50%;">
      <span class="text-truncate" style="display:inline-block;max-width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${rdata}">${rdata}</span>
    </td>
    <td class="small text-muted">${escapeHtml(formatZoneRecordTtl(zr.ttl))}</td>
    <td class="small text-center"></td>
  `
  return row
}
