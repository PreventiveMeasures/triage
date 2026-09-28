For deployment on Vercel, see [the deployment guide](VERCEL.md).
For database selection, shared-storage boundaries, and cleanup behavior across
both server modes, see [storage separation](../server-common/STORAGE.md).

# Account approval

GitHub sign-in establishes identity. New accounts default to the `none`
(No access) role. To preapprove the initial administrator, set this optional
environment variable to that account's numeric GitHub user ID:

```sh
MANAGED_INITIAL_ADMIN_GITHUB_ID=123456
```

On successful GitHub sign-in, the matching account gets `admin` only if its
role is `none` and it is the **only user in the database**. This applies to
the first registration and to later logins. If the intended administrator
signed in before the variable was set, set it and have them sign in again.
The identity update, sole-user check, and promotion share one transaction.

Changing configuration, restarting, or reading an existing session does not
trigger promotion. Assigned roles other than `none` are preserved. Any other
user row, even one with No access, blocks automatic promotion. An unset or
empty variable disables promotion; invalid IDs fail startup.
Team membership, upload ownership, and GitHub repository access do not grant
a workspace role.

For a deployment with multiple users and no admin, a trusted operator must approve
the intended account directly in the managed SQLite or Neon database. Verify
the numeric GitHub user ID and replace `123456` with it:

```sql
UPDATE managed_user SET role = 'admin' WHERE github_user_id = 123456;
```

Verify that exactly the intended row was updated. The administrator can then
approve other users through **Manage → Users**, and assign team access through
**Manage → Teams**. Database upgrades preserve existing roles.

These approval rules apply to the managed service. Combined managed + E2E
deployments retain the E2E service's separate authentication and permissions.

# Managed browser navigation

## Public workspace links

Set `DEEPVIEW_ALLOW_SHARE=1` to let a manager share a team they belong to, or
an administrator share any team, using the sidebar's **Share public link** button.
The sidebar button appears on hover or keyboard focus and remains visible on
devices without hover. Sharing is
disabled when unset or set to any other value, including for existing links in
the database. The dialog creates a read-only link and can
revoke all public links for that workspace. Anyone holding a link can open it
without GitHub sign-in, including on combined managed + E2E deployments.

New links use `/team/<team-slug>#public=<link-id>.<token>`. The eight-character
link ID matches the ID shown in the dropdown and Manage's Links tab, so a URL can
be matched to its entry for editing or revocation. It is a prefix of the stored
token hash, not a credential. The full token uniquely resolves the workspace;
the slug and short ID cannot grant access or select another team's data. Older
links with a team ID before the token remain valid.

A link exposes that team's currently published reports, links, triage, comments
and cited source files. **Security** and **Dependencies** are independent opt-ins
in the creation dialog, both off by default. Existing links also migrate with
both permissions off until a manager explicitly enables them. The same finding
filters apply to report data, comments, triage/history and cited sources. Future
published reports in the team's repository paths are included; drafts and
other workspaces are excluded. Whole-repository team grants also expose their
bundles; published npm advisories require the security opt-in. Directory-only grants expose cited source
files, not entire bundles. GitHub PR metadata and user avatars require account
access and are not fetched in public views.

Tokens contain 256 random bits; only their SHA-256 hashes are stored, separately
from sessions. They persist across restarts and issuer logout, and stop working
when revoked, sharing is disabled, the team is deleted, or the issuer no longer
has administrator access or a manager role with membership in that team. Reads recheck the current
scope after slow storage or upstream work. Turning the flag off does not delete
links; re-enabling sharing makes any unrevoked links usable again.

The **Links** tab in Manage lists public links grouped by team, with their creator,
creation time and permissions. Managers see only their teams' links; administrators
see all links. Select **Edit** to change permissions without changing the URL or
revoke a link. The share dialog also lists the team's links and can revoke all of them.
Only hashes are stored, so an existing link's original URL cannot be recovered from
the listing; copy a newly created URL before closing the dialog.

`GET /api/admin/links` lists links within the manager's scope. `GET /api/teams/:id/share`
lists one team's links. `POST` creates a link with `{ security, dependencies }`, where
only literal `true` opts in; `PATCH /api/teams/:id/share/:id` replaces those permissions.
`DELETE` on a link revokes just that link; `DELETE` on the team's collection revokes all.
These require an authenticated team manager or administrator; mutations also require
same-origin access and CSRF. Public
clients send the fragment token in `X-Deepview-Share`, with no cookies. A supplied
token takes precedence over any login cookie and is confined to an explicit
allowlist: `/api/shares/:linkId/workspace` (only the token's own workspace),
`/api/teams/:id/{shared,reports,feed}`, visible reports' read-only
`triage`, `triage/history`, `comments`, and `sources` routes, and authorized
bundles' `metadata`, `contents`, `download`, and `advisories` routes. Global
endpoints, mutations, unknown routes, cleanup and sync transports are denied.
The token stays in the URL fragment across browser navigation, rather than
being sent in page URLs or stored in local storage.

## Page routes

Build the UI with `pnpm build` before starting a managed or combined server.
Managed pages use the History API: navigation pushes a URL, Back/Forward
restores it, and reloading opens the same page. PWA launches into an existing
window also navigate to their managed page URL.

| URL | Page |
| --- | --- |
| `/` | Team landing / login |
| `/team/:teamSlug` | Team findings |
| `/team/:teamSlug/files` | Team files |
| `/team/:teamSlug/report/:reportSlug` | Report findings |
| `/team/:teamSlug/report/:reportSlug/files` | Report files |
| `/team/:teamSlug/finding/:findingId` | Finding in a team |
| `/team/:teamSlug/report/:reportSlug/finding/:findingId` | Finding in a report |
| `/team/:teamSlug/bundle/:bundleSlug[/:tab]` | Team bundle; active tab is part of the URL |
| `/manage/bundle/:bundleSlug[/:tab]` | Bundle opened without an accessible team (manager/admin) |
| `/manage` | Manage overview |
| `/manage/bundle` | Bundles |
| `/manage/scans` | Scans |
| `/manage/report` | Reports |
| `/manage/repositories` | Repositories (admin) |
| `/manage/users` | Users (admin) |
| `/manage/team` | Teams (admin) |
| `/manage/history` | Activity history; optional `?actor=<login>` |

Page tokens are persistent server-assigned slugs: the last UUID component when
unique, otherwise the full ID, with the same allocation rules for teams, reports,
and bundles. API requests and database relationships continue to use full IDs.
Existing bundle rows receive stable slugs during the SQLite/PostgreSQL upgrade.

Finding IDs are percent-encoded as one path component. Finding links only appear
under a team or report; there is no root `/finding/:id` route. E2E finding hashes
remain supported and resolve to the accessible managed team/report destination.
Old plural managed page URLs fall back to the landing page without redirects.
Sidebar search filters the loaded team/report/bundle names locally, without
fetching report contents or changing the catalogue used to open a team.

Bundle links retain the clicked team, even when several teams share a repository.
The optional tab suffix is omitted for Overview. Reload and Back/Forward restore
the tab; switching bundles retains it when available. Compare offers accessible
bundles assigned to the same repository, including bundles not previously opened.
Unattached bundles cannot be compared with each other.

Manage pages require a manager or admin. Team, report, and team bundle URLs require
the current user's team access. Unavailable pages return to the landing page;
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

# Repository additions

Adding repositories currently requires a server admin. Installed discovery
defaults to the acting user's GitHub access; **Show all** lets admins choose any
repository available to the repository App. Effective permission checks use
GitHub's [Get repository permissions for a user](https://docs.github.com/en/rest/collaborators/collaborators#get-repository-permissions-for-a-user)
endpoint with an installation token and **Metadata: read**, not Administration.

Public discovery lists repositories the actor is involved with. The separate
**Add a public repository** input is available only to admins whose numeric
GitHub ID is in `WHITEHAT` in `repository-policy.ts`. Its POST endpoint,
`/api/admin/repositories/add-public`, accepts `{ "repository": "owner/repo" }`
or an exact GitHub repository URL, with the usual session, origin and CSRF checks.
It verifies public visibility without user credentials and stores GitHub's
canonical metadata. The allowlist bypasses only the public involvement safeguard;
it never grants server permission to add repositories or access private repos.

# Report repository metadata

Managed report headers use the repository assignment stored on the server,
including its directory, even when the report embeds a different repository.
They do not offer the local “Set repo” editor. Findings retain their own upstream
repository metadata (for example, a dependency's repository); source links that
need a report fallback use the server assignment.

`GET /api/teams/:id/reports` returns the complete workspace as separate
`{ id, filename, data, repo: { github, directory } }` envelopes in `{ reports }`.
The server derives the report list from that team's repository paths and the
caller's membership. Ordinary users receive published reports filtered by that
team's security/dependency grants; grants in other teams do not broaden the
answer. Admins and managers retain their filtering bypass. Opening an individual
report in the viewer selects it from the same whole-team response.

Links files are uploaded, assigned and published like reports in Manage. Their
wire data is `{ source: 'links', findings: [], links: [[findingId, ...], ...] }`.
Security propagates across complete rows and links in the chosen team before
dependency filtering. Links in the response contain only remaining finding IDs,
and each retained link names at least two distinct findings. Unavailable reports
and unpublished/out-of-scope links do not contribute to an ordinary user's view.

`GET /api/reports/:id` and `POST /api/reports/query` are reserved for admins and
managers, with existing ownership/team access rules. Individual previews with
`Accept: application/json` return `{ data, repo: { github, directory } }`;
other callers receive raw text. `github: null` means unassigned.

Managed clients cache complete workspace responses only in JavaScript memory,
keyed by team and invalidated on catalogue or session changes. HTTP responses
use `no-store`; no report response is written to browser storage.

Ordinary users supply `?team=:teamId` for report triage, history, comments and
sources. These endpoints authorize against the same complete workspace and
recheck access after cold reads. Triage and comments remain shared by finding ID
across teams; the team is only the authorization context.

# Live team updates

`GET /api/teams/:id/feed` is a read-only SSE subscription for an approved
user. One connection carries two invalidations, each with `data: {}`:

- `teams`: the current user's memberships, grants, repository scopes, team names,
  and visible reports/bundles across **all teams they belong to**. The client
  refreshes `GET /api/teams`.
- `triage`: visible triage and comments for **only the focused team**. The client
  refreshes the existing report annotation APIs.

`GET /api/teams/feed` provides the same catalog updates without subscribing to
triage. It works even before the user has joined a team. Both event types are
sent on connection when applicable, so reconnects recover missed changes
without a replay cursor. Notifications contain no finding IDs, annotation
bodies, membership details, or global history sequence numbers. Writes continue
through the existing POST/PATCH/DELETE routes.

The feed checks shared database state every three seconds, so instances using
SQLite or Postgres see each other's writes. Transactions finish before each
wait; catalog reads do not write session timestamps. Visibility is recomputed
when the focused team's reports or grants change, and concurrent access changes
discard stale annotation reads. Catalog notifications are sent before report
parsing; unreadable report blobs suspend only triage, which retries on later
polls. Losing that team removes its triage subscription while the
membership/catalog feed continues. Logout, session expiry or a role
change sends terminal `event: close` and requires session revalidation.

The UI keeps one feed, replacing it on navigation. Home, bundles and Manage use
the catalog-only feed; the focused team's triage subscription starts after its
reports hydrate. Catalog updates refresh the sidebar and landing links, evict
changed report, source and bundle caches, and reload affected open content if
still accessible. Logout and local mode close the subscription. Live annotation reads
preserve pending local edits and refresh Fix metadata when needed.

Public-share feeds remain limited to the single capability workspace. They
never subscribe to the issuer's memberships or other teams; capability or
workspace changes close them for revalidation.

Heartbeats run every 15 seconds; streams end after at most 240 seconds and
reconnect. Slow consumers are disconnected without queuing a backlog.

# Fix pull requests and issues

`GET /api/teams/:id/fixes` returns GitHub PR and ordinary issue metadata
for the workspace. It requires an approved managed session (at least `view`)
and membership in that team. URLs come only from persisted Fix links on findings
surviving the same workspace security and dependency filters as report reads,
including whole-row and linked security propagation. Admins and managers retain
their report-filter bypass. The caller supplies only the team ID, never a URL
list. Both the former `POST /api/github/pull-requests` and the team
`GET /api/teams/:id/pull-requests` endpoints are removed.

Each link's repository must match a repository assigned to this team, including
for administrators. Directory grants count as repository membership. Links to
other repositories are omitted entirely, even if their metadata was cached;
they keep the plain link presentation used in local/E2E mode. Other Fix values
are skipped. An empty workspace returns an empty list.

The response is `{ fixes: [...] }`. Successful items contain
`{ url, title, description, status, stateReason }`, where `description` is GitHub's body text
(or null), and status is `open`, `draft`, `closed`, or `merged`. Ordinary issues
use `open` or `closed`. Closed issues also have `stateReason`: `completed`,
`not_planned`, `duplicate`, or `unknown` when GitHub provides no recognized reason.
Other items use null. Completed issues appear purple like merged PRs; not-planned,
duplicate and unknown closed issues appear muted, with distinct labels for the
known reasons. An eligible item with no metadata has
`{ url, error: "unavailable" }` and remains usable as a plain Fix link.

`managed_github_metadata` persists titles, descriptions, statuses, closure reasons and fetch times
without eviction. Records are shared by stable repository ID, item type and
number. Every read
requires the current user’s membership in the selected team, that team’s repo
grant, and a visible finding carrying the Fix link. Cached data never grants
access to another team, repository, or hidden finding.
Both SQLite and PostgreSQL create the table for existing installations. Cached
merged PRs are never requested again. Closed items also stay cached; only open
items (including draft PRs) older than one minute are queued for refresh.
An exception is closed issues cached before closure reasons were stored: they
are backfilled once successfully, keeping their old metadata on failure. A null
reason marks these legacy entries; `unknown` completes backfill even if GitHub
does not provide a reason. Database upgrades preserve all existing cache rows.

Every workspace read returns all available cached metadata, including stale open
items. Its upstream queue takes missing entries first, then fills any remaining
slots with stale open entries and legacy closed issues, oldest first, up to 200 distinct items total. A
larger workspace is still a successful response. Successful refreshes replace
cached values; GitHub failures, missing credentials, or an exhausted request
budget retain the old data. Cached entries are ordered by their latest successful
fetch or refresh attempt. Failed attempts rotate behind entries not checked as
recently, without updating their successful fetch time, so repeated failures
cannot monopolize the backfill queue. Only started reads record attempts;
entries skipped by the cap, deadline, or absent credentials keep their place.
There are at most four upstream calls in flight,
with one shared 10-second deadline for token refresh and GitHub reads.

Requests use the selected repository's stored full name and the validated item
number, with the signed-in user's GitHub token only. Installation credentials
are never substituted, redirects are rejected, and returned repository/item
identity is validated. Workspace access and persisted Fix links are rechecked
after upstream work before any metadata is released.

HTTP responses use `no-store`. The browser keeps workspace metadata in JS memory
for one minute and invalidates it on account, workspace, catalogue, or mode
changes and successful Fix changes, once after the complete triage flush.
Color, flag and triage-only edits do not invalidate Fix metadata. No browser
storage is used. Compact Fix previews show the title, status and description
as plain text.

# Managed comments

Comments live in `managed_finding_comment`, independently of the shared triage row.
Each has its own ID, finding ID, text, optional author ID/login, optional creation and
edit timestamps, and a version. Discussion posts are attributed to the
authenticated user; the client cannot choose the author. Readers see the discussion; users
with triage access can add comments and edit or delete their own. Admins can also
delete comments that have no linked author. Edits and
deletions require the version that was read, so stale requests receive 409
instead of overwriting or deleting newer text.

`GET /api/reports/:id/comments` returns comments for the findings that user can
see. `POST` accepts `{ findingId, body }`; `PATCH /api/reports/:id/comments/:commentId`
accepts `{ body, version }`; `DELETE` at the same item URL accepts `{ version }`
and returns 204. Mutations require CSRF and current report/triage
access. Text is nonempty and limited to 10,000 characters. Comments are shared
across reports carrying the same finding and stay in browser memory only.

Unattributed comments are supported during normal operation, independently of
migration. Future workspace imports started by an admin in the UI can use
`createComment` with null author ID/login and a separate `actor` containing the
admin's ID/login. This records the action in history and Last Activity without
claiming that the admin wrote the imported text. The workspace import UI/API is
not implemented yet; ordinary comment posts always take their author from the
authenticated session.

Imports can pass `createdAt: null` and `updatedAt: null` to retain missing dates;
omitting `createdAt` uses the current time, and omitting `updatedAt` uses the
creation date. New discussion posts always use the server clock. Existing
database tables are migrated to permit null dates without rewriting records.
The UI omits absent authors and dates: an anonymous dated comment shows its
date and text, and an undated one shows just its text. Audit events still have
the time of the action even when the imported comment has no known date.

Existing triage-row comment text is migrated to unattributed records. The
last triage writer is not reliable evidence of authorship, so migration does not
claim an author. Each migrated text gets a fresh ID, preserving subsequent
legacy-server writes after a rollback without replacing previous comments.
The old column is cleared in the same transaction to avoid duplicate migration
on restart. Unattributed comments remain readable; users cannot claim or
edit them, but admins can delete comments with no linked user. Legacy triage
history is preserved. New shared-field comment writes are rejected;
e2e/local/sync comment storage and editing are unchanged.

Comment additions, edits, and deletions contribute to scoped activity history and user
Last Activity, without copying their text into the activity feed. Ordinary
triage updates and clears do not change comments. Explicit repository annotation
deletion includes comments, while preserving findings shared by other repos.

# Activity history

`/manage/history` reads `GET /api/admin/history?page=1&limit=100&kind=all&q=`.
The server returns `{ history, total, page, limit, filters }`, newest first, with at most
100 entries per page. Type, text, repository (`repo`), and user (`actor`) filters apply before pagination.
`filters.repos` and `filters.users` contain choices from the authorized history.
Pass the selected user's opaque `id` as `actor`: stored identities use `user:<id>`;
older login-only records use `legacy:<login>` and are never attributed to a current user by name.
Supported types are `triage`, `upload`, `visibility`, `access`, `repository`, and `delete`.

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
matching directory scope for both reports and bundles. These rules apply to catalogues, downloads,
uploads, visibility changes, assignment changes, deletion, and triage. Managers
can review unpublished reports in scope. Viewer and triage roles still require
publication. Administrators retain unrestricted content access.

Managers can upload unassigned content and retain access to their own uploads.
Detaching or deleting attached content requires access to its current repository
and directory; assigning it requires access to the destination. Repository
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

# Bundle creation preview

Manage → Bundles → Create opens a page for choosing a connected repository,
branch, tag, or commit SHA and selecting entry-point files across directories.
The final **Create a bundle** action is disabled; selections are not saved.

`GET /api/admin/repositories/refs?repoId=…` returns the default branch and up to
100 branch/tag suggestions; any branch or tag name can also be entered.
`GET /api/admin/repositories/contents?repoId=…&ref=…&path=…` returns directory
entries and a resolved commit SHA, which pins subsequent navigation. These
read-only endpoints require admin/manage access and an active repository.
Managers see only their team directory grants and the ancestors needed to reach
them; access is rechecked after GitHub reads. Private repositories use the
configured repository App. The GitHub Contents API limits directory listings to
1,000 entries, and the page displays a notice when that limit is reached.

# Bundle metadata and contents

`GET /api/bundles/:id/metadata` returns the shared `common/bundle-metadata.js`
format: file inventory, byte sizes, source hashes and line counts, package
identity, imports, entry points, executable flags and language/code statistics.
It excludes source bodies and binary resources. `GET /api/bundles/:id/contents`
returns the original sourcemap or Stasis JSON after HTTP decoding.
Both endpoints use `Content-Encoding: br`. Metadata is cached as Brotli;
contents serve the stored Brotli bytes directly, without waiting for metadata
or generating another compressed copy. Stasis uploads remain byte-identical.
Contents and downloads use disk or private Blob streams; HEAD closes the stream and
GET streams with backpressure instead of buffering the full bundle per request.
Clients are expected to support Brotli; no encoding negotiation is needed.
Both endpoints support HEAD, compressed Content-Length when known, and
`Cache-Control: private, no-store`.

`GET /api/bundles/:id/advisories` looks up published npm advisories using the
stored bundle's dependency names and versions. Optional `?reason=<name>` limits
the lookup to package versions with files in that bundle reason; unknown reasons
return 400. A separate package inventory, including the named scopes, is persisted during the shared metadata build; advisory requests buffer at most
1 MiB before parsing, without decompressing the full file inventory. Oversized package
inventories return 413 without contacting npm. The API accepts no bundle body and
returns `{ packages, advisories }`, without source contents or scan findings.
The managed Advisories tab loads it directly, without a consent prompt.
Bundle access and the team's `security` permission are required for view/triage
users; `dependencies` is not required. That permission gates scan findings in
dependencies' own code, while findings about effects on the app remain visible.
Managers and admins retain their normal full access to authorized bundles.
An optional `?team=<id>` restricts the security grant to the selected team.
Access is checked before reading inventory, before contacting npm, and before
returning the result. The endpoint is available on standalone managed, combined,
and managed Vercel servers.

`GET /api/bundles/:id/download` preserves the uploaded filename and bytes:
sourcemaps use HTTP Brotli decoding, while Stasis downloads remain .br archives.

Sourcemaps are compressed once to `bundles/:id.map.br`; the uncompressed .map
is not retained. The DB keeps the original filename, byte size and integrity
so deduplication and report hashes keep working. Sourcemaps and metadata use
Brotli quality 4 to avoid slow maximum-quality compression.

The cache lives beside SQLite under `cache/bundle/:id/`, or in private Blob
storage for Neon deployments. Persistent servers schedule upload prebuilds;
Vercel functions build missing derivatives during authorized reads. Builds
are deduplicated and serialized to bound memory, with a 512 MiB decoded limit.
Files are published atomically and removed on bundle or repository deletion,
including when a build was already in flight. Invalid/unsupported bundles can
still be downloaded as uploaded; metadata requests return 422. Contents are
passed through without parsing; metadata generation still validates them.

Report-scoped `/api/reports/:id/sources` responses use a separate gzip cache,
backed by disk or private Blob storage. Derivatives are shared by report hash
and filename format, scoped to the source paths cited by the team's visible
finding members (including evidence, even when members share a finding ID),
and removed when their final report reference or bundle is deleted. Cold
builders recheck references after publishing to reconcile concurrent deletion
on another instance. Authorization is checked again before streaming sources.

Admins can read/manage every bundle. Managers can read/manage bundles they own
or can access through their teams. View/triage users need team access; the none
role has no bundle access. Ownership survives repository attachment. Adding a
repository location requires bundle management access and access to the destination
repository and directory; detaching or deleting a bundle requires access to its
current location, even for its owner.
Manage lists and repository pickers enforce these rules on the server.

Bundles store a repository and an optional directory, editable together from
Manage → Bundles, just like report locations. Uploads accept `X-Repo-Id` and a
URL-encoded `X-Repo-Directory`; `POST /api/admin/bundles/set-repo` accepts
`{ bundleId, repoId, directory }`. Root is stored as an empty directory; existing
bundles migrate to root. Detaching clears the directory, and deduplicated uploads
preserve the stored location.

A team granted `/` sees all bundles in that repository. A team granted `/foo`
sees bundles at `/foo` and `/foo/*`, excluding root and `/foobar`. This applies
to team catalogs, public workspace links, direct bundle access, advisories and
manager activity. Directory edits also refresh open clients' catalogs.

Opening a bundle downloads its metadata into managed app memory. Code,
Terminal, source search and source comparison request contents when needed;
the browser handles HTTP Brotli decoding. Neither payload enters OPFS, IndexedDB
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
avatars, report/triage data, bundle caches, GitHub pull-request lookups, upload
parts, and every management endpoint. Unauthenticated requests receive 401;
unapproved accounts receive 403 before request bodies or resources are read.
Public bootstrap, the user's own session status and sign-out remain available.
The client shows a no-access page and clears previously loaded data when the
role changes.
