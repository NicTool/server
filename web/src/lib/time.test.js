import assert from 'node:assert/strict'
import { test } from 'node:test'

import { parseHumanTime, secondsToHuman } from './time.js'

test('secondsToHuman picks the largest fitting unit', () => {
  assert.equal(secondsToHuman(0), '0s')
  assert.equal(secondsToHuman(30), '30s')
  assert.equal(secondsToHuman(60), '1m')
  assert.equal(secondsToHuman(3600), '1h')
  assert.equal(secondsToHuman(86400), '1d')
  assert.equal(secondsToHuman(604800), '1w')
  assert.equal(secondsToHuman(90000), '1d') // 1.04d rounds to 1d
})

test('secondsToHuman rejects non-numbers and negatives', () => {
  assert.equal(secondsToHuman('abc'), '')
  assert.equal(secondsToHuman(-5), '')
})

test('parseHumanTime accepts bare seconds and unit suffixes', () => {
  assert.equal(parseHumanTime('300'), 300)
  assert.equal(parseHumanTime('5m'), 300)
  assert.equal(parseHumanTime('2h'), 7200)
  assert.equal(parseHumanTime('1d'), 86400)
  assert.equal(parseHumanTime('1w'), 604800)
  assert.equal(parseHumanTime('1.5h'), 5400)
  assert.equal(parseHumanTime('30S'), 30) // case-insensitive unit
})

test('parseHumanTime returns null for garbage', () => {
  assert.equal(parseHumanTime('nope'), null)
  assert.equal(parseHumanTime('5x'), null)
  assert.equal(parseHumanTime(''), null)
})

test('secondsToHuman and parseHumanTime round-trip for whole units', () => {
  for (const secs of [60, 3600, 86400, 604800]) {
    assert.equal(parseHumanTime(secondsToHuman(secs)), secs)
  }
})
