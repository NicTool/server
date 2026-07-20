import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  escapeHtml,
  fieldToId,
  formatZoneRecordTtl,
  getRdataPreview,
  parseInputValue,
  parseOptionalTtlValue,
} from './format.js'

test('fieldToId hyphenates whitespace', () => {
  assert.equal(fieldToId('key tag'), 'key-tag')
  assert.equal(fieldToId('original ttl'), 'original-ttl')
  assert.equal(fieldToId('address'), 'address')
})

test('escapeHtml escapes the five entities and coerces nullish to empty', () => {
  assert.equal(
    escapeHtml(`<a href="x">'&'</a>`),
    '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;',
  )
  assert.equal(escapeHtml(null), '')
  assert.equal(escapeHtml(undefined), '')
})

test('getRdataPreview trims only past the limit', () => {
  assert.deepEqual(getRdataPreview('short', 50), {
    full: 'short',
    preview: 'short',
    isTrimmed: false,
  })
  const long = 'x'.repeat(60)
  const out = getRdataPreview(long, 50)
  assert.equal(out.isTrimmed, true)
  assert.equal(out.preview.length, 50)
  assert.ok(out.preview.endsWith('...'))
  assert.equal(out.full, long)
})

test('formatZoneRecordTtl blanks zero and nullish, stringifies otherwise', () => {
  assert.equal(formatZoneRecordTtl(0), '')
  assert.equal(formatZoneRecordTtl(null), '')
  assert.equal(formatZoneRecordTtl(undefined), '')
  assert.equal(formatZoneRecordTtl(3600), '3600')
})

test('parseInputValue coerces digit strings to numbers', () => {
  assert.equal(parseInputValue('42'), 42)
  assert.equal(parseInputValue(' 42 '), 42)
  assert.equal(parseInputValue('1.2.3.4'), '1.2.3.4')
  assert.equal(parseInputValue(7), 7)
})

test('parseOptionalTtlValue returns undefined for empty, number for digits', () => {
  assert.equal(parseOptionalTtlValue(''), undefined)
  assert.equal(parseOptionalTtlValue('   '), undefined)
  assert.equal(parseOptionalTtlValue('300'), 300)
  assert.equal(parseOptionalTtlValue('1h'), '1h')
})
