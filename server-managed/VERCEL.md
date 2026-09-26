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
| Cleanup | `api/managed-reap.ts` deletes expired sessions and upload parts older than 24 hours; cron is scheduled daily at 00:00 UTC |

The app shares initialization within a function instance and retries failed
initialization. Requests await their work; the serverless app installs no
listener, signal handlers, or maintenance timers. Missing derivatives are built
during authorized reads. Build deduplication and queues are local to each
instance; caches are shared, and builders recheck database references after
publishing to handle concurrent deletion. Access is checked again after cold
builds. Each Neon operation closes its connection before returning.

Use `DATABASE_URL` for a shared database, or `MANAGED_DATABASE_URL` for a
managed-specific database. The global URL cannot be combined with either
`MANAGED_DATABASE_URL` or `E2E_DATABASE_URL`. A managed database URL and
`BLOB_READ_WRITE_TOKEN` are required; there is no SQLite/filesystem fallback.
Changing backends does not migrate existing data. New users default to No
access. Only a matching `MANAGED_INITIAL_ADMIN_GITHUB_ID` can bootstrap the
empty database's first user as admin. Once any user exists, that variable has
no effect. See [Account approval](README.md#account-approval).

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
| `GITHUB_CLIENT_ID` | GitHub login app client ID |
| `GITHUB_CLIENT_SECRET` | GitHub login app client secret |
| `MANAGED_INITIAL_ADMIN_GITHUB_ID` | Optional numeric GitHub ID allowed to become admin on the first registration, only while the user table is empty |
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

The client reads `managed.uploadChunkBytes` from `/api/config` and splits uploads
larger than 3 MiB into 3 MiB parts. Each part is sent to
`POST /api/admin/uploads/{reports|bundles}/{uploadUuid}/{zeroBasedPart}` with the
session cookie, manager/admin access, same-origin validation, and `X-CSRF-Token`.
Parts are bound to the session, upload kind, upload ID, and part index.

Finalization posts an empty body to `/api/admin/reports` or `/api/admin/bundles`
with the filename/repository headers and `X-Upload-Id`, `X-Upload-Parts`, and
`X-Upload-Size`. The server checks part lengths and the total limit, assembles
the file, and applies parsing, access checks, hashing, and deduplication. Once
part assembly is attempted, the parts are consumed; a failed finalization may
require re-uploading. Abandoned parts become eligible for the daily cleanup
after 24 hours, so removal is not immediate at the 24-hour mark.

| Bound | Configured value |
| --- | --- |
| Report upload | 10 MiB by default (`MAX_REPORT_BYTES`) |
| Bundle upload | 100 MiB by default (`MAX_BUNDLE_BYTES`) |
| Upload part | 3 MiB |
| Decoded bundle | 512 MiB |
| App invocation | 300 seconds (`api/managed.ts` in the deployment configuration) |
| Cleanup invocation | 60 seconds (`api/managed-reap.ts` in the deployment configuration) |

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

## Coverage and limits

The repository tests cover PostgreSQL queries and rollback behavior, function
initialization/retry, upload authorization and assembly, streamed responses,
Blob namespaces, cache deletion races, and authenticated cleanup. PostgreSQL
coverage uses PGlite; Blob coverage uses SDK fixtures. See
[managed-postgres](../tests/managed-postgres.test.js),
[managed-vercel-runtime](../tests/managed-vercel-runtime.test.js),
[managed-vercel-storage](../tests/managed-vercel-storage.test.js),
[managed-vercel-reap](../tests/managed-vercel-reap.test.js), and
[storage isolation](../tests/server-storage-isolation.test.js).

These tests do not validate a deployed Vercel build, live OAuth/provider
credentials, platform streaming, actual concurrent Neon connections, or memory
and timeout behavior at upload limits. Those require deployment validation.

Cleanup covers sessions and upload staging. Explicit report/bundle deletion
also removes associated bytes and caches, but there is no general managed
orphan-object sweep to recover every failed deletion or interrupted publish.
