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
// The bytes you pass to `put()` are OPAQUE to the server. Callers
// are responsible for application-level encryption (ChaCha20-Poly1305
// with a workspace-derived key, same as triage-sync) and for
// computing a `noncePrefix` that uniquely names the encryption
// nonce-base. This module's job is integrity + transport, NOT
// confidentiality:
//   - `contentHash = SHA-256(bytes)` is computed here and bound
//     into the Ed25519 signature, so a peer fetching bytes that
//     don't match the signed hash has proof of tampering.
//   - The Ed25519 signature is over the (signed) `contentHash`,
//     length, chunks, noncePrefix, prevVersion, etc. — every
//     server-side state mutation is gated on the seed-holder's
//     consent.
//
// Concurrency: the caller MUST NOT issue two ops for the same
// resourceTag concurrently. Responses are correlated by message
// `type` + `resourceTag` (or `type` only for `list`); a second
// concurrent op for the same key would race the matcher. Ops on
// DIFFERENT resourceTags are safe to interleave.

import {
  type ObjstoreDeleteFields,
  type ObjstorePutBeginFields,
  computeContentHash,
  signObjstoreDelete,
  signObjstoreFetch,
  signObjstoreList,
  signObjstorePut,
} from './objstore-crypto.ts'

// Server-emitted wire row shape. Returned by `list`, embedded in
// `fetch`-token replies, and broadcast on `objstore-put`.
export type ObjectMeta = {
  resourceTag: string
  version: number
  contentHash: string
  contentLength: number
  chunkCount: number
  noncePrefix: string
  signature: string
}

export type PutResult =
  | { ok: true; meta: { version: number; contentHash: string; contentLength: number } }
  | { ok: false; reason: 'conflict'; current: ObjectMeta | null }
  | { ok: false; reason: 'workspace-full' }

export type DeleteResult =
  | { ok: true; deletedVersion: number }
  | { ok: false; reason: 'conflict'; current: ObjectMeta | null }
  | { ok: false; reason: 'not-found' }

export type FetchResult = { bytes: Uint8Array; meta: ObjectMeta }

export type ObjstoreSessionDeps = {
  // WebSocket URL — `ws://host:port/api/sync` (the same URL the
  // triage-sync relay listens on; objstore handlers are wired into
  // the shared dispatch).
  serverUrl: string
  // HTTP origin for REST data-plane PUT / GET — `http://host:port`
  // (no path). The token + relative urlPath come from the WS reply.
  httpOrigin: string
  // The workspaceTag (base64url Ed25519 public key) the relay
  // identifies this session against.
  workspaceTag: string
  // The Ed25519 private key for signing wire frames. Sign-only
  // CryptoKey — the relay never sees the key itself, only sigs.
  privateKey: CryptoKey
  // Optional: override the default 10s request timeout (per WS op).
  // REST PUT/GET timeouts use the platform's `fetch` default.
  requestTimeoutMs?: number
}

export type ObjstoreSession = {
  put(opts: { resourceTag: string; bytes: Uint8Array; noncePrefix: string; prevVersion: number | null }): Promise<PutResult>
  fetch(resourceTag: string): Promise<FetchResult | null>
  delete(resourceTag: string, prevVersion: number | null): Promise<DeleteResult>
  list(): Promise<ObjectMeta[]>
  onPut(handler: (meta: ObjectMeta) => void): () => void
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
  const ws = new WebSocket(deps.serverUrl)
  // Queue + waiters pattern (same as the spawned-relay tests' helper
  // — see tests/sync-server-objstore.test.js). Listener attached at
  // construction time so the `challenge` frame that arrives
  // concurrently with `'open'` doesn't get dropped.
  const queue: WireMessage[] = []
  const waiters: Array<{ predicate: (m: WireMessage) => boolean; resolve: (m: WireMessage) => void; reject: (err: Error) => void }> = []
  const putHandlers = new Set<(meta: ObjectMeta) => void>()
  const deletedHandlers = new Set<(event: { resourceTag: string; version: number }) => void>()

  ws.addEventListener('message', (event) => {
    let msg: WireMessage
    try { msg = JSON.parse(typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data as ArrayBuffer)) as WireMessage }
    catch { return }
    // Broadcasts dispatch synchronously — never end up in the
    // request-correlation queue. A subscriber that registered AFTER
    // a broadcast arrived missed it (no replay); register before
    // calling the op that would trigger it on a peer.
    if (msg.type === 'objstore-put' && isObjectMeta(msg)) {
      for (const h of putHandlers) { try { h(toObjectMeta(msg)) } catch {} }
      return
    }
    if (msg.type === 'objstore-deleted' && typeof msg.resourceTag === 'string' && typeof msg['version'] === 'number') {
      const ev = { resourceTag: msg.resourceTag, version: msg['version'] }
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
    const subscribeSig = await signSubscribe(deps.privateKey, deps.workspaceTag, connectionNonce)
    send({ type: 'workspace-subscribe', workspaceTag: deps.workspaceTag, from: null, signature: subscribeSig })
    await recv((m) => m.type === 'workspace-subscribed' && m.workspaceTag === deps.workspaceTag)
  } catch (err) {
    // Close the WS so we don't leak the connection. Each `recv()`
    // call manages its own timeout + waiter cleanup, so by the time
    // we reach this catch the waiters list is already drained for
    // the failing path. Rethrow to let the caller surface the
    // original error.
    try { ws.close() } catch {}
    throw err
  }

  async function put(opts: { resourceTag: string; bytes: Uint8Array; noncePrefix: string; prevVersion: number | null }): Promise<PutResult> {
    const contentHash = await computeContentHash(opts.bytes)
    const fields: ObjstorePutBeginFields = {
      workspaceTag: deps.workspaceTag,
      resourceTag: opts.resourceTag,
      prevVersion: opts.prevVersion,
      expectedChunks: 1,
      expectedLength: opts.bytes.byteLength,
      contentHash,
      noncePrefix: opts.noncePrefix,
    }
    const signature = await signObjstorePut(deps.privateKey, fields, connectionNonce)
    send({ type: 'objstore-put-begin', ...fields, signature })
    // Match `workspaceTag` on the reply too — every server reply frame
    // carries it (server/objstore/handlers.ts). The socket is already
    // workspace-scoped, but this is defense-in-depth: a server
    // routing bug that delivered a different workspace's reply
    // would otherwise correlate on `type` + `resourceTag` alone.
    const reply = await recv((m) =>
      m.workspaceTag === deps.workspaceTag && m.resourceTag === opts.resourceTag && (
        m.type === 'objstore-put-token' ||
        m.type === 'objstore-put-error' ||
        m.type === 'objstore-conflict'
      ),
    )
    if (reply.type === 'objstore-put-error') {
      // `workspace-full` is the only documented reason today, but
      // forward the literal so a future reason surfaces unchanged.
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
      // `fetch`'s `BodyInit` requires `Uint8Array<ArrayBuffer>` (not
      // the broader `ArrayBufferLike` that a plain `Uint8Array`
      // parameter has). Node's `Buffer` / `crypto.getRandomValues`
      // always produce regular ArrayBuffer at runtime so the cast
      // is safe. Same narrowing as `crypto.subtle.digest`.
      body: opts.bytes as Uint8Array<ArrayBuffer>,
    })
    if (!res.ok) {
      // Documented REST PUT error paths that map to typed results
      // (vs throws). See `server/README.md`'s error-handling matrix:
      // - 409 `conflict` — race-loss at the per-resource commit lock.
      //   Two peers both passed the WS put-begin (their staging rows
      //   landed concurrently), then the first to acquire the commit
      //   lock won; the second's `commitPut` sees a non-matching
      //   live version and returns conflict. The REST 409 body
      //   doesn't carry the current row (the commit lock isn't a
      //   subscribe path), so `current` is null — caller can
      //   `fetch()` to materialise the winner if it cares.
      // - 410 `gone` — the staging row was reaped between
      //   put-token-issue and REST commit. Surfaces as a conflict
      //   from the caller's perspective; same null-current handling.
      if (res.status === 409 || res.status === 410) return { ok: false, reason: 'conflict', current: null }
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

  async function fetchOne(resourceTag: string): Promise<FetchResult | null> {
    const signature = await signObjstoreFetch(deps.privateKey, deps.workspaceTag, resourceTag, connectionNonce)
    send({ type: 'objstore-fetch', workspaceTag: deps.workspaceTag, resourceTag, signature })
    const reply = await recv((m) =>
      m.workspaceTag === deps.workspaceTag && m.resourceTag === resourceTag && (
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

  async function deleteOne(resourceTag: string, prevVersion: number | null): Promise<DeleteResult> {
    const fields: ObjstoreDeleteFields = { workspaceTag: deps.workspaceTag, resourceTag, prevVersion }
    const signature = await signObjstoreDelete(deps.privateKey, fields, connectionNonce)
    send({ type: 'objstore-delete', ...fields, signature })
    const reply = await recv((m) =>
      m.workspaceTag === deps.workspaceTag && m.resourceTag === resourceTag && (
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
    // objstore-delete-error
    if (reply['reason'] === 'not-found') return { ok: false, reason: 'not-found' }
    throw new Error(`objstore: delete-error reason='${String(reply['reason'])}'`)
  }

  async function list(): Promise<ObjectMeta[]> {
    const signature = await signObjstoreList(deps.privateKey, deps.workspaceTag, connectionNonce)
    send({ type: 'objstore-list', workspaceTag: deps.workspaceTag, signature })
    const reply = await recv((m) => m.type === 'objstore-list-result' && m.workspaceTag === deps.workspaceTag)
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

  return {
    put,
    fetch: fetchOne,
    delete: deleteOne,
    list,
    onPut(handler) { putHandlers.add(handler); return () => { putHandlers.delete(handler) } },
    onDeleted(handler) { deletedHandlers.add(handler); return () => { deletedHandlers.delete(handler) } },
    close() { try { ws.close() } catch {} },
  }
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
    && typeof m['chunkCount'] === 'number'
    && typeof m['noncePrefix'] === 'string'
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
    chunkCount: m['chunkCount'] as number,
    noncePrefix: m['noncePrefix'] as string,
    signature: m['signature'] as string,
  }
}
