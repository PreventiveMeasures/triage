# Managed browser navigation

Every page of the managed UI has its own URL, so links, reloads and Back and Forward work.
A team's workspace can also be shared read-only through a public link that needs no GitHub sign-in.
This page describes public links, which are an external API, and lists the page routes and who may open them.

## Public workspace links

Set `DEEPVIEW_ALLOW_SHARE=1` to turn on public links.
Any other value, or none, disables sharing and every existing link.
Turning sharing off does not delete links, so turning it back on makes unrevoked links work again.
Links also work on combined managed + E2E deployments.

- A manager can share a team they belong to, and an administrator can share any team, with the sidebar's **Share public link** button.
- The share dialog creates a link, with the **Security** and **Dependencies** permissions both off by default, and can revoke all of the team's links.
- Manage's **Links** tab lists links by team, with their creator, creation time and permissions.
  Managers see their own teams' links, and administrators see all links.
  **Edit** changes a link's permissions without changing its URL, or revokes it.
- Only token hashes are stored, so a link's URL cannot be shown again.
  Copy it before closing the dialog.

### What a link exposes

A link is read-only, like the Viewer role: triage, fix links, flags and colors show with their controls disabled, and comments are read-only.
It exposes the team's currently published reports, including reports published later in the team's repository paths, with their links, triage, comments and cited source files.
Whole-repository team grants also expose their bundles, and directory-only grants expose only cited source files.
Published advisories require the **Security** permission.
The security and dependency finding filters apply alike to report data, comments, triage and cited sources.

A link never exposes:

- drafts, or any other team's workspace
- GitHub pull request metadata, bundle commit details and tags, or user avatars
- finding triage history, even when a login cookie is also present
- any global endpoint, mutation, cleanup or sync transport

### Tokens and lifetime

New links use `/team/<team-slug>#public=<link-id>.<token>`, and older links with a team ID before the token still work.
The token holds 256 random bits, and only its SHA-256 hash is stored, apart from sessions.
The eight-character link ID is a prefix of that hash, shown in the dialog and the Links tab to match a URL to its entry.
Only the full token resolves a workspace, and the slug and link ID cannot grant access or select another team's data.
The token stays in the URL fragment as the user navigates, and is never sent in page URLs or kept in local storage.

Links survive restarts and the issuer's logout.
Reads recheck the link's current scope after slow storage or upstream work.
A link stops working when:

- it is revoked
- sharing is disabled
- the team is deleted
- its issuer is no longer an administrator, or a manager who is a member of that team

### Endpoints

Managing links requires an authenticated team manager or administrator, and mutations also require same-origin access and CSRF.

| Request | Effect |
| --- | --- |
| `GET /api/admin/links` | Lists the links within the caller's scope |
| `GET /api/teams/:id/share` | Lists one team's links |
| `POST /api/teams/:id/share` | Creates a link with `{ security, dependencies }`, where only literal `true` opts in |
| `PATCH /api/teams/:id/share/:id` | Replaces a link's permissions |
| `DELETE /api/teams/:id/share/:id` | Revokes that link |
| `DELETE /api/teams/:id/share` | Revokes all of the team's links |

A link holder sends the token from the fragment in the `X-Deepview-Share` header, without cookies.
A supplied token takes precedence over any login cookie.
It may call only these read-only routes, and every other route is denied:

- `/api/shares/:linkId/workspace`, for the token's own workspace only
- `/api/teams/:id/{shared,reports,feed,annotations}`
- the `triage`, `comments` and `sources` routes of reports the link can see
- the `metadata`, `contents`, `download`, `pretty`, `advisories`, `rename-diff`, `type-only` and `comparison` routes of bundles the link covers, where a comparison must be with another of those bundles

## Page routes

Build the UI with `pnpm build` before starting a managed or combined server.

| URL | Page |
| --- | --- |
| `/` | Team landing and login |
| `/team/:team[/{files,reports,bundles,repositories}]` | A team's findings, files, reports, bundles or repositories |
| `/team/:team/dependencies[/:tab]` | A team's Dependencies: `versions`, `branch`, `reviews`, or none for Pull requests |
| `/team/:team/report/:report[/files]` | A report's findings or files |
| `/team/:team[/report/:report]/finding/:findingId` | A finding, in a team or a report |
| `/team/:team/bundle/:bundle[/:tab]` | A team's bundle |
| `/manage/bundle/:bundle[/:tab]` | A bundle with no accessible team (manager or admin) |
| `/repo/:repoId[/:commit[/:tab]][?path=:dir]` | A repository directory at its default branch or a commit, on Code, Search, Treemap, Compare, or an Activity view (`commits`, `issues`, `pulls`, `agents`, `pulse`, `replay`) |
| `/npm[/:name[@:version][/:tab]]` | npm package lookup, or a version; `:version` may be a dist-tag |
| `/npm/:name@:version/review[/:base@:baseVersion]` | Review a package, or an update from a base version |
| `/manage[/{bundle,scans,report,history}]` | Manage overview, Bundles, Scans, Reports, Activity history (`?actor=:login` filters it) |
| `/manage/{deduplication,repositories,repositories/risk,users,team,import}` | Admin pages |
| `/manage/links` | Public links, only while sharing is enabled |
| `/my/{profile,reviews}` | Profile and linked GitHub accounts, My reviews |

On bundle, repository and npm version pages, `…/code/:file` opens Code at a file, and `…/compare[/:other[/code]]` opens Compare with another bundle, commit or version.
Older names still open: `/diff` opens Code, `history` opens Commits, and `/manage/code/` links open the `/repo/` page.

Teams, reports and bundles have persistent, server-assigned slugs: the last UUID component when it is unique, and otherwise the full ID.
Finding IDs are percent-encoded as one path component, and a finding opens only under a team or report.

Access and serving:

- Manage pages require a manager or admin, and the admin pages require an admin.
- Team, report and team bundle URLs require the user's access to that team.
- A page the user cannot open returns to the landing page.
- Finding triage history requires an authenticated `triage`, `manage` or `admin` role and access to the finding.
  Triage users must name their team, whose security and dependency filters apply.
- Browser history holds only a navigation generation, never report or triage data.
- Managed and combined servers serve the entry HTML for page `GET` and `HEAD` requests, including direct loads of nested URLs.
  `/api` and `/api/*` always stay API routes, and missing assets and other methods never get the entry HTML.
- E2E and local mode do not use these routes, and switching mode returns to `/`, so Back cannot reopen the old managed pages.

## Compare

Compare reviews the changes between two bundles of the same repository, two commits, or two npm versions.
The first picker chooses what to compare with, the second the side that is open, and changes read from the first to the second.
Its Overview counts files, size and lines of code on each side, and its Code view shows the diffs beside a tree of changed files.
Each file is flagged where it is hard to review or risky: unusual characters, large or obfuscated content, entry points and licenses, install scripts, code capabilities (`eval`, `child_process`, `credentials`, `whole env`, `publish`, `shell`, `persistence`) and hosts known from malicious packages, each marked when new.
Between stasis bundles it also compares each file's recorded format, execute bit and entry-point status.
Whitespace changes can be hidden, as `diff -b` does, in languages where whitespace has no meaning outside strings.
For repository directories, see [code-viewer.md](./code-viewer.md).
