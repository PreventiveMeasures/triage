# Managed mode on Vercel

[vercel.managed.json](../vercel.managed.json) deploys the managed HTTP app and UI with Neon Postgres and private Vercel Blob storage.
Authentication, team permissions, reports, bundles, triage, comments and activity use the same managed application as the persistent server.

The function advertises managed mode only.
Combined managed/e2e mode runs on the persistent Node launcher and is not part of this deployment configuration.
For all backend combinations and sharing rules, see [storage separation](../server-common/STORAGE.md).

## Runtime and storage

| Component | Current behavior |
| --- | --- |
| HTTP app | `api/managed.ts` handles API requests, assets, and managed page URLs; `out/**` is bundled with the function |
| Metadata and sessions | Neon Postgres; transactional schema initialization, serialized writers, and consistent read snapshots |
| Reports, bundles, avatars | Private Blob objects under `.managed/`; clients receive authorized responses, not Blob credentials or public URLs |
| Bundle storage | Sourcemaps are stored as Brotli; Stasis archives retain their uploaded bytes; original sizes and hashes remain in Postgres |
| Derived data | Brotli bundle metadata and gzip report sources are cached in Blob; source caches include the viewer's permissions |
| Cleanup | Ordinary requests trigger due cleanup, coordinated across instances by a database lease; `GET /api/reap` and the daily 00:00 UTC cron also remain available |

The app shares initialization within a function instance and retries failed initialization.
Requests await their work.
The serverless app installs no listener, signal handlers or maintenance timers.
Team SSE polling and heartbeat timers exist only for the lifetime of their awaited request.
Missing derivatives are built during authorized reads.
Build deduplication and queues are local to each instance, while caches are shared.
Builders recheck database references after publishing, to handle concurrent deletion.
Access is checked again after cold builds.

Finite HTTP requests lease one Neon connection and release it before returning.
Feeds lease a connection within each polling iteration and release it before waiting for the next poll.
Released connections stay pooled in the instance for five seconds, so later requests, polls and initialization skip the connection handshake.
The pool is registered with [`attachDatabasePool`](https://vercel.com/docs/functions/functions-api-reference/vercel-functions-package).
Each release keeps the invocation alive until idle connections have closed, so none survives a suspended instance.
A failed lease is discarded, never reused.

Every response the managed app answers carries a `Server-Timing` header, which the browser's developer tools show beside the request.
It gives the database's time and statement count (`db`), new connections' time (`conn`), GitHub's time and call count (`gh`), `cold` on an instance's first request, and the app's time from taking the request to writing the response's headers (`app`).
It holds counts and durations alone, nothing of what was asked.
A streamed response, such as a team's Dependencies or batched line counts, writes its headers before its first line, so its header tells only what was spent until then.
Timing starts once the app has initialized, so a cold start's initialization is in none of these times, and the `503` of a failed initialization carries no header.
A request's statements run one after another on its connection, so where they are simple reads, `db`'s time over its statements is close to one round trip to the database; tens of milliseconds each point to the function running far from the database's region.

Ordinary managed requests start a due session/upload sweep alongside the normal response.
The managed app registers maintenance with [`waitUntil`](https://vercel.com/docs/functions/functions-api-reference/vercel-functions-package#waituntil), so it can finish after the response ends.
This also holds when an embedding host such as Fastify mounts the request listener returned by `init()`.
Install the optional `@vercel/functions` peer dependency in Vercel deployments.
The supplied entrypoint also retains the complete handler promise, because awaiting a Node HTTP handler promise alone does not extend the invocation beyond `res.end()`.
Sweeps are coalesced per instance and coordinated by a shared database lease.
After a successful sweep, the next one waits an hour; after a failure, traffic retries it after a minute.
A cold start does not bypass that shared cooldown.
Results appear as `managed-reaper:` logs under the triggering request, including expired-session and stale-upload-part counts.
Failures are logged without failing the request.
This automatic path needs neither `/api/reap` nor `CRON_SECRET`.
The authenticated cron is still useful when there is no traffic.

Use `DATABASE_URL` for a shared database, or `MANAGED_DATABASE_URL` for a managed-specific database.
The global URL cannot be combined with either `MANAGED_DATABASE_URL` or `E2E_DATABASE_URL`.
A managed database URL and `BLOB_READ_WRITE_TOKEN` are required; there is no SQLite or filesystem fallback.
Changing backends does not migrate existing data.
New users default to No access.
On login, a matching `MANAGED_INITIAL_ADMIN_GITHUB_ID` becomes admin only if that account has No access and is the sole user.
This also recovers an account registered before the variable was set.
Any other user blocks promotion.
See [Account approval](README.md#account-approval).

E2e and managed may share a Postgres database and Blob store.
Their tables are separate, and e2e cleanup skips `.managed/`.
This is logical separation under shared credentials.
Multiple concurrent instances share the configured database and Blob storage; there is no per-instance namespace.
All managed tables carry the `managed_` prefix.
Startup renames tables in an existing managed database transactionally.
Instances using that database must use the same schema names.

## Deployment

Use a repository checkout and Node.js 24.x.
The cloud adapters require both optional peer dependencies declared in [package.json](../package.json):

```sh
pnpm add '@neondatabase/serverless@^1.0.2' '@vercel/blob@^2.3.3'
pnpm build
vercel --local-config vercel.managed.json
```

Include the dependency and lockfile updates in Git deployments.
For Vercel Git integration, make the managed configuration the deployment's `vercel.json`.
`--local-config` selects a configuration for CLI commands only.
The repository's root `vercel.json` configures e2e cleanup and does not route the managed app.
See Vercel's [Node.js versions](https://vercel.com/docs/functions/runtimes/node-js/node-js-versions) and [CLI configuration selection](https://vercel.com/docs/cli/global-options#local-config).

Set these variables for each deployment environment:

| Variable | Value |
| --- | --- |
| `DATABASE_URL` or `MANAGED_DATABASE_URL` | Shared or managed-specific Neon connection string; set exactly one |
| `BLOB_READ_WRITE_TOKEN` | Token for a private Vercel Blob store paired with that database |
| `MANAGED_STORAGE_ENCRYPTION_KEY` | Optional 32-byte base64 master key for managed payloads and GitHub tokens; enables encryption on startup, then requires the same key on every instance and cleanup function |
| `MANAGED_STORAGE_ENCRYPTION_MIGRATE` | Set to `1` to migrate existing plaintext during request/cron maintenance; requires the key |
| `MANAGED_STORAGE_ENCRYPTION_MIGRATE_MAX_MS` | Per-batch time budget; default `150000`, maximum `240000` on Vercel, within the deployed function's duration |
| `GITHUB_CLIENT_ID` | GitHub login app client ID |
| `GITHUB_CLIENT_SECRET` | GitHub login app client secret |
| `MANAGED_INITIAL_ADMIN_GITHUB_ID` | Optional numeric GitHub ID promoted on login only when that account has No access and is the sole user |
| `OAUTH_CALLBACK_URL` | HTTPS callback registered with the login app, ending in `/api/oauth/github/callback` |
| `CRON_SECRET` | Cleanup authorization secret; the endpoint requires `Authorization: Bearer <secret>` |
| `MANAGED_REPOSITORY_ACCESS_CACHE_MS` | Optional; how long GitHub's answer on a user's access to a repository is kept for them, per function instance; default `300000` (five minutes), `0` asks GitHub on every request |

The supplied configuration sets `NODEJS_HELPERS=0` to preserve raw request bodies, runs `pnpm build`, and uses `out` as its output directory.
Keep helpers disabled in the deployed environment; see Vercel's [Node.js configuration](https://vercel.com/docs/functions/runtimes/node-js/advanced-node-configuration#disabling-helpers-for-nodejs).
Under `VERCEL=1`, managed configuration turns proxy trust on by default and requires an HTTPS OAuth callback.
Optional repository-access GitHub app credentials and application limits are defined in [config.ts](config.ts).

## Uploads and resource limits

The client reads `managed.uploadChunkBytes` and `managed.uploadMaxBytes` from `/api/config`.
It rejects files over the report or bundle limit before uploading.
It splits uploads larger than 3 MiB into 3 MiB parts and sends three at a time.
Each part goes to `POST /api/admin/uploads/{reports|bundles}/{uploadUuid}/{zeroBasedPart}` with the session cookie, manager/admin access, same-origin validation and `X-CSRF-Token`.
Parts are bound to the session, upload kind, upload ID and part index.

Finalization posts an empty body to `/api/admin/reports` or `/api/admin/bundles` with the filename/repository headers and `X-Upload-Id`, `X-Upload-Parts` and `X-Upload-Size`.
The server checks part lengths and the total limit, then assembles the file, reading a few parts at once into one buffer.
It then applies parsing, access checks, hashing and deduplication.
The parts are deleted after the response, and the invocation is kept alive until they are.
Size-limit failures during finalization and rejected later chunks also delete the staged parts.
Clients cancel failed or interrupted uploads with `DELETE /api/admin/uploads/{reports|bundles}/{uploadUuid}`, with `X-Upload-Parts` set to the number of attempted parts.
This requires the same session, manager/admin access, origin and CSRF checks.
It cannot delete another session's parts, or published reports and bundles.
Cleanup has a bounded part count even for forged counts, and keeps the original upload error if deletion fails.
A failed finalization may require re-uploading.
Abandoned parts and failed deletions become eligible for automatic maintenance or explicit cleanup after 24 hours, so removal is not immediate at the 24-hour mark.

| Bound | Configured value |
| --- | --- |
| Report upload | 25 MiB by default, before compression (`MAX_REPORT_BYTES`) |
| Bundle upload | 200 MiB by default (`MAX_BUNDLE_BYTES`) |
| Upload part | 3 MiB |
| Decoded bundle | 512 MiB |
| App invocation | 300 seconds (`api/managed.ts` in the deployment configuration) |
| Cleanup invocation | 300 seconds (shared `api/managed.ts` function) |

Chunking keeps each upload request below Vercel's documented 4.5 MB payload limit.
Raw uploads remain subject to that platform limit even when the application permits larger files.
See [function limits](https://vercel.com/docs/functions/limitations#request-body-size).
Bundle downloads and cached derivatives use streams.
Reports and large JSON responses are materialized in memory and then written in chunks.
Sourcemap responses use HTTP Brotli decoding to restore the uploaded bytes.

Finalization buffers the complete upload.
Cold bundle processing can hold compressed bytes, decoded text, parsed objects and generated output together.
The 512 MiB decoding cap is not a total memory cap.
These operations must fit within the function's memory and duration budget.
Larger workloads can use the persistent server with the same Neon/Blob adapters.

## Team update streams

`GET /api/teams/:id/feed` streams catalog invalidations for all the user's teams, and triage/comment invalidations for the focused team.
`GET /api/teams/feed` carries only catalog updates, on Home, bundle and Manage pages, including for users with no memberships.
The browser keeps one stream at a time.

Each stream ends after 240 seconds, leaving headroom below this deployment's 300-second invocation limit.
Reconnection refreshes the catalog, and the focused team's annotations only where the revision the stream's first event tells is not the one last read.
Idle streams send 15-second heartbeats.
Stalled streams and transient failures retry with backoff.
Navigation aborts the previous request.

The function stays awaited until the stream closes.
It polls shared database state every three seconds using short read-only transactions, and releases its Neon connection to the pool before waiting.
Unchanged polls read only session/role and internal invalidation counters.
Catalog changes reload membership, scope and report/bundle metadata.
Annotation changes alone read the focused workspace revision without rebuilding its catalog.
No background process, sticky routing, persistent database connection or instance-local notification bus is required.
Each signed-in browser feed, including on landing, occupies a streaming invocation and incurs those reads; see Vercel's [streaming and duration guidance](https://vercel.com/docs/functions/streaming-functions#function-duration).

Team annotation hydration and refresh use one `GET /api/teams/:id/annotations` request for triage and comments across the workspace.
Shared annotation bodies are returned once, with per-report finding references preserving visibility.
Access is rechecked after reading the batch.
Individual management previews keep their report-scoped endpoints.

Session and team visibility are rechecked during polling.
Losing membership stops focused triage but keeps catalog notifications.
Logout, expiry or role changes send a terminal close event.
Public-share feeds use the same header capability and revocation checks as public report reads, and never receive the issuer's broader catalog.

## Coverage and limits

The repository tests cover PostgreSQL queries and rollback behavior, function initialization and retry, upload authorization and assembly, streamed responses, Blob namespaces, cache deletion races and authenticated cleanup.
PostgreSQL coverage uses PGlite, and Blob coverage uses SDK fixtures.
See these tests:

- [managed-postgres](../tests/managed-postgres.test.js)
- [managed-vercel-runtime](../tests/managed-vercel-runtime.test.js)
- [managed-vercel-storage](../tests/managed-vercel-storage.test.js)
- [managed-vercel-reap](../tests/managed-vercel-reap.test.js)
- [managed maintenance](../tests/managed-maintenance.test.js)
- [team feeds](../tests/managed-team-feed.test.js)
- [feed reconnection](../tests/managed-feed-client.test.js)
- [storage isolation](../tests/server-storage-isolation.test.js)

These tests do not validate a deployed Vercel build, live OAuth/provider credentials, platform streaming, actual concurrent Neon connections, or memory and timeout behavior at upload limits.
Those require deployment validation.

Cleanup covers sessions, upload staging, and the pretty-printed public npm copies of earlier versions.
With `MANAGED_STORAGE_ENCRYPTION_MIGRATE=1`, it also runs bounded SQL-row migration and legacy plaintext/cache cleanup.
Reports and bundles keep their paths under `.managed/`, and their SQL rows hold random data keys wrapped by `MANAGED_STORAGE_ENCRYPTION_KEY`.
Rebuilt caches use `.managed/cache-encrypted-v1/` and their bundle's data key.
GitHub access and refresh tokens are wrapped separately.
Public GitHub avatars remain unencrypted.
See [storage encryption](STORAGE-ENCRYPTION.md) for activation, migration controls, key custody and compatible database/Blob backups.
Configure the key and redeploy; the first function to open managed storage enables encryption automatically.
Preview deployments never activate it.
When a key is configured, they require an already enabled database and validate that key against its installation marker.
Rotation and old-key lists are not implemented.
