import './_polyfills.js'
import assert from 'node:assert/strict'
import { it } from 'node:test'
import { createObjstoreClient, deriveObjstoreKeys } from '../client/sync/objstore.ts'
import { createSyncHandlers } from '../server-e2e/sync-handlers.ts'
import { openDb } from '../server-e2e/db.ts'
import { signSubscribePayload } from '../client/sync/sync-crypto.ts'
import { createHub } from '../server-e2e/hub.ts'
import { Peer } from '../server-e2e/peer.ts'
import { computeResourceTag, encryptObjstorePayload } from '../client/sync/objstore-content-crypto.ts'
import { computeContentHash } from '../client/sync/objstore-crypto.ts'

function keys() {
  return deriveObjstoreKeys(crypto.getRandomValues(new Uint8Array(32)).toBase64(), crypto.randomUUID())
}

function meta(resourceTag, version = 1) {
  return { resourceTag, version, incarnation: 'incarnation', contentHash: 'hash', contentLength: 100, signature: 'signature' }
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
