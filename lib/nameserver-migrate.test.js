// Exercises the real store-backed migration: nameservers carried in an older
// nictool.json move into the data store and are dropped from the bootstrap.
//
// Lives in its own file because the API binds its store backend at module load.
// Setting these env vars must happen before anything imports the repo, and
// node --test gives each file its own process.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, it, after } from 'node:test'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-nsmig-'))
const store = path.join(dir, 'data')

process.env.NICTOOL_CONF_DIR = path.join(dir, 'etc')
process.env.NICTOOL_DATA_STORE = 'json'
process.env.NICTOOL_DATA_STORE_PATH = store

const { writeApiConfig, writeBootstrap, bootstrapPath } = await import('./config.js')
const { migrateNameservers, resolveNameserverConfig } =
  await import('./nameserver-config.js')

after(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

const nameserver = {
  name: 'ns1.example.com.',
  type: 'native',
  listen: [{ address: '127.0.0.1', port: 5353, proto: 'udp' }],
  publisher: { type: 'memory' },
}

describe('nameserver migration into the store', () => {
  it('moves records out of the bootstrap and into the store', async () => {
    await writeApiConfig(dir, { type: 'json', path: store })
    const bootstrap = {
      configured: true,
      api: { mode: 'in_process' },
      nameserver: [nameserver],
    }

    const migrated = await migrateNameservers(dir, bootstrap, writeBootstrap)

    assert.equal(migrated.nameserver, undefined, 'dropped from the returned config')

    const onDisk = JSON.parse(await fsp.readFile(bootstrapPath(dir), 'utf8'))
    assert.equal(onDisk.nameserver, undefined, 'dropped from nictool.json')
    assert.equal(onDisk.configured, true, 'the rest of the bootstrap survives')

    const stored = JSON.parse(
      await fsp.readFile(path.join(store, 'nameserver.json'), 'utf8'),
    )
    assert.equal(stored.nameserver.length, 1)
    assert.equal(stored.nameserver[0].name, nameserver.name)
    assert.deepEqual(stored.nameserver[0].listen, nameserver.listen)
    assert.deepEqual(stored.nameserver[0].publisher, nameserver.publisher)
  })

  it('then serves those records back to the supervisor', async () => {
    const cfg = await resolveNameserverConfig(dir, { configured: true, api: {} })

    assert.equal(cfg.store.type, 'json')
    assert.equal(cfg.nameserver.length, 1)
    assert.equal(cfg.nameserver[0].type, 'native')
  })

  it('does not duplicate on a second run', async () => {
    const bootstrap = { configured: true, api: {}, nameserver: [nameserver] }
    await migrateNameservers(dir, bootstrap, writeBootstrap)

    const stored = JSON.parse(
      await fsp.readFile(path.join(store, 'nameserver.json'), 'utf8'),
    )
    assert.equal(stored.nameserver.length, 1, 'matched on name, not appended again')
  })

})
