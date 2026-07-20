import assert from 'node:assert/strict'
import { test } from 'node:test'

import { filterRows, getField, sortRows, toggleSort } from './table-client.js'

const rows = [
  { id: 2, name: 'ns2.example.com.', export: { type: 'tinydns' }, address: '10.0.0.2' },
  { id: 1, name: 'ns1.example.com.', export: { type: 'bind' }, address: '10.0.0.10' },
  { id: 3, name: 'apex.example.net.', export: { type: 'bind' }, address: null },
]

test('getField reads nested dot paths', () => {
  assert.equal(getField(rows[0], 'export.type'), 'tinydns')
  assert.equal(getField(rows[0], 'name'), 'ns2.example.com.')
  assert.equal(getField({}, 'export.type'), undefined)
})

test('filterRows matches across fields including nested, case-insensitively', () => {
  assert.equal(filterRows(rows, 'NS1', ['name']).length, 1)
  assert.equal(filterRows(rows, 'bind', ['export.type']).length, 2)
  assert.equal(filterRows(rows, '', ['name']).length, 3) // blank → all
  assert.equal(filterRows(rows, 'nope', ['name', 'export.type']).length, 0)
})

test('sortRows sorts by field with nullish last, and copies (no mutation)', () => {
  const asc = sortRows(rows, 'name', 'asc')
  assert.deepEqual(
    asc.map((r) => r.id),
    [3, 1, 2], // apex < ns1 < ns2
  )
  const desc = sortRows(rows, 'name', 'desc')
  assert.deepEqual(
    desc.map((r) => r.id),
    [2, 1, 3],
  )
  // null address sorts last regardless of direction
  assert.equal(sortRows(rows, 'address', 'asc').at(-1).id, 3)
  assert.equal(sortRows(rows, 'address', 'desc').at(-1).id, 3)
  // original array untouched
  assert.deepEqual(
    rows.map((r) => r.id),
    [2, 1, 3],
  )
})

test('toggleSort flips the active column and defaults new columns to asc', () => {
  assert.deepEqual(toggleSort({ sortBy: 'name', sortDir: 'asc' }, 'address'), {
    sortBy: 'address',
    sortDir: 'asc',
  })
  assert.deepEqual(toggleSort({ sortBy: 'name', sortDir: 'asc' }, 'name'), {
    sortBy: 'name',
    sortDir: 'desc',
  })
})
