import assert from 'node:assert/strict'
import dnsNode from 'node:dns/promises'
import fs from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { describe, it, before, after } from 'node:test'

import NameserverSupervisor from './nameservers.js'

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer()
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => resolve(port))
    })
  })
}

function makeResolver(port) {
  const r = new dnsNode.Resolver()
  r.setServers([`127.0.0.1:${port}`])
  return r
}

describe('NameserverSupervisor', function () {
  let storeDir
  let supervisor
  let portA
  let portB

  before(async () => {
    storeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nictool-sup-'))
    // Seed a TOML store: two zones.
    const zoneToml = `
[[zone]]
id = 1
name = "example.com"
ttl = 300
serial = 2026010101
mailaddr = "ns1.example.com"
rname = "hostmaster.example.com"

[[zone]]
id = 2
name = "test.local"
ttl = 300
serial = 2026010102
`
    const recordToml = `
[[zone_record]]
id = 10
zid = 1
type = "A"
name = "@"
address = "192.0.2.10"
ttl = 300

[[zone_record]]
id = 11
zid = 1
type = "A"
name = "www"
address = "192.0.2.20"
ttl = 300

[[zone_record]]
id = 20
zid = 2
type = "A"
name = "@"
address = "10.0.0.1"
ttl = 300
`
    await fs.writeFile(path.join(storeDir, 'zone.toml'), zoneToml)
    await fs.writeFile(path.join(storeDir, 'zone_record.toml'), recordToml)

    portA = await freePort()
    portB = await freePort()

    supervisor = new NameserverSupervisor()
    await supervisor.start({
      store: { type: 'directory', path: storeDir },
      nameserver: [
        {
          name: 'ns1.example.com.',
          engine: 'native',
          listen: [{ address: '127.0.0.1', port: portA, proto: 'udp' }],
          publisher: { type: 'memory' },
          transport: { type: 'noop', interval: 0 },
        },
        {
          name: 'ns2.example.com.',
          engine: 'native',
          listen: [{ address: '127.0.0.1', port: portB, proto: 'udp' }],
          publisher: { type: 'memory' },
          transport: { type: 'noop', interval: 0 },
        },
      ],
    })
  })

  after(async () => {
    await supervisor.stop()
    await fs.rm(storeDir, { recursive: true, force: true })
  })

  it('starts two native engines and each answers queries', async () => {
    const a = await makeResolver(portA).resolve4('www.example.com')
    assert.deepEqual(a, ['192.0.2.20'])

    const b = await makeResolver(portB).resolve4('test.local')
    assert.deepEqual(b, ['10.0.0.1'])
  })

  it('status() reports both engines as running', () => {
    const s = supervisor.status()
    assert.equal(s.length, 2)
    for (const row of s) {
      assert.equal(row.state, 'running')
      assert.equal(row.engine, 'native')
    }
  })

  it('honors the legacy {host,port} shape', async () => {
    const altPort = await freePort()
    const sup2 = new NameserverSupervisor()
    await sup2.start({
      store: { type: 'directory', path: storeDir },
      nameserver: [{ name: 'legacy.', host: '127.0.0.1', port: altPort, type: 'native' }],
    })
    try {
      const r = await makeResolver(altPort).resolve4('example.com')
      assert.deepEqual(r, ['192.0.2.10'])
    } finally {
      await sup2.stop()
    }
  })

  it('rejects unknown engine types with a clear error', async () => {
    const sup2 = new NameserverSupervisor()
    let errored = false
    sup2.on('error', () => {
      errored = true
    })
    await sup2.start({
      store: { type: 'directory', path: storeDir },
      nameserver: [
        {
          name: 'nope.',
          engine: 'nonesuch',
          publisher: { type: 'rfc1035', path: '/tmp' },
        },
      ],
    })
    assert.equal(sup2.status().length, 0, 'unknown engine should not have started')
    assert.equal(errored, true, 'supervisor should have emitted an error')
    await sup2.stop()
  })

  it('bind engine publishes RFC1035 zone files', async () => {
    const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nictool-bind-'))
    const sup2 = new NameserverSupervisor()
    try {
      await sup2.start({
        store: { type: 'directory', path: storeDir },
        nameserver: [
          {
            name: 'bind1.',
            engine: 'bind',
            publisher: { type: 'rfc1035', path: outDir },
            transport: { type: 'noop', interval: 0, cooldown: 0 },
          },
        ],
      })
      assert.equal(sup2.status().length, 1)
      const exampleZone = await fs.readFile(path.join(outDir, 'example.com.zone'), 'utf8')
      assert.match(exampleZone, /\$ORIGIN example\.com\./)
      assert.match(exampleZone, /www\s+300\s+IN\s+A\s+192\.0\.2\.20/)
      assert.match(exampleZone, /SOA/)
      const testZone = await fs.readFile(path.join(outDir, 'test.local.zone'), 'utf8')
      assert.match(testZone, /\$ORIGIN test\.local\./)
    } finally {
      await sup2.stop()
      await fs.rm(outDir, { recursive: true, force: true })
    }
  })
})
