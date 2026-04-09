import http from 'node:http'
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
 * @param {object} [opts.apiServer]  Initialized (but not listening) Hapi server for in-process API.
 * @param {object} [opts.suggestedPorts] Random port suggestions { api, client }.
 * @param {Function} [opts.onSaved]  Called with (config, ctx) after a successful save, once the
 *                                   response has flushed. May set ctx.apiServer.
 * @returns {Promise<https.Server>}
 */
export async function startServer({
  configDir,
  tls,
  host,
  port,
  nicConfig = null,
  apiServer = null,
  apiRemoteUrl = null,
  suggestedPorts = null,
  onSaved = null,
}) {
  const tomlPath = path.join(configDir, 'etc', 'nictool.toml')
  // ctx is mutated as services start/stop
  const ctx = { configDir, tomlPath, nicConfig, apiServer, apiRemoteUrl, suggestedPorts, host, onSaved }

  const server = https.createServer({ cert: tls.cert, key: tls.key }, (req, res) =>
    handleRequest(req, res, ctx),
  )

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, process.env.NICTOOL_BIND_HOST || host, resolve)
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

    if (url === '/nt/config' && method === 'GET') return serveConfig(res, ctx)
    if (url === '/nt/config' && method === 'POST') return await saveConfig(req, res, ctx)
    if (url?.startsWith('/nt/check-path') && method === 'GET') return await checkPath(req, res, ctx)
    if (url === '/nt/service' && method === 'GET') return serveService(res, ctx)
    if (url === '/nt/status' && method === 'GET') return await serveStatus(res, ctx)

    if (url?.startsWith('/api/') || url?.startsWith('/doc')) {
      if (ctx.apiServer) return await forwardToAPI(req, res, ctx.apiServer)
      if (ctx.apiRemoteUrl) return forwardToRemote(req, res, ctx.apiRemoteUrl)
    }

    if (method === 'GET' && url?.startsWith('/nictool/')) return await serveStatic(req, res, path.join(__dirname, 'node_modules', '@nictool'), '/nictool/')
    if (method === 'GET') return await serveStatic(req, res, path.join(__dirname, 'html'), '/')

    respond(res, 404, 'application/json', JSON.stringify({ error: `Not Found ${url}` }))
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
      respond(res, 404, 'application/json', JSON.stringify({ error: `Not Found: static ${urlPath}` }))
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

function serveService(res, { apiServer }) {
  const api = { running: apiServer != null }
  respond(res, 200, 'application/json', JSON.stringify({ api }, null, 2))
}

async function checkPath(req, res, { configDir }) {
  const qs = new URL(req.url, 'http://x').searchParams
  const p = qs.get('path')
  if (!p) return respond(res, 400, 'application/json', JSON.stringify({ error: 'path required' }))

  const resolved = path.isAbsolute(p) ? p : path.resolve(configDir, p)

  try {
    const stat = await fs.stat(resolved)
    if (stat.isDirectory()) {
      respond(res, 200, 'application/json', JSON.stringify({ ok: true, exists: true, resolved }))
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
        return respond(res, 200, 'application/json', JSON.stringify({ ok: true, exists: false, resolved }))
      } catch (e) {
        if (e.code !== 'ENOENT') break
        ancestor = path.dirname(ancestor)
      }
    }
    respond(res, 200, 'application/json', JSON.stringify({ ok: false, error: 'No writable ancestor directory found' }))
  }
}

async function serveStatus(res, { tomlPath, nicConfig, apiServer }) {
  const configured = await fileExists(tomlPath)
  const api = { running: apiServer != null }
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

  if (!config.store?.type) {
    return respond(res, 400, 'application/json', JSON.stringify({ error: 'Missing required fields' }))
  }
  if (config.api?.mode === 'remote' && (!config.api?.host || !(config.api?.port > 0))) {
    return respond(res, 400, 'application/json', JSON.stringify({ error: 'Remote API mode requires host and port' }))
  }

  // Mark configuration as complete — this is the flag that skips the configurator on next run
  config.configured = true

  try {
    await fs.mkdir(path.dirname(ctx.tomlPath), { recursive: true })
    await fs.writeFile(ctx.tomlPath, stringify(config))
    ctx.nicConfig = config
    res.on('finish', () => ctx.onSaved?.(config, ctx))
    respond(res, 200, 'application/json', JSON.stringify({ ok: true }))
  } catch (err) {
    respond(res, 500, 'application/json', JSON.stringify({ error: err.message }))
  }
}

// ---------------------------------------------------------------------------
// API forwarding — dispatches /api/* requests to the in-process Hapi server
// ---------------------------------------------------------------------------

async function forwardToAPI(req, res, hapiServer) {
  const apiPath = req.url.slice(4) || '/'  // strip '/api' prefix

  const forwardHeaders = {}
  for (const hdr of ['authorization', 'content-type', 'accept']) {
    if (req.headers[hdr]) forwardHeaders[hdr] = req.headers[hdr]
  }

  let payload
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    const body = await readBody(req)
    if (body) payload = body
  }

  const result = await hapiServer.inject({
    method: req.method,
    url: apiPath,
    headers: forwardHeaders,
    payload,
    remoteAddress: req.socket?.remoteAddress ?? '127.0.0.1',
  })

  res.writeHead(result.statusCode, {
    'Content-Type': result.headers['content-type'] ?? 'application/json',
  })
  res.end(result.rawPayload)
}

/**
 * Proxy /api/* to a remote API server at remoteBaseUrl.
 * Streams the request body directly without buffering.
 * Uses rejectUnauthorized:false so self-signed certs on internal services work.
 */
function forwardToRemote(req, res, remoteBaseUrl) {
  const apiPath = req.url.slice(4) || '/'
  const target = new URL(apiPath, remoteBaseUrl)
  const mod = target.protocol === 'https:' ? https : http

  const forwardHeaders = {}
  for (const hdr of ['authorization', 'content-type', 'accept', 'content-length']) {
    if (req.headers[hdr]) forwardHeaders[hdr] = req.headers[hdr]
  }

  return new Promise((resolve, reject) => {
    const upReq = mod.request(
      {
        hostname: target.hostname,
        port: target.port || (target.protocol === 'https:' ? 443 : 80),
        path: target.pathname + target.search,
        method: req.method,
        headers: forwardHeaders,
        rejectUnauthorized: false,
      },
      (upRes) => {
        const chunks = []
        upRes.on('data', (c) => chunks.push(c))
        upRes.on('end', () => {
          res.writeHead(upRes.statusCode, {
            'Content-Type': upRes.headers['content-type'] ?? 'application/json',
          })
          res.end(Buffer.concat(chunks))
          resolve()
        })
        upRes.on('error', reject)
      },
    )
    upReq.on('error', reject)
    req.pipe(upReq)
  })
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
