// Entry point of the Node process on Android: starts the bus, makes
// require('electron') resolve to the shim, then runs GenOffice's own main
// process (resources/app/out/main/index.js) unchanged.
//
// Environment (set by the Java host):
//   GO_RES     resources directory: app/, modules/, native/, wasm/, ...
//   GO_DATA    writable data directory
//   GO_TOKEN   shared secret for the bus
//   GO_WIDTH, GO_HEIGHT, GO_SCALE, GO_DARK, GO_LOCALE   first display state
//   GO_DEV=1   run without the host (desktop testing)
const path = require('node:path')
const fs = require('node:fs')
const Module = require('node:module')

const RES = process.env.GO_RES
if (!RES) {
  console.error('GO_RES is not set')
  process.exit(2)
}

// GenOffice branches on these the way Electron sets them
Object.defineProperty(process, 'platform', { value: 'linux' })
process.resourcesPath = RES
process.type = 'browser'
process.versions.electron = process.versions.electron || '39.0.0'
process.versions.chrome = process.versions.chrome || '142.0.0.0'
process.defaultApp = false
delete process.env.APPIMAGE
delete process.env.ELECTRON_RUN_AS_NODE

// Electron's additions to process
const os = require('node:os')
const started = Date.now()
Object.assign(process, {
  getSystemMemoryInfo: () => ({ total: Math.round(os.totalmem() / 1024), free: Math.round(os.freemem() / 1024), swapTotal: 0, swapFree: 0 }),
  getProcessMemoryInfo: () => Promise.resolve({ residentSet: Math.round(process.memoryUsage().rss / 1024), private: 0, shared: 0 }),
  getHeapStatistics: () => {
    const h = require('node:v8').getHeapStatistics()
    return {
      totalHeapSize: h.total_heap_size / 1024,
      totalHeapSizeExecutable: h.total_heap_size_executable / 1024,
      totalPhysicalSize: h.total_physical_size / 1024,
      totalAvailableSize: h.total_available_size / 1024,
      usedHeapSize: h.used_heap_size / 1024,
      heapSizeLimit: h.heap_size_limit / 1024,
      mallocedMemory: h.malloced_memory / 1024,
      peakMallocedMemory: h.peak_malloced_memory / 1024,
      doesZapGarbage: false,
    }
  },
  getBlinkMemoryInfo: () => ({ allocated: 0, total: 0 }),
  getCPUUsage: () => ({ percentCPUUsage: 0, cumulativeCPUUsage: 0, idleWakeupsPerSecond: 0 }),
  getIOCounters: () => ({ readOperationCount: 0, writeOperationCount: 0, otherOperationCount: 0, readTransferCount: 0, writeTransferCount: 0, otherTransferCount: 0 }),
  getCreationTime: () => started,
  getSystemVersion: () => os.release(),
  takeHeapSnapshot: () => false,
  crash: () => process.abort(),
  hang: () => {},
})

const SHIM = path.join(__dirname, 'electron.js')
const resolve = Module._resolveFilename
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron' || request === 'electron/main' || request === 'electron/common') return SHIM
  if (request === 'original-fs') return resolve.call(this, 'fs', ...rest)
  return resolve.call(this, request, ...rest)
}

process.on('uncaughtException', (err) => console.error('[main] uncaught', err))
process.on('unhandledRejection', (err) => console.error('[main] unhandled rejection', err))

const { Bus } = require('./bus')
const bus = new Bus()

bus.start().then((port) => {
  require(SHIM).attach(bus)
  // the host reads this line to learn where to connect
  console.log(`GO_READY ${port} ${bus.token}`)
  const entry = path.join(RES, 'app', JSON.parse(fs.readFileSync(path.join(RES, 'app', 'package.json'), 'utf8')).main || 'index.js')
  require(entry)
})
