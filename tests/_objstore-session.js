// Test-only single-session objstore entry point. Production code never
// drives `workspace-subscribe` from the objstore client — presence
// rides triage-sync's single subscribe for the same workspace tag on
// the shared socket (the two always open a workspace together), which
// is what registers the socket for `objstore-put` / `-deleted`
// broadcasts; the client's own nonce-signed requests only need the
// socket connected.
//
// Peer-broadcast tests, though, need a standalone objstore session on
// its OWN socket with nothing else subscribing the tag, so this helper
// drives the real subscribe wire frame itself: sign
// `[domain, tag, '', nonce]` (via the production `signSubscribePayload`),
// send `workspace-subscribe` on connect, await the `workspace-subscribed`
// ack, and re-subscribe on every reconnect. Each call creates its OWN
// client (its own WebSocket) so the server's originator-exclusion on
// broadcasts lets two sessions for the same workspace see each other's
// puts.

import { createObjstoreClient } from '../client/sync/objstore.ts'
import { createSocketTransport } from '../client/sync/socket-transport.ts'
import { signSubscribePayload } from '../client/sync/sync-crypto.ts'

// `deps`: { serverUrl, httpOrigin, keys, requestTimeoutMs?, authResolver? }.
// Returns an `ObjstoreSession` whose `close()` also tears down the
// helper's subscribe consumer and the private transport.
export async function createObjstoreSession(deps) {
  const timeoutMs = deps.requestTimeoutMs ?? 10_000
  const { keys } = deps
  const transport = createSocketTransport(
    deps.authResolver === undefined
      ? { serverUrl: deps.serverUrl }
      : { serverUrl: deps.serverUrl, authResolver: deps.authResolver },
  )

  // Resolves with the `workspace-subscribed` ack's `resources` snapshot
  // (the inventory the subscribe handshake now folds in). Doubles as the
  // `resources` half of the WorkspaceSubscription token the client's
  // openWorkspace requires — this helper is the subscriber, so it owns
  // both halves. Pre-attach a catch so an abandoned subscribe (e.g.
  // server unreachable → openWorkspace rejects first) doesn't surface as
  // an unhandled rejection.
  let resolveAck = () => {}
  let rejectAck = () => {}
  const firstAck = new Promise((resolve, reject) => { resolveAck = resolve; rejectAck = reject })
  firstAck.catch(() => {})

  // One-shot resolvers awaiting the NEXT `workspace-subscribed` ack's
  // resources — `list()` registers one then re-subscribes, so it returns
  // an authoritative current server snapshot (the production client's
  // `list()` is a live cache fed by broadcasts; tests that assert
  // post-concurrency state want a fresh read, which re-subscribing gives
  // now that `objstore-list` is gone).
  const resourceWaiters = []

  // Drive the real subscribe handshake on every (re)connect. Stale-
  // tolerant: signing is async, so re-check (socket, nonce) before send.
  const consumer = transport.addConsumer({
    onConnected(nonce) {
      const startSocket = transport.getSocket()
      void (async () => {
        let sig
        try { sig = await signSubscribePayload(keys.signingKey, keys.workspaceTag, null, nonce) }
        catch { return }
        if (transport.getSocket() !== startSocket || transport.getNonce() !== nonce) return
        transport.send({ type: 'workspace-subscribe', workspaceTag: keys.workspaceTag, from: null, signature: sig })
      })()
    },
    onMessage(msg) {
      if (msg.type === 'workspace-subscribed' && msg.workspaceTag === keys.workspaceTag) {
        const rows = Array.isArray(msg.resources) ? msg.resources : []
        resolveAck(rows)
        for (const w of resourceWaiters.splice(0)) w(rows)
      }
    },
    onDisconnected() {},
  })

  // Authoritative inventory read: re-subscribe and return the fresh
  // `workspace-subscribed` snapshot (the handshake that replaced
  // `objstore-list`). Mirrors the old `session.list()` "current server
  // state" semantics that the concurrency tests rely on.
  async function freshList() {
    const nonce = transport.getNonce()
    if (!nonce) throw new Error('objstore test helper: socket not open for list')
    const sig = await signSubscribePayload(keys.signingKey, keys.workspaceTag, null, nonce)
    // Send FIRST, then register the waiter — a failed send must not
    // leave a resolver queued (it would leak and later be resolved by an
    // unrelated ack). The ack is a network round-trip, so registering
    // synchronously right after the send still beats it.
    if (!transport.send({ type: 'workspace-subscribe', workspaceTag: keys.workspaceTag, from: null, signature: sig })) {
      throw new Error('objstore test helper: subscribe send failed for list')
    }
    const rows = new Promise((resolve) => { resourceWaiters.push(resolve) })
    const resolved = await withTimeout(rows, timeoutMs, 'list re-subscribe ack')
    return resolved.map((r) => ({ resourceTag: r.resourceTag, version: r.version, incarnation: r.incarnation, contentLength: r.contentLength }))
  }

  const clientDeps = { serverUrl: deps.serverUrl, httpOrigin: deps.httpOrigin, transport }
  if (deps.requestTimeoutMs !== undefined) clientDeps.requestTimeoutMs = deps.requestTimeoutMs
  const client = createObjstoreClient(clientDeps)

  let session
  try {
    // openWorkspace resolves on socket-connect; our consumer's
    // onConnected already sent the subscribe frame. Wait for the ack so
    // peer broadcasts are wired before the caller issues ops. Bounded
    // so a server that drops the subscribe doesn't hang the open.
    // This helper IS the subscriber (it drives the workspace-subscribe
    // above), so it mints its own subscription token for the client's
    // enforced `openWorkspace(keys, subscription)` API — `resources` is
    // the ack snapshot the client seeds its inventory from.
    session = await client.openWorkspace(keys, { workspaceId: keys.workspaceTag, workspaceTag: keys.workspaceTag, resources: firstAck })
    await withTimeout(firstAck, timeoutMs, 'workspace-subscribe ack')
  } catch (err) {
    try { rejectAck(err) } catch {}
    try { consumer.remove() } catch {}
    try { client.close() } catch {}
    try { transport.close() } catch {}
    throw err
  }

  const inner = session.close
  return {
    ...session,
    // Override the client's live-cache `list()` with an authoritative
    // re-subscribe read for tests (see freshList).
    list: freshList,
    close() {
      try { inner() } catch {}
      try { consumer.remove() } catch {}
      try { client.close() } catch {}
      try { transport.close() } catch {}
    },
  }
}

function withTimeout(promise, ms, label) {
  let t
  return new Promise((resolve, reject) => {
    t = setTimeout(() => reject(new Error(`objstore test helper: ${label} timeout after ${ms}ms`)), ms)
    promise.then(resolve, reject)
  }).finally(() => clearTimeout(t))
}
