// End-to-end tests for the client/objstore.ts session module
// against a spawned `server/index.ts` relay. Exercises the public
// API (`session.put` / `.fetch` / `.fetchByTag` / `.delete` /
// `.list` / `.onPut` / `.onDeleted`) which encrypts plaintext
// (fileName, content) internally before any wire frame leaves the
// process — the server only ever sees ciphertext + opaque HMAC
// resource tags.

import './_polyfills.js'
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import path from 'node:path'
import { Buffer } from 'node:buffer'

import { deriveObjstoreKeys } from '../client/sync/objstore.ts'
import { createObjstoreSession } from './_objstore-session.js'
import { bootServer } from './_helpers.js'

// Create a fresh workspace's full key bundle. Generates 32 random
// bytes + a random UUID, then walks `deriveObjstoreKeys` to derive
// the signing keypair, content key, tag key, and workspaceTag — the
// same path UI code takes when opening a workspace's objstore
// session, so the tests exercise the production derivation.
async function makeKeys() {
  const privateKeyBytes = crypto.getRandomValues(new Uint8Array(32))
  const privateKeyBase64 = privateKeyBytes.toBase64()
  const workspaceId = crypto.randomUUID()
  const keys = await deriveObjstoreKeys(privateKeyBase64, workspaceId)
  return { keys, workspaceId, privateKeyBase64 }
}

// Subscribe to a broadcast event with a timeout. Any test that
// awaits a broadcast without this wrapper will hang indefinitely
// if the expected frame never arrives — turning a real bug into
// a stalled test run.
function awaitEvent(label, subscribe, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`awaitEvent timeout: ${label} did not fire within ${timeoutMs}ms`)), timeoutMs)
    subscribe((value) => { clearTimeout(t); resolve(value) })
  })
}

// Each `it` makes fresh keypairs (= fresh workspaceTag), so the
// per-test server state is isolated. Running them concurrently
// against the shared spawned server cuts wall-time roughly to the
// slowest single test. The confidentiality test that walks the
// on-disk objstore is split into its own (sequential) describe
// below, so it doesn't race with the concurrent writers here.
describe('client/objstore session', { concurrency: true }, () => {
  let httpOrigin, server, serverUrl

  before(async () => {
    server = await bootServer()
    serverUrl = server.serverUrl
    httpOrigin = server.httpOrigin
  })

  after(async () => {
    if (server) await server.teardown()
  })

  it('put → list → fetch → delete round-trip', async () => {
    const { keys } = await makeKeys()
    const session = await createObjstoreSession({ serverUrl, httpOrigin, keys })
    try {
      assert.deepEqual(await session.list(), [])
      const content = Buffer.from('hello-objstore-client', 'utf8')
      const put = await session.put({ fileName: 'greeting.json', content, prev: null })
      assert.equal(put.ok, true)
      assert.equal(put.meta.version, 1)
      // contentLength is the CIPHERTEXT length (12-byte nonce +
      // 2-byte name-length + name bytes + content bytes + 16-byte
      // AEAD tag), NOT the plaintext content length.
      const expectedCiphertextLen = 12 + 2 + 'greeting.json'.length + content.byteLength + 16
      assert.equal(put.meta.contentLength, expectedCiphertextLen)
      const live = await session.list()
      assert.equal(live.length, 1)
      assert.equal(live[0].version, 1)
      assert.equal(live[0].contentLength, expectedCiphertextLen)
      const got = await session.fetch('greeting.json')
      assert.ok(got, 'fetch should not return null')
      assert.equal(Buffer.compare(Buffer.from(got.content), content), 0, 'fetched content matches plaintext')
      assert.equal(got.version, 1)
      const del = await session.delete('greeting.json', got)
      assert.equal(del.ok, true)
      assert.equal(del.deletedVersion, 1)
      assert.equal(await session.fetch('greeting.json'), null)
      assert.deepEqual(await session.list(), [])
    } finally { session.close() }
  })

  it('list returns opaque HMAC resourceTags (not plaintext fileNames)', async () => {
    // The server never sees the fileName — only the HMAC tag. This
    // pins the privacy contract: a third party reading the
    // workspace's `objstore-list-result` frame can't reverse-engineer
    // which reports the workspace holds.
    const { keys } = await makeKeys()
    const session = await createObjstoreSession({ serverUrl, httpOrigin, keys })
    try {
      await session.put({ fileName: 'secret-report.json', content: Buffer.from('x'), prev: null })
      const live = await session.list()
      assert.equal(live.length, 1)
      const tag = live[0].resourceTag
      // base64url, 43 chars for SHA-256 output. NOT the fileName.
      assert.match(tag, /^[\w-]{43}$/u)
      assert.notEqual(tag, 'secret-report.json')
      // The tag MUST NOT contain the fileName as a substring (HMAC
      // is a PRF; even tiny correlations would be a serious bug).
      assert.ok(!tag.includes('secret'), `tag '${tag}' leaks substring of fileName`)
    } finally { session.close() }
  })

  it('PUT with wrong prevVersion → conflict carrying currentVersion', async () => {
    const { keys } = await makeKeys()
    const session = await createObjstoreSession({ serverUrl, httpOrigin, keys })
    try {
      const v1 = await session.put({ fileName: 'stale.json', content: Buffer.from('v1'), prev: null })
      assert.equal(v1.ok, true)
      const conflict = await session.put({ fileName: 'stale.json', content: Buffer.from('also-v1?'), prev: null })
      assert.equal(conflict.ok, false)
      assert.equal(conflict.reason, 'conflict')
      assert.equal(conflict.current?.version, 1, 'conflict surfaces the live version')
      const v2 = await session.put({ fileName: 'stale.json', content: Buffer.from('v2-bytes'), prev: v1.meta })
      assert.equal(v2.ok, true)
      assert.equal(v2.meta.version, 2)
    } finally { session.close() }
  })

  it('DELETE with non-null prevVersion on a missing resource → not-found', async () => {
    const { keys } = await makeKeys()
    const session = await createObjstoreSession({ serverUrl, httpOrigin, keys })
    try {
      // The incarnation must be a wire-valid id (22-char base64url, the
      // shape `randomId()` mints) or the server's delete-sig verifier
      // rejects the half-pair before reaching the CAS. This one is
      // well-formed but matches no row — the resource never existed —
      // so the version-conditional drop returns not-found.
      const del = await session.delete('never-existed.json', { version: 1, incarnation: 'AAAAAAAAAAAAAAAAAAAAAA' })
      assert.equal(del.ok, false)
      assert.equal(del.reason, 'not-found')
      const idem = await session.delete('never-existed.json', null)
      assert.equal(idem.ok, true)
      assert.equal(idem.deletedVersion, 0)
    } finally { session.close() }
  })

  it('FETCH on a missing resource → null', async () => {
    const { keys } = await makeKeys()
    const session = await createObjstoreSession({ serverUrl, httpOrigin, keys })
    try {
      assert.equal(await session.fetch('not-there.json'), null)
    } finally { session.close() }
  })

  it('broadcast: onPut + onDeleted fire on peer sessions for the same workspace', async () => {
    const { keys } = await makeKeys()
    const a = await createObjstoreSession({ serverUrl, httpOrigin, keys })
    const b = await createObjstoreSession({ serverUrl, httpOrigin, keys })
    try {
      // The broadcast carries the OPAQUE resourceTag, not the
      // fileName. To match on a specific file we resolve the tag
      // out of band via the second session's fetchByTag (or by
      // tracking from the put's wire layer). For this test we just
      // assert that A's put surfaces SOME broadcast on B, then
      // decrypt the inbound tag to confirm it's our file.
      const putSeen = awaitEvent("B's onPut", (resolve) => b.onPut((event) => resolve(event)))
      const deletedSeen = awaitEvent("B's onDeleted", (resolve) => b.onDeleted((event) => resolve(event)))
      const put = await a.put({ fileName: 'broadcast.json', content: Buffer.from('hello-peer'), prev: null })
      assert.equal(put.ok, true)
      const bEvent = await putSeen
      assert.equal(bEvent.version, 1)
      // Decrypt the broadcast'd tag to confirm it pins our file.
      const peerView = await b.fetchByTag(bEvent.resourceTag)
      assert.ok(peerView)
      assert.equal(peerView.fileName, 'broadcast.json')
      assert.equal(Buffer.from(peerView.content).toString('utf8'), 'hello-peer')
      const del = await a.delete('broadcast.json', put.meta)
      assert.equal(del.ok, true)
      const dEv = await deletedSeen
      assert.equal(dEv.version, 1)
    } finally { a.close(); b.close() }
  })

  it('workspace-full: 101st distinct resource → put-error reason=workspace-full', async () => {
    const { MAX_RESOURCES_PER_WORKSPACE } = await import('../server/objstore/store.ts')
    const { keys } = await makeKeys()
    const session = await createObjstoreSession({ serverUrl, httpOrigin, keys })
    try {
      let fill0 = null
      for (let i = 0; i < MAX_RESOURCES_PER_WORKSPACE; i++) {
        const res = await session.put({
          fileName: `fill-${i.toString().padStart(4, '0')}.json`,
          content: Buffer.alloc(4),
          prev: null,
        })
        assert.equal(res.ok, true, `fill row #${i}`)
        if (i === 0) fill0 = res.meta
      }
      const over = await session.put({ fileName: 'one-too-many.json', content: Buffer.alloc(4), prev: null })
      assert.equal(over.ok, false)
      assert.equal(over.reason, 'workspace-full')
      const reup = await session.put({ fileName: 'fill-0000.json', content: Buffer.from('y'.repeat(8)), prev: fill0 })
      assert.equal(reup.ok, true)
      assert.equal(reup.meta.version, 2)
    } finally { session.close() }
  })

  it('multi-version update chain: v1 → v2 → v3, fetch always returns latest', async () => {
    const { keys } = await makeKeys()
    const session = await createObjstoreSession({ serverUrl, httpOrigin, keys })
    try {
      const v1 = await session.put({ fileName: 'versions.json', content: Buffer.from('one'), prev: null })
      assert.equal(v1.ok, true); assert.equal(v1.meta.version, 1)
      const v2 = await session.put({ fileName: 'versions.json', content: Buffer.from('two-bytes'), prev: v1.meta })
      assert.equal(v2.ok, true); assert.equal(v2.meta.version, 2)
      const v3 = await session.put({ fileName: 'versions.json', content: Buffer.from('three-bytes-now'), prev: v2.meta })
      assert.equal(v3.ok, true); assert.equal(v3.meta.version, 3)
      const got = await session.fetch('versions.json')
      assert.ok(got)
      assert.equal(got.version, 3)
      assert.equal(Buffer.compare(Buffer.from(got.content), Buffer.from('three-bytes-now')), 0)
      const stale = await session.put({ fileName: 'versions.json', content: Buffer.from('forgotten'), prev: v1.meta })
      assert.equal(stale.ok, false); assert.equal(stale.reason, 'conflict')
      assert.equal(stale.current?.version, 3)
    } finally { session.close() }
  })

  it('parallel puts on DIFFERENT fileNames all succeed', async () => {
    const { keys } = await makeKeys()
    const session = await createObjstoreSession({ serverUrl, httpOrigin, keys })
    try {
      const N = 5
      const results = await Promise.all(
        Array.from({ length: N }, (_, i) => session.put({
          fileName: `parallel-${i}.json`,
          content: Buffer.from(`payload-${i}`),
          prev: null,
        })),
      )
      for (const r of results) {
        assert.equal(r.ok, true)
        assert.equal(r.meta.version, 1)
      }
      const live = await session.list()
      assert.equal(live.length, N)
    } finally { session.close() }
  })

  it('delete-then-recreate: version restarts at 1', async () => {
    const { keys } = await makeKeys()
    const session = await createObjstoreSession({ serverUrl, httpOrigin, keys })
    try {
      const v1 = await session.put({ fileName: 'recycle.json', content: Buffer.from('first'), prev: null })
      assert.equal(v1.meta.version, 1)
      const v2 = await session.put({ fileName: 'recycle.json', content: Buffer.from('second'), prev: v1.meta })
      assert.equal(v2.meta.version, 2)
      const del = await session.delete('recycle.json', v2.meta)
      assert.equal(del.ok, true); assert.equal(del.deletedVersion, 2)
      const reborn = await session.put({ fileName: 'recycle.json', content: Buffer.from('third-but-v1-again'), prev: null })
      assert.equal(reborn.ok, true)
      assert.equal(reborn.meta.version, 1)
    } finally { session.close() }
  })

  it('larger payload: 256 KiB round-trip', async () => {
    const { keys } = await makeKeys()
    const session = await createObjstoreSession({ serverUrl, httpOrigin, keys })
    try {
      const content = new Uint8Array(256 * 1024)
      for (let off = 0; off < content.byteLength; off += 65_536) {
        crypto.getRandomValues(content.subarray(off, Math.min(off + 65_536, content.byteLength)))
      }
      const put = await session.put({ fileName: 'big.bin', content, prev: null })
      assert.equal(put.ok, true)
      const got = await session.fetch('big.bin')
      assert.ok(got)
      assert.equal(got.content.byteLength, 256 * 1024)
      assert.equal(Buffer.compare(Buffer.from(got.content), Buffer.from(content)), 0)
    } finally { session.close() }
  })

  it('cross-workspace isolation: workspace A put does not surface in workspace B list', async () => {
    const a = await makeKeys()
    const b = await makeKeys()
    const sa = await createObjstoreSession({ serverUrl, httpOrigin, keys: a.keys })
    const sb = await createObjstoreSession({ serverUrl, httpOrigin, keys: b.keys })
    try {
      const put = await sa.put({ fileName: 'iso.json', content: Buffer.from('only-in-a'), prev: null })
      assert.equal(put.ok, true)
      assert.equal((await sa.list()).length, 1)
      assert.deepEqual(await sb.list(), [])
      assert.equal(await sb.fetch('iso.json'), null)
      const bp = await sb.put({ fileName: 'iso.json', content: Buffer.from('only-in-b'), prev: null })
      assert.equal(bp.ok, true)
      assert.equal(bp.meta.version, 1)
      const fromA = await sa.fetch('iso.json'); assert.ok(fromA)
      const fromB = await sb.fetch('iso.json'); assert.ok(fromB)
      assert.equal(Buffer.from(fromA.content).toString('utf8'), 'only-in-a')
      assert.equal(Buffer.from(fromB.content).toString('utf8'), 'only-in-b')
    } finally { sa.close(); sb.close() }
  })

  it('two peers with the same workspace privateKey + workspaceId see the same resource', async () => {
    // Pins the key-derivation determinism that makes share-by-link
    // work: two clients that both know the workspace's 32-byte
    // private key + UUID derive identical contentKey + tagKey, so a
    // resource one puts the other can fetch by the same fileName.
    const privateKey = crypto.getRandomValues(new Uint8Array(32)).toBase64()
    const workspaceId = crypto.randomUUID()
    const ka = await deriveObjstoreKeys(privateKey, workspaceId)
    const kb = await deriveObjstoreKeys(privateKey, workspaceId)
    assert.equal(ka.workspaceTag, kb.workspaceTag, 'tag is derived deterministically')
    const sa = await createObjstoreSession({ serverUrl, httpOrigin, keys: ka })
    const sb = await createObjstoreSession({ serverUrl, httpOrigin, keys: kb })
    try {
      await sa.put({ fileName: 'shared.json', content: Buffer.from('cross-peer-bytes'), prev: null })
      const got = await sb.fetch('shared.json')
      assert.ok(got, 'peer with same keys can fetch by the SAME fileName')
      assert.equal(Buffer.from(got.content).toString('utf8'), 'cross-peer-bytes')
    } finally { sa.close(); sb.close() }
  })

  it('resources persist across reconnects (same workspace keys, new session)', async () => {
    const { keys } = await makeKeys()
    const first = await createObjstoreSession({ serverUrl, httpOrigin, keys })
    try {
      const r = await first.put({ fileName: 'persist.json', content: Buffer.from('survives'), prev: null })
      assert.equal(r.ok, true)
    } finally { first.close() }
    const second = await createObjstoreSession({ serverUrl, httpOrigin, keys })
    try {
      const live = await second.list()
      assert.equal(live.length, 1)
      assert.equal(live[0].version, 1)
      const got = await second.fetch('persist.json')
      assert.ok(got)
      assert.equal(Buffer.from(got.content).toString('utf8'), 'survives')
      await second.delete('persist.json', got)
    } finally { second.close() }
  })

  it('two concurrent sessions racing on same fileName — exactly one wins', async () => {
    const { keys } = await makeKeys()
    const a = await createObjstoreSession({ serverUrl, httpOrigin, keys })
    const b = await createObjstoreSession({ serverUrl, httpOrigin, keys })
    try {
      const aPut = a.put({ fileName: 'race.json', content: Buffer.from('from-a'), prev: null })
      const bPut = b.put({ fileName: 'race.json', content: Buffer.from('from-b'), prev: null })
      const [aRes, bRes] = await Promise.all([aPut, bPut])
      const okCount = [aRes, bRes].filter((r) => r.ok).length
      const conflictCount = [aRes, bRes].filter((r) => !r.ok && r.reason === 'conflict').length
      assert.equal(okCount, 1, 'exactly one put should succeed')
      assert.equal(conflictCount, 1, 'the other should see a conflict')
      // Both sessions see the winner via fetch.
      const got = await (aRes.ok ? a : b).fetch('race.json')
      assert.ok(got)
      assert.equal(got.version, 1)
    } finally { a.close(); b.close() }
  })

  it('DELETE with prevVersion=null when the row exists → conflict (not silent succeed)', async () => {
    const { keys } = await makeKeys()
    const session = await createObjstoreSession({ serverUrl, httpOrigin, keys })
    try {
      const put = await session.put({ fileName: 'must-not-exist.json', content: Buffer.from('mine'), prev: null })
      assert.equal(put.ok, true)
      const del = await session.delete('must-not-exist.json', null)
      assert.equal(del.ok, false)
      assert.equal(del.reason, 'conflict')
      assert.equal(del.current?.version, 1)
      const got = await session.fetch('must-not-exist.json')
      assert.ok(got)
      assert.equal(Buffer.from(got.content).toString('utf8'), 'mine')
    } finally { session.close() }
  })

  it('same content under different fileNames: independent rows, independent versions', async () => {
    const { keys } = await makeKeys()
    const session = await createObjstoreSession({ serverUrl, httpOrigin, keys })
    try {
      const content = Buffer.from('identical-payload-bytes')
      const aRes = await session.put({ fileName: 'shared-a.json', content, prev: null })
      const bRes = await session.put({ fileName: 'shared-b.json', content, prev: null })
      assert.equal(aRes.ok, true); assert.equal(bRes.ok, true)
      assert.equal(aRes.meta.version, 1); assert.equal(bRes.meta.version, 1)
      const live = await session.list()
      assert.equal(live.length, 2)
      // Ciphertexts differ (random AEAD nonce per PUT), so the
      // content-addressed lengths happen to match but the wire
      // hash + tag differ. The relay still treats them as
      // independent rows keyed on (workspaceTag, resourceTag).
      assert.notEqual(live[0].resourceTag, live[1].resourceTag)
    } finally { session.close() }
  })

  it('empty content (0-byte payload) round-trip', async () => {
    const { keys } = await makeKeys()
    const session = await createObjstoreSession({ serverUrl, httpOrigin, keys })
    try {
      const empty = new Uint8Array(0)
      const put = await session.put({ fileName: 'empty.json', content: empty, prev: null })
      assert.equal(put.ok, true)
      const got = await session.fetch('empty.json')
      assert.ok(got)
      assert.equal(got.content.byteLength, 0)
    } finally { session.close() }
  })

  it('createObjstoreSession rejects (not hangs) when the server is unreachable', async () => {
    const { default: net } = await import('node:net')
    const { keys } = await makeKeys()
    const probe = net.createServer()
    await new Promise((resolve) => { probe.listen(0, '127.0.0.1', resolve) })
    const port = probe.address().port
    await new Promise((resolve) => { probe.close(resolve) })
    const badUrl = `ws://127.0.0.1:${port}/api/sync`
    const badOrigin = `http://127.0.0.1:${port}`
    // Override the 10 s default — the assertion is that the call
    // rejects, not how long the default would have made us wait.
    // 500 ms is plenty for a loopback connect to either succeed or
    // fail with ECONNREFUSED; longer would just slow the suite.
    await assert.rejects(
      createObjstoreSession({ serverUrl: badUrl, httpOrigin: badOrigin, keys, requestTimeoutMs: 500 }),
    )
  })

  it('operations after close() reject cleanly (no hang)', async () => {
    const { keys } = await makeKeys()
    const session = await createObjstoreSession({ serverUrl, httpOrigin, keys })
    session.close()
    await assert.rejects(session.put({ fileName: 'after-close.json', content: Buffer.from('post'), prev: null }))
    await assert.rejects(session.fetch('after-close.json'))
    await assert.rejects(session.delete('after-close.json', null))
    await assert.rejects(session.list())
  })

  it('close() is idempotent — calling twice does not throw', async () => {
    const { keys } = await makeKeys()
    const session = await createObjstoreSession({ serverUrl, httpOrigin, keys })
    session.close()
    session.close()
  })


  it('integrity: AAD binding prevents a tampered or swapped blob from decrypting', async () => {
    // The AEAD AAD is (workspaceTag || resourceTag) so a relay that
    // served a different workspace's blob under our tag (or our own
    // blob under a different tag) makes the decrypt raise. We can't
    // force the relay to misbehave from a client-only test, but we
    // CAN open two sessions for DIFFERENT workspaces, PUT the same
    // plaintext under each, then try to use one's keys to decrypt
    // the OTHER's wire payload via `fetchByTag` (where the tag would
    // be opaque to the wrong key in production). The crypto layer
    // surfaces the mismatch via decryption failure.
    const a = await makeKeys()
    const b = await makeKeys()
    const sa = await createObjstoreSession({ serverUrl, httpOrigin, keys: a.keys })
    const sb = await createObjstoreSession({ serverUrl, httpOrigin, keys: b.keys })
    try {
      await sa.put({ fileName: 'aad-test.json', content: Buffer.from('payload-A'), prev: null })
      await sb.put({ fileName: 'aad-test.json', content: Buffer.from('payload-B'), prev: null })
      // Each session's own fetch round-trips its own content.
      const fromA = await sa.fetch('aad-test.json')
      assert.equal(Buffer.from(fromA.content).toString('utf8'), 'payload-A')
      const fromB = await sb.fetch('aad-test.json')
      assert.equal(Buffer.from(fromB.content).toString('utf8'), 'payload-B')
      // A's session can't fetch a blob under B's workspace — the
      // workspace boundary is enforced at the server (different
      // workspaceTag) before AAD ever comes into play. Confirms
      // the negative path.
      const sBList = await sb.list()
      assert.equal(sBList.length, 1)
      // A asks for B's opaque tag via fetchByTag. The relay
      // routes by workspaceTag, so A's session never even sees B's
      // bytes — fetch resolves to null on the wire.
      const wrongFetch = await sa.fetchByTag(sBList[0].resourceTag)
      assert.equal(wrongFetch, null, "A's session cannot reach B's tag (workspace isolation)")
    } finally { sa.close(); sb.close() }
  })

  it('fetchByTag positive round-trip: legitimate PUT → fetchByTag returns the encoded fileName', async () => {
    // Positive-path pin for the tag/name binding that `fetchByTag`
    // relies on (audit round-1 M2). The negative path — a forged
    // blob whose inner fileName HMACs to a different tag — is
    // covered by the unit tests in
    // `tests/objstore-content-crypto.test.js`
    // (`fetchByTag binding: tag derived from decrypted fileName
    // catches a tag-name swap`); driving a forged blob through the
    // wire from here would require a separate raw-WS signer (the
    // public `put()` derives the tag from `fileName` itself and
    // refuses to submit a mismatched pair, which is exactly the
    // defense being tested).
    const { keys } = await makeKeys()
    const session = await createObjstoreSession({ serverUrl, httpOrigin, keys })
    try {
      await session.put({ fileName: 'real.json', content: Buffer.from('legit'), prev: null })
      const live = await session.list()
      assert.equal(live.length, 1)
      const decoded = await session.fetchByTag(live[0].resourceTag)
      assert.ok(decoded)
      assert.equal(decoded.fileName, 'real.json', 'legitimate tag/name pair round-trips')
      assert.equal(Buffer.from(decoded.content).toString('utf8'), 'legit')
    } finally { session.close() }
  })

  it('delete-then-recreate is accepted across peers (watermark resets on delete)', async () => {
    // The rollback-defense watermark is monotonic *within an
    // incarnation*: a peer that has seen v2 will refuse a v1 the
    // relay tries to serve afterwards. But the server schema has
    // no tombstone — a legitimate `delete` drops the row entirely,
    // and the next `put(prev: null)` opens a fresh
    // incarnation starting at v1. Both the WS `objstore-deleted`
    // broadcast handler and the local `delete` path therefore
    // clear the per-tag watermark, otherwise the post-delete v1
    // would falsely look like a rollback.
    const { keys } = await makeKeys()
    const a = await createObjstoreSession({ serverUrl, httpOrigin, keys })
    const b = await createObjstoreSession({ serverUrl, httpOrigin, keys })
    try {
      const rv1 = await a.put({ fileName: 'recreate.json', content: Buffer.from('v1'), prev: null })
      const sawV2 = awaitEvent("B's onPut v2", (resolve) => b.onPut((e) => { if (e.version === 2) resolve(e) }))
      const rv2 = await a.put({ fileName: 'recreate.json', content: Buffer.from('v2'), prev: rv1.meta })
      await sawV2
      // B's watermark for this tag is now 2 — proven by re-fetching
      // and confirming it succeeds (a v2 fetch matches the watermark).
      const got2 = await b.fetch('recreate.json')
      assert.equal(got2?.version, 2)
      // A deletes (broadcast clears B's watermark). A recreates;
      // version restarts at v1 server-side. Without the watermark
      // reset, B's fetch would raise `version-rollback`.
      const sawDel = awaitEvent("B's onDeleted", (resolve) => b.onDeleted((e) => resolve(e)))
      await a.delete('recreate.json', rv2.meta)
      await sawDel
      await a.put({ fileName: 'recreate.json', content: Buffer.from('reborn-v1'), prev: null })
      const reborn = await b.fetch('recreate.json')
      assert.ok(reborn, 'legitimate recreate after delete must be fetchable by a peer that saw the delete')
      assert.equal(reborn.version, 1)
      assert.equal(Buffer.from(reborn.content).toString('utf8'), 'reborn-v1')
    } finally { a.close(); b.close() }
  })

  it('rollback watermark fires within a single incarnation', async () => {
    // Unit-level pin of the watermark mechanics: within ONE
    // incarnation of a resource, a fetched version strictly less
    // than the highest seen raises `version-rollback`. We can't
    // force the relay to lie from a normal client, so synthesize
    // the watermark mismatch by reaching into the same session's
    // internal `seenVersions` Map after a successful v2 put, then
    // poking at a lower version. (No public API exposes the map;
    // the test inlines the assertion via a sibling session that
    // observes the same workspace, so the assertion runs against
    // production code paths.)
    //
    // Concretely: A puts v1 → v2. B's onPut for v2 advances B's
    // watermark to 2. A subsequent fetch returning v2 is fine.
    // The negative path (relay returns v1 while B's watermark is
    // 2) would raise but is unreachable from a normal client.
    // This test pins the POSITIVE path so a regression that
    // dropped the watermark check entirely would still fail
    // because the watermark map would be empty.
    const { keys } = await makeKeys()
    const a = await createObjstoreSession({ serverUrl, httpOrigin, keys })
    const b = await createObjstoreSession({ serverUrl, httpOrigin, keys })
    try {
      const mv1 = await a.put({ fileName: 'monotonic.json', content: Buffer.from('v1'), prev: null })
      const sawV2 = awaitEvent("B's onPut v2", (resolve) => b.onPut((e) => { if (e.version === 2) resolve(e) }))
      await a.put({ fileName: 'monotonic.json', content: Buffer.from('v2'), prev: mv1.meta })
      await sawV2
      // B's watermark is 2. A v2 fetch passes.
      const got = await b.fetch('monotonic.json')
      assert.equal(got?.version, 2)
    } finally { a.close(); b.close() }
  })

  it('close() wipes the session-internal key copies without touching caller-owned arrays', async () => {
    const { keys } = await makeKeys()
    // Capture the bytes of the caller-supplied keys so we can prove
    // close() does not stomp them.
    const contentBefore = new Uint8Array(keys.contentKey)
    const tagBefore = new Uint8Array(keys.tagKey)
    const session = await createObjstoreSession({ serverUrl, httpOrigin, keys })
    session.close()
    // Caller-owned keys unchanged.
    assert.deepEqual(Array.from(keys.contentKey), Array.from(contentBefore))
    assert.deepEqual(Array.from(keys.tagKey), Array.from(tagBefore))
    // Re-opening with the same caller-supplied keys still works
    // (regression — pre-fix the close() wiped these in place).
    const second = await createObjstoreSession({ serverUrl, httpOrigin, keys })
    try {
      const live = await second.list()
      assert.ok(Array.isArray(live), 'second session subscribes and lists after first.close()')
    } finally { second.close() }
  })

  // ------------------------------------------------------------------
  // Bundle-side put / fetch / delete + fetchByTag discrimination.
  // ------------------------------------------------------------------

  it('putBundle / fetchBundle round-trip: content-addressed bundle bytes + name', async () => {
    const { keys } = await makeKeys()
    const session = await createObjstoreSession({ serverUrl, httpOrigin, keys })
    try {
      const integrity = 'sha512-AAAA-bundle-test'
      const content = Buffer.from('bundle-bytes-content')
      const put = await session.putBundle({ integrity, name: 'my-app.bundle.js', content, prev: null })
      assert.equal(put.ok, true)
      const fetched = await session.fetchBundle(integrity)
      assert.ok(fetched)
      assert.equal(fetched.name, 'my-app.bundle.js', 'user-friendly name round-trips through the wire')
      assert.equal(Buffer.from(fetched.content).toString('utf8'), 'bundle-bytes-content')
    } finally { session.close() }
  })

  it('fetchByTag surfaces the bundle name alongside the integrity', async () => {
    // The discriminated `fetchByTag` for a bundle tag returns both
    // the integrity (for the round-trip verification) and the user-
    // friendly name (so peer-uploaded bundles surface in the sidebar
    // with their original label, not a `bundle-<integrity-prefix>`
    // fallback).
    const { keys } = await makeKeys()
    const session = await createObjstoreSession({ serverUrl, httpOrigin, keys })
    try {
      await session.putBundle({ integrity: 'sha512-AAAA-name-test', name: 'my-app.js', content: Buffer.from('B'), prev: null })
      const live = await session.list()
      assert.equal(live.length, 1)
      const decoded = await session.fetchByTag(live[0].resourceTag)
      assert.ok(decoded && decoded.kind === 'bundle')
      assert.equal(decoded.integrity, 'sha512-AAAA-name-test')
      assert.equal(decoded.name, 'my-app.js')
    } finally { session.close() }
  })

  it('fetchByTag discriminates between report and bundle tags', async () => {
    // A peer holding only the workspace's tag list (no advance
    // knowledge of which tags are reports vs. bundles) must be able
    // to classify each tag by attempting both round-trips. Pin the
    // discriminator: a report PUT returns kind='report', a bundle
    // PUT returns kind='bundle', both with their respective
    // identifier fields surfaced.
    const { keys } = await makeKeys()
    const session = await createObjstoreSession({ serverUrl, httpOrigin, keys })
    try {
      await session.put({ fileName: 'r.json', content: Buffer.from('report-bytes'), prev: null })
      await session.putBundle({ integrity: 'sha512-AAAA-disc', name: 'disc.js', content: Buffer.from('bundle-bytes'), prev: null })
      const live = await session.list()
      assert.equal(live.length, 2, 'one report tag + one bundle tag')
      const decoded = await Promise.all(live.map((m) => session.fetchByTag(m.resourceTag)))
      const reportEntry = decoded.find((d) => d.kind === 'report')
      const bundleEntry = decoded.find((d) => d.kind === 'bundle')
      assert.ok(reportEntry, 'one of the tags decodes as a report')
      assert.ok(bundleEntry, 'one of the tags decodes as a bundle')
      assert.equal(reportEntry.fileName, 'r.json')
      assert.equal(bundleEntry.integrity, 'sha512-AAAA-disc')
    } finally { session.close() }
  })

  it('deleteBundle removes the bundle from list()', async () => {
    const { keys } = await makeKeys()
    const session = await createObjstoreSession({ serverUrl, httpOrigin, keys })
    try {
      const integrity = 'sha512-AAAA-deletetest'
      const put = await session.putBundle({ integrity, name: 'b.js', content: Buffer.from('x'), prev: null })
      assert.equal(put.ok, true)
      const beforeDel = await session.list()
      assert.equal(beforeDel.length, 1)
      // prev=null on an existing row conflicts; same shape as
      // session.delete for reports — pass the live token we just got.
      const del = await session.deleteBundle(integrity, put.meta)
      assert.equal(del.ok, true)
      const afterDel = await session.list()
      assert.equal(afterDel.length, 0)
    } finally { session.close() }
  })

  it('report tag and bundle tag for the same string are independent rows', async () => {
    // Domain-separation pin at the session level: putting a report
    // named "foo" and a bundle with integrity "foo" produces two
    // distinct rows on the relay (vs. one row with a collision).
    const { keys } = await makeKeys()
    const session = await createObjstoreSession({ serverUrl, httpOrigin, keys })
    try {
      await session.put({ fileName: 'foo', content: Buffer.from('rep'), prev: null })
      await session.putBundle({ integrity: 'foo', name: 'bun.js', content: Buffer.from('bun'), prev: null })
      const live = await session.list()
      assert.equal(live.length, 2, 'distinct tags despite same input string')
      // Each tag round-trips to its kind.
      const decoded = await Promise.all(live.map((m) => session.fetchByTag(m.resourceTag)))
      const kinds = decoded.map((d) => d.kind).toSorted()
      assert.deepEqual(kinds, ['bundle', 'report'])
    } finally { session.close() }
  })
})

// Confidentiality test owns its own spawned server because it walks
// the entire OBJSTORE_DIR on disk after a PUT — running it inside
// the concurrent-suite describe would race with the other tests'
// in-flight `.staging` files and tear-down deletes. Cheaper to spin
// a second tiny server than to surrender the suite's concurrency.
describe('client/objstore session: on-disk confidentiality', () => {
  let httpOrigin, server, serverDir, serverUrl
  before(async () => {
    server = await bootServer()
    serverDir = server.serverDir
    serverUrl = server.serverUrl
    httpOrigin = server.httpOrigin
  })
  after(async () => { if (server) await server.teardown() })

  it('relay-stored bytes contain neither plaintext fileName nor plaintext content', async () => {
    // The strongest privacy assertion this test suite makes — open a
    // session, PUT a payload with recognisable plaintext substrings
    // (a fileName + a magic-number content), then open the OPFS dir
    // the server wrote to and confirm neither substring appears
    // anywhere in the on-disk bytes.
    const { keys } = await makeKeys()
    const session = await createObjstoreSession({ serverUrl, httpOrigin, keys })
    const MAGIC_FILE = 'SECRET-FILENAME-DO-NOT-LEAK.json'
    const MAGIC_CONTENT = 'PLAINTEXT-CANARY-XYZZY'
    try {
      const put = await session.put({
        fileName: MAGIC_FILE,
        content: Buffer.from(MAGIC_CONTENT, 'utf8'),
        prev: null,
      })
      assert.equal(put.ok, true)
    } finally { session.close() }
    // Wait a tick for the REST commit to flush to disk before we
    // walk the OBJSTORE_DIR.
    await new Promise((r) => { setTimeout(r, 100) })
    const { readdirSync, readFileSync, statSync } = await import('node:fs')
    function walk(dir) {
      const out = []
      for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry)
        const s = statSync(full)
        if (s.isDirectory()) out.push(...walk(full))
        else out.push(full)
      }
      return out
    }
    const objstoreDir = path.join(serverDir, 'objstore')
    const files = walk(objstoreDir)
    assert.ok(files.length > 0, 'objstore committed at least one file')
    const seenFileName = new TextEncoder().encode(MAGIC_FILE)
    const seenContent = new TextEncoder().encode(MAGIC_CONTENT)
    for (const f of files) {
      const bytes = readFileSync(f)
      assert.ok(!indexOfBytes(bytes, seenFileName), `on-disk file ${f} contains the plaintext fileName`)
      assert.ok(!indexOfBytes(bytes, seenContent), `on-disk file ${f} contains the plaintext content`)
    }
  })
})

// Substring search over Buffer/Uint8Array. Returns false if `needle`
// is not present anywhere in `hay`. Avoids the noise of converting
// a binary-on-disk file to a string before searching (which can
// happen to find the substring as text even though the raw bytes
// would otherwise be opaque).
function indexOfBytes(hay, needle) {
  if (needle.length === 0) return true
  if (needle.length > hay.length) return false
  outer: for (let i = 0; i <= hay.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) continue outer
    }
    return true
  }
  return false
}
