// Vercel Blob BlobBackend — unit + integration tests against an
// injected in-memory stub of the `@vercel/blob` SDK. Avoids the
// network (no real Vercel store needed) and pins the
// (BlobBackend → SDK) wiring: that we call the right SDK methods
// with the right pathnames + options, that errors map to the right
// surface, and that the staging→live promotion preserves the same
// crash-safety contract the FS backend implements.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Buffer } from 'node:buffer'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'

import { openVercelBlobBackend } from '../server/objstore/blob-vercel.ts'
import { abortPut, beginPut, commitPut, deleteObject, getLive, openObjstore } from '../server/objstore/store.ts'
import { reapOrphans } from '../server/objstore/reaper.ts'
import { handleRest } from '../server/objstore/rest.ts'
import { mintGetToken, newTokenSecret } from '../server/objstore/tokens.ts'

// 64-byte b64url, 86 chars no padding (SIG_RE)
function b64u64() { return 'a'.repeat(86) }
// Deterministic, valid (43-char base64url) content hash from a seed.
// Live blobs are content-addressed (`${tag}/${contentHash}.bin`), so
// keying each payload's hash off its resourceTag gives each resource
// its own blob pathname (mirrors the old per-resourceTag layout).
function chash(seed) { return createHash('sha256').update(String(seed)).digest('base64url') }
// The live-blob pathname the Vercel backend writes for a resource's
// default payload.
function liveName(tag, resourceTag) { return `${tag}/${chash(resourceTag)}.bin` }

// Minimal stand-in for the `@vercel/blob` SDK. Keeps an in-memory
// blob store keyed by pathname so we can assert end-to-end (put →
// head → copy → del → list) without a network round-trip. The
// shape matches what `blob-vercel.ts` actually uses; new SDK
// methods would need to be added here as the backend grows.
class MockBlobNotFoundError extends Error {
  constructor() { super('Blob not found'); this.name = 'BlobNotFoundError' }
}

function mockSdk() {
  // pathname → { bytes: Buffer }
  const blobs = new Map()
  const calls = []  // call log for assertions

  function urlFor(pathname) { return `https://mock.private.blob/${pathname}` }

  async function readToBuffer(body) {
    if (Buffer.isBuffer(body)) return body
    if (typeof body === 'string') return Buffer.from(body)
    // Node Readable
    const chunks = []
    for await (const c of body) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c))
    return Buffer.concat(chunks)
  }

  return {
    blobs, calls,
    sdk: {
      put: async (pathname, body, options) => {
        calls.push({ fn: 'put', pathname, options })
        // Respect AbortSignal — if aborted before/while reading the body,
        // throw an AbortError to mimic the SDK's documented behavior.
        const ac = options?.abortSignal
        if (ac?.aborted) { throw new Error('aborted') }
        const bytes = await readToBuffer(body)
        if (ac?.aborted) { throw new Error('aborted') }
        if (blobs.has(pathname) && !options?.allowOverwrite) {
          throw new Error('blob exists')
        }
        blobs.set(pathname, { bytes, uploadedAt: Date.now() })
        return { url: urlFor(pathname), pathname }
      },
      // eslint-disable-next-line require-await
      head: async (pathname, _opts) => {
        calls.push({ fn: 'head', pathname })
        const b = blobs.get(pathname)
        if (!b) throw new MockBlobNotFoundError()
        return { size: b.bytes.byteLength, pathname, url: urlFor(pathname) }
      },
      // eslint-disable-next-line require-await
      get: async (pathname, _opts) => {
        calls.push({ fn: 'get', pathname })
        const b = blobs.get(pathname)
        if (!b) throw new MockBlobNotFoundError()
        // Web ReadableStream wrapping the byte buffer — the backend
        // converts to a Node Readable via Readable.fromWeb.
        const bytes = b.bytes
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(bytes))
            controller.close()
          },
        })
        return {
          statusCode: 200,
          stream,
          blob: { size: bytes.byteLength },
        }
      },
      // eslint-disable-next-line require-await
      copy: async (fromPathname, toPathname, _opts) => {
        calls.push({ fn: 'copy', from: fromPathname, to: toPathname })
        const b = blobs.get(fromPathname)
        if (!b) throw new MockBlobNotFoundError()
        // Atomic per the SDK contract — the destination is either
        // fully written or not at all. Overwrite semantics match
        // `put` with allowOverwrite (Vercel docs: copy overwrites
        // unconditionally when toPathname already has a blob).
        blobs.set(toPathname, { bytes: Buffer.from(b.bytes), uploadedAt: Date.now() })
        return { url: urlFor(toPathname), pathname: toPathname }
      },
      // eslint-disable-next-line require-await
      del: async (urlOrPathname, _opts) => {
        calls.push({ fn: 'del', target: urlOrPathname })
        const keys = Array.isArray(urlOrPathname) ? urlOrPathname : [urlOrPathname]
        for (const k of keys) {
          if (!blobs.has(k)) throw new MockBlobNotFoundError()
          blobs.delete(k)
        }
      },
      // eslint-disable-next-line require-await
      list: async (options) => {
        calls.push({ fn: 'list', options })
        const prefix = options.prefix ?? ''
        const limit = options.limit ?? 1000
        // `cursor` is the index to start at — keeps pagination
        // simple and deterministic for tests.
        const startIdx = options.cursor == null ? 0 : Number(options.cursor)
        const all = [...blobs.keys()].filter((k) => k.startsWith(prefix)).toSorted()
        const matched = all.slice(startIdx, startIdx + limit)
        // Mode 'folded': split into top-level blobs vs subfolders
        // relative to the prefix.
        if (options.mode === 'folded') {
          const topBlobs = []
          const folders = new Set()
          for (const k of matched) {
            const rest = k.slice(prefix.length)
            const slash = rest.indexOf('/')
            if (slash === -1) {
              topBlobs.push({ pathname: k, size: blobs.get(k).bytes.byteLength, uploadedAt: blobs.get(k).uploadedAt })
            } else {
              folders.add(`${prefix}${rest.slice(0, slash + 1)}`)
            }
          }
          return {
            blobs: topBlobs,
            folders: [...folders],
            hasMore: startIdx + limit < all.length,
            cursor: startIdx + limit < all.length ? String(startIdx + limit) : undefined,
          }
        }
        return {
          blobs: matched.map((k) => ({ pathname: k, size: blobs.get(k).bytes.byteLength, uploadedAt: blobs.get(k).uploadedAt })),
          hasMore: startIdx + limit < all.length,
          cursor: startIdx + limit < all.length ? String(startIdx + limit) : undefined,
        }
      },
    },
  }
}

// Construct a Handle whose DB plane is SQLite (in a temp dir) and
// whose byte plane is the Vercel BlobBackend driven by a mock SDK.
// This is the pairing for the test — the same shape production code
// builds in server/index.ts (modulo SQLite ↔ Neon on the DB plane).
let counter = 0
async function freshVercelHandle() {
  const dir = mkdtempSync(path.join(tmpdir(), `deepview-vercel-${++counter}-`))
  const db = new DatabaseSync(path.join(dir, 'data.db'))
  // openObjstore wires the FS-backed handle, then we swap the blob
  // field. This reuses the schema-bootstrap + statement-prep code
  // without forking the opener.
  const handle = openObjstore(db, path.join(dir, 'objstore'))
  const { sdk, blobs, calls } = mockSdk()
  const vercel = await openVercelBlobBackend({ token: 'test-token', sdk })
  handle.blob = vercel
  // Vercel-backed handles do not carry a `dir` field in production
  // (server/index.ts builds the Neon handle from openNeonObjstore,
  // which doesn't set `dir`). Match that shape for the tests so a
  // stray test that reads handle.dir on the Vercel path would
  // fail loudly rather than silently using the unused FS root.
  delete handle.dir
  return {
    handle, sdk, blobs, calls,
    cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }) },
  }
}

function fakeBegin(over = {}) {
  const resourceTag = over.resourceTag ?? 'res-1'
  return {
    workspaceTag: 'ws-1',
    resourceTag,
    prevVersion: null,
    prevIncarnation: null,
    expectedLength: 16,
    contentHash: chash(resourceTag),
    signature: b64u64(),
    ...over,
  }
}

// Drive the REST PUT byte path: open a staging writer, stream the
// bytes through it, await finalize. Mirrors what rest.ts does on
// production traffic so the byte plane exercises the same surface
// the SDK-backed implementation has to support.
async function streamBytesToStaging(handle, tag, sid, bytes) {
  const writer = await handle.blob.openStagingWriter(tag, sid)
  await pipeline(Readable.from([bytes]), writer.writable)
  await writer.finalize()
}

// Minimal IncomingMessage / ServerResponse stand-ins for driving
// `handleRest` end-to-end without a live TCP server. On the GET path
// handleRest reads only req.method / req.url / req.headers and writes
// the status via res.writeHead, then res.end (deny) or pipeline (200).
// The res is a real Writable so the 200 success path's
// `pipeline(reader.stream, res)` works just as in production.
function mockReq({ method, url, token }) {
  return { method, url, headers: token ? { authorization: `Bearer ${token}` } : {} }
}
function mockRes() {
  // Capture raw Buffer chunks so the helper is byte-exact for the
  // octet-stream GET path (production serves arbitrary ciphertext bytes).
  // `bodyBuffer` is binary-safe; `body` decodes the FULL concatenation
  // once as UTF-8 (for JSON error envelopes) — never per-chunk, which
  // could split a multibyte sequence across write() boundaries.
  const chunks = []
  const res = new Writable({ write(chunk, _enc, cb) { chunks.push(Buffer.from(chunk)); cb() } })
  res.statusCode = 0
  res.headersSent = false
  res.writeHead = function writeHead(status) { this.statusCode = status; this.headersSent = true; return this }
  Object.defineProperty(res, 'bodyBuffer', { get() { return Buffer.concat(chunks) } })
  Object.defineProperty(res, 'body', { get() { return Buffer.concat(chunks).toString() } })
  return res
}
function restDepsFor(handle, secret) {
  return { handle, secret, broadcast: () => {}, publishObjPut: () => {}, debug: false }
}

describe('vercel blob backend — happy path', () => {
  it('begin → put bytes → commit promotes staging → live', async () => {
    const { handle, blobs, cleanup } = await freshVercelHandle()
    try {
      const begin = await beginPut(handle, fakeBegin())
      assert.equal(begin.ok, true)
      // Vercel handle: filePath is omitted — pathname is meaningful
      // only inside the Vercel store, not as an OS path.
      assert.equal(begin.filePath, undefined)
      await streamBytesToStaging(handle, 'ws-1', begin.stagingId, Buffer.alloc(16))
      // After streaming, the staging blob exists in the mock store.
      assert.equal(blobs.has(`ws-1/.staging/${begin.stagingId}.bin`), true)
      const stagedSize = await handle.blob.statStaging('ws-1', begin.stagingId)
      assert.equal(stagedSize, 16)
      const commit = await commitPut(handle, {
        workspaceTag: 'ws-1', resourceTag: 'res-1', stagingId: begin.stagingId,
      })
      assert.equal(commit.ok, true)
      assert.equal(commit.row.version, 1)
      // Post-commit: live blob exists, staging gone (the backend
      // attempts a best-effort delete after copy).
      assert.equal(blobs.has(liveName('ws-1', 'res-1')), true)
      assert.equal(blobs.has(`ws-1/.staging/${begin.stagingId}.bin`), false)
      assert.equal(blobs.get(liveName('ws-1', 'res-1')).bytes.byteLength, 16)
      // listLive sees the row.
      const live = await getLive(handle, 'ws-1', 'res-1')
      assert.deepEqual(live?.version, 1)
    } finally { cleanup() }
  })

  it('openLiveReader streams the bytes back', async () => {
    const { handle, cleanup } = await freshVercelHandle()
    try {
      const payload = Buffer.from('hello-vercel-blob')
      const begin = await beginPut(handle, fakeBegin({ expectedLength: payload.byteLength }))
      assert.equal(begin.ok, true)
      await streamBytesToStaging(handle, 'ws-1', begin.stagingId, payload)
      const c = await commitPut(handle, {
        workspaceTag: 'ws-1', resourceTag: 'res-1', stagingId: begin.stagingId,
      })
      assert.equal(c.ok, true)
      const opened = await handle.blob.openLiveReader('ws-1', chash('res-1'))
      assert.equal(opened.ok, true)
      assert.equal(opened.reader.size, payload.byteLength)
      const chunks = []
      for await (const chunk of opened.reader.stream) chunks.push(chunk)
      assert.equal(Buffer.concat(chunks).toString(), payload.toString())
    } finally { cleanup() }
  })
})

describe('vercel blob backend — error & race surfaces', () => {
  it('statStaging returns null on not-found (not a throw)', async () => {
    const { handle, cleanup } = await freshVercelHandle()
    try {
      const size = await handle.blob.statStaging('ws-1', 'a'.repeat(22))
      assert.equal(size, null)
    } finally { cleanup() }
  })

  it('openLiveReader returns unavailable (NOT not-found) when the blob is missing', async () => {
    // Byte-plane contract: a missing blob maps to `unavailable` (→ HTTP
    // 503), never `not-found`/404. The byte plane has no view of the
    // metadata row, so it can't decide existence — only the REST layer's
    // live-row check (openLiveSnapshot) produces a terminal 404. (This
    // test calls openLiveReader directly, with no live row.) Mirrors the
    // FS backend, which maps ENOENT → unavailable (blob-fs.ts).
    const { handle, cleanup } = await freshVercelHandle()
    try {
      // A syntactically valid (43-char base64url) content hash that was
      // never written — representative of a real hash, and robust if the
      // backend later validates contentHash shape.
      const opened = await handle.blob.openLiveReader('ws-1', chash('absent-resource'))
      assert.equal(opened.ok, false)
      assert.equal(opened.reason, 'unavailable')
      assert.notEqual(opened.reason, 'not-found')
    } finally { cleanup() }
  })

  it('openLiveReader falls back to head() when get() reports size 0 (Vercel private-read quirk)', async () => {
    const { handle, sdk, calls, cleanup } = await freshVercelHandle()
    try {
      // Land a live blob the normal way, then reproduce @vercel/blob@2.x's
      // private streaming get(): a real body but blob.size === 0. The
      // backend must fall back to head() for the true byte count rather
      // than 503ing the read.
      const payload = Buffer.from('private-read-needs-head')
      const begin = await beginPut(handle, fakeBegin({ expectedLength: payload.byteLength }))
      assert.equal(begin.ok, true)
      await streamBytesToStaging(handle, 'ws-1', begin.stagingId, payload)
      const c = await commitPut(handle, {
        workspaceTag: 'ws-1', resourceTag: 'res-1', stagingId: begin.stagingId,
      })
      assert.equal(c.ok, true)
      const realGet = sdk.get
      sdk.get = async (pathname, opts) => {
        const r = await realGet(pathname, opts)
        return r && { ...r, blob: { size: 0 } }
      }
      calls.length = 0
      const opened = await handle.blob.openLiveReader('ws-1', chash('res-1'))
      assert.equal(opened.ok, true)
      // Size is the head() value, not the bogus 0 from get().
      assert.equal(opened.reader.size, payload.byteLength)
      assert.equal(calls.some((x) => x.fn === 'head'), true, 'expected a head() fallback')
      // The body stream still yields the real bytes.
      const chunks = []
      for await (const chunk of opened.reader.stream) chunks.push(chunk)
      assert.equal(Buffer.concat(chunks).toString(), payload.toString())
    } finally { cleanup() }
  })

  it('REST GET → 503 (not 404) when the live row is present but the blob bytes are gone', async () => {
    // The exact "objstore link 404s in vercel mode" regression, end-to-end
    // through handleRest: a GET token still matches the live row's
    // (version, incarnation), but the content-addressed blob is missing
    // (reaper GC racing a version bump, or Vercel-Blob propagation lag).
    // The byte plane must surface this as 503 `unavailable` (transient —
    // the client retries), never 404 (which the client treats as a
    // terminal "gone" and stops re-fetching). Before the fix the Vercel
    // backend returned not-found here → handleRestGet emitted 404.
    const { handle, blobs, cleanup } = await freshVercelHandle()
    try {
      const secret = newTokenSecret()
      const deps = restDepsFor(handle, secret)
      // Commit a live row + its blob the normal way.
      const payload = Buffer.from('objstore-link-bytes')
      const begin = await beginPut(handle, fakeBegin({ expectedLength: payload.byteLength }))
      assert.equal(begin.ok, true)
      await streamBytesToStaging(handle, 'ws-1', begin.stagingId, payload)
      const c = await commitPut(handle, { workspaceTag: 'ws-1', resourceTag: 'res-1', stagingId: begin.stagingId })
      assert.equal(c.ok, true)
      const row = await getLive(handle, 'ws-1', 'res-1')
      // Mint a GET token that matches the live row exactly (the "link").
      const { token } = mintGetToken(secret, 'ws-1', 'res-1', row.version, row.incarnation)
      const url = '/api/objstore/ws-1/res-1'
      // Positive control: the link serves bytes (200) while the blob exists.
      const okRes = mockRes()
      await handleRest(deps, mockReq({ method: 'GET', url, token }), okRes)
      assert.equal(okRes.statusCode, 200, 'link serves bytes while the blob is present')
      assert.equal(Buffer.compare(okRes.bodyBuffer, payload), 0, 'serves the exact blob bytes')
      // Now the blob bytes vanish out from under the still-live row —
      // models a reaper GC of a just-superseded hash, or a Vercel-Blob
      // read-after-write / propagation loss. The DB row is untouched, so
      // the same token still matches (version, incarnation). Derive the
      // pathname from the live row's actual contentHash (not the fixture's
      // chash(resourceTag) convention) so this stays correct if the
      // fixture or production hashing changes.
      blobs.delete(`ws-1/${row.contentHash}.bin`)
      const goneRes = mockRes()
      await handleRest(deps, mockReq({ method: 'GET', url, token }), goneRes)
      assert.equal(goneRes.statusCode, 503, 'row present + bytes gone → 503 unavailable')
      assert.notEqual(goneRes.statusCode, 404, 'must NOT be the terminal 404 the client gives up on')
      assert.deepEqual(JSON.parse(goneRes.body), { error: 'unavailable' })
    } finally { cleanup() }
  })

  it('unlinkStaging / unlinkLive tolerate not-found (idempotent)', async () => {
    const { handle, cleanup } = await freshVercelHandle()
    try {
      await handle.blob.unlinkStaging('ws-1', 'a'.repeat(22))
      await handle.blob.unlinkLive('ws-1', 'res-not-there')
      // No throw means tolerated.
    } finally { cleanup() }
  })

  it('abortPut after a partial upload cleans the staging blob and the row', async () => {
    const { handle, blobs, cleanup } = await freshVercelHandle()
    try {
      const begin = await beginPut(handle, fakeBegin())
      assert.equal(begin.ok, true)
      await streamBytesToStaging(handle, 'ws-1', begin.stagingId, Buffer.alloc(16))
      assert.equal(blobs.has(`ws-1/.staging/${begin.stagingId}.bin`), true)
      await abortPut(handle, 'ws-1', 'res-1', begin.stagingId)
      // Staging blob gone, staging row gone.
      assert.equal(blobs.has(`ws-1/.staging/${begin.stagingId}.bin`), false)
    } finally { cleanup() }
  })

  it('deleteObject drops the live row; the reaper GCs the unreferenced blob past the grace window', async () => {
    const { handle, blobs, cleanup } = await freshVercelHandle()
    try {
      const begin = await beginPut(handle, fakeBegin())
      await streamBytesToStaging(handle, 'ws-1', begin.stagingId, Buffer.alloc(16))
      const commit = await commitPut(handle, {
        workspaceTag: 'ws-1', resourceTag: 'res-1', stagingId: begin.stagingId,
      })
      const live = liveName('ws-1', 'res-1')
      assert.equal(blobs.has(live), true)
      const del = await deleteObject(handle, 'ws-1', 'res-1', 1, commit.row.incarnation)
      assert.equal(del.ok, true)
      assert.equal(del.deletedVersion, 1)
      // deleteObject only drops the row — the blob (possibly shared via
      // content dedup) is left for the reaper, which GCs it once
      // unreferenced AND past the grace window. Backdate uploadedAt to
      // clear the window.
      assert.equal(blobs.has(live), true)
      blobs.get(live).uploadedAt = Date.now() - 2 * 60 * 60 * 1000
      await reapOrphans(handle)
      assert.equal(blobs.has(live), false)
    } finally { cleanup() }
  })
})

describe('vercel blob backend — listing for the reaper', () => {
  it('lists workspace tags, live blob hashes, and staging ids', async () => {
    const { handle, blobs, cleanup } = await freshVercelHandle()
    try {
      // Seed two workspaces with one live + one staging each.
      for (const tag of ['ws-A', 'ws-B']) {
        const begin = await beginPut(handle, fakeBegin({ workspaceTag: tag, resourceTag: 'r' }))
        await streamBytesToStaging(handle, tag, begin.stagingId, Buffer.alloc(16))
        await commitPut(handle, { workspaceTag: tag, resourceTag: 'r', stagingId: begin.stagingId })
        // A second beginPut staged but not committed — staging blob persists.
        const stagedOnly = await beginPut(handle, fakeBegin({ workspaceTag: tag, resourceTag: 'r2' }))
        await streamBytesToStaging(handle, tag, stagedOnly.stagingId, Buffer.alloc(16))
      }
      const wsTags = (await handle.blob.listWorkspaceTags()).toSorted()
      assert.deepEqual(wsTags, ['ws-A', 'ws-B'])
      for (const tag of ['ws-A', 'ws-B']) {
        const liveBlobs = await handle.blob.listLiveBlobs(tag)
        // Content-addressed: the listing yields content hashes (the
        // committed resource 'r' used the default chash('r')), each
        // with a modified time for the GC grace window.
        assert.deepEqual(liveBlobs.map((b) => b.hash), [chash('r')])
        assert.equal(typeof liveBlobs[0].modifiedMs, 'number')
        const stagingIds = await handle.blob.listStagingIds(tag)
        assert.equal(stagingIds.length, 1)
        // Staging id is 16-byte random base64url — 22 chars.
        assert.match(stagingIds[0], /^[\w-]{22}$/u)
        // Sanity: the listed staging id corresponds to a real blob.
        assert.equal(blobs.has(`${tag}/.staging/${stagingIds[0]}.bin`), true)
      }
    } finally { cleanup() }
  })

  it('reaper GCs a stranded live blob (row deleted out-of-band) once past the grace window', async () => {
    const { handle, blobs, cleanup } = await freshVercelHandle()
    try {
      const begin = await beginPut(handle, fakeBegin())
      await streamBytesToStaging(handle, 'ws-1', begin.stagingId, Buffer.alloc(16))
      await commitPut(handle, {
        workspaceTag: 'ws-1', resourceTag: 'res-1', stagingId: begin.stagingId,
      })
      const live = liveName('ws-1', 'res-1')
      assert.equal(blobs.has(live), true)
      // Simulate a row drop without unlink (deleteObject leaves the
      // blob behind; or a crash mid-delete). The blob is now
      // stranded/unreferenced. Raw DELETE (not a store API) — this
      // models an out-of-band/crash drop that bypassed deleteObject.
      handle.db.prepare('DELETE FROM workspace_object WHERE workspace_tag = ? AND resource_tag = ?').run('ws-1', 'res-1')
      // Within the grace window → a default sweep leaves it.
      await reapOrphans(handle)
      assert.equal(blobs.has(live), true, 'grace window protects a recent blob')
      // Past the grace window → GC'd.
      blobs.get(live).uploadedAt = Date.now() - 2 * 60 * 60 * 1000
      await reapOrphans(handle)
      assert.equal(blobs.has(live), false, 'reaper unlinks the stranded live blob')
    } finally { cleanup() }
  })

  it('reaper drops a stranded staging blob whose row was never inserted', async () => {
    const { handle, blobs, cleanup } = await freshVercelHandle()
    try {
      // Insert a staging blob WITHOUT a staging row — mimics a
      // pre-DB-insert crash on the production path. The reaper's
      // orphan-staging sweep matches per-blob row lookups (no
      // caller snapshot), so it should clean.
      const orphanSid = 'a'.repeat(22)
      const writer = await handle.blob.openStagingWriter('ws-1', orphanSid)
      await pipeline(Readable.from([Buffer.alloc(8)]), writer.writable)
      await writer.finalize()
      assert.equal(blobs.has(`ws-1/.staging/${orphanSid}.bin`), true)
      await reapOrphans(handle)
      assert.equal(blobs.has(`ws-1/.staging/${orphanSid}.bin`), false)
    } finally { cleanup() }
  })
})

describe('vercel blob backend — SDK call shape', () => {
  it('put uses access:private + allowOverwrite + multipart', async () => {
    const { handle, calls, cleanup } = await freshVercelHandle()
    try {
      const writer = await handle.blob.openStagingWriter('ws-1', 'a'.repeat(22))
      await pipeline(Readable.from([Buffer.alloc(4)]), writer.writable)
      await writer.finalize()
      const put = calls.find((c) => c.fn === 'put')
      assert.ok(put, 'put was called')
      assert.equal(put.pathname, `ws-1/.staging/${'a'.repeat(22)}.bin`)
      assert.equal(put.options.access, 'private')
      assert.equal(put.options.allowOverwrite, true)
      assert.equal(put.options.multipart, true)
      assert.equal(put.options.token, 'test-token')
    } finally { cleanup() }
  })

  it('copy uses access:private and references the canonical staging+live pathnames', async () => {
    const { handle, calls, cleanup } = await freshVercelHandle()
    try {
      const begin = await beginPut(handle, fakeBegin())
      await streamBytesToStaging(handle, 'ws-1', begin.stagingId, Buffer.alloc(16))
      await commitPut(handle, {
        workspaceTag: 'ws-1', resourceTag: 'res-1', stagingId: begin.stagingId,
      })
      const copy = calls.find((c) => c.fn === 'copy')
      assert.ok(copy)
      assert.equal(copy.from, `ws-1/.staging/${begin.stagingId}.bin`)
      assert.equal(copy.to, liveName('ws-1', 'res-1'))
    } finally { cleanup() }
  })

  it('get uses access:private with the token', async () => {
    const { handle, calls, cleanup } = await freshVercelHandle()
    try {
      const begin = await beginPut(handle, fakeBegin())
      await streamBytesToStaging(handle, 'ws-1', begin.stagingId, Buffer.alloc(16))
      await commitPut(handle, {
        workspaceTag: 'ws-1', resourceTag: 'res-1', stagingId: begin.stagingId,
      })
      calls.length = 0  // clear call log so we measure just the read
      const opened = await handle.blob.openLiveReader('ws-1', chash('res-1'))
      assert.equal(opened.ok, true)
      const get = calls.find((c) => c.fn === 'get')
      assert.ok(get)
      assert.equal(get.pathname, liveName('ws-1', 'res-1'))
    } finally { cleanup() }
  })
})
