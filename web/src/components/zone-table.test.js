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

const { ZoneTable } = await import('./zone-table.js')

function makeStore(n = 120) {
  return {
    zones: Array.from({ length: n }, (_, i) => ({
      id: 300 + i,
      gid: 1,
      zone: `z${String(i).padStart(3, '0')}.example.com`,
      description: `zone ${i}`,
      deleted: false,
    })),
  }
}

function stubFetch(store) {
  const calls = []
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url, method: opts.method ?? 'GET' })
    const m = url.match(/\/zone\/(\d+)/)
    if (m && opts.method === 'DELETE') {
      const z = store.zones.find((x) => x.id === Number(m[1]))
      if (z) z.deleted = true
      return { json: async () => ({ zone: [] }) }
    }
    if (m && opts.method === 'PUT') {
      const z = store.zones.find((x) => x.id === Number(m[1]))
      if (z) z.deleted = false
      return { json: async () => ({ zone: z ? [z] : [] }) }
    }
    if (url.includes('/zone?')) {
      const q = new URL(url, 'http://x').searchParams
      const wantDeleted = q.get('deleted') === 'true'
      const search = (q.get('search') ?? '').toLowerCase()
      const limit = Number(q.get('limit') ?? 50)
      const offset = Number(q.get('offset') ?? 0)
      const dir = q.get('sort_dir') === 'desc' ? -1 : 1
      const scoped = store.zones.filter((z) => Boolean(z.deleted) === wantDeleted)
      let list = scoped.filter(
        (z) =>
          !search ||
          z.zone.toLowerCase().includes(search) ||
          `${z.description}`.toLowerCase().includes(search),
      )
      list = [...list].sort((a, b) =>
        a.zone > b.zone ? dir : a.zone < b.zone ? -dir : 0,
      )
      return {
        json: async () => ({
          zone: list.slice(offset, offset + limit),
          meta: {
            pagination: { total: scoped.length, filtered: list.length, limit, offset },
          },
        }),
      }
    }
    return { json: async () => ({}) }
  }
  return calls
}

async function mount(store) {
  const el = new ZoneTable()
  document.body.appendChild(el)
  el.gid = 1
  await el._load()
  await el.updateComplete
  return el
}

const zoneNames = (el) =>
  [...el.querySelectorAll('tbody tr.zone-row td.zone-name-toggle')].map((td) =>
    td.textContent.trim(),
  )

test('loads a page of zones with a pager', async () => {
  stubFetch(makeStore(120))
  const el = await mount()
  assert.equal(el.querySelectorAll('tbody tr.zone-row').length, 50)
  assert.match(el.textContent, /Page 1 of 3/)
})

test('paginates and sorts server-side', async () => {
  stubFetch(makeStore(120))
  const el = await mount()
  assert.equal(zoneNames(el)[0], 'z000.example.com')

  el._goToPage(2)
  await el._load()
  await el.updateComplete
  assert.equal(zoneNames(el)[0], 'z050.example.com')

  el._sortByColumn('zone') // flip to desc
  await el._load()
  await el.updateComplete
  assert.equal(zoneNames(el)[0], 'z119.example.com')
})

test('searches server-side', async () => {
  stubFetch(makeStore(120))
  const el = await mount()
  el._search = 'z05'
  el._page = 1
  await el._load()
  await el.updateComplete
  assert.equal(el.querySelectorAll('tbody tr.zone-row').length, 10) // z050..z059
})

test('clicking a zone emits zone-open-records; action buttons emit their events', async () => {
  stubFetch(makeStore(3))
  const el = await mount()
  const events = {}
  for (const name of [
    'zone-open-records',
    'zone-edit',
    'zone-add-record',
    'zone-create',
  ]) {
    events[name] = []
    el.addEventListener(name, (e) => events[name].push(e.detail))
  }

  el.querySelector('tbody tr.zone-row td.zone-name-toggle').click()
  assert.equal(events['zone-open-records'].length, 1)
  assert.equal(events['zone-open-records'][0].zone.id, 300)

  el.querySelector('.zone-edit-btn').click()
  assert.equal(events['zone-edit'].length, 1)
  el.querySelector('.zone-add-zr-btn').click()
  assert.equal(events['zone-add-record'].length, 1)
  el.querySelector('button.btn-outline-secondary').click() // + Create
  assert.equal(events['zone-create'].length, 1)
})

test('subgroups toggle emits subgroups-change and requests include_subgroups', async () => {
  const calls = stubFetch(makeStore(3))
  const el = await mount()
  const changes = []
  el.addEventListener('subgroups-change', (e) => changes.push(e.detail.value))

  el._toggleSubgroups({ target: { checked: true } })
  await el.updateComplete
  await el._load()

  assert.deepEqual(changes, [true])
  assert.ok(calls.some((c) => /include_subgroups=true/.test(c.url)))
})

test('delete shows an undo toast and undo restores', async () => {
  const store = makeStore(3)
  const calls = stubFetch(store)
  const el = await mount()
  assert.equal(el.querySelectorAll('tbody tr.zone-row').length, 3)

  await el._deleteRecord(store.zones[0]) // id 300
  await el.updateComplete
  assert.equal(el.querySelectorAll('tbody tr.zone-row').length, 2)
  assert.match(el._notice.text, /Deleted zone z000/)

  await el._undoDelete(el._notice.item)
  await el.updateComplete
  assert.ok(calls.some((c) => c.method === 'PUT' && /\/zone\/300/.test(c.url)))
  assert.equal(el.querySelectorAll('tbody tr.zone-row').length, 3)
})

test('show-deleted lists deleted zones with Restore', async () => {
  const store = makeStore(2)
  store.zones[0].deleted = true
  const calls = stubFetch(store)
  const el = await mount()
  assert.equal(el.querySelectorAll('tbody tr.zone-row').length, 1) // active only

  el._showDeleted = true
  el._page = 1
  await el._load()
  await el.updateComplete
  assert.ok(el.querySelector('.zone-restore-btn'))
  assert.equal(el.querySelector('.zone-delete-btn'), null)
  assert.ok(calls.some((c) => /deleted=true/.test(c.url)))

  await el._restoreRecord(store.zones[0])
  await el.updateComplete
  assert.equal(store.zones[0].deleted, false)
  assert.match(el._notice.text, /Restored/)
})
