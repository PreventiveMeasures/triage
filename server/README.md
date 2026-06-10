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

The server runs in one of **two deployment modes**, each pairing a
metadata store with a byte (blob) store. The mode is chosen entirely by
whether `DATABASE_URL` is set — there's no mix-and-match:

| Mode                 | Metadata          | Blob bytes                  | Topology         |
| -------------------- | ----------------- | --------------------------- | ---------------- |
| **SQLite** (default) | SQLite at `DB_PATH` | local FS at `OBJSTORE_DIR` | single-process   |
| **Neon**             | Neon Postgres     | Vercel Blob Private Storage | multi-instance   |

Neon mode shares its DB + bytes consistently across instances, AND
cross-instance real-time broadcasts ride a dedicated Postgres
LISTEN/NOTIFY bus — a commit landing on instance A reaches subscribers
on instance B with the same latency the hub gives same-instance peers.
See the "Cross-instance broadcasts" detail in the Neon section.

| Env var                | Default               | Notes                                          |
| ---------------------- | --------------------- | ---------------------------------------------- |
| `PORT`                 | `8765`                |                                                |
| `HOST`                 | `127.0.0.1`           |                                                |
| `DEBUG`                | —                     | `DEBUG=1` logs every message                   |
| `DB_PATH`              | `server/data/data.db` | SQLite mode only                               |
| `OBJSTORE_DIR`         | next to `DB_PATH`     | SQLite mode only — on-disk blob bytes          |
| `DATABASE_URL`         | —                     | set → Neon mode (Postgres connection string)   |
| `BLOB_READ_WRITE_TOKEN`| —                     | Neon mode, **required** — Vercel Blob R/W token |
| `OBJSTORE_TOKEN_SECRET`| —                     | Neon mode, **required** — shared HMAC secret    |
| `OBJSTORE_REAP_INTERVAL_MS` | `600000` (10 min) | orphan-reaper period                       |
| `OBJSTORE_REAP_DISABLED` | —                   | `1` / `true` disables the reaper entirely (no GC; orphans grow unbounded — see below) |
| `TRUST_PROXY`          | on for loopback `HOST` | any non-loopback bind behind a proxy — set `1` (see below) |

## SQLite mode (default)

SQLite for metadata + local filesystem for blob bytes. No extra
dependencies, no config — best for single-process / single-machine
deployments. `pnpm server` gives you this out of the box.

This mode is **single-process**: `OBJSTORE_DIR` is a local directory, so a
`PUT` on one process and a `GET` on another wouldn't see the same bytes.
Run exactly one server instance. For a multi-instance deployment, use Neon
mode below.

## Neon mode (multi-instance)

Neon Postgres for metadata + Vercel Blob Private Storage for the bytes —
both serverless and HTTP-backed, so no shared filesystem is needed and the
relay can run as multiple instances behind a load balancer. Install the two
optional drivers and set the required env vars:

```sh
pnpm add @neondatabase/serverless @vercel/blob

DATABASE_URL=postgres://user:pass@<project>.neon.tech/db \
BLOB_READ_WRITE_TOKEN=vercel_blob_rw_xxx \
OBJSTORE_TOKEN_SECRET=$(node -e 'console.log(require("crypto").randomBytes(32).toString("base64"))') \
TRUST_PROXY=1 HOST=0.0.0.0 \
  pnpm server
```

When `DATABASE_URL` is set, `DB_PATH` / `OBJSTORE_DIR` are ignored and the
server **fails fast at boot** if any required companion is missing:

- **`BLOB_READ_WRITE_TOKEN`** — the Vercel Blob R/W token. Local-FS bytes
  can't back a multi-instance deployment (one instance's writes wouldn't be
  visible to another), so this is mandatory. All blobs are written with
  `access: 'private'`; the URL alone never fetches them.
- **`OBJSTORE_TOKEN_SECRET`** — a shared HMAC secret (base64, 32 bytes) so
  the short-TTL REST bearer tokens minted on one instance validate on any
  other. Without a shared secret each instance would mint per-process
  secrets and cross-instance byte transfers would 401.
- **`TRUST_PROXY=1`** — make the same-origin gate honour `X-Forwarded-Host`
  / `-Proto` instead of the internal container hostname; otherwise every
  browser request behind a load balancer / TLS terminator 403s. This isn't
  Neon-specific — the gate (`server/origin.ts`) defaults on for a loopback
  `HOST` and off otherwise in *any* mode, so a SQLite deploy on a public
  bind behind a proxy needs it too. Neon mode just additionally **fails
  fast at boot** when it's missing on a non-loopback `HOST` (a SQLite
  deploy would instead silently 403). Set `TRUST_PROXY=0` only if you
  genuinely terminate TLS in the container with no proxy.

The drivers are `optional` peer deps and `pnpm-workspace.yaml` sets
`autoInstallPeers: false`, so a SQLite deploy never installs them.

### Cross-instance broadcasts (Postgres LISTEN/NOTIFY)

The WS fan-out is still an in-memory subscriber map (`server/hub.ts`),
but Neon mode wires a Postgres LISTEN/NOTIFY bus
(`server/pubsub.ts`) alongside it so live broadcasts reach peers on
*other* instances too. Each commit fans out twice: locally over the
in-memory subscriber map, then onto the bus; the receiving instance
re-fans-out into its own subscriber map. A client on instance A sees
a real-time `workspace-state` push for a commit that landed via
instance B — no reconnect, no chain re-pull on the hot path.

The bus uses one dedicated long-lived `Client` (WebSocket-based) per
instance from `@neondatabase/serverless`. The HTTP `neon()` callable
the queries flow over is stateless and can't `LISTEN`; the Client
form is session-bound. Per-process random sender ids let an instance
skip its own notifications (Postgres delivers `NOTIFY` back to
publishers that `LISTEN` on the same channel).

Payload-size budget. Postgres caps `NOTIFY` payloads at ~8 KB
(`NAMEDATALEN`-derived, not raisable on a managed endpoint), but the
`workspace-state` envelope carries a ciphertext up to
`MAX_CIPHERTEXT_LEN` (2 MiB). The bus therefore ships *hints* for the
size-unbounded paths and the receiver re-fetches the row from the
shared DB:

Bus envelopes are JSON; the field names below are the LITERAL keys in
the `pg_notify` payload (kept short to stay well clear of the ~8 KB
budget). Each envelope also carries a per-process `sender` for the
own-publish self-filter.

- `rev` (revision committed) — `{kind:"rev", tag, id}`; receiver
  SELECTs the row from `workspace_revision` by `(tag, id)` and
  broadcasts `workspace-state`.
- `objput` (objstore PUT committed) — `{kind:"objput", tag, res}`
  (`res` = resourceTag); receiver SELECTs from `workspace_object` by
  `(tag, res)` and broadcasts `objstore-put`.
- `objdel` (objstore DELETE committed) — `{kind:"objdel", tag, res, ver}`
  (`res` = resourceTag, `ver` = version); inline — the row is gone
  from `workspace_object` post-commit, so the bus payload IS the wire
  data and no fetch happens.

The bus is best-effort fan-out, not a durability layer. A dropped
publish only means peers on *other* instances miss the live push for
that one event — they still catch up via the shared DB (chain re-pull)
on their next subscribe / reconnect. Transient transport failures
reconnect with exponential backoff; publishes during the down window
drop on the floor.

<details>
<summary>Neon latency &amp; multi-instance fork-safety</summary>

- **Latency.** Each save issues 3 pipelined HTTP round-trips to Neon
  (dup / head check + gated INSERT). At ~30–80 ms RTT that's ~90–240 ms
  per save vs sub-millisecond on SQLite. Fine for triage-edit cadence;
  size for it if you expect bursty writes.
- **Multi-replica writes.** `commitRevision` takes no write lock;
  fork-safety rests on Postgres READ-COMMITTED single-statement snapshots
  + the `UNIQUE(workspace_tag, seq)` PK. This is sound by construction but
  not yet covered by an automated cross-replica test (the PGlite test
  backend is single-connection). Confirm with a real-Postgres concurrency
  test before relying on multi-instance writes in production.
- **Blob crash-safety.** The Vercel backend mirrors the FS ordering via
  copy + delete instead of fsync + rename: `put(staging) → copy(→ live) →
  DB version-CAS → del(staging)`. A crash at the worst moment leaves at
  most a stranded blob (reaper-GC'd past the grace window), never a row
  pointing at missing bytes.

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
- `POST /api/sync/sse` — SSE+POST fallback transport (corporate proxies
  that strip the `Upgrade` header); same wire protocol, upstream batched
  into POSTs, downstream a long-lived `text/event-stream`.
- `POST /api/sync/save` — session-independent save plane. The SSE-mode
  alternative to the in-band `workspace-save` frame: the same signed save
  frame in the JSON body, run through the SAME pipeline (the save canonical
  binds no connection nonce, so it self-verifies), committed + broadcast
  WITHOUT taking over the client's SSE event-stream (every in-band SSE POST
  reopens the stream). The outcome is a JSON HTTP status: `200 { ok, id }`
  (committed / replay), `409 { reason:'stale-base', revisions }` (catch-up
  to rebase on), `413 { reason:'too-large' }`, or `401` (new-workspace
  gate). The client POSTs here in SSE mode, falling back to the in-band
  frame on `401`. Broadcasts use `except: null` (no socket to exclude); the
  originator's own content-addressed echo on its stream is an idempotent
  no-op.
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
  `Authorization: Bearer …`, streamed straight to / from the blob backend
  (local FS or Vercel Blob).

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
`server/objstore/sign.ts` (`canonicalObjstorePut` / `…Delete` / `…Fetch` /
`…FetchRest`); JSON key order on the wire is irrelevant but the signed
byte order is fixed by those builders. `*-error` / `*-conflict` frames are sent after
sig verify, so only legit signers see them.

</details>

<details>
<summary>REST endpoints &amp; tokens</summary>

All routes match `/api/objstore/{workspaceTag}/{resourceTag}`. The `PUT`/
`GET` byte transfers carry a token in `Authorization: Bearer <token>`,
never the URL (querystring tokens leak via access logs / referer). The
`POST` route is a REST alternative to the WS `objstore-fetch` /
`objstore-put-begin` / `objstore-delete` handshakes
(`server/objstore/rest-mint.ts`): authed by an Ed25519 signature in the JSON
body (no live socket, no bearer token) — useful when running these ops
independent of the SSE session (e.g. so an SSE replica hop can't interrupt
them; the client uses it in SSE mode). The body's `op` selects `fetch` (→
get-token) or `put` (→ put-token + stagingId) — both return the SAME token
shape the WS path sends for the same `GET` / `PUT` route — or `delete`, which
mutates in place and returns `{ deletedVersion }` (no token; there are no
bytes to move). In place of the WS connection nonce it binds a client
timestamp; the server enforces a ±60s freshness window + a single-use replay
dedup (`server/objstore/fetch-mint-guard.ts`), so a retry must re-sign with a
fresh `ts` rather than resend the same body. The `put` op also runs the
new-workspace operator gate — since REST has no socket auth state, a
never-seen workspace under a configured password gets 401 and the client
falls back to the in-band WS put-begin. `delete` has no such gate (it's
signature-gated, idempotent, and creates nothing), matching the WS path.

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

POST /api/objstore/{workspaceTag}/{resourceTag}      (op=fetch|put|delete)
  Common body (application/json): { op, ts, signature }
    ts        client epoch-ms; rejected outside a ±60s window
    signature Ed25519 over the op's canonical (workspaceTag IS the pubkey;
              canonicals in sign.ts), binding `ts` in the nonce slot
  401 { error: "unauthorized" }       bad signature, stale ts, OR replayed
                                      signature (re-sign with a fresh ts)
  400 { error: "bad-request" }        missing/malformed fields, or unknown op

  op=fetch  signature over [fetch-rest domain, tag, res, ts]
    200 { resourceTag, version, incarnation, contentHash, contentLength,
          signature, urlPath, token, expiresAt }   get-token for the GET above
    404 { error: "not-found" }        no live row for (tag, res)

  op=put    + body { prevVersion, prevIncarnation, expectedLength, contentHash }
            signature over [put-rest domain, tag, res, prevVersion,
              prevIncarnation, contentHash, expectedLength, ts]
    200 { stagingId, urlPath, token, expiresAt }   put-token for the PUT above
    401 also = new-workspace operator gate (password set + workspace new);
              client falls back to the in-band WS put-begin
    403 { error: "workspace-full" }   per-workspace resource cap
    409 { error: "conflict", currentVersion, currentIncarnation }
                                      prevVersion/incarnation precondition stale

  op=delete + body { prevVersion, prevIncarnation }   (null pair = must-exist-free)
            signature over [delete-rest domain, tag, res, prevVersion,
              prevIncarnation, ts]
    200 { deletedVersion }            0 = idempotent no-op (no live row + null
              precondition); >0 = dropped that version (broadcasts to peers).
              No operator gate (idempotent, creates nothing)
    404 { error: "not-found" }        non-null precondition against a missing row
    409 { error: "conflict", currentVersion, currentIncarnation }
                                      prevVersion/incarnation precondition stale
  500 { error: "internal" }
```

Tokens are HMAC-SHA-256 over a JSON payload, base64url, dot-joined to the
payload bytes:

```
PUT payload: { op: "put", tag, res, sid, len, exp }
GET payload: { op: "get", tag, res, ver, inc, exp }
token       = base64url(payload-json) + "." + base64url(hmac)
```

The HMAC secret is a 32-byte random value minted at start; restart
invalidates outstanding tokens (TTL is short — 5 min default — and clients
re-handshake over WS). PUT tokens are single-use (`commitPut` deletes the
staging row keyed by `sid`, so a replay hits `410 Gone`); GET tokens are
multi-use within TTL but only ever yield AEAD ciphertext. (`inc` =
incarnation; the GET re-checks it so a token can't serve a recreated
incarnation that reuses the version number.)

In a multi-replica deployment the secret MUST be the shared
`OBJSTORE_TOKEN_SECRET` (required + fail-fast in Neon mode, see above) so a
token minted on one replica — including via the `POST` fetch-mint — verifies
on any other. The per-process random secret is the single-process (SQLite)
default, where mint and serve are always the same process.

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

**Storage.** Metadata lives in two tables (SQLite or Neon Postgres);
bytes live in a separate blob backend (local FS or Vercel Blob), keyed by
the same content-addressed path in both:

```
workspace_object (
  workspace_tag, resource_tag,
  version,                    -- monotonic per (tag, resource)
  incarnation,                -- minted per lineage; lets the commit CAS
                              --   tell a recreated row from a stale prev
  content_hash, content_length, signature, put_at,
  PRIMARY KEY (workspace_tag, resource_tag)
)

workspace_object_staging (
  workspace_tag, resource_tag, staging_id,
  prev_version, prev_incarnation,   -- expected-live precondition
  expected_length, content_hash, signature, begun_at,
  PRIMARY KEY (workspace_tag, resource_tag, staging_id)
)

${workspaceTag}/${contentHash}.bin           -- live (content-addressed)
${workspaceTag}/.staging/${stagingId}.bin    -- in-flight
```

Same columns, primary keys, and value-domain `CHECK` constraints
(`version >= 0`, `content_length >= 0`, …) in both modes. The difference
is type enforcement: SQLite adds `STRICT` for column types
(`server/objstore/store.ts`), while Neon relies on native Postgres types
(`BIGINT`, etc.) and carries the same `CHECK`s
(`server/objstore/store-neon.ts`).

The byte path is `${OBJSTORE_DIR}/…` on the FS backend and a private
Vercel Blob pathname on the Neon backend; consumers (`store`, `rest`,
`reaper`) go through a backend-agnostic `BlobBackend` interface
(`server/objstore/blob.ts`). Bytes live outside the metadata store to keep
multi-MB blobs off the DB path. Live blobs are content-addressed, so the
row's `content_hash` literally names its blob — a metadata-vs-bytes desync
is impossible and commit is a plain version compare-and-set. Ordering is
asymmetric so a crash leaves at most a stranded blob (GC'd by the reaper),
never a row pointing at missing bytes:
- PUT: durable staging bytes → promote to live → DB version-CAS. FS does
  this with `fsync → rename → fsync(parent)`; Vercel with atomic
  `copy → del(staging)`.
- DELETE: `DB row drop`; the unreferenced blob is GC'd by the reaper (not
  unlinked inline) so it can't race a commit or an in-flight GET.

The reaper runs once at startup (before accepting traffic) then every
`OBJSTORE_REAP_INTERVAL_MS`. Stale staging rows and unreferenced live
blobs expire after `STAGING_TTL_MS_DEFAULT` (1h) — the grace window that
keeps a just-promoted blob from being collected mid-commit.

Setting `OBJSTORE_REAP_DISABLED=1` (or `=true`) turns the reaper **off
entirely** — no startup sweep and no periodic GC. Since live-blob
reclamation lives solely in the reaper (DELETE and superseded commits only
drop/orphan the row; see above), nothing then collects orphaned bytes or
stale staging rows and they grow unbounded. Only use it when an external
job owns GC — e.g. a scheduled task calling `reapOrphans(handle)` directly,
which is stateless, lock-free, and safe to run concurrently with live
traffic and across replicas. The server logs a loud warning at boot when
the reaper is disabled.

#### Vercel Cron reaper

`api/reap.ts` + `vercel.json` ship that external GC job for Neon + Vercel
Blob deployments — for running serverless (no long-lived process to host the
periodic sweep) or for a long-lived relay with `OBJSTORE_REAP_DISABLED=1`.
The function opens its own objstore handle (the Neon HTTP callable is
stateless — no relay boot) and runs one `reapOrphans` sweep per invocation;
Vercel Cron triggers it on `vercel.json`'s `schedule` (default every 10
min, matching `OBJSTORE_REAP_INTERVAL_MS` — note the Vercel **Hobby** plan
caps cron at once/day, **Pro** allows any cadence).

Required env on the deployment:

- **`CRON_SECRET`** — Vercel sends it as `Authorization: Bearer <secret>` on
  cron invocations; the endpoint **fails closed** (401) without a match, so
  the GC endpoint can't be triggered by arbitrary callers. A 401 in the cron
  logs means it wasn't set.
- **`DATABASE_URL`** + **`BLOB_READ_WRITE_TOKEN`** — same Neon + Vercel Blob
  config as the relay (the endpoint 500s `not-configured` without them).

`reapOrphans` being lock-free + idempotent means the cron can run alongside
a still-enabled in-process reaper or other replicas without coordination —
worst case is redundant, harmless work.

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

(SQLite DDL shown; Neon uses the same columns/constraints with Postgres
types — `BIGINT` etc. — and no `STRICT`.) On SQLite, WAL mode +
`synchronous = FULL` give concurrent readers, crash-safe writes, and an
fsync per commit so the `workspace-save-ack` is a real durability promise;
on Neon, durability is Postgres-native.

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
| Save dropped by inflight cap | `workspace-save-error { busy }` before the handler IIFE | Open | Client clears `pending`, re-arms `pendingSave`, and schedules a timed retry (~2 s); no `session.error` (recoverable). |
| Save `base` ≠ server head | `workspace-state` catch-up then `workspace-save-error { stale-base }` | Open | `handleChain` clears `pending` first; recoverable (catch-up rebases). Catch-up EMPTY or inapplicable (this deployment no longer has the client's base — wiped/migrated DB, rebuilt chain) → client re-anchors with one full-state push at `base=null` (CAS-rejected if the chain in fact survives); a repeat within the recovery cycle errors the session (the one-shot re-arms on ack / applied chain / reconnect). |
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
traffic patterns (size, timing, edit cadence per tag), synthesise garbage
revisions — which clients reject on signature verification and recover
from via the gap re-subscribe / full-state-push ladder — and **equivocate**:
serve different subscribers divergent views of one chain (truncated for
one peer, current for another). Clients verify each revision's content
and continuity but have no cross-client view of global consistency, so a
forked view persists until the relay shows both peers the same chain
again; keyframes then converge each peer to whatever chain it was shown.
Within a single honest deployment forks can't arise (the gated INSERT
linearises the chain) — equivocation is purely a malicious/compromised
relay behaviour, listed here so the trust boundary is explicit.

## License

MIT.
