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

const { UserTable } = await import('./user-table.js')

function user(id, username, extra = {}) {
  return {
    id,
    username,
    first_name: '',
    last_name: '',
    email: `${username}@example.com`,
    ...extra,
  }
}

function stubFetch(store) {
  const calls = []
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url, method: opts.method ?? 'GET' })
    const m = url.match(/\/user\/(\d+)/)
    if (m && opts.method === 'DELETE') {
      const r = store.user.find((x) => x.id === Number(m[1]))
      if (r) r.deleted = true
      return { json: async () => ({ user: [] }) }
    }
    if (m && opts.method === 'PUT') {
      const r = store.user.find((x) => x.id === Number(m[1]))
      if (r) r.deleted = false
      return { json: async () => ({ user: r ? [r] : [] }) }
    }
    if (url.includes('/user?')) {
      const wantDeleted = new URL(url, 'http://x').searchParams.get('deleted') === 'true'
      const list = store.user.filter((u) => Boolean(u.deleted) === wantDeleted)
      return { json: async () => ({ user: list }) }
    }
    return { json: async () => ({}) }
  }
  return calls
}

async function mount() {
  const el = new UserTable()
  document.body.appendChild(el)
  el.gid = 5
  await el._load()
  await el.updateComplete
  return el
}

const usernames = (el) =>
  [...el.querySelectorAll('tbody tr.user-row td:first-child')].map((td) =>
    td.textContent.trim(),
  )

test('loads, sorts by username, and filters via search', async () => {
  stubFetch({
    user: [
      user(2, 'bob', { first_name: 'Bob', last_name: 'Jones' }),
      user(1, 'alice', { first_name: 'Alice', last_name: 'Adams' }),
    ],
  })
  const el = await mount()
  assert.deepEqual(usernames(el), ['alice', 'bob'])

  el._sortByColumn('username') // flip to desc
  await el.updateComplete
  assert.deepEqual(usernames(el), ['bob', 'alice'])

  el._search = 'jones' // matches Bob's last name
  await el.updateComplete
  assert.deepEqual(usernames(el), ['bob'])
})

test('renders the combined name column', async () => {
  stubFetch({ user: [user(1, 'alice', { first_name: 'Alice', last_name: 'Adams' })] })
  const el = await mount()
  const cells = el.querySelectorAll('tbody tr.user-row td')
  assert.equal(cells[1].textContent.trim(), 'Alice Adams')
})

test('delete shows an undo toast and undo restores', async () => {
  const store = { user: [user(1, 'alice'), user(2, 'bob')] }
  const calls = stubFetch(store)
  const el = await mount()
  assert.equal(el.querySelectorAll('tbody tr.user-row').length, 2)

  await el._deleteRecord(store.user[0])
  await el.updateComplete
  assert.equal(el.querySelectorAll('tbody tr.user-row').length, 1)
  assert.match(el._notice.text, /Deleted alice/)

  await el._undoDelete(el._notice.item)
  await el.updateComplete
  assert.ok(calls.some((c) => c.method === 'PUT' && /\/user\/1/.test(c.url)))
  assert.equal(el.querySelectorAll('tbody tr.user-row').length, 2)
})

test('show-deleted lists deleted rows with Restore', async () => {
  const store = { user: [user(1, 'alice'), user(2, 'old', { deleted: true })] }
  const calls = stubFetch(store)
  const el = await mount()
  assert.equal(el.querySelectorAll('tbody tr.user-row').length, 1)

  el._showDeleted = true
  await el._load()
  await el.updateComplete
  assert.ok(el.querySelector('.user-restore-btn'))
  assert.equal(el.querySelector('.user-delete-btn'), null)
  assert.ok(calls.some((c) => /deleted=true/.test(c.url)))

  await el._restoreRecord(store.user[1])
  await el.updateComplete
  assert.equal(store.user[1].deleted, false)
  assert.match(el._notice.text, /Restored/)
})

test('row click and edit button emit user-edit; create emits user-create', async () => {
  stubFetch({ user: [user(1, 'alice')] })
  const el = await mount()
  const edits = []
  const creates = []
  el.addEventListener('user-edit', (e) => edits.push(e.detail))
  el.addEventListener('user-create', () => creates.push(true))

  el.querySelector('tbody tr.user-row td').click()
  assert.equal(edits.length, 1)
  assert.equal(edits[0].user.id, 1)

  el.querySelector('.user-edit-btn').click()
  assert.equal(edits.length, 2)

  el.querySelector('button.btn-outline-secondary').click()
  assert.equal(creates.length, 1)
})
