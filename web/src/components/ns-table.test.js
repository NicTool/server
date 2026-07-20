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

const { NsTable } = await import('./ns-table.js')

function ns(id, name, extra = {}) {
  return {
    id,
    name,
    description: '',
    address: `10.0.0.${id}`,
    export: { type: 'bind' },
    ...extra,
  }
}

function stubFetch(store) {
  const calls = []
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url, method: opts.method ?? 'GET' })
    const m = url.match(/\/nameserver\/(\d+)/)
    if (m && opts.method === 'DELETE') {
      const r = store.nameserver.find((x) => x.id === Number(m[1]))
      if (r) r.deleted = true
      return { json: async () => ({ nameserver: [] }) }
    }
    if (m && opts.method === 'PUT') {
      const r = store.nameserver.find((x) => x.id === Number(m[1]))
      if (r) r.deleted = false
      return { json: async () => ({ nameserver: r ? [r] : [] }) }
    }
    if (url.includes('/nameserver?')) {
      const wantDeleted = new URL(url, 'http://x').searchParams.get('deleted') === 'true'
      const list = store.nameserver.filter((n) => Boolean(n.deleted) === wantDeleted)
      return { json: async () => ({ nameserver: list }) }
    }
    return { json: async () => ({}) }
  }
  return calls
}

async function mount(store) {
  const el = new NsTable()
  document.body.appendChild(el)
  el.gid = 5
  await el._load()
  await el.updateComplete
  return el
}

const names = (el) =>
  [...el.querySelectorAll('tbody tr.ns-row td:first-child')].map((td) =>
    td.textContent.trim(),
  )

test('loads, sorts by name, and filters via search', async () => {
  stubFetch({
    nameserver: [
      ns(2, 'ns2.example.com.'),
      ns(1, 'ns1.example.com.'),
      ns(3, 'apex.example.net.'),
    ],
  })
  const el = await mount()

  assert.deepEqual(names(el), [
    'apex.example.net.',
    'ns1.example.com.',
    'ns2.example.com.',
  ])

  el._sortByColumn('name') // flip to desc
  await el.updateComplete
  assert.deepEqual(names(el), [
    'ns2.example.com.',
    'ns1.example.com.',
    'apex.example.net.',
  ])

  el._search = 'ns2'
  await el.updateComplete
  assert.deepEqual(names(el), ['ns2.example.com.'])
})

test('flags a name missing its trailing dot', async () => {
  stubFetch({ nameserver: [ns(1, 'ns1.example.com')] }) // no trailing dot
  const el = await mount()
  assert.ok(el.querySelector('tbody tr.ns-row .badge'), 'warning badge shown')
})

test('delete shows an undo toast and undo restores', async () => {
  const store = { nameserver: [ns(1, 'ns1.example.com.'), ns(2, 'ns2.example.com.')] }
  const calls = stubFetch(store)
  const el = await mount()
  assert.equal(el.querySelectorAll('tbody tr.ns-row').length, 2)

  await el._deleteRecord(store.nameserver[0])
  await el.updateComplete
  assert.equal(el.querySelectorAll('tbody tr.ns-row').length, 1)
  assert.match(el._notice.text, /Deleted ns1/)

  await el._undoDelete(el._notice.item)
  await el.updateComplete
  assert.ok(calls.some((c) => c.method === 'PUT' && /\/nameserver\/1/.test(c.url)))
  assert.equal(el.querySelectorAll('tbody tr.ns-row').length, 2)
})

test('show-deleted lists deleted rows with Restore, restore brings them back', async () => {
  const store = {
    nameserver: [ns(1, 'ns1.example.com.'), ns(2, 'old.example.com.', { deleted: true })],
  }
  const calls = stubFetch(store)
  const el = await mount()
  assert.equal(el.querySelectorAll('tbody tr.ns-row').length, 1)

  el._showDeleted = true
  await el._load()
  await el.updateComplete
  assert.equal(el.querySelectorAll('tbody tr.ns-row').length, 1)
  assert.ok(el.querySelector('.ns-restore-btn'))
  assert.equal(el.querySelector('.ns-delete-btn'), null)
  assert.ok(calls.some((c) => /deleted=true/.test(c.url)))

  await el._restoreRecord(store.nameserver[1])
  await el.updateComplete
  assert.equal(store.nameserver[1].deleted, false)
  assert.match(el._notice.text, /Restored/)
  assert.equal(el.querySelector('.nt-undo-btn'), null)
})

test('row click and edit button emit ns-edit; create button emits ns-create', async () => {
  stubFetch({ nameserver: [ns(1, 'ns1.example.com.')] })
  const el = await mount()
  const edits = []
  const creates = []
  el.addEventListener('ns-edit', (e) => edits.push(e.detail))
  el.addEventListener('ns-create', () => creates.push(true))

  el.querySelector('tbody tr.ns-row td').click()
  assert.equal(edits.length, 1)
  assert.equal(edits[0].ns.id, 1)

  el.querySelector('.ns-edit-btn').click()
  assert.equal(edits.length, 2)

  el.querySelector('button.btn-outline-secondary').click() // + Create
  assert.equal(creates.length, 1)
})
