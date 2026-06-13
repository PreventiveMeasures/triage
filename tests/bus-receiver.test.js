// End-to-end coverage of the cross-instance bus RECEIVER path
// (`server-e2e/bus-receiver.ts`). The pubsub tests in `tests/pubsub.test.js`
// exercise parse / dispatch / self-filter on the wire (PGlite is
// single-connection so they can't reproduce genuine multi-replica
// A→B); this file fills the gap by driving the receiver directly
// against a real (PGlite-backed Neon) DB + real objstore + a fake
// subscriber socket. Pins:
//   - workspace_revision row → wire `workspace-state` shape (incl. the
//     INTEGER→strict-boolean keyframe coercion).
//   - workspace_object row → wire `objstore-put` shape via
//     `objectMetaWire` (the server-only `putAt` column MUST NOT leak).
//   - `objstore-deleted` carries inline (tag, resourceTag, version) —
//     no DB read.
//   - Missing-row paths (rev id unknown, objput resourceTag absent)
//     drop silently — no broadcast.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Buffer } from 'node:buffer'

import { createHub } from '../server-e2e/hub.ts'
import { commitRevision } from '../server-e2e/db.ts'
import { createBusReceiver } from '../server-e2e/bus-receiver.ts'
import { beginPut, commitPut } from '../server-e2e/objstore/store.ts'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { freshNeonDb, freshNeonObjstore } from './_neon-pglite.js'

// Helpers ---------------------------------------------------------

// Fake WebSocket subscriber. The hub only touches `readyState`,
// `bufferedAmount`, `send`, `terminate`, and the `OPEN` constant; the
// rest of the ws surface is irrelevant.
function fakeSocket() {
  return {
    readyState: 1, // OPEN
    OPEN: 1,
    bufferedAmount: 0,
    sent: [],
    send(payload) { this.sent.push(payload) },
    terminate() {},
  }
}

// Hub-with-one-fake-subscriber helper. The bus receiver calls only
// `broadcastLocalRaw` (no `peers` lookup), so we need just enough
// PeerRegistry state for `hub.subscribe(socket, tag)` to register the
// reverse index without throwing — a single Peer with an empty `tags`
// Set, attached via the WeakMap constructor's initial-entries form to
// satisfy unicorn(no-immediate-mutation).
function makeHubWithSub(tag) {
  const sock = fakeSocket()
  const peers = new WeakMap([[sock, { tags: new Set() }]])
  const hub = createHub({ peers, maxBufferedBytes: 16 * 1024 * 1024, debug: false })
  hub.subscribe(sock, tag)
  return { hub, sock }
}

// Drop a blob into the staging dir + commit a live row, so getLive
// returns a real row. The commitPut requires actual bytes on disk —
// not a content-addressed lookup we can shortcut.
async function commitObjPut(objHandle, objDir, tag, resTag, body) {
  const expectedLength = body.length
  const contentHash = createHash('sha256').update(body).digest('base64url')
  const begin = await beginPut(objHandle, {
    workspaceTag: tag, resourceTag: resTag, prevVersion: null, prevIncarnation: null,
    expectedLength, contentHash, signature: 'a'.repeat(86),
  })
  assert.equal(begin.ok, true)
  const stagingDir = path.join(objDir, tag, '.staging')
  writeFileSync(path.join(stagingDir, `${begin.stagingId}.bin`), body)
  const result = await commitPut(objHandle, {
    workspaceTag: tag, resourceTag: resTag, stagingId: begin.stagingId, observedSize: expectedLength,
  })
  assert.equal(result.ok, true)
  return result.row
}

// Tests -----------------------------------------------------------

describe('bus-receiver — workspace-state branch (`rev`)', () => {
  it('SELECTs the revision and broadcasts a wire-shape workspace-state', async () => {
    const { handle, cleanup } = await freshNeonDb()
    try {
      // Land a non-keyframe revision so the wire-side strict-boolean
      // coercion turns the stored INTEGER 0 into `false`.
      await commitRevision(handle, {
        tag: 'tag-A', id: 'rev-1', base: null, keyframe: false,
        nonce: 'nonce-x', ciphertext: 'ct-x', signature: 'sig-x',
      })
      const { hub, sock } = makeHubWithSub('tag-A')
      const onBusMessage = createBusReceiver({
        handle,
        // The objstore handle isn't reached by the rev branch — pass a
        // minimal stub so an accidental call surfaces as a TypeError.
        objstoreHandle: /** @type {never} */ ({}),
        broadcastLocalRaw: hub.broadcastLocalRaw,
        debug: false,
      })
      await onBusMessage({ kind: 'rev', tag: 'tag-A', id: 'rev-1' })
      assert.equal(sock.sent.length, 1, 'exactly one broadcast frame')
      const wire = JSON.parse(sock.sent[0])
      assert.equal(wire.type, 'workspace-state')
      assert.equal(wire.workspaceTag, 'tag-A')
      assert.equal(wire.revisions.length, 1)
      // Strict boolean — the regression the docstring warns about
      // (DB stores INTEGER 0/1, wire must be `=== true`).
      assert.equal(wire.revisions[0].keyframe, false)
      assert.equal(typeof wire.revisions[0].keyframe, 'boolean')
      assert.equal(wire.revisions[0].id, 'rev-1')
      assert.equal(wire.revisions[0].nonce, 'nonce-x')
      assert.equal(wire.revisions[0].ciphertext, 'ct-x')
      assert.equal(wire.revisions[0].signature, 'sig-x')
    } finally { await cleanup() }
  })

  it('keyframe stored as INTEGER 1 round-trips as strict-true `true` on the wire', async () => {
    const { handle, cleanup } = await freshNeonDb()
    try {
      await commitRevision(handle, {
        tag: 'tag-K', id: 'rev-kf', base: null, keyframe: true,
        nonce: 'n', ciphertext: 'c', signature: 's',
      })
      const { hub, sock } = makeHubWithSub('tag-K')
      const onBusMessage = createBusReceiver({
        handle, objstoreHandle: /** @type {never} */ ({}),
        broadcastLocalRaw: hub.broadcastLocalRaw, debug: false,
      })
      await onBusMessage({ kind: 'rev', tag: 'tag-K', id: 'rev-kf' })
      const wire = JSON.parse(sock.sent[0])
      assert.equal(wire.revisions[0].keyframe, true)
      assert.equal(typeof wire.revisions[0].keyframe, 'boolean')
    } finally { await cleanup() }
  })

  it('drops the broadcast silently when the revision id is unknown', async () => {
    const { handle, cleanup } = await freshNeonDb()
    try {
      const { hub, sock } = makeHubWithSub('tag-X')
      const onBusMessage = createBusReceiver({
        handle, objstoreHandle: /** @type {never} */ ({}),
        broadcastLocalRaw: hub.broadcastLocalRaw, debug: false,
      })
      // No revision committed → SELECT returns undefined → no broadcast.
      await onBusMessage({ kind: 'rev', tag: 'tag-X', id: 'nope' })
      assert.equal(sock.sent.length, 0)
    } finally { await cleanup() }
  })
})

describe('bus-receiver — objstore-put branch (`objput`)', () => {
  it("re-fetches the live row and broadcasts via `objectMetaWire` (no `putAt` leak)", async () => {
    const { handle: objHandle, objDir, cleanup } = await freshNeonObjstore()
    try {
      const row = await commitObjPut(objHandle, objDir, 'tag-A', 'res-1', Buffer.from('hello'))
      const { hub, sock } = makeHubWithSub('tag-A')
      const onBusMessage = createBusReceiver({
        handle: /** @type {never} */ ({}),
        objstoreHandle: objHandle,
        broadcastLocalRaw: hub.broadcastLocalRaw, debug: false,
      })
      await onBusMessage({ kind: 'objput', tag: 'tag-A', res: 'res-1' })
      assert.equal(sock.sent.length, 1)
      const wire = JSON.parse(sock.sent[0])
      assert.equal(wire.type, 'objstore-put')
      assert.equal(wire.workspaceTag, 'tag-A')
      assert.equal(wire.resourceTag, 'res-1')
      assert.equal(wire.version, row.version)
      assert.equal(wire.incarnation, row.incarnation)
      assert.equal(wire.contentHash, row.contentHash)
      assert.equal(wire.contentLength, row.contentLength)
      assert.equal(wire.signature, row.signature)
      // putAt is a server-only debug column — `objectMetaWire` strips
      // it. A regression that forwarded `row.putAt` would surface here.
      assert.equal(Object.prototype.hasOwnProperty.call(wire, 'putAt'), false, 'putAt must not leak to the wire')
    } finally { await cleanup() }
  })

  it("broadcasts the CURRENT live version even if the NOTIFY referred to an older one (two close-spaced puts)", async () => {
    // Two puts arrive in quick succession; both NOTIFYs land at the
    // receiver, but `getLive` shows v2 by the time either is processed.
    // The receiver broadcasts v2 twice — sound because the client's
    // putHandlers are already idempotent on (resourceTag, version)
    // (mirroring the same-instance `except: null` echo path in rest.ts).
    const { handle: objHandle, objDir, cleanup } = await freshNeonObjstore()
    try {
      await commitObjPut(objHandle, objDir, 'tag-A', 'res-rapid', Buffer.from('v1'))
      // Re-upload bumps to v2.
      const begin = await beginPut(objHandle, {
        workspaceTag: 'tag-A', resourceTag: 'res-rapid', prevVersion: 1,
        prevIncarnation: (await objHandle.selectLiveOne.get('tag-A', 'res-rapid')).incarnation,
        expectedLength: 2,
        contentHash: createHash('sha256').update(Buffer.from('v2')).digest('base64url'),
        signature: 'a'.repeat(86),
      })
      assert.equal(begin.ok, true)
      const stagingDir = path.join(objDir, 'tag-A', '.staging')
      writeFileSync(path.join(stagingDir, `${begin.stagingId}.bin`), 'v2')
      const result = await commitPut(objHandle, {
        workspaceTag: 'tag-A', resourceTag: 'res-rapid', stagingId: begin.stagingId, observedSize: 2,
      })
      assert.equal(result.ok, true)
      assert.equal(result.row.version, 2)
      const { hub, sock } = makeHubWithSub('tag-A')
      const onBusMessage = createBusReceiver({
        handle: /** @type {never} */ ({}), objstoreHandle: objHandle,
        broadcastLocalRaw: hub.broadcastLocalRaw, debug: false,
      })
      // Both bus messages broadcast the CURRENT v2 row.
      await onBusMessage({ kind: 'objput', tag: 'tag-A', res: 'res-rapid' })
      await onBusMessage({ kind: 'objput', tag: 'tag-A', res: 'res-rapid' })
      assert.equal(sock.sent.length, 2)
      for (const frame of sock.sent) {
        const wire = JSON.parse(frame)
        assert.equal(wire.version, 2)
      }
    } finally { await cleanup() }
  })

  it('drops the broadcast silently when the live row is absent (put → delete sequence)', async () => {
    const { handle: objHandle, cleanup } = await freshNeonObjstore()
    try {
      const { hub, sock } = makeHubWithSub('tag-A')
      const onBusMessage = createBusReceiver({
        handle: /** @type {never} */ ({}), objstoreHandle: objHandle,
        broadcastLocalRaw: hub.broadcastLocalRaw, debug: false,
      })
      // No row committed → getLive returns null → no broadcast.
      await onBusMessage({ kind: 'objput', tag: 'tag-A', res: 'missing' })
      assert.equal(sock.sent.length, 0)
    } finally { await cleanup() }
  })
})

describe('bus-receiver — objstore-deleted branch (`objdel`)', () => {
  it('broadcasts (tag, resourceTag, version) inline without a DB lookup', async () => {
    const { hub, sock } = makeHubWithSub('tag-A')
    let lookupCalled = false
    const objHandle = {
      selectLiveOne: { get: () => { lookupCalled = true; return Promise.resolve(undefined) } },
    }
    const onBusMessage = createBusReceiver({
      handle: /** @type {never} */ ({}),
      objstoreHandle: /** @type {never} */ (objHandle),
      broadcastLocalRaw: hub.broadcastLocalRaw, debug: false,
    })
    await onBusMessage({ kind: 'objdel', tag: 'tag-A', res: 'res-d', ver: 7 })
    assert.equal(sock.sent.length, 1)
    const wire = JSON.parse(sock.sent[0])
    assert.deepEqual(wire, {
      type: 'objstore-deleted', workspaceTag: 'tag-A', resourceTag: 'res-d', version: 7,
    })
    assert.equal(lookupCalled, false, 'objdel must NOT hit the objstore — the bus payload IS the wire data')
  })
})
