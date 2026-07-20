import { expect, test } from '@playwright/test'

test.describe('<nt-dsn-status>', () => {
  test('lights up green when the server confirms the connection', async ({ page }) => {
    await page.route('**/nt/check-dsn**', (route) =>
      route.fulfill({ json: { ok: true } }),
    )

    await page.goto('/')
    await page.fill('#dsn', 'mysql://user:pass@127.0.0.1:3306/nictool')

    const pill = page.locator('#status .pill')
    await expect(pill).toHaveClass(/ok/)
    await expect(pill).toContainText('Connected')
  })

  test('shows the error when the server rejects the connection', async ({ page }) => {
    await page.route('**/nt/check-dsn**', (route) =>
      route.fulfill({ json: { ok: false, error: 'ER_ACCESS_DENIED_ERROR: bad creds' } }),
    )

    await page.goto('/')
    await page.fill('#dsn', 'mysql://user:wrong@127.0.0.1:3306/nictool')

    const pill = page.locator('#status .pill')
    await expect(pill).toHaveClass(/error/)
    await expect(pill).toContainText('bad creds')
  })

  test('stays idle for an incomplete DSN and never probes', async ({ page }) => {
    let probed = false
    await page.route('**/nt/check-dsn**', (route) => {
      probed = true
      return route.fulfill({ json: { ok: true } })
    })

    await page.goto('/')
    await page.fill('#dsn', 'mysql://user@127.0.0.1/')

    await expect(page.locator('#status .pill')).toHaveClass(/idle/)
    expect(probed).toBe(false)
  })
})
