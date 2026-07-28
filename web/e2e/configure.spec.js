import { expect, test } from '@playwright/test'

// Drives the real configure.html against mocked /nt/* endpoints. Covers the
// four-card flow: install type, API location, API status, data store.

// Mutable per-test state rather than re-registering routes: two handlers for the
// same pattern make precedence ambiguous.
let apiRunning
let posted

test.beforeEach(async ({ page }) => {
  apiRunning = false
  posted = null

  await page.route('**/nt/config', async (route) => {
    if (route.request().method() === 'GET') {
      return route.fulfill({
        json: { _hostname: 'nt.example.com', _suggested: { api: 4321 } },
      })
    }
    posted = route.request().postDataJSON()
    await route.fulfill({ json: { ok: true } })
  })

  await page.route('**/nt/service', (route) =>
    route.fulfill({ json: { api: { running: apiRunning } } }),
  )

  await page.route('**/nt/check-path*', (route) =>
    route.fulfill({ json: { ok: true, exists: true, resolved: '/var/lib/nictool' } }),
  )

  await page.route('**/nt/check-dsn*', (route) => route.fulfill({ json: { ok: true } }))
})

test.describe('configurator flow', () => {
  test('cards appear in the documented order', async ({ page }) => {
    await page.goto('/configure.html')

    await expect(page.locator('.card h2')).toHaveText([
      'Installation',
      'API Service',
      'API Status',
      'Data Store',
      'Nameservers',
    ])
  })

  test('defaults to a new install with a JSON file store', async ({ page }) => {
    const pageErrors = []
    page.on('pageerror', (err) => pageErrors.push(err.message))

    await page.goto('/configure.html')

    await expect(page.locator('#install-type')).toHaveValue('new')
    await expect(page.locator('#store-type')).toHaveValue('json')
    await expect(page.locator('#f-store-path')).toBeVisible()
    await expect(page.locator('#f-store-db')).toBeHidden()
    await expect(page.locator('#upgrade-note')).toBeHidden()
    expect(pageErrors).toEqual([])
  })

  test('TOML remains selectable alongside JSON', async ({ page }) => {
    await page.goto('/configure.html')
    await page.selectOption('#store-type', 'toml')

    await expect(page.locator('#f-store-path')).toBeVisible()
  })

  test('unimplemented backends are visible but disabled', async ({ page }) => {
    await page.goto('/configure.html')

    for (const value of ['sqlite', 'mongodb', 'elasticsearch']) {
      await expect(page.locator(`#store-type option[value="${value}"]`)).toBeDisabled()
    }
  })

  test('choosing upgrade locks the store to MySQL and asks for a schema probe', async ({
    page,
  }) => {
    await page.goto('/configure.html')
    await page.selectOption('#install-type', 'upgrade')

    await expect(page.locator('#upgrade-note')).toBeVisible()
    await expect(page.locator('#store-type')).toHaveValue('mysql')
    await expect(page.locator('#store-type')).toBeDisabled()
    await expect(page.locator('#f-store-db')).toBeVisible()
    // Not yet probed, so saving is still blocked.
    await expect(page.locator('#btn-save')).toBeDisabled()
  })

  test('a successful probe reports the detected version and unblocks save', async ({
    page,
  }) => {
    await page.route('**/nt/detect-schema*', (route) =>
      route.fulfill({
        json: { ok: true, found: true, version: '2.41', tables: ['nt_zone'] },
      }),
    )

    await page.goto('/configure.html')
    await page.selectOption('#install-type', 'upgrade')
    await page.fill('#db-dsn', 'mysql://nictool:pw@127.0.0.1:3306/nictool')
    await page.click('#detect-schema')

    await expect(page.locator('#n-detect')).toContainText('2.41')
    await expect(page.locator('#btn-save')).toBeEnabled()
  })

  test('an empty database fails the probe and keeps save blocked', async ({ page }) => {
    await page.route('**/nt/detect-schema*', (route) =>
      route.fulfill({ json: { ok: true, found: false, tables: [] } }),
    )

    await page.goto('/configure.html')
    await page.selectOption('#install-type', 'upgrade')
    await page.fill('#db-dsn', 'mysql://nictool:pw@127.0.0.1:3306/nictool')
    await page.click('#detect-schema')

    await expect(page.locator('#n-detect')).toContainText('no NicTool schema')
    await expect(page.locator('#btn-save')).toBeDisabled()
  })

  test('tcp mode asks for a port but not a host', async ({ page }) => {
    await page.goto('/configure.html')
    await page.selectOption('#api-mode', 'tcp')

    await expect(page.locator('#api-port')).toBeVisible()
    await expect(page.locator('#api-host')).toBeHidden()
    await expect(page.locator('#download-api-config')).toBeHidden()
  })

  test('remote mode asks for host, port, and offers the drop-in config', async ({
    page,
  }) => {
    await page.goto('/configure.html')
    await page.selectOption('#api-mode', 'remote')

    await expect(page.locator('#api-host')).toBeVisible()
    await expect(page.locator('#api-port')).toBeVisible()
    await expect(page.locator('#download-api-config')).toBeVisible()
  })

  test('in_process mode hides the API connection fields', async ({ page }) => {
    await page.goto('/configure.html')
    await page.selectOption('#api-mode', 'remote')
    await page.selectOption('#api-mode', 'in_process')

    await expect(page.locator('#api-remote-fields')).toBeHidden()
  })

  test('the API status card reflects /nt/service', async ({ page }) => {
    apiRunning = true
    await page.goto('/configure.html')

    await expect(page.locator('#boot-status')).toHaveText('API running')
  })

  test('saving posts install, store and api, then waits for the API', async ({
    page,
  }) => {
    await page.goto('/configure.html')
    await page.fill('#store-path', '/var/lib/nictool')
    await expect(page.locator('#btn-save')).toBeEnabled()

    // The API comes up only after the save, which is what waitForApi polls for.
    apiRunning = true
    await page.click('#btn-save')

    await expect.poll(() => posted).not.toBeNull()
    expect(posted.install).toBe('new')
    expect(posted.store.type).toBe('json')
    expect(posted.store.path).toBe('/var/lib/nictool')
    expect(posted.api.mode).toBe('in_process')
  })

  test('a new MySQL install initializes the schema before saving', async ({ page }) => {
    const calls = []
    await page.route('**/nt/init-schema', async (route) => {
      calls.push(route.request().postDataJSON())
      await route.fulfill({ json: { ok: true, applied: ['01_nt_group.sql'] } })
    })

    await page.goto('/configure.html')
    await page.selectOption('#store-type', 'mysql')
    await page.fill('#db-dsn', 'mysql://nictool:pw@127.0.0.1:3306/nictool')
    await expect(page.locator('#btn-save')).toBeEnabled()

    apiRunning = true
    await page.click('#btn-save')

    await expect.poll(() => calls.length).toBe(1)
    expect(calls[0].install).toBe('new')
    expect(calls[0].dsn).toContain('nictool')
  })

  test('an upgrade never calls init-schema', async ({ page }) => {
    let initCalled = false
    await page.route('**/nt/init-schema', async (route) => {
      initCalled = true
      await route.fulfill({ json: { ok: true, applied: [] } })
    })
    await page.route('**/nt/detect-schema*', (route) =>
      route.fulfill({
        json: { ok: true, found: true, version: '2.41', tables: ['nt_zone'] },
      }),
    )

    await page.goto('/configure.html')
    await page.selectOption('#install-type', 'upgrade')
    await page.fill('#db-dsn', 'mysql://nictool:pw@127.0.0.1:3306/nictool')
    await page.click('#detect-schema')
    await expect(page.locator('#btn-save')).toBeEnabled()

    apiRunning = true
    await page.click('#btn-save')

    await expect.poll(() => posted).not.toBeNull()
    expect(posted.install).toBe('upgrade')
    expect(initCalled).toBe(false)
  })
})
