# Managed mode on Vercel

[vercel.managed.json](../vercel.managed.json) deploys the managed HTTP app and
UI with Neon Postgres and private Vercel Blob storage. Authentication, team
permissions, reports, bundles, triage, comments, and activity use the same
managed application as the persistent server.

The function advertises managed mode only. Combined managed/e2e mode runs on
the persistent Node launcher; it is not part of this deployment configuration.
For all backend combinations and sharing rules, see
[storage separation](../server-common/STORAGE.md).

## Runtime and storage

| Component | Current behavior |
| --- | --- |
| HTTP app | `api/managed.ts` handles API requests, assets, and managed page URLs; `out/**` is bundled with the function |
| Metadata and sessions | Neon Postgres; transactional schema initialization, serialized writers, and consistent read snapshots |
| Reports, bundles, avatars | Private Blob objects under `.managed/`; clients receive authorized responses, not Blob credentials or public URLs |
| Bundle storage | Sourcemaps are stored as Brotli; Stasis archives retain their uploaded bytes; original sizes and hashes remain in Postgres |
| Derived data | Brotli bundle metadata and gzip report sources are cached in Blob; source caches include the viewer's permissions |
| Cleanup | Ordinary requests trigger cleanup on the first request per instance, then hourly while traffic continues; `GET /api/reap` and the daily 00:00 UTC cron also remain available |

The app shares initialization within a function instance and retries failed
initialization. Requests await their work; the serverless app installs no
listener, signal handlers, or maintenance timers. Team SSE polling and heartbeat
timers exist only for the lifetime of their awaited request. Missing derivatives
are built during authorized reads. Build deduplication and queues are local to each
instance; caches are shared, and builders recheck database references after
publishing to handle concurrent deletion. Access is checked again after cold
builds. Each Neon operation closes its connection before returning.

Ordinary managed requests start a due session/upload sweep alongside the normal
response and await it before the invocation returns. Sweeps are coalesced and
throttled per instance: the first request runs one, successful sweeps defer the
next for an hour, and failures retry on traffic after a minute. Results appear
as `managed-reaper:` logs under the triggering request, including expired-session
and stale-upload-part counts. Failures are logged without failing the request.
This automatic path needs neither `/api/reap` nor `CRON_SECRET`; the authenticated
cron remains useful when there is no traffic.

Use `DATABASE_URL` for a shared database, or `MANAGED_DATABASE_URL` for a
managed-specific database. The global URL cannot be combined with either
`MANAGED_DATABASE_URL` or `E2E_DATABASE_URL`. A managed database URL and
`BLOB_READ_WRITE_TOKEN` are required; there is no SQLite/filesystem fallback.
Changing backends does not migrate existing data. New users default to No
access. On login, a matching `MANAGED_INITIAL_ADMIN_GITHUB_ID` becomes admin
only if that account has No access and is the sole user. This also recovers
an account registered before the variable was set. Any other user blocks
promotion. See [Account approval](README.md#account-approval).

E2e and managed may share a Postgres database and Blob store: their tables are
separate, and e2e cleanup skips `.managed/`. This is logical separation under
shared credentials. Multiple concurrent instances share the configured database
and Blob storage; there is no per-instance namespace. All managed tables carry
the `managed_` prefix. Startup renames tables in an existing managed database
transactionally. Instances using that database must use the same schema names.

## Deployment

Use a repository checkout and Node.js 24.x. The cloud adapters require both
optional peer dependencies declared in [package.json](../package.json):

```sh
pnpm add '@neondatabase/serverless@^1.0.2' '@vercel/blob@^2.3.3'
pnpm build
vercel --local-config vercel.managed.json
```

Include the dependency and lockfile updates in Git deployments. For Vercel Git
integration, make the managed configuration the deployment's `vercel.json`;
`--local-config` selects a configuration for CLI commands. The repository's
root `vercel.json` configures e2e cleanup and does not route the managed app.
See Vercel's [Node.js versions](https://vercel.com/docs/functions/runtimes/node-js/node-js-versions)
and [CLI configuration selection](https://vercel.com/docs/cli/global-options#local-config).

Set these variables for each deployment environment:

| Variable | Value |
| --- | --- |
| `DATABASE_URL` or `MANAGED_DATABASE_URL` | Shared or managed-specific Neon connection string; set exactly one |
| `BLOB_READ_WRITE_TOKEN` | Token for a private Vercel Blob store paired with that database |
| `MANAGED_STORAGE_ENCRYPTION_KEY` | Optional separate 32-byte base64 key for ChaCha20-Poly1305 encryption of managed Blob contents; use the same key on every instance and cleanup function |
| `GITHUB_CLIENT_ID` | GitHub login app client ID |
| `GITHUB_CLIENT_SECRET` | GitHub login app client secret |
| `MANAGED_INITIAL_ADMIN_GITHUB_ID` | Optional numeric GitHub ID promoted on login only when that account has No access and is the sole user |
| `OAUTH_CALLBACK_URL` | HTTPS callback registered with the login app, ending in `/api/oauth/github/callback` |
| `CRON_SECRET` | Cleanup authorization secret; the endpoint requires `Authorization: Bearer <secret>` |

The supplied configuration sets `NODEJS_HELPERS=0` to preserve raw request
bodies, runs `pnpm build`, and uses `out` as its output directory. Keep helpers
disabled in the deployed environment; see Vercel's
[Node.js configuration](https://vercel.com/docs/functions/runtimes/node-js/advanced-node-configuration#disabling-helpers-for-nodejs).
Under `VERCEL=1`, managed configuration defaults proxy trust on and requires an
HTTPS OAuth callback. Optional repository-access GitHub app credentials and
application limits are defined in [config.ts](config.ts).

## Uploads and resource limits

The client reads `managed.uploadChunkBytes` and `managed.uploadMaxBytes` from
`/api/config`, rejects files over the report/bundle limit before uploading, and
splits uploads larger than 3 MiB into 3 MiB parts. Each part is sent to
`POST /api/admin/uploads/{reports|bundles}/{uploadUuid}/{zeroBasedPart}` with the
session cookie, manager/admin access, same-origin validation, and `X-CSRF-Token`.
Parts are bound to the session, upload kind, upload ID, and part index.

Finalization posts an empty body to `/api/admin/reports` or `/api/admin/bundles`
with the filename/repository headers and `X-Upload-Id`, `X-Upload-Parts`, and
`X-Upload-Size`. The server checks part lengths and the total limit, assembles
the file, and applies parsing, access checks, hashing, and deduplication.
Size-limit failures during finalization and rejected later chunks delete the
staged parts too. Clients also cancel failed or interrupted uploads with
`DELETE /api/admin/uploads/{reports|bundles}/{uploadUuid}` and `X-Upload-Parts`
set to the number of attempted parts. This requires the same session,
manager/admin access, origin and CSRF checks; it cannot delete another session's
parts or published reports/bundles. Cleanup has a bounded part count even for
forged counts and retains the original upload error if deletion fails.
A failed finalization may require re-uploading. Abandoned parts or failed
deletions become eligible for automatic maintenance or explicit cleanup after
24 hours, so removal is not immediate at the 24-hour mark.

| Bound | Configured value |
| --- | --- |
| Report upload | 10 MiB by default (`MAX_REPORT_BYTES`) |
| Bundle upload | 200 MiB by default (`MAX_BUNDLE_BYTES`) |
| Upload part | 3 MiB |
| Decoded bundle | 512 MiB |
| App invocation | 300 seconds (`api/managed.ts` in the deployment configuration) |
| Cleanup invocation | 300 seconds (shared `api/managed.ts` function) |

Chunking keeps individual upload requests below Vercel's documented 4.5 MB
payload limit. Raw uploads remain subject to that platform limit even when the
application permits larger files. See [function limits](https://vercel.com/docs/functions/limitations#request-body-size).
Bundle downloads and cached derivatives use streams; reports and large JSON
responses are materialized in memory and then written in chunks. Sourcemap
responses use HTTP Brotli decoding to restore the uploaded bytes.

Finalization buffers the complete upload, and cold bundle processing can hold
compressed bytes, decoded text, parsed objects, and generated output together.
The 512 MiB decoding cap is not a total memory cap. These operations must fit
within the function's memory and duration budget. Larger workloads can use the
persistent server with the same Neon/Blob adapters.

## Team update streams

`GET /api/teams/:id/feed` streams catalog invalidations for all the user's teams
and triage/comment invalidations for the focused team. `GET /api/teams/feed`
carries only catalog updates on Home, bundle and Manage pages, including for
users with no memberships. The browser keeps one stream at a time.

Each stream ends after 240 seconds, leaving headroom below this deployment's
300-second invocation limit. Reconnection refreshes the catalog and any focused
annotations. Idle streams send 15-second heartbeats; stalled streams and
transient failures retry with backoff. Navigation aborts the previous request.

The function stays awaited until the stream closes. It polls shared database
state every three seconds using short read-only transactions, releasing each
Neon connection before waiting. Catalog polling reads membership, scope and
report/bundle metadata; only focused triage needs report visibility and
annotation revisions. No background process, sticky routing, persistent
database connection, or instance-local notification bus is required. Each
signed-in browser feed, including on landing, occupies a streaming invocation
and incurs those reads; see Vercel's
[streaming and duration guidance](https://vercel.com/docs/functions/streaming-functions#function-duration).

Session and team visibility are rechecked during polling. Membership loss stops
focused triage while retaining catalog notifications; logout, expiry or role
changes send a terminal close event. Public-share feeds use the same header
capability and revocation checks as public report reads and never receive the
issuer's broader catalog.

## Coverage and limits

The repository tests cover PostgreSQL queries and rollback behavior, function
initialization/retry, upload authorization and assembly, streamed responses,
Blob namespaces, cache deletion races, and authenticated cleanup. PostgreSQL
coverage uses PGlite; Blob coverage uses SDK fixtures. See
[managed-postgres](../tests/managed-postgres.test.js),
[managed-vercel-runtime](../tests/managed-vercel-runtime.test.js),
[managed-vercel-storage](../tests/managed-vercel-storage.test.js),
[managed-vercel-reap](../tests/managed-vercel-reap.test.js),
[managed maintenance](../tests/managed-maintenance.test.js),
[team feeds](../tests/managed-team-feed.test.js),
[feed reconnection](../tests/managed-feed-client.test.js), and
[storage isolation](../tests/server-storage-isolation.test.js).

These tests do not validate a deployed Vercel build, live OAuth/provider
credentials, platform streaming, actual concurrent Neon connections, or memory
and timeout behavior at upload limits. Those require deployment validation.

Cleanup covers sessions and upload staging. With
`MANAGED_STORAGE_ENCRYPTION_KEY`, it also runs bounded plaintext migration and
collects unreferenced ciphertext after a 24-hour grace period. New payloads and
caches are encrypted under `.managed/encrypted-v1/`; the SQL manifest resolves
their logical paths. See [storage encryption](STORAGE-ENCRYPTION.md) for rollout,
migration commands, key custody and backup requirements. Deployments without
this key retain plaintext application payloads inside private Blob and do not
have a general managed orphan-object sweep.
