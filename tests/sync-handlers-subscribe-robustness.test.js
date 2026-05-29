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

import { INVENTORY_LOOKUP_TIMEOUT_MS, createSyncHandlers } from '../server/sync-handlers.ts'
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

// Shared scaffold: temp DB + keys + signed subscribe. Returns the
// deps-shaped pieces every test reassembles. `try/finally` in each
// test runs `cleanup` so an assert-throw doesn't leak the temp dir
// or the DB handle into the rest of the suite.
async function setupSubscribeFixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'sync-handlers-test-'))
  const handle = openDb(path.join(dir, 'data.db'))
  const { sk, tag } = await makeKp()
  const nonce = 'test-nonce-' + Math.random().toString(36).slice(2, 10)
  const signature = await signSubscribe(sk, tag, null, nonce)
  const sock = { readyState: 1, OPEN: 1 }
  const sends = []
  const baseDeps = {
    handle,
    send: (_socket, msg) => { sends.push(msg) },
    broadcast: () => {},
    publishRevision: () => {},
    subscribe: () => {},
    getNonce: () => nonce,
    requiresAuth: () => false,
    sendUnauthorized: () => {},
    workspaceExists: () => Promise.resolve(true),
    debug: false,
  }
  const subscribeMsg = { type: 'workspace-subscribe', workspaceTag: tag, from: null, signature }
  async function cleanup() {
    await handle.close()
    rmSync(dir, { recursive: true, force: true })
  }
  return { tag, nonce, sock, sends, baseDeps, subscribeMsg, cleanup }
}

describe('sync-handlers: handleSubscribe inventory-lookup timeout', () => {
  it('ships the workspace-subscribed ack even when objstoreResources never resolves', async () => {
    const { tag, sock, sends, baseDeps, subscribeMsg, cleanup } = await setupSubscribeFixture()
    try {
      // Objstore lookup that hangs forever — simulates the 503-looping
      // backend scenario. Without the handler-side timeout, the ack
      // would never go out.
      let resolveSlow
      const slow = new Promise((r) => { resolveSlow = r })

      const { handleSubscribe } = createSyncHandlers({
        ...baseDeps,
        objstoreResources: () => slow,
      })

      // Drive the handler. It must complete (and ship the ack) without
      // waiting for the hung objstore lookup.
      const start = Date.now()
      await handleSubscribe(sock, subscribeMsg)
      const elapsed = Date.now() - start

      const ack = sends.find((m) => m.type === 'workspace-subscribed')
      assert.ok(ack, 'workspace-subscribed ack was sent')
      assert.equal(ack.workspaceTag, tag)
      assert.deepEqual(ack.resources, [], 'empty resources on timeout (broadcasts fill the inventory)')
      // Two-sided bound: lower pins that the timer actually fired (a
      // regression dropping the timeout to ~0 would silently pass an
      // upper-only check); upper rejects a regression that lets the
      // ack hang indefinitely behind the lookup. Both bounds tracked
      // off the production constant so a future tuning lands here too.
      assert.ok(
        elapsed >= INVENTORY_LOOKUP_TIMEOUT_MS - 100,
        `ack should not ship before the timeout fires, took ${elapsed}ms (timeout: ${INVENTORY_LOOKUP_TIMEOUT_MS}ms)`,
      )
      assert.ok(
        elapsed < INVENTORY_LOOKUP_TIMEOUT_MS + 2_000,
        `ack should ship within the timeout window, took ${elapsed}ms (timeout: ${INVENTORY_LOOKUP_TIMEOUT_MS}ms)`,
      )

      // Release the hung promise so the leftover race loser settles
      // cleanly inside the suite rather than leaking past teardown.
      resolveSlow([])
    } finally {
      await cleanup()
    }
  })

  it('passes the inventory through when objstoreResources resolves promptly', async () => {
    const { sock, sends, baseDeps, subscribeMsg, cleanup } = await setupSubscribeFixture()
    try {
      const inventoryRows = [{ resourceTag: 'r1', version: 1 }, { resourceTag: 'r2', version: 2 }]
      const { handleSubscribe } = createSyncHandlers({
        ...baseDeps,
        objstoreResources: () => Promise.resolve(inventoryRows),
      })

      await handleSubscribe(sock, subscribeMsg)

      const ack = sends.find((m) => m.type === 'workspace-subscribed')
      assert.ok(ack, 'workspace-subscribed ack was sent')
      assert.deepEqual(ack.resources, inventoryRows, 'inventory passed through when lookup is fast')
    } finally {
      await cleanup()
    }
  })

  it('falls back to empty resources when objstoreResources rejects (async)', async () => {
    const { sock, sends, baseDeps, subscribeMsg, cleanup } = await setupSubscribeFixture()
    try {
      const { handleSubscribe } = createSyncHandlers({
        ...baseDeps,
        objstoreResources: () => Promise.reject(new Error('backend 503')),
      })

      await handleSubscribe(sock, subscribeMsg)

      const ack = sends.find((m) => m.type === 'workspace-subscribed')
      assert.ok(ack, 'workspace-subscribed ack was sent despite the rejection')
      assert.deepEqual(ack.resources, [], 'empty resources on rejection')
    } finally {
      await cleanup()
    }
  })

  it('falls back to empty resources when objstoreResources throws synchronously', async () => {
    // Production wires objstoreResources as `async (tag) => ...`, which
    // wraps any sync throw into a rejected promise. But the contract
    // (`(tag) => Promise<object[]>`) doesn't require that wrap, so a
    // stricter future implementation or a wire-up that drops the `async`
    // keyword would surface a sync throw at the handler. Pin that the
    // handler degrades the same way it does for an async rejection —
    // the ack still ships, with empty resources.
    const { sock, sends, baseDeps, subscribeMsg, cleanup } = await setupSubscribeFixture()
    try {
      const { handleSubscribe } = createSyncHandlers({
        ...baseDeps,
        objstoreResources: () => { throw new Error('backend exploded synchronously') },
      })

      await handleSubscribe(sock, subscribeMsg)

      const ack = sends.find((m) => m.type === 'workspace-subscribed')
      assert.ok(ack, 'workspace-subscribed ack was sent despite the sync throw')
      assert.deepEqual(ack.resources, [], 'empty resources on sync throw')
    } finally {
      await cleanup()
    }
  })
})
