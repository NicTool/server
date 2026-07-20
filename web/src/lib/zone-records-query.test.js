import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  buildZoneRecordQuery,
  clampPage,
  nextSort,
  pageCount,
  rangeLabel,
} from './zone-records-query.js'

test('buildZoneRecordQuery derives offset from page and includes sort/search', () => {
  const qs = buildZoneRecordQuery({
    zid: 100,
    page: 3,
    pageSize: 50,
    search: '  www ',
    sortBy: 'owner',
    sortDir: 'desc',
  })
  const p = new URLSearchParams(qs)
  assert.equal(p.get('zid'), '100')
  assert.equal(p.get('limit'), '50')
  assert.equal(p.get('offset'), '100') // (3-1)*50
  assert.equal(p.get('search'), 'www') // trimmed
  assert.equal(p.get('sort_by'), 'owner')
  assert.equal(p.get('sort_dir'), 'desc')
})

test('buildZoneRecordQuery sets deleted=true only when requested', () => {
  assert.equal(
    new URLSearchParams(buildZoneRecordQuery({ zid: 1 })).has('deleted'),
    false,
  )
  assert.equal(
    new URLSearchParams(buildZoneRecordQuery({ zid: 1, deleted: true })).get('deleted'),
    'true',
  )
})

test('buildZoneRecordQuery omits blank search and rejects unknown sort column', () => {
  const p = new URLSearchParams(
    buildZoneRecordQuery({ zid: 1, search: '   ', sortBy: 'address' }),
  )
  assert.equal(p.has('search'), false)
  assert.equal(p.has('sort_by'), false)
})

test('pageCount rounds up and floors at 1', () => {
  assert.equal(pageCount(0, 50), 1)
  assert.equal(pageCount(50, 50), 1)
  assert.equal(pageCount(51, 50), 2)
  assert.equal(pageCount(1234, 50), 25)
})

test('clampPage keeps the page within range', () => {
  assert.equal(clampPage(0, 200, 50), 1)
  assert.equal(clampPage(99, 200, 50), 4) // 200/50 = 4 pages
  assert.equal(clampPage(2, 200, 50), 2)
})

test('nextSort flips the active column and defaults new columns to asc', () => {
  assert.deepEqual(nextSort({ sortBy: 'owner', sortDir: 'asc' }, 'type'), {
    sortBy: 'type',
    sortDir: 'asc',
  })
  assert.deepEqual(nextSort({ sortBy: 'owner', sortDir: 'asc' }, 'owner'), {
    sortBy: 'owner',
    sortDir: 'desc',
  })
  const cur = { sortBy: 'owner', sortDir: 'asc' }
  assert.equal(nextSort(cur, 'nope'), cur) // unknown column: unchanged
})

test('rangeLabel formats the visible slice', () => {
  assert.equal(
    rangeLabel({ page: 1, pageSize: 50, filtered: 1234 }),
    'Showing 1 to 50 of 1,234 entries',
  )
  assert.equal(
    rangeLabel({ page: 25, pageSize: 50, filtered: 1234 }),
    'Showing 1,201 to 1,234 of 1,234 entries',
  )
  assert.equal(rangeLabel({ page: 1, pageSize: 50, filtered: 0 }), 'No entries')
})
