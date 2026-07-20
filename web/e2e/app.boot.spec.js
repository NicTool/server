import { expect, test } from '@playwright/test'

test.describe('app boot', () => {
  test('bundled app loads and shows the login screen', async ({ page }) => {
    const pageErrors = []
    page.on('pageerror', (err) => pageErrors.push(err.message))

    await page.goto('/')

    // With no session cookie, onLoad() reveals the login form.
    await expect(page.locator('#login_div')).toBeVisible()
    await expect(page.locator('#loggedInMain')).toBeHidden()

    // No uncaught errors from the bundle executing.
    expect(pageErrors).toEqual([])
  })

  test('bundled RR populates the record-type select', async ({ page }) => {
    await page.goto('/')

    // populateZrEditType() runs at boot and fills #zrEditType from the bundled
    // dns-resource-record library — proof the RR import bundled and executed.
    const options = page.locator('#zrEditType option')
    await expect.poll(() => options.count()).toBeGreaterThan(5)
    await expect(page.locator('#zrEditType')).toContainText('A')
  })
})
