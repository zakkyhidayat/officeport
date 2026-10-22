// Electron loads pages from custom schemes (genoffice-app://docs/index.html)
// and file:// URLs. The Android WebView loads them over HTTP from the Node
// process instead, one origin per scheme and host, as in Electron:
//
//   genoffice-app://docs/index.html  <->  http://docs.genoffice-app.localhost:PORT/index.html
//   file:///data/app/x/index.html    <->  http://_.file.localhost:PORT/data/app/x/index.html
//
// *.localhost resolves to the loopback address in Chromium and WebView.
;(function (root) {
  const PASS = new Set(['http', 'https', 'data', 'blob', 'about', 'javascript', 'mailto', 'tel', 'chrome', 'devtools'])

  function make(port) {
    function toHttp(url) {
      if (typeof url !== 'string') return url
      const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):(.*)$/s.exec(url)
      if (!m) return url
      const scheme = m[1].toLowerCase()
      if (PASS.has(scheme)) return url
      let rest = m[2]
      let host = '_'
      if (rest.startsWith('//')) {
        rest = rest.slice(2)
        const end = rest.search(/[/?#]/)
        host = (end < 0 ? rest : rest.slice(0, end)) || '_'
        rest = end < 0 ? '/' : rest.slice(end)
      }
      if (!rest.startsWith('/')) rest = '/' + rest
      return `http://${host.toLowerCase()}.${scheme}.localhost:${port}${rest}`
    }

    // Host header (docs.genoffice-app.localhost:PORT) + path -> original URL,
    // or null for the bus's own address.
    function fromHttp(hostHeader, path) {
      const host = String(hostHeader || '').replace(/:\d+$/, '').toLowerCase()
      const m = /^(.+)\.([a-z][a-z0-9+-]*)\.localhost$/.exec(host)
      if (!m) return null
      const [, name, scheme] = m
      if (scheme === 'file') return `file://${path}`
      return `${scheme}://${name === '_' ? '' : name}${path}`
    }

    function urlFromHttp(url) {
      try {
        const u = new URL(url)
        if (u.protocol !== 'http:' || !u.hostname.endsWith('.localhost')) return url
        return fromHttp(u.host, u.pathname + u.search + u.hash) || url
      } catch {
        return url
      }
    }

    return { toHttp, fromHttp, urlFromHttp }
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { make, PASS }
  else root.__goUrlMap = { make, PASS }
})(this)
