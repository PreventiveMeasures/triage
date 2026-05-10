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
