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
import {
  type AcquireHandle,
  type ConsumerHandle,
  type SocketTransport,
  createSocketTransport,
} from './socket-transport.ts'
import { encodeUtf8 } from '../../common/utf8.js'

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
  // Ignored when `transport` is provided (the supplied transport
  // already owns its auth resolver).
  authResolver?: ObjstoreAuthResolver
  // Optional: a pre-existing `SocketTransport` to share with another
  // consumer (e.g. the triage-sync singleton from
  // `./sync-transport.ts`). When provided, this client doesn't own
  // the transport — `client.close()` releases its acquisitions and
  // detaches its consumer but DOESN'T call `transport.close()`. When
  // omitted, the client creates a private transport (current default
  // — used by `createObjstoreSession` and by tests that need a
  // peer-broadcast-isolated socket).
  transport?: SocketTransport
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

// REST GET vs concurrent commit: a token minted at v1 can race a
// commitPut that lands v2 before the GET reaches the server, which
// then 404s (token-ver mismatch) or 503s (mid-promote bytes/meta
// desync). Cap retries small — the race window is microseconds, so
// the next attempt usually picks up the stable post-commit state.
const REST_RACE_MAX_ATTEMPTS = 4
const REST_RACE_BACKOFF_MS = 15

async function signSubscribe(privateKey: CryptoKey, workspaceTag: string, connectionNonce: string): Promise<string> {
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
  // SENT on the current socket (flag flips in `sendSubscribeFor`
  // before the send, with a rollback if the send fails — guards
  // against a re-entered `onTransportConnected` double-sending
  // while the ack is in flight). Distinct from the ack-received
  // signal carried by `subscribedPromise` / `resolveSubscribed`
  // below. Reset on disconnect so the next `onTransportConnected`
  // re-subscribes.
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

  // Shared WebSocket transport owns lifecycle, nonce, heartbeat,
  // and the `authenticate` flow. We register as a consumer and
  // hold one `acquire()` per open workspace session. Caller-
  // supplied transport (production) is shared and not owned;
  // omitted (tests, single-session) gets a private one.
  const ownsTransport = deps.transport === undefined
  const transport: SocketTransport = deps.transport ?? createSocketTransport(
    deps.authResolver === undefined
      ? { serverUrl: deps.serverUrl }
      : { serverUrl: deps.serverUrl, authResolver: deps.authResolver },
  )
  let clientClosed = false

  // Map<workspaceTag, ...> — broadcast routing + onConnected
  // resubscribe iteration walk these in lockstep.
  const sessionsByTag = new Map<string, SessionState>()
  const acquiresByTag = new Map<string, AcquireHandle>()

  // Shared across all sessions. Waiter predicates include
  // `m.workspaceTag` so a single queue routes correctly.
  const queue: WireMessage[] = []
  const waiters: Array<{ predicate: (m: WireMessage) => boolean; resolve: (m: WireMessage) => void; reject: (err: Error) => void }> = []

  function noteVersion(state: SessionState, tag: string, version: number): void {
    const prev = state.seenVersions.get(tag) ?? 0
    if (version > prev) state.seenVersions.set(tag, version)
  }

  function makeSubscribedDeferred(state: Partial<SessionState>): void {
    state.subscribedPromise = new Promise<void>((resolve, reject) => {
      state.resolveSubscribed = resolve
      state.rejectSubscribed = reject
    })
    // Pre-attach a catch so reconnect-time rejections don't spam
    // the console as unhandled — internal paths don't always await.
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

  function send(msg: object): void {
    if (!transport.send(msg)) throw new Error('objstore: socket not open')
  }

  // Fail every pending waiter on socket close / error so an in-flight
  // request doesn't hang the full `requestTimeoutMs` after the socket
  // is gone. Fires from the transport's `onDisconnected` (caller close,
  // server shutdown, abnormal disconnect) and indirectly from
  // `session.close()` when the last release tears the transport down.
  function failPendingWaiters(reason: string): void {
    for (const w of waiters.splice(0)) {
      try { w.reject(new Error(`objstore: ${reason}`)) } catch {}
    }
  }

  // Stale-tolerant: signSubscribe is async; if (socket, nonce)
  // swaps during the await, the captured pair won't match and the
  // send is suppressed.
  function sendSubscribeFor(state: SessionState, nonce: string): void {
    const startSocket = transport.getSocket()
    void (async () => {
      let sig: string
      try { sig = await signSubscribe(state.signingKey, state.workspaceTag, nonce) }
      catch (err) {
        console.warn('objstore: signSubscribe failed:', err)
        return
      }
      if (state.closed || state.subscribed) return
      if (transport.getSocket() !== startSocket || transport.getNonce() !== nonce) return
      // Flip `subscribed` BEFORE send so a re-entrant onConnected
      // (double `challenge`, replay-on-addConsumer, etc.) can't
      // double-fire while the first ack is in flight. Roll back on
      // send-failure so a fresh onConnected can retry. Mirrors
      // `trySendSubscribe` in `client/triage-sync.ts`.
      state.subscribed = true
      if (!transport.send({ type: 'workspace-subscribe', workspaceTag: state.workspaceTag, from: null, signature: sig })) {
        state.subscribed = false
        console.warn('objstore: workspace-subscribe send failed (socket not open)')
      }
    })()
  }

  // MUST REMAIN SYNCHRONOUS — broadcast handlers fire and waiters
  // resolve in wire-arrival order; an `await` here would let two
  // messages interleave. Compare to triage-sync's `messageQueue
  // .then(...)` Promise-chain — that path has awaits inside the
  // consumer-side handler, this one doesn't. If a future change
  // adds an await, mirror the chain pattern.
  function onTransportMessage(msg: WireMessage): void {
    // Broadcasts fan to session handlers; subscribers that register
    // AFTER a broadcast arrived miss it (no replay).
    if (msg.type === 'objstore-put' && typeof msg.workspaceTag === 'string' && isObjectMeta(msg)) {
      const state = sessionsByTag.get(msg.workspaceTag)
      if (!state) return  // workspace closed / unknown — drop silently
      const meta = toObjectMeta(msg)
      // Advance the per-tag rollback watermark — a relay that promises
      // v5 in a broadcast then serves v3 on FETCH hits assertFreshOrLater.
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
      // Delete destroys the row server-side; the next PUT lands as
      // v1. Drop the watermark so the recreate isn't mis-classified
      // as a rollback.
      state.seenVersions.delete(tag)
      const ev = { resourceTag: tag, version }
      for (const h of state.deletedHandlers) { try { h(ev) } catch {} }
      return
    }

    // `subscribed` already flipped true at SEND time (see
    // `sendSubscribeFor`); this handler just unblocks awaiters.
    // Edge: a stale ack from the prior socket can arrive after
    // `onTransportDisconnected` re-armed `subscribedPromise` and
    // unblock awaiters early. Bounded impact — the server doesn't
    // gate ops on subscribe state (only on connection-nonce sig),
    // so a racing op signs against the NEW socket's nonce. Worst
    // case: ops fire ~ms sooner than the proper-subscribe gate
    // would prefer, not "wrong-socket op."
    if (msg.type === 'workspace-subscribed' && typeof msg.workspaceTag === 'string') {
      const state = sessionsByTag.get(msg.workspaceTag)
      if (state) state.resolveSubscribed()
      return
    }

    // Triage-sync frames share the socket (unified transport).
    // Drop explicitly so they don't pile up in `queue`.
    // `authenticated` is transport-internal-but-passed-through
    // (triage-sync claims it as a deferred-send kicker).
    if (msg.type === 'workspace-state' || msg.type === 'workspace-save-ack' || msg.type === 'workspace-save-error' || msg.type === 'authenticated') return

    // Request-response correlation: first matching waiter wins,
    // else queue for a later `recv`.
    for (let i = 0; i < waiters.length; i++) {
      if (waiters[i]!.predicate(msg)) {
        const w = waiters[i]!
        waiters.splice(i, 1)
        w.resolve(msg)
        return
      }
    }
    queue.push(msg)
    // FIFO-evict beyond the cap so an unknown frame type can't grow
    // the queue unbounded. Warn with the dropped types so a future
    // debug session can see what accumulated.
    if (queue.length > MAX_QUEUE_SIZE) {
      const dropped = queue.splice(0, queue.length - MAX_QUEUE_SIZE)
      const types = [...new Set(dropped.map((m) => (m as { type?: unknown }).type ?? '<no-type>'))].slice(0, 4)
      console.warn(`objstore: dropping ${dropped.length} unmatched frame(s) over MAX_QUEUE_SIZE=${MAX_QUEUE_SIZE} (types: ${types.join(', ')})`)
    }
  }

  function onTransportConnected(nonce: string): void {
    for (const state of sessionsByTag.values()) {
      if (state.closed || state.subscribed) continue
      sendSubscribeFor(state, nonce)
    }
  }

  function onTransportDisconnected(reason: string): void {
    // Drain so in-flight requests don't time out, then re-arm each
    // session's subscribed gate for the next onConnected.
    failPendingWaiters(reason)
    for (const state of sessionsByTag.values()) {
      if (state.closed) continue
      if (state.subscribed) {
        state.subscribed = false
        makeSubscribedDeferred(state)
      }
    }
  }

  const consumerHandle: ConsumerHandle = transport.addConsumer({
    onMessage: onTransportMessage,
    onConnected: onTransportConnected,
    onDisconnected: onTransportDisconnected,
  })

  // Wire-level PUT — takes a pre-computed resourceTag + ciphertext.
  // `put` (public) is the encrypting wrapper.
  async function _rawPut(state: SessionState, opts: { resourceTag: string; bytes: Uint8Array; prevVersion: number | null }): Promise<RawPutResult> {
    await state.subscribedPromise
    if (state.closed) throw new Error('objstore: session closed')
    const nonce = transport.getNonce()
    if (!nonce) throw new Error('objstore: socket not open')
    const contentHash = await computeContentHash(opts.bytes)
    const fields: ObjstorePutBeginFields = {
      workspaceTag: state.workspaceTag,
      resourceTag: opts.resourceTag,
      prevVersion: opts.prevVersion,
      expectedLength: opts.bytes.byteLength,
      contentHash,
    }
    const signature = await signObjstorePut(state.signingKey, fields, nonce)
    // At most ONE retry after a successful auth flow. The signature
    // binds all the per-frame fields including connectionNonce —
    // none change between retries on the same socket — so reuse is
    // safe. `attemptedAuth` caps the loop in the pathological case
    // where auth succeeds but a second `unauthorized` still arrives.
    let reply: WireMessage
    let attemptedAuth = false
    while (true) {
      send({ type: 'objstore-put-begin', ...fields, signature })
      // Pin on `kind: 'gated'` so the `auth-failed` reply from our
      // own in-flight `authenticate` (already consumed by the
      // transport) can't satisfy this predicate.
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
      const authed = await transport.runAuthFlow()
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
        // No explicit `content-length` — browser `fetch()` forbids
        // setting it; both undici and the browser compute it from
        // the body bytes (matches the server's parse).
        'authorization': `Bearer ${reply['token']}`,
        'content-type': 'application/octet-stream',
      },
      body: opts.bytes as Uint8Array<ArrayBuffer>,
    })
    if (!res.ok) {
      // 503 + `{ error: 'contended' }`: server's commit-lock held
      // by another in-flight op (server waited 2s before surfacing).
      // Typed retryable so the caller can back off rather than die.
      if (res.status === 503) {
        let body: { error?: unknown } = {}
        try { body = await res.json() as { error?: unknown } } catch {}
        if (body.error === 'contended') return { ok: false, reason: 'contended' }
        // Other 503s fall through to the generic-error throw.
      }
      if (res.status === 409 || res.status === 410) {
        // 409 carries `currentVersion` for the retry loop; 410
        // (`gone`, staging row reaped) doesn't have a live version.
        const current = res.status === 409 ? await parseRestConflictVersion(res) : null
        return { ok: false, reason: 'conflict', current }
      }
      let body = ''
      try { body = await res.text() } catch {}
      throw new Error(`objstore: REST PUT failed ${res.status} ${body.slice(0, 200)}`)
    }
    // Validate the server echoed back the same contentHash +
    // contentLength the client signed. Divergence = protocol bug /
    // buggy proxy / hostile relay (server commitPut verifies the
    // body matches the signed hash before producing this ack).
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
  //
  // A concurrent commit/delete can land between the WS token-issue
  // and the REST GET. The server's openLiveUnderLock gates on the
  // token's `ver` matching the current live row, so the racing
  // outcomes the GET observes are:
  //   - REST 404 "not-found": row was at v1 when token issued, now
  //     at v2 (or deleted) — token is stale.
  //   - REST 503 "unavailable": row exists at the token's version
  //     but the bytes/size momentarily diverge (the commitPut
  //     promote/upsert window, or a reaper sweep on a stranded blob).
  // Both states are transient: re-issuing the WS fetch picks up the
  // current live row (or a stable not-found if the resource is truly
  // gone). Without this retry, a CAS PUT v2 that races a concurrent
  // fetch can surface null even though one of v1/v2 is always live —
  // violating the atomicity contract pinned by
  // `tests/objstore-client-races.test.js` ('GET races concurrent
  // PUT v2'). Bounded so a constantly-thrashed resource still
  // eventually surfaces null rather than spinning.
  async function _rawFetch(state: SessionState, resourceTag: string): Promise<{ bytes: Uint8Array; meta: ObjectMeta } | null> {
    for (let attempt = 0; attempt < REST_RACE_MAX_ATTEMPTS; attempt++) {
      const r = await _rawFetchOnce(state, resourceTag)
      if (r.kind === 'ok') return r.value
      if (r.kind === 'not-found') return null
      // r.kind === 'retry' — REST 404 or 503 against a token the
      // server minted. Re-issue the WS fetch.
      if (attempt + 1 < REST_RACE_MAX_ATTEMPTS) {
        await new Promise<void>((resolve) => { setTimeout(resolve, REST_RACE_BACKOFF_MS) })
      }
    }
    return null
  }

  async function _rawFetchOnce(state: SessionState, resourceTag: string): Promise<
    | { kind: 'ok'; value: { bytes: Uint8Array; meta: ObjectMeta } }
    | { kind: 'not-found' }
    | { kind: 'retry' }
  > {
    await state.subscribedPromise
    if (state.closed) throw new Error('objstore: session closed')
    const nonce = transport.getNonce()
    if (!nonce) throw new Error('objstore: socket not open')
    const signature = await signObjstoreFetch(state.signingKey, state.workspaceTag, resourceTag, nonce)
    send({ type: 'objstore-fetch', workspaceTag: state.workspaceTag, resourceTag, signature })
    const reply = await recv((m) =>
      m.workspaceTag === state.workspaceTag && m.resourceTag === resourceTag && (
        m.type === 'objstore-fetch-token' ||
        m.type === 'objstore-fetch-not-found'
      ),
    )
    if (reply.type === 'objstore-fetch-not-found') return { kind: 'not-found' }
    if (typeof reply['urlPath'] !== 'string' || typeof reply['token'] !== 'string' || !isObjectMeta(reply)) {
      throw new TypeError('objstore: malformed fetch-token (missing urlPath / token / metadata)')
    }
    const meta = toObjectMeta(reply)
    const res = await globalThis.fetch(deps.httpOrigin + reply['urlPath'], {
      method: 'GET',
      headers: { 'authorization': `Bearer ${reply['token']}` },
    })
    if (!res.ok) {
      // 404: live row deleted or advanced past the token's version.
      // 503: row present but file missing / size diverged (commitPut
      // promote-vs-upsert window, or reaper sweep).
      // Both are transient — re-issue the WS fetch.
      if (res.status === 404 || res.status === 503) return { kind: 'retry' }
      let body = ''
      try { body = await res.text() } catch {}
      throw new Error(`objstore: REST GET failed ${res.status} ${body.slice(0, 200)}`)
    }
    const bytes = new Uint8Array(await res.arrayBuffer())
    // Tamper-detection: mismatch is proof the relay (or network)
    // swapped bytes — the signature covered this exact hash.
    const actualHash = await computeContentHash(bytes)
    if (actualHash !== meta.contentHash) {
      throw new Error(`objstore: contentHash mismatch — expected ${meta.contentHash.slice(0, 16)}…, got ${actualHash.slice(0, 16)}…`)
    }
    return { kind: 'ok', value: { bytes, meta } }
  }

  // Wire-level DELETE. `delete` (public) is the encrypting wrapper —
  // it derives the tag from the plaintext fileName and calls here.
  async function _rawDelete(state: SessionState, resourceTag: string, prevVersion: number | null): Promise<RawDeleteResult> {
    await state.subscribedPromise
    if (state.closed) throw new Error('objstore: session closed')
    const nonce = transport.getNonce()
    if (!nonce) throw new Error('objstore: socket not open')
    const fields: ObjstoreDeleteFields = { workspaceTag: state.workspaceTag, resourceTag, prevVersion }
    const signature = await signObjstoreDelete(state.signingKey, fields, nonce)
    send({ type: 'objstore-delete', ...fields, signature })
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
    const nonce = transport.getNonce()
    if (!nonce) throw new Error('objstore: socket not open')
    const signature = await signObjstoreList(state.signingKey, state.workspaceTag, nonce)
    send({ type: 'objstore-list', workspaceTag: state.workspaceTag, signature })
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

    // Acquire a transport reference — the transport opens the socket
    // on the first acquire and tears it down when the last release
    // fires. Released on session.close() OR the rollback path below.
    const acquireHandle = transport.acquire()
    acquiresByTag.set(workspaceTag, acquireHandle)

    // If the socket is already connected, kick a subscribe immediately
    // so we don't wait for the next reconnect. Otherwise the
    // transport's `onConnected(nonce)` callback will pick us up the
    // moment the challenge frame lands.
    const currentNonce = transport.getNonce()
    if (currentNonce) sendSubscribeFor(full, currentNonce)

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
      acquiresByTag.delete(workspaceTag)
      full.closed = true
      try { full.contentKey.fill(0) } catch {}
      try { full.tagKey.fill(0) } catch {}
      // Releasing the transport acquisition drops the refcount; if
      // this was the only/first session, the transport tears the
      // socket down and our `onTransportDisconnected` drains pending
      // waiters. No need for a manual teardown here.
      acquireHandle.release()
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
        // Release the transport acquisition. If this was the last
        // open session, the transport's refcount drops to zero and
        // it tears the socket down synchronously — our
        // `onTransportDisconnected` handler drains pending waiters
        // before the underlying close() lands, so an in-flight
        // `_rawPut`/`_rawFetch`/etc. fails fast instead of hanging
        // for `requestTimeoutMs`.
        const handle = acquiresByTag.get(workspaceTag)
        acquiresByTag.delete(workspaceTag)
        if (handle) handle.release()
      },
    }
  }

  function close(): void {
    if (clientClosed) return
    clientClosed = true
    // Close every open session — wipe keys, drop from the map, reject
    // pending subscribe waiters. We release all acquisitions and then
    // close the transport: closing the transport triggers
    // `onTransportDisconnected` which calls `failPendingWaiters`.
    for (const state of sessionsByTag.values()) {
      state.closed = true
      try { state.contentKey.fill(0) } catch {}
      try { state.tagKey.fill(0) } catch {}
      try { state.rejectSubscribed(new Error('objstore: client closed')) } catch {}
    }
    sessionsByTag.clear()
    for (const handle of acquiresByTag.values()) handle.release()
    acquiresByTag.clear()
    consumerHandle.remove()
    // Only close the transport when this client owns it. Shared
    // transports (e.g. the triage-sync singleton) are torn down by
    // their owner.
    if (ownsTransport) transport.close()
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
