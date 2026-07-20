// Pure helpers for the <nt-zone-records> table state. Kept framework-free so
// the paging/sort/query logic is unit-testable without a DOM or network.

export const SORT_COLUMNS = ['owner', 'type', 'ttl']
export const DEFAULT_PAGE_SIZE = 50

/**
 * Build the querystring for GET /api/zone_record from table state.
 * offset is derived from page (1-based) and pageSize.
 */
export function buildZoneRecordQuery({
  zid,
  page = 1,
  pageSize = DEFAULT_PAGE_SIZE,
  search = '',
  sortBy = 'owner',
  sortDir = 'asc',
  deleted = false,
}) {
  const params = new URLSearchParams()
  params.set('zid', `${zid}`)
  params.set('limit', `${pageSize}`)
  params.set('offset', `${Math.max(0, (page - 1) * pageSize)}`)
  const term = `${search ?? ''}`.trim()
  if (term) params.set('search', term)
  if (SORT_COLUMNS.includes(sortBy)) {
    params.set('sort_by', sortBy)
    params.set('sort_dir', sortDir === 'desc' ? 'desc' : 'asc')
  }
  if (deleted) params.set('deleted', 'true')
  return params.toString()
}

/** Total number of pages for a given filtered count and page size (min 1). */
export function pageCount(filtered, pageSize = DEFAULT_PAGE_SIZE) {
  if (!Number.isFinite(filtered) || filtered <= 0) return 1
  return Math.max(1, Math.ceil(filtered / Math.max(1, pageSize)))
}

/** Clamp a requested page into [1, pageCount]. */
export function clampPage(page, filtered, pageSize = DEFAULT_PAGE_SIZE) {
  const last = pageCount(filtered, pageSize)
  if (!Number.isFinite(page) || page < 1) return 1
  return Math.min(page, last)
}

/**
 * Given the current sort and a clicked column, return the next {sortBy, sortDir}:
 * clicking a new column sorts it ascending; clicking the active column flips it.
 */
export function nextSort(current, column) {
  if (!SORT_COLUMNS.includes(column)) return current
  if (current.sortBy !== column) return { sortBy: column, sortDir: 'asc' }
  return { sortBy: column, sortDir: current.sortDir === 'asc' ? 'desc' : 'asc' }
}

/** DataTables-style "Showing 1 to 25 of 27 entries" label for the current page. */
export function rangeLabel({ page, pageSize, filtered }) {
  if (!filtered) return 'No entries'
  const start = (page - 1) * pageSize + 1
  const end = Math.min(filtered, page * pageSize)
  const n = (v) => v.toLocaleString('en-US')
  return `Showing ${n(start)} to ${n(end)} of ${n(filtered)} entries`
}
