# Storage separation between e2e and managed

E2e persists client-encrypted revisions and objects. Managed persists
server-readable users, sessions, permissions, reports, bundles, triage,
comments, and activity. They can share one Postgres database and private Blob
store: their tables and object paths are separate. Sharing infrastructure does
not convert or synchronize application data between modes.

The cloud deployment model is multiple concurrent instances sharing the same
database and Blob storage. Instances use the same table/object namespaces;
there is no per-instance storage. This is logical separation between modes,
not a security boundary against holders of the shared provider credentials.

## Database configuration

Use one of two configurations:

- `DATABASE_URL`: a shared Neon Postgres URL for every enabled mode.
- `E2E_DATABASE_URL` and `MANAGED_DATABASE_URL`: independently configured URLs
  for the corresponding modes. They may point to the same or different databases.

`DATABASE_URL` cannot be combined with either per-mode URL, even when their
values are identical or the other mode is disabled. Empty values count as
unset. Validation happens before storage is opened, including in cleanup
handlers.

Combined mode requires both backends to be cloud-backed or both to be local:

| URL configuration | E2e | Managed |
| --- | --- | --- |
| No URLs | SQLite + filesystem | SQLite + filesystem |
| `DATABASE_URL` alone | Neon + Blob | Same Neon DB + Blob |
| Both per-mode URLs, no global URL | Neon + Blob | Neon + Blob |
| Only one per-mode URL | Rejected: mixed cloud/local backends | Rejected |
| Global URL plus either per-mode URL | Rejected: ambiguous configuration | Rejected |

Both combined launch modes (`managed-e2e` and `e2e-managed`) use these rules;
their order changes only the client's default mode. Standalone mode selects its
own backend, so the inactive mode's dedicated URL does not select its storage
or require matching backends. Managed Vercel functions require a managed URL
(global or dedicated); they cannot fall back to local storage.

Neon requires `BLOB_READ_WRITE_TOKEN`. E2e also requires a shared
`OBJSTORE_TOKEN_SECRET` so REST tokens work across instances. Both modes select
complete pairings; launchers do not expose SQLite with Blob or Neon with files.
A Blob token alone does not select Neon.

| Local setting | Selection when that mode uses SQLite |
| --- | --- |
| E2e database | `DB_PATH`, otherwise `server-e2e/data/data.db` relative to the module |
| E2e objects | `OBJSTORE_DIR`, otherwise `objstore` beside its database |
| Managed database, standalone | `MANAGED_DB_PATH`, then `DB_PATH`, otherwise `server-managed/data/managed.db` relative to the working directory |
| Managed database, combined | `MANAGED_DB_PATH`, otherwise the managed default; `DB_PATH` belongs to e2e |
| Managed objects/caches | `reports`, `bundles`, `avatars`, and `cache` beside its database |

Local paths are ignored when the corresponding database URL selects Neon.
`:memory:` makes SQLite temporary, but does not make byte storage temporary.

Sources: [shared URL validation](database-config.ts),
[e2e configuration](../server-e2e/config.ts),
[managed configuration](../server-managed/config.ts), and
[managed storage](../server-managed/storage.ts).

## Tables

All managed tables carry the `managed_` prefix. Both modes use the connection's
SQL schema; neither creates a separate PostgreSQL schema or database role.

| Owner | Tables |
| --- | --- |
| E2e revisions | `workspace_revision` |
| E2e object metadata/staging | `workspace_object`, `workspace_object_staging` |
| Managed identity | `managed_user`, `managed_session` |
| Managed repositories and teams | `managed_selected_repo`, `managed_team`, `managed_team_repo`, `managed_team_user` |
| Managed uploads | `managed_report`, `managed_bundle` |
| Managed triage | `managed_finding_triage`, `managed_finding_triage_event` |
| Managed comments | `managed_finding_comment`, `managed_finding_comment_event` |
| Managed activity and schema versions | `managed_activity`, `managed_schema_version` |
| Managed encryption activation and migration | `managed_storage_encryption`; wrapped data keys on the existing bundle/report rows |

Startup renames tables in an existing managed database transactionally while
retaining rows, foreign keys, and upload triggers. Conflicting source/destination
tables stop initialization. Instances using that managed database must use the
same schema names. E2e tables are unaffected.

The combined launcher requires distinct SQLite file paths (except separate
`:memory:` databases). Its guard uses `path.resolve`, not filesystem identity,
so symlink/hard-link aliases are not detected. The low-level schemas are
compatible with a shared file, but the launcher requires separate files.

## Byte storage and cleanup

| Data | Filesystem | Private Blob |
| --- | --- | --- |
| E2e objects | `OBJSTORE_DIR/<workspaceTag>/<contentHash>.bin` | `<workspaceTag>/<contentHash>.bin` |
| E2e staging | `OBJSTORE_DIR/<workspaceTag>/.staging/<stagingId>.bin` | `<workspaceTag>/.staging/<stagingId>.bin` |
| Managed reports | `reports/<uuid>` | `.managed/reports/<uuid>` |
| Managed bundles | `bundles/<uuid>` or `<uuid>.map.br` | `.managed/bundles/<uuid>` or `<uuid>.map.br` |
| Managed avatars | `avatars/<uuid>` plus `.type` sidecar | `.managed/avatars/<uuid>` with embedded content type |
| Bundle metadata cache | `cache/bundles/<uuid>/...` | `.managed/cache/bundles/<uuid>/...` |
| Report source cache | `cache/report-sources/<bundleUuid>/...` | `.managed/cache/report-sources/<bundleUuid>/...` |
| Pretty-printed public npm files | `cache/npm/pretty-v1/<sha512hex>.<ext>.br` | `.managed/cache/npm/pretty-v1/<sha512hex>.<ext>.br` |
| Managed upload parts | Not enabled by the disk adapter | `.managed/uploads/<derivedUuid>` |
| Managed encrypted caches (when enabled) | `cache-encrypted-v1/` | `.managed/cache-encrypted-v1/` |

Once startup enables encryption with `MANAGED_STORAGE_ENCRYPTION_KEY`, reports and
bundles retain their paths and get random data keys wrapped in their SQL rows.
Caches rebuild in the encrypted cache namespace using their bundle key. Legacy
payloads migrate in place through resumable SQL-row batches. GitHub access and
refresh tokens are encrypted too; other SQL data and e2e encryption are unchanged. See
[managed storage encryption](../server-managed/STORAGE-ENCRYPTION.md).

Managed filesystem paths are relative to the database's parent, not its
filename. In combined cloud mode, both servers use `BLOB_READ_WRITE_TOKEN`.
Selecting separate per-mode database URLs does not select separate Blob stores;
the mode namespaces remain distinct inside the shared store.

E2e cleanup excludes `.managed/` because dots are invalid workspace-tag
characters. It collects unreferenced e2e blobs after an age grace period and
reclaims stale/orphaned staging. Managed deletes target its UUID objects or
slash-delimited cache prefixes. Managed maintenance removes expired sessions
and, on Vercel only, upload parts older than 24 hours; it is not a general orphan-object sweep.
Ordinary managed requests trigger it on the first request per instance, then
hourly while traffic continues (one-minute retry backoff after failures).
The response proceeds alongside cleanup, and the triggering invocation awaits
both; concurrent requests share the sweep. Results and failures are logged as
`managed-reaper:` under the triggering request. Persistent servers also have an
hourly timer; serverless instances need traffic or the optional cron when idle.
With `MANAGED_STORAGE_ENCRYPTION_MIGRATE=1`, maintenance also migrates referenced
plaintext and removes legacy caches, orphan plaintext and stale atomic-write
temporary files. Cleanup recognizes managed UUID filenames and bundle cache
directories; unrelated files in a shared database directory are left alone. It does not collect
encrypted orphan report/bundle files; those no longer have a live SQL data key.

E2e commits and reaping are designed for concurrent instances: version updates
use database compare-and-set operations; cleanup rechecks live references and
uses conditional staging deletion. Managed writers use a shared transactional
Postgres advisory lock; readers use consistent snapshots. Cache builders
recheck references after publishing. Repeated/concurrent cleanup is supported.
All replicas of a mode must use the same configured database and byte storage.

`GET /api/reap` is mounted by the top-level servers and runs cleanup for every
enabled mode using its already-open storage. Standalone e2e runs object cleanup;
standalone managed runs session/upload cleanup and encrypted-storage maintenance
when enabled; either combined mode runs both.
`Authorization: Bearer <CRON_SECRET>` is required (401 if unset or incorrect).
Other methods return 405. Cleanup waits for all enabled modes and returns 500
if any fails. Concurrent requests share each mode's in-flight sweep.

On Vercel, the e2e function `api/reap.ts` opens the configured e2e store for each
sweep. The managed function `api/managed.ts` handles `/api/reap` using its managed
app. Both use the startup database URL validator. `OBJSTORE_REAP_DISABLED` disables
automatic e2e sweeps; explicit `/api/reap` requests still run them.

Switching backends does not migrate metadata or bytes. Managed users default to
No access. The configured `MANAGED_INITIAL_ADMIN_GITHUB_ID` is promoted on login
only while that account has No access and is the sole user, including when it
registered before the variable was set. Any other user blocks promotion. See
[account approval](../server-managed/README.md#account-approval).

## Verification

Configuration and launcher tests cover shared/dedicated URLs, conflicting
settings, mixed-backend rejection, and standalone selection. Table migration
tests cover data preservation, foreign keys, triggers, rollback, and repeated
initialization. Storage isolation tests exercise both schemas in one database
and both cleanup directions in one Blob namespace. E2e replica tests exercise
competing commits and cleanup against shared storage.

PostgreSQL tests use PGlite; Blob tests use SDK fixtures. They verify SQL and
adapter behavior, but do not reproduce independent concurrent Neon connections
or validate live provider credentials, IAM, networking, and platform limits.

The existing [e2e race suite](../tests/objstore-server-races.test.js) tracks three
limits as TODOs: concurrent new objects can overshoot the per-workspace count
cap; an upload that outlives its staging TTL can be reaped while finishing;
and cleanup does not repair live metadata rows whose blob is already missing.
