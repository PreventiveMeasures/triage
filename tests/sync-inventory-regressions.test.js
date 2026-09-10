import './_polyfills.js'
import assert from 'node:assert/strict'
import { it } from 'node:test'
import { createObjstoreClient, deriveObjstoreKeys } from '../client/sync/objstore.ts'
import { createSyncHandlers } from '../server-e2e/sync-handlers.ts'
import { openDb } from '../server-e2e/db.ts'
import { signSubscribePayload } from '../client/sync/sync-crypto.ts'
import { createHub } from '../server-e2e/hub.ts'
import { createBusReceiver } from '../server-e2e/bus-receiver.ts'
import { Peer } from '../server-e2e/peer.ts'
import { computeResourceTag, encryptObjstorePayload } from '../client/sync/objstore-content-crypto.ts'
import { computeContentHash } from '../client/sync/objstore-crypto.ts'

function keys() {
  return deriveObjstoreKeys(crypto.getRandomValues(new Uint8Array(32)).toBase64(), crypto.randomUUID())
}

function meta(resourceTag, version = 1) {
  return { resourceTag, version, incarnation: 'incarnation', contentHash: 'hash', contentLength: 100, signature: 'signature' }
}

it('a scoped delete broadcast still notifies after its own acknowledgment cleared the inventory', async () => {
  const k = await keys()
  const resourceTag = await computeResourceTag(k.tagKey, 'report.json')
  let consumer
  const transport = {
    addConsumer(c) { consumer = c; return { remove() {} } },
    acquire: () => ({ release() {} }), getNonce: () => 'nonce', isSse: () => false,
    send(msg) {
      assert.equal(msg.type, 'objstore-delete')
      consumer.onMessage({ type: 'objstore-deleted-ack', workspaceTag: k.workspaceTag, resourceTag, deletedVersion: 1 })
      return true
    },
  }
  const client = createObjstoreClient({ serverUrl: '', httpOrigin: 'http://127.0.0.1', transport })
  try {
    const session = await client.openWorkspace(k, { workspaceId: 'test', workspaceTag: k.workspaceTag, resources: Promise.resolve([meta(resourceTag)]) })
    await session.list()
    const events = []
    session.onDeleted((event) => events.push(event))
    assert.equal((await session.delete('report.json', meta(resourceTag))).ok, true)
    assert.deepEqual(await session.list(), [], 'acknowledgment already cleared the inventory')
    consumer.onMessage({ type: 'objstore-deleted', workspaceTag: k.workspaceTag, resourceTag, version: 1, incarnation: 'incarnation' })
    assert.deepEqual(events, [{ resourceTag, version: 1 }], 'the delayed echo still reaches presence listeners')
  } finally { client.close() }
})

for (const timing of ['after recreation', 'buffered before recreation']) {
  it(`a delayed delete ${timing} cannot remove a recreated snapshot entry`, async () => {
    const k = await keys()
    let consumer
    const transport = {
      addConsumer(c) { consumer = c; return { remove() {} } },
      acquire: () => ({ release() {} }), getNonce: () => 'nonce',
    }
    const client = createObjstoreClient({ serverUrl: '', httpOrigin: 'http://127.0.0.1', transport })
    const socket = { OPEN: 1, readyState: 1, bufferedAmount: 0, send: (payload) => consumer.onMessage(JSON.parse(payload)) }
    const hub = createHub({ peers: new WeakMap(), maxBufferedBytes: 10000, debug: false })
    hub.subscribe(socket, k.workspaceTag)
    const onBusMessage = createBusReceiver({ handle: {}, objstoreHandle: {}, broadcastLocalRaw: hub.broadcastLocalRaw, debug: false })
    try {
      const session = await client.openWorkspace(k, { workspaceId: 'test', workspaceTag: k.workspaceTag, resources: Promise.resolve([meta('resource', 7)]) })
      await session.list()
      const changes = []
      session.onDeleted((event) => changes.push(event))
      const release = hub.pauseBroadcasts(socket)
      const deleted = { kind: 'objdel', tag: k.workspaceTag, res: 'resource', ver: 7, incarnation: 'incarnation' }
      if (timing === 'buffered before recreation') await onBusMessage(deleted)
      const recreated = { ...meta('resource'), incarnation: 'recreated' }
      hub.send(socket, { type: 'workspace-subscribed', workspaceTag: k.workspaceTag, resources: [recreated] })
      assert.equal(changes.length, 1, 'recreation emits the old-lineage deletion once')
      changes.length = 0
      release()
      if (timing === 'after recreation') await onBusMessage(deleted)
      assert.deepEqual(await session.list(), [{ resourceTag: 'resource', version: 1, incarnation: 'recreated', contentLength: 100 }])
      assert.deepEqual(changes, [], 'stale tombstone must not clear current presence')
      await onBusMessage({ ...deleted, ver: 1, incarnation: 'recreated' })
      assert.deepEqual(await session.list(), [], 'the current incarnation can still be deleted')
      assert.equal(changes.length, 1)
    } finally { client.close() }
  })
}

it('refreshes objstore inventory after reconnect and does not let the initial token overwrite a newer snapshot', async () => {
  const k = await keys()
  let consumer
  let resolveInitial
  const resources = new Promise((resolve) => { resolveInitial = resolve })
  const transport = {
    addConsumer(c) { consumer = c; return { remove() {} } },
    acquire: () => ({ release() {} }),
    getNonce: () => 'nonce',
  }
  const client = createObjstoreClient({ serverUrl: '', httpOrigin: 'http://127.0.0.1', transport })
  try {
    const session = await client.openWorkspace(k, { workspaceId: 'test', workspaceTag: k.workspaceTag, resources })
    const snapshot = (rows) => consumer.onMessage({ type: 'workspace-subscribed', workspaceTag: k.workspaceTag, resources: rows })
    snapshot([meta('current', 2)])
    // The token is delivered via triage-sync's async queue; a later wire
    // snapshot can already have arrived when its first promise resolves.
    resolveInitial([meta('obsolete')])
    assert.deepEqual((await session.list()).map((m) => m.resourceTag), ['current'])
    const changes = []
    session.onPut((m) => changes.push(['put', m.resourceTag]))
    session.onDeleted((m) => changes.push(['delete', m.resourceTag]))
    consumer.onDisconnected('reconnect')
    consumer.onConnected('new nonce')
    snapshot([meta('added-while-offline')])
    assert.deepEqual((await session.list()).map((m) => m.resourceTag), ['added-while-offline'])
    snapshot([])
    assert.deepEqual(await session.list(), [])
    assert.deepEqual(changes, [['delete', 'current'], ['put', 'added-while-offline'], ['delete', 'added-while-offline']])
  } finally { client.close() }
})

for (const failure of ['inventory', 'chain']) {
  it(`a failed ${failure} lookup closes the subscription without acknowledging an incomplete snapshot`, async () => {
    const k = await keys()
    const handle = openDb(':memory:')
    if (failure === 'chain') handle.chainAll.all = () => Promise.reject(new Error('temporary database failure'))
    const messages = []
    const socket = { OPEN: 1, readyState: 1, close() { this.readyState = 3 } }
    const handlers = createSyncHandlers({
      handle,
      send: (_socket, msg) => messages.push(msg),
      broadcast() {}, publishRevision() {}, subscribe() {},
      pauseBroadcasts: () => () => {},
      getNonce: () => 'nonce', requiresAuth: () => false,
      passwordConfigured: false, sendUnauthorized() {},
      workspaceExists: () => Promise.resolve(true),
      objstoreResources: () => failure === 'inventory' ? Promise.reject(new Error('temporary database failure')) : Promise.resolve([]),
      debug: false,
    })
    try {
      const signature = await signSubscribePayload(k.signingKey, k.workspaceTag, null, 'nonce')
      await handlers.handleSubscribe(socket, { workspaceTag: k.workspaceTag, from: null, signature })
      assert.equal(messages.some((m) => m.type === 'workspace-subscribed'), false, 'failure is not a deletion snapshot')
      assert.equal(socket.readyState, 3, 'reconnect retries the failed handshake')
    } finally { await handle.close() }
  })
}

it('does not roll inventory backwards on delayed puts and reports recreation to presence consumers', async () => {
  const k = await keys()
  let consumer
  const transport = {
    addConsumer(c) { consumer = c; return { remove() {} } },
    acquire: () => ({ release() {} }), getNonce: () => 'nonce',
  }
  const client = createObjstoreClient({ serverUrl: '', httpOrigin: 'http://127.0.0.1', transport })
  try {
    const session = await client.openWorkspace(k, { workspaceId: 'test', workspaceTag: k.workspaceTag, resources: Promise.resolve([meta('resource', 3)]) })
    await session.list()
    const changes = []
    session.onPut((m) => changes.push(['put', m.resourceTag, m.version]))
    session.onDeleted((m) => changes.push(['delete', m.resourceTag, m.version]))
    consumer.onMessage({ type: 'objstore-put', workspaceTag: k.workspaceTag, ...meta('resource', 2) })
    assert.equal((await session.list())[0].version, 3, 'older broadcast cannot undo a newer snapshot')
    assert.deepEqual(changes, [], 'stale put does not trigger a replacement')
    consumer.onMessage({ type: 'workspace-subscribed', workspaceTag: k.workspaceTag, resources: [{ ...meta('resource'), incarnation: 'new-incarnation' }] })
    assert.deepEqual(changes, [['delete', 'resource', 3], ['put', 'resource', 1]], 'presence must reset its version floor across recreation')
  } finally { client.close() }
})

for (const newerSource of ['snapshot', 'broadcast']) {
  it(`keeps newer inventory from a ${newerSource} when an older snapshot arrives later`, async () => {
    const k = await keys()
    let consumer
    const transport = {
      addConsumer(c) { consumer = c; return { remove() {} } },
      acquire: () => ({ release() {} }), getNonce: () => 'nonce',
    }
    const client = createObjstoreClient({ serverUrl: '', httpOrigin: 'http://127.0.0.1', transport })
    try {
      const session = await client.openWorkspace(k, { workspaceId: 'test', workspaceTag: k.workspaceTag, resources: Promise.resolve([meta('resource')]) })
      await session.list()
      const changes = []
      session.onPut((event) => changes.push(event))
      const snapshot = (row) => consumer.onMessage({ type: 'workspace-subscribed', workspaceTag: k.workspaceTag, resources: [row] })
      const newer = { ...meta('resource', 5), contentLength: 500 }
      if (newerSource === 'snapshot') snapshot(newer)
      else consumer.onMessage({ type: 'objstore-put', workspaceTag: k.workspaceTag, ...newer })
      // An earlier subscription query completes after the newer update.
      snapshot({ ...meta('resource', 3), contentLength: 300 })
      assert.deepEqual(await session.list(), [{ resourceTag: 'resource', version: 5, incarnation: newer.incarnation, contentLength: 500 }])
      assert.deepEqual(changes, [{ resourceTag: 'resource', version: 5, contentLength: 500 }], 'no stale replacement event')
      snapshot({ ...meta('resource', 6), contentLength: 600 })
      assert.equal((await session.list())[0].version, 6, 'newer snapshots still advance the inventory')
      assert.deepEqual(changes.at(-1), { resourceTag: 'resource', version: 6, contentLength: 600 })
    } finally { client.close() }
  })
}

it('reconnect snapshots and delayed puts cannot lower the fetch rollback watermark', async (t) => {
  const k = await keys()
  const resourceTag = await computeResourceTag(k.tagKey, 'report.md')
  const bytes = encryptObjstorePayload(k.contentKey, 'report.md', new TextEncoder().encode('old content'), k.workspaceTag, resourceTag)
  const oldMeta = { ...meta(resourceTag, 2), contentLength: bytes.length, contentHash: await computeContentHash(bytes) }
  let consumer
  const transport = {
    addConsumer(c) { consumer = c; return { remove() {} } },
    acquire: () => ({ release() {} }), getNonce: () => 'nonce', isSse: () => false,
    send(msg) {
      assert.equal(msg.type, 'objstore-fetch')
      consumer.onMessage({ type: 'objstore-fetch-token', workspaceTag: k.workspaceTag, ...oldMeta, urlPath: `/api/objstore/${k.workspaceTag}/${resourceTag}`, token: 'token' })
      return true
    },
  }
  t.mock.method(globalThis, 'fetch', () => Promise.resolve(new Response(bytes)))
  const client = createObjstoreClient({ serverUrl: '', httpOrigin: 'http://127.0.0.1', transport })
  try {
    const session = await client.openWorkspace(k, { workspaceId: 'test', workspaceTag: k.workspaceTag, resources: Promise.resolve([meta(resourceTag, 5)]) })
    await session.list()
    consumer.onMessage({ type: 'workspace-subscribed', workspaceTag: k.workspaceTag, resources: [meta(resourceTag, 3)] })
    consumer.onMessage({ type: 'objstore-put', workspaceTag: k.workspaceTag, ...oldMeta })
    await assert.rejects(session.fetch('report.md'), /version-rollback/u)
  } finally { client.close() }
})

it('delivers a subscription snapshot before broadcasts committed during its lookup', async () => {
  const k = await keys()
  const handle = openDb(':memory:')
  const messages = []
  const socket = { OPEN: 1, readyState: 1, bufferedAmount: 0, send: (s) => messages.push(JSON.parse(s)) }
  const peers = new WeakMap([[socket, new Peer('nonce')]])
  const hub = createHub({ peers, maxBufferedBytes: 10000, debug: false })
  const inventoryRead = Promise.withResolvers()
  const reading = Promise.withResolvers()
  const handlers = createSyncHandlers({
    handle, ...hub, publishRevision() {},
    getNonce: () => 'nonce', requiresAuth: () => false,
    passwordConfigured: false, sendUnauthorized() {},
    workspaceExists: () => Promise.resolve(true),
    objstoreResources: () => { reading.resolve(); return inventoryRead.promise },
    debug: false,
  })
  try {
    const signature = await signSubscribePayload(k.signingKey, k.workspaceTag, null, 'nonce')
    const subscribing = handlers.handleSubscribe(socket, { workspaceTag: k.workspaceTag, from: null, signature })
    await reading.promise
    hub.broadcast(k.workspaceTag, { type: 'objstore-put', ...meta('new-resource') }, null)
    hub.broadcastLocalRaw(k.workspaceTag, JSON.stringify({ type: 'objstore-deleted', resourceTag: 'old-resource', version: 1 }))
    inventoryRead.resolve([meta('old-resource')])
    await subscribing
    assert.deepEqual(messages.map((m) => m.type), ['workspace-subscribed', 'workspace-state', 'objstore-put', 'objstore-deleted'])
  } finally { await handle.close() }
})

it('bounds broadcasts buffered across overlapping subscription snapshots', () => {
  const peers = new WeakMap()
  let terminated = false
  const messages = []
  const socket = {
    OPEN: 1, readyState: 1, bufferedAmount: 0,
    send: (s) => messages.push(s),
    terminate() { terminated = true; this.readyState = 3 },
  }
  peers.set(socket, new Peer('nonce'))
  const hub = createHub({ peers, maxBufferedBytes: 30, debug: false })
  hub.subscribe(socket, 'tag')
  const release1 = hub.pauseBroadcasts(socket)
  const release2 = hub.pauseBroadcasts(socket)
  hub.broadcast('tag', { type: 'small' }, null)
  release1()
  assert.equal(messages.length, 0, 'other snapshot is still pending')
  hub.broadcast('tag', { payload: 'x'.repeat(100) }, null)
  release2()
  assert.equal(terminated, true)
  assert.equal(messages.length, 0, 'no delivery past close')
})

for (const outcome of ['recreated', 'deleted', 'failed']) {
  it(`discards an older subscription lookup after a newer ${outcome === 'failed' ? 'successful' : outcome} snapshot`, async () => {
    const k = await keys()
    const handle = openDb(':memory:')
    const messages = []
    const socket = { OPEN: 1, readyState: 1, bufferedAmount: 0, send: (s) => messages.push(JSON.parse(s)), close() { this.readyState = 3 } }
    const peers = new WeakMap([[socket, new Peer('nonce')]])
    const hub = createHub({ peers, maxBufferedBytes: 10000, debug: false })
    const reads = [Promise.withResolvers(), Promise.withResolvers()]
    const entered = [Promise.withResolvers(), Promise.withResolvers()]
    let n = 0
    const handlers = createSyncHandlers({
      handle, ...hub, publishRevision() {},
      getNonce: () => 'nonce', requiresAuth: () => false,
      passwordConfigured: false, sendUnauthorized() {},
      workspaceExists: () => Promise.resolve(true),
      objstoreResources: () => { const i = n++; entered[i].resolve(); return reads[i].promise },
      debug: false,
    })
    try {
      const signature = await signSubscribePayload(k.signingKey, k.workspaceTag, null, 'nonce')
      const frame = { workspaceTag: k.workspaceTag, from: null, signature }
      const older = handlers.handleSubscribe(socket, frame)
      await entered[0].promise
      const newer = handlers.handleSubscribe(socket, frame)
      await entered[1].promise
      const current = outcome === 'deleted' ? [] : [{ ...meta('resource'), incarnation: 'B' }]
      reads[1].resolve(current)
      await newer
      // Complete A after B was delivered. A must neither restore an old
      // lineage/deletion nor close the successfully refreshed connection.
      if (outcome === 'failed') reads[0].reject(new Error('obsolete lookup failed'))
      else reads[0].resolve([{ ...meta('resource', 5), incarnation: 'A' }])
      await older
      assert.deepEqual(messages.filter((m) => m.type === 'workspace-subscribed').map((m) => m.resources), [current])
      assert.equal(messages.filter((m) => m.type === 'workspace-state').length, 1, 'obsolete chain reply is suppressed too')
      assert.equal(socket.readyState, socket.OPEN)
    } finally { await handle.close() }
  })
}

for (const stalledStage of ['inventory', 'chain']) {
  it(`releases a superseded ${stalledStage} lookup's pause before that lookup settles`, async () => {
    const k = await keys()
    const handle = openDb(':memory:')
    const messages = []
    const socket = { OPEN: 1, readyState: 1, bufferedAmount: 0, send: (s) => messages.push(JSON.parse(s)), close() { this.readyState = 3 } }
    const peers = new WeakMap([[socket, new Peer('nonce')]])
    const hub = createHub({ peers, maxBufferedBytes: 10000, debug: false })
    const reads = Array.from({ length: 3 }, () => Promise.withResolvers())
    const entered = Array.from({ length: 3 }, () => Promise.withResolvers())
    const pending = []
    let n = 0
    const read = () => { const i = n++; entered[i].resolve(); return reads[i].promise }
    if (stalledStage === 'chain') handle.chainAll.all = read
    const handlers = createSyncHandlers({
      handle, ...hub, publishRevision() {},
      getNonce: () => 'nonce', requiresAuth: () => false,
      passwordConfigured: false, sendUnauthorized() {},
      workspaceExists: () => Promise.resolve(true),
      objstoreResources: stalledStage === 'inventory' ? read : () => Promise.resolve([]),
      debug: false,
    })
    try {
      hub.subscribe(socket, 'other-workspace')
      const signature = await signSubscribePayload(k.signingKey, k.workspaceTag, null, 'nonce')
      const frame = { workspaceTag: k.workspaceTag, from: null, signature }
      pending.push(handlers.handleSubscribe(socket, frame))
      await entered[0].promise
      hub.broadcast(k.workspaceTag, { type: 'before-retry' }, null)
      pending.push(handlers.handleSubscribe(socket, frame))
      await entered[1].promise
      assert.deepEqual(messages, [], 'handoff must not flush broadcasts before the replacement snapshot')
      hub.broadcast('other-workspace', { type: 'during-retry' }, null)
      reads[1].resolve([])
      await pending[1]
      assert.deepEqual(messages.map((m) => m.type), ['workspace-subscribed', 'workspace-state', 'before-retry', 'during-retry'], 'both workspaces resume while the obsolete lookup is still pending')
      hub.broadcast(k.workspaceTag, { type: 'live' }, null)
      assert.equal(messages.at(-1).type, 'live', 'future broadcasts are not left buffered')

      // The old finally can run during another subscription. Its release
      // must be harmless, including when the obsolete read rejects late.
      pending.push(handlers.handleSubscribe(socket, frame))
      await entered[2].promise
      hub.broadcast('other-workspace', { type: 'during-third' }, null)
      if (stalledStage === 'chain') reads[0].reject(new Error('obsolete chain failed'))
      else reads[0].resolve([])
      await pending[0]
      assert.equal(messages.at(-1).type, 'live', 'old cleanup cannot release the third lookup pause')
      assert.equal(socket.readyState, socket.OPEN)
      reads[2].resolve([])
      await pending[2]
      assert.deepEqual(messages.slice(-3).map((m) => m.type), ['workspace-subscribed', 'workspace-state', 'during-third'])
    } finally {
      for (const r of reads) r.resolve([])
      await Promise.allSettled(pending)
      await handle.close()
    }
  })
}
