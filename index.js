import https from 'node:https'
import path from 'node:path'
import fs from 'node:fs/promises'

import { stringify } from 'smol-toml'

const __dirname = new URL('.', import.meta.url).pathname

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript',
  '.mjs':  'text/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.ico':  'image/x-icon',
  '.woff': 'font/woff',
  '.woff2':'font/woff2',
  '.txt':  'text/plain',
}

/**
 * Start the NicTool bootstrap configurator over HTTPS.
 *
 * @param {object} opts
 * @param {string} opts.configDir    Absolute path to the NicTool data root.
 * @param {{ cert: string, key: string }} opts.tls  PEM-encoded TLS material.
 * @param {string} opts.host         Hostname the server is bound to.
 * @param {number} opts.port         Port to listen on (443 or 8443).
 * @param {object} [opts.nicConfig]  Parsed nictool.toml contents, or null.
 * @param {object} [opts.apiProcess] Initial child process handle for the API.
 * @param {object} [opts.suggestedPorts] Random port suggestions { api, client }.
 * @param {Function} [opts.startAPI]  Async fn(config) → ChildProcess that starts the API.
 * @param {Function} [opts.onSaved]   Called with (config, {apiProcess}) after a
 *                                    successful save, once the response has flushed.
 * @returns {Promise<https.Server>}
 */
export async function startServer({
  configDir,
  tls,
  host,
  port,
  nicConfig = null,
  apiProcess = null,
  suggestedPorts = null,
  startAPI = null,
  onSaved = null,
}) {
  const tomlPath = path.join(configDir, 'etc', 'nictool.toml')
  // ctx is mutated as services start/stop
  const ctx = { configDir, tomlPath, nicConfig, apiProcess, suggestedPorts, host, startAPI, onSaved }

  const server = https.createServer({ cert: tls.cert, key: tls.key }, (req, res) =>
    handleRequest(req, res, ctx),
  )

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, resolve)
  })

  const url = `https://${host}${port === 443 ? '' : `:${port}`}`
  console.log(`Configurator: ${url}`)

  return server
}

// ---------------------------------------------------------------------------
// Request handler
// ---------------------------------------------------------------------------

async function handleRequest(req, res, ctx) {
  const { method, url } = req

  try {
    if (url === '/' && method === 'GET') {
      const page = ctx.nicConfig?.configured ? 'html/index.html' : 'html/configure.html'
      return await serveFile(res, page)
    }
    if (url === '/api/config' && method === 'GET') return serveConfig(res, ctx)
    if (url === '/api/config' && method === 'POST') return await saveConfig(req, res, ctx)
    if (url?.startsWith('/api/check-path') && method === 'GET') return await checkPath(req, res, ctx)
    if (url === '/api/service' && method === 'GET') return serveService(res, ctx)
    if (url === '/api/service/api' && method === 'POST') return await toggleService(req, res, ctx)
    if (url === '/api/status' && method === 'GET') return await serveStatus(res, ctx)

    if (method === 'GET' && url?.startsWith('/nictool/')) return await serveStatic(req, res, path.join(__dirname, 'node_modules', '@nictool'), '/nictool/')
    if (method === 'GET') return await serveStatic(req, res, path.join(__dirname, 'html'), '/')

    respond(res, 404, 'application/json', JSON.stringify({ error: 'Not Found' }))
  } catch (err) {
    console.error(err)
    respond(res, 500, 'application/json', JSON.stringify({ error: 'Internal Server Error' }))
  }
}

async function serveFile(res, relPath) {
  const ext = path.extname(relPath)
  const contentType = MIME[ext] ?? 'application/octet-stream'
  const content = await fs.readFile(path.join(__dirname, relPath), 'utf8')
  respond(res, 200, contentType, content)
}

async function serveStatic(req, res, rootDir, urlPrefix) {
  const urlPath = new URL(req.url, 'http://x').pathname
  const rel = path.normalize(urlPath.slice(urlPrefix.length) || '/')
  const filePath = path.join(rootDir, rel)

  // Prevent path traversal outside rootDir
  if (!filePath.startsWith(rootDir + path.sep) && filePath !== rootDir) {
    respond(res, 403, 'application/json', JSON.stringify({ error: 'Forbidden' }))
    return
  }

  try {
    const content = await fs.readFile(filePath)
    const contentType = MIME[path.extname(filePath)] ?? 'application/octet-stream'
    res.writeHead(200, { 'Content-Type': contentType })
    res.end(content)
  } catch (err) {
    if (err.code === 'ENOENT') {
      respond(res, 404, 'application/json', JSON.stringify({ error: 'Not Found' }))
    } else {
      throw err
    }
  }
}

function serveConfig(res, { nicConfig, suggestedPorts, host }) {
  if (nicConfig) {
    respond(res, 200, 'application/json', JSON.stringify({ ...nicConfig, _hostname: host }, null, 2))
  } else {
    respond(res, 200, 'application/json', JSON.stringify({ _suggested: suggestedPorts ?? {}, _hostname: host }, null, 2))
  }
}

function serveService(res, { apiProcess }) {
  const api = apiProcess
    ? { running: apiProcess.exitCode === null && !apiProcess.killed, pid: apiProcess.pid }
    : { running: false }
  respond(res, 200, 'application/json', JSON.stringify({ api }, null, 2))
}

async function toggleService(req, res, ctx) {
  let body
  try {
    body = JSON.parse(await readBody(req))
  } catch {
    return respond(res, 400, 'application/json', JSON.stringify({ error: 'Invalid JSON' }))
  }

  const want = !!body.running
  const isRunning = ctx.apiProcess && ctx.apiProcess.exitCode === null && !ctx.apiProcess.killed

  if (want && !isRunning) {
    if (!ctx.startAPI || !ctx.nicConfig) {
      return respond(res, 400, 'application/json', JSON.stringify({ error: 'No config to start API with' }))
    }
    ctx.apiProcess = await ctx.startAPI(ctx.nicConfig)
    console.log(`API started (pid ${ctx.apiProcess?.pid})`)
  } else if (!want && isRunning) {
    ctx.apiProcess.kill()
    ctx.apiProcess = null
    console.log('API stopped')
  }

  serveService(res, ctx)
}

async function checkPath(req, res, { configDir }) {
  const qs = new URL(req.url, 'http://x').searchParams
  const p = qs.get('path')
  if (!p) return respond(res, 400, 'application/json', JSON.stringify({ error: 'path required' }))

  const resolved = path.isAbsolute(p) ? p : path.resolve(configDir, p)

  try {
    const stat = await fs.stat(resolved)
    if (stat.isDirectory()) {
      respond(res, 200, 'application/json', JSON.stringify({ ok: true, exists: true }))
    } else {
      respond(res, 200, 'application/json', JSON.stringify({ ok: false, error: 'Path exists but is not a directory' }))
    }
  } catch (err) {
    if (err.code !== 'ENOENT') {
      return respond(res, 200, 'application/json', JSON.stringify({ ok: false, error: err.message }))
    }
    let ancestor = path.dirname(resolved)
    while (ancestor !== path.dirname(ancestor)) {
      try {
        await fs.access(ancestor, fs.constants.W_OK)
        return respond(res, 200, 'application/json', JSON.stringify({ ok: true, exists: false }))
      } catch (e) {
        if (e.code !== 'ENOENT') break
        ancestor = path.dirname(ancestor)
      }
    }
    respond(res, 200, 'application/json', JSON.stringify({ ok: false, error: 'No writable ancestor directory found' }))
  }
}

async function serveStatus(res, { tomlPath, nicConfig, apiProcess }) {
  const configured = await fileExists(tomlPath)
  const api = apiProcess
    ? { running: apiProcess.exitCode === null && !apiProcess.killed, pid: apiProcess.pid }
    : null
  respond(
    res,
    200,
    'application/json',
    JSON.stringify({ configured, tomlPath, config: nicConfig, api }, null, 2),
  )
}

async function saveConfig(req, res, ctx) {
  let body
  try {
    body = JSON.parse(await readBody(req))
  } catch {
    return respond(res, 400, 'application/json', JSON.stringify({ error: 'Invalid JSON' }))
  }

  // Strip runtime-only flags from the toml payload
  const { startApi: _startApi, _hostname: _h, _suggested: _s, ...config } = body

  if (!config.store?.type || !config.api?.host || !(config.api?.port > 0)) {
    return respond(res, 400, 'application/json', JSON.stringify({ error: 'Missing required fields' }))
  }

  // Mark configuration as complete — this is the flag that skips the configurator on next run
  config.configured = true

  try {
    await fs.mkdir(path.dirname(ctx.tomlPath), { recursive: true })
    await fs.writeFile(ctx.tomlPath, stringify(config))
    ctx.nicConfig = config
    res.on('finish', () => ctx.onSaved?.(config, { apiProcess: ctx.apiProcess }))
    respond(res, 200, 'application/json', JSON.stringify({ ok: true }))
  } catch (err) {
    respond(res, 500, 'application/json', JSON.stringify({ error: err.message }))
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString()))
    req.on('error', reject)
  })
}

function respond(res, status, contentType, body) {
  res.writeHead(status, { 'Content-Type': contentType })
  res.end(body)
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath, fs.constants.F_OK)
    return true
  } catch {
    return false
  }
}
