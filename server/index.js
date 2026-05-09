// DeepView triage-sync relay server. WebSocket front-end, SQLite
// backing store. Implements the protocol described in
// `client/triage-sync.js` (and `server/sign.js` for the canonical
// signature payloads):
//
//   client → server  workspace-save      { workspaceTag, base,
//                                          nonce, ciphertext, signature }
//   client → server  workspace-subscribe { workspaceTag, signature }
//   server → client  workspace-save-ack  { workspaceTag, base, id }
//   server → client  workspace-state     { workspaceTag, revisions:
//                                          [{ base, id, nonce,
//                                             ciphertext, signature }, ...] }
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
// A socket joins the set when it sends any signed message for the
// tag (save or subscribe). It leaves on disconnect. Broadcasts go
// to every subscriber for the workspaceTag except the originator.

import { WebSocketServer } from 'ws'
import { argv, env } from 'node:process'
import { fileURLToPath } from 'node:url'
import { decodeUtf8 } from '../common/utf8.js'
import { chainFrom, headFor, insertRevision, openDb, revisionExists } from './db.js'
import { computeRevisionIdFromCanonical, verifySaveSigAndCanonical, verifySubscribeSig } from './sign.js'

const PORT = Number(env.PORT ?? 8765)
const HOST = env.HOST ?? '127.0.0.1'
// Fail fast on a malformed PORT — `Number("abc")` is NaN, and
// `WebSocketServer({ port: NaN })` throws deep inside `node:net`
// with a confusing trace. A clear up-front error lets the operator
// fix the env var without trawling the stack.
if (!Number.isInteger(PORT) || PORT < 0 || PORT > 65535) {
  console.error(`Invalid PORT: ${env.PORT}`)
  process.exit(1)
}
// `fileURLToPath` decodes percent-escapes and handles non-ASCII path
// segments correctly (the older `new URL(...).pathname` form left
// `%20` etc. raw, breaking deploys under paths like `/srv/deep view/`).
const DB_PATH = env.DB_PATH ?? fileURLToPath(new URL('./data.db', import.meta.url))
const DEBUG = env.DEBUG === '1'

if (argv.includes('--help') || argv.includes('-h')) {
  console.log(`Usage: node server/index.js
Environment:
  PORT     listen port (default 8765)
  HOST     bind host (default 127.0.0.1)
  DB_PATH  sqlite file (default server/data.db)
  DEBUG=1  log every message`)
  process.exit(0)
}

const handle = openDb(DB_PATH)

// workspaceTag → Set<WebSocket>
const subscribers = new Map()
// WebSocket → Set<workspaceTag> — for cleanup on disconnect
const socketTags = new WeakMap()

function subscribe(socket, tag) {
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

function unsubscribeAll(socket) {
  const tags = socketTags.get(socket)
  if (!tags) return
  for (const tag of tags) {
    const set = subscribers.get(tag)
    if (!set) continue
    set.delete(socket)
    if (set.size === 0) subscribers.delete(tag)
  }
}

function send(socket, msg) {
  if (socket.readyState !== socket.OPEN) return
  // Wrap send() in try/catch — readyState can transition from OPEN
  // to CLOSING between the check above and the send() call (TOCTOU
  // window in `ws`'s event loop). Without this, a socket dying
  // mid-broadcast would throw and abort the broadcast loop, skipping
  // every subscriber after the dead one. Audit M4.
  try { socket.send(JSON.stringify(msg)) } catch {}
}

// Normalise `keyframe` on outbound chain entries to a strict boolean.
// SQLite stores the column as INTEGER (0/1) and `chainFrom` returns
// raw rows; the wire contract (and the canonical signing payload)
// uses strict `=== true` to mark keyframes. Forwarding the integer
// shape works only because every shipping client coerces via
// `Boolean(rev.keyframe)` before reconstructing the canonical
// bytes — fragile if a future client (or test harness) ever
// strict-compares. Convert once on the send side.
function chainForWire(revisions) {
  return revisions.map((r) => ({ ...r, keyframe: r.keyframe === 1 || r.keyframe === true }))
}

function broadcast(tag, msg, except) {
  const set = subscribers.get(tag)
  if (!set) return
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
    send(s, msg)
  }
}

async function handleSave(socket, msg) {
  if (typeof msg.workspaceTag !== 'string') return
  if (typeof msg.nonce !== 'string') return
  if (typeof msg.ciphertext !== 'string') return
  // `base` is `string | null` per the wire contract. The signed
  // canonical path coerces with `String(base)` while the storage /
  // head-comparison paths use the raw value — a non-string non-null
  // value from a legit signer would canonicalise to one shape (e.g.
  // `'[object Object]'`) but fail the SQLite STRICT TEXT insert,
  // throwing inside `insertRevision` after the signature check
  // succeeded. Reject at the wire gate so the symptom is "save
  // dropped silently" rather than a swallowed handler exception.
  if (msg.base != null && typeof msg.base !== 'string') return
  // Verify the signature AND capture the canonical bytes in one
  // pass — the revision id (below) hashes the EXACT bytes the
  // signature covered, so the stored id is provably tied to the
  // signed content. The previous shape recomputed canonical bytes
  // independently from `computeRevisionId`, leaving room for a
  // future divergence to drift the stored id away from the signed
  // payload.
  const { ok, canonical } = await verifySaveSigAndCanonical(msg)
  if (!ok) {
    if (DEBUG) console.warn('reject save: bad signature', msg.workspaceTag.slice(0, 12) + '…')
    return
  }
  const id = await computeRevisionIdFromCanonical(canonical)
  const tag = msg.workspaceTag
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
  // Idempotent retransmit: a save with the same content (same id)
  // arriving more than once gets a fresh ack but doesn't grow the
  // chain. Useful when a client times out mid-ack and re-sends.
  if (revisionExists(handle, tag, id)) {
    if (DEBUG) console.log(`save (duplicate id ${id.slice(0, 8)}…) → ack-only`)
    send(socket, { type: 'workspace-save-ack', workspaceTag: tag, base: msg.base ?? null, id })
    return
  }
  const head = headFor(handle, tag)
  const baseNorm = msg.base ?? null
  const matches = baseNorm == null ? head == null : baseNorm === head
  if (!matches) {
    // Stale base — send catch-up chain. Client rebases and
    // retries with the fresh head.
    const revisions = chainForWire(chainFrom(handle, tag, baseNorm))
    if (DEBUG) console.log(`save (stale base ${baseNorm} vs head ${head}) → chain ${revisions.length}`)
    send(socket, { type: 'workspace-state', workspaceTag: tag, revisions })
    return
  }
  // `keyframe` is part of the signed canonical bytes —
  // `verifySaveSigAndCanonical` already rejected anything where the
  // wire flag didn't match what the client signed (the canonical
  // payload uses `=== true` strict-equality, see sign.js's
  // `canonicalSave`), so a `true` here means the signer intended a
  // keyframe.
  const keyframe = msg.keyframe === true
  insertRevision(handle, {
    tag,
    id,
    base: baseNorm,
    keyframe,
    nonce: msg.nonce,
    ciphertext: msg.ciphertext,
    signature: msg.signature,
  })
  if (DEBUG) console.log(`save${keyframe ? ' [keyframe]' : ''} → revision ${id.slice(0, 8)}… for ${tag.slice(0, 12)}…`)
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

async function handleSubscribe(socket, msg) {
  if (typeof msg.workspaceTag !== 'string') return
  // Same `string | null` contract as `base` in handleSave. The
  // signed canonical uses `String(from)`, but the chain-lookup path
  // (`typeof msg.from === 'string' ? msg.from : null`) treats every
  // non-string as null — so a legit signer sending `from: { … }`
  // would silently take the keyframe-fallback path even though the
  // signature was over a different canonical shape. Reject at the
  // wire gate.
  if (msg.from != null && typeof msg.from !== 'string') return
  const ok = await verifySubscribeSig(msg)
  if (!ok) {
    if (DEBUG) console.warn('reject subscribe: bad signature', msg.workspaceTag.slice(0, 12) + '…')
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
  const revisions = chainForWire(chainFrom(handle, tag, fromId))
  if (DEBUG) console.log(`subscribe ${tag.slice(0, 12)}… from=${fromId?.slice(0, 8) ?? 'null'} → chain ${revisions.length}`)
  send(socket, { type: 'workspace-state', workspaceTag: tag, revisions })
}

const wss = new WebSocketServer({ port: PORT, host: HOST })

// In-flight async message handlers. `shutdown` awaits this set
// before closing the DB so a SIGINT mid-save can't resume against
// a closed handle (which would throw inside `insertRevision` after
// the client believed its save was committed).
const inFlight = new Set()
function track(promise) {
  inFlight.add(promise)
  promise.finally(() => inFlight.delete(promise))
}

// Hoisted above the connection handler so the message-loop's
// `if (shuttingDown) return` reads from a defined binding even if
// the closure runs in the same tick the variable is declared.
let shuttingDown = false

wss.on('connection', (socket, req) => {
  if (DEBUG) console.log(`connect from ${req.socket.remoteAddress}`)
  socket.on('message', (data, isBinary) => {
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
    let msg
    try {
      // `decodeUtf8` is fatal on invalid UTF-8 (vs `Buffer.toString`
      // which silently substitutes U+FFFD). The substitution path
      // would let mangled bytes pass JSON.parse only to fail
      // signature verification deeper in the handler — wasted work
      // and noisier logs. Fail at the gate.
      msg = JSON.parse(decodeUtf8(data))
    } catch { return }
    if (!msg || typeof msg !== 'object') return
    const handler = (async () => {
      try {
        if (msg.type === 'workspace-save') await handleSave(socket, msg)
        else if (msg.type === 'workspace-subscribe') await handleSubscribe(socket, msg)
        // Heartbeat — application-level alive check the browser
        // WebSocket API doesn't expose at protocol level. Stateless,
        // unauthenticated; the security-critical paths (save /
        // subscribe) still verify signatures.
        else if (msg.type === 'ping') send(socket, { type: 'pong' })
      } catch (err) {
        console.warn('Handler error:', err)
      }
    })()
    track(handler)
  })
  socket.on('close', () => unsubscribeAll(socket))
  // Surface socket-level errors instead of swallowing — these are
  // the signals operators want under abuse / network flakiness
  // (TLS handshake failures, frame-decode errors, ws-protocol
  // violations). The previous `() => {}` left every per-connection
  // failure invisible. `close` fires after `error` and runs the
  // unsubscribe cleanup, so logging here doesn't risk leaking.
  socket.on('error', (err) => { console.warn('Socket error:', err.message ?? err) })
})

wss.on('listening', () => {
  console.log(`DeepView triage-sync server: ws://${HOST}:${PORT} (db: ${DB_PATH})`)
})

// Surface server-level errors (EADDRINUSE on bind, EACCES, the rare
// post-listen socket fault). Without this handler `ws` re-emits the
// underlying error as an uncaughtException, which the launcher sees
// as a confusing crash rather than "this port was taken." Exit
// cleanly on bind failure so systemd / docker can apply its retry
// policy; for post-listen errors there's no clean way to recover, so
// crash too.
// Route through `shutdown()` rather than calling `process.exit(1)`
// directly: the previous shape skipped the in-flight handler drain
// and the DB close, so a non-bind error after listen could lose
// already-acked WAL frames. shutdown() is re-entrancy-safe and
// exits with code 1 when invoked from this path so systemd /
// docker still see a failure exit. Audit round-9 M2.
wss.on('error', (err) => {
  console.error('Server error:', err?.message ?? err)
  shutdown(1)
})

async function shutdown(exitCode = 0) {
  if (shuttingDown) return
  shuttingDown = true
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
  // Stop accepting new connections; existing sockets stay open
  // until their close handlers run (driven by the 1001 frames above).
  await new Promise((resolve) => { wss.close(() => resolve()) })
  // Drain in-flight handlers so a save that's mid-`await
  // verifySaveSigAndCanonical` finishes its insertRevision before
  // the DB closes. Without this, SIGINT during a save throws into
  // the connection-level catch (silent log) and the row is lost
  // even though the client may already have observed an ack from
  // a separate broadcast path. `Promise.allSettled` so a single
  // handler rejection doesn't abort the drain.
  if (inFlight.size > 0) await Promise.allSettled([...inFlight])
  try { handle.close() } catch (err) { console.warn('DB close error:', err.message ?? err) }
  process.exit(exitCode)
}
// Wrap signal handlers so the signal name (passed as the listener's
// first arg) doesn't bleed into shutdown's `exitCode` parameter and
// trip `process.exit` into rejecting a non-numeric code.
process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))
