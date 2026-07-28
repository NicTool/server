// Covers the upgrade path's two endpoints against a real MySQL database.
//
// The safety property under test: POST /nt/init-schema must refuse to run
// against a database that already holds NicTool tables — adopting one is the
// upgrade path's job. This test points it at a populated database and asserts
// both the 409 and that every table survives.
//
// Skips when MySQL is unreachable, so `npm test` stays DB-free by default.
import assert from 'node:assert/strict'
import { test, before, after } from 'node:test'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import mysql from 'mysql2/promise'

const DSN =
  process.env.NICTOOL_TEST_DSN ?? 'mysql://nictool:lootcin!mysql@127.0.0.1:3306/nictool'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-schema-'))

let tls = null
try {
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      path.join(tmp, 'key.pem'),
      '-out',
      path.join(tmp, 'cert.pem'),
      '-days',
      '2',
      '-subj',
      '/CN=127.0.0.1',
      '-addext',
      'subjectAltName=IP:127.0.0.1',
    ],
    { stdio: 'ignore' },
  )
  tls = {
    cert: fs.readFileSync(path.join(tmp, 'cert.pem'), 'utf8'),
    key: fs.readFileSync(path.join(tmp, 'key.pem'), 'utf8'),
  }
} catch {
  tls = null
}

async function tablesIn(dsn) {
  const u = new URL(dsn)
  const conn = await mysql.createConnection({
    host: u.hostname,
    port: Number(u.port) || 3306,
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: u.pathname.replace(/^\//, ''),
    connectTimeout: 3000,
  })
  try {
    const [rows] = await conn.query(
      'SELECT table_name AS t FROM information_schema.tables WHERE table_schema = ?',
      [u.pathname.replace(/^\//, '')],
    )
    return rows.map((r) => r.t ?? r.table_name)
  } finally {
    await conn.end()
  }
}

let skip = tls ? false : 'openssl not available to generate a test cert'
let populated = []

if (!skip) {
  try {
    populated = await tablesIn(DSN)
    if (!populated.includes('nt_options')) {
      skip = 'test database has no NicTool schema to guard against'
    }
  } catch (err) {
    skip = `MySQL unreachable: ${err.code ?? err.message}`
  }
}

let server, base

before(async () => {
  if (skip) return
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

  const { startServer } = await import(new URL('../index.js', import.meta.url))
  server = await startServer({
    configDir: tmp,
    tls,
    host: '127.0.0.1',
    port: 0,
    nicConfig: null,
  })
  base = `https://127.0.0.1:${server.address().port}`
})

after(async () => {
  if (server) await new Promise((r) => server.close(r))
  fs.rmSync(tmp, { recursive: true, force: true })
})

test('GET /nt/detect-schema finds an existing NicTool schema', { skip }, async () => {
  const res = await fetch(`${base}/nt/detect-schema?dsn=${encodeURIComponent(DSN)}`)
  assert.equal(res.status, 200)

  const body = await res.json()
  assert.equal(body.ok, true)
  assert.equal(body.found, true)
  assert.ok(body.tables.includes('nt_options'))
  assert.match(String(body.version), /^\d+\.\d+/, 'reports a db_version')
})

test(
  'GET /nt/detect-schema reports a reachable but empty database',
  { skip },
  async () => {
    const u = new URL(DSN)
    u.pathname = '/information_schema'
    const res = await fetch(
      `${base}/nt/detect-schema?dsn=${encodeURIComponent(u.toString())}`,
    )

    const body = await res.json()
    assert.equal(body.ok, true)
    assert.equal(body.found, false)
    assert.deepEqual(body.tables, [])
  },
)

test(
  'GET /nt/detect-schema reports connection failure without throwing',
  { skip },
  async () => {
    const bad = 'mysql://nobody:wrong@127.0.0.1:3306/nictool'
    const res = await fetch(`${base}/nt/detect-schema?dsn=${encodeURIComponent(bad)}`)

    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.ok, false)
    assert.ok(body.error)
  },
)

test(
  'POST /nt/init-schema refuses a populated database and leaves it intact',
  { skip },
  async () => {
    const res = await fetch(`${base}/nt/init-schema`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ install: 'new', dsn: DSN }),
    })

    assert.equal(res.status, 409, 'refuses rather than dropping tables')
    const body = await res.json()
    assert.match(body.error, /already contains NicTool tables/)

    const after = await tablesIn(DSN)
    assert.deepEqual(after.sort(), populated.sort(), 'every table survived')
  },
)

test('POST /nt/init-schema is unreachable during an upgrade', { skip }, async () => {
  const res = await fetch(`${base}/nt/init-schema`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ install: 'upgrade', dsn: DSN }),
  })

  assert.equal(res.status, 409)
  const body = await res.json()
  assert.match(body.error, /during an upgrade/)
})

test('POST /nt/init-schema requires a dsn', { skip }, async () => {
  const res = await fetch(`${base}/nt/init-schema`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ install: 'new' }),
  })

  assert.equal(res.status, 400)
})
