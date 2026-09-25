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

# Fix pull requests

`POST /api/github/pull-requests` accepts `{ "urls": ["https://github.com/Owner/Repo/pull/123"] }`
with at most 50 links. A managed session, same-origin request, and `X-CSRF-Token`
are required. Results preserve input order in `{ pullRequests: [...] }`, with
`{ url, title, status }` on success (`open`, `draft`, `closed`, or `merged`), or
`{ url, error }` (`invalid-url`, `forbidden`, or `unavailable`) per failed item.
Malformed batches return 400; empty batches return an empty list.

Each link's repository is matched case-insensitively against the repositories
assigned to the user's teams, including for administrators. A directory grant
counts as membership in its repository. GitHub requests use that repository's
stored full name and only the validated positive safe integer from the link;
other link components never supply the upstream path. Duplicates share a lookup.

Team access is not GitHub access. Requests use only the signed-in user's stored
GitHub token, refreshing it when possible. Missing credentials, denied GitHub
access, redirects, and upstream failures leave the Fix link usable without
metadata. Installation credentials are never substituted. Responses are not
HTTP-cached; the UI batches links and keeps metadata in memory for one minute,
invalidating it on account, team, or mode changes.

# Managed comments

Comments live in `finding_comment`, independently of the shared triage row.
Each has its own ID, finding ID, text, optional author ID/login, creation and
edit timestamps, and a version. New comments are attributed to the authenticated
user; the client cannot choose the author. Readers see the discussion; users
with triage access can add comments and edit their own. Edits require the version
that was read, so stale edits receive 409 instead of overwriting newer text.

`GET /api/reports/:id/comments` returns comments for the findings that user can
see. `POST` accepts `{ findingId, body }`; `PATCH /api/reports/:id/comments/:commentId`
accepts `{ body, version }`. Mutations require CSRF and current report/triage
access. Text is nonempty and limited to 10,000 characters. Comments are shared
across reports carrying the same finding and stay in browser memory only.

Existing triage-row comment text is migrated once to unattributed records. The
last triage writer is not reliable evidence of authorship, so migration does not
claim an author. Unattributed comments remain readable; users cannot claim or
edit them. Legacy triage history is preserved. New shared-field comment writes
are rejected; e2e/local/sync comment storage and editing are unchanged.

Comment additions and edits contribute to scoped activity history and user
Last Activity, without copying their text into the activity feed. Ordinary
triage updates and clears do not change comments. Explicit repository annotation
deletion includes comments, while preserving findings shared by other repos.

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

Managers manage reports and bundles they uploaded or can access through
repositories assigned to their teams. Access through teams also requires a
matching directory scope for reports; bundles use repository access. These rules apply to catalogues, downloads,
uploads, visibility changes, assignment changes, deletion, and triage. Managers
can review unpublished reports in scope. Viewer and triage roles still require
publication. Administrators retain unrestricted content access.

Managers can upload unassigned content and retain access to their own uploads.
Detaching or deleting attached content requires access to its current repository
(and report path); assigning it requires access to the destination. Repository
pickers contain only allowed repositories. Reports without embedded repository
metadata can use the repository and directory
controls on the upload page. Bundle deduplication never returns inaccessible
bundle IDs or names, and manager uploads only auto-link owned or team-accessible
reports.
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


# Report access and blocked accounts

Report lists, previews, downloads and triage reads use the same access scope:
admins can read all reports; managers can read their uploads or reports within
their team repository paths. Other readers need a published report inside a
team path. Uploader ownership does not grant access to view/triage/none roles.
Report repository changes, publication and deletion also require access to the
current repository path; new links require access to the destination path.

The `none` (No access) role is denied at the managed data API boundary, even
when the account owns uploads or belongs to teams. This includes team names,
avatars, report/triage data, bundle caches, and every management endpoint.
Public bootstrap, the user's own session status and sign-out remain available.
The client shows a no-access page and clears previously loaded data when the
role changes.
