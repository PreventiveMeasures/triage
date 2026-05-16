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
import { randomBytes } from 'node:crypto'
import { argv, env } from 'node:process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { decodeUtf8 } from '../common/utf8.js'
import { type Handle, type RevisionRow, chainFrom, commitRevision, openDb, revisionExists } from './db.ts'
import { openNeonDb } from './db-neon.ts'
import { type SaveMsg, type SubscribeMsg, canonicalSave, computeRevisionIdFromCanonical, verifyEd25519, verifySubscribeSig } from './sign.ts'
import { handleRest, matchRoute } from './objstore/rest.ts'
import { initObjstore } from './objstore/init.ts'
import { type Handle as ObjstoreHandle, openObjstore } from './objstore/store.ts'
import { openNeonObjstore } from './objstore/store-neon.ts'
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

const PORT = Number(env['PORT'] ?? 8765)
const HOST = env['HOST'] ?? '127.0.0.1'
// Fail fast on a malformed PORT — `Number("abc")` is NaN, and
// `WebSocketServer({ port: NaN })` throws deep inside `node:net`
// with a confusing trace. A clear up-front error lets the operator
// fix the env var without trawling the stack.
if (!Number.isSafeInteger(PORT) || PORT < 0 || PORT > 65535) {
  console.error(`Invalid PORT: ${env['PORT']}`)
  process.exit(1)
}
// `fileURLToPath` decodes percent-escapes and handles non-ASCII path
// segments correctly (the older `new URL(...).pathname` form left
// `%20` etc. raw, breaking deploys under paths like `/srv/deep view/`).
const DB_PATH = env['DB_PATH'] ?? fileURLToPath(new URL('./data/data.db', import.meta.url))
// `path.join` so a Windows DB_PATH (`C:\srv\foo\data.db` → dirname
// returns backslash-separated) doesn't get a mixed-separator child
// (`C:\srv\foo/objstore`). Cosmetic on POSIX, real bug on win32.
const OBJSTORE_DIR = env['OBJSTORE_DIR'] ?? join(dirname(DB_PATH), 'objstore')
// `Number('abc')` is NaN and `setInterval(…, NaN)` runs a 0-ms loop;
// reject up front like PORT does.
const OBJSTORE_REAP_INTERVAL_MS = Number(env['OBJSTORE_REAP_INTERVAL_MS'] ?? 10 * 60 * 1000)
if (!Number.isSafeInteger(OBJSTORE_REAP_INTERVAL_MS) || OBJSTORE_REAP_INTERVAL_MS <= 0) {
  console.error(`Invalid OBJSTORE_REAP_INTERVAL_MS: ${env['OBJSTORE_REAP_INTERVAL_MS']}`); process.exit(1)
}
const DEBUG = env['DEBUG'] === '1'

// Same-origin gate for the WS upgrade and REST data plane. We don't
// support cross-origin browser clients, so any Origin header
// present on an incoming request MUST match the server's own host
// (derived from `req.headers.host` directly, or from `X-Forwarded-
// Host` / `X-Forwarded-Proto` when a reverse proxy is in front and
// we're configured to trust it).
//
// Why "present-must-match" rather than "always required":
// - WebSocket handshakes from browsers always carry an Origin header
//   (per RFC 6455), so a foreign-page session attempt always
//   surfaces here.
// - Browser same-origin XHR/fetch may OMIT the Origin header
//   entirely; requiring it would break legitimate same-origin REST
//   calls.
// - Non-browser clients (the test suite's `ws`, an admin CLI, …)
//   may also omit Origin. Same-origin in that context just means
//   "trusted operator process" and the network is the trust
//   boundary.
//
// Reverse-proxy support is OPT-IN via TRUST_PROXY. When off, we
// ignore `X-Forwarded-Host` / `X-Forwarded-Proto` entirely and
// derive the expected origin from `req.headers.host` + `http://`.
// When on, the proxy headers take precedence. This guards a public-
// bind deployment (`HOST=0.0.0.0` directly on a port, no proxy)
// from a trivial bypass: an attacker page would otherwise send its
// own `X-Forwarded-Host` + matching `Origin` and walk through the
// gate. Default: ON for loopback binds (typical: relay behind nginx
// on the same host), OFF for everything else (operator must
// explicitly opt-in when fronting a public bind with a proxy).
// Transport audit `server/index.ts:530` + `server/objstore/rest.ts:103`.
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost'])
const TRUST_PROXY_ENV = env['TRUST_PROXY']
const TRUST_PROXY = TRUST_PROXY_ENV == null
  ? LOOPBACK_HOSTS.has(HOST)
  : TRUST_PROXY_ENV === '1' || TRUST_PROXY_ENV.toLowerCase() === 'true'

function firstHeaderValue(v: string | string[] | undefined): string | null {
  if (typeof v === 'string') return v.split(',')[0]!.trim() || null
  if (Array.isArray(v) && v.length > 0) return String(v[0]).trim() || null
  return null
}
function expectedOrigin(req: { headers: HttpRequest['headers'] }): string | null {
  const xfHost = TRUST_PROXY ? firstHeaderValue(req.headers['x-forwarded-host']) : null
  const xfProto = TRUST_PROXY ? firstHeaderValue(req.headers['x-forwarded-proto']) : null
  const host = xfHost ?? firstHeaderValue(req.headers['host'])
  if (!host) return null
  const proto = xfProto ?? 'http'
  return `${proto}://${host}`
}
function isOriginAllowed(req: { headers: HttpRequest['headers'] }): boolean {
  const origin = firstHeaderValue(req.headers['origin'])
  // Missing Origin → same-origin browser fetch OR non-browser
  // client. Both are allowed; non-browser callers' trust boundary
  // is the network / token, not Origin.
  if (origin == null) return true
  const expected = expectedOrigin(req)
  if (expected == null) return false // Origin present but no Host to compare → deny
  return origin === expected
}

// Per-socket buffered-bytes cap. `socket.send` returns synchronously
// even when the kernel/ws library can't drain to the wire fast
// enough; the unsent payload accumulates in `bufferedAmount`. A
// slow / blackholed peer on a high-volume workspace can hold many
// MB of fan-out broadcasts in this buffer with no backpressure on
// the broadcast loop. Drop the message when the buffer crosses the
// cap; the heartbeat will eventually close a peer that never
// drains. Transport audit `server/index.ts:225`.
const MAX_BUFFERED_BYTES = 16 * 1024 * 1024
// Per-socket in-flight async-handler cap. Each inbound text frame
// spawns a `track(handler)` IIFE; an authorised peer who keeps
// firing valid frames can grow this set without bound, growing the
// SIGTERM drain time. Drop frames once the cap is hit. Transport
// audit `server/index.ts:590`.
const MAX_INFLIGHT_PER_SOCKET = 64
const socketInflight = new WeakMap<WebSocket, number>()

// REST PUT idle-body timeout. A slow-loris client trickling bytes
// within the declared Content-Length holds the staging fd and an
// inFlightSids slot until the global staging TTL reaps it. Aborting
// the per-chunk-idle period closes that window. Transport audit
// `server/objstore/rest.ts:218`.
const REST_PUT_IDLE_TIMEOUT_MS = 30_000

if (argv.includes('--help') || argv.includes('-h')) {
  console.log(`Usage: node server/index.ts
Environment:
  PORT                       listen port (default 8765)
  HOST                       bind host (default 127.0.0.1)
  DB_PATH                    sqlite file (default: server/data/data.db);
                             ignored when DATABASE_URL is set
  DATABASE_URL               Neon Postgres connection string; if set,
                             selects the Neon backend instead of
                             SQLite. Requires the optional peer dep
                             @neondatabase/serverless.
  OBJSTORE_DIR               object store root (default: ./objstore
                             next to DB_PATH; the default still uses
                             DB_PATH's dirname even when DATABASE_URL
                             selects the Neon backend — set
                             OBJSTORE_DIR explicitly if you want it
                             elsewhere)
  OBJSTORE_REAP_INTERVAL_MS  orphan reaper period (default 600000)
  TRUST_PROXY                set '1' / 'true' to honour X-Forwarded-
                             Host / X-Forwarded-Proto when computing
                             the same-origin gate's expected origin.
                             Default: ON when HOST is a loopback
                             (127.0.0.1, ::1, localhost) — the typical
                             "behind nginx on same host" deployment.
                             OFF for public binds (HOST=0.0.0.0 etc.)
                             where a bare X-Forwarded-* would
                             otherwise let an attacker page bypass
                             the gate.
  DEBUG=1                    log every message`)
  process.exit(0)
}

// Backend selection. Both planes (workspace_revision + the v1.objstore
// tables) flow through the same backend, picked by DATABASE_URL
// presence; absent → SQLite. The Neon files import
// `@neondatabase/serverless` lazily inside their open functions, so
// static imports here are safe even on a SQLite-only install where the
// optional peer dep isn't present. Branch out explicitly (rather than
// via a ternary) so the SQLite path keeps its `SqliteHandle` narrowing
// — `sqliteHandle.db` is typed as a non-optional `DatabaseSync` and
// `openObjstore` accepts it without a non-null assertion.
const NEON_URL = env['DATABASE_URL'] ?? null
let handle: Handle
let objstoreHandle: ObjstoreHandle
if (NEON_URL) {
  handle = await openNeonDb(NEON_URL)
  objstoreHandle = await openNeonObjstore(NEON_URL, OBJSTORE_DIR)
} else {
  const sqliteHandle = openDb(DB_PATH)
  handle = sqliteHandle
  objstoreHandle = openObjstore(sqliteHandle.db, OBJSTORE_DIR)
}

// Per-connection challenge nonce (round-9 H2). Issued in a
// `challenge` frame the moment the socket opens; the client signs
// it into every subsequent `workspace-subscribe`. Bound to the
// socket via WeakMap so a reconnecting client gets a fresh nonce
// and a captured subscribe frame can't be replayed from a
// different connection (the canonical bytes the captured signature
// covered include the OLD nonce; the attacker's new connection
// has a NEW nonce; the canonical bytes differ; signature verify
// fails). 16 bytes (128 bits) is enough for collision-free
// uniqueness; base64url so the wire stays JSON-text.
const socketChallenge = new WeakMap<WebSocket, string>()
function newChallenge(): string {
  return randomBytes(16).toString('base64url')
}

// workspaceTag → Set<WebSocket>
const subscribers = new Map<string, Set<WebSocket>>()
// WebSocket → Set<workspaceTag> — for cleanup on disconnect
const socketTags = new WeakMap<WebSocket, Set<string>>()

function subscribe(socket: WebSocket, tag: string): void {
  let set = subscribers.get(tag)
  if (!set) {
    set = new Set()
    subscribers.set(tag, set)
  }
  set.add(socket)
  let tags = socketTags.get(socket)
  if (!tags) {
    tags = new Set()
    socketTags.set(socket, tags)
  }
  tags.add(tag)
}

function unsubscribeAll(socket: WebSocket): void {
  const tags = socketTags.get(socket)
  if (!tags) return
  for (const tag of tags) {
    const set = subscribers.get(tag)
    if (!set) continue
    set.delete(socket)
    if (set.size === 0) subscribers.delete(tag)
  }
}

function send(socket: WebSocket, msg: object): void {
  sendRaw(socket, JSON.stringify(msg))
}

// Lower-level send for when the JSON payload is already serialised
// (e.g. broadcast fan-out — stringify once, send N times).
function sendRaw(socket: WebSocket, payload: string): void {
  if (socket.readyState !== socket.OPEN) return
  // Backpressure cap. `socket.bufferedAmount` is the count of bytes
  // queued in the `ws` send pipeline that haven't drained to the
  // kernel yet — a slow / blackholed peer accumulates them
  // unboundedly during fan-out broadcasts. Drop above the cap and
  // terminate the socket so the heartbeat doesn't keep it alive on
  // ping/pong while every broadcast piles up. Transport audit
  // `server/index.ts:225`.
  if (socket.bufferedAmount > MAX_BUFFERED_BYTES) {
    if (DEBUG) console.warn(`drop broadcast: socket buffered ${socket.bufferedAmount}B > cap`)
    try { socket.terminate() } catch {}
    return
  }
  // Wrap send() in try/catch — readyState can transition from OPEN
  // to CLOSING between the check above and the send() call (TOCTOU
  // window in `ws`'s event loop). Without this, a socket dying
  // mid-broadcast would throw and abort the broadcast loop, skipping
  // every subscriber after the dead one. Audit M4.
  try { socket.send(payload) } catch {}
}

// Truncate a base64url tag for `DEBUG=1` logging. Full workspaceTag
// is an Ed25519 public key; operator logs shouldn't carry it
// verbatim. Same convention as objstore/handlers.ts.
function debugTag(s: string): string { return `${s.slice(0, 12)}…` }

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

// `except: null` is the REST-originated path — byte transfer
// landed via HTTP, not via a particular WS socket; broadcast hits
// every subscriber. WS-originated broadcasts pass the originator's
// socket so the sender doesn't see its own message echoed back.
function broadcast(tag: string, msg: object, except: WebSocket | null): void {
  const set = subscribers.get(tag)
  if (!set) return
  // Stringify ONCE outside the fan-out loop. For a workspace-state
  // catch-up with a multi-MB ciphertext × N subscribers, per-recipient
  // JSON.stringify would dominate CPU; this is the cheap win.
  const payload = JSON.stringify(msg)
  // Snapshot before iterating — `send`'s try/catch swallows
  // socket.send errors, but a socket transitioning to CLOSED
  // mid-broadcast triggers `unsubscribeAll` from the 'close'
  // handler, which mutates `set` while we're walking it. Set
  // iteration is well-defined under same-key delete today; the
  // snapshot keeps a future refactor (e.g. switching to a
  // different collection or an async send) from silently
  // skipping subscribers. Audit M4 round-3.
  for (const s of [...set]) {
    if (s === except) continue
    sendRaw(s, payload)
  }
}

// Save-message field gate: base64-or-base64url alphabet, length-
// bounded. Critical guarantee is "no newlines" — without it,
// `nonce = "AAA\nBBB"` + `ciphertext = "CCC"` produces the same
// canonical bytes as `nonce = "AAA"` + `ciphertext = "BBB\nCCC"`
// (canonicalSave newline-joins), causing same-id collisions across
// distinct stored fields. Two alphabets:
//
//   - workspaceTag / signature / base — base64url-no-padding only.
//     Clients always emit these via `toBase64({ alphabet: 'base64url',
//     omitPadding: true })` (client/sync-crypto.ts), and the same
//     workspaceTag must round-trip through objstore's TAG_RE (also
//     base64url-no-padding) for cross-protocol consistency. Accepting
//     `+/=` here would let a buggy or hostile client split its data
//     across two encodings of the same workspace.
//   - nonce / ciphertext — base64 OR base64url (union alphabet).
//     Clients emit these via `toBase64()` with no alphabet hint
//     (standard base64 with `+/=` padding), and the bytes are opaque
//     to the server — no cross-protocol identity is bound to the
//     encoding. The newline-collision guard is the only invariant
//     here; the wider alphabet is acceptable.
//
// Short-field length caps bound the canonical and `MAX_CIPHERTEXT_LEN`
// bounds chain-bloat; the ciphertext size check runs post-sig so the
// error response (`workspace-save-error`) only reaches a legit signer.
const TAG_SIG_BASE_RE = /^[\w-]+$/u
const NONCE_CIPHER_RE = /^[\w+/=-]+$/u
const MAX_FIELD_LEN = 128
const MAX_CIPHERTEXT_LEN = 2 * 1024 * 1024

const validTagSigBase = (s: unknown, max: number): s is string => typeof s === 'string' && s.length > 0 && s.length <= max && TAG_SIG_BASE_RE.test(s)
const validNonce = (s: unknown, max: number): s is string => typeof s === 'string' && s.length > 0 && s.length <= max && NONCE_CIPHER_RE.test(s)
// Ciphertext: same alphabet as nonce but the size cap is checked
// POST-sig (to avoid leaking the cap to unauthenticated probes).
// Pre-sig only the shape gate applies; `maxPayload` (4 MiB) already
// bounds the total frame, so the worst-case bytes are still bounded.
const validCiphertextShape = (s: unknown): s is string => typeof s === 'string' && s.length > 0 && NONCE_CIPHER_RE.test(s)

const { handlers: objstore, restDeps: objstoreRestDeps, startupReap, stopReaper } = initObjstore({
  handle: objstoreHandle, reapIntervalMs: OBJSTORE_REAP_INTERVAL_MS,
  send, broadcast, getNonce: (socket) => socketChallenge.get(socket), debug: DEBUG,
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
    send(socket, { type: 'workspace-save-error', workspaceTag: tag, base: msg.base ?? null, reason: 'too-large' })
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
    send(socket, { type: 'workspace-save-error', workspaceTag: tag, base: baseNorm, reason: 'stale-base' })
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
  const nonce = socketChallenge.get(socket)
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

const httpServer = createServer((req: HttpRequest, res: ServerResponse) => {
  if (matchRoute(req.url) != null) {
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
      console.warn('REST handler error:', (err as Error)?.stack ?? err)
      if (res.headersSent) { try { res.destroy() } catch {} }
      else { try { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'internal' })) } catch {} }
    })
    track(p)
    return
  }
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
  // Issue a per-connection challenge nonce BEFORE the client can
  // send anything that needs it. The client signs this nonce into
  // every `workspace-subscribe` (see canonicalSubscribe in
  // server/sign.ts); a captured subscribe frame can't be replayed
  // from a different connection because that connection's nonce
  // is different and the signature won't verify against the new
  // canonical bytes. Audit round-9 H2.
  const nonce = newChallenge()
  socketChallenge.set(socket, nonce)
  send(socket, { type: 'challenge', nonce })
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
    const inflightForSocket = socketInflight.get(socket) ?? 0
    if (inflightForSocket >= MAX_INFLIGHT_PER_SOCKET) {
      if (DEBUG) console.warn(`drop message: socket inflight ${inflightForSocket} >= ${MAX_INFLIGHT_PER_SOCKET}`)
      // For workspace-save specifically, send a typed NACK so the
      // client's `pending` slot clears IMMEDIATELY instead of
      // hanging until the next heartbeat (~15–30s). Reason `busy`
      // is server-side overload; safe to retry. Same wire envelope
      // as the existing `too-large` save-error path.
      const baseField = typeof (parsed as SaveMsg).base === 'string' || (parsed as SaveMsg).base === null
        ? ((parsed as SaveMsg).base ?? null)
        : null
      const tagField = typeof (parsed as SaveMsg).workspaceTag === 'string'
        ? (parsed as SaveMsg).workspaceTag as string
        : null
      if (parsed.type === 'workspace-save' && tagField != null) {
        send(socket, { type: 'workspace-save-error', workspaceTag: tagField, base: baseField, reason: 'busy' })
      }
      return
    }
    socketInflight.set(socket, inflightForSocket + 1)
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
        console.warn(`Handler error (type=${typeStr}):`, (err as Error)?.stack ?? err)
      } finally {
        const n = (socketInflight.get(socket) ?? 1) - 1
        if (n <= 0) socketInflight.delete(socket)
        else socketInflight.set(socket, n)
      }
    })()
    track(handler)
  })
  socket.on('close', () => {
    unsubscribeAll(socket)
    // WeakMap entries clear via GC once the socket is unreachable,
    // but `wss.clients` (and the `ws` library's internals) hold the
    // socket strongly until well after `close` — explicit delete on
    // BOTH WeakMaps keeps the nonce + tag-set out of memory
    // immediately. Audit round-10 + round-13.
    socketChallenge.delete(socket)
    socketTags.delete(socket)
  })
  // Surface socket-level errors instead of swallowing — these are
  // the signals operators want under abuse / network flakiness
  // (TLS handshake failures, frame-decode errors, ws-protocol
  // violations). The previous `() => {}` left every per-connection
  // failure invisible. `close` fires after `error` and runs the
  // unsubscribe cleanup, so logging here doesn't risk leaking.
  socket.on('error', (err: Error) => { console.warn('Socket error:', err?.message ?? err) })
})

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
  // doesn't claim a misleading DB_PATH under Neon.
  const dbBanner = NEON_URL ? 'db: neon-postgres' : `db: ${DB_PATH}`
  console.log(`DeepView triage-sync server: ws://${HOST}:${boundPort}${WS_UPGRADE_PATH} http://${HOST}:${boundPort}/api/objstore/{workspaceTag}/{resourceTag} (${dbBanner}, objstore: ${OBJSTORE_DIR})`)
})

// Route bind / post-listen failures through `shutdown` so the
// in-flight handler drain + DB close still run before exit.
// Without this, `ws` re-emits the error as uncaughtException and
// the launcher sees a confusing crash rather than the bind
// failure. Audit round-9 M2.
httpServer.on('error', (err: Error) => {
  console.error('Server error:', err?.stack ?? err)
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
  console.error('WS server error:', err?.stack ?? err)
  fireShutdown(1)
})

// `.catch` defends against an unguarded `await` slipping into
// `shutdown` later: an unhandled rejection here would skip the
// non-zero exit the launcher relies on.
function fireShutdown(code: number): void {
  shutdown(code).catch((err) => {
    console.warn('shutdown error:', (err as Error)?.stack ?? err)
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
  // Drain in-flight handlers so a save that's mid-`await
  // verifySaveSigAndCanonical` finishes its insertRevision before
  // the DB closes. Without this, SIGINT during a save throws into
  // the connection-level catch (silent log) and the row is lost
  // even though the client may already have observed an ack from
  // a separate broadcast path. `Promise.allSettled` so a single
  // handler rejection doesn't abort the drain.
  if (inFlight.size > 0) await Promise.allSettled([...inFlight])
  // objstoreHandle has no `close()`:
  //  - SQLite: it shares the workspace_revision handle's
  //    `DatabaseSync`, which `handle.close()` below closes.
  //  - Neon: there's no persistent connection at all — `neon()`
  //    returns a stateless HTTP callable, and the SQLite-only
  //    `DatabaseSync` is the only thing that ever needs explicit
  //    shutdown. `handle.close()` below is itself a no-op on Neon.
  try { await handle.close() } catch (err) { console.warn('DB close error:', (err as Error)?.message ?? err) }
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
  console.error('Unhandled rejection:', (reason as Error)?.stack ?? reason)
  fireShutdown(1)
})
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err?.stack ?? err)
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
