# Managed storage encryption

Set `MANAGED_STORAGE_ENCRYPTION_KEY` to encrypt managed byte storage with
ChaCha20-Poly1305 before writing to disk or private Vercel Blob. The value must
be the canonical base64 encoding of 32 cryptographically random bytes. Generate
it once, store it as a deployment secret, and back it up separately:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

All managed instances, CLI maintenance commands, and cleanup functions using
the same database and byte store must use the same key. It is independent of
`BLOB_READ_WRITE_TOKEN`; possession of that token alone does not decrypt these
objects. The managed server decrypts authorized reads in memory and streams
the original bytes to clients. API URLs, permissions, compression, download
sizes, and bundle/report hashes do not change.

## Scope

| Data | Protected by this key |
| --- | --- |
| Report and bundle payloads, including compressed sourcemaps | Yes |
| Upload parts on Vercel | Yes |
| Bundle metadata, package inventory, contents, and other derived byte caches | Yes |
| Cached report source files and avatars, including disk content-type sidecars | Yes |
| SQL rows: users, sessions, permissions, triage, comments, activity, repository/upload metadata and tokens | No |
| E2e objects | Unchanged; already encrypted by clients with their own keys |

This protects byte contents in a copied disk/Blob store or against someone
with only storage credentials. It does not hide sizes, SQL metadata, or access
patterns. Anyone able to read the deployment's key or execute code in the
managed server can decrypt data. Storing the key in Vercel's environment does
not protect against a Vercel administrator who can access that environment or
deploy code. Provider encryption at rest remains an independent outer layer.

## Activation and plaintext migration

1. Back up the database and byte store. Keep the new key separately.
2. Drain deployments that can write plaintext, including old function versions
   and preview deployments sharing production storage. Restart all writers and
   cleanup functions with this implementation and the same key. Do not run an
   old binary against storage after activation.
3. New writes are encrypted immediately. Existing plaintext remains readable
   while migration runs; clients do not need to re-upload data.
4. Maintenance migrates bounded batches through the normal managed `reap()`:
   at most 64 objects and a 150-second work budget per batch. This runs on the
   persistent server's cleanup timer and via authenticated `GET /api/reap`.
   Vercel's supplied schedule runs daily; use the CLI for faster completion.
5. Check that migration reports `complete: true`. That requires a full empty
   inventory sweep after plaintext cleanup. Unlisted plaintext is then ignored.

Run these commands with the deployment's usual managed configuration and key:

```sh
node server-managed/cli.js --storage-encryption-status
node server-managed/cli.js --migrate-storage
```

The installed `triage-managed-server` command accepts the same flags. Neither
starts an HTTP listener. The migration command repeats bounded batches until
complete and prints JSON progress; rerun it after any interruption. Opening
storage with a key, including for a status command, records encryption as
required in the database. A missing or different key then fails closed.

Migration writes an immutable encrypted candidate, reads it back to verify
authentication and its SHA-256 digest, publishes its reference transactionally
in SQL, then deletes the observed plaintext version. Updates and deletions
fence off stale migration attempts. Concurrent workers share progress through
the database. A failed upload/verification preserves the original; an uncertain
SQL commit preserves the candidate until maintenance can check its reference.
Reads racing plaintext removal retry through the new SQL reference.

There is no background promise left running after a Vercel response. Work is
awaited, transfer operations receive an abort signal, and progress survives
function termination. The time budget does not override the provider's own
database/listing timeouts. A single object must fit within the transfer budget;
repeated timeouts leave its original available and require investigation before
migration can finish. Encryption adds bounded streaming buffers; upload
assembly and bundle parsing retain their existing memory limits.

## Physical layout, cleanup, and recovery

Encrypted objects use random immutable paths:

| Backend | Location |
| --- | --- |
| Filesystem | `encrypted-v1/<uuid>` beside the managed database |
| Private Vercel Blob | `.managed/encrypted-v1/<uuid>` |

The SQL manifest maps logical paths to physical objects. Its tables are
`managed_storage_encryption` (key ID, migration and collection progress),
`managed_storage_object` (references and deletion markers), and
`managed_storage_prefix` (cache-prefix deletion markers). The key itself is
never stored in these tables or object headers.

Deletes immediately revoke the SQL reference. Maintenance collects unreferenced
ciphertexts at least 24 hours old in pages of 100; actual removal depends on
the cleanup schedule. Candidates can only be published within three minutes
of starting their write, and collection checks references under the database's
writer transaction. This also collects abandoned uploads and superseded object
versions. Missing or invalid ciphertext is an error, never a reason to fall
back to an old plaintext copy.

Keep a consistent backup of **database + byte store + key**. Losing the key
makes encrypted contents unrecoverable. Losing the manifest loses the mapping
from logical objects to random physical paths. Removing/changing the key or
rolling back to an older binary is unsupported once activated; key rotation
requires a separate re-encryption procedure and is not implemented. Plaintext
backups or provider-retained copies are outside this migration and need their
own retention policy.

## Envelope v1

Uses Node's native [ChaCha20-Poly1305](https://nodejs.org/docs/latest-v24.x/api/crypto.html#cryptocreatecipherivalgorithm-key-iv-options),
with a 256-bit key, 96-bit nonce, and full 128-bit authentication tag. Chunk
framing follows the counter/final-flag approach in
[age STREAM](https://github.com/C2SP/C2SP/blob/main/age.md#payload); this envelope
is application-specific and is not an age file.

- Every write generates a fresh random 32-byte salt. HKDF-SHA-256 derives a
  per-write key from the master key, salt, domain, logical path and immutable
  physical generation. Rewrites do not reuse a key/nonce pair; moving a
  ciphertext to another object or generation fails authentication.
- The 73-byte header contains the 16-byte `DeepView.storage` magic, version
  byte `1`, salt (32 bytes), big-endian plaintext size (8 bytes; all ones means
  unknown), and a non-secret key identifier (16 bytes). The entire header is
  authenticated as additional data for every chunk.
- Plaintext chunks are 64 KiB, each followed by a 16-byte tag. The final chunk
  may be shorter; an empty object has one authenticated empty final chunk.
  A 12-byte nonce combines an 11-byte big-endian counter with a final-chunk
  byte (`0` or `1`). This implementation caps the counter at 32 bits.
- The reader checks ordering, finality, authentication, and declared size. It
  releases a chunk only after its tag verifies, and authenticates the first
  chunk before exposing size metadata. Truncation, trailing data, substitution,
  and corruption fail the stream.

Tests cover both raw backends, SQLite/PostgreSQL references, migration races,
interruption, CLI operation, authentication failures and streaming of a
generated 115 MiB bundle. PostgreSQL tests use PGlite and Blob tests use SDK
fixtures; live Vercel/Neon deployment behavior still needs deployment validation.
