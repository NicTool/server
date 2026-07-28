import { EventEmitter } from 'node:events'

import {
  AxfrTransport,
  BindNS,
  DbReplicationTransport,
  KnotNS,
  MaradnsNS,
  MaradnsPublisher,
  MemoryPublisher,
  MemorySigner,
  MysqlSource,
  NativeNS,
  NoneSigner,
  NoopTransport,
  NsdNS,
  PowerdnsDbPublisher,
  PowerdnsNS,
  Rfc1035Publisher,
  Rfc1035Signer,
  RsyncTransport,
  TinydnsCdbPublisher,
  TinydnsNS,
  FileSource,
} from '@nictool/dns-nameserver'

const FILE_ENGINE_CLASSES = {
  bind: BindNS,
  knot: KnotNS,
  nsd: NsdNS,
  powerdns: PowerdnsNS,
  tinydns: TinydnsNS,
  maradns: MaradnsNS,
}

// MaraDNS reads csv2, not RFC 1035, and tinydns reads a compiled cdb.
const DEFAULT_PUBLISHER = {
  native: 'memory',
  tinydns: 'tinydns-cdb',
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
 * NameserverSupervisor – starts/stops the set of nameserver engines held in the
 * data store. Built to support many instances (so the deployment can run
 * several native NSes side-by-side, or mix native with export engines).
 *
 * start() takes { store, nameserver } — the store connection the engines read
 * zone data from, and the nameserver records. Each record may override the
 * default Source via its own `source`.
 *
 * Emits:
 *   started(engine)  — after successful start
 *   stopped(engine)  — after stop
 *   error(engine, err)
 */
export class NameserverSupervisor extends EventEmitter {
  constructor() {
    super()
    this.engines = []
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
        const engine = this._build(nsCfg, nicConfig, i)
        engine.on('error', (err) => this.emit('error', engine, err))
        await engine.start()
        this.engines.push(engine)
        console.log(
          `NS ${trimDot(engine.name ?? i)} started: engine=${engine.engine} listen=${formatListen(engine.listen)}`,
        )
        this.emit('started', engine)
      } catch (err) {
        console.error(`Nameserver[${nsCfg.name ?? i}] failed to start: ${err.message}`)
        this.emit('error', null, err)
      }
    }
  }

  async stop() {
    for (const engine of this.engines) {
      try {
        await engine.stop()
        this.emit('stopped', engine)
      } catch (err) {
        console.error(`Nameserver[${engine.name}] stop failed: ${err.message}`)
      }
    }
    this.engines = []
  }

  status() {
    return this.engines.map((e) => e.status())
  }

  _build(nsCfg, nicConfig, idx) {
    const engineName =
      nsCfg.engine ?? nsCfg.type ?? (nsCfg.exportType ? 'bind' : 'native')
    const source = this._buildSource(nsCfg, nicConfig)

    // Normalize listen[] from either the richer form or the legacy {host,port} shape.
    const listen =
      Array.isArray(nsCfg.listen) && nsCfg.listen.length
        ? nsCfg.listen
        : nsCfg.host && nsCfg.port
          ? [{ address: nsCfg.host, port: Number(nsCfg.port), proto: 'udp' }]
          : []

    const transportCfg = nsCfg.transport ?? { type: 'noop', interval: 0, cooldown: 5 }
    const publisherCfg = nsCfg.publisher ?? {
      type: engineName === 'native' ? 'memory' : 'rfc1035',
    }

    const signer = this._buildSigner(nsCfg)

    if (engineName === 'native') {
      if (publisherCfg.type !== 'memory') {
        throw new Error(
          `native engine requires publisher.type=memory (got "${publisherCfg.type}")`,
        )
      }
      return new NativeNS({
        id: nsCfg.id ?? idx + 1,
        name: nsCfg.name,
        listen,
        source,
        publisher: new MemoryPublisher(),
        signer,
        transport: new NoopTransport({
          interval: Number(transportCfg.interval ?? 0),
          cooldown: Number(transportCfg.cooldown ?? 1),
        }),
        dnssec: nsCfg.dnssec ?? null,
      })
    }

    const Klass = FILE_ENGINE_CLASSES[engineName]
    if (!Klass) throw new Error(`Unknown nameserver engine: "${engineName}"`)

    const publisher = this._buildPublisher(publisherCfg, engineName)
    const transport = this._buildTransport(transportCfg)

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

  _buildPublisher(cfg, engineName) {
    const type = cfg?.type ?? DEFAULT_PUBLISHER[engineName] ?? 'rfc1035'
    switch (type) {
      case 'rfc1035':
        // bind/knot/nsd all read RFC 1035 zone files but declare them in their
        // own config format, so the engine picks the config generator.
        return new Rfc1035Publisher({
          ...cfg,
          config: cfg?.config === false ? null : { format: engineName, ...cfg?.config },
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
      default:
        throw new Error(`Unknown publisher.type: "${type}"`)
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
          master: cfg.master,
          tsigKey: cfg.tsigKey,
          interval,
          cooldown,
        })
      case 'db-replication':
        return new DbReplicationTransport({ interval, cooldown })
      default:
        throw new Error(`Unknown transport.type: "${type}"`)
    }
  }

  _buildSigner(nsCfg) {
    const d = nsCfg.dnssec
    if (!d || !d.enabled) return new NoneSigner()
    const engineName = nsCfg.engine ?? nsCfg.type ?? 'native'
    if (engineName === 'native') return new MemorySigner(d)
    return new Rfc1035Signer(d)
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
