// The Node side of the Android port's plumbing: one HTTP server on the
// loopback address that
//   - serves every page's resources (custom schemes, file://) through the
//     handlers the app registered with protocol.handle (urlmap.js);
//   - injects page.js into each page, which stands in for the preload
//     environment and talks to ipcMain over /__go/ipc and /__go/events;
//   - carries the host channel to the Java side (/__go/host/*), which owns
//     the WebViews, dialogs and menus.
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { Readable } = require('node:stream')
const codec = require('./codec')

const RUNTIME = __dirname
const TOKEN = process.env.GO_TOKEN || crypto.randomBytes(16).toString('hex')
const DEV = process.env.GO_DEV === '1'

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.emf': 'image/emf',
  '.wmf': 'image/wmf',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.xml': 'application/xml',
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
}

function mimeOf(file) {
  return MIME[path.extname(file).toLowerCase()] || 'application/octet-stream'
}

/** A Response for a file on disk, as Electron's net.fetch(file://) gives. */
async function fileResponse(file, request) {
  let stat
  try {
    stat = await fs.promises.stat(file)
  } catch {
    return new Response(null, { status: 404 })
  }
  if (!stat.isFile()) return new Response(null, { status: 404 })
  const headers = { 'content-type': mimeOf(file), 'content-length': String(stat.size), 'accept-ranges': 'bytes' }
  const range = request?.headers?.get?.('range')
  const m = range && /^bytes=(\d*)-(\d*)$/.exec(range)
  if (m && stat.size > 0) {
    let start = m[1] === '' ? Math.max(0, stat.size - Number(m[2])) : Number(m[1])
    let end = m[1] !== '' && m[2] !== '' ? Number(m[2]) : stat.size - 1
    end = Math.min(end, stat.size - 1)
    if (start <= end) {
      headers['content-range'] = `bytes ${start}-${end}/${stat.size}`
      headers['content-length'] = String(end - start + 1)
      return new Response(Readable.toWeb(fs.createReadStream(file, { start, end })), { status: 206, headers })
    }
  }
  return new Response(Readable.toWeb(fs.createReadStream(file)), { status: 200, headers })
}

const PAGE_SCRIPT = '<script src="/__go/page.js"></script>'
const CSP_META = /<meta[^>]+http-equiv\s*=\s*["']?content-security-policy["']?[^>]*>/gi

function injectPage(html) {
  html = html.replace(CSP_META, '')
  const head = /<head(\s[^>]*)?>/i.exec(html)
  if (head) return html.slice(0, head.index + head[0].length) + PAGE_SCRIPT + html.slice(head.index + head[0].length)
  const tag = /<html(\s[^>]*)?>/i.exec(html)
  if (tag) return html.slice(0, tag.index + tag[0].length) + PAGE_SCRIPT + html.slice(tag.index + tag[0].length)
  return PAGE_SCRIPT + html
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function sendJson(res, value, status = 200) {
  const body = JSON.stringify(value)
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': '*' })
  res.end(body)
}

/** An event stream (SSE): queued while no client is connected. */
class Stream {
  constructor() {
    this.res = null
    this.queue = []
  }
  attach(res) {
    if (this.res) this.res.end()
    this.res = res
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'access-control-allow-origin': '*',
    })
    res.write(': open\n\n')
    res.on('close', () => {
      if (this.res === res) this.res = null
    })
    const queued = this.queue
    this.queue = []
    for (const m of queued) this.push(m)
  }
  push(message) {
    const line = `data: ${JSON.stringify(message)}\n\n`
    if (this.res && !this.res.writableEnded) this.res.write(line)
    else this.queue.push(message)
  }
  reset() {
    this.queue = []
  }
}

class Bus {
  constructor() {
    this.port = 0
    this.token = TOKEN
    this.urls = null
    this.host = new Stream()
    this.hostConnected = false
    this.pending = new Map()
    this.reqSeq = 0
    this.pages = new Map() // wcId -> { stream, seq, held: Map }
    this.protocols = new Map() // scheme -> handler(Request)
    this.onPageMessage = null // (wcId, msg) -> result | Promise
    this.onHostEvent = null // (msg) -> void
    this.onBoot = null // (wcId) -> boot info
    this.findWcByOrigin = null // dev only: (origin) -> wcId
  }

  start() {
    const server = http.createServer((req, res) => {
      this.route(req, res).catch((err) => {
        console.error('[bus]', req.method, req.url, err)
        if (!res.headersSent) res.writeHead(500)
        res.end()
      })
    })
    server.keepAliveTimeout = 60_000
    return new Promise((resolve) => {
      server.listen(Number(process.env.GO_PORT || 0), '127.0.0.1', () => {
        this.port = server.address().port
        this.urls = require('./urlmap').make(this.port)
        resolve(this.port)
      })
    })
  }

  // --- host channel (Java) ---------------------------------------------

  /** Fire-and-forget command to the host. */
  cmd(name, args = {}) {
    if (DEV) console.log('[host]', name, JSON.stringify(args).slice(0, 200))
    this.host.push({ cmd: name, ...args })
  }

  /** Command that the host answers with a reply. */
  request(name, args = {}) {
    if (DEV && !this.hostConnected && this.devAnswer) {
      console.log('[host?]', name, JSON.stringify(args).slice(0, 200))
      return Promise.resolve(this.devAnswer(name, args))
    }
    const req = ++this.reqSeq
    return new Promise((resolve, reject) => {
      this.pending.set(req, { resolve, reject })
      this.host.push({ cmd: name, req, ...args })
    })
  }

  hostMessage(msg) {
    if (msg.type === 'reply') {
      const p = this.pending.get(msg.req)
      if (!p) return
      this.pending.delete(msg.req)
      if (msg.error) p.reject(new Error(msg.error))
      else p.resolve(msg.value)
    } else if (this.onHostEvent) {
      this.onHostEvent(msg)
    }
  }

  // --- pages -------------------------------------------------------------

  page(wcId) {
    let p = this.pages.get(wcId)
    if (!p) {
      p = { stream: new Stream(), seq: 0, pageId: null, waiters: [], execSeq: 0, execs: new Map() }
      this.pages.set(wcId, p)
    }
    return p
  }

  sendToPage(wcId, message) {
    this.page(wcId).stream.push(message)
  }

  /** A new document is loading in wcId: messages queued for the old one go. */
  resetPage(wcId) {
    const p = this.page(wcId)
    p.stream.reset()
    p.pageId = null
    for (const w of p.waiters) w()
    p.waiters = []
  }

  dropPage(wcId) {
    const p = this.pages.get(wcId)
    if (p?.stream.res) p.stream.res.end()
    this.pages.delete(wcId)
  }

  execInPage(wcId, code) {
    const p = this.page(wcId)
    const id = ++p.execSeq
    return new Promise((resolve, reject) => {
      p.execs.set(id, { resolve, reject })
      p.stream.push({ exec: id, code })
    })
  }

  /** Page messages start in the order the page sent them (they travel as
   * separate requests); a gap waits at most a second. */
  async pageMessage(wcId, msg) {
    const p = this.page(wcId)
    if (typeof msg.seq === 'number') {
      if (msg.page !== p.pageId) {
        p.pageId = msg.page
        p.seq = msg.seq - 1
      }
      const deadline = Date.now() + 1000
      while (msg.seq > p.seq + 1 && Date.now() < deadline) {
        await new Promise((resolve) => {
          p.waiters.push(resolve)
          setTimeout(resolve, 100)
        })
      }
      p.seq = Math.max(p.seq, msg.seq)
      const waiters = p.waiters
      p.waiters = []
      for (const w of waiters) w()
    }
    if (msg.kind === 'exec-result') {
      const e = p.execs.get(msg.id)
      if (e) {
        p.execs.delete(msg.id)
        if (msg.error) e.reject(new Error(msg.error))
        else e.resolve(codec.decode(msg.value))
      }
      return undefined
    }
    return this.onPageMessage(wcId, msg)
  }

  authorized(url, req) {
    if (DEV) return true
    return url.searchParams.get('token') === TOKEN || req.headers['x-go-token'] === TOKEN
  }

  async route(req, res) {
    const url = new URL(req.url, 'http://x')
    const p = url.pathname

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': '*',
        'access-control-allow-headers': '*',
      })
      return res.end()
    }

    if (p.startsWith('/__go/')) return this.routeBus(req, res, url)

    const original = this.urls.fromHttp(req.headers.host, p + url.search)
    if (!original) {
      res.writeHead(404)
      return res.end()
    }
    return this.serveScheme(req, res, original)
  }

  async routeBus(req, res, url) {
    const p = url.pathname
    if (p === '/__go/page.js') {
      const body =
        fs.readFileSync(path.join(RUNTIME, 'codec.js'), 'utf8') +
        '\n' +
        fs.readFileSync(path.join(RUNTIME, 'urlmap.js'), 'utf8') +
        '\n' +
        fs.readFileSync(path.join(RUNTIME, 'page.js'), 'utf8')
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' })
      return res.end(body)
    }
    if (!this.authorized(url, req)) {
      res.writeHead(403)
      return res.end()
    }
    if (p === '/__go/host/events') {
      this.host.attach(res)
      if (!this.hostConnected) {
        this.hostConnected = true
        this.onHostConnected?.()
      }
      return
    }
    if (p === '/__go/host/msg' && req.method === 'POST') {
      const msg = JSON.parse((await readBody(req)).toString('utf8'))
      sendJson(res, { ok: true })
      for (const m of Array.isArray(msg) ? msg : [msg]) this.hostMessage(m)
      return
    }
    // a scheme resource fetched by the host for a WebView (custom schemes the
    // page itself names, which WebView cannot load)
    if (p === '/__go/host/fetch') {
      return this.serveScheme(req, res, url.searchParams.get('url'))
    }
    let wcId = Number(url.searchParams.get('wc'))
    if (!wcId && DEV && this.findWcByOrigin) wcId = this.findWcByOrigin(req.headers.origin || req.headers.referer || '')
    if (p === '/__go/boot') return sendJson(res, (await this.onBoot(wcId, url.searchParams.get('href') || '')) || {})
    if (p === '/__go/events') {
      this.page(wcId).stream.attach(res)
      return
    }
    if (p === '/__go/ipc' && req.method === 'POST') {
      const msg = JSON.parse((await readBody(req)).toString('utf8'))
      const result = await this.pageMessage(wcId, msg)
      return sendJson(res, result === undefined ? {} : result)
    }
    res.writeHead(404)
    res.end()
  }

  async serveScheme(req, res, original) {
    const scheme = original.slice(0, original.indexOf(':')).toLowerCase()
    const headers = new Headers()
    for (const [k, v] of Object.entries(req.headers)) {
      if (k === 'host' || k === 'connection') continue
      headers.set(k, Array.isArray(v) ? v.join(', ') : v)
    }
    const init = { method: req.method, headers }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      init.body = await readBody(req)
      init.duplex = 'half'
    }
    let response
    try {
      const handler = this.protocols.get(scheme)
      if (handler) {
        response = await handler(new Request(original, init))
      } else if (scheme === 'file') {
        const { fileURLToPath } = require('node:url')
        response = await fileResponse(fileURLToPath(original.replace(/[?#].*$/, '')), new Request('http://x/', init))
      } else {
        response = new Response(null, { status: 404 })
      }
    } catch (err) {
      console.error('[bus] handler', original, err)
      response = new Response(null, { status: 500 })
    }
    if (!(response instanceof Response) && response && typeof response === 'object' && 'status' in response) {
      response = new Response(response.body ?? null, response)
    }
    response = response || new Response(null, { status: 404 })

    const out = {}
    response.headers.forEach((v, k) => {
      if (k === 'content-security-policy' || k === 'content-encoding') return
      out[k] = v
    })
    out['access-control-allow-origin'] = '*'
    out['cache-control'] = out['cache-control'] || 'no-cache'
    const type = (out['content-type'] || (scheme === 'file' ? '' : mimeOf(new URL(original).pathname)) || '').toLowerCase()
    if (!out['content-type'] && type) out['content-type'] = type
    const isDocument = (req.headers['sec-fetch-dest'] || 'document') === 'document'
    if (isDocument && type.startsWith('text/html') && response.status === 200) {
      const html = injectPage(await response.text())
      delete out['content-length']
      res.writeHead(200, out)
      return res.end(html)
    }
    res.writeHead(response.status, out)
    if (!response.body || req.method === 'HEAD') return res.end()
    Readable.fromWeb(response.body)
      .on('error', () => res.destroy())
      .pipe(res)
  }
}

module.exports = { Bus, fileResponse, mimeOf, TOKEN, DEV }
