import { expect, test } from '@playwright/test'

const json = (route, body) =>
  route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) })

function makeStore() {
  return {
    nameserver: Array.from({ length: 3 }, (_, i) => ({
      id: i + 1,
      gid: 1,
      name: `ns${i + 1}.example.com.`,
      description: `NS ${i + 1}`,
      address: `10.0.0.${i + 1}`,
      address6: '',
      export: { type: 'bind' },
      deleted: false,
    })),
  }
}

async function setupApp(page, store) {
  await page
    .context()
    .addCookies([{ name: 'nt-token', value: 'test-token', url: 'http://localhost:5175' }])
  await page.route('**/nt/config', (r) => json(r, {}))
  await page.route(/\/api\/session/, (r) =>
    json(r, { user: { id: 1, username: 'admin' }, group: { id: 1, name: 'Test' } }),
  )
  await page.route(/\/api\/group\?/, (r) => json(r, { group: [] }))
  await page.route(/\/api\/group\/\d+/, (r) =>
    json(r, { group: { id: 1, name: 'Test', parent_gid: 0 } }),
  )
  await page.route(/\/api\/user(\?|$)/, (r) => json(r, { user: [] }))
  await page.route(/\/api\/zone\?/, (r) =>
    json(r, { zone: [], meta: { pagination: { total: 0, filtered: 0 } } }),
  )
  await page.route(/\/api\/nameserver\/\d+$/, (r) => {
    const id = Number(
      r
        .request()
        .url()
        .match(/\/nameserver\/(\d+)/)[1],
    )
    const rec = store.nameserver.find((n) => n.id === id)
    const method = r.request().method()
    if (rec && method === 'DELETE') rec.deleted = true
    if (rec && method === 'PUT') rec.deleted = false
    return json(r, { nameserver: rec && method !== 'DELETE' ? [rec] : [] })
  })
  await page.route(/\/api\/nameserver\?/, (r) => {
    const wantDeleted = new URL(r.request().url()).searchParams.get('deleted') === 'true'
    const list = store.nameserver.filter((n) => Boolean(n.deleted) === wantDeleted)
    return json(r, { nameserver: list })
  })
}

async function openNsTab(page) {
  await page.goto('/')
  await page.locator('#tab-nameservers').click()
  await expect(page.locator('#nsTable')).toBeVisible()
}

test.describe('nameserver table', () => {
  test('lists nameservers and filters via search', async ({ page }) => {
    await setupApp(page, makeStore())
    await openNsTab(page)

    const rows = page.locator('#nsTable tbody tr.ns-row')
    await expect(rows).toHaveCount(3)

    await page.locator('#nsTable input[type="search"]').fill('ns2')
    await expect(rows).toHaveCount(1)
    await expect(rows.first()).toContainText('ns2.example.com.')
  })

  test('delete shows an undo toast and restores', async ({ page }) => {
    await setupApp(page, makeStore())
    page.on('dialog', (d) => d.accept())
    await openNsTab(page)

    const rows = page.locator('#nsTable tbody tr.ns-row')
    await rows.first().locator('.ns-delete-btn').click()
    await expect(rows).toHaveCount(2)

    const undo = page.locator('#nsTable .nt-undo-btn')
    await expect(undo).toBeVisible()
    await undo.click()
    await expect(rows).toHaveCount(3)
    await expect(undo).toHaveCount(0)
  })

  test('Deleted toggle reveals deleted rows with Restore', async ({ page }) => {
    const store = makeStore()
    store.nameserver[0].deleted = true
    await setupApp(page, store)
    await openNsTab(page)

    const rows = page.locator('#nsTable tbody tr.ns-row')
    await expect(rows).toHaveCount(2) // active only

    await page.locator('#nsTable .nt-show-deleted').check()
    await expect(rows).toHaveCount(1)
    await expect(
      page.locator('#nsTable .zr-restore-btn, #nsTable .ns-restore-btn'),
    ).toBeVisible()
  })

  test('edit button opens the offcanvas edit pane', async ({ page }) => {
    await setupApp(page, makeStore())
    await openNsTab(page)

    await page.locator('#nsTable tbody tr.ns-row').first().locator('.ns-edit-btn').click()
    await expect(page.locator('#nsEditPane')).toBeVisible()
    await expect(page.locator('#nsEditName')).toHaveValue('ns1.example.com.')
  })
})
