# Managed mode on Vercel

Managed mode uses the same providers as server-e2e: Neon Postgres and private
Vercel Blob storage. The optional Neon driver and Blob SDK boundary are shared.
The existing e2e deployment configuration in `vercel.json` is unchanged;
`vercel.managed.json` deploys managed mode independently.

## Compatibility review

The following parts of the original managed server did not work unchanged in
Vercel Functions:

1. **SQLite metadata and sessions** (`db.ts`, `index.ts`). A local database is
   neither durable nor shared across function instances. `db-methods.ts` now
   holds the common asynchronous queries and behavior; `sql.ts` owns operation
   transactions, and `db-neon.ts` supplies Neon connections. SQLite upgrades
   stay in `db.ts`. PostgreSQL bootstrap is versioned and transactional.
2. **Report and bundle bytes** (`blob-store.ts`). The startup always selected
   filesystem storage. `storage.ts` now selects the disk or private Vercel
   implementations of the same `BlobStore` interface. Both use `BundleStore`
   to compress sourcemaps once into `.map.br` objects and retain uploaded
   Stasis archives unchanged. Original sizes and hashes stay in the database.
3. **Avatars, bundle derivatives, and report sources** (`avatar-store.ts`,
   `bundle-cache.ts`, `report-sources.ts`). These previously depended on writable
   local directories. Avatars now have a
   private Blob adapter; bundle generation uses `BundleCacheStorage` with disk
   and Blob adapters. Only Brotli metadata is cached; contents stream directly
   from the stored Brotli bundle. Cache eviction is safe: metadata can be rebuilt from
   durable uploads. Report-scoped sources use `CacheStorage` with disk and private
   Blob adapters. Gzip responses retain main's report hash, filename format and
   viewer-permission isolation, with authorization rechecked after cold builds.
   Both caches reconcile deletion after publishing across function instances.
   Process-local maps only deduplicate computation.
4. **Listener, timers, and detached work** (`index.ts`, `http.ts`). The new
   `api/managed.ts` awaits requests without starting a listener or installing
   process signal handlers or cleanup intervals. Speculative background bundle
   generation is disabled in functions; authorized reads build a missing cache
   within the invocation. `api/managed-reap.ts` performs session and staging
   cleanup through authenticated Vercel Cron.
5. **Uploads larger than a function request** (`http.ts`,
   `client/managed/request.js`). The old raw POST could exceed Vercel's request
   payload ceiling. The managed client negotiates `uploadChunkBytes` from
   `/api/config`, stages 3 MiB chunks, then finalizes with a small POST. Raw
   uploads still work for small files and existing local servers. The report
   and bundle limits remain 10 MiB and 100 MiB by default.
6. **Large buffered responses** (`http.ts`). Reports and large JSON responses
   write chunks through Node's streaming response API. Bundle metadata,
   contents, report sources, and downloads stream from disk or private Blob storage with
   backpressure. Sourcemap downloads use HTTP Brotli decoding to restore the
   uploaded bytes; Stasis downloads remain byte-identical archives.
7. **Function routing and raw request bodies**. The managed Vercel config
   bundles `out/**`, routes API and History API page URLs to the managed
   handler, and keeps cleanup separate. It sets `NODEJS_HELPERS=0` to preserve
   raw request bytes. Proxy trust defaults on under `VERCEL=1`, and HTTPS
   OAuth is required so session cookies remain secure.

Managed mode's GitHub requests and external scan service do not require local
processes. There is no managed WebSocket server to port. The combined launcher
continues to compose the e2e and managed apps on a persistent Node listener;
the managed Vercel entry point advertises managed mode only.

In a combined process, `DATABASE_URL` and `DB_PATH` belong to e2e. Managed mode
keeps using `MANAGED_DB_PATH` (or its default SQLite path) unless
`MANAGED_DATABASE_URL` explicitly selects Neon. Standalone and Vercel managed
deployments also accept `DATABASE_URL` as a fallback.

## Deploy

Use Node.js 24.x and install the same optional peers required by e2e's Neon
mode. Commit the dependency/lockfile updates for a Git-based deployment:

```sh
pnpm add @neondatabase/serverless @vercel/blob
pnpm build
vercel --local-config vercel.managed.json
```

For Vercel Git integration, use `vercel.managed.json` as the project's
configuration (copy it to `vercel.json` in the deployment branch). The CLI
`--local-config` option applies to CLI deployments only.

Set these variables in the Vercel project, for each deployment environment:

| Variable | Purpose |
| --- | --- |
| `MANAGED_DATABASE_URL` or `DATABASE_URL` | Neon Postgres connection string; managed-specific value takes precedence |
| `BLOB_READ_WRITE_TOKEN` | Token for a **private** Vercel Blob store |
| `GITHUB_CLIENT_ID` | GitHub login app client ID |
| `GITHUB_CLIENT_SECRET` | GitHub login app secret |
| `OAUTH_CALLBACK_URL` | `https://your-host/api/oauth/github/callback`, registered with GitHub |
| `CRON_SECRET` | Secret used by Vercel's authenticated cleanup requests |

The optional repository-access GitHub app variables and upload/history limits
work as on the standalone managed server. Use separate databases and Blob
stores for production and preview environments. Missing durable storage causes
startup to fail; Vercel never silently falls back to local SQLite.

Reports, bundles, avatars, cache files and upload parts use separate prefixes
under `.managed/`. No public Blob URL is returned to clients. The e2e blob
reaper excludes this namespace. Existing managed SQLite data is **not**
automatically copied into Neon or Blob: a new Neon database starts empty.
The first registered user becomes its admin.

## Upload protocol and runtime bounds

For a large upload, POST each binary part to
`/api/admin/uploads/{reports|bundles}/{uploadUuid}/{zeroBasedPart}`. Every
request requires the session cookie, same-origin validation, manager/admin
role, and `X-CSRF-Token`. Parts are keyed by a hash of the authenticated session,
upload kind, upload ID, and part index. They cannot be read by another session
or finalized under another kind. The client does not receive storage tokens.

Finalize by POSTing to the ordinary `/api/admin/reports` or
`/api/admin/bundles` endpoint with an empty body, the ordinary filename/repo
headers, and `X-Upload-Id`, `X-Upload-Parts`, and `X-Upload-Size`. The server
checks the total limit and each exact part length, reconstructs the bytes,
then applies the existing parsing, permissions, integrity, and deduplication
logic. Finalization consumes the parts. Retry a failed finalization by
re-uploading; incomplete transfers are collected after 24 hours. Daily cron
also deletes expired sessions; session reads reject expiry immediately. Cleanup
finishes listing all staging pages before deleting expired parts so deletions
cannot shift pagination and skip objects.

Neon writers use a shared transaction lock so first-admin selection, slugs,
comment version checks, triage/history changes and team-grant replacements
remain atomic across instances. Reads use consistent snapshots. Connections
are closed before each operation returns. PGlite parity tests cover SQL and
rollback semantics; they do not simulate actual concurrent Neon connections.

Chunking removes the request payload bottleneck, but a finalization or cold
bundle conversion must still finish within the configured 300-second function
window and available memory. Bundle decoding retains its 512 MiB safety cap.
For larger workloads, use the persistent server with the same Neon/Blob
backends. This config deploys the full managed HTTP app, not the combined e2e
listener.

Platform references: [function limits](https://vercel.com/docs/functions/limitations),
[streaming](https://vercel.com/docs/functions/streaming-functions),
[raw Node.js requests](https://vercel.com/docs/functions/runtimes/node-js/advanced-node-configuration),
and [project configuration](https://vercel.com/docs/project-configuration/vercel-json).
