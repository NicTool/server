#!/usr/bin/env node

import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { parseArgs, promisify } from 'node:util'

import { parse, stringify } from 'smol-toml'

import { startServer } from '../index.js'
import { init as initAPI } from '@nictool/api/routes/index.js'

const execFileAsync = promisify(execFile)

// ---------------------------------------------------------------------------
// Prevent stray TLS errors (e.g. plain HTTP hitting the HTTPS port) from
// crashing the process.  Only EPROTO is swallowed; everything else exits.
// ---------------------------------------------------------------------------
process.on('uncaughtException', (err) => {
  if (err.code === 'EPROTO') {
    console.error(`[uncaughtException] TLS error (ignored): ${err.message}`)
    return
  }
  console.error('[uncaughtException] Fatal:', err)
  process.exit(1)
})

process.on('unhandledRejection', (reason) => {
  if (reason?.code === 'EPROTO') {
    console.error(`[unhandledRejection] TLS error (ignored): ${reason.message}`)
    return
  }
  console.error('[unhandledRejection] Fatal:', reason)
  process.exit(1)
})

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
// TLS – skip entirely in development mode, otherwise discover or generate
// ---------------------------------------------------------------------------

const useTLS = (process.env.NICTOOL_TLS ?? 'auto') !== 'false'
const osHostname = os.hostname()
let tls = null
let host = osHostname

if (!useTLS) {
  console.log('TLS disabled (NICTOOL_TLS=false) — running plain HTTP')
  host = 'localhost'
} else {
  const tlsDir = path.join(configDir, 'etc', 'tls')
  const discovered = await discoverTLS(tlsDir, osHostname)

  if (discovered) {
    const { hostname: certHost, ...pemMaterial } = discovered
    tls = pemMaterial
    host = certHost
  } else {
    console.log(`Generating self-signed cert for ${osHostname}`)
    tls = await generateTLS(tlsDir, osHostname)
  }
}

// ---------------------------------------------------------------------------
// NicTool config (nictool.toml)
// ---------------------------------------------------------------------------

const tomlPath = path.join(configDir, 'etc', 'nictool.toml')
const nicConfig = await readNicToolToml(tomlPath)

// ---------------------------------------------------------------------------
// Port selection – HTTP prefers 8080, HTTPS prefers 443/8443
// ---------------------------------------------------------------------------

const port = useTLS
  ? ((await resolvePort(host, 443)) ?? (await resolvePort(host, 8443)) ?? (await randomAvailablePort(host)))
  : ((await resolvePort(host, 8080)) ?? (await resolvePort(host, 80)) ?? (await randomAvailablePort(host)))

// ---------------------------------------------------------------------------
// If already configured, skip the configurator and go straight to services
// ---------------------------------------------------------------------------

if (nicConfig?.configured === true) {
  console.log('Already configured — starting services.')
  const apiServer = await maybeInitAPI(nicConfig)
  const apiRemoteUrl = buildRemoteUrl(nicConfig)
  await startServer({ configDir, tls, host, port, nicConfig, apiServer, apiRemoteUrl })
} else {
  // ---------------------------------------------------------------------------
  // Pre-select a random port to suggest for the API in the configuration form
  // ---------------------------------------------------------------------------

  const suggestedApiPort = await randomAvailablePort(host)

  // ---------------------------------------------------------------------------
  // Start configurator; wire up API once config is saved
  // ---------------------------------------------------------------------------

  await startServer({
    configDir,
    tls,
    host,
    port,
    nicConfig,
    suggestedPorts: { api: suggestedApiPort },
    onSaved: async (config, ctx) => {
      if (!ctx.apiServer && !ctx.apiRemoteUrl) {
        ctx.apiServer = await maybeInitAPI(config)
        ctx.apiRemoteUrl = buildRemoteUrl(config)
      }
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

function storeTypeToEnv(type) {
  if (type === 'directory') return 'toml'
  return type ?? 'mysql'
}

/**
 * Return the remote API base URL (e.g. "https://api.example.com:3000") when
 * api.mode is "remote", otherwise null.
 */
function buildRemoteUrl(config) {
  if (!config?.api || config.api.mode !== 'remote') return null
  const { host, port, scheme: configScheme } = config.api
  if (!host || !port) return null
  const scheme = configScheme ?? 'http'
  return `${scheme}://${host}:${port}`
}

/**
 * When api.mode is "local" (or unset), patch the API's mysql.toml, set
 * required env vars, and initialize the Hapi server in-process without
 * binding to any port.
 *
 * @returns {Promise<import('@hapi/hapi').Server|null>}
 */
async function maybeInitAPI(config) {
  if (!config || !config.api) return null
  if (config.api.mode === 'remote') return null

  const apiPkgDir = new URL('../node_modules/@nictool/api', import.meta.url).pathname

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

  // Set process env vars the API reads at init time
  process.env.NICTOOL_DATA_STORE = storeTypeToEnv(config.store?.type)
  if (config.store?.path) process.env.NICTOOL_DATA_STORE_PATH = config.store.path
  if (config.store?.dsn)  process.env.NICTOOL_DATA_STORE_DSN  = config.store.dsn

  try {
    const hapiServer = await initAPI()
    console.log('API initialized in-process')
    return hapiServer
  } catch (err) {
    console.error(`API init failed: ${err.message}`)
    return null
  }
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
