# Managed storage encryption

Managed storage can encrypt report and bundle contents before writing to disk
or private Vercel Blob. It uses ChaCha20-Poly1305 with a random data key for each
upload. The existing SQL row stores that key wrapped by one deployment master
key, `MANAGED_STORAGE_ENCRYPTION_KEY`.

The master key must be the canonical base64 encoding of 32 random bytes:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

Store it as a deployment secret (a Sensitive environment variable on Vercel),
and back it up separately. All instances, maintenance commands and cleanup
functions sharing the database and byte store must use the same key. There is
one supported master key; rotation and old-key lists are not implemented.

## Scope and ownership

| Data | Encryption key |
| --- | --- |
| Reports | Random per-report key, wrapped in `managed_report.data_key` |
| Bundles, including Brotli sourcemaps | Random per-bundle key, wrapped in `managed_bundle.data_key` |
| Bundle metadata/package inventory and report-source caches | Their bundle's data key |
| Temporary Vercel upload parts | Master key, with fresh per-write derivation |
| GitHub access and refresh tokens | Master key; each SQL value is wrapped separately and bound to its user and field |
| Public GitHub avatars | Unencrypted |
| Other SQL data: users, permissions, sessions, triage, comments, activity and upload metadata | Unencrypted |
| E2e objects | Unchanged; encrypted by clients with their own keys |

The managed server unwraps keys and decrypts authorized reads in memory. API
URLs, access checks, compression, download sizes and content hashes remain the
same. A Blob token or copy of the byte store alone cannot decrypt encrypted
payloads. Access to both the SQL keys and master key permits decryption;
control of the running managed server or its deployment environment does too.
Provider encryption at rest remains a separate outer layer.

## Explicit activation

1. Back up the database and byte store together; retain the master key separately.
2. Upgrade all instances and cleanup functions, including any previews sharing
   production storage. Configure the same master key everywhere. Drain old
   binaries before activation; they do not enforce the encryption requirement.
3. Explicitly enable encryption with the command below. Merely setting the
   variable, starting the server or asking for status never enables it.
4. Run migration, or let scheduled maintenance process bounded batches.

```sh
node server-managed/cli.js --storage-encryption-status
node server-managed/cli.js --enable-storage-encryption
node server-managed/cli.js --migrate-storage
```

The installed `triage-managed-server` accepts the same flags. Supply the usual
managed server configuration; these commands do not start an HTTP listener.
Activation saves a wrapped test value in `managed_storage_encryption`. Every
startup checks it, and storage/token operations check the requirement again.
A missing or incorrect key fails closed. Removing or changing the master key
and reverting to an older binary are unsupported after activation.

On Vercel, deploy with the key configured first, then run the activation command
from a trusted workstation or CI job using the production Neon URL, Blob token
and the same key. The marker is stored in Neon, so deployed functions observe
it on subsequent operations. The command needs no shell inside Vercel; the
scheduled `/api/reap` can perform migration after activation.

New uploads receive a random data key. The server encrypts the file at its
usual path, then inserts the row with the wrapped key and an encrypted flag.
A duplicate retains the original row/key and discards the candidate. After an
uncertain database commit, reconciliation takes the database writer lock
before deciding whether the candidate file can be deleted. If reconciliation
is unavailable, the encrypted candidate is retained.

A plaintext write racing activation is rejected, including a write whose PUT
committed but lost its acknowledgement. Cleanup compares its bytes and deletes
only the observed version, preserving a concurrent encrypted replacement.

## Resumable migration

Migration walks SQL rows by ID, independently of Blob listings. Each payload
row has three states:

| `data_key` | `storage_encrypted` | Meaning |
| --- | --- | --- |
| `NULL` | `0` | Legacy payload, not started |
| Wrapped key | `0` | Pending migration; plaintext or an interrupted encrypted replacement |
| Wrapped key | `1` | Encrypted payload; plaintext is always rejected |

For each report/bundle, the worker:

1. Allocates a data key if absent, using the persisted winner if another worker
   allocated it first.
2. Validates the original bytes against the SQL upload hash. Sourcemaps are
   decompressed while hashing because their integrity covers the original upload.
3. Streams encryption over the same path. Vercel uses conditional `put` with
   `ifMatch`; disk writes use a synced temporary file and atomic rename.
4. Reads the replacement back, authenticates it, checks the upload hash, and
   marks the row encrypted. An interrupted replacement can be verified and
   completed on a later attempt using the same persisted data key. Disk workers
   sync the directory before checkpointing, including on resumed replacements.

Pending-row reads accept plaintext only after verifying the original upload
hash. Already encrypted rows never fall back to plaintext, even while other
rows are still migrating. GitHub tokens migrate in their own short database
transactions, serialized with token refreshes.

Progress is saved after each row. Failed rows are retried on the next pass;
other rows can advance. `complete: true` means there are no pending payload or
token rows, including earlier failures. An unavailable/corrupt payload keeps
migration incomplete and reports an error.

Legacy caches are immediately ignored after activation. Rebuilds use the
bundle key and a separate `cache-encrypted-v1/` namespace. A bounded independent
inventory removes old caches and unreferenced plaintext; `cleanupComplete`
reports that inventory's completion. Referenced-data migration is not blocked
by stray files. Old upload parts remain readable during the activation grace
period of 24 hours and are removed by the normal staging sweep; expiry is not
an assurance of physical deletion at exactly 24 hours.

Maintenance runs through managed `reap()`, including authenticated
`GET /api/reap`. Each migration call processes at most 64 entries with a
150-second work budget. Persistent servers schedule cleanup; Vercel's supplied
cron runs daily. The CLI repeats batches until both completion flags are true.
If cleanup finds a recent temporary file, it exits with `cleanupComplete: false`
and `retryAt` (Unix milliseconds) rather than spinning through the 24-hour staging
grace period. Run it again after that time, or let scheduled maintenance resume.
All work is awaited; no background promise must survive a Vercel response. The
work budget cancels Blob reads, writes, listings and deletes, as well as payload
verification and decompression. Provider/database timeouts still apply; an
in-flight database operation is not cancelled by that signal. A single object
must fit the transfer budget; persistent failures require investigation and a rerun.

## Layout, deletion and recovery

Reports and bundles keep `reports/<id>` and `bundles/<id>` (or `<id>.map.br`)
beside SQLite, or under `.managed/` in private Vercel Blob. There is no object
manifest, random ciphertext pathname, prefix table or deletion-marker table.
The installation-state table stores the test value and migration/cleanup cursors.

Deleting a row removes its live wrapped key, blocking subsequent key lookup
even when byte deletion fails. Encrypted orphan files have no live SQL key.
Physical deletion remains best effort. Readers already holding a key, retained
SQL pages/WAL, replicas and backups can retain key material; SQL deletion alone
is not an assurance of immediate forensic erasure. Report-source caches belong
to the bundle, so deleting a report does not destroy the bundle's cache key.
Previously retained plaintext copies/backups need their own retention policy.

Back up **database + byte store + master key** as a compatible set. A Blob
backup alone cannot recover data keys. Restoring a pre-migration database
against migrated files loses the keys generated during migration. Restore its
matching byte-store snapshot too. Losing the master key is unrecoverable.

## Formats

SQL wrapped values are canonical base64 of:

```
version(1) || masterKeyId(16) || salt(32) || ciphertext || tag(16)
```

HKDF-SHA-256 derives a wrapping key from the master key, fresh random salt and
`deepview.wrap.v1`. ChaCha20-Poly1305 uses a zero nonce under that one-use derived
key. AAD contains the complete header and identity: `managed_bundle:<id>`,
`managed_report:<id>`, `managed_user.gh_access_token:<id>`,
`managed_user.gh_refresh_token:<id>`, or the installation-test identity. The
master-key ID is a domain-separated SHA-256 hash truncated to 16 bytes.

Payloads use Node's native ChaCha20-Poly1305 with 64 KiB chunks and full 16-byte
tags. Each write derives a fresh key with HKDF-SHA-256 from its data key (or the
master key for upload parts), a new 32-byte salt, and the logical path.

The authenticated 57-byte header contains `DeepView.storage` (16 bytes),
version `1`, salt (32 bytes), and big-endian plaintext size (8 bytes; all ones
means unknown). It contains no master-key ID. Each chunk authenticates the
header and uses a counter/final-flag nonce, following the framing approach of
[age STREAM](https://github.com/C2SP/C2SP/blob/main/age.md#payload). The envelope
is application-specific, not an age file. The reader checks the first chunk
before exposing size metadata and never releases an unauthenticated chunk.

Substitution between paths/rows, corruption, truncation and reordered chunks
fail authentication. Same-path replay of valid ciphertext is possible; upload
contents are immutable, and cached derivatives can be rebuilt.

Tests exercise disk and Blob SDK fixtures, SQLite and PostgreSQL semantics
(PGlite), API uploads/downloads, explicit activation, migration interruptions,
concurrent keys/deletions, token encryption and a generated 115 MiB payload.
