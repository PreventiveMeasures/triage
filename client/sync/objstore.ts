// Client for the v1.objstore extension. Pair with the triage-sync
// relay (see e2e-server/README.md). Two planes:
//
// - **WS control plane**. A single multiplexed WebSocket per client
//   (`createObjstoreClient`) — every workspace the client opens
//   (`client.openWorkspace(keys, subscription)`) shares the
//   per-connection `challenge` nonce, bound into every signed request
//   frame. The client does NOT send `workspace-subscribe` of its own:
//   it rides triage-sync's single subscribe for the same workspace tag
//   on the shared socket, which is what registers the socket for
//   `objstore-put` / `-deleted` broadcasts; our nonce-signed requests
//   only need the socket connected. `openWorkspace` REQUIRES a
//   `WorkspaceSubscription` token (minted by
//   `triageSync.ensureSubscription`) so a session can never be opened —
//   and never send a request frame — for a tag with no backing sync
//   subscribe. Request frames (`objstore-put-begin` / `-fetch` /
//   `-delete`) carry `workspaceTag` so replies route back to the right
//   session; the inventory snapshot rides the `workspace-subscribed`
//   ack (no separate list request). Broadcasts (`objstore-put`,
//   `objstore-deleted`)
//   carry `workspaceTag` and fan out to the matching session's handlers.
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
  signObjstoreDeleteRest,
  signObjstoreFetch,
  signObjstoreFetchRest,
  signObjstorePut,
  signObjstorePutBeginRest,
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
  SESSION_RESTART_REASON,
  type SocketTransport,
  createSocketTransport,
} from './socket-transport.ts'

export { type ObjstoreKeys, deriveObjstoreKeys } from './objstore-content-crypto.ts'

// Resolver shape for the operator-side first-action gate. Matches
// `AuthenticationResolver` in client/triage-sync.ts so the UI can
// install the same dialog-driver in both places. `retry: true`
// means the previous attempt on this socket failed the password
// compare — UI surfaces "wrong password" rather than re-prompting
// cold. Returning `null` / `undefined` cancels (the put returns
// `{ ok: false, reason: 'unauthorized' }` as usual).
export type ObjstoreAuthResolver = (context: { retry: boolean }) => Promise<string | null | undefined>

// Server-emitted wire row shape. Carried in the `workspace-subscribed`
// ack's `resources` snapshot, embedded in `_rawFetch`-token replies,
// and broadcast on `objstore-put`. Internal — the public API surfaces
// `Listing` (just `{ version, contentLength }` per fileName) and
// decrypted `FetchResult`.
type ObjectMeta = {
  resourceTag: string
  version: number
  incarnation: string
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
  incarnation: string
  contentLength: number
}

// Optimistic-concurrency precondition. `null` = "must not exist" (first
// write). Otherwise the EXACT (version, incarnation) the caller observed
// for the state it intends to update — both echoed back from a prior
// put/fetch/list result. Carrying the incarnation is what stops a stale
// version from matching a freshly-recreated incarnation at the same
// number (the cross-incarnation overwrite). Pass a result's `meta` or a
// listing entry straight through.
export type ObjstorePrev = { version: number; incarnation: string } | null

export type PutResult =
  | { ok: true; meta: { version: number; incarnation: string; contentLength: number } }
  | { ok: false; reason: 'conflict'; current: { version: number; incarnation: string } | null }
  | { ok: false; reason: 'workspace-full' }
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
  | { ok: false; reason: 'conflict'; current: { version: number; incarnation: string } | null }
  | { ok: false; reason: 'not-found' }

// `fetch(fileName)` returns plaintext content + version. `fileName`
// is omitted from the result because the caller already knows it
// (they passed it in). `fetchByTag` reverses the AAD-bound name and
// returns both fields.
export type FetchResult = { content: Uint8Array; version: number; incarnation: string }
// Bundle fetch carries the user-friendly name alongside the bytes —
// peers downloading a bundle they didn't upload themselves need this
// to render a meaningful sidebar label. The integrity is what the
// caller passed in.
export type FetchBundleResult = { name: string; content: Uint8Array; version: number; incarnation: string }
// `fetchByTag` returns a discriminated union: the embedded "name" in
// the encrypted payload is either a report fileName (kind='report')
// or a bundle's sha512 integrity (kind='bundle'). The session decides
// which by round-tripping the embedded name through both tag
// derivations and matching against the requested resourceTag. Callers
// that only care about reports can `if (r.kind === 'report')` and
// discard bundles. The bundle branch additionally unwraps the
// structured content prefix to surface the user-friendly bundle name.
export type FetchByTagResult =
  | { kind: 'report'; fileName: string; content: Uint8Array; version: number; incarnation: string }
  | { kind: 'bundle'; integrity: string; name: string; content: Uint8Array; version: number; incarnation: string }

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
  // omitted, the client creates a private transport (used by tests
  // that need a peer-broadcast-isolated socket).
  transport?: SocketTransport
}

export type ObjstoreSession = {
  // PUT a plaintext (fileName, content) pair. Internally derives
  // the wire tag, encrypts the payload, and routes the put-begin +
  // REST PUT round-trip. `prevVersion` is the optimistic-concurrency
  // precondition: `null` for first upload, the version returned by
  // the previous `put` / `list` / `fetch` for an in-place overwrite.
  put(opts: { fileName: string; content: Uint8Array; prev: ObjstorePrev }): Promise<PutResult>
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
  delete(fileName: string, prev: ObjstorePrev): Promise<DeleteResult>
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
  putBundle(opts: { integrity: string; name: string; content: Uint8Array; prev: ObjstorePrev }): Promise<PutResult>
  fetchBundle(integrity: string): Promise<FetchBundleResult | null>
  deleteBundle(integrity: string, prev: ObjstorePrev): Promise<DeleteResult>
  close(): void
}

// Proof that an external subscriber — triage-sync — owns the single
// `workspace-subscribe` for a session's tag on the shared socket. The
// objstore client never subscribes on its own (it rides triage-sync's
// subscribe), so it must never open a session — and thus never send a
// request frame (`-fetch` / `-put-begin` / `-delete`) or rely on the
// subscribe-ack inventory — for a tag nobody is subscribed to.
// `openWorkspace` REQUIRES one,
// minted by `triageSync.ensureSubscription(workspaceId)`, which
// guarantees a sync session (and hence its `workspace-subscribe`) is
// established first. This makes "objstore op without a subscribe"
// unrepresentable in the API rather than a latent client logic error.
//
// The token also carries the objstore inventory snapshot from the
// `workspace-subscribed` ack. triage-sync owns the subscribe and
// receives the ack, so it hands the rows over here — the objstore
// client seeds its inventory from this rather than racing to observe a
// one-shot ack on the shared socket (which it may not even be listening
// for yet). Resolves [] for a triage-only / empty workspace.
//
// `workspaceTag` binds the token to a specific workspace: `openWorkspace`
// rejects a token whose tag doesn't match the session's keys, so a token
// minted for workspace A can't be used to open a session for B. It's
// `null` only while the minting session's key derivation is still in
// flight (a fresh on-demand open) — in which case the binding can't be
// checked and is skipped; the common path (sync session already open)
// always carries it.
export type WorkspaceSubscription = {
  readonly workspaceId: string
  readonly workspaceTag: string | null
  readonly resources: Promise<readonly unknown[]>
}

// Public surface of the multiplexed client. Each `openWorkspace`
// adds a session to the shared socket; `close()` tears the socket
// down and closes every open session.
export type ObjstoreClient = {
  openWorkspace(keys: ObjstoreKeys, subscription: WorkspaceSubscription): Promise<ObjstoreSession>
  close(): void
}

// Wire-shape envelope every server frame lands as post-JSON.parse.
// Every field is unknown; the dispatcher narrows on `type` then on
// `resourceTag` to correlate to a pending request. The session's
// outbound frames carry the same shape but with stricter types.
type WireMessage = { type?: unknown; workspaceTag?: unknown; resourceTag?: unknown; [k: string]: unknown }

// Cap on the unmatched-message queue. Any waiter older than this
// many unmatched frames is lost — acceptable, since a properly-
// behaving session shouldn't have unmatched frames piling up at
// all. Empirically the queue depth is bounded by inflight ops.
const MAX_QUEUE_SIZE = 64

// Bound on how many times `withSessionRestartRetry` replays an op (a
// put's begin→token handshake, or a fetch) across a transient session
// restart (an SSE replica hop re-challenges with a fresh nonce; see
// `withSessionRestartRetry`). High enough that a bulk recovery riding
// through a few hops still completes per-object, low enough that a
// genuinely flapping socket surfaces the error instead of spinning.
const MAX_SESSION_RESTART_RETRIES = 5

// REST GET vs concurrent commit / backend propagation: a token minted at
// v1 can race a commitPut that lands v2 before the GET reaches the server
// (→ 404 token-ver mismatch), or the live row can be present while its
// bytes are momentarily absent (→ 503): the commitPut promote→CAS window,
// a reaper sweep on a just-superseded hash, or — on the Vercel Blob byte
// plane — read-after-write / edge-propagation lag on a freshly-promoted
// private blob. The first two are microsecond races; Vercel-Blob
// propagation can run hundreds of ms, so the budget is an exponential-
// backoff CEILING, not a fixed cost: nearly every fetch resolves on the
// first attempt, and only a genuinely degraded read spends the full budget
// before surfacing null. A truly absent resource never enters this loop —
// the WS fetch returns `objstore-fetch-not-found` and `_rawFetch` returns
// null immediately (see `_rawFetchOnce`).
const REST_RACE_MAX_ATTEMPTS = 6
const REST_RACE_BACKOFF_BASE_MS = 25
const REST_RACE_BACKOFF_CAP_MS = 500

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
  // Per-tag rollback watermark, keyed by incarnation — see
  // `noteVersion` / `assertFreshOrLater`. Tracks the highest version
  // seen WITHIN the current incarnation; a different incarnation
  // (delete+recreate) legitimately restarts at v1 and resets the floor.
  seenVersions: Map<string, { incarnation: string; version: number }>
  // True while the shared socket is connected (a challenge nonce is
  // available). Flips in `onTransportConnected` (and openWorkspace's
  // already-connected check), cleared in `onTransportDisconnected`.
  // Guards the re-arm of `connectedPromise` so a disconnect while
  // already disconnected doesn't churn the deferred.
  connected: boolean
  // Resolves once the socket is connected. Pending requests (and
  // `openWorkspace` itself) await this before signing — the per-frame
  // signature binds the connection nonce, so an op can't proceed until
  // a nonce exists. Re-armed on disconnect so a request issued during
  // the reconnect window blocks until the new socket's challenge lands
  // rather than failing fast with "socket not open".
  connectedPromise: Promise<void>
  resolveConnected: () => void
  rejectConnected: (err: Error) => void
  // Live inventory keyed by resourceTag — the client's view of what the
  // relay holds for this workspace. Seeded from the `workspace-subscribed`
  // ack's `resources` snapshot, then kept current by this session's own
  // put/delete results and by `objstore-put` / `-deleted` broadcasts.
  // `list()` is a read of this map, not a wire request.
  inventory: Map<string, { version: number; incarnation: string; contentLength: number }>
  // Resolves once the inventory has been seeded at least once (the first
  // `workspace-subscribed` for this tag). `list()` awaits it so an early
  // read doesn't return an empty snapshot before the subscribe ack lands.
  listedPromise: Promise<void>
  resolveListed: () => void
  rejectListed: (err: Error) => void
  closed: boolean
}

// Validates and resolves a server-supplied urlPath against a known-good
// httpOrigin. Two gates:
//   1. Regex: only the exact server route shape is accepted.
//   2. WHATWG URL origin check: defense-in-depth against encoding tricks.
// Exported via __test__ only — not a committed public API.
function validateObjstoreUrlPath(urlPath: string, httpOrigin: string): string {
  if (!/^\/api\/objstore\/[\w-]+\/[\w-]+$/u.test(urlPath)) {
    throw new TypeError(`objstore: urlPath rejected (unexpected shape): ${JSON.stringify(urlPath)}`)
  }
  const expectedOrigin = new URL(httpOrigin).origin
  const url = new URL(urlPath, expectedOrigin)
  if (url.origin !== expectedOrigin) {
    throw new TypeError(`objstore: urlPath origin mismatch — expected ${expectedOrigin}, got ${url.origin}`)
  }
  return url.href
}
export const __test__ = { validateObjstoreUrlPath, isObjectMeta, isSafeNonNegativeInt, MAX_SESSION_RESTART_RETRIES }

export function createObjstoreClient(deps: ObjstoreClientDeps): ObjstoreClient {
  const timeoutMs = deps.requestTimeoutMs ?? 10_000
  const httpOriginParsed = new URL(deps.httpOrigin).origin

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

  function noteVersion(state: SessionState, tag: string, incarnation: string, version: number): void {
    const prev = state.seenVersions.get(tag)
    // A new incarnation resets the floor (fresh lineage); within the same
    // incarnation we keep the high-water mark.
    if (!prev || prev.incarnation !== incarnation || version > prev.version) {
      state.seenVersions.set(tag, { incarnation, version })
    }
  }

  function makeConnectedDeferred(state: Partial<SessionState>): void {
    state.connectedPromise = new Promise<void>((resolve, reject) => {
      state.resolveConnected = resolve
      state.rejectConnected = reject
    })
    // Pre-attach a catch so reconnect-time rejections don't spam
    // the console as unhandled — internal paths don't always await.
    state.connectedPromise.catch(() => {})
  }

  function makeListedDeferred(state: Partial<SessionState>): void {
    state.listedPromise = new Promise<void>((resolve, reject) => {
      state.resolveListed = resolve
      state.rejectListed = reject
    })
    state.listedPromise.catch(() => {})
  }

  // Replace the session's inventory with a server snapshot (the
  // `workspace-subscribed` resources). Also advances the rollback
  // watermark per resource — a relay that promised v5 in the snapshot
  // then serves v3 on FETCH hits assertFreshOrLater. Resolves the
  // `listed` gate so a pending `list()` returns.
  function seedInventory(state: SessionState, resources: ObjectMeta[]): void {
    state.inventory.clear()
    for (const m of resources) {
      state.inventory.set(m.resourceTag, { version: m.version, incarnation: m.incarnation, contentLength: m.contentLength })
      noteVersion(state, m.resourceTag, m.incarnation, m.version)
    }
    state.resolveListed()
  }

  // Narrow a wire `resources` field to ObjectMeta[] (drops malformed
  // entries rather than throwing — a single bad row shouldn't sink the
  // whole subscribe ack).
  function parseResources(raw: unknown): ObjectMeta[] {
    if (!Array.isArray(raw)) return []
    const out: ObjectMeta[] = []
    for (const entry of raw) {
      if (isObjectMeta(entry as WireMessage | undefined)) out.push(toObjectMeta(entry as WireMessage))
    }
    return out
  }

  // Await the first inventory seed (the `workspace-subscribed` ack),
  // bounded so a session whose tag is somehow never subscribed surfaces
  // a timeout instead of hanging `list()` forever.
  function awaitListed(state: SessionState): Promise<void> {
    let t: ReturnType<typeof setTimeout>
    return new Promise<void>((resolve, reject) => {
      t = setTimeout(() => reject(new Error(`objstore: inventory not seeded (no subscribe ack) after ${timeoutMs}ms`)), timeoutMs)
      state.listedPromise.then(resolve, reject)
    }).finally(() => clearTimeout(t))
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
      noteVersion(state, meta.resourceTag, meta.incarnation, meta.version)
      // Keep the live inventory current so `list()` reflects peer puts.
      state.inventory.set(meta.resourceTag, { version: meta.version, incarnation: meta.incarnation, contentLength: meta.contentLength })
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
      // as a rollback, and drop it from the live inventory.
      state.seenVersions.delete(tag)
      state.inventory.delete(tag)
      const ev = { resourceTag: tag, version }
      for (const h of state.deletedHandlers) { try { h(ev) } catch {} }
      return
    }

    // Triage-sync frames share the socket (unified transport). Drop
    // explicitly so they don't pile up in `queue`. `workspace-subscribed`
    // is triage-sync's subscribe ack — we ride that subscribe and receive
    // its `resources` inventory snapshot via the `WorkspaceSubscription`
    // token (triage-sync hands it over), not by observing the ack here.
    // `authenticated` is transport-internal-but-passed-through.
    if (msg.type === 'workspace-state' || msg.type === 'workspace-save-ack' || msg.type === 'workspace-save-error' || msg.type === 'workspace-subscribed' || msg.type === 'authenticated') return

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

  function onTransportConnected(): void {
    for (const state of sessionsByTag.values()) {
      if (state.closed || state.connected) continue
      state.connected = true
      state.resolveConnected()
    }
  }

  function onTransportDisconnected(reason: string): void {
    // Drain so in-flight requests don't time out, then re-arm each
    // session's connected gate for the next onConnected.
    failPendingWaiters(reason)
    for (const state of sessionsByTag.values()) {
      if (state.closed) continue
      if (state.connected) {
        state.connected = false
        makeConnectedDeferred(state)
      }
    }
  }

  const consumerHandle: ConsumerHandle = transport.addConsumer({
    onMessage: onTransportMessage,
    onConnected: onTransportConnected,
    onDisconnected: onTransportDisconnected,
  })

  const buildObjstoreUrl = (urlPath: string) => validateObjstoreUrlPath(urlPath, httpOriginParsed)

  // The REST mint endpoint for (tag, res) — same `/api/objstore/...` route
  // as GET/PUT, validated against the captured origin. POST here mints a
  // fetch/put token without the SSE round-trip (see the REST handlers in
  // e2e-server/objstore/rest.ts).
  const restMintUrl = (workspaceTag: string, resourceTag: string) =>
    buildObjstoreUrl(`/api/objstore/${workspaceTag}/${resourceTag}`)

  // Outcome of a put-begin handshake (WS in-band OR REST mint), before the
  // byte PUT. The byte PUT itself is identical for both.
  type PutBeginOutcome =
    | { kind: 'token'; urlPath: string; token: string }
    | { kind: 'conflict'; current: { version: number; incarnation: string } | null }
    | { kind: 'workspace-full' }
    | { kind: 'unauthorized' }

  // In-band WS put-begin handshake. Also the SSE-mode fallback for the
  // new-workspace operator gate (it runs `runAuthFlow` on a `gated` reply
  // and retries). Returns the token (or a conflict / workspace-full /
  // unauthorized outcome) — the caller does the byte PUT.
  async function wsPutBegin(state: SessionState, resourceTag: string, fields: ObjstorePutBeginFields): Promise<PutBeginOutcome> {
    const nonce = transport.getNonce()
    if (!nonce) throw new Error('objstore: socket not open')
    const signature = await signObjstorePut(state.signingKey, fields, nonce)
    // At most ONE retry after a successful auth flow — see the prior
    // _rawPutOnce note; the signature reuse across the retry is safe
    // because connectionNonce doesn't change on the same socket.
    let reply: WireMessage
    let attemptedAuth = false
    while (true) {
      send({ type: 'objstore-put-begin', ...fields, signature })
      // Pin on `kind: 'gated'` so the `auth-failed` reply from our own
      // in-flight `authenticate` can't satisfy this predicate.
      reply = await recv((m) =>
        m.workspaceTag === state.workspaceTag && m.resourceTag === resourceTag && (
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
    if (reply.type === 'unauthorized') return { kind: 'unauthorized' }
    if (reply.type === 'objstore-put-error') {
      if (reply['reason'] === 'workspace-full') return { kind: 'workspace-full' }
      throw new Error(`objstore: put-error reason='${String(reply['reason'])}'`)
    }
    if (reply.type === 'objstore-conflict') {
      const current = isObjectMeta(reply['current'] as WireMessage | undefined) ? toObjectMeta(reply['current'] as WireMessage) : null
      return { kind: 'conflict', current }
    }
    if (typeof reply['urlPath'] !== 'string' || typeof reply['token'] !== 'string') {
      throw new TypeError('objstore: malformed put-token (missing urlPath/token)')
    }
    return { kind: 'token', urlPath: reply['urlPath'], token: reply['token'] }
  }

  // REST put-begin mint (SSE mode): POST the signed begin to the mint
  // endpoint; the reply is the same token shape over JSON. 401 → the
  // new-workspace operator gate (caller falls back to `wsPutBegin`); 409 →
  // conflict (rebase); 403 → workspace-full.
  async function restPutBegin(state: SessionState, resourceTag: string, fields: ObjstorePutBeginFields, contentHash: string): Promise<PutBeginOutcome> {
    const ts = Date.now()
    const signature = await signObjstorePutBeginRest(state.signingKey, fields, ts)
    const res = await globalThis.fetch(restMintUrl(state.workspaceTag, resourceTag), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        op: 'put', ts, signature,
        prevVersion: fields.prevVersion, prevIncarnation: fields.prevIncarnation,
        expectedLength: fields.expectedLength, contentHash,
      }),
    })
    if (res.status === 401) return { kind: 'unauthorized' }
    if (res.status === 403) return { kind: 'workspace-full' }
    if (res.status === 409) return { kind: 'conflict', current: await parseRestConflict(res) }
    if (!res.ok) {
      let body = ''
      try { body = await res.text() } catch {}
      throw new Error(`objstore: REST put-begin failed ${res.status} ${body.slice(0, 200)}`)
    }
    let mint: unknown
    try { mint = await res.json() } catch { throw new TypeError('objstore: put-mint JSON parse failed') }
    if (!mint || typeof mint !== 'object'
      || typeof (mint as { urlPath?: unknown }).urlPath !== 'string'
      || typeof (mint as { token?: unknown }).token !== 'string') {
      throw new TypeError('objstore: malformed put-mint (missing urlPath/token)')
    }
    return { kind: 'token', urlPath: (mint as { urlPath: string }).urlPath, token: (mint as { token: string }).token }
  }

  // Replay `op` across a transient session restart. An SSE replica hop
  // re-challenges with a fresh nonce; `socket-transport.ts` fires a
  // synthetic disconnect (`SESSION_RESTART_REASON`) that
  // `failPendingWaiters` turns into an `objstore: session restarted`
  // rejection of WHATEVER socket `recv` is in flight — the put-token wait
  // (`_rawPutOnce`) OR the fetch-token wait (`_rawFetchOnce`). The session
  // reconnects synchronously against the new nonce, so `op` (which
  // re-awaits the connected gate and re-signs) is safe to replay. Without
  // this, the mass re-upload flow surfaced a 'failed'/'check-failed' row
  // per hop ("… failed: objstore: session restarted").
  //
  // Replay-safety obligations on `op`:
  //   - `_rawFetchOnce` is an idempotent read — always safe.
  //   - `_rawPutOnce`'s replay is pre-commit: the server commits only on
  //     the REST PUT, which is NOT a socket waiter and so is never the
  //     source of this rejection. A replayed begin at most mints a fresh
  //     staging row the reaper collects; it can't double-commit.
  //   - `_rawDeleteOnce` is idempotent: a WS-mode delete commits on the
  //     socket frame the restart CAN interrupt (unlike put), so a drop that
  //     committed before its ack was lost to the hop replays against an
  //     already-gone row -> not-found (non-null prev) / deletedVersion 0
  //     (null prev). That's the desired gone-state, already reachable via a
  //     manual retry, so the replay can't corrupt anything.
  //
  // No-hang invariant: the `op`'s re-await of `state.connectedPromise`
  // relies on the restart being IMMEDIATELY followed by a synchronous
  // reconnect — `socket-transport.ts` always fires `notifyConnected(new
  // nonce)` in the same turn as the `SESSION_RESTART_REASON` disconnect,
  // so the re-armed gate is already resolved when the retry re-enters. If
  // that ordering ever changes, the retry would wait on the next
  // reconnect (no worse than the pre-change first-await, but worth
  // flagging). Bounded by `MAX_SESSION_RESTART_RETRIES`.
  async function withSessionRestartRetry<T>(state: SessionState, op: () => Promise<T>): Promise<T> {
    // Reconstruct the wrapped message `failPendingWaiters` produces for a
    // restart. The reason half is imported from socket-transport (its emit
    // site) so a reword there can't silently desync this guard; the
    // `objstore: ` prefix half is owned here (failPendingWaiters).
    const restartMessage = `objstore: ${SESSION_RESTART_REASON}`
    for (let retries = 0; ; retries++) {
      try {
        return await op()
      } catch (err) {
        if (
          retries < MAX_SESSION_RESTART_RETRIES
          && !state.closed
          && err instanceof Error
          && err.message === restartMessage
        ) {
          continue
        }
        throw err
      }
    }
  }

  // Wire-level PUT. Wraps the single attempt with the session-restart
  // replay (see `withSessionRestartRetry`). Covers both `put` and
  // `putBundle` via `rawPutAndMap`.
  function _rawPut(state: SessionState, opts: { resourceTag: string; bytes: Uint8Array; prev: ObjstorePrev }): Promise<RawPutResult> {
    return withSessionRestartRetry(state, () => _rawPutOnce(state, opts))
  }

  // One begin→put-token→REST-PUT attempt. `put` (public) is the
  // encrypting wrapper; `_rawPut` above wraps THIS with the restart retry.
  async function _rawPutOnce(state: SessionState, opts: { resourceTag: string; bytes: Uint8Array; prev: ObjstorePrev }): Promise<RawPutResult> {
    await state.connectedPromise
    if (state.closed) throw new Error('objstore: session closed')
    const contentHash = await computeContentHash(opts.bytes)
    const fields: ObjstorePutBeginFields = {
      workspaceTag: state.workspaceTag,
      resourceTag: opts.resourceTag,
      prevVersion: opts.prev?.version ?? null,
      prevIncarnation: opts.prev?.incarnation ?? null,
      expectedLength: opts.bytes.byteLength,
      contentHash,
    }
    // Acquire a put-token. In SSE mode mint over REST — independent of the
    // session, so a replica hop can't interrupt it; else use the in-band WS
    // handshake. On a REST new-workspace gate (401 → 'unauthorized') fall
    // back to the WS path, which runs the operator auth flow.
    let outcome: PutBeginOutcome
    if (transport.isSse()) {
      outcome = await restPutBegin(state, opts.resourceTag, fields, contentHash)
      if (outcome.kind === 'unauthorized') outcome = await wsPutBegin(state, opts.resourceTag, fields)
    } else {
      outcome = await wsPutBegin(state, opts.resourceTag, fields)
    }
    if (outcome.kind === 'unauthorized') return { ok: false, reason: 'unauthorized' }
    if (outcome.kind === 'workspace-full') return { ok: false, reason: 'workspace-full' }
    if (outcome.kind === 'conflict') return { ok: false, reason: 'conflict', current: outcome.current }
    // outcome.kind === 'token' → PUT the bytes (identical for both paths).
    const res = await globalThis.fetch(buildObjstoreUrl(outcome.urlPath), {
      method: 'PUT',
      headers: {
        // No explicit `content-length` — browser `fetch()` forbids
        // setting it; both undici and the browser compute it from
        // the body bytes (matches the server's parse).
        'authorization': `Bearer ${outcome.token}`,
        'content-type': 'application/octet-stream',
      },
      body: opts.bytes as Uint8Array<ArrayBuffer>,
    })
    if (!res.ok) {
      if (res.status === 409 || res.status === 410) {
        // 409 carries `currentVersion` for the retry loop; 410
        // (`gone`, staging row reaped) doesn't have a live version.
        const current = res.status === 409 ? await parseRestConflict(res) : null
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
    // `version`/`contentLength` get the same `isSafeNonNegativeInt`
    // gate as isObjectMeta: the PUT-ack `version` is RELAY-CONTROLLED,
    // not pinned client-side (unlike `contentHash`/`contentLength`,
    // re-checked below), yet flows into `noteVersion` (rawPutAndMap).
    // A relay answering with `version: 1e999` (→ Infinity) would poison
    // the rollback watermark — so this ack is a watermark feeder too.
    if (!ack || typeof ack !== 'object'
      || !isSafeNonNegativeInt((ack as { version?: unknown }).version)
      || typeof (ack as { incarnation?: unknown }).incarnation !== 'string'
      || typeof (ack as { contentHash?: unknown }).contentHash !== 'string'
      || !isSafeNonNegativeInt((ack as { contentLength?: unknown }).contentLength)) {
      throw new TypeError('objstore: PUT ack malformed (missing/invalid version/incarnation/contentHash/contentLength)')
    }
    const meta = ack as { version: number; incarnation: string; contentHash: string; contentLength: number }
    if (meta.contentHash !== contentHash || meta.contentLength !== opts.bytes.byteLength) {
      throw new Error(`objstore: PUT ack mismatch — server returned contentHash=${meta.contentHash.slice(0, 16)}… length=${meta.contentLength}, client signed ${contentHash.slice(0, 16)}… length=${opts.bytes.byteLength}`)
    }
    return { ok: true, meta }
  }

  // Wire-level FETCH — returns raw ciphertext + meta. `fetch` /
  // `fetchByTag` (public) wrap this with decryption.
  //
  // A concurrent commit/delete can land between the WS token-issue
  // and the REST GET. The server's openLiveSnapshot gates on the
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
  // Outcome of a fetch-token handshake (WS in-band OR REST mint), before
  // the byte GET. `unauthorized` only arises on the REST path (stale ts /
  // replay / clock skew); the caller falls back to the WS path, which is
  // nonce-bound and has no such failure mode. (Fetch has no operator gate —
  // it's read-only.)
  type FetchTokenOutcome =
    | { kind: 'token'; urlPath: string; token: string; meta: ObjectMeta }
    | { kind: 'not-found' }
    | { kind: 'unauthorized' }

  // In-band WS fetch-token handshake.
  async function wsFetchToken(state: SessionState, resourceTag: string): Promise<FetchTokenOutcome> {
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
    return { kind: 'token', urlPath: reply['urlPath'], token: reply['token'], meta: toObjectMeta(reply) }
  }

  // REST fetch-token mint (SSE mode): POST the signed fetch to the mint
  // endpoint; the reply is the same `{ ...meta, urlPath, token }` shape over
  // JSON. 404 → not-found; 401 → stale/replay (caller falls back to WS).
  async function restFetchToken(state: SessionState, resourceTag: string): Promise<FetchTokenOutcome> {
    const ts = Date.now()
    const signature = await signObjstoreFetchRest(state.signingKey, state.workspaceTag, resourceTag, ts)
    const res = await globalThis.fetch(restMintUrl(state.workspaceTag, resourceTag), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op: 'fetch', ts, signature }),
    })
    if (res.status === 404) return { kind: 'not-found' }
    if (res.status === 401) return { kind: 'unauthorized' }
    if (!res.ok) {
      let body = ''
      try { body = await res.text() } catch {}
      throw new Error(`objstore: REST fetch-mint failed ${res.status} ${body.slice(0, 200)}`)
    }
    let mint: unknown
    try { mint = await res.json() } catch { throw new TypeError('objstore: fetch-mint JSON parse failed') }
    if (!mint || typeof mint !== 'object'
      || typeof (mint as { urlPath?: unknown }).urlPath !== 'string'
      || typeof (mint as { token?: unknown }).token !== 'string'
      || !isObjectMeta(mint as WireMessage)) {
      throw new TypeError('objstore: malformed fetch-mint (missing urlPath / token / metadata)')
    }
    return { kind: 'token', urlPath: (mint as { urlPath: string }).urlPath, token: (mint as { token: string }).token, meta: toObjectMeta(mint as WireMessage) }
  }

  async function _rawFetch(state: SessionState, resourceTag: string): Promise<{ bytes: Uint8Array; meta: ObjectMeta } | null> {
    for (let attempt = 0; attempt < REST_RACE_MAX_ATTEMPTS; attempt++) {
      // Wrap each attempt with the session-restart replay so an SSE
      // replica hop mid-fetch (which rejects the fetch-token `recv` with
      // 'session restarted') re-issues against the fresh nonce instead of
      // throwing — distinct from the kind-based 404/503 race retry below.
      // A read is idempotent, so the replay is unconditionally safe.
      const r = await withSessionRestartRetry(state, () => _rawFetchOnce(state, resourceTag))
      if (r.kind === 'ok') return r.value
      if (r.kind === 'not-found') return null
      // r.kind === 'retry' — REST 404 or 503 against a token the
      // server minted. Re-issue the WS fetch after an exponential
      // backoff capped at REST_RACE_BACKOFF_CAP_MS (25, 50, 100, 200,
      // 400 ms across the 5 inter-attempt waits — ~775 ms ceiling),
      // enough to ride out sub-second Vercel-Blob propagation without
      // hammering the relay.
      if (attempt + 1 < REST_RACE_MAX_ATTEMPTS) {
        const delay = Math.min(REST_RACE_BACKOFF_CAP_MS, REST_RACE_BACKOFF_BASE_MS * 2 ** attempt)
        await new Promise<void>((resolve) => { setTimeout(resolve, delay) })
      }
    }
    return null
  }

  async function _rawFetchOnce(state: SessionState, resourceTag: string): Promise<
    | { kind: 'ok'; value: { bytes: Uint8Array; meta: ObjectMeta } }
    | { kind: 'not-found' }
    | { kind: 'retry' }
  > {
    await state.connectedPromise
    if (state.closed) throw new Error('objstore: session closed')
    // Acquire a fetch-token. In SSE mode mint over REST (session-
    // independent); else the in-band WS handshake. On a REST 401 (stale ts
    // / replay / clock skew) fall back to the nonce-bound WS path.
    let tok: FetchTokenOutcome
    if (transport.isSse()) {
      tok = await restFetchToken(state, resourceTag)
      if (tok.kind === 'unauthorized') tok = await wsFetchToken(state, resourceTag)
    } else {
      tok = await wsFetchToken(state, resourceTag)
    }
    if (tok.kind === 'not-found') return { kind: 'not-found' }
    if (tok.kind === 'unauthorized') throw new Error('objstore: fetch-mint unauthorized')
    const meta = tok.meta
    const res = await globalThis.fetch(buildObjstoreUrl(tok.urlPath), {
      method: 'GET',
      headers: { 'authorization': `Bearer ${tok.token}` },
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
  // Outcome of a delete handshake (WS in-band OR REST mint). `unauthorized`
  // arises only on the REST path (stale ts / replay / clock skew) — delete
  // has no operator gate (it's signature-gated + idempotent + creates
  // nothing), so the caller falls back to the nonce-bound WS path, which
  // can't produce it.
  type DeleteOutcome =
    | { kind: 'ok'; deletedVersion: number }
    | { kind: 'conflict'; current: { version: number; incarnation: string } | null }
    | { kind: 'not-found' }
    | { kind: 'unauthorized' }

  // In-band WS delete handshake.
  async function wsDelete(state: SessionState, fields: ObjstoreDeleteFields): Promise<DeleteOutcome> {
    const nonce = transport.getNonce()
    if (!nonce) throw new Error('objstore: socket not open')
    const signature = await signObjstoreDelete(state.signingKey, fields, nonce)
    send({ type: 'objstore-delete', ...fields, signature })
    const reply = await recv((m) =>
      m.workspaceTag === state.workspaceTag && m.resourceTag === fields.resourceTag && (
        m.type === 'objstore-deleted-ack' ||
        m.type === 'objstore-delete-error' ||
        m.type === 'objstore-conflict'
      ),
    )
    if (reply.type === 'objstore-deleted-ack') {
      if (typeof reply['deletedVersion'] !== 'number') throw new TypeError('objstore: malformed deleted-ack (deletedVersion not a number)')
      return { kind: 'ok', deletedVersion: reply['deletedVersion'] }
    }
    if (reply.type === 'objstore-conflict') {
      const current = isObjectMeta(reply['current'] as WireMessage | undefined) ? toObjectMeta(reply['current'] as WireMessage) : null
      return { kind: 'conflict', current }
    }
    if (reply['reason'] === 'not-found') return { kind: 'not-found' }
    throw new Error(`objstore: delete-error reason='${String(reply['reason'])}'`)
  }

  // REST delete mint (SSE mode): POST the signed delete to the mint endpoint.
  // 200 → `{ deletedVersion }`; 404 → not-found; 409 → conflict; 401 →
  // stale/replay (caller falls back to WS).
  async function restDelete(state: SessionState, resourceTag: string, fields: ObjstoreDeleteFields): Promise<DeleteOutcome> {
    const ts = Date.now()
    const signature = await signObjstoreDeleteRest(state.signingKey, fields, ts)
    const res = await globalThis.fetch(restMintUrl(state.workspaceTag, resourceTag), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op: 'delete', ts, signature, prevVersion: fields.prevVersion, prevIncarnation: fields.prevIncarnation }),
    })
    if (res.status === 401) return { kind: 'unauthorized' }
    if (res.status === 404) return { kind: 'not-found' }
    if (res.status === 409) return { kind: 'conflict', current: await parseRestConflict(res) }
    if (!res.ok) {
      let body = ''
      try { body = await res.text() } catch {}
      throw new Error(`objstore: REST delete failed ${res.status} ${body.slice(0, 200)}`)
    }
    let ack: unknown
    try { ack = await res.json() } catch { throw new TypeError('objstore: delete-ack JSON parse failed') }
    if (!ack || typeof ack !== 'object' || typeof (ack as { deletedVersion?: unknown }).deletedVersion !== 'number') {
      throw new TypeError('objstore: malformed delete-ack (deletedVersion not a number)')
    }
    return { kind: 'ok', deletedVersion: (ack as { deletedVersion: number }).deletedVersion }
  }

  // Wire-level DELETE. Wraps the single attempt with the session-restart
  // replay (see `withSessionRestartRetry`), matching `_rawPut` / `_rawFetch`
  // so an SSE replica hop mid-handshake doesn't surface a spurious
  // "session restarted" error. Safe because delete is idempotent (see the
  // `_rawDeleteOnce` obligation in `withSessionRestartRetry`).
  function _rawDelete(state: SessionState, resourceTag: string, prev: ObjstorePrev): Promise<RawDeleteResult> {
    return withSessionRestartRetry(state, () => _rawDeleteOnce(state, resourceTag, prev))
  }

  // One delete attempt: SSE → REST mint (session-independent), else the
  // in-band WS handshake; on a REST 401 fall back to the WS path.
  async function _rawDeleteOnce(state: SessionState, resourceTag: string, prev: ObjstorePrev): Promise<RawDeleteResult> {
    await state.connectedPromise
    if (state.closed) throw new Error('objstore: session closed')
    const fields: ObjstoreDeleteFields = { workspaceTag: state.workspaceTag, resourceTag, prevVersion: prev?.version ?? null, prevIncarnation: prev?.incarnation ?? null }
    let outcome: DeleteOutcome
    if (transport.isSse()) {
      outcome = await restDelete(state, resourceTag, fields)
      if (outcome.kind === 'unauthorized') outcome = await wsDelete(state, fields)
    } else {
      outcome = await wsDelete(state, fields)
    }
    if (outcome.kind === 'ok') return { ok: true, deletedVersion: outcome.deletedVersion }
    if (outcome.kind === 'conflict') return { ok: false, reason: 'conflict', current: outcome.current }
    if (outcome.kind === 'not-found') return { ok: false, reason: 'not-found' }
    // wsDelete never returns 'unauthorized' (delete has no operator gate), so
    // the fallback above resolves it; this is unreachable defensive cover.
    throw new Error('objstore: delete unauthorized')
  }

  // Reject a fetched object whose version is strictly lower than the
  // highest we've already seen FOR THE SAME INCARNATION. The Ed25519 PUT
  // signature is valid for ANY historical version, so without this
  // watermark a relay could serve a stale-but-signed copy on FETCH and
  // the AEAD / contentHash chain would all check out. Scoping to the
  // incarnation keeps that protection while letting a legitimate
  // delete+recreate (fresh incarnation, restarting at v1) read cleanly
  // even when the client missed the delete broadcast (reconnect window).
  function assertFreshOrLater(state: SessionState, tag: string, incarnation: string, version: number): void {
    const last = state.seenVersions.get(tag)
    if (last && last.incarnation === incarnation && version < last.version) {
      throw new Error(`objstore: version-rollback rejected — fetched v${version} for an incarnation we've already seen at v${last.version}`)
    }
  }

  async function openWorkspace(keys: ObjstoreKeys, subscription: WorkspaceSubscription): Promise<ObjstoreSession> {
    if (clientClosed) throw new Error('objstore: client closed')
    // Enforce the cross-layer invariant: an objstore session may only
    // exist while a sync subscription backs its tag on the shared
    // socket. The token is minted by `triageSync.ensureSubscription`;
    // its absence means a caller tried to open objstore without first
    // establishing the sync subscribe — the exact logic error (an
    // objstore op / inventory read for an unsubscribed tag) this guards.
    if (!subscription || typeof subscription.workspaceId !== 'string') {
      throw new Error('objstore: openWorkspace requires a WorkspaceSubscription (triageSync.ensureSubscription) — the client must not open a session for a tag with no backing sync subscribe')
    }
    const workspaceTag = keys.workspaceTag
    // Bind the token to these keys: a token minted for a different
    // workspace must not open this session. Skipped only when the
    // minting session's tag isn't derived yet (null) — see the type doc.
    if (subscription.workspaceTag != null && subscription.workspaceTag !== workspaceTag) {
      throw new Error('objstore: openWorkspace — WorkspaceSubscription is for a different workspace than these keys')
    }
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
      inventory: new Map(),
      connected: false,
      closed: false,
    }
    makeConnectedDeferred(state)
    makeListedDeferred(state)
    sessionsByTag.set(workspaceTag, state as SessionState)
    const full = state as SessionState

    // Seed the inventory from the subscribe-ack snapshot triage-sync
    // handed us in the token. Resolves the `listed` gate so `list()`
    // returns; thereafter own puts/deletes + objstore-put/-deleted
    // broadcasts keep the inventory live. Errors are swallowed — a seed
    // that never arrives just leaves `list()` to time out.
    void (async () => {
      let rows: readonly unknown[]
      try { rows = await subscription.resources } catch { return }
      if (!full.closed) seedInventory(full, parseResources(rows))
    })()

    // Acquire a transport reference — the transport opens the socket
    // on the first acquire and tears it down when the last release
    // fires. Released on session.close() OR the rollback path below.
    const acquireHandle = transport.acquire()
    acquiresByTag.set(workspaceTag, acquireHandle)

    // If the socket is already connected, resolve the gate immediately —
    // `addConsumer` doesn't replay `onConnected`, so a session opened on
    // an already-live socket would otherwise wait for the next reconnect.
    // Otherwise the transport's `onConnected` callback flips the gate the
    // moment the challenge frame lands.
    if (transport.getNonce()) {
      full.connected = true
      full.resolveConnected()
    }

    // Cap the open's wait on socket-connect at `timeoutMs` so a server
    // that never completes the handshake (or an unreachable URL) doesn't
    // hang the caller forever.
    let openTimeout: ReturnType<typeof setTimeout> | null = null
    try {
      await new Promise<void>((resolve, reject) => {
        openTimeout = setTimeout(() => {
          reject(new Error(`objstore: connect timeout after ${timeoutMs}ms`))
        }, timeoutMs)
        full.connectedPromise.then(() => resolve(), (err) => reject(err))
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

    // PUT `ciphertext` under `resourceTag` with optimistic concurrency,
    // mapping the raw server result into a PutResult. Shared by `put`
    // (reports) and `putBundle`.
    async function rawPutAndMap(resourceTag: string, ciphertext: Uint8Array, prev: ObjstorePrev): Promise<PutResult> {
      const raw = await _rawPut(full, { resourceTag, bytes: ciphertext, prev })
      if (raw.ok) {
        // `prev: null` is the server's "must not exist" precondition —
        // its success means the row was created fresh, possibly atop a
        // deleted prior incarnation we never saw the broadcast for.
        // Re-seed the watermark from this incarnation's v1.
        if (prev == null) full.seenVersions.delete(resourceTag)
        noteVersion(full, resourceTag, raw.meta.incarnation, raw.meta.version)
        // Reflect our own put in the live inventory immediately, so a
        // `list()` right after a put sees it without waiting for the
        // server's broadcast echo to round-trip.
        full.inventory.set(resourceTag, { version: raw.meta.version, incarnation: raw.meta.incarnation, contentLength: raw.meta.contentLength })
        return { ok: true, meta: { version: raw.meta.version, incarnation: raw.meta.incarnation, contentLength: raw.meta.contentLength } }
      }
      if (raw.reason === 'workspace-full') return { ok: false, reason: 'workspace-full' }
      if (raw.reason === 'unauthorized') return { ok: false, reason: 'unauthorized' }
      if (raw.current) noteVersion(full, resourceTag, raw.current.incarnation, raw.current.version)
      return { ok: false, reason: 'conflict', current: raw.current }
    }

    async function put(opts: { fileName: string; content: Uint8Array; prev: ObjstorePrev }): Promise<PutResult> {
      const resourceTag = await computeResourceTag(full.tagKey, opts.fileName)
      const ciphertext = encryptObjstorePayload(full.contentKey, opts.fileName, opts.content, workspaceTag, resourceTag)
      return await rawPutAndMap(resourceTag, ciphertext, opts.prev)
    }

    async function fetch(fileName: string): Promise<FetchResult | null> {
      const resourceTag = await computeResourceTag(full.tagKey, fileName)
      const raw = await _rawFetch(full, resourceTag)
      if (!raw) return null
      assertFreshOrLater(full, resourceTag, raw.meta.incarnation, raw.meta.version)
      const { fileName: decoded, content } = decryptObjstorePayload(full.contentKey, raw.bytes, workspaceTag, resourceTag)
      if (decoded !== fileName) {
        throw new Error(`objstore: fileName-binding mismatch — requested '${fileName}', payload encoded '${decoded}'`)
      }
      noteVersion(full, resourceTag, raw.meta.incarnation, raw.meta.version)
      return { content, version: raw.meta.version, incarnation: raw.meta.incarnation }
    }

    async function fetchByTag(resourceTag: string): Promise<FetchByTagResult | null> {
      const raw = await _rawFetch(full, resourceTag)
      if (!raw) return null
      assertFreshOrLater(full, resourceTag, raw.meta.incarnation, raw.meta.version)
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
        noteVersion(full, resourceTag, raw.meta.incarnation, raw.meta.version)
        return { kind: 'report', fileName: embeddedName, content, version: raw.meta.version, incarnation: raw.meta.incarnation }
      }
      const expectedBundle = await computeBundleResourceTag(full.tagKey, embeddedName)
      if (expectedBundle === resourceTag) {
        const { name, content: bundleContent } = unwrapBundleContent(content)
        noteVersion(full, resourceTag, raw.meta.incarnation, raw.meta.version)
        return { kind: 'bundle', integrity: embeddedName, name, content: bundleContent, version: raw.meta.version, incarnation: raw.meta.incarnation }
      }
      throw new Error('objstore: fetchByTag — decrypted name does not derive back to the requested resourceTag under either the report or bundle tag scheme (relay or workspace member produced a non-round-trippable tag-name pair)')
    }

    // DELETE `resourceTag` with optimistic concurrency, mapping the raw
    // server result into a DeleteResult. Shared by `deleteByName`
    // (reports) and `deleteBundle`.
    async function rawDeleteAndMap(resourceTag: string, prev: ObjstorePrev): Promise<DeleteResult> {
      const raw = await _rawDelete(full, resourceTag, prev)
      if (raw.ok) {
        // Delete drops the server-side row; the next PUT under this
        // tag starts a new incarnation at v1.
        full.seenVersions.delete(resourceTag)
        full.inventory.delete(resourceTag)
        return raw
      }
      if (raw.reason === 'not-found') return { ok: false, reason: 'not-found' }
      if (raw.current) noteVersion(full, resourceTag, raw.current.incarnation, raw.current.version)
      return { ok: false, reason: 'conflict', current: raw.current }
    }

    async function deleteByName(fileName: string, prev: ObjstorePrev): Promise<DeleteResult> {
      const resourceTag = await computeResourceTag(full.tagKey, fileName)
      return await rawDeleteAndMap(resourceTag, prev)
    }

    async function list(): Promise<Listing[]> {
      // No wire request: the inventory is seeded from the subscribe-ack
      // snapshot (handed over in the token) and kept live by this
      // session's puts/deletes and by objstore-put/-deleted broadcasts.
      // Await the first seed so an early read doesn't return empty before
      // it lands.
      await awaitListed(full)
      if (full.closed) throw new Error('objstore: session closed')
      return [...full.inventory.entries()].map(([resourceTag, m]) => ({
        resourceTag, version: m.version, incarnation: m.incarnation, contentLength: m.contentLength,
      }))
    }

    async function putBundle(opts: { integrity: string; name: string; content: Uint8Array; prev: ObjstorePrev }): Promise<PutResult> {
      const resourceTag = await computeBundleResourceTag(full.tagKey, opts.integrity)
      const wrapped = wrapBundleContent(opts.name, opts.content)
      const ciphertext = encryptObjstorePayload(full.contentKey, opts.integrity, wrapped, workspaceTag, resourceTag)
      return await rawPutAndMap(resourceTag, ciphertext, opts.prev)
    }

    async function fetchBundle(integrity: string): Promise<FetchBundleResult | null> {
      const resourceTag = await computeBundleResourceTag(full.tagKey, integrity)
      const raw = await _rawFetch(full, resourceTag)
      if (!raw) return null
      assertFreshOrLater(full, resourceTag, raw.meta.incarnation, raw.meta.version)
      const { fileName: decoded, content: wrapped } = decryptObjstorePayload(full.contentKey, raw.bytes, workspaceTag, resourceTag)
      if (decoded !== integrity) {
        throw new Error(`objstore: bundle-integrity binding mismatch — requested '${integrity}', payload encoded '${decoded}'`)
      }
      const { name, content } = unwrapBundleContent(wrapped)
      noteVersion(full, resourceTag, raw.meta.incarnation, raw.meta.version)
      return { name, content, version: raw.meta.version, incarnation: raw.meta.incarnation }
    }

    async function deleteBundle(integrity: string, prev: ObjstorePrev): Promise<DeleteResult> {
      const resourceTag = await computeBundleResourceTag(full.tagKey, integrity)
      return await rawDeleteAndMap(resourceTag, prev)
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
        // If a request happened to be awaiting connectedPromise /
        // listedPromise at the moment of close, unblock it with an error
        // so it doesn't hang past the session's lifetime.
        try { full.rejectConnected(new Error('objstore: session closed')) } catch {}
        try { full.rejectListed(new Error('objstore: session closed')) } catch {}
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
    // Close every open session, then release all acquisitions and
    // close the transport — closing it triggers
    // `onTransportDisconnected` which calls `failPendingWaiters`.
    for (const state of sessionsByTag.values()) {
      state.closed = true
      try { state.contentKey.fill(0) } catch {}
      try { state.tagKey.fill(0) } catch {}
      try { state.rejectConnected(new Error('objstore: client closed')) } catch {}
      try { state.rejectListed(new Error('objstore: client closed')) } catch {}
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

// Internal wire-level result shapes returned by `_rawPut` /
// `_rawDelete`. Kept separate from the public `PutResult` /
// `DeleteResult` so the public types carry just the rebase token
// `current: { version, incarnation }` rather than the full server-meta
// blob — the conflict envelope's resourceTag is the OPAQUE wire tag,
// which the caller can't meaningfully consume without the tagKey.
type RawPutResult =
  | { ok: true; meta: { version: number; incarnation: string; contentHash: string; contentLength: number } }
  | { ok: false; reason: 'conflict'; current: { version: number; incarnation: string } | null }
  | { ok: false; reason: 'workspace-full' }
  | { ok: false; reason: 'unauthorized' }

type RawDeleteResult =
  | { ok: true; deletedVersion: number }
  | { ok: false; reason: 'conflict'; current: { version: number; incarnation: string } | null }
  | { ok: false; reason: 'not-found' }

// Read the live row's (version, incarnation) out of a REST PUT 409
// `conflict` body. Returns `null` for malformed bodies, missing fields,
// a non-safe-integer version, or a missing incarnation. The caller
// treats `null` the same as "no precondition surfaced" — the retry path
// won't loop against a live row, and can't rebase onto a known state
// either (both halves must be present to form a valid `prev`).
async function parseRestConflict(res: Response): Promise<{ version: number; incarnation: string } | null> {
  try {
    const body = (await res.json()) as { currentVersion?: unknown; currentIncarnation?: unknown }
    // Same `isSafeNonNegativeInt` gate as the other watermark feeders:
    // `currentVersion` is relay-controlled (REST 409 body) and flows into
    // `noteVersion` via rawPutAndMap's conflict branch.
    if (isSafeNonNegativeInt(body.currentVersion)
      && typeof body.currentIncarnation === 'string') {
      return { version: body.currentVersion, incarnation: body.currentIncarnation }
    }
  } catch {}
  return null
}

// A wire-supplied integer field (`version` / `contentLength`) must be
// a safe, NON-NEGATIVE integer — not merely `typeof === 'number'`.
// JSON lets a hostile/buggy relay send a numeric literal that parses
// to a non-finite or out-of-safe-range double: `1e999` → `Infinity`,
// `1e308` → a finite-but-unsafe value, etc. Because the Ed25519 PUT
// signature does NOT cover the server-assigned `version` (see
// `assertFreshOrLater`), an unchecked value reaching `noteVersion`
// would poison the rollback watermark — an `Infinity` floor makes
// every later legitimate fetch trip the `version < last.version`
// guard (a permanent fetch DoS), and a non-finite/`NaN` value defeats
// the monotonic comparison outright. Mirrors the server's
// `isSafeNonNegativeInt` (e2e-server/objstore/sign.ts).
//
// This gate is the trust boundary for EVERY relay-controlled numeric
// metadata field that can feed `noteVersion` / `assertFreshOrLater` —
// not just the WS-frame guard `isObjectMeta`. The other feeders that
// must use it: the REST PUT-ack parser (`_rawPut`) and the REST 409
// conflict parser (`parseRestConflict`). Keep all three in sync.
function isSafeNonNegativeInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
}

// Wire-shape guard. The objstore broadcast / list / fetch-token
// frames all carry the same metadata shape; this validates the
// fields the caller cares about (the signature field is wire-only
// — callers don't verify it client-side since the bytes themselves
// are verified via `contentHash`). `version` / `contentLength` use
// the `isSafeNonNegativeInt` gate so a relay can't smuggle a non-
// finite version past `typeof` and poison the rollback watermark.
function isObjectMeta(m: WireMessage | undefined): m is WireMessage {
  if (!m || typeof m !== 'object') return false
  return typeof m['resourceTag'] === 'string'
    && isSafeNonNegativeInt(m['version'])
    && typeof m['incarnation'] === 'string'
    && typeof m['contentHash'] === 'string'
    && isSafeNonNegativeInt(m['contentLength'])
    && typeof m['signature'] === 'string'
}

function toObjectMeta(m: WireMessage): ObjectMeta {
  // Pre-condition: `isObjectMeta(m)` was true. Bracket access
  // satisfies TS strict's `noUncheckedIndexedAccess`; the literal
  // narrowing inside `isObjectMeta` covered the type guard.
  return {
    resourceTag: m['resourceTag'] as string,
    version: m['version'] as number,
    incarnation: m['incarnation'] as string,
    contentHash: m['contentHash'] as string,
    contentLength: m['contentLength'] as number,
    signature: m['signature'] as string,
  }
}
