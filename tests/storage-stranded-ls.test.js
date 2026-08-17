// `client/storage.js` — OPFS↔localStorage dual-backend behavior.
//
// `openOpfsDir` treats ANY `navigator.storage.getDirectory()` failure
// as "OPFS unavailable" and silently routes saves into the gzipped
// localStorage fallback. That condition can be transient, so entries
// can end up STRANDED in localStorage while OPFS is live again on the
// next load. These tests install a minimal in-memory OPFS mock on
// `navigator.storage` (Node 24 ships `navigator` + `navigator.locks`
// but no `navigator.storage`, which is what keeps the sibling
// `storage.test.js` pinned to the LS fallback) and pin the recovery
// semantics:
//
//   - listFiles unions both backends (stranded entries stay visible)
//   - readFile serves the LS copy on an OPFS miss and migrates it
//     back into OPFS (clearing the LS shadow)
//   - readFileBytes serves the LS copy on an OPFS miss
//   - saveFile / deleteFile clear the LS shadow so it can't diverge
//     or resurrect a deleted name
//
// The mock is installed once for the whole file BEFORE the module
// import — storage.js re-probes `navigator.storage` on every call, so
// per-test toggling isn't needed, and node:test runs each test file
// in its own process so the global patch can't leak into siblings.

/* eslint-disable require-await -- the OPFS mock mirrors the async
   browser API surface; its bodies are synchronous by design. */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { encodeUtf8 } from '../common/utf8.js'
import { gzipBytes } from '../common/gzip.js'

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

// Minimal OPFS mock: enough surface for storage.js's reports dir
// (getDirectoryHandle / getFileHandle / getFile / createWritable /
// removeEntry / entries). Directories and files are plain Maps.
function createOpfsMock() {
  const dirs = new Map() // dirName -> Map<fileName, Uint8Array>
  function makeDirHandle(files) {
    return {
      getFileHandle: async (name, { create = false } = {}) => {
        if (!files.has(name)) {
          if (!create) throw new DOMException(`file not found: ${name}`, 'NotFoundError')
          files.set(name, new Uint8Array())
        }
        return {
          getFile: async () => {
            const bytes = files.get(name)
            return {
              arrayBuffer: async () =>
                bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
            }
          },
          createWritable: async () => {
            const chunks = []
            return {
              write: async (b) => { chunks.push(new Uint8Array(b)) },
              close: async () => {
                const total = chunks.reduce((n, c) => n + c.length, 0)
                const out = new Uint8Array(total)
                let off = 0
                for (const c of chunks) { out.set(c, off); off += c.length }
                files.set(name, out)
              },
              abort: async () => {},
            }
          },
        }
      },
      removeEntry: async (name) => {
        if (!files.delete(name)) throw new DOMException(`not found: ${name}`, 'NotFoundError')
      },
      entries: async function* () {
        for (const [k, v] of files) yield [k, v]
      },
    }
  }
  return {
    dirs,
    storage: {
      getDirectory: async () => ({
        getDirectoryHandle: async (name, { create = false } = {}) => {
          if (!dirs.has(name)) {
            if (!create) throw new DOMException(`dir not found: ${name}`, 'NotFoundError')
            dirs.set(name, new Map())
          }
          return makeDirHandle(dirs.get(name))
        },
        removeEntry: async (name) => { dirs.delete(name) },
      }),
    },
  }
}

const opfs = createOpfsMock()
navigator.storage = opfs.storage

const { deleteFile, listFiles, readFile, readFileBytes, saveFile } = await import('../client/storage.js')

const LS_REPORT_PREFIX = 'deepview.report:'
const OPFS_DIR = 'deepview-reports'

function opfsFiles() {
  return opfs.dirs.get(OPFS_DIR) ?? new Map()
}

// Seed a stranded LS-fallback entry the exact way saveFile's LS
// branch writes them (gzip + base64), bypassing the module so the
// in-memory cache stays cold for the name.
async function seedStrandedLsEntry(name, content) {
  const gz = await gzipBytes(encodeUtf8(content))
  globalThis.localStorage.setItem(LS_REPORT_PREFIX + name, gz.toBase64())
}

// Poll until `predicate` holds (the stranded-entry migration in
// readFile is fire-and-forget, so tests wait for it to land).
async function waitFor(predicate, what, tries = 50) {
  for (let i = 0; i < tries; i++) {
    if (predicate()) return
    await new Promise((resolve) => { setTimeout(resolve, 10) })
  }
  assert.fail(`timed out waiting for: ${what}`)
}

let nameCounter = 0
function uniqueName(stem) {
  nameCounter += 1
  return `${stem}-${nameCounter}.json`
}

describe('storage — OPFS live: baseline round-trip through the mock', () => {
  it('saveFile lands in OPFS (not localStorage) and readFile round-trips', async () => {
    const name = uniqueName('opfs-basic')
    await saveFile(name, '{"via":"opfs"}')
    assert.equal(await readFile(name), '{"via":"opfs"}')
    assert.equal(opfsFiles().has(name), true, 'bytes are in the OPFS dir')
    assert.equal(globalThis.localStorage.getItem(LS_REPORT_PREFIX + name), null, 'no LS copy')
  })
})

describe('storage — listFiles unions OPFS and stranded LS entries', () => {
  it('shows stranded LS names alongside OPFS names, sorted, deduped', async () => {
    const opfsName = uniqueName('union-opfs')
    const strandedName = uniqueName('union-stranded')
    await saveFile(opfsName, 'x')
    await seedStrandedLsEntry(strandedName, 'y')
    // Duplicate name present in BOTH backends dedupes to one entry.
    await seedStrandedLsEntry(opfsName, 'stale-shadow')
    const names = await listFiles()
    assert.equal(names.includes(opfsName), true, 'OPFS entry listed')
    assert.equal(names.includes(strandedName), true, 'stranded LS entry listed')
    assert.equal(names.filter((n) => n === opfsName).length, 1, 'both-backend name deduped')
    assert.deepEqual(names, [...names].toSorted(), 'sorted')
    globalThis.localStorage.removeItem(LS_REPORT_PREFIX + opfsName)
    globalThis.localStorage.removeItem(LS_REPORT_PREFIX + strandedName)
  })
})

describe('storage — readFile falls back to a stranded LS entry and migrates it', () => {
  it('serves the LS content on an OPFS miss', async () => {
    const name = uniqueName('fallback-read')
    await seedStrandedLsEntry(name, '{"stranded":true}')
    assert.equal(await readFile(name), '{"stranded":true}')
  })

  it('migrates the entry into OPFS and clears the LS shadow', async () => {
    const name = uniqueName('fallback-migrate')
    await seedStrandedLsEntry(name, '{"migrate":"me"}')
    assert.equal(await readFile(name), '{"migrate":"me"}')
    await waitFor(
      () => opfsFiles().has(name) && globalThis.localStorage.getItem(LS_REPORT_PREFIX + name) === null,
      'stranded entry migrated to OPFS + LS shadow cleared',
    )
    // Post-migration read comes from OPFS.
    assert.equal(await readFile(name), '{"migrate":"me"}')
  })

  it('still rejects when the name is in neither backend', async () => {
    await assert.rejects(
      () => readFile(uniqueName('nowhere')),
      (err) => err instanceof DOMException && err.name === 'NotFoundError',
    )
  })
})

describe('storage — readFileBytes falls back to a stranded LS entry', () => {
  it('serves the raw stored bytes on an OPFS miss', async () => {
    const name = uniqueName('bytes-fallback')
    await seedStrandedLsEntry(name, '{"bytes":1}')
    const bytes = await readFileBytes(name)
    // LS entries are stored gzipped; readFileBytes returns the
    // logical (gzipped) representation, gzip magic first.
    assert.equal(bytes[0], 0x1f)
    assert.equal(bytes[1], 0x8b)
  })

  it('still rejects when the name is in neither backend', async () => {
    await assert.rejects(
      () => readFileBytes(uniqueName('bytes-nowhere')),
      (err) => err instanceof DOMException && err.name === 'NotFoundError',
    )
  })
})

describe('storage — a corrupt (empty) stranded LS entry is quarantined, not served', () => {
  // Integration with the #195 empty-entry quarantine: the stranded-LS
  // fallback must not become a side door that serves (or migrates) a
  // gzip-of-nothing launder artifact, and quarantine must clear the
  // LS copy even while the OPFS dir is live — otherwise the union'd
  // listFiles keeps a ghost row alive.
  it('readFile throws the standard not-found shape and removes the LS copy', async () => {
    const name = uniqueName('stranded-corrupt')
    const gz = await gzipBytes(new Uint8Array(0)) // gzip('') artifact
    globalThis.localStorage.setItem(LS_REPORT_PREFIX + name, gz.toBase64())
    await assert.rejects(() => readFile(name), /File not found/u)
    assert.equal(globalThis.localStorage.getItem(LS_REPORT_PREFIX + name), null, 'LS copy quarantined')
    assert.equal(opfsFiles().has(name), false, 'nothing migrated into OPFS')
    assert.equal((await listFiles()).includes(name), false, 'no ghost row')
  })
})

describe('storage — saveFile clears a stale LS shadow on OPFS commit', () => {
  it('an overwrite drops the stranded copy so it cannot diverge', async () => {
    const name = uniqueName('shadow-clear')
    await seedStrandedLsEntry(name, 'old-shadow')
    await saveFile(name, 'new-content')
    assert.equal(globalThis.localStorage.getItem(LS_REPORT_PREFIX + name), null, 'shadow gone')
    assert.equal(await readFile(name), 'new-content')
  })
})

describe('storage — deleteFile removes both backends', () => {
  it('a stranded LS copy cannot resurrect a deleted name', async () => {
    const name = uniqueName('delete-both')
    await saveFile(name, 'doomed')
    await seedStrandedLsEntry(name, 'doomed-shadow')
    await deleteFile(name)
    assert.equal(globalThis.localStorage.getItem(LS_REPORT_PREFIX + name), null, 'LS copy gone')
    assert.equal(opfsFiles().has(name), false, 'OPFS copy gone')
    assert.equal((await listFiles()).includes(name), false, 'not listed')
  })

  it('deletes a name that exists ONLY as a stranded LS entry', async () => {
    const name = uniqueName('delete-stranded-only')
    await seedStrandedLsEntry(name, 'only-in-ls')
    assert.equal((await listFiles()).includes(name), true, 'listed pre-delete')
    await deleteFile(name)
    assert.equal(globalThis.localStorage.getItem(LS_REPORT_PREFIX + name), null, 'LS copy gone')
    assert.equal((await listFiles()).includes(name), false, 'not listed post-delete')
  })
})
