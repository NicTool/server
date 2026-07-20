import assert from 'node:assert/strict'
import { test } from 'node:test'

import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><html><body></body></html>')
globalThis.document = dom.window.document

const { buildSyntheticSoaRow, buildSyntheticNsRow } = await import('./zone-rows.js')

const ZONE = {
  zone: 'example.com',
  ttl: 3600,
  mailaddr: 'hostmaster.example.com.',
  nameservers: ['ns1.example.com.'],
  serial: 2026011900,
}

function cells(row) {
  return [...row.querySelectorAll('td')]
}

test('SOA row has the fixed 6-cell shape with sort key 0', () => {
  const row = buildSyntheticSoaRow(ZONE)
  const td = cells(row)
  assert.equal(td.length, 6)
  assert.equal(td[0].textContent, '0') // sort key pins SOA first
  assert.equal(td[1].textContent.trim(), '@')
  assert.equal(td[2].textContent.trim(), 'SOA')
  assert.equal(td[4].textContent.trim(), '3600')
  assert.ok(row.classList.contains('zone-record-soa'))
})

test('SOA rdata unqualifies the mname/rname against the zone', () => {
  const row = buildSyntheticSoaRow(ZONE)
  const rdata = cells(row)[3].textContent.trim()
  // ns1.example.com. -> ns1, hostmaster.example.com. -> hostmaster
  assert.match(rdata, /^ns1 hostmaster 2026011900 /)
})

test('SOA row falls back to sane defaults when fields are missing', () => {
  const row = buildSyntheticSoaRow({ zone: 'bare.test' })
  const td = cells(row)
  assert.equal(td.length, 6)
  assert.match(td[3].textContent.trim(), /^ns1 hostmaster 0 86400 7200 1209600 3600$/)
})

test('NS row has the fixed 6-cell shape with sort key 1', () => {
  const row = buildSyntheticNsRow(
    { owner: 'example.com.', dname: 'ns1.example.com.', ttl: 86400 },
    ZONE,
  )
  const td = cells(row)
  assert.equal(td.length, 6)
  assert.equal(td[0].textContent, '1') // sort key pins NS after SOA
  assert.equal(td[1].textContent.trim(), '@') // owner === zone fqdn shows as @
  assert.equal(td[2].textContent.trim(), 'NS')
  assert.equal(td[3].textContent.trim(), 'ns1') // dname unqualified
  assert.ok(row.classList.contains('zone-record-synthetic'))
})

test('synthetic rows escape hostile content', () => {
  const row = buildSyntheticNsRow(
    { owner: 'example.com.', dname: '<img src=x onerror=alert(1)>', ttl: 0 },
    ZONE,
  )
  const dataCell = cells(row)[3]
  assert.equal(dataCell.querySelector('img'), null)
  assert.match(dataCell.innerHTML, /&lt;img/)
})
