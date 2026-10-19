# Reports

Managed mode stores uploaded reports, shows the published ones to each team, and keeps triage, comments, Fix links and GitHub issues per finding.
This page covers who can upload, triage, comment and import, the limits a user can hit, what the live feed and activity history show, and the GitHub App permissions that issues and checks need.
Roles and account approval are in [accounts](./accounts.md), public workspace links in [navigation](./navigation.md), and bundles in [bundles](./bundles.md).

## Uploading reports

Managers and admins upload reports in **Manage → Reports**.
New reports stay unpublished until a manager or admin publishes them.
Reports accept up to 25 MiB by default.
`MAX_REPORT_BYTES` changes the limit, up to 100 MiB.
The limit applies to the original file, before storage compression.
The browser refuses a larger file before sending it, and the server answers `413` `too-large`.
Large uploads are sent in parts; see [uploads and resource limits](../server-managed/VERCEL.md#uploads-and-resource-limits).

Automation posts the raw report to `POST /api/admin/reports`, with the session cookie and `X-CSRF-Token` like any other write.
`X-Report-Filename` names the file.
`X-Repo-Id` and a URL-encoded `X-Repo-Directory` set the location of a report with no embedded repository.
A new report returns `201`.
Identical content, including from retries and workspace imports, returns `200` with `deduped: true` and the stored ID, even under another filename.
A reused report keeps its filename, repository assignment, publication state and bundle link.

The location comes from the report's embedded repository, else from those headers, else from the findings.
A report whose findings alone name a repository, such as Claude Security Markdown or a Codex CSV export, goes to the single repository they name outside `node_modules/` (else `vendor/`, else `dependencies/`), when it is active and within the uploader's access.
Otherwise the report stays unattached, and a manager can assign it later.
Report headers show the location assigned on the server, not the one embedded in the report.

Stored reports are Brotli-compressed and, when enabled, encrypted (see [managed storage encryption](../server-managed/STORAGE-ENCRYPTION.md)).
Downloads return the original filename and bytes.

## Upload encryption in transit

A CDN or proxy that terminates TLS, such as Cloudflare, could otherwise read every uploaded report, bundle and links file.
The browser therefore seals each upload with AES-256-GCM, under a key agreed by X25519 between a fresh ephemeral key and the session's own key pair.
The private key stays on the server, so the proxy sees only public keys and ciphertext.
The server rejects altered bodies, bodies sealed for another session, and content over the upload limit once decompressed.
Unsealed uploads are still accepted, so scripts keep working.
This protects against a proxy that observes traffic, not one that alters the page's JavaScript or swaps the public key.
Downloads and JSON requests, such as triage and comments, are not sealed.

## Repositories and aliases

Only admins add repositories, in **Manage → Repositories**.
Discovery lists the repositories the admin can access on GitHub, and **Show all** lists every repository the GitHub App can reach.
Permission checks need only the App's **Metadata: read** permission.
Public discovery lists only public repositories the admin is involved with.
**Add a public repository** takes any public repository, and is offered only to admins whose numeric GitHub ID is in `WHITEHAT` in `server-managed/repository-policy.ts`.
It verifies that the repository is public, and never grants private access or the right to add repositories.

Admins map old locations to connected repositories in **Manage → Repositories → Aliases**.
Each alias maps an old repository and path to a connected repository and new path, and an empty path is the root.
Repository names match case-insensitively, and directories case-sensitively at path boundaries.
The longest matching old path wins, the rest of the path is kept, and aliases never chain.
For example, `org/a` at the root mapped to `org/b` at `projects/a` assigns a report declaring `org/a` at `src` to `org/b` at `projects/a/src`.
A Stasis bundle also matches by the directory all its files share, when that part ends both the old and the new path, because file paths are never rewritten.
Aliases only set the detected location of new reports and bundles, and explicit locations override them.
Editing an alias or connecting a repository moves no existing content, and findings, file paths and hashes never change.

## Team workspaces

A team's view combines the published reports inside its repository paths.
Even admins and managers must be members of the team to open it.
Ordinary users see findings filtered by that team's Security and Dependencies grants, and grants in other teams do not widen them.
Admins and managers bypass these filters.
`triage`, `manage` and `admin` users can triage findings in reports they can read, and `view` users only read.
Triage and comments are shared by finding ID across reports and teams, and the team only decides who may read and write them.

Unpublished reports never appear in team views, annotations, Fix lists or feeds, for any role.
An admin or manager who is a team member can open one inside the team's scope as an isolated preview of that report alone.
Anyone else gets `404`.

A team view loads at most 4,096 reports and 1 GiB, and a larger workspace fails with `413`.
Its reports come without their file trees: each tells how many files its tree holds (`treeFiles`) and the dependency directory it names (`treeDependencies`), and `GET /api/teams/:id/trees` answers the trees by report ID (each file's without its `treeHash`), under the same access, only once the view's Graph or Files needs them.
`GET /api/teams/:id/reports?lite=1` sends the same reports with each finding's detail left out (its description, evidence and narrative, its hashes, export, commits, dates and other facts, and the run meta beside `model` and `type`: `common/managed/finding-detail.js` lists them; an untitled finding keeps its description's first line, which names it), and neither carries what nothing reads: a finding's `treeHash`, the `_idBasis` its ID was derived from, or a run's `think`.
The browser draws a team's board from those and asks for the whole reports beside them; a finding's popup, the other view modes and an export wait for them.
The server rechecks access and publication after loading, and refuses rather than return a workspace that changed meanwhile.
The browser keeps report content, comments, history and GitHub metadata in memory only, and responses are never HTTP-cached.

The sidebar opens a team collapsed to its finding count when its workspace has a basic App view, or when none of its reports opens in App mode.
Other teams open expanded, and the sidebar follows publication, grant, scope and link changes live.

## Deduplication reports

Links files (`*.link.json`) group finding IDs that are the same issue.
Only admins import them, in **Manage → Deduplication** or through the report upload endpoint.
They are installation-wide, with no repository or team, and are enabled or disabled instead of published.
They need `MANAGED_STORAGE_ENCRYPTION_KEY`; see [deduplication reports](../server-managed/STORAGE-ENCRYPTION.md#deduplication-reports).
A security classification spreads across whole rows and enabled links before dependency filtering.
Responses list only groups of at least two findings the reader can see.
Hidden or absent findings can still connect visible ones, but their IDs are never disclosed.

## Live updates

Signed-in pages keep one live feed, so team views update without reloading.
It tells the browser when to refetch:

- **Catalog**: the user's memberships, grants, repository scopes, team names, and visible reports and bundles, across all their teams.
- **Triage**: triage and comment changes in the focused team only, from its published reports, or from the one unpublished report being previewed.

Home, bundle and Manage pages get catalog changes only, even before the user joins a team.
Each triage notice carries an opaque revision of the team's annotations, the same one `GET /api/teams/:id/annotations` answers with.
The browser refetches only when the revision differs from the one it last read, so a reconnect that finds nothing changed reads nothing.
A public link's feed carries no revision.
A reconnect catches up on missed changes.
Notifications never carry finding IDs, annotation text, membership details or history sequence numbers, and the browser refetches through the usual access-checked reads.
Losing membership of the focused team stops its triage updates.
Logout, session expiry or a role change closes the feed, and the page revalidates the session.
Public-link feeds cover only that link's workspace, never the issuer's other teams.
Server instances that share a database see each other's writes, with no extra message service (see [team update streams](../server-managed/VERCEL.md#team-update-streams)).

## Comments

Anyone who can read a finding sees its discussion.
`triage`, `manage` and `admin` users can add comments, and edit or delete their own.
Admins can also delete comments that have no author.
The server takes the author from the session, and the client cannot choose it.
Comment text must be nonempty and at most 10,000 characters.
Editing or deleting a comment that changed since it was read fails with `409`, instead of overwriting newer text.
Imported comments, and comments carried over from older triage rows, have no author.
Removing a repository's annotations also deletes their comments, except on findings that other repositories share.

## Fix pull requests and issues

A finding's Fix can link a GitHub pull request or issue.
Team views show each linked item's title, description and status: open, draft, closed or merged for pull requests, and open or closed for issues.
Closed issues also show a reason: completed, not planned, duplicate or unknown.
Links come from manual Fix values, and from saved issues and their linked pull requests (see [Creating GitHub issues](#creating-github-issues)).

- The viewer must be an approved member of the team, and the link must sit on a finding they can see under that team's filters.
- The link's repository must be assigned to the team, even for admins.
  Links to other repositories stay plain links.
- Private and internal repositories are read with the viewer's own GitHub token, after a live check that they can read the repository.
  Installation credentials are never used.
- Public repositories are read anonymously.
  A repository's public status is reused for up to a minute, so a repository made private can show cached metadata until the next check.
- Private access is never cached across requests, and the checks run on every request, for admins too, and for cached items.
- Missing credentials, denied access, redirects and failed checks show the item as a plain link, without cached titles or descriptions.
- Access and the saved Fix links are rechecked after GitHub answers, before anything is returned.
- Cached metadata never grants access to another team, repository, hidden finding or GitHub user.

Merged and closed items are kept once fetched, and open items are refreshed when over a minute old.
Each load refreshes at most 200 items, so a large workspace can show older statuses until later loads.

## Creating GitHub issues

In managed mode, a finding's **Issue** action opens an editable title and description, and **Create issue** files it as the signed-in GitHub user.
Creation uses that user's server-held token, never an installation token.
Reauthorization must return the same GitHub account.
Signing in, checking authorization or connecting a repository never posts an issue.

Use one GitHub App for sign-in and repository access:

| Variables | What they are |
| --- | --- |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | The app's user-authorization credentials |
| `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_SLUG` | The app's installation credentials |

Keep **Account permissions** unset or minimal, so login requests no elevated account access.
Set these repository permissions on the app; they are approved when repositories are connected, not requested as login scopes:

- **Contents: read**, **Issues: read and write** and **Pull requests: read**.
- **Checks: read** and **Commit statuses: read**, for a pull request's checks.
- **Dependabot alerts: read**, so a repository risk scan can include Dependabot alerts for an admin whom GitHub lets see them.

The owner of an existing installation must approve each permission change, and the issue dialog offers the installation flow when approval is missing.
See [GitHub's permission model](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app).

The server creates an issue only for a finding visible in the current team, in a repository assigned to that team where the app is installed.
The repository must be the finding's own, or the report's assignment when the finding names none.
Other repositories, public workspace links and local mode open GitHub's prefilled new-issue form instead.
Issues get the label `deepview`, `security` for security findings, and the comma-separated labels in `GITHUB_NEW_ISSUE_LABELS` (optional).
Labels the repository lacks are left out, and labels are never created.

Each finding ID keeps one permanent issue, shared across reports and teams, which no triage, import or management write can replace or clear.
Reading it still needs the finding to be visible and its repository reachable through the current team, so a matching finding ID reveals no other team's issue.
Public links never expose saved issues.
The newest pull request linked to the issue, other than one closed without merging, becomes the finding's derived Fix.
Linked pull requests outside the team's repositories are neither shown nor saved.
A manual Fix stays a user override, and both show when they differ.
Either one satisfies **Has fix**, and derived updates add no triage history.
A kanban card has room for one link: the manual Fix, else the derived Fix, else the issue.

A database reservation stops simultaneous requests, even on different servers, from creating duplicate issues.
A lost GitHub response is never retried automatically, and the dialog offers a status check instead.
After an ambiguous failure the reservation stays in `managed_finding_issue` until an operator reconciles it with GitHub.
If access is lost during creation, the response confirms creation without the issue's URL or details.

## Manager content access

Managers manage the reports and bundles they uploaded, and those inside the repositories and directory scopes their teams grant.
This covers catalogs, downloads, uploads, publication, assignment, deletion and triage.
Managers can review unpublished reports in scope, while `view` and `triage` users need published ones.
Admins have unrestricted content access.

- Managers can upload unassigned content, and keep access to their own uploads.
- Detaching or deleting attached content needs access to its current repository and directory.
- Assigning content needs access to the destination, and repository pickers list only allowed repositories.
- Upload deduplication and automatic report–bundle links never reach content the manager cannot access.
- Publication, reassignment, deletion and uploads recheck the session, role and grants when they write.
- Repository connections, teams, memberships and roles are admin-only.

If a repository's reports change while it is being removed, removal fails with `409` `repository-changed` and deletes nothing; refresh and retry.

## Workspace imports

Only admins import a local workspace into a new team, in **Manage → Import**.
The import grants the team access through the content's active repository and directory, assigns unattached content, and publishes the reports.
Links files become deduplication reports instead.
Reports with embedded repository metadata need that repository to be active.
Other content goes to the repository typed for it in local mode, else the one its findings name, through the current aliases, else the repository selected for the import.
Triage merges by finding ID through the usual import conflict dialog.
A comment whose text the finding already has is skipped, and history records the admin as the actor without claiming they wrote the text.

## Activity history

**Manage → Activity history** lists uploads, triage, publication changes, repository assignments and connections, deletions, roles, teams and team access, newest first.
Admins see everything.
Managers see uploads, publication changes, assignments and triage for reports and bundles within their current team access and directory scopes, including unpublished reports.
Repository administration, team changes and role changes are admin-only.
Counts, search results and context follow the same limits.
A deletion shows to managers who could reach the content's repository and path when it was deleted, and other events about removed content are admin-only.

Entries hold the actor, action, target and time, never comment text, annotation bodies or credentials.
Unchanged edits, failed requests and deduplicated uploads add no entries.
Upload and management entries survive content deletion and account renames.
Triage history is kept in full unless `TRIAGE_HISTORY_LIMIT` bounds it per finding, and explicit triage deletion removes it.
Older entries that recorded only a login are never attributed to a current account.

The **Users** page derives Last activity from the user's latest retained history entry, so reading pages counts for nothing.
Last seen tracks sign-ins separately.
Users without attributable history show Unknown.
