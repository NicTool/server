import assert from 'node:assert/strict'
import { test } from 'node:test'

import { JSDOM } from 'jsdom'

// Lit needs DOM globals at import time; wire jsdom up before importing the component.
const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/',
})
for (const k of [
  'window',
  'document',
  'HTMLElement',
  'customElements',
  'CustomEvent',
  'Element',
  'Node',
  'ShadowRoot',
  'MutationObserver',
  'Document',
  'CSSStyleSheet',
]) {
  globalThis[k] = dom.window[k]
}

const { DsnStatus, STATE, looksComplete } = await import('./dsn-status.js')

const GOOD_DSN = 'mysql://user:pass@127.0.0.1:3306/nictool'

function mount() {
  const el = new DsnStatus()
  el.debounceMs = 0
  document.body.appendChild(el)
  return el
}

test('looksComplete requires mysql url with host and database', () => {
  assert.equal(looksComplete(''), false)
  assert.equal(looksComplete('not a url'), false)
  assert.equal(looksComplete('postgres://h/db'), false)
  assert.equal(looksComplete('mysql://user@127.0.0.1:3306/'), false)
  assert.equal(looksComplete(GOOD_DSN), true)
})

test('check() lights up ok and emits dsn-check on success', async () => {
  globalThis.fetch = async () => ({ json: async () => ({ ok: true }) })
  const el = mount()
  const events = []
  el.addEventListener('dsn-check', (e) => events.push(e.detail))

  el.dsn = GOOD_DSN
  const result = await el.check()

  assert.equal(result.ok, true)
  assert.equal(el._state, STATE.OK)
  assert.deepEqual(events, [{ ok: true, error: undefined, dsn: GOOD_DSN }])
})

test('check() reports the server error on failure', async () => {
  globalThis.fetch = async () => ({
    json: async () => ({ ok: false, error: 'Access denied for user' }),
  })
  const el = mount()

  el.dsn = GOOD_DSN
  const result = await el.check()

  assert.equal(result.ok, false)
  assert.equal(el._state, STATE.ERROR)
  assert.equal(el._message, 'Access denied for user')
})

test('an incomplete DSN stays idle and never probes', async () => {
  let called = false
  globalThis.fetch = async () => {
    called = true
    return { json: async () => ({ ok: true }) }
  }
  const el = mount()

  el.dsn = 'mysql://user@127.0.0.1/'
  const result = await el.check()

  assert.equal(result.ok, false)
  assert.equal(el._state, STATE.IDLE)
  assert.equal(called, false)
})
