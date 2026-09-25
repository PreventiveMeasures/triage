# Managed browser navigation

Build the UI with `pnpm build` before starting a managed or combined server.
Managed pages use the History API: navigation pushes a URL, Back/Forward
restores it, and reloading opens the same page. PWA launches into an existing
window also navigate to their managed page URL.

| URL | Page |
| --- | --- |
| `/` | Team landing / login |
| `/teams/:teamId` | Team findings |
| `/teams/:teamId/files` | Team files |
| `/teams/:teamId/reports/:reportId` | Report findings |
| `/teams/:teamId/reports/:reportId/files` | Report files |
| `/bundles/:bundleId` | Bundle overview, files and dependency graph |
| `/manage` | Manage overview |
| `/manage/bundles` | Bundles |
| `/manage/scans` | Scans |
| `/manage/reports` | Reports |
| `/manage/repositories` | Repositories (admin) |
| `/manage/users` | Users (admin) |
| `/manage/teams` | Teams (admin) |
| `/manage/history` | Activity history; optional `?actor=<login>` |

Manage pages require a manager or admin. Team and report URLs require the
current user's team access. Unavailable pages return to the landing page;
Files falls back to Findings when the reports have no multi-file source tree.
Switching between Findings and Files reuses the loaded reports and filters.

Managed and combined servers serve the same entry HTML for page GET/HEAD
requests, including direct loads of nested URLs. Assets resolve from `/`.
`/api` and `/api/*` always retain their API handling, including unknown routes;
missing assets and non-GET/HEAD requests do not receive fallback HTML.

E2E and local mode do not use this page router. A mode switch returns to `/`
and invalidates the old managed history entries, so Back cannot reopen them.
History contains a navigation generation only, with no report or triage data.
The server mode's advertised default still applies on reload.

# Report repository metadata

Managed report headers use the repository assignment stored on the server,
including its directory, even when the report embeds a different repository.
They do not offer the local “Set repo” editor. Findings retain their own upstream
repository metadata (for example, a dependency's repository); source links that
need a report fallback use the server assignment.

`GET /api/reports/:id` with `Accept: application/json` returns
`{ content, repo: { github, directory } }`. Content has the same permission
filtering as the raw text response, and `github: null` means unassigned. Other
callers still receive raw text. JSON can appear in a media-range list or carry
parameters; `q=0` excludes it, and wildcards alone retain raw text. The local
fixture server uses the same response contract. Responses are never cached or
stored locally.

# Activity history

`/manage/history` reads `GET /api/admin/history?page=1&limit=100&kind=all&q=`.
The server returns `{ history, total, page, limit }`, newest first, with at most
100 entries per page. Type and text filters apply before pagination. Supported
types are `triage`, `upload`, `visibility`, `access`, `repository`, and `delete`.

Admins see all workspace activity. Managers see uploads, publication changes,
assignments, and triage involving reports and bundles within their current team
access. Reports also obey team directory scopes, including unpublished reports.
Repository administration, team changes, and role changes remain admin-only.
Counts, search results, and displayed context obey the same restrictions.
Deletion events use the content's repository/path at deletion and the manager's
current grants. Other events for removed content, and legacy bundle events
without durable target IDs, remain admin-only.
The client retains history only in memory; responses are never HTTP-cached.

Uploads and triage changes already stored in the database appear automatically.
New uploads are recorded atomically with their metadata. Report publication,
repository assignments and connections, content deletion, roles, teams, and
team access changes are recorded after successful management requests.
Repeated edits that change nothing, failed requests, and deduplicated uploads
do not add entries. Upload and management snapshots survive content deletion.
Triage history follows `TRIAGE_HISTORY_LIMIT` and explicit triage deletion.

Older management actions were not recorded and cannot be reconstructed; older
triage events may have no originating report name. The feed contains actors,
actions, targets, and timestamps, not annotation bodies or credentials.

# Manager content access

Managers manage reports and bundles and oversee triage only in repositories
assigned to their teams. Report access also requires a matching team directory
scope; bundles use repository access. These rules apply to catalogues, downloads,
uploads, visibility changes, assignment changes, deletion, and triage. Managers
can review unpublished reports in scope. Viewer and triage roles still require
publication. Administrators retain unrestricted content access.

Managers cannot create unassigned content, detach content, or move it outside
their team scopes. Repository pickers contain only allowed repositories. Reports
without embedded repository metadata can use the repository and directory
controls on the upload page. Bundle deduplication never returns inaccessible
bundle IDs or names, and manager uploads only auto-link accessible reports.
Repository connections, teams, memberships, and user roles are admin-only.

# User timestamps

The Users page reads Last Activity from the latest retained triage, upload, or
management history entry attributed to that user's stable ID. Reading pages,
failed requests, unchanged edits, and deduplicated uploads do not add activity.
The user row is not updated for Last Activity; Last seen independently tracks
session authentication. Upload and management entries retain their actor ID
when content is deleted or an account is renamed.

Existing triage and uploads whose original metadata remains are attributable
on upgrade. Older management entries recorded only a display login, so they
cannot be safely assigned to an account after a rename or login reuse. Users
without attributable history show Unknown. Triage retention/deletion still
applies because Last Activity is derived from the retained history.

# Bundle metadata and contents

`GET /api/bundles/:id/metadata` returns the shared `common/bundle-metadata.js`
format: file inventory, byte sizes, source hashes and line counts, package
identity, imports, entry points, executable flags and language/code statistics.
It excludes source bodies and binary resources. `GET /api/bundles/:id/contents`
returns the original sourcemap JSON or the decompressed Stasis JSON.
Both endpoints support HEAD and stream cached files with `Content-Encoding:
gzip`, compressed Content-Length, and `Cache-Control: private, no-store`.
`GET /api/bundles/:id/download` serves the original uploaded bytes.

The cache lives beside the managed database under `cache/bundles/:id/`.
Uploads schedule a prebuild; reads build missing derivatives on demand. Builds
are deduplicated and serialized to bound memory, with a 512 MiB decoded limit.
Files are published atomically and removed on bundle or repository deletion,
including when a build was already in flight. Invalid/unsupported bundles can
still be downloaded as uploaded; derivative requests return 422.

Admins can read/manage every bundle. Managers can read/manage bundles they own
or can access through their teams. View/triage users need team access; the none
role has no bundle access. Ownership survives repository attachment. Adding a
repo link requires bundle management access and access to the destination repo;
removing a link requires access to the current repo. Moving or deleting an
attached bundle therefore checks the current repo too, even for its owner.
Manage lists and repository pickers enforce these rules on the server.

Opening a bundle downloads its metadata into managed app memory. Code,
Terminal, source search and source comparison request contents when needed;
the browser handles HTTP gzip decoding. Neither payload enters OPFS, IndexedDB
or localStorage. Session/role changes clear managed caches and terminal state.
