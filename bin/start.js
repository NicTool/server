#!/usr/bin/env node

import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { parseArgs, promisify } from 'node:util'

import { parse, stringify } from 'smol-toml'

import { startServer } from '../index.js'

const execFileAsync = promisify(execFile)

// ---------------------------------------------------------------------------
// CLI arguments
// ---------------------------------------------------------------------------

const { values } = parseArgs({
  options: {
    config: { type: 'string', short: 'c' },
  },
  strict: true,
})

if (!values.config) {
  console.log(`Usage: nictool-server -c <config-dir>

Options:
  -c, --config <dir>  Path to the NicTool data root (required).
                      TLS certificates are read from <dir>/etc/tls/ and
                      auto-generated for ${os.hostname()} if absent.
                      The configurator will build <dir>/etc/nictool.toml.

Example:
  nictool-server -c /var/lib/nictool`)
  process.exit(0)
}

const configDir = path.resolve(values.config)

// ---------------------------------------------------------------------------
// Verify config directory is readable
// ---------------------------------------------------------------------------

try {
  await fs.access(configDir, fs.constants.R_OK)
  await fs.readdir(configDir)
} catch (err) {
  console.error(`Cannot read directory ${configDir}: ${err.message}`)
  process.exit(1)
}

// ---------------------------------------------------------------------------
// TLS – discover existing certs or generate a self-signed one
// ---------------------------------------------------------------------------

const osHostname = os.hostname()
const tlsDir = path.join(configDir, 'etc', 'tls')

const discovered = await discoverTLS(tlsDir, osHostname)
let tls, host

if (discovered) {
  const { hostname: certHost, ...pemMaterial } = discovered
  tls = pemMaterial
  host = certHost
} else {
  console.log(`Generating self-signed cert for ${osHostname}`)
  tls = await generateTLS(tlsDir, osHostname)
  host = osHostname
}

// ---------------------------------------------------------------------------
// NicTool config (nictool.toml)
// ---------------------------------------------------------------------------

const tomlPath = path.join(configDir, 'etc', 'nictool.toml')
const nicConfig = await readNicToolToml(tomlPath)

// ---------------------------------------------------------------------------
// Port selection – prefer 443, fall back to 8443
// ---------------------------------------------------------------------------

const port = (await resolvePort(host, 443)) ?? (await resolvePort(host, 8443)) ?? (await randomAvailablePort(host))

// ---------------------------------------------------------------------------
// If already configured, skip the configurator and go straight to services
// ---------------------------------------------------------------------------

if (nicConfig?.configured === true) {
  console.log('Already configured — starting services.')
  const apiProcess = await maybeStartAPI(nicConfig)
  await startServer({ configDir, tls, host, port, nicConfig, apiProcess })
} else {
  // ---------------------------------------------------------------------------
  // Pre-select a random port to suggest for the API in the configuration form
  // ---------------------------------------------------------------------------

  const suggestedApiPort = await randomAvailablePort(host)

  const apiProcess = await maybeStartAPI(nicConfig)

  // ---------------------------------------------------------------------------
  // Start configurator; close it after the config is saved
  // ---------------------------------------------------------------------------

  await startServer({
    configDir,
    tls,
    host,
    port,
    nicConfig,
    apiProcess,
    suggestedPorts: { api: suggestedApiPort },
    startAPI: (config) => maybeStartAPI(config),
    onSaved: async (config, { apiProcess: currentApiProcess }) => {
      // API may already be running from a live toggle — only start if not
      if (!currentApiProcess) await maybeStartAPI(config)
    },
  })
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Try to load TLS from $hostname.pem, localhost.pem, or legacy cert.pem+key.pem.
 */
async function discoverTLS(dir, hostname) {
  const pemCandidates = [
    { file: path.join(dir, `${hostname}.pem`), hostname },
    { file: path.join(dir, 'localhost.pem'), hostname: 'localhost' },
  ]

  for (const { file, hostname: certHost } of pemCandidates) {
    try {
      const content = await fs.readFile(file, 'utf8')
      const parsed = parsePEMBlocks(content)
      if (parsed?.key && parsed?.cert) {
        console.log(`Using TLS from ${file}`)
        return { ...parsed, hostname: certHost }
      }
    } catch {
      /* not found — try next */
    }
  }

  // Legacy: separate cert.pem + key.pem — CN unknown, present as localhost
  try {
    const cert = await fs.readFile(path.join(dir, 'cert.pem'), 'utf8')
    const key = await fs.readFile(path.join(dir, 'key.pem'), 'utf8')
    console.log(`Using TLS from ${dir}/cert.pem + key.pem`)
    return { cert, key, hostname: 'localhost' }
  } catch {
    /* not found */
  }

  return null
}

/**
 * Extract private key and certificate chain from a combined PEM file.
 */
function parsePEMBlocks(content) {
  const keyMatch = content.match(
    /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z]+ )?PRIVATE KEY-----/,
  )
  const certMatches = [
    ...content.matchAll(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g),
  ]
  if (!keyMatch || !certMatches.length) return null
  return {
    key: keyMatch[0] + '\n',
    cert: certMatches.map((m) => m[0]).join('\n') + '\n',
  }
}

/**
 * Generate a self-signed cert for hostname and store as $hostname.pem.
 */
async function generateTLS(dir, hostname) {
  const pemFile = path.join(dir, `${hostname}.pem`)
  await fs.mkdir(dir, { recursive: true })

  const tmpKey = path.join(dir, '.tmp-key.pem')
  const tmpCert = path.join(dir, '.tmp-cert.pem')

  await execFileAsync('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-keyout',
    tmpKey,
    '-out',
    tmpCert,
    '-days',
    '365',
    '-nodes',
    '-subj',
    `/CN=${hostname}`,
  ])

  const [key, cert] = await Promise.all([fs.readFile(tmpKey, 'utf8'), fs.readFile(tmpCert, 'utf8')])
  await fs.writeFile(pemFile, key + cert)
  await Promise.allSettled([fs.unlink(tmpKey), fs.unlink(tmpCert)])

  console.log(`Generated self-signed certificate: ${pemFile}`)
  return { key, cert }
}

/**
 * Read nictool.toml if it exists. Returns null if absent — the file is only
 * written when the user submits the configuration form.
 */
async function readNicToolToml(tomlPath) {
  try {
    return parse(await fs.readFile(tomlPath, 'utf8'))
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
    return null
  }
}

/**
 * Return true if `host` resolves to a local address this machine controls.
 */
function isLocalHost(host) {
  if (!host) return false
  if (host === 'localhost' || host === os.hostname()) return true
  // Any loopback or private-range IP
  if (/^127\./.test(host)) return true
  if (/^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(host)) return true
  // Check against all local network interfaces
  const ifaces = os.networkInterfaces()
  return Object.values(ifaces).flat().some((i) => i.address === host)
}

/**
 * If nictool.toml specifies a local api.host, update the API package's
 * http.toml with the configured port and spawn it as a supervised child process.
 */
function storeTypeToEnv(type) {
  if (type === 'directory') return 'toml'
  return type ?? 'mysql'
}

async function maybeStartAPI(config) {
  if (!config || !config.api || !isLocalHost(config.api.host)) return null
  if (config.api?.start === false) return null

  const apiPkgDir = new URL('../node_modules/@nictool/api', import.meta.url).pathname
  const serverJs = path.join(apiPkgDir, 'server.js')

  try {
    await fs.access(serverJs, fs.constants.R_OK)
  } catch {
    console.warn(`API server not found at ${serverJs} — skipping API startup`)
    return null
  }

  // Patch the API's http.toml host+port to match nictool.toml
  const httpTomlPath = path.join(apiPkgDir, 'conf.d', 'http.toml')
  try {
    const content = await fs.readFile(httpTomlPath, 'utf8')
    const httpCfg = parse(content)
    if (httpCfg.host !== config.api.host || httpCfg.port !== config.api.port) {
      httpCfg.host = config.api.host
      httpCfg.port = config.api.port
      await fs.writeFile(httpTomlPath, stringify(httpCfg))
    }
  } catch (err) {
    console.warn(`Could not update API http.toml: ${err.message} — skipping API startup`)
    return null
  }

  // Patch the API's mysql.toml when nictool.toml uses a mysql store
  if (config.store?.type === 'mysql') {
    const mysqlTomlPath = path.join(apiPkgDir, 'conf.d', 'mysql.toml')
    try {
      const content = await fs.readFile(mysqlTomlPath, 'utf8')
      const mysqlCfg = parse(content)
      const s = config.store
      mysqlCfg.host     = s.host     ?? mysqlCfg.host
      mysqlCfg.port     = s.port     ?? mysqlCfg.port
      mysqlCfg.user     = s.user     ?? mysqlCfg.user
      mysqlCfg.password = s.password ?? mysqlCfg.password
      mysqlCfg.database = s.database ?? mysqlCfg.database
      await fs.writeFile(mysqlTomlPath, stringify(mysqlCfg))
    } catch (err) {
      console.warn(`Could not update API mysql.toml: ${err.message}`)
    }
  }

  const storeEnv = {
    NICTOOL_DATA_STORE: storeTypeToEnv(config.store?.type),
  }
  if (config.store?.path) storeEnv.NICTOOL_DATA_STORE_PATH = config.store.path
  if (config.store?.dsn)  storeEnv.NICTOOL_DATA_STORE_DSN  = config.store.dsn

  const child = spawn(process.execPath, [serverJs], {
    cwd: apiPkgDir,
    stdio: 'inherit',
    env: {
      ...process.env,
      NODE_ENV: process.env.NODE_ENV || 'production',
      ...storeEnv,
    },
  })

  child.on('error', (err) => console.error(`API process error: ${err.message}`))
  child.on('exit', (code, signal) => {
    if (signal) console.log(`API process killed by signal ${signal}`)
    else console.log(`API process exited with code ${code}`)
  })

  return child
}

/**
 * Bind to port 0 to get a random available port assigned by the OS.
 */
function randomAvailablePort(bindHost = 'localhost') {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.once('error', reject)
    srv.listen(0, bindHost, () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}

/**
 * Return `preferred` if it is available to bind on `host`, otherwise null.
 * Covers both EACCES (no privilege) and EADDRINUSE (already in use).
 */
function resolvePort(bindHost, preferred) {
  return new Promise((resolve) => {
    const probe = net.createServer()
    probe.once('error', () => resolve(null))
    probe.once('listening', () => {
      probe.close(() => resolve(preferred))
    })
    probe.listen(preferred, bindHost)
  })
}
