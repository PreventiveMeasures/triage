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

  // Resolves on the first `workspace-subscribed` ack. Pre-attach a
  // catch so an abandoned subscribe (e.g. server unreachable →
  // openWorkspace rejects first) doesn't surface as an unhandled
  // rejection.
  let resolveAck = () => {}
  let rejectAck = () => {}
  const firstAck = new Promise((resolve, reject) => { resolveAck = resolve; rejectAck = reject })
  firstAck.catch(() => {})

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
      if (msg.type === 'workspace-subscribed' && msg.workspaceTag === keys.workspaceTag) resolveAck()
    },
    onDisconnected() {},
  })

  const clientDeps = { serverUrl: deps.serverUrl, httpOrigin: deps.httpOrigin, transport }
  if (deps.requestTimeoutMs !== undefined) clientDeps.requestTimeoutMs = deps.requestTimeoutMs
  const client = createObjstoreClient(clientDeps)

  let session
  try {
    // openWorkspace resolves on socket-connect; our consumer's
    // onConnected already sent the subscribe frame. Wait for the ack so
    // peer broadcasts are wired before the caller issues ops. Bounded
    // so a server that drops the subscribe doesn't hang the open.
    session = await client.openWorkspace(keys)
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
