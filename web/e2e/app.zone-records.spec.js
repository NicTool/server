import { expect, test } from '@playwright/test'

const json = (route, body) =>
  route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) })

const ZONE = {
  id: 100,
  zone: 'example.com',
  description: 'primary',
  ttl: 3600,
  mailaddr: 'hostmaster.example.com.',
  serial: 2026011900,
  refresh: 16384,
  retry: 900,
  expire: 1048576,
  minimum: 2560,
}

// Server-side pagination emulated in the mock: honor search/sort/limit/offset
// and report meta.pagination, so the component drives real page/search state.
function makeStore() {
  const records = Array.from({ length: 120 }, (_, i) => ({
    id: 300 + i,
    zid: 100,
    owner: `h${String(i).padStart(3, '0')}.example.com.`,
    type: 'A',
    address: `10.0.0.${i}`,
    ttl: 300,
  }))
  return { records }
}

function page(store, url) {
  const q = new URL(url).searchParams
  const search = (q.get('search') ?? '').toLowerCase()
  const limit = Number(q.get('limit') ?? 50)
  const offset = Number(q.get('offset') ?? 0)
  const dir = q.get('sort_dir') === 'desc' ? -1 : 1
  const wantDeleted = q.get('deleted') === 'true'
  let list = store.records.filter(
    (r) =>
      Boolean(r.deleted) === wantDeleted &&
      (!search || r.owner.toLowerCase().includes(search) || r.address.includes(search)),
  )
  list = [...list].sort((a, b) =>
    a.owner > b.owner ? dir : a.owner < b.owner ? -dir : 0,
  )
  return {
    zone_record: list.slice(offset, offset + limit),
    meta: {
      pagination: { total: store.records.length, filtered: list.length, limit, offset },
    },
  }
}

async function setupApp(page_, store) {
  await page_
    .context()
    .addCookies([{ name: 'nt-token', value: 'test-token', url: 'http://localhost:5175' }])
  await page_.route('**/nt/config', (r) => json(r, {}))
  await page_.route(/\/api\/session/, (r) =>
    json(r, { user: { id: 1, username: 'admin' }, group: { id: 1, name: 'Test' } }),
  )
  await page_.route(/\/api\/group\?/, (r) => json(r, { group: [] }))
  await page_.route(/\/api\/group\/\d+/, (r) =>
    json(r, { group: { id: 1, name: 'Test', parent_gid: 0 } }),
  )
  await page_.route(/\/api\/nameserver/, (r) => json(r, { nameserver: [] }))
  await page_.route(/\/api\/user(\?|$)/, (r) => json(r, { user: [] }))
  await page_.route(/\/api\/zone\?/, (r) =>
    json(r, { zone: [ZONE], meta: { pagination: { total: 1, filtered: 1 } } }),
  )
  await page_.route(/\/api\/zone\/100\/ns/, (r) => json(r, { ns: [] }))
  await page_.route(/\/api\/zone_record\/\d+$/, (r) => {
    const id = Number(
      r
        .request()
        .url()
        .match(/\/zone_record\/(\d+)/)[1],
    )
    const rec = store.records.find((x) => x.id === id)
    const method = r.request().method()
    if (rec && method === 'DELETE') rec.deleted = true
    if (rec && method === 'PUT') rec.deleted = false
    return json(r, { zone_record: rec && method !== 'DELETE' ? [rec] : [] })
  })
  await page_.route(/\/api\/zone_record\?/, (r) =>
    json(r, page(store, r.request().url())),
  )
}

async function openRecordsModal(page_) {
  await expect(page_.locator('#zoneTable tbody tr.zone-row')).toHaveCount(1)
  await page_.locator('#zoneTable tbody tr.zone-row td.zone-disclosure').click()
  await expect(page_.locator('#zoneRecordsModal')).toBeVisible()
}

test.describe('zone records modal', () => {
  test('opens a paginated modal instead of expanding inline', async ({ page }) => {
    const errors = []
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
    await setupApp(page, makeStore())

    await page.goto('/')
    // No inline records table exists anymore.
    await openRecordsModal(page)
    await expect(page.locator('#zone_100_table')).toHaveCount(0)

    const rows = page.locator('#zoneRecordsComponent tbody tr.zone-record-row')
    await expect(rows).toHaveCount(50) // page size
    await expect(
      page.locator('#zoneRecordsComponent tbody tr.zone-record-soa'),
    ).toHaveCount(1)
    await expect(page.getByText('Page 1 of 3')).toBeVisible()
    expect(errors).toEqual([])
  })

  test('paginates to the next page', async ({ page }) => {
    await setupApp(page, makeStore())
    await page.goto('/')
    await openRecordsModal(page)

    const first = page.locator('#zoneRecordsComponent tbody tr.zone-record-row').first()
    await expect(first).toContainText('h000')
    await page.getByRole('button', { name: 'Next ›' }).click()
    await expect(page.getByText('Page 2 of 3')).toBeVisible()
    await expect(first).toContainText('h050')
  })

  test('searches server-side and narrows the result', async ({ page }) => {
    await setupApp(page, makeStore())
    await page.goto('/')
    await openRecordsModal(page)

    await page.locator('#zoneRecordsComponent input[type="search"]').fill('h05')
    // h050..h059 → 10 matches, single page, synthetic rows hidden while searching
    await expect(
      page.locator('#zoneRecordsComponent tbody tr.zone-record-row'),
    ).toHaveCount(10)
    await expect(
      page.locator('#zoneRecordsComponent tbody tr.zone-record-soa'),
    ).toHaveCount(0)
  })

  test('deletes a record in place without a full-table flash', async ({ page }) => {
    const store = makeStore()
    let deleteCalls = 0
    await setupApp(page, store)
    page.on('dialog', (d) => d.accept()) // confirm-deletes is on by default
    page.on('request', (r) => {
      if (r.method() === 'DELETE' && /\/zone_record\/\d+/.test(r.url())) deleteCalls++
    })
    await page.goto('/')
    await openRecordsModal(page)

    const rows = page.locator('#zoneRecordsComponent tbody tr.zone-record-row')
    await expect(rows.first()).toContainText('h000')

    await rows.first().locator('.zr-delete-btn').click()

    // h000 gone; the table stays mounted (same modal), first row is now h001.
    await expect(rows.first()).toContainText('h001')
    expect(deleteCalls).toBe(1)
    expect(store.records.find((r) => r.id === 300).deleted).toBe(true)
  })

  test('shows an undo toast after delete and restores the record', async ({ page }) => {
    const store = makeStore()
    await setupApp(page, store)
    page.on('dialog', (d) => d.accept())
    await page.goto('/')
    await openRecordsModal(page)

    const rows = page.locator('#zoneRecordsComponent tbody tr.zone-record-row')
    await expect(rows.first()).toContainText('h000')
    await rows.first().locator('.zr-delete-btn').click()

    // Undo toast appears; the row is gone from the view.
    const undo = page.locator('#zoneRecordsComponent .nt-undo-btn')
    await expect(undo).toBeVisible()
    await expect(rows.first()).toContainText('h001')

    // Undo restores it and dismisses the toast.
    await undo.click()
    await expect(rows.first()).toContainText('h000')
    await expect(undo).toHaveCount(0)
    expect(store.records.find((r) => r.id === 300).deleted).toBe(false)
  })

  test('Deleted toggle reveals soft-deleted rows and Restore brings them back', async ({
    page,
  }) => {
    const store = makeStore()
    await setupApp(page, store)
    page.on('dialog', (d) => d.accept())
    await page.goto('/')
    await openRecordsModal(page)

    const rows = page.locator('#zoneRecordsComponent tbody tr.zone-record-row')
    await rows.first().locator('.zr-delete-btn').click()
    await expect(rows.first()).toContainText('h001') // h000 soft-deleted, gone from active

    // Show deleted → only h000, with a Restore action (no delete button).
    await page.locator('#zoneRecordsComponent .nt-show-deleted').check()
    await expect(rows).toHaveCount(1)
    await expect(rows.first()).toContainText('h000')
    const restore = page.locator('#zoneRecordsComponent .zr-restore-btn')
    await expect(restore).toBeVisible()

    // Restore empties the deleted view; toggling back shows h000 live again.
    await restore.click()
    await expect(rows).toHaveCount(0)
    expect(store.records.find((r) => r.id === 300).deleted).toBe(false)
    await page.locator('#zoneRecordsComponent .nt-show-deleted').uncheck()
    await expect(rows.first()).toContainText('h000')
  })

  test('clicking a record row opens the edit modal', async ({ page }) => {
    await setupApp(page, makeStore())
    await page.goto('/')
    await openRecordsModal(page)

    await page
      .locator('#zoneRecordsComponent tbody tr.zone-record-row td')
      .first()
      .click()
    await expect(page.locator('#zrEditModal')).toBeVisible()
  })
})
