/**
 * The nameserver edit form's model: which pieces can be combined, what each
 * needs, and what is worth warning about.
 *
 * Kept apart from the DOM because the rules are the interesting part and they
 * come from the nameserver type, not from the markup — a publisher it cannot
 * read, or a transport with nothing configured to deliver, fails at start()
 * with a message nobody sees. The form's job is to make those combinations
 * unreachable.
 */

export const DNSSEC_ALGORITHMS = [
  'ECDSAP256SHA256',
  'ECDSAP384SHA384',
  'ED25519',
  'ED448',
  'RSASHA256',
  'RSASHA512',
]

/** Publishers every external nameserver can use, whatever it reads. */
const UNIVERSAL = ['none']

export const NS_TYPES = [
  {
    value: 'native',
    label: 'native (in-process)',
    serves: 'in-process',
    publishers: ['memory'],
    transports: ['noop'],
    needsListen: true,
    dnssec: 'memory',
  },
  {
    value: 'bind',
    label: 'BIND',
    serves: 'external',
    publishers: ['rfc1035', ...UNIVERSAL],
    transports: ['rsync', 'axfr', 'noop', 'pull'],
    config: 'named.conf',
    dnssec: 'signer',
  },
  {
    value: 'knot',
    label: 'Knot',
    serves: 'external',
    publishers: ['rfc1035', ...UNIVERSAL],
    transports: ['rsync', 'axfr', 'noop', 'pull'],
    config: 'knot.conf',
    dnssec: 'self',
  },
  {
    value: 'nsd',
    label: 'NSD',
    serves: 'external',
    publishers: ['rfc1035', ...UNIVERSAL],
    transports: ['rsync', 'axfr', 'noop', 'pull'],
    config: 'nsd.conf',
    dnssec: 'signer',
  },
  {
    value: 'coredns',
    label: 'CoreDNS',
    serves: 'external',
    publishers: ['rfc1035', 'coredns-redis', ...UNIVERSAL],
    transports: ['rsync', 'axfr', 'noop', 'pull'],
    config: 'Corefile',
    dnssec: 'signer',
  },
  {
    value: 'powerdns',
    label: 'PowerDNS',
    serves: 'external',
    publishers: ['powerdns-db', 'rfc1035', ...UNIVERSAL],
    transports: ['db-replication', 'rsync', 'axfr', 'noop', 'pull'],
    dnssec: 'self',
  },
  {
    value: 'djbdns',
    label: 'djbdns (tinydns + axfrdns)',
    serves: 'external',
    publishers: ['tinydns-cdb', ...UNIVERSAL],
    // No transfer config is generated for djbdns, so offering axfr here would
    // promise a far side this cannot set up.
    transports: ['rsync', 'noop', 'pull'],
    dnssec: 'none',
  },
  {
    value: 'maradns',
    label: 'MaraDNS',
    serves: 'external',
    publishers: ['maradns', ...UNIVERSAL],
    transports: ['rsync', 'noop', 'pull'],
    config: 'mararc',
    dnssec: 'none',
  },
]

export const PUBLISHERS = {
  memory: { label: 'memory (in-process map)', fields: [] },
  rfc1035: { label: 'RFC 1035 zone files', fields: ['path', 'writeConfig'] },
  maradns: { label: 'csv2 zone files', fields: ['path', 'writeConfig'] },
  'tinydns-cdb': { label: 'tinydns data.cdb', fields: ['path', 'compile'] },
  'powerdns-db': { label: 'PowerDNS database', fields: ['dsn', 'domainType'] },
  'coredns-redis': {
    label: 'Redis (CoreDNS redis plugin)',
    fields: ['address', 'password', 'keyPrefix'],
  },
  none: { label: 'none — this server fetches for itself', fields: [] },
}

export const TRANSPORTS = {
  noop: { label: 'none needed', fields: ['interval', 'cooldown'] },
  rsync: {
    label: 'rsync over ssh',
    fields: ['remote', 'sshKey', 'interval', 'cooldown'],
  },
  axfr: {
    label: 'AXFR (send NOTIFY)',
    fields: ['notify', 'tsigKey', 'interval', 'cooldown'],
  },
  'db-replication': { label: 'database replication', fields: ['interval', 'cooldown'] },
  pull: { label: 'the far side fetches', fields: ['pullSource', 'interval'] },
}

/** Per-type defaults, matching the supervisor's DEFAULT_PUBLISHER. */
const DEFAULT_PUBLISHER = {
  native: 'memory',
  bind: 'rfc1035',
  knot: 'rfc1035',
  nsd: 'rfc1035',
  coredns: 'rfc1035',
  powerdns: 'powerdns-db',
  djbdns: 'tinydns-cdb',
  maradns: 'maradns',
}

export const nsTypeFor = (value) => NS_TYPES.find((t) => t.value === value) ?? NS_TYPES[0]

export function publishersFor(nsType) {
  return nsTypeFor(nsType).publishers.map((type) => ({
    value: type,
    ...PUBLISHERS[type],
  }))
}

export function transportsFor(nsType) {
  return nsTypeFor(nsType).transports.map((type) => ({
    value: type,
    ...TRANSPORTS[type],
  }))
}

/**
 * Keep a publisher/transport choice if the new type can still use it,
 * otherwise fall back — switching bind to maradns must not leave rfc1035
 * selected, which start() would reject.
 */
export function reconcile(form) {
  const nsType = nsTypeFor(form.type)
  const publisher = nsType.publishers.includes(form.publisherType)
    ? form.publisherType
    : (DEFAULT_PUBLISHER[nsType.value] ?? nsType.publishers[0])
  const transport = nsType.transports.includes(form.transportType)
    ? form.transportType
    : nsType.transports[0]

  // A publisher that writes nothing has nothing to deliver.
  const forced = publisher === 'none' && transport !== 'pull' ? 'pull' : transport

  // A nameserver that binds sockets needs somewhere to bind them. Seeding a row
  // here rather than leaving the section empty means switching to native shows
  // what it wants instead of only complaining that it is missing.
  const listen =
    nsType.needsListen && !(form.listen ?? []).length
      ? [{ address: '127.0.0.1', port: 53, proto: 'udp' }]
      : (form.listen ?? [])

  return { ...form, publisherType: publisher, transportType: forced, listen }
}

/**
 * Reconciles first, like validate and toPayload: a caller that changed the
 * type without touching the publisher would otherwise be asked for fields
 * belonging to a publisher that type cannot use.
 */
export function fieldsFor(formIn) {
  const form = reconcile(formIn)
  const nsType = nsTypeFor(form.type)
  return {
    publisher: PUBLISHERS[form.publisherType]?.fields ?? [],
    transport: TRANSPORTS[form.transportType]?.fields ?? [],
    listen: nsType.needsListen,
    config: nsType.config ?? null,
    dnssec: dnssecFor(form),
  }
}

/**
 * How this combination gets signed, and whether it can be at all.
 *
 * `signer` needs zone files to sign — a publisher that writes rows or keys has
 * nothing for dnssec-signzone to read. `memory` signs the zone map in process,
 * so it needs the memory publisher and no external tool.
 */
export function dnssecFor(formIn) {
  const form = reconcile(formIn)
  const strategy = nsTypeFor(form.type).dnssec ?? 'none'

  if (strategy === 'signer' && form.publisherType !== 'rfc1035') {
    return { available: false, strategy, reason: 'only zone files can be signed' }
  }
  if (strategy === 'memory' && form.publisherType !== 'memory') {
    return { available: false, strategy, reason: 'only the zone map can be signed here' }
  }
  if (strategy === 'none') {
    return { available: false, strategy, reason: 'no DNSSEC support' }
  }
  return { available: true, strategy }
}

const isPort = (v) => Number.isInteger(Number(v)) && Number(v) >= 1 && Number(v) <= 65535

/**
 * @returns {{ errors: string[], warnings: string[] }} errors block saving;
 *   warnings describe a configuration that will start and then disappoint.
 */
export function validate(formIn, { storeType } = {}) {
  const form = reconcile(formIn)
  const fields = fieldsFor(form)
  const errors = []
  const warnings = []

  if (!form.name?.trim()) errors.push('Name is required.')
  else if (!form.name.trim().endsWith('.')) {
    errors.push('Name must be fully qualified, ending in a dot.')
  }
  if (!form.address?.trim()) errors.push('IPv4 address is required.')

  if (fields.listen) {
    const rows = (form.listen ?? []).filter((l) => l.address?.trim())
    if (!rows.length)
      errors.push('A native nameserver needs at least one listen address.')
    else if (!rows.every((l) => isPort(l.port))) {
      errors.push('Every listen row needs a port between 1 and 65535.')
    }
  }

  if (fields.publisher.includes('path') && !form.publisher?.path?.trim()) {
    errors.push('The publisher needs an output path.')
  }
  if (form.publisherType === 'powerdns-db' && !form.publisher?.dsn?.trim()) {
    errors.push('The PowerDNS publisher needs a database DSN.')
  }
  if (form.publisherType === 'coredns-redis' && !form.publisher?.address?.trim()) {
    errors.push('The Redis publisher needs an address.')
  }

  if (form.transportType === 'rsync' && !form.transport?.remote?.trim()) {
    errors.push('rsync needs a remote, such as user@host:/etc/bind/zones.')
  }
  if (form.transportType === 'axfr' && !notifyList(form).length) {
    errors.push('AXFR needs at least one notify target.')
  }

  const interval = Number(form.transport?.interval ?? 0)
  if (form.transport?.interval !== undefined && interval < 0) {
    errors.push('Interval cannot be negative.')
  }

  // --- warnings: these start, and then behave in a way worth knowing about ---

  if (form.dnssec?.enabled) {
    const dnssec = dnssecFor(form)
    if (!dnssec.available) {
      errors.push(
        dnssec.strategy === 'none'
          ? `${form.type} has no DNSSEC support, so it cannot be signed.`
          : 'DNSSEC needs a publisher that writes zone files.',
      )
    } else if (dnssec.strategy === 'signer') {
      warnings.push(
        'Zone files are signed here with dnssec-signzone; it must be installed on this host.',
      )
    } else if (dnssec.strategy === 'memory') {
      // NSEC3 is unimplemented in MemorySigner, which throws rather than
      // publishing an NSEC chain to someone who asked for NSEC3.
      if (form.dnssec.nsec3) {
        errors.push('The in-process signer supports NSEC only, not NSEC3.')
      }
      warnings.push(
        'NicTool signs the zone map itself, reading keys from the keyset directory. ' +
          'Generate them with dnssec-keygen; NicTool does not roll them.',
      )
    } else {
      warnings.push(
        `${form.type} signs its own zones — NicTool writes the policy into its config and manages no keys.`,
      )
    }
  }

  if (
    interval === 0 &&
    form.transportType !== 'pull' &&
    storeType === 'mysql' &&
    form.publisherType !== 'memory'
  ) {
    warnings.push(
      'Interval 0 waits for a change event, and a MySQL store sends none. ' +
        'This will publish once at startup and then only when something calls notifyZoneChanged.',
    )
  }

  if (
    form.publisherType === 'powerdns-db' &&
    form.transportType === 'axfr' &&
    (form.publisher?.domainType ?? 'NATIVE').toUpperCase() === 'NATIVE'
  ) {
    warnings.push(
      'PowerDNS at domain type NATIVE does not replicate, so there is no transfer for the NOTIFY to trigger. Use MASTER.',
    )
  }

  if (form.publisherType === 'coredns-redis') {
    warnings.push(
      'The CoreDNS redis plugin serves nine record types and PTR is not among them; reverse zones cannot be published here.',
    )
  }

  if (form.transportType === 'axfr' && form.transport?.tsigKey?.trim()) {
    const parts = form.transport.tsigKey.split(':')
    if (parts.length < 2 || parts.length > 3) {
      errors.push('TSIG key must be name:secret or algorithm:name:secret.')
    }
  }

  return { errors, warnings }
}

function notifyList(form) {
  const raw = form.transport?.notify
  if (Array.isArray(raw)) return raw.filter((t) => String(t).trim())
  return String(raw ?? '')
    .split(/[\s,]+/)
    .filter(Boolean)
}

/** Form state -> the record the API stores. */
export function toPayload(formIn) {
  const form = reconcile(formIn)
  const fields = fieldsFor(form)

  const payload = {
    name: form.name.trim(),
    ttl: Number(form.ttl) || 86400,
    description: form.description?.trim() || '',
    address: form.address?.trim() || undefined,
    address6: form.address6?.trim() || undefined,
    type: form.type,
    publisher: { type: form.publisherType },
    transport: { type: form.transportType },
  }

  if (fields.listen) {
    payload.listen = (form.listen ?? [])
      .filter((l) => l.address?.trim())
      .map((l) => ({
        address: l.address.trim(),
        port: Number(l.port) || 53,
        proto: l.proto || 'udp',
      }))
  }

  const p = form.publisher ?? {}
  for (const field of fields.publisher) {
    switch (field) {
      case 'path':
        if (p.path?.trim()) payload.publisher.path = p.path.trim()
        break
      case 'writeConfig':
        // `false` is meaningful — it suppresses the server config entirely.
        if (p.writeConfig === false) payload.publisher.config = false
        break
      case 'compile':
        if (p.compile === false) payload.publisher.compile = false
        break
      case 'dsn':
        if (p.dsn?.trim()) payload.publisher.dsn = p.dsn.trim()
        break
      case 'domainType':
        if (p.domainType) payload.publisher.domainType = p.domainType
        break
      case 'address':
        if (p.address?.trim()) payload.publisher.address = p.address.trim()
        break
      case 'password':
        if (p.password) payload.publisher.password = p.password
        break
      case 'keyPrefix':
        if (p.keyPrefix?.trim()) payload.publisher.keyPrefix = p.keyPrefix.trim()
        break
    }
  }

  const t = form.transport ?? {}
  for (const field of fields.transport) {
    switch (field) {
      case 'remote':
        if (t.remote?.trim()) payload.transport.remote = t.remote.trim()
        break
      case 'sshKey':
        if (t.sshKey?.trim()) payload.transport.sshKey = t.sshKey.trim()
        break
      case 'notify': {
        const list = notifyList(form)
        if (list.length) payload.transport.notify = list
        break
      }
      case 'tsigKey':
        if (t.tsigKey?.trim()) payload.transport.tsigKey = t.tsigKey.trim()
        break
      case 'pullSource':
        if (t.pullSource?.trim()) payload.transport.source = t.pullSource.trim()
        break
      case 'interval':
        payload.transport.interval = Number(t.interval ?? 0)
        break
      case 'cooldown':
        payload.transport.cooldown = Number(t.cooldown ?? 5)
        break
    }
  }

  if (form.dnssec?.enabled) {
    payload.dnssec = { enabled: true, nsec3: Boolean(form.dnssec.nsec3) }
    if (form.dnssec.algorithm) payload.dnssec.algorithm = form.dnssec.algorithm
    if (form.dnssec.keyset?.trim()) payload.dnssec.keyset = form.dnssec.keyset.trim()
  }

  return payload
}

/** A stored record -> form state, filling in what the record leaves out. */
export function fromRecord(ns) {
  const type = knownType(ns?.type)
  const base = {
    name: ns?.name ?? '',
    ttl: ns?.ttl ?? 86400,
    description: ns?.description ?? '',
    address: ns?.address ?? '',
    address6: ns?.address6 ?? '',
    type,
    publisherType: ns?.publisher?.type ?? DEFAULT_PUBLISHER[type] ?? 'rfc1035',
    transportType: ns?.transport?.type ?? 'noop',
    publisher: {
      path: ns?.publisher?.path ?? '',
      writeConfig: ns?.publisher?.config !== false,
      compile: ns?.publisher?.compile !== false,
      dsn: ns?.publisher?.dsn ?? '',
      domainType: ns?.publisher?.domainType ?? 'NATIVE',
      address: ns?.publisher?.address ?? '127.0.0.1:6379',
      password: ns?.publisher?.password ?? '',
      keyPrefix: ns?.publisher?.keyPrefix ?? '',
    },
    transport: {
      remote: ns?.transport?.remote ?? '',
      sshKey: ns?.transport?.sshKey ?? '',
      notify: (ns?.transport?.notify ?? []).join(', '),
      tsigKey: ns?.transport?.tsigKey ?? '',
      pullSource: ns?.transport?.source ?? '',
      interval: ns?.transport?.interval ?? 300,
      cooldown: ns?.transport?.cooldown ?? 5,
    },
    listen: (ns?.listen ?? []).map((l) => ({
      address: l.address ?? '',
      port: l.port ?? 53,
      proto: l.proto ?? 'udp',
    })),
    dnssec: {
      enabled: Boolean(ns?.dnssec?.enabled),
      algorithm: ns?.dnssec?.algorithm ?? 'ECDSAP256SHA256',
      nsec3: Boolean(ns?.dnssec?.nsec3),
      keyset: ns?.dnssec?.keyset ?? '',
    },
  }

  if (nsTypeFor(type).needsListen && !base.listen.length) {
    base.listen = [{ address: '127.0.0.1', port: 53, proto: 'udp' }]
  }
  return reconcile(base)
}

/**
 * 2.x export types that name how a nameserver is fed, not a different one.
 * Mirrors ALIASES in @nictool/validate, which the supervisor resolves with —
 * duplicated because this file is bundled for the browser.
 */
const ALIASES = { 'bind-nsupdate': 'bind' }

/**
 * A 2.x install can also hold `dynect`, which nothing here implements. The
 * select can only offer what it can build, so that lands on bind rather than
 * on a value the select cannot show.
 */
function knownType(type) {
  const resolved = ALIASES[type] ?? type
  return NS_TYPES.some((t) => t.value === resolved) ? resolved : 'bind'
}
