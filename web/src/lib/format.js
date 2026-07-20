export const RR_DATA_PREVIEW_CHARS = 50

export function fieldToId(field) {
  return field.replace(/\s+/g, '-')
}

export function escapeHtml(value) {
  return `${value ?? ''}`
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

export function getRdataPreview(value, maxChars = RR_DATA_PREVIEW_CHARS) {
  const full = `${value ?? ''}`
  if (full.length <= maxChars) {
    return { full, preview: full, isTrimmed: false }
  }

  return {
    full,
    preview: `${full.slice(0, maxChars - 3)}...`,
    isTrimmed: true,
  }
}

export function formatZoneRecordTtl(ttl) {
  return ttl === 0 || ttl === undefined || ttl === null ? '' : `${ttl}`
}

export function parseInputValue(raw) {
  if (typeof raw !== 'string') return raw
  const value = raw.trim()
  if (/^\d+$/.test(value)) return parseInt(value, 10)
  return value
}

export function parseOptionalTtlValue(raw) {
  if (typeof raw !== 'string') return raw
  const value = raw.trim()
  if (value === '') return undefined
  if (/^\d+$/.test(value)) return parseInt(value, 10)
  return value
}
