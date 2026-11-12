# DeepView triage-sync server

A small WebSocket relay for DeepView clients that share a workspace seed.
It syncs their per-finding triage (color, deleted, comment, fix) and exchanges encrypted bundle and report blobs.
Encryption and Ed25519 signing happen on the client.
The server only stores and routes opaque ciphertext.
It cannot read, forge or re-attribute anything.

Requires **Node ≥ 24.14** (built-in `node:sqlite`, WebCrypto Ed25519, and native `.ts` execution with no flags).

> This README covers the **end-to-end-encrypted** relay (untrusted server).
> For the **trusted** managed server — GitHub login, server-decided
> visibility, and attributed triage — see
> [`server-managed/README.md`](../server-managed/README.md) and its protocol
> spec [`MANAGED.md`](../server-managed/MANAGED.md).

## Quick start

```sh
pnpm install
pnpm server          # ws://127.0.0.1:8765/api/sync
```

The server creates the SQLite file on first run.
Nothing else is needed.

## Server entry points

`pnpm server` is an alias for `pnpm server-e2e`.
The `server-e2e` and `server-managed` scripts run their own `index.ts` files independently.
From a checkout, the root launcher can run either server or both:

```sh
node cli.js --mode e2e          # default when --mode is omitted
node cli.js --mode managed
node cli.js --mode managed-e2e
node cli.js --mode e2e-managed
```

`cli.js` registers the TypeScript loader and starts `server.ts`, which parses the arguments and selects the server.
Importing or executing `server.ts` directly does not register a loader or start listening.

The published `triage-server` command runs the same launcher and accepts the same `--mode` values.
`triage-e2e-server` and `triage-managed-server` run the individual servers directly.

To embed any mode, initialize it once during host startup.
`init({ mode })`, or its shorthand `init(mode)`, returns an unbound Node HTTP server with its request and upgrade listeners installed:

```js
import { init } from '@preventive/triage/server'

const httpServer = await init({ mode: 'managed-e2e' })
const [triageRequestListener] = httpServer.listeners('request')
const [triageUpgradeListener] = httpServer.listeners('upgrade')
```

By default the server also serves the UI from `out/`, which initialization reads and compresses.
Pass `ui: false` (`init({ mode, ui: false })`) to serve only the API.
Then `out/` is never read, and requests outside `/api/` answer 404.
The host serves `out/` itself, and in managed modes it also serves `index.html` at the page URLs.
When the server serves that file, it rewrites the file's `./` asset URLs to absolute ones (deep page URLs need this) and adds the `DEEPVIEW_SCAN_SERVER` origin to its `connect-src`.
A host that serves the file unchanged does neither.

For an installed package, run the host with `node --import @preventive/triage/strip-types-loader host.js` so Node can load TypeScript from `node_modules`.
From a checkout, import `./server.ts` instead.
The e2e entry point `@preventive/triage/server-e2e` exports an already initialized `httpServer`.

Attach those listeners to your host server, or call `httpServer.listen(...)` yourself.
The supported modes match `--mode`.
Managed-only mode has no upgrade listener.
Each initialization opens its own storage handles and starts maintenance, without binding a port or installing process handlers.
Only `cli.js` calls the root `start()`.
Standalone launchers own signals and exit codes.
Embedded hosts receive server errors through the server's `error` event.

Invalid configuration rejects `init(mode)`, so the host can correct it and retry.
Neon configuration and driver checks run before storage opens.
If a later assembly step fails, initialization releases the resources it acquired and waits for pending maintenance before it rejects.
Retries therefore leave no background work or database handles behind.

In every mode, await `httpServer[Symbol.asyncDispose]()` on teardown.
Without exiting the host, disposal:

- closes live WS and SSE connections;
- drains tracked work;
- stops maintenance and pubsub;
- closes all enabled databases.

Disposal also works when the listeners are mounted on another server: the host's listener stays open, and disposed API handlers reject new work.
Disposal is idempotent, and `init(mode)` can create a fresh instance afterwards.
A server `close` or `error` event also starts cleanup; await async disposal to wait for it to finish.
The host remains responsible for closing its own HTTP server.

Combined modes use one HTTP server on `HOST`/`PORT`.
It serves the managed HTTP routes alongside the existing e2e HTTP, WebSocket and SSE routes.
Only `/api/config` is shared.
It advertises `managed+e2e` or `e2e+managed`, and the first mode listed is the one the client selects on each reload.
Managed has no live transport of its own.

Managed modes require `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` and `OAUTH_CALLBACK_URL`.
For local HTTP development, set `SESSION_COOKIE_NAME` to a name without the `__Host-` prefix.
Combined mode uses `DB_PATH` for e2e and `MANAGED_DB_PATH` for managed (default `server-managed/data/managed.db`).
The two must be different files.
Standalone managed still accepts `DB_PATH`, and `MANAGED_DB_PATH` takes precedence when set.
Managed reports, bundles and avatars live beside its database.

Managed and combined servers also serve the built UI with nested page URLs.
See [managed navigation](../doc/navigation.md) for the page list and mode-switch behavior.
E2E page navigation is unchanged.

Set `GITHUB_NEW_ISSUE_LABELS` to a comma-separated list of extra labels for prefilled GitHub issue forms, for example `team,needs-review`.
The server advertises the value through `/api/config` and the WebSocket/SSE `server-info` frame, including on combined deployments.
The client adds `deepview` and, for security findings, `security`, then trims and deduplicates the labels.
Labels stay runtime configuration and are not saved in local storage.

## Storage backends

For the full standalone/combined backend matrix and sharing constraints, see [storage separation between e2e and managed](../server-common/STORAGE.md).

The e2e server supports **two storage backends**.
Each pairs a metadata store with a byte (blob) store.
Whether `DATABASE_URL` or `E2E_DATABASE_URL` is set decides the backend, and the two halves cannot be mixed and matched:

| Mode                 | Metadata          | Blob bytes                  | Topology         |
| -------------------- | ----------------- | --------------------------- | ---------------- |
| **SQLite** (default) | SQLite at `DB_PATH` | local FS at `OBJSTORE_DIR` | single-process   |
| **Neon**             | Neon Postgres     | Vercel Blob Private Storage | multi-instance   |

Neon mode shares its database and bytes consistently across instances.
Cross-instance real-time broadcasts ride a dedicated Postgres LISTEN/NOTIFY bus.
A commit that lands on instance A reaches subscribers on instance B with the same latency the hub gives peers on the same instance.
See "Cross-instance broadcasts" in the Neon section.

| Env var                | Default               | Notes                                          |
| ---------------------- | --------------------- | ---------------------------------------------- |
| `PORT`                 | `8765`                |                                                |
| `HOST`                 | `127.0.0.1`           |                                                |
| `DEBUG`                | —                     | `DEBUG=1` logs every message                   |
| `DB_PATH`              | `server-e2e/data/data.db` | SQLite mode only                               |
| `OBJSTORE_DIR`         | `objstore/` next to `DB_PATH` | SQLite mode only — on-disk blob bytes          |
| `DATABASE_URL`         | —                     | Shared Neon URL for all enabled modes; excludes per-mode URLs |
| `E2E_DATABASE_URL`     | —                     | E2e-specific Neon URL; cannot be combined with `DATABASE_URL` |
| `BLOB_READ_WRITE_TOKEN`| —                     | Neon mode, **required** — Vercel Blob R/W token |
| `OBJSTORE_TOKEN_SECRET`| —                     | Neon mode, **required** — shared HMAC secret    |
| `OBJSTORE_REAP_INTERVAL_MS` | `600000` (10 min) | orphan-reaper period                       |
| `OBJSTORE_REAP_DISABLED` | —                   | `1` / `true` disables automatic sweeps; explicit `/api/reap` remains available |
| `TRUST_PROXY`          | on for loopback `HOST` | any non-loopback bind behind a proxy — set `1` (see below) |

## SQLite mode (default)

SQLite holds the metadata and the local filesystem holds the blob bytes.
This mode needs no extra dependencies and no configuration, and suits single-process, single-machine deployments.
`pnpm server` gives you this mode out of the box.

This mode is **single-process**.
`OBJSTORE_DIR` is a local directory, so a `PUT` on one process and a `GET` on another would not see the same bytes.
Run exactly one server instance.
For a multi-instance deployment, use Neon mode below.

## Neon mode (multi-instance)

Neon Postgres holds the metadata and Vercel Blob Private Storage holds the bytes.
Both are serverless and HTTP-backed, so no shared filesystem is needed and the relay can run as several instances behind a load balancer.
Install the two optional drivers and set the required env vars:

```sh
pnpm add @neondatabase/serverless @vercel/blob

DATABASE_URL=postgres://user:pass@<project>.neon.tech/db \
BLOB_READ_WRITE_TOKEN=vercel_blob_rw_xxx \
OBJSTORE_TOKEN_SECRET=$(node -e 'console.log(require("crypto").randomBytes(32).toString("base64"))') \
TRUST_PROXY=1 HOST=0.0.0.0 \
  pnpm server
```

`DATABASE_URL` selects the same Neon database for both enabled modes.
To configure them separately, unset it and set `E2E_DATABASE_URL` and `MANAGED_DATABASE_URL`.
Combined mode requires both per-mode URLs or neither, and it rejects mixed Neon/SQLite backends.
Standalone mode uses only its own URL.
Global and per-mode URLs cannot be combined, even if their values match.

When an e2e database URL is set, `DB_PATH` and `OBJSTORE_DIR` are ignored.
The server then **fails fast at boot** if any required companion is missing:

- **`BLOB_READ_WRITE_TOKEN`**: the Vercel Blob R/W token.
  It is mandatory because local-FS bytes cannot back a multi-instance deployment: one instance's writes would not be visible to another.
  All blobs are written with `access: 'private'`, so the URL alone never fetches them.
- **`OBJSTORE_TOKEN_SECRET`**: a shared HMAC secret (base64, 32 bytes).
  It lets the short-TTL REST bearer tokens minted on one instance validate on any other.
  Without it, each instance would mint its own per-process secret, and cross-instance byte transfers would fail with 401.
- **`TRUST_PROXY=1`**: makes the same-origin gate honour `X-Forwarded-Host` and `X-Forwarded-Proto` instead of the internal container hostname.
  Without it, every browser request behind a load balancer or TLS terminator gets 403.
  This is not Neon-specific: in *any* mode the gate (`server-common/origin.ts`) defaults on for a loopback `HOST` and off otherwise.
  So a SQLite deployment on a public bind behind a proxy needs it too.
  Neon mode just also **fails fast at boot** when it is missing on a non-loopback `HOST`, where a SQLite deployment would silently answer 403 instead.
  Set `TRUST_PROXY=0` only if you really terminate TLS in the container with no proxy.

The drivers are `optional` peer deps, and `pnpm-workspace.yaml` sets `autoInstallPeers: false`, so a SQLite deployment never installs them.

### Cross-instance broadcasts (Postgres LISTEN/NOTIFY)

The WS fan-out is still an in-memory subscriber map (`server-e2e/hub.ts`).
Neon mode adds a Postgres LISTEN/NOTIFY bus (`server-e2e/pubsub.ts`) beside it, so live broadcasts also reach peers on *other* instances.
Each commit fans out twice: first locally over the in-memory map, then onto the bus.
The receiving instance fans it out again into its own subscriber map.
So a client on instance A gets a real-time `workspace-state` push for a commit that landed on instance B, with no reconnect and no chain re-pull on the hot path.

The bus uses one dedicated long-lived `Client` (WebSocket-based) per instance from `@neondatabase/serverless`.
Queries go over the HTTP `neon()` callable, which is stateless and cannot `LISTEN`; the `Client` form is session-bound.
Postgres delivers `NOTIFY` back to publishers that `LISTEN` on the same channel, so each instance uses a per-process random sender id to skip its own notifications.

Payload-size budget: Postgres caps `NOTIFY` payloads at about 8 KB (`NAMEDATALEN`-derived, and not raisable on a managed endpoint).
The `workspace-state` envelope carries a ciphertext of up to `MAX_CIPHERTEXT_LEN` (2 MiB).
So for the size-unbounded paths the bus ships *hints*, and the receiver re-fetches the row from the shared database.

Bus envelopes are JSON.
The field names below are the literal keys in the `pg_notify` payload, kept short to stay well clear of the 8 KB budget.
Each envelope also carries a per-process `sender` for the self-filter.

- `rev` (revision committed): `{kind:"rev", tag, id}`.
  The receiver selects the row from `workspace_revision` by `(tag, id)` and broadcasts `workspace-state`.
- `objput` (objstore PUT committed): `{kind:"objput", tag, res}`, where `res` is the resourceTag.
  The receiver selects from `workspace_object` by `(tag, res)` and broadcasts `objstore-put`.
- `objdel` (objstore DELETE committed): `{kind:"objdel", tag, res, ver, incarnation}`, where `res` is the resourceTag and `ver` is the version.
  The data is inline because the row is gone from `workspace_object` after the commit.
  The bus payload is the wire data, and no fetch happens.
  Only messages from older relay instances omit `incarnation`.

The bus is best-effort fan-out, not a durability layer.
A dropped publish only means that peers on *other* instances miss the live push for that one event.
They still catch up from the shared database (chain re-pull) on their next subscribe or reconnect.
Transient transport failures reconnect with exponential backoff.
Publishes during the down window are dropped.

<details>
<summary>Neon latency &amp; multi-instance fork-safety</summary>

- **Latency:** each save makes 2 HTTP round-trips to Neon: a duplicate precheck, then one pipelined transaction with the gated INSERT and the dup and head checks.
  At about 30–80 ms RTT that is about 60–160 ms per save, against sub-millisecond on SQLite.
  That is fine for triage-edit cadence; size for it if you expect bursty writes.
- **Multi-replica writes:** `commitRevision` takes no write lock.
  Fork-safety rests on Postgres READ-COMMITTED single-statement snapshots and the `UNIQUE(workspace_tag, seq)` PK.
  This is sound by construction but not yet covered by an automated cross-replica test, because the PGlite test backend is single-connection.
  Confirm it with a real-Postgres concurrency test before relying on multi-instance writes in production.
- **Blob crash-safety:** the Vercel backend mirrors the FS ordering with copy and delete instead of fsync and rename: `put(staging) → copy(→ live) → DB version-CAS → del(staging)`.
  A crash at the worst moment leaves at most a stranded blob, which the reaper collects after the grace window.
  It never leaves a row that points at missing bytes.

</details>

## Authentication

The server verifies every signed message against its `workspaceTag` (the Ed25519 public key) before any state changes.
It silently drops invalid signatures.
A seed holder retries, and an attacker who only learned the tag cannot get past verification.
Save, subscribe and each objstore op use distinct signing-domain prefixes, so a signature cannot be replayed across message types or protocols.

### Optional password gate

The relay can put **the first action against a never-before-seen workspace tag** behind a shared password.
To set one, copy the example config:

```sh
cp server-e2e/config.example.json server-e2e/config.json
```

```json
{ "password": "your-shared-secret" }
```

`config.json` is git-ignored.
`null` or a missing file disables the gate, which is the default with no config.
The gate only stops strangers from creating *new* workspaces on a shared relay.
The per-message signature controls access to existing workspaces, and subscribes are never gated.

<details>
<summary>Gate semantics, wire shape &amp; password comparison</summary>

The gate fires on the first signed `workspace-save` or `objstore-put-begin` for a tag that has no rows in either `workspace_revision` or `workspace_object`.
Every other signed action bypasses it.
`workspace-subscribe` is never gated, on purpose: a subscribe to an unknown tag returns an empty chain, and confirming absence leaks nothing.

**Concurrent-creation race (accepted).**
`workspaceExists` reads at a different moment than the commit.
Under concurrent saves on a fresh tag, an unauthenticated socket may see "exists" (a peer's commit landed between check and commit) and skip the gate.
This is accepted because the socket still had to produce a valid signature, so it holds the seed.
The worst case is "two authorised writers", not "a stranger bypasses auth".

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

- `gated` + `workspaceTag` + `base`: a rejected `workspace-save`.
- `gated` + `workspaceTag` + `resourceTag`: a rejected `objstore-put-begin`.
- `auth-failed`: wrong password; the client prompts for a different one.

Authorization is per connection: it is the `Peer.authorized` flag, held in a `WeakMap<WebSocket, Peer>`.
A reconnect re-authenticates.
The client caches the password in memory and persists it in secure-storage under `deepview.sync.password`.
The stored copy is encrypted under the vault key when the passkey vault is on, and plaintext when it is off.
So the user sees the prompt only once per page load or password change.

Password comparison computes HMAC-SHA-256 on both sides under a per-process random key (32 bytes minted at boot, never persisted).
It then runs `crypto.timingSafeEqual` on the two 32-byte digests.
Fixed-length inputs close the length-leak window.
Any remaining timing variance reveals only HMAC bytes, which are useless without the per-process key.

</details>

## URL layout

One `http.Server` handles everything under `/api/*`.
So a fronting proxy can route with a single location block (`/api/*` → relay, `/*` → static UI bundle).

- `ws://${host}/api/sync`: WebSocket upgrade; the triage-sync wire protocol flows over it.
- `POST /api/sync/sse`: the SSE+POST fallback transport, for corporate proxies that strip the `Upgrade` header.
  It carries the same wire protocol, with upstream frames batched into POSTs and a long-lived `text/event-stream` downstream.
- `POST /api/sync/save`: the session-independent save plane, the SSE-mode alternative to the in-band `workspace-save` frame.
  The JSON body is the same signed save frame, and it runs through the SAME pipeline.
  The save canonical binds no connection nonce, so it verifies on its own.
  The save is committed and broadcast WITHOUT taking over the client's SSE event-stream (every in-band SSE POST reopens the stream).
  See the status table below.
- `/api/objstore/{workspaceTag}/{resourceTag}`: REST `PUT`/`GET` byte transfer for the object store, plus the signed `POST` mint (see "REST endpoints & tokens").
- `GET /api/config`: this server's `server-info` as JSON.
- `GET /api/reap`: explicit orphan cleanup (see "Quotas, truncation invariant & storage layout").
- `POST /api/npm-advisories`: same-origin proxy for the npm registry's bulk advisories endpoint (`server-e2e/npm-proxy.ts`).
- Paths outside `/api/`: the static UI bundle, unless `ui: false`.
- Any other URL: `404 not-found` (JSON body).

`POST /api/sync/save` reports its outcome as a JSON body and HTTP status:

| Status | Body | Meaning |
|---|---|---|
| `200` | `{ ok, id }` | Committed, or a replay of a committed save. |
| `409` | `{ reason:'stale-base', revisions }` | The head moved; `revisions` is the catch-up to rebase on. |
| `413` | `{ reason:'too-large' }` | The ciphertext is over 2 MiB. |
| `401` | `{ reason:'unauthorized' }` | The new-workspace gate fired. |
| `400` | `{ reason:'bad-request' }` | Malformed body, invalid field shape or bad signature. |

In SSE mode the client POSTs here and falls back to the in-band frame on `401`.
Broadcasts use `except: null`, because there is no socket to exclude.
The originator's own content-addressed echo on its stream is an idempotent no-op.

## Wire protocol

All WS messages are JSON in text frames; binary frames are dropped.
The `nonce`, `ciphertext`, `signature` and `connectionNonce` fields are base64url.
The very first frame the server sends is a per-socket `challenge { nonce }` (16 random bytes).
The client must bind that nonce into every `workspace-subscribe` signature, which blocks cross-connection replay.

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

`workspace-state` carries:

- the initial sync after a subscribe;
- a broadcast when another client commits;
- the stale-base catch-up.

For `from = null` (or an unknown id) the chain starts at the most recent keyframe, so a fresh client does not replay history back to genesis.

</details>

## v1.objstore — bundle + report storage

Two planes share the same listener:

- **WS plane**: control and auth.
  Signed `objstore-put-begin` and `objstore-fetch` mint short-TTL HMAC bearer tokens that authorise a matching REST byte transfer.
  `objstore-delete` stays fully on WS.
- **REST plane**: byte transfer.
  `PUT`/`GET` under `/api/objstore/{workspaceTag}/{resourceTag}` carry the WS-issued token in `Authorization: Bearer …`.
  The bytes stream straight to and from the blob backend (local FS or Vercel Blob).

The split pays off twice.
A 50 MiB upload does not head-of-line block heartbeats or other workspaces' triage chains.
It also avoids the ~33% base64 overhead of a WS text frame.

Unlike triage-sync there is **no history**: PUT upserts and DELETE drops the row.
Upload and fetch are **manual**.
Broadcasts carry only metadata; the bytes need an explicit signed token and a REST round-trip.

<details>
<summary>WS messages</summary>

Client → server:

```
objstore-put-begin {
  workspaceTag,         // base64url Ed25519 public key
  resourceTag,          // base64url, HMAC-derived per (tagKey, fileName)
  prevVersion,          // integer or null — expected current version
  prevIncarnation,      // string or null — expected current incarnation
                        //   (null exactly when prevVersion is null)
  expectedLength,       // total ciphertext bytes (incl. AEAD nonce + tag)
  contentHash,          // base64url SHA-256 of the ciphertext bytes
  signature             // Ed25519 over the canonical PUT payload
}
objstore-delete { workspaceTag, resourceTag, prevVersion, prevIncarnation, signature }
objstore-fetch  { workspaceTag, resourceTag, signature }   // bound to connectionNonce
```

Server → client:

```
objstore-put-token    { workspaceTag, resourceTag, stagingId, urlPath,
                        token, expiresAt }
objstore-fetch-token  { workspaceTag, resourceTag, version, incarnation, contentHash,
                        contentLength, signature, urlPath, token, expiresAt }
objstore-fetch-not-found { workspaceTag, resourceTag }
objstore-deleted-ack  { workspaceTag, resourceTag, deletedVersion }   // 0 = no-op
objstore-put-error    { workspaceTag, resourceTag, reason }   // workspace-full
objstore-delete-error { workspaceTag, resourceTag, reason }   // not-found
objstore-conflict     { action, workspaceTag, resourceTag, current? }

// broadcasts to subscribed peers:
objstore-put          { workspaceTag, resourceTag, version, incarnation, contentHash,
                        contentLength, signature }
objstore-deleted      { workspaceTag, resourceTag, version, incarnation }
```

The canonical signing payloads in `server-e2e/objstore/sign.ts` are the source of truth (`canonicalObjstorePut` / `…Delete` / `…Fetch`, and the REST variants `…PutRest` / `…DeleteRest` / `…FetchRest`).
JSON key order on the wire does not matter, but those builders fix the signed byte order.
`*-error` and `*-conflict` frames are sent after signature verification, so only legitimate signers see them.

</details>

<details>
<summary>REST endpoints &amp; tokens</summary>

All routes match `/api/objstore/{workspaceTag}/{resourceTag}`.
The `PUT` and `GET` byte transfers carry a token in `Authorization: Bearer <token>`, never in the URL, because querystring tokens leak through access logs and the referer.

The `POST` route (`server-e2e/objstore/rest-mint.ts`) is a REST alternative to the WS `objstore-fetch`, `objstore-put-begin` and `objstore-delete` handshakes.
An Ed25519 signature in the JSON body authenticates it, with no live socket and no bearer token.
It lets these ops run independently of the SSE session, so an SSE replica hop cannot interrupt them; the client uses it in SSE mode.
The body's `op` selects the operation:

- `fetch` returns a get-token.
- `put` returns a put-token and a `stagingId`.
- `delete` changes the row in place and returns `{ deletedVersion }`.
  It returns no token, because there are no bytes to move.

`fetch` and `put` return the SAME token shape that the WS path sends for the same `GET` or `PUT` route.

In place of the WS connection nonce, the signature binds a client timestamp `ts`.
The server enforces a ±60 s freshness window and a single-use replay dedup (`server-e2e/objstore/fetch-mint-guard.ts`).
So a retry must re-sign with a fresh `ts` instead of resending the same body.
The `put` op also runs the new-workspace operator gate.
REST has no socket auth state, so a never-seen workspace under a configured password gets 401, and the client falls back to the in-band WS put-begin.
`delete` has no such gate, matching the WS path, because it is signature-gated, idempotent and creates nothing.

Every non-2xx response is a uniform JSON envelope `{ "error": <reason> }`, with the reason words shown below.
The 409 envelope also carries `currentVersion` and `currentIncarnation` so the client can rebase.

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

A token is the base64url JSON payload, a dot, and the base64url HMAC-SHA-256 of that encoded payload:

```
PUT payload: { op: "put", tag, res, sid, len, exp }
GET payload: { op: "get", tag, res, ver, inc, exp }
token       = base64url(payload-json) + "." + base64url(hmac)
```

- PUT tokens are single-use.
  `commitPut` deletes the staging row keyed by `sid`, so a replay gets `410 Gone`.
- GET tokens are multi-use within the TTL, but they only ever yield AEAD ciphertext.
- `inc` is the incarnation.
  The GET re-checks it, so a token cannot serve a recreated incarnation that reuses the version number.
- The TTL is short (5 min by default), and clients re-handshake over WS.

In single-process (SQLite) mode the default HMAC secret is a 32-byte random value minted at start, because mint and serve always happen in the same process.
A restart therefore invalidates outstanding tokens.
In a multi-replica deployment the secret MUST be the shared `OBJSTORE_TOKEN_SECRET`, which Neon mode requires and checks at boot (see above).
Then a token minted on one replica, including through the `POST` mint, verifies on any other.

</details>

<details>
<summary>Lifecycle (client UX contract)</summary>

The client enforces this contract; the server just serves the wire protocol.
It is documented here as the single source of truth.

- **Upload is manual:** signed `objstore-put-begin` → `objstore-put-token` → HTTP `PUT`.
  The `200` body carries `{ version, incarnation, contentHash, contentLength }`, and peers see the metadata through the `objstore-put` broadcast.
- **Fetch is manual:** signed `objstore-fetch` → `objstore-fetch-token` → HTTP `GET`.
- **Delete-from-server, when synced:** send `objstore-delete`, then wait for `objstore-deleted-ack` (success) or `objstore-conflict` / `objstore-delete-error` (failure).
  Prune the local cache only on success.
  This action is disabled while offline.
- **Delete-arrived-from-peer:** when an `objstore-deleted` broadcast arrives and a local copy exists, prompt the user to keep it (and optionally re-upload) or drop it.
  A diff of the `workspace-subscribed` snapshot on reconnect triggers the same prompt.
  The "kept-local" decision is sticky: the dialog must not re-fire on every reconnect.
- **Re-upload after kept-local + delete:** this is just another PUT with `prevVersion = null`.
  Concurrent re-uploads resolve through `objstore-conflict`.

</details>

<details>
<summary>Quotas, truncation invariant &amp; storage layout</summary>

**Quotas**

- Per-workspace resource cap: `MAX_RESOURCES_PER_WORKSPACE = 100` live rows per tag.
  It is enforced at `objstore-put-begin` for NEW resources only; re-uploads of an existing resourceTag never trip it.
  The rejection is `objstore-put-error { reason: 'workspace-full' }`.
- Per-upload byte cap: `MAX_CONTENT_LENGTH = 100 MiB`.
  It is enforced at `objstore-put-begin` and at the REST PUT (Content-Length and on-disk stat).
  There is no per-workspace total-bytes cap yet.

**Truncation invariant.**
A partial or aborted upload MUST NEVER become a live row.
Three layers enforce this:

1. The REST handler aborts with 400 when `received !== declared`.
2. After the upload, a staged `stat().size !== payload.len` gets the same 400.
3. `commitPut` checks the staged size against the signed `expected_length` before it promotes the blob.
   It re-stats the blob unless the REST layer passes in the size it just observed.

Retries get a fresh `stagingId`, so truncated bytes can never be promoted.

**Storage.**
Metadata lives in two tables (SQLite or Neon Postgres).
Bytes live in a separate blob backend (local FS or Vercel Blob), keyed by the same content-addressed path in both:

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

Both modes have the same columns, primary keys and value-domain `CHECK` constraints (`version >= 0`, `content_length >= 0`, …).
They differ in type enforcement.
SQLite adds `STRICT` for column types (`server-e2e/objstore/store.ts`).
Neon relies on native Postgres types (`BIGINT` and so on) and carries the same `CHECK`s (`server-e2e/objstore/store-neon.ts`).

The byte path is `${OBJSTORE_DIR}/…` on the FS backend and a private Vercel Blob pathname on the Neon backend.
Consumers (`store`, `rest`, `reaper`) go through a backend-agnostic `BlobBackend` interface (`server-e2e/objstore/blob.ts`).
Bytes live outside the metadata store to keep multi-MB blobs off the DB path.
Live blobs are content-addressed, so the row's `content_hash` literally names its blob.
A metadata-vs-bytes desync is therefore impossible, and a commit is a plain version compare-and-set.
The ordering is asymmetric, so a crash leaves at most a stranded blob (which the reaper collects), never a row that points at missing bytes:

- PUT: durable staging bytes → promote to live → DB version-CAS.
  FS does this with `fsync → rename → fsync(parent)`.
  Vercel promotes with an atomic `copy` and deletes the staging blob after the CAS.
- DELETE: drops the DB row only.
  The reaper collects the unreferenced blob instead of unlinking it inline, so the delete cannot race a commit or an in-flight GET.

The reaper runs once at startup, before the server accepts traffic, and then every `OBJSTORE_REAP_INTERVAL_MS`.
Stale staging rows and unreferenced live blobs expire after `STAGING_TTL_MS_DEFAULT` (1h).
This grace window keeps a just-promoted blob from being collected mid-commit.

Setting `OBJSTORE_REAP_DISABLED=1` (or `=true`) disables the automatic startup and periodic sweeps.
Explicit cleanup stays available through `GET /api/reap`, authenticated with `Authorization: Bearer <CRON_SECRET>`.
The endpoint fails closed (401) if the secret is unset or incorrect.
Combined servers run both e2e and managed cleanup; standalone servers run only their own mode.
A request waits for all cleanup to finish and returns 500 if any mode fails.

With automatic sweeps disabled, schedule `/api/reap` or another cleanup job.
DELETE and superseded commits leave unreferenced bytes for the reaper to collect.

#### Vercel Cron reaper

`api/reap.ts` and `vercel.json` ship that external cleanup job for Neon + Vercel Blob deployments.
Use it when running serverless (no long-lived process to host the periodic sweep), or for a long-lived relay with `OBJSTORE_REAP_DISABLED=1`.
The function opens its own objstore handle and runs one `reapOrphans` sweep per invocation.
It does not boot the relay, because the Neon HTTP callable is stateless.
Vercel Cron triggers it on `vercel.json`'s `schedule`, by default every 10 min to match `OBJSTORE_REAP_INTERVAL_MS`.
Note that the Vercel **Hobby** plan caps cron at once a day, while **Pro** allows any cadence.

Required env on the deployment:

- **`CRON_SECRET`**: Vercel sends it as `Authorization: Bearer <secret>` on cron invocations.
  The endpoint **fails closed** (401) without a match, so arbitrary callers cannot trigger the cleanup endpoint.
  A 401 in the cron logs means the secret was not set.
- **`DATABASE_URL` or `E2E_DATABASE_URL`**, plus **`BLOB_READ_WRITE_TOKEN`**: the same Neon + Vercel Blob config as the relay.
  Without them the endpoint returns 500 `reap-failed`.

`reapOrphans` is lock-free and idempotent, so the cron can run alongside a still-enabled in-process reaper or other replicas without coordination.
The worst case is redundant, harmless work.

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
  keyframe      INTEGER NOT NULL DEFAULT 0
                CHECK (keyframe IN (0, 1)),  -- 1 if full-state, else 0
  nonce         TEXT NOT NULL,               -- base64url
  ciphertext    TEXT NOT NULL,               -- base64url
  signature     TEXT NOT NULL,               -- base64url
  created_at    INTEGER NOT NULL,            -- ms epoch (debug aid)
  PRIMARY KEY (workspace_tag, seq),
  UNIQUE (workspace_tag, id)                 -- makes retransmits idempotent
) STRICT
```

This is the SQLite DDL.
Neon uses the same columns and constraints with Postgres types (`BIGINT` and so on) and no `STRICT`.
On SQLite, WAL mode and `synchronous = FULL` give concurrent readers, crash-safe writes and an fsync per commit, so the `workspace-save-ack` is a real durability promise.
On Neon, durability is Postgres-native.

`commitRevision` takes **no write lock** on either backend.
A single gated INSERT keeps concurrent saves on one tag fork-safe.
Its head check and its `COALESCE(MAX(seq),0)+1` read one statement snapshot.
So a racer either computes the same `seq` (rejected by the PK) or sees a head that no longer matches (gated out).
The loser gets `stale-base`.
A UNIQUE-violation recovery branch (the `catch` in `server-e2e/db.ts`) re-routes a PK/UNIQUE collision through `revisionExists` and `headFor`.
It emerges as `inserted` or `stale-base`, never as a silent fork.

Coverage is asymmetric.
`tests/server-db.test.js` fully covers SQLite lockless-commit fork-safety.
Neon cross-replica safety rests on the READ-COMMITTED + `UNIQUE(tag, seq)` argument but is not tested empirically, because PGlite is single-connection (see the Neon caveats above).

</details>

## Transport backpressure

Per-socket caps bound resource use under hostile load.
They are not security primitives; the per-message signature is.
They apply across protocols.

- **`MAX_BUFFERED_BYTES = 16 MiB`** of undrained outbound bytes per socket.
  Past the cap the server terminates the socket, and the client reconnects and catches up through the chain.
- **`MAX_INFLIGHT_PER_SOCKET = 64`** in-flight async handlers.
  Saves dropped at the cap surface as `workspace-save-error { reason: 'busy' }`.
  The `MAX_INFLIGHT_PER_SOCKET` env var overrides it, mostly for tests.
- **REST PUT idle-body timeout = 30 s.**
  It aborts a slow-loris trickle instead of holding the staging fd until the staging TTL reaps it.

<details>
<summary>Per-message error handling matrix</summary>

The socket is shared across every open workspace.
Per-message errors are scoped to one session and DO NOT close the WS.
Only transport failures reconnect.

| Failure mode | Server action | Socket | Client recovery |
|---|---|---|---|
| Bad signature on save / subscribe | Silent drop | Open | Legit signer retries; a silent drop sets no `session.error`. Local encrypt/sign failures surface as `'encrypt/sign failed: …'` after `maxConsecutiveFailures` (5). |
| Shape-invalid save field (newline, non-base64) | Silent drop | Open | Same as bad sig — legit clients never produce these. |
| Save ciphertext > 2 MiB (`MAX_CIPHERTEXT_LEN`) | `workspace-save-error { too-large }` after sig verify | Open | Client clears `pending`, sets `session.error`; cleared via `dismissError` or a lifecycle handler (`setServerUrl` to a new URL, `setEnabled(true)`, `setForcedOff(false)`). |
| Save dropped by inflight cap | `workspace-save-error { busy }` before the handler IIFE | Open | Client clears `pending`, re-arms `pendingSave`, and schedules a timed retry (~2 s); no `session.error` (recoverable). |
| Save `base` ≠ server head | `workspace-state` catch-up then `workspace-save-error { stale-base }` | Open | `handleChain` clears `pending` first; recoverable (catch-up rebases). Catch-up EMPTY or inapplicable (this deployment no longer has the client's base — wiped/migrated DB, rebuilt chain) → client re-anchors with one full-state push at `base=null` (CAS-rejected if the chain in fact survives); a repeat within the recovery cycle errors the session (the one-shot re-arms on ack / applied chain / reconnect). |
| `objstore-put-begin` over the 100-resource cap (new resource) | `objstore-put-error { workspace-full }` after sig verify | Open | Re-uploads of existing resourceTags still succeed. |
| Total WS frame > 4 MiB (`maxPayload`) | `ws` closes with 1009 | **Closed** | Reconnects; shouldn't happen given the 2 MiB ciphertext cap. |
| Heartbeat: `ping` → no `pong` in timeout | n/a | **Closed by client** | Reconnects (backoff from 1 s); session flags reset, `session.error` preserved. |
| Graceful shutdown (SIGTERM) | Close 1001 "going away" | **Closed by server** | Reconnects per backoff. |

Boot-blocking errors (an invalid `PORT`, a non-STRICT pre-existing `workspace_revision` table, and so on) fail loudly at startup.

</details>

## What the server can &amp; can't do

The server stores and routes opaque ciphertext.
It **can't**:

- decrypt or modify triage values or blob contents;
- forge writes, because every save, PUT and DELETE needs a valid Ed25519 signature;
- re-attribute a revision to a different `base`, `keyframe` or `id`, or a blob to a different `resourceTag`, because all of these are bound into the signed canonical and the content hash;
- replay a captured subscribe or fetch from another connection, because both bind the per-socket `connectionNonce`.

Like any relay, it **can**:

- drop, reorder or delay messages (DoS);
- observe traffic patterns (size, timing, edit cadence per tag);
- synthesise garbage revisions, which clients reject on signature verification and recover from through the gap re-subscribe / full-state-push ladder;
- **equivocate**: serve different subscribers divergent views of one chain (truncated for one peer, current for another).

Clients verify each revision's content and continuity, but they have no cross-client view of global consistency.
So a forked view persists until the relay shows both peers the same chain again.
Keyframes then converge each peer to whatever chain it was shown.
Within a single honest deployment forks cannot arise, because the gated INSERT linearises the chain.
Equivocation is purely a malicious or compromised relay behaviour, listed here so the trust boundary is explicit.

## License

MIT OR Apache-2.0, at your option: see [LICENSE-MIT](../LICENSE-MIT) and [LICENSE-APACHE](../LICENSE-APACHE).
