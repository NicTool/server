import { expect, test } from '@playwright/test'

const json = (route, body) =>
  route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) })

let saved
let nameservers
let store

async function setup(page) {
  saved = null
  nameservers = []
  store = { type: 'json', path: '/var/lib/nictool' }

  await page
    .context()
    .addCookies([{ name: 'nt-token', value: 't', url: 'http://localhost:5175' }])
  await page.route('**/nt/config', (r) => json(r, { store }))
  await page.route(/\/api\/session/, (r) =>
    json(r, { user: { id: 1, username: 'admin' }, group: { id: 1, name: 'Test' } }),
  )
  await page.route(/\/api\/group\?/, (r) => json(r, { group: [] }))
  await page.route(/\/api\/group\/\d+/, (r) =>
    json(r, { group: { id: 1, name: 'Test', parent_gid: 0 } }),
  )
  await page.route(/\/api\/user(\?|$)/, (r) => json(r, { user: [] }))
  await page.route(/\/api\/zone\?/, (r) =>
    json(r, {
      zone: [],
      meta: { pagination: { total: 0, filtered: 0, limit: 50, offset: 0 } },
    }),
  )
  await page.route(/\/api\/nameserver/, async (r) => {
    if (r.request().method() === 'GET') {
      return json(r, {
        nameserver: nameservers,
        meta: { pagination: { total: nameservers.length, filtered: nameservers.length } },
      })
    }
    saved = r.request().postDataJSON()
    return json(r, { nameserver: [{ id: 1, ...saved }] })
  })

  await page.goto('/')
  await page.locator('#tab-nameservers').click()
}

const openCreate = async (page) => {
  await page.locator('#nsTable').getByRole('button', { name: '+ Create' }).click()
  await expect(page.locator('#nsEditPane')).toBeVisible()
}

/** Fill the always-required fields so a test can focus on one thing. */
async function fillBasics(page) {
  await page.fill('#nsEditName', 'ns1.example.com.')
  await page.fill('#nsEditAddress', '192.0.2.1')
}

test.describe('nameserver form', () => {
  test('offers every type, and only publishers that type can read', async ({ page }) => {
    await setup(page)
    await openCreate(page)

    const types = await page.locator('#nsEditType option').allTextContents()
    expect(types.length).toBe(8)

    await page.selectOption('#nsEditType', 'maradns')
    let publishers = await page
      .locator('#nsEditPublisher option')
      .evaluateAll((els) => els.map((e) => e.value))
    // MaraDNS reads csv2; offering rfc1035 here would fail at start().
    expect(publishers).toContain('maradns')
    expect(publishers).not.toContain('rfc1035')

    await page.selectOption('#nsEditType', 'coredns')
    publishers = await page
      .locator('#nsEditPublisher option')
      .evaluateAll((els) => els.map((e) => e.value))
    expect(publishers).toEqual(['rfc1035', 'coredns-redis', 'none'])
  })

  test('switching type replaces a publisher the new type cannot use', async ({
    page,
  }) => {
    await setup(page)
    await openCreate(page)

    await page.selectOption('#nsEditType', 'coredns')
    await page.selectOption('#nsEditPublisher', 'coredns-redis')
    await expect(page.locator('#nsEditPublisher')).toHaveValue('coredns-redis')

    await page.selectOption('#nsEditType', 'bind')
    await expect(page.locator('#nsEditPublisher')).toHaveValue('rfc1035')
  })

  test('shows only the fields the chosen publisher needs', async ({ page }) => {
    await setup(page)
    await openCreate(page)

    // bind + rfc1035: a path, no Redis or DSN.
    await expect(page.locator('[data-field="path"]')).toBeVisible()
    await expect(page.locator('[data-field="address"]')).toBeHidden()
    await expect(page.locator('[data-field="dsn"]')).toBeHidden()

    await page.selectOption('#nsEditType', 'coredns')
    await page.selectOption('#nsEditPublisher', 'coredns-redis')
    await expect(page.locator('[data-field="address"]')).toBeVisible()
    await expect(page.locator('[data-field="path"]')).toBeHidden()

    await page.selectOption('#nsEditType', 'powerdns')
    await page.selectOption('#nsEditPublisher', 'powerdns-db')
    await expect(page.locator('[data-field="dsn"]')).toBeVisible()
    await expect(page.locator('[data-field="domainType"]')).toBeVisible()
  })

  test('native asks for listen sockets and nothing else', async ({ page }) => {
    await setup(page)
    await openCreate(page)
    await page.selectOption('#nsEditType', 'native')

    await expect(page.locator('#nsEditListenSection')).toBeVisible()
    await expect(page.locator('#nsEditListenBody tr')).toHaveCount(1)
    await expect(page.locator('#nsEditPublisher')).toHaveValue('memory')
    await expect(page.locator('[data-field="path"]')).toBeHidden()

    await page.locator('#nsEditAddListen').click()
    await expect(page.locator('#nsEditListenBody tr')).toHaveCount(2)

    await page.locator('#nsEditListenBody tr').first().getByRole('button').click()
    await expect(page.locator('#nsEditListenBody tr')).toHaveCount(1)
  })

  test('blocks saving until the required fields are there', async ({ page }) => {
    await setup(page)
    await openCreate(page)

    await expect(page.locator('#nsEditSaveBtn')).toBeDisabled()
    await expect(page.locator('#nsEditErrors')).toContainText('Name is required')

    await page.fill('#nsEditName', 'ns1.example.com')
    await expect(page.locator('#nsEditErrors')).toContainText('ending in a dot')

    await page.fill('#nsEditName', 'ns1.example.com.')
    await page.fill('#nsEditAddress', '192.0.2.1')
    await page.fill('#nsPubPath', '/etc/bind/zones')
    await expect(page.locator('#nsEditSaveBtn')).toBeEnabled()
    await expect(page.locator('#nsEditErrors')).toBeHidden()
  })

  test('requires a remote for rsync and a target for AXFR', async ({ page }) => {
    await setup(page)
    await openCreate(page)
    await fillBasics(page)
    await page.fill('#nsPubPath', '/etc/bind/zones')

    await page.selectOption('#nsEditTransport', 'rsync')
    await expect(page.locator('#nsEditErrors')).toContainText('rsync needs a remote')
    await page.fill('#nsTrRemote', 'bind@ns1:/etc/bind/zones')
    await expect(page.locator('#nsEditSaveBtn')).toBeEnabled()

    await page.selectOption('#nsEditTransport', 'axfr')
    await expect(page.locator('#nsEditErrors')).toContainText('notify target')
    await page.fill('#nsTrNotify', '192.0.2.53')
    await expect(page.locator('#nsEditSaveBtn')).toBeEnabled()
  })

  test('signs bind zone files here, and says so', async ({ page }) => {
    await setup(page)
    await openCreate(page)
    await fillBasics(page)
    await page.fill('#nsPubPath', '/etc/bind/zones')

    await expect(page.locator('#nsEditDnssec')).toBeEnabled()
    await page.locator('#nsEditDnssec').check()

    await expect(page.locator('#nsEditDnssecHelp')).toContainText('dnssec-signzone')
    await expect(page.locator('#nsDsAlgorithm')).toBeVisible()
    // Signing here means keys live here.
    await expect(page.locator('[data-dnssec="keyset"]')).toBeVisible()
    await expect(page.locator('#nsEditSaveBtn')).toBeEnabled()

    await page.fill('#nsDsKeyset', '/var/lib/nictool/dnssec')
    await page.selectOption('#nsDsAlgorithm', 'ED25519')
    await page.locator('#nsDsNsec3').check()
    await page.locator('#nsEditSaveBtn').click()

    await expect.poll(() => saved).not.toBeNull()
    expect(saved.dnssec).toEqual({
      enabled: true,
      nsec3: true,
      algorithm: 'ED25519',
      keyset: '/var/lib/nictool/dnssec',
    })
  })

  test('leaves knot to sign for itself, with no key directory to fill in', async ({
    page,
  }) => {
    await setup(page)
    await openCreate(page)
    await fillBasics(page)
    await page.selectOption('#nsEditType', 'knot')
    await page.fill('#nsPubPath', '/etc/knot/zones')

    await page.locator('#nsEditDnssec').check()
    await expect(page.locator('#nsEditDnssecHelp')).toContainText('signs its own zones')
    // Knot keeps its own keys, so asking for a directory would be a lie.
    await expect(page.locator('[data-dnssec="keyset"]')).toBeHidden()
    await expect(page.locator('#nsEditSaveBtn')).toBeEnabled()
  })

  test('cannot enable DNSSEC on a type that has none', async ({ page }) => {
    await setup(page)
    await openCreate(page)
    await fillBasics(page)

    for (const type of ['djbdns', 'maradns']) {
      await page.selectOption('#nsEditType', type)
      await expect(page.locator('#nsEditDnssec')).toBeDisabled()
      await expect(page.locator('#nsEditDnssecHelp')).toContainText('Not available')
    }
  })

  test('cannot sign a publisher that writes no zone files', async ({ page }) => {
    await setup(page)
    await openCreate(page)
    await fillBasics(page)

    await page.selectOption('#nsEditType', 'coredns')
    await page.fill('#nsPubPath', '/etc/coredns/zones')
    await page.locator('#nsEditDnssec').check()
    await expect(page.locator('#nsEditDnssec')).toBeChecked()

    // Redis holds rows, not zone files, so there is nothing to sign.
    await page.selectOption('#nsEditPublisher', 'coredns-redis')
    await expect(page.locator('#nsEditDnssec')).toBeDisabled()
    await expect(page.locator('#nsEditDnssecHelp')).toContainText('only zone files')
  })

  test('warns that interval 0 over MySQL publishes once', async ({ page }) => {
    await setup(page)
    store = { type: 'mysql', host: '127.0.0.1' }
    await page.reload()
    await page.locator('#tab-nameservers').click()
    await openCreate(page)
    await fillBasics(page)
    await page.fill('#nsPubPath', '/etc/bind/zones')

    await page.fill('#nsTrInterval', '0')
    await expect(page.locator('#nsEditWarnings')).toContainText('publish once at startup')

    await page.fill('#nsTrInterval', '300')
    await expect(page.locator('#nsEditWarnings')).toBeHidden()
  })

  test('warns that PowerDNS at NATIVE has no transfer to trigger', async ({ page }) => {
    await setup(page)
    await openCreate(page)
    await fillBasics(page)

    await page.selectOption('#nsEditType', 'powerdns')
    // rfc1035 is valid for powerdns too, so switching type keeps it; the
    // database publisher is a deliberate choice.
    await page.selectOption('#nsEditPublisher', 'powerdns-db')
    await page.fill('#nsPubDsn', 'mysql://u:p@127.0.0.1/pdns')
    await page.selectOption('#nsEditTransport', 'axfr')
    await page.fill('#nsTrNotify', '192.0.2.53')

    await expect(page.locator('#nsEditWarnings')).toContainText(
      'NATIVE does not replicate',
    )
    await page.selectOption('#nsPubDomainType', 'MASTER')
    await expect(page.locator('#nsEditWarnings')).toBeHidden()
  })

  test('a pull nameserver publishes nothing and sends nothing', async ({ page }) => {
    await setup(page)
    await openCreate(page)
    await fillBasics(page)

    await page.selectOption('#nsEditPublisher', 'none')
    // Nothing was published, so there is nothing to deliver.
    await expect(page.locator('#nsEditTransport')).toHaveValue('pull')
    await expect(page.locator('[data-field="path"]')).toBeHidden()
    await expect(page.locator('[data-field="pullSource"]')).toBeVisible()

    await page.fill('#nsTrPullSource', 'fetchzone from cron')
    await page.locator('#nsEditSaveBtn').click()

    await expect.poll(() => saved).not.toBeNull()
    expect(saved.publisher).toEqual({ type: 'none' })
    expect(saved.transport.type).toBe('pull')
    expect(saved.transport.source).toBe('fetchzone from cron')
  })

  test('saves the full runtime config, not just the 2.x fields', async ({ page }) => {
    await setup(page)
    await openCreate(page)
    await fillBasics(page)

    await page.selectOption('#nsEditType', 'bind')
    await page.fill('#nsPubPath', '/etc/bind/zones')
    await page.selectOption('#nsEditTransport', 'axfr')
    await page.fill('#nsTrNotify', '192.0.2.53, 192.0.2.54:5353')
    await page.fill('#nsTrInterval', '600')

    await page.locator('#nsEditSaveBtn').click()
    await expect.poll(() => saved).not.toBeNull()

    expect(saved.type).toBe('bind')
    expect(saved.publisher).toEqual({ type: 'rfc1035', path: '/etc/bind/zones' })
    expect(saved.transport.type).toBe('axfr')
    expect(saved.transport.notify).toEqual(['192.0.2.53', '192.0.2.54:5353'])
    expect(saved.transport.interval).toBe(600)
    expect(saved.gid).toBe(1)
  })

  test('reopens an existing record with its settings intact', async ({ page }) => {
    await setup(page)
    nameservers = [
      {
        id: 4,
        gid: 1,
        name: 'ns9.example.com.',
        ttl: 3600,
        address: '192.0.2.9',
        type: 'coredns',
        publisher: { type: 'coredns-redis', address: 'redis.internal:6379' },
        transport: { type: 'rsync', remote: 'x@y:/z', interval: 120 },
      },
    ]
    await page.reload()
    await page.locator('#tab-nameservers').click()
    await page.locator('#nsTable').locator('.ns-edit-btn').first().click()

    await expect(page.locator('#nsEditPane')).toBeVisible()
    await expect(page.locator('#nsEditName')).toHaveValue('ns9.example.com.')
    await expect(page.locator('#nsEditType')).toHaveValue('coredns')
    await expect(page.locator('#nsEditPublisher')).toHaveValue('coredns-redis')
    await expect(page.locator('#nsPubAddress')).toHaveValue('redis.internal:6379')
    await expect(page.locator('#nsEditTransport')).toHaveValue('rsync')
    await expect(page.locator('#nsTrInterval')).toHaveValue('120')
  })
})
