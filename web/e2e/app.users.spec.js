import { expect, test } from '@playwright/test'

const json = (route, body) =>
  route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) })

function makeStore() {
  return {
    user: [
      {
        id: 1,
        gid: 1,
        username: 'alice',
        first_name: 'Alice',
        last_name: 'Adams',
        email: 'alice@example.com',
        deleted: false,
      },
      {
        id: 2,
        gid: 1,
        username: 'bob',
        first_name: 'Bob',
        last_name: 'Jones',
        email: 'bob@example.com',
        deleted: false,
      },
      {
        id: 3,
        gid: 1,
        username: 'carol',
        first_name: 'Carol',
        last_name: 'King',
        email: 'carol@example.com',
        deleted: false,
      },
    ],
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
  await page.route(/\/api\/zone\?/, (r) =>
    json(r, { zone: [], meta: { pagination: { total: 0, filtered: 0 } } }),
  )
  await page.route(/\/api\/user\/\d+$/, (r) => {
    const id = Number(
      r
        .request()
        .url()
        .match(/\/user\/(\d+)/)[1],
    )
    const rec = store.user.find((u) => u.id === id)
    const method = r.request().method()
    if (rec && method === 'DELETE') rec.deleted = true
    if (rec && method === 'PUT') rec.deleted = false
    return json(r, { user: rec && method !== 'DELETE' ? [rec] : [] })
  })
  await page.route(/\/api\/user(\?|$)/, (r) => {
    const wantDeleted = new URL(r.request().url()).searchParams.get('deleted') === 'true'
    const list = store.user.filter((u) => Boolean(u.deleted) === wantDeleted)
    return json(r, { user: list })
  })
}

async function openUsersTab(page) {
  await page.goto('/')
  await page.locator('#tab-users').click()
  await expect(page.locator('#userTable')).toBeVisible()
}

test.describe('user table', () => {
  test('lists users and filters via search', async ({ page }) => {
    await setupApp(page, makeStore())
    await openUsersTab(page)

    const rows = page.locator('#userTable tbody tr.user-row')
    await expect(rows).toHaveCount(3)

    await page.locator('#userTable input[type="search"]').fill('jones') // Bob Jones
    await expect(rows).toHaveCount(1)
    await expect(rows.first()).toContainText('bob')
  })

  test('delete shows an undo toast and restores', async ({ page }) => {
    await setupApp(page, makeStore())
    page.on('dialog', (d) => d.accept())
    await openUsersTab(page)

    const rows = page.locator('#userTable tbody tr.user-row')
    await rows.first().locator('.user-delete-btn').click()
    await expect(rows).toHaveCount(2)

    const undo = page.locator('#userTable .nt-undo-btn')
    await expect(undo).toBeVisible()
    await undo.click()
    await expect(rows).toHaveCount(3)
    await expect(undo).toHaveCount(0)
  })

  test('edit button opens the offcanvas edit pane', async ({ page }) => {
    await setupApp(page, makeStore())
    await openUsersTab(page)

    await page
      .locator('#userTable tbody tr.user-row')
      .first()
      .locator('.user-edit-btn')
      .click()
    await expect(page.locator('#userEditPane')).toBeVisible()
    await expect(page.locator('#userEditUsername')).toHaveValue('alice')
  })
})
