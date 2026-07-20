import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'

import { JSDOM } from 'jsdom'

const dom = new JSDOM('', { url: 'http://localhost/' })
globalThis.document = dom.window.document

const { Cookie } = await import('./cookie.js')

beforeEach(() => {
  // Clear any cookies left by a prior test.
  for (const pair of document.cookie.split(';')) {
    const name = pair.split('=')[0].trim()
    if (name) Cookie.delete(name)
  }
})

test('set then get round-trips a value', () => {
  Cookie.set('nt-token', 'abc123')
  assert.equal(Cookie.get('nt-token'), 'abc123')
})

test('get returns undefined for an unset cookie', () => {
  assert.equal(Cookie.get('missing'), undefined)
})

test('values are URL-encoded and decoded transparently', () => {
  Cookie.set('greeting', 'a b;c=d')
  assert.equal(Cookie.get('greeting'), 'a b;c=d')
})

test('delete removes the cookie', () => {
  Cookie.set('temp', 'x')
  assert.equal(Cookie.get('temp'), 'x')
  Cookie.delete('temp')
  assert.equal(Cookie.get('temp'), undefined)
})

test('days option is translated to max-age without leaking into the value', () => {
  Cookie.set('withdays', 'v', { days: 1 })
  assert.equal(Cookie.get('withdays'), 'v')
})
