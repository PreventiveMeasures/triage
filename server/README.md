# DeepView triage-sync server

A small WebSocket relay that lets DeepView clients sharing a
workspace seed sync their per-finding triage (color, deleted,
comment, fix) without trusting the server with the contents.
Encryption + Ed25519 signing happens client-side; the server only
sees opaque ciphertexts and routes them.

## Run

```
pnpm install
pnpm server                # listens on ws://127.0.0.1:8765
PORT=9000 pnpm server      # custom port
DEBUG=1 pnpm server        # log every message
DB_PATH=./mydb.db pnpm server
```

Defaults: `PORT=8765`, `HOST=127.0.0.1`, `DB_PATH=server/data.db`.
The SQLite file is created on first run; nothing else is needed.

Requires Node ≥ 24 (uses the built-in `node:sqlite` and WebCrypto
Ed25519).

## Wire protocol

All messages are JSON over WebSocket text frames. `nonce` /
`ciphertext` / `signature` fields are base64url.

### Client → Server

```
workspace-save {
  workspaceTag,        // base64url Ed25519 public key
  base,                // last revision id the client knows; null on first save
  nonce, ciphertext,   // ChaCha20-Poly1305 over the JSON-encoded changeset
  signature            // Ed25519 sig over (tag, base, nonce, ciphertext)
}

workspace-subscribe {
  workspaceTag,
  signature            // Ed25519 sig over (tag) — proves seed knowledge
}
```

### Server → Client

```
workspace-save-ack {
  workspaceTag, base, id      // accepted as revision `id`
}

workspace-state {
  workspaceTag,
  revisions: [
    { base, id, nonce, ciphertext, signature },
    ...
  ]
}
```

`workspace-state` is used for: initial sync (after a subscribe),
broadcast when another client commits a revision, and stale-base
catch-up when a save's `base` doesn't match the workspace's head.

## Authentication

Every signed message is verified against the `workspaceTag` (=
public key) before any state mutation. Invalid signatures are
silently dropped — a holder of the workspace seed will retry, an
attacker who only learned the tag can't get past the verify.

## Storage

Single table:

```
workspace_revision (
  workspace_tag TEXT,
  id            INTEGER,           -- monotonic per workspace_tag
  base          INTEGER,            -- previous id, null on the first
  nonce         TEXT,                -- base64url
  ciphertext    TEXT,                -- base64url
  signature     TEXT,                -- base64url
  created_at    INTEGER,             -- ms epoch
  PRIMARY KEY (workspace_tag, id)
)
```

WAL mode is enabled. Single-process write semantics are sufficient
because the JS event loop serialises handlers; for a multi-process
deployment add `BEGIN IMMEDIATE` / `COMMIT` around `head + insert`
or move id-assignment behind a unique index retry loop.

## What the server CAN'T do

- Decrypt, modify, or examine triage values — `nonce` and
  `ciphertext` are opaque.
- Forge writes — saves require a valid Ed25519 signature.
- Re-attribute a revision to a different `base` — the AAD on the
  ciphertext binds it to its `(workspaceTag, base)` context, and
  the sig binds the same.

## What the server CAN do

- Drop / reorder / delay messages (denial of service).
- Observe traffic patterns (size, timing, edit cadence per tag).
- Synthesise garbage revisions; clients reject them on signature
  verification (per-revision skip + advance, not a full resync).

## License

MIT.
