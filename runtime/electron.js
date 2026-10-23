// require('electron') for GenOffice's main process on Android. Windows,
// views, dialogs and menus are drawn by the Java host (bus.cmd/request);
// pages talk to ipcMain through page.js. Anything not written here is a
// logged no-op (see fallback), so a missing piece costs a feature, not a
// crash.
const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL, fileURLToPath } = require('node:url')
const codec = require('./codec')
const { fileResponse } = require('./bus')

let bus = null
const warned = new Set()

function warn(what) {
  if (warned.has(what)) return
  warned.add(what)
  console.warn(`[electron-shim] not on Android: ${what}`)
}

/** Unknown members read as logged no-op functions; a few names stay
 * undefined so the object is not taken for a promise or a module. */
const KEEP_UNDEFINED = new Set(['then', 'catch', 'toJSON', 'constructor', '$$typeof', '__esModule', 'inspect', 'asymmetricMatch', 'nodeType', 'default'])
function fallback(target, name) {
  return new Proxy(target, {
    get(t, prop, receiver) {
      if (typeof prop === 'symbol' || prop in t || KEEP_UNDEFINED.has(prop) || prop.startsWith('_')) return Reflect.get(t, prop, receiver)
      warn(`${name}.${prop}`)
      return function noop() {
        return undefined
      }
    },
  })
}
function fallbackClass(Class, name) {
  const proto = Object.getPrototypeOf(Class.prototype)
  Object.setPrototypeOf(Class.prototype, fallback(Object.create(proto), name))
  return Class
}

const RES = process.env.GO_RES || process.resourcesPath
const DATA = process.env.GO_DATA || path.join(os.homedir(), '.genoffice-android')
const APP_DIR = path.join(RES, 'app')
const pkg = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8'))
  } catch {
    return { name: 'genoffice', productName: 'GenOffice', version: '0.0.0' }
  }
})()

// --- display -------------------------------------------------------------

const display = {
  width: Number(process.env.GO_WIDTH || 1280),
  height: Number(process.env.GO_HEIGHT || 800),
  scale: Number(process.env.GO_SCALE || 1),
  dark: process.env.GO_DARK === '1',
}

function displayObject() {
  const bounds = { x: 0, y: 0, width: display.width, height: display.height }
  return {
    id: 1,
    label: 'Built-in',
    bounds,
    workArea: { ...bounds },
    size: { width: display.width, height: display.height },
    workAreaSize: { width: display.width, height: display.height },
    scaleFactor: display.scale,
    rotation: 0,
    internal: true,
    monochrome: false,
    accelerometerSupport: 'unknown',
    touchSupport: 'available',
    colorDepth: 24,
    colorSpace: 'srgb',
    depthPerComponent: 8,
    displayFrequency: 60,
    detected: true,
  }
}

const screen = fallback(
  Object.assign(new EventEmitter(), {
    getPrimaryDisplay: displayObject,
    getAllDisplays: () => [displayObject()],
    getDisplayMatching: () => displayObject(),
    getDisplayNearestPoint: () => displayObject(),
    getCursorScreenPoint: () => ({ x: Math.round(display.width / 2), y: Math.round(display.height / 2) }),
    screenToDipPoint: (p) => p,
    dipToScreenPoint: (p) => p,
    screenToDipRect: (_w, r) => r,
    dipToScreenRect: (_w, r) => r,
  }),
  'screen',
)

// --- nativeTheme -----------------------------------------------------------

const nativeTheme = fallback(new EventEmitter(), 'nativeTheme')
let themeSource = 'system'
Object.defineProperties(nativeTheme, {
  themeSource: {
    get: () => themeSource,
    set: (v) => {
      themeSource = v
      bus?.cmd('theme.set', { source: v })
      nativeTheme.emit('updated')
    },
  },
  shouldUseDarkColors: { get: () => (themeSource === 'system' ? display.dark : themeSource === 'dark') },
  shouldUseHighContrastColors: { get: () => false },
  shouldUseInvertedColorScheme: { get: () => false },
  shouldUseDarkColorsForSystemIntegratedUI: { get: () => display.dark },
  inForcedColorsMode: { get: () => false },
  prefersReducedTransparency: { get: () => false },
})

// --- app ---------------------------------------------------------------------

const paths = {
  home: os.homedir(),
  appData: path.join(DATA, 'config'),
  userData: path.join(DATA, 'config', pkg.productName || pkg.name),
  sessionData: path.join(DATA, 'config', pkg.productName || pkg.name),
  temp: process.env.TMPDIR || os.tmpdir(),
  exe: process.execPath,
  module: process.execPath,
  desktop: process.env.GO_DOCUMENTS || path.join(DATA, 'Documents'),
  documents: process.env.GO_DOCUMENTS || path.join(DATA, 'Documents'),
  downloads: process.env.GO_DOWNLOADS || path.join(DATA, 'Downloads'),
  music: path.join(DATA, 'Music'),
  pictures: process.env.GO_PICTURES || path.join(DATA, 'Pictures'),
  videos: path.join(DATA, 'Videos'),
  recent: path.join(DATA, 'Recent'),
  logs: path.join(DATA, 'logs'),
  crashDumps: path.join(DATA, 'crashes'),
}

let ready = false
let readyResolve
const readyPromise = new Promise((r) => (readyResolve = r))
let appName = pkg.productName || pkg.name

const app = fallback(new EventEmitter(), 'app')
Object.assign(app, {
  isPackaged: true,
  commandLine: {
    appendSwitch() {},
    appendArgument() {},
    hasSwitch: () => false,
    getSwitchValue: () => '',
    removeSwitch() {},
  },
  dock: undefined,
  whenReady: () => readyPromise,
  isReady: () => ready,
  getPath(name) {
    const p = paths[name]
    if (!p) throw new Error(`Failed to get '${name}' path`)
    return p
  },
  setPath(name, p) {
    paths[name] = p
  },
  getAppPath: () => APP_DIR,
  getVersion: () => pkg.version,
  getName: () => appName,
  setName: (n) => (appName = n),
  getLocale: () => process.env.GO_LOCALE || 'en-US',
  getSystemLocale: () => process.env.GO_LOCALE || 'en-US',
  getPreferredSystemLanguages: () => [process.env.GO_LOCALE || 'en-US'],
  getLocaleCountryCode: () => (process.env.GO_LOCALE || 'en-US').split(/[-_]/)[1] || 'US',
  requestSingleInstanceLock: () => true,
  hasSingleInstanceLock: () => true,
  releaseSingleInstanceLock() {},
  quit() {
    const e = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true } }
    app.emit('before-quit', e)
    if (e.defaultPrevented) return
    for (const w of BrowserWindow.getAllWindows()) w.close()
    app.emit('will-quit', { preventDefault() {} })
    app.emit('quit', {}, 0)
    bus?.cmd('app.quit')
    setTimeout(() => process.exit(0), 300)
  },
  exit(code = 0) {
    bus?.cmd('app.quit')
    setTimeout(() => process.exit(code), 100)
  },
  relaunch() {
    bus?.cmd('app.relaunch')
  },
  focus() {},
  hide() {},
  show() {},
  setAppUserModelId() {},
  setAsDefaultProtocolClient: () => false,
  isDefaultProtocolClient: () => false,
  removeAsDefaultProtocolClient: () => false,
  addRecentDocument() {},
  clearRecentDocuments() {},
  setAboutPanelOptions() {},
  setAccessibilitySupportEnabled() {},
  isAccessibilitySupportEnabled: () => false,
  getAppMetrics: () => [],
  getGPUFeatureStatus: () => ({}),
  getGPUInfo: () => Promise.resolve({}),
  enableSandbox() {},
  isInApplicationsFolder: () => true,
  getLoginItemSettings: () => ({ openAtLogin: false }),
  setLoginItemSettings() {},
  getFileIcon: () => Promise.resolve(nativeImage.createEmpty()),
  setBadgeCount: () => false,
  getBadgeCount: () => 0,
  isEmojiPanelSupported: () => false,
  disableHardwareAcceleration() {},
  setUserTasks: () => false,
  setJumpList() {},
  get name() {
    return appName
  },
  set name(n) {
    appName = n
  },
  userAgentFallback: '',
  runningUnderARM64Translation: false,
  accessibilitySupportEnabled: false,
})

// --- ipcMain -------------------------------------------------------------------

class IpcMain extends EventEmitter {
  constructor() {
    super()
    this.handlers = new Map()
  }
  handle(channel, fn) {
    if (this.handlers.has(channel)) throw new Error(`Attempted to register a second handler for '${channel}'`)
    this.handlers.set(channel, fn)
  }
  handleOnce(channel, fn) {
    this.handle(channel, (...a) => {
      this.handlers.delete(channel)
      return fn(...a)
    })
  }
  removeHandler(channel) {
    this.handlers.delete(channel)
  }
}
const ipcMain = new IpcMain()

// --- webContents -------------------------------------------------------------

let wcSeq = 0
const allContents = new Map()
let focusedWcId = 0
let defaultSession

function navEvent(url) {
  return {
    url,
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true
    },
    isMainFrame: true,
    isSameDocument: false,
    frame: null,
  }
}

class WebContents extends EventEmitter {
  constructor(options = {}) {
    super()
    this.id = ++wcSeq
    this._preload = options.preload || null
    this._owner = options.owner || null // BrowserWindow (its own) or WebContentsView
    this._type = options.type || 'window'
    this._url = ''
    this._title = ''
    this._destroyed = false
    this._loading = false
    this._zoom = 1
    this._windowOpenHandler = null
    this._loadWaiters = []
    this._css = new Map()
    this.session = defaultSession
    this.hostWebContents = null
    this.devToolsWebContents = null
    this.debugger = fallback(Object.assign(new EventEmitter(), { attach() {}, detach() {}, isAttached: () => false, sendCommand: () => Promise.resolve({}) }), 'debugger')
    this.navigationHistory = fallback(
      { canGoBack: () => false, canGoForward: () => false, goBack() {}, goForward() {}, clear() {}, getActiveIndex: () => 0, length: () => 1 },
      'navigationHistory',
    )
    this.ipc = new IpcMain()
    this.mainFrame = this._frame()
    this.audioMuted = false
    this.userAgent = ''
    this.backgroundThrottling = true
    allContents.set(this.id, this)
    bus.cmd('wc.create', { wc: this.id, type: this._type })
    app.emit('web-contents-created', { preventDefault() {} }, this)
  }

  _frame() {
    const wc = this
    return {
      get url() {
        return wc._url
      },
      get origin() {
        try {
          return new URL(wc._url).origin
        } catch {
          return ''
        }
      },
      routingId: 1,
      processId: this.id,
      frameTreeNodeId: this.id,
      name: '',
      top: null,
      parent: null,
      frames: [],
      framesInSubtree: [],
      visibilityState: 'visible',
      detached: false,
      isDestroyed: () => wc._destroyed,
      executeJavaScript: (code) => wc.executeJavaScript(code),
      send: (channel, ...args) => wc.send(channel, ...args),
      postMessage: (channel, msg) => wc.send(channel, msg),
      reload: () => wc.reload(),
      on() {},
      once() {},
      ipc: this.ipc,
    }
  }

  loadURL(url) {
    if (this._destroyed) return Promise.reject(new Error('WebContents destroyed'))
    this._url = url
    this._loading = true
    bus.resetPage(this.id)
    bus.cmd('wc.load', { wc: this.id, url: bus.urls.toHttp(url) })
    this.emit('did-start-loading')
    return new Promise((resolve, reject) => this._loadWaiters.push({ resolve, reject }))
  }

  loadFile(file, options = {}) {
    const u = pathToFileURL(path.resolve(file))
    if (options.query) for (const [k, v] of Object.entries(options.query)) u.searchParams.set(k, v)
    if (options.search) u.search = options.search
    if (options.hash) u.hash = options.hash
    return this.loadURL(u.toString())
  }

  _finishLoad(error) {
    this._loading = false
    const waiters = this._loadWaiters
    this._loadWaiters = []
    for (const w of waiters) error ? w.reject(error) : w.resolve()
  }

  getURL() {
    return this._url
  }
  getTitle() {
    return this._title || this._url
  }
  isDestroyed() {
    return this._destroyed
  }
  isLoading() {
    return this._loading
  }
  isLoadingMainFrame() {
    return this._loading
  }
  isWaitingForResponse() {
    return false
  }
  isCrashed() {
    return false
  }
  isFocused() {
    return focusedWcId === this.id
  }
  focus() {
    focusedWcId = this.id
    bus.cmd('wc.focus', { wc: this.id })
  }
  getType() {
    return this._type
  }
  getProcessId() {
    return this.id
  }
  getOSProcessId() {
    return process.pid
  }
  send(channel, ...args) {
    if (this._destroyed) return
    bus.sendToPage(this.id, { channel, args: codec.encode(args) })
  }
  postMessage(channel, message) {
    this.send(channel, message)
  }
  sendToFrame(_frame, channel, ...args) {
    this.send(channel, ...args)
  }
  executeJavaScript(code) {
    if (this._destroyed) return Promise.reject(new Error('WebContents destroyed'))
    return bus.execInPage(this.id, String(code))
  }
  executeJavaScriptInIsolatedWorld(_world, scripts) {
    return this.executeJavaScript(scripts.map((s) => s.code).join(';\n'))
  }
  insertCSS(css) {
    const key = String(this._css.size + 1)
    this._css.set(key, css)
    bus.sendToPage(this.id, { css })
    return Promise.resolve(key)
  }
  removeInsertedCSS() {
    return Promise.resolve()
  }
  setWindowOpenHandler(fn) {
    this._windowOpenHandler = fn
  }
  setZoomFactor(f) {
    this._zoom = f
    bus.sendToPage(this.id, { zoom: f })
  }
  getZoomFactor() {
    return this._zoom
  }
  setZoomLevel(level) {
    this.setZoomFactor(Math.pow(1.2, level))
  }
  getZoomLevel() {
    return Math.log(this._zoom) / Math.log(1.2)
  }
  setVisualZoomLevelLimits() {
    return Promise.resolve()
  }
  _edit(action) {
    bus.cmd('wc.edit', { wc: this.id, action })
  }
  undo() {
    this._edit('undo')
  }
  redo() {
    this._edit('redo')
  }
  cut() {
    this._edit('cut')
  }
  copy() {
    this._edit('copy')
  }
  paste() {
    this._edit('paste')
  }
  pasteAndMatchStyle() {
    this._edit('paste')
  }
  delete() {
    this._edit('delete')
  }
  selectAll() {
    this._edit('selectAll')
  }
  unselect() {
    this._edit('unselect')
  }
  replaceMisspelling(text) {
    bus.sendToPage(this.id, { replaceWord: String(text) })
  }
  replace(text) {
    this.executeJavaScript(`document.execCommand('insertText', false, ${JSON.stringify(text)})`).catch(() => {})
  }
  insertText(text) {
    return this.executeJavaScript(`document.execCommand('insertText', false, ${JSON.stringify(text)})`).then(() => {})
  }
  findInPage(text, options = {}) {
    bus.cmd('wc.find', { wc: this.id, text, forward: options.forward !== false, findNext: !!options.findNext })
    return 1
  }
  stopFindInPage() {
    bus.cmd('wc.find', { wc: this.id, text: '' })
  }
  print(options = {}, callback) {
    bus.request('wc.print', { wc: this.id, title: this.getTitle() }).then(
      () => callback?.(true, ''),
      (err) => callback?.(false, String(err.message || err)),
    )
  }
  async printToPDF(options = {}) {
    const b64 = await bus.request('wc.printToPDF', {
      wc: this.id,
      landscape: !!options.landscape,
      pageSize: options.pageSize || 'A4',
      margins: options.margins || null,
      printBackground: !!options.printBackground,
      scale: options.scale || 1,
    })
    return Buffer.from(b64, 'base64')
  }
  async capturePage(rect) {
    const b64 = await bus.request('wc.capture', { wc: this.id, rect: rect || null })
    return nativeImage.createFromBuffer(Buffer.from(b64, 'base64'))
  }
  reload() {
    if (this._url) this.loadURL(this._url).catch(() => {})
  }
  reloadIgnoringCache() {
    this.reload()
  }
  stop() {
    bus.cmd('wc.stop', { wc: this.id })
  }
  canGoBack() {
    return false
  }
  canGoForward() {
    return false
  }
  goBack() {}
  goForward() {}
  openDevTools() {}
  closeDevTools() {}
  isDevToolsOpened() {
    return false
  }
  isDevToolsFocused() {
    return false
  }
  toggleDevTools() {}
  inspectElement() {}
  setBackgroundThrottling(v) {
    this.backgroundThrottling = v
  }
  getBackgroundThrottling() {
    return this.backgroundThrottling
  }
  setAudioMuted(v) {
    this.audioMuted = v
  }
  isAudioMuted() {
    return this.audioMuted
  }
  isCurrentlyAudible() {
    return false
  }
  setUserAgent(ua) {
    this.userAgent = ua
  }
  getUserAgent() {
    return this.userAgent
  }
  setIgnoreMenuShortcuts() {}
  setFrameRate() {}
  getFrameRate() {
    return 60
  }
  invalidate() {}
  isBeingCaptured() {
    return false
  }
  isOffscreen() {
    return false
  }
  startDrag() {}
  downloadURL(url) {
    shell.openExternal(url)
  }
  getAllSharedWorkers() {
    return []
  }
  getMediaSourceId() {
    return ''
  }
  centerSelection() {}
  scrollToTop() {}
  scrollToBottom() {}
  setDevToolsTitle() {}
  close() {
    this.destroy()
  }
  destroy() {
    if (this._destroyed) return
    this._destroyed = true
    allContents.delete(this.id)
    bus.cmd('wc.destroy', { wc: this.id })
    bus.dropPage(this.id)
    this._finishLoad(new Error('destroyed'))
    this.emit('destroyed')
  }

  // --- page and host events ---------------------------------------------

  _life(msg) {
    switch (msg.ev) {
      case 'dom-ready':
        this.emit('dom-ready', {})
        break
      case 'did-finish-load':
        if (msg.title) this._setTitle(msg.title)
        this.emit('did-stop-loading')
        this.emit('did-frame-finish-load', {}, true, 1, 1)
        this.emit('did-finish-load', {})
        this._finishLoad()
        this._owner?._contentsLoaded?.()
        break
      case 'focus':
        focusedWcId = this.id
        this.emit('focus')
        this._owner?._contentsFocused?.()
        break
      case 'blur':
        if (focusedWcId === this.id) focusedWcId = 0
        this.emit('blur')
        break
      case 'title':
        this._setTitle(msg.title)
        break
      case 'context-menu':
        withSpelling(msg.params).then((params) => {
          if (!this._destroyed) this.emit('context-menu', { preventDefault() {}, defaultPrevented: false }, params)
        })
        break
      case 'menu-accelerator':
        menuAccelerator(msg.id, this)
        break
    }
  }

  _setTitle(title) {
    if (title === this._title) return
    this._title = title
    const e = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true } }
    this.emit('page-title-updated', e, title, true)
    this._owner?._contentsTitle?.(title, e)
  }

  _input(input) {
    let prevented = false
    const e = {
      preventDefault() {
        prevented = true
      },
      get defaultPrevented() {
        return prevented
      },
    }
    this.emit('before-input-event', e, input)
    return prevented
  }

  _hostEvent(msg) {
    switch (msg.name) {
      case 'did-fail-load':
        this.emit('did-fail-load', {}, msg.code || -2, msg.description || 'load failed', msg.url || this._url, true)
        this._finishLoad(new Error(`ERR_FAILED (${msg.code || -2}) loading '${this._url}'`))
        break
      case 'render-process-gone':
        this.emit('render-process-gone', {}, { reason: msg.reason || 'crashed', exitCode: 1 })
        break
      case 'will-navigate': {
        const url = bus.urls.urlFromHttp(msg.url)
        const e = navEvent(url)
        this.emit('will-navigate', e, url)
        this.emit('will-frame-navigate', e)
        bus.cmd('wc.navigate-decision', { wc: this.id, req: msg.req, allow: !e.defaultPrevented })
        if (!e.defaultPrevented) this._url = url
        break
      }
      case 'did-navigate':
        this._url = bus.urls.urlFromHttp(msg.url)
        this.emit('did-navigate', {}, this._url, 200, 'OK')
        break
      case 'window-open':
        this._windowOpen(bus.urls.urlFromHttp(msg.url), msg.frameName || '', msg.disposition || 'new-window')
        break
      case 'focus':
        focusedWcId = this.id
        break
      case 'html-fullscreen':
        this.emit(msg.on ? 'enter-html-full-screen' : 'leave-html-full-screen')
        break
    }
  }

  _windowOpen(url, frameName, disposition) {
    let action = { action: 'deny' }
    if (this._windowOpenHandler) {
      try {
        action = this._windowOpenHandler({ url, frameName, features: '', disposition, referrer: { url: this._url, policy: 'default' }, postBody: null }) || action
      } catch (err) {
        console.error(err)
      }
    } else if (/^https?:/.test(url)) {
      shell.openExternal(url)
      return
    }
    if (action.action === 'allow') {
      const opts = action.overrideBrowserWindowOptions || {}
      const win = new BrowserWindow({ width: 900, height: 700, ...opts })
      win.loadURL(url).catch(() => {})
      this.emit('did-create-window', win, { url, frameName, options: opts, disposition })
    }
  }
}
fallbackClass(WebContents, 'webContents')

const webContents = fallback(
  {
    getAllWebContents: () => [...allContents.values()],
    fromId: (id) => allContents.get(Number(id)),
    getFocusedWebContents: () => allContents.get(focusedWcId) || null,
    fromFrame: () => null,
    fromDevToolsTargetId: () => null,
  },
  'webContents',
)

// --- views and windows ---------------------------------------------------------

class View extends EventEmitter {
  constructor() {
    super()
    this.children = []
    this._bounds = { x: 0, y: 0, width: 0, height: 0 }
    this._visible = true
    this._window = null
    this._parentView = null
  }
  addChildView(view, index) {
    if (view._parentView) view._parentView.removeChildView(view)
    if (index === undefined || index < 0 || index > this.children.length) this.children.push(view)
    else this.children.splice(index, 0, view)
    view._parentView = this
    view._attach(this._window)
  }
  removeChildView(view) {
    const i = this.children.indexOf(view)
    if (i < 0) return
    this.children.splice(i, 1)
    view._parentView = null
    view._attach(null)
  }
  _attach(win) {
    this._window = win
    for (const c of this.children) c._attach(win)
  }
  setBounds(b) {
    this._bounds = { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) }
    this.emit('bounds-changed')
  }
  getBounds() {
    return { ...this._bounds }
  }
  setVisible(v) {
    this._visible = !!v
  }
  getVisible() {
    return this._visible
  }
  setBackgroundColor() {}
  setBorderRadius() {}
}
fallbackClass(View, 'View')

class WebContentsView extends View {
  constructor(options = {}) {
    super()
    this.webContents = new WebContents({ preload: options.webPreferences?.preload, owner: this, type: 'browserView' })
  }
  _attach(win) {
    super._attach(win)
    if (win) {
      const siblings = this._parentView ? this._parentView.children : []
      bus.cmd('view.attach', {
        wc: this.webContents.id,
        win: win.id,
        index: siblings.indexOf(this),
        bounds: this._bounds,
        visible: this._visible,
      })
    } else {
      bus.cmd('view.detach', { wc: this.webContents.id })
    }
  }
  setBounds(b) {
    super.setBounds(b)
    bus.cmd('view.bounds', { wc: this.webContents.id, bounds: this._bounds })
  }
  setVisible(v) {
    super.setVisible(v)
    bus.cmd('view.visible', { wc: this.webContents.id, visible: this._visible })
  }
  setBackgroundColor(color) {
    bus.cmd('view.background', { wc: this.webContents.id, color })
  }
  _contentsFocused() {
    this._window?._contentsFocused()
  }
}

let winSeq = 0
const allWindows = new Map()
let focusedWinId = 0

class BrowserWindow extends EventEmitter {
  constructor(options = {}) {
    super()
    this.id = ++winSeq
    this._options = options
    this._title = options.title || appName
    this._visible = options.show !== false
    this._destroyed = false
    this._maximized = false
    this._fullScreen = !!options.fullscreen
    this._parent = options.parent || null
    this._modal = !!options.modal
    this._shownOnce = false
    this._minSize = [options.minWidth || 0, options.minHeight || 0]
    this._size = { width: options.width || 800, height: options.height || 600 }
    // a window the host lays out as a dialog over its parent; others fill the screen
    this._floating = !!(this._parent || this._modal) && this._size.width < display.width && this._size.height < display.height
    this._bounds = this._floating ? { x: 0, y: 0, ...this._size } : { x: 0, y: 0, width: display.width, height: display.height }
    allWindows.set(this.id, this)
    this.webContents = new WebContents({ preload: options.webPreferences?.preload, owner: this, type: 'window' })
    this.contentView = new View()
    this.contentView._window = this
    this.contentView._bounds = { x: 0, y: 0, width: this._bounds.width, height: this._bounds.height }
    bus.cmd('window.create', {
      win: this.id,
      wc: this.webContents.id,
      parent: this._parent ? this._parent.id : 0,
      floating: this._floating,
      width: this._size.width,
      height: this._size.height,
      title: this._title,
      show: this._visible && !(options.show === false),
      backgroundColor: options.backgroundColor || null,
      waitForReady: !!options.paintWhenInitiallyHidden,
    })
    if (this._visible) {
      focusedWinId = this.id
      this._shownOnce = true
      setImmediate(() => {
        this.emit('show')
        this.emit('focus')
        app.emit('browser-window-focus', {}, this)
      })
    }
    app.emit('browser-window-created', {}, this)
  }

  static getAllWindows() {
    return [...allWindows.values()]
  }
  static getFocusedWindow() {
    const w = allWindows.get(focusedWinId)
    return w && !w._destroyed && w._visible ? w : null
  }
  static fromWebContents(wc) {
    if (!wc) return null
    const owner = wc._owner
    if (owner instanceof BrowserWindow) return owner._destroyed ? null : owner
    if (owner instanceof View) return owner._window || null
    return null
  }
  static fromId(id) {
    return allWindows.get(Number(id)) || null
  }
  static fromBrowserView() {
    return null
  }

  loadURL(url, options) {
    return this.webContents.loadURL(url, options)
  }
  loadFile(file, options) {
    return this.webContents.loadFile(file, options)
  }
  reload() {
    this.webContents.reload()
  }

  _contentsLoaded() {
    if (!this._readyShown) {
      this._readyShown = true
      this.emit('ready-to-show')
    }
  }
  _contentsFocused() {
    if (focusedWinId !== this.id) {
      const prev = allWindows.get(focusedWinId)
      focusedWinId = this.id
      prev?.emit('blur')
      this.emit('focus')
      app.emit('browser-window-focus', {}, this)
    }
  }
  _contentsTitle(title, e) {
    this.emit('page-title-updated', e, title, true)
    if (!e.defaultPrevented) this.setTitle(title)
  }
  _resized(width, height) {
    if (this._floating) return
    this._bounds = { x: 0, y: 0, width, height }
    this.contentView._bounds = { x: 0, y: 0, width, height }
    this.emit('will-resize', { preventDefault() {} }, this._bounds, {})
    this.emit('resize')
    this.emit('resized')
  }

  show() {
    this._visible = true
    bus.cmd('window.show', { win: this.id })
    if (!this._shownOnce) this._shownOnce = true
    this.emit('show')
    this.focus()
  }
  showInactive() {
    this.show()
  }
  hide() {
    this._visible = false
    bus.cmd('window.hide', { win: this.id })
    this.emit('hide')
  }
  isVisible() {
    return this._visible && !this._destroyed
  }
  focus() {
    if (this._destroyed) return
    bus.cmd('window.focus', { win: this.id })
    this._contentsFocused()
  }
  blur() {}
  isFocused() {
    return focusedWinId === this.id
  }
  close() {
    if (this._destroyed) return
    const e = {
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true
      },
    }
    this.emit('close', e)
    if (!e.defaultPrevented) this.destroy()
  }
  destroy() {
    if (this._destroyed) return
    this._destroyed = true
    this._visible = false
    for (const child of this.getChildWindows()) child.destroy()
    for (const view of this.contentView.children.slice()) this.contentView.removeChildView(view)
    bus.cmd('window.destroy', { win: this.id })
    this.webContents.destroy()
    allWindows.delete(this.id)
    if (focusedWinId === this.id) {
      const rest = [...allWindows.values()].filter((w) => w._visible)
      focusedWinId = rest.length ? rest[rest.length - 1].id : 0
    }
    this.emit('closed')
    if (allWindows.size === 0) app.emit('window-all-closed')
  }
  isDestroyed() {
    return this._destroyed
  }
  minimize() {
    bus.cmd('window.minimize', { win: this.id })
    this.emit('minimize')
  }
  restore() {
    this.emit('restore')
  }
  isMinimized() {
    return false
  }
  maximize() {
    this._maximized = true
    this.emit('maximize')
  }
  unmaximize() {
    this._maximized = false
    this.emit('unmaximize')
  }
  isMaximized() {
    return this._maximized
  }
  isNormal() {
    return !this._maximized && !this._fullScreen
  }
  setFullScreen(on) {
    this._fullScreen = !!on
    bus.cmd('window.fullscreen', { win: this.id, on: this._fullScreen })
    this.emit(on ? 'enter-full-screen' : 'leave-full-screen')
  }
  isFullScreen() {
    return this._fullScreen
  }
  isFullScreenable() {
    return true
  }
  setSimpleFullScreen(on) {
    this.setFullScreen(on)
  }
  isSimpleFullScreen() {
    return this._fullScreen
  }
  setKiosk() {}
  isKiosk() {
    return false
  }
  getBounds() {
    return { ...this._bounds }
  }
  getContentBounds() {
    return { ...this._bounds }
  }
  getNormalBounds() {
    return { ...this._bounds }
  }
  setBounds(b) {
    if (this._floating && b.width && b.height) this.setSize(b.width, b.height)
  }
  setContentBounds(b) {
    this.setBounds(b)
  }
  getSize() {
    return [this._bounds.width, this._bounds.height]
  }
  getContentSize() {
    return this.getSize()
  }
  setSize(width, height) {
    if (!this._floating) return
    this._bounds = { x: 0, y: 0, width, height }
    this.contentView._bounds = { x: 0, y: 0, width, height }
    bus.cmd('window.size', { win: this.id, width, height })
  }
  setContentSize(width, height) {
    this.setSize(width, height)
  }
  setMinimumSize(w, h) {
    this._minSize = [w, h]
  }
  getMinimumSize() {
    return this._minSize
  }
  setMaximumSize() {}
  getMaximumSize() {
    return [0, 0]
  }
  getPosition() {
    return [0, 0]
  }
  setPosition() {}
  center() {}
  setTitle(title) {
    this._title = title
    bus.cmd('window.title', { win: this.id, title })
  }
  getTitle() {
    return this._title
  }
  setTitleBarOverlay() {}
  setMenu() {}
  removeMenu() {}
  setMenuBarVisibility() {}
  isMenuBarVisible() {
    return false
  }
  setAutoHideMenuBar() {}
  isMenuBarAutoHide() {
    return true
  }
  setBackgroundColor(color) {
    bus.cmd('window.background', { win: this.id, color })
  }
  getBackgroundColor() {
    return this._options.backgroundColor || '#FFFFFF'
  }
  setIcon() {}
  setProgressBar() {}
  setOverlayIcon() {}
  setDocumentEdited(v) {
    this._edited = v
  }
  isDocumentEdited() {
    return !!this._edited
  }
  setRepresentedFilename(f) {
    this._represented = f
  }
  getRepresentedFilename() {
    return this._represented || ''
  }
  setAlwaysOnTop() {}
  isAlwaysOnTop() {
    return false
  }
  moveTop() {}
  moveAbove() {}
  setParentWindow(p) {
    this._parent = p
  }
  getParentWindow() {
    return this._parent
  }
  getChildWindows() {
    return [...allWindows.values()].filter((w) => w._parent === this)
  }
  isModal() {
    return this._modal
  }
  setVibrancy() {}
  setBackgroundMaterial() {}
  setSkipTaskbar() {}
  flashFrame() {}
  setResizable() {}
  isResizable() {
    return !this._floating
  }
  setMovable() {}
  isMovable() {
    return false
  }
  setMinimizable() {}
  isMinimizable() {
    return !this._floating
  }
  setMaximizable() {}
  isMaximizable() {
    return !this._floating
  }
  setClosable() {}
  isClosable() {
    return true
  }
  setFocusable() {}
  isFocusable() {
    return true
  }
  setWindowButtonVisibility() {}
  setHasShadow() {}
  hasShadow() {
    return true
  }
  setOpacity() {}
  getOpacity() {
    return 1
  }
  setIgnoreMouseEvents() {}
  setContentProtection() {}
  setEnabled() {}
  isEnabled() {
    return true
  }
  setAspectRatio() {}
  setSheetOffset() {}
  getNativeWindowHandle() {
    return Buffer.alloc(8)
  }
  getMediaSourceId() {
    return `window:${this.id}:0`
  }
  setBrowserView() {}
  getBrowserView() {
    return null
  }
  addBrowserView() {}
  getBrowserViews() {
    return []
  }
  setTouchBar() {}
  setThumbarButtons() {
    return false
  }
  setAppDetails() {}
  showDefinitionForSelection() {}
  invalidateShadow() {}
}
fallbackClass(BrowserWindow, 'BrowserWindow')

// --- Menu -------------------------------------------------------------------------

let applicationMenu = null
let itemSeq = 0
const itemsById = new Map()

class MenuItem {
  constructor(options = {}) {
    Object.assign(this, options)
    this._key = `m${++itemSeq}`
    itemsById.set(this._key, this)
    this.type = options.type || (options.submenu ? 'submenu' : 'normal')
    this.enabled = options.enabled !== false
    this.visible = options.visible !== false
    this.checked = !!options.checked
    this.label = options.label || ''
    if (options.submenu) this.submenu = options.submenu instanceof Menu ? options.submenu : Menu.buildFromTemplate(options.submenu)
    this.menu = null
  }
}

class Menu extends EventEmitter {
  constructor() {
    super()
    this.items = []
  }
  static buildFromTemplate(template) {
    const menu = new Menu()
    for (const t of template || []) menu.append(t instanceof MenuItem ? t : new MenuItem(t))
    return menu
  }
  static setApplicationMenu(menu) {
    applicationMenu = menu
    publishAccelerators()
  }
  static getApplicationMenu() {
    return applicationMenu
  }
  static sendActionToFirstResponder() {}
  append(item) {
    item.menu = this
    this.items.push(item)
  }
  insert(pos, item) {
    item.menu = this
    this.items.splice(pos, 0, item)
  }
  getMenuItemById(id) {
    for (const item of this.items) {
      if (item.id === id) return item
      const sub = item.submenu?.getMenuItemById(id)
      if (sub) return sub
    }
    return null
  }
  popup(options = {}) {
    const win = options.window || BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0]
    this.emit('menu-will-show', {})
    bus
      .request('menu.popup', {
        win: win ? win.id : 0,
        x: options.x ?? null,
        y: options.y ?? null,
        items: serializeMenu(this),
      })
      .then((key) => {
        this.emit('menu-will-close', {})
        if (key) activateItem(itemsById.get(key), win, {})
        options.callback?.()
      })
      .catch((err) => {
        console.error('[menu]', err)
        options.callback?.()
      })
  }
  closePopup() {
    bus.cmd('menu.close')
  }
}
fallbackClass(Menu, 'Menu')

function cleanLabel(label) {
  return String(label || '').replace(/&(.)/g, '$1')
}

function serializeMenu(menu) {
  return menu.items
    .filter((i) => i.visible !== false)
    .map((i) => ({
      key: i._key,
      type: i.type,
      label: cleanLabel(i.label || roleLabel(i.role)),
      enabled: i.enabled !== false,
      checked: !!i.checked,
      accelerator: i.accelerator ? String(i.accelerator).replace(/CmdOrCtrl|CommandOrControl/g, 'Ctrl') : '',
      submenu: i.submenu ? serializeMenu(i.submenu) : null,
    }))
}

const ROLE_LABELS = {
  undo: 'Undo',
  redo: 'Redo',
  cut: 'Cut',
  copy: 'Copy',
  paste: 'Paste',
  pasteandmatchstyle: 'Paste and Match Style',
  delete: 'Delete',
  selectall: 'Select All',
  reload: 'Reload',
  forcereload: 'Force Reload',
  toggledevtools: 'Toggle Developer Tools',
  resetzoom: 'Actual Size',
  zoomin: 'Zoom In',
  zoomout: 'Zoom Out',
  togglefullscreen: 'Toggle Full Screen',
  minimize: 'Minimize',
  close: 'Close',
  quit: 'Quit',
}
function roleLabel(role) {
  return role ? ROLE_LABELS[String(role).toLowerCase()] || role : ''
}

function activateItem(item, win, event) {
  if (!item || item.enabled === false) return
  if (item.type === 'checkbox') item.checked = !item.checked
  if (item.type === 'radio') {
    for (const sib of item.menu?.items || []) if (sib.type === 'radio') sib.checked = sib === item
    item.checked = true
  }
  const focused = win?.webContents
  if (typeof item.click === 'function') {
    try {
      item.click(item, win, event)
    } catch (err) {
      console.error('[menu] click', err)
    }
    return
  }
  const role = String(item.role || '').toLowerCase()
  const wc = webContents.getFocusedWebContents() || focused
  switch (role) {
    case 'undo':
    case 'redo':
    case 'cut':
    case 'copy':
    case 'paste':
    case 'delete':
      wc?.[role]()
      break
    case 'pasteandmatchstyle':
      wc?.paste()
      break
    case 'selectall':
      wc?.selectAll()
      break
    case 'reload':
    case 'forcereload':
      wc?.reload()
      break
    case 'resetzoom':
      wc?.setZoomFactor(1)
      break
    case 'zoomin':
      wc?.setZoomFactor((wc.getZoomFactor() || 1) * 1.1)
      break
    case 'zoomout':
      wc?.setZoomFactor((wc.getZoomFactor() || 1) / 1.1)
      break
    case 'togglefullscreen':
      win?.setFullScreen(!win.isFullScreen())
      break
    case 'minimize':
      win?.minimize()
      break
    case 'close':
      win?.close()
      break
    case 'quit':
      app.quit()
      break
  }
}

function collectAccelerators(menu, out) {
  for (const item of menu?.items || []) {
    if (item.submenu) collectAccelerators(item.submenu, out)
    else if (item.accelerator && typeof item.click === 'function' && item.visible !== false && item.registerAccelerator !== false) {
      out.push({ id: item._key, accelerator: String(item.accelerator) })
    }
  }
  return out
}

function currentAccelerators() {
  return collectAccelerators(applicationMenu, [])
}

function publishAccelerators() {
  const accelerators = currentAccelerators()
  for (const id of allContents.keys()) bus.sendToPage(id, { accelerators })
}

function menuAccelerator(key, wc) {
  const item = itemsById.get(key)
  activateItem(item, BrowserWindow.fromWebContents(wc) || BrowserWindow.getFocusedWindow(), { triggeredByAccelerator: true })
}

// --- dialog --------------------------------------------------------------------

function splitWindowArg(a, b) {
  return a instanceof BrowserWindow || a === null ? [a, b || {}] : [null, a || {}]
}

const dialog = fallback(
  {
    async showOpenDialog(a, b) {
      const [win, options] = splitWindowArg(a, b)
      const r = await bus.request('dialog.open', {
        win: win ? win.id : 0,
        title: options.title || '',
        defaultPath: options.defaultPath || '',
        filters: options.filters || [],
        properties: options.properties || ['openFile'],
      })
      return { canceled: !r || !r.length, filePaths: r || [] }
    },
    async showSaveDialog(a, b) {
      const [win, options] = splitWindowArg(a, b)
      const r = await bus.request('dialog.save', {
        win: win ? win.id : 0,
        title: options.title || '',
        defaultPath: options.defaultPath || '',
        filters: options.filters || [],
      })
      return { canceled: !r, filePath: r || '' }
    },
    async showMessageBox(a, b) {
      const [win, options] = splitWindowArg(a, b)
      const buttons = options.buttons && options.buttons.length ? options.buttons : ['OK']
      const r = await bus.request('dialog.message', {
        win: win ? win.id : 0,
        type: options.type || 'none',
        title: options.title || '',
        message: options.message || '',
        detail: options.detail || '',
        buttons: buttons.map(cleanLabel),
        defaultId: options.defaultId ?? 0,
        cancelId: options.cancelId ?? (buttons.length > 1 ? buttons.length - 1 : 0),
        checkboxLabel: options.checkboxLabel || '',
        checkboxChecked: !!options.checkboxChecked,
      })
      return { response: r ? r.response : options.cancelId ?? 0, checkboxChecked: r ? !!r.checkboxChecked : !!options.checkboxChecked }
    },
    showErrorBox(title, content) {
      console.error('[dialog] error box:', title, content)
      bus.cmd('dialog.error', { title: String(title || ''), message: String(content || '') })
    },
    showMessageBoxSync(a, b) {
      const [, options] = splitWindowArg(a, b)
      warn('dialog.showMessageBoxSync')
      return options.cancelId ?? 0
    },
    showOpenDialogSync() {
      warn('dialog.showOpenDialogSync')
      return undefined
    },
    showSaveDialogSync() {
      warn('dialog.showSaveDialogSync')
      return undefined
    },
    showCertificateTrustDialog: () => Promise.resolve(),
  },
  'dialog',
)

// --- shell, clipboard, nativeImage ----------------------------------------------------

const shell = fallback(
  {
    openExternal(url) {
      bus.cmd('shell.openExternal', { url: String(url) })
      return Promise.resolve()
    },
    async openPath(p) {
      const r = await bus.request('shell.openPath', { path: String(p) }).catch((e) => String(e.message || e))
      return typeof r === 'string' ? r : ''
    },
    showItemInFolder(p) {
      bus.cmd('shell.showItemInFolder', { path: String(p) })
    },
    async trashItem(p) {
      await fs.promises.rm(p, { recursive: true, force: true })
    },
    beep() {},
    writeShortcutLink: () => false,
    readShortcutLink: () => ({}),
  },
  'shell',
)

let clipboardText = ''
let clipboardImage = null
const clipboard = fallback(
  {
    readText: () => clipboardText,
    writeText(text) {
      clipboardText = String(text ?? '')
      bus.cmd('clipboard.write', { text: clipboardText })
    },
    readHTML: () => '',
    writeHTML(html) {
      bus.cmd('clipboard.write', { html: String(html), text: String(html).replace(/<[^>]+>/g, '') })
    },
    readRTF: () => '',
    writeRTF() {},
    readImage: () => clipboardImage || nativeImage.createEmpty(),
    writeImage(img) {
      clipboardImage = img
      if (img && !img.isEmpty()) bus.cmd('clipboard.write', { png: img.toPNG().toString('base64') })
    },
    readBookmark: () => ({ title: '', url: '' }),
    writeBookmark() {},
    readFindText: () => '',
    writeFindText() {},
    clear() {
      clipboardText = ''
      clipboardImage = null
    },
    availableFormats: () => [...(clipboardText ? ['text/plain'] : []), ...(clipboardImage ? ['image/png'] : [])],
    has: (format) => clipboard.availableFormats().includes(format),
    read: () => '',
    readBuffer: () => Buffer.alloc(0),
    writeBuffer() {},
    write(data) {
      if (data.text !== undefined) clipboard.writeText(data.text)
      else if (data.html !== undefined) clipboard.writeHTML(data.html)
      if (data.image) clipboard.writeImage(data.image)
    },
  },
  'clipboard',
)

function pngSize(buf) {
  if (buf && buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
  if (buf && buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) break
      const marker = buf[i + 1]
      const len = buf.readUInt16BE(i + 2)
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) }
      }
      i += 2 + len
    }
  }
  return { width: 0, height: 0 }
}

class NativeImage {
  constructor(buffer, mime) {
    this._buf = buffer && buffer.length ? Buffer.from(buffer) : Buffer.alloc(0)
    this._mime = mime || (this._buf[0] === 0xff ? 'image/jpeg' : 'image/png')
    this.isMacTemplateImage = false
  }
  isEmpty() {
    return this._buf.length === 0
  }
  getSize() {
    return pngSize(this._buf)
  }
  getAspectRatio() {
    const s = this.getSize()
    return s.height ? s.width / s.height : 1
  }
  toPNG() {
    return this._buf
  }
  toJPEG() {
    return this._buf
  }
  toBitmap() {
    return this._buf
  }
  getBitmap() {
    return this._buf
  }
  toDataURL() {
    return this.isEmpty() ? 'data:image/png;base64,' : `data:${this._mime};base64,${this._buf.toString('base64')}`
  }
  resize() {
    return this
  }
  crop() {
    return this
  }
  addRepresentation() {}
  getScaleFactors() {
    return [1]
  }
  setTemplateImage() {}
  isTemplateImage() {
    return false
  }
}
fallbackClass(NativeImage, 'NativeImage')

const nativeImage = fallback(
  {
    createEmpty: () => new NativeImage(null),
    createFromBuffer: (buf) => new NativeImage(buf),
    createFromPath(p) {
      try {
        return new NativeImage(fs.readFileSync(p))
      } catch {
        return new NativeImage(null)
      }
    },
    createFromDataURL(url) {
      const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(String(url))
      if (!m) return new NativeImage(null)
      return new NativeImage(m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3])), m[1])
    },
    createFromBitmap: () => new NativeImage(null),
    createFromNamedImage: () => new NativeImage(null),
    createThumbnailFromPath: () => Promise.reject(new Error('thumbnails are not available on Android')),
  },
  'nativeImage',
)

// --- spelling -------------------------------------------------------------------------------
// Android's system spell checker draws WebView's underlines; the context
// menu's misspelled word and suggestions come from it too (spell.check),
// minus the words added to the app's own dictionary.

function systemLanguage() {
  return process.env.GO_LOCALE || 'en-US'
}

const spell = {
  enabled: true,
  languages: [systemLanguage()],
  _words: null,
  file() {
    return path.join(paths.userData, 'Custom Dictionary.txt')
  },
  words() {
    if (!this._words) {
      try {
        this._words = new Set(fs.readFileSync(this.file(), 'utf8').split('\n').filter(Boolean))
      } catch {
        this._words = new Set()
      }
    }
    return this._words
  },
  save() {
    try {
      fs.writeFileSync(this.file(), [...this.words()].join('\n') + '\n')
    } catch (err) {
      console.error('[spell] save', err.message)
    }
  },
}

async function withSpelling(params) {
  const word = params.spellWord
  delete params.spellWord
  if (!spell.enabled || !params.isEditable || !word || spell.words().has(word)) return params
  try {
    const r = await Promise.race([
      bus.request('spell.check', { word, language: spell.languages[0] || '' }),
      new Promise((resolve) => setTimeout(() => resolve(null), 800)),
    ])
    if (r && r.misspelled) {
      params.misspelledWord = word
      params.dictionarySuggestions = (r.suggestions || []).filter((s) => s && s !== word).slice(0, 5)
    }
  } catch (err) {
    console.error('[spell]', err.message)
  }
  return params
}

// --- protocol, net, session ------------------------------------------------------------

const protocol = fallback(
  {
    registerSchemesAsPrivileged() {},
    handle(scheme, handler) {
      bus.protocols.set(String(scheme).toLowerCase(), handler)
    },
    unhandle(scheme) {
      bus.protocols.delete(String(scheme).toLowerCase())
    },
    isProtocolHandled: (scheme) => bus.protocols.has(String(scheme).toLowerCase()),
    registerFileProtocol(scheme, handler) {
      protocol.handle(scheme, (request) => new Promise((resolve) => handler(request, (r) => resolve(fileResponse(typeof r === 'string' ? r : r.path, request)))))
      return true
    },
    registerBufferProtocol(scheme, handler) {
      protocol.handle(scheme, (request) => new Promise((resolve) => handler(request, (r) => resolve(new Response(r?.data ?? r, { headers: r?.mimeType ? { 'content-type': r.mimeType } : {} })))))
      return true
    },
    registerStringProtocol(scheme, handler) {
      return protocol.registerBufferProtocol(scheme, handler)
    },
    registerHttpProtocol() {
      warn('protocol.registerHttpProtocol')
      return false
    },
    unregisterProtocol(scheme) {
      protocol.unhandle(scheme)
      return true
    },
    isProtocolRegistered: (scheme) => bus.protocols.has(String(scheme).toLowerCase()),
    interceptFileProtocol: () => false,
  },
  'protocol',
)

async function netFetch(input, init) {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  const scheme = url.slice(0, Math.max(0, url.indexOf(':'))).toLowerCase()
  const handler = bus.protocols.get(scheme)
  if (handler && !init?.bypassCustomProtocolHandlers) {
    const req = typeof input === 'string' || input instanceof URL ? new Request(url, init) : input
    return handler(req)
  }
  if (scheme === 'file') return fileResponse(fileURLToPath(url.replace(/[?#].*$/, '')), typeof input === 'object' && input.headers ? input : new Request('http://x/', init))
  if (!/^https?:/i.test(url)) return fetch(input, init)
  const req = new Request(input, init)
  // as Electron's net.fetch: the browser's user agent, not Node's "node"
  if (!req.headers.has('user-agent') && process.env.GO_UA) req.headers.set('user-agent', process.env.GO_UA)
  const host = new URL(url).host
  // a host whose CDN already turned Node away goes to WebView straight (for a while)
  if ((blockedHosts.get(host) || 0) > Date.now()) {
    try {
      return await webFetch(req.clone())
    } catch {}
  }
  try {
    const res = await fetch(req.clone())
    if (!blockedByEdge(res)) return res
    blockedHosts.set(host, Date.now() + 10 * 60000)
    // a CDN's bot check turned Node away (by how it speaks TLS, as it does
    // Android's HTTP stack): the request goes from a page of the site in a
    // hidden WebView, on Chromium's network stack as on desktop
    let reason = ''
    try {
      const again = await webFetch(req)
      if (!blockedByEdge(again)) return again
      reason = ` (in WebView too: HTTP ${again.status})`
    } catch (err) {
      reason = ` (WebView: ${err.message})`
    }
    reportNetworkError(url, new Error(`HTTP ${res.status} from ${res.headers.get('server') || 'the server'}, blocked${reason}`))
    return res
  } catch (err) {
    if (err?.name === 'AbortError' || req.signal?.aborted) throw err
    // Node could not connect (TLS, DNS, a blocked client): Android's own HTTP
    // stack, with the system's certificates and network settings, tries again
    try {
      return await hostFetch(req)
    } catch (fallbackErr) {
      reportNetworkError(url, err)
      console.error('net.fetch fallback', url, fallbackErr.message)
      throw err
    }
  }
}

const blockedHosts = new Map()

/** A CDN's bot check answering instead of the site (Cloudflare and the like). */
function blockedByEdge(res) {
  if (res.status !== 403 && res.status !== 429 && res.status !== 503) return false
  const h = res.headers
  return h.has('cf-mitigated') || h.has('cf-ray') || /cloudflare|akamai|cloudfront/i.test(h.get('server') || '')
}

async function webFetch(req) {
  const headers = {}
  req.headers.forEach((v, k) => {
    headers[k] = v
  })
  const body = req.method === 'GET' || req.method === 'HEAD' ? '' : Buffer.from(await req.arrayBuffer()).toString('base64')
  const r = await Promise.race([
    bus.request('net.webFetch', { url: req.url, method: req.method, headers, body }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 70000)),
  ])
  const h = new Headers(r.headers || {})
  // the page cannot read Set-Cookie: the host hands over the cookie jar's
  for (const c of r.setCookies || []) h.append('set-cookie', c)
  const nullBody = r.status === 204 || r.status === 304 || req.method === 'HEAD'
  return new Response(nullBody ? null : Buffer.from(r.body || '', 'base64'), { status: r.status, headers: h })
}

async function hostFetch(req) {
  const headers = {}
  req.headers.forEach((v, k) => {
    headers[k] = v
  })
  const body = req.method === 'GET' || req.method === 'HEAD' ? '' : Buffer.from(await req.arrayBuffer()).toString('base64')
  const r = await Promise.race([
    bus.request('net.fetch', { url: req.url, method: req.method, headers, body }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 30000)),
  ])
  const status = r.status
  const nullBody = status === 204 || status === 304 || req.method === 'HEAD'
  return new Response(nullBody ? null : Buffer.from(r.body || '', 'base64'), { status, headers: r.headers || {} })
}

// GenOffice reports only "Cannot reach …"; show the underlying cause once a minute per host
const networkErrorShown = new Map()
function reportNetworkError(url, err) {
  if (err?.name === 'AbortError') return
  let host = url
  try {
    host = new URL(url).host
  } catch {}
  const now = Date.now()
  if (now - (networkErrorShown.get(host) || 0) < 60000) return
  networkErrorShown.set(host, now)
  const cause = err?.cause?.code || err?.cause?.message || err?.message || String(err)
  console.error('net.fetch', host, err?.cause || err)
  bus?.cmd('notify', { title: 'Network error: ' + host, body: String(cause) })
}

const net = fallback(
  {
    fetch: netFetch,
    isOnline: () => true,
    get online() {
      return true
    },
    request() {
      throw new Error('net.request is not available on Android; use net.fetch')
    },
    resolveHost: () => Promise.resolve({ endpoints: [] }),
  },
  'net',
)

function makeSession(partition) {
  const s = fallback(new EventEmitter(), 'session')
  Object.assign(s, {
    partition,
    protocol,
    fetch: netFetch,
    webRequest: fallback({ onBeforeRequest() {}, onBeforeSendHeaders() {}, onHeadersReceived() {}, onCompleted() {}, onErrorOccurred() {} }, 'webRequest'),
    setPermissionRequestHandler() {},
    setPermissionCheckHandler() {},
    setDevicePermissionHandler() {},
    setDisplayMediaRequestHandler() {},
    setSpellCheckerEnabled(on) {
      spell.enabled = !!on
    },
    isSpellCheckerEnabled: () => spell.enabled,
    setSpellCheckerLanguages(langs) {
      spell.languages = Array.isArray(langs) && langs.length ? langs.slice(0, 1) : spell.languages
    },
    getSpellCheckerLanguages: () => spell.languages.slice(),
    addWordToSpellCheckerDictionary(word) {
      spell.words().add(String(word))
      spell.save()
      return true
    },
    removeWordFromSpellCheckerDictionary(word) {
      const removed = spell.words().delete(String(word))
      if (removed) spell.save()
      return removed
    },
    listWordsInSpellCheckerDictionary: () => Promise.resolve([...spell.words()]),
    setSpellCheckerDictionaryDownloadURL() {},
    clearCache: () => Promise.resolve(),
    clearStorageData: () => Promise.resolve(),
    clearHostResolverCache: () => Promise.resolve(),
    flushStorageData() {},
    getCacheSize: () => Promise.resolve(0),
    setProxy: () => Promise.resolve(),
    resolveProxy: () => Promise.resolve('DIRECT'),
    closeAllConnections: () => Promise.resolve(),
    getUserAgent: () => '',
    setUserAgent() {},
    setPreloads() {},
    getPreloads: () => [],
    registerPreloadScript() {},
    setCodeCachePath() {},
    getStoragePath: () => paths.sessionData,
    isPersistent: () => true,
    setDownloadPath() {},
    cookies: fallback({ get: () => Promise.resolve([]), set: () => Promise.resolve(), remove: () => Promise.resolve(), flushStore: () => Promise.resolve(), on() {} }, 'cookies'),
    serviceWorkers: fallback({ getAllRunning: () => ({}), on() {} }, 'serviceWorkers'),
    extensions: fallback({ getAllExtensions: () => [], loadExtension: () => Promise.reject(new Error('no extensions')) }, 'extensions'),
  })
  Object.defineProperty(s, 'availableSpellCheckerLanguages', {
    get: () => [...new Set([systemLanguage(), ...spell.languages])],
  })
  return s
}
defaultSession = makeSession('')
const sessions = new Map()
const session = fallback(
  {
    get defaultSession() {
      return defaultSession
    },
    fromPartition(p) {
      if (!p) return defaultSession
      if (!sessions.has(p)) sessions.set(p, makeSession(p))
      return sessions.get(p)
    },
    fromPath: () => defaultSession,
  },
  'session',
)

// --- smaller modules ---------------------------------------------------------------------

const systemPreferences = fallback(
  Object.assign(new EventEmitter(), {
    getMediaAccessStatus: () => 'granted',
    askForMediaAccess: () => Promise.resolve(true),
    getAccentColor: () => '3584e4ff',
    getColor: () => '#000000',
    getSystemColor: () => '#000000',
    isDarkMode: () => nativeTheme.shouldUseDarkColors,
    getAnimationSettings: () => ({ shouldRenderRichAnimation: true, scrollAnimationsEnabledBySystem: true, prefersReducedMotion: false }),
    canPromptTouchID: () => false,
    isTrustedAccessibilityClient: () => false,
    getUserDefault: () => undefined,
    subscribeNotification: () => 0,
    unsubscribeNotification() {},
  }),
  'systemPreferences',
)

class Notification extends EventEmitter {
  constructor(options = {}) {
    super()
    this.title = options.title || ''
    this.body = options.body || ''
  }
  static isSupported() {
    return true
  }
  show() {
    bus.cmd('notify', { title: this.title, body: this.body })
    this.emit('show')
  }
  close() {}
}
fallbackClass(Notification, 'Notification')

const powerMonitor = fallback(
  Object.assign(new EventEmitter(), { getSystemIdleState: () => 'active', getSystemIdleTime: () => 0, isOnBatteryPower: () => false, onBatteryPower: false }),
  'powerMonitor',
)
const powerSaveBlocker = fallback({ start: () => 1, stop() {}, isStarted: () => false }, 'powerSaveBlocker')
const desktopCapturer = fallback({ getSources: () => Promise.resolve([]) }, 'desktopCapturer')
const globalShortcut = fallback({ register: () => false, registerAll() {}, isRegistered: () => false, unregister() {}, unregisterAll() {} }, 'globalShortcut')
const crashReporter = fallback({ start() {}, addExtraParameter() {}, removeExtraParameter() {}, getParameters: () => ({}), getUploadedReports: () => [], getLastCrashReport: () => null }, 'crashReporter')
const autoUpdater = fallback(Object.assign(new EventEmitter(), { setFeedURL() {}, getFeedURL: () => '', checkForUpdates() {}, quitAndInstall() {} }), 'autoUpdater')
const safeStorage = fallback(
  {
    isEncryptionAvailable: () => false,
    encryptString: (s) => Buffer.from(String(s), 'utf8'),
    decryptString: (b) => Buffer.from(b).toString('utf8'),
    setUsePlainTextEncryption() {},
    getSelectedStorageBackend: () => 'basic_text',
    isAsyncEncryptionAvailable: () => Promise.resolve(false),
  },
  'safeStorage',
)
const contentTracing = fallback({ startRecording: () => Promise.resolve(), stopRecording: () => Promise.resolve(''), getCategories: () => Promise.resolve([]) }, 'contentTracing')
const webFrameMain = fallback({ fromId: () => null, fromFrameToken: () => null }, 'webFrameMain')

class MessageChannelMain {
  constructor() {
    const { MessageChannel } = require('node:worker_threads')
    const { port1, port2 } = new MessageChannel()
    this.port1 = port1
    this.port2 = port2
  }
}

// --- host and page events ---------------------------------------------------------------

function onPageMessage(wcId, msg) {
  const wc = allContents.get(wcId)
  if (!wc) return msg.kind === 'invoke' ? { error: codec.encode(new Error('WebContents gone')) } : {}
  if (msg.kind === 'life') {
    wc._life(msg)
    return {}
  }
  if (msg.kind === 'input') return { prevented: wc._input(msg.input) }
  const args = codec.decode(msg.args) || []
  const event = {
    sender: wc,
    senderFrame: wc.mainFrame,
    frameId: 1,
    processId: wc.id,
    ports: [],
    type: 'frame',
    returnValue: undefined,
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true
    },
    reply: (channel, ...a) => wc.send(channel, ...a),
  }
  if (msg.kind === 'send') {
    wc.ipc.emit(msg.channel, event, ...args)
    ipcMain.emit(msg.channel, event, ...args)
    return {}
  }
  if (msg.kind === 'sync') {
    wc.ipc.emit(msg.channel, event, ...args)
    ipcMain.emit(msg.channel, event, ...args)
    return { value: codec.encode(event.returnValue) }
  }
  if (msg.kind === 'invoke') {
    const handler = wc.ipc.handlers.get(msg.channel) || ipcMain.handlers.get(msg.channel)
    if (!handler) return { error: codec.encode(new Error(`No handler registered for '${msg.channel}'`)) }
    return Promise.resolve()
      .then(() => handler(event, ...args))
      .then(
        (value) => ({ value: codec.encode(value) }),
        (err) => {
          console.error(`[ipc] ${msg.channel}:`, err)
          return { error: codec.encode(err instanceof Error ? err : new Error(String(err))) }
        },
      )
  }
  return {}
}

let pendingOpenFiles = []
const preloadCache = new Map()

function onHostEvent(msg) {
  switch (msg.type) {
    case 'memory':
      // Android is short of memory: give back what V8 holds but no longer uses
      // (--expose-gc), before Android starts killing processes
      global.gc?.()
      break
    case 'display': {
      const darkChanged = msg.dark !== undefined && !!msg.dark !== display.dark
      Object.assign(display, {
        width: msg.width ?? display.width,
        height: msg.height ?? display.height,
        scale: msg.scale ?? display.scale,
        dark: msg.dark !== undefined ? !!msg.dark : display.dark,
      })
      screen.emit('display-metrics-changed', {}, displayObject(), ['bounds', 'workArea'])
      if (darkChanged) nativeTheme.emit('updated')
      maybeReady()
      break
    }
    case 'window-size':
      allWindows.get(msg.win)?._resized(msg.width, msg.height)
      break
    case 'close-request':
      allWindows.get(msg.win)?.close()
      break
    case 'window-focus':
      allWindows.get(msg.win)?._contentsFocused()
      break
    case 'wc':
      allContents.get(msg.wc)?._hostEvent(msg)
      break
    case 'clipboard':
      clipboardText = msg.text ?? clipboardText
      break
    case 'open-file':
      if (ready) app.emit('open-file', { preventDefault() {} }, msg.path)
      else pendingOpenFiles.push(msg.path)
      break
    case 'second-instance':
      app.emit('second-instance', { preventDefault() {} }, msg.argv || [], '/', {})
      break
    case 'quit':
      app.quit()
      break
  }
}

let hostSeen = false
function maybeReady() {
  if (ready || !hostSeen) return
  ready = true
  // Electron creates these before ready
  for (const name of ['userData', 'sessionData', 'logs', 'temp', 'documents', 'downloads']) {
    try {
      fs.mkdirSync(paths[name], { recursive: true })
    } catch {}
  }
  app.emit('will-finish-launching')
  app.emit('ready', {}, {})
  readyResolve()
  setImmediate(() => {
    for (const p of pendingOpenFiles) app.emit('open-file', { preventDefault() {} }, p)
    pendingOpenFiles = []
  })
}

function attach(theBus) {
  bus = theBus
  bus.onPageMessage = onPageMessage
  bus.onHostEvent = onHostEvent
  bus.onBoot = (wcId) => {
    const wc = allContents.get(wcId)
    let preload = null
    if (wc?._preload) {
      try {
        // the payload's preload scripts do not change while it runs (re-read while developing)
        preload = (process.env.GO_DEV !== '1' && preloadCache.get(wc._preload)) || fs.readFileSync(wc._preload, 'utf8')
        preloadCache.set(wc._preload, preload)
      } catch (err) {
        console.error('[boot] preload', wc._preload, err.message)
      }
    }
    return {
      wc: wcId,
      port: bus.port,
      preload,
      schemes: ['file', ...bus.protocols.keys()],
      accelerators: currentAccelerators(),
      inputHooks: !!wc && wc.listenerCount('before-input-event') > 0,
      versions: process.versions,
      arch: process.arch === 'arm64' ? 'arm64' : 'x64',
    }
  }
  bus.findWcByOrigin = (origin) => {
    let best = 0
    for (const wc of allContents.values()) {
      try {
        if (bus.urls.toHttp(wc._url).startsWith(new URL(origin).origin)) best = wc.id
      } catch {}
    }
    return best
  }
  bus.onHostConnected = () => {
    hostSeen = true
    maybeReady()
  }
  if (process.env.GO_DEV === '1') {
    // desktop testing without the host: dialogs answer themselves
    bus.devAnswer = (name, args) => {
      if (name === 'dialog.save') return path.join(paths.documents, path.basename(args.defaultPath || 'untitled'))
      if (name === 'dialog.open') return process.env.GO_DEV_OPEN ? [process.env.GO_DEV_OPEN] : []
      if (name === 'dialog.message') return { response: args.defaultId ?? 0, checkboxChecked: false }
      return null
    }
    hostSeen = true
    setTimeout(maybeReady, 50)
  }
}

// a page that gains a before-input-event listener later must start sending keys
const origOn = WebContents.prototype.on
WebContents.prototype.on = function (name, fn) {
  const r = origOn.call(this, name, fn)
  if (name === 'before-input-event' && bus) bus.sendToPage(this.id, { inputHooks: true })
  return r
}
WebContents.prototype.addListener = WebContents.prototype.on

module.exports = {
  attach,
  app,
  autoUpdater,
  BaseWindow: BrowserWindow,
  BrowserView: WebContentsView,
  BrowserWindow,
  clipboard,
  contentTracing,
  crashReporter,
  desktopCapturer,
  dialog,
  globalShortcut,
  inAppPurchase: undefined,
  ipcMain,
  Menu,
  MenuItem,
  MessageChannelMain,
  nativeImage,
  nativeTheme,
  net,
  netLog: fallback({ startLogging: () => Promise.resolve(), stopLogging: () => Promise.resolve() }, 'netLog'),
  Notification,
  powerMonitor,
  powerSaveBlocker,
  protocol,
  pushNotifications: undefined,
  safeStorage,
  screen,
  session,
  shell,
  systemPreferences,
  TouchBar: undefined,
  Tray: undefined,
  utilityProcess: fallback({ fork() { throw new Error('utilityProcess is not available on Android') } }, 'utilityProcess'),
  View,
  webContents,
  WebContentsView,
  webFrameMain,
}
