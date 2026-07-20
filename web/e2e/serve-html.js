import fs from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Minimal static file server for the built app (html/ + html/dist/), used only
// by the Playwright app suite. Not part of the shipped server.
const htmlDir = fileURLToPath(new URL('../../html', import.meta.url))
const port = Number(process.argv[2] ?? 5175)

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
}

http
  .createServer(async (req, res) => {
    const urlPath = new URL(req.url, 'http://x').pathname
    const rel = path.normalize(urlPath === '/' ? 'index.html' : urlPath.slice(1))
    const filePath = path.join(htmlDir, rel)

    if (!filePath.startsWith(htmlDir)) {
      res.writeHead(403).end('Forbidden')
      return
    }

    try {
      const body = await fs.readFile(filePath)
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(filePath)] ?? 'application/octet-stream',
      })
      res.end(body)
    } catch {
      res.writeHead(404).end('Not Found')
    }
  })
  .listen(port, () => console.log(`serve-html on http://localhost:${port}`))
