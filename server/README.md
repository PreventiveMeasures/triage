# DeepView triage-sync server

A small WebSocket relay that lets DeepView clients sharing a
workspace seed sync their per-finding triage (color, deleted,
comment, fix) without trusting the server with the contents.
Encryption + Ed25519 signing happens client-side; the server only
sees opaque ciphertexts and routes them.

## Run

```
pnpm install
pnpm server                # listens on ws://127.0.0.1:8765/api/sync
PORT=9000 pnpm server      # custom port
DEBUG=1 pnpm server        # log every message
DB_PATH=./mydb.db pnpm server
```

Defaults: `PORT=8765`, `HOST=127.0.0.1`, `DB_PATH=server/data.db`.
The SQLite file is created on first run; nothing else is needed.

### Storage backends

Two interchangeable backends back the same wire protocol — pick one
per deployment:

- **SQLite (default).** Built into Node ≥ 24 via `node:sqlite` (the
  whole project requires Node ≥ 24 — see below). No extra
  dependency, single file at `DB_PATH`. Best for single-process
  / single-machine deployments.
- **Neon Postgres.** Set `DATABASE_URL` to a Neon connection string;
  `DB_PATH` is ignored. Requires the optional peer dependency
  `@neondatabase/serverless`:

  ```
  pnpm add @neondatabase/serverless
  DATABASE_URL=postgres://user:pass@…neon.tech/db pnpm server
  ```

  Both planes (`workspace_revision` for triage-sync and the
  `workspace_object` / `workspace_object_staging` tables for v1.objstore)
  land in the same Neon database. The objstore's BYTES still live on
  local disk under `OBJSTORE_DIR` — multi-MB blobs are not stored in
  the database in either backend.

The peer dep is marked `optional` in `package.json` and the
`pnpm-workspace.yaml` sets `autoInstallPeers: false`, so a SQLite-only
deployment doesn't install it.

> ⚠️ **The v1.objstore byte plane is single-process today.**
> `OBJSTORE_DIR` is local to one process — a `PUT` on replica A
> + `GET` on replica B would 503, and the reaper on replica A
> cannot see replica B's files. The DB layer itself is
> multi-process safe (the per-`workspace_tag` write lock that
> serialises `commitRevision` is in-process, but the DB schema's
> `PRIMARY KEY (workspace_tag, seq)` is the multi-process backstop
> — a sibling process losing the race gets a clean `stale-base`
> outcome via the catch in `commitRevision`, not a silent
> failure). Full multi-process / multi-replica support arrives
> when a shared object-storage backend (S3 or similar) lands for
> the byte plane.

> 📡 **Neon backend latency.** Every `commitRevision` issues 3–5
> HTTP round-trips to Neon (dup check, base check, MAX(seq),
> INSERT, plus the recovery `revisionExists` + `headFor` on a
> unique-violation). At Neon's typical 30–80 ms HTTP RTT that's
> 100–400 ms per save vs sub-millisecond on SQLite — and saves on
> the same `workspace_tag` serialise through the in-process write
> lock, capping per-tag throughput. Acceptable for triage-edit
> cadence; size for it if you expect bursty writes per workspace.
> A future optimisation (CTE / single-round-trip insert) could
> collapse the pre-INSERT reads.

## URL layout

The relay shares one `http.Server` for everything under `/api/*`,
keeping the namespace reserved for backend traffic so a fronting
proxy can route with a single location block (`/api/*` → relay,
`/*` → static UI bundle, no upgrade-header gymnastics).

- `ws://${host}/api/sync` — WebSocket upgrade. Triage-sync wire
  protocol (described below) flows over it.
- Any other URL — `404 not-found` (JSON body). Future feature work
  (e.g. a REST byte-transfer plane) lands under `/api/...` without
  changing this contract.

Requires Node ≥ 24 (uses the built-in `node:sqlite`, WebCrypto
Ed25519, and `--experimental-strip-types` for the `.ts` sources —
default-on in Node 23.6+, no flag needed in 24.x).

## Wire protocol

All messages are JSON over WebSocket text frames. `nonce` /
`ciphertext` / `signature` / `connectionNonce` fields are
base64url. Binary frames are dropped.

### Server → Client (handshake)

The very first frame the server sends after `connection` is the
per-socket challenge — the client has to bind it into every
subsequent `workspace-subscribe` signature, blocking
cross-connection replay of a captured subscribe frame:

```
challenge {
  nonce                // base64url, 16 random bytes (128 bits)
}
```

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

ping                   // application-level liveness probe; no payload needed
```

### Server → Client

```
workspace-subscribed { workspaceTag }
                       // explicit handshake-complete ack, sent BEFORE the
                       // initial chain — lets the UI flip
                       // `connecting → online` only after the server
                       // registered the peer

workspace-save-ack { workspaceTag, base, id }
                       // `id` is content-addressed (SHA-256 of canonical
                       // bytes, base64url no padding) — same id the
                       // client computes from its own canonical

workspace-save-error { workspaceTag, base, reason }
                       // Explicit reject for a SIGNED save the server
                       // chose not to commit. Sent AFTER sig verify, so
                       // only a legit seed-holder receives it (shape /
                       // sig attacks still drop silently). Current
                       // reasons: `too-large` (ciphertext > 2 MiB). The
                       // `base` field echoes the save's base so the
                       // client can attribute the error to the correct
                       // pending save (mismatches are dropped).

workspace-state {
  workspaceTag,
  revisions: [
    { base, id, keyframe, nonce, ciphertext, signature },
    ...
  ]
}

pong                   // reply to `ping`
```

`workspace-state` is used for: initial sync (after a subscribe),
broadcast when another client commits a revision, and stale-base
catch-up when a save's `base` doesn't match the workspace's head.
For `from = null` (or an unknown id), the chain starts at the
most recent keyframe so a fresh client doesn't replay history
back to genesis.

## Authentication

Every signed message is verified against the `workspaceTag` (=
public key) before any state mutation. Invalid signatures are
silently dropped — a holder of the workspace seed will retry, an
attacker who only learned the tag can't get past the verify.

Domain separation: the `save` and `subscribe` signing prefixes
differ (`deepview-triage-sync.v1.save` vs
`deepview-triage-sync.v1.subscribe`), so a captured save sig
can't be replayed as a subscribe and vice versa.

A save's signature does NOT auto-attach the sender as a
subscriber (round-9 H1) — passive observers who captured a
single valid save frame can't replay it from another connection
to silently mirror future encrypted broadcasts.

A subscribe's signature is bound to the per-socket
`connectionNonce` (round-9 H2) — so a captured subscribe frame
can't be replayed from a different TCP connection (the new
connection's nonce is different; the canonical bytes differ;
verify fails).
## v1.objstore — bundle + report storage

Two-plane protocol on the same listener:

- **WS plane** — control + auth. Signed `objstore-put-begin` /
  `objstore-fetch` requests mint short-TTL HMAC bearer tokens that
  authorise a corresponding REST byte transfer. `objstore-delete` /
  `objstore-list` stay fully on WS (no bytes involved). Same Ed25519
  authentication as triage-sync (every signed message verified
  against `workspaceTag`), separate domain prefixes
  (`deepview-objstore.v1.{put,delete,list,fetch}`) so triage signatures
  can't replay across protocols. Canonical signing payloads for each
  message type are the source of truth in `server/objstore/sign.ts`
  (`canonicalObjstorePut` / `canonicalObjstoreDelete` /
  `canonicalObjstoreList` / `canonicalObjstoreFetch`); the WIRE field
  order below is JSON-keyed (order-irrelevant) but the SIGNED canonical
  byte order differs and is fixed by the canonical builders.
- **REST plane** — byte transfer. `PUT` and `GET` under
  `/api/objstore/{workspaceTag}/{resourceTag}` with the WS-issued token
  in `Authorization: Bearer …`. The HTTP server streams the body to
  / from disk via `fs.createReadStream` / `createWriteStream`,
  staying out of the WS message loop entirely.

Two-plane separation is the win: a 50 MiB bundle upload doesn't
head-of-line block heartbeats, peer broadcasts, or other workspaces'
triage chains, and we don't pay the ~33% base64 overhead the WS
text-frame path would impose.

The same broadcast subscriber set (peers attached via
`workspace-subscribe`) receives `objstore-put` and `objstore-deleted`
broadcasts after a successful REST commit / WS DELETE.

Two semantic differences from triage-sync:

- **No history.** PUT upserts; DELETE drops the row outright. New
  subscribers receiving the live set never learn that a deleted
  resource existed.
- **Manual upload, manual fetch.** Broadcasts only carry metadata
  (size, hash, signature); the bytes ride a separate signed token
  + REST round-trip the user explicitly initiates.

### WS messages

Client → server:

```
objstore-put-begin {
  workspaceTag,         // base64url Ed25519 public key
  resourceTag,          // base64url, HMAC-derived per (tagKey, fileName)
  prevVersion,          // integer or null — server's expected current version
  expectedLength,       // total ciphertext bytes (incl. AEAD nonce + tag)
  contentHash,          // base64url SHA-256 of the ciphertext bytes
  signature             // Ed25519 over the canonical PUT payload
}

objstore-delete {
  workspaceTag, resourceTag, prevVersion, signature
}

objstore-list {
  workspaceTag,
  signature             // bound to per-socket connectionNonce (replay protection)
}

objstore-fetch {
  workspaceTag, resourceTag,
  signature             // bound to per-socket connectionNonce
}
```

Server → client:

```
objstore-put-token    { workspaceTag, resourceTag, stagingId, urlPath,
                        token, expiresAt }
                        // present the token at PUT urlPath to upload bytes
objstore-fetch-token  { workspaceTag, resourceTag, version, contentHash,
                        contentLength, signature,
                        urlPath, token, expiresAt }
                        // metadata + GET capability
objstore-fetch-not-found { workspaceTag, resourceTag }
objstore-deleted-ack  { workspaceTag, resourceTag, deletedVersion }
                        // deletedVersion=0 = no-op (already absent)
objstore-put-error    { workspaceTag, resourceTag, reason }
                        // reasons: `workspace-full` — the workspace
                        // already holds MAX_RESOURCES_PER_WORKSPACE
                        // (100) live rows and this is a NEW resource.
                        // Re-uploads of an existing resourceTag aren't
                        // capped. (See "Quotas" below.) Sent AFTER
                        // sig verify, so only reaches a legit signer.
objstore-delete-error { workspaceTag, resourceTag, reason }
                        // current reasons: `not-found` — the resource
                        // never existed and the caller passed a
                        // non-null `prevVersion` (a null-prevVersion
                        // delete of a missing resource is idempotent
                        // success, not an error). Other reasons may
                        // be added; the wire shape is stable. Sent
                        // AFTER sig verify, same legit-signer-only
                        // contract as `objstore-put-error`.
objstore-conflict     { action, workspaceTag, resourceTag, current? }
                        // current echoes the server's live row when the
                        // conflict is a version race; absent on the
                        // never-existed-yet path
objstore-list-result  { workspaceTag, resources: [...] }

// broadcasts to subscribed peers (PUT broadcast on REST commit;
//                                 DELETE broadcast on WS handler):
objstore-put          { workspaceTag, resourceTag, version, contentHash,
                        contentLength, signature }
objstore-deleted      { workspaceTag, resourceTag, version }
```

### REST endpoints

Both routes match `/api/objstore/{workspaceTag}/{resourceTag}`. The
token in `Authorization: Bearer <token>` carries the auth — the
URL never includes it (querystring tokens leak through access logs
and browser referer).

```
PUT  /api/objstore/{workspaceTag}/{resourceTag}
  Headers:    Authorization: Bearer <put-token>
              Content-Length: <expectedLength>
              Content-Type:   application/octet-stream
  Body:       raw ciphertext bytes (matches expectedLength exactly)
  Responses:
    200 { version, contentHash, contentLength }    — committed
    400 { error: "length-mismatch" }               — Content-Length ≠ token's expectedLength
                                                     OR on-disk size mismatch after stream
    400 { error: "aborted" }                       — pipe failure mid-body (client drop, overrun)
    401 { error: "unauthorized" }                  — missing / bad / expired token
    405 { error: "method-not-allowed" }            — token op ≠ method (put-token used as GET, etc.)
    409 { error: "conflict" }                      — prev_version raced (peer commit / delete landed)
    410 { error: "gone" }                          — staging row dropped (TTL, abort, racing commit)
    411 { error: "length-required" }               — missing / non-integer / > 100 MiB Content-Length
    500 { error: "io-error" }                      — fsync / rename / parent-fsync / stat failure
    500 { error: "internal" }                      — uncaught exception in the PUT handler

GET  /api/objstore/{workspaceTag}/{resourceTag}
  Headers:    Authorization: Bearer <get-token>
  Responses:
    200 (Content-Type: application/octet-stream)   — body = raw ciphertext
    401 { error: "unauthorized" }                  — missing / bad / expired token
    404 { error: "not-found" }                     — version mismatch / resource deleted
    405 { error: "method-not-allowed" }            — token op ≠ method
    500 { error: "internal" }                      — uncaught exception in the GET handler
    503 { error: "unavailable" }                   — live row present, file missing / size diverged
```

Tokens are HMAC-SHA-256 over a JSON payload, base64url, dot-joined
to the payload bytes:

```
PUT payload: { op: "put", tag, res, sid, len, exp }
GET payload: { op: "get", tag, res, ver, exp }
token       = base64url(payload-json) + "." + base64url(hmac)
```

The HMAC secret is a 32-byte random value minted at server start.
Restart invalidates every outstanding token — fine, since TTLs are
short (default 5 min) and clients re-handshake via WS.

PUT tokens are single-use by construction: `commitPut` deletes the
staging row keyed by `sid`, so a replayed PUT with the same token
hits a missing staging row and returns `410 Gone`. GET tokens are
multi-use within their TTL — the bytes are AEAD'd ciphertext the
relay can't read; a leaked GET token + captured ciphertext gives
no plaintext.

### Lifecycle (client UX contract)

These rules are enforced by the client; the server is unaware of
"local copies" and just serves the wire protocol. They're documented
here so the client implementation has one source of truth.

- **Upload is manual.** Client never auto-uploads on local change.
  Two-step: signed WS `objstore-put-begin` → receive
  `objstore-put-token` → HTTP `PUT` to `urlPath` with the bearer.
  The 200 response body carries `{ version, contentHash }`; peers
  see the metadata via the `objstore-put` WS broadcast.
- **Fetch is manual.** Subscribers see metadata in
  `objstore-put` broadcasts. To download: signed WS `objstore-fetch`
  → receive `objstore-fetch-token` → HTTP `GET` to `urlPath` with
  the bearer.
- **Delete-from-server, when synced.** A client that holds a local
  copy and wants to remove the resource sends `objstore-delete`,
  waits for `objstore-deleted-ack` (success) or `objstore-conflict`
  / `objstore-delete-error` (failure), and only on the success
  path prunes its local cache. Optimistic local-prune before the
  ack would lose data on rejection (version race, transport drop).
  This rule applies only when the client is synced — when offline,
  the "delete from server" affordance is gated off; pure local-copy
  housekeeping is independent and not covered by the protocol.
- **Delete-arrived-from-peer.** A client receiving an
  `objstore-deleted` broadcast (or noticing a server-side absence
  on a reconnect `objstore-list` diff) prompts the user when a
  local copy exists: keep-and-optionally-reupload, or drop-local.
  The "kept-local" decision is sticky — the dialog must not re-fire
  on every reconnect once recorded.
- **Re-upload after kept-local + delete.** Just another PUT.
  `prevVersion` is `null` (the row is gone server-side); concurrent
  re-uploads from multiple peers race on `prevVersion = null` and
  resolve via the usual `objstore-conflict` echo.

### Quotas

- **Per-workspace resource cap.** `MAX_RESOURCES_PER_WORKSPACE = 100`
  live rows per `workspace_tag`. Enforced at `objstore-put-begin`
  for NEW resources only — re-uploads of an existing `resourceTag`
  (new version of the same row) never trip the cap. Rejection wire:
  `objstore-put-error { reason: 'workspace-full' }`, sent post-sig
  so only legit signers see it.
- **Per-upload byte cap.** `MAX_CONTENT_LENGTH = 100 MiB`. Enforced
  at both `objstore-put-begin` (rejects oversize `expectedLength`)
  and at the REST PUT (`Content-Length` gate + on-disk stat after
  upload). No per-workspace total-bytes cap yet — future work paired
  with GitHub-auth-per-account quotas.

### Truncation invariant

A partial / mid-aborted upload MUST NEVER become a live row. Enforced
at three layers:

1. REST handler tracks `received` byte count; `received !== declared`
   → 400 `length-mismatch`, staging row + file aborted.
2. Post-upload `stat(stagingPath).size !== payload.len` → same abort.
3. `commitPut` re-stats under the per-resource lock; mismatch → bail
   BEFORE the rename. (Last line of defense — if layers 1+2 were ever
   bypassed, this final check still gates the promotion.)

Clients may retry a failed upload under the same `resourceTag`. The
retry gets a fresh `stagingId` (server-generated, unique per begin),
so its staging file path is distinct from the truncated original's.
The truncated bytes can never appear in the live file: only the
retry's complete, stat-verified bytes get renamed in.

### Storage

Two SQLite tables and a filesystem tree:

```
workspace_object (
  workspace_tag  TEXT NOT NULL,
  resource_tag   TEXT NOT NULL,
  version        INTEGER NOT NULL,    -- monotonic per (tag, resource)
  content_hash   TEXT NOT NULL,
  content_length INTEGER NOT NULL,
  signature      TEXT NOT NULL,
  put_at         INTEGER NOT NULL,
  PRIMARY KEY (workspace_tag, resource_tag)
) STRICT

workspace_object_staging (
  workspace_tag, resource_tag, staging_id,
  prev_version, expected_length,
  content_hash, signature, begun_at,
  PRIMARY KEY (workspace_tag, resource_tag, staging_id)
) STRICT

${OBJSTORE_DIR}/${workspaceTag}/${resourceTag}.bin           -- live
${OBJSTORE_DIR}/${workspaceTag}/.staging/${stagingId}.bin    -- in-flight
```

Bytes live outside SQLite to keep the WAL out of the multi-MB
bundle path. Commit/delete order is asymmetric so a power-loss at
the worst moment leaves at most a stranded file (cleaned by the
periodic reaper), never a row pointing at a missing file:

- PUT commit: `fsync(staging) → rename → fsync(parent dir) → DB write`.
- DELETE: `DB write → unlink (best-effort, ENOENT ok)`.

The reaper runs once at startup (synchronous, before the WS
listener accepts traffic) and then every
`OBJSTORE_REAP_INTERVAL_MS`. Stale staging rows expire after
`STAGING_TTL_MS_DEFAULT` (1h, comfortably over a 50 MiB upload on
a slow line).

### What the server still CAN'T do

- Decrypt or modify resource contents — the bytes are AEAD'd
  client-side under a key derived from the workspace seed.
- Forge writes — every PUT/DELETE requires a valid Ed25519
  signature against the workspaceTag.
- Promote / re-attribute a resource to a different `resourceTag` —
  the tag is in the signed canonical, signed `contentHash` ties
  the bytes to the announcement.
- Replay a captured `objstore-list` / `objstore-fetch` from a
  different TCP connection — both sigs bind the per-socket
  `connectionNonce`.



## Error handling

The socket is shared across every workspace open in the client.
Per-message errors are scoped to a session; they DO NOT close the
WS. Only transport-level failures trigger reconnects. Summary:

| Failure mode | Server action | Socket | Client recovery |
|---|---|---|---|
| Bad signature on `workspace-save` / `workspace-subscribe` | Silent drop | Stays open | Legit signer retries; persistent bad-sig surfaces client-side as `'encrypt/sign failed: …'` after the IIFE's `maxConsecutiveFailures` (5). |
| `workspace-save` with shape-invalid field (newline, non-base64 alphabet) | Silent drop | Stays open | Same as bad sig — silent (legit clients never produce these). |
| `workspace-save` ciphertext &gt; 2 MiB (`MAX_CIPHERTEXT_LEN`) | Emits `workspace-save-error { reason: 'too-large' }` AFTER sig verify | Stays open | Client clears `pending`, sets `session.error`. Recovery via `dismissError(wsId)` or any of the lifecycle handlers (`setServerUrl`, `setEnabled(true)`, `setForcedOff(false)`) — those clear the error AND re-kick key derivation if the session never had usable keys. |
| `objstore-put-begin` exceeds the per-workspace `MAX_RESOURCES_PER_WORKSPACE` (100) cap for a NEW resource | Emits `objstore-put-error { reason: 'workspace-full' }` AFTER sig verify | Stays open | Re-uploads of existing resourceTags (new versions) still succeed; the cap is on the live row count only. |
| `workspace-save` `base` doesn't match server head | Server sends a `workspace-state` catch-up chain | Stays open | Client rebases against the chain and retries. |
| Total WS frame &gt; 4 MiB (`maxPayload`) | `ws` library closes with code 1009 | **Closed** | Client reconnects; on reconnect the same oversize state will retry, so this should not happen in practice — the 2 MiB ciphertext cap keeps frames well under 4 MiB. |
| Heartbeat: client `ping` → no `pong` within timeout | n/a | **Closed by client** | Client reconnects (exponential backoff from 1 s). Per-session `pending`/`pendingSave`/`encrypting`/subscribed flags reset; `session.error` is preserved across reconnect. |
| Graceful server shutdown (SIGTERM) | Sends close code 1001 "going away" to every client | **Closed by server** | Client reconnects per its backoff. |

Server-side errors that prevent the relay from booting at all
(invalid `PORT` env var, non-STRICT pre-existing `workspace_revision`
table, etc.) fail loud at startup so the operator can act on them.

## Storage

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

WAL mode + `synchronous = FULL`: WAL gives concurrent readers and
crash-safe writes; FULL fsyncs every commit so the
`workspace-save-ack` the server returns is a real durability
promise (a power loss between ack and the next WAL checkpoint
under NORMAL would lose the row even though peers heard "this
revision committed"). Round-9 M1.

Single-process write semantics are sufficient because the JS event
loop serialises handlers; for a multi-process deployment add
`BEGIN IMMEDIATE` / `COMMIT` around `head + insert` or move
id-assignment behind the UNIQUE-index retry loop.

## What the server CAN'T do

- Decrypt, modify, or examine triage values — `nonce` and
  `ciphertext` are opaque.
- Forge writes — saves require a valid Ed25519 signature.
- Re-attribute a revision to a different `base` or flip its
  `keyframe` flag — both are bound into the signed canonical, and
  the AAD on the ciphertext binds the changeset to its
  `(workspaceTag, base)` context.
- Promote a revision to a different `id` — `id` is the SHA-256
  of the same canonical bytes the signature covered.
- Replay a captured subscribe from a different connection — the
  per-socket `connectionNonce` is bound into the canonical, and
  every fresh accept gets a fresh nonce.

## What the server CAN do

- Drop / reorder / delay messages (denial of service).
- Observe traffic patterns (size, timing, edit cadence per tag).
- Synthesise garbage revisions; clients reject them on signature
  verification (per-revision skip + advance, not a full resync).

## License

MIT.
