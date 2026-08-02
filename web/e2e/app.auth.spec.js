import { expect, test } from '@playwright/test'

const json = (route, body) =>
  route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) })

// The navbar is a sibling of #loggedInMain rather than a child, so nothing about
// showing the login form hides it on its own.
test.describe('logged out', () => {
  test('shows the login form without the tabs or the profile menu', async ({ page }) => {
    await page.route('**/nt/config', (r) => json(r, {}))
    await page.goto('/')

    await expect(page.locator('#login_div')).toBeVisible()
    await expect(page.locator('#mainTabs')).toBeHidden()
    await expect(page.locator('#profileMenu')).toBeHidden()
    await expect(page.locator('#logout_button')).toBeHidden()
  })

  test('an expired token falls back to the login form, still without menus', async ({
    page,
  }) => {
    await page
      .context()
      .addCookies([{ name: 'nt-token', value: 'stale', url: 'http://localhost:5175' }])
    await page.route('**/nt/config', (r) => json(r, {}))
    await page.route(/\/api\/session/, (r) =>
      json(r, { error: true, message: 'Token expired' }),
    )

    await page.goto('/')

    await expect(page.locator('#login_div')).toBeVisible()
    await expect(page.locator('#mainTabs')).toBeHidden()
    await expect(page.locator('#profileMenu')).toBeHidden()
  })

  test('logging in reveals the tabs and the profile menu', async ({ page }) => {
    await page
      .context()
      .addCookies([
        { name: 'nt-token', value: 'test-token', url: 'http://localhost:5175' },
      ])
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
    await page.route(/\/api\/zone\?/, (r) =>
      json(r, {
        zone: [],
        meta: { pagination: { total: 0, filtered: 0, limit: 50, offset: 0 } },
      }),
    )

    await page.goto('/')

    await expect(page.locator('#login_div')).toBeHidden()
    await expect(page.locator('#mainTabs')).toBeVisible()
    await expect(page.locator('#profileMenu')).toBeVisible()
  })
})
