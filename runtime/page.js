// Runs first in every page (bus.js injects it into each HTML document) and
// stands in for what Electron gives a page: the preload script with
// require('electron') (ipcRenderer, contextBridge, webUtils, webFrame), and
// the events the main process gets from a page (load, focus, title, keys
// for before-input-event and menu accelerators, the context menu).
;(function () {
  'use strict'
  if (window.__goBooted || window.top !== window) return
  window.__goBooted = true

  // what gives a web page away on a touch screen, as a desktop app does not
  // show it: the tap flash, the long-press callout, the bounce at the edges,
  // phone-style text inflation, and dragging images and links out. :where()
  // keeps these below any style the app sets itself.
  const nativeFeel = document.createElement('style')
  nativeFeel.textContent = `
:where(html) { -webkit-text-size-adjust: 100%; text-size-adjust: 100%; overscroll-behavior: none; }
:where(*) { -webkit-tap-highlight-color: transparent; }
:where(body) { -webkit-touch-callout: none; }
:where(input, textarea, [contenteditable]:not([contenteditable="false"])) { -webkit-touch-callout: default; }
:where(img, a) { -webkit-user-drag: none; }
`
  ;(document.head || document.documentElement).appendChild(nativeFeel)

  const codec = window.__goCodec
  const H = window.GenOfficeHost
  let wc = 0
  let token = ''
  if (H) {
    wc = Number(H.wcId())
    token = String(H.token())
  }
  const qs = (extra) => `?wc=${wc}&token=${encodeURIComponent(token)}${extra || ''}`

  const bootXhr = new XMLHttpRequest()
  bootXhr.open('GET', '/__go/boot' + qs('&href=' + encodeURIComponent(location.href)), false)
  bootXhr.send()
  const boot = JSON.parse(bootXhr.responseText || '{}')
  if (!wc) wc = boot.wc || 0
  const urls = window.__goUrlMap.make(boot.port)
  const customSchemes = new Set(boot.schemes || [])
  const pageId = Math.random().toString(36).slice(2) + Date.now().toString(36)
  let seq = 0

  function message(kind, fields) {
    return JSON.stringify({ kind, seq: ++seq, page: pageId, ...fields })
  }

  function postAsync(body) {
    return fetch('/__go/ipc' + qs(), { method: 'POST', body, headers: { 'content-type': 'application/json' } }).then((r) =>
      r.json(),
    )
  }

  function postSync(body) {
    const x = new XMLHttpRequest()
    x.open('POST', '/__go/ipc' + qs(), false)
    x.setRequestHeader('content-type', 'application/json')
    x.send(body)
    return JSON.parse(x.responseText || '{}')
  }

  // --- ipcRenderer ---------------------------------------------------------

  const listeners = new Map()
  const ipcRenderer = {
    on(channel, fn) {
      if (!listeners.has(channel)) listeners.set(channel, [])
      listeners.get(channel).push(fn)
      return ipcRenderer
    },
    once(channel, fn) {
      const wrap = (...a) => {
        ipcRenderer.removeListener(channel, wrap)
        fn(...a)
      }
      wrap.__go = fn
      return ipcRenderer.on(channel, wrap)
    },
    removeListener(channel, fn) {
      const list = listeners.get(channel)
      if (list) {
        const i = list.findIndex((f) => f === fn || f.__go === fn)
        if (i >= 0) list.splice(i, 1)
      }
      return ipcRenderer
    },
    off(channel, fn) {
      return ipcRenderer.removeListener(channel, fn)
    },
    addListener(channel, fn) {
      return ipcRenderer.on(channel, fn)
    },
    removeAllListeners(channel) {
      if (channel === undefined) listeners.clear()
      else listeners.delete(channel)
      return ipcRenderer
    },
    listenerCount(channel) {
      return (listeners.get(channel) || []).length
    },
    send(channel, ...args) {
      postAsync(message('send', { channel, args: codec.encode(args) })).catch(() => {})
    },
    invoke(channel, ...args) {
      return postAsync(message('invoke', { channel, args: codec.encode(args) })).then((r) => {
        if (r.error) {
          const err = codec.decode(r.error)
          throw new Error(`Error invoking remote method '${channel}': ${err && err.name ? err.name : 'Error'}: ${err && err.message}`)
        }
        return codec.decode(r.value)
      })
    },
    sendSync(channel, ...args) {
      return codec.decode(postSync(message('sync', { channel, args: codec.encode(args) })).value)
    },
    sendToHost(channel, ...args) {
      ipcRenderer.send(channel, ...args)
    },
    postMessage(channel, msg) {
      ipcRenderer.send(channel, msg)
    },
  }

  function emit(channel, args) {
    const list = listeners.get(channel)
    if (!list) return
    const event = { sender: ipcRenderer, senderId: 0, ports: [] }
    for (const fn of list.slice()) {
      try {
        fn(event, ...args)
      } catch (err) {
        console.error(err)
      }
    }
  }

  // --- the rest of require('electron') ------------------------------------

  let zoom = 1
  function setZoom(f) {
    zoom = f
    document.documentElement.style.zoom = f === 1 ? '' : String(f)
  }

  const electron = {
    ipcRenderer,
    contextBridge: {
      exposeInMainWorld(name, api) {
        Object.defineProperty(window, name, { value: api, configurable: true, enumerable: true, writable: false })
      },
      exposeInIsolatedWorld() {},
      executeInMainWorld({ func, args }) {
        return func(...(args || []))
      },
    },
    webUtils: {
      getPathForFile(file) {
        return (file && (file.path || file.__goPath)) || ''
      },
    },
    webFrame: {
      setZoomFactor: setZoom,
      getZoomFactor: () => zoom,
      setZoomLevel: (l) => setZoom(Math.pow(1.2, l)),
      getZoomLevel: () => Math.log(zoom) / Math.log(1.2),
      setVisualZoomLevelLimits() {},
      insertCSS(css) {
        const s = document.createElement('style')
        s.textContent = css
        ;(document.head || document.documentElement).appendChild(s)
        return ''
      },
      setSpellCheckProvider() {},
      executeJavaScript: (code) => Promise.resolve((0, eval)(code)),
      clearCache() {},
      getResourceUsage: () => ({}),
      routingId: 1,
    },
    clipboard: {
      readText: () => '',
      writeText: (t) => navigator.clipboard && navigator.clipboard.writeText(t),
    },
    crashReporter: { start() {}, addExtraParameter() {}, removeExtraParameter() {}, getParameters: () => ({}) },
  }

  function MiniEmitter() {
    this._l = {}
  }
  MiniEmitter.prototype.on = function (n, f) {
    ;(this._l[n] = this._l[n] || []).push(f)
    return this
  }
  MiniEmitter.prototype.addListener = MiniEmitter.prototype.on
  MiniEmitter.prototype.off = function (n, f) {
    this._l[n] = (this._l[n] || []).filter((x) => x !== f)
    return this
  }
  MiniEmitter.prototype.removeListener = MiniEmitter.prototype.off
  MiniEmitter.prototype.once = function (n, f) {
    const w = (...a) => {
      this.off(n, w)
      f(...a)
    }
    return this.on(n, w)
  }
  MiniEmitter.prototype.emit = function (n, ...a) {
    const l = this._l[n] || []
    l.slice().forEach((f) => f(...a))
    return l.length > 0
  }
  MiniEmitter.EventEmitter = MiniEmitter

  const fakeProcess = {
    platform: 'linux',
    arch: boot.arch || 'x64',
    type: 'renderer',
    versions: boot.versions || {},
    env: {},
    argv: [],
    execPath: '',
    pid: 1,
    sandboxed: true,
    contextIsolated: true,
    isMainFrame: true,
    on() {},
    once() {},
    off() {},
    removeListener() {},
    nextTick: (fn, ...a) => queueMicrotask(() => fn(...a)),
    cwd: () => '/',
    getSystemVersion: () => '',
    getCPUUsage: () => ({ percentCPUUsage: 0, idleWakeupsPerSecond: 0 }),
  }

  function requireShim(name) {
    switch (name) {
      case 'electron':
        return electron
      case 'events':
      case 'node:events':
        return MiniEmitter
      case 'timers':
      case 'node:timers':
        return { setTimeout, clearTimeout, setInterval, clearInterval, setImmediate: (f, ...a) => setTimeout(f, 0, ...a) }
      case 'url':
      case 'node:url':
        return { URL, URLSearchParams }
      default:
        throw new Error(`Cannot find module '${name}' (preload on Android)`)
    }
  }

  // --- custom schemes in fetch/XHR ------------------------------------------

  function mapUrl(url) {
    if (typeof url !== 'string') {
      if (url instanceof URL) url = url.href
      else return url
    }
    const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(url)
    return m && customSchemes.has(m[1].toLowerCase()) ? urls.toHttp(url) : url
  }
  const origFetch = window.fetch.bind(window)
  window.fetch = function (input, init) {
    if (typeof input === 'string' || input instanceof URL) return origFetch(mapUrl(input), init)
    if (input instanceof Request) {
      const mapped = mapUrl(input.url)
      if (mapped !== input.url) return origFetch(new Request(mapped, input), init)
    }
    return origFetch(input, init)
  }
  const origOpen = XMLHttpRequest.prototype.open
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    return origOpen.call(this, method, mapUrl(url), ...rest)
  }

  // --- messages from the main process ---------------------------------------

  let accelerators = boot.accelerators || []
  let inputHooks = !!boot.inputHooks

  function onMessage(m) {
    if (m.channel !== undefined) return emit(m.channel, codec.decode(m.args) || [])
    if (m.exec !== undefined) {
      Promise.resolve()
        .then(() => (0, eval)(m.code))
        .then(
          (value) => postAsync(message('exec-result', { id: m.exec, value: codec.encode(value) })),
          (err) => postAsync(message('exec-result', { id: m.exec, error: String((err && err.message) || err) })),
        )
      return
    }
    if (m.accelerators) accelerators = m.accelerators
    if (m.inputHooks !== undefined) inputHooks = m.inputHooks
    if (m.zoom !== undefined) setZoom(m.zoom)
    if (m.css !== undefined) electron.webFrame.insertCSS(m.css)
    if (m.replaceWord !== undefined) replaceWord(m.replaceWord)
  }

  const events = new EventSource('/__go/events' + qs('&page=' + pageId))
  events.onmessage = (e) => {
    try {
      onMessage(JSON.parse(e.data))
    } catch (err) {
      console.error('[go] message', err)
    }
  }

  // --- the preload ------------------------------------------------------------

  if (boot.preload) {
    const mod = { exports: {} }
    try {
      new Function('require', 'process', 'module', 'exports', 'global', '__dirname', '__filename', boot.preload)(
        requireShim,
        fakeProcess,
        mod,
        mod.exports,
        window,
        '',
        '',
      )
    } catch (err) {
      console.error('[go] preload failed', err)
    }
  }

  // --- page life and input ------------------------------------------------------

  function life(ev, fields) {
    postAsync(message('life', { ev, ...fields })).catch(() => {})
  }
  document.addEventListener('DOMContentLoaded', () => life('dom-ready'))
  window.addEventListener('load', () => life('did-finish-load', { title: document.title }))
  window.addEventListener('focus', () => life('focus'))
  window.addEventListener('blur', () => life('blur'))
  let lastTitle = null
  // watches <head> only (where <title> is): watching the whole document would
  // run on every edit in a large editor DOM
  const titleObserver = new MutationObserver(() => {
    if (document.title !== lastTitle) {
      lastTitle = document.title
      life('title', { title: document.title })
    }
  })
  const watchTitle = () => {
    titleObserver.disconnect()
    if (document.head) titleObserver.observe(document.head, { subtree: true, childList: true, characterData: true })
    titleObserver.observe(document.documentElement, { childList: true })
  }
  if (document.documentElement) watchTitle()
  document.addEventListener('DOMContentLoaded', watchTitle)

  const CODE_KEYS = {
    Equal: '=',
    Minus: '-',
    BracketLeft: '[',
    BracketRight: ']',
    Backslash: '\\',
    Semicolon: ';',
    Quote: "'",
    Comma: ',',
    Period: '.',
    Slash: '/',
    Backquote: '`',
    Space: 'space',
    Enter: 'enter',
    NumpadEnter: 'enter',
    Escape: 'escape',
    Tab: 'tab',
    Backspace: 'backspace',
    Delete: 'delete',
    Insert: 'insert',
    Home: 'home',
    End: 'end',
    PageUp: 'pageup',
    PageDown: 'pagedown',
    ArrowUp: 'up',
    ArrowDown: 'down',
    ArrowLeft: 'left',
    ArrowRight: 'right',
    NumpadAdd: 'plus',
    NumpadSubtract: '-',
  }
  const ACCEL_KEYS = { return: 'enter', esc: 'escape', '+': 'plus', plus: 'plus', numadd: 'plus', numsub: '-', space: 'space' }

  function eventKeys(e) {
    const keys = new Set()
    if (/^Key[A-Z]$/.test(e.code)) keys.add(e.code.slice(3).toLowerCase())
    else if (/^Digit\d$/.test(e.code)) keys.add(e.code.slice(5))
    else if (/^Numpad\d$/.test(e.code)) keys.add('num' + e.code.slice(6))
    else if (CODE_KEYS[e.code]) keys.add(CODE_KEYS[e.code])
    if (e.key) {
      const k = e.key.length === 1 ? e.key.toLowerCase() : e.key.toLowerCase().replace(/^arrow/, '')
      keys.add(k === '+' ? 'plus' : k === ' ' ? 'space' : k)
    }
    if (keys.has('=') && e.shiftKey) keys.add('plus')
    return keys
  }

  function parseAccelerator(text) {
    const parts = String(text).replace(/\+\+$/, '+Plus').split('+')
    const acc = { ctrl: false, alt: false, shift: false, meta: false, key: '' }
    for (const raw of parts) {
      const p = raw.trim().toLowerCase()
      if (p === 'cmdorctrl' || p === 'commandorcontrol' || p === 'ctrl' || p === 'control') acc.ctrl = true
      else if (p === 'alt' || p === 'option' || p === 'altgr') acc.alt = true
      else if (p === 'shift') acc.shift = true
      else if (p === 'cmd' || p === 'command' || p === 'super' || p === 'meta') acc.meta = true
      else acc.key = ACCEL_KEYS[p] || p
    }
    return acc
  }

  function matches(e, text) {
    const a = parseAccelerator(text)
    if (e.ctrlKey !== a.ctrl || e.altKey !== a.alt || e.metaKey !== a.meta) return false
    const keys = eventKeys(e)
    if (!keys.has(a.key)) return false
    // Shift+= is "Plus" without naming Shift
    return e.shiftKey === a.shift || (a.key === 'plus' && e.shiftKey)
  }

  function inputOf(e, type) {
    return {
      type,
      key: e.key,
      code: e.code,
      isAutoRepeat: e.repeat,
      isComposing: e.isComposing,
      shift: e.shiftKey,
      control: e.ctrlKey,
      alt: e.altKey,
      meta: e.metaKey,
      location: e.location,
      modifiers: [e.shiftKey && 'shift', e.ctrlKey && 'control', e.altKey && 'alt', e.metaKey && 'meta'].filter(Boolean),
    }
  }

  function hooked(e) {
    return inputHooks && (e.ctrlKey || e.altKey || e.metaKey || /^F\d+$/.test(e.key) || e.key === 'Escape' || e.key === 'Tab')
  }

  for (const [type, name] of [
    ['keydown', 'keyDown'],
    ['keyup', 'keyUp'],
  ]) {
    window.addEventListener(
      type,
      (e) => {
        if (!hooked(e)) return
        // only keyDown can be cancelled in time to matter: keyUp goes without blocking the page
        if (name === 'keyUp') return void postAsync(message('input', { input: inputOf(e, name) })).catch(() => {})
        const r = postSync(message('input', { input: inputOf(e, name) }))
        if (r.prevented) {
          e.preventDefault()
          e.stopImmediatePropagation()
        }
      },
      true,
    )
  }

  // the application menu's accelerators: what the page leaves alone
  window.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || !accelerators.length) return
    for (const item of accelerators) {
      if (matches(e, item.accelerator)) {
        e.preventDefault()
        life('menu-accelerator', { id: item.id })
        return
      }
    }
  })

  // the word under the pointer in editable text, and its range (replaceMisspelling)
  const WORD_CHAR = /[\p{L}\p{M}\p{N}'’]/u
  let spellRange = null
  function wordAt(x, y) {
    spellRange = null
    const caret = document.caretRangeFromPoint ? document.caretRangeFromPoint(x, y) : null
    const node = caret && caret.startContainer
    if (!node || node.nodeType !== Node.TEXT_NODE) return ''
    const text = node.data
    let start = caret.startOffset
    let end = caret.startOffset
    while (start > 0 && WORD_CHAR.test(text[start - 1])) start--
    while (end < text.length && WORD_CHAR.test(text[end])) end++
    while (start < end && /['’]/.test(text[start])) start++
    while (end > start && /['’]/.test(text[end - 1])) end--
    if (start === end || /^\p{N}+$/u.test(text.slice(start, end))) return ''
    spellRange = document.createRange()
    spellRange.setStart(node, start)
    spellRange.setEnd(node, end)
    return text.slice(start, end)
  }

  // Electron's replaceMisspelling: the selection when the app has selected
  // the word itself, else the word the context menu was opened on
  function replaceWord(text) {
    const sel = window.getSelection()
    if (sel.isCollapsed && spellRange) {
      sel.removeAllRanges()
      sel.addRange(spellRange)
    }
    if (!sel.isCollapsed) document.execCommand('insertText', false, text)
    spellRange = null
  }

  // Electron's 'context-menu' event (the app draws its own menus from it).
  // Electron has no menu of its own; WebView would show one (Cut, Copy,
  // Select all) over the app's, so the event ends here.
  window.addEventListener('contextmenu', (e) => {
    if (e.defaultPrevented) return
    e.preventDefault()
    const t = e.target instanceof Element ? e.target : null
    const editable = !!(t && (t.isContentEditable || /^(INPUT|TEXTAREA)$/.test(t.tagName)))
    const spellWord = editable && t.spellcheck !== false ? wordAt(e.clientX, e.clientY) : ''
    const selection = String(window.getSelection() || '')
    const link = t && t.closest('a[href]')
    const img = t && t.closest('img')
    life('context-menu', {
      params: {
        x: Math.round(e.clientX * zoom),
        y: Math.round(e.clientY * zoom),
        selectionText: selection,
        isEditable: editable,
        editFlags: {
          canUndo: editable,
          canRedo: editable,
          canCut: editable && !!selection,
          canCopy: !!selection,
          canPaste: editable,
          canDelete: editable && !!selection,
          canSelectAll: true,
          canEditRichly: !!(t && t.isContentEditable),
        },
        linkURL: link ? link.href : '',
        linkText: link ? link.textContent : '',
        mediaType: img ? 'image' : 'none',
        srcURL: img ? img.src : '',
        hasImageContents: !!img,
        misspelledWord: '',
        dictionarySuggestions: [],
        pageURL: location.href,
        frameURL: location.href,
        inputFieldType: t && t.tagName === 'INPUT' ? t.type : editable ? 'plainText' : 'none',
        spellcheckEnabled: false,
        menuSourceType: 'mouse',
        spellWord,
        titleText: '',
        altText: img ? img.alt : '',
        suggestedFilename: '',
        selectionRect: { x: 0, y: 0, width: 0, height: 0 },
        selectionStartOffset: 0,
        referrerPolicy: { policy: 'default', url: '' },
        frameCharset: 'UTF-8',
      },
    })
  })
})()
