import { expect, test } from '@playwright/test'

const json = (route, body) =>
  route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) })

function makeStore(n = 120) {
  return {
    zones: Array.from({ length: n }, (_, i) => ({
      id: 300 + i,
      gid: 1,
      zone: `z${String(i).padStart(3, '0')}.example.com`,
      description: `zone ${i}`,
      ttl: 3600,
      mailaddr: 'hostmaster.example.com.',
      deleted: false,
    })),
  }
}

function zonePage(store, url) {
  const q = new URL(url).searchParams
  const wantDeleted = q.get('deleted') === 'true'
  const search = (q.get('search') ?? '').toLowerCase()
  const limit = Number(q.get('limit') ?? 50)
  const offset = Number(q.get('offset') ?? 0)
  const dir = q.get('sort_dir') === 'desc' ? -1 : 1
  const scoped = store.zones.filter((z) => Boolean(z.deleted) === wantDeleted)
  let list = scoped.filter((z) => !search || z.zone.toLowerCase().includes(search))
  list = [...list].sort((a, b) => (a.zone > b.zone ? dir : a.zone < b.zone ? -dir : 0))
  return {
    zone: list.slice(offset, offset + limit),
    meta: { pagination: { total: scoped.length, filtered: list.length, limit, offset } },
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
  await page.route(/\/api\/nameserver/, (r) => json(r, { nameserver: [] }))
  await page.route(/\/api\/user(\?|$)/, (r) => json(r, { user: [] }))
  await page.route(/\/api\/zone\/\d+\/ns/, (r) => json(r, { ns: [] }))
  await page.route(/\/api\/zone_record\?/, (r) =>
    json(r, {
      zone_record: [],
      meta: { pagination: { total: 0, filtered: 0, limit: 50, offset: 0 } },
    }),
  )
  await page.route(/\/api\/zone\/\d+$/, (r) => {
    const id = Number(
      r
        .request()
        .url()
        .match(/\/zone\/(\d+)/)[1],
    )
    const z = store.zones.find((x) => x.id === id)
    const method = r.request().method()
    if (z && method === 'DELETE') z.deleted = true
    if (z && method === 'PUT') z.deleted = false
    return json(r, { zone: z && method !== 'DELETE' ? [z] : [] })
  })
  await page.route(/\/api\/zone\?/, (r) => json(r, zonePage(store, r.request().url())))
  await page.goto('/')
  await expect(page.locator('#zoneTable')).toBeVisible()
}

test.describe('zone table', () => {
  test('lists a page of zones with a pager', async ({ page }) => {
    await setupApp(page, makeStore(120))
    await expect(page.locator('#zoneTable tbody tr.zone-row')).toHaveCount(50)
    await expect(page.getByText('Page 1 of 3')).toBeVisible()
  })

  test('shows a filtered-from-total summary when searching', async ({ page }) => {
    await setupApp(page, makeStore(120))
    await expect(page.getByText('Showing 1 to 50 of 120 entries')).toBeVisible()

    await page.locator('#zoneTable input[type="search"]').fill('z05')
    await expect(page.getByText('Showing 1 to 10 of 10 entries')).toBeVisible()
    await expect(page.getByText('(filtered from 120 total entries)')).toBeVisible()
  })

  test('paginates to the next page', async ({ page }) => {
    await setupApp(page, makeStore(120))
    const first = page.locator('#zoneTable tbody tr.zone-row td.zone-name-toggle').first()
    await expect(first).toHaveText('z000.example.com')
    await page.getByRole('button', { name: 'Next ›' }).click()
    await expect(page.getByText('Page 2 of 3')).toBeVisible()
    await expect(first).toHaveText('z050.example.com')
  })

  test('clicking a zone opens its records modal', async ({ page }) => {
    await setupApp(page, makeStore(3))
    await page.locator('#zoneTable tbody tr.zone-row td.zone-name-toggle').first().click()
    await expect(page.locator('#zoneRecordsModal')).toBeVisible()
  })

  test('delete shows an undo toast and restores', async ({ page }) => {
    await setupApp(page, makeStore(3))
    page.on('dialog', (d) => d.accept())
    const rows = page.locator('#zoneTable tbody tr.zone-row')
    await rows.first().locator('.zone-delete-btn').click()
    await expect(rows).toHaveCount(2)
    const undo = page.locator('#zoneTable .nt-undo-btn')
    await expect(undo).toBeVisible()
    await undo.click()
    await expect(rows).toHaveCount(3)
  })

  test('create and edit open their modals', async ({ page }) => {
    await setupApp(page, makeStore(3))
    await page
      .locator('#zoneTable button.btn-outline-secondary', { hasText: '+ Create' })
      .click()
    await expect(page.locator('#zoneCreateModal')).toBeVisible()
    await page.locator('#zoneCreateModal [data-bs-dismiss="modal"]').first().click()
    await expect(page.locator('#zoneCreateModal')).toBeHidden()

    await page
      .locator('#zoneTable tbody tr.zone-row')
      .first()
      .locator('.zone-edit-btn')
      .click()
    await expect(page.locator('#zoneEditModal')).toBeVisible()
  })
})
