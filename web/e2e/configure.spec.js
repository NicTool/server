import { expect, test } from '@playwright/test'

// Drives the real configure.html against mocked /nt/* endpoints. Covers the
// three-card flow: install type, API service, data store.

// Mutable per-test state rather than re-registering routes: two handlers for the
// same pattern make precedence ambiguous.
let apiRunning
let posted
let serviceCalls
let startFails
let runningStore
let savedStore

test.beforeEach(async ({ page }) => {
  apiRunning = false
  posted = null
  serviceCalls = []
  startFails = null
  savedStore = null
  runningStore = 'file:///var/lib/nictool'

  await page.route('**/nt/config', async (route) => {
    if (route.request().method() === 'GET') {
      const json = { _hostname: 'nt.example.com', _suggested: { api: 4321 } }
      if (savedStore) json.store = savedStore
      return route.fulfill({ json })
    }
    posted = route.request().postDataJSON()
    await route.fulfill({ json: { ok: true } })
  })

  await page.route('**/nt/service', async (route) => {
    if (route.request().method() === 'GET') {
      const api = { running: apiRunning }
      if (apiRunning)
        Object.assign(api, { mode: 'in_process', pid: 50495, store: runningStore })
      return route.fulfill({ json: { api } })
    }
    const body = route.request().postDataJSON()
    serviceCalls.push(body)
    if (body.action === 'start' && startFails) {
      return route.fulfill({ status: 500, json: { error: startFails } })
    }
    apiRunning = body.action === 'start'
    if (apiRunning) runningStore = 'file://' + body.store.path
    await route.fulfill({ json: { running: apiRunning } })
  })

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
      'Data Store',
    ])
    await expect(page.locator('#api-status')).toHaveText('not started')
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

  test('the API status reflects /nt/service on load', async ({ page }) => {
    apiRunning = true
    await page.goto('/configure.html')

    await expect(page.locator('#api-status')).toHaveText('running')
    await expect(page.locator('#api-status')).toHaveClass(/\bok\b/)
    await expect(page.locator('#btn-api-toggle')).toHaveText('Stop API')
  })

  test('the toggle is offered for local modes only', async ({ page }) => {
    await page.goto('/configure.html')
    await expect(page.locator('#btn-api-toggle')).toBeVisible()

    await page.selectOption('#api-mode', 'tcp')
    await expect(page.locator('#btn-api-toggle')).toBeVisible()

    await page.selectOption('#api-mode', 'remote')
    await expect(page.locator('#btn-api-toggle')).toBeHidden()
  })

  test('the toggle stays disabled until the store is usable', async ({ page }) => {
    await page.goto('/configure.html')
    await expect(page.locator('#btn-api-toggle')).toBeDisabled()
    await expect(page.locator('#n-api-toggle')).toContainText('Finish the settings')

    await page.fill('#store-path', '/var/lib/nictool')
    await expect(page.locator('#btn-api-toggle')).toBeEnabled()
  })

  test('the toggle starts the API with the current store and api settings', async ({
    page,
  }) => {
    await page.goto('/configure.html')
    await page.fill('#store-path', '/var/lib/nictool')
    await page.click('#btn-api-toggle')

    await expect(page.locator('#api-status')).toHaveText('running')
    await expect(page.locator('#api-status')).toHaveClass(/\bok\b/)

    expect(serviceCalls).toHaveLength(1)
    expect(serviceCalls[0].action).toBe('start')
    expect(serviceCalls[0].api.mode).toBe('in_process')
    expect(serviceCalls[0].store).toMatchObject({
      type: 'json',
      path: '/var/lib/nictool',
    })
  })

  test('a running API reports the store it loaded from api.json', async ({ page }) => {
    apiRunning = true
    runningStore = 'mysql://nictool:***@127.0.0.1:3306/nictool'

    await page.goto('/configure.html')

    await expect(page.locator('#n-api-detail')).toHaveText(
      'pid: 50495, store: mysql://nictool:***@127.0.0.1:3306/nictool',
    )
  })

  test('a running API freezes the store fields', async ({ page }) => {
    apiRunning = true
    await page.goto('/configure.html')

    await expect(page.locator('#store-type')).toBeDisabled()
    await expect(page.locator('#store-path')).toBeDisabled()
    await expect(page.locator('#n-store-lock')).toContainText('stop it to make changes')

    await page.click('#btn-api-toggle')

    await expect(page.locator('#store-type')).toBeEnabled()
    await expect(page.locator('#store-path')).toBeEnabled()
    await expect(page.locator('#n-store-lock')).toHaveText('')
  })

  test('a store already on disk comes back into the form', async ({ page }) => {
    savedStore = {
      type: 'mysql',
      host: 'db.example.com',
      port: 3306,
      user: 'nictool',
      password: 'secret',
      database: 'nictool',
    }

    await page.goto('/configure.html')

    await expect(page.locator('#store-type')).toHaveValue('mysql')
    await expect(page.locator('#db-host')).toHaveValue('db.example.com')
    await expect(page.locator('#db-user')).toHaveValue('nictool')
    await expect(page.locator('#db-password')).toHaveValue('secret')
    await expect(page.locator('#db-name')).toHaveValue('nictool')
  })

  test('an upgrade probes the schema as soon as the DSN connects', async ({ page }) => {
    let probes = 0
    await page.route('**/nt/detect-schema*', (route) => {
      probes++
      route.fulfill({ json: { ok: true, found: true, version: '2.41' } })
    })

    await page.goto('/configure.html')
    await page.selectOption('#install-type', 'upgrade')
    // No click on the probe button — the connection check drives it.
    await page.fill('#db-dsn', 'mysql://nictool:pw@127.0.0.1:3306/nictool')

    await expect(page.locator('#n-detect')).toContainText('2.41')
    await expect(page.locator('#btn-save')).toBeEnabled()
    expect(probes).toBe(1)
  })

  test('a store that connects but has no schema still blocks an upgrade', async ({
    page,
  }) => {
    await page.route('**/nt/detect-schema*', (route) =>
      route.fulfill({ json: { ok: true, found: false } }),
    )

    await page.goto('/configure.html')
    await page.selectOption('#install-type', 'upgrade')
    await page.fill('#db-dsn', 'mysql://nictool:pw@127.0.0.1:3306/nictool')

    await expect(page.locator('#n-detect')).toContainText('no NicTool schema')
    await expect(page.locator('#save-reason')).toContainText('holding a NicTool schema')
  })

  test('a blocked save says what is missing', async ({ page }) => {
    await page.goto('/configure.html')
    await expect(page.locator('#save-reason')).toContainText('complete the data store')

    await page.fill('#store-path', '/var/lib/nictool')
    await expect(page.locator('#btn-save')).toBeEnabled()
    await expect(page.locator('#save-reason')).toHaveText('')
  })

  test('an upgrade with no connection yet says so', async ({ page }) => {
    await page.goto('/configure.html')
    await page.selectOption('#install-type', 'upgrade')

    await expect(page.locator('#btn-save')).toBeDisabled()
    await expect(page.locator('#save-reason')).toContainText(
      'connect to the 2.x database',
    )
  })

  test('the toggle stops a running API', async ({ page }) => {
    apiRunning = true
    await page.goto('/configure.html')
    await expect(page.locator('#btn-api-toggle')).toHaveText('Stop API')

    await page.click('#btn-api-toggle')

    await expect(page.locator('#api-status')).toHaveText('not started')
    await expect(page.locator('#api-status')).not.toHaveClass(/\b(ok|err)\b/)
    expect(serviceCalls).toEqual([{ action: 'stop' }])
  })

  test('a failed start turns the state red and reports why', async ({ page }) => {
    startFails = 'ECONNREFUSED 127.0.0.1:3306'

    await page.goto('/configure.html')
    await page.fill('#store-path', '/var/lib/nictool')
    await page.click('#btn-api-toggle')

    await expect(page.locator('#api-status')).toHaveText('failed')
    await expect(page.locator('#api-status')).toHaveClass(/\berr\b/)
    await expect(page.locator('#n-api-detail')).toHaveText(startFails)
    await expect(page.locator('#n-api-detail')).toHaveClass(/\berr\b/)
    await expect(page.locator('#btn-api-toggle')).toHaveText('Start API')
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
