// Pins the `handleSubscribe` ack-timeout contract: a wedged
// `objstoreResources` lookup (a 503-looping backend, a DB latency
// spike) must NOT pin the `workspace-subscribed` ack — the
// server-side subscription is already registered (`subscribe(socket,
// tag)` runs synchronously above the await), so broadcasts flow even
// without the ack, but the client's UI status sits in `connecting`
// until the ack lands. The handler caps the inventory lookup so the
// ack ships within a bounded window; the lookup degrades to the
// same empty-snapshot path the catch branch already uses, and
// broadcasts fill the client's inventory in the meantime.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Buffer } from 'node:buffer'

import { createSyncHandlers } from '../server/sync-handlers.ts'
import { openDb } from '../server/db.ts'
import { encodeUtf8 } from '../common/utf8.js'

const SUBSCRIBE_DOMAIN = 'deepview-triage-sync.v1.subscribe'

function b64url(bytes) { return Buffer.from(bytes).toString('base64url') }

async function makeKp() {
  const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])
  const jwk = await crypto.subtle.exportKey('jwk', kp.publicKey)
  return { sk: kp.privateKey, tag: b64url(Buffer.from(jwk.x, 'base64url')) }
}

async function signSubscribe(sk, tag, from, connectionNonce) {
  const payload = encodeUtf8([
    SUBSCRIBE_DOMAIN, tag, from == null ? '' : String(from), connectionNonce,
  ].join('\n'))
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, sk, payload))
  return b64url(sig)
}

describe('sync-handlers: handleSubscribe inventory-lookup timeout', () => {
  it('ships the workspace-subscribed ack even when objstoreResources never resolves', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'sync-handlers-test-'))
    const handle = openDb(path.join(dir, 'data.db'))
    const { sk, tag } = await makeKp()
    const nonce = 'test-nonce-' + Math.random().toString(36).slice(2, 10)
    const signature = await signSubscribe(sk, tag, null, nonce)

    // Fake socket — just enough surface for `socket.readyState ===
    // socket.OPEN` to pass and `send(socket, msg)` to capture.
    const sock = { readyState: 1, OPEN: 1 }
    const sends = []

    // Objstore lookup that hangs forever — simulates the 503-looping
    // backend scenario. Without the handler-side timeout, the ack
    // would never go out.
    let resolveSlow
    const slow = new Promise((r) => { resolveSlow = r })

    const { handleSubscribe } = createSyncHandlers({
      handle,
      send: (_socket, msg) => { sends.push(msg) },
      broadcast: () => {},
      publishRevision: () => {},
      subscribe: () => {},
      getNonce: () => nonce,
      requiresAuth: () => false,
      sendUnauthorized: () => {},
      workspaceExists: () => Promise.resolve(true),
      objstoreResources: () => slow,
      debug: false,
    })

    // Drive the handler. It must complete (and ship the ack) without
    // waiting for the hung objstore lookup.
    const start = Date.now()
    await handleSubscribe(sock, {
      type: 'workspace-subscribe',
      workspaceTag: tag,
      from: null,
      signature,
    })
    const elapsed = Date.now() - start

    const ack = sends.find((m) => m.type === 'workspace-subscribed')
    assert.ok(ack, 'workspace-subscribed ack was sent')
    assert.equal(ack.workspaceTag, tag)
    assert.deepEqual(ack.resources, [], 'empty resources on timeout (broadcasts fill the inventory)')
    // The production timeout is 2s; allow some slack but reject a
    // regression that lets the ack hang indefinitely behind the lookup.
    assert.ok(elapsed < 4_000, `ack should ship within timeout window, took ${elapsed}ms`)

    // Cleanup — release the hung promise so the leftover race loser
    // settles cleanly, then close the DB + temp dir.
    resolveSlow([])
    await handle.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('passes the inventory through when objstoreResources resolves promptly', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'sync-handlers-test-'))
    const handle = openDb(path.join(dir, 'data.db'))
    const { sk, tag } = await makeKp()
    const nonce = 'test-nonce-' + Math.random().toString(36).slice(2, 10)
    const signature = await signSubscribe(sk, tag, null, nonce)

    const sock = { readyState: 1, OPEN: 1 }
    const sends = []
    const inventoryRows = [{ resourceTag: 'r1', version: 1 }, { resourceTag: 'r2', version: 2 }]

    const { handleSubscribe } = createSyncHandlers({
      handle,
      send: (_socket, msg) => { sends.push(msg) },
      broadcast: () => {},
      publishRevision: () => {},
      subscribe: () => {},
      getNonce: () => nonce,
      requiresAuth: () => false,
      sendUnauthorized: () => {},
      workspaceExists: () => Promise.resolve(true),
      objstoreResources: () => Promise.resolve(inventoryRows),
      debug: false,
    })

    await handleSubscribe(sock, {
      type: 'workspace-subscribe',
      workspaceTag: tag,
      from: null,
      signature,
    })

    const ack = sends.find((m) => m.type === 'workspace-subscribed')
    assert.ok(ack, 'workspace-subscribed ack was sent')
    assert.deepEqual(ack.resources, inventoryRows, 'inventory passed through when lookup is fast')

    await handle.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('falls back to empty resources when objstoreResources rejects', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'sync-handlers-test-'))
    const handle = openDb(path.join(dir, 'data.db'))
    const { sk, tag } = await makeKp()
    const nonce = 'test-nonce-' + Math.random().toString(36).slice(2, 10)
    const signature = await signSubscribe(sk, tag, null, nonce)

    const sock = { readyState: 1, OPEN: 1 }
    const sends = []

    const { handleSubscribe } = createSyncHandlers({
      handle,
      send: (_socket, msg) => { sends.push(msg) },
      broadcast: () => {},
      publishRevision: () => {},
      subscribe: () => {},
      getNonce: () => nonce,
      requiresAuth: () => false,
      sendUnauthorized: () => {},
      workspaceExists: () => Promise.resolve(true),
      objstoreResources: () => Promise.reject(new Error('backend 503')),
      debug: false,
    })

    await handleSubscribe(sock, {
      type: 'workspace-subscribe',
      workspaceTag: tag,
      from: null,
      signature,
    })

    const ack = sends.find((m) => m.type === 'workspace-subscribed')
    assert.ok(ack, 'workspace-subscribed ack was sent despite the rejection')
    assert.deepEqual(ack.resources, [], 'empty resources on rejection')

    await handle.close()
    rmSync(dir, { recursive: true, force: true })
  })
})
