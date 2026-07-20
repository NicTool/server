export function normalizeOwnerForZone(owner, zoneName) {
  const zoneFqdn = `${zoneName}`.endsWith('.') ? `${zoneName}` : `${zoneName}.`
  let value = `${owner ?? ''}`.trim()

  if (!value || value === '@') return zoneFqdn
  // A trailing dot means the user typed an absolute name — trust it as-is
  // rather than appending the zone (which mangled out-of-zone fqdns).
  const absolute = value.endsWith('.')
  if (!absolute) value = `${value}.`
  if (absolute || value === zoneFqdn || value.endsWith(zoneFqdn)) return value
  return `${value}${zoneFqdn}`
}

export function unqualifyHost(host, zoneFqdn) {
  if (!host) return host
  const fqdn = zoneFqdn.endsWith('.') ? zoneFqdn : `${zoneFqdn}.`
  const h = host.endsWith('.') ? host : `${host}.`
  if (h === fqdn) return '@'
  const suffix = `.${fqdn}`
  if (h.endsWith(suffix)) return h.slice(0, -suffix.length)
  return h
}

export function syntheticOwnerDisplay(owner, zone) {
  const zoneFqdn = `${zone.zone}`.endsWith('.') ? zone.zone : `${zone.zone}.`
  return owner === zoneFqdn ? '@' : owner
}
