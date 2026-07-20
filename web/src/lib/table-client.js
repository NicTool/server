// Small, framework-free helpers for client-side tables (nameservers, users)
// whose data sets are small enough to filter/sort in the browser.

/** Read a possibly-nested field by dot path, e.g. 'export.type'. */
export function getField(obj, path) {
  return `${path}`.split('.').reduce((o, k) => (o == null ? o : o[k]), obj)
}

/** Case-insensitive substring filter across the given fields (dot paths ok). */
export function filterRows(rows, search, fields) {
  const term = `${search ?? ''}`.trim().toLowerCase()
  if (!term) return rows
  return rows.filter((r) =>
    fields.some((f) => `${getField(r, f) ?? ''}`.toLowerCase().includes(term)),
  )
}

/** Stable sort by a field (dot path); nullish values sort last. Returns a copy. */
export function sortRows(rows, sortBy, sortDir = 'asc') {
  if (!sortBy) return [...rows]
  const dir = sortDir === 'desc' ? -1 : 1
  return [...rows].sort((a, b) => {
    const av = getField(a, sortBy)
    const bv = getField(b, sortBy)
    if (av === bv) return 0
    if (av == null || av === '') return 1
    if (bv == null || bv === '') return -1
    return (av > bv ? 1 : -1) * dir
  })
}

/** Clicking a new column sorts asc; clicking the active column flips direction. */
export function toggleSort(current, column) {
  if (current.sortBy !== column) return { sortBy: column, sortDir: 'asc' }
  return { sortBy: column, sortDir: current.sortDir === 'asc' ? 'desc' : 'asc' }
}
