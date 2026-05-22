# DeepView triage-sync server

A small WebSocket relay that lets DeepView clients sharing a workspace
seed sync their per-finding triage (color, deleted, comment, fix) and
exchange encrypted bundle/report blobs. Encryption + Ed25519 signing
happen client-side; the server only stores opaque ciphertext and routes
it. It can't read, forge, or re-attribute anything.

Requires **Node ≥ 24** (built-in `node:sqlite`, WebCrypto Ed25519, and
native `.ts` execution — no flags).

## Quick start

```sh
pnpm install
pnpm server          # ws://127.0.0.1:8765/api/sync
```

The SQLite file is created on first run; nothing else is needed.

| Env var        | Default                | Notes                                  |
| -------------- | ---------------------- | -------------------------------------- |
| `PORT`         | `8765`                 |                                        |
| `HOST`         | `127.0.0.1`            |                                        |
| `DB_PATH`      | `server/data/data.db`  | SQLite file (ignored when using Neon)  |
| `OBJSTORE_DIR` | next to `DB_PATH`      | on-disk blob bytes                     |
| `DATABASE_URL` | —                      | set to use Neon Postgres (see below)   |
| `DEBUG`        | —                      | `DEBUG=1` logs every message           |

## Using Neon Postgres

The default SQLite backend is best for single-process / single-machine
deployments. To use Neon instead, install the optional driver and point
`DATABASE_URL` at your connection string:

```sh
pnpm add @neondatabase/serverless
DATABASE_URL=postgres://user:pass@<project>.neon.tech/db pnpm server
```

`DB_PATH` is ignored when `DATABASE_URL` is set. Both data planes (triage
revisions and object metadata) live in the same Neon database; blob
**bytes** still live on local disk under `OBJSTORE_DIR` in either backend.

The driver is an `optional` peer dep and `pnpm-workspace.yaml` sets
`autoInstallPeers: false`, so a SQLite-only deploy never installs it.

<details>
<summary>Neon caveats (latency &amp; multi-replica)</summary>

- **Latency.** Each save issues 3 pipelined HTTP round-trips to Neon
  (dup / head check + gated INSERT). At ~30–80 ms RTT that's ~90–240 ms
  per save vs sub-millisecond on SQLite. Fine for triage-edit cadence;
  size for it if you expect bursty writes.
- **Multi-replica writes.** `commitRevision` takes no write lock;
  fork-safety rests on Postgres READ-COMMITTED single-statement snapshots
  + the `UNIQUE(workspace_tag, seq)` PK. This is sound by construction but
  not yet covered by an automated cross-replica test (the PGlite test
  backend is single-connection). Confirm with a real-Postgres concurrency
  test before relying on multi-replica writes in production.
- **Blob byte plane is single-process today.** `OBJSTORE_DIR` is local to
  one process, so a `PUT` on replica A + `GET` on replica B would 503.
  The DB/metadata layer is multi-process safe; full multi-replica blob
  support waits on a shared object store (S3 or similar).

</details>

## Authentication

Every signed message is verified against the `workspaceTag` (= Ed25519
public key) before any state mutation; invalid signatures are silently
dropped. A seed holder retries; an attacker who only learned the tag
can't get past verify. Save/subscribe and each objstore op use distinct
signing-domain prefixes so a signature can't be replayed across message
types or protocols.

### Optional password gate

The relay can gate **the first action against a never-before-seen
workspace tag** behind a shared password. Copy the example config and set
one:

```sh
cp server/config.example.json server/config.json
```

```json
{ "password": "your-shared-secret" }
```

`config.json` is git-ignored. `null` (or a missing file) disables the
gate — the default no-config behaviour. The gate only stops strangers
from creating *new* workspaces on a shared relay; access to existing
workspaces is the per-message signature, and subscribes are never gated.

<details>
<summary>Gate semantics, wire shape &amp; password comparison</summary>

Fires on the first signed `workspace-save` / `objstore-put-begin` for a
tag whose `workspace_revision` and `workspace_object` tables are both
empty. Every other signed action bypasses it. `workspace-subscribe` is
intentionally never gated — a subscribe to an unknown tag returns an
empty chain, and there's nothing to leak by confirming absence.

**Concurrent-creation race (accepted).** `workspaceExists` reads at a
different moment than the commit, so under concurrent saves on a fresh
tag an unauthenticated socket may observe "exists" (a peer's commit
landed between check and commit) and skip the gate. Accepted: it still
had to produce a valid signature (= holds the seed), so the worst case is
"two authorised writers", not "stranger bypasses auth".

Wire shape:

```
client → server  authenticate { password }
server → client  authenticated {}                  // accepted
server → client  unauthorized {                    // gate fired / rejected
  kind,                                            //   'gated' | 'auth-failed'
  workspaceTag?, base?, resourceTag?,
}
```

Callers MUST switch on `kind`:
- `gated` + `workspaceTag` + `base` — rejected `workspace-save`.
- `gated` + `workspaceTag` + `resourceTag` — rejected `objstore-put-begin`.
- `auth-failed` — wrong password; client prompts for a different one.

Authorization is per-WebSocket (`WeakMap<WebSocket, boolean>`); a
reconnect re-authenticates. The client caches the password (in memory,
and encrypted in secure-storage when the passkey vault is on) so the user
sees the prompt only once per page load / password change.

Password comparison is HMAC-SHA-256 on both sides under a per-process
random key (32 bytes minted at boot, never persisted) then
`crypto.timingSafeEqual` on the two 32-byte digests — fixed-length inputs
close the length-leak window, and any residual timing variance reveals
only HMAC bytes useless without the per-process key.

</details>

## URL layout

One `http.Server` handles everything under `/api/*`, so a fronting proxy
can route with a single location block (`/api/*` → relay, `/*` → static
UI bundle).

- `ws://${host}/api/sync` — WebSocket upgrade; the triage-sync wire
  protocol flows over it.
- `/api/objstore/{workspaceTag}/{resourceTag}` — REST `PUT`/`GET` byte
  transfer for the object store.
- Any other URL — `404 not-found` (JSON body).

## Wire protocol

All WS messages are JSON over text frames; binary frames are dropped.
`nonce` / `ciphertext` / `signature` / `connectionNonce` fields are
base64url. The very first frame the server sends is a per-socket
`challenge { nonce }` (16 random bytes) that the client must bind into
every `workspace-subscribe` signature, blocking cross-connection replay.

<details>
<summary>Triage-sync messages</summary>

### Client → Server

```
workspace-save {
  workspaceTag,        // base64url Ed25519 public key
  base,                // last revision id the client knows; null on first save
  keyframe,            // optional; true = full-state baked in (catch-up root),
                       // omitted/false = delta against `base`
  nonce, ciphertext,   // ChaCha20-Poly1305 over the JSON-encoded changeset
  signature            // Ed25519 over (domain, tag, base, keyframe, nonce, ciphertext)
}

workspace-subscribe {
  workspaceTag,
  from,                // last revision id the client has applied (or null)
  signature            // Ed25519 over (domain, tag, from, connectionNonce)
}

authenticate { password }   // see "Optional password gate"
ping                        // application-level liveness probe
```

### Server → Client

```
workspace-subscribed { workspaceTag, resources: [...] }
                       // handshake-complete ack, sent BEFORE the initial
                       // chain — lets the UI flip connecting → online only
                       // after the peer is registered. `resources` is the
                       // objstore inventory snapshot (resourceTag, version,
                       // incarnation, contentHash, contentLength, signature);
                       // `[]` for a triage-only workspace.

workspace-save-ack { workspaceTag, base, id }
                       // `id` is content-addressed (SHA-256 of canonical
                       // bytes, base64url) — same id the client computes.

workspace-save-error { workspaceTag, base, reason }
                       // Reject for a SIGNED save (sent AFTER sig verify, so
                       // only a legit seed-holder sees it). Reasons (see
                       // common/save-error-reason.ts):
                       //   too-large  — ciphertext > 2 MiB; retry won't help.
                       //   busy       — per-socket inflight cap; recoverable.
                       //   stale-base — head advanced; emitted AFTER the
                       //                catch-up workspace-state.
                       // `base` echoes the save's base for attribution.

workspace-state {
  workspaceTag,
  revisions: [ { base, id, keyframe, nonce, ciphertext, signature }, ... ]
}

authenticated {}       // password accepted; per-socket flag flips on
unauthorized { kind, workspaceTag?, base?, resourceTag? }   // see gate section
pong                   // reply to ping
```

`workspace-state` carries: initial sync (after subscribe), broadcast when
another client commits, and stale-base catch-up. For `from = null` (or an
unknown id) the chain starts at the most recent keyframe, so a fresh
client doesn't replay history back to genesis.

</details>

## v1.objstore — bundle + report storage

Two planes on the same listener:

- **WS plane** — control + auth. Signed `objstore-put-begin` /
  `objstore-fetch` mint short-TTL HMAC bearer tokens that authorise a
  matching REST byte transfer. `objstore-delete` stays fully on WS.
- **REST plane** — byte transfer. `PUT`/`GET` under
  `/api/objstore/{workspaceTag}/{resourceTag}` with the WS-issued token in
  `Authorization: Bearer …`, streamed straight to / from disk.

The split is the win: a 50 MiB upload doesn't head-of-line block
heartbeats or other workspaces' triage chains, and avoids the ~33% base64
overhead of a WS text frame. Unlike triage-sync there's **no history**
(PUT upserts, DELETE drops the row), and upload/fetch are **manual** —
broadcasts only carry metadata; bytes ride an explicit signed token +
REST round-trip.

<details>
<summary>WS messages</summary>

Client → server:

```
objstore-put-begin {
  workspaceTag,         // base64url Ed25519 public key
  resourceTag,          // base64url, HMAC-derived per (tagKey, fileName)
  prevVersion,          // integer or null — expected current version
  expectedLength,       // total ciphertext bytes (incl. AEAD nonce + tag)
  contentHash,          // base64url SHA-256 of the ciphertext bytes
  signature             // Ed25519 over the canonical PUT payload
}
objstore-delete { workspaceTag, resourceTag, prevVersion, signature }
objstore-fetch  { workspaceTag, resourceTag, signature }   // bound to connectionNonce
```

Server → client:

```
objstore-put-token    { workspaceTag, resourceTag, stagingId, urlPath,
                        token, expiresAt }
objstore-fetch-token  { workspaceTag, resourceTag, version, contentHash,
                        contentLength, signature, urlPath, token, expiresAt }
objstore-fetch-not-found { workspaceTag, resourceTag }
objstore-deleted-ack  { workspaceTag, resourceTag, deletedVersion }   // 0 = no-op
objstore-put-error    { workspaceTag, resourceTag, reason }   // workspace-full
objstore-delete-error { workspaceTag, resourceTag, reason }   // not-found
objstore-conflict     { action, workspaceTag, resourceTag, current? }

// broadcasts to subscribed peers:
objstore-put          { workspaceTag, resourceTag, version, contentHash,
                        contentLength, signature }
objstore-deleted      { workspaceTag, resourceTag, version }
```

Canonical signing payloads are the source of truth in
`server/objstore/sign.ts` (`canonicalObjstorePut` / `…Delete` / `…Fetch`);
JSON key order on the wire is irrelevant but the signed byte order is
fixed by those builders. `*-error` / `*-conflict` frames are sent after
sig verify, so only legit signers see them.

</details>

<details>
<summary>REST endpoints &amp; tokens</summary>

Both routes match `/api/objstore/{workspaceTag}/{resourceTag}`; the token
rides `Authorization: Bearer <token>`, never the URL (querystring tokens
leak via access logs / referer).

Every non-2xx response is a uniform JSON envelope `{ "error": <reason> }`
(the reason word is shown below); the 409 envelope additionally carries
`currentVersion` + `currentIncarnation` so the client can rebase.

```
PUT  /api/objstore/{workspaceTag}/{resourceTag}
  Headers: Authorization: Bearer <put-token>
           Content-Length: <expectedLength>
           Content-Type:   application/octet-stream
  Body:    raw ciphertext (matches expectedLength exactly)
  200 { version, incarnation, contentHash, contentLength }   committed
  400 { error: "length-mismatch" }    Content-Length ≠ token's expectedLength / size mismatch
  400 { error: "aborted" }            pipe failure mid-body
  401 { error: "unauthorized" }       missing / bad / expired token
  405 { error: "method-not-allowed" } token op ≠ method
  409 { error: "conflict", currentVersion, currentIncarnation }
                                      prev_version raced, or same token already in flight
  410 { error: "gone" }               staging row dropped (TTL / abort / racing commit)
  411 { error: "length-required" }    missing / non-int / > 100 MiB Content-Length
  500 { error: "io-error" | "internal" }

GET  /api/objstore/{workspaceTag}/{resourceTag}
  Headers: Authorization: Bearer <get-token>
  200 (application/octet-stream)      body = raw ciphertext
  401 { error: "unauthorized" }
  404 { error: "not-found" }          version mismatch / deleted
  405 { error: "method-not-allowed" }
  500 { error: "internal" }
  503 { error: "unavailable" }        live row present, file missing / size diverged
```

Tokens are HMAC-SHA-256 over a JSON payload, base64url, dot-joined to the
payload bytes:

```
PUT payload: { op: "put", tag, res, sid, len, exp }
GET payload: { op: "get", tag, res, ver, exp }
token       = base64url(payload-json) + "." + base64url(hmac)
```

The HMAC secret is a 32-byte random value minted at start; restart
invalidates outstanding tokens (TTL is short — 5 min default — and clients
re-handshake over WS). PUT tokens are single-use (`commitPut` deletes the
staging row keyed by `sid`, so a replay hits `410 Gone`); GET tokens are
multi-use within TTL but only ever yield AEAD ciphertext.

</details>

<details>
<summary>Lifecycle (client UX contract)</summary>

Enforced by the client; the server just serves the wire protocol.
Documented here for a single source of truth.

- **Upload is manual.** Signed `objstore-put-begin` → `objstore-put-token`
  → HTTP `PUT`. The 200 body carries `{ version, contentHash }`; peers see
  metadata via the `objstore-put` broadcast.
- **Fetch is manual.** Signed `objstore-fetch` → `objstore-fetch-token` →
  HTTP `GET`.
- **Delete-from-server, when synced.** Send `objstore-delete`, wait for
  `objstore-deleted-ack` (success) or `objstore-conflict` /
  `objstore-delete-error` (failure), and only on success prune the local
  cache. Gated off when offline.
- **Delete-arrived-from-peer.** On an `objstore-deleted` broadcast (or a
  diff of the `workspace-subscribed` snapshot on reconnect) with a local
  copy present, prompt: keep-and-optionally-reupload, or drop-local. The
  "kept-local" decision is sticky — the dialog must not re-fire every
  reconnect.
- **Re-upload after kept-local + delete.** Just another PUT with
  `prevVersion = null`; concurrent re-uploads resolve via `objstore-conflict`.

</details>

<details>
<summary>Quotas, truncation invariant &amp; storage layout</summary>

**Quotas**
- Per-workspace resource cap: `MAX_RESOURCES_PER_WORKSPACE = 100` live
  rows per tag, enforced at `objstore-put-begin` for NEW resources only
  (re-uploads of an existing resourceTag never trip it). Rejection:
  `objstore-put-error { reason: 'workspace-full' }`.
- Per-upload byte cap: `MAX_CONTENT_LENGTH = 100 MiB`, enforced at
  `objstore-put-begin` and at the REST PUT (Content-Length + on-disk
  stat). No per-workspace total-bytes cap yet.

**Truncation invariant.** A partial / aborted upload MUST NEVER become a
live row. Three layers: (1) REST handler aborts on `received !== declared`
→ 400; (2) post-upload `stat().size !== payload.len` → same; (3)
`commitPut` re-stats under the per-resource lock before the rename.
Retries get a fresh `stagingId`, so truncated bytes can never be renamed in.

**Storage.** Two SQLite tables + a filesystem tree:

```
workspace_object (
  workspace_tag TEXT, resource_tag TEXT,
  version INTEGER,            -- monotonic per (tag, resource)
  content_hash TEXT, content_length INTEGER, signature TEXT, put_at INTEGER,
  PRIMARY KEY (workspace_tag, resource_tag)
) STRICT

workspace_object_staging (
  workspace_tag, resource_tag, staging_id,
  prev_version, expected_length, content_hash, signature, begun_at,
  PRIMARY KEY (workspace_tag, resource_tag, staging_id)
) STRICT

${OBJSTORE_DIR}/${workspaceTag}/${contentHash}.bin           -- live (content-addressed)
${OBJSTORE_DIR}/${workspaceTag}/.staging/${stagingId}.bin    -- in-flight
```

Bytes live outside SQLite to keep the WAL out of the multi-MB path. Live
blobs are content-addressed, so the row's `content_hash` literally names
its file — a metadata-vs-bytes desync is impossible and commit is a plain
version compare-and-set. Ordering is asymmetric so power-loss leaves at
most a stranded blob (GC'd by the reaper), never a row pointing at missing
bytes:
- PUT: `fsync(staging) → rename → fsync(parent dir) → DB version-CAS`.
- DELETE: `DB row drop`; the unreferenced blob is GC'd by the reaper (not
  unlinked inline) so it can't race a commit or an in-flight GET.

The reaper runs once at startup (before accepting traffic) then every
`OBJSTORE_REAP_INTERVAL_MS`. Stale staging rows and unreferenced live
blobs expire after `STAGING_TTL_MS_DEFAULT` (1h) — the grace window that
keeps a just-promoted blob from being collected mid-commit.

</details>

<details>
<summary>Triage-sync storage &amp; lockless commit</summary>

Single table:

```
workspace_revision (
  workspace_tag TEXT NOT NULL,
  seq           INTEGER NOT NULL,            -- monotonic per workspace_tag
  id            TEXT NOT NULL,               -- SHA-256 content-address (base64url)
  base          TEXT,                        -- previous revision id, null on first
  keyframe      INTEGER NOT NULL DEFAULT 0,  -- 1 if full-state, else 0
  nonce         TEXT NOT NULL,               -- base64url
  ciphertext    TEXT NOT NULL,               -- base64url
  signature     TEXT NOT NULL,               -- base64url
  created_at    INTEGER NOT NULL,            -- ms epoch (debug aid)
  PRIMARY KEY (workspace_tag, seq),
  UNIQUE (workspace_tag, id)                 -- makes retransmits idempotent
) STRICT
```

WAL mode + `synchronous = FULL`: concurrent readers, crash-safe writes,
and an fsync per commit so the `workspace-save-ack` is a real durability
promise.

`commitRevision` takes **no write lock** on either backend. Concurrent
saves on one tag are kept fork-safe by a single gated INSERT whose
head-check and `COALESCE(MAX(seq),0)+1` read one statement snapshot, so a
racer is forced onto either the same `seq` (rejected by the PK) or a
no-longer-matching head (gated out). The loser gets `stale-base`. A
UNIQUE-violation recovery branch (`catch` in `server/db.ts`) re-routes a
PK/UNIQUE collision through `revisionExists` + `headFor`, emerging as
`inserted` or `stale-base`, never a silent fork.

Coverage is asymmetric: SQLite lockless-commit fork-safety is fully
covered by `tests/server-db.test.js`; Neon cross-replica safety rests on
the READ-COMMITTED + `UNIQUE(tag, seq)` argument but isn't empirically
tested (PGlite is single-connection) — see the Neon caveats above.

</details>

## Transport backpressure

Per-socket caps that bound resource use under hostile load (not security
primitives — the per-message signature is). Cross-protocol.

- **`MAX_BUFFERED_BYTES = 16 MiB`** per socket of undrained outbound
  bytes; past the cap the socket is terminated and the client reconnects +
  catches up via the chain.
- **`MAX_INFLIGHT_PER_SOCKET = 64`** in-flight async handlers; saves
  dropped at the cap surface as `workspace-save-error { reason: 'busy' }`.
  Configurable via env var (mostly for tests).
- **REST PUT idle-body timeout = 30 s** — aborts a slow-loris trickle
  rather than holding the staging fd until the staging TTL reaps it.

<details>
<summary>Per-message error handling matrix</summary>

The socket is shared across every open workspace. Per-message errors are
session-scoped and DO NOT close the WS; only transport failures reconnect.

| Failure mode | Server action | Socket | Client recovery |
|---|---|---|---|
| Bad signature on save / subscribe | Silent drop | Open | Legit signer retries; persistent bad-sig surfaces as `'encrypt/sign failed: …'` after `maxConsecutiveFailures` (5). |
| Shape-invalid save field (newline, non-base64) | Silent drop | Open | Same as bad sig — legit clients never produce these. |
| Save ciphertext > 2 MiB (`MAX_CIPHERTEXT_LEN`) | `workspace-save-error { too-large }` after sig verify | Open | Client clears `pending`, sets `session.error`; cleared via `dismissError` / lifecycle handlers. |
| Save dropped by inflight cap | `workspace-save-error { busy }` before the handler IIFE | Open | Client clears `pending`, re-arms `pendingSave`; no `session.error` (recoverable). |
| Save `base` ≠ server head | `workspace-state` catch-up then `workspace-save-error { stale-base }` | Open | `handleChain` clears `pending` first; recoverable (catch-up rebases). |
| `objstore-put-begin` over the 100-resource cap (new resource) | `objstore-put-error { workspace-full }` after sig verify | Open | Re-uploads of existing resourceTags still succeed. |
| Total WS frame > 4 MiB (`maxPayload`) | `ws` closes with 1009 | **Closed** | Reconnects; shouldn't happen given the 2 MiB ciphertext cap. |
| Heartbeat: `ping` → no `pong` in timeout | n/a | **Closed by client** | Reconnects (backoff from 1 s); session flags reset, `session.error` preserved. |
| Graceful shutdown (SIGTERM) | Close 1001 "going away" | **Closed by server** | Reconnects per backoff. |

Boot-blocking errors (invalid `PORT`, a non-STRICT pre-existing
`workspace_revision` table, etc.) fail loud at startup.

</details>

## What the server can &amp; can't do

The server stores and routes opaque ciphertext. It **can't** decrypt or
modify triage values / blob contents, forge writes (every save / PUT /
DELETE needs a valid Ed25519 signature), re-attribute a revision to a
different `base`/`keyframe`/`id` or a blob to a different `resourceTag`
(all bound into the signed canonical + content hash), or replay a captured
subscribe / fetch from another connection (both bind the per-socket
`connectionNonce`).

It **can**, as any relay: drop / reorder / delay messages (DoS), observe
traffic patterns (size, timing, edit cadence per tag), and synthesise
garbage revisions — which clients reject on signature verification (skip +
advance, not a full resync).

## License

MIT.
