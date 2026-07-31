import assert from 'node:assert/strict'
import dgram from 'node:dgram'
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
zone = "example.com"
ttl = 300
serial = 2026010101
mailaddr = "ns1.example.com"
rname = "hostmaster.example.com"

[[zone]]
id = 2
zone = "test.local"
ttl = 300
serial = 2026010102
`
    const recordToml = `
[[zone_record]]
id = 10
zid = 1
type = "A"
owner = "@"
address = "192.0.2.10"
ttl = 300

[[zone_record]]
id = 11
zid = 1
type = "A"
owner = "www"
address = "192.0.2.20"
ttl = 300

[[zone_record]]
id = 20
zid = 2
type = "A"
owner = "@"
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
          type: 'native',
          listen: [{ address: '127.0.0.1', port: portA, proto: 'udp' }],
          publisher: { type: 'memory' },
          transport: { type: 'noop', interval: 0 },
        },
        {
          name: 'ns2.example.com.',
          type: 'native',
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

  it('starts two native nameservers and each answers queries', async () => {
    const a = await makeResolver(portA).resolve4('www.example.com')
    assert.deepEqual(a, ['192.0.2.20'])

    const b = await makeResolver(portB).resolve4('test.local')
    assert.deepEqual(b, ['10.0.0.1'])
  })

  it('status() reports both nameservers as running', () => {
    const s = supervisor.status()
    assert.equal(s.length, 2)
    for (const row of s) {
      assert.equal(row.state, 'running')
      assert.equal(row.type, 'native')
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

  it('rejects an unknown nameserver type with a clear error', async () => {
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
          type: 'nonesuch',
          publisher: { type: 'rfc1035', path: '/tmp' },
        },
      ],
    })
    assert.equal(sup2.status().length, 0, 'unknown type should not have started')
    assert.equal(errored, true, 'supervisor should have emitted an error')
    await sup2.stop()
  })

  it('bind publishes RFC1035 zone files', async () => {
    const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nictool-bind-'))
    const sup2 = new NameserverSupervisor()
    try {
      await sup2.start({
        store: { type: 'directory', path: storeDir },
        nameserver: [
          {
            name: 'bind1.',
            type: 'bind',
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

      // The server also needs to be told the zones exist.
      const named = await fs.readFile(path.join(outDir, 'named.conf'), 'utf8')
      assert.match(named, /zone "example\.com" \{/)
      assert.match(named, /file "example\.com\.zone";/)
      assert.match(named, /zone "test\.local" \{/)
    } finally {
      await sup2.stop()
      await fs.rm(outDir, { recursive: true, force: true })
    }
  })

  it('maradns publishes csv2 zone files and a mararc', async () => {
    const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nictool-mara-'))
    const sup2 = new NameserverSupervisor()
    try {
      await sup2.start({
        store: { type: 'directory', path: storeDir },
        nameserver: [
          {
            name: 'mara1.',
            type: 'maradns',
            // No publisher.type: maradns must not default to rfc1035, whose
            // zone files MaraDNS cannot read.
            publisher: { path: outDir },
            transport: { type: 'noop', interval: 0, cooldown: 0 },
          },
        ],
      })
      assert.equal(sup2.status().length, 1)

      const zone = await fs.readFile(path.join(outDir, 'example.com.csv2'), 'utf8')
      assert.match(zone, /^www\.example\.com\.\s+\+300\s+A\s+192\.0\.2\.20 ~$/m)
      assert.doesNotMatch(zone, /\bIN\b/, 'csv2 has no class field')

      const mararc = await fs.readFile(path.join(outDir, 'mararc'), 'utf8')
      assert.match(mararc, /csv2 = \{\}/)
      assert.match(mararc, /csv2\["example\.com\."\] = "example\.com\.csv2"/)
    } finally {
      await sup2.stop()
      await fs.rm(outDir, { recursive: true, force: true })
    }
  })

  // Omitting `publisher` entirely used to substitute {type:'rfc1035'} before
  // DEFAULT_PUBLISHER was consulted, so tinydns and maradns got zone files
  // their software cannot read.
  it('picks the per-type default when no publisher is given at all', async () => {
    const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nictool-defpub-'))
    const sup2 = new NameserverSupervisor()
    try {
      await sup2.start({
        store: { type: 'directory', path: storeDir },
        nameserver: [
          {
            name: 'mara2.',
            type: 'maradns',
            transport: { type: 'noop', interval: 0, cooldown: 0 },
          },
        ],
      })
      assert.equal(sup2.status().length, 1)
      const ns = sup2.nameservers[0]
      assert.equal(ns.publisher.constructor.name, 'MaradnsPublisher')
    } finally {
      await sup2.stop()
      await fs.rm(outDir, { recursive: true, force: true })
    }
  })

  it('republishes on a store change when in event mode', async () => {
    const watchDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nictool-evt-store-'))
    const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nictool-evt-out-'))
    await fs.writeFile(
      path.join(watchDir, 'zone.json'),
      JSON.stringify({ zone: [{ id: 1, zone: 'evt.example', ttl: 300, serial: 1 }] }),
    )
    await fs.writeFile(
      path.join(watchDir, 'zone_record.json'),
      JSON.stringify({
        zone_record: [
          { id: 1, zid: 1, type: 'A', owner: 'a', address: '192.0.2.1', ttl: 300 },
        ],
      }),
    )

    const sup2 = new NameserverSupervisor()
    try {
      await sup2.start({
        store: { type: 'json', path: watchDir },
        nameserver: [
          {
            name: 'evt1.',
            type: 'bind',
            publisher: { type: 'rfc1035', path: outDir },
            transport: { type: 'noop', interval: 0, cooldown: 0 },
          },
        ],
      })

      const zoneFile = path.join(outDir, 'evt.example.zone')
      assert.match(await fs.readFile(zoneFile, 'utf8'), /192\.0\.2\.1/)

      // Wait on the nameserver rather than polling the file: how long fs.watch takes
      // to deliver is the OS's business, and a wall-clock deadline turns a busy
      // machine into a test failure.
      const republished = new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('no republish within 20s')),
          20000,
        )
        sup2.nameservers[0].once('published', () => {
          clearTimeout(timer)
          resolve()
        })
      })

      await fs.writeFile(
        path.join(watchDir, 'zone_record.json'),
        JSON.stringify({
          zone_record: [
            { id: 1, zid: 1, type: 'A', owner: 'a', address: '192.0.2.99', ttl: 300 },
          ],
        }),
      )
      await republished

      assert.match(
        await fs.readFile(zoneFile, 'utf8'),
        /192\.0\.2\.99/,
        'edit should have triggered a republish',
      )
    } finally {
      await sup2.stop()
      await fs.rm(watchDir, { recursive: true, force: true })
      await fs.rm(outDir, { recursive: true, force: true })
    }
  })

  // 2.x had bind-nsupdate as an export type of its own. It is BIND fed over the
  // network (RFC 2136) rather than by file copy — a transport choice here, so
  // the nameserver it resolves to is plain bind.
  it('resolves the 2.x bind-nsupdate export type to bind', async () => {
    const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nictool-nsupdate-'))
    const sup2 = new NameserverSupervisor()
    const warnings = []
    const realWarn = console.warn
    console.warn = (...a) => warnings.push(a.join(' '))
    try {
      await sup2.start({
        store: { type: 'directory', path: storeDir },
        nameserver: [
          {
            name: 'nsupdate1.',
            type: 'bind-nsupdate',
            publisher: { type: 'rfc1035', path: outDir },
            transport: { type: 'noop', interval: 0, cooldown: 0 },
          },
        ],
      })
      assert.equal(sup2.status().length, 1, 'bind-nsupdate should have started')
      assert.equal(sup2.nameservers[0].type, 'bind')
      assert.match(
        await fs.readFile(path.join(outDir, 'named.conf'), 'utf8'),
        /zone "example\.com"/,
      )
      assert.match(
        warnings.join(),
        /pushed updates over the network/,
        'and says the push mechanism did not come with it',
      )
    } finally {
      console.warn = realWarn
      await sup2.stop()
      await fs.rm(outDir, { recursive: true, force: true })
    }
  })

  // dynect was a SaaS provider; nothing here publishes to it. An adopted record
  // keeps the type, but starting it would mean silently serving from elsewhere.
  it('refuses a 2.x type nothing here implements', async () => {
    const sup2 = new NameserverSupervisor()
    const errors = []
    sup2.on('error', (_e, err) => errors.push(err))
    await sup2.start({
      store: { type: 'directory', path: storeDir },
      nameserver: [{ name: 'dyn1.', type: 'dynect', publisher: { type: 'none' } }],
    })
    assert.equal(sup2.status().length, 0)
    assert.match(errors.at(-1).message, /Unknown nameserver type: "dynect"/)
    await sup2.stop()
  })

  // djbdns is the package name; tinydns and axfrdns are its daemons, both
  // reading the data.cdb this writes.
  it('publishes a data.cdb for djbdns', async () => {
    const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nictool-djbdns-'))
    const sup2 = new NameserverSupervisor()
    try {
      await sup2.start({
        store: { type: 'directory', path: storeDir },
        nameserver: [
          {
            name: 'djbdns1.',
            type: 'djbdns',
            publisher: { path: outDir, compile: false },
            transport: { type: 'noop', interval: 0, cooldown: 0 },
          },
        ],
      })
      assert.equal(sup2.status().length, 1)
      assert.equal(sup2.nameservers[0].type, 'djbdns')
      assert.equal(
        sup2.nameservers[0].publisher.constructor.name,
        'TinydnsCdbPublisher',
        'djbdns must default to the cdb publisher, not rfc1035',
      )
      const data = await fs.readFile(path.join(outDir, 'data'), 'utf8')
      assert.match(data, /example\.com/)
    } finally {
      await sup2.stop()
      await fs.rm(outDir, { recursive: true, force: true })
    }
  })

  it('bind over axfr notifies the secondary and authorizes the transfer', async () => {
    const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nictool-axfr-'))
    const secondary = dgram.createSocket('udp4')
    const notified = []
    await new Promise((r) => secondary.bind(0, '127.0.0.1', r))
    secondary.on('message', (msg, rinfo) => {
      // Question name starts at byte 12.
      const labels = []
      let off = 12
      while (msg[off] !== 0) {
        labels.push(msg.subarray(off + 1, off + 1 + msg[off]).toString())
        off += 1 + msg[off]
      }
      notified.push(labels.join('.'))
      const res = Buffer.alloc(12)
      res.writeUInt16BE(msg.readUInt16BE(0), 0)
      res.writeUInt16BE(0x8000 | (4 << 11), 2)
      secondary.send(res, rinfo.port, rinfo.address)
    })
    const target = `127.0.0.1:${secondary.address().port}`

    const sup2 = new NameserverSupervisor()
    try {
      await sup2.start({
        store: { type: 'directory', path: storeDir },
        nameserver: [
          {
            name: 'axfr1.',
            type: 'bind',
            publisher: { type: 'rfc1035', path: outDir },
            transport: {
              type: 'axfr',
              notify: [target],
              interval: 0,
              cooldown: 0,
              timeoutMs: 500,
              attempts: 1,
            },
          },
        ],
      })

      assert.equal(sup2.status().length, 1, 'the axfr nameserver should have started')
      assert.deepEqual(notified.sort(), ['example.com', 'test.local'])

      // The notify list must also reach named.conf, or the transfer the NOTIFY
      // asks for gets refused.
      const named = await fs.readFile(path.join(outDir, 'named.conf'), 'utf8')
      assert.match(named, /allow-transfer \{ 127\.0\.0\.1; \};/)
      assert.match(named, /also-notify \{ 127\.0\.0\.1; \};/)
      assert.doesNotMatch(
        named,
        /127\.0\.0\.1:/,
        'the port belongs to NOTIFY, not the ACL',
      )

      const m = sup2.status()[0].publish
      assert.equal(m.failures, 0)
      assert.equal(m.last.zoneCount, 2)
    } finally {
      await sup2.stop()
      secondary.close()
      await fs.rm(outDir, { recursive: true, force: true })
    }
  })

  it('reports a nameserver whose secondary never answers', async () => {
    const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nictool-axfr-dead-'))
    const dead = dgram.createSocket('udp4')
    await new Promise((r) => dead.bind(0, '127.0.0.1', r))

    const sup2 = new NameserverSupervisor()
    try {
      await sup2.start({
        store: { type: 'directory', path: storeDir },
        nameserver: [
          {
            name: 'axfr2.',
            type: 'nsd',
            publisher: { type: 'rfc1035', path: outDir },
            transport: {
              type: 'axfr',
              notify: [`127.0.0.1:${dead.address().port}`],
              interval: 0,
              cooldown: 0,
              timeoutMs: 40,
              attempts: 1,
            },
          },
        ],
      })

      // The zones still published; only the notify leg failed.
      const conf = await fs.readFile(path.join(outDir, 'nsd.conf'), 'utf8')
      assert.match(conf, /provide-xfr: 127\.0\.0\.1 NOKEY/)
      assert.match(
        await fs.readFile(path.join(outDir, 'example.com.zone'), 'utf8'),
        /SOA/,
      )
    } finally {
      await sup2.stop()
      dead.close()
      await fs.rm(outDir, { recursive: true, force: true })
    }
  })

  it('coredns publishes zone files and a Corefile', async () => {
    const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nictool-coredns-'))
    const sup2 = new NameserverSupervisor()
    try {
      await sup2.start({
        store: { type: 'directory', path: storeDir },
        nameserver: [
          {
            name: 'coredns1.',
            type: 'coredns',
            publisher: { path: outDir, config: { reload: '15s' } },
            transport: { type: 'noop', interval: 0, cooldown: 0 },
          },
        ],
      })
      assert.equal(sup2.status().length, 1)

      // Same RFC 1035 zone files bind reads.
      const zone = await fs.readFile(path.join(outDir, 'example.com.zone'), 'utf8')
      assert.match(zone, /\$ORIGIN example\.com\./)
      assert.match(zone, /www\s+300\s+IN\s+A\s+192\.0\.2\.20/)

      const corefile = await fs.readFile(path.join(outDir, 'Corefile'), 'utf8')
      assert.match(corefile, /^example\.com \{$/m)
      assert.match(corefile, /file example\.com\.zone \{/)
      assert.match(corefile, /reload 15s/)
      assert.match(corefile, /^test\.local \{$/m)
    } finally {
      await sup2.stop()
      await fs.rm(outDir, { recursive: true, force: true })
    }
  })

  it('coredns over axfr writes a transfer block from the notify list', async () => {
    const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nictool-coredns-xfr-'))
    const secondary = dgram.createSocket('udp4')
    await new Promise((r) => secondary.bind(0, '127.0.0.1', r))
    secondary.on('message', (msg, rinfo) => {
      const res = Buffer.alloc(12)
      res.writeUInt16BE(msg.readUInt16BE(0), 0)
      res.writeUInt16BE(0x8000 | (4 << 11), 2)
      secondary.send(res, rinfo.port, rinfo.address)
    })

    const sup2 = new NameserverSupervisor()
    try {
      await sup2.start({
        store: { type: 'directory', path: storeDir },
        nameserver: [
          {
            name: 'coredns2.',
            type: 'coredns',
            publisher: { path: outDir },
            transport: {
              type: 'axfr',
              notify: [`127.0.0.1:${secondary.address().port}`],
              interval: 0,
              cooldown: 0,
              timeoutMs: 500,
              attempts: 1,
            },
          },
        ],
      })

      const corefile = await fs.readFile(path.join(outDir, 'Corefile'), 'utf8')
      assert.match(corefile, /transfer \{/)
      assert.match(corefile, /to 127\.0\.0\.1/)
      assert.equal(sup2.status()[0].publish.last.deliveryFailures, 0)
    } finally {
      await sup2.stop()
      secondary.close()
      await fs.rm(outDir, { recursive: true, force: true })
    }
  })

  // A nameserver NicTool does not push to still deserves a record: a MaraDNS
  // secondary running fetchzone from cron, or CoreDNS polling its own store.
  it('a pull nameserver is a real record that writes nothing', async () => {
    const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nictool-pull-'))
    const sup2 = new NameserverSupervisor()
    try {
      await sup2.start({
        store: { type: 'directory', path: storeDir },
        nameserver: [
          {
            name: 'mara-secondary.',
            type: 'maradns',
            publisher: { type: 'none' },
            transport: { type: 'pull', source: 'fetchzone from cron', interval: 0 },
          },
        ],
      })

      const s = sup2.status()[0]
      assert.equal(s.state, 'running', 'it starts like any other nameserver')
      assert.equal(s.publisher, 'NonePublisher')
      assert.equal(s.transport, 'PullTransport')

      // Zones are counted so the record says what the far side should hold...
      assert.equal(s.publish.last.zoneCount, 2)
      assert.equal(s.publish.failures, 0)
      // ...and nothing counts as a failed delivery, because nothing was sent.
      assert.equal(s.publish.last.deliveryFailures, 0)

      const written = await fs.readdir(outDir)
      assert.deepEqual(written, [], 'a pull nameserver writes no artifacts')
    } finally {
      await sup2.stop()
      await fs.rm(outDir, { recursive: true, force: true })
    }
  })

  // DNSSEC uses whatever the nameserver ships. bind/nsd/coredns read a signed zone
  // file, so the signing happens here; knot and powerdns sign for themselves and
  // only need telling; the rest have no tool at all.
  it('signs zone files for a nameserver that reads them', async (t) => {
    const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nictool-sign-'))
    const keyDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nictool-keys-'))
    const sup2 = new NameserverSupervisor()
    try {
      await sup2.start({
        store: { type: 'directory', path: storeDir },
        nameserver: [
          {
            name: 'signed.',
            type: 'bind',
            publisher: { type: 'rfc1035', path: outDir },
            transport: { type: 'noop', interval: 0, cooldown: 0 },
            dnssec: { enabled: true, keyset: keyDir },
          },
        ],
      })

      if (!sup2.status().length) return t.skip('dnssec-signzone not installed')

      const zone = await fs.readFile(path.join(outDir, 'example.com.zone'), 'utf8')
      assert.match(zone, /RRSIG/, 'the published zone is signed')
      assert.match(zone, /DNSKEY/)

      // The config still names the same file, which now holds signed content.
      const named = await fs.readFile(path.join(outDir, 'named.conf'), 'utf8')
      assert.match(named, /file "example\.com\.zone";/)

      const keys = await fs.readdir(keyDir)
      assert.ok(keys.length >= 4, 'a KSK and ZSK per zone')
    } finally {
      await sup2.stop()
      await fs.rm(outDir, { recursive: true, force: true })
      await fs.rm(keyDir, { recursive: true, force: true })
    }
  })

  it('tells knot to sign for itself rather than signing here', async () => {
    const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nictool-knot-dnssec-'))
    const sup2 = new NameserverSupervisor()
    try {
      await sup2.start({
        store: { type: 'directory', path: storeDir },
        nameserver: [
          {
            name: 'knot1.',
            type: 'knot',
            publisher: { type: 'rfc1035', path: outDir },
            transport: { type: 'noop', interval: 0, cooldown: 0 },
            dnssec: { enabled: true, algorithm: 'ED25519', nsec3: true },
          },
        ],
      })
      assert.equal(sup2.status().length, 1)

      const conf = await fs.readFile(path.join(outDir, 'knot.conf'), 'utf8')
      assert.match(conf, /policy:/)
      assert.match(conf, /algorithm: ed25519/)
      assert.match(conf, /nsec3: on/)
      assert.match(conf, /dnssec-signing: on/)

      // Knot signs on load, so what we wrote is deliberately unsigned.
      const zone = await fs.readFile(path.join(outDir, 'example.com.zone'), 'utf8')
      assert.doesNotMatch(zone, /RRSIG/)
      assert.equal(sup2.nameservers[0].signer.constructor.name, 'NoneSigner')
    } finally {
      await sup2.stop()
      await fs.rm(outDir, { recursive: true, force: true })
    }
  })

  // native has no external tool because it is not an external server:
  // MemorySigner signs the live zone map, which NativeNS answers from directly.
  it('signs the native zone map in process', async (t) => {
    const keyDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nictool-memkeys-'))
    const port = await freePort()
    const sup2 = new NameserverSupervisor()
    try {
      const { ensureKeys } = await import('@nictool/dns-nameserver/lib/dnssec.js')
      try {
        // Every zone in the store, because MemorySigner signs the whole map and
        // fails the cycle on the first zone it has no key for.
        for (const zone of ['example.com', 'test.local']) {
          await ensureKeys({ keyDir, zone, algorithm: 'ECDSAP256SHA256' })
        }
      } catch {
        return t.skip('dnssec-keygen not installed')
      }

      await sup2.start({
        store: { type: 'directory', path: storeDir },
        nameserver: [
          {
            name: 'native-signed.',
            type: 'native',
            listen: [{ address: '127.0.0.1', port, proto: 'udp' }],
            transport: { type: 'noop', interval: 0, cooldown: 0 },
            dnssec: { enabled: true, keyset: keyDir },
          },
        ],
      })

      assert.equal(sup2.status().length, 1, 'native accepts DNSSEC')
      assert.equal(sup2.nameservers[0].signer.constructor.name, 'MemorySigner')

      const records = sup2.nameservers[0].publisher.zones.get('example.com').records
      const types = new Set(records.map((r) => r.type))
      assert.ok(types.has('DNSKEY'), 'DNSKEY at the apex')
      assert.ok(types.has('RRSIG'), 'the RRsets are signed')
      assert.ok(types.has('NSEC'), 'an NSEC chain for authenticated denial')
    } finally {
      await sup2.stop()
      await fs.rm(keyDir, { recursive: true, force: true })
    }
  })

  it('refuses DNSSEC on a type that has no signing support', async () => {
    for (const type of ['djbdns', 'maradns']) {
      const sup2 = new NameserverSupervisor()
      const errors = []
      sup2.on('error', (_e, err) => errors.push(err))
      await sup2.start({
        store: { type: 'directory', path: storeDir },
        nameserver: [
          {
            name: `${type}-dnssec.`,
            type,
            listen: [{ address: '127.0.0.1', port: 15999, proto: 'udp' }],
            transport: { type: 'noop', interval: 0, cooldown: 0 },
            dnssec: { enabled: true },
          },
        ],
      })
      assert.equal(sup2.status().length, 0, `${type} should not have started`)
      assert.match(errors.at(-1).message, /no signing support/, type)
      await sup2.stop()
    }
  })

  it('refuses to sign a publisher that writes no zone files', async () => {
    const sup2 = new NameserverSupervisor()
    const errors = []
    sup2.on('error', (_e, err) => errors.push(err))
    await sup2.start({
      store: { type: 'directory', path: storeDir },
      nameserver: [
        {
          name: 'redis-dnssec.',
          type: 'coredns',
          publisher: { type: 'coredns-redis', address: '127.0.0.1:6399' },
          transport: { type: 'noop', interval: 0, cooldown: 0 },
          dnssec: { enabled: true },
        },
      ],
    })
    assert.equal(sup2.status().length, 0)
    assert.match(errors.at(-1).message, /only be signed when publishing zone files/)
    await sup2.stop()
  })

  it('publishes when told a MySQL-backed store changed', async () => {
    const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nictool-notify-'))
    const sup2 = new NameserverSupervisor()
    try {
      await sup2.start({
        store: { type: 'directory', path: storeDir },
        nameserver: [
          {
            name: 'notify1.',
            type: 'bind',
            publisher: { type: 'rfc1035', path: outDir },
            transport: { type: 'noop', interval: 0, cooldown: 0 },
          },
        ],
      })

      let published = 0
      sup2.nameservers[0].on('published', () => published++)
      sup2.notifyZoneChanged({ reason: 'test' })

      const deadline = Date.now() + 5000
      while (Date.now() < deadline && published === 0) {
        await new Promise((r) => setTimeout(r, 25))
      }
      assert.equal(published > 0, true, 'notifyZoneChanged should drive a publish')
    } finally {
      await sup2.stop()
      await fs.rm(outDir, { recursive: true, force: true })
    }
  })
})
