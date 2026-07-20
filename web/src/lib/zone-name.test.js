import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  normalizeOwnerForZone,
  syntheticOwnerDisplay,
  unqualifyHost,
} from './zone-name.js'

test('normalizeOwnerForZone maps @ and blanks to the zone fqdn', () => {
  assert.equal(normalizeOwnerForZone('@', 'example.com'), 'example.com.')
  assert.equal(normalizeOwnerForZone('', 'example.com.'), 'example.com.')
  assert.equal(normalizeOwnerForZone('   ', 'example.com'), 'example.com.')
})

test('normalizeOwnerForZone qualifies a relative owner under the zone', () => {
  assert.equal(normalizeOwnerForZone('www', 'example.com'), 'www.example.com.')
})

test('normalizeOwnerForZone leaves an in-zone qualified owner intact', () => {
  assert.equal(
    normalizeOwnerForZone('www.example.com.', 'example.com'),
    'www.example.com.',
  )
})

test('normalizeOwnerForZone trusts an out-of-zone fqdn as absolute', () => {
  assert.equal(normalizeOwnerForZone('ns.other.net.', 'example.com'), 'ns.other.net.')
})

test('normalizeOwnerForZone treats a no-dot spelling of the zone as the apex', () => {
  assert.equal(normalizeOwnerForZone('example.com', 'example.com'), 'example.com.')
})

test('unqualifyHost strips the zone suffix or returns @', () => {
  assert.equal(unqualifyHost('example.com.', 'example.com'), '@')
  assert.equal(unqualifyHost('www.example.com.', 'example.com.'), 'www')
  assert.equal(unqualifyHost('ns1.other.net.', 'example.com'), 'ns1.other.net.')
  assert.equal(unqualifyHost('', 'example.com'), '')
})

test('syntheticOwnerDisplay shows @ when owner equals the zone fqdn', () => {
  assert.equal(syntheticOwnerDisplay('example.com.', { zone: 'example.com' }), '@')
  assert.equal(
    syntheticOwnerDisplay('www.example.com.', { zone: 'example.com' }),
    'www.example.com.',
  )
})
