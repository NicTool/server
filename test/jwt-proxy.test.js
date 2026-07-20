// Exercises real JWT validation end-to-end through the server's /api proxy:
// mint a token via POST /api/session, then call the authenticated table
// endpoints with that Bearer token. Regression guard for the class of 401s
// where the proxy fails to forward the Authorization header or the in-process
// API rejects an otherwise-valid token.
//
// Runs the real Hapi API (toml store) behind the real startServer() proxy over
// TLS. node --test executes each file in its own process, so the chdir/env this
// test needs stay isolated from the jsdom component tests.
import assert from 'node:assert/strict'
import { test, before, after } from 'node:test'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const apiDir = fileURLToPath(new URL('../node_modules/@nictool/api/', import.meta.url))
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-jwt-'))
const store = path.join(tmp, 'store')
fs.mkdirSync(store)

// Self-signed cert for 127.0.0.1; skip the whole suite if openssl is unavailable.
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
const skip = tls ? false : 'openssl not available to generate a test cert'

let server, base, token, login, gid

before(async () => {
  if (skip) return

  process.env.NICTOOL_DATA_STORE = 'toml'
  process.env.NICTOOL_DATA_STORE_PATH = store
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
  process.chdir(apiDir) // the API loads config from ./conf.d relative to cwd

  const { default: Group } = await import(
    new URL('../node_modules/@nictool/api/lib/group/index.js', import.meta.url)
  )
  const { default: User } = await import(
    new URL('../node_modules/@nictool/api/lib/user/index.js', import.meta.url)
  )
  const groupCase = JSON.parse(
    fs.readFileSync(path.join(apiDir, 'routes/test/group.json')),
  )
  const userCase = JSON.parse(fs.readFileSync(path.join(apiDir, 'routes/test/user.json')))
  await Group.create(groupCase)
  await User.create(userCase)
  gid = groupCase.id
  login = {
    username: `${userCase.username}@${groupCase.name}`,
    password: userCase.password,
  }

  const { init: initAPI } = await import(
    new URL('../node_modules/@nictool/api/routes/index.js', import.meta.url)
  )
  const apiServer = await initAPI()

  const { startServer } = await import(new URL('../index.js', import.meta.url))
  server = await startServer({
    configDir: tmp,
    tls,
    host: '127.0.0.1',
    port: 0,
    nicConfig: { configured: true, api: { mode: 'local' } },
    apiServer,
  })
  base = `https://127.0.0.1:${server.address().port}`
})

after(async () => {
  if (server) await new Promise((r) => server.close(r))
  fs.rmSync(tmp, { recursive: true, force: true })
})

test('POST /api/session mints a token that fits in a cookie', { skip }, async () => {
  const res = await fetch(`${base}/api/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(login),
  })
  assert.equal(res.statusCode ?? res.status, 200)
  const body = await res.json()
  token = body?.session?.token
  assert.ok(token, 'session response includes a token')
  assert.ok(
    token.length < 4000,
    `token (${token.length} chars) must fit under the ~4KB cookie limit`,
  )
})

test('authenticated table endpoints accept the Bearer token', { skip }, async () => {
  for (const ep of [
    `/api/zone?gid=${gid}`,
    `/api/nameserver?gid=${gid}`,
    `/api/user?gid=${gid}`,
    `/api/group/${gid}`,
  ]) {
    const res = await fetch(`${base}${ep}`, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
    })
    assert.equal(
      res.status,
      200,
      `${ep} should be 200 with a valid token, got ${res.status}`,
    )
  }
})

test('the proxy enforces auth (no token -> 401)', { skip }, async () => {
  const res = await fetch(`${base}/api/zone?gid=${gid}`, {
    headers: { Accept: 'application/json' },
  })
  assert.equal(res.status, 401)
})

test(
  'static assets revalidate so a rebuilt bundle is never stale',
  { skip },
  async () => {
    const page = await fetch(`${base}/`, { headers: { Accept: 'text/html' } })
    assert.equal(page.headers.get('cache-control'), 'no-cache')

    const asset = await fetch(`${base}/dist/app.js`)
    if (asset.status !== 200) return // bundle not built in this environment
    const etag = asset.headers.get('etag')
    assert.ok(etag, 'built asset carries an ETag')
    assert.equal(asset.headers.get('cache-control'), 'no-cache')

    const revalidated = await fetch(`${base}/dist/app.js`, {
      headers: { 'If-None-Match': etag },
    })
    assert.equal(revalidated.status, 304)
  },
)
