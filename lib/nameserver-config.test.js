import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, it, beforeEach, after } from 'node:test'

import { apiConfigPath, writeApiConfig, writeBootstrap, bootstrapPath } from './config.js'
import {
  migrateNameservers,
  resolveNameserverConfig,
  runnableHere,
} from './nameserver-config.js'

describe('nameserver config', () => {
  const tmpDirs = []
  let dir

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-nscfg-'))
    tmpDirs.push(dir)
  })

  after(() => {
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true })
  })

  const nameserver = {
    name: 'ns1.example.com.',
    engine: 'native',
    listen: [{ address: '127.0.0.1', port: 5353, proto: 'udp' }],
  }

  describe('runnableHere', () => {
    it('keeps only records with listen sockets', () => {
      // A NicTool install lists every nameserver it knows about; most are
      // export targets running on other hosts.
      const kept = runnableHere([
        nameserver,
        { name: 'ns2.example.com.', address: '192.0.2.2' },
        { name: 'ns3.example.com.', listen: [] },
      ])

      assert.deepEqual(
        kept.map((n) => n.name),
        ['ns1.example.com.'],
      )
    })

    it('is empty when nothing is configured to run locally', () => {
      assert.deepEqual(runnableHere([{ name: 'ns9.example.com.' }]), [])
    })
  })

  describe('resolveNameserverConfig', () => {
    it('pairs the store connection with the nameserver records', async () => {
      await writeApiConfig(dir, { type: 'json', path: path.join(dir, 'data') })

      const cfg = await resolveNameserverConfig(dir, { nameserver: [nameserver] })

      assert.equal(cfg.store.type, 'json')
      assert.equal(cfg.nameserver.length, 1)
    })

    it('reports no store when the API has not been configured', async () => {
      const cfg = await resolveNameserverConfig(dir, { nameserver: [nameserver] })

      assert.equal(cfg.store, null)
      assert.deepEqual(cfg.nameserver, [nameserver], 'carried records are still returned')
    })

    it('yields an empty list when nothing is configured anywhere', async () => {
      const cfg = await resolveNameserverConfig(dir, null)

      assert.deepEqual(cfg.nameserver, [])
    })
  })

  describe('migrateNameservers', () => {
    it('is a no-op when the bootstrap carries none', async () => {
      const bootstrap = { configured: true, api: { mode: 'in_process' } }

      const after = await migrateNameservers(dir, bootstrap, writeBootstrap)

      assert.equal(after, bootstrap)
    })

    it('leaves the bootstrap intact when the store write fails', async () => {
      // No api.json, so the store cannot be opened.
      const bootstrap = { configured: true, api: {}, nameserver: [nameserver] }
      let wrote = false

      const after = await migrateNameservers(dir, bootstrap, async () => {
        wrote = true
      })

      assert.equal(
        wrote,
        false,
        'the bootstrap is only rewritten after a successful move',
      )
      assert.deepEqual(after.nameserver, [nameserver], 'records are not lost')
    })
  })

  describe('api.json', () => {
    it('is where the store connection is read from', async () => {
      await writeApiConfig(dir, { type: 'mysql', host: 'db', database: 'nictool' })

      const onDisk = JSON.parse(await fsp.readFile(apiConfigPath(dir), 'utf8'))
      assert.equal(onDisk.store.host, 'db')
    })
  })
})
