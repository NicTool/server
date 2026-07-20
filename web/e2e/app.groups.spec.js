import { expect, test } from '@playwright/test'

const json = (route, body) =>
  route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) })

const GROUPS = {
  1: { id: 1, name: 'Test', parent_gid: 0 },
  2: { id: 2, name: 'Child A', parent_gid: 1 },
  3: { id: 3, name: 'Child B', parent_gid: 1 },
  4: { id: 4, name: 'Grandchild', parent_gid: 3 },
}
const CHILDREN = { 1: [2, 3], 2: [], 3: [4], 4: [] }

async function setupApp(page) {
  await page
    .context()
    .addCookies([{ name: 'nt-token', value: 'test-token', url: 'http://localhost:5175' }])
  await page.route('**/nt/config', (r) => json(r, {}))
  await page.route(/\/api\/session/, (r) =>
    json(r, { user: { id: 1, username: 'admin' }, group: { id: 1, name: 'Test' } }),
  )
  await page.route(/\/api\/group\/(\d+)/, (r) => {
    const id = Number(
      r
        .request()
        .url()
        .match(/\/group\/(\d+)/)[1],
    )
    return json(r, { group: GROUPS[id] ? [GROUPS[id]] : [] })
  })
  await page.route(/\/api\/group\?/, (r) => {
    const pid = Number(new URL(r.request().url()).searchParams.get('parent_gid'))
    return json(r, { group: (CHILDREN[pid] ?? []).map((id) => GROUPS[id]) })
  })
  await page.route(/\/api\/nameserver/, (r) => json(r, { nameserver: [] }))
  await page.route(/\/api\/user(\?|$)/, (r) => json(r, { user: [] }))
  await page.route(/\/api\/zone\?/, (r) =>
    json(r, { zone: [], meta: { pagination: { total: 0, filtered: 0 } } }),
  )
  await page.goto('/')
  await expect(page.locator('#groupNav')).toBeVisible()
}

test.describe('group sidebar', () => {
  test('shows the current group and auto-expands its children', async ({ page }) => {
    await setupApp(page)
    const links = page.locator('#groupNav .nt-group-link')
    await expect(links.filter({ hasText: 'Test' })).toBeVisible()
    await expect(links.filter({ hasText: 'Child A' })).toBeVisible()
    await expect(links.filter({ hasText: 'Child B' })).toBeVisible()
    await expect(page.locator('#groupNav .nt-group-row.active')).toContainText('Test')
  })

  test('expands a branch and switches group in one click', async ({ page }) => {
    await setupApp(page)

    // Expand Child B → reveals its grandchild.
    await page
      .locator('#groupNav .nt-group-row', { hasText: 'Child B' })
      .locator('.nt-group-caret')
      .click()
    await expect(
      page.locator('#groupNav .nt-group-link').filter({ hasText: 'Grandchild' }),
    ).toBeVisible()

    // One click on any group navigates there.
    const zoneReqs = []
    page.on(
      'request',
      (r) => /\/api\/zone\?.*gid=2/.test(r.url()) && zoneReqs.push(r.url()),
    )
    await page.locator('#groupNav .nt-group-link').filter({ hasText: 'Child A' }).click()

    await expect(page.locator('#groupNav .nt-group-row.active')).toContainText('Child A')
    expect(zoneReqs.length).toBeGreaterThan(0) // zone table reloaded for the new group
  })

  test('collapses to just the selected group name', async ({ page }) => {
    await setupApp(page)
    await expect(page.locator('#groupNav .nt-group-tree')).toBeVisible()

    await page.locator('#groupNav .nt-group-toggle').click()
    await expect(page.locator('#groupNav .nt-group-tree')).toHaveCount(0)
    await expect(page.locator('#groupNav')).toContainText('Test') // name still visible
  })
})
