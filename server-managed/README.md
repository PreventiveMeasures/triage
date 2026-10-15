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
state cookie names (`dvstate`, `dvissuestate`, `dvlinkstate`); startup fails if it does. `GET /api/auth/session` then returns the viewed
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

## Profile and linked GitHub accounts

**Profile** in the account menu (`/my/profile`) shows a user's avatar and name
and the GitHub accounts linked to theirs. **Link GitHub account** runs the
App's user authorization again, asking GitHub for its account picker
(`prompt=select_account`), and links whichever account completes it. Linking
needs workspace access (any role but No access) and is refused while an admin
views as the user. Its state is bound to the session that started it, in a
`dvlinkstate` cookie, and expires after ten minutes. The linked account's
token is used only to read its identity and avatar; it is never stored.

A linked account is reserved for its user: it can neither sign in
(`403 { "error": "github-account-linked" }` from the OAuth callback) nor
register. Linking is refused for the sign-in account itself, an account another
user linked, and any account that has signed in here before, which already is
a user of its own. Refusals land back on the profile, which explains them.
Unlinking frees the account to sign in or register again. Linking and
unlinking are recorded in the access history.

A user's login and GitHub ID always stay the sign-in account's. Their displayed
name and avatar may each come from any of their accounts: the name is then
shown wherever they are, and `/api/avatar/<user id>` serves the chosen avatar
(`?own` serves the sign-in account's). Linked accounts' names are kept as they
were when linked; linking an account again refreshes them. Signing in refreshes
the sign-in account's own name, which is displayed unless another was chosen.
Unlinking an account returns the name or avatar it gave to the sign-in
account's.

`GET /api/auth/profile` answers the profile; `POST /api/auth/profile` with
`{ "name"?: <id> | null, "avatar"?: <id> | null }` chooses accounts (a linked
account's ID, or null for the sign-in account); `DELETE
/api/auth/profile/accounts/<id>` unlinks one. Changes need same-origin access
and CSRF. Database upgrades keep existing names as the sign-in accounts' own.

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
bundles' `metadata`, `contents`, `download`, `pretty`, and `advisories` routes. Global
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
| `/manage/code/:repoId[?path=:directory]` | A repository directory at its default branch's head; its route then names the commit |
| `/manage/code/:repoId/:commit[/:tab][?path=:directory]` | A repository directory at a commit, on its Code, Search, Treemap or Compare tab, or a view of its Activity: `commits`, `issues`, `pulls`, `agents` or `pulse` (`history`, its earlier name, opens Commits) |
| `/manage/code/:repoId/:commit/code/:file[?path=:directory]` | Its Code tab, at a file |
| `/manage/code/:repoId/:commit/compare[/:otherCommit[/code\|/diff]][?path=:directory]` | Its Compare tab, with the directory at another commit, in its Code or Diff mode |
| `/manage/scans` | Scans |
| `/manage/report` | Reports |
| `/manage/repositories` | Repositories (admin) |
| `/manage/users` | Users (admin) |
| `/manage/team` | Teams (admin) |
| `/manage/history` | Activity history; optional `?actor=<login>` |
| `/my/profile` | Profile and linked GitHub accounts |
| `/my/reviews` | My reviews |
| `/npm` | npm package lookup |
| `/npm/:name[@:version][/:tab]` | npm package version; `:version` may be a dist-tag |
| `/npm/:name@:version/code[/:file]` | Its Code tab, at a file |
| `/npm/:name@:version/review[/:baseName@:baseVersion]` | Review a package or update; automatically chooses whole-diff or per-file display |
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
both pickers, the one compared with first and the open bundle second, the
changes reading from the first to the second. The first picks what to compare
with; the second opens the bundle picked, compared with the same one (picking
that one swaps the two). What it compares with stays while another tab of the
bundle is open, as Back gives too, so its tab opens with it again. Its
summary counts files, size and lines of code (non-blank lines of its text
files) on each side; a file's lines are in its size's tooltip. Compare offers accessible
bundles assigned to the same repository, including bundles not previously opened.
Unattached bundles cannot be compared with each other. Past its Overview,
Compare reviews the changes in **Code**, beside the tree of changed files.
While every changed file's diff fits in a list of under 25,000 rows (its
folded unchanged runs, each file's head and each repointed import counted),
Code lists them all, one after another, each under its name, in the tree's
order: picking a file in the tree scrolls the list to it, and the file at
the list's top is marked there as it scrolls; a file whose only change is a
repointed import lists those imports alone. Past that, Code shows a file at
a time, its Previous and Next file buttons stepping through them in the
tree's order. A link naming the older Diff mode opens Code. Each file's
head tags how it reads, as the npm Overview tags files (ASCII, UTF-8,
Controls, Minified, ...), after how it read where that differs, with every
other label it has now, Controls and Long lines, beside it, and the tree
tags a file more briefly where it can be hard to review by reading it: its
category (but Map, as a source map's name says, which its head keeps), and
its controls and unexpected long lines; both
tag it Large or Obfuscated as the npm Files list does, as it is now (as it
was, for one removed). A file a
bundle or package starts from is labelled in blue in its head (a Stasis
bundle's entry, an npm version's main, module, types or bin), a license
file as license in grey (an npm version's at its root, its tooltip naming the
licenses its manifest's expression opens it for, and a bundle's packages'), and a
package.json's install scripts (preinstall, install and postinstall, which
npm runs installing it from the registry, not prepare, which it runs only for
a local or git install, and `node-gyp rebuild` beside a binding.gyp) are marked in its head and in
the tree, each with its command, one new or changed saying so, and in its
head one no longer named struck through. For an npm version, a file
Socket raises an alert on is labelled with it in its head and in the tree.
A script is labelled with what its code can do beyond itself, in its head
and in the tree: run a string as code, one `eval` label for `eval` (not
a key named so, as WebAuthn's `extensions: { prf: { eval: … } }`, but a
worker's `{ eval: true }` and eval destructured from the global object), `Function` (with `new` or without, but not `Function('return this')()`,
older code's way to the global object, as lodash's and ejs's), `vm` and
Module's `_compile` (called or hooked), its tooltip naming each; run other programs (`child_process`);
reach for `credentials` (a path to `.npmrc`, `.ssh` or `.aws`, or
`NPM_TOKEN` or `GITHUB_TOKEN` where its value is read, as
`process.env.GITHUB_TOKEN || null`, `process.env['NPM_TOKEN']` or a shell's or
`.npmrc`'s `$GITHUB_TOKEN` and `${NPM_TOKEN}` do, not where its absence is
told, `!process.env.GITHUB_TOKEN` (but for what is read of it,
`!process.env.GITHUB_TOKEN.trim()`), it is deleted or only set
(`process.env.NPM_TOKEN = token`), or text names it; `gh auth token`, as a
string or a program's arguments apart, `spawnSync('gh', ['auth', 'token'])`;
the cloud's instance metadata endpoint, `169.254.169.254` or
`metadata.google.internal`, not Azure's `/metadata/instance`, a machine's
region; the GitHub Actions runner's process, `Runner.Worker`; another
process's memory, `/proc/<pid>/mem` by a pid, a glob (`/proc/*/mem`) or a
substitution (`/proc/${pid}/mem`), not `/proc/self/mem`; or `trufflehog`, in
any case); read out
the `whole env`, as
`JSON.stringify(process.env)` or `Object.entries(process.env)` do, not where
it is handed to a program, its names listed, or its entries picked among as
they are read (`.filter(…)`, `.find(…)`, `.reduce(…)`, as npm's agent finds
its proxy's); `publish` to npm (`npm publish` run, the registry's
`/-/whoami`, libnpmpublish, a PUT request in a file naming the registry: its
URL as JavaScript reads the string, its escapes decoded, the host after a
URL's two slashes (or backslashes) or an http(s) scheme, userinfo between
(`https://registry.npmjs.org/`, `.npmrc`'s `//registry.npmjs.org/`), or its
host starting a string, its whole or before its path or port; not its host in
prose, as the advisories' consent dialog tells it); run `shell` commands
fetching or handing off code (`curl` or `wget` given a URL, a download piped
to a shell, `powershell -…`, rundll32, osascript, mshta, `certutil
-urlcache`, `bitsadmin /transfer`, `/dev/tcp/`, PowerShell's `iex` of what
`iwr` or `irm` fetches); and name a place code runs from again later,
`persistence` (a shell's rc file, PowerShell's `$PROFILE`, LaunchAgents and
LaunchDaemons, systemd's user units, `.claude/settings.json`,
`.vscode/tasks.json`, a directory and its file named apart as `path.join`
takes them). A shell script (`.sh`, `.bat`, `.ps1` …, or a shell's hashbang)
is read whole for the last two, and for the `credentials` a command reaches
for (`gh auth token`, `Runner.Worker`, `/proc/<pid>/mem`, `trufflehog`).
Each label is marked as an install script
is, `whole env`, `publish` and `persistence` in red, worse; its tooltip a
list, as Compare's chips' are, of
what it found (each way a string runs as code, a credential file, a
token, `gh auth token`, …) with the lines it is on, and where the version
compared with didn't hold one (all of an added file's), a line under them naming it new
in this version. A
quick read, not a parse: its strings, regular expressions and comments set
aside, its strings read for the paths, names and commands they hold, a
module (`vm`, `child_process`, libnpmpublish) told by the string naming it
where code loads it (`require(…)`, `import`, `from`), and a declaration file
(.d.ts) read as any TypeScript, as node runs it. A file naming a host
malicious packages send what they take to, fetch what they run from or
look the machine up with is labelled so, in its head and in the tree, as
what it runs is, under one of three tags, each in its level's color:
Exfiltration, red, where nothing but catching what is sent has a use for it
in a package's code (request catchers: webhook.site, Pipedream's
`pipedream.net` endpoints, RequestBin, Request Catcher, requestrepo,
Beeceptor; out-of-band testing hosts: interactsh's `interact.sh` and
`oast.*`, Burp Collaborator's, Canarytokens, DNSLog's `dnslog.cn`, CEYE's
`ceye.io`); Remote, orange, where it could be fine (Telegram's bot API,
Discord and Slack webhooks, Pastebin, paste.ee, transfer.sh and file.io in
a URL, 0x0.st, tunnels: ngrok, localtunnel's `loca.lt`, Cloudflare's
`trycloudflare.com`, Serveo; Pipedream's own API at `pipedream.com`, and
Bun's install script, `bun.sh/install`, now `bun.com/install`, which a worm
ran its payload with); and IP lookup, yellow, where it usually is (ipinfo,
ipify, ifconfig.me, icanhazip, ip-api, ipapi, `checkip.amazonaws.com`).
Each lists its services with their lines, one the version compared with
didn't name saying so, and a tag naming one a level higher, never past red.
Any text but prose and a source map is read for them, comments and all.
Between two stasis bundles, what each records of a file beside its bytes is
compared too: the format it loads it in (a resource carried as data, or
`module`, `commonjs` and the rest, run as code, as is a file it records no
format for, shown as `none`), its execute bit, and its
being an entry point of the bundle. A file whose record changed is changed,
its bytes the same or not, and says how in its row of the Overview's Files,
its head and its tree row (`resource → module`, `+x`, `new entry`; what it
no longer is struck through), a file whose contents read the same saying it
in words. Code shows as a labelled box, never as the blank or nothing it
draws as, each character that reads as something it is not: the controls
and format characters (bidirectional and zero-width among them), Unicode's
other spaces (no-break, en and em, thin, ideographic), the default-ignorable
characters (Hangul fillers, variation selectors, the grapheme joiner, each a
different name in code from the one it looks like) and the Braille blank;
an emoji's own joiners, presentation selectors and keycaps, and a
subdivision flag's tags where Unicode recommends it (England's, Scotland's,
Wales's), excepted.
Lines always wrap. Code can hide whitespace changes as
`diff -b` does: a line re-indented, or with blanks added to a run of them or
at its end, reads as unchanged, while blanks put between other characters or
taken from between them still show, as in `/tmp` to `/ tmp` inside a string
or `return x` to `returnx`, which `diff -w` would hide. It hides them only in
code whose whitespace means nothing but in its strings: JavaScript and
TypeScript, JSON, CSS, SCSS and Less, HTML, XML and SVG, C and C++, Java,
Kotlin, Go, Rust, C#, Swift, PHP and shell. A stasis bundle's file is told
by the format the bundle records for it (`module`, `commonjs`, `json`,
`shell`, `cmake`, …), where it records one, whatever its name; any other by
extension, or by a script's `#!` line, one of a short list known to run Node,
Deno, Bun or a shell (`#!/usr/bin/env node`, `#!/bin/sh`, …), matched whole
with nothing parsed out of it. A format of another language, or one not
known, reads as not listed. Any other file may hold
its meaning in its whitespace (Python's, YAML's or Markdown's indentation, a
Makefile's tabs, TSV's fields, a language not listed), and shows all of it,
the toggle not offered for it. Nor are they hidden in a file where that would
hide blanks of more than one kind changing between the same two characters,
such as spaces turned to tabs or a run of tabs and spaces made longer. Such a
file says why in a note while whitespace changes are to be hidden. The toggle is offered only where
hiding whitespace changes hides one, in the diff shown or in diff -b's: in
the file shown, or in any file the Diff view lists.

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

`GET /api/admin/repositories/risk` (admin only) scans every active repository's
npm lockfiles at its default branch's head, or a team's (`?team=<id>`) or one
(`?repo=<id>`), and assesses each package they lock as `GET /api/npm/risk`
assesses a version without `otherVersion`, against the version risk picks. A team's repository is read for the lockfiles in
the team's directories of it and those above them, as a workspace's root
lockfile locks them too. It answers Brotli-encoded ndjson as it goes
(`repository-risk.ts` names each line): the repositories, then each
repository's lockfiles (`findRepoLockfiles`), each npm, pnpm or Yarn 1
lockfile's packages (`@preventive/lockfile`), and each package's risk, with
`done` last; a response without `done` was cut short. A lockfile the reader
refuses is told so (`lockfile-unreadable`), but for a test's fixture or
example: one under a directory of tests (`test`, `tests`, `__tests__` and
such) and in one of fixtures or examples inside it (`fixture(s)`,
`example(s)`), which a test may keep unreadable on purpose, is read like the
rest but left out where it is refused. On a serverless
deployment (Vercel, whose function answers within 300 seconds), a scan stops
after 270 seconds, the work under way given up on and not waited for, its
last line `continue`
in place of `done`: the page asks again at once, keeping what it found (but
a repository's lockfiles', where its default branch moved on between parts,
or a team's directories in it changed, a repository's no longer listed or
renamed, and
a lockfile's advisories audited again otherwise), and
the next part tells what the last assessed as kept, going on from where it
stopped, a hundred parts at most, or until three parts in a row find nothing
more. The repositories a part told whole are kept for the next
(`repository-risk/progress` rows, by the admin, the id the page gives the scan
and its scope, for a day, written as a part ends and waited on five seconds
at most): it tells none of them again, nor asks GitHub of them, as the page
has them already, but looks up their packages' risks as their lockfiles are
kept, so a scan of more repositories than a part reaches goes on past them.
One renamed since, or whose team's directories changed, is read again; one
whose default branch moved on is told as the scan read it. Repositories are read six
at a time (`repository-risk-read.ts`), each told in turn, as each asks GitHub
one thing after another (opening it and its default branch's head) even where
its listing and lockfiles are kept, with the admin's own GitHub access,
through the same gate as browsing them, which is checked again as a
repository's turn to be told comes, however long ago it was read, and before
any of it is told. A repository GitHub isn't reached for (`github-unreachable`)
tells, as its line's `detail` and its row's tooltip, while doing what (opening
it, listing its lockfiles or checking access to it again) and what failed, as
the error and its causes tell it (a timeout, a connection closed, an answer too
large), after how long; never GitHub's text. A package from npm's registry is assessed once a scan; one
from another host with an integrity, such as a company's mirror, as npm's
package of its name and version only where the lockfile's integrity is npm's;
one from git, a tarball with no integrity or a file is listed but not assessed.
A package only devDependencies need, wherever a lockfile installs it, as npm's
and pnpm's lockfiles say (`@preventive/lockfile`'s `dev`; Yarn 1's say nothing
of it, which only the package.json files do), is `dev: true` in its
lockfile's line; one every lockfile of the scan locks so is assessed only once
all the rest are, the stale ones among them, as an install of no
devDependencies leaves it out, and the page tags it `dev`, listing packages
by their risk alone, whatever needs them, so that a riskier one only
devDependencies need is above a less risky one production takes; toggled
beside the filter, it shows all packages, or those an install for
production takes, or those only devDependencies need, malware either way,
as it runs wherever it is installed, CI and a developer's machine among
them. A mirror's copy that risk finds
differs from npm's (`integrity-mismatch`) is flagged critical and listed
first but for malware, not among those that couldn't be assessed, and, as
malware, shown and listed so whatever needs it. Each
lockfile a package or an advisory is used in links to it on GitHub, at the
commit read. Its Advisories tab shows those of the
versions an install for production takes (some lockfile needs them as more
than devDependencies do, or doesn't say, as Yarn 1's doesn't), or, toggled
beside the search, those of the versions only devDependencies need, each
with the versions of its kind, tagged `dev` in the latter, and each toggle
saying how many; an advisory of malware is shown either way, first, with
all its versions, as is the package it names among the riskiest.
The page's progress shows the scan's state (scanning, and which part, done
or stopped), then a metric each: repositories and lockfiles read and
packages assessed, each of how many with a bar, and packages flagged, stale
and advisories, those of malware said apart. Packages' metrics say those an
install for production takes and those only devDependencies need apart
(`prod` and `dev`), as each lockfile tells it so far: a later lockfile that
needs one otherwise moves it among the rest.
Each lockfile's packages of npm's registry or a mirror are asked of npm's
registry's advisories at once, as `npm audit` asks (upstream's `advisories`,
kept by the lockfile's blob for an hour, in the instance's memory and the
database, `repository-risk/advisories` rows, and one that failed, as by timing
out, ten minutes, for a scan's next parts not to wait on it again), and told in an `advisories` line,
each advisory with whether it is of malware, as risk tells it
(`npmMalwareAdvisory`): OSV's of a malicious package (`MAL-…`), or one such a
record names, GitHub's CWE-506, embedded malicious code, or a title
naming malware. The page lists them on a tab of
their own, and a package an advisory of malware names is critical in its risk,
from npm's registry or a mirror, but where its integrity is found to differ
from npm's: npm deletes a version it finds malware in, so a mirror's copy of
one can't be held to npm's integrity, and is told as npm's. Other advisories
are vulnerabilities, not a supply chain's risk, and stay on their tab. npm's
registry hasn't every one of GitHub's malware advisories (those of nx's
malicious versions, for one), nor any of the malicious packages' records OSV
holds: the viewer's assessments, and a scan's lockfiles, add OSV's
(upstream's `osv`, risk's `npmVersionAdvisories`), a public package's alone,
a private one's name never sent to OSV, as it never is to Socket
(bundle-advisories.ts: a scoped package is asked of OSV only where npm
answers it anonymously, `isPublicNpmPackage`). A version npm has
no document of is asked of risk as one npm removed (`npmRiskRemoved`): its
package taken down by npm is risk's `malware`, critical, whatever version is
locked, as is an advisory of malware naming it, npm's or, where anyone can
read its package, OSV's (nx's malicious versions have OSV's alone), and the
page says so in its tooltip; one nothing tells of is told as not on npm. Assessments are `spare` ones (`npm-risk.ts`): two at most across
the server, leaving the rest to readers, and without asking npm of each
dependency's package, nor of the version's advisories, which a lockfile's are
asked at once. A package's downloads, which risk asks of npm's downloads API
for its popularity and score, and which that API answers some 40 lookups a
minute of before answering 429 for a while, are readied before it is assessed
(`scan-downloads.ts`), so that no assessment waits on that API: at once, each
lockfile's as it is read, those kept already and unscoped ones, asked 128 at a
time in one lookup (risk's `npmReadyDownloads`); and scoped ones, which the
API answers only one by one, one at a time at the pace it allows, while the
assessors go on with the others. Public packages' downloads are kept in the
database (`npm-risk.ts`), for a week, as risk tells them that long (the tier
they put a package in, the most of its latest six weeks', hardly moves in
one), so that another instance, or a scan again that week, asks the API for
none of them again; a scoped one a
scan readies on its own only where the API counts some, as it counts public
packages alone, so that a private one's none is never kept with them. One refused as busy (`npm-busy`), or that npm asked to ask later
(risk's `upstream-busy`), is asked again after a wait, so a
large scan goes at the pace npm allows. A package's risk line carries its
findings and risk's `score` of it, out of 100 (risk/npm/score.js); the page
shows the score in its Risk column, red from 75, orange from 50, yellow from
25, else plain, as the viewer's ring is, malware's 100 where npm's advisories
tell of it too, and lists the riskiest first. A package's risk that still fails tells
its code, and, where risk failed, risk's `detail` of what it asked of npm and
how that failed. A package's risk line is kept (`repository-risk/lines` rows of
`managed_upstream_cache`, and the instance's memory) for good: each
lockfile's packages are looked up as it is read, and those kept told at once,
however old, one kept within the hour as it is and an older one, or one kept
before risk told a score, as stale (`stale: { assessedAt }`), dimmed on the
page and said so; those with none kept are assessed first, and the stale ones
only after, each line told again once assessed, or, where that fails, the
stale one kept, its tooltip saying why. Scans keep a repository's lockfiles
as listed at a commit and a lockfile's packages by its blob, in the
instance's memory and for a day in the database (`repository-risk/listings`
and `repository-risk/lockfiles` rows, as the lockfiles' packages, private
repositories' among them, are kept in memory, told only once the reader's
access is checked), so a scan again, or its next part on another instance,
asks GitHub only for each repository's head and access.
The database keeps public versions'
documents for a day, of only the fields `readNpmVersion` reads of them
(`npm-kept.ts`, `managed_upstream_cache`), so that a scan after a restart, or
on another instance, asks npm for none of them again: where npm removed a
version since, as it removes malware, risk finds it missing from the package's
whole document and the scan tells it as one npm removed. Rows kept longer
than they count are removed as new ones are written, at most once an hour. What risk keeps of each package
(`npm-risk.ts`) is beneath that. Closing the response, or leaving it idle for
five minutes, stops the scan. The page is `/manage/repositories/risk`, opened
from the Repositories page's Risk button, beside Aliases.

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

`GET /api/bundles/:id/pretty?path=&hash=` returns one of its files
pretty-printed, as Brotli-encoded `text/plain`, for the pretty-print toggle
beside the wrap toggle of the Code tab, the source popup and the Search tab's
source; the npm viewer's `GET /api/npm/pretty` formats a package version's
files as these are, all at once. The file is named by its path and the hash the
metadata gives it (`sha512-<base64>` of its UTF-8 text); only JavaScript,
TypeScript, JSX, CSS and JSON files of at most 4 MiB are formatted, with
[oxfmt](https://oxc.rs/docs/guide/usage/formatter), changing no more than
layout needs. The first request reads the bundle, checks the file's hash (409
`hash-mismatch` where it differs) and formats it, off the event loop and two
files at a time per process, up to sixteen more waiting their turn (429
`pretty-busy` past those); the viewer asks for two at a time. A file that does
not parse is 422 `unformattable`; one whose output, checked apart from the
formatter by @preventive/compare's `format` (a script's syntax tree as oxc
parses it, a style sheet's as css-tree does, JSON's strings and comments as
written), differs from it in more than layout is 422 `pretty-mismatch` and is
logged, and one of a kind it has no check for 422 `unsupported`. The Brotli bytes are kept in
the bundle's cache directory by content hash, encrypted with its data key
where storage is, and removed with the bundle; later requests stream them as
they are. Access is checked before and again after formatting, and the
endpoint supports HEAD. Each copy names the file it was formatted from, by
that hash, in `x-source-hash`, and the viewer takes only a copy naming the
file it asked about.

`GET /api/bundles/:id/pretty?other=` pretty-prints, for Compare, the files that
changed between the bundle and the `other` one, both sides': each side's
formattable files the other side has another text at the path of, or, where
it has none there, none of their text at a path of its own (a file renamed,
or moved with its tree, unchanged, has it there; a copy at a path both have
is not one), each formatted, checked and kept as one file's is. Those are
both files of the pairs Compare diffs but where it pairs files otherwise
(among copies of one text, across packages), whose copies it asks for alone,
by `path` and `hash`, once this ends. They are sent
as Brotli-encoded `application/x-ndjson`, a line a file, `{ side, path, source,
text }` or `{ side, path, source, error, status }`, `side` `base` (the bundle
asked about) or `other`, `source` its file's hash: those kept come first, at
once, then the rest as each is formatted, one after another, the minified
before the others, in path order otherwise. Both bundles are read before
anything is answered, for a reader of both (401 or 404 as for one bundle, 400
`bad-bundle` for an `other` that isn't a bundle ID), whose access is checked
again before each line. A public link reads its own bundles' alone.

`GET /api/bundles/:id/rename-diff?path=&hash=&other=&otherPath=&otherHash=`
diffs one of its JavaScript files (`.js`, `.mjs`, `.cjs`) with one of the
`other` bundle's, for Compare's **Hide renamed names**, in steps each checked
apart, by @preventive/compare's `renamedDiffs` (`rename-diff-worker.js`). Both
files are pretty-printed as `pretty` has them (and kept as it keeps them).
The old copy is then given the new copy's names: both are parsed
(oxc-parser) and each name resolved, by JavaScript's scopes, to the variable
it stands for; the lines that match with short names set aside tell which
variable became which (in a change of unlike lengths, those of its lines
alike but for a final `;` or `,` too, as a declaration others now follow,
`let t = …;` → `let t = …,`, weighed as a changed line's), and each old
variable takes the name of the new one
it most stands for, where that one most stands for it, on every line,
removed ones too. An old variable no new one stands for whose name the new
copy uses is renamed apart (`r_old`), so that no line reads it as the new one.
The names given must leave every name read resolving to the same variable,
and a global's to none, with no `var` named as a declaration of a block it
passes through, nor a function body's variable as a parameter. The renamed
copy must then bind as the old one did by oxc's minifier (oxc-minify), whose
scope analysis is apart from this one: both copies are mangled, every
variable named by its place alone, and must read the same, so that a mistake
in the first analysis costs a file its names, never its sense. Checks that
should never fail stand between the steps, and any that does, or anything
else that goes wrong, leaves the old copy as it was (`unverified`, logged):
each analysis hangs together (every name it would rename written as that
name where it is), the pairing takes each new variable once, every name
given is one a variable may have and either its counterpart's or one apart,
the renamed copy read again binds as the old one with the names given and
has no error oxc's semantic check finds. No file reviewed is ever given to
Node's `vm` or otherwise compiled or run: only parsed, by oxc. The renamed
copy is then formatted again, checked to change only its layout and
again by oxc's minifier as the old copy, else used as it was. The two copies
are then diffed twice, as they are and as diff -b reads them, from the names
found once, and each diff's change
blocks checked to take the old copy's lines to the new one's, every line
between them alike (but for how much whitespace it has, under diff -b) and,
but for diff -b, the last line in a block where a
newline was added or dropped after it, by the worker and again by the server, which otherwise
answers none (422 `undiffable`). It answers Brotli-encoded `{ before,
blocks, reason, reads, marks, ignoringWhitespace }`: the old copy as diffed, each change block
`{ a0, a1, b0, b1 }` (its lines `[a0, a1)` replaced by the new copy's `[b0,
b1)`), and, where its names could not be given safely, why (`unparsed`,
`dynamic` for `eval` or `with`, `jsx`, `block-function` for a function
declared in a block outside strict code, where it sets its function's
variable of that name too, `unverified`), the old copy then as it was;
`reads`, the properties either copy reads through which a program may read
a name (`name`, `toString`, `stack`, `callee`, `caller`, as a member's or a
pattern's key, `.name` or `const { name } = f`, or any string written out as
one, as `Reflect.get(f, "name")` reads it), so that a rename may change what it
does; and `marks`, the change blocks of the diff of the two copies as
pretty-printed whose old lines, given the new names, are their new lines,
no newline added or dropped after the last (none where names were not
given), each checked by the server to be such a diff's blocks, in order and
as many lines on either side; `ignoringWhitespace`, the `blocks` and `marks`
of the diff -b diff, checked alike, so that the viewer's **Hide whitespace
changes** asks for nothing again; the two files' hashes, `hash` and
`otherHash`, which the viewer checks are those it asked about; and those of
the two pretty-printed copies the diff was worked out from, `prettyHash` and
`otherPrettyHash`, which it checks are those of the copies it draws. Each diff runs in a worker thread, off the event
loop, two at a time per process, up to sixteen more waiting their turn (429
`diff-busy` past that, as Code's one list asks for every file it shows at once),
for at most a minute, its wait included (504 `diff-timeout`); a file that does
not format is refused as by `pretty`. The last few dozen answers are kept
in memory by both files' hashes, each side read through the pretty-print
cache first. The reader needs access to both bundles, checked before and
again after the diff; a public link answers for two of its own bundles.

`GET /api/bundles/:id/rename-diff?other=`, without a file, diffs every pair
of JavaScript files minified on both sides that changed between the two
bundles in one request, as Compare's Diff view and tree want them all:
paired as the viewer pairs them (`computeBundleDiff`, at one path or renamed,
within a package as the bundles record their packages, `bundlePkgOf`), in path order, one after another (leaving a
worker to the files a viewer asks for alone), each from both sides' copies,
kept or made as `pretty` keeps and makes them. It answers Brotli-encoded
ndjson as each is worked out, a line each, the answer for that pair asked
about alone with both files' paths, `path` and `otherPath`, or `{ path, hash,
otherPath, otherHash, error, status }` where it has none (a file that does
not format, the server busy). With `&scope=reason:<tree>`, as a Compare
narrowed to a tree of Stasis bundles asks, each side's files are those of the
tree alone (`bundleCompareFiles`), paired as that Compare pairs them. Access is
checked as for `pretty?other=`, again before each line; a pair the viewer pairs
otherwise, or one the server was too busy for, it asks for alone.

`GET /api/bundles/:id/comparison?other=` compares the bundle with the `other`
one for Compare's Overview and Code: the files each side has alone, and those
that changed, at one path or renamed, paired as `compareTrees` pairs them
within a package (`common/bundle-comparison.js prepareComparison`), with
their sizes, lines and recorded changes, the packages, dependency versions and
import resolutions that differ, and the totals (`comparison.ts`). The viewer of
a managed bundle pairs nothing itself: only bundles it opened from disk, which
no server holds, it pairs, in a chunk loaded for those alone. With `&scope=reason:<tree>`, each side's files are those of the tree
alone. Answered as Brotli-encoded JSON once worked out, the bundles read one at
a time as the pretty-printed copies read them; `files.root` is the directory
one side's files sit under in the other's, where they differ, and
`files.basePaths` then each base file's path as the other lays it out, as
`[path, laid out]` pairs, else none. Access is checked as for `pretty?other=`,
and again before it is sent; a public link answers for two of its own bundles.

`GET /api/bundles/:id/type-only?other=` tells which TypeScript files that
changed between the two bundles changed in types alone, for Compare's **Hide
type-only changes**: every changed, added and removed file, paired as the
viewer pairs them, whose change @preventive/compare's `compareTrees` stamps
`typeOnly` -- each side there a file named as a declaration file (`.d.ts`,
`.d.mts`, `.d.cts`, `.d.css.ts`) that its `proveTypeOnly` proves holds types
alone but for a runtime, the module loads, bare `export {}`, directives and
pragmas its stripping leaves, which the change leaves as it was (a rename
across module formats aside, where that runtime loads a module or keeps an
`export {}`): an added file's empty or a single bare `export {}`, which nothing
loaded before, a removed one's empty -- and nothing else decides it. Proving
needs Node's type stripping, so the viewer can't. Each pair is asked of the
engine on its own, as a tree of a file a side; two paths it takes for no
rename are types only where each of their changes is: the file gone erasing
whole, and the one come erasing whole or leaving a single bare `export {}`.
Proven in a worker thread, off the event loop, a comparison at a time per
process, up to sixteen more waiting (the response cut short past that, or past
a minute), and answered as Brotli-encoded ndjson once all are proven, a line
each, `{ path, hash, otherPath, otherHash }`, a side not there null, which the
viewer checks name the files it shows; within a tree with `&scope=`, as the
stream above. Access is checked as for `pretty?other=`; a public link answers
for two of its own bundles.

`GET /api/bundles/:id/advisories` uses `@preventive/upstream` to audit the
stored bundle's dependency ecosystems, names and versions. npm uses the registry,
and OSV for the packages anyone may read (upstream's `osv`), for the malicious
packages' records the registry hasn't: a scoped package where npm answers it
anonymously (a HEAD, `isPublicNpmPackage`), so that a private one's name never
leaves for OSV. Cargo and Composer use OSV, and Soldeer and GitHub dependencies use published
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
single row, and an expired listing stays, for the npm Overview's advisories to
take where GitHub can't be reached (`GET /api/npm/advisories`). The listings of repositories an audit already knows (GitHub
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


# Repository code viewer

Admins and managers read a connected repository's files in the bundle view,
as an npm version shows, with the Treemap, Code, Search, Compare and Activity tabs:
from the
`</>` on its row on the Repositories page, at `/manage/code/<repo id>`, which
opens its default branch's head, its route then naming the commit it opened
(see Page routes), so a link or a reload opens the same files, whatever the
branch has moved to since. Its header picks the repository, among those the
reader may browse, and the revision, a branch, a tag or a commit, as Create a
bundle picks one (`ui/view/revision-select.js`, shared by both): another
repository opens at its default branch, another revision opens the same
directory there, on the same tab, a typed one on Enter, and Back names a
revision as it was opened, else by its commit. Between them, a directory's
path in the repository, each part opening its own directory, and after them
the commit, linking its tree on GitHub; each file's head links it on GitHub at
the commit, and admins have a breadcrumb back to the Repositories page. A
directory too large to read whole, or one the reader's grants reach only part
of, says so, and lists its directories to open instead (as browsing lists
them, `GET /api/admin/repositories/contents`).

`GET /api/admin/repositories/code?repoId=…&ref=…&path=…` answers the
directory's files, Brotli-encoded, as `{ repoId, repo, commit, path, tree,
files }`, the files as `GET /api/npm/package` answers a version's (by their
paths in the directory, text inline, a digest for those not UTF-8), for the
viewer to hold in memory only while it shows them. It is read as browsing is,
with the same two gates and the reader's own GitHub access, and only where
the reader's grants reach the whole directory: an ancestor of a manager's
grants is `no-directory`, as is a directory the commit has none at. GitHub's listing of the directory's tree, every tree
under it with it, says first whether it holds at most 20,000 files and
64 MiB, as a package may (`repository-code.ts`), else `413
directory-too-large`, before its tarball is asked for: the tree's, verified
against the tree's id as bundle builds verify theirs, and kept in upstream's
disk cache with them. Readers asking for the same directory meanwhile share
one load, among the npm viewer's (`429 repository-busy` past them), and access
is checked again once it is read, before any of it is sent.

## Compare

The **Compare** tab compares the directory with itself at another revision,
as an npm version's compares it with another version
(`ui/view/repository-compare.js`): its Overview lists the files each adds,
removes and changes, each with its type's icon, and its Code reviews them as
a diff. It shows none of a package's risk, alerts or dependencies, nor a
bundle's Packages. Both sides pick a revision as the header does, a branch, a
tag or a commit, the one compared with first: picking the first compares
with it, picking the second opens the directory there, compared with the
same first, and **Swap** opens the first, compared with the second. The one
compared with is read as the directory is
(`GET /api/admin/repositories/code`), its route then naming the commit read,
`/compare/<commit>`, and `/code` past its Overview; for the session, its
picker names it as it was picked. Another tab of the directory keeps it, for
Compare to open with again.

## Activity

The **Activity** tab holds what happens around the code, in five views, each
its own route's tab (`commits`, `issues`, `pulls`, `agents`, `pulse`): its
**Commits** (below), **Issues** and **Pull requests**, **Agents**
and **Pulse**. It opens on the view last shown, Commits until one is
(`ui/view/repository-activity.js`). Each view's bar starts with their
picker, an icon each (a commit on its line, an issue's ring, a pull
request's branches, a robot's head, a pulse's beat), as the graph's layouts
are picked, which switches the view as a tab does, Back returning to the
one before.

## Commits

Activity's Commits view lists commits as `git log --oneline --decorate --graph` does,
one compact line each: its short id, the branches and tags naming it (the
default branch's first, the revision shown marked), its subject, author and
time, beside the graph of the lines its parents make
(`ui/view/history-graph.js`). Commits list newest first, never a parent before
a child of it; a merge's other parent takes a lane of its own, and lanes waiting
on one parent join where it comes; each line keeps a color of its own, unlike
its neighbors' where it can, the default branch's first lane and color its
own; a parent not listed is a short dotted line on. At the repository's root
it reads **All branches**, as `--all` adds them, else **This revision**'s, the
commit shown first. Either's **Older commits** reads on from where those
listed stop, their parents not listed (and, for All branches, the branches
not read yet), the newest 25 first (a parent by its child's time), a hundred
commits from each, each commit once; a branch not read joins those named
once a commit listed is its tip. A directory's reads a hundred at a time,
**Older commits** reading the next hundred. Older
commits read as their button nears the end of the scroll, a screen before it
shows, as though clicked, and again while it stays near; after a page that
failed, they wait for a click. The commit shown is marked, and, where every branch's latest commits don't reach
it, a link shows its own history. A directory lists the commits touching it, in a
line, as GitHub doesn't rewrite their parents to those listed. A line opens its
commit's code, named by the branch, else the tag, naming it. The view reads
none of the directory's files: its route at a commit opens it alone, its other
tabs then reading them. A directory whose files fail to open shows its Commits
all the same, where its commit is known (a `413 directory-too-large` names the
commit it was read at, its route then naming it). What it read is kept in
the page for the session five minutes, and on the server for every reader:

- A whole repository's history, from a revision or all branches, is read a
  page from a commit at a time: the first hundred commits of the history
  from that commit, kept (`managed_upstream_cache`, under
  `repository/history`, a month) by the commit it starts at, its top. A
  commit's history never changes, so a page kept is never read again, and a
  branch moving on doesn't miss: only the page from its new tip is read.
  Read with a token, a page tells each commit's lines added and removed and
  its author's own time too, which Pulse counts (and the tab is not sent).
- Pages glue on: where a commit listed, or a parent of one not listed, is
  the top of a page kept, that page joins those listed, and so on, till two
  thousand commits are listed. The pages from where it starts are listed
  whole all the same, All branches' 25 tips' as before, two thousand five
  hundred commits at most. A branch that moved on a few commits reads one page and
  shows all the history read of it before, the pages Older commits read
  among it.
- The branches and tags naming commits, which move, are kept as Issues'
  pages are: two minutes as read, then answered while they are read again.
- A directory's history, whose commits a page from a commit doesn't list
  alone, is read from GitHub each time.

`GET /api/admin/repositories/history?repoId=…&ref=…&path=…&page=…` answers a
page of a revision's history, `{ commit, path, page, commits, more }`, each
commit `{ sha, parents, subject, authorName, authorLogin, committedAt }`, as
GitHub's list of commits gives them (`repository-history.ts`), with, on the
first page, the `branches` and `tags` naming commits, `{ name, sha }` each:
with a token, every branch All branches reads (below, kept for both) and the
latest hundred tags; without, GitHub's first page of each, a hundred by
name, to spare an unsigned reader's rate limit. A whole repository's is the history
from its commit, glued on (above), `more` where a parent is not listed; a
later page names the commits to read on from, `from=<sha>,<sha>…`, as All
branches' do (a later page naming none reads GitHub's page of that
number). A directory's is GitHub's page of that number. With `all=true`, at the root and first
page, it answers `{ all, commits, branches, tags, defaultBranch, unread, more }`
from GraphQL: the branches' tips with their commits' times, a hundred a page
for up to fifty pages (GitHub orders heads by name alone), then, in one query,
the latest hundred commits of the default branch and the 24 others most
recently committed to, each commit once; every branch naming a commit listed;
the branches not read whose tips aren't listed, `{ name, sha, at }` each,
newest first; `cut` where branches past the five thousand listed are left out,
never to be read, the tab then saying so; and the latest hundred tags, an
annotated one by the commit it tags. `more` where a branch or a branch's commits are left out. A later page
names up to 25 commits to read on from, `from=<sha>,<sha>…`, and answers
`{ all, page, commits, more }`, the latest hundred commits of each, each
once, `more` but for the deepest page. GraphQL needs a token: a public repository read without one is `403
github-token-required`, and the tab then shows the revision's history. It is
read as the code is, with the reader's own GitHub access, only where the
reader's grants reach the whole directory, and access is checked again before
it is sent.

## Issues and pull requests

The **Issues** and **Pull requests** tabs show the repository's issues and
pull requests as a grid of compact tiles rather than a list, filling the
width, the most recently updated first. **Open** and **Closed** pick which,
each with how many there are; a pull request's closed include those merged.
A tile is its title, in up to two lines, then a line each, none wrapping:
its number, author and age; its labels, if it has any; and a pull request's
branch, the one it merges into, and its lines added and removed. Beside
them is a rail: its state, an icon and a stripe in GitHub's colors (open
green, merged and completed purple, closed red, draft and not planned
muted); under it, a pull request's review (approved, changes requested or
review required) while open and its checks (passed, failed or running),
each an icon, room held for both; then how many comments it has. Its
labels, each by a dot of its color, show whole while they fit, then the
last is shortened first, to its dot alone, then the one before it; each
tells its name on hover where it is shortened. As many show as the
narrowest tile has room for as dots, eight, else seven and how many more;
up to twenty are read, which the filter searches. A tile clicked opens its
popup over the tab, as a kanban card does (`dialogs/repository-item-dialog.js`):
what the tile shows at once, then, as it is read, its description, what a
pull request closes or what closed an issue, each opening in its place
(**Back** returning), a pull request's commits, files changed and who merged
it, and **Open on GitHub**. Held with a key, or with another button, a tile
opens on GitHub as a link does. A
**Filter** picks among those read by every word typed, in a tile's number,
title, author, labels or branch. Fifty are read at a time, the next as the
**More** button nears the end of the scroll, as Commits' Older commits are,
but not while a filter picks among them, nor after a page failed. Like
Commits, neither tab reads the directory's files: at a commit, each opens
alone. What they read is kept in the page for the session five minutes, and
on the server for every reader (below).

`GET /api/admin/repositories/issues?repoId=…&kind=issues|pulls&state=open|closed[&after=…]`
answers `{ kind, state, items, counts: { open, closed }, more, after }` from
GraphQL (`repository-issues.ts`): a page of fifty, `after` the cursor reading
the next where `more`. Each item is `{ number, title, author, createdAt,
updatedAt, closedAt, comments, labels: [{ name, color }], moreLabels, state }`,
an issue's with its `reason` (`completed`, `not-planned` or `duplicate`), a
pull request's with `draft`, `mergedAt`, `review`, `checks`, `additions`,
`deletions`, `head` and `base`, its `state` `merged` where it was. They are
the whole repository's, so they are read only where the reader's grants
reach all of it (`404 no-directory` otherwise), with the reader's own GitHub
access; GraphQL needs a token (`403 github-token-required` without one). A
nonpublic repository's are read with its GitHub App's installation, which
lists pull requests only with **Pull requests: read** (`502
github-status-403`, the tab saying so, where GitHub refuses them) and reads a
pull request's checks only with **Checks: read** and **Commit statuses:
read**, its tiles showing none where GitHub refuses those alone (see GitHub
App setup). Access is checked again before they are sent.

`GET /api/admin/repositories/item?repoId=…&number=…` answers one issue or
pull request, as its popup shows it, read and checked as a page is: its
tile's fields, `kind` (`issues` or `pulls`), its description's Markdown as
written (`body`, never GitHub's HTML of it, shown as finding descriptions
are), an issue's pull requests closing it (`closedBy`), a pull request's
issues it closes (`closes`), its `commits`, `files` changed and `mergedBy`;
`404 github-not-found` where the repository has none of that number. A
description past 20,000 characters is shortened (`bodyShortened`), and of
those it closes or that closed it, ten are named and the rest counted
(`moreLinked`), the popup saying so and that the rest are on GitHub.

What a page or item read is kept in the database (`managed_upstream_cache`,
under `repository/reads`, a day), for every reader, their access checked as
each asks: for two minutes it is answered as kept, unread again; then, while
kept, it is answered at once and read again behind the answer for the next
to ask, once at a time. Serverless, where nothing outlives an answer, a
read older than two minutes is read again before it is answered. One GitHub
refuses to read again (the GitHub App's permission for it withdrawn, the
repository or item gone) is no longer kept, the next to ask refused as
GitHub refused it. The
Agents tab's pages are kept so too.


## Agents

The **Agents** tab shows the sessions the repository's work was done in, of
Claude, of Codex, and of the agents the server knows by their GitHub Apps, reconstructed from what each leaves on GitHub
(`common/managed/agent-tasks.ts`), in the same compact tiles as Issues, the
most recently active first. A session holds its tasks: the pull requests it
opened, and the commits it pushed straight to the default branch, which no
pull request merged. It is told by the links and marks the agents leave:

- a Claude Code session, by `https://claude.ai/code/session_…`: in a pull
  request's body, its head or merge (or squash) commit's message (the
  `Claude-Session:` trailer), a commit's message, or a branch's tip commit;
- a Codex task, by `https://chatgpt.com/codex/tasks/task_…` in the same;
- without a session named, by its branch, `claude/…` or `codex/…`, one
  session a branch, its pull requests together; and by Claude's marks
  (`Co-Authored-By: Claude`, `Generated with [Claude Code]`, a commit Claude
  authored), a pull request or commit its own session;
- an agent known by its GitHub App (`APP_AGENTS` in `repository-agents.ts`,
  each its id, name, app, fingerprint and branches' prefix: now Neo, by
  `🤖 Generated with [Neo](` and `neo/…`), by its fingerprint in the same
  texts or its branch's prefix. It names no session, so a pull request of its
  is a session alone, with its branch (the newest of the pull requests from
  it), joining none by what it links. Claude's or Codex's marks on its work
  show their marks after its own, as its tools.

Everything naming one session is that session, whatever branch each is on; a
pull request joins its branch's, a fork's branch, named `owner:branch` as
GitHub names it, apart from the repository's of that name and another
fork's. Comments are never read: an agent links its session in its own
texts, and anyone may name one in a comment. An issue is shown with a
session whose pull request closes it, or whose branch the Claude GitHub App
named for it (`claude/issue-12-…`). A tile, as Issues' are, is its agent's
mark (Claude's burst, Codex's OpenAI mark), a rail beside a line each, none
wrapping: its title (its first task's, of two lines at most); its author,
age, how many tasks and lines it holds; its pull requests, commits and
issues in their states' colors, as many as fit and how many more; and its
branch. An app agent's mark is its app's avatar, which the server fetches
from GitHub once and keeps (`/api/avatar/app-<id>`, for those apps alone). A tile clicked opens its session's popup, as an issue's does: who,
when, its state, tasks and size, its pull requests and issues, each opening
in its place, its commits and branches, on GitHub, and links to where it ran
(a Claude Code session or a Codex task) and to GitHub. A pull request's or
issue's chip opens its own popup, a commit's opens on GitHub; held with a
key, the title opens where the session ran and a chip on GitHub. One with a branch alone says it has no pull
request, shown once no pull request left to read can be its (where some
are, only a branch newer than the oldest read). **All**, **Claude**,
**Codex** and each app agent pick whose, each with how many; a **Filter**
picks by any word of a title, author, branch, number or session. The bar's
end shows, beside the mark of each agent with sessions among those read
(app agents first, Claude's and Codex's last, so theirs keep their places),
by icon and count, the pull requests, branches and commits to the default
branch without a pull request (where there are any) among its sessions. Pages read on as the end of the scroll nears, as Commits'
do, the sessions made again of all read, but only while each adds a session:
most pull requests and commits may be no agent's, so after a page adding
none, the next waits for **More** to be clicked rather than read the whole
history on its own.

`GET /api/admin/repositories/agents?repoId=…[&pulls=…][&commits=…]` answers
`{ pulls, commits, issues, branches, more, after: { pulls, commits } }` from
GraphQL (`repository-agents.ts`): fifty pull requests, the most recently
updated first, and a hundred of the default branch's commits, the newest
first, each on from its own cursor; and, on the first page alone, naming
neither, the hundred most recently updated issues, the app agents (each its
id, name and app, never how it is told), and the five hundred newest of each
agent's branches: GitHub lists branches by name alone, so every branch
an agent's prefix names is read, as many as fifty pages of a hundred of each,
named in full whatever prefix GitHub splits off, and the newest kept by
their tips' times. Each pull request's body and head and merge commits'
messages, each commit's message, and each branch's tip commit (never a
comment, nor an issue's body) are read for the sessions and tasks
they link, Claude's marks and the app agents' fingerprints, a pull
request's and branch's name for their prefixes too (`signals`), and those
alone are answered,
never the texts; of the default branch's commits, only those no pull request
merged and an agent marked. They are read as Issues are: with the reader's
own GitHub access, only where their grants reach the whole repository, a
token needed, and access checked again before they are sent.

## Pulse

The **Pulse** tab shows how the repository moves over a **Week**, **Month**,
**Quarter** or **Year**: one, four, thirteen or fifty-two weeks to today, as
GitHub's statistics count weeks (Sunday first, UTC), the current week the
last of them. Its dates are named in the bar, beside **Charts** and
**Table**, which show its charts as tables of the same figures.

- **Figures**, a tile each: the default branch's commits, how many people
  made them, the pull requests merged (and opened) and the issues closed
  (and opened), and the lines added and removed. Commits, pull requests and
  issues are each set beside the same days of the week a period earlier
  ("↑ from 110 the month before"): this week's Sunday to Thursday beside
  last week's, not the days just before, whose days of the week differ. The
  year's commits are set beside none, only the last year's being counted.
- **Commits**, a column a week over the last year, the period's in blue, the
  rest gray, over a scale of round counts; under them **Lines**, added above
  a line in blue and removed below it in red, one scale for both, the weeks
  outside the period faded; the months named under both, the year where
  January starts.
- **Contributors**, those who made commits in the period, as many as eight,
  ranked by their commits in bars, each with the lines they added and
  removed, and how many more there were; each name opens their GitHub page
  (one whose commits name no GitHub account by the name they carry, unlinked).
- **When commits are made**, a cell an hour of each day of the week, Monday
  first, the more commits the deeper its blue, as the scale under it shows;
  in each author's own time zone, and not only the period's.
- **Merged** and **opened pull requests**, **closed** and **opened issues**,
  the ten latest of each, with how many there were and, where there were
  more, a link to all of them on GitHub; each opens its popup as an Issues
  tile does.

Each column, bar and cell names its figures on hover. A period read anew
shows the last one read, faded, till it is.

The year is counted from the default branch's commits themselves, as the
Commits tab reads and keeps them: each page of a hundred commits, kept by
the commit it starts at, tells each commit's lines added and removed and
when its author made it in their own time zone (GitHub's GraphQL API tells
both). So a year whose commits are kept is counted from them at once, and
once the branch moves, only the commits new since are read of GitHub. It is
read on from as far as thirty days before the year, a commit's clock not
always later than its parents'. A year not kept yet is read five queries an
answer: the tab shows what else
it read and how many of the year's commits are read so far, and asks again
a second apart as long as each answer reads more (after five that read
none, **Read on** is left to the reader). A year of more than 10,000
commits is counted by GitHub's statistics instead (`stats/commit_activity`,
`contributors`, `punch_card`, and `code_frequency` for lines), which GitHub
computes when first asked, and again once the branch moves, answering `202`
till they are: kept (commits and lines together, as one), they are
answered through that; never computed yet,
the tab says GitHub is still counting and asks again five seconds apart, a
dozen times, then leaves **Ask again** to the reader. GitHub counts no lines
of one of 10,000 commits or more there, and it shows none.

`GET /api/admin/repositories/pulse?repoId=…&weeks=1|4|13|52` answers
`{ weeks, since, previousSince, merged, opened, closed, created, stats,
reading, pending }` (`repository-pulse.ts`). `merged`, `opened`, `closed`
and `created` are each `{ count, previous, items }`: how many GitHub's
search finds in the period (`since`, its first day, to today) and in the
same days of the week a period earlier (`previousSince` on), and the ten
latest, from one GraphQL query of eight searches, searched by the day.
GitHub sorts no search by when a pull request was merged or an issue closed,
so the fifty most recently updated are read and the ten latest merged or
closed of them listed: all of them where the period holds fifty or fewer.
`stats` is the year: `weeks`, a row a week, its commits each day (UTC) and
in all and its lines added and removed; `contributors`, by login, else
name, as many as a hundred, the most commits that year first, each their
weeks of it with any; `punch`, commits by day of the week and hour; and
`lines`, false where GitHub counts none.
Merges are left out, as GitHub's statistics leave them. A year counted is
kept by the head it was counted from (`repository/reads`, a day), the head
as Issues' pages are (two minutes, then answered while read again); one not
read whole yet is null, `reading` how many of its commits are read; one
GitHub is still counting, null, `pending` true. A page of commits kept
without lines (as GitHub's REST API lists them, for a reader without a
token) is read again for the year, with them. They are read as Issues are:
with the reader's own GitHub access, only where their grants reach the
whole repository, a token needed, and access checked again before they are
sent.

# npm package viewer

Every role but `none` can open a published npm package version from the
landing page's **npm packages** card, or at `/npm/<name>[@<version>]`. The
`/npm` page lists the reader's last ten searches that opened, newest first,
under its search, each to open again or remove; they are kept in the
browser's `localStorage` per signed-in user, a convenience, not access
control. While a version opens, its header shows at once, on the tab its
link names, its version picker and tabs waiting for it, and its body says
what opens. A version shows in the bundle view with these tabs:

- **Overview**: its header names the package beside a picker of its
  versions, as wide as the version shown, listing them as Compare's pickers
  do (searchable, newest first, several to a row as wide as the longest
  needs, with their dist-tags; the arrow keys move along a row and between
  rows; switching keeps the tab shown, and until the versions arrive it holds
  the version shown, disabled), and links its page on npm.
  Over the summary, where any file can be hard to review by reading it, a
  warning says how many and why, in categories, a file counted under each
  that holds of it and once in the total, each category's chip finding every
  file it holds of: not
  UTF-8 (the server could not read it as UTF-8, or it holds a NUL), control
  characters (the C0 ones but tab, line feed and carriage return, DEL, the
  C1 ones, and the bidirectional controls U+202A–U+202E and U+2066–U+2069),
  invisible characters (of those Code shows as boxes, the ones text is
  hidden in: variation selectors, as a payload a byte a selector, but a variation
  sequence Unicode registers (an HTML entity's math symbol, a heading
  anchor's `#`), an emoji's selector doubled as copying text leaves it, or a
  block of them written out as a range in a table of the characters a name
  may hold; Hangul fillers, as a name no one sees, but those composing
  Hangul or among jamo; and tags, but those of a subdivision flag Unicode
  recommends (England's, Scotland's or Wales's); not a BOM, a zero-width or
  a no-break space, which text has its uses for; found in the same pass as
  control characters, and told apart from them by code point),
  long lines (lines over 1,000 characters: a warning among readable ones,
  as no one writes them, and a notice in minified code, whose they are),
  minified (most of its text on such lines, or named `.min.` with any, or,
  with none, its lines averaging over 110 characters and next to none of its
  spaces outside strings ones a minifier drops, beside punctuation), source
  maps (`.map`), and inline source maps (code with a line that is a
  `sourceMappingURL` comment holding its map as a `data:` URL, minified or
  not, its tag giving the map's size). Prose (Markdown, text and the markup
  GitHub renders a README from, licenses and changelogs, as `LICENSE-MIT`; not code named alike, as `lib/history.js` or
  `dist/notice.min.js`) is readable whatever its lines' lengths, and an inline map's
  line counts for none, nor for how much of a file is on long lines; nor are
  a source map's long lines counted, all it is. A file holding control or
  invisible characters or long lines is still whatever else it is, as a
  minified file with a form feed in a regular expression is all three, but
  readable ASCII or UTF-8. Then the manifest's facts: description, license
  (each license in its expression opening its file in the package: the one
  named after it, as `LICENSE-APACHE` for `Apache-2.0`, else its only license
  file), author (with their npm account, linking its profile, where the
  publisher's or a maintainer's email or name is theirs), the publisher's
  account where it is someone else's (each account green where it is known
  to publish one of npm's most downloaded packages, as
  `@preventive/publishers` lists them, else yellow), or, published by a CI npm
  trusts (`GitHub Actions`), that CI in grey unless its provenance, once
  read, names what built it,
  when the version was published and
  how long ago (in the warning color under two weeks old, as a compromised
  release is mostly found and pulled within days; a version of a scope any
  visible team lists is its team's own and isn't flagged, nor is any until
  the version list says whether it is one),
  GitHub repository with its stars, forks, open issues and open pull requests
  (GitHub counts them together; the pull requests are counted apart from its
  list of them, and where that fails they show together), publish commit with
  the tags that point to it, provenance for a public package (npm's SLSA
  statement, v1 or the v0.2 it first wrote: what built it, as GitHub Actions or
  GitLab CI on its own runners or the publisher's, green on its own, as the
  certificate that signed it says (or, where it doesn't, GitHub's builder
  id); from which repository at which commit, flagged
  (and not green) where that isn't the repository the package names, on
  GitHub or GitLab; and, beside it where that fits whole, else on the next
  line, how: its workflow, at that commit, its run and its Sigstore
  transparency log entry; None where npm keeps none, and flagged where npm lists
  provenance but no statement naming the tarball can be read, never shown
  as attested while it's asked for or where asking fails), homepage (left out where it only leads to its
  GitHub repository, or its directory or readme there, as npm's default
  does) and integrity; beside them entry points,
  each with its file's icon and opening its file, Main and Module in one row
  where they name the same file, engines, install scripts (preinstall,
  install and postinstall, each with its
  name marked as a warning's and its command, a file it names opening it, in the order npm runs them, and
  `node-gyp rebuild` where a `binding.gyp` has no install script of its own),
  how many dependencies it has, with a chip for each check below any of them
  is flagged by, counting them, which in its tooltip, and its files with the lines of code they add
  up to, its tarball's size and what it unpacks to, each but the tarball's
  size tinted by how big it is: tiny, small, medium, large or gigantic, files,
  lines and bytes counted without the files every package has (package.json,
  readme and licenses), in steps of eight times that agree for a file of about
  130 lines and 5 KiB; and a card of its downloads: the latest
  week's (or month's) and the last year's, each with its unit (`1.2K/week`,
  `9.6K/year`), and its tier among npm's packages by downloads (top 10, 20,
  50, 100, 200, 500, 1,000, 2,000, 5,000, 10,000, 20,000, 50,000 or 100,000,
  else unpopular), solid
  green to the top 200, then tinted green to the top 5,000, yellow to the top
  20,000, orange to the top 100,000 and red for the unpopular, by the most it had in
  any of its latest six weeks, so a week lower for days npm failed to count
  (zeros it may never correct) or for a holiday doesn't move it, and yellow
  at most past the top 20,000 where the version's risk finds it known (a
  known account published it, or, published with provenance, it is in a
  known scope, a known account's own among them), its tooltip saying why, as
  Compare's popularity chip is;
  the tiers'
  weekly bounds, rounded estimates to be revisited, are download-counts'
  snapshot of a month (Jan 30 – Feb 28, 2026), each rank's count grown by the
  median growth of the packages ranked around it to the 30 days Sep 9 –
  Oct 8, 2026, as npm counts them, then made a week, over a chart of them across the year by week, or by calendar
  month (the last twelve complete ones), with the switch between the two at its top
  right and under it the hovered period's downloads; and under it the
  version's pages on npmjs.com and, for a public package, Socket, beside the
  tarball download; under those, its risk score first, out of 100, as risk
  tells it (`score`, risk/npm/score.js): a ring filled to it, red from 75,
  orange from 50, yellow from 25, else plain, its tooltip the findings that
  raised it, each with its severity, and how much the version's time out
  among its package's downloads lowered that; then what calls for a look at the version on
  its own, as Compare's chips do but for those only a change from one
  version to another tells (a publisher, provenance lost, files and hosts
  new): its deprecation, its install scripts (named, their commands in the
  tooltip), dependencies from elsewhere than npm's registry or imported by
  nothing of it, in orange what any of its files runs beyond itself (the
  kinds alone, `eval, child_process`, `Runs code` heading its tooltip) and
  the credentials any reaches for (`Credentials`, each file's by their
  names in its tooltip: `NPM_TOKEN or GITHUB_TOKEN (line 7)`), the
  hosts its files name, a chip for each tag
  (Exfiltration in red, Remote in orange, IP lookup in yellow, the services
  named), and an obfuscator's fingerprint, each listing its files and their
  lines in its tooltip, its age under two weeks, the advisories affecting
  it, tinted by the worst, Socket's scores under their bars (yellow from 50,
  red under it), and its tier by
  downloads where it is orange or red, tinted as its tag beside its downloads
  is. Over the facts, where npm's security team took the
  package down (npm's "security holding package" placeholder, told by its
  description or its npm/security-holder repository with npm as its
  publisher, or with a `-security` version as npm's staff publish it), a
  banner saying so; and the alerts Socket raises on the version, such as
  malware, each with its severity, the file it names (opening it) and
  Socket's note, left out on npm's placeholder, which holds nothing but the
  files every package has. A file an alert names is labelled with it, in
  its severity's color, in the Files list and in Compare's file heads and
  tree, each version by its own report; and a script with what its code can
  do beyond itself (`eval`, `child_process`, `credentials`, `whole env`,
  `publish`, `shell`, `persistence`), and a file with Exfiltration, Remote or IP lookup where it
  names such a host, each in its color, as Compare labels them, its lines in the
  tooltip, one on a single line opening the file's code there when clicked. Under the facts, its languages, then its readable files
  as UTF-8 or ASCII and its file types, side by side where they fit: Package, for the files every package
  has at its root (`package.json`, a readme, and license files such as
  `LICENSE`, `LICENSE-MIT` or `LICENCE.md`), then each extension with its
  count, one only those files have left out, one other files have too
  counting them as well, each with its files' size and, where they are text,
  their lines of code in its tooltip; then Socket's scores for a public
  package (supply chain, vulnerability, quality, maintenance and license, out
  of 100, as Socket's page shows them; its overall score is only the lowest), each a small chip as wide as its text after a ring
  gauge filled to it, tinted for 80 and over (85 for supply chain and
  vulnerability), 50 and over, and under 50, that one in red, a full score's
  number green. Each category's chip, and each file type's, narrows
  the Files list to its files, one at a time; the Files head names it, with a
  way back to every file. Then its columns: Dependencies, where
  it has any (peer and optional ones included), which open in the viewer at
  their latest version (an `npm:` alias at the package it names) where npm
  installs them from its registry (not a path, `file:` or `./x`, a
  repository, a URL, nor what npm doesn't install, `workspace:`, as the
  registry's package of that name isn't what npm installs), their kinds
  and ranges lined up, each tagged after its name where it calls for a look:
  non-registry where npm fetches it from elsewhere than its registry, as
  npm-package-arg resolves a dependency's spec, hosted-git-info reading a
  repository's host for it: a repository on GitHub, GitLab, Bitbucket, Gist
  or SourceHut in any form npm takes (`github:owner/repo`, GitHub's
  `owner/repo` shorthand, `git@github.com:owner/repo`,
  `ssh://`, `git+https://` or `https://github.com/owner/repo`), named for
  it, another `git:`, `git+https:` or `git+ssh:` repository, or an `http:`
  or `https:` tarball; not a `file:` path, nor what npm doesn't install
  (`workspace:`, `ssh:` to another host) or reads as a path
  (`git@example.com:org/repo`), its
  spec in its tooltip; and unimported where nothing of the
  version imports it: no code file names it as an import would (quoted,
  alone or before a path in it, `'name'` or `"name/sub"`, after webpack's
  `~` too, or built from a part of its name up to a `-` or `/`, as a
  package picks its platform's build, `` `@rollup/rollup-${platform}` ``
  or `"@typescript/" + name`; prose but MDX, which imports, source maps, lockfiles and its own
  package.json aside), nor does an install script npm runs, though npm
  installs it all the same and runs its install scripts, as a dependency
  added for those alone would be; not a peer one, which whoever installs the
  package provides, nor one of DefinitelyTyped's `@types/`, nor the
  package a stub of DefinitelyTyped's types of it depends on once it has
  types of its own (`@types/mkdirp` 2.0.0 on mkdirp): nothing but prose
  beside its package.json, no code to import it, depending on the
  registry's package by that name (not an `npm:` alias of another, a
  repository, a URL or a path);
  Advisories, across every published version, one row each, its head
  counting those that affect the version shown, those first and marked,
  those fixed in it (affecting only older versions) struck through, and
  those affecting later versions, older ones perhaps too, plain, each with
  its text, where its source has one, opening as on the Advisories tab; Files, each with its type's icon (a source map's a folded map) and tagged with its category, its
  tag naming the control or invisible characters or long lines it holds:
  each label a file has, Controls, Invisible and Long lines beside its category, but
  ASCII, as most files are, and Map, as a source map's name says (Compare's
  file heads tag both, and how a file's changed), and before them,
  Large, quietly, on a JavaScript or TypeScript file of 256 KiB or more
  (not a declaration file), which says little of a file alone, and
  Obfuscated, as a warning, on one with an obfuscator's fingerprint (20
  names or more such as `_0x1a2b`, `_0x` and four to six hex digits, or the
  loop `while(!![])`, as javascript-obfuscator writes; not prose, nor a
  source map, which holds the names of the code it maps), ordered by name or
  size, or, where any file listed is flagged (Socket's alerts on it, what
  it runs beyond itself, the hosts it names, critical for Exfiltration, a
  warning's for Remote and moderate for IP lookup, in Compare a level higher
  where new to the file, a warning's or a notice's tag), by its flags: the
  most severe first (a critical alert, then a warning's or a high alert,
  then a moderate and a low alert, then a notice), then the most flags, then
  their names, then its path, files with none last; and, where the
  package has any, its binary files again on their own.
- **Code**: the file tree and source viewer, opening on what `main` names,
  each file's head linking it on GitHub at the commit the version was
  published from, where npm recorded both its repository and that commit
  (in the directory its repository names; a file its build wrote may not
  be in the repository), as a stasis bundle's do; Compare's file heads link
  each file as the side it's read from has it.
  A minified file (as the Overview tags them) of a language the server
  formats has a pretty-print toggle in its bar, as a managed bundle's has:
  turned on, the file shows as the server formatted it, and so does each
  minified file opened after, until it is turned off: the version's minified
  files are asked for all at once, in one request, the first time one is
  wanted (see `GET /api/npm/pretty` below). The formatted copy has lines of
  its own, so line links and marks stay on the file as published.
- **Search**: the bundle Search across the version's text files (a file that
  isn't text has none to match), each match with the lines around it, case
  and regular expressions as toggles, a result opening its file beside the
  results, its pretty-print toggle there as in Code;
  `/npm/<name>@<version>/search`.
- **Treemap**: the files by size, as for bundles, colored by the top-most
  directories that tell them apart, as package colors can't tell one
  package's files apart: below the directories every file shares, each
  directory has its color, and the files loose in a directory passed on the
  way have one more (`src/a/`, `src/b/` and `src/*.js` for `src/a/a.js`,
  `src/b/b.js` and `src/c.js`), the largest first; a package of loose files
  alone is colored by extension. Any bundle of a single package is colored
  the same way.
- **Compare**: the bundle Compare, with another version of the same package,
  picked from its versions newest first, each with the day it was published
  (flagged under two weeks old as on the Overview, how long ago in its
  tooltip), both pickers one width: from the start at least as wide as the
  package's name with a version as long as `10.90.90` tagged `latest`, so
  most don't move as its versions arrive, then wide enough for any it lists,
  each whole with its tags (up to 24 characters of them).
  At the end of its picker row, once the two are compared, chips flag what
  calls for a look: first the open version's risk score against the one
  compared with, as the Overview shows it; an open version npm says is deprecated, its message in
  the tooltip (npm's placeholder, `Package no longer supported. Contact
  Support at https://www.npmjs.com/support for more info.`, to its first
  sentence, as the Overview lists it); a publisher that changed, where npm names the account
  that published each version and they differ (`~alice → ~bob`, as when a
  package changes hands, or is taken over), linking to the new one's
  profile; provenance lost, where npm lists provenance for the one compared
  with and none for the open one, as a version published by hand with a token taken
  from its maintainers wouldn't; install scripts the open version adds or
  changes (`postinstall added`, node-gyp's `install` for a `binding.gyp` it
  adds among them, not one it drops), each version's with their commands in
  its tooltip; in red, though their tags on the files say little of one
  alone or warn of it in orange, code that runs beyond itself new to a file
  the open version adds or changes (the kinds alone, as the file's tags say
  them: eval, child_process, whole env, publish, shell, persistence,
  `Runs code` heading its tooltip), its tooltip listing each file with its new kinds and their lines,
  each way a string runs as code by its own name (`Function (line 2)`); a
  credential new to a file it adds or changes, under `Credentials`, each by
  its name (`NPM_TOKEN or GITHUB_TOKEN (line 7, new)`); a
  host new to a file the open version adds or changes, a chip for each tag a
  level higher than the tag's own (`Exfiltration` and `Remote` in red, `IP
  lookup` in orange, the services named: `webhook.site`), its tooltip
  listing each file with its new services and their lines; a code file of
  256 KiB or more the open version adds (not one renamed), a file it changes
  that had no line over 200 characters and now has one over 2,000 (prose,
  source maps and an inline map's line aside, as its Long lines or Minified
  tag says of it), a file
  it adds or changes with an obfuscator's fingerprint where the version
  compared with had none (`Large new code`, `Now unreadable`, `Obfuscated`),
  and a JavaScript or TypeScript file it adds or changes that isn't text (not
  UTF-8, or holding a NUL) where the version compared with's wasn't one
  (`Binary code`), each counting them where there are several, its tooltip
  alone listing them, each with its size, its longest line before and now,
  or what its fingerprint holds; in orange, as the files' tags are, what any file of the
  open version runs beyond itself that the red chip doesn't name, kept from
  the one compared with (the kinds alone), its tooltip listing
  each file with its kinds and their lines; in orange, the whole chip, as one
  naming its issue is, the hosts the open
  version's code names that the one compared with's named in none of its
  (`New hosts`, the host where it is one, else how many): a URL's in a
  script's strings, regular expressions and template literals, its comments
  aside, not a host built as the code runs, nor this machine's, the names
  kept for examples and tests, a local network's, or W3C's, whose URLs name
  XML namespaces, its tooltip listing each with every file that names it and
  the line it is first named on there, and the chip, where one host is named
  in one file alone, opening that file at its line in Code; each file naming
  one tagged `New host` in its head and in the tree, its tooltip a list of the
  hosts with their lines, under them the version none of whose files named
  them (`None of 1.0.0-beta.3's files named them`);
  `Non-registry deps`, dependencies the open version takes from
  elsewhere than npm's registry, as the Overview tags them, where the one
  compared with didn't, or by another spec, their names and each version's
  spec in its tooltip; `Unused deps`, new dependencies
  nothing of the open version imports, as the Overview tells
  (`plain-crypto-js`, which axios 1.14.1 added to run its postinstall), their
  names and ranges in its tooltip, one that was another kind of dependency
  before not new, tinted as risk grades them by their packages: red for one
  first published since the version compared with (`new package, 18 hours
  old`), or whose range installs a version published since with install
  scripts, not its package's latest (`installs 3.0.1 (its latest 4.0.0),
  published since 1.0.0, running its install scripts`), orange where that version has install scripts, yellow for one
  among npm's top 20,000 (`npm's top 200`), as a dependency named for
  another's peer is, or for those all kept, else orange, and a notice's
  for lodash and Babel's presets alone (`no risk counted`); an open version
  under two weeks old, as on
  the Overview, how long ago (`3 days ago`), the day in its tooltip; the
  advisories affecting either version, counted from
  the one compared with to the open one (`2 → 1`, one number where they
  match), tinted by the worst still affecting the open one, or green where
  none does, its tooltip a row for each version's, their severities in
  their colors, and how many the open one brings and fixes, and a click listing them in a
  dialog, rows as in the Overview's Advisories column: those the open one
  brings, marked, those it still has, and those it fixes, struck through;
  for a public package, each of Socket's scores the open version has under
  its bar (a score it raised past the bar, as `81 → 100`, isn't flagged),
  from the one compared with to it, its tooltip a row for each version's with
  its ring, and the bar it's shown under, tinted as on the Overview: supply chain under 85; vulnerability
  under 85 where it tells of worse than the advisories found affecting the
  version (Socket's score counts much the same advisories: under 85 for a
  high one, 84 for one alone, and 25, its floor, for a critical one or many
  high), as where none are found, or a moderate one next to its 84; quality under 70 (a sabotaged release such as faker's 6.6.6 scores 38;
  most widely used packages 70 and up), maintenance under 70 (a deprecated or
  abandoned package's 50; a finished one's 75 and up; for a deprecated open
  version only under 50, its Deprecated chip saying as much) and license under 80
  (a copyleft or unusual license's 70, as AGPL's or WTFPL's); and the
  package's tier by downloads where it is orange or red (past the top
  20,000), its last complete month's downloads in its tooltip. Its Dependencies section, in place
  of Packages, lists the dependencies only one version has and the ranges
  that changed, each opening its package, and a changed one whose ranges
  each name a version (`^1.2.0` → `^1.3.0`) its Compare between those, each
  the open version adds or changes tagged as its chips flag it; one it adds
  that opens a package is tagged with that package's tier by downloads,
  whatever it is, tinted as the package's own is, by its downloads to the
  day before its latest two weeks (which a package a release just pulled in
  could owe to that release alone), as the server's risk tells it
  (`/api/npm/risk`) (a version-specific check, as of a version's age or publisher, would have
  to cover every version its range takes); unpopular where npm counts none
  of its downloads, as it counts none of a package's until the day after it
  was first published (axios 1.14.1, 21 minutes past midnight, named
  plain-crypto-js, first published the morning before), and npm has it for
  anyone: none for a private one, whose downloads npm's API tells no one. One below the top
  20,000 whose package didn't exist when the version compared with was
  published (its first version, one since unpublished among them, published
  after it) is tagged with how old it was when the open version was
  (`18 hours old`), or `published later` where it came after that, as a
  name someone took once a release named it would, the day in its tooltip;
  its whole document is asked for only then, as a package many install
  isn't one to doubt for being new.
  Files, open from the start, show each file's type, and the files the open
  version adds or changes their category, and Large or Obfuscated, as in the Files list, under the
  Overview's warning where any of those can be hard to review by reading them;
  each group ordered by name or size, or, where a file in it is flagged, as
  the Files list orders them by its flags (a stasis bundle's what it records
  of a changed file, `+x` or a format, among them).
  Files that are not text compare by digest. **Swap** opens
  the version compared with, comparing it with the one before. Both sides
  are pickers in the same order as for bundles, the version compared with
  first: picking the open side's opens that version compared with the same
  one, and picking the other side's swaps them. Code
  reviews the changes as for bundles, over the package's package.json its
  dependencies' changes (plain, peer and optional ones, not dev ones) under
  one head counting them, each a chip with its range beside its name (a new
  one's tier by downloads after it),
  tinted as the Dependencies section's groups are: those the open version
  adds, those whose range it changes (`~1.3.8 → ^2.0.0`) and those it drops,
  struck through, each opening as there and tagged as there, the head
  counting those tagged by each tag (`1 non-registry`). Compare asks the
  server for every changed file's two sides pretty-printed as it opens, in one
  request (`GET /api/bundles/:id/pretty?other=`, `GET
  /api/npm/pretty?otherVersion=`), those the server kept coming at once, the
  toggle on or not (one it brought none of asked for alone, and a failure
  that may pass asked again a while after, twice as long each time), and the
  pretty-print toggle is offered where printing
  changes a diff, in the file shown or any file the Diff view lists: a file
  minified on either side, as the Code tab prints one, or one whose two copies
  diff in fewer changed lines than its texts as published, as where only its
  formatting changed (a semicolon added to every line). With the toggle on,
  those files diff as the server formatted each, the others as published, and
  one whose copies are the same says there are no actual code changes in it,
  its texts not told as the same. Printed, a JavaScript file (`.js`, `.mjs`,
  `.cjs` without JSX) minified on both sides, its names a minifier's, marks
  its renamed lines: the two sides
  diffed as they are, the lines that differ in names renamed alone drawn
  faint and counted apart (`≈`), the diff drawn plain till the server
  answers. Renamed names are those a minifier renamed alike throughout:
  short ASCII names (three characters at most, as a minifier gives them,
  none a reader can't tell from another) a declaration in scope stands for,
  on every line, removed ones too. **Hide renamed names**, offered where the
  server finds lines it marks (and, while on, where it is to be turned off),
  rather gives the old side the new side's names,
  so that the two sides then diff as they are. An old variable no new one
  stands for reads as `r_old` where the new side uses its name `r`, never as
  the new one. The server works it out from the two copies (`GET
  /api/npm/rename-diff` below, `GET /api/bundles/:id/rename-diff` for bundles),
  so it is done with the pretty-print toggle on, for a managed bundle's or a
  version's files, and says why where it hides no names after all.
  The viewer takes the server's diff, checked there, as it is once it names
  the two files asked about and, by their hashes, the two copies the viewer
  draws as those it was worked out from, and shows the names where it does
  not, asking again when the names are hidden again. Where either side reads
  names (`.name`, told only where a name renamed is a function's or class's,
  `.toString`, `.stack`, `.callee`, `.caller`), whose values a rename may
  change, hidden renamed names come with a note saying so and offering them
  marked. It is done for those files alone: an author's name renamed, to a
  minifier's or to another author's, always shows. A global (`Map`, `$`) is
  kept, as is a name declared at a script's top level, a global another
  script may read; a module's (`import`, `export`) or a CommonJS one's
  (`require(…)`, `module.exports`, `exports.…`) is its own. Keywords,
  properties (after `.`, or an object's, a pattern's or a class's keys and
  methods), labels, names a module exports or imports by their own name,
  shorthand properties' names, strings, templates, regular expressions,
  comments and longer names keep theirs.

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
integrity, tarballSize, published, manifest, files, known }`, the manifest's `publisher` the npm
account that published it (never its email), or its `trustedPublisher` the
CI npm trusted to publish it, as npm names it (`GitHub Actions`), its `knownAccounts` those of
its publisher and author known to publish (`@preventive/publishers`), its `provenance` true where npm
keeps a provenance statement for it, its `gitlab` the GitLab project its
`repository` names (`group/project`, as `github` names a GitHub one), and each file row `[path,
bytes, text]`, or for a file that is not UTF-8 `[path, bytes, null,
'sha256-<base64>']`. `version` defaults to `latest`. `published` is when the
version was published (ISO), null until a read of the package's whole
document has said: a version's time never changes once published, so every
one such a read gives is kept while the server runs (up to 100,000), and the
Overview needn't wait for the version list to show it. `known` carries what the
server already keeps about the package, so the viewer need not ask for it:
`stats`, `advisories`, `tags`, `socket` and `provenance`, each as its own route below
answers it, `stats` where the figures of the repository the latest version
names are kept too, `advisories` where kept for a version list that has this
version, and `tags` and `socket` for this version. While the version's files
load, the server asks for each of these itself, as its route would, so that
what is answered by the time the files are encoded comes with them; nothing
waits on it, and what isn't answered yet is left out, for the viewer's own
request to share. The package's whole document, read for this for its
advisories' version list and when each version was published, is read only
where registry reads leave room for two more of readers' own. The version list the
viewer shows, never kept, is always asked for apart. A version naming no
repository or commit has no tags to ask for, and a private one no Socket
report. `GET
/api/npm/versions?name=` returns `{ name, private, distTags, versions,
times, created, teamScoped }`, newest first, `times` when each was published (ISO
dates, from the registry's whole document rather than its abbreviated one),
`created` when its first version was, one since unpublished among them (the
earliest time the document lists, which npm's own `created` can postdate, as
a placeholder's does for a package npm took down),
`teamScoped` whether any visible team lists its scope, whatever teams the
reader is in, and `GET /api/npm/download?name=&version=` the tarball.
`otherVersion=(empty)` compares every file against an empty package for initial dependency reviews, using the same risk findings and chips.

`GET /api/npm/risk?name=&version=&otherVersion=` returns what calls for a
look at a version, as risk tells it (risk/README.md, `assessNpm`), against
`otherVersion` where given, as Compare asks, else against the version of the
package most likely free of what an attack injects, as risk picks it
(`oldVersion: true`), as the Overview asks: `{ name, version, oldVersion,
published, findings, files, dependencies, score }`, `oldVersion` the one compared
with, or null for none, and `score` its risk out of 100, what raised it and what
lowered it (risk/README.md). What the version holds is told either way, what
changed folded into it, never lowering it. Risk is told on this server
alone, and the npm viewer shows it as told, computing none of it: the
Overview and Compare alike, and each side's files'. The version risk picks
has its document read as the open version's is, for its tarball. A team's own scopes
are trusted however new (a minimum release age of 0), any other version held
to two weeks, and however few download them: a version of one is not flagged
`popularity`, and a new dependency on a package of one is told no tier nor
age, nor is npm asked of it (assessNpm `owned`). What it reads is kept by type (npm-risk.ts): a public package's
assessment in the public npm cache, its versions' documents in the upstream
cache table, the rest in memory, and nothing of a private one shared.
Packages' documents are read as the others here are, within their bounds and
shared budget, tarballs as the viewer's loads read them, and four assessments
at once at most, as those loads are (429 `npm-busy` past any of them); a
tarball past their bounds or risk's is a 413 `package-too-large`.
`GET /api/npm/stats?name=` returns `{ name, downloads, github }`: `downloads`
is `{ start, end, days }`, a count a day over the last year from npm's
downloads API, reaching back to the first of the month that year starts in so
its months are whole (the last 365 days make the year's total), and `github` is `{ repo, stars, forks, openIssues, openPulls,
archived, pushedAt }` for the repository the latest version's manifest names,
`openIssues` taking in the open pull requests `openPulls` counts apart (from
the last page of their list, one a page; null where GitHub didn't say); either
is null where it can't be had, `github` for a repository GitHub does not
say is public. A repository renamed or transferred since, which GitHub
answers with a redirect to it by its id (`https://api.github.com/repositories/<id>`),
is followed there once by upstream (`getRepo`'s `followRedirect`), with the
same token, `repo` then its name now; a redirect anywhere else, or a second,
is no repository to show.
`GET /api/npm/tags?name=&version=` returns `{ name, version,
tags }`: the tags of its GitHub repository that point to its publish commit
(`gitHead`), among those whose names hold the version (`v1.2.3`,
`pkg@1.2.3`), which the Overview shows after the commit. GitHub's GraphQL API
finds them by name, and needs a token: the reader's own, where they have one,
and none are asked without. Only a public repository's are answered, kept an
hour for that repository and commit. `GET /api/npm/advisories?name=` returns `{ name, versions,
advisories, repository, keptAt? }`, asked as bundle advisories with repository
advisories are: what `npm audit` asks npm's registry, for every published
version at once (`source: 'registry'`), what OSV has besides for a package
anyone may read (`source: 'osv'`, the malicious packages' records among
them), and what the package's GitHub
repository publishes that npm does not report yet (`source: 'repository'`):
the repository its latest version names, asked for only where GitHub says it
is public, asked afresh rather than from its figures' kept answer, since the list is kept for every reader and
the reader's token could read a private repository's; its listing is kept
where bundle audits keep theirs. A repository renamed or transferred is
followed as for its figures, its listing asked and kept under its name now,
and taken as kept under that name where GitHub refuses it; one that leads to
a repository GitHub doesn't say is public has none asked, leaving npm's, with
`repository` true. Each advisory is `{ id, source, ghsa?,
url?, title?, severity?, cvss?, cwe, range?, details?, affected }`, `details`
its text (Markdown): OSV's record of an npm advisory's GHSA, a repository
advisory's own description; `affected` indexing
`versions`, one row an advisory: npm's registry answers one a range it covers,
merged here, their ranges joined with `||`. Where GitHub refuses the listing (its anonymous rate
limit, say), or can't say whether the repository is public, the listing last
kept for it is taken instead, however old: read where audits keep listings,
on disk or in `managed_upstream_cache`, never written, and checked by upstream
as its own are, `keptAt` saying when it was kept. GitHub is asked nothing for
it, and an audit that fails with it is npm's failing, not asked a third time.
Only where none is kept, or upstream won't take it, is `repository` false,
leaving npm's alone. A repository GitHub says isn't public
never has its kept listing taken. Such a list, kept or npm's alone, is asked
again on the next request. `GET
/api/npm/socket?name=&version=` returns `{ name, version, socket }`: Socket's
report on the version, as Socket Firewall asks it (no key), `{ scores,
alerts }`, `scores` each 0 to 1 (`overall`, `supplyChain`, `vulnerability`,
`quality`, `maintenance`, `license`), cut to two decimals, `supplyChain` as
the version's Socket badge rounds it where that is lower or at most 0.01
higher (where the badge can't be had, as while Socket limits how often it's
asked, the report is answered as Socket gives it and asked for again next
time) and `alerts` most severe first, each
`{ type, severity, category, file, note }`, `file` its path in the package;
null where Socket has none. Socket is asked only about a version npm answers
for without a token: a private package's name never leaves for it. `GET
/api/npm/provenance?name=&version=` returns `{ name, version, provenance }`:
npm's provenance for the version, `{ repository, commit, workflow, ref,
builder, run, logIndex, runner }` (its source repository and the run as https URLs,
`runner` the runner environment the certificate that signed it names,
`github-hosted`, `gitlab-hosted` or `self-hosted`; each part null where
they don't say), read from the SLSA
statement npm's registry keeps beside it (v1, or v0.2, whose run, given as
`<run id>-<attempt>`, is made GitHub's URL; GitLab's, as npm writes it, names
its project with no ref and its job's URL as its run), only where the statement names this version's tarball by its
name, version and sha512 digest; its signature isn't checked here, as npm
checks it when the version is published. null where npm keeps none, and for
a private package; asked only where the version's manifest says npm keeps
one, without a token, kept for an hour, and a failure answered as one. `GET
/api/npm/pretty?name=&version=` returns every one of the version's files that
needs pretty-printing (`needsPrettyPrint` in `common/pretty-print.js`: one the
viewer tags minified, of a language formatted, of at most 4 MiB), each
formatted and checked as a bundle's are (`GET /api/bundles/:id/pretty`), as
Brotli-encoded `application/x-ndjson`: a line a file, in path order, each sent
as it is formatted, `{ path, source, text }`, or `{ path, source, error,
status }` where it has no copy (`unformattable`, `pretty-mismatch`,
`pretty-busy`, …), `source` the `sha512-<base64>` of the file's bytes it was
formatted from, which the client checks against the text it was sent. With
`otherVersion=`, it returns instead the files that changed between the two
versions, both sides', as `GET /api/bundles/:id/pretty?other=` has them for
two bundles, each line naming its `side`, private where either version is; with
`path=&hash=`, one of its files, as `GET /api/bundles/:id/pretty?path=&hash=`
has one of a bundle's, for a pair a comparison brought none of. The
files are loaded once, as for `package`, within the same four loads at once,
before anything is answered, so a version that can't be loaded is refused as
`package` refuses it; access is checked again before each line, and a reader
who lost it has the response cut short. A public version's copies are kept by
content hash under `cache/npm/`, unencrypted, as what they are made from is
public, and read from there by anyone who may read a public version; a private
version's are made for each request and never kept. `GET
/api/npm/rename-diff?name=&version=&path=&hash=&otherVersion=&otherPath=&otherHash=`
diffs one of the version's JavaScript files with one of `otherVersion`'s of
the same package, from both pretty-printed as `pretty` has them, as a
bundle's are (`GET /api/bundles/:id/rename-diff`), and without a file every
pair of them, a line each, as a bundle's; `GET
/api/npm/type-only?name=&version=&otherVersion=` tells which of their
TypeScript files changed in types alone, as a bundle's (`GET
/api/bundles/:id/type-only`), nothing of it kept; `GET
/api/npm/comparison?name=&version=&otherVersion=&otherName=` compares the
version shown with `otherVersion`, of `otherName` where Review compares a
dependency replaced by another package, or with none as `(empty)`, as a
bundle's is (`GET /api/bundles/:id/comparison`), each package's private access
checked before and again once it is worked out; a diff of two public
versions' files is kept in memory among the last few dozen, a private one's never,
its sides, formatted again for it, read in its turn among the diffs waiting.
Responses are `private, no-store`. Nothing else derived from a package's
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
without credentials. That answer alone is kept, never one read with the token:
documents and tarballs that a bundle build fetched with the token can remain in
upstream's caches, readable without one, so leaving the token out is not
enough. An exact version's document npm answered anonymously is kept in the
database (`npm-kept.ts`, of only the fields read of it), and the viewer,
dependency reviews and repository risk scans read it from there for a day
rather than ask npm on every read, then ask again: npm never changes a version's files, but its document can
change within that day, as its owner deprecates it or makes a scoped package
private (a private answer is never kept), or npm removes it. A dist-tag such as
`latest` is asked each time. A version npm removed stays readable for that day
where its document is kept (its tarball where that is kept too); risk tells it
as removed, from the package's whole document. Tarballs are read from there all the same, as the answer names the sha512 the
tarball must have: one kept in upstream's cache directory (`npm/tarballs`,
where bundle builds keep theirs), or in npm's own cache, is served only when it
matches. Otherwise the tarball comes from the registry, at the package's own
path, without credentials for a public version, is checked against that sha512,
and is then kept in upstream's cache, where the server has one. A package's
whole document, as risk and the version list with publish times read it, is
kept there too where it is public (`npm/packuments`, gzipped, with npm's ETag),
and served only when the registry, asked anonymously with that ETag, answers
304: the request is still made on every read, but npm sends nothing more while
the document is unchanged (a large package's runs to megabytes). One only the
token could read is never kept, and one npm no longer has for anyone is
dropped. Off Vercel only, as upstream's cache is. Readers with
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
access. Repository **Contents: read**, **Issues: read and write** and **Pull
requests: read** are approved when connecting repositories, not added as login
OAuth scopes; **Checks: read** and **Commit statuses: read** let the Pull
requests tab show a pull request's checks. Existing installations must have
their owner approve each permission update; the issue dialog offers the
installation flow when approval is missing. GitHub App
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

### Dependency reviews

A package's **Review** tab opens `/npm/<package>@<version>/review`. With no base,
all package files are reviewed as additions. Append `/<basePackage>@<baseVersion>`
to review an update; a bare base version is accepted as a same-package shortcut.
The tab is shown only to users belonging to a visible team with dependency review enabled.
Tags resolve to exact versions. Review uses the Compare header and stats.
Clicking Review reopens the author's latest review for that exact package version
and integrity, including its original base. Explicit review links keep their base.
Changed files totaling less than 50,000 lines and 2 MiB across both versions use
the whole diff; larger reviews use the per-file Code view. Both views support
file reviews and whole-diff notes (a null file path).

Triage users and above can save private review sets with notes and optional
verdicts: **Accept**, **Accept with nits (non-blocking)**, **Request changes**, or
**Reject**. In Manage teams, the **Enable dependency review** switch follows the
npm scopes count. Only enabled, visible teams the author belongs to are offered
for publication. A sole eligible team is selected initially; with multiple teams none are preselected.
**Publish** requires at least one selected team.
The account menu and review page link to **My reviews** (`/my/reviews`), a paginated
list of the user's unpublished, published, and revoked review sets.
Authors can discard an unpublished set from My reviews after an explicit
confirmation. `POST /api/npm/reviews/discard` requires its ID and current revision;
it atomically deletes the set and its file rows. Published and revoked sets cannot
be discarded. Discarding does not require fetching the package again.

Selecting a file verdict saves it immediately. Review always wraps source lines.
Notes save when their field loses focus. Finalize also saves pending notes before
opening confirmation.
Each file has one verdict and one text note; later saves update that same row.
The note editor is shown for Accept with nits, Request changes, and Reject.
At least one changed file must have a saved verdict before publishing.

**Finalize review** opens a separate confirmation step with a required final
verdict and optional final comment. File verdicts limit the final verdict: it
cannot be more favorable than the least favorable file verdict. A final verdict
does not check any remaining files. Every published set is classified **Full**
or **Partial** using the exact changed paths from the same diff engine as the UI,
including added, removed, renamed, and binary files. Notes alone do not check a
file; checking three of four files produces a partial review. The changed paths
are frozen on first publication, along with the final verdict and comment.

A full, non-revoked published review whose final verdict is **Accept** or
**Accept with nits** offers **Copy audit Markdown**. This includes the package,
version and integrity, its base when present, and any file or final notes.

Publication freezes the entire set. Its author can publish that same snapshot to
additional eligible teams or **Revoke** it. Revocation is permanent and keeps its
file reviews and team links visible, labeled revoked. **Continue in a new review**
copies the set into new private review and file-review rows; it never edits the
published original. Only one unpublished set per author and comparison is active.

`GET /api/npm/reviews` takes `ecosystem=npm`, `package`, exact `version`,
`integrity`, and optional `basePackage`, `baseVersion`, `baseIntegrity`. It returns
the author's own sets, published sets shared with their current visible teams,
and eligible publication teams. Private npm access is checked for both sides.
`POST` takes that context plus `action`: `start` (an empty private set), `save` (file, comment, optional status,
optional reviewId/revision/entryId), `publish` (reviewId, revision, teamIds,
and required finalStatus/optional finalComment on first publication),
`revoke`, or `continue` (reviewId, revision). Every mutation requires a session,
CSRF token and triage role. `GET /api/npm/reviews/mine` lists only the current
user's sets in pages of 50, with an optional beforeTime/beforeId cursor.
Revision conflicts return 409. Version and integrity
mismatches also return 409; unknown file paths are refused, including paths not
present on either side. Notes are limited to 20,000 characters.

Storage uses three tables: `managed_dependency_review` for author, comparison,
changed paths, final verdict/comment, revision and publication/revocation times; `managed_dependency_file_review` for
file paths, comments, verdicts and times; and `managed_dependency_review_team`
for publication links. There is no draft flag. `managed_team.dependency_review`
controls publication eligibility, defaulting off. Both SQLite and Postgres
migrate existing installations without altering their existing team membership.
