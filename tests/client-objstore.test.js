// End-to-end tests for the client/objstore.ts session module
// against a spawned `server/index.ts` relay. Mirrors the wire-level
// coverage of `tests/sync-server-objstore.test.js` but exercises the
// client API (`session.put` / `.fetch` / `.delete` / `.list` /
// `.onPut` / `.onDeleted`) rather than hand-rolled WS frames.

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Buffer } from 'node:buffer'

import { createObjstoreSession } from '../client/objstore.ts'

function b64url(bytes) { return Buffer.from(bytes).toString('base64url') }

// Boot a spawned `server/index.ts` and resolve the OS-assigned port.
// Same shape as the helper in tests/sync-server.test.js — buffer
// stdout across chunks, reject on early child-exit, remove listeners
// on resolve/reject.
function awaitListeningPort(proc, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    let buf = ''
    let stderrBuf = ''
    let settled = false
    function onData(d) {
      buf += String(d)
      const m = /ws:\/\/[^:]+:(\d+)\//u.exec(buf)
      if (m) finish(null, Number(m[1]))
    }
    function onErrData(d) { stderrBuf += String(d) }
    function onExit(code, signal) {
      const detail = stderrBuf.slice(0, 400).trim() || `exit ${code}, signal ${signal}`
      finish(new Error(`server exited during boot: ${detail}`))
    }
    function onError(err) { finish(err) }
    function finish(err, port) {
      if (settled) return
      settled = true
      clearTimeout(t)
      proc.stdout.removeListener('data', onData)
      proc.stderr.removeListener('data', onErrData)
      proc.removeListener('exit', onExit)
      proc.removeListener('error', onError)
      if (err) reject(err); else resolve(port)
    }
    const t = setTimeout(() => finish(new Error('server boot timeout')), timeoutMs)
    proc.stdout.on('data', onData)
    proc.stderr.on('data', onErrData)
    proc.once('exit', onExit)
    proc.once('error', onError)
  })
}

async function makeKp() {
  // `extractable: true` on the public key is required to base64url
  // the raw bytes for `workspaceTag`. Private key stays sign-only.
  const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])
  const jwk = await crypto.subtle.exportKey('jwk', kp.publicKey)
  return { privateKey: kp.privateKey, workspaceTag: b64url(Buffer.from(jwk.x, 'base64url')) }
}

// Subscribe to a broadcast event with a timeout. Any test that
// awaits a broadcast without this wrapper will hang indefinitely
// if the expected frame never arrives — turning a real bug into
// a stalled test run. Returns a Promise that resolves with the
// matched event, or rejects with a descriptive error after
// `timeoutMs`. The `subscribe` callback registers the underlying
// handler (e.g. `b.onPut(handler)` / `b.onDeleted(handler)`);
// the handler should call the supplied `resolve(eventValue)` when
// the event of interest arrives.
function awaitEvent(label, subscribe, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`awaitEvent timeout: ${label} did not fire within ${timeoutMs}ms`)), timeoutMs)
    subscribe((value) => { clearTimeout(t); resolve(value) })
  })
}

describe('client/objstore session', () => {
  let httpOrigin, serverDir, serverProc, serverUrl

  before(async () => {
    serverDir = mkdtempSync(path.join(tmpdir(), 'deepview-client-objstore-'))
    serverProc = spawn(process.execPath, ['server/index.ts'], {
      env: {
        ...process.env, PORT: '0', HOST: '127.0.0.1',
        DB_PATH: path.join(serverDir, 'data.db'),
        OBJSTORE_DIR: path.join(serverDir, 'objstore'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const port = await awaitListeningPort(serverProc)
    serverUrl = `ws://127.0.0.1:${port}/api/sync`
    httpOrigin = `http://127.0.0.1:${port}`
  })

  after(async () => {
    if (!serverProc) return
    serverProc.kill('SIGTERM')
    await new Promise((resolve) => { serverProc.once('exit', resolve) })
    rmSync(serverDir, { recursive: true, force: true })
  })

  it('put → list → fetch → delete round-trip', async () => {
    const { privateKey, workspaceTag } = await makeKp()
    const session = await createObjstoreSession({ serverUrl, httpOrigin, workspaceTag, privateKey })
    try {
      // Pre-state: list is empty.
      assert.deepEqual(await session.list(), [])
      // PUT a small payload. `prevVersion: null` is the "must not
      // exist" precondition.
      const bytes = Buffer.from('hello-objstore-client', 'utf8')
      const put = await session.put({
        resourceTag: 'r-greeting',
        bytes,
        prevVersion: null,
      })
      assert.equal(put.ok, true)
      assert.equal(put.meta.version, 1)
      assert.equal(put.meta.contentLength, bytes.byteLength)
      // LIST reflects the new resource.
      const live = await session.list()
      assert.equal(live.length, 1)
      assert.equal(live[0].resourceTag, 'r-greeting')
      assert.equal(live[0].version, 1)
      assert.equal(live[0].contentHash, put.meta.contentHash)
      // FETCH returns byte-equal payload + verifies the contentHash.
      const got = await session.fetch('r-greeting')
      assert.ok(got, 'fetch should not return null')
      assert.equal(Buffer.compare(Buffer.from(got.bytes), bytes), 0, 'fetched bytes match what was put')
      assert.equal(got.meta.version, 1)
      // DELETE with the correct prevVersion succeeds.
      const del = await session.delete('r-greeting', 1)
      assert.equal(del.ok, true)
      assert.equal(del.deletedVersion, 1)
      // FETCH after delete returns null.
      assert.equal(await session.fetch('r-greeting'), null)
      // LIST is empty again.
      assert.deepEqual(await session.list(), [])
    } finally { session.close() }
  })

  it('PUT with wrong prevVersion → conflict carrying current row', async () => {
    const { privateKey, workspaceTag } = await makeKp()
    const session = await createObjstoreSession({ serverUrl, httpOrigin, workspaceTag, privateKey })
    try {
      // v1 lands fresh.
      const v1 = await session.put({
        resourceTag: 'r-stale', bytes: Buffer.from('v1'),
        prevVersion: null,
      })
      assert.equal(v1.ok, true)
      // Second PUT also claims prevVersion=null → conflict.
      const conflict = await session.put({
        resourceTag: 'r-stale', bytes: Buffer.from('also-v1?'),
        prevVersion: null,
      })
      assert.equal(conflict.ok, false)
      assert.equal(conflict.reason, 'conflict')
      assert.ok(conflict.current, 'conflict carries the current live row')
      assert.equal(conflict.current.version, 1)
      assert.equal(conflict.current.resourceTag, 'r-stale')
      // Update with the right prevVersion → v2.
      const v2 = await session.put({
        resourceTag: 'r-stale', bytes: Buffer.from('v2-bytes'),
        prevVersion: 1,
      })
      assert.equal(v2.ok, true)
      assert.equal(v2.meta.version, 2)
    } finally { session.close() }
  })

  it('DELETE with non-null prevVersion on a missing resource → not-found', async () => {
    const { privateKey, workspaceTag } = await makeKp()
    const session = await createObjstoreSession({ serverUrl, httpOrigin, workspaceTag, privateKey })
    try {
      const del = await session.delete('never-existed', 1)
      assert.equal(del.ok, false)
      assert.equal(del.reason, 'not-found')
      // Idempotent missing-delete (prevVersion=null) still acks.
      const idem = await session.delete('never-existed', null)
      assert.equal(idem.ok, true)
      assert.equal(idem.deletedVersion, 0)
    } finally { session.close() }
  })

  it('FETCH on a missing resource → null', async () => {
    const { privateKey, workspaceTag } = await makeKp()
    const session = await createObjstoreSession({ serverUrl, httpOrigin, workspaceTag, privateKey })
    try {
      assert.equal(await session.fetch('not-there'), null)
    } finally { session.close() }
  })

  it('broadcast: onPut + onDeleted fire on peer sessions for the same workspace', async () => {
    const { privateKey, workspaceTag } = await makeKp()
    // Open two sessions for the same workspace. Both subscribe; A's
    // put broadcasts to B (and vice versa).
    const a = await createObjstoreSession({ serverUrl, httpOrigin, workspaceTag, privateKey })
    const b = await createObjstoreSession({ serverUrl, httpOrigin, workspaceTag, privateKey })
    try {
      const putSeen = awaitEvent("B's onPut r-broadcast", (resolve) => b.onPut((meta) => { if (meta.resourceTag === 'r-broadcast') resolve(meta) }))
      const deletedSeen = awaitEvent("B's onDeleted r-broadcast", (resolve) => b.onDeleted((event) => { if (event.resourceTag === 'r-broadcast') resolve(event) }))
      const put = await a.put({
        resourceTag: 'r-broadcast', bytes: Buffer.from('hello-peer'),
        prevVersion: null,
      })
      assert.equal(put.ok, true)
      // B sees the broadcast.
      const bMeta = await putSeen
      assert.equal(bMeta.version, 1)
      assert.equal(bMeta.contentHash, put.meta.contentHash)
      // A deletes; B sees the deleted broadcast.
      const del = await a.delete('r-broadcast', 1)
      assert.equal(del.ok, true)
      const bEv = await deletedSeen
      assert.equal(bEv.version, 1)
    } finally { a.close(); b.close() }
  })

  it('workspace-full: 101st distinct resource → put-error reason=workspace-full', async () => {
    const { MAX_RESOURCES_PER_WORKSPACE } = await import('../server/objstore/store.ts')
    const { privateKey, workspaceTag } = await makeKp()
    const session = await createObjstoreSession({ serverUrl, httpOrigin, workspaceTag, privateKey })
    try {
      // Fill to the cap via the full WS+REST path so we exercise the
      // same code the wire frame depends on. 4-byte payloads keep
      // each round-trip cheap.
      for (let i = 0; i < MAX_RESOURCES_PER_WORKSPACE; i++) {
        const res = await session.put({
          resourceTag: `r-fill-${i.toString().padStart(4, '0')}`,
          bytes: Buffer.alloc(4),
          prevVersion: null,
        })
        assert.equal(res.ok, true, `fill row #${i}`)
      }
      // 101st NEW resource is rejected at put-begin.
      const over = await session.put({
        resourceTag: 'r-one-too-many', bytes: Buffer.alloc(4),
        prevVersion: null,
      })
      assert.equal(over.ok, false)
      assert.equal(over.reason, 'workspace-full')
      // Update path is still allowed at the cap.
      const reup = await session.put({
        resourceTag: 'r-fill-0000', bytes: Buffer.from('y'.repeat(8)),
        prevVersion: 1,
      })
      assert.equal(reup.ok, true)
      assert.equal(reup.meta.version, 2)
    } finally { session.close() }
  })

  it('multi-version update chain: v1 → v2 → v3, fetch always returns latest', async () => {
    // Each update bumps the live row's version; the canonical
    // signing payload binds the prevVersion so out-of-order updates
    // can't slip past. Verifies the client surfaces every version
    // bump correctly + that fetch sees the latest bytes.
    const { privateKey, workspaceTag } = await makeKp()
    const session = await createObjstoreSession({ serverUrl, httpOrigin, workspaceTag, privateKey })
    try {
      const v1 = await session.put({
        resourceTag: 'r-versions', bytes: Buffer.from('one'),
        prevVersion: null,
      })
      assert.equal(v1.ok, true); assert.equal(v1.meta.version, 1)
      const v2 = await session.put({
        resourceTag: 'r-versions', bytes: Buffer.from('two-bytes'),
        prevVersion: 1,
      })
      assert.equal(v2.ok, true); assert.equal(v2.meta.version, 2)
      const v3 = await session.put({
        resourceTag: 'r-versions', bytes: Buffer.from('three-bytes-now'),
        prevVersion: 2,
      })
      assert.equal(v3.ok, true); assert.equal(v3.meta.version, 3)
      // fetch returns latest
      const got = await session.fetch('r-versions')
      assert.ok(got)
      assert.equal(got.meta.version, 3)
      assert.equal(Buffer.compare(Buffer.from(got.bytes), Buffer.from('three-bytes-now')), 0)
      // Replaying an old prevVersion fails with conflict echoing v3.
      const stale = await session.put({
        resourceTag: 'r-versions', bytes: Buffer.from('forgotten'),
        prevVersion: 1,
      })
      assert.equal(stale.ok, false); assert.equal(stale.reason, 'conflict')
      assert.equal(stale.current?.version, 3)
    } finally { session.close() }
  })

  it('parallel puts on DIFFERENT resources all succeed', async () => {
    // The session's concurrency constraint is per-resourceTag (no
    // two concurrent ops for the same key). Across DIFFERENT keys
    // there's no constraint — the wire frames carry their own
    // resourceTag and the message handler routes correctly.
    const { privateKey, workspaceTag } = await makeKp()
    const session = await createObjstoreSession({ serverUrl, httpOrigin, workspaceTag, privateKey })
    try {
      const N = 5
      const results = await Promise.all(
        Array.from({ length: N }, (_, i) => session.put({
          resourceTag: `r-parallel-${i}`,
          bytes: Buffer.from(`payload-${i}`),
          prevVersion: null,
        })),
      )
      for (const r of results) {
        assert.equal(r.ok, true)
        assert.equal(r.meta.version, 1)
      }
      // List sees all N — server's `selectLive` returns sorted by
      // resource_tag ASC.
      const live = await session.list()
      assert.equal(live.length, N)
      const tags = live.map((r) => r.resourceTag)
      assert.deepEqual(tags, Array.from({ length: N }, (_, i) => `r-parallel-${i}`))
    } finally { session.close() }
  })

  it('delete-then-recreate: version restarts at 1', async () => {
    // Per server/README.md and reaper-protected truncation contract:
    // deleting a row drops it from `workspace_object` entirely (no
    // tombstone). A subsequent `put` with `prevVersion: null` lands
    // at version 1 again, NOT continuing from the deleted version.
    const { privateKey, workspaceTag } = await makeKp()
    const session = await createObjstoreSession({ serverUrl, httpOrigin, workspaceTag, privateKey })
    try {
      const v1 = await session.put({
        resourceTag: 'r-recycle', bytes: Buffer.from('first-incarnation'),
        prevVersion: null,
      })
      assert.equal(v1.meta.version, 1)
      // Update to v2 then delete it.
      const v2 = await session.put({
        resourceTag: 'r-recycle', bytes: Buffer.from('second-incarnation'),
        prevVersion: 1,
      })
      assert.equal(v2.meta.version, 2)
      const del = await session.delete('r-recycle', 2)
      assert.equal(del.ok, true); assert.equal(del.deletedVersion, 2)
      // Re-put: version restarts at 1.
      const reborn = await session.put({
        resourceTag: 'r-recycle', bytes: Buffer.from('third-but-v1-again'),
        prevVersion: null,
      })
      assert.equal(reborn.ok, true)
      assert.equal(reborn.meta.version, 1, 'version starts back at 1 after delete')
    } finally { session.close() }
  })

  it('larger payload: 256 KiB round-trip with integrity check', async () => {
    // Exercises the REST streaming path with a non-trivial body.
    // Smaller than the server's MAX_CONTENT_LENGTH (100 MiB) but
    // large enough to span multiple TCP packets and verify the
    // pipeline doesn't truncate.
    const { privateKey, workspaceTag } = await makeKp()
    const session = await createObjstoreSession({ serverUrl, httpOrigin, workspaceTag, privateKey })
    try {
      // `crypto.getRandomValues` is capped at 65,536 bytes per call,
      // so fill the larger buffer in chunks.
      const bytes = new Uint8Array(256 * 1024)
      for (let off = 0; off < bytes.byteLength; off += 65_536) {
        crypto.getRandomValues(bytes.subarray(off, Math.min(off + 65_536, bytes.byteLength)))
      }
      const put = await session.put({
        resourceTag: 'r-big', bytes, prevVersion: null,
      })
      assert.equal(put.ok, true)
      assert.equal(put.meta.contentLength, 256 * 1024)
      const got = await session.fetch('r-big')
      assert.ok(got)
      assert.equal(got.bytes.byteLength, 256 * 1024)
      assert.equal(Buffer.compare(Buffer.from(got.bytes), Buffer.from(bytes)), 0)
    } finally { session.close() }
  })

  it('multi-peer broadcast: all subscribed peers receive byte-equal events', async () => {
    // Expands the basic broadcast test: 3 peer sessions, A puts,
    // B + C both receive the same `objstore-put` event. Pins that
    // the relay's broadcast fans out correctly + that each session's
    // onPut handler fires independently.
    const { privateKey, workspaceTag } = await makeKp()
    const a = await createObjstoreSession({ serverUrl, httpOrigin, workspaceTag, privateKey })
    const b = await createObjstoreSession({ serverUrl, httpOrigin, workspaceTag, privateKey })
    const c = await createObjstoreSession({ serverUrl, httpOrigin, workspaceTag, privateKey })
    try {
      const bSeen = awaitEvent("B's onPut r-fanout", (resolve) => b.onPut((meta) => { if (meta.resourceTag === 'r-fanout') resolve(meta) }))
      const cSeen = awaitEvent("C's onPut r-fanout", (resolve) => c.onPut((meta) => { if (meta.resourceTag === 'r-fanout') resolve(meta) }))
      const put = await a.put({
        resourceTag: 'r-fanout', bytes: Buffer.from('fanout'),
        prevVersion: null,
      })
      assert.equal(put.ok, true)
      const [bMeta, cMeta] = await Promise.all([bSeen, cSeen])
      // Both peers see the SAME metadata for the same put.
      assert.equal(bMeta.contentHash, put.meta.contentHash)
      assert.equal(cMeta.contentHash, put.meta.contentHash)
      assert.equal(bMeta.version, cMeta.version)
      assert.equal(bMeta.contentLength, put.meta.contentLength)
    } finally { a.close(); b.close(); c.close() }
  })

  it('onPut / onDeleted return unsubscribe fns that detach the handler', async () => {
    // The handler set is internal state; unsubscribe should drop it.
    // After unsubscribe, a peer's put on the workspace must NOT fire
    // the unsubscribed handler. Tests the return-value contract.
    const { privateKey, workspaceTag } = await makeKp()
    const a = await createObjstoreSession({ serverUrl, httpOrigin, workspaceTag, privateKey })
    const b = await createObjstoreSession({ serverUrl, httpOrigin, workspaceTag, privateKey })
    try {
      let firedCount = 0
      const unsubscribe = b.onPut(() => { firedCount++ })
      // First put: handler should fire.
      const sentinel1 = awaitEvent("B's onPut sentinel r-unsub", (resolve) => b.onPut((meta) => { if (meta.resourceTag === 'r-unsub') resolve() }))
      await a.put({
        resourceTag: 'r-unsub', bytes: Buffer.from('one'),
        prevVersion: null,
      })
      await sentinel1
      const afterFirst = firedCount
      assert.ok(afterFirst > 0, 'handler should fire at least once')
      // Detach the first handler. The second (sentinel) handler stays
      // attached to confirm the broadcast itself reaches B.
      unsubscribe()
      // Second put on a DIFFERENT resource so we have a fresh
      // sentinel to await.
      const sentinel2 = awaitEvent("B's onPut sentinel r-unsub-2", (resolve) => b.onPut((meta) => { if (meta.resourceTag === 'r-unsub-2') resolve() }))
      await a.put({
        resourceTag: 'r-unsub-2', bytes: Buffer.from('two'),
        prevVersion: null,
      })
      await sentinel2
      // The unsubscribed handler must NOT have fired again.
      assert.equal(firedCount, afterFirst, 'unsubscribed handler should not fire after detach')
    } finally { a.close(); b.close() }
  })

  it('DELETE with wrong prevVersion on existing resource → conflict carrying current', async () => {
    const { privateKey, workspaceTag } = await makeKp()
    const session = await createObjstoreSession({ serverUrl, httpOrigin, workspaceTag, privateKey })
    try {
      await session.put({
        resourceTag: 'r-stale-del', bytes: Buffer.from('v1'),
        prevVersion: null,
      })
      // prevVersion=2 against a live row at version=1 → conflict.
      const del = await session.delete('r-stale-del', 2)
      assert.equal(del.ok, false)
      assert.equal(del.reason, 'conflict')
      assert.equal(del.current?.version, 1)
      // Correct prevVersion succeeds.
      const ok = await session.delete('r-stale-del', 1)
      assert.equal(ok.ok, true); assert.equal(ok.deletedVersion, 1)
    } finally { session.close() }
  })

  it('createObjstoreSession rejects (not hangs) when the server is unreachable', async () => {
    // Pins the handshake-cleanup contract: if the WS can't open, the
    // promise rejects with the underlying error (not a hang). A
    // freshly-bound but immediately-closed local port simulates a
    // "no server here" scenario.
    const { default: net } = await import('node:net')
    const { privateKey, workspaceTag } = await makeKp()
    // Grab a free port then close, so connect() fast-fails.
    const probe = net.createServer()
    await new Promise((resolve) => { probe.listen(0, '127.0.0.1', resolve) })
    const port = probe.address().port
    await new Promise((resolve) => { probe.close(resolve) })
    const badUrl = `ws://127.0.0.1:${port}/api/sync`
    const badOrigin = `http://127.0.0.1:${port}`
    // Any rejection is fine — the exact error class depends on the
    // platform's WS implementation (undici throws TypeError without
    // a useful message on connect-refused, browsers throw something
    // else). What we're pinning is that the promise REJECTS rather
    // than hanging for the request timeout.
    await assert.rejects(
      createObjstoreSession({ serverUrl: badUrl, httpOrigin: badOrigin, workspaceTag, privateKey }),
    )
  })

  it('cross-workspace isolation: tagA put does not surface in tagB list', async () => {
    // Per the server's `workspace_object` PK on (workspace_tag,
    // resource_tag), data for different tags is fully partitioned.
    // From the client side: a session for tagA can put a resource;
    // a session for tagB on the same relay must NOT see it.
    const a = await makeKp()
    const b = await makeKp()
    const sa = await createObjstoreSession({ serverUrl, httpOrigin, workspaceTag: a.workspaceTag, privateKey: a.privateKey })
    const sb = await createObjstoreSession({ serverUrl, httpOrigin, workspaceTag: b.workspaceTag, privateKey: b.privateKey })
    try {
      const put = await sa.put({
        resourceTag: 'r-iso', bytes: Buffer.from('only-in-a'),
        prevVersion: null,
      })
      assert.equal(put.ok, true)
      // tagA sees it; tagB doesn't.
      assert.equal((await sa.list()).length, 1)
      assert.deepEqual(await sb.list(), [])
      assert.equal(await sb.fetch('r-iso'), null)
      // tagB CAN put its own r-iso (same name, different workspace)
      // without affecting tagA.
      const bp = await sb.put({
        resourceTag: 'r-iso', bytes: Buffer.from('only-in-b'),
        prevVersion: null,
      })
      assert.equal(bp.ok, true)
      assert.equal(bp.meta.version, 1)
      // Each tag's fetch returns its own bytes — no cross-talk.
      const fromA = await sa.fetch('r-iso'); assert.ok(fromA)
      const fromB = await sb.fetch('r-iso'); assert.ok(fromB)
      assert.equal(Buffer.from(fromA.bytes).toString('utf8'), 'only-in-a')
      assert.equal(Buffer.from(fromB.bytes).toString('utf8'), 'only-in-b')
    } finally { sa.close(); sb.close() }
  })

  it('resources persist across reconnects (same workspaceTag, new session)', async () => {
    // Server-side state lives in SQLite + filesystem under the same
    // DB_PATH / OBJSTORE_DIR for the spawned relay's lifetime.
    // Closing the session closes only the WS; the row stays. A
    // fresh session for the same workspace must see the same list.
    const { privateKey, workspaceTag } = await makeKp()
    const first = await createObjstoreSession({ serverUrl, httpOrigin, workspaceTag, privateKey })
    let putMeta
    try {
      const r = await first.put({
        resourceTag: 'r-persist', bytes: Buffer.from('survives-reconnect'),
        prevVersion: null,
      })
      assert.equal(r.ok, true)
      putMeta = r.meta
    } finally { first.close() }
    // Fresh session on the same workspace tag.
    const second = await createObjstoreSession({ serverUrl, httpOrigin, workspaceTag, privateKey })
    try {
      const live = await second.list()
      assert.equal(live.length, 1)
      assert.equal(live[0].resourceTag, 'r-persist')
      assert.equal(live[0].version, 1)
      assert.equal(live[0].contentHash, putMeta.contentHash)
      const got = await second.fetch('r-persist')
      assert.ok(got)
      assert.equal(Buffer.from(got.bytes).toString('utf8'), 'survives-reconnect')
      // Clean up so this test doesn't bleed into the next.
      await second.delete('r-persist', 1)
    } finally { second.close() }
  })

  it('two concurrent sessions racing on same resourceTag — exactly one wins', async () => {
    // The server's per-resource `KeyedAsyncLock` serialises commits
    // on the same (tag, resourceTag). Two peers both submitting
    // `put(prevVersion: null)` for the same fresh resource: the
    // FIRST commit wins (version=1); the SECOND sees a conflict
    // carrying the winner's row. Tests the wire shape of the
    // conflict response on a real race.
    const { privateKey, workspaceTag } = await makeKp()
    const a = await createObjstoreSession({ serverUrl, httpOrigin, workspaceTag, privateKey })
    const b = await createObjstoreSession({ serverUrl, httpOrigin, workspaceTag, privateKey })
    try {
      const aPut = a.put({
        resourceTag: 'r-race', bytes: Buffer.from('from-a'),
        prevVersion: null,
      })
      const bPut = b.put({
        resourceTag: 'r-race', bytes: Buffer.from('from-b'),
        prevVersion: null,
      })
      const [aRes, bRes] = await Promise.all([aPut, bPut])
      // Exactly one wins: their (ok: true) ↔ (ok: false, conflict).
      const okCount = [aRes, bRes].filter((r) => r.ok).length
      const conflictCount = [aRes, bRes].filter((r) => !r.ok && r.reason === 'conflict').length
      assert.equal(okCount, 1, 'exactly one put should succeed')
      assert.equal(conflictCount, 1, 'the other should see a conflict')
      // The conflict's `current` either carries the winner's row
      // (WS-side conflict — server's beginPut got the second put-
      // begin AFTER the first committed) or null (REST-side
      // conflict — both put-begins issued tokens, race-loser hit
      // the per-resource commit lock second and got `409 conflict`
      // back from REST with no row body). Both are documented; the
      // caller can `fetch()` to resolve the winner if it cares.
      const winner = aRes.ok ? aRes : bRes
      const loser = aRes.ok ? bRes : aRes
      if (loser.current !== null) {
        assert.equal(loser.current.version, 1)
        assert.equal(loser.current.contentHash, winner.meta.contentHash)
      }
      // Regardless of where the race resolved, fetch sees the winner.
      const got = await (aRes.ok ? a : b).fetch('r-race')
      assert.ok(got); assert.equal(got.meta.version, 1)
      assert.equal(got.meta.contentHash, winner.meta.contentHash)
    } finally { a.close(); b.close() }
  })

  it('GET race against concurrent DELETE: returns either intact bytes or null, never garbage', async () => {
    // The server-side fetch-token captures the live row's metadata
    // at the moment the token is minted. A subsequent DELETE drops
    // the row + unlinks the file; the OS pins the inode for any
    // open fd (POSIX semantics). From the client side, observable
    // outcome is: either the original bytes round-trip (fd pinned)
    // OR fetch resolves to null (we lost the race to begin the
    // GET). Either way, integrity holds — never garbage bytes.
    const { privateKey, workspaceTag } = await makeKp()
    const session = await createObjstoreSession({ serverUrl, httpOrigin, workspaceTag, privateKey })
    try {
      const original = Buffer.from('original-bytes-for-the-race')
      const put = await session.put({
        resourceTag: 'r-fetch-delete-race', bytes: original,
        prevVersion: null,
      })
      assert.equal(put.ok, true)
      // Fire fetch and delete concurrently. Either order is valid;
      // the assertion is on the integrity of whatever fetch returns.
      const [fetchRes, deleteRes] = await Promise.all([
        session.fetch('r-fetch-delete-race'),
        session.delete('r-fetch-delete-race', 1),
      ])
      assert.equal(deleteRes.ok, true)
      // fetch result is either { bytes: original } or null.
      if (fetchRes !== null) {
        assert.equal(Buffer.compare(Buffer.from(fetchRes.bytes), original), 0,
          'if fetch returned bytes, they must match the put (no torn read)')
      }
    } finally { session.close() }
  })

  it('DELETE with prevVersion=null when the row exists → conflict (not silent succeed)', async () => {
    // The server distinguishes "missing + prev=null" (idempotent
    // success, deletedVersion=0) from "present + prev=null"
    // (conflict). Without this branch, a stale client thinking
    // "the row is missing" would silently drop a row that another
    // peer just created.
    const { privateKey, workspaceTag } = await makeKp()
    const session = await createObjstoreSession({ serverUrl, httpOrigin, workspaceTag, privateKey })
    try {
      const put = await session.put({
        resourceTag: 'r-must-not-exist', bytes: Buffer.from('mine'),
        prevVersion: null,
      })
      assert.equal(put.ok, true)
      // Now delete with prevVersion=null on an existing row.
      const del = await session.delete('r-must-not-exist', null)
      assert.equal(del.ok, false)
      assert.equal(del.reason, 'conflict')
      assert.equal(del.current?.version, 1, 'conflict carries the existing row')
      // Verify the row is STILL there — the conflict-without-delete
      // contract.
      const got = await session.fetch('r-must-not-exist')
      assert.ok(got)
      assert.equal(Buffer.from(got.bytes).toString('utf8'), 'mine')
    } finally { session.close() }
  })

  it('same bytes as different resourceTags: both succeed with the same contentHash', async () => {
    // contentHash is content-addressed (SHA-256(bytes)), so two
    // distinct resourceTags carrying byte-identical payloads land
    // the same hash. They're independent live rows on the server
    // (PK is (workspace_tag, resource_tag), not contentHash) — no
    // de-duplication. Confirms the client surfaces both correctly.
    const { privateKey, workspaceTag } = await makeKp()
    const session = await createObjstoreSession({ serverUrl, httpOrigin, workspaceTag, privateKey })
    try {
      const bytes = Buffer.from('identical-payload-bytes')
      const aRes = await session.put({
        resourceTag: 'r-shared-a', bytes, prevVersion: null,
      })
      const bRes = await session.put({
        resourceTag: 'r-shared-b', bytes, prevVersion: null,
      })
      assert.equal(aRes.ok, true); assert.equal(bRes.ok, true)
      assert.equal(aRes.meta.contentHash, bRes.meta.contentHash,
        'identical bytes → identical contentHash')
      // Each row is its own version=1 (independent).
      assert.equal(aRes.meta.version, 1); assert.equal(bRes.meta.version, 1)
      const live = await session.list()
      assert.equal(live.length, 2)
      // Both rows share contentHash + contentLength but have
      // distinct resourceTags.
      const tags = live.map((r) => r.resourceTag).sort()
      assert.deepEqual(tags, ['r-shared-a', 'r-shared-b'])
      assert.equal(live[0].contentHash, live[1].contentHash)
    } finally { session.close() }
  })

  it('sender DOES receive its own onPut broadcast (REST commit broadcasts to all)', async () => {
    // Server-side asymmetry worth pinning: the REST PUT commit
    // broadcasts to ALL workspace subscribers without an `except`
    // socket (the REST plane has no WS-originator reference). So
    // a session that puts via session.put() also receives the
    // resulting `objstore-put` on its OWN onPut handler.
    //
    // Callers that want to dedupe "did I do this?" must do so via
    // the contentHash or by tracking outstanding puts themselves.
    const { privateKey, workspaceTag } = await makeKp()
    const session = await createObjstoreSession({ serverUrl, httpOrigin, workspaceTag, privateKey })
    try {
      const selfSeen = awaitEvent("self onPut r-self-put", (resolve) => session.onPut((meta) => { if (meta.resourceTag === 'r-self-put') resolve(meta) }))
      const put = await session.put({
        resourceTag: 'r-self-put', bytes: Buffer.from('echoed-to-me'),
        prevVersion: null,
      })
      assert.equal(put.ok, true)
      const echo = await selfSeen
      assert.equal(echo.contentHash, put.meta.contentHash)
      assert.equal(echo.version, 1)
    } finally { session.close() }
  })

  it('sender does NOT receive its own onDeleted broadcast (WS delete excludes originator)', async () => {
    // Asymmetric with the put broadcast above: the WS `handleDelete`
    // passes the originator's socket as `except` to broadcast, so
    // the deleting session does NOT receive its own `objstore-
    // deleted` event. A peer session would.
    const { privateKey, workspaceTag } = await makeKp()
    const sender = await createObjstoreSession({ serverUrl, httpOrigin, workspaceTag, privateKey })
    const peer = await createObjstoreSession({ serverUrl, httpOrigin, workspaceTag, privateKey })
    try {
      await sender.put({
        resourceTag: 'r-asym-del', bytes: Buffer.from('temporary'),
        prevVersion: null,
      })
      // Drain the put-broadcast from BOTH sessions before testing
      // the delete-broadcast asymmetry. Use a tiny timeout so we
      // don't await indefinitely on a frame that may or may not
      // arrive (sender DOES receive own put per the test above).
      await new Promise((res) => { setTimeout(res, 50) })
      let senderSeenDelete = false
      sender.onDeleted((ev) => { if (ev.resourceTag === 'r-asym-del') senderSeenDelete = true })
      const peerSeesDelete = awaitEvent("peer onDeleted r-asym-del", (resolve) => peer.onDeleted((ev) => { if (ev.resourceTag === 'r-asym-del') resolve(ev) }))
      const del = await sender.delete('r-asym-del', 1)
      assert.equal(del.ok, true)
      // Peer sees the broadcast.
      const peerEv = await peerSeesDelete
      assert.equal(peerEv.version, 1)
      // After peer saw it, give the sender's handler a few extra
      // turns of the event loop to (incorrectly) fire — it shouldn't.
      await new Promise((res) => { setTimeout(res, 50) })
      assert.equal(senderSeenDelete, false, 'sender must NOT receive its own onDeleted')
    } finally { sender.close(); peer.close() }
  })

  it('broadcasts respect workspaceTag isolation across sessions', async () => {
    // Subscribers are keyed per (workspaceTag, socket). A session
    // for tagA must NOT receive broadcasts for tagB even though
    // both are on the same relay. Cross-cuts the subscriber-map
    // routing on the server.
    const a = await makeKp()
    const b = await makeKp()
    const sa = await createObjstoreSession({ serverUrl, httpOrigin, workspaceTag: a.workspaceTag, privateKey: a.privateKey })
    const sb = await createObjstoreSession({ serverUrl, httpOrigin, workspaceTag: b.workspaceTag, privateKey: b.privateKey })
    try {
      let saSawBPut = false
      let sbSawAPut = false
      sa.onPut((meta) => { if (meta.resourceTag === 'r-b-only') saSawBPut = true })
      sb.onPut((meta) => { if (meta.resourceTag === 'r-a-only') sbSawAPut = true })
      // Wait-handles for the SENDER receiving its own put, so we
      // know the broadcast plumbing has settled before checking
      // the negative assertion.
      const aSawA = awaitEvent("sa onPut r-a-only", (resolve) => sa.onPut((meta) => { if (meta.resourceTag === 'r-a-only') resolve(meta) }))
      const bSawB = awaitEvent("sb onPut r-b-only", (resolve) => sb.onPut((meta) => { if (meta.resourceTag === 'r-b-only') resolve(meta) }))
      await sa.put({ resourceTag: 'r-a-only', bytes: Buffer.from('a'), prevVersion: null })
      await sb.put({ resourceTag: 'r-b-only', bytes: Buffer.from('b'), prevVersion: null })
      await aSawA; await bSawB
      // Cross-tag must NOT have crossed.
      assert.equal(saSawBPut, false, 'tagA session must NOT receive tagB broadcasts')
      assert.equal(sbSawAPut, false, 'tagB session must NOT receive tagA broadcasts')
    } finally { sa.close(); sb.close() }
  })

  it('handler exception is swallowed; other handlers still fire', async () => {
    // The message dispatcher wraps each handler invocation in
    // try/catch — a buggy handler must not block other handlers
    // for the same event. Register a throwing handler + a sentinel
    // handler; the sentinel must still resolve.
    const { privateKey, workspaceTag } = await makeKp()
    const a = await createObjstoreSession({ serverUrl, httpOrigin, workspaceTag, privateKey })
    const b = await createObjstoreSession({ serverUrl, httpOrigin, workspaceTag, privateKey })
    try {
      let badFired = 0
      // Throwing handler runs first.
      b.onPut(() => { badFired++; throw new Error('intentional handler throw') })
      // Sentinel runs second — must still fire even though the first threw.
      const sentinelSeen = awaitEvent("B's sentinel onPut r-handler-throw", (resolve) => b.onPut((meta) => { if (meta.resourceTag === 'r-handler-throw') resolve(meta) }))
      await a.put({
        resourceTag: 'r-handler-throw', bytes: Buffer.from('payload'),
        prevVersion: null,
      })
      const meta = await sentinelSeen
      assert.equal(meta.resourceTag, 'r-handler-throw')
      assert.ok(badFired > 0, 'the throwing handler should have been called')
    } finally { a.close(); b.close() }
  })

  it('empty bytes (0-byte payload) round-trip', async () => {
    // Edge case: zero-length payload. Server's `expectedLength >= 0`
    // gate allows it; SHA-256 over empty bytes is a constant. Client
    // should compute contentLength=0 + contentHash of empty; fetch
    // returns Uint8Array(0).
    const { privateKey, workspaceTag } = await makeKp()
    const session = await createObjstoreSession({ serverUrl, httpOrigin, workspaceTag, privateKey })
    try {
      const empty = new Uint8Array(0)
      const put = await session.put({
        resourceTag: 'r-empty', bytes: empty,
        prevVersion: null,
      })
      assert.equal(put.ok, true)
      assert.equal(put.meta.contentLength, 0)
      // SHA-256 of empty input is well-known. Verify against the
      // base64url of the standard digest so a regression that hashed
      // something other than the empty input would fail.
      const EMPTY_SHA256_B64URL = '47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU'
      assert.equal(put.meta.contentHash, EMPTY_SHA256_B64URL)
      const got = await session.fetch('r-empty')
      assert.ok(got)
      assert.equal(got.bytes.byteLength, 0)
      assert.equal(got.meta.contentHash, EMPTY_SHA256_B64URL)
    } finally { session.close() }
  })

  it('close() during an in-flight operation rejects the pending promise (no 10s hang)', async () => {
    // Pre-fix bug: close() left pending waiters dangling for up to
    // the full `requestTimeoutMs` (default 10 s) because the WS
    // close event didn't reach the recv() promises. Now: 'close'
    // fires `failPendingWaiters` which rejects everything in the
    // waiters list. The promise rejects within a few ms of the
    // close, not the full requestTimeoutMs.
    //
    // To get a reliable "pending recv" state we send a put-begin
    // for a resourceTag the server silently drops (forbidden char
    // `/` outside the `[\w-]+` alphabet). The send succeeds (no
    // client-side validation), the server drops without responding,
    // and our recv waiter sits pending until either the request
    // timeout (default 10s) or close() rejects it. Use the default
    // timeout so a regression that fell back to it would manifest
    // as a 10s test rather than a quick fail.
    const { privateKey, workspaceTag } = await makeKp()
    const session = await createObjstoreSession({ serverUrl, httpOrigin, workspaceTag, privateKey })
    const inflight = session.put({
      resourceTag: 'bad/tag', bytes: Buffer.from('payload'),
      prevVersion: null,
    })
    // 100ms is enough for the put's sign + send to complete and the
    // recv waiter to land in the queue, with margin to spare.
    await new Promise((r) => { setTimeout(r, 100) })
    const start = Date.now()
    session.close()
    await assert.rejects(inflight, /session closed|websocket/iu)
    const elapsed = Date.now() - start
    assert.ok(elapsed < 500, `pending op should reject promptly after close, got ${elapsed}ms (would be ~10000ms if it fell back to the request timeout)`)
  })

  it('malformed resourceTag (forbidden chars) → caller-facing timeout, not silent hang', async () => {
    // The server's wire-gate (`isValidTag`) silently drops any
    // put-begin whose resourceTag isn't `[\w-]+`. From the client
    // side this manifests as a request timeout — `recv()` never
    // sees a matching response. Pin this behaviour with a SHORT
    // requestTimeoutMs so a regression that left the caller hanging
    // for the default 10 s shows up as a test slow-down.
    //
    // Future work: client-side validation could fail-fast with a
    // clearer error; for now the timeout is the documented surface.
    const { privateKey, workspaceTag } = await makeKp()
    const session = await createObjstoreSession({ serverUrl, httpOrigin, workspaceTag, privateKey, requestTimeoutMs: 500 })
    try {
      const start = Date.now()
      await assert.rejects(
        session.put({
          // `/` is outside `[\w-]+` — server drops at the wire-gate.
          resourceTag: 'bad/tag',
          bytes: Buffer.from('payload'),
          prevVersion: null,
        }),
        /timeout/iu,
      )
      const elapsed = Date.now() - start
      // We pinned requestTimeoutMs=500 so the rejection arrives
      // ~500ms after send. Allow some slack for scheduling.
      assert.ok(elapsed >= 400 && elapsed < 2_000,
        `timeout should fire around requestTimeoutMs, got ${elapsed}ms`)
    } finally { session.close() }
  })

  it('operations after close() reject cleanly (no hang)', async () => {
    // After `close()` the WS readyState is CLOSING/CLOSED; the
    // internal `send()` throws "socket not open". The async API
    // surfaces this as a rejected promise from put/fetch/delete/
    // list rather than a hang. Caller gets a clear error to handle.
    const { privateKey, workspaceTag } = await makeKp()
    const session = await createObjstoreSession({ serverUrl, httpOrigin, workspaceTag, privateKey })
    session.close()
    // Each method should reject; the exact error message depends
    // on the WS library + readyState transition timing, so just
    // assert rejection (no message match).
    await assert.rejects(session.put({
      resourceTag: 'r-after-close', bytes: Buffer.from('post'),
      prevVersion: null,
    }))
    await assert.rejects(session.fetch('r-after-close'))
    await assert.rejects(session.delete('r-after-close', null))
    await assert.rejects(session.list())
  })

  it('close() is idempotent — calling twice does not throw', async () => {
    const { privateKey, workspaceTag } = await makeKp()
    const session = await createObjstoreSession({ serverUrl, httpOrigin, workspaceTag, privateKey })
    session.close()
    // Second close is a no-op via the internal try/catch swallow.
    session.close()
  })

  it('integrity: client verifies SHA-256(bytes) === contentHash on fetch', async () => {
    // This pins the client-side integrity contract from
    // client/objstore.ts. Happy-path: a correctly-stored resource
    // round-trips with a hash match. A regression that dropped the
    // check would still pass — to detect tampering we'd need to
    // inject corruption, which requires server-side cooperation we
    // don't have. So this is a positive smoke test only; the
    // negative path is documented in the client module.
    const { privateKey, workspaceTag } = await makeKp()
    const session = await createObjstoreSession({ serverUrl, httpOrigin, workspaceTag, privateKey })
    try {
      const bytes = crypto.getRandomValues(new Uint8Array(1024))
      const put = await session.put({
        resourceTag: 'r-integrity', bytes, prevVersion: null,
      })
      assert.equal(put.ok, true)
      // contentHash was computed client-side; verify it matches what
      // the server stored + echoes back on fetch.
      const got = await session.fetch('r-integrity')
      assert.ok(got)
      assert.equal(got.meta.contentHash, put.meta.contentHash)
      assert.equal(Buffer.compare(Buffer.from(got.bytes), Buffer.from(bytes)), 0)
    } finally { session.close() }
  })
})
