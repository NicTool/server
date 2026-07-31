import { EventEmitter } from 'node:events'

import {
  AxfrTransport,
  BindNS,
  DbReplicationTransport,
  KnotNS,
  CorednsNS,
  CorednsRedisPublisher,
  MaradnsNS,
  MaradnsPublisher,
  MemoryPublisher,
  MemorySigner,
  MysqlSource,
  NativeNS,
  strategyFor,
  NonePublisher,
  NoneSigner,
  NoopTransport,
  PullTransport,
  NsdNS,
  PowerdnsDbPublisher,
  PowerdnsNS,
  DjbdnsNS,
  Rfc1035Publisher,
  Rfc1035Signer,
  RsyncTransport,
  TinydnsCdbPublisher,
  FileSource,
} from '@nictool/dns-nameserver'
import { nameserver } from '@nictool/validate'

// The stored type may be a 2.x alias (tinydns, bind-nsupdate). @nictool/validate
// owns that mapping, so the API and the supervisor cannot disagree about it.
const { resolveType } = nameserver

const FILE_NS_CLASSES = {
  bind: BindNS,
  knot: KnotNS,
  nsd: NsdNS,
  powerdns: PowerdnsNS,
  coredns: CorednsNS,
  djbdns: DjbdnsNS,
  maradns: MaradnsNS,
}

const DEFAULT_PUBLISHER = {
  native: 'memory',
  djbdns: 'tinydns-cdb',
  maradns: 'maradns',
  powerdns: 'rfc1035',
}

const trimDot = (name) => `${name}`.replace(/\.$/, '')

// Collapse listen[] to a compact "addr:port" list, deduping the udp/tcp pair.
function formatListen(listen) {
  if (!Array.isArray(listen)) return `${listen ?? ''}`
  const seen = new Set()
  for (const l of listen) seen.add(`${l.address}:${l.port}`)
  return [...seen].join(', ')
}

/**
 * NameserverSupervisor – starts/stops the set of nameservers held in the
 * data store. Built to support many instances (so the deployment can run
 * several native NSes side-by-side, or mix native with exporting ones).
 *
 * start() takes { store, nameserver } — the store connection the nameservers read
 * zone data from, and the nameserver records. Each record may override the
 * default Source via its own `source`.
 *
 * Emits:
 *   started(ns)  — after successful start
 *   stopped(ns)  — after stop
 *   error(ns, err)
 */
export class NameserverSupervisor extends EventEmitter {
  constructor() {
    super()
    this.nameservers = []
  }

  async start(nicConfig) {
    const list = Array.isArray(nicConfig?.nameserver) ? nicConfig.nameserver : []
    if (list.length === 0) {
      console.log('Nameservers: none configured')
      return
    }

    for (let i = 0; i < list.length; i++) {
      const nsCfg = list[i]
      try {
        const ns = this._build(nsCfg, nicConfig, i)
        ns.on('error', (err) => this.emit('error', ns, err))
        await ns.start()
        this._warnIfStale(ns, nsCfg.transport)
        this.nameservers.push(ns)
        console.log(
          `NS ${trimDot(ns.name ?? i)} started: type=${ns.type} listen=${formatListen(ns.listen)}`,
        )
        this.emit('started', ns)
      } catch (err) {
        console.error(`Nameserver[${nsCfg.name ?? i}] failed to start: ${err.message}`)
        this.emit('error', null, err)
      }
    }
  }

  async stop() {
    for (const ns of this.nameservers) {
      try {
        await ns.stop()
        this.emit('stopped', ns)
      } catch (err) {
        console.error(`Nameserver[${ns.name}] stop failed: ${err.message}`)
      }
    }
    this.nameservers = []
  }

  /**
   * Tell every running nameserver the zone data changed, so those in event mode
   * publish. Called by whoever performed the write — sources over MySQL cannot
   * notice it themselves.
   */
  notifyZoneChanged(detail) {
    for (const ns of this.nameservers) {
      ns.source?.notifyZoneChanged?.(detail)
    }
  }

  // Event mode with a source that neither watches nor gets notified publishes
  // once at startup and then serves that snapshot forever.
  _warnIfStale(ns, transportCfg) {
    // A pull nameserver is meant to sit idle; nothing here publishes to it.
    if (transportCfg?.type === 'pull') return
    const interval = Number(transportCfg?.interval ?? 0)
    if (interval > 0) return
    if (ns.source?.watches) return
    console.warn(
      `NS ${trimDot(ns.name ?? ns.id)}: interval 0 with a source that does not ` +
        `watch — it will publish once and then only on an external change notification`,
    )
  }

  // 2.x's bind-nsupdate pushed changes into a running BIND with RFC 2136. That
  // is a transport here, and resolving the type to plain bind does not carry it
  // over — an adopted record left on noop would quietly write files nobody reads.
  _warnIfPushLost(nsCfg) {
    if (nsCfg.type !== 'bind-nsupdate') return
    const transport = nsCfg.transport?.type ?? 'noop'
    if (transport !== 'noop') return
    console.warn(
      `NS ${trimDot(nsCfg.name ?? '')}: adopted from 2.x bind-nsupdate, which pushed ` +
        `updates over the network. Publishing zone files locally instead — set ` +
        `transport.type (axfr or rsync) to deliver them.`,
    )
  }

  // NOTIFY tells a secondary to come and transfer. PowerDNS at NATIVE is not
  // replicating, so there may be nothing for it to transfer from.
  _warnIfAxfrUnserved(publisherType, publisherCfg, transportCfg) {
    if (transportCfg?.type !== 'axfr') return
    if (publisherType !== 'powerdns-db') return
    const domainType = (publisherCfg?.domainType ?? 'NATIVE').toUpperCase()
    if (domainType === 'NATIVE') {
      console.warn(
        'axfr transport with publisher.domainType=NATIVE — PowerDNS will not serve the ' +
          'transfer the NOTIFY asks for; set publisher.domainType=MASTER',
      )
    }
  }

  status() {
    return this.nameservers.map((ns) => ns.status())
  }

  _build(nsCfg, nicConfig, idx) {
    const nsType = resolveType(nsCfg.type ?? 'native')
    this._warnIfPushLost(nsCfg)
    const source = this._buildSource(nsCfg, nicConfig)

    // Normalize listen[] from either the richer form or the legacy {host,port} shape.
    const listen =
      Array.isArray(nsCfg.listen) && nsCfg.listen.length
        ? nsCfg.listen
        : nsCfg.host && nsCfg.port
          ? [{ address: nsCfg.host, port: Number(nsCfg.port), proto: 'udp' }]
          : []

    const transportCfg = nsCfg.transport ?? { type: 'noop', interval: 0, cooldown: 5 }
    // Resolve the type here rather than in _buildPublisher: substituting a
    // default cfg object with a type baked in meant DEFAULT_PUBLISHER was only
    // consulted for `publisher: {}`, never for an omitted publisher, so djbdns
    // and maradns silently got rfc1035.
    const publisherCfg = nsCfg.publisher ?? {}
    const publisherType = publisherCfg.type ?? DEFAULT_PUBLISHER[nsType] ?? 'rfc1035'

    const signer = this._buildSigner(nsCfg, nsType, publisherType)

    if (nsType === 'native') {
      if (publisherType !== 'memory') {
        throw new Error(`native requires publisher.type=memory (got "${publisherType}")`)
      }
      const memoryPublisher = new MemoryPublisher()
      // MemorySigner edits the live zone map, which only the publisher holds.
      signer.attach?.(memoryPublisher)
      return new NativeNS({
        id: nsCfg.id ?? idx + 1,
        name: nsCfg.name,
        listen,
        source,
        publisher: memoryPublisher,
        signer,
        transport: new NoopTransport({
          interval: Number(transportCfg.interval ?? 0),
          cooldown: Number(transportCfg.cooldown ?? 1),
        }),
        dnssec: nsCfg.dnssec ?? null,
      })
    }

    const Klass = FILE_NS_CLASSES[nsType]
    if (!Klass) throw new Error(`Unknown nameserver type: "${nsType}"`)

    const publisher = this._buildPublisher(
      publisherCfg,
      publisherType,
      nsType,
      transportCfg,
      this._dnssecConfig(nsCfg, nsType),
    )
    const transport = this._buildTransport(transportCfg)
    this._warnIfAxfrUnserved(publisherType, publisherCfg, transportCfg)

    return new Klass({
      id: nsCfg.id ?? idx + 1,
      name: nsCfg.name,
      listen,
      source,
      publisher,
      signer,
      transport,
      dnssec: nsCfg.dnssec ?? null,
    })
  }

  _buildPublisher(cfg, publisherType, nsType, transportCfg, dnssec) {
    // A notify list configured on the transport also has to reach the generated
    // server config: sending NOTIFY achieves nothing if the primary refuses the
    // transfer that follows.
    const notify =
      transportCfg?.type === 'axfr'
        ? (transportCfg.notify ?? (transportCfg.master ? [transportCfg.master] : []))
        : []

    switch (publisherType) {
      case 'rfc1035':
        // bind/knot/nsd all read RFC 1035 zone files but declare them in their
        // own config format, so the nameserver type picks the config generator.
        return new Rfc1035Publisher({
          ...cfg,
          config:
            cfg?.config === false
              ? null
              : { format: nsType, notify, dnssec, ...cfg?.config },
        })
      case 'maradns':
        return new MaradnsPublisher({
          ...cfg,
          config: cfg?.config === false ? null : { ...cfg?.config },
        })
      case 'tinydns-cdb':
        return new TinydnsCdbPublisher({ ...cfg })
      case 'powerdns-db':
        return new PowerdnsDbPublisher({ ...cfg })
      case 'coredns-redis':
        return new CorednsRedisPublisher({ ...cfg })
      case 'none':
        return new NonePublisher({ ...cfg })
      default:
        throw new Error(`Unknown publisher.type: "${publisherType}"`)
    }
  }

  _buildTransport(cfg) {
    const interval = Number(cfg?.interval ?? 300)
    const cooldown = Number(cfg?.cooldown ?? 5)
    const type = cfg?.type ?? 'noop'
    switch (type) {
      case 'noop':
        return new NoopTransport({ interval, cooldown })
      case 'rsync':
        return new RsyncTransport({
          remote: cfg.remote,
          sshKey: cfg.sshKey,
          interval,
          cooldown,
        })
      case 'axfr':
        return new AxfrTransport({
          notify: cfg.notify,
          master: cfg.master,
          tsigKey: cfg.tsigKey,
          port: cfg.port,
          timeoutMs: cfg.timeoutMs,
          attempts: cfg.attempts,
          interval,
          cooldown,
        })
      case 'db-replication':
        return new DbReplicationTransport({ interval, cooldown })
      case 'pull':
        return new PullTransport({ interval, cooldown, source: cfg.source })
      default:
        throw new Error(`Unknown transport.type: "${type}"`)
    }
  }

  /**
   * DNSSEC is done with whatever the nameserver already provides, so this picks a
   * strategy rather than a signer:
   *
   *   signer  bind/nsd/coredns read a signed zone file, so sign it here.
   *   engine  Knot and PowerDNS sign their own zones; the config generator
   *           tells them to, and no signer runs.
   *   none    djbdns and MaraDNS have no DNSSEC, and native would mean
   *           implementing the crypto here.
   */
  _buildSigner(nsCfg, nsType, publisherType) {
    const d = nsCfg.dnssec
    if (!d || !d.enabled) return new NoneSigner()

    switch (strategyFor(nsType)) {
      case 'signer':
        if (publisherType !== 'rfc1035') {
          throw new Error(
            `dnssec: ${nsType} can only be signed when publishing zone files ` +
              `(publisher.type=rfc1035, got "${publisherType}")`,
          )
        }
        return new Rfc1035Signer(d)
      case 'memory':
        // No external tool because there is no external server: MemorySigner
        // signs the live map that NativeNS answers from.
        return new MemorySigner(d)
      case 'self':
        // Signing happens on the far side; see _dnssecConfig.
        return new NoneSigner()
      default:
        throw new Error(
          `dnssec: ${nsType} has no signing support — ` +
            `no tool ships with it, and NicTool does not sign zones itself`,
        )
    }
  }

  /** The policy a nameserver that signs for itself needs in its config. */
  _dnssecConfig(nsCfg, nsType) {
    const d = nsCfg.dnssec
    if (!d?.enabled || strategyFor(nsType) !== 'self') return null
    return { algorithm: d.algorithm, nsec3: Boolean(d.nsec3) }
  }

  _buildSource(nsCfg, nicConfig) {
    // Per-nameserver override takes precedence; otherwise inherit top-level [store].
    const srcCfg =
      nsCfg.source && nsCfg.source.type !== 'inherit' ? nsCfg.source : nicConfig?.store

    const type = srcCfg?.type
    switch (type) {
      case 'json':
        return new FileSource({ path: srcCfg.path, format: 'json' })
      case 'directory':
      case 'toml':
        return new FileSource({ path: srcCfg.path, format: 'toml' })
      case 'mysql':
        return new MysqlSource(srcCfg)
      default:
        throw new Error(`Unsupported source type: ${type ?? '(missing)'}`)
    }
  }
}

export default NameserverSupervisor
