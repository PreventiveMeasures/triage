#!/usr/bin/env node
// DeepView triage-sync relay server. WebSocket front-end, SQLite
// backing store. Implements the protocol described in
// `client/triage-sync.js` (and `server-e2e/sign.ts` for the canonical
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
import { errMsg, errStack } from './util.ts'
import type { PeerRegistry } from './peer.ts'
import { LOOPBACK_HOSTS, createOriginGate } from '../server-common/origin.ts'
import { createHub } from './hub.ts'
import { createAuth } from './auth.ts'
import { createSyncHandlers } from './sync-handlers.ts'
import { WS_UPGRADE_PATH, createHttpServer } from './http.ts'
import { installWsServer } from './ws-server.ts'
import { SSE_OPEN_PATH, installSseServer } from './sse-server.ts'
import type { ServerInfo } from '../common/server-info.ts'
import { createLifecycle } from './lifecycle.ts'
import { loadConfig } from './config.ts'
import { type Handle, openDb } from './db.ts'
import { openNeonDb } from './db-neon.ts'
import { initObjstore } from './objstore/init.ts'
import { type Handle as ObjstoreHandle, listLive, objectMetaWire, openObjstore } from './objstore/store.ts'
import { openNeonObjstore } from './objstore/store-neon.ts'
import { openVercelBlobBackend } from './objstore/blob-vercel.ts'
import {
  type NeonClientCtor, type PubSub,
  createNeonPubSub, createNoopPubSub,
} from './pubsub.ts'
import { createBusReceiver } from './bus-receiver.ts'

// All external inputs (env vars + optional config.json) are parsed
// and validated in ./config.ts; destructure into the uppercase names
// the rest of this module uses.
const config = loadConfig()
const {
  port: PORT, host: HOST, dbPath: DB_PATH, objstoreDir: OBJSTORE_DIR,
  reapIntervalMs: OBJSTORE_REAP_INTERVAL_MS, reapDisabled: OBJSTORE_REAP_DISABLED,
  maxInflightPerSocket: MAX_INFLIGHT_PER_SOCKET, debug: DEBUG,
  neonUrl: NEON_URL, blobToken: BLOB_TOKEN, tokenSecret: TOKEN_SECRET,
  password: CONFIG_PASSWORD, trustProxyEnv: TRUST_PROXY_ENV,
} = config

// Same-origin gate for the WS upgrade and REST data plane (see
// ./origin.ts). `TRUST_PROXY_ENV` also feeds the boot-time
// misconfiguration fail-fast below.
const { trustProxy: TRUST_PROXY, isOriginAllowed } = createOriginGate(HOST, TRUST_PROXY_ENV)

// Per-socket buffered-bytes cap. `socket.send` returns synchronously
// even when the kernel/ws library can't drain to the wire fast
// enough; the unsent payload accumulates in `bufferedAmount`. A
// slow / blackholed peer on a high-volume workspace can hold many
// MB of fan-out broadcasts in this buffer with no backpressure on
// the broadcast loop. Drop the message when the buffer crosses the
// cap; the heartbeat will eventually close a peer that never
// drains. Transport audit `server-e2e/index.ts:225`.
const MAX_BUFFERED_BYTES = 16 * 1024 * 1024
// Per-socket in-flight async-handler cap (MAX_INFLIGHT_PER_SOCKET,
// env-validated in config). Each inbound text frame spawns a
// `track(handler)` IIFE; an authorised peer firing valid frames could
// otherwise grow the set without bound, stretching SIGTERM drain time.
// Saves dropped at the cap surface as a typed `busy` NACK. Transport
// audit `server-e2e/index.ts:590`.

// Per-connection state registry. One `Peer` per accepted socket holds
// the challenge nonce, auth flag, heartbeat liveness, in-flight count,
// and subscribed tags (see ./peer.ts). The connection handler holds
// the Peer in a closure for the hot paths; cross-function call sites
// resolve it via `peers.get(socket)`.
const peers: PeerRegistry = new WeakMap()

// REST PUT idle-body timeout. A slow-loris client trickling bytes
// within the declared Content-Length holds the staging fd and an
// inFlightSids slot until the global staging TTL reaps it. Aborting
// the per-chunk-idle period closes that window. Transport audit
// `server-e2e/objstore/rest.ts:218`.
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
// v1.objstore byte store) are picked from config at boot. Two
// supported pairings:
//   1. DATABASE_URL set → Neon (workspace_revision + objstore
//      tables) + Vercel Blob Private Storage (bytes). Requires
//      BLOB_READ_WRITE_TOKEN — fail fast at boot if missing, since
//      a local-FS byte plane can't back a multi-replica deployment
//      (one replica's writes wouldn't be visible to another).
//   2. DATABASE_URL absent → SQLite + local FS bytes. Single-
//      process; the only pairing the SQLite plane supports.
// The Neon / Vercel files import their peer deps lazily inside the
// open functions, so static imports here are safe even on a SQLite-
// only install where the optional peer deps aren't present. Explicit
// branch (not a ternary) so the SQLite path keeps its `SqliteHandle`
// narrowing — `sqliteHandle.db` is a non-optional `DatabaseSync` that
// `openObjstore` accepts without a non-null assertion.
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
// broadcast (see ./hub.ts).
const hub = createHub({ peers, maxBufferedBytes: MAX_BUFFERED_BYTES, debug: DEBUG })
const { send, broadcast, subscribe, unsubscribeAll, broadcastLocalRaw } = hub

// Cross-instance pub/sub for live broadcasts (see ./pubsub.ts). SQLite
// mode is single-process by construction so it gets a no-op; Neon mode
// uses Postgres LISTEN/NOTIFY on a dedicated long-lived Client
// connection (separate from the HTTP `neon()` callable the queries flow
// over — LISTEN needs a session-bound socket, the HTTP path is
// stateless). The bus carries lookup hints, not the full wire payload:
// the `workspace-state` broadcast's ciphertext alone can exceed the
// ~8 KB NOTIFY payload cap, so the receiver re-fetches from the shared
// DB to construct the wire frame. The bus is best-effort fan-out, not a
// durability layer — the DB itself is the source of truth, and a
// dropped publish only means peers on other instances miss the live
// push (they still catch up via the chain on their next subscribe).
let pubsub: PubSub = createNoopPubSub()
if (NEON_URL) {
  // Dynamic import: the Client export lives in the same optional peer
  // dep as the HTTP `neon()` callable (see ./neon-driver.ts), but the
  // dep itself is only present on a Neon-mode deploy. The wrapper path
  // also lets tests swap in a PGlite-backed shim (`tests/pubsub.test.js`).
  const mod = (await import('./neon-driver.ts')) as unknown as { Client?: NeonClientCtor }
  if (!mod.Client) {
    console.error('DATABASE_URL is set but the @neondatabase/serverless Client export is not available.')
    console.error('Cross-instance broadcasts require the WebSocket-based Client (the HTTP `neon()` callable cannot LISTEN).')
    console.error('Reinstall the peer dep: pnpm add @neondatabase/serverless')
    process.exit(1)
  }
  const NeonClientImpl = mod.Client
  pubsub = createNeonPubSub({
    newClient: () => new NeonClientImpl(NEON_URL),
    debug: DEBUG,
  })
}

// Password gate (see ./auth.ts) — HMAC derivation + the `authenticate`
// handshake.
const auth = createAuth({ peers, password: CONFIG_PASSWORD, send, debug: DEBUG })
const { requiresAuth, passwordConfigured, handleAuthenticate, sendUnauthorized } = auth

// Triage-sync protocol handlers (see ./sync-handlers.ts). `getNonce`
// resolves a socket's challenge nonce and is shared with the objstore
// wiring below; `sendSaveError` is reused by the dispatcher's `busy`
// inflight-cap NACK path.
const getNonce = (socket: WebSocket): string | undefined => peers.get(socket)?.challenge
const publishRevision = (tag: string, revisionId: string): void => {
  pubsub.publish({ kind: 'rev', tag, id: revisionId })
}
const publishObjPut = (tag: string, resourceTag: string): void => {
  pubsub.publish({ kind: 'objput', tag, res: resourceTag })
}
const publishObjDeleted = (tag: string, resourceTag: string, version: number): void => {
  pubsub.publish({ kind: 'objdel', tag, res: resourceTag, ver: version })
}

const { handleSave, handleSaveRest, handleSubscribe, sendSaveError } = createSyncHandlers({
  handle, send, broadcast, publishRevision, subscribe, getNonce,
  requiresAuth, passwordConfigured, sendUnauthorized, workspaceExists,
  // Folds the objstore inventory into the `workspace-subscribed` ack.
  // The objstore store keeps its own richer `Handle`, so we wire the
  // query here where both handles exist rather than coupling
  // sync-handlers to the store type.
  objstoreResources: async (tag) => (await listLive(objstoreHandle, tag)).map(objectMetaWire),
  debug: DEBUG,
})

const { handlers: objstore, restDeps: objstoreRestDeps, startupReap, stopReaper } = initObjstore({
  handle: objstoreHandle, reapIntervalMs: OBJSTORE_REAP_INTERVAL_MS,
  reapDisabled: OBJSTORE_REAP_DISABLED,
  send, broadcast, publishObjPut, publishObjDeleted,
  getNonce, debug: DEBUG,
  // Auth gate for the FIRST objstore-put-begin against a workspace
  // that doesn't yet exist on the server. Mirrors handleSave's gate
  // below; handlers.ts calls this AFTER sig verify so the
  // `unauthorized` frame only reaches a legitimate signer. Returns
  // `false` to allow, `true` to deny — handlers.ts emits the
  // `unauthorized` frame and bails on `true`.
  authGate: async (socket, tag) => requiresAuth(socket) && !await workspaceExists(tag),
  sendUnauthorized,
  // Socket-less analog of `authGate` for the REST put-begin mint: a REST
  // request can never be operator-authorized, so the gate collapses to
  // "password configured AND workspace new". A deny routes the client to
  // its in-band WS put-begin fallback.
  restPutGate: async (tag) => passwordConfigured && !await workspaceExists(tag),
  // `tokenSecret` is set only when OBJSTORE_TOKEN_SECRET was
  // provided in env (see TOKEN_SECRET resolution above). Omitted
  // → initObjstore mints a fresh per-process secret (fine for
  // single-replica).
  ...(TOKEN_SECRET ? { tokenSecret: TOKEN_SECRET } : {}),
})

// 4 MiB cap leaves headroom above MAX_CIPHERTEXT_LEN (2 MiB) for
// the JSON envelope + base64 overhead. `ws` defaults to 100 MiB
// which any unauthenticated peer could spam — every connection
// accepts and JSON.parses up to that before the signature-fail drops
// the frame.
const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 })

// Process lifecycle (see ./lifecycle.ts): `track` (in-flight request
// drain) and `isShuttingDown` (the new-work gate) are consumed by the
// HTTP + WS planes below; the teardown is `installLifecycle`d once
// every server object exists.
const { track, isShuttingDown, install: installLifecycle } = createLifecycle()

// The sync protocol this build advertises — emitted as a `server-info` frame
// right after the challenge on every connection. This is the e2e boot, so it
// always advertises e2e.
const SERVER_INFO: ServerInfo = { mode: 'e2e', managed: null }

// Shared per-connection dispatch surface. Both the WS plane
// (installWsServer below) and the SSE+POST fallback (installSseServer
// below) drive `setupPeerConnection` with this; one Peer per accepted
// connection, one message-handler tree.
const peerConnectionDeps = {
  peers, serverInfo: SERVER_INFO, send, unsubscribeAll,
  handleSave, handleSubscribe, handleAuthenticate, sendSaveError, objstore,
  track, isShuttingDown,
  maxInflightPerSocket: MAX_INFLIGHT_PER_SOCKET,
  debug: DEBUG,
}

// SSE+POST fallback transport (see ./sse-server.ts). The WS upgrade is
// the preferred path; clients fall back to SSE when `new WebSocket(…)`
// fails to open (corporate proxies that strip the Upgrade header,
// hostile network middleboxes, etc.). Same protocol on the wire — only
// the byte transport differs.
const sseServer = installSseServer({
  peerDeps: peerConnectionDeps, isShuttingDown,
  // Same cap shape as `wss` (no explicit per-process cap; OS FD limits
  // are the upstream bound). 1024 leaves room above the typical web
  // session count without being a soft DoS hammer.
  maxSessions: 1024,
  // Mirror the WS `maxPayload` so the SSE plane can't accept frames
  // the WS plane would reject.
  maxBodyBytes: 4 * 1024 * 1024,
  debug: DEBUG,
})

// HTTP plane: REST byte-transfer routing + SSE fallback + the WS
// upgrade gate (see ./http.ts). Built after the lifecycle state above
// because the REST shutdown gate reads `shuttingDown` and the request
// drain uses `track`. The WS connection handler is wired on `wss`
// below.
const httpServer = createHttpServer({
  wss, restDeps: objstoreRestDeps, sseServer, isOriginAllowed,
  isShuttingDown, track, handleSaveRest,
  restPutIdleTimeoutMs: REST_PUT_IDLE_TIMEOUT_MS, debug: DEBUG,
})

// WS runtime: per-connection handler + message dispatch + heartbeat
// sweep (see ./ws-server.ts). Returns the heartbeat timer so shutdown
// can clear it.
const { heartbeatTimer } = installWsServer({
  wss, heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
  ...peerConnectionDeps,
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
  // doesn't claim a misleading DB_PATH under Neon, or a misleading
  // OBJSTORE_DIR under Vercel Blob.
  const dbBanner = NEON_URL ? 'db: neon-postgres' : `db: ${DB_PATH}`
  console.log(`DeepView triage-sync server: ws://${HOST}:${boundPort}${WS_UPGRADE_PATH} (sse fallback http://${HOST}:${boundPort}${SSE_OPEN_PATH}) http://${HOST}:${boundPort}/api/objstore/{workspaceTag}/{resourceTag} (${dbBanner}, ${objstoreBanner})`)
})

// Cross-instance bus receiver (see ./bus-receiver.ts): a remote NOTIFY
// lands here, we re-fetch any data the bus payload only hinted at,
// then broadcast to local peers via `broadcastLocalRaw`. Extracted so
// the rev / objput / objdel mapping (including the keyframe boolean
// coercion and the `objectMetaWire` shape) is testable without the
// full server bring-up.
const onBusMessage = createBusReceiver({
  handle, objstoreHandle, broadcastLocalRaw, debug: DEBUG,
})

// Kick off the LISTEN loop in the background. `pubsub.start` resolves
// only after the FIRST successful connect, and the internal reconnect
// loop retries indefinitely on transport / LISTEN failure — awaiting
// it here would convert a transient Neon WS hiccup at boot into a
// server that never binds (and a `.catch` that never runs). Instead
// the server binds immediately and the bus comes up async; publishes
// during the down window drop silently (best-effort semantics
// documented in pubsub.ts). The SQLite no-op resolves immediately,
// so the behaviour is identical in that mode.
void pubsub.start(onBusMessage).catch((err) => {
  console.warn('pubsub: startup error:', errStack(err))
})

// App-specific shutdown step (run after the in-flight drain), wired
// into the lifecycle teardown below.
const closeDb = async (): Promise<void> => {
  // Stop the bus first so a publish from a still-draining handler
  // can't fire into a half-closed Client. The in-flight drain runs
  // before this (see lifecycle.ts), so by here all `broadcast` →
  // `publish*` calls are settled.
  try { await pubsub.stop() } catch (err) { console.warn('pubsub close error:', errMsg(err)) }
  // objstoreHandle has no close(): SQLite shares this DatabaseSync and
  // Neon has no persistent connection; `handle.close()` covers both.
  try { await handle.close() } catch (err) { console.warn('DB close error:', errMsg(err)) }
}
// Wire graceful shutdown + the signal / error / process-catchall
// handlers (see ./lifecycle.ts). Installed last, once httpServer, wss,
// and the heartbeat timer all exist.
installLifecycle({
  httpServer, wss, heartbeatTimer, stopReaper,
  sseSessions: sseServer.sessions,
  sseKeepaliveTimer: sseServer.keepaliveTimer,
  closeDb,
})

// Bind only after the startup orphan sweep finishes — otherwise a
// fresh boot could serve traffic against tags whose on-disk state
// still has residue from a prior crash. `startupReap` already
// resolves on any error (the reaper's own catch logs the failure
// unconditionally and returns void), so no outer `.catch` is
// needed here.
await startupReap

// Bind the HTTP/WS plane on the configured PORT/HOST. Exported so a
// launcher (server-e2e/cli.js — the triage-server bin) or any `import`er can
// start serving. The top-level `await startupReap` above means the server
// is fully ready — DB open, DDL bootstrapped, objstore reaper swept — by
// the time the import resolves.
export function start(): void {
  httpServer.listen(PORT, HOST)
}

export { httpServer, wss }

// Library mode: when this module is `import`ed (rather than run as the
// entry script) skip the auto-start so consumers can own the bind — e.g.
// wrap CF Access / framework-preset shims around the assembled
// `httpServer`, or just call `start()` when ready. Direct invocation via
// `node server-e2e/index.ts` (or the `triage-server` bin) still listens.
if (import.meta.main) {
  start()
}

