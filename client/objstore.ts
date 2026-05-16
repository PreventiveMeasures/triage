// Client for the v1.objstore extension. Pair with the triage-sync
// relay (see server/README.md). Two planes:
//
// - **WS control plane**. The session opens its own WebSocket to
//   `${serverUrl}` (which already serves triage-sync), captures
//   the per-connection `challenge` nonce, then routes
//   `objstore-put-begin` / `-fetch` / `-delete` / `-list` requests
//   over it. The session also subscribes to broadcasts
//   (`objstore-put`, `objstore-deleted`) for the workspace tag.
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
  computeResourceTag,
  decryptObjstorePayload,
  encryptObjstorePayload,
} from './objstore-content-crypto.ts'

export { type ObjstoreKeys, deriveObjstoreKeys } from './objstore-content-crypto.ts'

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

export type DeleteResult =
  | { ok: true; deletedVersion: number }
  | { ok: false; reason: 'conflict'; currentVersion: number | null }
  | { ok: false; reason: 'not-found' }

// `fetch(fileName)` returns plaintext content + version. `fileName`
// is omitted from the result because the caller already knows it
// (they passed it in). `fetchByTag` reverses the AAD-bound name and
// returns both fields.
export type FetchResult = { content: Uint8Array; version: number }
export type FetchByTagResult = { fileName: string; content: Uint8Array; version: number }

export type ObjstoreSessionDeps = {
  // WebSocket URL — `ws://host:port/api/sync` (the same URL the
  // triage-sync relay listens on; objstore handlers are wired into
  // the shared dispatch).
  serverUrl: string
  // HTTP origin for REST data-plane PUT / GET — `http://host:port`
  // (no path). The token + relative urlPath come from the WS reply.
  httpOrigin: string
  // Workspace identity + keys. `workspaceTag` is the base64url
  // Ed25519 public key (also stored on `keys`); `keys.signingKey`
  // signs wire frames, `keys.contentKey` / `keys.tagKey` drive the
  // content-layer AEAD + HMAC. See `deriveObjstoreKeys` for the
  // single-entrypoint derivation from a workspace's 32-byte secret.
  keys: ObjstoreKeys
  // Optional: override the default 10s request timeout (per WS op).
  // REST PUT/GET timeouts use the platform's `fetch` default.
  requestTimeoutMs?: number
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

async function signSubscribe(privateKey: CryptoKey, workspaceTag: string, connectionNonce: string): Promise<string> {
  const { encodeUtf8 } = await import('../common/utf8.js')
  const canonical = encodeUtf8([SUBSCRIBE_DOMAIN, workspaceTag, '', connectionNonce].join('\n'))
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, privateKey, canonical))
  return sig.toBase64({ alphabet: 'base64url', omitPadding: true })
}

export async function createObjstoreSession(deps: ObjstoreSessionDeps): Promise<ObjstoreSession> {
  const timeoutMs = deps.requestTimeoutMs ?? 10_000
  const workspaceTag = deps.keys.workspaceTag
  const signingKey = deps.keys.signingKey
  // Take a private copy of the raw keys so `close()` can wipe its
  // own slot without affecting caller-owned state. Callers commonly
  // reuse the same `ObjstoreKeys` across reconnect cycles (test
  // expects this; presence-layer ditto), so mutating the caller's
  // arrays in place would silently break the second session.
  const contentKey = new Uint8Array(deps.keys.contentKey)
  const tagKey = new Uint8Array(deps.keys.tagKey)
  const ws = new WebSocket(deps.serverUrl)
  // Queue + waiters pattern (same as the spawned-relay tests' helper
  // — see tests/sync-server-objstore.test.js). Listener attached at
  // construction time so the `challenge` frame that arrives
  // concurrently with `'open'` doesn't get dropped.
  const queue: WireMessage[] = []
  const waiters: Array<{ predicate: (m: WireMessage) => boolean; resolve: (m: WireMessage) => void; reject: (err: Error) => void }> = []
  const putHandlers = new Set<(event: { resourceTag: string; version: number; contentLength: number }) => void>()
  const deletedHandlers = new Set<(event: { resourceTag: string; version: number }) => void>()
  // Per-tag monotonic version watermark. The Ed25519 signature on a
  // stored object binds (`prevVersion`, `contentHash`, …) into the
  // PUT — so a fetched object's signature is still valid for ANY
  // historical version a relay decides to serve. A relay that
  // serves a stale-but-correctly-signed version on FETCH would slip
  // past every other check (AEAD decrypts, contentHash matches the
  // ciphertext, AAD binds (workspace, tag)). Track the highest
  // version we've seen on this session — across put / fetch /
  // fetchByTag / broadcasts — and refuse any fetch that comes back
  // strictly lower. Audit round-1 M3.
  const seenVersions = new Map<string, number>()
  function noteVersion(tag: string, version: number): void {
    const prev = seenVersions.get(tag) ?? 0
    if (version > prev) seenVersions.set(tag, version)
  }

  ws.addEventListener('message', (event) => {
    let msg: WireMessage
    try { msg = JSON.parse(typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data as ArrayBuffer)) as WireMessage }
    catch { return }
    // Broadcasts dispatch synchronously — never end up in the
    // request-correlation queue. A subscriber that registered AFTER
    // a broadcast arrived missed it (no replay); register before
    // calling the op that would trigger it on a peer.
    //
    // Every broadcast is gated on `msg.workspaceTag === workspaceTag`
    // even though the socket is workspace-scoped: defense in depth
    // against a relay routing bug (or hostile relay) that fanned a
    // foreign workspace's broadcast onto this socket — without the
    // guard `onPut` / `onDeleted` callbacks would fire with another
    // workspace's data, polluting caller state.
    if (msg.type === 'objstore-put' && msg.workspaceTag === workspaceTag && isObjectMeta(msg)) {
      const meta = toObjectMeta(msg)
      // Advance the per-tag rollback watermark on every broadcast we
      // believe. A relay that promises v5 in a broadcast then serves
      // v3 on a follow-up FETCH will hit `assertFreshOrLater`.
      noteVersion(meta.resourceTag, meta.version)
      const putEvent = { resourceTag: meta.resourceTag, version: meta.version, contentLength: meta.contentLength }
      for (const h of putHandlers) { try { h(putEvent) } catch {} }
      return
    }
    if (msg.type === 'objstore-deleted' && msg.workspaceTag === workspaceTag && typeof msg.resourceTag === 'string' && typeof msg['version'] === 'number') {
      const tag = msg.resourceTag
      const version = msg['version']
      // A delete broadcast destroys the row server-side: the next
      // legitimate PUT lands as v1 again. Drop the watermark so the
      // recreate's v1 isn't mistaken for a rollback. Same rationale
      // as the `deleteByName` path below — the rollback gate only
      // applies *within* a single incarnation of a resource.
      seenVersions.delete(tag)
      const ev = { resourceTag: tag, version }
      for (const h of deletedHandlers) { try { h(ev) } catch {} }
      return
    }
    // The session subscribes via the shared `workspace-subscribe`
    // path so objstore broadcasts land here. The relay's subscribe
    // contract also delivers triage-sync frames (`workspace-state`
    // after every save, `workspace-save-ack`/`-error` for the
    // originator, `pong`, etc.) for the SAME workspaceTag. None of
    // those frames match an objstore-side predicate; without an
    // explicit drop they'd pile up in `queue` forever on an active
    // workspace. Filter known triage-sync types up-front.
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
    // Defense in depth: even with the explicit drop above, an
    // unknown future frame type could land here. Bound the queue so
    // a misbehaving relay (or new protocol message we haven't taught
    // the client about) doesn't grow it without limit. FIFO eviction
    // — the oldest unmatched message is the least likely to be
    // wanted by the next predicate.
    if (queue.length > MAX_QUEUE_SIZE) queue.splice(0, queue.length - MAX_QUEUE_SIZE)
  })

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

  // Reject every pending waiter on WS close / error so an in-flight
  // `put` / `fetch` / `delete` / `list` doesn't hang for the full
  // request timeout (10 s default) after the session is gone. Fires
  // for caller `close()`, server-initiated shutdown (1001), and
  // abnormal disconnects. Idempotent — once the waiters drain, the
  // re-entry on a redundant event is a no-op.
  function failPendingWaiters(reason: string): void {
    for (const w of waiters.splice(0)) {
      try { w.reject(new Error(`objstore: ${reason}`)) } catch {}
    }
  }
  ws.addEventListener('close', () => failPendingWaiters('session closed'))
  ws.addEventListener('error', () => failPendingWaiters('websocket error'))

  function send(msg: object): void {
    if (ws.readyState !== WebSocket.OPEN) throw new Error('objstore: socket not open')
    ws.send(JSON.stringify(msg))
  }

  // Handshake. Any step here can reject (relay unreachable, challenge
  // recv timeout, malformed challenge, subscribe timeout). On
  // failure, close the socket + reject every pending waiter so the
  // caller's exception doesn't leak a half-open connection with
  // dangling listeners. After this block resolves, the session is
  // ready and the caller owns `close()` for orderly teardown.
  let connectionNonce: string
  try {
    await new Promise<void>((resolve, reject) => {
      const onOpen = () => { cleanup(); resolve() }
      const onError = (e: Event) => {
        cleanup()
        reject((e as { error?: Error }).error ?? new Error('objstore: websocket error before open'))
      }
      function cleanup(): void {
        ws.removeEventListener('open', onOpen)
        ws.removeEventListener('error', onError)
      }
      ws.addEventListener('open', onOpen, { once: true })
      ws.addEventListener('error', onError, { once: true })
    })
    const challenge = await recv((m) => m.type === 'challenge')
    if (typeof challenge['nonce'] !== 'string') throw new TypeError('objstore: challenge frame missing nonce')
    connectionNonce = challenge['nonce']
    // Subscribe so the server adds this socket to the workspace's
    // broadcast set. The relay's subscribe contract delivers BOTH
    // `workspace-subscribed` AND a `workspace-state` chain; we await
    // the former, and the message listener above drops the latter
    // as a known triage-sync type so it doesn't sit in the queue.
    const subscribeSig = await signSubscribe(signingKey, workspaceTag, connectionNonce)
    send({ type: 'workspace-subscribe', workspaceTag, from: null, signature: subscribeSig })
    await recv((m) => m.type === 'workspace-subscribed' && m.workspaceTag === workspaceTag)
  } catch (err) {
    // Close the WS so we don't leak the connection. Each `recv()`
    // call manages its own timeout + waiter cleanup, so by the time
    // we reach this catch the waiters list is already drained for
    // the failing path. Rethrow to let the caller surface the
    // original error.
    try { ws.close() } catch {}
    throw err
  }

  // Wire-level PUT — takes a pre-computed resourceTag + ciphertext.
  // `put` (public) is the encrypting wrapper.
  async function _rawPut(opts: { resourceTag: string; bytes: Uint8Array; prevVersion: number | null }): Promise<RawPutResult> {
    const contentHash = await computeContentHash(opts.bytes)
    const fields: ObjstorePutBeginFields = {
      workspaceTag,
      resourceTag: opts.resourceTag,
      prevVersion: opts.prevVersion,
      expectedLength: opts.bytes.byteLength,
      contentHash,
    }
    const signature = await signObjstorePut(signingKey, fields, connectionNonce)
    send({ type: 'objstore-put-begin', ...fields, signature })
    // Match `workspaceTag` on the reply too — every server reply frame
    // carries it (server/objstore/handlers.ts). The socket is already
    // workspace-scoped, but this is defense-in-depth: a server
    // routing bug that delivered a different workspace's reply
    // would otherwise correlate on `type` + `resourceTag` alone.
    const reply = await recv((m) =>
      m.workspaceTag === workspaceTag && m.resourceTag === opts.resourceTag && (
        m.type === 'objstore-put-token' ||
        m.type === 'objstore-put-error' ||
        m.type === 'objstore-conflict'
      ),
    )
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
      if (res.status === 409 || res.status === 410) {
        // Parse the server's `{ error, currentVersion }` envelope so a
        // 409 carries the live row's version into the caller's retry
        // loop — symmetric with the WS plane's `objstore-conflict`
        // envelope. Without `currentVersion` a putFile retry against
        // a live slot would re-send `prevVersion: null` and loop
        // indefinitely against a non-empty row. 410 (`gone`, staging
        // row reaped between begin and commit) doesn't have a live
        // version to surface — fall through with `current: null`.
        const current = res.status === 409 ? await parseRestConflictVersion(res) : null
        return { ok: false, reason: 'conflict', current }
      }
      // Other 4xx/5xx are protocol violations or server-side faults
      // the caller can't usefully discriminate. Throw with the wire
      // body so a post-mortem has the reason string.
      let body = ''
      try { body = await res.text() } catch {}
      throw new Error(`objstore: REST PUT failed ${res.status} ${body.slice(0, 200)}`)
    }
    // Validate the JSON response shape AND that the server echoed
    // back the same contentHash + contentLength the client signed
    // into put-begin. The server-side commitPut verifies the body
    // matches the signed hash before producing this ack, so any
    // divergence here is a protocol bug, a buggy proxy, or a hostile
    // relay that swapped fields — none of which should silently land
    // as `ok: true` with garbage meta. `JSON.parse` itself throws on
    // malformed bytes; wrap to surface a uniform error.
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
  async function _rawFetch(resourceTag: string): Promise<{ bytes: Uint8Array; meta: ObjectMeta } | null> {
    const signature = await signObjstoreFetch(signingKey, workspaceTag, resourceTag, connectionNonce)
    send({ type: 'objstore-fetch', workspaceTag, resourceTag, signature })
    const reply = await recv((m) =>
      m.workspaceTag === workspaceTag && m.resourceTag === resourceTag && (
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
      // Documented REST GET race outcomes (per server/README.md):
      // - 404 `not-found` — the live row was DELETED (or its
      //   version bumped past the token's `ver`) between
      //   token-issue and GET. From the caller's perspective the
      //   resource simply isn't there now — return null. Same
      //   shape as the WS `objstore-fetch-not-found` reply.
      // - 503 `unavailable` — live row present but the file is
      //   missing / size diverged (server-side fs fault). Caller
      //   can't usefully recover; throw with the wire body so the
      //   incident has a forensic trail.
      // - Other 4xx/5xx — protocol violation or server fault;
      //   throw.
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
  async function _rawDelete(resourceTag: string, prevVersion: number | null): Promise<RawDeleteResult> {
    const fields: ObjstoreDeleteFields = { workspaceTag, resourceTag, prevVersion }
    const signature = await signObjstoreDelete(signingKey, fields, connectionNonce)
    send({ type: 'objstore-delete', ...fields, signature })
    const reply = await recv((m) =>
      m.workspaceTag === workspaceTag && m.resourceTag === resourceTag && (
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
    throw new Error(`objstore: delete-error reason='${String(reply['reason'])}'`)
  }

  // Wire-level LIST. Returns raw ObjectMeta (with opaque resourceTag
  // HMACs). `list` (public) downgrades to the small Listing shape
  // — server-side metadata that doesn't include any plaintext.
  async function _rawList(): Promise<ObjectMeta[]> {
    const signature = await signObjstoreList(signingKey, workspaceTag, connectionNonce)
    send({ type: 'objstore-list', workspaceTag, signature })
    const reply = await recv((m) => m.type === 'objstore-list-result' && m.workspaceTag === workspaceTag)
    // Match fetch's strictness: any malformed wire shape is a protocol
    // violation, not a "missing data" signal. The server emits `[]`
    // explicitly for the empty case, and well-formed entries for
    // every present resource — there is no legitimate path for a
    // malformed entry inside `resources`, so silently filtering them
    // would hide a real bug (server regression, MITM, ...) behind a
    // partial result the caller can't tell from a truthful one.
    // Throw with the index so a post-mortem can pinpoint the entry.
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
  // and the AEAD / contentHash chain would all check out. Note
  // we accept equal versions (an idempotent re-fetch of the same
  // row); the monotonic gate fires strictly below the watermark.
  function assertFreshOrLater(tag: string, version: number): void {
    const last = seenVersions.get(tag) ?? 0
    if (version < last) {
      throw new Error(`objstore: version-rollback rejected — fetched v${version} for a tag we've already seen at v${last}`)
    }
  }

  async function put(opts: { fileName: string; content: Uint8Array; prevVersion: number | null }): Promise<PutResult> {
    const resourceTag = await computeResourceTag(tagKey, opts.fileName)
    const ciphertext = encryptObjstorePayload(contentKey, opts.fileName, opts.content, workspaceTag, resourceTag)
    const raw = await _rawPut({ resourceTag, bytes: ciphertext, prevVersion: opts.prevVersion })
    if (raw.ok) {
      // `prevVersion: null` is the server's "must not exist"
      // precondition — its success means the row was created
      // fresh, possibly atop a deleted prior incarnation we
      // never saw the broadcast for. Re-seed the watermark from
      // this incarnation's v1 (server returns it in `meta.version`).
      if (opts.prevVersion == null) seenVersions.delete(resourceTag)
      noteVersion(resourceTag, raw.meta.version)
      return { ok: true, meta: { version: raw.meta.version, contentLength: raw.meta.contentLength } }
    }
    if (raw.reason === 'workspace-full') return { ok: false, reason: 'workspace-full' }
    // A conflict envelope's `current.version` is the server's view
    // of the live row; note it too so a subsequent fetch can't be
    // rolled back below it.
    if (raw.current) noteVersion(resourceTag, raw.current.version)
    return { ok: false, reason: 'conflict', currentVersion: raw.current?.version ?? null }
  }

  async function fetch(fileName: string): Promise<FetchResult | null> {
    const resourceTag = await computeResourceTag(tagKey, fileName)
    const raw = await _rawFetch(resourceTag)
    if (!raw) return null
    assertFreshOrLater(resourceTag, raw.meta.version)
    const { fileName: decoded, content } = decryptObjstorePayload(contentKey, raw.bytes, workspaceTag, resourceTag)
    // AAD already pins (workspaceTag, resourceTag); the encoded
    // fileName inside the plaintext is the third leg of the bind.
    // A relay that somehow served a successfully-decrypting blob
    // whose plaintext encoded a different fileName would surface
    // here. (Unreachable under standard threat model — the AAD
    // mismatch raises first — but cheap defense in depth.)
    if (decoded !== fileName) {
      throw new Error(`objstore: fileName-binding mismatch — requested '${fileName}', payload encoded '${decoded}'`)
    }
    noteVersion(resourceTag, raw.meta.version)
    return { content, version: raw.meta.version }
  }

  async function fetchByTag(resourceTag: string): Promise<FetchByTagResult | null> {
    const raw = await _rawFetch(resourceTag)
    if (!raw) return null
    assertFreshOrLater(resourceTag, raw.meta.version)
    const { fileName, content } = decryptObjstorePayload(contentKey, raw.bytes, workspaceTag, resourceTag)
    // Re-derive the tag from the decrypted fileName and assert it
    // matches the tag we asked for. AAD already pins the (workspace,
    // tag) tuple at the AEAD layer — but a malicious workspace
    // participant (anyone with the tagKey) could PUT an encrypted
    // blob encoding `fileName=X` at the tag for `fileName=Y`, then
    // a peer's `fetchByTag(tagY)` would surface `X` as the
    // filename even though `fetch(X)` wouldn't find it (the
    // round-trip is broken). Refuse the non-round-trippable result
    // here so callers can rely on `fetchByTag(t).fileName` being a
    // name they can fetch back. Audit round-1 M2.
    const expected = await computeResourceTag(tagKey, fileName)
    if (expected !== resourceTag) {
      throw new Error('objstore: fetchByTag — decrypted fileName does not derive back to the requested resourceTag (relay or workspace member produced a non-round-trippable tag-name pair)')
    }
    noteVersion(resourceTag, raw.meta.version)
    return { fileName, content, version: raw.meta.version }
  }

  async function deleteByName(fileName: string, prevVersion: number | null): Promise<DeleteResult> {
    const resourceTag = await computeResourceTag(tagKey, fileName)
    const raw = await _rawDelete(resourceTag, prevVersion)
    if (raw.ok) {
      // Delete drops the server-side row; the next PUT under this
      // tag starts a new incarnation at v1. Drop the watermark so
      // the recreate's v1 isn't mistaken for a rollback — the
      // rollback gate applies *within* a single incarnation only.
      // (A stale v2 the relay tries to serve *after* the delete
      // is still rejected by the AAD-bound contentHash chain at
      // fetch time; we just lose the version-monotonic check
      // across the delete boundary, which can't be enforced
      // without a tombstone the schema explicitly omits.)
      seenVersions.delete(resourceTag)
      return raw
    }
    if (raw.reason === 'not-found') return { ok: false, reason: 'not-found' }
    if (raw.current) noteVersion(resourceTag, raw.current.version)
    return { ok: false, reason: 'conflict', currentVersion: raw.current?.version ?? null }
  }

  async function list(): Promise<Listing[]> {
    const entries = await _rawList()
    // List advances the watermark for each tag so a follow-up fetch
    // can't roll back below the version the relay just acknowledged.
    for (const m of entries) noteVersion(m.resourceTag, m.version)
    return entries.map((m) => ({ resourceTag: m.resourceTag, version: m.version, contentLength: m.contentLength }))
  }

  return {
    put,
    fetch,
    fetchByTag,
    delete: deleteByName,
    list,
    onPut(handler) { putHandlers.add(handler); return () => { putHandlers.delete(handler) } },
    onDeleted(handler) { deletedHandlers.add(handler); return () => { deletedHandlers.delete(handler) } },
    close() {
      try { ws.close() } catch {}
      // Defense-in-depth: drop the raw key wrappers we hold so a
      // heap snapshot taken after close() doesn't include the
      // workspace's content + tag key material. JS doesn't expose
      // a deterministic erase primitive (the GC may have already
      // moved the bytes), but the explicit fill(0) drops the
      // wrappers themselves. Mirrors sync-crypto.ts's seed wipe.
      try { contentKey.fill(0) } catch {}
      try { tagKey.fill(0) } catch {}
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
// `current` on a conflict carries the version only — that's what
// the public `PutResult` / `DeleteResult` surface to callers as
// `currentVersion`. The WS plane's `objstore-conflict` envelope
// produces a full `ObjectMeta` (which structurally satisfies
// `{ version: number }`); the REST plane's 409 body carries just
// the version field. Narrowing the type to the only field actually
// consumed lets the two planes share the union without forcing the
// REST path to fabricate the rest of the ObjectMeta shape.
type RawPutResult =
  | { ok: true; meta: { version: number; contentHash: string; contentLength: number } }
  | { ok: false; reason: 'conflict'; current: { version: number } | null }
  | { ok: false; reason: 'workspace-full' }

type RawDeleteResult =
  | { ok: true; deletedVersion: number }
  | { ok: false; reason: 'conflict'; current: { version: number } | null }
  | { ok: false; reason: 'not-found' }

// Wire-shape guard. The objstore broadcast / list / fetch-token
// frames all carry the same metadata shape; this validates the
// fields the caller cares about (the signature field is wire-only
// — callers don't verify it client-side since the bytes themselves
// are verified via `contentHash`).
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
