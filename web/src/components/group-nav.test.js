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

const { GroupNav } = await import('./group-nav.js')

const GROUPS = {
  1: { id: 1, name: 'NicTool', parent_gid: 0 },
  2: { id: 2, name: 'wz-conseil.com', parent_gid: 1 },
  5: { id: 5, name: 'theartfarm.com', parent_gid: 1 },
  10: { id: 10, name: 'sub.theartfarm', parent_gid: 5 },
}
const CHILDREN = { 1: [2, 5], 2: [], 5: [10], 10: [] }

function stubFetch() {
  const calls = []
  globalThis.fetch = async (url) => {
    calls.push(url)
    let m = url.match(/\/group\/(\d+)(\?|$)/)
    if (m) {
      const g = GROUPS[Number(m[1])]
      return { json: async () => ({ group: g ? [g] : [] }) }
    }
    m = url.match(/\/group\?parent_gid=(\d+)/)
    if (m) {
      const kids = (CHILDREN[Number(m[1])] ?? []).map((id) => GROUPS[id])
      return { json: async () => ({ group: kids }) }
    }
    return { json: async () => ({}) }
  }
  return calls
}

async function mount(currentGid = 5) {
  const el = new GroupNav()
  document.body.appendChild(el)
  el.token = 't'
  el.rootGid = 1
  el.currentGid = currentGid
  await el._init()
  await el.updateComplete
  return el
}

const linkTexts = (el) =>
  [...el.querySelectorAll('.nt-group-link')].map((a) => a.textContent.trim())

test('loads the tree and auto-expands the path to the current group', async () => {
  stubFetch()
  const el = await mount(5)

  const links = linkTexts(el)
  assert.ok(links.includes('NicTool'))
  assert.ok(links.includes('theartfarm.com'))
  assert.ok(links.includes('wz-conseil.com'))
  assert.ok(links.includes('sub.theartfarm')) // current's children shown

  const active = el.querySelector('.nt-group-row.active .nt-group-link')
  assert.equal(active.textContent.trim(), 'theartfarm.com')
})

test('shows an expand caret only for groups that have children', async () => {
  stubFetch()
  const el = await mount(5)
  // wz-conseil.com (leaf) has no caret; theartfarm.com (has child) does
  const rows = [...el.querySelectorAll('.nt-group-row')]
  const leaf = rows.find((r) => r.textContent.includes('wz-conseil.com'))
  const parent = rows.find((r) => r.textContent.includes('theartfarm.com'))
  assert.equal(leaf.querySelector('.nt-group-caret'), null)
  assert.ok(parent.querySelector('.nt-group-caret'))
})

test('clicking a group emits group-select in one step', async () => {
  stubFetch()
  const el = await mount(5)
  const picks = []
  el.addEventListener('group-select', (e) => picks.push(e.detail))

  const nictool = [...el.querySelectorAll('.nt-group-link')].find(
    (a) => a.textContent.trim() === 'NicTool',
  )
  nictool.click()
  assert.deepEqual(picks, [{ id: 1, name: 'NicTool' }])
})

test('the root is always expanded and has no caret', async () => {
  stubFetch()
  const el = await mount(5)
  const rootRow = [...el.querySelectorAll('.nt-group-row')].find(
    (r) => r.querySelector('.nt-group-link').textContent.trim() === 'NicTool',
  )
  assert.equal(rootRow.querySelector('.nt-group-caret'), null)
})

test('a caret collapses/expands a child branch', async () => {
  stubFetch()
  const el = await mount(5)
  assert.ok(linkTexts(el).includes('sub.theartfarm'))

  const parent = [...el.querySelectorAll('.nt-group-row')].find((r) =>
    r.querySelector('.nt-group-link').textContent.trim().startsWith('theartfarm'),
  )
  parent.querySelector('.nt-group-caret').click()
  await el.updateComplete
  const links = linkTexts(el)
  assert.ok(!links.includes('sub.theartfarm')) // branch collapsed
  assert.ok(links.includes('theartfarm.com')) // parent still shown
  assert.ok(links.includes('NicTool'))
})

test('clicking empty tree background collapses the sidebar', async () => {
  stubFetch()
  const el = await mount(5)
  const tree = el.querySelector('.nt-group-tree')
  tree.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  await el.updateComplete
  assert.equal(el.querySelector('.nt-group-tree'), null) // collapsed to rail
})

test('collapsing the sidebar hides the tree but keeps the selected name', async () => {
  stubFetch()
  const el = await mount(5)
  assert.ok(el.querySelector('.nt-group-tree'))

  el.querySelector('.nt-group-toggle').click()
  await el.updateComplete
  assert.equal(el.querySelector('.nt-group-tree'), null)
  assert.match(el.textContent, /theartfarm\.com/) // selected name still shown
})
