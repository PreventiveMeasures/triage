// Client for the v1.objstore extension. Pair with the triage-sync
// relay (see server/README.md). Two planes:
//
// - **WS control plane**. A single multiplexed WebSocket per client
//   (`createObjstoreClient`) — every workspace the client opens
//   (`client.openWorkspace(keys)`) subscribes over the SAME socket
//   and shares the per-connection `challenge` nonce. Request frames
//   (`objstore-put-begin` / `-fetch` / `-delete` / `-list`) carry
//   `workspaceTag` so replies route back to the right session.
//   Broadcasts (`objstore-put`, `objstore-deleted`) carry
//   `workspaceTag` and fan out to the matching session's handlers.
//
// - **REST data plane**. PUT bytes via `fetch(httpOrigin + urlPath,
//   { method: 'PUT', headers: { Authorization: 'Bearer <token>' },
//   body })`. GET via the same shape. The WS handler issues the
//   bearer token + URL; this module performs the HTTP round-trip.
//
// Confidentiality: the bytes the server sees are **always**
// ciphertext — the session encrypts (fileName, content) with
// ChaCha20-Poly1305 (key derived from the workspace privateKey via
// HKDF; see `objstore-content-crypto.ts`) before each PUT, and
// decrypts on each FETCH. The wire `resourceTag` is HMAC-SHA-256
// (tagKey, fileName) — deterministic + privacy-preserving, so two
// peers naming the same fileName under the same workspace agree on
// the tag without coordination, but the relay can't reverse the
// HMAC. Public API (`put` / `fetch` / `delete`) takes plaintext
// fileNames; the wire `resourceTag` + ciphertext stay internal.
// Integrity stays orthogonal:
//   - `contentHash = SHA-256(ciphertext)` is computed here and
//     bound into the Ed25519 signature on PUT-BEGIN, so a peer
//     fetching bytes that don't match the signed hash has proof of
//     tampering.
//   - The AEAD also binds (workspaceTag, resourceTag) into AAD, so
//     a relay shuffling blobs between resources or workspaces
//     makes the decrypt fail at the AEAD-tag step BEFORE the
//     fileName is exposed.
//
// Concurrency: the caller MUST NOT issue two ops for the same
// `fileName` concurrently (responses are correlated by `type` +
// `resourceTag`; the deterministic tag derivation means two ops
// for the same name produce the same tag and the matcher would
// race). Ops on DIFFERENT fileNames are safe to interleave.
// Ops on DIFFERENT workspaces of the SAME client are safe to
// interleave — replies are scoped by `workspaceTag`.

import {
  type ObjstoreDeleteFields,
  type ObjstorePutBeginFields,
  computeContentHash,
  signObjstoreDelete,
  signObjstoreFetch,
  signObjstoreList,
  signObjstorePut,
} from './objstore-crypto.ts'
import {
  type ObjstoreKeys,
  computeBundleResourceTag,
  computeResourceTag,
  decryptObjstorePayload,
  encryptObjstorePayload,
  unwrapBundleContent,
  wrapBundleContent,
} from './objstore-content-crypto.ts'
import { getCachedSyncPassword, setCachedSyncPassword } from './sync-auth-cache.ts'

export { type ObjstoreKeys, deriveObjstoreKeys } from './objstore-content-crypto.ts'

// Resolver shape for the operator-side first-action gate. Matches
// `AuthenticationResolver` in client/triage-sync.ts so the UI can
// install the same dialog-driver in both places. `retry: true`
// means the previous attempt on this socket failed the password
// compare — UI surfaces "wrong password" rather than re-prompting
// cold. Returning `null` / `undefined` cancels (the put returns
// `{ ok: false, reason: 'unauthorized' }` as usual).
export type ObjstoreAuthResolver = (context: { retry: boolean }) => Promise<string | null | undefined>

// Server-emitted wire row shape. Returned by `_rawList`, embedded
// in `_rawFetch`-token replies, and broadcast on `objstore-put`.
// Internal — the public API surfaces `Listing` (just `{ version,
// contentLength }` per fileName) and decrypted `FetchResult`.
type ObjectMeta = {
  resourceTag: string
  version: number
  contentHash: string
  contentLength: number
  signature: string
}

// Public listing — server-emitted metadata for one resource. The
// `resourceTag` is the wire HMAC (opaque to anyone without the
// tagKey); the `version` lets callers thread optimistic-concurrency
// preconditions through `put` / `delete`. `contentLength` is the
// CIPHERTEXT length (12-byte nonce + N-byte plaintext + 16-byte
// AEAD tag), NOT the plaintext content length — callers who care
// about plaintext size must `fetchByTag` and inspect the returned
// `content`.
export type Listing = {
  resourceTag: string
  version: number
  contentLength: number
}

export type PutResult =
  | { ok: true; meta: { version: number; contentLength: number } }
  | { ok: false; reason: 'conflict'; currentVersion: number | null }
  | { ok: false; reason: 'workspace-full' }
  | { ok: false; reason: 'contended' }
  // Operator-side first-action gate fired: this is the FIRST signed
  // action against a workspace tag that doesn't yet exist on the
  // server, and the connection hasn't authenticated. Caller surfaces
  // this to the user (typically the triage-sync auth dialog is the
  // path to resolving it — the cached password gets reused on the
  // next put attempt once the same workspace exists on the server
  // OR once a fresh password is cached).
  | { ok: false; reason: 'unauthorized' }

export type DeleteResult =
  | { ok: true; deletedVersion: number }
  | { ok: false; reason: 'conflict'; currentVersion: number | null }
  | { ok: false; reason: 'not-found' }
  | { ok: false; reason: 'contended' }

// `fetch(fileName)` returns plaintext content + version. `fileName`
// is omitted from the result because the caller already knows it
// (they passed it in). `fetchByTag` reverses the AAD-bound name and
// returns both fields.
export type FetchResult = { content: Uint8Array; version: number }
// Bundle fetch carries the user-friendly name alongside the bytes —
// peers downloading a bundle they didn't upload themselves need this
// to render a meaningful sidebar label. The integrity is what the
// caller passed in.
export type FetchBundleResult = { name: string; content: Uint8Array; version: number }
// `fetchByTag` returns a discriminated union: the embedded "name" in
// the encrypted payload is either a report fileName (kind='report')
// or a bundle's sha512 integrity (kind='bundle'). The session decides
// which by round-tripping the embedded name through both tag
// derivations and matching against the requested resourceTag. Callers
// that only care about reports can `if (r.kind === 'report')` and
// discard bundles. The bundle branch additionally unwraps the
// structured content prefix to surface the user-friendly bundle name.
export type FetchByTagResult =
  | { kind: 'report'; fileName: string; content: Uint8Array; version: number }
  | { kind: 'bundle'; integrity: string; name: string; content: Uint8Array; version: number }

// Per-client deps. The client opens one WebSocket and multiplexes
// every workspace's session over it. `authResolver` is shared too —
// the server's `socketAuthorized` flag is per-WebSocket, so a single
// password unlocks all workspaces over this client's socket.
export type ObjstoreClientDeps = {
  // WebSocket URL — `ws://host:port/api/sync` (the same URL the
  // triage-sync relay listens on; objstore handlers are wired into
  // the shared dispatch).
  serverUrl: string
  // HTTP origin for REST data-plane PUT / GET — `http://host:port`
  // (no path). The token + relative urlPath come from the WS reply.
  httpOrigin: string
  // Optional: override the default 10s request timeout (per WS op).
  // REST PUT/GET timeouts use the platform's `fetch` default.
  requestTimeoutMs?: number
  // Optional: password prompt for the operator-side first-action
  // gate. The auth flow is socket-scoped: the first gated put-begin
  // over this client's socket runs the flow (cached password silent
  // retry, then resolver prompt loop); subsequent gated put-begins
  // — including ones on a DIFFERENT workspace session — piggyback
  // on the same socket auth without re-prompting. Omitted → no auth
  // flow runs; gated put-begin returns `unauthorized` immediately.
  authResolver?: ObjstoreAuthResolver
}

// Backwards-compatible single-session deps. Each `createObjstoreSession`
// call creates its OWN client (its own socket) — tests that exercise
// peer-broadcast behavior rely on this (the server excludes the
// originator socket from broadcasts, so two sessions for the same
// workspace must live on separate sockets for one to see the other's
// puts).
export type ObjstoreSessionDeps = ObjstoreClientDeps & {
  // Workspace identity + keys. `workspaceTag` is the base64url
  // Ed25519 public key (also stored on `keys`); `keys.signingKey`
  // signs wire frames, `keys.contentKey` / `keys.tagKey` drive the
  // content-layer AEAD + HMAC. See `deriveObjstoreKeys` for the
  // single-entrypoint derivation from a workspace's 32-byte secret.
  keys: ObjstoreKeys
}

export type ObjstoreSession = {
  // PUT a plaintext (fileName, content) pair. Internally derives
  // the wire tag, encrypts the payload, and routes the put-begin +
  // REST PUT round-trip. `prevVersion` is the optimistic-concurrency
  // precondition: `null` for first upload, the version returned by
  // the previous `put` / `list` / `fetch` for an in-place overwrite.
  put(opts: { fileName: string; content: Uint8Array; prevVersion: number | null }): Promise<PutResult>
  // FETCH by plaintext fileName. Derives the tag, fetches the wire
  // ciphertext, verifies the AAD-bound (workspaceTag, tag) match and
  // the fileName inside the AEAD blob equals the requested one
  // (defense against a relay swapping resources). Returns null on
  // not-found.
  fetch(fileName: string): Promise<FetchResult | null>
  // FETCH by opaque resourceTag — for the case the caller listed
  // the workspace and got a tag they haven't seen before (peer
  // uploaded under a fileName the local user doesn't know yet).
  // Returns the fileName from the decrypted blob, or null on
  // not-found.
  fetchByTag(resourceTag: string): Promise<FetchByTagResult | null>
  // DELETE by plaintext fileName. `prevVersion` carries the same
  // optimistic-concurrency precondition as `put`.
  delete(fileName: string, prevVersion: number | null): Promise<DeleteResult>
  // LIST every resource the relay holds for this workspace. The
  // `resourceTag` field is opaque (HMAC); callers who need a list
  // of plaintext fileNames must `fetchByTag` on each tag to
  // surface the inner names.
  list(): Promise<Listing[]>
  // Broadcast subscriptions — `onPut` fires when ANY peer (or this
  // session) commits a new version under the workspace. `onDeleted`
  // mirrors. Both deliver the wire `resourceTag` (opaque), since
  // the relay doesn't decrypt — callers who need fileNames must
  // `fetchByTag` to surface the inner names.
  onPut(handler: (event: { resourceTag: string; version: number; contentLength: number }) => void): () => void
  onDeleted(handler: (event: { resourceTag: string; version: number }) => void): () => void
  // Bundle-side put / fetch / delete. Same semantics as the report
  // counterparts but the tag derives from a sha512 integrity and the
  // wire HMAC uses a distinct domain-separation prefix. The user-
  // friendly bundle name rides in a structured content prefix so
  // peers downloading the bundle see the original name, not just
  // the integrity.
  putBundle(opts: { integrity: string; name: string; content: Uint8Array; prevVersion: number | null }): Promise<PutResult>
  fetchBundle(integrity: string): Promise<FetchBundleResult | null>
  deleteBundle(integrity: string, prevVersion: number | null): Promise<DeleteResult>
  close(): void
}

// Public surface of the multiplexed client. Each `openWorkspace`
// adds a session to the shared socket; `close()` tears the socket
// down and closes every open session.
export type ObjstoreClient = {
  openWorkspace(keys: ObjstoreKeys): Promise<ObjstoreSession>
  close(): void
}

// Wire-shape envelope every server frame lands as post-JSON.parse.
// Every field is unknown; the dispatcher narrows on `type` then on
// `resourceTag` to correlate to a pending request. The session's
// outbound frames carry the same shape but with stricter types.
type WireMessage = { type?: unknown; workspaceTag?: unknown; resourceTag?: unknown; [k: string]: unknown }

// The relay sends a `challenge` frame on connect that the client
// must bind into every subsequent objstore signature (and the
// `workspace-subscribe` signature too — the relay's subscribe path
// is shared with triage-sync's). Audit round-9 H2.
//
// The subscribe canonical is `[domain, tag, from, connectionNonce]`
// with `from = null` since the objstore session doesn't carry a
// triage-sync chain cursor.
const SUBSCRIBE_DOMAIN = 'deepview-triage-sync.v1.subscribe'

// Cap on the unmatched-message queue. Any waiter older than this
// many unmatched frames is lost — acceptable, since a properly-
// behaving session shouldn't have unmatched frames piling up at
// all. Empirically the queue depth is bounded by inflight ops.
const MAX_QUEUE_SIZE = 64

// Reconnect backoff window (matches triage-sync.ts).
const INITIAL_RECONNECT_DELAY = 1_000
const MAX_RECONNECT_DELAY = 30_000

async function signSubscribe(privateKey: CryptoKey, workspaceTag: string, connectionNonce: string): Promise<string> {
  const { encodeUtf8 } = await import('../common/utf8.js')
  const canonical = encodeUtf8([SUBSCRIBE_DOMAIN, workspaceTag, '', connectionNonce].join('\n'))
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, privateKey, canonical))
  return sig.toBase64({ alphabet: 'base64url', omitPadding: true })
}

// Per-workspace state held by the client's session map. The shared
// socket routes broadcasts here via `workspaceTag`; the per-session
// handlers fire on the matching entry.
type SessionState = {
  workspaceTag: string
  signingKey: CryptoKey
  contentKey: Uint8Array
  tagKey: Uint8Array
  putHandlers: Set<(event: { resourceTag: string; version: number; contentLength: number }) => void>
  deletedHandlers: Set<(event: { resourceTag: string; version: number }) => void>
  // Per-tag monotonic version watermark — see `noteVersion` below.
  seenVersions: Map<string, number>
  // True once a `workspace-subscribe` for this session has been
  // ack'd on the CURRENT socket. Reset on disconnect so the next
  // reconnect re-subscribes via `resubscribeAll`.
  subscribed: boolean
  // Resolves once the next subscribe-ack lands. Pending requests
  // (and `openWorkspace` itself) await this before sending. Re-armed
  // on disconnect so a request issued during the reconnect window
  // blocks until the new socket finishes its subscribe handshake
  // rather than failing fast.
  subscribedPromise: Promise<void>
  resolveSubscribed: () => void
  rejectSubscribed: (err: Error) => void
  closed: boolean
}

export function createObjstoreClient(deps: ObjstoreClientDeps): ObjstoreClient {
  const timeoutMs = deps.requestTimeoutMs ?? 10_000

  // Shared transport state. `ws` flips between null (closed /
  // reconnecting) and an open socket; `connectionNonce` mirrors the
  // current socket's challenge nonce (used in every signature).
  let ws: WebSocket | null = null
  let connectionNonce: string | null = null
  let clientClosed = false
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let reconnectDelayMs = INITIAL_RECONNECT_DELAY

  // Map<workspaceTag, SessionState> — broadcast routing + reconnect
  // re-subscribe iteration both walk this.
  const sessionsByTag = new Map<string, SessionState>()

  // Shared queue + waiters across all sessions. Each waiter's
  // predicate already includes `m.workspaceTag === <tag>` so the
  // shared queue routes correctly across sessions without extra
  // scaffolding.
  const queue: WireMessage[] = []
  const waiters: Array<{ predicate: (m: WireMessage) => boolean; resolve: (m: WireMessage) => void; reject: (err: Error) => void }> = []

  // Per-socket auth state for the operator-side first-action gate.
  // Hoisted from the per-session scope of the pre-multiplex design:
  // the server's `socketAuthorized` flag is per-WebSocket, so all
  // sessions on this client share one auth state. The first session
  // to hit `unauthorized: gated` runs the auth flow; concurrent
  // gated put-begins on OTHER sessions await the in-flight flow's
  // result rather than racing a second prompt.
  let authFlowInFlight: Promise<boolean> | null = null
  let cachedPasswordTriedOnThisSocket = false
  let authResponseResolver: ((ok: boolean) => void) | null = null

  function noteVersion(state: SessionState, tag: string, version: number): void {
    const prev = state.seenVersions.get(tag) ?? 0
    if (version > prev) state.seenVersions.set(tag, version)
  }

  function attemptAuthenticate(password: string): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      authResponseResolver = resolve
      try { sendRaw({ type: 'authenticate', password }) }
      catch (err) {
        authResponseResolver = null
        // Send-after-close: the WebSocket transitioned to CLOSING /
        // CLOSED between the put-begin reply and our auth attempt.
        // Bail false so the auth flow doesn't hang.
        console.warn('objstore: authenticate send failed:', err)
        resolve(false)
      }
    })
  }

  // Run the gated-put-begin auth flow against this client's socket.
  // Returns `true` when the socket is now authenticated and the
  // caller should retry the put-begin; `false` when the user
  // cancelled / there's no resolver / the cached attempt failed
  // and no resolver is wired.
  //
  // Concurrent callers (e.g. two workspace sessions racing a gated
  // put on a fresh socket) coalesce on the in-flight promise — the
  // resolver only prompts the user once, and both callers retry
  // their puts on success. Audit: pre-multiplex this path returned
  // `false` for the second caller, surfacing a spurious
  // `unauthorized` to one of two concurrent uploads. Coalescing
  // fixes that without changing the prompt-cadence contract.
  function runAuthFlow(): Promise<boolean> {
    if (authFlowInFlight) return authFlowInFlight
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.resolve(false)
    // Pin the socket this flow runs against. The server's
    // `socketAuthorized` flag is per-WebSocket, so an `authenticate`
    // attempt is only meaningful on the socket the caller's gated
    // put-begin was issued on. If the socket transitions mid-flow
    // (resolver dialog open during a NAT-induced disconnect, e.g.),
    // bail false so the caller's `_rawPut` waiter — which has
    // already been rejected by `failPendingWaiters` on the close
    // event — bubbles up the disconnect error and the next put on
    // the fresh socket re-enters runAuthFlow, replaying the cached
    // password fresh on the new socket.
    const startWs = ws
    const promise = (async (): Promise<boolean> => {
      try {
        // Silent replay of the shared cached password, once per socket.
        const cached = getCachedSyncPassword()
        if (cached != null && !cachedPasswordTriedOnThisSocket) {
          cachedPasswordTriedOnThisSocket = true
          const ok = await attemptAuthenticate(cached)
          if (ws !== startWs) return false
          if (ok) return true
          // Cache was wrong — drop it so triage-sync doesn't re-replay
          // the same broken value, then fall through to the resolver.
          try { await setCachedSyncPassword(null) }
          catch (err) { console.warn('objstore: failed to clear cached auth password:', err) }
        }
        // Prompt loop. `retry=true` after the first attempt so the UI
        // surfaces "wrong password" rather than re-prompting cold.
        let firstAttempt = true
        while (true) {
          if (ws !== startWs || !ws || ws.readyState !== WebSocket.OPEN) return false
          if (!deps.authResolver) return false
          let password: string | null | undefined
          try { password = await deps.authResolver({ retry: !firstAttempt }) }
          catch (err) {
            console.warn('objstore: authentication resolver threw:', err)
            return false
          }
          if (ws !== startWs) return false
          firstAttempt = false
          if (password == null || password === '') return false
          const ok = await attemptAuthenticate(password)
          if (ws !== startWs) return false
          if (ok) {
            try { await setCachedSyncPassword(password) }
            catch (err) { console.warn('objstore: failed to cache auth password:', err) }
            return true
          }
        }
      } finally {
        authFlowInFlight = null
      }
    })()
    authFlowInFlight = promise
    return promise
  }

  function makeSubscribedDeferred(state: Partial<SessionState>): void {
    state.subscribedPromise = new Promise<void>((resolve, reject) => {
      state.resolveSubscribed = resolve
      state.rejectSubscribed = reject
    })
    // Mark the promise as handled — callers may not always await it
    // (e.g. internal resubscribe paths during reconnect), and an
    // unhandled rejection from a transport error would spam the
    // console.
    state.subscribedPromise.catch(() => {})
  }

  function recv(predicate: (m: WireMessage) => boolean): Promise<WireMessage> {
    for (let i = 0; i < queue.length; i++) {
      if (predicate(queue[i]!)) return Promise.resolve(queue.splice(i, 1)[0]!)
    }
    return new Promise((resolve, reject) => {
      const w: typeof waiters[number] = {
        predicate,
        resolve: () => {},
        reject: (err) => {
          clearTimeout(t)
          const idx = waiters.indexOf(w)
          if (idx >= 0) waiters.splice(idx, 1)
          reject(err)
        },
      }
      const t = setTimeout(() => w.reject(new Error(`objstore: response timeout after ${timeoutMs}ms`)), timeoutMs)
      w.resolve = (m) => { clearTimeout(t); resolve(m) }
      waiters.push(w)
    })
  }

  function sendRaw(msg: object): void {
    if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error('objstore: socket not open')
    ws.send(JSON.stringify(msg))
  }

  // Fail every pending waiter on socket close / error so an in-flight
  // `put` / `fetch` / `delete` / `list` doesn't hang for the full
  // request timeout (10 s default) after the socket is gone. Fires
  // for caller `close()`, server-initiated shutdown (1001), and
  // abnormal disconnects.
  function failPendingWaiters(reason: string): void {
    for (const w of waiters.splice(0)) {
      try { w.reject(new Error(`objstore: ${reason}`)) } catch {}
    }
  }

  // MUST REMAIN SYNCHRONOUS. The dispatcher fires broadcast handlers
  // (`putHandlers` / `deletedHandlers`) and resolves request-response
  // waiters in arrival order; introducing an `await` here would let
  // two messages interleave (one handler's async work racing the
  // next message's state mutations). Compare to triage-sync's
  // `queue = queue.then(...)` Promise-chain (client/triage-sync.ts:2389)
  // — that path needs the chain BECAUSE handleAck/handleChain have
  // awaits. If a future change adds an await here, mirror that
  // pattern.
  function handleMessage(event: MessageEvent): void {
    let msg: WireMessage
    try { msg = JSON.parse(typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data as ArrayBuffer)) as WireMessage }
    catch { return }

    // Broadcasts dispatch synchronously to the matching session's
    // handlers — never end up in the request-correlation queue. A
    // subscriber that registered AFTER a broadcast arrived missed
    // it (no replay); register before calling the op that would
    // trigger it on a peer.
    if (msg.type === 'objstore-put' && typeof msg.workspaceTag === 'string' && isObjectMeta(msg)) {
      const state = sessionsByTag.get(msg.workspaceTag)
      if (!state) return  // workspace closed / unknown — drop silently
      const meta = toObjectMeta(msg)
      // Advance the per-tag rollback watermark on every broadcast we
      // believe. A relay that promises v5 in a broadcast then serves
      // v3 on a follow-up FETCH will hit `assertFreshOrLater`.
      noteVersion(state, meta.resourceTag, meta.version)
      const putEvent = { resourceTag: meta.resourceTag, version: meta.version, contentLength: meta.contentLength }
      for (const h of state.putHandlers) { try { h(putEvent) } catch {} }
      return
    }
    if (msg.type === 'objstore-deleted' && typeof msg.workspaceTag === 'string' && typeof msg.resourceTag === 'string' && typeof msg['version'] === 'number') {
      const state = sessionsByTag.get(msg.workspaceTag)
      if (!state) return
      const tag = msg.resourceTag
      const version = msg['version']
      // A delete broadcast destroys the row server-side: the next
      // legitimate PUT lands as v1 again. Drop the watermark so the
      // recreate's v1 isn't mistaken for a rollback. Same rationale
      // as the `deleteByName` path below — the rollback gate only
      // applies *within* a single incarnation of a resource.
      state.seenVersions.delete(tag)
      const ev = { resourceTag: tag, version }
      for (const h of state.deletedHandlers) { try { h(ev) } catch {} }
      return
    }

    // Operator-side auth handshake replies. Pin on the explicit `kind`
    // discriminator so an `unauthorized` with `kind: 'gated'` (the
    // put-begin gate signal) still falls through to the recv-predicate
    // dispatch below, where the in-flight `_rawPut` matches it on
    // resourceTag.
    if (msg.type === 'authenticated') {
      if (authResponseResolver) {
        const r = authResponseResolver
        authResponseResolver = null
        r(true)
      }
      return
    }
    if (msg.type === 'unauthorized' && msg['kind'] === 'auth-failed') {
      if (authResponseResolver) {
        const r = authResponseResolver
        authResponseResolver = null
        r(false)
      }
      return
    }

    // Subscribe-acks resolve the matching session's
    // `subscribedPromise`. Routed by workspaceTag.
    if (msg.type === 'workspace-subscribed' && typeof msg.workspaceTag === 'string') {
      const state = sessionsByTag.get(msg.workspaceTag)
      if (state && !state.subscribed) {
        state.subscribed = true
        state.resolveSubscribed()
      }
      return
    }

    // Triage-sync frames piggyback on the same socket via the shared
    // `workspace-subscribe` path (the relay's subscribe contract
    // delivers BOTH planes' broadcasts to a subscribed socket). None
    // of those frames match an objstore-side predicate; without an
    // explicit drop they'd pile up in `queue` forever.
    if (msg.type === 'workspace-state' || msg.type === 'workspace-save-ack' || msg.type === 'workspace-save-error' || msg.type === 'pong') return

    // Request-response correlation. First waiter whose predicate
    // matches gets the message; otherwise queue for a later `recv`.
    for (let i = 0; i < waiters.length; i++) {
      if (waiters[i]!.predicate(msg)) {
        const w = waiters[i]!
        waiters.splice(i, 1)
        w.resolve(msg)
        return
      }
    }
    queue.push(msg)
    // Defense in depth: bound the queue so an unknown future frame
    // type doesn't grow it without limit. FIFO eviction — the
    // oldest unmatched message is the least likely to be wanted by
    // the next predicate. Surface evictions via `console.warn` so a
    // future debug session can see WHICH frame type accumulated.
    if (queue.length > MAX_QUEUE_SIZE) {
      const dropped = queue.splice(0, queue.length - MAX_QUEUE_SIZE)
      const types = [...new Set(dropped.map((m) => (m as { type?: unknown }).type ?? '<no-type>'))].slice(0, 4)
      console.warn(`objstore: dropping ${dropped.length} unmatched frame(s) over MAX_QUEUE_SIZE=${MAX_QUEUE_SIZE} (types: ${types.join(', ')})`)
    }
  }

  function clearReconnect(): void {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
  }

  function scheduleReconnect(): void {
    clearReconnect()
    if (clientClosed) return
    if (sessionsByTag.size === 0) return  // no live sessions — nothing to keep open
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      openSocket()
    }, reconnectDelayMs)
    reconnectDelayMs = Math.min(reconnectDelayMs * 2, MAX_RECONNECT_DELAY)
  }

  // Issue fresh `workspace-subscribe` frames for every session whose
  // current-socket subscription isn't yet acked. Called after the
  // socket opens + challenge arrives (both initial and reconnect).
  // Each session's `subscribedPromise` resolves when the matching
  // `workspace-subscribed` ack lands in `handleMessage`.
  async function resubscribeAll(): Promise<void> {
    if (!ws || !connectionNonce) return
    const nonce = connectionNonce
    const currentWs = ws
    // Race guard: this function is async (signSubscribe awaits a
    // crypto.subtle call); the socket may transition during the await.
    // After each `await`, re-check that `ws === currentWs` (and is
    // still OPEN) before sending — a stale send against a stale
    // socket would either throw (different ws) or land on a fresh
    // socket with a fresh nonce that doesn't match the signed one.
    for (const state of sessionsByTag.values()) {
      if (state.closed || state.subscribed) continue
      let sig: string
      try { sig = await signSubscribe(state.signingKey, state.workspaceTag, nonce) }
      catch (err) {
        console.warn('objstore: signSubscribe failed:', err)
        continue
      }
      if (ws !== currentWs || ws.readyState !== WebSocket.OPEN) return
      try { sendRaw({ type: 'workspace-subscribe', workspaceTag: state.workspaceTag, from: null, signature: sig }) }
      catch (err) { console.warn('objstore: workspace-subscribe send failed:', err) }
    }
  }

  function openSocket(): void {
    if (clientClosed) return
    if (ws) return
    if (sessionsByTag.size === 0) return
    let next: WebSocket
    try { next = new WebSocket(deps.serverUrl) }
    catch (err) {
      console.warn('objstore: WebSocket constructor failed:', err)
      scheduleReconnect()
      return
    }
    ws = next
    // Per-socket state is rearmed each open: nonce is awaited from
    // the challenge frame, auth state resets (server's
    // socketAuthorized is per-socket).
    connectionNonce = null
    cachedPasswordTriedOnThisSocket = false
    if (authResponseResolver) {
      const r = authResponseResolver
      authResponseResolver = null
      r(false)
    }
    // Every existing session's subscribed-on-current-socket flag
    // resets; the next open + challenge re-subscribes all of them.
    for (const state of sessionsByTag.values()) {
      if (state.closed) continue
      if (state.subscribed) {
        state.subscribed = false
        makeSubscribedDeferred(state)
      }
    }

    next.addEventListener('open', () => {
      if (ws !== next) return
      reconnectDelayMs = INITIAL_RECONNECT_DELAY
      // Wait for the challenge frame, then re-subscribe everyone.
      // The challenge can arrive synchronously-ish so we register
      // the recv waiter before any await.
      ;(async () => {
        try {
          const challenge = await recv((m) => m.type === 'challenge')
          if (ws !== next) return
          if (typeof challenge['nonce'] !== 'string') throw new TypeError('objstore: challenge frame missing nonce')
          connectionNonce = challenge['nonce']
          await resubscribeAll()
        } catch (err) {
          console.warn('objstore: handshake failed:', err)
          try { next.close() } catch {}
        }
      })()
    })

    next.addEventListener('message', handleMessage)

    next.addEventListener('close', () => {
      // Stale-close guard: if a fresh socket has already replaced
      // this one (`ws !== next`), every clear below would step on
      // the new socket's state.
      if (ws !== next) return
      ws = null
      connectionNonce = null
      cachedPasswordTriedOnThisSocket = false
      if (authResponseResolver) {
        const r = authResponseResolver
        authResponseResolver = null
        r(false)
      }
      // The pending requests are gone with the socket — reject every
      // waiter so the caller's promise settles instead of timing out.
      failPendingWaiters('session closed')
      // Each session's subscribed-on-current-socket flag clears so
      // reconnect re-subscribes everyone.
      for (const state of sessionsByTag.values()) {
        if (state.closed) continue
        if (state.subscribed) {
          state.subscribed = false
          makeSubscribedDeferred(state)
        }
      }
      if (!clientClosed && sessionsByTag.size > 0) scheduleReconnect()
    })

    next.addEventListener('error', () => {
      // `close` fires right after — let it own the reconnect schedule.
      failPendingWaiters('websocket error')
    })
  }

  // Wire-level PUT — takes a pre-computed resourceTag + ciphertext.
  // `put` (public) is the encrypting wrapper.
  async function _rawPut(state: SessionState, opts: { resourceTag: string; bytes: Uint8Array; prevVersion: number | null }): Promise<RawPutResult> {
    await state.subscribedPromise
    if (state.closed) throw new Error('objstore: session closed')
    if (!connectionNonce) throw new Error('objstore: socket not open')
    const nonce = connectionNonce
    const contentHash = await computeContentHash(opts.bytes)
    const fields: ObjstorePutBeginFields = {
      workspaceTag: state.workspaceTag,
      resourceTag: opts.resourceTag,
      prevVersion: opts.prevVersion,
      expectedLength: opts.bytes.byteLength,
      contentHash,
    }
    const signature = await signObjstorePut(state.signingKey, fields, nonce)
    // Send + await, with at most ONE retry after a successful auth
    // flow. The Ed25519 signature binds (tag, resourceTag, prevVersion,
    // contentHash, expectedLength, connectionNonce) — none of which
    // change between retries on the same socket — so the original
    // signature is reusable verbatim. `attemptedAuth` guards against
    // a runaway loop in the pathological case where auth succeeds but
    // a second `unauthorized` still arrives.
    let reply: WireMessage
    let attemptedAuth = false
    while (true) {
      sendRaw({ type: 'objstore-put-begin', ...fields, signature })
      // Match `workspaceTag` on the reply too — every server reply
      // frame carries it (server/objstore/handlers.ts). On a
      // multiplexed socket the workspaceTag is what disambiguates
      // replies destined for different sessions; on a single-session
      // socket it's defense-in-depth against routing bugs.
      //
      // `unauthorized` with `kind: 'gated'` is the operator-side
      // first-action gate firing; the reply carries `workspaceTag +
      // resourceTag`. Pin on `kind` so the `kind: 'auth-failed'`
      // reply from our own in-flight `authenticate` (handled by the
      // dispatcher above) can't accidentally satisfy this predicate.
      reply = await recv((m) =>
        m.workspaceTag === state.workspaceTag && m.resourceTag === opts.resourceTag && (
          m.type === 'objstore-put-token' ||
          m.type === 'objstore-put-error' ||
          m.type === 'objstore-conflict' ||
          (m.type === 'unauthorized' && m['kind'] === 'gated')
        ),
      )
      if (reply.type !== 'unauthorized') break
      if (attemptedAuth) break
      attemptedAuth = true
      // On success the in-flight auth flow has set the server's
      // socketAuthorized for THIS socket; loop back and re-send
      // put-begin. On failure / cancel → fall through to the
      // unauthorized return below.
      const authed = await runAuthFlow()
      if (!authed) break
    }
    if (reply.type === 'unauthorized') return { ok: false, reason: 'unauthorized' }
    if (reply.type === 'objstore-put-error') {
      if (reply['reason'] === 'workspace-full') return { ok: false, reason: 'workspace-full' }
      throw new Error(`objstore: put-error reason='${String(reply['reason'])}'`)
    }
    if (reply.type === 'objstore-conflict') {
      const current = isObjectMeta(reply['current'] as WireMessage | undefined) ? toObjectMeta(reply['current'] as WireMessage) : null
      return { ok: false, reason: 'conflict', current }
    }
    // objstore-put-token { urlPath, token, expiresAt, stagingId, ... }
    if (typeof reply['urlPath'] !== 'string' || typeof reply['token'] !== 'string') {
      throw new TypeError('objstore: malformed put-token (missing urlPath/token)')
    }
    const res = await globalThis.fetch(deps.httpOrigin + reply['urlPath'], {
      method: 'PUT',
      headers: {
        // No explicit `content-length` — browser `fetch()` treats it
        // as a forbidden request header and throws TypeError on
        // assignment. Both undici (Node) and the browser compute
        // Content-Length from the body bytes, which matches the
        // server's `req.headers['content-length']` parse in
        // server/objstore/rest.ts.
        'authorization': `Bearer ${reply['token']}`,
        'content-type': 'application/octet-stream',
      },
      body: opts.bytes as Uint8Array<ArrayBuffer>,
    })
    if (!res.ok) {
      // 503 + `{ error: 'contended' }` — the server's commit-lock
      // for this (workspace_tag, resource_tag) is held by another
      // in-flight commit/delete; the server already waited up to
      // 2 s before giving up. Surface as a typed retryable result
      // so the caller can choose to retry with backoff rather than
      // treating it as a hard failure.
      if (res.status === 503) {
        let body: { error?: unknown } = {}
        try { body = await res.json() as { error?: unknown } } catch {}
        if (body.error === 'contended') return { ok: false, reason: 'contended' }
        // Other 503s (e.g. transient backend issue) fall through to
        // the generic-error path below.
      }
      if (res.status === 409 || res.status === 410) {
        // Parse the server's `{ error, currentVersion }` envelope so a
        // 409 carries the live row's version into the caller's retry
        // loop — symmetric with the WS plane's `objstore-conflict`
        // envelope. 410 (`gone`, staging row reaped between begin and
        // commit) doesn't have a live version — fall through with
        // `current: null`.
        const current = res.status === 409 ? await parseRestConflictVersion(res) : null
        return { ok: false, reason: 'conflict', current }
      }
      // Other 4xx/5xx are protocol violations or server-side faults
      // the caller can't usefully discriminate.
      let body = ''
      try { body = await res.text() } catch {}
      throw new Error(`objstore: REST PUT failed ${res.status} ${body.slice(0, 200)}`)
    }
    // Validate the JSON response shape AND that the server echoed
    // back the same contentHash + contentLength the client signed
    // into put-begin. The server-side commitPut verifies the body
    // matches the signed hash before producing this ack, so any
    // divergence here is a protocol bug, a buggy proxy, or a hostile
    // relay that swapped fields.
    let ack: unknown
    try { ack = await res.json() }
    catch { throw new TypeError('objstore: PUT ack JSON parse failed') }
    if (!ack || typeof ack !== 'object'
      || typeof (ack as { version?: unknown }).version !== 'number'
      || typeof (ack as { contentHash?: unknown }).contentHash !== 'string'
      || typeof (ack as { contentLength?: unknown }).contentLength !== 'number') {
      throw new TypeError('objstore: PUT ack malformed (missing version/contentHash/contentLength)')
    }
    const meta = ack as { version: number; contentHash: string; contentLength: number }
    if (meta.contentHash !== contentHash || meta.contentLength !== opts.bytes.byteLength) {
      throw new Error(`objstore: PUT ack mismatch — server returned contentHash=${meta.contentHash.slice(0, 16)}… length=${meta.contentLength}, client signed ${contentHash.slice(0, 16)}… length=${opts.bytes.byteLength}`)
    }
    return { ok: true, meta }
  }

  // Wire-level FETCH — returns raw ciphertext + meta. `fetch` /
  // `fetchByTag` (public) wrap this with decryption.
  async function _rawFetch(state: SessionState, resourceTag: string): Promise<{ bytes: Uint8Array; meta: ObjectMeta } | null> {
    await state.subscribedPromise
    if (state.closed) throw new Error('objstore: session closed')
    if (!connectionNonce) throw new Error('objstore: socket not open')
    const signature = await signObjstoreFetch(state.signingKey, state.workspaceTag, resourceTag, connectionNonce)
    sendRaw({ type: 'objstore-fetch', workspaceTag: state.workspaceTag, resourceTag, signature })
    const reply = await recv((m) =>
      m.workspaceTag === state.workspaceTag && m.resourceTag === resourceTag && (
        m.type === 'objstore-fetch-token' ||
        m.type === 'objstore-fetch-not-found'
      ),
    )
    if (reply.type === 'objstore-fetch-not-found') return null
    if (typeof reply['urlPath'] !== 'string' || typeof reply['token'] !== 'string' || !isObjectMeta(reply)) {
      throw new TypeError('objstore: malformed fetch-token (missing urlPath / token / metadata)')
    }
    const meta = toObjectMeta(reply)
    const res = await globalThis.fetch(deps.httpOrigin + reply['urlPath'], {
      method: 'GET',
      headers: { 'authorization': `Bearer ${reply['token']}` },
    })
    if (!res.ok) {
      // 404 `not-found` — the live row was DELETED between
      // token-issue and GET. Return null (same shape as the WS
      // `objstore-fetch-not-found` reply).
      // 503 `unavailable` — live row present but the file is
      // missing / size diverged (server-side fs fault). Throw with
      // the wire body so the incident has a forensic trail.
      if (res.status === 404) return null
      let body = ''
      try { body = await res.text() } catch {}
      throw new Error(`objstore: REST GET failed ${res.status} ${body.slice(0, 200)}`)
    }
    const bytes = new Uint8Array(await res.arrayBuffer())
    // Integrity check: verify the bytes match the contentHash the
    // workspaceTag-holder signed into put-begin. A mismatch is
    // proof the relay (or network) tampered with the bytes — the
    // signature covered this exact hash, and the relay can't
    // produce a valid signature without the seed.
    const actualHash = await computeContentHash(bytes)
    if (actualHash !== meta.contentHash) {
      throw new Error(`objstore: contentHash mismatch — expected ${meta.contentHash.slice(0, 16)}…, got ${actualHash.slice(0, 16)}…`)
    }
    return { bytes, meta }
  }

  // Wire-level DELETE. `delete` (public) is the encrypting wrapper —
  // it derives the tag from the plaintext fileName and calls here.
  async function _rawDelete(state: SessionState, resourceTag: string, prevVersion: number | null): Promise<RawDeleteResult> {
    await state.subscribedPromise
    if (state.closed) throw new Error('objstore: session closed')
    if (!connectionNonce) throw new Error('objstore: socket not open')
    const fields: ObjstoreDeleteFields = { workspaceTag: state.workspaceTag, resourceTag, prevVersion }
    const signature = await signObjstoreDelete(state.signingKey, fields, connectionNonce)
    sendRaw({ type: 'objstore-delete', ...fields, signature })
    const reply = await recv((m) =>
      m.workspaceTag === state.workspaceTag && m.resourceTag === resourceTag && (
        m.type === 'objstore-deleted-ack' ||
        m.type === 'objstore-delete-error' ||
        m.type === 'objstore-conflict'
      ),
    )
    if (reply.type === 'objstore-deleted-ack') {
      if (typeof reply['deletedVersion'] !== 'number') throw new TypeError('objstore: malformed deleted-ack (deletedVersion not a number)')
      return { ok: true, deletedVersion: reply['deletedVersion'] }
    }
    if (reply.type === 'objstore-conflict') {
      const current = isObjectMeta(reply['current'] as WireMessage | undefined) ? toObjectMeta(reply['current'] as WireMessage) : null
      return { ok: false, reason: 'conflict', current }
    }
    if (reply['reason'] === 'not-found') return { ok: false, reason: 'not-found' }
    // `contended` — the server's commit-lock for this key was held
    // by another in-flight commit/delete; surface as a typed
    // retryable result so the caller can back off and retry rather
    // than crash. Mirror of REST PUT 503 `contended`.
    if (reply['reason'] === 'contended') return { ok: false, reason: 'contended' }
    throw new Error(`objstore: delete-error reason='${String(reply['reason'])}'`)
  }

  // Wire-level LIST. Returns raw ObjectMeta (with opaque resourceTag
  // HMACs). `list` (public) downgrades to the small Listing shape.
  async function _rawList(state: SessionState): Promise<ObjectMeta[]> {
    await state.subscribedPromise
    if (state.closed) throw new Error('objstore: session closed')
    if (!connectionNonce) throw new Error('objstore: socket not open')
    const signature = await signObjstoreList(state.signingKey, state.workspaceTag, connectionNonce)
    sendRaw({ type: 'objstore-list', workspaceTag: state.workspaceTag, signature })
    const reply = await recv((m) => m.type === 'objstore-list-result' && m.workspaceTag === state.workspaceTag)
    // Match fetch's strictness: any malformed wire shape is a protocol
    // violation, not a "missing data" signal.
    if (!Array.isArray(reply['resources'])) throw new TypeError('objstore: malformed list-result (resources not an array)')
    const out: ObjectMeta[] = []
    for (let i = 0; i < reply['resources'].length; i++) {
      const entry = reply['resources'][i] as WireMessage | undefined
      if (!isObjectMeta(entry)) throw new TypeError(`objstore: malformed list-result entry at index ${i}`)
      out.push(toObjectMeta(entry))
    }
    return out
  }

  // Reject a fetched object whose version is strictly lower than
  // the highest we've already seen for this tag. The Ed25519 PUT
  // signature is valid for ANY historical version, so without this
  // watermark a relay could serve a stale-but-signed copy on FETCH
  // and the AEAD / contentHash chain would all check out.
  function assertFreshOrLater(state: SessionState, tag: string, version: number): void {
    const last = state.seenVersions.get(tag) ?? 0
    if (version < last) {
      throw new Error(`objstore: version-rollback rejected — fetched v${version} for a tag we've already seen at v${last}`)
    }
  }

  async function openWorkspace(keys: ObjstoreKeys): Promise<ObjstoreSession> {
    if (clientClosed) throw new Error('objstore: client closed')
    const workspaceTag = keys.workspaceTag
    if (sessionsByTag.has(workspaceTag)) {
      throw new Error(`objstore: workspace ${workspaceTag.slice(0, 8)}… is already open on this client`)
    }
    // Take a private copy of the raw keys so `close()` can wipe its
    // own slot without affecting caller-owned state. Callers commonly
    // reuse the same `ObjstoreKeys` across reconnect cycles (test
    // expects this; presence-layer ditto), so mutating the caller's
    // arrays in place would silently break the second session.
    const state: Partial<SessionState> = {
      workspaceTag,
      signingKey: keys.signingKey,
      contentKey: new Uint8Array(keys.contentKey),
      tagKey: new Uint8Array(keys.tagKey),
      putHandlers: new Set(),
      deletedHandlers: new Set(),
      seenVersions: new Map(),
      subscribed: false,
      closed: false,
    }
    makeSubscribedDeferred(state)
    sessionsByTag.set(workspaceTag, state as SessionState)
    const full = state as SessionState

    // Kick the socket lifecycle. If the socket is already open + a
    // challenge has landed, send subscribe immediately; otherwise
    // openSocket → 'open' handler → resubscribeAll picks us up.
    if (!ws) {
      openSocket()
    } else if (ws.readyState === WebSocket.OPEN && connectionNonce) {
      // Race-tolerant: signSubscribe is async; if the socket dies
      // mid-await, capture (currentWs, currentNonce) BEFORE the await
      // and check BOTH after, so a swap to a fresh socket with a
      // fresh nonce doesn't land a signed-for-the-old-nonce subscribe
      // on the new socket (server rejects sig → silent hang until
      // subscribe-ack timeout). `resubscribeAll` on the new socket's
      // open will re-issue with the fresh nonce.
      const currentWs = ws
      const currentNonce = connectionNonce
      ;(async () => {
        try {
          const sig = await signSubscribe(full.signingKey, workspaceTag, currentNonce)
          if (ws === currentWs && connectionNonce === currentNonce && ws.readyState === WebSocket.OPEN && !full.subscribed && !full.closed) {
            sendRaw({ type: 'workspace-subscribe', workspaceTag, from: null, signature: sig })
          }
        } catch (err) {
          console.warn('objstore: workspace-subscribe send failed:', err)
        }
      })()
    }

    // Cap the open's wait on the subscribe-ack at `timeoutMs` so a
    // server that silently drops the subscribe (bad sig, etc.)
    // doesn't hang the caller forever.
    let openTimeout: ReturnType<typeof setTimeout> | null = null
    try {
      await new Promise<void>((resolve, reject) => {
        openTimeout = setTimeout(() => {
          reject(new Error(`objstore: subscribe-ack timeout after ${timeoutMs}ms`))
        }, timeoutMs)
        full.subscribedPromise.then(() => resolve(), (err) => reject(err))
      })
    } catch (err) {
      if (openTimeout) clearTimeout(openTimeout)
      // Roll back the session entry so a retried openWorkspace works.
      sessionsByTag.delete(workspaceTag)
      full.closed = true
      try { full.contentKey.fill(0) } catch {}
      try { full.tagKey.fill(0) } catch {}
      // If this was the only/first session, tear the socket down too —
      // otherwise it stays open with no users, since `scheduleReconnect`
      // bails on `sessionsByTag.size === 0` and the next `openSocket()`
      // bails on `if (ws) return`. Symmetric with `session.close()`'s
      // last-session auto-teardown.
      if (sessionsByTag.size === 0) {
        clearReconnect()
        reconnectDelayMs = INITIAL_RECONNECT_DELAY
        if (ws) {
          const stale = ws
          ws = null
          connectionNonce = null
          failPendingWaiters('session closed')
          try { stale.close() } catch {}
        }
      }
      throw err
    }
    if (openTimeout) clearTimeout(openTimeout)

    async function put(opts: { fileName: string; content: Uint8Array; prevVersion: number | null }): Promise<PutResult> {
      const resourceTag = await computeResourceTag(full.tagKey, opts.fileName)
      const ciphertext = encryptObjstorePayload(full.contentKey, opts.fileName, opts.content, workspaceTag, resourceTag)
      // `retryOnContended` re-runs the PUT (re-mints token + re-
      // uploads bytes) on transient lock-contention from the server.
      // The signed put-begin is single-use per stagingId — a fresh
      // begin mints a fresh stagingId, so this is NOT a token replay.
      const raw = await retryOnContendedImpl(() =>
        _rawPut(full, { resourceTag, bytes: ciphertext, prevVersion: opts.prevVersion }))
      if (raw.ok) {
        // `prevVersion: null` is the server's "must not exist"
        // precondition — its success means the row was created
        // fresh, possibly atop a deleted prior incarnation we
        // never saw the broadcast for. Re-seed the watermark from
        // this incarnation's v1.
        if (opts.prevVersion == null) full.seenVersions.delete(resourceTag)
        noteVersion(full, resourceTag, raw.meta.version)
        return { ok: true, meta: { version: raw.meta.version, contentLength: raw.meta.contentLength } }
      }
      if (raw.reason === 'workspace-full') return { ok: false, reason: 'workspace-full' }
      if (raw.reason === 'contended') return { ok: false, reason: 'contended' }
      if (raw.reason === 'unauthorized') return { ok: false, reason: 'unauthorized' }
      if (raw.current) noteVersion(full, resourceTag, raw.current.version)
      return { ok: false, reason: 'conflict', currentVersion: raw.current?.version ?? null }
    }

    async function fetch(fileName: string): Promise<FetchResult | null> {
      const resourceTag = await computeResourceTag(full.tagKey, fileName)
      const raw = await _rawFetch(full, resourceTag)
      if (!raw) return null
      assertFreshOrLater(full, resourceTag, raw.meta.version)
      const { fileName: decoded, content } = decryptObjstorePayload(full.contentKey, raw.bytes, workspaceTag, resourceTag)
      if (decoded !== fileName) {
        throw new Error(`objstore: fileName-binding mismatch — requested '${fileName}', payload encoded '${decoded}'`)
      }
      noteVersion(full, resourceTag, raw.meta.version)
      return { content, version: raw.meta.version }
    }

    async function fetchByTag(resourceTag: string): Promise<FetchByTagResult | null> {
      const raw = await _rawFetch(full, resourceTag)
      if (!raw) return null
      assertFreshOrLater(full, resourceTag, raw.meta.version)
      // The decrypted payload's embedded "name" is one of:
      //   - a report fileName (most common)
      //   - a bundle's sha512 integrity
      // Try the report-tag derivation first; on miss, try the bundle-tag
      // derivation. Both share the same `tagKey` but use different HMAC
      // prefixes, so a name that's a fileName won't accidentally match
      // the bundle round-trip and vice versa.
      const { fileName: embeddedName, content } = decryptObjstorePayload(full.contentKey, raw.bytes, workspaceTag, resourceTag)
      const expectedReport = await computeResourceTag(full.tagKey, embeddedName)
      if (expectedReport === resourceTag) {
        noteVersion(full, resourceTag, raw.meta.version)
        return { kind: 'report', fileName: embeddedName, content, version: raw.meta.version }
      }
      const expectedBundle = await computeBundleResourceTag(full.tagKey, embeddedName)
      if (expectedBundle === resourceTag) {
        const { name, content: bundleContent } = unwrapBundleContent(content)
        noteVersion(full, resourceTag, raw.meta.version)
        return { kind: 'bundle', integrity: embeddedName, name, content: bundleContent, version: raw.meta.version }
      }
      throw new Error('objstore: fetchByTag — decrypted name does not derive back to the requested resourceTag under either the report or bundle tag scheme (relay or workspace member produced a non-round-trippable tag-name pair)')
    }

    async function deleteByName(fileName: string, prevVersion: number | null): Promise<DeleteResult> {
      const resourceTag = await computeResourceTag(full.tagKey, fileName)
      const raw = await retryOnContendedImpl(() => _rawDelete(full, resourceTag, prevVersion))
      if (raw.ok) {
        // Delete drops the server-side row; the next PUT under this
        // tag starts a new incarnation at v1.
        full.seenVersions.delete(resourceTag)
        return raw
      }
      if (raw.reason === 'not-found') return { ok: false, reason: 'not-found' }
      if (raw.reason === 'contended') return { ok: false, reason: 'contended' }
      if (raw.current) noteVersion(full, resourceTag, raw.current.version)
      return { ok: false, reason: 'conflict', currentVersion: raw.current?.version ?? null }
    }

    async function list(): Promise<Listing[]> {
      const entries = await _rawList(full)
      for (const m of entries) noteVersion(full, m.resourceTag, m.version)
      return entries.map((m) => ({ resourceTag: m.resourceTag, version: m.version, contentLength: m.contentLength }))
    }

    async function putBundle(opts: { integrity: string; name: string; content: Uint8Array; prevVersion: number | null }): Promise<PutResult> {
      const resourceTag = await computeBundleResourceTag(full.tagKey, opts.integrity)
      const wrapped = wrapBundleContent(opts.name, opts.content)
      const ciphertext = encryptObjstorePayload(full.contentKey, opts.integrity, wrapped, workspaceTag, resourceTag)
      const raw = await retryOnContendedImpl(() =>
        _rawPut(full, { resourceTag, bytes: ciphertext, prevVersion: opts.prevVersion }))
      if (raw.ok) {
        if (opts.prevVersion == null) full.seenVersions.delete(resourceTag)
        noteVersion(full, resourceTag, raw.meta.version)
        return { ok: true, meta: { version: raw.meta.version, contentLength: raw.meta.contentLength } }
      }
      if (raw.reason === 'workspace-full') return { ok: false, reason: 'workspace-full' }
      if (raw.reason === 'contended') return { ok: false, reason: 'contended' }
      if (raw.reason === 'unauthorized') return { ok: false, reason: 'unauthorized' }
      if (raw.current) noteVersion(full, resourceTag, raw.current.version)
      return { ok: false, reason: 'conflict', currentVersion: raw.current?.version ?? null }
    }

    async function fetchBundle(integrity: string): Promise<FetchBundleResult | null> {
      const resourceTag = await computeBundleResourceTag(full.tagKey, integrity)
      const raw = await _rawFetch(full, resourceTag)
      if (!raw) return null
      assertFreshOrLater(full, resourceTag, raw.meta.version)
      const { fileName: decoded, content: wrapped } = decryptObjstorePayload(full.contentKey, raw.bytes, workspaceTag, resourceTag)
      if (decoded !== integrity) {
        throw new Error(`objstore: bundle-integrity binding mismatch — requested '${integrity}', payload encoded '${decoded}'`)
      }
      const { name, content } = unwrapBundleContent(wrapped)
      noteVersion(full, resourceTag, raw.meta.version)
      return { name, content, version: raw.meta.version }
    }

    async function deleteBundle(integrity: string, prevVersion: number | null): Promise<DeleteResult> {
      const resourceTag = await computeBundleResourceTag(full.tagKey, integrity)
      const raw = await retryOnContendedImpl(() => _rawDelete(full, resourceTag, prevVersion))
      if (raw.ok) {
        full.seenVersions.delete(resourceTag)
        return raw
      }
      if (raw.reason === 'not-found') return { ok: false, reason: 'not-found' }
      if (raw.reason === 'contended') return { ok: false, reason: 'contended' }
      if (raw.current) noteVersion(full, resourceTag, raw.current.version)
      return { ok: false, reason: 'conflict', currentVersion: raw.current?.version ?? null }
    }

    return {
      put,
      fetch,
      fetchByTag,
      delete: deleteByName,
      list,
      putBundle,
      fetchBundle,
      deleteBundle,
      onPut(handler) { full.putHandlers.add(handler); return () => { full.putHandlers.delete(handler) } },
      onDeleted(handler) { full.deletedHandlers.add(handler); return () => { full.deletedHandlers.delete(handler) } },
      close() {
        if (full.closed) return
        full.closed = true
        sessionsByTag.delete(workspaceTag)
        // Defense-in-depth: drop the raw key wrappers we hold so a
        // heap snapshot taken after close() doesn't include the
        // workspace's content + tag key material.
        try { full.contentKey.fill(0) } catch {}
        try { full.tagKey.fill(0) } catch {}
        // If a request happened to be awaiting subscribedPromise at
        // the moment of close, unblock it with an error so it doesn't
        // hang past the session's lifetime.
        try { full.rejectSubscribed(new Error('objstore: session closed')) } catch {}
        // Note: the server has no per-tag unsubscribe message, so
        // broadcasts for this workspaceTag may continue to arrive on
        // the shared socket. The dispatcher drops them silently
        // because `sessionsByTag.get(workspaceTag)` returns undefined
        // after the delete above.
        //
        // If this was the last open session, tear the socket down so
        // we don't keep a connection alive for nothing. Symmetric
        // with the openSocket-on-first-openWorkspace bootstrap.
        if (sessionsByTag.size === 0) {
          clearReconnect()
          reconnectDelayMs = INITIAL_RECONNECT_DELAY
          if (ws) {
            const stale = ws
            ws = null
            connectionNonce = null
            // The stale-close guard in the ws 'close' listener bails
            // when `ws !== stale` and so SKIPS `failPendingWaiters`;
            // without this explicit drain, any waiter past the
            // subscribedPromise gate (i.e. inside `await recv(...)`
            // for an in-flight put/fetch/delete/list) would hang the
            // full `requestTimeoutMs` instead of failing fast.
            failPendingWaiters('session closed')
            try { stale.close() } catch {}
          }
        }
      },
    }
  }

  function close(): void {
    if (clientClosed) return
    clientClosed = true
    clearReconnect()
    // Close every open session — wipe keys, drop from the map, reject
    // pending subscribe waiters.
    for (const state of sessionsByTag.values()) {
      state.closed = true
      try { state.contentKey.fill(0) } catch {}
      try { state.tagKey.fill(0) } catch {}
      try { state.rejectSubscribed(new Error('objstore: client closed')) } catch {}
    }
    sessionsByTag.clear()
    failPendingWaiters('client closed')
    if (ws) {
      const stale = ws
      ws = null
      connectionNonce = null
      try { stale.close() } catch {}
    }
  }

  return { openWorkspace, close }
}

// Backwards-compatible single-session entry point. Each call creates
// its OWN client (its own WebSocket) — peer-broadcast tests rely on
// this isolation (the server excludes the originator socket from
// broadcasts). Production code that wants connection multiplexing
// across workspaces should call `createObjstoreClient` directly.
export async function createObjstoreSession(deps: ObjstoreSessionDeps): Promise<ObjstoreSession> {
  // Spread to forward optional fields without coercing undefined onto
  // the target — exactOptionalPropertyTypes wants the key absent, not
  // explicitly undefined.
  const clientDeps: ObjstoreClientDeps = { serverUrl: deps.serverUrl, httpOrigin: deps.httpOrigin }
  if (deps.requestTimeoutMs !== undefined) clientDeps.requestTimeoutMs = deps.requestTimeoutMs
  if (deps.authResolver !== undefined) clientDeps.authResolver = deps.authResolver
  const client = createObjstoreClient(clientDeps)
  let session: ObjstoreSession
  try {
    session = await client.openWorkspace(deps.keys)
  } catch (err) {
    try { client.close() } catch {}
    throw err
  }
  // Wrap close to tear the client down too — single-session callers
  // expect `session.close()` to drop the underlying socket.
  const inner = session.close
  return {
    ...session,
    close() {
      try { inner() } catch {}
      try { client.close() } catch {}
    },
  }
}

// Internal wire-level result shapes returned by `_rawPut` /
// `_rawDelete`. Kept separate from the public `PutResult` /
// `DeleteResult` so the public types can carry just
// `currentVersion` (a number from the conflict envelope) rather
// than the full server-meta blob — the conflict envelope's
// resourceTag is the OPAQUE wire tag, which the caller can't
// meaningfully consume without the tagKey.
type RawPutResult =
  | { ok: true; meta: { version: number; contentHash: string; contentLength: number } }
  | { ok: false; reason: 'conflict'; current: { version: number } | null }
  | { ok: false; reason: 'workspace-full' }
  | { ok: false; reason: 'contended' }
  | { ok: false; reason: 'unauthorized' }

type RawDeleteResult =
  | { ok: true; deletedVersion: number }
  | { ok: false; reason: 'conflict'; current: { version: number } | null }
  | { ok: false; reason: 'not-found' }
  | { ok: false; reason: 'contended' }

// Read the live row's version out of a REST PUT 409 `conflict` body.
// Returns `null` for malformed bodies, missing fields, or non-safe
// integer values. The caller treats `null` the same as "no version
// surfaced" — the retry path won't loop against a live row, but the
// caller can't precondition on a known version either.
async function parseRestConflictVersion(res: Response): Promise<{ version: number } | null> {
  try {
    const body = (await res.json()) as { currentVersion?: unknown }
    if (typeof body.currentVersion === 'number' && Number.isSafeInteger(body.currentVersion)) {
      return { version: body.currentVersion }
    }
  } catch {}
  return null
}

// Bounded retry for server-side `contended` (REST PUT 503 + body
// `error: 'contended'`, or WS DELETE error reason 'contended').
// The server already waited up to 2s polling the commit-lock
// before surfacing — by the time we see `contended` the peer
// holder is genuinely busy, so a short jittered backoff before
// re-issuing the request gives the holder time to finish.
//
// Cap at 3 retries with exponential-ish jittered backoff
// (100–200, 200–400, 400–800 ms). At the 4th attempt the typed
// `contended` propagates to the caller — at that point the
// holder has had ~1.4 s of additional client-side grace, on top
// of the server's 2 s wait per attempt (each `_rawPut` /
// `_rawDelete` re-issues a fresh WS request which the server
// will again wait 2 s on). Total worst-case time before the
// caller sees `contended`: ~10 s. Acceptable as a backstop;
// typical contention clears in <100 ms.
//
// Exported (rather than closure-private) so the unit test in
// `tests/client-objstore-contended.test.js` can pin the contract
// directly with a synthetic op — testing it via real fetch/WS
// would require spinning up a contention scenario end-to-end.
export async function retryOnContendedImpl<T>(
  op: () => Promise<T>,
  // Test seam: injectable sleep so the test doesn't actually wait
  // 700 ms across 3 retries. Production omits and uses real
  // setTimeout.
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) }),
): Promise<T> {
  let r = await op()
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (!isContendedResult(r)) return r
    const base = 100 * (2 ** (attempt - 1))
    const jitter = Math.floor(Math.random() * base)
    await sleep(base + jitter)
    r = await op()
  }
  return r
}
function isContendedResult(r: unknown): boolean {
  if (typeof r !== 'object' || r === null) return false
  const o = r as { ok?: unknown; reason?: unknown }
  return o.ok === false && o.reason === 'contended'
}

// Wire-shape guard. The objstore broadcast / list / fetch-token
// frames all carry the same metadata shape; this validates the
// fields the caller cares about (the signature field is wire-only
// — callers don't verify it client-side since the bytes themselves
// are verified via `contentHash`).
function isObjectMeta(m: WireMessage | undefined): m is WireMessage {
  if (!m || typeof m !== 'object') return false
  return typeof m['resourceTag'] === 'string'
    && typeof m['version'] === 'number'
    && typeof m['contentHash'] === 'string'
    && typeof m['contentLength'] === 'number'
    && typeof m['signature'] === 'string'
}

function toObjectMeta(m: WireMessage): ObjectMeta {
  // Pre-condition: `isObjectMeta(m)` was true. Bracket access
  // satisfies TS strict's `noUncheckedIndexedAccess`; the literal
  // narrowing inside `isObjectMeta` covered the type guard.
  return {
    resourceTag: m['resourceTag'] as string,
    version: m['version'] as number,
    contentHash: m['contentHash'] as string,
    contentLength: m['contentLength'] as number,
    signature: m['signature'] as string,
  }
}
