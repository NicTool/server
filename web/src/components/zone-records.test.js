import assert from 'node:assert/strict'
import { test } from 'node:test'

import { JSDOM } from 'jsdom'

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

const { ZoneRecords } = await import('./zone-records.js')

const ZONE = {
  id: 1,
  zone: 'example.com',
  ttl: 3600,
  mailaddr: 'hostmaster.example.com.',
}

function recordsPage(records) {
  return {
    zone_record: records,
    meta: {
      pagination: {
        total: records.length,
        filtered: records.length,
        limit: 50,
        offset: 0,
      },
    },
  }
}

/** Stub fetch with a mutable record store (soft-delete); returns { calls }. */
function stubFetch(store) {
  const calls = []
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url, method: opts.method ?? 'GET' })
    if (url.includes('/zone/1/ns')) return { json: async () => ({ ns: [] }) }
    const m = url.match(/\/zone_record\/(\d+)/)
    if (m && opts.method === 'DELETE') {
      const r = store.records.find((x) => x.id === Number(m[1]))
      if (r) r.deleted = true
      return { json: async () => ({ zone_record: [] }) }
    }
    if (m && opts.method === 'PUT') {
      const r = store.records.find((x) => x.id === Number(m[1]))
      if (r) r.deleted = false
      return { json: async () => ({ zone_record: r ? [r] : [] }) }
    }
    if (url.includes('/zone_record?')) {
      const wantDeleted = new URL(url, 'http://x').searchParams.get('deleted') === 'true'
      const list = store.records.filter((r) => (wantDeleted ? r.deleted : !r.deleted))
      return { json: async () => recordsPage(list) }
    }
    return { json: async () => ({}) }
  }
  return calls
}

async function mount(store) {
  const el = new ZoneRecords()
  document.body.appendChild(el)
  el.zone = ZONE
  await Promise.all([el.refresh(), el._loadNs()])
  await el.updateComplete
  return el
}

test('loads and renders a page of records with the sortable header', async () => {
  stubFetch({
    records: [
      {
        id: 201,
        zid: 1,
        owner: 'www.example.com.',
        type: 'A',
        address: '1.2.3.4',
        ttl: 300,
      },
      {
        id: 202,
        zid: 1,
        owner: 'mail.example.com.',
        type: 'A',
        address: '5.6.7.8',
        ttl: 300,
      },
    ],
  })
  const el = await mount()

  const rows = el.querySelectorAll('tbody tr.zone-record-row')
  assert.equal(rows.length, 2)
  assert.match(rows[0].textContent, /www/)
  assert.match(rows[0].textContent, /1\.2\.3\.4/)
  // sortable Owner header present
  assert.ok(
    [...el.querySelectorAll('thead th')].some((th) => /Owner/.test(th.textContent)),
  )
})

test('emits zr-edit with the zone and record when the edit button is clicked', async () => {
  stubFetch({
    records: [
      {
        id: 201,
        zid: 1,
        owner: 'www.example.com.',
        type: 'A',
        address: '1.2.3.4',
        ttl: 300,
      },
    ],
  })
  const el = await mount()

  const events = []
  el.addEventListener('zr-edit', (e) => events.push(e.detail))
  el.querySelector('.zr-edit-btn').click()

  assert.equal(events.length, 1)
  assert.equal(events[0].zr.id, 201)
  assert.equal(events[0].zone.id, 1)
})

test('delete removes the row via a DELETE request and reactively refetches', async () => {
  const store = {
    records: [
      {
        id: 201,
        zid: 1,
        owner: 'www.example.com.',
        type: 'A',
        address: '1.2.3.4',
        ttl: 300,
      },
      {
        id: 202,
        zid: 1,
        owner: 'mail.example.com.',
        type: 'A',
        address: '5.6.7.8',
        ttl: 300,
      },
    ],
  }
  const calls = stubFetch(store)
  const el = await mount()
  assert.equal(el.querySelectorAll('tbody tr.zone-record-row').length, 2)

  await el._deleteRecord(store.records[0]) // id 201
  await el.updateComplete

  assert.ok(calls.some((c) => c.method === 'DELETE' && /\/zone_record\/201/.test(c.url)))
  assert.equal(el.querySelectorAll('tbody tr.zone-record-row').length, 1)
  assert.equal(store.records.find((r) => r.id === 201).deleted, true)
})

test('delete shows an undo notice and undo restores the row', async () => {
  const store = {
    records: [
      {
        id: 201,
        zid: 1,
        owner: 'www.example.com.',
        type: 'A',
        address: '1.2.3.4',
        ttl: 300,
      },
      {
        id: 202,
        zid: 1,
        owner: 'mail.example.com.',
        type: 'A',
        address: '5.6.7.8',
        ttl: 300,
      },
    ],
  }
  const calls = stubFetch(store)
  const el = await mount()

  await el._deleteRecord(store.records[0]) // id 201
  await el.updateComplete
  assert.ok(el._notice, 'notice is shown after delete')
  assert.match(el._notice.text, /Deleted www\.example\.com\. A/)
  assert.equal(el.querySelectorAll('tbody tr.zone-record-row').length, 1)
  assert.ok(el.querySelector('.nt-undo-btn'), 'undo button rendered')

  await el._undoDelete(el._notice.item)
  await el.updateComplete
  assert.equal(el._notice, null, 'notice cleared after undo')
  assert.ok(calls.some((c) => c.method === 'PUT' && /\/zone_record\/201/.test(c.url)))
  assert.equal(el.querySelectorAll('tbody tr.zone-record-row').length, 2)
})

test('show-deleted lists deleted rows with a Restore action', async () => {
  const store = {
    records: [
      {
        id: 201,
        zid: 1,
        owner: 'www.example.com.',
        type: 'A',
        address: '1.2.3.4',
        ttl: 300,
        deleted: false,
      },
      {
        id: 202,
        zid: 1,
        owner: 'old.example.com.',
        type: 'A',
        address: '9.9.9.9',
        ttl: 300,
        deleted: true,
      },
    ],
  }
  const calls = stubFetch(store)
  const el = await mount()
  assert.equal(el.querySelectorAll('tbody tr.zone-record-row').length, 1) // active only

  el._showDeleted = true
  await el._load()
  await el.updateComplete

  const rows = el.querySelectorAll('tbody tr.zone-record-row')
  assert.equal(rows.length, 1)
  assert.match(rows[0].textContent, /old/)
  assert.ok(el.querySelector('.zr-restore-btn'), 'restore button shown for deleted rows')
  assert.equal(
    el.querySelector('.zr-delete-btn'),
    null,
    'no delete button on deleted rows',
  )
  assert.ok(calls.some((c) => /deleted=true/.test(c.url)))
})

test('restoring a deleted record PUTs deleted:false and notices without undo', async () => {
  const store = {
    records: [
      {
        id: 202,
        zid: 1,
        owner: 'old.example.com.',
        type: 'A',
        address: '9.9.9.9',
        ttl: 300,
        deleted: true,
      },
    ],
  }
  const calls = stubFetch(store)
  const el = await mount()
  el._showDeleted = true
  await el._load()
  await el.updateComplete

  await el._restoreRecord(store.records[0])
  await el.updateComplete

  assert.ok(calls.some((c) => c.method === 'PUT' && /\/zone_record\/202/.test(c.url)))
  assert.equal(store.records[0].deleted, false)
  assert.match(el._notice.text, /Restored/)
  assert.equal(el.querySelector('.nt-undo-btn'), null, 'restore notice has no undo')
  assert.equal(el.querySelectorAll('tbody tr.zone-record-row').length, 0)
})

test('clicking a live row (not a button) emits zr-edit', async () => {
  stubFetch({
    records: [
      {
        id: 201,
        zid: 1,
        owner: 'www.example.com.',
        type: 'A',
        address: '1.2.3.4',
        ttl: 300,
      },
    ],
  })
  const el = await mount()
  const events = []
  el.addEventListener('zr-edit', (e) => events.push(e.detail))

  el.querySelector('tbody tr.zone-record-row td').click()
  assert.equal(events.length, 1)
  assert.equal(events[0].zr.id, 201)
})
