// Structured-clone-like encoding of IPC values as JSON, shared by the Node
// side (require) and the pages (loaded as a classic script, sets
// globalThis.__goCodec). Electron's IPC carries typed arrays, Dates, Maps,
// Sets and Errors; JSON alone does not.
;(function (root) {
  const hasBuffer = typeof Buffer !== 'undefined'

  function toBase64(bytes) {
    if (hasBuffer) return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64')
    let out = ''
    for (let i = 0; i < bytes.length; i += 0x8000) {
      out += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
    }
    return btoa(out)
  }

  function fromBase64(text) {
    if (hasBuffer) {
      const buf = Buffer.from(text, 'base64')
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
    }
    const bin = atob(text)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    return bytes
  }

  function encode(value, seen) {
    if (value === undefined) return { $: 'u' }
    if (value === null || typeof value === 'boolean' || typeof value === 'string') return value
    if (typeof value === 'number') return Number.isFinite(value) ? value : { $: 'n', v: String(value) }
    if (typeof value === 'bigint') return { $: 'b', v: value.toString() }
    if (typeof value === 'function' || typeof value === 'symbol') return { $: 'u' }
    seen = seen || new Set()
    if (seen.has(value)) return { $: 'u' }
    if (value instanceof Date) return { $: 'd', v: value.getTime() }
    if (value instanceof RegExp) return { $: 'r', v: value.source, f: value.flags }
    if (value instanceof ArrayBuffer) return { $: 'ab', v: toBase64(new Uint8Array(value)) }
    if (ArrayBuffer.isView(value)) {
      const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
      const type = hasBuffer && Buffer.isBuffer(value) ? 'Uint8Array' : value.constructor.name
      return { $: 'ta', t: type, v: toBase64(bytes) }
    }
    if (value instanceof Error) return { $: 'e', name: value.name, message: value.message, stack: value.stack, code: value.code }
    seen.add(value)
    try {
      if (value instanceof Map) return { $: 'm', v: [...value].map(([k, v]) => [encode(k, seen), encode(v, seen)]) }
      if (value instanceof Set) return { $: 's', v: [...value].map((v) => encode(v, seen)) }
      if (Array.isArray(value)) return value.map((v) => encode(v, seen))
      const out = {}
      for (const key of Object.keys(value)) {
        const v = value[key]
        if (typeof v === 'function' || typeof v === 'symbol') continue
        out[key] = encode(v, seen)
      }
      return '$' in out ? { $: 'o', v: out } : out
    } finally {
      seen.delete(value)
    }
  }

  const TYPED = typeof globalThis !== 'undefined' ? globalThis : root

  function decode(value) {
    if (value === null || typeof value !== 'object') return value
    if (Array.isArray(value)) return value.map(decode)
    switch (value.$) {
      case undefined:
        break
      case 'u':
        return undefined
      case 'n':
        return Number(value.v)
      case 'b':
        return BigInt(value.v)
      case 'd':
        return new Date(value.v)
      case 'r':
        return new RegExp(value.v, value.f)
      case 'ab': {
        const bytes = fromBase64(value.v)
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
      }
      case 'ta': {
        const bytes = fromBase64(value.v)
        if (value.t === 'Uint8Array') return hasBuffer ? Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength) : bytes
        const Ctor = TYPED[value.t] || Uint8Array
        const copy = bytes.slice()
        return new Ctor(copy.buffer, 0, copy.byteLength / (Ctor.BYTES_PER_ELEMENT || 1))
      }
      case 'e': {
        const err = new Error(value.message)
        err.name = value.name
        if (value.stack) err.stack = value.stack
        if (value.code !== undefined) err.code = value.code
        return err
      }
      case 'm':
        return new Map(value.v.map(([k, v]) => [decode(k), decode(v)]))
      case 's':
        return new Set(value.v.map(decode))
      case 'o':
        value = value.v
        break
    }
    const out = {}
    for (const key of Object.keys(value)) out[key] = decode(value[key])
    return out
  }

  const api = { encode, decode, toBase64, fromBase64 }
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  else root.__goCodec = api
})(this)
