// DeepView triage-sync relay server. WebSocket front-end, SQLite
// backing store. Implements the protocol described in
// `client/triage-sync.js` (and `server/sign.ts` for the canonical
// signature payloads):
//
//   server → client  challenge           { nonce } — emitted on every
//                                          accept, BEFORE any client
//                                          frame; per-socket random
//                                          128-bit value the client
//                                          must bind into every
//                                          `workspace-subscribe`
//                                          signature (round-9 H2)
//   client → server  workspace-save      { workspaceTag, base,
//                                          keyframe, nonce, ciphertext,
//                                          signature } — `keyframe` is
//                                          a boolean (`true` exactly,
//                                          else falsy), bound into the
//                                          signed canonical
//   client → server  workspace-subscribe { workspaceTag, from,
//                                          signature } — `from` is the
//                                          last revision id the client
//                                          claims to have applied (or
//                                          null for fresh)
//   client → server  ping                 — heartbeat
//   server → client  pong                 — heartbeat reply
//   server → client  workspace-save-ack  { workspaceTag, base, id }
//   server → client  workspace-save-error { workspaceTag, base, reason }
//                                          — explicit failure surface for
//                                          the legit-signer case where
//                                          the server rejects a signed
//                                          save (e.g. `too-large` past
//                                          MAX_CIPHERTEXT_LEN). Sent
//                                          AFTER sig verify so the
//                                          response only reaches a
//                                          legitimate seed holder; shape
//                                          attacks still drop silently.
//   server → client  workspace-subscribed { workspaceTag } — explicit
//                                          handshake-complete ack so
//                                          the client can flip its
//                                          status from `connecting` to
//                                          `online` only after the
//                                          server registered it as a
//                                          peer (not just on socket
//                                          open)
//   server → client  workspace-state     { workspaceTag, revisions:
//                                          [{ base, id, keyframe,
//                                             nonce, ciphertext,
//                                             signature }, ...] }
//
// Authentication: every signed message is checked against the
// `workspaceTag` (= base64url Ed25519 public key) before any
// state mutation. Unsigned / bad-sig messages are dropped silently
// — the legitimate signer will retry, and an attacker who learns
// the tag without holding the seed can't get past the verify.
//
// Content opacity: `nonce` and `ciphertext` are opaque to the
// server. We store and forward them; we never inspect.
//
// Subscriber tracking: `subscribers: Map<workspaceTag, Set<socket>>`.
// A socket joins the set ONLY via an explicit, signature-verified
// `workspace-subscribe` (sole call site of `subscribe()` is in
// `handleSubscribe`, gated by the per-connection challenge nonce
// bound into the signature and a post-await `readyState` check).
// It leaves on disconnect. Broadcasts go to every subscriber for
// the workspaceTag except the originator.
//
// `workspace-save` deliberately does NOT auto-attach the sender,
// even on a valid signature — see the audit note in `handleSave`
// (round-9 H1): auto-subscribe-on-save let a passive observer
// replay any captured save frame from any TCP connection to attach
// as a silent mirror, since the duplicate-id path returns ack-only
// and would not reject the attaching socket.

import { type WebSocket, WebSocketServer } from 'ws'
import { type IncomingMessage as HttpRequest, type ServerResponse, createServer } from 'node:http'
import { Buffer } from 'node:buffer'
import { fileURLToPath } from 'node:url'
import { decodeUtf8 } from '../common/utf8.js'
import { SAVE_ERROR_REASONS, type SaveErrorReason } from '../common/save-error-reason.ts'
import { debugTag, errMsg, errStack, randomId } from './util.ts'
import { Peer } from './peer.ts'
import { LOOPBACK_HOSTS, createOriginGate } from './origin.ts'
import { createHub } from './hub.ts'
import { type AuthenticateMsg, createAuth } from './auth.ts'
import { MAX_CIPHERTEXT_LEN, MAX_FIELD_LEN, validCiphertextShape, validNonce, validTagSigBase } from './validation.ts'
import { loadConfig } from './config.ts'
import { type Handle, type RevisionRow, chainFrom, commitRevision, openDb, revisionExists } from './db.ts'
import { openNeonDb } from './db-neon.ts'
import { type SaveMsg, type SubscribeMsg, canonicalSave, computeRevisionIdFromCanonical, verifyEd25519, verifySubscribeSig } from './sign.ts'
import { handleRest, matchRoute } from './objstore/rest.ts'
import { initObjstore } from './objstore/init.ts'
import { loadStatic } from './static.ts'
import { type Handle as ObjstoreHandle, openObjstore } from './objstore/store.ts'
import { openNeonObjstore } from './objstore/store-neon.ts'
import { openVercelBlobBackend } from './objstore/blob-vercel.ts'
import { heldLeaseCount, releaseAllForThisProcess, setDefaultLeaseMs } from './objstore/commit-lock.ts'
import type { ObjstoreDeleteMsg, ObjstoreFetchMsg, ObjstoreListMsg, ObjstorePutBeginMsg } from './objstore/sign.ts'

// Wire-message envelope as it lands post-`JSON.parse`. Every field is
// `unknown` until a handler narrows it; the type just documents the
// dispatch surface so call sites can pattern-match on `msg.type`.
type IncomingMessage = {
  type?: unknown
  [k: string]: unknown
}

// `chainForWire` accepts the row shape from `chainFrom` (where
// `keyframe` is the SQLite INTEGER 0 / 1) and returns the same fields
// with `keyframe` normalised to a strict boolean for the wire.
type WireRevision = {
  base: string | null
  id: string
  keyframe: boolean
  nonce: string
  ciphertext: string
  signature: string
}

// All external inputs (env vars + optional config.json) are parsed
// and validated in ./config.ts. Destructure into the existing
// uppercase names so the rest of this module reads unchanged.
const config = loadConfig()
const {
  port: PORT, host: HOST, dbPath: DB_PATH, objstoreDir: OBJSTORE_DIR,
  reapIntervalMs: OBJSTORE_REAP_INTERVAL_MS, leaseMs: OBJSTORE_COMMIT_LOCK_LEASE_MS,
  maxInflightPerSocket: MAX_INFLIGHT_PER_SOCKET, debug: DEBUG,
  neonUrl: NEON_URL, blobToken: BLOB_TOKEN, tokenSecret: TOKEN_SECRET,
  password: CONFIG_PASSWORD, trustProxyEnv: TRUST_PROXY_ENV,
} = config

// Apply the validated commit-lock lease to the lock module. The setter
// threads it via opts.leaseMs to withCommitLock at every call site.
setDefaultLeaseMs(OBJSTORE_COMMIT_LOCK_LEASE_MS)

// Same-origin gate for the WS upgrade and REST data plane (see
// ./origin.ts). `TRUST_PROXY_ENV` (from config) also feeds the
// boot-time misconfiguration fail-fast below.
const { trustProxy: TRUST_PROXY, isOriginAllowed } = createOriginGate(HOST, TRUST_PROXY_ENV)

// Per-socket buffered-bytes cap. `socket.send` returns synchronously
// even when the kernel/ws library can't drain to the wire fast
// enough; the unsent payload accumulates in `bufferedAmount`. A
// slow / blackholed peer on a high-volume workspace can hold many
// MB of fan-out broadcasts in this buffer with no backpressure on
// the broadcast loop. Drop the message when the buffer crosses the
// cap; the heartbeat will eventually close a peer that never
// drains. Transport audit `server/index.ts:225`.
const MAX_BUFFERED_BYTES = 16 * 1024 * 1024
// Per-socket in-flight async-handler cap (MAX_INFLIGHT_PER_SOCKET,
// env-validated in config). Each inbound text frame spawns a
// `track(handler)` IIFE; an authorised peer firing valid frames could
// otherwise grow the set without bound, stretching SIGTERM drain time.
// Saves dropped at the cap surface as a typed `busy` NACK. Transport
// audit `server/index.ts:590`.

// Per-connection state registry. One `Peer` per accepted socket holds
// the challenge nonce, auth flag, heartbeat liveness, in-flight count,
// and subscribed tags (see ./peer.ts) — replacing what were five
// parallel per-socket WeakMaps. The connection handler holds the Peer
// in a closure for the hot paths; cross-function call sites resolve it
// via `peers.get(socket)`.
const peers = new WeakMap<WebSocket, Peer>()

// REST PUT idle-body timeout. A slow-loris client trickling bytes
// within the declared Content-Length holds the staging fd and an
// inFlightSids slot until the global staging TTL reaps it. Aborting
// the per-chunk-idle period closes that window. Transport audit
// `server/objstore/rest.ts:218`.
const REST_PUT_IDLE_TIMEOUT_MS = 30_000

// Server-driven WS heartbeat. Every `HEARTBEAT_INTERVAL_MS` we walk
// `wss.clients`, terminate anyone who didn't pong since the last
// tick, and ping the rest. The client-initiated `{type:'ping'}` /
// `{type:'pong'}` JSON heartbeat the protocol already had only
// catches the case where the CLIENT notices the socket's gone — it
// can't recover an FD when the client itself has wandered off
// (battery-killed background tab, mid-transfer NAT timeout, a
// hostile non-browser client that opens the socket and never
// speaks again). The same-origin upgrade gate allows missing
// Origin headers through (legitimate non-browser callers), so a
// hostile CLI can stack arbitrarily many idle sockets without it.
// Kernel TCP keepalive is hours by default; without this interval
// each abandoned socket pins its `wss.clients` Set entry, its `Peer`
// state, and an FD until the kernel reclaims it. Two ticks max
// from silence to termination, so the longest a dead socket
// survives is ~2 × HEARTBEAT_INTERVAL_MS.
const HEARTBEAT_INTERVAL_MS = 30_000

// Backend selection. Both planes (workspace_revision DB + the
// v1.objstore byte store) are picked from config at boot. Two supported
// pairings:
//   1. DATABASE_URL set → Neon (workspace_revision + objstore
//      tables) + Vercel Blob Private Storage (bytes). Requires
//      BLOB_READ_WRITE_TOKEN — fail fast at boot if missing, since
//      a local-FS byte plane can't back a multi-replica deployment
//      (one replica's writes wouldn't be visible to another).
//   2. DATABASE_URL absent → SQLite + local FS bytes. Single-
//      process; the only pairing the SQLite plane supports.
// The Neon / Vercel files import their peer deps lazily inside the
// open functions, so static imports here are safe even on a SQLite-
// only install where the optional peer deps aren't present. Branch
// out explicitly (rather than via a ternary) so the SQLite path
// keeps its `SqliteHandle` narrowing — `sqliteHandle.db` is typed
// as a non-optional `DatabaseSync` and `openObjstore` accepts it
// without a non-null assertion.
let handle: Handle
let objstoreHandle: ObjstoreHandle
let objstoreBanner: string
if (NEON_URL) {
  if (!BLOB_TOKEN) {
    console.error('DATABASE_URL is set but BLOB_READ_WRITE_TOKEN is not.')
    console.error('The Neon DB plane requires the Vercel Blob byte plane (local-FS bytes cannot back a multi-replica deployment).')
    console.error('Set BLOB_READ_WRITE_TOKEN to your Vercel Blob R/W token, or unset DATABASE_URL to fall back to SQLite + local FS.')
    process.exit(1)
  }
  if (!TOKEN_SECRET) {
    console.error('DATABASE_URL is set but OBJSTORE_TOKEN_SECRET is not.')
    console.error('Multi-replica deployments need a shared HMAC secret so REST bearer tokens minted on one replica validate on any other.')
    console.error('Generate one with: node -e \'console.log(require("crypto").randomBytes(32).toString("base64"))\'')
    process.exit(1)
  }
  handle = await openNeonDb(NEON_URL)
  const blob = await openVercelBlobBackend({ token: BLOB_TOKEN })
  objstoreHandle = await openNeonObjstore(NEON_URL, blob)
  objstoreBanner = 'objstore: vercel-blob (private)'
} else {
  const sqliteHandle = openDb(DB_PATH)
  handle = sqliteHandle
  objstoreHandle = openObjstore(sqliteHandle.db, OBJSTORE_DIR)
  objstoreBanner = `objstore: ${OBJSTORE_DIR}`
}
// Multi-replica deployments behind a load balancer / TLS terminator
// (the typical Vercel + Neon shape) need TRUST_PROXY=1 to honour
// X-Forwarded-Host when computing the same-origin gate's expected
// origin. Otherwise the gate derives the origin from the internal
// container hostname and rejects every browser request as a
// cross-origin attempt — silently from the operator's perspective
// until users report 403s. Fail fast (parallels the
// BLOB_READ_WRITE_TOKEN / OBJSTORE_TOKEN_SECRET checks above) so
// a misconfigured deploy doesn't ship a 100%-403 fleet. An
// operator who genuinely terminates TLS in the container without
// X-Forwarded-* (rare) can set `TRUST_PROXY=0` to acknowledge.
if (NEON_URL && !TRUST_PROXY && !LOOPBACK_HOSTS.has(HOST) && TRUST_PROXY_ENV !== '0' && TRUST_PROXY_ENV !== 'false') {
  console.error(`DATABASE_URL is set and HOST=${HOST} is not loopback, but TRUST_PROXY is not enabled.`)
  console.error('Browser requests through a load balancer / TLS terminator will be rejected by the same-origin gate (all 403).')
  console.error('Set TRUST_PROXY=1 to honour X-Forwarded-Host / X-Forwarded-Proto from the upstream proxy.')
  console.error('Set TRUST_PROXY=0 if you really terminate TLS in the container without X-Forwarded-* headers (no proxy).')
  process.exit(1)
}

// "Workspace exists on the server" gate. The auth requirement only
// kicks in for the FIRST action against a never-before-seen tag —
// once any row lands (triage revision or objstore object), the
// workspace is considered established and signature-gated. Checks
// both planes so the gate stays consistent regardless of which
// action the user picks first (workspace-save in the common case;
// objstore-put-begin for a bundle-first flow).
async function workspaceExists(tag: string): Promise<boolean> {
  if (await handle.headFor.get(tag)) return true
  const c = await objstoreHandle.countLive.get(tag)
  return (c?.c ?? 0) > 0
}

// WS fan-out hub: subscriber registry + backpressure-aware send /
// broadcast (see ./hub.ts). Destructure into the existing names so the
// handlers / dispatcher / objstore wiring below read unchanged.
const hub = createHub({ peers, maxBufferedBytes: MAX_BUFFERED_BYTES, debug: DEBUG })
const { send, broadcast, subscribe, unsubscribeAll } = hub

// Password gate (see ./auth.ts) — HMAC derivation + the `authenticate`
// handshake. Destructure into the existing names for the wiring below.
const auth = createAuth({ peers, password: CONFIG_PASSWORD, send, debug: DEBUG })
const { requiresAuth, handleAuthenticate, sendUnauthorized } = auth

// Typed wrapper for the three `workspace-save-error` emit sites
// (too-large at handleSave, stale-base after the catch-up, busy
// at the inflight-cap drop). Forces the `reason` argument to be a
// member of `SaveErrorReason` so a typo or a server-side addition
// that didn't update `common/save-error-reason.ts` fails at
// compile time rather than turning into a wire-level surprise.
// The shared taxonomy is pinned by
// `tests/save-error-reason-taxonomy.test.js`.
function sendSaveError(
  socket: WebSocket,
  workspaceTag: string,
  base: string | null,
  reason: SaveErrorReason,
): void {
  // Runtime guard alongside the compile-time `SaveErrorReason`
  // union — covers the case where the `reason` argument is a
  // variable (not a string literal) and TypeScript's narrowing
  // can't enforce taxonomy membership at the call site. Throws
  // because a server emitting a typo'd reason would be a wire-
  // protocol break the client can't recover from; better to fail
  // fast in the test suite than to silently land bytes the
  // client coerces to `'rejected'`.
  if (!SAVE_ERROR_REASONS.has(reason)) {
    throw new Error(`sendSaveError: reason '${reason}' is not in SAVE_ERROR_REASONS — update common/save-error-reason.ts`)
  }
  send(socket, { type: 'workspace-save-error', workspaceTag, base, reason })
}

// Normalise `keyframe` on outbound chain entries to a strict boolean.
// SQLite stores the column as INTEGER (0/1) and `chainFrom` returns
// raw rows; the wire contract (and the canonical signing payload)
// uses strict `=== true` to mark keyframes. Forwarding the integer
// shape works only because every shipping client coerces via
// `Boolean(rev.keyframe)` before reconstructing the canonical
// bytes — fragile if a future client (or test harness) ever
// strict-compares. Convert once on the send side.
function chainForWire(revisions: RevisionRow[]): WireRevision[] {
  return revisions.map((r) => ({ ...r, keyframe: r.keyframe === 1 }))
}

const { handlers: objstore, restDeps: objstoreRestDeps, startupReap, stopReaper } = initObjstore({
  handle: objstoreHandle, reapIntervalMs: OBJSTORE_REAP_INTERVAL_MS,
  send, broadcast, getNonce: (socket) => peers.get(socket)?.challenge, debug: DEBUG,
  // Auth gate for the FIRST objstore-put-begin against a workspace
  // that doesn't yet exist on the server. Mirrors handleSave's gate
  // below; handlers.ts calls this AFTER sig verify so the
  // `unauthorized` frame only reaches a legitimate signer. Returns
  // `false` to allow, `true` to deny — handlers.ts emits the
  // `unauthorized` frame and bails on `true`.
  authGate: async (socket, tag) => requiresAuth(socket) && !await workspaceExists(tag),
  sendUnauthorized,
  // `tokenSecret` is set only when OBJSTORE_TOKEN_SECRET was
  // provided in env (see TOKEN_SECRET resolution above). Omitted
  // → initObjstore mints a fresh per-process secret (the pre-PR
  // behaviour, fine for single-replica).
  ...(TOKEN_SECRET ? { tokenSecret: TOKEN_SECRET } : {}),
})

async function handleSave(socket: WebSocket, msg: SaveMsg): Promise<void> {
  // `base` is `string | null`; null is the keyframe-root marker.
  if (!validTagSigBase(msg.workspaceTag, MAX_FIELD_LEN) || !validNonce(msg.nonce, MAX_FIELD_LEN) || !validCiphertextShape(msg.ciphertext) || !validTagSigBase(msg.signature, MAX_FIELD_LEN) || (msg.base != null && !validTagSigBase(msg.base, MAX_FIELD_LEN))) return
  // Compute canonical bytes + content-addressed id ONCE, then thread
  // both through the precheck → sig verify → commit pipeline:
  //   1. canonicalSave (sync, throws on lone-surrogate input)
  //   2. SHA-256 → id
  //   3. precheck: revisionExists → short-circuit ack on replay
  //      (skips Ed25519 verify; closes the round-9 H1 CPU-DoS vector
  //      where a passive observer floods captured saves)
  //   4. verifyEd25519 against the SAME canonical bytes the id was
  //      hashed from — provably tied
  //   5. ciphertext size policy (post-sig so the explicit error only
  //      reaches a legit signer)
  //   6. commitRevision — re-checks dup + base + inserts, all under
  //      one per-workspace_tag lock. The previously-separate dup
  //      recheck, headFor, base-match, insertRevision calls all
  //      collapse here. Without the lock, two concurrent saves with
  //      the same `base` and different ids would both pass an
  //      out-of-lock base check, both insert, and FORK THE CHAIN
  //      (two rows with the same base — UNIQUE is on id, not base);
  //      and two concurrent same-id retransmits would have one of
  //      them throw on UNIQUE with no ack reaching the originator.
  let canonical: Uint8Array<ArrayBuffer>
  try { canonical = canonicalSave(msg) } catch { return }
  const id = await computeRevisionIdFromCanonical(canonical)
  const tag = msg.workspaceTag
  if (await revisionExists(handle, tag, id)) {
    if (DEBUG) console.log(`save (precheck dup ${id.slice(0, 8)}…) → ack-only`)
    send(socket, { type: 'workspace-save-ack', workspaceTag: tag, base: msg.base ?? null, id })
    return
  }
  if (!await verifyEd25519(tag, canonical, msg.signature)) {
    if (DEBUG) console.warn('reject save: bad signature', debugTag(tag))
    return
  }
  // Size policy — emit an explicit error so the client can surface
  // the failure to the user. Without this, an oversized save hangs
  // forever in the client's `pending` slot (no ack, no rebase).
  if (msg.ciphertext.length > MAX_CIPHERTEXT_LEN) {
    if (DEBUG) console.warn(`reject save: ciphertext too large (${msg.ciphertext.length} > ${MAX_CIPHERTEXT_LEN})`)
    sendSaveError(socket, tag, msg.base == null || typeof msg.base !== 'string' ? null : msg.base, 'too-large')
    return
  }
  // Auth gate for the FIRST action against a workspace tag that
  // doesn't yet exist on the server (no rows in workspace_revision
  // AND none in workspace_object). Once any row lands, the workspace
  // is established and every signed action flows freely — access
  // control falls back to the Ed25519 signature for the rest of the
  // workspace's lifetime. Checked AFTER sig verify so the
  // `unauthorized` frame only reaches a legitimate signer; shape /
  // sig attacks still drop silently.
  //
  // RACE: `workspaceExists` reads outside the per-tag write lock that
  // `commitRevision` later acquires. Under concurrent saves on a
  // fresh tag, an unauthenticated socket whose `workspaceExists`
  // observes "true" (because an authenticated peer's commit landed
  // between this socket's check and its commit) skips the gate and
  // commits as the second writer. Accepted: the unauthenticated peer
  // still had to produce a valid Ed25519 signature (= holds the
  // workspace seed), and "two concurrent writes both authorising"
  // is the worst case. Tightening would require moving the gate
  // inside `commitRevision`'s lock and is not worth the layer
  // crossing for the soft-policy guarantee.
  if (requiresAuth(socket) && !await workspaceExists(tag)) {
    if (DEBUG) console.warn(`reject save: unauthorized (new workspace ${debugTag(tag)})`)
    sendUnauthorized(socket, { kind: 'gated', workspaceTag: tag, base: msg.base ?? null })
    return
  }
  // NOTE: Earlier revisions auto-subscribed the sending socket here.
  // That created a replay vector — a passive observer who captured
  // any single valid `workspace-save` frame could replay it from any
  // TCP connection forever to attach as a subscriber and silently
  // mirror every future encrypted broadcast for the workspace,
  // without ever holding the seed (the duplicate-id path returns
  // ack-only and doesn't reject the socket). Audit round-9 H1.
  //
  // The legitimate client always sends an explicit
  // `workspace-subscribe` (see `trySendSubscribe` in
  // `client/triage-sync.js` — fires on key derivation, on
  // socket open, on continuity-break recovery, on dismissError).
  // The subscribe path remains the only way to attach as a
  // broadcast subscriber.
  const baseNorm = msg.base ?? null
  // `keyframe === true` is what canonicalSave bound the signature
  // to (strict equality); the signer's intent is unambiguous here.
  const keyframe = msg.keyframe === true
  const commit = await commitRevision(handle, {
    tag, id, base: baseNorm, keyframe,
    nonce: msg.nonce, ciphertext: msg.ciphertext, signature: msg.signature,
  })
  if (commit.kind === 'duplicate') {
    if (DEBUG) console.log(`save (duplicate id ${id.slice(0, 8)}…) → ack-only`)
    send(socket, { type: 'workspace-save-ack', workspaceTag: tag, base: baseNorm, id })
    return
  }
  if (commit.kind === 'stale-base') {
    // Client claimed a base that's no longer head. Catch-up chain
    // is computed OUTSIDE the lock — a concurrent commit landing
    // between lock-release and `chainFrom` only means the catch-up
    // is fresher than the recheck saw, which is benign (clients
    // tolerate extra revisions in the chain).
    //
    // Wire order: send `workspace-state` (catch-up) FIRST, then
    // the typed `workspace-save-error { reason: 'stale-base' }`.
    // The catch-up's handler clears `session.pending`; the
    // subsequent error frame's `handleSaveError` then early-returns
    // on the missing pending and does NOT mark the session errored
    // — exactly what we want, since stale-base is a recoverable
    // race (client rebases + re-saves). The typed frame is for
    // protocol clarity (debug surfaces / explicit rejection signal),
    // not for triggering an error transition.
    // Audit follow-up to round-15 — `sync-server-races.test.js:1105`.
    const revisions = chainForWire(await chainFrom(handle, tag, baseNorm))
    if (DEBUG) console.log(`save (stale base ${baseNorm} vs head ${commit.head}) → chain ${revisions.length}`)
    send(socket, { type: 'workspace-state', workspaceTag: tag, revisions })
    sendSaveError(socket, tag, baseNorm, 'stale-base')
    return
  }
  if (DEBUG) console.log(`save${keyframe ? ' [keyframe]' : ''} → revision ${id.slice(0, 8)}… for ${debugTag(tag)}`)
  send(socket, {
    type: 'workspace-save-ack',
    workspaceTag: tag,
    base: baseNorm,
    id,
  })
  // Carry `keyframe` as a strict boolean on the broadcast wire —
  // peers strict-compare `=== true` (matching the canonical-payload
  // contract). The previous shape emitted `keyframe ? 1 : 0` which
  // a strict check would treat as non-keyframe, making a replayed
  // keyframe look like a regular delta on broadcast paths even
  // though the chain-fetch path (chainFrom → SQLite integer) DID
  // round-trip correctly.
  broadcast(tag, {
    type: 'workspace-state',
    workspaceTag: tag,
    revisions: [{
      base: baseNorm,
      id,
      keyframe,
      nonce: msg.nonce,
      ciphertext: msg.ciphertext,
      signature: msg.signature,
    }],
  }, socket)
}

async function handleSubscribe(socket: WebSocket, msg: SubscribeMsg): Promise<void> {
  if (typeof msg.workspaceTag !== 'string') return
  // Same `string | null` contract as `base` in handleSave. The
  // signed canonical uses `String(from)`, but the chain-lookup path
  // (`typeof msg.from === 'string' ? msg.from : null`) treats every
  // non-string as null — so a legit signer sending `from: { … }`
  // would silently take the keyframe-fallback path even though the
  // signature was over a different canonical shape. Reject at the
  // wire gate.
  if (msg.from != null && typeof msg.from !== 'string') return
  // The challenge nonce we issued on this socket is bound into
  // the signed canonical, blocking cross-connection replay of a
  // captured subscribe frame. A subscribe arriving before we sent
  // the challenge (impossible from the legitimate client) has no
  // nonce to verify against — drop. Audit round-9 H2.
  const nonce = peers.get(socket)?.challenge
  if (typeof nonce !== 'string') return
  const ok = await verifySubscribeSig(msg, nonce)
  if (!ok) {
    if (DEBUG) console.warn('reject subscribe: bad signature', debugTag(msg.workspaceTag))
    return
  }
  // Bail if the socket closed during the verify await. The close
  // handler's `unsubscribeAll(socket)` already ran (when there was
  // nothing to remove yet), and `subscribe()` below would add the
  // dead socket to `subscribers[tag]` — a permanent leak: broadcasts
  // no-op via `send`'s readyState gate, but the Set entry pins the
  // socket reference past close, blocking GC. Audit round-12.
  if (socket.readyState !== socket.OPEN) {
    if (DEBUG) console.warn('reject subscribe: socket closed mid-verify', debugTag(msg.workspaceTag))
    return
  }
  const tag = msg.workspaceTag
  subscribe(socket, tag)
  // Explicit ack — distinguishes "the server processed my
  // subscribe and registered me as a peer" from "the WebSocket
  // is open". A client that sent a malformed / bad-sig subscribe
  // never gets this; a client that did gets one before the chain
  // arrives. Lets the UI surface a `connecting → online`
  // transition based on real handshake completion, not just
  // socket state.
  send(socket, { type: 'workspace-subscribed', workspaceTag: tag })
  // `from` is the last revision id the client claims to have
  // applied — now a base64url string, not an integer. We send
  // only revisions after that. Client lying about `from` just
  // means they get a smaller catch-up — their subsequent saves
  // will reveal stale state on the usual base-mismatch path.
  // Null / missing → send the full chain.
  const fromId = typeof msg.from === 'string' ? msg.from : null
  const revisions = chainForWire(await chainFrom(handle, tag, fromId))
  if (DEBUG) console.log(`subscribe ${debugTag(tag)} from=${fromId?.slice(0, 8) ?? 'null'} → chain ${revisions.length}`)
  send(socket, { type: 'workspace-state', workspaceTag: tag, revisions })
}

// `/api/*` is reserved for backend traffic so a fronting nginx
// (or similar) can route `/api/*` → this process and `/*` → the
// static UI bundle with a single location block.
const WS_UPGRADE_PATH = '/api/sync'
function isUpgradePath(url: string | undefined): boolean {
  if (typeof url !== 'string') return false
  // Strip `?…` so clients can carry build / debug tags. Exact
  // match otherwise — `/api/sync/` (trailing slash) doesn't pass.
  return url.split('?', 1)[0] === WS_UPGRADE_PATH
}

const NOT_FOUND_BODY = JSON.stringify({ error: 'not-found' })

// Static-file plane (see `./static.ts`). The directory is the
// `build.js build` output sibling to this file; the loader handles
// directory enumeration, pre-compression, and ETag derivation. The
// returned handler is plugged into the HTTP request handler below
// after the `/api/objstore/...` REST branch.
const handleStatic = loadStatic(fileURLToPath(new URL('../out', import.meta.url)))

const httpServer = createServer((req: HttpRequest, res: ServerResponse) => {
  if (matchRoute(req.url) != null) {
    // Shutdown gate. The WS plane gates new messages on
    // `shuttingDown` at line 906, but REST handlers go through a
    // separate path and must mirror that gate. Without this, a
    // REST PUT arriving on an existing keep-alive socket AFTER
    // SIGTERM but BEFORE `httpServer.close()` finishes draining
    // could land in `withCommitLock`, acquire a lease, and finish
    // its `finally { release() }` AFTER the shutdown's
    // `heldLeaseCount` snapshot — leaving an orphan row in the
    // commit_lock table that pins the key until TTL expiry. The
    // 503 + `shutting-down` reason tells the client to retry
    // against a different replica (the load balancer should have
    // already drained this one). Transport audit + multi-replica
    // shutdown ordering review.
    if (shuttingDown) {
      res.writeHead(503, { 'content-type': 'application/json', 'connection': 'close' })
      res.end(JSON.stringify({ error: 'shutting-down' }))
      return
    }
    // Same-origin gate. Token IS the auth on REST, but a hostile
    // origin that holds a valid token (e.g. via XSS that read a
    // freshly-minted one) would PUT with its own Origin header — we
    // catch that here. Same-origin XHR/fetch may omit Origin; that
    // path is allowed (see `isOriginAllowed`). Transport audit
    // `server/objstore/rest.ts:103`.
    if (!isOriginAllowed(req)) {
      res.writeHead(403, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'origin-denied' }))
      return
    }
    // PUT idle-body timeout — a slow-loris client trickling bytes
    // within the declared Content-Length holds the staging fd + an
    // inFlightSids slot indefinitely. `req.setTimeout` fires on
    // inactivity (no bytes received within the window) and emits
    // `'timeout'`; we destroy the request, which aborts the body
    // pipeline. Transport audit `server/objstore/rest.ts:218`.
    if (req.method === 'PUT') {
      req.setTimeout(REST_PUT_IDLE_TIMEOUT_MS, () => {
        if (DEBUG) console.warn(`REST PUT idle ${REST_PUT_IDLE_TIMEOUT_MS}ms → abort`)
        try { req.destroy(new Error('idle-timeout')) } catch {}
      })
    }
    // Track so SIGTERM mid-upload/download awaits handleRest before
    // handle.close(). `httpServer.close()` waits for active requests
    // too, but the WS plane's track() pattern is the canonical drain.
    //
    // Outer `.catch` is the unhandled-rejection guard for a stray
    // throw OUTSIDE handleRest's internal PUT/GET try/catch blocks —
    // e.g. a `deny()` write to an already-destroyed response, or a
    // future code path the inner catches don't cover. Node 20+
    // defaults `--unhandled-rejections=throw`, which would crash the
    // server. Same pattern as the WS message handler's IIFE catch
    // above. Logs and ensures the response is terminated so the TCP
    // socket doesn't dangle.
    const p = handleRest(objstoreRestDeps, req, res).catch((err) => {
      console.warn('REST handler error:', errStack(err))
      if (res.headersSent) { try { res.destroy() } catch {} }
      else { try { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'internal' })) } catch {} }
    })
    track(p)
    return
  }
  if (handleStatic(req, res)) return
  // `Connection: close` so an HTTP/1.1 keep-alive client doesn't
  // hold the socket open expecting more requests on a server that
  // only serves a small REST surface — same reason `socket.end(...)`
  // below sends FIN immediately after the upgrade-rejection body.
  res.writeHead(404, { 'content-type': 'application/json', 'connection': 'close' })
  res.end(NOT_FOUND_BODY)
})
// 4 MiB cap leaves headroom above MAX_CIPHERTEXT_LEN (2 MiB) for
// the JSON envelope + base64 overhead. `ws` defaults to 100 MiB
// which any unauthenticated peer could spam — every connection
// accepts and JSON.parses up to that before the signature-fail drops
// the frame.
const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 })
httpServer.on('upgrade', (req, socket, head) => {
  // RFC 6455: the WS upgrade IS an HTTP request; reject with a
  // normal HTTP response so a misconfigured client sees the JSON
  // body instead of ECONNRESET. `socket.end(body)` flushes before
  // sending FIN — `socket.write(...) + socket.destroy()` can
  // truncate the body when destroy() doesn't wait for the write
  // buffer to drain.
  if (!isUpgradePath(req.url)) {
    socket.end(
      'HTTP/1.1 404 Not Found\r\n' +
      'Content-Type: application/json\r\n' +
      `Content-Length: ${Buffer.byteLength(NOT_FOUND_BODY)}\r\n` +
      'Connection: close\r\n\r\n' +
      NOT_FOUND_BODY,
    )
    return
  }
  // Same-origin gate. The WS upgrade IS a cross-origin-reachable
  // surface in the browser; without this any page in any tab can
  // open a session to a 127.0.0.1 relay and probe handler shape /
  // burn signature-verify CPU. Browser WS handshakes always carry
  // Origin (RFC 6455), so a foreign tab is caught here; non-
  // browser clients (test suite, admin CLI) omit Origin and are
  // allowed (network is their trust boundary).
  if (!isOriginAllowed(req)) {
    socket.end(
      'HTTP/1.1 403 Forbidden\r\n' +
      'Content-Type: application/json\r\n' +
      'Content-Length: 26\r\n' +
      'Connection: close\r\n\r\n' +
      '{"error":"origin-denied"}\n',
    )
    return
  }
  wss.handleUpgrade(req, socket, head, (ws) => { wss.emit('connection', ws, req) })
})

// In-flight async message handlers. `shutdown` awaits this set
// before closing the DB so a SIGINT mid-save can't resume against
// a closed handle (which would throw inside `insertRevision` after
// the client believed its save was committed).
const inFlight = new Set<Promise<unknown>>()
function track(promise: Promise<unknown>): void {
  inFlight.add(promise)
  promise.finally(() => inFlight.delete(promise))
}

// Hoisted above the connection handler so the message-loop's
// `if (shuttingDown) return` reads from a defined binding even if
// the closure runs in the same tick the variable is declared.
let shuttingDown = false
// Live exit code the in-progress shutdown will pass to
// `process.exit`. Re-entry can ESCALATE it from 0 → 1 (e.g. a
// `wss.error` firing during a SIGTERM-driven graceful shutdown
// shouldn't leave the launcher seeing a clean exit code) but
// can never DE-escalate. Audit round-13.
let pendingExitCode = 0

wss.on('connection', (socket: WebSocket, req) => {
  if (DEBUG) console.log(`connect from ${req.socket.remoteAddress}`)
  // One Peer holds this connection's state (challenge / authorized /
  // alive / inflight / tags). Created before any client frame can
  // arrive (`socket.on('message')` is wired below). The heartbeat
  // sweep flips `alive` false after each `ping()`; the `pong` listener
  // flips it back, and a socket still false on the next sweep is
  // terminated — the only thing closing FDs for an idle peer.
  const peer = new Peer(randomId())
  peers.set(socket, peer)
  socket.on('pong', () => { peer.alive = true })
  // Issue the per-connection challenge nonce BEFORE the client can
  // send anything that needs it. The client signs it into every
  // `workspace-subscribe` (see canonicalSubscribe in server/sign.ts);
  // a captured subscribe frame can't be replayed from a different
  // connection because that connection's nonce differs and the
  // signature won't verify against the new canonical bytes. Round-9 H2.
  send(socket, { type: 'challenge', nonce: peer.challenge })
  // Per-socket handlers are DELIBERATELY NOT serialized (vs the
  // client-side `messageQueue = messageQueue.then(...)` Promise
  // chain inside `client/triage-sync.ts:onTransportMessage`).
  // Each inbound frame spawns its own tracked async IIFE; two
  // frames from the same socket can interleave across `await`
  // boundaries inside the handlers. Per-resource correctness is
  // preserved by the `KeyedAsyncLock` (held by `commitRevision` /
  // `commitPut` / `beginPut` / `deleteObject`) and by post-await
  // `readyState === OPEN` rechecks in every objstore handler. The
  // unbounded fan-out is capped by `MAX_INFLIGHT_PER_SOCKET` (see
  // also the `'busy'` NACK at the cap below). Concurrent dispatch
  // is intentional: it lets multi-workspace clients multiplex
  // saves + subscribes over one socket without HOL blocking.
  // Audit follow-up to round-15 concurrency review.
  socket.on('message', (data: Buffer, isBinary: boolean) => {
    // Drop new work once shutdown started — `wss.close()` stops new
    // CONNECTIONS but already-open sockets can still send messages.
    // Without this gate a message arriving between `wss.close()`
    // resolving and the `inFlight` snapshot would spawn a handler
    // that's NOT in the snapshot, then resume against the just-
    // closed DB and throw inside `insertRevision`. Audit round-9.
    if (shuttingDown) return
    // Wire protocol is JSON over text frames. A binary frame is
    // either a buggy client or someone probing — drop without
    // attempting to interpret it as text.
    if (isBinary) return
    let msg: IncomingMessage | null = null
    try {
      // `decodeUtf8` is fatal on invalid UTF-8 (vs `Buffer.toString`
      // which silently substitutes U+FFFD). The substitution path
      // would let mangled bytes pass JSON.parse only to fail
      // signature verification deeper in the handler — wasted work
      // and noisier logs. Fail at the gate.
      msg = JSON.parse(decodeUtf8(data)) as IncomingMessage
    } catch { return }
    if (!msg || typeof msg !== 'object') return
    const parsed: IncomingMessage = msg
    // Per-socket inflight cap. Each tracked handler keeps the socket
    // alive in `inFlight`, and a peer who keeps firing valid frames
    // can spawn unbounded handlers — growing SIGTERM drain time and
    // memory. Drop new work above the cap. Heartbeat ping is the
    // exception: it's stateless, synchronous, and we want to KEEP
    // responding so the peer doesn't drop the socket while we're
    // shedding load. Pings go through a fast inline `send(pong)`
    // path BELOW that doesn't bump the per-socket inflight counter,
    // so a ping-spam at the cap can't outrun the gate. Transport
    // audit `server/index.ts:590` + post-#58 audit follow-up.
    if (parsed.type === 'ping') {
      send(socket, { type: 'pong' })
      return
    }
    // `authenticate` runs synchronously (constant-time bytes compare
    // — no DB, no I/O), so it shares the same fast-inline path as
    // `ping` and bypasses the per-socket inflight counter. Keeping
    // it out of the IIFE pool means an unauthenticated client can
    // still complete the handshake when the socket is otherwise
    // saturated (matching the philosophy of the `busy` NACK path
    // for `workspace-save`: don't strand a recoverable handshake
    // behind the cap).
    if (parsed.type === 'authenticate') {
      handleAuthenticate(socket, parsed as AuthenticateMsg)
      return
    }
    if (peer.inflight >= MAX_INFLIGHT_PER_SOCKET) {
      if (DEBUG) console.warn(`drop message: socket inflight ${peer.inflight} >= ${MAX_INFLIGHT_PER_SOCKET}`)
      // For workspace-save specifically, send a typed NACK so the
      // client's `pending` slot clears IMMEDIATELY instead of
      // hanging until the next heartbeat (~15–30s). Reason `busy`
      // is server-side overload; safe to retry. Same wire envelope
      // as the existing `too-large` save-error path.
      //
      // Wire-order interaction with `'stale-base'`: the cap-path
      // send is SYNCHRONOUS in this message callback and lands on
      // the wire BEFORE any handler IIFE's `await`-completed reply.
      // If an earlier in-flight `workspace-save` (frame F1) ends up
      // emitting a catch-up `workspace-state` + `'stale-base'` while
      // a later frame F2 hits the cap, the order is `'busy'`(F2) →
      // `workspace-state`(F1) → `'stale-base'`(F1). The client's
      // `handleSaveError` correlates on `base`, and the wire-order
      // trick documented in `common/save-error-reason.ts` (catch-up
      // clears `pending` before the stale-base frame's
      // `handleSaveError` runs) still holds.
      const rawBase = (parsed as SaveMsg).base
      const baseField: string | null = typeof rawBase === 'string' ? rawBase : null
      const rawTag = (parsed as SaveMsg).workspaceTag
      const tagField = typeof rawTag === 'string' ? rawTag : null
      if (parsed.type === 'workspace-save' && tagField != null) {
        // `sendSaveError` runs its taxonomy-guard before the wire
        // send and throws on an unknown reason. Every OTHER emit
        // site lives inside the `handler` IIFE's try/catch — this
        // cap path is the only one outside it. Mirror the same
        // forensic envelope so a future bad reason here surfaces
        // as `Handler error (type=workspace-save): …` rather than
        // escaping to ws's emitter as an uncaught.
        try {
          sendSaveError(socket, tagField, baseField, 'busy')
        } catch (err) {
          console.warn('Handler error (type=workspace-save):', errStack(err))
        }
      }
      return
    }
    peer.inflight += 1
    const handler = (async () => {
      try {
        if (parsed.type === 'workspace-save') await handleSave(socket, parsed as SaveMsg)
        else if (parsed.type === 'workspace-subscribe') await handleSubscribe(socket, parsed as SubscribeMsg)
        // Objstore control plane — bytes ride the REST plane via
        // tokens these handlers mint. The Objstore*Msg types are
        // weak shapes (every field `unknown`); the handlers narrow
        // each field through their own validators on entry.
        else if (parsed.type === 'objstore-put-begin') await objstore.handlePutBegin(socket, parsed as ObjstorePutBeginMsg)
        else if (parsed.type === 'objstore-delete') await objstore.handleDelete(socket, parsed as ObjstoreDeleteMsg)
        else if (parsed.type === 'objstore-list') await objstore.handleList(socket, parsed as ObjstoreListMsg)
        else if (parsed.type === 'objstore-fetch') await objstore.handleFetch(socket, parsed as ObjstoreFetchMsg)
      } catch (err) {
        // Forensic logging for unexpected throws — the handlers all
        // have internal narrow catches (e.g. signature reject paths);
        // anything reaching here is unexpected. Include the wire
        // `type` so an operator can correlate to a specific code
        // path, and prefer `.stack` over `.message` so the post-
        // mortem has the throw site.
        const typeStr = typeof parsed.type === 'string' ? parsed.type : '<unknown>'
        console.warn(`Handler error (type=${typeStr}):`, errStack(err))
      } finally {
        peer.inflight -= 1
      }
    })()
    track(handler)
  })
  socket.on('close', () => {
    // `unsubscribeAll` reads `peer.tags` (peer still registered), then
    // we drop the Peer. The Peer's state would GC once the socket is
    // unreachable, but `wss.clients` / `ws` internals hold the socket
    // strongly well past `close`, so the explicit delete frees it
    // immediately. Audit round-10 + round-13.
    unsubscribeAll(socket)
    peers.delete(socket)
  })
  // Surface socket-level errors instead of swallowing — these are
  // the signals operators want under abuse / network flakiness
  // (TLS handshake failures, frame-decode errors, ws-protocol
  // violations). The previous `() => {}` left every per-connection
  // failure invisible. `close` fires after `error` and runs the
  // unsubscribe cleanup, so logging here doesn't risk leaking.
  socket.on('error', (err: Error) => { console.warn('Socket error:', errMsg(err)) })
})

// Periodic heartbeat sweep. Two-tick liveness window: a socket
// that doesn't `pong` within `HEARTBEAT_INTERVAL_MS` of our `ping`
// sees its tracker flip to `false`; on the NEXT tick we terminate.
// `try/catch` shrugs at any peer that races us into CLOSING / CLOSED
// (`ws.ping` / `ws.terminate` throw in that state) — the close
// event handles cleanup either way.
//
// `unref` so the timer alone doesn't keep the event loop alive
// (parity with `terminateTimer` in `shutdown` below). Cleared in
// `shutdown` so a graceful SIGTERM doesn't fire one last ping race
// after `wss.close` resolved.
const heartbeatTimer = setInterval(() => {
  for (const ws of wss.clients) {
    const peer = peers.get(ws)
    if (peer?.alive === false) {
      try { ws.terminate() } catch {}
      continue
    }
    if (peer) peer.alive = false
    try { ws.ping() } catch {}
  }
}, HEARTBEAT_INTERVAL_MS)
heartbeatTimer.unref?.()

httpServer.on('listening', () => {
  // Read the actual bound port from `httpServer.address()` rather
  // than the `PORT` env constant. Operators (and the test harness)
  // can boot with `PORT=0` to get an OS-assigned ephemeral port;
  // the log line then carries the real bound number, not `0`.
  // Server-side bind failure took the error path above, so
  // `address()` is always a populated AddressInfo here.
  const addr = httpServer.address()
  const boundPort = typeof addr === 'object' && addr ? addr.port : PORT
  // Differentiate the storage banner by backend so the log line
  // doesn't claim a misleading DB_PATH under Neon, or a misleading
  // OBJSTORE_DIR under Vercel Blob.
  const dbBanner = NEON_URL ? 'db: neon-postgres' : `db: ${DB_PATH}`
  console.log(`DeepView triage-sync server: ws://${HOST}:${boundPort}${WS_UPGRADE_PATH} http://${HOST}:${boundPort}/api/objstore/{workspaceTag}/{resourceTag} (${dbBanner}, ${objstoreBanner})`)
})

// Route bind / post-listen failures through `shutdown` so the
// in-flight handler drain + DB close still run before exit.
// Without this, `ws` re-emits the error as uncaughtException and
// the launcher sees a confusing crash rather than the bind
// failure. Audit round-9 M2.
httpServer.on('error', (err: Error) => {
  console.error('Server error:', errStack(err))
  fireShutdown(1)
})
wss.on('error', (err: Error) => {
  // Symmetric with the http.Server error handler above — route
  // through `fireShutdown(1)` so the launcher sees a non-zero exit.
  // The re-entry escalation in `shutdown()` (round-13 audit) takes
  // a `wss.error` arriving mid-graceful-SIGTERM and bumps
  // `pendingExitCode` from 0 → 1; without `fireShutdown`, a pre-
  // shutdown `wss.error` would log + drop and the launcher would
  // never know to treat the process as failed.
  console.error('WS server error:', errStack(err))
  fireShutdown(1)
})

// `.catch` defends against an unguarded `await` slipping into
// `shutdown` later: an unhandled rejection here would skip the
// non-zero exit the launcher relies on.
function fireShutdown(code: number): void {
  shutdown(code).catch((err) => {
    console.warn('shutdown error:', errStack(err))
    process.exit(code === 0 ? 1 : code)
  })
}

async function shutdown(exitCode: number = 0): Promise<void> {
  // Re-entry: don't restart the teardown, but escalate the pending
  // exit code if the new caller is non-zero (e.g. a wss.error during
  // a SIGTERM-driven graceful shutdown). Without this, an error
  // arriving mid-shutdown would silently exit 0 and the launcher
  // would record a clean stop.
  if (shuttingDown) {
    if (exitCode !== 0 && pendingExitCode === 0) pendingExitCode = exitCode
    return
  }
  shuttingDown = true
  pendingExitCode = exitCode
  console.log('Shutting down…')
  // Stop the heartbeat so a tick can't fire mid-shutdown and ping
  // a socket the close-loop below already started tearing down.
  // `unref` already kept it from holding the loop open; this is
  // the symmetric explicit teardown.
  clearInterval(heartbeatTimer)
  // Send a 1001 (going away) close frame to every open socket BEFORE
  // shutting the listener. Lets clients distinguish a server-initiated
  // graceful shutdown from a network drop, so they can skip their
  // reconnect backoff and reconnect on the operator's schedule
  // instead. Fire-and-forget — `process.exit(0)` below would
  // force-kill any in-progress flush anyway, and the close frame
  // gets one tick to drain through the socket buffer before the
  // following `await wss.close` resolves. The `try/catch` shrugs at
  // sockets already in CLOSING / CLOSED.
  for (const socket of wss.clients) {
    try { socket.close(1001, 'Server shutting down') } catch {}
  }
  // Force-terminate any client that doesn't ack the close frame
  // within a short grace window. `wss.close()` waits for every client
  // to emit `'close'`, and the `ws` library only TCP-RSTs unresponsive
  // peers after its own ~30 s `closeTimeout`. A single dead/blackholed
  // peer would otherwise stretch SIGTERM/SIGINT response by that
  // full timeout. Audit round-11.
  const TERMINATE_GRACE_MS = 1_000
  const terminateTimer = setTimeout(() => {
    for (const socket of wss.clients) {
      const rs = socket.readyState
      if (rs === socket.OPEN || rs === socket.CLOSING) {
        try { socket.terminate() } catch {}
      }
    }
    // Same grace for HTTP keep-alive sockets that didn't respect the
    // `Connection: close` hint. Without this, an idle keep-alive
    // connection can hold `httpServer.close()` until its TCP timeout.
    try { httpServer.closeAllConnections() } catch {}
  }, TERMINATE_GRACE_MS)
  // Don't keep the event loop alive solely for the grace timer —
  // wss.close resolution already drives shutdown progress.
  terminateTimer.unref?.()
  // Stop the periodic reaper AND wait for any in-flight sweep
  // (incl. the startup sweep) to finish before `handle.close()`
  // below — otherwise a readdir / unlink would race a closed DB.
  await stopReaper()
  // Free idle HTTP keep-alive sockets up front so the close()
  // below doesn't wait on them. Active in-flight requests still
  // get to finish; only sockets sitting in keep-alive limbo go.
  try { httpServer.closeIdleConnections() } catch {}
  // Close http.Server first to stop accepting new upgrades + HTTP
  // requests. Guard with `.listening` because `close()` throws
  // ERR_SERVER_NOT_RUNNING when bind never succeeded (the http
  // error handler is the path that invoked shutdown in that case).
  if (httpServer.listening) {
    await new Promise<void>((resolve) => { httpServer.close(() => resolve()) })
  }
  await new Promise<void>((resolve) => { wss.close(() => resolve()) })
  clearTimeout(terminateTimer)
  // Drain in-flight handlers so a save that's mid-pipeline finishes
  // its insertRevision before the DB closes. `handleSave` splits
  // canonicalSave + computeRevisionIdFromCanonical + revisionExists
  // + verifyEd25519 + commitRevision across awaits (dup-precheck
  // interleaved between id-derive and verify), so the in-flight
  // window spans several yield points. Without this drain, SIGINT
  // during a save throws into the connection-level catch (silent
  // log) and the row is lost even though the client may already
  // have observed an ack from a separate broadcast path.
  // `Promise.allSettled` so a single handler rejection doesn't
  // abort the drain.
  if (inFlight.size > 0) await Promise.allSettled([...inFlight])
  // Release any commit-lock leases this process still holds. Runs
  // AFTER the in-flight drain so a PUT that was mid-commit has
  // already gone through its own finally-release; we mop up only
  // anything stuck. A rolling restart without this step pins every
  // held key for the full lease TTL on the new replicas trying to
  // access them. Tolerant — the DB lease will expire naturally on
  // failure.
  const heldBefore = heldLeaseCount()
  if (heldBefore > 0) {
    if (DEBUG) console.log(`releasing ${heldBefore} commit-lock lease(s) held by this process`)
    try { await releaseAllForThisProcess(objstoreHandle) }
    catch (err) { console.warn('commit-lock shutdown release error:', errMsg(err)) }
  }
  // objstoreHandle has no `close()`:
  //  - SQLite: it shares the workspace_revision handle's
  //    `DatabaseSync`, which `handle.close()` below closes.
  //  - Neon: there's no persistent connection at all — `neon()`
  //    returns a stateless HTTP callable, and the SQLite-only
  //    `DatabaseSync` is the only thing that ever needs explicit
  //    shutdown. `handle.close()` below is itself a no-op on Neon.
  try { await handle.close() } catch (err) { console.warn('DB close error:', errMsg(err)) }
  // Read `pendingExitCode` (not the parameter) so a re-entrant
  // `shutdown(1)` that landed during the drain wins over the
  // original `shutdown(0)`. See round-13 escalation note.
  process.exit(pendingExitCode)
}
// Wrap signal handlers so the signal name (passed as the listener's
// first arg) doesn't bleed into shutdown's `exitCode` parameter.
process.on('SIGINT', () => fireShutdown(0))
process.on('SIGTERM', () => fireShutdown(0))

// Process-level catchalls so a stray rejection or uncaught exception
// doesn't bypass `shutdown()` — Node 20+ defaults exit-on-unhandled-
// rejection which would skip the in-flight handler drain and the DB
// close. Log forensically (full stack), route through `fireShutdown(1)`
// so the launcher records a non-zero exit and the same teardown path
// runs as on a SIGTERM. Audit round-11 observability.
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', errStack(reason))
  fireShutdown(1)
})
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', errStack(err))
  fireShutdown(1)
})

// Bind only after the startup orphan sweep finishes — otherwise a
// fresh boot could serve traffic against tags whose on-disk state
// still has residue from a prior crash. Top-level await is fine
// for an entry-point ESM module (no other module imports this for
// its exports — the side effect IS the program). `startupReap`
// already resolves on any error (the reaper's own catch logs the
// failure unconditionally and returns void), so no outer `.catch`
// is needed here.
await startupReap
httpServer.listen(PORT, HOST)
