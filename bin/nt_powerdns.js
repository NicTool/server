#!/usr/bin/env node
/**
 * nt_powerdns.js — NicTool PowerDNS Pipe/Co-process backend (v1 protocol)
 *
 * Drop-in JS replacement for nt_powerdns.pl. Invoked by PowerDNS as a
 * pipe-command; communicates over stdin/stdout using tab-delimited lines.
 *
 * PowerDNS pipe backend v1 protocol:
 *   IN:  HELO\t<version>
 *   OUT: OK\t<banner>
 *
 *   IN:  Q\t<qname>\t<qclass>\t<qtype>\t<id>\t<remote-ip>
 *   OUT: DATA\t<qname>\t<qclass>\t<type>\t<ttl>\t<zone-id>\t<rdata...>
 *        END
 *
 *   IN:  AXFR\t<zone-id>
 *   OUT: DATA\t...  (all records for zone)
 *        END
 *
 *   IN:  PING
 *   OUT: END
 *
 * Environment variables:
 *   NT_PDNS_DB_HOST  (default: 127.0.0.1)
 *   NT_PDNS_DB_PORT  (default: 3306)
 *   NT_PDNS_DB_USER  (default: nictool)
 *   NT_PDNS_DB_PASS  (required)
 *   NT_PDNS_DB_NAME  (default: nictool)
 *   NT_PDNS_NS_ID    nameserver id to serve (default: 1)
 *   NT_PDNS_LOG      set to 1 for verbose stderr logging
 *   NT_PDNS_CACHE_TTL seconds to cache query results (default: 20)
 */

import readline from 'node:readline'
import mysql from 'mysql2/promise'

const NS_ID = Number(process.env.NT_PDNS_NS_ID ?? 1)
const CACHE_TTL = Number(process.env.NT_PDNS_CACHE_TTL ?? 20)
const LOG = process.env.NT_PDNS_LOG === '1'

const dbCfg = {
  host: process.env.NT_PDNS_DB_HOST ?? '127.0.0.1',
  port: Number(process.env.NT_PDNS_DB_PORT ?? 3306),
  user: process.env.NT_PDNS_DB_USER ?? 'nictool',
  password: process.env.NT_PDNS_DB_PASS,
  database: process.env.NT_PDNS_DB_NAME ?? 'nictool',
  ssl: { rejectUnauthorized: false },
}

if (!dbCfg.password) {
  write('FAIL')
  stderr('NT_PDNS_DB_PASS is required')
  process.exit(1)
}

// Simple TTL cache: Map<string, { data: any, expire: number }>
const cache = new Map()
function cacheGet(key) {
  const entry = cache.get(key)
  if (!entry) return null
  if (entry.expire < Date.now() / 1000) {
    cache.delete(key)
    return null
  }
  return entry.data
}
function cacheSet(key, data) {
  cache.set(key, { data, expire: Date.now() / 1000 + CACHE_TTL })
}

// -------------------------------------------------------------------------
// DB connection (reconnects on drop)
// -------------------------------------------------------------------------

let dbh = null

async function query(sql, params = []) {
  if (!dbh) {
    dbh = await mysql.createConnection(dbCfg)
    log(`MySQL connected (id ${dbh.connection.connectionId})`)
  }
  try {
    const [rows] = await dbh.execute(sql, params)
    return rows
  } catch (err) {
    if (err.code === 'PROTOCOL_CONNECTION_LOST' || err.code === 'ECONNRESET') {
      dbh = null
      const [rows] = await (await mysql.createConnection(dbCfg)).execute(sql, params)
      return rows
    }
    throw err
  }
}

// -------------------------------------------------------------------------
// Protocol I/O
// -------------------------------------------------------------------------

function write(line) {
  process.stdout.write(line + '\n')
}

function log(msg) {
  if (LOG) process.stderr.write(`[nt_powerdns] ${msg}\n`)
}

function stderr(msg) {
  process.stderr.write(`[nt_powerdns] ${msg}\n`)
}

function dataLine(qname, qclass, type, ttl, zoneId, ...rdata) {
  return ['DATA', qname, qclass, type, ttl, zoneId, ...rdata].join('\t')
}

// -------------------------------------------------------------------------
// Content helpers
// -------------------------------------------------------------------------

function rrContentFields(r) {
  const address = (r.address ?? '').replace(/\.$/, '')
  if (r.type === 'MX') {
    return [r.weight ?? 0, address]
  }
  if (r.type === 'SRV') {
    const priority = r.priority ?? 0
    const weight = r.weight ?? 0
    const port = r.other ?? 0
    return [priority, `${weight} ${port} ${address}`]
  }
  return [address]
}

function uniqRows(rows) {
  const seen = new Set()
  return rows.filter((r) => {
    const k = r.join('\t')
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

// -------------------------------------------------------------------------
// Query handlers
// -------------------------------------------------------------------------

async function getRecords(qname, qclass, qtype) {
  const cacheKey = `${qname}:${qtype}`
  const cached = cacheGet(cacheKey)
  if (cached) {
    log(`cache hit ${cacheKey}`)
    return cached
  }

  // Build ordered list of (zone, record) candidates from qname.
  // We peel labels off the front to find the containing zone.
  const labels = qname.replace(/\.$/, '').split('.')
  const order = []
  let prefix = ''

  for (let n = 0; n < labels.length; n++) {
    const zoneName = labels.slice(n).join('.')
    const recordName = prefix ? prefix : qname.replace(/\.$/, '') + '.'
    order.push({ zone: zoneName, record: recordName })
    // wildcard entry for parent zones
    if (n > 0) order.push({ zone: zoneName, record: `*.${zoneName}.` })
    prefix = prefix ? `${prefix}.${labels[n - 1]}` : labels[n - 1]
  }

  // Look up which zones this nameserver serves among the candidates.
  const wantedZones = [...new Set(order.map((e) => e.zone))]
  if (!wantedZones.length) return []

  const placeholders = wantedZones.map(() => '?').join(',')
  const zoneRows = await query(
    `SELECT z.nt_zone_id, z.zone
       FROM nt_zone z
       INNER JOIN nt_zone_nameserver ns ON ns.nt_zone_id = z.nt_zone_id
         AND ns.nt_nameserver_id = ?
      WHERE z.deleted = 0
        AND z.zone IN (${placeholders})`,
    [NS_ID, ...wantedZones],
  )

  const zoneIdFor = {}
  for (const z of zoneRows) zoneIdFor[z.zone] = z.nt_zone_id

  const pairs = []
  for (const e of order) {
    const zid = zoneIdFor[e.zone]
    if (zid !== undefined) pairs.push([zid, e.record])
  }
  if (!pairs.length) return []

  const pairPh = pairs.map(() => '(?,?)').join(',')
  const pairParams = pairs.flat()

  let typeClause = ''
  const extraParams = []
  if (qtype !== 'ANY') {
    typeClause = " AND (t.name = ? OR t.name = 'CNAME')"
    extraParams.push(qtype)
  }

  const rows = await query(
    `SELECT r.nt_zone_id, t.name AS type,
            r.name, r.ttl, r.address, r.weight, r.priority, r.other,
            r.nt_zone_record_id
       FROM nt_zone_record r
       INNER JOIN nt_zone z ON z.nt_zone_id = r.nt_zone_id AND z.deleted = 0
       INNER JOIN nt_zone_nameserver ns
               ON ns.nt_zone_id = z.nt_zone_id AND ns.nt_nameserver_id = ?
       LEFT JOIN resource_record_type t ON r.type_id = t.id
      WHERE (r.nt_zone_id, r.name) IN (${pairPh})
        AND r.deleted = 0${typeClause}`,
    [NS_ID, ...pairParams, ...extraParams],
  )

  const seen = new Set()
  const result = []
  for (const r of rows) {
    const content = rrContentFields(r)
    const line = ['DATA', qname, qclass, r.type, r.ttl, r.nt_zone_id, ...content]
    const key = line.join('\t')
    if (!seen.has(key)) {
      seen.add(key)
      result.push(line)
    }
  }

  cacheSet(cacheKey, result)
  return result
}

async function getNS(qname, qclass) {
  const rows = await query(
    `SELECT z.nt_zone_id, ns.ttl, ns.name, ns.address
       FROM nt_zone z
       INNER JOIN nt_zone_nameserver zns ON z.nt_zone_id = zns.nt_zone_id
       INNER JOIN nt_nameserver ns ON zns.nt_nameserver_id = ns.nt_nameserver_id
      WHERE z.zone = ? AND z.deleted = 0 AND ns.deleted = 0`,
    [qname.replace(/\.$/, '')],
  )

  return rows.map((r) => ['DATA', qname, qclass, 'NS', r.ttl, r.nt_zone_id, r.name])
}

async function getSOA(qname, qclass) {
  const rows = await query(
    `SELECT ns.name, z.*
       FROM nt_zone z
       INNER JOIN nt_zone_nameserver zns ON z.nt_zone_id = zns.nt_zone_id
       INNER JOIN nt_nameserver ns ON zns.nt_nameserver_id = ns.nt_nameserver_id
      WHERE z.zone = ? AND z.deleted = 0 AND ns.deleted = 0
      LIMIT 1`,
    [qname.replace(/\.$/, '')],
  )

  if (!rows.length) return []
  const z = rows[0]
  return [
    [
      'DATA',
      qname,
      qclass,
      'SOA',
      z.ttl,
      z.nt_zone_id,
      z.name,
      z.mailaddr,
      z.serial,
      z.refresh,
      z.retry,
      z.expire,
      z.ttl,
    ],
  ]
}

async function getAXFR(zoneId) {
  const rows = await query(
    `SELECT z.nt_zone_id, z.zone, t.name AS type,
            r.name, r.ttl, r.address, r.weight, r.priority, r.other
       FROM nt_zone z
       INNER JOIN nt_zone_record r ON z.nt_zone_id = r.nt_zone_id
       LEFT JOIN resource_record_type t ON r.type_id = t.id
      WHERE z.nt_zone_id = ? AND z.deleted = 0 AND r.deleted = 0`,
    [zoneId],
  )

  return rows.map((r) => {
    const fqdn = /\.$/.test(r.name) ? r.name : `${r.name}.${r.zone}`
    const content = rrContentFields(r)
    return ['DATA', fqdn, 'IN', r.type, r.ttl, r.nt_zone_id, ...content]
  })
}

// -------------------------------------------------------------------------
// Main loop
// -------------------------------------------------------------------------

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })

// HELO handshake — must be the first line
let heloReceived = false

for await (const line of rl) {
  const trimmed = line.trim()
  if (!trimmed) continue

  if (!heloReceived) {
    if (/^HELO\t\d+$/.test(trimmed)) {
      heloReceived = true
      write('OK\tNicTool PowerDNS backend ready')
      log(`HELO received — NS_ID=${NS_ID}`)
    } else {
      write('FAIL')
      stderr(`Expected HELO, got: ${trimmed}`)
      process.exit(1)
    }
    continue
  }

  const parts = trimmed.split('\t')
  const type = parts[0]

  log(`received: ${trimmed}`)

  try {
    if (type === 'Q') {
      const [, qname, qclass, qtype] = parts
      let rows = []

      if (qtype === 'SOA') {
        rows = await getSOA(qname, qclass)
        cacheSet(`${qname}:${qtype}`, rows)
      } else if (qtype === 'NS') {
        rows = uniqRows([
          ...(await getNS(qname, qclass)),
          ...(await getRecords(qname, qclass, qtype)),
        ])
        cacheSet(`${qname}:${qtype}`, rows)
      } else if (qtype === 'ANY') {
        rows = uniqRows([
          ...(await getRecords(qname, qclass, qtype)),
          ...(await getNS(qname, qclass)),
        ])
        cacheSet(`${qname}:${qtype}`, rows)
      } else {
        rows = await getRecords(qname, qclass, qtype)
      }

      for (const r of rows) write(r.join('\t'))
    } else if (type === 'AXFR') {
      const zoneId = parts[1]
      const rows = await getAXFR(zoneId)
      for (const r of rows) write(r.join('\t'))
    } else if (type === 'PING') {
      // no-op
    } else {
      stderr(`Unknown request type: ${type}`)
    }
  } catch (err) {
    stderr(`Error handling ${type}: ${err.message}`)
    write(`LOG\tError: ${err.message}`)
  }

  write('END')
}

if (dbh) await dbh.end()
log('Exiting')
