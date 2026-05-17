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
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { argv, env } from 'node:process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { decodeUtf8 } from '../common/utf8.js'
import { SAVE_ERROR_REASONS, type SaveErrorReason } from '../common/save-error-reason.ts'
import { type Handle, type RevisionRow, chainFrom, commitRevision, openDb, revisionExists } from './db.ts'
import { openNeonDb } from './db-neon.ts'
import { type SaveMsg, type SubscribeMsg, canonicalSave, computeRevisionIdFromCanonical, verifyEd25519, verifySubscribeSig } from './sign.ts'
import { handleRest, matchRoute } from './objstore/rest.ts'
import { initObjstore } from './objstore/init.ts'
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
// Distributed commit-lock lease duration. The default (5 min) is
// tuned for Vercel Functions' Pro Max execution cap; self-hosted
// long-running processes with multi-MB uploads on slow links may
// bump this. A crashed-held lease without graceful release pins
// the key for at most this long. Setter passes via opts.leaseMs
// to withCommitLock at every call site.
// Range-clamped: too short → the lock effectively doesn't exist
// (every concurrent caller steals instantly). Too long → a SIGKILL/
// OOM-crashed holder pins the key for hours/days waiting on TTL
// expiry. 1 second–1 hour is the operationally-sensible band.
const OBJSTORE_COMMIT_LOCK_LEASE_MS = Number(env['OBJSTORE_COMMIT_LOCK_LEASE_MS'] ?? 5 * 60 * 1000)
const LEASE_MS_MIN = 1000
const LEASE_MS_MAX = 60 * 60 * 1000
if (!Number.isSafeInteger(OBJSTORE_COMMIT_LOCK_LEASE_MS) || OBJSTORE_COMMIT_LOCK_LEASE_MS < LEASE_MS_MIN || OBJSTORE_COMMIT_LOCK_LEASE_MS > LEASE_MS_MAX) {
  console.error(`Invalid OBJSTORE_COMMIT_LOCK_LEASE_MS: ${env['OBJSTORE_COMMIT_LOCK_LEASE_MS']}`)
  console.error(`Must be an integer in [${LEASE_MS_MIN}, ${LEASE_MS_MAX}] (1s..1h). Default is 300000 (5 min).`)
  process.exit(1)
}
setDefaultLeaseMs(OBJSTORE_COMMIT_LOCK_LEASE_MS)
const DEBUG = env['DEBUG'] === '1'

// Optional operator-side config file. Read once at boot; absence is
// silently fine (preserves the no-auth default — fresh installs and
// existing deployments without config.json keep working as before).
// Parse errors fail loud at startup so a typo doesn't silently fall
// back to "no auth required". `config.example.json` ships with the
// repo as the documented shape; the real `config.json` is git-
// ignored so operators can store secrets locally.
const CONFIG_PATH = env['CONFIG_PATH'] ?? fileURLToPath(new URL('./config.json', import.meta.url))
type ServerConfig = { password?: string | null }
function loadConfig(path: string): ServerConfig {
  let raw: string
  try { raw = readFileSync(path, 'utf8') } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return {}
    console.error(`Failed to read ${path}:`, (err as Error)?.message ?? err); process.exit(1)
  }
  try { return JSON.parse(raw) as ServerConfig }
  catch (err) {
    console.error(`Failed to parse ${path} as JSON:`, (err as Error)?.message ?? err); process.exit(1)
  }
}
const SERVER_CONFIG = loadConfig(CONFIG_PATH)
// Password is the only auth method today. A non-empty string in
// config gates first-action (workspace creation) on the wire-level
// `authenticate { password }` handshake; null / undefined / empty
// disables the gate (the no-config default — first action is
// allowed without an authenticate handshake).
//
// Comparison is HMAC-SHA-256 under a per-process random key:
//   * at boot, generate `PASSWORD_HMAC_KEY` (32 random bytes,
//     static for the process lifetime, never persisted, never
//     leaves this module);
//   * compute `CONFIGURED_PASSWORD_HMAC = HMAC(key, configured)`
//     once at boot and discard the raw configured-password bytes
//     so a heap snapshot post-boot doesn't expose the plaintext;
//   * on each `authenticate`, compute the same HMAC over the
//     submitted password and compare with `timingSafeEqual`.
// HMAC outputs are fixed at 32 bytes so `timingSafeEqual` runs
// without a length-equal precondition (no length leak), and even
// a hypothetical timing leak only exposes HMAC bytes — useless to
// an attacker without the per-process key. A `null`
// `CONFIGURED_PASSWORD_HMAC` is the "no gate" sentinel that every
// other check reads.
const PASSWORD_HMAC_KEY: Uint8Array<ArrayBuffer> = new Uint8Array(randomBytes(32))
const CONFIGURED_PASSWORD_HMAC: Uint8Array<ArrayBuffer> | null = (() => {
  const p = SERVER_CONFIG.password
  if (p == null || p === '') return null
  if (typeof p !== 'string') {
    console.error(`Invalid ${CONFIG_PATH}: "password" must be a string or null`); process.exit(1)
  }
  return new Uint8Array(createHmac('sha256', PASSWORD_HMAC_KEY).update(p, 'utf8').digest())
})()

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
//
// Env-configurable via `MAX_INFLIGHT_PER_SOCKET` for tests that
// want to deterministically exercise the cap (`busy` NACK
// regression) without needing 65 signed sends. Default 64.
const MAX_INFLIGHT_PER_SOCKET = (() => {
  const raw = env['MAX_INFLIGHT_PER_SOCKET']
  if (raw == null) return 64
  const n = Number(raw)
  // Upper bound = 65_536. The cap's point is to bound memory under
  // hostile load; a deployer passing `MAX_SAFE_INTEGER` would silently
  // defeat the purpose. 65_536 is way above any realistic legitimate
  // value (default is 64) but cheap to enforce. Adversarial-audit
  // foot-gun guard.
  if (!Number.isSafeInteger(n) || n < 1 || n > 65_536) {
    console.error(`Invalid MAX_INFLIGHT_PER_SOCKET: ${raw} (must be integer 1..65536)`); process.exit(1)
  }
  return n
})()
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
                             @neondatabase/serverless. The Neon
                             pairing additionally requires
                             BLOB_READ_WRITE_TOKEN (Vercel Blob
                             Private Storage) for the byte plane —
                             local-FS bytes cannot back a multi-
                             replica DB plane.
  BLOB_READ_WRITE_TOKEN      Vercel Blob R/W token (private store).
                             Required when DATABASE_URL is set;
                             ignored otherwise. Requires the optional
                             peer dep @vercel/blob.
  OBJSTORE_TOKEN_SECRET      Base64 (32 bytes) HMAC secret for REST
                             bearer tokens. REQUIRED when DATABASE_URL
                             is set (multi-replica deployments: a
                             token minted on one replica's WS plane
                             must validate on another replica's REST
                             plane). Optional under SQLite (a fresh
                             per-process secret is minted at boot).
                             Generate one with:
                               node -e 'console.log(crypto.randomBytes(32).toString("base64"))'
  OBJSTORE_DIR               object store root (default: ./objstore
                             next to DB_PATH). Used by the local-FS
                             byte plane only; ignored when
                             DATABASE_URL + BLOB_READ_WRITE_TOKEN
                             are set (bytes live in Vercel Blob).
  OBJSTORE_REAP_INTERVAL_MS  orphan reaper period (default 600000)
  OBJSTORE_COMMIT_LOCK_LEASE_MS
                             distributed commit-lock lease duration
                             (default 300000 = 5 min). A crashed-held
                             lease pins (workspace_tag, resource_tag)
                             for at most this long. Bump for self-
                             hosted deployments where uploads can
                             legitimately exceed 5 min (e.g. 100 MiB
                             on a 100 KB/s link).
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
  MAX_INFLIGHT_PER_SOCKET    per-socket in-flight async-handler
                             cap; saves dropped past this fire a
                             typed 'busy' workspace-save-error
                             NACK. Default 64. Lower for tests
                             that need to deterministically
                             exercise the cap.
  CONFIG_PATH                operator config JSON path (default:
                             server/config.json). Currently the
                             only field is { "password": "..." }
                             which gates first-action creation of
                             a new workspace on the
                             authenticate { password } handshake.
                             Missing file / null password →
                             no gating (default).
  DEBUG=1                    log every message`)
  process.exit(0)
}

// Backend selection. Both planes (workspace_revision DB + the
// v1.objstore byte store) are picked from env at boot. Two supported
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
const NEON_URL = env['DATABASE_URL'] ?? null
const BLOB_TOKEN = env['BLOB_READ_WRITE_TOKEN'] ?? null
const TOKEN_SECRET_B64 = env['OBJSTORE_TOKEN_SECRET'] ?? null
// Decode + length-check the HMAC secret upfront so a misconfigured
// secret fails at boot, not at the first token verification. 32
// bytes matches `newTokenSecret()` and HMAC-SHA-256's block/output
// size.
//
// `Buffer.from(s, 'base64')` does NOT throw on invalid input — it
// silently strips non-alphabet characters, so a typo like `+→-`
// (base64url char in a base64 string) decodes to a DIFFERENT secret
// without warning. Detect this by re-encoding and comparing — a
// faithful round-trip should match the input (modulo `=` padding).
let TOKEN_SECRET: Uint8Array<ArrayBuffer> | null = null
if (TOKEN_SECRET_B64) {
  // Trim surrounding whitespace — a copy-pasted env value often
  // ends in `\n` and Buffer.from(..., 'base64') would silently
  // strip it, then the typo-detector below would fail with a
  // misleading "non-base64 characters" message. The trim happens
  // here so the round-trip comparison sees the same bytes the
  // decoder saw.
  const trimmed = TOKEN_SECRET_B64.trim()
  if (trimmed.length === 0) {
    console.error('OBJSTORE_TOKEN_SECRET is empty after trimming whitespace')
    process.exit(1)
  }
  const decoded = Buffer.from(trimmed, 'base64')
  const reencoded = decoded.toString('base64')
  // Strip trailing `=` padding for the comparison — operators may
  // omit it. Anything else differing means a silent strip happened
  // (e.g. a base64url '-' or '_' in a standard base64 secret).
  const norm = (s: string): string => s.replace(/=+$/u, '')
  if (norm(reencoded) !== norm(trimmed)) {
    console.error('OBJSTORE_TOKEN_SECRET contains non-base64 characters (likely a typo, e.g. base64url chars in a base64 secret).')
    console.error('Regenerate with: node -e \'console.log(require("crypto").randomBytes(32).toString("base64"))\'')
    process.exit(1)
  }
  if (decoded.byteLength !== 32) {
    console.error(`OBJSTORE_TOKEN_SECRET must decode to 32 bytes (got ${decoded.byteLength})`)
    process.exit(1)
  }
  // `new Uint8Array(decoded)` copies into a fresh ArrayBuffer so the
  // type matches `TokenSecret = Uint8Array<ArrayBuffer>` (Buffer is
  // backed by SharedArrayBuffer in some Node configs).
  TOKEN_SECRET = new Uint8Array(decoded)
}
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

// Per-connection authorization flag for the password-gated "first
// action in a workspace" path. Once a connection completes the
// `authenticate { password }` handshake, every subsequent action on
// that socket bypasses the gate — the access-control surface is the
// per-message Ed25519 signature (the seed-holder is the authorised
// writer), and once a workspace EXISTS on the server the gate is
// off for that workspace regardless of which connection touches it.
// The gate only protects against an unauthenticated client creating
// a brand-new workspace on the server. WeakMap so a closed socket
// drops its flag immediately via the close handler's delete.
const socketAuthorized = new WeakMap<WebSocket, boolean>()
function isAuthorized(socket: WebSocket): boolean {
  return socketAuthorized.get(socket) === true
}
// `CONFIGURED_PASSWORD_HMAC == null` → no gate; everyone is
// effectively authorised and every first action proceeds without an
// `authenticate` handshake. Otherwise the per-socket flag is the
// live state.
function requiresAuth(socket: WebSocket): boolean {
  if (CONFIGURED_PASSWORD_HMAC == null) return false
  return !isAuthorized(socket)
}
// HMAC-based constant-time password compare. Both sides are passed
// through `HMAC(PASSWORD_HMAC_KEY, …)` so the inputs to
// `timingSafeEqual` are always 32-byte fixed-length digests — no
// length-equal precondition, no length leak, and any residual
// timing variance in the comparator reveals only HMAC bytes that
// are useless without the per-process key.
function passwordMatches(submitted: string): boolean {
  if (CONFIGURED_PASSWORD_HMAC == null) return false
  const submittedHmac = new Uint8Array(createHmac('sha256', PASSWORD_HMAC_KEY).update(submitted, 'utf8').digest())
  return timingSafeEqual(submittedHmac, CONFIGURED_PASSWORD_HMAC)
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

// Top-level `unauthorized` frame (Server → Client). Sent when:
//   * A `workspace-save` for a NEW workspace tag arrives on a socket
//     that hasn't authenticated yet (handleSave below) — `kind:
//     'gated'`, with `workspaceTag` + `base` so the client can clear
//     the matching pending save and prompt the user for the password.
//   * An `objstore-put-begin` hits the same gate (handlers.ts) —
//     `kind: 'gated'`, with `workspaceTag` + `resourceTag` for the
//     in-flight putBegin caller.
//   * The client's `authenticate { password }` was rejected by
//     `handleAuthenticate` (wrong password) — `kind: 'auth-failed'`,
//     no other context fields.
// The explicit `kind` discriminator is the wire-protocol contract:
// callers MUST switch on it rather than infer from the presence /
// absence of other fields. A future server change adding context
// to either branch can't silently misroute under this contract,
// whereas a field-presence inference would. The client's wire-side
// dispatcher (client/triage-sync.ts handleMessage) and the objstore
// client's put-begin recv predicate both pin on `kind`.
type UnauthorizedContext =
  | { kind: 'gated'; workspaceTag: string; base: string | null }       // workspace-save gated
  | { kind: 'gated'; workspaceTag: string; resourceTag: string }       // objstore-put-begin gated
  | { kind: 'auth-failed' }                                             // authenticate-failed
function sendUnauthorized(socket: WebSocket, ctx: UnauthorizedContext): void {
  send(socket, { type: 'unauthorized', ...ctx })
}

// `authenticate { password }` handler. Constant-time password
// compare; success flips the per-socket flag and emits
// `authenticated` (the client's signal to retry any queued
// pendingSave / pendingSubscribe). Failure emits
// `unauthorized { kind: 'auth-failed' }` so the client knows its
// retry loop should ask for a different password rather than treat
// the message as a new action-gating signal (`kind: 'gated'`).
//
// Pre-shape gate: password must be a non-empty string, length-
// capped so a peer can't make us HMAC megabytes per frame. This
// handler is fast-inlined OUTSIDE the per-socket MAX_INFLIGHT
// cap (see the dispatcher's ping/authenticate special-case below),
// so without the cap a frame-spamming peer would dominate the
// event loop on `createHmac().update(p)`. 4096 bytes is far above
// any conceivable real password and well below the WS frame
// `maxPayload` of 4 MiB.
const MAX_AUTH_PASSWORD_LEN = 4096
type AuthenticateMsg = { password?: unknown }
function handleAuthenticate(socket: WebSocket, msg: AuthenticateMsg): void {
  if (typeof msg.password !== 'string' || msg.password.length === 0 || msg.password.length > MAX_AUTH_PASSWORD_LEN) return
  // No-config short-circuit: if the server isn't gating, treat any
  // authenticate as success. This lets a client cache its password
  // and replay it on reconnect even when the server happens to be
  // un-gated today — the wire shape stays consistent.
  if (CONFIGURED_PASSWORD_HMAC == null) {
    socketAuthorized.set(socket, true)
    send(socket, { type: 'authenticated' })
    return
  }
  if (!passwordMatches(msg.password)) {
    if (DEBUG) console.warn('authenticate: wrong password')
    sendUnauthorized(socket, { kind: 'auth-failed' })
    return
  }
  socketAuthorized.set(socket, true)
  if (DEBUG) console.log('authenticate: success')
  send(socket, { type: 'authenticated' })
}

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
  // Per-socket handlers are DELIBERATELY NOT serialized (vs the
  // client-side `queue = queue.then(...)` message-dispatch chain
  // inside `triageSync.openSocket` in `client/triage-sync.ts`).
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
    const inflightForSocket = socketInflight.get(socket) ?? 0
    if (inflightForSocket >= MAX_INFLIGHT_PER_SOCKET) {
      if (DEBUG) console.warn(`drop message: socket inflight ${inflightForSocket} >= ${MAX_INFLIGHT_PER_SOCKET}`)
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
          console.warn('Handler error (type=workspace-save):', (err as Error)?.stack ?? err)
        }
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
    socketAuthorized.delete(socket)
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
    catch (err) { console.warn('commit-lock shutdown release error:', (err as Error)?.message ?? err) }
  }
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
