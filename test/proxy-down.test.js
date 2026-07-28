// An unreachable API must not take the server down with it.
//
// Regression guard: forwardToRemote rejected on ECONNREFUSED, and the call site
// did `return forwardToRemote(...)` without await — so the rejection escaped the
// enclosing try/catch, became an unhandled rejection, and killed the process.
// A tcp-mode API restart was enough to trigger it.
import assert from 'node:assert/strict'
import { test, before, after } from 'node:test'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-proxydown-'))

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

/** A port nothing listens on, so the proxy is guaranteed ECONNREFUSED. */
function closedPort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
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
    nicConfig: { configured: true, api: { mode: 'tcp' } },
    apiRemoteUrl: `http://127.0.0.1:${await closedPort()}`,
  })
  base = `https://127.0.0.1:${server.address().port}`
})

after(async () => {
  if (server) await new Promise((r) => server.close(r))
  fs.rmSync(tmp, { recursive: true, force: true })
})

test('answers 502 when the API is unreachable', { skip }, async () => {
  const res = await fetch(`${base}/api/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'someone', password: 'secret' }),
  })

  assert.equal(res.status, 502)
  assert.match((await res.json()).error, /API unreachable/)
})

test('stays up and keeps serving after the failed proxy', { skip }, async () => {
  // The crash showed up on the *next* request, once the process had died.
  await fetch(`${base}/api/session`, { method: 'POST', body: '{}' }).catch(() => {})

  const res = await fetch(`${base}/nt/service`)
  assert.equal(res.status, 200, 'the server survived an unreachable upstream')
})

test('survives repeated failures without leaking a crash', { skip }, async () => {
  for (let i = 0; i < 5; i++) {
    const res = await fetch(`${base}/api/zone`)
    assert.equal(res.status, 502)
  }

  assert.equal((await fetch(`${base}/nt/service`)).status, 200)
})
