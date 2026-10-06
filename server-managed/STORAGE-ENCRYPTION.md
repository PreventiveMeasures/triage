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
| Reports, including Brotli-compressed reports | Random per-report key, wrapped in `managed_report.data_key` |
| Bundles, including Brotli sourcemaps | Random per-bundle key, wrapped in `managed_bundle.data_key` |
| Bundle metadata/package inventory and report-source caches | Their bundle's data key |
| Temporary Vercel upload parts | Master key, with fresh per-write derivation |
| Global deduplication link reports | Master key; encrypted JSON stored directly in `managed_link_report.encrypted_groups`, bound to the row |
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

New report uploads are compressed with Brotli quality 9 before encryption and
stored at `reports/:id.br`. Reads decrypt before decompressing, preserving the
original report bytes. Legacy reports at `reports/:id` convert during their first
read, using the existing per-report key and removing the old copy only after
the compressed representation is saved. No separate compression migration is
required. The upload cap and SQL byte sizes and hashes describe
the original file, before compression or encryption.

Processes cache a validated enabled policy. Keyless instances cache disabled
state for five seconds to avoid per-read database round trips. A plaintext write
still checks activation after its PUT, and a read encountering ciphertext forces
a fresh check; these fences never use the disabled cache. Header inspection on
plaintext reads prevents serving ciphertext during that window. Owned encrypted
reads load the current SQL data key separately from public permission/metadata
records, so a stale handler record cannot supply a deleted key. Existence and
version checks use object metadata; opening a payload authenticates its contents.

## Enable encryption at startup

1. Back up the database and byte store together; retain the master key separately.
2. Upgrade all instances and cleanup functions, including any previews sharing
   production storage. Drain old binaries before configuring the key; they do
   not enforce the encryption requirement.
3. Set `MANAGED_STORAGE_ENCRYPTION_KEY` to the same master key everywhere and
   restart or redeploy. The first startup with the key enables encryption in
   the shared database before serving requests. New uploads, cache writes,
   upload parts and GitHub tokens are encrypted immediately.
4. Set `MANAGED_STORAGE_ENCRYPTION_MIGRATE=1` and restart or redeploy to migrate
   existing data through bounded maintenance batches. Leave it unset to pause
   migration; new writes remain encrypted either way.

```sh
node server-managed/cli.js --storage-encryption-status managed
# For a combined e2e + managed deployment:
node server-managed/cli.js --storage-encryption-status managed-e2e
```

The installed `triage-managed-server` accepts the same status flag and required
deployment mode. `managed` uses the standalone configuration; `managed-e2e` and
`e2e-managed` use the combined configuration, where `DB_PATH` belongs to e2e
and managed uses `MANAGED_DB_PATH` or its own default. Status opens only the database, never
activates encryption, and does not start an HTTP listener or migration.
Without a key, a database that has never enabled encryption stays plaintext.
Enabling saves a wrapped test value in `managed_storage_encryption`. Every
startup checks it, and storage/token operations check the requirement again.
Concurrent starts reuse this value and must present the same key. A missing
or incorrect key fails closed after encryption is enabled. Removing or changing
the master key and reverting to an older binary are unsupported after activation.
Vercel previews (`VERCEL_ENV=preview`) never create the installation marker:
with a configured key they require encryption to have been enabled outside a
preview first. They validate the existing marker with the same key.

On Vercel, configure the key and redeploy. The first function invocation that
opens managed storage enables encryption in Neon; subsequent cold starts
validate the same key. No activation command or shell inside Vercel is needed.
With `MANAGED_STORAGE_ENCRYPTION_MIGRATE=1`, eligible ordinary managed requests,
subsequent automatic maintenance and authenticated `/api/reap` run migration
batches. Startup itself does not scan or rewrite existing payloads. The normal
response proceeds alongside maintenance. The Vercel entrypoint registers the
whole handler with `waitUntil` so the invocation stays alive after the HTTP
response ends; awaiting the handler alone is insufficient. A shared database
lease coordinates automatic batches across cold instances. Migration still
increases invocation duration and storage/SQL load
while enabled. The environment switch intentionally uses deployment configuration
rather than a separate CLI runner; changing it on Vercel requires a redeploy.

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

Migration walks pending SQL rows, independently of Blob listings. Each payload
row has three states:

| `data_key` | `storage_encrypted` | Meaning |
| --- | --- | --- |
| `NULL` | `0` | Legacy payload, not started |
| Wrapped key | `0` | Pending migration; plaintext or an interrupted encrypted replacement |
| Wrapped key | `1` | Encrypted payload; plaintext is always rejected |

For each report/bundle, the worker:

1. Allocates a data key if absent, using the persisted winner if another worker
   allocated it first.
2. Downloads the original bytes once, checking the SQL upload hash while streaming
   encryption. Compressed reports and sourcemaps are decompressed for hashing
   while their stored Brotli bytes are encrypted. The stream ends successfully
   only after the hash passes.
3. Replaces the same path only after that successful end. Vercel uses conditional
   `put` with `ifMatch`; multipart uploads complete only after consuming the stream.
   Disk writes use a synced temporary file and atomic rename. Verification errors
   or interrupted reads leave the original object in place.
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
token rows, including earlier failures. A missing payload, hash mismatch or
invalid sourcemap keeps migration incomplete and logs its row type, ID and
failure under `managed-storage-migration-row:`. These rows do not fail session
or upload cleanup, change `/api/reap` to HTTP 500, or trigger one-minute retries.
They retry on subsequent ordinary batches; repairing the payload lets migration
finish. Database and provider failures still fail the cleanup job.

Legacy caches are immediately ignored after activation. Rebuilds use the
bundle key and a separate `cache-encrypted-v1/` namespace. A bounded independent
inventory removes old caches and unreferenced plaintext; `cleanupComplete`
reports that inventory's completion. Deleting a bundle removes both cache
namespaces even with migration disabled. Referenced-data migration is not blocked
by stray files. Old upload parts remain readable during the activation grace
period of 24 hours and are removed by the normal staging sweep; expiry is not
an assurance of physical deletion at exactly 24 hours.

Cleanup recognizes only managed paths: `reports/<uuid>`, `bundles/<uuid>` and
`bundles/<uuid>.map.br`, plus caches under `cache/bundles/<uuid>/` and
`cache/report-sources/<uuid>/`. Unrelated files beside a database in a shared
directory are left alone. Disk deployments do not create or reap upload parts;
the staging sweep runs only on Vercel.

Migration requires `MANAGED_STORAGE_ENCRYPTION_MIGRATE=1` and the configured
key. It runs through managed `reap()`, including authenticated `GET /api/reap`.
Ordinary traffic triggers due maintenance hourly (one-minute retry backoff
after database/provider failures). Vercel's database lease preserves that
cooldown across cold starts; authenticated `/api/reap` bypasses it. Persistent
servers also run an hourly timer; Vercel's supplied optional cron runs daily
when traffic is idle.
Each migration call processes at most 64 entries with a default 150-second work
budget. Set `MANAGED_STORAGE_ENCRYPTION_MIGRATE_MAX_MS` to adjust that budget:
up to one hour on persistent servers, or 240 seconds on Vercel. The deployed
function's duration must still allow the batch and remaining request work.
Reports migrate first, then bundles, then GitHub tokens. Reports and bundles
each sort by their recorded `byte_size`, smallest first, with ID breaking ties;
token rows sort by ID. A saved cursor from the previous ordering restarts the
pending pass without repeating completed rows.

When time runs out after earlier rows have completed, the interrupted row stays
pending and gets a full budget next batch; the batch returns progress normally.
If the first row consumes the entire budget, the batch checkpoints past it and
logs a row diagnostic naming the row and `MANAGED_STORAGE_ENCRYPTION_MIGRATE_MAX_MS`.
Later rows and GitHub tokens can then advance. The oversized row remains pending
and is retried on the next pass; completion cannot hide it. Genuine storage
failures also remain errors. If cleanup finds a recent temporary file, it returns
`cleanupComplete: false` and `retryAt` (Unix milliseconds) without spinning
through the 24-hour staging grace period. Recognized disk `<path>.<uuid>.tmp`
files are removed after that grace period whether plaintext or encrypted,
including temporary files in the encrypted cache namespace. Progress is logged as
`managed-storage-migration:` with `complete`, `cleanupComplete`, `migrated`,
`cursor`, `retryAt`, `failed` (rows in this batch) and `cancelled`. Once both
completion flags are true the job is a no-op; the migration variable can be
removed while retaining the key.
Rows deferred because the object disappeared, changed version between reads,
or rejected a conditional replacement emit `managed-storage-migration-row:`
diagnostics too. These contain only the row type, opaque row ID and a short
reason, without payloads, filenames, paths, hashes, ETags or key material.
The rows remain pending and retry on the next pass without bypassing the
version check.
Vercel downloads request `Accept-Encoding: identity` so transport compression
does not weaken the stored ETag used for conditional writes or change the
advertised byte size. Stored Brotli bundles retain their existing encoding.
After a rejected conditional write, a bounded metadata lookup reports whether
the download and metadata versions match, differ only in formatting, or differ
in value. It also reports weak/quoted/unquoted formats, or missing/unavailable
metadata. These are diagnostic labels only; no ETag values are logged or
substituted into writes, and the row stays pending.
Diagnostics are emitted as each failure occurs, before advancing the cursor;
a later error cannot suppress earlier row warnings. `managed-storage-migration-start:`
records batch start and `managed-storage-migration-row-start:` records each
attempt's type and opaque ID. `managed-storage-migration-row-phase:` adds a fixed
phase name and elapsed milliseconds, and logs `aborted: true` directly when the
work budget expires or shutdown cancels the row, even if an operation is slow to
unwind. It never includes filenames, object paths, hashes, ETags, tokens or keys.
A hard invocation timeout can prevent these logs and the final summary, but does
not undo already saved checkpoints or emitted diagnostics.
Temporary files left by later crashes are not swept after migration cleanup
has completed; like encrypted orphan payloads, they can consume storage.

The work budget cancels Blob reads, writes, listings and deletes, as well as
payload verification and decompression. Server shutdown aborts the same work,
leaves an interrupted row pending with its existing data key, and waits for
maintenance to settle before closing the database. Provider/database timeouts
still apply; an in-flight database operation is not cancelled by that signal. A single object
must fit the transfer budget; increase the budget for objects that repeatedly
exhaust it. Disk inventories skip and log unsupported names and symlinks without
following them. Directory fsync is used where supported; on unsupported
filesystems, file fsync and atomic rename remain, but directory durability
depends on the filesystem.

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
(PGlite), API uploads/downloads, automatic startup activation, migration interruptions,
concurrent keys/deletions, token encryption and a generated 115 MiB payload.

## Deduplication reports

Admins import `*.link.json` files in Manage → Deduplication. Link reports are
installation-wide and have no repository or team assignment. Both arrays of
string IDs (`[["a", "b"], ["b", "c"]]`) and the existing local `{ "id": "a" }`
entries are accepted. New imports are enabled; disabling a report keeps its
ciphertext in SQL but removes its contribution to finding links. Importing the
same normalized content again preserves its enabled state.

This feature requires `MANAGED_STORAGE_ENCRYPTION_KEY`; it never writes link
payloads to the blob store or falls back to plaintext. On startup, legacy reports
with analyzer `links` are moved from the report store into this table, retaining
their publication state as enabled/disabled, before their old blobs are deleted.
Legacy installations with such reports must configure the key before starting.

Finding queries combine enabled reports transitively before retaining only IDs
present in the response and dropping groups smaller than two. Hidden or absent
IDs can bridge visible findings without being disclosed. Team security filtering
also uses the complete link graph. Link changes refresh team catalogs, cached
findings, annotations, and public workspace views.
