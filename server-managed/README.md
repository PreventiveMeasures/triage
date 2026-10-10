For deployment on Vercel, see [the deployment guide](VERCEL.md).
For database selection, shared-storage boundaries, and cleanup behavior across
both server modes, see [storage separation](../server-common/STORAGE.md).
For optional encryption of disk and Vercel Blob payloads, configuration and
plaintext migration, see [managed storage encryption](STORAGE-ENCRYPTION.md).

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

## Viewing as another user

To check what an account can access, an admin selects **View as** on that
user's row in **Manage → Users**. The app reloads as that user: their role,
teams, Dependencies and Security permissions, and pages apply unchanged. A
sidebar banner names the viewed user until the admin selects **Stop**, or
**Return to @admin** in the account menu, which reopens Users.

Every write is refused while viewing, with `403 { "error": "view-only" }`,
before a request body is read: triage, comments, issues, public links,
uploads and all management changes. Controls stay as the viewed user has them,
so the admin sees what that user is offered: a Viewer's triage controls are
disabled, while a Triage user's stay enabled and their edits are refused. The
app shows the refusal and restores the server's triage. Reads behave as for the viewed user, including the
read-only `POST /api/reports/query`. Requests never use the viewed user's
GitHub authorization, so data that needs it is omitted, as for a user who has
not authorized GitHub: private pull request and issue status, repository
browsing, discovery and issue creation. GitHub issue authorization is refused.
A combined deployment's E2E requests are unaffected; they keep that service's
own authentication.

`POST /api/auth/view-as` with `{ "userId": "<id>" }` opens a view. It requires
an admin session, same-origin access and CSRF, and refuses the admin's own ID.
The view is a separate session row for the viewed user, tied to the admin's
session and stored in its own `dvview` cookie (`__Host-dvview` when Secure)
beside the session cookie. `SESSION_COOKIE_NAME` cannot use this or the OAuth
state cookie names (`dvstate`, `dvissuestate`); startup fails if it does. `GET /api/auth/session` then returns the viewed
user, the view's own CSRF token, and the admin as `viewer`. A view token is
never accepted as a session cookie, and a view only resolves together with
the admin session that opened it. `DELETE /api/auth/view-as`, with the view's
CSRF token, ends the view; logging out ends both. A view also ends when the
admin session expires or ends, or the admin loses the admin role, and does not
return if the role is granted again. The next session probe then clears the
cookie, while other requests with it are unauthenticated: they never fall back
to the admin's own, writable session.

Opening a view adds `viewed as <login>` to the admin's access history.
Viewing does not update the viewed user's Last seen or Last activity.

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
Like the Viewer role, a link shows saved triage, fix links, flags and colors
with their controls disabled, and opens comments read-only.

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
bundles; published advisories require the security opt-in. Directory-only grants expose cited source
files, not entire bundles. GitHub PR metadata, bundle commit details and tags,
and user avatars require account access and are not sent in public views.

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
`triage`, `comments`, and `sources` routes, and authorized
bundles' `metadata`, `contents`, `download`, and `advisories` routes. Global
endpoints, mutations, unknown routes, cleanup and sync transports are denied.
The token stays in the URL fragment across browser navigation, rather than
being sent in page URLs or stored in local storage.

Finding triage history requires an authenticated `triage`, `manage`, or `admin`
role and access to the finding within the report. Ordinary triage users must
supply their team scope; its security and dependency visibility filters apply.
Public links cannot read triage history, including when a login cookie is present.

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
| `…/bundle/:bundleSlug/compare[/:otherSlug[/code\|/diff]]` | Its Compare tab, with another bundle, in its Code or Diff mode |
| `/manage` | Manage overview |
| `/manage/bundle` | Bundles |
| `/manage/scans` | Scans |
| `/manage/report` | Reports |
| `/manage/repositories` | Repositories (admin) |
| `/manage/users` | Users (admin) |
| `/manage/team` | Teams (admin) |
| `/manage/history` | Activity history; optional `?actor=<login>` |
| `/npm` | npm package lookup |
| `/npm/:name[@:version][/:tab]` | npm package version; `:version` may be a dist-tag |
| `/npm/:name@:version/code[/:file]` | Its Code tab, at a file |
| `/npm/:name@:version/compare[/:otherVersion[/code\|/diff]]` | Its Compare tab, with another version, in its Code or Diff mode |

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
the tab; switching bundles retains it when available. Compare's two sides are
both pickers: the open bundle's opens the bundle picked, compared with the same
one (picking that one swaps the two), and the other's picks what to compare
with. Compare offers accessible
bundles assigned to the same repository, including bundles not previously opened.
Unattached bundles cannot be compared with each other. Past its Overview,
Compare reviews the changes in **Code**, a file at a time beside the tree of
changed files, or in **Diff**, every changed file's diff one after another in
a single list, each under its name. Diff is offered only while that list is
under 8,000 rows, its folded unchanged runs and each file's head counted; a
link to a longer one opens the Overview.

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

# Repository aliases

Admins can add, edit, and delete aliases in **Manage → Repositories → Aliases**.
Rows contain an old repository (GitHub slug or URL), old path, connected target
repository, and new path. Empty paths mean the repository root. Repository names
match case-insensitively; directories match case-sensitively at path boundaries.
The longest matching old path wins, its suffix is retained, and mappings apply
once without chaining. For example, `org/a` with an empty old path can map to
`org/b` at `projects/a`; `org/c` at `a` can map to that same location, and an import
declaring `org/c` at `a/src` is assigned to `org/b` at `projects/a/src`.

For Stasis bundles, aliases can also match a directory shared by every bundled
file. With `org/c` at `a` mapped to `org/mono` at `projects/a`, a bundle declaring
`org/c` with no directory and files under `a/` is assigned to `org/mono` at
`projects`. The part already in the file paths must be a common suffix of the
old and new paths; otherwise this inference cannot apply without rewriting
files. Imports skip decoding the file inventory unless a compatible alias has
an active destination. Location suggestions use the same rule on metadata's
existing file inventory, including resources.

Aliases are stored in `managed_repository_alias` and affect only the detected
repository and directory of new reports and Stasis bundles. Original bytes,
individual findings, relative file paths, and content hashes are unchanged.
Explicit bundle and report locations override detection. Editing an alias or
connecting a repository does not move existing content; identical reuploads
reuse its stored assignment. Bundle and report location editors resolve their
suggestions using the current repositories and aliases, and only Save changes
the assignment.

# Report repository metadata

Managed report headers use the repository assignment stored on the server,
including its directory, even when the report embeds a different repository.
They do not offer the local “Set repo” editor. Findings retain their own upstream
repository metadata (for example, a dependency's repository); source links that
need a report fallback use the server assignment.

Reports without a report-level repository, such as Claude Security Markdown and
Codex CSV exports, name one on their findings. As in the local report view, the
single repository named by findings outside the report's dependency directory
(`node_modules/`, else `vendor/`, else `dependencies/`) stands for the report,
with any report-level `repo.directory`. A new upload without
`X-Repo-Id` is assigned there when it resolves, through connections and aliases
like embedded metadata, to an active repository within the uploader's access;
`X-Repo-Directory` still overrides the directory. Otherwise the report stays
unattached. Such reports remain reassignable, and
`GET /api/admin/reports/:id/location` returns
`{ location: { repoId, github, directory } | null }` for their location editor:
`repoId` is null unless the destination is connected and within the caller's
access, and `directory` is null when neither the report nor an alias names one.

`GET /api/teams/:id/reports` returns the complete **published** workspace as separate
`{ id, filename, data, repo: { github, directory } }` envelopes in `{ reports }`.
The server derives the report list from that team's repository paths and the
caller's membership, which is required even for admins and managers. Ordinary
users receive findings filtered by that team's security/dependency grants;
grants in other teams do not broaden the answer. Admins and managers bypass
those finding filters, but unpublished reports are excluded from aggregate
team responses for every role. Their hidden reports remain listed in the team
catalog for individual access.

The optional `?reportId=:reportId` query parameter selects a report in that team:

- A published selection returns the same complete published workspace, preserving
  cross-report classification. The viewer selects the individual report from it.
- An unpublished selection requires an admin or manager with membership in the
  team and a report matching its repository/directory scope. The response contains
  **only that report**, in the same `{ reports: [...] }` envelope. This isolated
  preview does not read or merge the team's published reports and has its own
  query capacity, so a full published workspace cannot prevent opening it.
- A missing or out-of-scope report, or an unpublished selection by a viewer or
  triager, returns `404`.

Both aggregate reads and isolated previews retain the existing query limits:
4,096 reports and 1 GiB for input and encoded response size. Oversized requests
return `413`. The server rechecks access and publication after loading content;
a changed workspace is rejected instead of returning a stale response.

Links files are uploaded, assigned and published like reports in Manage. Their
wire data is `{ source: 'links', findings: [], links: [[findingId, ...], ...] }`.
Security propagates across complete rows and published links in the chosen team
before dependency filtering. Aggregate links contain only remaining finding IDs,
and each retained link names at least two distinct findings. Unpublished reports
and out-of-scope links do not contribute to any role's aggregate view. An isolated
unpublished links preview preserves its references without loading the reports
they name.

`GET /api/reports/:id` and `POST /api/reports/query` are reserved for admins and
managers, with existing ownership/team access rules. Individual previews with
`Accept: application/json` return `{ data, repo: { github, directory } }`;
other callers receive raw text. `github: null` means unassigned.

Managed clients load report content on demand and cache responses only in
JavaScript memory. Aggregate responses are keyed by team; isolated previews also
include the selected report ID and cannot populate the aggregate cache. Catalogue
or session changes invalidate these caches. HTTP responses use `no-store`;
no report response is written to browser storage.

`GET /api/teams/:id/annotations` includes only published workspace findings for
every role. With `?reportId=:reportId`, it returns annotations for the selected
report: published reports use whole-workspace classification, while authorized
unpublished previews use only that report. Hidden-only findings never enter the
aggregate annotations.

Ordinary users supply `?team=:teamId` for report triage, history, comments and
sources. These endpoints authorize against the same published workspace or
authorized isolated preview when scoped to a team and recheck access after cold
reads. Triage and comments remain shared by finding ID across teams; the team is
only the authorization context.

# Team App classification

Each team in `GET /api/teams`, and the team in a public link's bootstrap, carries
`app`: `{ appMode: true, appFindings }` when its published workspace has a basic
App view, `{ appMode: false }` otherwise, or `null` when it cannot be classified
right now. The sidebar opens App teams collapsed to their finding count from the
first paint, and keeps other teams expanded. The server classifies the same
filtered workspace the team view loads, with the classifier the view uses
(`common/managed/team-app.js`), before the catalog is sent.

A classification is keyed by the team's catalog cache key and its published
reports' cache keys, so an unchanged catalog reuses it and accounts with the same
access share it. Publishing, hiding, moving or uploading a report, a grant or
scope change, or a link change produces a new key and a new catalog revision, so
open sidebars refetch the catalog and collapse or expand the team live.
Classification reads the team's published reports once per key, in memory per
server instance. Oversized or unreadable workspaces have no App view. Unavailable
storage leaves the team `null` (expanded) until a later catalog read succeeds.

# Live team updates

`GET /api/teams/:id/feed` is a read-only SSE subscription for an approved
user. One connection carries two invalidations, each with `data: {}`:

- `teams`: the current user's memberships, grants, repository scopes, team names,
  and visible reports/bundles across **all teams they belong to**. The client
  refreshes `GET /api/teams`.
- `triage`: visible triage and comments for **only the focused team**. The client
  refreshes the existing report annotation APIs.

Team feeds exclude unpublished reports from aggregate triage updates for every
role. `GET /api/teams/:id/feed?reportId=:reportId` uses the same selection and
access rules as report reads: an authorized unpublished preview receives updates
for that report alone; a published selection retains the published workspace
scope. Catalog updates remain unchanged by this selection.

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
for the published workspace. It requires an approved managed session (at least `view`)
and membership in that team. URLs come only from persisted Fix links on findings
surviving the same workspace security and dependency filters as report reads,
including whole-row and linked security propagation. Admins and managers retain
their security/dependency filter bypass. The optional `?reportId=:reportId`
follows the report-read selection rules: an authorized unpublished preview uses
only that report's findings, while a published selection uses the complete
published workspace. The caller supplies IDs, never a URL list.
Both the former `POST /api/github/pull-requests` and the team
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
number. Every read requires the current user’s membership in the selected team,
that team’s repo grant, and a visible finding carrying the Fix link. GitHub
repository ID and name must match the managed connection. Explicitly public
visibility (`private: false` and `visibility: public`) is persisted in
`managed_github_repository_visibility` and reused across viewers for one minute.
Only public visibility is an access grant; private permissions are never cached
across requests. Internal repos and unknown visibility still require user access.

For private or unknown repositories, one live `/user/repos?visibility=private`
request using the viewer’s own token authorizes matching repositories with read
permission from its first 100 results. Repositories omitted from that page, or
left unverified by a failed/malformed list, get individual repository lookups.
Pagination is not followed: absence from the list is unknown access, not denial.
These checks apply to admins and cached closed or merged items on every request.
Missing or expired credentials, denied access, redirects, malformed responses,
and failed access checks return `unavailable` without exposing cached titles or
bodies. Cached data never grants
access to another team, repository, hidden finding, or unauthorized GitHub user.
Recently public cached metadata can remain visible until the next visibility
check after a repository becomes private. New content uses the viewer's token
only after a live repository check, reusing checks already made in that request.
This preserves GitHub's authenticated rate limit and prevents fresh private data
from using a stale public grant. Without verified credentials, public refreshes
stay anonymous; failed refreshes keep the previously public data. A newer private observation
from another request also invalidates an in-flight public cache read. Both SQLite
and PostgreSQL create these tables for existing installations. Cached
merged PRs are never requested again. Closed items also stay cached; only open
items (including draft PRs) older than one minute are queued for refresh.
An exception is closed issues cached before closure reasons were stored: they
are backfilled once successfully, keeping their old metadata on failure. A null
reason marks these legacy entries; `unknown` completes backfill even if GitHub
does not provide a reason. Database upgrades preserve all existing cache rows.

Every workspace read returns available cached metadata for verified repositories,
including stale open items. Its upstream queue takes missing entries first, then fills any remaining
slots with stale open entries and legacy closed issues, oldest first, up to 200 distinct items total. A
larger workspace is still a successful response. Successful refreshes replace
cached values; failed metadata refreshes or an exhausted refresh budget retain
the old data for viewers whose current GitHub access was verified. Authorization
failures preserve stored data but prevent its release. Cached entries are ordered
by their latest successful fetch or refresh attempt. Failed attempts rotate behind entries not checked as
recently, without updating their successful fetch time, so repeated failures
cannot monopolize the backfill queue. Only started reads record attempts;
entries skipped by the cap, deadline, or absent credentials keep their place.
Live access checks cover only eligible Fix repositories and deduplicate repository
IDs. Cached metadata for recently public repositories needs no upstream
permission checks or user credentials. Other repositories share one private-list
request. That request's fallback checks and checks for public metadata refreshes
share a budget of 200 direct repository checks, in addition to the 200-item queue.
Unverified repositories beyond the direct-check budget return `unavailable`.
There are at most four upstream calls in flight, with one shared 10-second
deadline for token refresh, repository authorization, and metadata reads.

Requests use the selected repository's stored full name and the validated item
number, using the signed-in user's own GitHub token after live verification or
anonymous reads for public content. Installation credentials are never substituted,
redirects are rejected, and returned repository/item identity is validated.
Workspace access and persisted Fix links are rechecked
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
New uploads are recorded atomically with their metadata. Report/bundle publication,
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
controls on the upload page. Report and bundle deduplication never return inaccessible
IDs or names, and manager uploads only auto-link owned or team-accessible
reports.
Repository connections, teams, memberships, and user roles are admin-only.

Report publication, report/bundle reassignment and deletion recheck the session,
role and current repository grants in the metadata writer transaction. Uploads
recheck role and destination access after byte storage, before committing metadata.
Permanent repository removal commits metadata deletion, exclusive annotation
deletion and its audit record atomically; subsequent blob cleanup uses only the
rows actually removed.
If report references change during an annotation-overlap scan, removal returns
409 `repository-changed` without deleting data. Refresh and retry the removal.

# Report storage and upload limits

Report uploads accept up to 25 MiB by default. `MAX_REPORT_BYTES` changes this
limit, up to 100 MiB. The limit and displayed byte size describe the original
file, before storage compression.

New report bodies are compressed with Brotli quality 9, then encrypted when
managed storage encryption is enabled. Both disk and private Blob storage use
`reports/:id.br`. Reads decrypt and decompress in memory; downloads preserve
the original filename and bytes, and deduplication hashes the original upload.
Existing reports at `reports/:id` convert on their first read: the server
compresses their original bytes, reuses their existing encryption key when
enabled, saves `reports/:id.br`, and removes the old copy. There is no separate
compression migration job. Encryption maintenance also understands the stored
Brotli representation and verifies its original upload hash after decompression.

# Upload encryption in transit

A CDN or proxy that terminates TLS in front of the server, such as Cloudflare,
would otherwise read every uploaded report, bundle and link report. The browser
seals these uploads before sending them. Each session has its own X25519 key
pair, created on first use: `GET /api/admin/uploads/key` returns the public key,
and the private key stays in the session row. For every file, the browser derives
a fresh AES-256-GCM key by X25519 with a new ephemeral key, so the proxy sees only
public keys and ciphertext. Text is gzipped before sealing and binary files are
sealed as is. Large uploads are split into parts after sealing.

Sealed bodies carry `X-Upload-Encryption: 1`. The server opens them with the
session's key and rejects altered bodies, bodies sealed for another session,
and content that exceeds the upload limit once decompressed. Requests without
the header are still accepted unchanged, so scripts and older browser tabs keep
working. This protects against a proxy that observes traffic. It cannot protect
against one that modifies the page's JavaScript or substitutes the public key.
Downloads and JSON requests, such as triage and comments, are not sealed.

# Repeated imports

Uploading identical report or bundle content reuses its stored ID, even when
the filename changes. This also applies to workspace imports, retries after a
lost response, and concurrent uploads. A reused upload returns HTTP 200 with
`deduped: true`; new uploads return 201. Reports retain their existing filename,
repository assignment, publication state, and source-bundle link. CSV parsing
must also agree, so an earlier unrecognized upload cannot hide a valid CSV report.

If a PostgreSQL commit acknowledgement or connection close fails, uploaded bytes
are retained because the metadata may already be committed. Retries reuse a
committed upload with its bytes intact. An uncertain commit that did roll back
can leave unreferenced bytes for later reconciliation; definite insertion
failures still clean up their candidate blobs.

Workspace imports grant the new team access through the stored active repository
and directory, assign unattached content when needed, and publish the reports.
Non-embedded reports and bundles assigned to inactive repositories are moved to
the import's selected active repository, preserving their IDs and stored bytes.
Reports with embedded repository metadata still require that repository to be active.
Other reports use the repository typed for them in local mode, else the one their
findings name; like embedded repositories, these follow the current aliases at
import time, and fall back to the selected repository when not connected.
Triage remains shared by finding ID and follows the usual import conflict dialog.
Existing duplicate report rows are preserved; subsequent imports reuse the oldest
matching record without creating another copy.

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

# Bundle creation

Manage → Bundles → Create opens a page for choosing a connected repository,
branch, tag, or commit SHA and selecting entry-point files across directories.
**Create a bundle** calls `POST /api/admin/bundles/create`, building and storing
a Brotli-compressed Stasis source bundle at the selected immutable commit.
`@exodus/stasis/vfs-bundle` fetches the GitHub tree and reconstructs dependencies
in memory from its lockfile; repository code and install scripts are not run.
Supported remote projects are JavaScript/TypeScript with pnpm, Yarn 1, or npm
lockfiles, and Solidity with Soldeer. Entries must be of one supported language.
Node.js and Browser pass the selected export conditions; Metro uses Stasis's
Metro resolver for iOS/Android and requires its `react-native` condition unchanged.

Builds use the common parent directory of the selected entry points. Filenames
follow `stasis github-bundle`: `owner-repo.<short-commit>.stasis.code.br`, or
`owner-repo.<directory-with-dashes>.<short-commit>.stasis.code.br`. Nonportable
characters become underscores; long directories are truncated with a hash to
fit 255 characters. A JavaScript/TypeScript project in a subdirectory with its
own named `package.json` is instead `<package>.<short-commit>.stasis.code.br`,
the name Stasis read from it: `@scope/name` becomes `scope-name`, or just `name`
when that already starts with `scope-`. The stored directory comes from
Stasis's actual build root.

Creation requires same-origin, CSRF, manager/admin and live GitHub read access.
The caller must have a managed grant covering the resulting project root, which
can be above the selected files when a workspace lockfile installs them. Access
and repository identity are rechecked after building and storage authorization
is transactional. Duplicate bytes reuse the existing authorized bundle.
Shared database leases allow two builds across all instances using the managed
database, one per user, including on Vercel. Admission is atomic and precedes
GitHub requests. The three-minute budget starts before admission; disconnects
cancel builds and slots are released only after worker termination. Leases
expire after four minutes using the database clock to recover from crashes;
only the claiming request can release its slot. Each worker has a 512 MiB heap
limit. Off Vercel, what a build downloads (npm tarballs and version documents,
the repository's tree) is kept in upstream's disk cache at its default location,
`$XDG_CACHE_HOME/PreventiveMeasures` or else `~/.cache/PreventiveMeasures`; on
Vercel nothing is kept. Output is bounded by 200 MiB decoded and the configured
bundle upload size limit.

Builds write `managed-bundle-build:` JSON records from the HTTP thread, including
a build ID, repository/commit, worker URL, elapsed time, and stage (`worker-start`,
`build`, `scope`, `serialize`, or `compress`). Failures include the underlying
error name, code, message, stack and cause, or an unexpected worker exit code.
Credentials and upstream HTTP response bodies are removed from diagnostics;
the API continues to return only its public error code. A `completed` record
means the worker returned bundle bytes; authorization and storage follow it.

`GET /api/admin/repositories/browsable` provides the creation page's repository
picker. A repository must be active, and both access gates must pass: the caller
is an admin or a manager with a team grant for the repository, and the caller has
GitHub read permission or the repository is currently public. Public visibility
is verified with GitHub, not inferred from stored flags; internal repositories
require a user permission check. Admin status does not bypass the GitHub gate.

`GET /api/admin/repositories/refs?repoId=…` returns the default branch and up to
100 branch/tag suggestions; any branch or tag name can also be entered.
With `&withDefault=true`, the same response includes `defaultContents`: the
default branch's root directory and resolved commit, or `null` when no default
branch is available. The bundle picker uses this to load revisions and files in
one request. A nullable `managed_selected_repo.cached_default_branch` stores the
last live default independently of the repository-selection metadata. Branch/tag
suggestions and the cached branch's directory are read concurrently. If the
default changed (or was not cached), the server updates the hint and reads the
current default's directory before returning either result.
`GET /api/admin/repositories/contents?repoId=…&ref=…&path=…` returns directory
entries and a resolved commit SHA, which pins subsequent navigation. These
read-only endpoints independently enforce the same two gates.
Managers see only their team directory grants and the ancestors needed to reach
them; both managed access and GitHub access are rechecked after source reads.
Private repositories use the configured repository App, but its installation
access alone is never a user grant. Existing upload/link pickers retain their
managed-data permissions; they do not grant live source browsing.
The picker shares installation tokens and the GitHub identity lookup within one
request, but checks every repository's current visibility and permission. Stale
installation access falls back to anonymous source reads only after GitHub confirms
that the repository is public; private and internal repositories remain gated.
The GitHub Contents API limits directory listings to
1,000 entries, and the page displays a notice when that limit is reached.

# Bundle commits and tags

Bundle catalogs (`GET /api/teams` and `GET /api/admin/bundles`) send each
bundle's `commitInfo`: what the cache holds for the commit its summary records,
in the repository the bundle is stored at, or null when it holds nothing. It is
`{ sha, github, tags, details }`, where `github` is that repository, `tags`
names the cached tags pointing to the commit and `details` is `{ subject,
authorName, authorLogin, authoredAt, committedAt }` or null. The subject is the
message's first paragraph on one line, as `git log --format=%s` gives it,
without `Claude-Session:` lines; the server never sends the rest of the
message, which only its cache keeps. There is no
separate endpoint and no client-supplied commit: catalog access to the bundle
is the only gate, as for its summary. The cache is read before the catalog's
final access check, which a bundle moved meanwhile leaves without `commitInfo`.
The bundle view shows the tags after the commit on the Overview's GitHub row,
linked in `github` even when the bundle's stamp names another repository, and
the commit's subject, author and date in the tooltips that show that commit
(Overview, Code file link, team bundle rows). A tooltip that names that
repository also lists the first eight tags under the commit and counts the
rest; tooltips cannot scroll, so the subject is also cut at 200 characters
there. A commit link's tooltip leads its full hash with the commit icon.

`managed_github_commit` keeps details by stable repository ID and SHA, without
eviction: commits never change, so a cached one is never read again. A server
build caches its commit, read with the builder's verified repository access.
A catalog never waits for GitHub. After it responds, it reads up to four
commits it lacked with the viewer's own access (the source browser's public,
user token and App permission checks), so the first catalog can lack them and a
later one has them. A viewer who cannot read a commit retries it after five
minutes; another viewer may fill it sooner. Details come from the first entry
of GitHub's commit list from that SHA, checked against it, without the file
list `GET /commits/:sha` adds. Messages are kept up to 65,536 characters.

`managed_github_tag` maps a repository's tag names to commits. Only bundle
creation writes it; catalogs and the bundle view only read it and never request
tags. Each `refs` read refreshes the repository's tags from the listing its
suggestions use: a listing shorter than the 100-tag page lists every tag, so
tags it leaves out are deleted, while a full page only updates the tags it
names. A tag the revision input resolves through `contents` is stored even when
it is beyond that page. Each write happens before the request's access recheck,
like other GitHub caches. Each refresh carries the microsecond its request
started. A tag keeps the time it was last observed and only a later
observation moves it; a complete listing deletes only tags observed before it,
so tags a newer partial update observed stay. `managed_github_tag_listing`
holds the last complete listing applied for a repository, and any refresh
observed no later is skipped, so an overlapping browse that finishes late
cannot restore tags a newer one deleted or moved. Tags are removed with
their repository. SQLite and PostgreSQL create these tables for existing
installations.

# Bundle metadata and contents

`GET /api/bundles/:id/metadata` returns the shared `common/bundle-metadata.js`
format: file inventory, byte sizes, source hashes and lines of code (blank lines excluded), package
identity, repository/package origins, imports, entry points, executable flags and language/code statistics.
A sourcemap's imports are the edges between its files, which the server reads with oxc-parser
(`@preventive/sourcemap/edges.js`) for every map; a client reading a map itself sees Metro's alone (`edges-lite.js`).
The graph draws them, and Code links follow each import's specifier to the file its edge leads to.
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

`GET /api/bundles/:id/advisories` uses `@preventive/upstream` to audit the
stored bundle's dependency ecosystems, names and versions. npm uses the registry,
Cargo and Composer use OSV, and Soldeer and GitHub dependencies use published
repository advisories. Modules without an
ecosystem retain the legacy npm lookup when installed under `node_modules`;
the root module is excluded. As in `stasis audit`, a dependency must have a recorded
evidence file: manifests and the verified browser stubs of `ws` and `node-fetch`
do not count. Entry and manually added code count
without an import edge. Composer dev versions, git or unknown-source crates, and
unsupported ecosystems are returned as `skipped`, with a reason, without being
sent upstream. GitHub branch `.` is normalized to the unknown-version placeholder
`0.0.0`, which upstream conservatively matches against every advisory range.
Optional `?reason=<name>` limits the lookup and skipped list to dependencies with
evidence files in that bundle reason; unknown reasons return 400.
A separate inventory, including the named scopes, is persisted during the shared metadata build; advisory requests buffer at most
1 MiB before parsing, without decompressing the full file inventory. Oversized package
inventories return 413 before contacting upstream. The versioned inventory
rebuilds older npm-only and unfiltered caches. The API accepts no bundle body and returns
`{ packages, skipped, advisories }`, all arrays: packages contain `{ ecosystem, name,
versions }`, skipped entries contain `{ ecosystem, name, version, because }`, and advisory rows retain upstream's IDs, matched versions, source,
and optional severity, title, CVSS and range. Failures return 502 with
`upstream-unavailable`, without source contents or scan findings.
The managed Advisories tab loads it directly, without a consent prompt, and lists
dependencies that could not be audited separately from the results.
Its **Recheck against repositories** button, immediately left of Scope, requests `?repoAdvisories=true`,
passing the same upstream option as `stasis audit --repo-advisories`. This adds
maintainer-published advisories for npm, Cargo and Composer dependencies, including
ones not yet in the registry/OSV results, with upstream's version matching and
deduplication. Rechecks use the selected reason;
GitHub rate limits and the 30-second caller deadline still apply. The button shows
**Rechecking…** and is disabled during the request. Transient failures preserve
the previous results; a denied or missing bundle discards them.
For admins and managers, a **Validate** button right of it opens Scans on that bundle with
Dependency alerts selected (`/manage/scans?bundle=<id>&mode=dependencies`).
Once a bundle's modules are loaded, the tab is hidden when none is a dependency
package (a non-root module with an ecosystem, name and version), unless it is the
open tab: switching bundles (to a sourcemap too) or following a link keeps
Advisories open, as it keeps Compare open without another bundle to compare.
Only losing security access, or a bundle known to have no package versions to
audit, returns the viewer to Overview. Such a bundle never shows the tab: a
Stasis bundle before format version 1, or one whose catalog summary counts no
versioned packages (`versionedPackages`). Catalogs send both in its summary, so
the tab is hidden before the bundle opens; a parsed v0 bundle without a summary
yet hides it too. Neither button
is shown when the bundle's unscoped audit finds no packages, audited or skipped.
Managed bundles have no Issues tab: the Code tab shows each file's issues.
For both initial audits and repository rechecks, GitHub requests use the current
viewer's stored access token, refreshing it within the audit deadline when needed.
Public shares and viewers without a usable token use an anonymous client. Credentials
are sent only to GitHub, never to npm, OSV or the other registries. If GitHub rejects
the token with 401, that repository lookup is retried anonymously and the rest of
the audit uses anonymous GitHub access. Other failures do not trigger this fallback.
Ordinary npm-only audits contact only npm; GitHub requests are added by the
repository recheck.
Off Vercel, an audit's records are kept in upstream's disk cache at its default
location, as builds' are: each repository's published advisory listing
(repository rechecks, and Soldeer and GitHub dependencies) for 90 minutes, and
the npm version documents and registry lookups that find a package's repository.
On Vercel, only the listings are kept, in `managed_upstream_cache` and for the
same 90 minutes, shared by every viewer, public share and instance: only public
repositories publish advisories. Nothing else is kept there or on disk. Upstream
stamps, checks and expires the entries; refreshes replace the repository's
single row. The listings of repositories an audit already knows (GitHub
dependencies, Soldeer dependencies' recorded repositories, and on a recheck,
every dependency's recorded repository) are read in one query, since a request's
queries share one Neon connection; listings of repositories upstream looks up,
or all of them if that query fails, are read one at a time. A cache read or write
failure is treated as a miss and never fails the audit.
Bundle access and the team's `security` permission are required for view/triage
users; `dependencies` is not required. That permission gates scan findings in
dependencies' own code, while findings about effects on the app remain visible.
Managers and admins retain their normal full access to authorized bundles.
An optional `?team=<id>` restricts the security grant to the selected team.
Access is checked before reading inventory, before contacting upstream, and before
returning the result. The endpoint is available on standalone managed, combined,
and managed Vercel servers.

User repository discovery and public repository metadata also use
`@preventive/upstream`'s GitHub client, with its argument validation, response
limits and bounded pagination. Managed filtering still skips archived repos,
requires explicit public visibility for public additions, and checks effective
user permissions on installed nonpublic repositories. Installation discovery
and token minting retain their managed credential cache.

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
A sourcemap's import links there follow the edges its bundle metadata keeps,
read with the parser once, rather than read again for each derivative.

Admins can read/manage every bundle. Managers can read/manage bundles they own
or can access through their teams. View/triage users need a visible bundle and team access; the none
role has no bundle access. Ownership survives repository attachment. Adding a
repository location requires bundle management access and access to the destination
repository and directory; changing visibility, detaching or deleting a bundle requires access to its
current location, even for its owner.
Manage lists and repository pickers enforce these rules on the server.

Bundles store a repository and an optional directory, editable together from
Manage → Bundles, just like report locations. Uploads accept `X-Repo-Id` and a
URL-encoded `X-Repo-Directory`; `POST /api/admin/bundles/set-repo` accepts
`{ bundleId, repoId, directory }`. For new Stasis uploads without an explicit
repository, the bundle's `repo.github` defaults to a matching connected repository
(case-insensitive), with `repo.directory` as the directory default. Explicit upload
locations override these defaults; unmatched origins and stamps outside the
uploader's repository/directory grants remain unattached. Managers can assign their
unattached uploads to an allowed location afterward; explicit upload destinations
still require access. The location editor shows the original self-reported repository
and directory from bundle metadata separately from the editable assignment. Upload
inference decodes only the bounded origin header, before any source contents. The usual repository
and directory grants apply. Root is stored as an empty directory; existing
bundles migrate to root. Detaching clears the directory, and deduplicated uploads
preserve the stored location.

Manage → Bundles includes show/hide controls and a visibility filter. Bundles remain
visible by default, including existing bundles after upgrading. Hiding removes a
bundle from view/triage catalogs, direct reads, downloads, advisories, and public
workspace links. Managers and admins retain their existing access; hidden bundle
and report names appear muted in management lists and the team sidebar.
`POST /api/admin/bundles/set-visible` accepts `{ bundleId, visible }` with CSRF
protection and rechecks management access in the write transaction. Visibility
changes update live catalogs and leave linked reports' publication state unchanged.

A team granted `/` sees visible bundles in that repository. A team granted `/foo`
sees bundles at `/foo` and `/foo/*`, excluding root and `/foobar`. This applies
to team catalogs, public workspace links, direct bundle access, advisories and
manager activity. Directory edits also refresh open clients' catalogs.

Opening a bundle shows what its catalog entry already holds (name, location,
size, and its GitHub origin, commit and tags) at once, and its files once its
metadata arrives; its URL follows a successful open, and a failed one still
lands on the home page. A tab picked meanwhile keeps the bundle and still
receives its files, or the reason it has none.

A catalog bundle's `summary` holds its file, code file and LoC counts, the
commit its Stasis stamp records (`commit`), and for a Stasis bundle its format
version (`stasisVersion`, 0 for legacy bundles) and `versionedPackages`: the
name@version pairs its unscoped advisory audit covers, audited or skipped, by
the same inventory (evidence files included) the advisories route uses. Summaries are cached per bundle as
`v5-summary.json`, and the bounded backfill rebuilds missing and older ones. Until
it reaches a bundle, catalogs send its `v4-summary.json` as is (no
`stasisVersion`); a bundle with only an older summary has none until then.

Opening a bundle downloads its metadata into managed app memory. Code,
Terminal, source search and source comparison request contents when needed;
the browser handles HTTP Brotli decoding. Neither payload enters OPFS, IndexedDB
or localStorage. Session/role changes clear managed caches and terminal state.


# npm package viewer

Every role but `none` can open a published npm package version from the
landing page's **npm packages** card, or at `/npm/<name>[@<version>]`. It shows
in the bundle view with four tabs:

- **Overview**: its header names the package beside a picker of its
  versions, as wide as the version shown, listing them as Compare's pickers
  do (searchable, newest first, several to a row as wide as the longest
  needs, with their dist-tags; the arrow keys move along a row and between
  rows; switching keeps the tab shown, and until the versions arrive it holds
  the version shown, disabled), and links its page on npm.
  Over the summary, where any file can't be reviewed by reading it, a
  warning says how many and why, in categories, the first that holds of: not
  UTF-8 (the server could not read it as UTF-8, or it holds a NUL), control
  characters (the C0 ones but tab, line feed and carriage return, DEL, the
  C1 ones, and the bidirectional controls U+202A–U+202E and U+2066–U+2069),
  unexpected long lines (lines over 1,000 characters among readable ones),
  minified (most of its text on such lines, or named `.min.` with any), and
  source maps (`.map`). Prose (Markdown, text, licenses and changelogs) is
  readable whatever its lines' lengths, and a `sourceMappingURL` comment's
  line counts for none. Then the manifest's facts: description, license
  (each license in its expression opening its file in the package: the one
  named after it, as `LICENSE-APACHE` for `Apache-2.0`, else its only license
  file), author (linking the npm profile of the account that published it),
  GitHub repository with its stars, forks, open issues and open pull requests
  (GitHub counts them together; the pull requests are counted apart from its
  list of them, and where that fails they show together), publish commit with
  the tags that point to it, homepage (left out where it only leads to its
  GitHub repository, or its directory or readme there, as npm's default
  does) and integrity; beside them entry points,
  each with its file's icon and opening its file, Main and Module in one row
  where they name the same file, engines, install scripts, and its files with
  the lines of code they add up to; and a card of its downloads: the latest
  week's (or month's) and the last year's, each with its unit (`1.2K/week`,
  `9.6K/year`), over a chart of them across the year by week, or by calendar
  month (complete ones only), with the switch between the two at its top
  right and under it the hovered period's downloads; and the tarball
  download under it. Under the facts, its languages, then its readable files
  as UTF-8 or ASCII and its file types, side by side where they fit: Package, for the files every package
  has at its root (`package.json`, a readme, and license files such as
  `LICENSE`, `LICENSE-MIT` or `LICENCE.md`), then each extension with its
  count, one only those files have left out, one other files have too
  counting them as well. Each category's chip, and each file type's, narrows
  the Files list to its files, one at a time; the Files head names it, with a
  way back to every file. Then its columns: Dependencies, where
  it has any (peer and optional ones included), which open in the viewer at
  their latest version (an `npm:` alias at the package it names);
  Advisories, across every published version, one row each, its head
  counting those that affect the version shown, those first and marked,
  those fixed in it (affecting only older versions) struck through, and
  those affecting later versions, older ones perhaps too, plain; Files, each with its type's icon and tagged with its category, its
  tag naming the control characters or long lines it holds; and, where the
  package has any, its binary files again on their own.
- **Code**: the file tree and source viewer, opening on what `main` names.
- **Treemap**: the files by size, as for bundles, colored by the top-most
  directories that tell them apart, as package colors can't tell one
  package's files apart: below the directories every file shares, each
  directory has its color, and the files loose in a directory passed on the
  way have one more (`src/a/`, `src/b/` and `src/*.js` for `src/a/a.js`,
  `src/b/b.js` and `src/c.js`), the largest first; a package of loose files
  alone is colored by extension. Any bundle of a single package is colored
  the same way.
- **Compare**: the bundle Compare, with another version of the same package,
  picked from its versions newest first. Its Dependencies section, in place
  of Packages, lists the dependencies only one version has and the ranges
  that changed. Files that are not text compare by digest. **Swap** opens
  the version compared with, comparing it with the one before. Both sides
  are pickers, as for bundles: picking the open side's opens that version
  compared with the same one, and picking the other side's swaps them. Code
  and Diff review the changes as for bundles.

A dist-tag link, such as `/npm/lodash`, is committed to history at the exact
version it opened. Code links name files by number and lines in the fragment,
and Compare links the version compared with and its mode, as for bundles. The
browser keeps the last three public versions it read, and the package's
version list, figures and advisories, in memory for the session and role that
read them, so a swap or Back reopens one without another request. A private
version is asked for each time it opens, so the server checks again access the
reader may have lost since, as to a team's npm scopes. A version list,
figures or advisories that failed are asked for again after ten seconds, twice
as long after each failure in a row up to five minutes, on a repaint scheduled
for then.

`GET /api/npm/package?name=&version=` returns `{ name, version, private,
integrity, tarballSize, manifest, files }`, the manifest's `publisher` the npm
account that published it (never its email), and each file row `[path,
bytes, text]`, or for a file that is not UTF-8 `[path, bytes, null,
'sha256-<base64>']`. `version` defaults to `latest`. `GET
/api/npm/versions?name=` returns `{ name, private, distTags, versions }`,
newest first, and `GET /api/npm/download?name=&version=` the tarball.
`GET /api/npm/stats?name=` returns `{ name, downloads, github }`: `downloads`
is `{ start, end, days }`, a count a day over the last year from npm's
downloads API, and `github` is `{ repo, stars, forks, openIssues, openPulls,
archived, pushedAt }` for the repository the latest version's manifest names,
`openIssues` taking in the open pull requests `openPulls` counts apart (from
the last page of their list, one a page; null where GitHub didn't say); either
is null where it can't be had, `github` for a repository GitHub does not
say is public. `GET /api/npm/tags?name=&version=` returns `{ name, version,
tags }`: the tags of its GitHub repository that point to its publish commit
(`gitHead`), among those whose names hold the version (`v1.2.3`,
`pkg@1.2.3`), which the Overview shows after the commit. GitHub's GraphQL API
finds them by name, and needs a token: the reader's own, where they have one,
and none are asked without. Only a public repository's are answered, kept an
hour for that repository and commit. `GET /api/npm/advisories?name=` returns `{ name, versions,
advisories, repository }`, asked as bundle advisories with repository
advisories are: what `npm audit` asks npm's registry, for every published
version at once (`source: 'registry'`), and what the package's GitHub
repository publishes that npm does not report yet (`source: 'repository'`):
the repository its latest version names, asked for only where GitHub says it
is public, asked afresh rather than from its figures' kept answer, since the list is kept for every reader and
the reader's token could read a private repository's; its listing is kept
where bundle audits keep theirs. Each advisory is `{ id, source, ghsa?,
url?, title?, severity?, cvss?, cwe, range?, affected }`, `affected` indexing
`versions`, one row an advisory: npm's registry answers one a range it covers,
merged here, their ranges joined with `||`. `repository` is false where GitHub refused (its anonymous rate
limit, say), or couldn't say whether the repository is public, leaving npm's
alone; such a list is asked again on the next request. Responses are `private, no-store`. Nothing derived from a package's
files is kept on the server; its figures and advisories, which are public,
are kept an hour, npm's asked for without the server's npm token, and GitHub
with the reader's own token where they have one. Access to the package is
checked first on every request, as for its versions.

Anyone with workspace access can read public packages. Private packages need
the server's `NPM_TOKEN`, the same one bundle builds use, and a reader with
access to them: an admin or manager, or a member of a visible team that lists
the package's scope. Admins list scopes per team in **Manage → Teams → npm
scopes** (`POST /api/admin/teams/set-npm-scopes` with `{ teamId, scopes }`,
replacing the team's list); `GET /api/admin/teams` returns each team's
`npmScopes`. Scopes are lowercase, with `@` added when typed without one.
Changes are recorded in the activity history, and scopes are removed with
their team.

For everyone else, a version is public only when the registry answers for it
without credentials. That request is made on every read and never answered
from a cache: documents and tarballs that a bundle build fetched with the token
can remain in upstream's caches, readable without one, so leaving the token out
is not enough. Tarballs are read from there all the same, as the answer names the sha512 the
tarball must have: one kept in upstream's cache directory (`npm/tarballs`,
where bundle builds keep theirs), or in npm's own cache, is served only when it
matches. Otherwise the tarball comes from the registry, at the package's own
path, without credentials for a public version, is checked against that sha512,
and is then kept in upstream's cache, where the server has one. Readers with
private access also try the registry anonymously first, and retry a scoped
package with the token; their answer says `private: true` when only the token
could read it. Access is checked again after the registry answers, and a
reader who lost private access meanwhile gets 404. A version npm doesn't have,
and a private one the reader cannot open, are both 404 `package-not-found`.

Packages unpack in memory, bounded at 64 MiB of files, 20,000 files and a 96
MiB tar stream, and their files at 96 Mi characters of JSON, counted before it
is written, as escaping can grow a text sixfold; larger ones return 413
`package-too-large`, before download when the registry's `dist.unpackedSize`
or `dist.fileCount` says so. Directories, links, and paths that would leave
the package are not extracted. At most four loads run at once per process (429
`npm-busy`), each until its response is encoded and every response holding it
is written or abandoned, a response left unread for a minute being dropped;
concurrent reads of one version share its download and its encoded response. A
download is the tarball as the registry has it, not unpacked, and a tarball is
refused once past 96 MiB as it arrives, whatever sizes its document declares.
Registry documents being read at once are held to 256 MiB, each counted at its
limit until it is parsed (8 MiB for a version, 64 MiB for a version list); a
read past that is 429 `npm-busy` too. Public workspace links cannot reach
these endpoints.

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

## Creating GitHub issues

The finding's **Issue** action in managed mode opens an editable title and
description, then creates the issue as the signed-in GitHub user after they
select **Create issue**. The confirmation shows the fetched title, description,
author, status, number and labels. It uses their server-held user access token, never
an installation token. Reauthorization, when needed, must return the same GitHub
account and preserves the existing DeepView session.

Use one GitHub App for sign-in and repository access: `GITHUB_CLIENT_ID` and
`GITHUB_CLIENT_SECRET` are its user-authorization credentials; `GITHUB_APP_ID`,
`GITHUB_APP_PRIVATE_KEY`, and `GITHUB_APP_SLUG` are its installation credentials.
Keep **Account permissions** unset/minimal so login requests no elevated account
access. Repository **Contents: read** and **Issues: read and write** are approved
when connecting repositories, not added as login OAuth scopes. Existing
installations must have their owner approve the Issues permission update; the
issue dialog offers the installation flow when approval is missing. GitHub App
permissions are configured on the app, rather than requested as incremental
OAuth scopes. See [GitHub's permission model](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app).

API creation is limited to a visible finding in the current team and a repository
assigned to that team where the app is installed. The target must match the
finding's declared repository, or the report's managed assignment when the
finding has no repository; a different repository in the same team is rejected.
Other repositories, public
workspace views, and E2E/local mode use GitHub's prefilled issue form. The dialog
offers that form only when the server selects the repository fallback. No issue
is posted by signing in, checking authorization, or connecting a repository.

Both forms and API creation request `deepview`, plus `security` for `isSecurity`
findings, then comma-separated `GITHUB_NEW_ISSUE_LABELS` (optional). Labels are
trimmed and deduplicated. The API checks every requested label with the acting
user's token and silently omits names the repository lacks; it never creates
labels as a side effect. Security labels on the API path are derived from
the server's team-wide classification, including hidden siblings and links.

`GET /api/teams/:id/issues?reportId=...&findingId=...&repository=owner/repo`
checks availability. `POST` to the same path takes these fields plus `title`
and `body`, requires the session's CSRF token, and rechecks current workspace
access before creating. A lost GitHub response is not retried automatically,
since the issue may already exist. Explicit preflight failures (for example, a
failed label lookup) remain retryable by the user. Unknown server failures and
lost or malformed responses remain uncertain.

The `managed_finding_issue.issue_url` field stores one permanent reference per
finding ID, shared across reports and teams. No triage, import, or management
write can replace or clear it. Findings with a saved issue show its link and
GitHub status instead of the creation action. Reading the reference still requires finding visibility and
access to its repository through the current team; a matching finding ID alone
does not reveal another team's repository or issue URL.

Issue details, manual Fix metadata and linked PR states use a single GraphQL
batch with the viewer's GitHub token (additional batches for pagination or more
than 200 distinct links). The newest linked PR by creation time, excluding
closed-unmerged PRs, is saved separately in `managed_finding_issue.auto_fix_url`.
Every successful complete refresh replaces or clears this derived value; failed
or incomplete reads preserve it. Linked PRs outside the current team's repository
grants are not exposed or saved. Public shares do not expose saved issue records.

Manual `fix` remains exclusively a user override. Findings display both Fix links
when they differ; small Kanban cards prefer manual Fix regardless of PR status.
Either link satisfies **Has fix**. Derived updates do not create triage history.

An atomic database reservation prevents simultaneous requests, including those
on different servers, from creating duplicate issues. Definite GitHub rejection
releases the reservation; ambiguous failures retain it for operator reconciliation
instead of automatically creating another issue. The reference is saved before
fetching details, so a failed detail request still returns creation success with
the saved URL and the submitted content. If the final workspace access check
fails, the response confirms creation without exposing the issue URL or details;
the dialog offers a status check instead of another creation. Pending responses
link to the repository's issue list, never its new-issue form.
