// OPFS-branch corruption regression tests for `client/storage.js`.
//
// Field bug: some OPFS reports were found replaced with the 20-byte
// gzip-of-nothing member (1f 8b 08 00 … ISIZE=0). Root cause chain:
//   1. an OPFS write truncated the entry without committing new bytes
//      (quota failure / tab-kill between createWritable() and
//      close()), leaving a zero-length file;
//   2. the next readFile misclassified the zero-length entry as a
//      LEGACY UNCOMPRESSED report (it fails the 2-byte gzip-magic
//      sniff), decoded it to '', and the fire-and-forget
//      legacy-migration write re-saved it as gzip('') — a well-formed
//      gzip member every later read happily decompressed to '', so
//      the corruption looked like a valid empty report forever.
//
// The fix (client/storage.js):
//   - saveFile rejects '' and saveFileBytes rejects empty payloads,
//     so no code path can mint an empty entry;
//   - readFile / readFileBytes detect empty payloads (zero-length or
//     gzip-of-nothing, via isEmptyPayload), QUARANTINE the entry and
//     throw the standard not-found shape, so callers treat the file
//     as missing and the presence layer's claimed-but-absent path can
//     re-download a synced copy;
//   - failed OPFS writes remove a zero-length leftover
//     (removeIfTruncated) so truncation reads as absent, not empty.
//
// The production OPFS branch is browser-only, so these tests install
// an in-memory OPFS shim on `navigator.storage` BEFORE importing the
// module. The shim intentionally models the observed truncate-on-open
// behaviour (entry emptied at createWritable(), committed at close())
// so the interrupted-write scenario reproduces the original field
// corruption. A flag flips getDirectory() to throwing so the same
// module instance also exercises the localStorage fallback branch.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { gzipBytes } from '../common/gzip.js'
import { encodeUtf8 } from '../common/utf8.js'

function createLocalStorage() {
  const store = new Map()
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)) },
    removeItem: (k) => { store.delete(k) },
    clear: () => { store.clear() },
    get length() { return store.size },
    key: (i) => Array.from(store.keys())[i] ?? null,
  }
}
if (globalThis.localStorage === undefined) {
  globalThis.localStorage = createLocalStorage()
}

const notFound = () => new DOMException('A requested file or directory could not be found', 'NotFoundError')

// In-memory OPFS directory: name → Uint8Array. `failNextWrite`
// injects a mid-flight write failure (quota / closed handle) into the
// next writable's write() call. Methods return synchronously (the
// client `await`s every call, which handles plain values, and its
// try/catch blocks catch a sync throw at the same await); `entries()`
// is a sync generator — `for await` falls back to Symbol.iterator.
function createOpfsDir() {
  const files = new Map()
  const dir = {
    files,
    failNextWrite: false,
    getFileHandle(name, { create = false } = {}) {
      if (!files.has(name)) {
        if (!create) throw notFound()
        // Real OPFS materialises a zero-byte entry as soon as
        // getFileHandle({create: true}) resolves.
        files.set(name, new Uint8Array(0))
      }
      return {
        getFile() {
          const bytes = files.get(name)
          if (bytes === undefined) throw notFound()
          return {
            size: bytes.length,
            arrayBuffer: () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
          }
        },
        createWritable() {
          // Models the observed corruption: the entry is truncated at
          // open and only replaced with the buffered writes on close.
          const chunks = []
          files.set(name, new Uint8Array(0))
          return {
            write: (b) => {
              if (dir.failNextWrite) {
                dir.failNextWrite = false
                throw new DOMException('write exceeded storage quota', 'QuotaExceededError')
              }
              chunks.push(new Uint8Array(b))
            },
            close: () => {
              const total = chunks.reduce((n, c) => n + c.length, 0)
              const out = new Uint8Array(total)
              let o = 0
              for (const c of chunks) { out.set(c, o); o += c.length }
              files.set(name, out)
            },
            abort: () => {},
          }
        },
        remove() { files.delete(name) },
      }
    },
    removeEntry(name) {
      if (!files.has(name)) throw notFound()
      files.delete(name)
    },
    *entries() {
      for (const k of [...files.keys()]) yield [k, null]
    },
  }
  return dir
}

const dirs = new Map()
let opfsAvailable = true
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: {
    storage: {
      getDirectory: () => {
        if (!opfsAvailable) throw new DOMException('OPFS unavailable', 'SecurityError')
        return {
          getDirectoryHandle(name, { create = false } = {}) {
            if (!dirs.has(name)) {
              if (!create) throw notFound()
              dirs.set(name, createOpfsDir())
            }
            return dirs.get(name)
          },
        }
      },
    },
    // Minimal Web Locks shim: per-name FIFO chain. Enough to
    // serialise the module's request() calls; the tests never hold
    // two locks concurrently.
    locks: (() => {
      const chains = new Map()
      return {
        request(lockName, opts, cb) {
          const fn = cb ?? opts
          const prev = chains.get(lockName) ?? Promise.resolve()
          const next = prev.then(() => fn())
          chains.set(lockName, next.catch(() => {}))
          return next
        },
      }
    })(),
  },
})

const { deleteFile, listFiles, readFile, readFileBytes, saveFile, saveFileBytes } = await import('../client/storage.js')

const OPFS_DIR = 'deepview-reports'
const LS_REPORT_PREFIX = 'deepview.report:'
const reportsDir = async () => {
  await listFiles() // materialises the reports dir on first use
  return dirs.get(OPFS_DIR)
}

let nameCounter = 0
function uniqueName(stem) {
  nameCounter += 1
  return `${stem}-${nameCounter}.json`
}

const REPORT = '{"type":"analysis","findings":[{"id":"a","severity":"high","file":"x.js","line":1,"description":"real"}]}'
// The exact shape every not-found-tolerant consumer sniffs for
// (triage-gc, ingest's conflict path, workspace-export).
const NOT_FOUND_SHAPE = (err) => typeof err?.message === 'string' && err.message.startsWith('File not found:')
const isDomNotFound = (err) => err instanceof DOMException && err.name === 'NotFoundError'

describe('storage OPFS branch — corruption artifacts read as missing', () => {
  it('round-trips a normal report through the OPFS shim (sanity)', async () => {
    const name = uniqueName('sane')
    await saveFile(name, REPORT)
    assert.equal(await readFile(name), REPORT)
    assert.ok((await listFiles()).includes(name))
    const dir = await reportsDir()
    // Gzipped at rest.
    const onDisk = dir.files.get(name)
    assert.equal(onDisk[0], 0x1f)
    assert.equal(onDisk[1], 0x8b)
    await deleteFile(name)
  })

  it('zero-length entry: readFile throws not-found, quarantines, and never mints gzip(empty)', async () => {
    const name = uniqueName('truncated')
    const dir = await reportsDir()
    dir.files.set(name, new Uint8Array(0))
    await assert.rejects(readFile(name), NOT_FOUND_SHAPE)
    // Quarantined — the entry is gone, not laundered.
    assert.equal(dir.files.has(name), false)
    // The original bug wrote gzip('') back via a fire-and-forget
    // migration; give any stray write a beat to land, then re-check.
    await sleep(30)
    assert.equal(dir.files.has(name), false)
    assert.equal((await listFiles()).includes(name), false)
    // Re-reads see a genuinely missing file.
    await assert.rejects(readFile(name), isDomNotFound)
  })

  it('gzip-of-nothing artifact (the field corruption): readFile throws not-found and quarantines', async () => {
    const name = uniqueName('artifact')
    const artifact = await gzipBytes(new Uint8Array(0))
    // Pin the artifact's shape: gzip magic + all-zero ISIZE trailer.
    assert.equal(artifact[0], 0x1f)
    assert.equal(artifact[1], 0x8b)
    assert.deepEqual([...artifact.slice(-4)], [0, 0, 0, 0])
    const dir = await reportsDir()
    dir.files.set(name, artifact)
    await assert.rejects(readFile(name), NOT_FOUND_SHAPE)
    assert.equal(dir.files.has(name), false)
  })

  it('readFileBytes refuses the artifact too (no propagation into cloud uploads)', async () => {
    const name = uniqueName('artifact-bytes')
    const dir = await reportsDir()
    dir.files.set(name, await gzipBytes(new Uint8Array(0)))
    await assert.rejects(readFileBytes(name), NOT_FOUND_SHAPE)
    assert.equal(dir.files.has(name), false)
  })

  it('interrupted saveFile leaves the name absent, not a zero-length entry', async () => {
    const name = uniqueName('interrupted')
    await saveFile(name, REPORT)
    const dir = await reportsDir()
    dir.failNextWrite = true
    await assert.rejects(saveFile(name, REPORT + ' '), (err) => err.name === 'QuotaExceededError')
    // The overwrite truncated the entry; the catch cleanup must have
    // removed the zero-length leftover so the name reads as missing
    // (cloud-recoverable) instead of empty.
    assert.equal(dir.files.has(name), false)
    await assert.rejects(readFile(name), isDomNotFound)
  })

  it('saveFile refuses empty content and leaves existing bytes intact', async () => {
    const name = uniqueName('no-empty')
    await saveFile(name, REPORT)
    await assert.rejects(saveFile(name, ''), /Refusing to save empty report/u)
    assert.equal(await readFile(name), REPORT)
    await deleteFile(name)
  })

  it('saveFileBytes refuses zero-length and gzip-of-nothing payloads', async () => {
    const name = uniqueName('no-empty-bytes')
    await assert.rejects(saveFileBytes(name, new Uint8Array(0)), /Refusing to save empty report bytes/u)
    await assert.rejects(saveFileBytes(name, await gzipBytes(new Uint8Array(0))), /Refusing to save empty report bytes/u)
    const dir = await reportsDir()
    assert.equal(dir.files.has(name), false)
    // Non-empty payloads still land.
    await saveFileBytes(name, await gzipBytes(encodeUtf8(REPORT)))
    assert.equal(await readFile(name), REPORT)
    await deleteFile(name)
  })
})

describe('storage localStorage fallback — same artifact detection', () => {
  it('gzip-of-nothing artifact: readFile throws not-found and removes the key', async () => {
    opfsAvailable = false
    try {
      const name = uniqueName('ls-artifact')
      const artifact = await gzipBytes(new Uint8Array(0))
      localStorage.setItem(LS_REPORT_PREFIX + name, artifact.toBase64())
      await assert.rejects(readFile(name), NOT_FOUND_SHAPE)
      assert.equal(localStorage.getItem(LS_REPORT_PREFIX + name), null)
      await assert.rejects(readFile(name), NOT_FOUND_SHAPE)
    } finally {
      opfsAvailable = true
    }
  })

  it('saveFile refuses empty content on the fallback too', async () => {
    opfsAvailable = false
    try {
      const name = uniqueName('ls-no-empty')
      await assert.rejects(saveFile(name, ''), /Refusing to save empty report/u)
      assert.equal(localStorage.getItem(LS_REPORT_PREFIX + name), null)
    } finally {
      opfsAvailable = true
    }
  })
})
