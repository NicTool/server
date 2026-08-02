// The form's rules exist so that combinations the supervisor would reject at
// start() cannot be selected in the first place — a failed start is a line in a
// log nobody is watching.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  NS_TYPES,
  dnssecFor,
  fieldsFor,
  fromRecord,
  publishersFor,
  reconcile,
  toPayload,
  transportsFor,
  validate,
} from './ns-form.js'

/** A form that already validates, so a test can assert on one thing at a time. */
const base = (over = {}) => {
  const form = fromRecord({
    name: 'ns1.example.com.',
    address: '192.0.2.1',
    type: 'bind',
    publisher: { type: 'rfc1035', path: '/etc/bind/zones' },
  })
  return { ...form, ...over }
}

describe('what each type can be paired with', () => {
  it('offers native only the in-process publisher', () => {
    assert.deepEqual(
      publishersFor('native').map((p) => p.value),
      ['memory'],
    )
    assert.deepEqual(
      transportsFor('native').map((t) => t.value),
      ['noop'],
    )
  })

  it('gives every external type a publisher its own software can read', () => {
    const readable = {
      bind: 'rfc1035',
      knot: 'rfc1035',
      nsd: 'rfc1035',
      coredns: 'rfc1035',
      powerdns: 'powerdns-db',
      djbdns: 'tinydns-cdb',
      maradns: 'maradns',
    }
    for (const [type, expected] of Object.entries(readable)) {
      const offered = publishersFor(type).map((p) => p.value)
      assert.ok(offered.includes(expected), `${type} should offer ${expected}`)
    }
  })

  it('never offers a publisher the type cannot read', () => {
    // The bug this prevents: maradns reads csv2, not RFC 1035 zone files.
    assert.equal(publishersFor('maradns').includes('rfc1035'), false)
    assert.equal(
      publishersFor('djbdns')
        .map((p) => p.value)
        .includes('rfc1035'),
      false,
    )
  })

  it('offers redis only where a plugin exists to read it', () => {
    for (const t of NS_TYPES) {
      const offered = t.publishers.includes('coredns-redis')
      assert.equal(offered, t.value === 'coredns', t.value)
    }
  })

  it('offers AXFR only where the far-side config is generated', () => {
    const withAxfr = NS_TYPES.filter((e) => e.transports.includes('axfr')).map(
      (e) => e.value,
    )
    assert.deepEqual(withAxfr.sort(), ['bind', 'coredns', 'knot', 'nsd', 'powerdns'])
  })
})

describe('reconcile', () => {
  it('drops a publisher the new type cannot read', () => {
    const out = reconcile(base({ type: 'maradns', publisherType: 'rfc1035' }))
    assert.equal(out.publisherType, 'maradns')
  })

  it('keeps a choice that is still valid', () => {
    const out = reconcile(base({ type: 'coredns', publisherType: 'coredns-redis' }))
    assert.equal(out.publisherType, 'coredns-redis')
  })

  it('drops a transport the new type cannot use', () => {
    const out = reconcile(base({ type: 'maradns', transportType: 'axfr' }))
    assert.notEqual(out.transportType, 'axfr')
  })

  it('forces pull when nothing is published, since there is nothing to send', () => {
    const out = reconcile(base({ publisherType: 'none', transportType: 'rsync' }))
    assert.equal(out.transportType, 'pull')
  })

  it('seeds a listen row when the type needs one', () => {
    const out = reconcile(base({ type: 'native', listen: [] }))
    assert.deepEqual(out.listen, [{ address: '127.0.0.1', port: 53, proto: 'udp' }])
    // Not for a type that binds nothing.
    assert.deepEqual(reconcile(base({ listen: [] })).listen, [])
  })

  it('switching to native lands on memory and noop', () => {
    const out = reconcile(
      base({ type: 'native', publisherType: 'rfc1035', transportType: 'rsync' }),
    )
    assert.equal(out.publisherType, 'memory')
    assert.equal(out.transportType, 'noop')
  })
})

describe('validate', () => {
  const errorsOf = (form, opts) => validate(form, opts).errors
  const warningsOf = (form, opts) => validate(form, opts).warnings

  it('requires a fully qualified name', () => {
    assert.match(errorsOf(base({ name: '' })).join(), /Name is required/)
    assert.match(errorsOf(base({ name: 'ns1.example.com' })).join(), /ending in a dot/)
    assert.deepEqual(errorsOf(base({ name: 'ns1.example.com.' })), [])
  })

  it('requires an address', () => {
    assert.match(errorsOf(base({ address: '' })).join(), /IPv4 address is required/)
  })

  it('requires a listen row for native, with a usable port', () => {
    // A blank address survives reconcile's seeding, so this is still reachable.
    const native = base({
      type: 'native',
      listen: [{ address: '', port: 53, proto: 'udp' }],
    })
    assert.match(errorsOf(native).join(), /at least one listen address/)

    const badPort = base({
      type: 'native',
      listen: [{ address: '127.0.0.1', port: 99999, proto: 'udp' }],
    })
    assert.match(errorsOf(badPort).join(), /port between 1 and 65535/)
  })

  it('requires an output path where files are written', () => {
    const form = base()
    form.publisher = { ...form.publisher, path: '' }
    assert.match(errorsOf(form).join(), /needs an output path/)
  })

  it('requires a remote for rsync and a target for axfr', () => {
    const rsync = base({ transportType: 'rsync' })
    rsync.transport.remote = ''
    assert.match(errorsOf(rsync).join(), /rsync needs a remote/)

    const axfr = base({ transportType: 'axfr' })
    axfr.transport.notify = ''
    assert.match(errorsOf(axfr).join(), /at least one notify target/)
  })

  it('accepts notify as a comma or space separated list', () => {
    const form = base({ transportType: 'axfr' })
    form.transport.notify = '192.0.2.1, 192.0.2.2:5353'
    assert.deepEqual(errorsOf(form), [])
    assert.deepEqual(toPayload(form).transport.notify, ['192.0.2.1', '192.0.2.2:5353'])
  })

  it('rejects a TSIG key that is not name:secret', () => {
    const form = base({ transportType: 'axfr' })
    form.transport.notify = '192.0.2.1'
    form.transport.tsigKey = 'just-a-name'
    assert.match(errorsOf(form).join(), /name:secret/)

    form.transport.tsigKey = 'hmac-sha256:k:c2VjcmV0'
    assert.deepEqual(errorsOf(form), [])
  })

  it('says who does the signing, per type', () => {
    const bind = base({ dnssec: { enabled: true } })
    assert.match(warningsOf(bind).join(), /signed here with dnssec-signzone/)
    assert.deepEqual(errorsOf(bind), [], 'signing zone files is supported')

    const knot = base({ type: 'knot', dnssec: { enabled: true } })
    assert.match(warningsOf(knot).join(), /signs its own zones/)
    assert.deepEqual(errorsOf(knot), [])
  })

  it('blocks DNSSEC on a type that has none', () => {
    for (const type of ['djbdns', 'maradns']) {
      const form = base({ type, dnssec: { enabled: true } })
      assert.match(errorsOf(form).join(), /no DNSSEC support/, type)
    }
  })

  it('signs native in process, with no external tool', () => {
    const form = base({ type: 'native', dnssec: { enabled: true } })
    assert.deepEqual(errorsOf(form), [])
    assert.match(warningsOf(form).join(), /signs the zone map itself/)
  })

  it('rejects NSEC3 on the in-process signer, which only does NSEC', () => {
    const form = base({ type: 'native', dnssec: { enabled: true, nsec3: true } })
    assert.match(errorsOf(form).join(), /NSEC only, not NSEC3/)
  })

  it('blocks signing a publisher that writes no zone files', () => {
    const form = base({
      type: 'coredns',
      publisherType: 'coredns-redis',
      dnssec: { enabled: true },
    })
    form.publisher = { ...form.publisher, address: '127.0.0.1:6379' }
    assert.match(errorsOf(form).join(), /needs a publisher that writes zone files/)
  })

  it('warns that interval 0 over MySQL publishes once and stops', () => {
    const form = base()
    form.transport.interval = 0
    assert.match(
      warningsOf(form, { storeType: 'mysql' }).join(),
      /publish once at startup/,
    )
    // A file store watches, so the same setting is fine there.
    assert.deepEqual(warningsOf(form, { storeType: 'json' }), [])
  })

  it('warns that PowerDNS at NATIVE has no transfer to trigger', () => {
    const form = base({
      type: 'powerdns',
      publisherType: 'powerdns-db',
      transportType: 'axfr',
    })
    form.publisher.dsn = 'mysql://u:p@127.0.0.1/pdns'
    form.transport.notify = '192.0.2.1'
    assert.match(warningsOf(form).join(), /NATIVE does not replicate/)

    form.publisher.domainType = 'MASTER'
    assert.equal(warningsOf(form).join().includes('NATIVE'), false)
  })

  it('warns that redis cannot hold reverse zones', () => {
    const form = base({ type: 'coredns', publisherType: 'coredns-redis' })
    assert.match(warningsOf(form).join(), /PTR is not among them/)
  })
})

describe('toPayload', () => {
  it('writes the shape the supervisor reads', () => {
    const form = base()
    form.transportType = 'rsync'
    form.transport.remote = 'bind@ns1:/etc/bind/zones'
    form.transport.interval = 300

    assert.deepEqual(toPayload(form), {
      name: 'ns1.example.com.',
      ttl: 86400,
      description: '',
      address: '192.0.2.1',
      address6: undefined,
      type: 'bind',
      publisher: { type: 'rfc1035', path: '/etc/bind/zones' },
      transport: {
        type: 'rsync',
        remote: 'bind@ns1:/etc/bind/zones',
        interval: 300,
        cooldown: 5,
      },
    })
  })

  it('carries listen rows for native and nothing else', () => {
    const native = base({
      type: 'native',
      listen: [
        { address: '127.0.0.1', port: 53, proto: 'udp' },
        { address: '127.0.0.1', port: 53, proto: 'tcp' },
      ],
    })
    assert.equal(toPayload(native).listen.length, 2)
    assert.equal(toPayload(base()).listen, undefined)
  })

  it('sends config:false only when the server config is switched off', () => {
    const form = base()
    form.publisher.path = '/tmp/z'
    assert.equal(toPayload(form).publisher.config, undefined)

    form.publisher.writeConfig = false
    assert.equal(toPayload(form).publisher.config, false)
  })

  it('omits an empty optional rather than sending a blank string', () => {
    const form = base({ transportType: 'rsync' })
    form.transport.remote = 'host:/z'
    form.transport.sshKey = ''
    assert.equal('sshKey' in toPayload(form).transport, false)
  })

  it('only sends dnssec when it is turned on', () => {
    assert.equal(toPayload(base()).dnssec, undefined)

    const signed = toPayload(
      base({
        dnssec: {
          enabled: true,
          algorithm: 'ED25519',
          nsec3: true,
          keyset: '/var/lib/nictool/dnssec',
        },
      }),
    )
    assert.deepEqual(signed.dnssec, {
      enabled: true,
      nsec3: true,
      algorithm: 'ED25519',
      keyset: '/var/lib/nictool/dnssec',
    })
  })
})

describe('fromRecord', () => {
  it('round-trips a stored record', () => {
    const stored = {
      name: 'ns2.example.com.',
      ttl: 3600,
      address: '192.0.2.9',
      type: 'coredns',
      publisher: { type: 'coredns-redis', address: 'redis:6379', keyPrefix: '_dns:' },
      transport: { type: 'axfr', notify: ['192.0.2.1', '192.0.2.2'], interval: 600 },
    }
    const form = fromRecord(stored)
    assert.equal(form.type, 'coredns')
    assert.equal(form.publisherType, 'coredns-redis')
    assert.equal(form.transport.notify, '192.0.2.1, 192.0.2.2')

    const back = toPayload(form)
    assert.equal(back.publisher.address, 'redis:6379')
    assert.deepEqual(back.transport.notify, ['192.0.2.1', '192.0.2.2'])
  })

  it('gives a native record a starter listen row', () => {
    const form = fromRecord({ name: 'ns.', address: '192.0.2.1', type: 'native' })
    assert.equal(form.listen.length, 1)
    assert.equal(form.listen[0].port, 53)
  })

  it('maps a 2.x record onto its type', () => {
    const form = fromRecord({ name: 'old.', address: '192.0.2.1', type: 'djbdns' })
    assert.equal(form.type, 'djbdns')
    assert.equal(form.publisherType, 'tinydns-cdb')
  })

  // dynect and bind-nsupdate are export types a 2.x install can hold that no v3
  // nameserver implements. The select can only offer what it can build.
  it('falls back to bind for a type nothing here implements', () => {
    for (const type of ['dynect', 'bind-nsupdate']) {
      const form = fromRecord({ name: 'old.', address: '192.0.2.1', type })
      assert.equal(form.type, 'bind', type)
    }
  })

  it('starts a new record on defaults that validate', () => {
    const form = fromRecord(null)
    form.name = 'ns1.example.com.'
    form.address = '192.0.2.1'
    form.publisher.path = '/etc/bind/zones'
    assert.deepEqual(validate(form).errors, [])
  })
})

describe('dnssecFor', () => {
  it('routes each type to the tool that ships with it', () => {
    assert.deepEqual(dnssecFor(base()), { available: true, strategy: 'signer' })
    assert.deepEqual(dnssecFor(base({ type: 'knot' })), {
      available: true,
      strategy: 'self',
    })
    assert.deepEqual(dnssecFor(base({ type: 'powerdns' })), {
      available: true,
      strategy: 'self',
    })
    assert.deepEqual(dnssecFor(base({ type: 'native' })), {
      available: true,
      strategy: 'memory',
    })
  })

  it('reports why it is unavailable rather than just hiding it', () => {
    assert.match(dnssecFor(base({ type: 'maradns' })).reason, /no DNSSEC support/)
    assert.match(
      dnssecFor(base({ type: 'coredns', publisherType: 'coredns-redis' })).reason,
      /only zone files/,
    )
  })
})

describe('fieldsFor', () => {
  it('asks for a path where files are written and nothing where they are not', () => {
    assert.ok(fieldsFor(base()).publisher.includes('path'))
    assert.deepEqual(fieldsFor(base({ type: 'native' })).publisher, [])
    assert.deepEqual(fieldsFor(base({ publisherType: 'none' })).publisher, [])
  })

  it('names the config file the type will get', () => {
    assert.equal(fieldsFor(base()).config, 'named.conf')
    assert.equal(fieldsFor(base({ type: 'coredns' })).config, 'Corefile')
    assert.equal(fieldsFor(base({ type: 'native' })).config, null)
  })
})
