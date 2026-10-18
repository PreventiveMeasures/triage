For deployment on Vercel, see [the deployment guide](VERCEL.md).
For database selection, shared-storage boundaries, and cleanup behavior across both server modes, see [storage separation](../server-common/STORAGE.md).
For optional encryption of disk and Vercel Blob payloads, its configuration and plaintext migration, see [managed storage encryption](STORAGE-ENCRYPTION.md).

# Account approval

GitHub sign-in establishes identity.
New accounts get the `none` (No access) role.
To preapprove the first administrator, set this optional environment variable to that account's numeric GitHub user ID:

```sh
MANAGED_INITIAL_ADMIN_GITHUB_ID=123456
```

On a successful GitHub sign-in, the matching account becomes `admin` only if its role is `none` and it is the **only user in the database**.
This applies to the first registration and to later logins.
If the intended administrator signed in before the variable was set, set it and have them sign in again.
The identity update, the sole-user check and the promotion run in one transaction.

Changing configuration, restarting, or reading an existing session does not trigger promotion.
Assigned roles other than `none` are kept.
Any other user row, even one with No access, blocks automatic promotion.
An unset or empty variable disables promotion, and an invalid ID fails startup.
Team membership, upload ownership and GitHub repository access do not grant a workspace role.

For a deployment with several users and no admin, a trusted operator must approve the intended account directly in the managed SQLite or Neon database.
Verify the account's numeric GitHub user ID and put it in place of `123456`:

```sql
UPDATE managed_user SET role = 'admin' WHERE github_user_id = 123456;
```

Check that exactly the intended row was updated.
The administrator can then approve other users in **Manage → Users** and assign team access in **Manage → Teams**.
Database upgrades keep existing roles.

These approval rules apply to the managed service.
Combined managed + E2E deployments keep the E2E service's separate authentication and permissions.

## Viewing as another user

To check what an account can access, an admin selects **View as** on that user's row in **Manage → Users**.
The app reloads as that user, and their role, teams, Dependencies and Security permissions, and pages apply unchanged.
A sidebar banner names the viewed user until the admin selects **Stop**, or **Return to @admin** in the account menu, which reopens Users.

While viewing, every write is refused with `403 { "error": "view-only" }` before the request body is read.
This covers triage, comments, issues, public links, uploads and all management changes.
Controls stay as the viewed user has them, so the admin sees what that user is offered.
For example, a Viewer's triage controls are disabled, while a Triage user's stay enabled and their edits are refused.
The app shows the refusal and restores the server's triage.
Reads behave as for the viewed user, including the read-only `POST /api/reports/query`.

Requests never use the viewed user's GitHub authorization.
Data that needs it is left out, as for a user who has not authorized GitHub:

- private pull request and issue status
- repository browsing
- discovery
- issue creation

GitHub issue authorization is refused.
A combined deployment's E2E requests are unaffected and keep that service's own authentication.

`POST /api/auth/view-as` with `{ "userId": "<id>" }` opens a view.
It requires an admin session, same-origin access and CSRF, and it refuses the admin's own ID.
The view is a separate session row for the viewed user, tied to the admin's session.
It is stored in its own `dvview` cookie (`__Host-dvview` when Secure) beside the session cookie.
`SESSION_COOKIE_NAME` cannot use this name or the OAuth state cookie names (`dvstate`, `dvissuestate`, `dvlinkstate`), and startup fails if it does.
`GET /api/auth/session` then returns the viewed user, the view's own CSRF token, and the admin as `viewer`.
A view token is never accepted as a session cookie.
A view resolves only together with the admin session that opened it.
`DELETE /api/auth/view-as`, with the view's CSRF token, ends the view.
Logging out ends both.

A view also ends when the admin session expires or ends, or when the admin loses the admin role.
It does not come back if the role is granted again.
The next session probe then clears the cookie.
Other requests that carry the cookie are unauthenticated: they never fall back to the admin's own, writable session.

Opening a view adds `viewed as <login>` to the admin's access history.
Viewing does not update the viewed user's Last seen or Last activity.

## Profile and linked GitHub accounts

**Profile** in the account menu (`/my/profile`) shows a user's avatar and name and the GitHub accounts linked to theirs.
**Link GitHub account** runs the App's user authorization again, asks GitHub for its account picker (`prompt=select_account`), and links whichever account completes it.
Linking needs workspace access (any role but No access) and is refused while an admin views as the user.
Its state is bound to the session that started it, in a `dvlinkstate` cookie, and expires after ten minutes.
The linked account's token is used only to read its identity and avatar, and it is never stored.

A linked account is reserved for its user.
It cannot sign in (the OAuth callback returns `403 { "error": "github-account-linked" }`), and it cannot register.
Linking is refused for:

- the sign-in account itself
- an account another user linked
- any account that has signed in here before, since it is already a user of its own

Refusals land back on the profile, which explains them.
Unlinking frees the account to sign in or register again.
Linking and unlinking are recorded in the access history.

A user's login and GitHub ID always stay the sign-in account's.
Their displayed name and avatar may each come from any of their accounts.
The chosen name is shown wherever the user appears.
`/api/avatar/<user id>` serves the chosen avatar, and `?own` serves the sign-in account's.
Linked accounts' names are kept as they were when linked, and linking an account again refreshes them.
Signing in refreshes the sign-in account's own name, which is displayed unless another was chosen.
Unlinking an account that gave the name or avatar switches it back to the sign-in account's.

The profile API:

- `GET /api/auth/profile` returns the profile.
- `POST /api/auth/profile` with `{ "name"?: <id> | null, "avatar"?: <id> | null }` chooses the accounts: a linked account's ID, or `null` for the sign-in account.
- `DELETE /api/auth/profile/accounts/<id>` unlinks one account.

Changes need same-origin access and CSRF.
Database upgrades keep existing names as the sign-in accounts' own.

In the code viewer, a repository's activity (its commits, issues, pull requests, agents and pulse) shows a GitHub account as an approved user when that user signs in with it or has linked it.
It shows the user's chosen avatar and name, with the login itself in the tooltip.
A linked account shows as its user, and Pulse counts all of a user's accounts as one contributor.
The server resolves the accounts each answer names as it sends the answer, in a `users` map keyed by login.
That map is never kept with the cached repository data, and readers are never sent a list of users.

An account is matched by its numeric GitHub ID wherever GitHub gives one, and otherwise by its login, ignoring case.
So an account renamed since its user signed in with it or linked it still shows as theirs, and its old login, if another account takes it, does not.
A login that two users claim, which happens once one of them renames on GitHub, shows as the login alone.
Some commits have no user in GitHub's GraphQL API, such as a GitHub App bot's.
They are matched by the account their noreply address (`<id>+<login>@users.noreply.github.com`) names, as GitHub's REST API matches them.
Commits read before IDs were kept show by login.

Agents show as the Agents tab draws them, and the server names each in `users` as `{ "agent": <id> }`.
Claude, Codex and Copilot show by their marks, which the app draws itself.
Dependabot, GitHub Actions and Neo show by their avatars.
Cursor, which the app has no mark for, shows by its name's letter.
Each agent is matched by its accounts' logins, and the account's ID confirms the match wherever both are known.
An account known by no login is matched by its ID alone.
The agents and their accounts are defined in `common/managed/github-agents.ts`:

| Agent | Shown by | Accounts | Commits with no account, by name |
| --- | --- | --- | --- |
| Claude | its mark | `claude` (Claude Code's commits, authored as `Claude <noreply@anthropic.com>`) and `claude[bot]` | `Claude` |
| Codex | its mark | `chatgpt-codex-connector` and `chatgpt-codex-connector[bot]` | `Codex` |
| Copilot | its mark | its coding agent's `Copilot` (also `copilot-swe-agent`); its code review's bot, also `Copilot`, and `copilot-pull-request-reviewer` on its reviews | `Copilot` |
| Dependabot | its avatar | `dependabot` and `dependabot[bot]` | `dependabot[bot]` |
| GitHub Actions | the GitHub Actions App's avatar | `github-actions` and `github-actions[bot]` | `github-actions[bot]` |
| Neo | its GitHub App's (3115942) avatar, as it is where its fingerprint names it | account 274065190, by its ID alone, whatever its login | none |
| Cursor | its name's letter | none | `Cursor Agent` |

A login that both of Copilot's accounts use is still Copilot's.
Commits that GitHub names no account for are matched by the name they carry, as in the last column.
Codex otherwise commits as whoever ran it, and those commits show as that person's, with Codex beside them as a co-author (see Commits, below).
Pulse counts each agent as one contributor.

# Managed browser navigation

## Public workspace links

Set `DEEPVIEW_ALLOW_SHARE=1` to turn on public links.
A manager can then share a team they belong to, and an administrator can share any team, with the sidebar's **Share public link** button.
The button appears on hover or keyboard focus, and stays visible on devices without hover.
Sharing is disabled when the variable is unset or set to any other value, and that also disables links already in the database.
The dialog creates a read-only link and can revoke all public links for that workspace.
Anyone holding a link can open it without GitHub sign-in, including on combined managed + E2E deployments.
Like the Viewer role, a link shows saved triage, fix links, flags and colors with their controls disabled, and opens comments read-only.

New links use `/team/<team-slug>#public=<link-id>.<token>`.
The eight-character link ID matches the ID shown in the dropdown and in Manage's Links tab, so a URL can be matched to its entry for editing or revocation.
The link ID is a prefix of the stored token hash, not a credential.
Only the full token resolves the workspace, and the slug and short ID cannot grant access or select another team's data.
Older links, with a team ID before the token, remain valid.

A link exposes that team's currently published reports, links, triage, comments and cited source files.
**Security** and **Dependencies** are independent opt-ins in the creation dialog, and both are off by default.
Existing links also migrated with both permissions off until a manager enables them.
The same finding filters apply to report data, comments, triage and its history, and cited sources.
Future published reports in the team's repository paths are included, and drafts and other workspaces are excluded.
Whole-repository team grants also expose their bundles.
Published advisories require the security opt-in.
Directory-only grants expose cited source files, not entire bundles.
GitHub PR metadata, bundle commit details and tags, and user avatars require account access and are not sent in public views.

Tokens hold 256 random bits.
Only their SHA-256 hashes are stored, separately from sessions.
Links persist across restarts and issuer logout.
A link stops working when any of these happens:

- it is revoked
- sharing is disabled
- the team is deleted
- its issuer is no longer an administrator, or a manager who is a member of that team

Reads recheck the current scope after slow storage or upstream work.
Turning the flag off does not delete links, so re-enabling sharing makes any unrevoked links usable again.

The **Links** tab in Manage lists public links grouped by team, with their creator, creation time and permissions.
Managers see only their teams' links, and administrators see all links.
Select **Edit** to change a link's permissions without changing its URL, or to revoke it.
The share dialog also lists the team's links and can revoke all of them.
Only hashes are stored, so an existing link's URL cannot be recovered from the listing.
Copy a newly created URL before closing the dialog.

| Request | Effect |
| --- | --- |
| `GET /api/admin/links` | Lists the links within the caller's scope |
| `GET /api/teams/:id/share` | Lists one team's links |
| `POST /api/teams/:id/share` | Creates a link with `{ security, dependencies }`, where only literal `true` opts in |
| `PATCH /api/teams/:id/share/:id` | Replaces a link's permissions |
| `DELETE /api/teams/:id/share/:id` | Revokes just that link |
| `DELETE /api/teams/:id/share` | Revokes all of the team's links |

These require an authenticated team manager or administrator.
Mutations also require same-origin access and CSRF.

Public clients send the fragment token in `X-Deepview-Share`, with no cookies.
A supplied token takes precedence over any login cookie.
It is confined to an explicit allowlist of read-only routes:

- `/api/shares/:linkId/workspace`, for the token's own workspace only
- `/api/teams/:id/{shared,reports,feed,annotations}`
- visible reports' read-only `triage`, `comments` and `sources` routes
- authorized bundles' `metadata`, `contents`, `download`, `pretty`, `advisories`, `rename-diff`, `type-only` and `comparison` routes
  Comparison routes only compare with another of the link's bundles.

Global endpoints, mutations, unknown routes, cleanup and sync transports are denied.
The token stays in the URL fragment across browser navigation.
It is never sent in page URLs or stored in local storage.

Finding triage history requires an authenticated `triage`, `manage` or `admin` role and access to the finding within the report.
Ordinary triage users must supply their team scope, and its security and dependency visibility filters apply.
Public links cannot read triage history, even when a login cookie is present.

## Page routes

Build the UI with `pnpm build` before starting a managed or combined server.
Managed pages use the History API: navigation pushes a URL, Back and Forward restore it, and reloading opens the same page.
PWA launches into an existing window also navigate to their managed page URL.

| URL | Page |
| --- | --- |
| `/` | Team landing / login |
| `/team/:teamSlug` | Team findings |
| `/team/:teamSlug/files` | Team files |
| `/team/:teamSlug/{reports,bundles,repositories}` | The team's reports, bundles or repositories |
| `/team/:teamSlug/dependencies[/:tab]` | The team's Dependencies; `:tab` is `versions`, `branch` or `reviews`, and Pull requests has no suffix |
| `/team/:teamSlug/report/:reportSlug` | Report findings |
| `/team/:teamSlug/report/:reportSlug/files` | Report files |
| `/team/:teamSlug/finding/:findingId` | Finding in a team |
| `/team/:teamSlug/report/:reportSlug/finding/:findingId` | Finding in a report |
| `/team/:teamSlug/bundle/:bundleSlug[/:tab]` | Team bundle; the active tab is part of the URL |
| `/manage/bundle/:bundleSlug[/:tab]` | Bundle opened without an accessible team (manager/admin) |
| `…/bundle/:bundleSlug/code/:file` | Its Code tab, at a file |
| `…/bundle/:bundleSlug/compare[/:otherSlug[/code\|/diff]]` | Its Compare tab, with another bundle, in Code; `/diff`, the older mode's name, also opens Code |
| `/manage` | Manage overview |
| `/manage/bundle` | Bundles |
| `/repo/:repoId[?path=:directory]` | A repository directory at its default branch's head; its route then names the commit. Links under its earlier `/manage/code/` open the same |
| `/repo/:repoId/:commit[/:tab][?path=:directory]` | A repository directory at a commit, on its Code, Search, Treemap or Compare tab, or a view of its Activity: `commits`, `issues`, `pulls`, `agents`, `pulse` or `replay` (`history`, its earlier name, opens Commits) |
| `/repo/:repoId/:commit/code/:file[?path=:directory]` | Its Code tab, at a file |
| `/repo/:repoId/:commit/compare[/:otherCommit[/code\|/diff]][?path=:directory]` | Its Compare tab, with the directory at another commit, in Code; `/diff` also opens Code |
| `/manage/scans` | Scans |
| `/manage/report` | Reports |
| `/manage/deduplication` | Deduplication (admin) |
| `/manage/repositories` | Repositories (admin) |
| `/manage/repositories/risk` | Repository risk (admin) |
| `/manage/users` | Users (admin) |
| `/manage/team` | Teams (admin) |
| `/manage/import` | Import (admin) |
| `/manage/links` | Links (only while sharing is enabled) |
| `/manage/history` | Activity history; optional `?actor=<login>` |
| `/my/profile` | Profile and linked GitHub accounts |
| `/my/reviews` | My reviews |
| `/npm` | npm package lookup |
| `/npm/:name[@:version][/:tab]` | npm package version; `:version` may be a dist-tag |
| `/npm/:name@:version/code[/:file]` | Its Code tab, at a file |
| `/npm/:name@:version/review[/:baseName@:baseVersion]` | Review a package or update; automatically chooses whole-diff or per-file display |
| `/npm/:name@:version/compare[/:otherVersion[/code\|/diff]]` | Its Compare tab, with another version, in Code; `/diff` also opens Code |

Page tokens are persistent, server-assigned slugs.
A slug is the last UUID component when that is unique, and otherwise the full ID.
Teams, reports and bundles follow the same allocation rules.
API requests and database relationships still use full IDs.
Existing bundle rows got stable slugs during the SQLite/PostgreSQL upgrade.

Finding IDs are percent-encoded as one path component.
Finding links appear only under a team or report, and there is no root `/finding/:id` route.
E2E finding hashes are still supported and resolve to the accessible managed team or report.
Old plural managed page URLs fall back to the landing page, without redirects.
Sidebar search filters the loaded team, report and bundle names locally.
It does not fetch report contents or change the catalogue used to open a team.

Bundle links keep the clicked team, even when several teams share a repository.
The tab suffix is left out for Overview.
Reload and Back/Forward restore the tab, and switching bundles keeps it when the new bundle has it.

Compare's two sides are both pickers.
The bundle compared with comes first and the open bundle second, and the changes read from the first to the second.
Picking in the first chooses what to compare with.
Picking in the second opens the picked bundle, compared with the same first bundle.
Picking the first side's bundle there swaps the two.
The bundle compared with stays while another tab of the bundle is open, and Back keeps it too, so the Compare tab opens with it again.
The summary counts files, size and lines of code (the non-blank lines of text files) on each side.
A file's line count is in its size's tooltip.
Compare offers accessible bundles assigned to the same repository, including bundles not opened before.
Unattached bundles cannot be compared with each other.

Past its Overview, Compare reviews the changes in **Code**, beside the tree of changed files.
While every changed file's diff fits in a list of under 25,000 rows, Code lists them all, one after another, each under its name, in the tree's order.
The row count includes folded unchanged runs, each file's head and each repointed import.
In that list, picking a file in the tree scrolls to it, and the tree marks the file at the top of the list as it scrolls.
A file whose only change is a repointed import lists just those imports.
Above that limit, Code shows one file at a time, and its **Previous file** and **Next file** buttons step through the files in the tree's order.
A link naming the older Diff mode opens Code.

Each file's head tags how the file reads, as the npm Overview tags files (ASCII, UTF-8, Controls, Minified, …).
Where that changed, the head shows how it read before, then how it reads now.
Beside that, it shows every other label the file has now: Controls, Invisible and Long lines.
The tree tags a file more briefly, only where it can be hard to review by reading it:

- its category, except Map, which a source map's name already says (the head keeps Map)
- its Controls and Invisible labels, and Long lines where they are unexpected

Both the head and the tree tag a file Large or Obfuscated, as the npm Files list does, as the file is now (or was, for a removed file).

The head also labels these files:

- A file a bundle or package starts from is labelled in blue: a Stasis bundle's entry, or an npm version's `main`, `module`, `types` or `bin`.
- A license file is labelled `license` in grey.
  For an npm version, that is a license file at its root, and its tooltip names the licenses its manifest's license expression covers it for.
  For a bundle, that is its packages' license files.
- A `package.json`'s install scripts are marked in its head and in the tree, each with its command.
  A new or changed script says so, and the head strikes through a script that is no longer named.
- For an npm version, a file that Socket raises an alert on is labelled with that alert in its head and in the tree.

Install scripts are `preinstall`, `install` and `postinstall`, which npm runs when it installs a package from the registry.
`prepare` is not one, because npm runs it only for a local or git install.
`node-gyp rebuild` also counts when a `binding.gyp` sits beside the `package.json` and neither `preinstall` nor `install` is set, because npm then runs it.

A script is labelled, in its head and in the tree, with what its code can do beyond itself:

- `eval`: runs a string as code.
  One `eval` label covers `eval`, `Function` (with or without `new`), `vm` and Module's `_compile` (called or hooked), and its tooltip names each.
  A key named `eval` does not count, as in WebAuthn's `extensions: { prf: { eval: … } }`.
  A worker's `{ eval: true }` and `eval` destructured from the global object do count.
  `Function('return this')()` does not count, since it is older code's way to reach the global object, as in lodash and core-js.
- `child_process`: runs other programs.
- `credentials`: reaches for credentials, by any of these:
  - a path to `.npmrc`, `.ssh` or `.aws`
  - `NPM_TOKEN` or `GITHUB_TOKEN` where its value is read, as in `process.env.GITHUB_TOKEN || null`, `process.env['NPM_TOKEN']`, or a shell's or `.npmrc`'s `$GITHUB_TOKEN` and `${NPM_TOKEN}`
    It does not count where only the token's absence is checked (`!process.env.GITHUB_TOKEN`), but `!process.env.GITHUB_TOKEN.trim()` reads it and counts.
    It does not count where the token is deleted or only set (`process.env.NPM_TOKEN = token`), or where text only names it.
  - `gh auth token`, as one string or as a program's separate arguments (`spawnSync('gh', ['auth', 'token'])`)
  - the cloud's instance metadata endpoint, `169.254.169.254` or `metadata.google.internal`, but not Azure's `/metadata/instance`, which gives a machine's region
  - the GitHub Actions runner's process, `Runner.Worker`
  - another process's memory, `/proc/<pid>/mem`, by a pid, a glob (`/proc/*/mem`) or a substitution (`/proc/${pid}/mem`), but not `/proc/self/mem`
  - `trufflehog`, in any case
- `whole env`: reads out the whole environment, as `JSON.stringify(process.env)` or `Object.entries(process.env)` do.
  It does not count where the environment is handed to a program or its names are listed.
  It does not count where its entries are picked among as they are read (`.filter(…)`, `.find(…)`, `.reduce(…)`), as npm's agent finds its proxy's.
- `publish`: publishes to npm, by any of these:
  - `npm publish` (or `pnpm` or `yarn publish`) run
  - the registry's `/-/whoami`
  - libnpmpublish
  - a PUT request in a file that names the registry (`registry.npmjs.org` or `registry.yarnpkg.com`)
    The registry counts as named where its string, read as JavaScript reads it with its escapes decoded, has the host after a URL's two slashes (or backslashes) or after an http(s) scheme, with any userinfo between.
    Examples are `https://registry.npmjs.org/` and `.npmrc`'s `//registry.npmjs.org/`.
    It also counts where the host starts a string, as the whole string or before its path or port.
    It does not count in prose, as in the advisories' consent dialog.
- `shell`: runs shell commands that fetch or hand off code, by any of these:
  - `curl` or `wget` given a URL
  - a download piped to a shell
  - `powershell -…`
  - rundll32, osascript or mshta
  - `certutil -urlcache` or `bitsadmin /transfer`
  - `/dev/tcp/` or `/dev/udp/`
  - PowerShell's `iex` of what `iwr` or `irm` fetches
- `persistence`: names a place code runs from again later, by any of these:
  - a shell's rc file
  - PowerShell's `$PROFILE`
  - LaunchAgents and LaunchDaemons
  - systemd's user units
  - `.claude/settings.json`
  - `.vscode/tasks.json`
  - a directory and its file named apart, as `path.join` takes them

A shell script (`.sh`, `.bat`, `.ps1` …, or a file with a shell's hashbang) is read whole for `shell` and `persistence`.
It is also read whole for the `credentials` a command reaches for: `gh auth token`, `Runner.Worker`, `/proc/<pid>/mem` and `trufflehog`.
Each label is marked as an install script is, except `whole env`, `publish` and `persistence`, which are marked in red as worse.
A label's tooltip lists what it found, as Compare's chips' tooltips do (each way a string runs as code, a credential file, a token, `gh auth token`, …), with the lines each is on.
Where the version compared with didn't have one of them (all of them, for an added file), a line under them says it is new in this version.

This is a quick read, not a parse:

- strings, regular expressions and comments are set aside from the code
- strings are read for the paths, names and commands they hold
- a module (`vm`, `child_process`, libnpmpublish) is recognized by the string naming it where code loads it (`require(…)`, `import`, `from`)
- a declaration file (`.d.ts`) is read as any TypeScript, as node runs it

A file that names a host malicious packages use is labelled in its head and in the tree, as its code's capabilities are.
These are hosts that such packages send what they take to, fetch what they run from, or look up the machine with.
Each host falls under one of three tags, each in its level's color:

| Tag | Color | When | Services |
| --- | --- | --- | --- |
| Exfiltration | red | Nothing but catching what is sent has a use for it in a package's code | Request catchers: webhook.site, Pipedream's `pipedream.net` endpoints, RequestBin, Request Catcher, requestrepo, Beeceptor. Out-of-band testing hosts: interactsh's `interact.sh` and `oast.*`, Burp Collaborator's, Canarytokens, DNSLog's `dnslog.cn`, CEYE's `ceye.io` |
| Remote | orange | It could be fine | Telegram's bot API, Discord and Slack webhooks, Pastebin, paste.ee, transfer.sh and file.io in a URL, 0x0.st. Tunnels: ngrok, localtunnel's `loca.lt`, Cloudflare's `trycloudflare.com`, Serveo. Pipedream's own API at `pipedream.com`. Bun's install script, `bun.sh/install` (now `bun.com/install`), which a worm ran its payload with |
| IP lookup | yellow | It usually is fine | ipinfo, ipify, ifconfig.me, icanhazip, ip-api, ipapi, `checkip.amazonaws.com` |

Each tag lists its services with their lines, and says so for a service that the version compared with didn't name.
A tag that names such a new service is raised one level, never past red.
Any text except prose and a source map is read for these hosts, comments included.

Between two stasis bundles, Compare also compares what each bundle records of a file besides its bytes:

- its format: a resource carried as data, or `module`, `commonjs` and the rest, run as code (a file with no recorded format also runs as code and shows as `none`)
- its execute bit
- whether it is an entry point of the bundle

A file whose record changed counts as changed, whether or not its bytes changed.
Its row in the Overview's Files, its head and its tree row say how it changed: `resource → module`, `+x` or `−x`, `new entry` or `entry`.
The tree row shows a format change as just `format`.
What the file no longer is (a cleared execute bit, a dropped entry point) is struck through.
A file whose contents read the same says the change in words.

Some characters read as something they are not, and would draw as a blank or as nothing.
Code shows each of them as a labelled box instead:

- the control and format characters, bidirectional and zero-width ones among them
- Unicode's other spaces (no-break, en and em, thin, ideographic)
- the default-ignorable characters (Hangul fillers, variation selectors, the grapheme joiner), each of which makes a name in code different from the one it looks like
- the Braille blank

The exceptions are an emoji's own joiners, presentation selectors and keycaps, and a subdivision flag's tags where Unicode recommends that flag (England's, Scotland's and Wales's).

Lines always wrap.

Code can hide whitespace changes as `diff -b` does.
A line that is re-indented, or has blanks added to a run of blanks or at its end, then reads as unchanged.
Blanks put between other characters, or taken from between them, still show.
Examples are `/tmp` to `/ tmp` inside a string, or `return x` to `returnx`, which `diff -w` would hide.

Code hides whitespace changes only in files whose whitespace means nothing outside their strings, on both sides of the comparison:

- JavaScript and TypeScript
- JSON
- CSS, SCSS and Less
- HTML, XML and SVG
- C and C++
- Java, Kotlin, Go, Rust, C#, Swift and PHP
- shell

A stasis bundle's file is identified by the format the bundle records for it (`module`, `commonjs`, `json`, `shell`, `cmake`, …), where it records one, whatever the file's name.
By recorded format, the list also covers Solidity, Objective-C and Objective-C++, Gradle, CMake and Xcode project (`pbxproj`) files.
Any other file is identified by its extension, or by a script's `#!` line.
That line must be one of a short list known to run Node, Deno, Bun or a shell (`#!/usr/bin/env node`, `#!/bin/sh`, …), matched whole, with nothing parsed out of it.
A format of another language, or an unknown format, counts as not listed.

Any other file may hold meaning in its whitespace, such as Python's, YAML's or Markdown's indentation, a Makefile's tabs, TSV's fields, or a language not listed.
Such a file shows all of its whitespace, and the toggle is not offered for it.
Whitespace changes are also not hidden in a file where that would hide blanks of more than one kind changing between the same two characters.
Examples are spaces turned to tabs, or a run of tabs and spaces made longer.
Such a file explains why in a note while whitespace changes are set to be hidden.
The toggle is offered only where hiding whitespace changes hides one, in the diff shown or in `diff -b`'s: in the file shown, or in any file in Code's list.

Manage pages require a manager or admin.
Team, report and team bundle URLs require the current user's team access.
Unavailable pages return to the landing page.
Files falls back to Findings when the reports have no multi-file source tree.
Switching between Findings and Files reuses the loaded reports and filters.

Managed and combined servers serve the same entry HTML for page `GET` and `HEAD` requests, including direct loads of nested URLs.
Assets resolve from `/`.
`/api` and `/api/*` always keep their API handling, including unknown routes.
Missing assets and requests other than `GET` and `HEAD` do not get the fallback HTML.

E2E and local mode do not use this page router.
A mode switch returns to `/` and invalidates the old managed history entries, so Back cannot reopen them.
History holds only a navigation generation, with no report or triage data.
The server mode's advertised default still applies on reload.

# Repository additions

Adding repositories requires a server admin.
Installed discovery defaults to the repositories the acting user can access on GitHub.
**Show all** lets admins choose any repository available to the repository App.
Effective permission checks use GitHub's [Get repository permissions for a user](https://docs.github.com/en/rest/collaborators/collaborators#get-repository-permissions-for-a-user) endpoint with an installation token.
That endpoint needs only **Metadata: read**, not Administration.

Public discovery lists the repositories the actor is involved with.
The separate **Add a public repository** input is available only to admins whose numeric GitHub ID is in `WHITEHAT` in `repository-policy.ts`.
Its endpoint is `POST /api/admin/repositories/add-public`.
It accepts `{ "repository": "owner/repo" }` or an exact GitHub repository URL, and applies the usual session, origin and CSRF checks.
It verifies public visibility without user credentials and stores GitHub's canonical metadata.
The allowlist bypasses only the public involvement safeguard.
It never grants server permission to add repositories, and never grants access to private repositories.

# Repository aliases

Admins add, edit and delete aliases in **Manage → Repositories → Aliases**.
Each row has:

- An old repository, as a GitHub slug or URL.
- An old path.
- A connected target repository.
- A new path.

An empty path means the repository root.
Repository names match case-insensitively.
Directories match case-sensitively, at path boundaries.
The longest matching old path wins, and the rest of the path below it is kept.
A mapping applies once and never chains.
For example, `org/a` with an empty old path can map to `org/b` at `projects/a`.
`org/c` at `a` can map to that same location.
An import that declares `org/c` at `a/src` is then assigned to `org/b` at `projects/a/src`.

For Stasis bundles, an alias can also match a directory shared by every bundled file.
For example, `org/c` at `a` maps to `org/mono` at `projects/a`.
A bundle that declares `org/c` with no directory, and has its files under `a/`, is assigned to `org/mono` at `projects`.
This works only when the part already in the file paths is a common suffix of the old and new paths, because files are never rewritten.
Imports decode the file inventory only when a compatible alias has an active destination.
Location suggestions apply the same rule to the file inventory already in the metadata, including resources.

Aliases are stored in `managed_repository_alias`.
They affect only the detected repository and directory of new reports and Stasis bundles.
Original bytes, individual findings, relative file paths and content hashes do not change.
Explicit bundle and report locations override detection.
Editing an alias or connecting a repository does not move existing content.
An identical reupload reuses the stored assignment.
Bundle and report location editors build their suggestions from the current repositories and aliases.
Only **Save** changes the assignment.

# Report repository metadata

Managed report headers show the repository assignment stored on the server, including its directory, even when the report embeds a different repository.
They do not offer the local **Set repo** editor.
Findings keep their own upstream repository metadata (for example, a dependency's repository).
Source links that need a report-level fallback use the server assignment.

Some reports have no report-level repository, such as Claude Security Markdown and Codex CSV exports.
Their findings name one instead.
As in the local report view, such a report stands for the single repository named by its findings outside the dependency directory (`node_modules/`, else `vendor/`, else `dependencies/`).
Any report-level `repo.directory` still applies.
A new upload without `X-Repo-Id` is assigned to that repository when it resolves to an active repository within the uploader's access.
It resolves through connections and aliases, like embedded metadata.
`X-Repo-Directory` still overrides the directory.
Otherwise the report stays unattached.

Such reports stay reassignable.
Their location editor reads `GET /api/admin/reports/:id/location`, which returns `{ location: { repoId, github, directory } | null }`:

- `repoId` is null unless the destination is connected and within the caller's access.
- `directory` is null when neither the report nor an alias names one.

`GET /api/teams/:id/reports` returns the complete **published** workspace.
The response is `{ reports }`, with one `{ id, filename, data, repo: { github, directory } }` envelope per report, plus `links` when finding links apply (see below).
The server derives the report list from that team's repository paths and the caller's membership.
Membership is required even for admins and managers.
Ordinary users receive findings filtered by that team's security and dependency grants.
Grants in other teams do not broaden the answer.
Admins and managers bypass those finding filters.
Unpublished reports are excluded from aggregate team responses for every role.
For admins and managers, hidden reports stay listed in the team catalog for individual access.

The optional `?reportId=:reportId` query parameter selects a report in that team:

- A published selection returns the same complete published workspace, which keeps cross-report classification.
  The viewer selects the individual report from it.
- An unpublished selection requires an admin or manager who is a member of the team, and a report inside its repository/directory scope.
  The response contains **only that report**, in the same `{ reports: [...] }` envelope.
  This isolated preview does not read or merge the team's published reports.
  It has its own query capacity, so a full published workspace cannot prevent opening it.
- A missing or out-of-scope report returns `404`, and so does an unpublished selection by a viewer or triager.

Aggregate reads and isolated previews both keep the existing query limits: 4,096 reports, and 1 GiB each for input and encoded response size.
Oversized requests return `413`.
The server rechecks access and publication after loading content.
If the workspace changed, it rejects the request instead of returning a stale response.

Links files are not stored as reports.
Admins import them in **Manage → Deduplication** as installation-wide link reports, with no repository or team assignment (see [Deduplication reports](STORAGE-ENCRYPTION.md#deduplication-reports)).
Uploading one through `POST /api/admin/reports` imports it the same way, and also requires an admin.
Each link report is enabled or disabled instead of published.
Security classification propagates across complete rows and all enabled links before dependency filtering.
Team and report responses return the resulting links as an optional top-level `links: [[findingId, ...], ...]`.
These links contain only finding IDs that remain in the response, and each one names at least two distinct findings.
Hidden or absent finding IDs can still connect visible findings, but are never disclosed.
Unpublished reports do not contribute to any role's aggregate view.

`GET /api/reports/:id` and `POST /api/reports/query` are reserved for admins and managers, under the existing ownership and team access rules.
An individual preview with `Accept: application/json` returns `{ data, repo: { github, directory } }`, plus `links` when finding links apply.
Other callers receive raw text.
`github: null` means unassigned.

Managed clients load report content on demand and cache responses only in JavaScript memory.
Aggregate responses are cached by team.
Isolated previews are also keyed by the selected report ID, and cannot populate the aggregate cache.
Catalogue or session changes invalidate these caches.
HTTP responses use `no-store`.
No report response is written to browser storage.

`GET /api/teams/:id/annotations` includes only published workspace findings, for every role.
With `?reportId=:reportId`, it returns annotations for the selected report:

- A published report uses whole-workspace classification.
- An authorized unpublished preview uses only that report.

Findings that appear only in hidden reports never enter the aggregate annotations.

Ordinary users supply `?team=:teamId` for report triage, history, comments and sources.
When scoped to a team, these endpoints authorize against the same published workspace or authorized isolated preview.
They recheck access after cold reads.
Triage and comments stay shared by finding ID across teams; the team is only the authorization context.

# Team App classification

Each team in `GET /api/teams`, and the team in a public link's bootstrap, carries `app`:

- `{ appMode: true, appFindings }` when its published workspace has a basic App view.
- `{ appMode: false }` otherwise.
  It usually also has `appReports`, the number of its reports that open in App mode on their own, and `findings`, its row count.
- `null` when it cannot be classified right now.

The sidebar shows the final state from the first paint:

- An App team opens collapsed to its App finding count.
- A team with reports, none of which opens in App mode on its own (`appReports: 0`), also opens collapsed, to its `findings` count.
- Every other team stays expanded.
  This includes a team that mixes App and non-App reports, and a team whose reports each open as App while their combined workspace does not.

The server classifies the same filtered workspace the team view loads, with the classifier the view uses (`common/managed/team-app.js`), before it sends the catalog.

A classification is keyed by the team's catalog cache key and its published reports' cache keys.
An unchanged catalog reuses it, and accounts with the same access share it.
These changes produce a new key and a new catalog revision:

- Publishing, hiding, moving or uploading a report.
- A grant or scope change.
- A link change.

Open sidebars then refetch the catalog and collapse or expand the team live.
Classification reads the team's published reports once per key, in memory on each server instance.
Oversized or unreadable workspaces have no App view.
If storage is unavailable, the team stays `null` (expanded) until a later catalog read succeeds.

# Live team updates

`GET /api/teams/:id/feed` is a read-only SSE subscription for an approved user.
One connection carries two invalidation events:

- `teams`: the current user's memberships, grants, repository scopes, team names, and visible reports and bundles across **all teams they belong to**.
  Its data is `{ revision }`, an opaque catalog version.
  The client refreshes `GET /api/teams`, and can reuse an identical snapshot.
- `triage`: visible triage and comments for **only the focused team**, with `data: {}`.
  The client refreshes the existing report annotation APIs.

Team feeds exclude unpublished reports from aggregate triage updates for every role.
`GET /api/teams/:id/feed?reportId=:reportId` uses the same selection and access rules as report reads:

- An authorized unpublished preview receives updates for that report alone.
- A published selection keeps the published workspace scope.

The selection does not change catalog updates.

`GET /api/teams/feed` sends the same catalog updates without subscribing to triage.
It works even before the user has joined a team.
Both event types are sent on connection when they apply, so a reconnect recovers missed changes without a replay cursor.
Notifications never contain finding IDs, annotation bodies, membership details or global history sequence numbers.
Writes still go through the existing `POST`, `PATCH` and `DELETE` routes.

The feed checks shared database state every 3 seconds, so instances using SQLite or Postgres see each other's writes.
Transactions finish before each wait.
Catalog reads do not write session timestamps.
Visibility is recomputed when the focused team's reports or grants change.
Concurrent access changes discard stale annotation reads.
Catalog notifications are sent before any report is parsed.
An unreadable report blob suspends only triage, which retries on later polls.
If the user loses the focused team, its triage subscription ends while the membership and catalog feed continues.
Logout, session expiry or a role change sends a terminal `event: close`, and the client must revalidate its session.

The UI keeps one feed and replaces it on navigation.
Home, bundles and Manage use the catalog-only feed.
The focused team's triage subscription starts after its reports hydrate.
Catalog updates do three things:

- Refresh the sidebar and landing links.
- Evict changed report, source and bundle caches.
- Reload affected open content if it is still accessible.

Logout and local mode close the subscription.
Live annotation reads keep pending local edits and refresh Fix metadata when needed.

Public-share feeds stay limited to the single capability workspace.
They never subscribe to the issuer's memberships or other teams.
Capability or workspace changes close them for revalidation.

Heartbeats run every 15 seconds.
Streams end after at most 240 seconds and reconnect.
Slow consumers are disconnected without queuing a backlog.

# Fix pull requests and issues

`GET /api/teams/:id/fixes` returns GitHub PR and ordinary issue metadata for the published workspace.
It requires an approved managed session (at least `view`) and membership in that team.
URLs come only from links saved on findings that survive the same workspace security and dependency filters as report reads, including whole-row and linked security propagation.
These are manual Fix links, plus saved issue links and their derived Fix PRs (see [Creating GitHub issues](#creating-github-issues)).
Admins and managers keep their security/dependency filter bypass.
The optional `?reportId=:reportId` follows the report-read selection rules:

- An authorized unpublished preview uses only that report's findings.
- A published selection uses the complete published workspace.

The caller supplies IDs, never a list of URLs.
The former `POST /api/github/pull-requests` and team `GET /api/teams/:id/pull-requests` endpoints are removed.

Each link's repository must match a repository assigned to this team, including for administrators.
Directory grants count as repository membership.
Links to other repositories are omitted entirely, even if their metadata is cached.
They keep the plain link presentation used in local/E2E mode.
Other Fix values are skipped.
An empty workspace returns an empty list.

The response is `{ fixes: [...] }`.
A successful item is `{ url, title, description, status, stateReason }`:

- `description` is GitHub's body text, or null.
- `status` is `open`, `draft`, `closed` or `merged`.
  Ordinary issues use only `open` or `closed`.
- `stateReason` is set on closed issues: `completed`, `not_planned`, `duplicate`, or `unknown` when GitHub gives no recognized reason.
  Other items have null.

Completed issues appear purple, like merged PRs.
Not-planned, duplicate and unknown closed issues appear muted, with distinct labels for the known reasons.
An eligible item without metadata is `{ url, error: "unavailable" }`, and still works as a plain Fix link.

`managed_github_metadata` stores titles, descriptions, statuses, closure reasons and fetch times, without eviction.
Records are shared by stable repository ID, item type and number.
Every read requires:

- The current user's membership in the selected team.
- That team's repository grant.
- A visible finding that carries the Fix link.

The GitHub repository ID and name must match the managed connection.
Explicitly public visibility (`private: false` and `visibility: public`) is stored in `managed_github_repository_visibility` and reused across viewers for one minute.
Only public visibility grants access.
Private permissions are never cached across requests.
Internal repositories and unknown visibility still require user access.

For private or unknown repositories, the server makes one live `/user/repos?visibility=private` request with the viewer's own token.
It authorizes matching repositories with read permission in the first 100 results.
Repositories missing from that page, or left unverified by a failed or malformed list, get individual repository lookups.
Pagination is not followed: absence from the list means unknown access, not denial.
These checks apply on every request, to admins too, and to cached closed or merged items.
The following return `unavailable` without exposing cached titles or bodies:

- Missing or expired credentials.
- Denied access.
- Redirects.
- Malformed responses.
- Failed access checks.

Cached data never grants access to another team, repository, hidden finding or unauthorized GitHub user.
After a repository becomes private, recently public cached metadata can stay visible until the next visibility check.
New content uses the viewer's token only after a live repository check, reusing checks already made in the same request.
This preserves GitHub's authenticated rate limit and keeps fresh private data from using a stale public grant.
Without verified credentials, public refreshes stay anonymous.
Failed refreshes keep the previously public data.
A newer private observation from another request also invalidates an in-flight public cache read.
Both SQLite and PostgreSQL create these tables for existing installations.

Refresh rules:

- Cached merged PRs are never requested again.
- Closed items also stay cached.
- Only open items (including draft PRs) older than one minute are queued for refresh.
- The exception is closed issues cached before closure reasons were stored.
  They are backfilled once successfully, and keep their old metadata on failure.
  A null reason marks these legacy entries.
  `unknown` completes the backfill even if GitHub gives no reason.

Database upgrades keep all existing cache rows.

Every workspace read returns the available cached metadata for verified repositories, including stale open items.
Its upstream queue takes missing entries first.
Remaining slots go to stale open entries and legacy closed issues, oldest first, up to 200 distinct items in total.
A larger workspace still gets a successful response.
Successful refreshes replace cached values.
Failed refreshes, or an exhausted refresh budget, keep the old data for viewers whose current GitHub access was verified.
Authorization failures keep stored data but block its release.
Cached entries are ordered by their latest successful fetch or refresh attempt.
A failed attempt moves the entry behind entries checked less recently, without updating its successful fetch time, so repeated failures cannot monopolize the backfill queue.
Only reads that actually start record an attempt.
Entries skipped by the cap, the deadline or missing credentials keep their place.

Live access checks cover only eligible Fix repositories, and deduplicate repository IDs.
Cached metadata for recently public repositories needs no upstream permission checks or user credentials.
Other repositories share one private-list request.
That request's fallback checks and the checks for public metadata refreshes share a budget of 200 direct repository checks, separate from the 200-item queue.
Unverified repositories beyond the direct-check budget return `unavailable`.
At most four upstream calls run at once.
Token refresh, repository authorization and metadata reads share one 10-second deadline.

Requests use the selected repository's stored full name and the validated item number.
They use the signed-in user's own GitHub token after live verification, or anonymous reads for public content.
Installation credentials are never substituted.
Redirects are rejected, and the returned repository and item identity is validated.
Workspace access and saved Fix links are rechecked after upstream work, before any metadata is released.

HTTP responses use `no-store`.
The browser keeps workspace metadata in JavaScript memory for one minute.
It invalidates that metadata on account, workspace, catalogue or mode changes, and after successful Fix changes once the complete triage flush finishes.
Color, flag and triage-only edits do not invalidate Fix metadata.
No browser storage is used.
Compact Fix previews show the title, status and description as plain text.

# Managed comments

Comments live in `managed_finding_comment`, separate from the shared triage row.
Each comment has:

- Its own ID.
- A finding ID.
- Text.
- An optional author ID and login.
- Optional creation and edit timestamps.
- A version.

Discussion posts are attributed to the authenticated user; the client cannot choose the author.
Readers see the discussion.
Users with triage access can add comments, and edit or delete their own.
Admins can also delete comments that have no linked author.
Edits and deletions require the version that was read.
A stale request receives `409` instead of overwriting or deleting newer text.

| Route | Body | Result |
| --- | --- | --- |
| `GET /api/reports/:id/comments` | none | Comments on the findings the user can see |
| `POST /api/reports/:id/comments` | `{ findingId, body }` | Adds a comment |
| `PATCH /api/reports/:id/comments/:commentId` | `{ body, version }` | Edits a comment |
| `DELETE /api/reports/:id/comments/:commentId` | `{ version }` | Deletes a comment and returns `204` |

Mutations require CSRF and current report and triage access.
Text must be nonempty and at most 10,000 characters.
Comments are shared across reports that carry the same finding.
The browser keeps them in memory only.

Unattributed comments are supported in normal operation, independently of migration.
Admin workspace imports (`POST /api/admin/reports/:id/import-triage`) create each imported comment through `createComment`, with a null author ID and login and a separate `actor` holding the admin's ID and login.
This records the action in history and Last activity without claiming that the admin wrote the imported text.
An import skips a comment whose text the finding already has.
Ordinary comment posts always take their author from the authenticated session.

`createComment` also takes `createdAt` and `updatedAt`.
Null keeps a date missing, and workspace imports pass null for both.
Omitting `createdAt` uses the current time, and omitting `updatedAt` uses the creation date.
New discussion posts always use the server clock.
Existing database tables are migrated to allow null dates without rewriting records.
The UI omits absent authors and dates.
An anonymous dated comment shows its date and text; an undated one shows only its text.
Audit events still record the time of the action, even when the imported comment has no known date.

Existing comment text on triage rows is migrated to unattributed records.
The last triage writer is not reliable evidence of authorship, so migration does not claim an author.
Each migrated text gets a fresh ID.
So if a rollback lets a legacy server write new comment text, the next migration adds it without replacing earlier comments.
The old column is cleared in the same transaction, so a restart does not migrate it twice.
Unattributed comments stay readable.
Users cannot claim or edit them, but admins can delete comments with no linked user.
Legacy triage history is preserved.
New comment writes to the shared triage field are rejected.
E2E, local and sync comment storage and editing are unchanged.

Comment additions, edits and deletions count toward scoped activity history and user Last activity.
Their text is never copied into the activity feed.
Ordinary triage updates and clears do not change comments.
Explicit repository annotation deletion also deletes comments, except on findings that other repositories share.

# Activity history

`/manage/history` reads `GET /api/admin/history?page=1&limit=100&kind=all&q=`.
The server returns `{ history, total, page, limit, filters }`, newest first, with at most 100 entries per page.
The type (`kind`), text (`q`), repository (`repo`) and user (`actor`) filters apply before pagination.
`filters.repos` and `filters.users` list the choices in the authorized history.
Pass the selected user's opaque `id` as `actor`.
Stored identities use `user:<id>`.
Older login-only records use `legacy:<login>`, and are never attributed to a current user by name.
Supported types are `triage`, `upload`, `visibility`, `access`, `repository` and `delete`.

Admins see all workspace activity.
Managers see uploads, publication changes, assignments and triage for reports and bundles within their current team access.
Reports also obey team directory scopes, including unpublished reports.
Repository administration, team changes and role changes stay admin-only.
Counts, search results and displayed context obey the same restrictions.
Deletion events use the content's repository and path at deletion time, and the manager's current grants.
Other events for removed content, and legacy bundle events without durable target IDs, stay admin-only.
The client keeps history only in memory, and responses are never HTTP-cached.

Uploads and triage changes already in the database appear automatically.
New uploads are recorded atomically with their metadata.
These are recorded after successful management requests:

- Report and bundle publication.
- Repository assignments and connections.
- Content deletion.
- Roles.
- Teams.
- Team access changes.

Edits that change nothing, failed requests and deduplicated uploads add no entries.
Upload and management snapshots survive content deletion.
Triage history follows `TRIAGE_HISTORY_LIMIT` and explicit triage deletion.

Older management actions were not recorded and cannot be reconstructed.
Older triage events may have no originating report name.
The feed contains actors, actions, targets and timestamps, never annotation bodies or credentials.

# Manager content access

Managers manage the reports and bundles they uploaded, and those they can reach through repositories assigned to their teams.
Access through teams also requires a matching directory scope, for both reports and bundles.
These rules apply to:

- Catalogues and downloads.
- Uploads.
- Visibility and assignment changes.
- Deletion.
- Triage.

Managers can review unpublished reports in scope.
Viewer and triage roles still require publication.
Administrators keep unrestricted content access.

Managers can upload unassigned content, and keep access to their own uploads.
Detaching or deleting attached content requires access to its current repository and directory.
Assigning content requires access to the destination.
Repository pickers list only allowed repositories.
Reports without embedded repository metadata can use the repository and directory controls on the upload page.
Report and bundle deduplication never returns inaccessible IDs or names.
Manager uploads auto-link only reports the manager owns or can reach through a team.
Repository connections, teams, memberships and user roles are admin-only.

Report publication, report and bundle reassignment, and deletion recheck the session, role and current repository grants inside the metadata writer transaction.
Uploads recheck role and destination access after storing the bytes, before committing metadata.
Permanent repository removal commits the metadata deletion, the exclusive annotation deletion and its audit record atomically.
Later blob cleanup uses only the rows actually removed.
If report references change during the annotation-overlap scan, removal returns `409` `repository-changed` without deleting data.
Refresh and retry the removal.

# Report storage and upload limits

Report uploads accept up to 25 MiB by default.
`MAX_REPORT_BYTES` changes this limit, up to 100 MiB.
The limit and the displayed byte size describe the original file, before storage compression.

New report bodies are compressed with Brotli quality 9, then encrypted when managed storage encryption is enabled.
Both disk and private Blob storage use `reports/:id.br`.
Reads decrypt and decompress in memory.
Downloads keep the original filename and bytes, and deduplication hashes the original upload.

Existing reports at `reports/:id` convert on their first read:

1. The server compresses their original bytes.
2. It reuses their existing encryption key when encryption is enabled.
3. It saves `reports/:id.br`.
4. It removes the old copy.

There is no separate compression migration job.
Encryption maintenance also understands the stored Brotli form, and verifies the original upload hash after decompression.

# Upload encryption in transit

A CDN or proxy that terminates TLS in front of the server, such as Cloudflare, could otherwise read every uploaded report, bundle and link report.
The browser therefore seals these uploads before sending them.
Each session has its own X25519 key pair, created on first use.
`GET /api/admin/uploads/key` returns the public key, and the private key stays in the session row.
For every file, the browser derives a fresh AES-256-GCM key by X25519 with a new ephemeral key, so the proxy sees only public keys and ciphertext.
Text is gzipped before sealing, and binary files are sealed as they are.
Large uploads are split into parts after sealing.

Sealed bodies carry `X-Upload-Encryption: 1`.
The server opens them with the session's key, and rejects:

- Altered bodies.
- Bodies sealed for another session.
- Content that exceeds the upload limit once decompressed.

Requests without the header are still accepted unchanged, so scripts and older browser tabs keep working.
This protects against a proxy that observes traffic.
It cannot protect against a proxy that modifies the page's JavaScript or substitutes the public key.
Downloads and JSON requests, such as triage and comments, are not sealed.

# Repeated imports

Uploading identical report or bundle content reuses its stored ID, even when the filename changes.
This also applies to workspace imports, retries after a lost response, and concurrent uploads.
A reused upload returns HTTP `200` with `deduped: true`, and a new upload returns `201`.
Reports keep their existing filename, repository assignment, publication state and source-bundle link.
CSV parsing must also agree, so an earlier unrecognized upload cannot hide a valid CSV report.

If a PostgreSQL commit acknowledgement or connection close fails, the uploaded bytes are kept, because the metadata may already be committed.
Retries reuse a committed upload with its bytes intact.
An uncertain commit that actually rolled back can leave unreferenced bytes for later reconciliation.
Definite insertion failures still clean up their candidate blobs.

A workspace import:

- Grants the new team access through the stored active repository and directory.
- Assigns unattached content when needed.
- Publishes the reports.
- Imports links files as global deduplication reports instead of publishing them.

Non-embedded reports and bundles assigned to inactive repositories move to the import's selected active repository, keeping their IDs and stored bytes.
Reports with embedded repository metadata still require that repository to be active.
Other reports use the repository typed for them in local mode, or else the one their findings name.
Like embedded repositories, these follow the current aliases at import time, and fall back to the selected repository when not connected.
Triage stays shared by finding ID and goes through the usual import conflict dialog.
Existing duplicate report rows are kept.
Later imports reuse the oldest matching record without creating another copy.

# User timestamps

The Users page reads Last activity from the latest retained triage, upload or management history entry attributed to that user's stable ID.
Reading pages, failed requests, unchanged edits and deduplicated uploads add no activity.
Last activity is derived, and never written to the user row.
Last seen tracks session authentication separately.
Upload and management entries keep their actor ID when content is deleted or an account is renamed.

Existing triage and uploads whose original metadata remains are attributable after an upgrade.
Older management entries recorded only a display login, so they cannot be safely assigned to an account after a rename or login reuse.
Users without attributable history show Unknown.
Triage retention and deletion still apply, because Last activity is derived from the retained history.

# Bundle creation

**Manage** → **Bundles** → **Create** opens a page where the user picks a connected repository, a branch, tag or commit SHA, and entry-point files from any of its directories.
**Create a bundle** calls `POST /api/admin/bundles/create`.
The server builds a Brotli-compressed Stasis source bundle at the selected immutable commit and stores it.
`@exodus/stasis/vfs-bundle` fetches the GitHub tree and rebuilds the dependencies in memory from the project's lockfile.
It never runs repository code or install scripts.
Supported remote projects are JavaScript/TypeScript with a pnpm, Yarn 1 or npm lockfile, and Solidity with Soldeer.
All entries must be in one supported language.
Node.js and Browser pass the selected export conditions.
Metro uses Stasis's Metro resolver for iOS/Android and requires its `react-native` condition unchanged.

A build runs from the nearest directory, at or above the common parent directory of the selected entry points, that holds a project manifest: `package.json` for JavaScript/TypeScript, or `foundry.toml`, `soldeer.toml` or `soldeer.lock` for Solidity.
If no such directory exists, the build uses the common parent.
Filenames follow `stasis github-bundle`:

- `owner-repo.<short-commit>.stasis.code.br` for a build at the repository root.
- `owner-repo.<directory-with-dashes>.<short-commit>.stasis.code.br` for a build in a subdirectory.

Nonportable characters become underscores.
A long directory is truncated, with a hash, so the filename fits in 255 characters.
A JavaScript/TypeScript project in a subdirectory with its own named `package.json` is instead named `<package>.<short-commit>.stasis.code.br`.
`<package>` is the name Stasis read from that `package.json`: `@scope/name` becomes `scope-name`, or just `name` when it equals `scope` or already starts with `scope-`.
The stored directory comes from Stasis's actual build root.

Creating a bundle requires:

- a same-origin request with a valid CSRF token;
- the manager or admin role;
- live GitHub read access to the repository;
- a managed grant that covers the resulting project root.
  That root can be above the selected files when a workspace lockfile installs them.

After the build, the server checks access and repository identity again.
Storage authorization is transactional.
If the bytes match an existing bundle, the server reuses that authorized bundle.

| Limit | Value |
| --- | --- |
| Concurrent builds | 2 across all instances that use the managed database (Vercel included), at most 1 per user |
| Build time | 3 minutes, counted from before admission |
| Lease expiry | 4 minutes, by the database clock |
| Worker heap | 512 MiB |
| Output | 200 MiB decoded, and the configured bundle upload size limit |

Shared database leases enforce the build limit.
Admission is atomic and happens before any GitHub request.
A disconnect cancels the build.
A slot is released only after its worker has terminated.
Leases expire so that a crashed instance cannot hold a slot.
Only the request that claimed a slot can release it.
Off Vercel, upstream's disk cache keeps what a build downloads (npm tarballs, version documents and the repository's tree) at its default location: `$XDG_CACHE_HOME/PreventiveMeasures`, or `~/.cache/PreventiveMeasures` when `XDG_CACHE_HOME` is unset.
On Vercel nothing is kept.

The HTTP thread writes `managed-bundle-build:` JSON records for each build.
Each record includes:

- a build ID;
- the repository and commit;
- the worker URL;
- the elapsed time;
- the stage: `worker-start`, `build`, `scope`, `serialize` or `compress`.

A failure record adds the underlying error's name, code, message, stack and cause, or the worker's unexpected exit code.
Diagnostics never include credentials or upstream HTTP response bodies.
The API still returns only its public error code.
A `completed` record means the worker returned bundle bytes.
Authorization and storage happen after it.

`GET /api/admin/repositories/browsable` feeds the repository picker on the creation page and in the code viewer.
It lists the active repositories the caller has a team grant for, or all of them for an admin.
It lists them by name only, without asking GitHub.
Every read of one of these repositories must pass both access gates, each time:

1. Managed access: the caller is an admin, or a team member (any role from view up) whose team has a grant for the repository, and the read is within that grant's paths.
2. GitHub access: the caller has GitHub read permission on the repository, or the repository is currently public.

GitHub confirms public visibility; the server never infers it from stored flags.
Internal repositories need a user permission check.
Admin status does not bypass the GitHub gate.
Only admins and managers can build a bundle from a repository.

`GET /api/admin/repositories/refs?repoId=…` returns the default branch and up to 100 branch and tag suggestions.
The user can also enter any branch or tag name.
With `&withDefault=true`, the response also includes `defaultContents`: the default branch's root directory and resolved commit, or `null` when there is no default branch.
The bundle picker uses this to load revisions and files in one request.
The nullable column `managed_selected_repo.cached_default_branch` stores the last live default branch, separately from the repository-selection metadata.
The server reads the branch and tag suggestions and the cached branch's root directory at the same time.
If the default branch changed, or was not cached, the server updates the hint and reads the current default's directory before it returns either result.

`GET /api/admin/repositories/contents?repoId=…&ref=…&path=…` returns a directory's entries and the resolved commit SHA.
That SHA pins later navigation.
These read-only endpoints each enforce the same two gates on their own.
Non-admins see only their teams' directory grants and the ancestors needed to reach them.
Both managed access and GitHub access are checked again after the source reads.
Private repositories are read with the configured repository App, but the App's installation access alone is never a user grant.
The existing upload and link pickers keep their managed-data permissions.
They do not grant live source browsing.

Within one request, the picker shares installation tokens and the GitHub identity lookup, but it checks each repository's current visibility and permission.
A request asks GitHub who its user is at most once.
For a repository last known private, it asks at the same time as it reads the repository's metadata.
The recheck after source reads asks again for the repository's visibility and the user's permission, but not for the user's identity.
If the identity has changed, the next request fails.

GitHub's answer that grants a user access to a repository is kept for five minutes.
That answer covers the repository's visibility, the user's permission, and which credential reads the repository.
It is kept per user, by their GitHub ID and token, and per repository, by its ID, name and installation.
`MANAGED_REPOSITORY_ACCESS_CACHE_MS` sets this time in milliseconds, up to an hour; `0` asks GitHub on every request.
Within that time, checks and rechecks for that user alone are answered from the kept answer, in the instance that asked.
Access that GitHub refuses is never kept.
Once GitHub rejects a user's token (`401`), nothing kept for that token is used again, whichever credential reads the repository, including a private repository's installation token.
The next check asks GitHub again, and falls back to the installation's token or an anonymous read as usual.

Concurrent GitHub REST GETs and read-only GraphQL queries share one outstanding request when their transport, URL, token and request body match.
This covers cold-cache activity reads and simultaneous access checks as well as refreshes.
The shared request lasts until its JSON body is read, and is removed on success or failure.
Later access rechecks still read GitHub when the access cache is disabled or expired.
Each caller gets its own result object and applies its own GraphQL error policy.
This layer does not share POST mutations or token mints.
It tracks at most 1,000 outstanding reads per transport; further reads run on their own.
The Commits tab reads open pull request heads in parallel with its history, so those independent GitHub queries add no serial wait.
Pulse's statistics and line totals share their contributors request, including GitHub's pending, empty and oversized statistics responses.
Managed access (roles, teams and grants) is still checked on every request.
Stale installation access falls back to anonymous source reads only after GitHub confirms that the repository is public.
Private and internal repositories stay gated.
The GitHub Contents API limits directory listings to 1,000 entries, and the page shows a notice when a listing reaches that limit.

`GET /api/admin/repositories/risk` is admin only.
It scans the npm lockfiles of every active repository at its default branch's head.
`?team=<id>` limits the scan to one team's repositories, and `?repo=<id>` to one repository.
It assesses each package the lockfiles lock the way `GET /api/npm/risk` assesses a version without `otherVersion`: against the version risk picks.
For a team, the scan reads only the lockfiles in the team's directories of each repository and in the directories above them, because a workspace's root lockfile locks those packages too.
The response is Brotli-encoded ndjson, sent as the scan goes; `repository-risk.ts` names each line type.
The lines are, in order:

- the repositories;
- each repository's lockfiles (`findRepoLockfiles`);
- each npm, pnpm or Yarn 1 lockfile's packages (`@preventive/lockfile`);
- each package's risk;
- `done`, last.

A response without `done` was cut short.
If the lockfile reader refuses a lockfile, its line says so (`lockfile-unreadable`).
The exception is a test's fixture or example: a lockfile under a tests directory (`test`, `tests`, `__tests__` and similar) and inside a fixtures or examples directory within it (`fixture(s)`, `example(s)`).
Such a lockfile is read like the rest, but left out when the reader refuses it, because a test may keep it unreadable on purpose.

On a serverless deployment (Vercel, whose function must answer within 300 seconds), a scan stops after 270 seconds.
It gives up on the work under way without waiting for it, and its last line is `continue` instead of `done`.
The page then asks again at once and keeps what it found, except that:

- it drops a repository's lockfiles when the repository's default branch moved on between parts, or a team's directories in it changed;
- it drops a repository that is no longer listed or was renamed;
- it replaces a lockfile's advisories when they are audited again.

The next part first tells, from what is kept, what the last part assessed, then goes on from where it stopped.
The page asks for at most 100 parts, and stops early when three parts in a row find nothing more.

Each part keeps the repositories it told completely for the next part, in `repository-risk/progress` rows.
These rows are keyed by the admin, the scan ID the page gives, and the scan's scope, and are kept for a day.
A part writes them as it ends, and waits at most five seconds for the write.
The next part does not tell those repositories again or ask GitHub about them, because the page already has them.
It still looks up their packages' risks, since their lockfiles are kept, so a scan of more repositories than one part reaches gets past them.
A repository renamed since, or whose team's directories changed, is read again.
A repository whose default branch moved on is told as the scan read it.

Repositories are read six at a time (`repository-risk-read.ts`) and told one at a time, in order.
Each read makes sequential GitHub requests (opening the repository, then reading its default branch's head), even when its listing and lockfiles are kept.
The scan reads with the admin's own GitHub access, through the same gate as browsing.
That gate is checked again when the repository's turn to be told comes, however long ago it was read, and before any of it is told.
When GitHub cannot be reached for a repository (`github-unreachable`), its line's `detail` and its row's tooltip say:

- what the scan was doing: opening it, listing its lockfiles, or checking access to it again;
- what failed, as the error and its causes describe it (for example a timeout, a closed connection or an answer that was too large);
- after how long.

They never include GitHub's text.

A package from npm's registry is assessed once per scan.
A package from another host with an integrity, such as a company's mirror, is assessed as npm's package of that name and version only when the lockfile's integrity is npm's.
A package from git, a tarball without an integrity, or a file is listed but not assessed.
npm and pnpm lockfiles say which packages only devDependencies need (`@preventive/lockfile`'s `dev`).
Yarn 1 lockfiles do not; only the `package.json` files say it.
A package that only devDependencies need, wherever a lockfile installs it, has `dev: true` in that lockfile's line.
A package that every lockfile in the scan marks this way is assessed only after all the others, stale ones included, because an install without devDependencies leaves it out.
The page tags such a package `dev`.
The page orders packages by risk alone, whatever needs them, so a riskier package that only devDependencies need is listed above a less risky one that production takes.
A toggle beside the filter shows all packages, those a production install takes, or those only devDependencies need.
Malware shows in every view, because it runs wherever it is installed, including CI and developers' machines.

When risk finds that a mirror's copy differs from npm's (`integrity-mismatch`), the package is flagged critical.
It is listed first after malware, not among the packages that could not be assessed.
Like malware, it is shown and listed whatever needs it.
Each lockfile that a package or an advisory is used in links to that lockfile on GitHub, at the commit read.

The **Advisories** tab shows the advisories of the versions a production install takes.
Those are versions that some lockfile needs for more than devDependencies, or whose lockfile does not say (Yarn 1's does not).
A toggle beside the search switches to the advisories of versions only devDependencies need.
Each advisory lists its versions of the selected kind, tagged `dev` in the dev view.
Each toggle shows how many advisories it holds.
A malware advisory is shown in both views, first, with all its versions, and the package it names is listed among the riskiest.

The page's progress area shows the scan's state: scanning and which part, done, or stopped.
It then shows one metric each for:

- repositories read, lockfiles read and packages assessed, each out of its total, with a bar;
- packages flagged;
- stale packages;
- advisories, with malware advisories counted separately.

Package metrics count production (`prod`) and dev-only (`dev`) packages separately, as the lockfiles read so far tell it.
A later lockfile that needs a dev-only package for more than devDependencies moves it to `prod`.

The packages of each lockfile that come from npm's registry or a mirror are sent to npm's registry advisories in one request, as `npm audit` does (upstream's `advisories`).
The result is kept by the lockfile's blob for an hour, in the instance's memory and in the database (`repository-risk/advisories` rows).
A failed audit, for example one that timed out, is kept for ten minutes, so the scan's next parts do not wait on it again.
The result goes out in an `advisories` line.
Each advisory says whether it is malware, as risk decides (`npmMalwareAdvisory`).
An advisory is malware when it is:

- OSV's record of a malicious package (`MAL-…`), or an advisory that such a record names;
- GitHub's CWE-506, embedded malicious code;
- an advisory whose title names malware.

The page lists advisories on a tab of their own.
A package that a malware advisory names is critical in its risk, whether it comes from npm's registry or a mirror.
The exception is a copy whose integrity is found to differ from npm's.
npm deletes every version it finds malware in, so a mirror's copy of such a version cannot be checked against npm's integrity, and it is treated as npm's.
Other advisories are vulnerabilities, not a supply-chain risk, and stay on their tab.

npm's registry lacks some of GitHub's malware advisories (those for nx's malicious versions, for example) and all of OSV's malicious-package records.
So the viewer's assessments and a scan's lockfiles also ask OSV (upstream's `osv`, risk's `npmVersionAdvisories`), for public packages only.
A private package's name is never sent to OSV, just as it is never sent to Socket.
In `bundle-advisories.ts`, a scoped package is sent to OSV only when npm answers for it anonymously (`isPublicNpmPackage`).
A version that npm has no document for is assessed as one npm removed (`npmRiskRemoved`).
If npm took its package down, risk reports it as `malware`, critical, whatever version is locked.
The same applies when a malware advisory names it: npm's, or OSV's when anyone can read the package (nx's malicious versions are only in OSV).
The page says so in its tooltip.
A missing version that nothing explains is shown as not on npm.

The scan also asks GitHub for each repository's npm Dependabot alerts, open or dismissed (`dependabot-alerts.ts`, `GET /repos/:repo/dependabot/alerts`).
Fixed alerts are skipped, because a fixed alert's dependency is no longer what it was.
GitHub returns 100 alerts a page, and the scan follows the cursor that each page's `Link` header names, up to 2,000 alerts.
When open and dismissed alerts together exceed that, the scan lists the open ones again on their own, so newer dismissed alerts cannot push any open one out.
A dismissed alert includes who dismissed it, when, why and their comment, or that one of the repository's rules dismissed it.
Alerts are read while the repository's lockfiles are read, and are never kept.
For a team, only the alerts of the team's directories are read, as with lockfiles.
They go out in a `dependabot` line after the lockfiles' advisories.
Each alert carries:

- the versions of its package that its lockfile locks and its range covers (none when the alert is for a file the scan does not read, such as a `package.json` or a bun lockfile);
- whether it is malware, decided as for an advisory.

Alerts are read with the App's installation token (`dependabot-access.ts`), never the admin's own token.
Sign-in may use an identity-only App, and an OAuth App's tokens (`gho_…`) read public data only.
The scan reads the alerts only after it finds that the admin's own access lets them see the alerts on GitHub:

- their sign-in is verified, as for private repositories;
- their permission on the repository is admin or write (maintain counts as write), the levels GitHub lets see Dependabot alerts by default.

The installation asks GitHub for that permission (`GET /repos/:repo/collaborators/:login/permission`), including grants through teams, the organization and the enterprise.
It is the same level that a private repository's access check already asked for.
This is stricter than GitHub, where a custom role or the security manager role can grant alert access on top of read access: those are refused.
That access is checked again, with a fresh GitHub request, just before the alerts are told, as repository access is.
If it was withdrawn in between, the line says why instead of carrying the alerts.
The scan uses the installation that GitHub says covers the repository now, and checks that its token can read that repository.
It never uses the installation the connection stored, which may no longer cover the repository.
The App needs **Dependabot alerts: read**.
When the alerts cannot be had, the line says why and the scan goes on:

| Code | Reason |
| --- | --- |
| `dependabot-not-installed` | The App is not installed on the repository. |
| `dependabot-unverified` | The admin's sign-in is not verified. |
| `dependabot-forbidden` | The admin's access does not let them see the alerts; the tooltip names their permission. |
| `dependabot-app-permission` | The installation is not allowed to read the alerts. |
| `dependabot-disabled` | The repository has Dependabot alerts turned off. |

The line also says so when GitHub cannot be reached.

The page blends alerts into its **Advisories** tab.
An alert for an advisory that npm reports, matched by GHSA (its ID or one of its aliases) and package, is kept with that advisory.
Where that advisory is used, the alert's lockfile links to the alert instead of the lockfile.
If npm did not report the advisory for that lockfile (for example, a lockfile the scan did not read), the alert's lockfile is added to where it is used.
For example, an advisory used in lockfiles A and B, with alerts in B and C, links A to its lockfile and B and C to their alerts.
A dismissed alert is paired the same way: its use is struck through, its tooltip says how it was dismissed, and the lockfile count says how many are dismissed.
An open alert that matches no npm advisory is listed on its own, with GitHub's range and the kind (production or dev) its versions tell.
If no lockfile read locks a version of it, its scope (development or production) is used instead.
A dismissed alert joins such a row, but never creates one of its own.
Above the table, a line says how many alerts, open and dismissed, were read from how many repositories, and for which repositories they could not be, each with the reason in its tooltip.

Assessments are `spare` ones (`npm-risk.ts`): at most two run at a time across the server, leaving the rest for readers.
They do not ask npm for each dependency's package or for the version's advisories, because each lockfile's advisories are asked at once.
Risk asks npm's downloads API for a package's downloads to judge its popularity and score.
That API answers about 40 lookups a minute, then answers `429` for a while.
So the scan readies each package's downloads before assessing it (`scan-downloads.ts`), and no assessment waits on that API:

- At once, as each lockfile is read: packages already kept, and unscoped packages, asked 128 at a time in one lookup (risk's `npmReadyDownloads`).
- One at a time, at the pace the API allows: scoped packages, which the API answers only one by one, while the assessors go on with the others.

Public packages' downloads are kept in the database (`npm-risk.ts`) for a week, as long as risk uses them.
The tier they put a package in, based on the highest of its latest six weeks, hardly moves in a week.
So another instance, or another scan that week, asks the API for none of them again.
A scoped package that a scan readies on its own is kept only when the API counts some downloads for it, since the API counts public packages only.
That way a private package's zero is never kept with public packages' counts.
An assessment refused as busy (`npm-busy`), or that npm asked to retry later (risk's `upstream-busy`), is retried after a wait, so a large scan goes at the pace npm allows.

A package's risk line carries its findings and risk's `score` for it, out of 100 (`risk/npm/score.js`).
The page shows the score in its **Risk** column: red from 75, orange from 50, yellow from 25, otherwise plain, as the viewer's ring does.
Malware scores 100 when npm's advisories also report it.
The page lists the riskiest packages first.
If a package's risk still fails, its line gives the error code.
When risk itself failed, the line also gives risk's `detail`: what it asked npm and how that failed.

A package's risk line is kept for good, in `repository-risk/lines` rows of `managed_upstream_cache` and in the instance's memory.
Each lockfile's packages are looked up as the lockfile is read, and kept lines are told at once, however old.
A line kept within the hour is told as it is.
An older line, or one kept before risk reported a score, is told as stale (`stale: { assessedAt }`), and the page dims it and says so.
Packages with no kept line are assessed first, and stale ones only after them.
Each line is told again once assessed.
If that assessment fails, the stale line stays and its tooltip says why.

Scans keep a repository's lockfiles as listed at a commit, and a lockfile's packages by its blob, in the instance's memory and for a day in the database (`repository-risk/listings` and `repository-risk/lockfiles` rows).
The lockfiles' packages, private repositories' included, are also kept in memory, and are told only after the reader's access is checked.
So a repeated scan, or its next part on another instance, asks GitHub only for each repository's head and access.
The database keeps public versions' documents for a day, with only the fields `readNpmVersion` reads (`npm-kept.ts`, `managed_upstream_cache`).
So a scan after a restart, or on another instance, asks npm for none of them again.
If npm has since removed a version, as it removes malware, risk finds it missing from the package's whole document, and the scan reports it as one npm removed.
Rows kept longer than they are used are removed as new ones are written, at most once an hour.
Risk's own per-package cache (`npm-risk.ts`) sits beneath this layer.

Closing the response, or leaving it idle for five minutes, stops the scan.
The page is `/manage/repositories/risk`, opened from the **Risk** button beside **Aliases** on the Repositories page.

# Bundle commits and tags

Bundle catalogs (`GET /api/teams` and `GET /api/admin/bundles`) send each bundle's `commitInfo`.
It holds what the cache has for the commit the bundle's summary records, in the repository the bundle is stored at, or `null` when the cache has nothing.
It is `{ sha, github, tags, details }`:

- `github` is that repository.
- `tags` names the cached tags that point to the commit.
- `details` is `{ subject, authorName, authorLogin, authoredAt, committedAt }`, or `null`.

The subject is the message's first paragraph on one line, as `git log --format=%s` gives it, without `Claude-Session:` lines.
The server never sends the rest of the message; only its cache keeps it.
There is no separate endpoint and no client-supplied commit.
Catalog access to the bundle is the only gate, as for its summary.
The cache is read before the catalog's final access check, so a bundle moved in between is sent without `commitInfo`.

The bundle view shows the tags after the commit on the Overview's GitHub row.
They link in `github`, even when the bundle's stamp names another repository.
The tooltips that show that commit (Overview, Code file link, team bundle rows) show its subject, author and date.
A tooltip that names that repository also lists the first eight tags under the commit and counts the rest.
Tooltips cannot scroll, so the subject is also cut at 200 characters there.
A commit link's tooltip starts its full hash with the commit icon.

`managed_github_commit` keeps details by stable repository ID and SHA, without eviction.
Commits never change, so a cached commit is never read from GitHub again.
A server build caches its commit, read with the builder's verified repository access.
A catalog never waits for GitHub.
After it responds, it reads up to four commits it lacked, with the viewer's own access (the source browser's public, user-token and App permission checks).
So the first catalog can lack them and a later one has them.
A viewer who cannot read a commit retries it after five minutes; another viewer may fill it sooner.
Details come from the first entry of GitHub's commit list starting at that SHA, checked against it, without the file list that `GET /commits/:sha` adds.
Messages are kept up to 65,536 characters.

`managed_github_tag` maps a repository's tag names to commits.
Only `refs` and `contents` reads write it, and both the bundle creation page and the code viewer make them.
Catalogs and the bundle view only read it and never request tags.
Each `refs` read refreshes the repository's tags from the listing its suggestions use.
A listing shorter than the 100-tag page lists every tag, so tags it leaves out are deleted.
A full page only updates the tags it names.
A tag that the revision input resolves through `contents` is stored even when it is beyond that page.
Each write happens before the request's access recheck, like other GitHub caches.

Each refresh carries the microsecond its request started.
A tag keeps the time it was last observed, and only a later observation moves it.
A complete listing deletes only tags observed before it, so tags that a newer partial update observed stay.
`managed_github_tag_listing` holds the last complete listing applied for a repository.
Any refresh observed no later than that listing is skipped, so an overlapping browse that finishes late cannot restore tags that a newer one deleted or moved.
Tags are removed with their repository.
SQLite and PostgreSQL create these tables for existing installations.

# Bundle metadata and contents

`GET /api/bundles/:id/metadata` returns the shared `common/bundle-metadata.js` format.
It contains:

- the file inventory, byte sizes and source hashes
- lines of code, excluding blank lines
- package identity and repository/package origins
- imports, entry points and executable flags
- language and code statistics

It excludes source bodies and binary resources.

A sourcemap's imports are the edges between its files.
The server reads them for every map with `oxc-parser` (`@preventive/sourcemap/edges.js`).
A client that reads a map itself sees only Metro's edges (`edges-lite.js`).
The graph draws these edges, and Code links follow each import's specifier to the file its edge leads to.

`GET /api/bundles/:id/contents` returns the original sourcemap or Stasis JSON after HTTP decoding.

Both endpoints:

- use `Content-Encoding: br`
- support HEAD
- send the compressed Content-Length when it is known
- send `Cache-Control: private, no-store`

Clients are expected to support Brotli, so there is no encoding negotiation.
Metadata is cached as Brotli.
Contents serve the stored Brotli bytes directly.
They do not wait for metadata or make another compressed copy.
Stasis uploads stay byte-identical.
Contents and downloads stream from disk or private Blob storage.
HEAD closes the stream.
GET streams with backpressure instead of buffering the whole bundle per request.

`GET /api/bundles/:id/pretty?path=&hash=` returns one of the bundle's files pretty-printed, as Brotli-encoded `text/plain`.
It serves the pretty-print toggle beside the wrap toggle in the Code tab, the source popup and the Search tab's source.
The npm viewer's `GET /api/npm/pretty` formats a package version's files the same way, all at once.

- The file is named by its path and the hash the metadata gives it (`sha512-<base64>` of its UTF-8 text).
- Only JavaScript, TypeScript, JSX, CSS and JSON files of at most 4 MiB are formatted.
- Formatting uses [oxfmt](https://oxc.rs/docs/guide/usage/formatter) and changes no more than layout needs.

The first request reads the bundle, checks the file's hash and formats the file.
Formatting runs off the event loop, two files at a time per process, with up to sixteen more waiting their turn.
The viewer asks for two files at a time.
`@preventive/compare`'s `format` checks the output independently of the formatter.
It compares a script's syntax tree as oxc parses it, a style sheet's as `css-tree` parses it, and JSON's strings and comments as written.

| Status | Error | When |
| --- | --- | --- |
| 409 | `hash-mismatch` | The file's hash differs from `hash`. |
| 429 | `pretty-busy` | Sixteen files are already waiting to be formatted. |
| 422 | `unformattable` | The file does not parse. |
| 422 | `pretty-mismatch` | The output differs from the file in more than layout (logged). |
| 422 | `unsupported` | There is no check for this kind of file. |

The Brotli bytes are kept in the bundle's cache directory, by content hash.
They are encrypted with the bundle's data key where storage is encrypted, and removed with the bundle.
Later requests stream the kept bytes as they are.
Access is checked before and again after formatting.
The endpoint supports HEAD.
Each copy names the file it was formatted from, by that hash, in `x-source-hash`.
The viewer accepts only a copy that names the file it asked about.

`GET /api/bundles/:id/pretty?other=` pretty-prints, for Compare, the files that changed between the bundle and the `other` bundle, on both sides.
A side's formattable file is included when either:

- the other side has a different text at the same path, or
- the other side has no file at that path, and none of the paths only the other side has holds the same text.
  So an unchanged file that was renamed, or moved with its tree, is left out.
  A copy of the text at a path both sides have does not count.

Each file is formatted, checked and kept as a single file is.
These are both files of each pair Compare diffs.
Where Compare pairs files differently (among copies of one text, or across packages), it asks for those copies one at a time, by `path` and `hash`, after this response ends.

The response is Brotli-encoded `application/x-ndjson`, one line per file:

- `{ side, path, source, text }` for a formatted file
- `{ side, path, source, error, status }` for a file that could not be formatted

`side` is `base` for the bundle asked about, or `other`.
`source` is the hash of the file the line was formatted from.
Kept copies come first, at once, with a few read ahead of the line being sent.
The rest follow as each is formatted, one after another: minified files first, then the others, each in path order.

Both bundles are read before anything is sent.
The reader must be able to read both bundles: the errors are 401 or 404 as for one bundle, and 400 `bad-bundle` when `other` is not a bundle ID.
Access is checked again before each line.
A public link reads only its own bundles.

`GET /api/bundles/:id/rename-diff?path=&hash=&other=&otherPath=&otherHash=` diffs one of the bundle's JavaScript files (`.js`, `.mjs`, `.cjs`) with one of the `other` bundle's files.
It serves Compare's **Hide renamed names**.
`@preventive/compare`'s `renamedDiffs` does the work in steps, each checked separately (`rename-diff-worker.js`).

Both files are pretty-printed, and kept, as `pretty` does.
Then the old copy is given the new copy's names:

- Both copies are parsed with `oxc-parser`, and each name is resolved, by JavaScript's scopes, to the variable it stands for.
- Lines that match once short names are set aside tell which variable became which.
  In a change where the two sides have different numbers of lines, lines that match except for a final `;` or `,` also count, weighted as a changed line's.
  An example is a declaration that others now follow: `let t = …;` → `let t = …,`.
- Each old variable takes the name of the new variable it most stands for, when that new variable most stands for it in return.
  The new name applies on every line, removed lines included.
- An old variable that no new variable stands for, but whose name the new copy uses, is renamed apart (`r_old`), so no line reads it as the new one.

The names given must keep every name that is read resolving to the same variable, and a global's to none.
No `var` may be named as a declaration of a block it passes through.
No function body's variable may be named as a parameter.

The renamed copy must then bind as the old copy did by oxc's minifier (`oxc-minify`), whose scope analysis is separate from the first one.
Both copies are mangled, so that every variable is named by its position alone, and the results must be identical.
A mistake in the first analysis therefore costs a file its names, never its meaning.

Checks that should never fail sit between the steps:

- each analysis is consistent: every name it would rename is written as that name where it is
- the pairing takes each new variable once
- every name given is a valid variable name, and is either its counterpart's name or one renamed apart
- the renamed copy, parsed again, binds as the old one with the names given, and oxc's semantic check finds no error in it

If any check fails, or anything else goes wrong, the old copy stays as it was (`unverified`, logged).
No reviewed file is ever given to Node's `vm` or otherwise compiled or run; oxc only parses it.
The renamed copy is not formatted again: each of its lines stays where the old copy's line was.

The two copies are diffed twice from the names found once: as they are, and as `diff -b` reads them.
Each diff's change blocks are checked to take the old copy's lines to the new copy's:

- every line between blocks is alike, except under `diff -b` for how much whitespace it has
- in the plain diff, a line after which a newline was added or dropped is the last line of a block

The worker checks this, and the server checks it again.
If either check fails, the answer is 422 `undiffable`.

The answer is Brotli-encoded JSON with these fields:

- `before`: the old copy as diffed.
- `blocks`: the change blocks, each `{ a0, a1, b0, b1 }`, meaning the old lines `[a0, a1)` are replaced by the new copy's lines `[b0, b1)`.
- `reason`: why the names could not be given safely, with `before` then the old copy as it was.
  The reasons are `unparsed`, `dynamic` (for `eval` or `with`), `jsx`, `block-function` and `unverified`.
  `block-function` is a function declared in a block outside strict code, where it also sets its function's variable of that name.
- `reads`: the properties either copy reads through which a program may read a name, so a rename may change what it does.
  These are `name`, `toString`, `stack`, `callee` and `caller`, read as a member's or a pattern's key (`.name`, `const { name } = f`) or as any string written out as one (as `Reflect.get(f, "name")` reads it).
- `marks`: the change blocks of the diff of the two pretty-printed copies whose old lines, given the new names, are their new lines, with no newline added or dropped after the last line.
  It is empty where names were not given.
  The server checks that they are blocks of such a diff, in order and with as many lines on either side.
- `ignoringWhitespace`: the `blocks` and `marks` of the `diff -b` diff, checked the same way, so the viewer's **Hide whitespace changes** asks for nothing again.
- `hash` and `otherHash`: the two files' hashes, which the viewer checks are those it asked about.
- `prettyHash` and `otherPrettyHash`: the hashes of the two pretty-printed copies the diff was worked out from, which the viewer checks are those of the copies it draws.

Each diff runs in a worker thread, off the event loop, two at a time per process.
Up to sixteen more wait their turn, since Code's one list asks for every file it shows at once.
Past that the answer is 429 `diff-busy`.
A diff may take at most a minute, its wait included (504 `diff-timeout`).
A file that does not format is refused as by `pretty`.
The last 32 answers are kept in memory by both files' hashes.
Even for a kept answer, each side is first read through the pretty-print cache.
The reader needs access to both bundles, checked before and again after the diff.
A public link answers only for two of its own bundles.

`GET /api/bundles/:id/rename-diff?other=`, without a file, diffs in one request every pair of JavaScript files that are minified on both sides and changed between the two bundles.
Compare's Diff view and tree want them all.

- Pairs are formed as the viewer pairs them (`computeBundleDiff`): at one path, or renamed within a package as the bundles record their packages (`bundlePkgOf`).
- Pairs are diffed in path order, one after another, leaving a worker free for the files a viewer asks for alone.
- Each pair is diffed from both sides' copies, kept or made as `pretty` keeps and makes them.

The answer is Brotli-encoded ndjson, one line per pair, sent as each is worked out.
A line is the answer for that pair asked about alone, plus both files' paths, `path` and `otherPath`.
Where there is no answer (a file that does not format, or the server is busy), the line is `{ path, hash, otherPath, otherHash, error, status }`.
With `&scope=reason:<tree>`, as a Compare narrowed to a tree of Stasis bundles asks, each side's files are those of that tree alone (`bundleCompareFiles`), paired as that Compare pairs them.
Access is checked as for `pretty?other=`, and again before each line.
The viewer asks for a pair alone when it pairs it differently, or when the server was too busy for it.

`GET /api/bundles/:id/comparison?other=` compares the bundle with the `other` bundle for Compare's Overview and Code (`comparison.ts`).
It returns:

- the files each side has alone
- the files that changed, at one path or renamed, paired within a package as `compareTrees` pairs them (`common/bundle-comparison.js prepareComparison`), with their sizes, lines and recorded changes
- the packages, dependency versions and import resolutions that differ
- the totals

The viewer of a managed bundle pairs nothing itself.
It pairs only bundles it opened from disk, which no server holds, in a chunk loaded for those alone.
With `&scope=reason:<tree>`, each side's files are those of that tree alone.
The answer is Brotli-encoded JSON, sent once worked out.
The bundles are read one at a time, as the pretty-printed copies read them.
Where the two sides' roots differ, `files.root` is the directory one side's files sit under in the other's.
`files.basePaths` then lists each base file's path as the other side lays it out, as `[path, laid out]` pairs; otherwise it is empty.
Access is checked as for `pretty?other=`, and again before the answer is sent.
A public link answers only for two of its own bundles.

`GET /api/bundles/:id/type-only?other=` tells which changed TypeScript files changed in types alone, for Compare's **Hide type-only changes**.
It covers every changed, added and removed file, paired as the viewer pairs them.
A file counts only when `@preventive/compare`'s `compareTrees` stamps its change `typeOnly`, and nothing else decides it.
`compareTrees` stamps a change `typeOnly` only when:

- each side present is a file named as a declaration file (`.d.ts`, `.d.mts`, `.d.cts`, `.d.css.ts`)
- its `proveTypeOnly` proves each side holds types alone, apart from a runtime its stripping leaves: module loads, bare `export {}`, directives and pragmas
- the change leaves that runtime as it was: a removed file's runtime must be empty, and an added file's empty or a single bare `export {}`, which nothing loaded before
- a rename across module formats qualifies only when that runtime neither loads a module nor keeps an `export {}`

Proving needs Node's type stripping, so the viewer can't do it.
Each pair is given to the engine on its own, as a tree of one file per side.
When the engine does not take two paths for a rename, the pair is types only when each of its two changes is.
That means the removed file erases whole, and the added file erases whole or leaves a single bare `export {}`.

Proofs run in a worker thread, off the event loop, one comparison at a time per process, with up to sixteen more waiting.
Past that, or past a minute, the response is cut short.
The answer is Brotli-encoded ndjson, sent once all pairs are proven, one line per pair that changed in types alone: `{ path, hash, otherPath, otherHash }`, with null for a side that is not there.
The viewer checks that each line names the files it shows.
With `&scope=`, it works within a tree, as `rename-diff?other=` does.
Access is checked as for `pretty?other=`.
A public link answers only for two of its own bundles.

`GET /api/bundles/:id/advisories` uses `@preventive/upstream` to audit the stored bundle's dependency ecosystems, names and versions.

| Ecosystem | Advisory source |
| --- | --- |
| npm | The registry, plus OSV (upstream's `osv`) for packages anyone may read, for the malicious packages' records the registry lacks |
| Cargo, Composer | OSV |
| Soldeer, GitHub | Published repository advisories |

A scoped npm package goes to OSV only when npm answers it anonymously (checked with a HEAD request, `isPublicNpmPackage`), so a private package's name never leaves for OSV.
Modules without an ecosystem keep the legacy npm lookup when installed under `node_modules`.
The root module is excluded.
As in `stasis audit`, a dependency must have a recorded evidence file.
Manifests and the verified browser stubs of `ws` and `node-fetch` do not count.
Entry and manually added code count without an import edge.

These are returned as `skipped`, with a reason, and are never sent upstream:

- Composer dev versions
- git or unknown-source crates
- unsupported ecosystems

GitHub branch `.` is normalized to the unknown-version placeholder `0.0.0`, which upstream conservatively matches against every advisory range.
Optional `?reason=<name>` limits the lookup and the skipped list to dependencies with evidence files in that bundle reason.
An unknown reason returns 400.

The shared metadata build also persists a separate inventory, including the named scopes.
An advisory request buffers at most 1 MiB of it before parsing, without decompressing the full file inventory.
An oversized package inventory returns 413 before upstream is contacted.
The versioned inventory rebuilds older npm-only and unfiltered caches.
The API accepts no bundle body.
It returns `{ packages, skipped, advisories }`, all arrays:

- `packages` entries contain `{ ecosystem, name, versions }`
- `skipped` entries contain `{ ecosystem, name, version, because }`
- `advisories` rows keep upstream's IDs, matched versions and source, plus optional severity, title, CVSS and range

Failures return 502 with `upstream-unavailable`, without source contents or scan findings.

The managed Advisories tab loads it directly, without a consent prompt.
It lists dependencies that could not be audited separately from the results.
Its **Recheck against repositories** button sits immediately right of the scope selector.
The button requests `?repoAdvisories=true`, which passes the same upstream option as `stasis audit --repo-advisories`.
This adds maintainer-published advisories for npm, Cargo and Composer dependencies, including ones not yet in the registry or OSV results, with upstream's version matching and deduplication.
Rechecks use the selected reason.
GitHub rate limits and the 30-second caller deadline still apply.
During the request the button shows **Rechecking…** and is disabled.
Transient failures keep the previous results; a denied or missing bundle discards them.
For admins and managers, a **Validate** button right of it opens Scans on that bundle with Dependency alerts selected (`/manage/scans?bundle=<id>&mode=dependencies`).
Neither button is shown when the bundle's unscoped audit finds no packages, audited or skipped.

Once a bundle's modules are loaded, the tab is hidden when none of them is a dependency package (a non-root module with an ecosystem, name and version).
The exception is when Advisories is the open tab.
Switching bundles (to a sourcemap too) or following a link keeps Advisories open, as it keeps Compare open without another bundle to compare.
Only losing security access, or a bundle known to have no package versions to audit, returns the viewer to Overview.
Such a bundle never shows the tab.
It is a Stasis bundle before format version 1, or one whose catalog summary counts no versioned packages (`versionedPackages`).
Catalogs send both in the summary, so the tab is hidden before the bundle opens.
A parsed v0 bundle without a summary yet hides it too.
Managed bundles have no Issues tab: the Code tab shows each file's issues.

For initial audits and repository rechecks alike, GitHub requests use the current viewer's stored access token, refreshed within the audit deadline when needed.
Public shares and viewers without a usable token use an anonymous client.
Credentials are sent only to GitHub, never to npm, OSV or the other registries.
If GitHub rejects the token with 401, that repository lookup is retried anonymously, and the rest of the audit uses anonymous GitHub access.
Other failures do not trigger this fallback.
Ordinary npm-only audits contact only npm and OSV, never GitHub.
The repository recheck adds GitHub requests.

Off Vercel, an audit's records are kept in upstream's disk cache at its default location, as builds' records are:

- each repository's published advisory listing (repository rechecks, and Soldeer and GitHub dependencies), for 90 minutes
- the npm version documents and registry lookups that find a package's repository

On Vercel, only the listings are kept, in `managed_upstream_cache`, for the same 90 minutes.
They are shared by every viewer, public share and instance, because only public repositories publish advisories.
Nothing else is kept there or on disk.
Upstream stamps, checks and expires the entries.
A refresh replaces the repository's single row.
An expired listing stays, so the npm Overview's advisories (`GET /api/npm/advisories`) can use it where GitHub can't be reached.

An audit reads the listings of the repositories it already knows in one query, because a request's queries share one Neon connection.
These are:

- GitHub dependencies
- Soldeer dependencies' recorded repositories
- on a recheck, every dependency's recorded repository

Listings of repositories that upstream looks up, or all of them if that query fails, are read one at a time.
A cache read or write failure is treated as a miss and never fails the audit.

To read advisories, view/triage users need bundle access and the team's `security` permission; `dependencies` is not required.
The `dependencies` permission gates scan findings in dependencies' own code, while findings about effects on the app stay visible.
Managers and admins keep their normal full access to authorized bundles.
An optional `?team=<id>` restricts the security grant to the selected team.
Access is checked before reading the inventory, before contacting upstream, and before returning the result.
The endpoint is available on standalone managed, combined and managed Vercel servers.

User repository discovery and public repository metadata also use `@preventive/upstream`'s GitHub client, with its argument validation, response limits and bounded pagination.
Managed filtering still:

- skips archived repos
- requires explicit public visibility for public additions
- checks effective user permissions on installed nonpublic repositories

Installation discovery and token minting keep their managed credential cache.

`GET /api/bundles/:id/download` keeps the uploaded filename and bytes.
Sourcemaps use HTTP Brotli decoding, while Stasis downloads stay `.br` archives.

Sourcemaps are compressed once, to `bundles/:id.map.br`, and the uncompressed `.map` is not kept.
The DB keeps the original filename, byte size and integrity, so deduplication and report hashes keep working.
Sourcemaps and metadata use Brotli quality 4, to avoid slow maximum-quality compression.

The cache lives beside SQLite under `cache/bundles/:id/`, or in private Blob storage for Neon deployments.
Persistent servers schedule prebuilds on upload.
Vercel functions build missing derivatives during authorized reads.
Builds are deduplicated and serialized to bound memory, with a 512 MiB decoded limit.
Files are published atomically.
They are removed when the bundle or its repository is deleted, even when a build was already in flight.
Invalid or unsupported bundles can still be downloaded as uploaded; metadata requests for them return 422.
Contents pass through without parsing; metadata generation still validates them.

Report-scoped `/api/reports/:id/sources` responses use a separate gzip cache, backed by disk or private Blob storage.
Derivatives are shared by report hash and filename format.
They are scoped to the source paths cited by the team's visible finding members, including evidence, even when members share a finding ID.
They are removed when their last report reference or their bundle is deleted.
Cold builders recheck references after publishing, to reconcile a concurrent deletion on another instance.
Authorization is checked again before sources are streamed.
A sourcemap's import links there follow the edges its bundle metadata keeps, read with the parser once, rather than read again for each derivative.

Admins can read and manage every bundle.
Managers can read and manage bundles they own or can access through their teams.
View/triage users need a visible bundle and team access.
The `none` role has no bundle access.
Ownership survives repository attachment.
Adding a repository location requires bundle management access and access to the destination repository and directory.
Changing visibility, detaching or deleting a bundle requires access to its current location, even for its owner.
Manage lists and repository pickers enforce these rules on the server.

Bundles store a repository and an optional directory, edited together from Manage → Bundles, like report locations.
Uploads accept `X-Repo-Id` and a URL-encoded `X-Repo-Directory`.
`POST /api/admin/bundles/set-repo` accepts `{ bundleId, repoId, directory }`.
For new Stasis uploads without an explicit repository, the bundle's `repo.github` defaults to a matching connected repository (case-insensitive), with `repo.directory` as the directory default.
Explicit upload locations override these defaults.
Unmatched origins, and stamps outside the uploader's repository/directory grants, stay unattached.
Managers can later assign their unattached uploads to an allowed location.
Explicit upload destinations still require access.
The location editor shows the original self-reported repository and directory from bundle metadata separately from the editable assignment.
Upload inference decodes only the bounded origin header, before any source contents.
The usual repository and directory grants apply.
Root is stored as an empty directory, and existing bundles migrate to root.
Detaching clears the directory, and deduplicated uploads keep the stored location.

Manage → Bundles has show/hide controls and a visibility filter.
Bundles are visible by default, including existing bundles after an upgrade.
Hiding a bundle removes it from:

- view/triage catalogs
- direct reads and downloads
- advisories
- public workspace links

Managers and admins keep their existing access.
Hidden bundle and report names appear muted in management lists and the team sidebar.
`POST /api/admin/bundles/set-visible` accepts `{ bundleId, visible }` with CSRF protection, and rechecks management access in the write transaction.
Visibility changes update live catalogs and leave linked reports' publication state unchanged.

A team granted `/` sees visible bundles in that repository.
A team granted `/foo` sees bundles at `/foo` and `/foo/*`, but not at root or `/foobar`.
This applies to team catalogs, public workspace links, direct bundle access, advisories and manager activity.
Directory edits also refresh open clients' catalogs.

Opening a bundle at once shows what its catalog entry already holds: name, location, size, and its GitHub origin, commit and tags.
Its files appear once its metadata arrives.
Its URL follows a successful open, and a failed open still lands on the home page.
A tab picked meanwhile keeps the bundle and still receives its files, or the reason it has none.

A catalog bundle's `summary` holds:

- its file, code file and LoC counts
- the commit its Stasis stamp records (`commit`)
- for a Stasis bundle, its format version (`stasisVersion`, 0 for legacy bundles)
- for a Stasis bundle, `versionedPackages`: the number of name@version pairs its unscoped advisory audit covers, audited or skipped, from the same inventory (evidence files included) the advisories route uses

Summaries are cached per bundle as `v5-summary.json`, and the bounded backfill rebuilds missing and older ones.
Until the backfill reaches a bundle, catalogs send its `v4-summary.json` as is, without `stasisVersion`.
A bundle with only an older summary has none until then.

Opening a bundle downloads its metadata into managed app memory.
Code, Terminal, source search and source comparison request contents when needed, and the browser handles HTTP Brotli decoding.
Neither payload enters OPFS, IndexedDB or localStorage.
Session or role changes clear managed caches and terminal state.

# Repository code viewer

Team members with the view role or above read a connected repository's files in the bundle view, the same way an npm version shows.
The view has the Treemap, Code, Search, Compare and Activity tabs.
A team member reads a repository where their teams' grants reach it and their own GitHub account may read it (or it is public).
Admins read every connected repository.

A repository opens from either of these:

- the `</>` on its row on the Repositories page;
- its row on a team's Repositories tab.

Its route is `/repo/<repo id>`.
It opens the default branch's head, and the route then names the commit it opened (see Page routes).
A link or a reload therefore opens the same files, wherever the branch has moved since.

The header picks the repository, among those the reader may browse, and the revision: a branch, a tag or a commit.
It picks the revision the same way Create a bundle does; both use `ui/view/revision-select.js`.

- Another repository opens at its default branch.
- Another revision opens the same directory there, on the same tab.
- A typed revision opens on Enter.
- Back names a revision the way it was opened.

A revision opened by its commit, as from a link, is named by the branch whose head it is, the default branch first.
Where no branch has it as its head, it is named by the tag on it, else by its commit.
For this, the repository's branches and tags are listed with their commits (`branchCommits`, `tagCommits`).
The default branch is read separately where the first page of a hundred branches, sorted by name, leaves it out.
The branches and tags are read again each time a directory opens anew.
That includes switching to another tab from a page opened on Commits, Issues, Pull requests, Agents, Pulse or Replay.
Until GitHub answers, and also where that read fails, the header names the revision by the branches and tags read before.

Between the repository and the revision, the header shows the directory's path in the repository, and each part opens its own directory.
After them, it shows the commit, linked to its tree on GitHub.
The path, the revision and the commit do not show on Issues, Pull requests, Agents or Pulse, which read the whole repository whatever its revision and directory.
Replay shows them, since it plays the revision's history.
The revision and the directory are kept for the other tabs.
Each file's head links the file on GitHub at the commit.

A directory too large to read whole, or one the reader's grants reach only part of, says so.
It lists its directories to open instead, as browsing lists them (`GET /api/admin/repositories/contents`).

`GET /api/admin/repositories/code?repoId=…&ref=…&path=…` answers the directory's files, Brotli-encoded, as `{ repoId, repo, commit, path, tree, files }`.
The files take the same form as a version's in `GET /api/npm/package`: keyed by their paths in the directory, with text inline and a digest for files that are not UTF-8.
The viewer holds them in memory only while it shows them.

- It is read as browsing is, with the same two gates and the reader's own GitHub access.
- It is read only where the reader's grants reach the whole directory.
- An ancestor of a manager's grants is `404 no-directory`, and so is a directory the commit does not have.

Before the server asks for the tarball, it reads GitHub's listing of the directory's tree, with every tree under it.
That listing says whether the directory fits the first two bounds below; else the answer is `413 directory-too-large`.
These bounds are the directory's own, separate from a package's (`repository-code.ts`).
The server then reads the tree's tarball.
It verifies the tarball against the tree's id, as bundle builds verify theirs, and keeps it in upstream's disk cache with theirs.
The tree a commit has at a directory, and what a tree holds, never change.
The server keeps both in memory by the repository's id for the next reader, and reads them from there only once the reader's own access has named the commit.
The tarball is read as a package's is, within these bounds:

| Bound | Limit | Past it |
| --- | --- | --- |
| Files in the listing | 80,000 | `413 directory-too-large` |
| Bytes in the listing | 256 MiB | `413 directory-too-large` |
| Tar stream | 384 MiB | `413 directory-too-large` |
| Tar entries | 160,000 | `413 directory-too-large` |
| Files' JSON | 384 Mi characters | `413 directory-too-large` |

Symlinks are the one difference from a package: a symlink may climb as far as the repository's root, as a monorepo package's LICENSE links the root's.
An archive that `@preventive/archive` refuses is `422 directory-unreadable`: one holding an absolute symlink, or a symlink that climbs past the repository's root.

Readers asking for the same directory at the same time share one load, which counts among the npm viewer's loads.
It takes as many of their four places as packages its listed files would fill, all four at most; past them, the answer is `429 repository-busy`.
Its files' JSON is held to what a package's may take for each place it holds (`413 directory-too-large` past that), because the listing cannot tell how much escaping grows it.
Access is checked again once the directory is read, before any of it is sent.

While a directory's files are read, or where they are too many to open, its **Treemap** is drawn from file sizes alone.
The sizes come from the commit's tree listing (`GET /api/admin/repositories/tree`, which Replay also reads, below), which arrives sooner.
None of the files' text is read, so a file's cell opens nothing and its packages are told by their paths alone.
Where the listing leaves files out (the deepest, past 75,000), the Treemap says that the files drawn are those nearest the root.
A directory opening on its Treemap shows this Treemap while its files are read, instead of waiting for them.
It is drawn at the directory's commit; where the route names no commit, listing the repository's root names it.
Once the files are read, the Treemap is drawn from them: their packages are told, and each file opens its source.
A directory whose files are read already reads no tree.
A directory too large to open says why on its Code, Search and Compare tabs, and lists its directories to open instead.

## Compare

The **Compare** tab compares the directory with itself at another revision, as an npm version's Compare compares it with another version (`ui/view/repository-compare.js`).
Its Overview lists the files each side adds, removes and changes, each with its type's icon.
Its Code reviews them as a diff.
It shows none of a package's risk, alerts or dependencies, and none of a bundle's Packages.

Both sides pick a revision as the header does: a branch, a tag or a commit.
The first side is the revision compared with.

- Picking the first compares with it.
- Picking the second opens the directory there, compared with the same first.
- **Swap** opens the first, compared with the second.

The revision compared with is read as the directory is (`GET /api/admin/repositories/code`).
The route then names the commit read, `/compare/<commit>`, with `/code` past the Overview.
For the session, the picker names that revision the way it was picked.
Another tab of the directory keeps it, so Compare opens with it again.

## Activity

The **Activity** tab shows what happens around the code, in six views.
Each view is its own route's tab (`commits`, `issues`, `pulls`, `agents`, `pulse`, `replay`):

- **Commits** (below);
- **Issues** and **Pull requests**;
- **Agents**;
- **Pulse**;
- **Replay**.

Activity opens on the view last shown, and on Commits until one is (`ui/view/repository-activity.js`).
Each view's bar starts with the view picker, one icon per view: a commit on its line, an issue's ring, a pull request's branches, a robot's head, a pulse's beat, and a play button's triangle.
The picker works like the graph's layout picker: it switches the view as a tab does, and Back returns to the view before.
What a view read stays in the page after its time is up, and stays shown while it is read again (`ui/view/held-read.js`).
It is never blanked, only replaced by what the new read answers.
Where that read fails, the old answer is kept and read again a while later.

## Commits

Activity's Commits view lists commits as `git log --oneline --decorate --graph` does, one compact line each.
A line shows the commit's short id, the branches and tags naming it (the default branch's first, the revision shown marked), its subject, author and time.
Beside the lines is the graph of the lines its parents make (`ui/view/history-graph.js`).

- Commits list newest first, and never a parent before its child.
- A merge's other parent takes a lane of its own, and lanes waiting on one parent join where it comes.
- Each line keeps a color of its own, unlike its neighbors' where it can.
- The default branch has its own first lane and color.
- A parent not listed shows as a short dotted line.

**All branches** and **Unmerged** pick what the view lists.
All branches, the default, lists every branch, as `--all` adds them.
Where reading every branch needs the reader's GitHub sign-in, the view lists the revision shown's own history instead, with the commit shown first and nothing to pick.

Unmerged lists the branches All branches read that are not merged.
It lists the commits the default branch does not reach, as `git log --all --not <default>` does, each branch down to where it began.
A squash merge reaches its pull request's commits (below).
It lists only commits newer than the oldest commit read of the default branch's own line.
The commit that merged a newer one would be newer still, so it is read already.
An older one may be merged where the default branch is not read that far yet, and shows so as more of the default branch is read.
Unmerged reads as All branches does and is not read again.
Its **Older commits** waits for a click, as a page may add none of its lines.

**Older commits**, in either mode, reads on from where the listed commits stop:

- It reads from their parents not listed, and, for All branches, from the branches not read yet.
- It reads the newest 25 first, a parent by its child's time.
- It reads a hundred commits from each, and lists each commit once.
- A branch not read joins those named once a listed commit is its tip.

A pull request squashed into a listed commit is drawn as the merge it was.
The squash commit's other parent is the pull request's head as merged.
Its own commits run on a lane of their own from where it began, as GitHub keeps them (`refs/pull/<n>/head`), however its branch was reused or pushed over since.
A branch reused for another pull request shares the commits both had, drawn once.
A pull request's head is named by its number, `#123`, beside the branch still at it, an open one's too.

A directory's history reads a hundred commits at a time, and **Older commits** reads the next hundred.
Older commits are read as their button nears the end of the scroll, a screen before it shows, as though it were clicked.
They are read again while the button stays near.
After a page that failed, they wait for a click.

The commit shown is marked.
Where every branch's latest commits do not reach it, they are read again, afresh (`fresh=true`), once for each commit shown, as a branch that has moved since may reach it.
With `fresh=true`, the server reads every branch then, rather than answering with the branches it kept.
If it read them in the last ten seconds, it answers with those kept and says when it may read them again (`retryIn`), and the tab asks once more then.
Where that read fails, the server answers with the branches it kept.
The tab shows the listed commits meanwhile.
If the commit is still missing, a note says so.

A directory lists the commits touching it in a single line, as GitHub does not rewrite their parents to the commits listed.
Clicking a line shows its commit and stays on Commits.
The header names the commit by the branch naming it (the default first), else by the tag.
The view reads none of the directory's files, so its route at a commit opens it alone, and the directory's other tabs then read them.
A directory whose files fail to open still shows its Commits where its commit is known.
A `413 directory-too-large` names the commit the directory was read at, and the route then names it.

A commit made with others shows them as GitHub does.
Its author's avatar shows first (their name's letter where the app has none of theirs), and each other's is tucked behind it in turn, up to three, all named in its tooltip.
They are its co-authors, as its `Co-authored-by:` trailers name them.
GitHub's GraphQL API lists them by the accounts it knows their addresses by.
Its REST API lists them by the trailers, and an account's no-reply address names that account.
Then come the agents the commit's message marks:

- Claude, by Claude Code's trailer (`Claude … <noreply@anthropic.com>`, the model in its name), its `Generated with [Claude Code]` line, its `Claude-Session:` trailer or a session's link.
- Codex, by its trailer (`Codex <codex@openai.com>`) or a task's link (`chatgpt.com/codex/tasks/…`).
  Codex is known by its address, though GitHub names someone else's account for it.
- Cursor, by its agents' trailer (`Cursor Agent <cursoragent@cursor.com>`) or link (`cursor.com/agents?id=bc-…`).
- An app agent, by its fingerprint, as the Agents tab tells them (below).

An agent shows by its mark, a solid avatar as its app's icon is, as Replay draws them: Claude's white on its orange, OpenAI's black on white for Codex, and Copilot's white on GitHub's dark.
Dependabot and Neo show by their avatars.
Cursor, whose mark the app does not have, shows by its letter.
The author is never one of the co-authors (`server-managed/commit-coauthors.ts`).
The server reads each commit's message for them, and keeps and answers the co-authors alone, never the message.
A page kept before they were read, or read by rules that have changed since (`COAUTHORS_READ`, raised as they change), is read again.

What the view read is kept in the page for the session for five minutes, and on the server for every reader:

- A whole repository's history, from a revision or all branches, is read one page from a commit at a time.
  A page is the first hundred commits of the history from that commit.
  It is kept by the commit it starts at, its top (`managed_upstream_cache`, under `repository/history`, for a month).
  A commit's history never changes, so a kept page is never read again.
  A branch that moves on misses nothing: only the page from its new tip is read.
  A page read with a token also tells each commit's lines added and removed and its author's own time, which Pulse counts; the tab is not sent them.
- Pages glue on: where a listed commit, or an unlisted parent of a listed commit, is the top of a kept page, that page joins those listed, and so on, until two thousand commits are listed.
  The pages at parents not listed are read first, each adding only commits not listed yet.
  The pages at listed commits mostly list commits already listed.
  They are read only where any of those parents has no kept, readable page, so that a line with none at its parent still goes on.
  Where none of those parents has one, the pages at listed commits come from the same database read.
  The pages from where the history starts are listed whole all the same, as are All branches' 25 tips' pages, up to two thousand five hundred commits.
  A branch that moved on a few commits reads one page and shows all of its history read before, including the pages Older commits read.
- The branches and tags naming commits move, so they are kept as Issues' pages are: answered as read for two minutes, then answered while they are read again.
- A directory's history is read from GitHub each time, because a page from a commit lists the whole history, not the directory's commits alone.
- The pull requests squashed into a whole repository's commits are kept by each commit (`repository/squashes`, for a month, as its pages are).
  A merged pull request's commits never change.
  A commit no pull request merged, or one merged by a rebase, is kept as none.
  The open pull requests' heads move, so they are kept as the branches are.

`GET /api/admin/repositories/history?repoId=…&ref=…&path=…&page=…` answers a page of a revision's history, `{ commit, path, page, commits, more }`.
Each commit is `{ sha, parents, subject, authorName, authorLogin, authorId, coauthors, committedAt }`, as GitHub's list of commits gives them (`repository-history.ts`).
The first page also has the `branches` and `tags` naming commits, each `{ name, sha }`:

- With a token, it has every branch All branches reads (below, kept for both) and the latest hundred tags.
- Without one, it has GitHub's first page of each, a hundred by name, to spare an unsigned reader's rate limit.

A whole repository's page is the history from its commit, glued on (above), with `more` where a parent is not listed.
A later page names the commits to read on from, `from=<sha>,<sha>…`, as All branches' later pages do.
A later page that names none reads GitHub's page of that number.
A directory's page is GitHub's page of that number.

With `all=true`, at the root and on the first page, it answers `{ all, commits, branches, tags, defaultBranch, unread, cut, more }` from GraphQL:

- `commits`: the server reads the branches' tips with their commits' times, a hundred a page for up to fifty pages, as GitHub orders heads by name alone.
  Then, in one query, it reads the latest hundred commits of the default branch and of the 24 other branches most recently committed to, each commit once.
- `branches`: every branch naming a listed commit.
- `unread`: the branches not read whose tips are not listed, each `{ name, sha, at }`, newest first.
- `cut`: set where branches past the five thousand listed are left out, never to be read; the tab then says so.
- `tags`: the latest hundred tags, an annotated tag by the commit it tags.
- `more`: set where a branch, or some of a branch's commits, are left out.

A later page names up to 25 commits to read on from, `from=<sha>,<sha>…`, and answers `{ all, page, commits, more }`.
It has the latest hundred commits from each, each commit once, with `more` on every page but the deepest.

With a token, a whole repository's answer also has `pulls`: the pull requests squashed into its `commits`, each `{ merge, number, head, commits, more }`.

- A pull request is in `pulls` when it was merged and its merge commit, with one parent, is a listed commit.
- One that was rebased is not: its commits, more than one, were copied onto the branch.
  The merge commit and those below it on their first parents are its copies, matched by subject.
  One whose copies go on past the listed commits is told, and kept, once they are listed.
- A squash of one commit is titled as that commit by default, and is drawn as it was either way.
- `head` is its head when merged, `commits` its latest hundred commits, and `more` is set where it had more.

On a first page, the answer also has `openPulls`: the heads of the hundred most recently updated open pull requests, each `{ number, sha }`.

GraphQL looks up at most five hundred of each answer's single-parent commits not yet kept.
It reads a hundred commits or twenty pull requests per query, four queries at once.
Where GitHub refuses them, as for an App without **Pull requests: read**, the history is sent without them.
GraphQL needs a token: with `all=true`, a public repository read without one is `403 github-token-required`, and the tab then shows the revision's history.
The history is read as the code is, with the reader's own GitHub access and only where the reader's grants reach the whole directory.
Access is checked again before it is sent.

## Issues and pull requests

The **Issues** and **Pull requests** tabs show the repository's issues and pull requests as a grid of compact tiles rather than a list.
The tiles fill the width, the most recently updated first.
**Open** and **Closed** pick which to show, each with its count.
For pull requests, Closed includes those merged.

A tile shows its title in up to two lines, then one line for each of these, none wrapping:

- its number, author and age;
- its labels, if it has any;
- for a pull request, its branch, the branch it merges into, and its lines added and removed.

Beside them is a rail:

- its state, as an icon and a stripe in GitHub's colors: open green, merged and completed purple, closed red, draft and not planned muted;
- under it, for a pull request, its review (approved, changes requested or review required) while open, and its checks (passed, failed or running), each an icon, with room held for both;
- then how many comments it has.

An open pull request's tile has a line of its reviews (`pull-reviews.js`):

- Each reviewer shows by a mark of how their latest review stands (approved, changes requested, commented, or review requested), then their name.
  An agent shows by its mark alone.
  A reviewer is dimmed where their review was on an earlier commit than the latest.
- Copilot's code review shows by its bot.
  GitHub names it Copilot, as it does Copilot's coding agent; they are told apart by the bot's id, and by `copilot-pull-request-reviewer` on its reviews.
  A reviewer requested again is matched by their account's id before their login.
- An agentic workflow (gh-aw) reviews as GitHub Actions' bot, approving or not, and shows by GitHub Actions' mark.
  Its popup names the workflow by the `gh-aw-workflow-id` marker gh-aw leaves in what it posts.
- Codex shows first, by its summary comment rather than its reviews, since it posts a review only where it finds something.
  It shows as reviewed, reviewing, asked to review again (`@codex review`) since, or failed since.
- Then comes how many review threads are open, with the gravest one's badge (P0 to P3, as Codex marks its findings).
- **Unreviewed** shows where no review is on the latest commit; Codex's, done with that commit, counts.
- **Unreviewed?** shows where no review read is on it, but there are more reviews than were read.

The pull request author's own replies in its threads, which GitHub makes reviews of, do not count as reviews.

A tile's labels each show by a dot of their color, whole while they fit.
Past that, the last label is shortened first, to its dot alone, then the one before it.
A shortened label tells its name on hover.
As many show as the narrowest tile has room for as dots: eight, else seven and how many more.
Up to twenty are read, and the filter searches them.

Clicking a tile opens its popup over the tab, as a kanban card does (`dialogs/repository-item-dialog.js`).
The popup shows what the tile shows at once, then the rest as it is read:

- its description;
- what a pull request closes, or what closed an issue, each opening in its place (**Back** returns);
- a pull request's commits, files changed and who merged it;
- its reviews, a row each, with Codex's code review and security review apart, each with the commit it was on (linked, the latest or an earlier one) and when, saying where none is on the latest commit;
- its open threads, each by its badge, title, file and line, linked to it on GitHub, with how many are resolved;
- **Open on GitHub**.

A tile clicked with a modifier key held, or with another mouse button, opens on GitHub as a link does.

A **Filter** picks among the items read by every word typed, in a tile's number, title, author, labels or branch.
Fifty items are read at a time.
The next fifty are read as the **More** button nears the end of the scroll, as Commits' Older commits are.
They are not read that way while a filter picks among them, nor after a page failed.
Like Commits, neither tab reads the directory's files, so at a commit each opens alone.
What they read is kept in the page for the session for five minutes, and on the server for every reader (below).

Each issue or pull request shows as read latest, by its list or by its popup, whichever the server read from GitHub last (`ui/view/repository-items.js`, the app's store).

- One its popup read as merged shows merged on its tile too, and the open and closed counts move with it.
- A list read before shows an item read since in its new state, placed among those it lists by when it was updated, where the list reaches it.

`GET /api/admin/repositories/issues?repoId=…&kind=issues|pulls&state=open|closed[&after=…]` answers `{ kind, state, items, counts: { open, closed }, more, after, readAt }` from GraphQL (`repository-issues.ts`).
It answers a page of fifty, and where `more` is set, `after` is the cursor that reads the next page.
Each item is `{ number, title, author, authorId, createdAt, updatedAt, closedAt, comments, labels: [{ name, color }], moreLabels, state }`.

- An issue also has its `reason` (`completed`, `not-planned` or `duplicate`).
- A pull request also has `draft`, `mergedAt`, `review`, `checks`, `additions`, `deletions`, `head` and `base`, and its `state` is `merged` where it was merged.
- An open pull request also has `touchesLockfile` (below) and its `reviews` (`pull-reviews.ts`).

`reviews` is `{ head, reviewers: [{ login, id, workflow?, state, requested, commit, at }], moreReviews, moreRequests, threads: { open, resolved, more, severity }, codex: { login, id, code: { commit, status }, security, requested, failed } | null }`.
It is read as follows:

- Each reviewer is read from their latest review, twenty reviews and ten review requests at most.
- GitHub's counts of the rest go in `moreReviews` and `moreRequests`, apart.
  The tile says `+N` of both, counted apart rather than as reviewers, since one may be in both.
  Where a review is unread, the latest commit is unknown rather than unreviewed.
- The latest fifty threads are read; open ones are mostly those opened lately.
- For Codex's summary, the first five comments and the last twenty are read, to find its hidden `codex-review-state:v1` marker, which it posts when it is first asked.
  The last twenty also tell whether it was asked again, and whether it failed since.
- A closed page reads none of these, so its query stays as cheap as it was.

`readAt` is when the answer was read from GitHub; a kept answer is as old as when it was kept, and an item's is the same.
The item (`GET …/item`) has its pull request's `reviews` whether open or not.
It also has its threads' `list` (of the latest hundred read), with each open thread's `severity`, `title`, `path`, `line`, `outdated`, `author`, `authorId` and `url`.

These are the whole repository's, so they are read only where the reader's grants reach all of it (`404 no-directory` otherwise), with the reader's own GitHub access.
GraphQL needs a token (`403 github-token-required` without one).
A nonpublic repository's are read with its GitHub App's installation:

- It lists pull requests only with **Pull requests: read**.
  Where GitHub refuses them, the answer is `502 github-status-403`, and the tab says so.
- It reads a pull request's checks only with **Checks: read** and **Commit statuses: read**.
  Where GitHub refuses those alone, its tiles show no checks (see Creating GitHub issues).
- Its reviews, threads and comments likewise show none where GitHub refuses those alone.

Access is checked again before they are sent.

| When GitHub | The answer is |
| --- | --- |
| takes too long to read a list (it stops a query after ten seconds) | `502 github-timeout` |
| refuses it for a scope the token lacks (`INSUFFICIENT_SCOPES`), as it refuses a field a GitHub App lacks the permission for | `502 github-status-403` |
| answers with errors of no type it names, as when it rejects a query naming a field or type its API does not know | `502 github-malformed` |

GitHub's own words for those errors are logged on the server.

A team requested to review is not named; it is counted among the requests GitHub names no one for.
Reading a team needs its organization's **Members** permission, and a query that lacks it fails whole.
A query naming an `EnterpriseTeam` fails the same way, because GitHub's docs' schema has that type and its API does not.

`GET /api/admin/repositories/item?repoId=…&number=…` answers one issue or pull request as its popup shows it, read and checked as a page is.
It has:

- its tile's fields, and `kind` (`issues` or `pulls`);
- its description's Markdown as written (`body`), never GitHub's HTML of it, shown as finding descriptions are;
- for an issue, the pull requests closing it (`closedBy`);
- for a pull request, the issues it closes (`closes`), its `commits`, its `files` changed, `mergedBy` and `mergedById`, and its `touchesLockfile` (below), whether open, merged or closed.

Where the repository has no issue or pull request of that number, the answer is `404 github-not-found`.
A description past 20,000 characters is shortened (`bodyShortened`).
Of the items it closes or that closed it, ten are named and the rest counted (`moreLinked`).
The popup then says so, and that the rest are on GitHub.

What a page or item read is kept in the database for every reader (`managed_upstream_cache`, under `repository/reads`, for a day).
Each reader's access is checked as they ask.

- For two minutes, it is answered as kept, without reading GitHub again.
- After that, while it is kept, it is answered at once and read again behind the answer for the next reader.
  Only one such read runs at a time.
  On a serverless host too, the function keeps running until that read ends (Vercel's `waitUntil`).

Where GitHub refuses to read it again (the GitHub App's permission for it withdrawn, or the repository or item gone), it is no longer kept.
The next reader is then refused as GitHub refused it.
The Agents tab's pages are kept the same way.

### New dependency versions

A pull request that changes a lockfile shows the package versions its lockfiles lock that they did not lock before it (`pull-dependencies.ts`).
Such a version is either a package new to the lockfiles or a new version of a package they already locked (an update).
The app reviews versions, so an update's version is as new as a new package's.

An open pull request's tile shows them in one line under its branches:

- the packages' names, those new to its lockfiles first, cut to the tile's width;
- how many there are of each kind (`2 new, 1 updated`);
- on hover, each version with the versions it replaced, twenty at most.

The popup of any pull request (open, merged or closed) lists them under **New dependency versions**:

- by directory, each directory's lockfiles above their versions, each version by its name and version;
- a package new to the lockfiles is tagged **new**, and an update shows the versions it replaced (`from 1.0.0-alpha.7`);
- an npm version opens in the app's npm viewer, and an update opens compared with the highest version it replaced;
- a version from git, a tarball, a file or a mirror is tagged with that source;
- a version that only devDependencies need is tagged **dev**.

The lockfiles read are those of npm's ecosystem that repository risk reads:

- `package-lock.json` and `npm-shrinkwrap.json` with `lockfileVersion: 3`;
- `pnpm-lock.yaml` of pnpm 9 to 12;
- Yarn 1's `yarn.lock`.

Bun's lockfiles (`bun.lock`, `bun.lockb`) are recognized but not read, and their directory says so.
Lockfiles under a `node_modules` directory or in a test's fixtures are ignored, as no install uses them.
A version that pnpm patches counts as new wherever its patch is new.

Whether a pull request changes a lockfile is decided from the files GitHub lists for it, a hundred at most (`touchesLockfile`):

- `true` where one of them is a lockfile;
- `false` where none is;
- `null` where none of the hundred is but it changes more files, so it may still change one;
- omitted where GitHub refuses to list its files.

Only a pull request with `true` or `null` is read.
A closed pull request's tile shows nothing about lockfiles, because the list of closed pull requests reads no files.

`GET /api/admin/repositories/pull-dependencies?repoId=…&number=…` answers `{ number, base, head, lockfiles, cut }`.
It is read and access-checked as an item is (above).
The commits it is about are kept by the pull request's number, as an item is.
What those commits tell is kept by the commits alone (below), not again by the number.

GitHub's comparison of the pull request's base with its head names the commit where its branch left the base, its merge base (`base`), which is what **Files changed** compares from.
The comparison lists the files the pull request changes, three hundred at most.
When it lists that many, the files are taken from the pull request's own file list instead, a hundred a page, three thousand at most.
The lockfiles it changes in each directory (`paths`, twenty directories at most) are read at the merge base and at the head.
Each lockfile's bytes are checked against its blob, as repository risk reads lockfiles.

Each directory's `added` lists the package versions its lockfiles lock at the head that none of them locked at the merge base, matched by where each is installed from.
So a lockfile replaced by another (Yarn's by pnpm's, say) is compared with the one it replaced.
Each entry is `{ name, version, source, from?, dev?, was? }`, as a scan's lockfile line shows it, without its integrity.
`was` lists the versions of that package the lockfiles locked before, highest first; a package new to them has none.
Entries are sorted by name and version, at most two hundred are listed, and the rest are counted (`more`).
Where a lockfile in the directory could not be read, the directory has an `error` instead:

- `lockfile-unreadable`, with the reader's `detail`;
- `lockfile-unsupported`, for Bun's;
- `github-not-found`.

`cut` is set where the pull request changes more files than are listed, or lockfiles in more directories than are read.

For the review (below), the server also keeps every version the head's lockfiles lock, twenty thousand per directory at most, the rest counted.
Each is kept with its integrity, Yarn 1's sha1 and pnpm's patch hash where present, and the lockfile's format.
None of this is sent, except whether a version is `patched`.

What a pull request's base and head commits tell is kept in the database under `repository/pull-dependencies` for a month, because what the commits hold never changes.
Once it is gone, it is read again.
Each lockfile read is kept in the instance's memory by its commit, so pull requests that branch off the same commit (as a bot's do) read it once.
A lockfile already being read with the same token shares that read.

With `numbers=1,2,3` in place of `number` (twenty at most), it answers `{ pulls }`, one answer per pull request, three read at once.
A pull request that GitHub fails is answered `{ number, error }`.
The repository's access is checked once before them all and once after, unless every answer was kept and none failed.

The page reads two pull requests at a time, in the order they were asked for.
A team's Dependencies tab's requests wait behind a tile's or a popup's, and up to twenty of one repository's waiting pull requests are sent in one request.
The page keeps the answers for the session for five minutes, as it keeps the tiles.
GitHub refusing the repository's contents or the pull request fails the answer (`502 github-status-403`), and the popup says so.

### A repository's dependency review

An admin turns on a connected repository's dependency review in its page under Repositories, with the switch in the **Dependency review** section's heading.
The settings are:

- how many reviews each version needs (one to ten);
- optionally, the commit it is reviewed since (its full id);
- the lockfiles it holds to (below).

The page warns where no team that would count its reviews has the repository.
Once the setting is saved, the page asks again for the pull requests' reviews it holds.

`POST /api/admin/repositories/dependency-review` with `{ repoId, enabled, required, since, lockfiles? }` saves it.
Any other body gets `400 bad-request`, and an unknown repository gets `404 no-repository`.
The setting is stored on `managed_selected_repo` (Postgres schema 30) in `dependency_review`, `dependency_reviews_required`, `dependency_review_since` and `dependency_review_lockfiles` (JSON).
`GET /api/admin/repositories` lists it with each connected repository (`dependencyReview`), with the teams whose reviews count for it (`reviewTeams`).

The review is in effect only where a visible team that reviews dependencies has the repository.
The reviews that count are those published to such a team (`repository-dependency-reviews.ts`) that are:

- full, with every file checked (a partial review counts for nothing yet);
- accepting (**Accept** or **Accept with nits**);
- not revoked.

Each reviewer counts once: one person's several reviews of a version count as one.
A reviewer's latest review of a version decides where they stand.
A reviewer whose latest is **Reject** holds the version unreviewed (`rejected`), however many others pass it, until they accept it again.
The commit reviewed since and the host's reviewed dependencies (below) pass versions regardless of reviews: the app's reviews judge only what is new since.

An open pull request's tile and popup ask for its dependencies with their review (`review=1`, `pull-dependency-reviews.ts`).
A version is reviewed as npm's registry has it, by its name, version and integrity.
It must be locked from npm's registry, by its name or by the exact link to the version's tarball (with only a hash after it, as Yarn 1 writes its sha1), and with an integrity.
A review of it counts where the review's integrity is one the version is locked with.

These versions can't be reviewed, and fail the pull request's review even where its lockfiles locked them before:

- a version from git;
- a tarball another host serves (a mirror's too), or a link with a query;
- a version locked with no integrity.

The review also fails for:

- a changed lockfile that couldn't be read;
- lockfiles left unread (`cut`);
- a directory that locks more versions than are checked;
- a Bun lockfile.

A file of the project's own is not reviewed.

A version that pnpm patches (`patched`) is never passed by reviews here, because the app does not review patches yet.
It passes only by:

- the reviewed dependencies the host registers (below);
- reviews of its patch in an open pull request's comments, which those reviewed dependencies read;
- or, where the host registers none, being locked the same way, patch included, at the commit reviewed since.

A version the pull request adds passes with as many reviews as required, of it whole or compared with a version it replaced.
Versions past the two hundred listed are judged the same way and counted (`toReview`).
So is each other entry its lockfiles lock for that version (another integrity, say), and its row shows the least passing of them.
Every other version its lockfiles lock also needs its reviews, of it whole or compared with any version of its package.

Where the repository is reviewed since a commit, the versions locked at that commit need no reviews.
They are the reviewable versions of every lockfile of npm's ecosystem at that commit, a hundred lockfiles at most.
They are read from GitHub once and kept by the commit, in the instance's memory and in the database (under `repository/review-baselines`, for a month), and never stored as reviews.
A lockfile there that its reader refuses, a Bun lockfile, or one past the hundred is reported (`baselineUnread`), and the versions it locked need reviews.
Without that commit, every version needs its reviews.
Where GitHub doesn't read the commit, or has none of a lockfile it lists there, every version needs reviews, the popup says why, and nothing is kept.

Each directory then lists:

- each version it adds with its review: `reviews` (how many pass it) and `rejected` where a reviewer rejects it, or `baseline` (it needs none), or `unsupported` (`git`, `tarball` or `integrity`);
- the other versions that want reviews (`unreviewed`, two hundred at most, with `moreUnreviewed` counting the rest);
- the versions that can't be reviewed (`unsupported`, with `moreUnsupported`);
- how many versions it locks past those checked (`moreLocked`).

The answer's terms (`review`) hold:

- `required`, `since` and `canReview`;
- `toReview`, `unreviewed` and `unsupported`: how many versions it adds want reviews, how many other versions want reviews, and how many can't be reviewed, each counted once across its directories;
- `baselineError`, where the commit's versions couldn't be read.

Where the host registered reviewed dependencies, a version they pass is `reviewed`.
The terms then include `reviewedDependencies` and how many versions they failed to answer (`unasked`), and `since` is none.

The tile shows:

- a check where every version passes;
- else how many versions want reviews, its own and then the others its lockfiles lock (`1 + 4 to review`), shortened on a narrower tile;
- or, in red, that its review fails.

The popup shows the terms, what fails the review, and each version's review: `2/2`, **reviewed**, **rejected**, **baseline**, **can't review**, or **unreviewed** for a patched version.
The other versions are folded under them.
For a reader who publishes reviews to a team that counts (`canReview`), each version links to its review instead of a comparison, an update's against the version it replaced.
A patched version never links to a review.

`GET /api/admin/repositories/branch-dependencies?repoId=…` answers the same for the repository's default branch, for its team's Dependencies tab (below).
It reads every lockfile of npm's ecosystem at the branch's head that the review holds to (`commit-lockfiles.ts`), a hundred at most.
Their versions are told as one directory's, with none added, and each version that wants reviews is in `unreviewed`.
Each lockfile its reader refuses, or past the hundred, is a directory of its own that fails the review (`lockfile-unreadable`, or `lockfile-unsupported` for Bun's).
The answer follows the lockfiles the review held to when they were read, even if that setting changed meanwhile.
Where the head was kept and the lockfiles and baseline were held, GitHub was asked for none of them, and the answer is sent without checking access again.
It answers:

- `{ head, review: null }` where no review is in effect for the reader;
- `{ head: null, review: null }` where the branch has no commit;
- `{ review: null }` where the repository reviews no dependencies, once the reader's access in the app is checked, without asking GitHub, as a team's Dependencies tab asks this of each of its repositories.

The lockfiles a review holds to (`lockfiles`, `lockfile-scope.ts`) are one of:

- every lockfile, by default (`{ mode: 'exclude', paths: [] }`);
- every lockfile but those named (`exclude`);
- only those named (`include`).

At most a hundred are named, each by its path in the repository, or by a directory ending in `/` for every lockfile under it, and none outside the repository.
Leaving `lockfiles` out of the request keeps those stored.
The page lists the default branch's lockfiles to check (`GET /api/admin/repositories/lockfiles?repoId=…`, which answers `{ head, lockfiles: [{ path, format }] }` to any reader of the whole repository).
It also lists those named before that are no longer there, and takes another path or directory typed in.

While the review is on:

- A pull request's directory none of whose lockfiles it holds to is left out for every reader, asked with its review or not (`heldDependencies`).
  Such a directory is not listed, not asked of the host's reviewed dependencies, and doesn't fail the review where it couldn't be read.
  A pull request that changes only such lockfiles shows no dependencies at all.
- A directory with any lockfile it holds to is reviewed whole.
- A pull request that changes lockfiles in more directories than are read is cut only where it holds to a lockfile among those left unread (`omitted`: their paths, kept with what the pull request adds, a thousand at most).

On the default branch, only the lockfiles the review holds to are read, a hundred of them.
The commit reviewed since passes the versions any of its lockfiles locked, but reports as unread (`baselineUnread`) only those the review holds to.
The terms include the scope (`lockfiles`) where it isn't every lockfile.

#### A team's Dependencies

A team shows a **Dependencies** tab after Repositories (`/team/<slug>/dependencies`, `team-dependencies.js`) where its reader reviews dependencies in it (`dependencyReview`).
That is where its **Enable dependency review** switch is on and the reader is a member who manages it, a member who triages and sees its dependencies, or an admin.
Its sub-tabs are:

- **Pull requests**;
- **Versions**;
- **Default branch**, where any version there wants reviews;
- **Reviews**.

They are drawn as a dialog's header tabs are, and the first three each count what they list.
Each sub-tab past the first has an address of its own (`/team/<slug>/dependencies/versions`, `/branch`, `/reviews`), and picking one adds a history entry.
The team's Dependencies tab opens the sub-tab last picked.
The sub-tabs stay under the team's header while the open one scrolls.
Where **Default branch** is named but nothing there wants reviews once all is read, it gives way to **Pull requests**, address too.
Pull requests and repositories are named without their owner where every repository reviewed has the same one (`repo#1`).

For each of its repositories whose review is in effect for the reader, three read at once, the tab reads:

- the open pull requests, twenty pages of fifty at most, those updated latest, saying so where there are more;
- the dependencies, with their review, of those that change a lockfile, as their tiles do.

A repository the reader may read only part of is left out.

**Pull requests** lists the pull requests whose versions want reviews, or whose review fails.
Those adding the fewest versions come first, then those held only by other versions their lockfiles lock (mostly the default branch's).
Each is a card that opens its popup, and the cards sit side by side, each one column wide, however many versions it lists or opens.
A card shows:

- how many versions it wants reviewed;
- its versions with their review (`0/2`, **rejected**, **patched** or **can't review**), in as many columns as fit, twelve at first and the rest on request, with those past the versions its answer lists counted;
- on request, the versions a pull request above also adds, and the other versions its lockfiles lock.

A version is listed under the first pull request that adds it, of whichever repository, because one review passes it everywhere.
Another pull request that adds it too says so (`+1`), and a later one counts it among the versions a pull request above adds.
A version that another pull request reviews in its comments, which count only there (`commented`), is marked **in review in org/repo#1** wherever it is listed except under that pull request.
Under that pull request, its count tells how many of its reviewers are in its comments.
A patched version is never marked so, as two pull requests may patch it differently.
Reviews published here count everywhere, so none is marked.
A pull request that wants no reviews, its versions passed by reviews or the host's reviewed dependencies, is not listed, and the reader's reviews of its versions are copied from its popup (`formatted`, below).

**Versions** lists every version the pull requests add that wants reviews, each once, all of them, with the pull requests that add it.
**Default branch** lists, for each repository, what its default branch locks that wants reviews or fails them, and names its lockfiles left unread.
Each list there, and each list opened under a card, shows forty-eight versions at first.
**Reviews** lists the reviews published to the team, revoked ones too, the latest published first, with who wrote each, fifty a page.
It reads `GET /api/npm/reviews/team?teamId=…&beforeTime=&beforeId=`, which answers `{ reviews, next }` to one who reads reviews in the team, else `404 no-team`.
Each review is held to the reader's npm access, as My reviews' are.
It has no **Copy dependency review** button, which is for one's own reviews.

What the tab reads is kept for the session for two minutes, and shown as it was while it is read again.
It is read anew once an admin sets a repository's review or changes a team.
Its pull requests' dependencies are read after those a tile or a popup asks for, and one of them that a tile or popup asks for meanwhile is read first.

Each version that wants reviews, here and in a pull request's popup, shows the lines it changes against the version it replaced, or its whole package's (`GET /api/npm/delta`, `npm-delta.js`):

- `+x −y`;
- `, binary` after them where a binary file, which no line counts, was added, removed or changed (one moved unchanged is not);
- `(+z −w -types)` where declaration files changed in types alone.

The count is read once its row nears the viewport, two at a time, and kept for the session; each row is redrawn alone as its own count arrives.

#### Reviewed dependencies of the host

A host that keeps reviewed dependencies of its own registers them once, before `init()` (`reviewed-dependencies.ts`).
Registering after `init()`, or a second time, throws.

```js
import { init, registerReviewedDependencies } from '@preventive/triage/server'
registerReviewedDependencies({
  async lookup({ ecosystem, lockfile, name, version, integrity, shasum, patchHash }) { return isReviewed(...) },
  // Optional: the reviews an open pull request's comments make.
  async parseComments({ repository, number, comments, dependencies }) { return reviewsIn(comments) },
  // Optional: one's own dependency reviews as a comment, to copy.
  async formatDependencyReviews({ reviews, pullRequest }) { return commentOf(reviews) },
})
const server = await init('managed')
```

`lookup` is asked about each version an open pull request's lockfiles lock that its teams' reviews don't pass.
Where the host has `parseComments`, it is also asked about each version the lockfiles add that the teams' reviews do pass, before the comments are read for them (below).
It is given the version as the lockfile locks it:

- `ecosystem` (`npm`);
- `lockfile` (`npm`, `pnpm` or `yarn1`);
- `name`, `version` and `integrity`, always, since a version locked with no integrity fails the review instead;
- `shasum`, the hex sha1 Yarn 1 writes after a tarball's `#`, where the lockfile has one;
- `patchHash`, pnpm's patch hash, where the lockfile has one.

A version it answers `true` for passes.
A version it fails to answer for wants its reviews and is counted (`unasked`), and the error is logged.
Each version is asked once per request, sixteen at once, and the answer is kept in the instance for a minute.

Once registered, it replaces the commit a repository is reviewed since:

- the repository's page shows no commit;
- `POST /api/admin/repositories/dependency-review` refuses one (`400 since-unsupported`);
- a commit stored before is left unread but kept as it is, and the page saves the other settings without it, for a server that later registers none;
- the connected repositories' list includes `reviewedDependencies`.

The endpoint answers the setting as stored.
A version that neither `lookup` nor as many reviewers' reviews as required pass is unreviewed.

`parseComments`, where the host has it, reads the reviews an open pull request's comments make (`pull-comment-reviews.ts`).
Whether the pull request is open is read from GitHub together with the comments, and neither is kept with its dependencies.
It is asked only about an open pull request, and only where the lockfiles its review holds to change.
Its `dependencies` are:

- every version those lockfiles add that can be reviewed and that neither its teams' reviews nor `lookup` pass;
- those its teams' reviews pass but `lookup` doesn't, which `lookup` is asked about first, so that other pull requests are told the versions this one reviews (`commented`);
- the other versions its lockfiles lock that still want reviews, as `lookup` is asked about them.

A version that `lookup` passes is reviewed, and the comments are never read for it.
It is given the pull request (`repository`, `number`) and its comments (`comments`, a thousand at most, read through GitHub's GraphQL API and kept in the instance for a minute).
Each comment has:

- `kind`: `comment`; `review`, a review's own comment, whatever its state (given as `state`); or `review-comment`, on a line of the diff, every one of each review's;
- `id`, `author` (a login), `body`, `createdAt`, `editedAt` where it was edited, and `url`.

It answers the reviews the comments make: `[{ user, time?, dependencies: [{ name, version, integrity, patchHash?, status }] }]`.
`status` is `accept`, `accept-with-nits`, `request-changes` or `reject`, and each review is taken as full.
Its answer to the same input is kept for ten minutes.

A review counts only where its `user` wrote one of the comments and the app's user for that GitHub account (by its id, else its login, a linked account's too) publishes reviews to a team counting for the repository.
It then counts as that user's review, as of its `time`, else as of that user's latest comment, as last written or edited.
Each reviewer counts once among their reviews here, and their latest decides where they stand.
A patched version's review is of its patch.
These reviews count for the open pull request alone and are never stored.
The host is to merge a pull request reviewed this way only once those reviews reach what its `lookup` reads, so a closed pull request's comments are never read.
The terms tell how many reviewers its comments count (`commentReviews`), or that they couldn't be read (`commentsFailed`, the error logged).
Each version tells how many of its reviewers review it in its comments alone (`commented`), which a team's Dependencies tab shows beside it wherever another pull request lists it.

`formatDependencyReviews`, where the host has it, formats one's own dependency reviews as a comment, which a copy button gives (`dependency-review-copy.js`, **Copy dependency review**).
Where the host has none, no review or pull request has that button.
It is given a list (`reviews`), each entry with:

- `ecosystem` (`npm`);
- `new`, the version reviewed, and `old`, the version it was compared with (null where its package was read whole), each `{ name, version, integrity, shasum?, patchHash? }`, with `shasum` and `patchHash` where a pull request's lockfile has them;
- `status` (`accept`, `accept-with-nits`, `request-changes` or `reject`);
- `coverage` (`full`, else `partial`);
- `comment`, its final comment;
- `files`, the `{ path, status, comment }` of each file that was checked or commented on;
- `reviewer` (a login) and `publishedAt`.

It answers the text to copy.
An answer that is empty, null or undefined, or longer than a million characters, or a failure (logged), gives none.
It is given only the asker's own published, unrevoked reviews: `dependency-review-comments.ts` asks it and filters out every other review before calling it, however it is asked.
It is asked:

- of each such review alone, given as `formatted` on one's own reviews wherever My reviews, the review page, publishing and `GET /api/npm/reviews/latest` answer them, and never on others' reviews;
- of an open pull request asked with its review, of all the asker's reviews published to a team counting for its repository of the versions it adds (by their integrity and patch, whole or compared with a version they replaced), with the pull request (`pullRequest`, `{ repository, number }`).
  This is the pull request's `formatted`, which its popup and its card on a team's Dependencies tab copy (**Copy your dependency reviews of its versions**).

## Agents

The **Agents** tab shows the sessions in which the repository's work was done, by Claude, by Codex, and by the agents the server knows by their GitHub Apps or accounts.
Each session is reconstructed from what its agent leaves on GitHub (`common/managed/agent-tasks.ts`).
Sessions show in the same compact tiles as Issues, the most recently active first.
A session holds its tasks: the pull requests it opened, and the commits it pushed straight to the default branch that no pull request merged.

A session is told by the links and marks the agents leave:

- A Claude Code session, by `https://claude.ai/code/session_…` in a pull request's body, its head or merge (or squash) commit's message (the `Claude-Session:` trailer), a commit's message, or a branch's tip commit.
- A Codex task, by `https://chatgpt.com/codex/tasks/task_…` in the same places.
- Codex without a task named, by its co-author trailer (`Co-authored-by: Codex <codex@openai.com>`) on a pull request or commit, since Codex marks the commits it makes as whoever ran it.
- Without a session named, by the branch, `claude/…` or `codex/…`: one session per branch, with its pull requests together.
- Without a session named, by Claude's marks (`Co-Authored-By: Claude`, `Generated with [Claude Code]`, or a commit Claude authored): such a pull request or commit is its own session.
- By a pull request's label naming an agent's id (`claude`, `codex` or an app agent's), in any case, alone or after `agent:` or `agent/` (for example `Codex` or `agent: claude`).
- An app agent, by its fingerprint, its account or its branch prefix (below).

App agents are the agents of `GITHUB_AGENTS` (`common/managed/github-agents.ts`) that have a branch prefix, listed as `APP_AGENTS` in `app-agents.ts`.
Each is defined there by its id, name, avatar, branch prefix, and its fingerprint or the account its work is authored by:

| Agent | Fingerprint | Account | Branches |
| --- | --- | --- | --- |
| Neo | U+1F916 (robot face), a space, then `Generated with [Neo](` | 274065190, by its ID alone | `neo/…` |
| Copilot | None | 198982749, `Copilot` or `copilot-swe-agent` | `copilot/…` |
| Dependabot | None | 49699333, `dependabot` or `dependabot[bot]` | `dependabot/…` |

An app agent's work is told by any of these:

- Its fingerprint starting a line of the same texts; a line that quotes it, as a review does, does not count.
- Its account authoring the pull request, commit or branch tip, matched by ID and login together, or by ID alone for an account known by no login.
  Where GitHub names no user for a commit's author, as for a bot's commits, the author is matched by its GitHub no-reply address (`<id>+<login>@users.noreply.github.com`).
- Its branch prefix.
- A pull request label naming it (above).

An app agent names no session, so each of its pull requests is a session alone and joins no other by what it links.
It joins its branch only if it is the newest pull request read from that branch, by number (GitHub numbers pull requests as they are opened), whether the others are an agent's or not.
Claude's or Codex's marks on an app agent's work show after its own mark, as its tools.

Everything that names one session is that session, whatever branch each part is on.
A pull request joins its branch's session.
A fork's branch is named `owner:branch`, as GitHub names it, and is kept apart from the repository's branch of that name and from another fork's.
Comments are never read: an agent links its session in its own texts, and anyone may name a session in a comment.
An issue shows with a session whose pull request closes it, or whose branch the Claude GitHub App named for it (`claude/issue-12-…`).

As on Issues, a tile shows its agent's mark (Claude's burst, Codex's OpenAI mark, Copilot's GitHub Copilot mark) on a rail, beside these lines, each on its own line without wrapping:

- Its title (its first task's), in two lines at most.
- Its author, its age, how many tasks it holds, and its lines.
  The author is a user; none shows where only an agent's own account authored it, since its mark says who.
  The task count shows only where its pull request and commit chips don't count them all; its popup always says.
- Its pull requests, commits and issues as chips in their states' colors, as many as fit, and how many more.
  For a single task, its age and lines sit at the end of this row rather than on the line above.
- Its branch.

Copilot's mark is GitHub Copilot's icon, which the app draws itself.
The other app agents (Neo and Dependabot) are marked by their GitHub App's or account's avatar.
The server fetches each such avatar from GitHub once and keeps it, serving it at `/api/avatar/app-<id>` or `/api/avatar/user-<id>`, and only for the agents' own avatars (`APP_AGENTS` and `GITHUB_AGENTS`).
The browser keeps an agent's avatar for a day; it never keeps a user's avatar.

Clicking a tile opens its session's popup, as an issue's tile does.
The popup shows who, when, its state, tasks and size; its pull requests and issues, each opening in its place; its commits and branches, which open on GitHub; and links to where it ran (a Claude Code session or a Codex task) and to GitHub.
A pull request's or issue's chip opens that item's own popup, and a commit's chip opens on GitHub.
With a key held, the title opens where the session ran, and a chip opens on GitHub.

A session with a branch alone says it has no pull request.
It shows only once no pull request left to read could be its own; while some remain, only a branch newer than the oldest pull request read shows.

**All**, **Claude**, **Codex** and each app agent with sessions among those read pick whose sessions show, each with its count.
**Filter** keeps the sessions that match every word typed, in a title, author, branch, number, commit or session id.

At the bar's end, beside the mark of each agent with sessions among those read, an icon and a count each show its pull requests, branches, and commits to the default branch without a pull request.
App agents come first and Claude and Codex last, so theirs keep their places.
Each count shows only where there are any, whether or not more are left to read.
After them, a ring fills as the pull requests are read, with its percent inside (a blue check once all are read) and the count read in its tooltip.
The percent is 100 once none are left to read.
Otherwise it is the number read out of the highest number read (an issue's included), each number taken for a pull request, which may undercount it.

Pages load as the end of the scroll nears, as on Commits, and the sessions are rebuilt from everything read.
Loading goes on only while each page adds a session.
Most pull requests and commits may be no agent's, so after a page that adds none, the next page waits for a click on **More** instead of reading the whole history on its own.

`GET /api/admin/repositories/agents?repoId=…[&pulls=…][&commits=…]` answers `{ pulls, commits, issues, branches, agents, more, after: { pulls, commits } }` from GraphQL (`repository-agents.ts`).
Each page holds fifty pull requests, the most recently updated first, and a hundred of the default branch's commits, the newest first, each read on from its own cursor.
The first page alone, which names neither cursor, also holds:

- The hundred most recently updated issues.
- The app agents (`agents`), each by its id, name and avatar, never by how it is told.
- The hundred newest default-branch commits that the app agents' accounts authored, found by their no-reply addresses however far back.
  A bot's commits pushed with no pull request here (as before a repository moved) may lie deeper than the pages read.
  Neo, known by its ID alone, has no such address.
- The five hundred newest of each agent's branches.
  GitHub lists branches by name alone, so every branch under an agent's prefix is read, up to fifty pages of a hundred per prefix.
  Each is named in full, whatever prefix GitHub splits off, and the newest are kept by their tip commits' times.

Only each item's own texts are read: a pull request's body and its head and merge commits' messages, a commit's message, and a branch's tip commit.
Comments and issue bodies are never read.
The texts are read for the sessions and tasks they link, Claude's marks and the app agents' fingerprints.
Pull request and branch names are read for their prefixes, a pull request's labels (up to 100) for one naming an agent, and the authors' logins of pull requests, branches and commits.
Only what these tell (`signals`) is answered, never the texts.
Of the default branch's commits, only those that no pull request merged and that an agent marked are answered.
They are read as Issues are: with the reader's own GitHub access, only where their grants reach the whole repository, with a token required, and with access checked again before they are sent.

## Pulse

The **Pulse** tab shows how the repository moves over a **Week**, **Month**, **Quarter** or **Year**.
These are one, four, thirteen or fifty-two weeks up to today, counted as GitHub's statistics count weeks (Sunday first, UTC), with the current week last.
The bar names the period's dates.

- **Figures**, one tile each: the default branch's commits, how many people made them, the pull requests merged (and opened), the issues closed (and opened), and the lines added and removed.
  Commits, pull requests and issues are each compared with the same days of the week one period earlier ("↑ from 110 the month before").
  So this week's Sunday to Thursday is compared with last week's Sunday to Thursday, not with the days just before, whose days of the week differ.
  The year's commits are compared with nothing, since only the last year is counted.
- **Commits**, for the period alone: a column per day in a week or a month, or per week in a quarter or a year, over a scale of round counts.
  Under them, **Lines** shows lines added above a baseline in green and lines removed below it in red, on one scale for both.
  Columns are named under both plots: each day in a week, each week's Sunday in a month, every other week in a quarter, and each month in a year (by the year's number where January starts).
  In a month, weekends are lightly shaded; days still to come are empty.
  Pointing at a column highlights it across both plots, and a card beside it gives its day or week ("so far" for this week, "today" for today), its commits, its lines, and who made the most of its commits.
  The chart takes keyboard focus: the arrow keys read each column, Home and End jump to the first and the latest, and the card's figures are read aloud.
  Clicking a column, or picking it with Enter or Space, makes it the one the contributors are of, marked in the accent color, until it is clicked again, its chip is cleared, or Escape is pressed.
  Where GitHub's statistics count the year, they count lines and contributors per week: a week or a month then shows no lines (the quarter and the year do), and a day's contributors are its week's, which the tab says.
- **Contributors**: those who made commits in the period, or in the picked column, up to eight, ranked by their commits in bars, each with the lines they added and removed; the rest are a click away.
  Clicking a name shows only that contributor's commits in the plots, whatever period is picked, with the other contributors faded, until the name is clicked again or its chip over the plots is cleared.
  A link beside the name, shown when the row is pointed at, opens their GitHub profile; a contributor whose commits name no GitHub account shows by the name they carry, with no link.
- **Pull requests**, merged or opened, and **Issues**, closed or opened, as each panel's toggle picks, with each kind's count on its button.
  Merged and closed show first, and the reader's pick is kept.
  Each panel lists the ten latest and, where there were more, links to all of them on GitHub.
  Each item opens its popup, as an Issues tile does.
- **When commits are made**: a cell for each hour of each day of the week, Monday first, in a stronger blue the more commits it holds, as the scale under it shows.
  Hours are in each author's own time zone.
  It covers the period, or more than the period where GitHub's statistics count the year.

The activity plots span two of three columns beside the contributors, with the lists and the punch card under them.
Where the tab is narrower, the panels go two to a row, and where it is narrower still, one.
Each cell of the punch card names its figures on hover.
A period picked anew shows at once from the year last read, waiting only for its own pull requests and issues (its punch card, another period's, faded meanwhile).
With no year read yet, the last period read shows, faded, until the new one is read.

The year is counted from the default branch's commits themselves, as the Commits tab reads and keeps them.
Each page of a hundred commits, kept by the commit it starts at, gives each commit's lines added and removed and when its author made it in their own time zone (GitHub's GraphQL API gives both).
So a year whose commits are kept is counted from them at once, and once the branch moves, only the commits new since then are read from GitHub.
Reading goes on to as far as thirty days before the year, since a commit's clock is not always later than its parents'.
A year not kept yet is read five queries per answer.
Meanwhile the tab shows everything else it read and how many of the year's commits are read so far.
It asks again a second apart as long as each answer reads more; after five answers that read none, **Read on** is left to the reader.

A year of more than 10,000 commits is counted by GitHub's statistics instead (`stats/commit_activity`, `contributors`, `punch_card`, and `code_frequency` for lines).
GitHub computes them when first asked, and again once the branch moves, answering `202` until they are ready.
They are kept together, commits and lines as one, and the kept copy is answered while GitHub computes them again.
If they were never computed yet, the tab says GitHub is still counting and asks again five seconds apart, a dozen times, then leaves **Ask again** to the reader.
GitHub counts no lines for a repository of 10,000 commits or more, and the tab shows none.

`GET /api/admin/repositories/pulse?repoId=…&weeks=1|4|13|52` answers `{ weeks, since, previousSince, merged, opened, closed, created, stats, reading, pulls, pending }` (`repository-pulse.ts`):

- `merged`, `opened`, `closed` and `created` are each `{ count, previous, items }`: how many GitHub's search finds in the period (from `since`, its first day, to today), how many in the same days of the week one period earlier (from `previousSince`), and the ten latest.
  All eight searches run in one GraphQL query and search by the day.
  GitHub sorts no search by when a pull request was merged or an issue closed, so the fifty most recently updated are read and the ten latest merged or closed among them are listed; that is all of them where the period holds fifty or fewer.
- `stats` is the year (below).
- `reading` and `pulls` show progress while the year is not read whole yet, and `pending` is true while GitHub is still computing its statistics (below).

`stats` holds:

- `weeks`, one row per week: its commits each day (UTC) and in total, its lines added and removed, and, when counted from its commits, each day's lines (`dayLines`, `[added, removed]`).
- `contributors`, by account where GitHub names one (its numeric `id`), else by login, else by name, up to a hundred, the most commits that year first.
  Each holds their weeks of the year with any commits and, when counted from their commits, their days (`days`).
- `punch`, commits by day of the week and hour.
  When counted from commits, it is the period's (`periodPunch`); the server counts each period's with the year and sends the one asked for.
- `lines`, false where GitHub counts none.

Merges are left out, as GitHub's statistics leave them out.
A counted year is kept under a version of what it holds, so a year counted before it held as much is counted again.
It is kept by the head it was counted from (`repository/reads`, a day), and the head is kept as Issues' pages are (two minutes, then answered while read again).
A year not read whole yet answers the year last counted from an earlier head over the same weeks, where one is kept, else null.
`reading` then says how many of its commits are read, or `pulls` how many of the pull requests merged in it are read.
While GitHub is still computing its statistics, `stats` is likewise the last counted year or null, and `pending` is true.
A kept page of commits without lines (as GitHub's REST API lists them, for a reader without a token) is read again, with lines, for the year.
They are read as Issues are: with the reader's own GitHub access, only where their grants reach the whole repository, with a token required, and with access checked again before they are sent.

## Replay

Activity's play button, **Replay**, plays the latest commits of the revision shown, as [Gource](https://gource.io) plays a repository's history (`ui/view/repository-replay.js`, `ui/view/replay-model.js`).
On a canvas filling the tab, the repository's directories form a tree from its root (below the root, from the directory shown).
It starts from the files as they were before the first commit played (that commit's parent's), or from no files where that commit is the repository's first.
Each directory's files form a cluster of dots around it on a sunflower's spiral.
Each dot is in its kind's color, by its extension: the eight kinds counted most take colors in the order Commits colors its lanes, and the rest take Other's gray.
A key in the corner names them.

Each directory's subtrees are packed around it: the trees under it surround its files, each as a disc, as close as they fit without overlapping, the largest nearest, each turned to face away from it.
So a directory takes room by its files, not by how many directories it has, however broad.
A small directory beside a broad one shows as large as its files make it.
As the tree changes, only the directories it changes under are laid out again, and they move no more than they must.
A new directory is set in the nearest room for it, and a growing one pushes its neighbors aside, the smaller ones further; the room a directory leaves stays as it is.
Dots only a few pixels across, as in a large tree, are drawn as squares set as pixels, so a tree of tens of thousands of files plays as smoothly as a small one.

Those who made each commit, its author and co-authors, fly to the files it changes, each on a solid disc:

- A user of the app shows by their avatar.
- Claude, Codex and Copilot show as their apps' icons do: Claude's mark white on its orange, OpenAI's black on white, and Copilot's white on GitHub's dark.
- Another agent shows by its avatar, where the app has one.
- Anyone else shows by their name's first letter.

A beam runs to each file: green where the file is added, amber where it is modified, and red where it is removed.
The file glows as its beam reaches it; a removed file shrinks away, and a directory it empties goes with it.
The camera eases to fit the tree as it grows.
The day and how many commits have played show at the top.
The commit last played (its id, subject and who made it, as Commits shows them) shows along the foot, with what is under the pointer (a file's or directory's path, or who made commits) beside it.

**Last 100**, **Last 300** (the default) or **Last 1,000** picks how many of the latest commits play.
Merges are left out, since their other parents' commits change their files.
Commits play oldest first, in the order Commits uses: by their times, but never a commit before its parent, whatever an off clock dates it.
They are read as Commits reads a revision's history (a directory's, below the root), as many pages as hold them.
At 1×, each commit plays a second per day of time after the one before, but no sooner than 0.08 s and no later than 0.6 s, with quiet spells skipped as Gource's `--auto-skip-seconds` skips them.
**½×** to **8×** play it slower or faster.
Under the canvas are play and pause (once it has ended, play starts again from the first commit) and a track of the commits to seek through, the played part filled and the part read behind it.
A seek makes every commit before it at once, on the files it starts from.
Replay starts playing as it opens, unless the reader asks for less motion.

The files it starts from are read once (`GET /api/admin/repositories/tree`) and drawn as soon as they are.
What each commit changes is read twenty commits at first, then fifty at a time, the oldest first from where it plays, buffering as a video does while it shows.
At a commit not read yet, it waits and says so.
A commit of more files than are read (`more`, below) is made whole before it plays by the files it leaves, read as the starting files are; what it changes beyond them is made as it plays, or as a seek passes it.
Where the starting files, or the files a cut commit leaves, are more than are read, the summary says the replay is drawn in part: files beyond them are neither drawn nor, where a cut commit removes them, removed.
If a page of the history fails to read, Replay says so, with **Retry**, and takes no replay from the commits read so far.
Each replay, where it is and what was read, is kept for the session, and pauses when another view or count is picked.

`GET /api/admin/repositories/changes?repoId=…&path=…&shas=…` answers `{ path, changes }` (`repository-changes.ts`).
For each of the commits `shas` names (up to fifty), it gives `{ sha, files, more }`.
`files` lists its changes as `git log --name-status` names them: `[path, status]`, with `A` added (a copy too), `M` modified or `D` removed, or `[path, 'R', from]` renamed.
They come from GitHub's REST listing of a commit's files (`GET /repos/:owner/:repo/commits/:sha`), a hundred per page while each page is full, up to three hundred, with `more` set where it had more.
`files` is null for a commit GitHub has none of.
Within `path`, only its files are answered, and a rename across its edge is the file added where it comes in and removed where it goes out.
A commit's files never change, so each is kept whole by the commit (`repository/changes`, a month, as Commits' pages are) and read from GitHub once, six at a time.
They are read as the history is: with the reader's own GitHub access, only within their grants (a directory they reach all of), and with access checked again before they are sent.

`GET /api/admin/repositories/tree?repoId=…&path=…&commit=…` answers `{ commit, path, files, sizes, cut }`.
`files` holds the paths of the files the commit holds within `path`, and `sizes` their bytes in the same order; a directory's Treemap is drawn by them while its files are read, or where they are too many.
They come from GitHub's listing of the tree and every tree under it at once (`GET /repos/:owner/:repo/git/trees/:commit?recursive=1`): its blobs, not its directories or submodules, up to 75,000.
Where GitHub cuts that listing short (past 100,000 entries or 7 MB, as for a large repository such as nodejs/node), it is read as GitHub advises, a tree at a time.
It reads the tree's own entries, then each tree in it whole, or, where that is cut short too, that tree's own entries in turn, six at once, up to 400 trees.
Each round of trees is read whole, whichever tree answers first, except trees none of whose files could be kept (as deep as the 75,000 files nearest the root read so far, or deeper).
Past 75,000 files, those nearest the root are kept, and `cut` is set where some are left out, which the summary then says.
`files` and `sizes` are null for a commit GitHub has none of.
For a directory below the root of a tree cut short this way, whose files may be among those left out, the directory itself is read.
Its tree's id is read a level at a time, then its tree is read as the commit's is, kept by its id, with the files nearest it kept.
Trees are kept by the commit and the rules they are read by, as the changes are (`repository/trees`), and a tree kept by older rules (the last of them without sizes) is read again.
They are read with the same access as the changes.

# npm package viewer

Every role but `none` can open a published npm package version from the landing page's **npm packages** card, or at `/npm/<name>[@<version>]`.
Under its search box, the `/npm` page lists the reader's last ten searches that opened, newest first, each of which can be opened again or removed.
They are kept in the browser's `localStorage` per signed-in user, as a convenience, not access control.
While a version opens, its header shows at once, on the tab its link names.
Its version picker and tabs wait for the version, and the body says what is opening.

A version opens in the bundle view, with these tabs:

- **Overview**: its header names the package beside a picker of its versions, and links the package's page on npm.
  The picker is as wide as the version shown.
  It lists the versions as Compare's pickers do: searchable, newest first, several to a row as wide as the longest needs, with their dist-tags.
  The arrow keys move along a row and between rows.
  Switching versions keeps the tab shown.
  Until the versions arrive, the picker holds the version shown, disabled.

  Above the summary, where any file can be hard to review by reading it, a warning says how many files and why, by category.
  A file is counted under each category that applies to it, and once in the total.
  Each category's chip finds every file it applies to.
  The categories are:

  - Not UTF-8: the server could not read it as UTF-8, or it holds a NUL.
  - Control characters: the C0 controls except tab, line feed and carriage return; DEL; the C1 controls; and the bidirectional controls U+202A–U+202E and U+2066–U+2069.
  - Invisible characters: those Code shows as boxes, which text can be hidden in.
    They are found in the same pass as control characters, and told apart from them by code point.
    They are:

    - variation selectors, as a payload of one byte per selector, but not a variation sequence Unicode registers (an HTML entity's math symbol, a heading anchor's `#`), an emoji's selector doubled as copying text leaves it, or a block of them written out as a range in a table of the characters a name may hold;
    - Hangul fillers, as a name no one sees, but not those composing Hangul or among jamo;
    - tags, but not those of a subdivision flag Unicode recommends (England's, Scotland's or Wales's).

    A BOM, a zero-width space or a no-break space is not counted, as text has its uses for them.
  - Long lines: lines over 1,000 characters.
    They are a warning in otherwise readable files, as no one writes them, and a notice in minified code, where they belong.
  - Minified: most of its text is on long lines, or it is named `.min.` and has any, or, with none, its lines average over 110 characters and next to none of its spaces outside strings are ones a minifier drops (beside punctuation).
  - Source maps: `.map` files.
  - Inline source maps: code, minified or not, with a line that is a `sourceMappingURL` comment holding its map as a `data:` URL.
    Its tag gives the map's size.

  Prose is readable whatever the length of its lines: Markdown, text and the markup GitHub renders a README from, and licenses and changelogs such as `LICENSE-MIT`, but not code named alike, such as `lib/history.js` or `dist/notice.min.js`.
  An inline map's line counts as no long line, and does not count toward how much of a file is on long lines.
  A source map's long lines are not counted either, as long lines are all it is.
  A file with control or invisible characters or long lines keeps its other categories, but is no longer readable ASCII or UTF-8.
  For example, a minified file with a form feed in a regular expression is all three: minified, with control characters, and with long lines.

  Then come the manifest's facts:

  - Description.
  - License: each license in its expression opens its file in the package, the one named after it (such as `LICENSE-APACHE` for `Apache-2.0`), else its only license file.
  - Author, with their npm account linking its profile, where the publisher's or a maintainer's email or name is theirs.
  - Publisher: the publisher's account, where it is someone else's.
    Each account is green where it is known to publish one of npm's most downloaded packages, as `@preventive/publishers` lists them, else yellow.
    A version published by a CI npm trusts (`GitHub Actions`) shows that CI in grey, unless its provenance, once read, names what built it.
  - Published: when the version was published, and how long ago.
    Under two weeks old, it shows in the warning color, as a compromised release is mostly found and pulled within days.
    A version of a scope any visible team lists is that team's own and isn't flagged, and no version is flagged until the version list says whether it is one.
  - GitHub repository, with its stars, forks, open issues and open pull requests.
    GitHub counts issues and pull requests together, so the pull requests are counted separately from their list; where that fails, they show together.
  - Publish commit, with the tags that point to it.
  - Provenance, for a public package: npm's SLSA statement, v1 or the v0.2 it first wrote.
    It shows what built it, such as GitHub Actions or GitLab CI, on its own runners or the publisher's, as the certificate that signed it says (or, where it doesn't, GitHub's builder id); it is green on its own runners.
    It shows from which repository at which commit, flagged (and not green) where that isn't the repository the package names, on GitHub or GitLab.
    It shows how: its workflow at that commit, its run and its Sigstore transparency log entry, beside the rest where that fits whole, else on the next line.
    It shows None where npm keeps none, and is flagged where npm lists provenance but no statement naming the tarball can be read.
    It is never shown as attested while it is being asked for, or where asking fails.
  - Homepage, left out where it only leads to its GitHub repository, or to its directory or readme there, as npm's default does.
  - Integrity.

  Beside them are:

  - Entry points, each with its file's icon and opening its file; Main and Module share one row where they name the same file.
  - Engines.
  - Install scripts (preinstall, install and postinstall), in the order npm runs them, each with its name marked as a warning's and its command; a file the command names opens it.
    `node-gyp rebuild` shows where a `binding.gyp` has no install script of its own.
  - How many dependencies it has, with a chip for each check below that flags any of them, counting them and naming which in its tooltip.
  - Its files with the lines of code they add up to, its tarball's size, and what it unpacks to.
    Each but the tarball's size is tinted by how big it is: tiny, small, medium, large or gigantic.
    Files, lines and bytes are counted without the files every package has (package.json, readme and licenses).
    The steps are eight times apart, and agree for a file of about 130 lines and 5 KiB.
  - A card of its downloads: the latest week's (or month's) and the last year's, each with its unit (`1.2K/week`, `9.6K/year`).
    It shows the package's tier among npm's packages by downloads: top 10, 20, 50, 100, 200, 500, 1,000, 2,000, 5,000, 10,000, 20,000, 50,000 or 100,000, else unpopular.
    The tier is solid green to the top 200, tinted green to the top 5,000, yellow to the top 20,000, orange to the top 100,000, and red for the unpopular.
    It goes by the most downloads in any of the latest six weeks, so a week that is lower for days npm failed to count (zeros it may never correct), or for a holiday, doesn't move it.
    Where the version's risk finds the package known, its tier is yellow at most, even past the top 20,000: a known account published it, or it was published with provenance in a known scope, a known account's own among them.
    Its tooltip says why, as Compare's popularity chip does.
    The tiers' weekly bounds are rounded estimates, to be revisited.
    They come from download-counts' snapshot of a month (Jan 30 – Feb 28, 2026), each rank's count grown by the median growth of the packages ranked around it to the 30 days Sep 9 – Oct 8, 2026, as npm counts them, then made a week's.
    Below them is a chart of the downloads across the year, by week or by calendar month (the last twelve complete ones), with the switch between the two at its top right and the hovered period's downloads under it.

  Under the card are the version's pages on npmjs.com and, for a public package, Socket, beside the tarball download.

  Under those comes the version's risk score, out of 100, as risk tells it (`score`, risk/npm/score.js).
  It is a ring filled to the score: red from 75, orange from 50, yellow from 25, else plain.
  Its tooltip lists the findings that raised it, each with its severity, and how much the version's time out among its package's downloads lowered that.
  After it come chips for what calls for a look at the version on its own.
  They are Compare's chips, without those only a change from one version to another can tell (a publisher, provenance lost, new files and hosts):

  - its deprecation;
  - its install scripts, named, with their commands in the tooltip;
  - dependencies from elsewhere than npm's registry, or imported by nothing of it;
  - in orange, what any of its files runs beyond itself, as the kinds alone (`eval, child_process`), with `Runs code` heading its tooltip;
  - the credentials any file reaches for (`Credentials`), each file's by name in its tooltip (`NPM_TOKEN or GITHUB_TOKEN (line 7)`);
  - the hosts its files name, a chip for each tag (Exfiltration in red, Remote in orange, IP lookup in yellow), with the services named and the files and their lines in its tooltip;
  - an obfuscator's fingerprint, with the files and their lines in its tooltip;
  - its age, where under two weeks;
  - the advisories affecting it, tinted by the worst;
  - Socket's scores under their bars (yellow from 50, red under 50);
  - its tier by downloads where it is orange or red, tinted as its tag beside its downloads is.

  Above the facts, where npm's security team took the package down, a banner says so.
  Such a package is npm's "security holding package" placeholder, told by its description, by its npm/security-holder repository with npm as its publisher, or by a `-security` version as npm's staff publish it.
  Also above the facts are the alerts Socket raises on the version, such as malware, each with its severity, the file it names (opening it) and Socket's note.
  They are left out on npm's placeholder, which holds nothing but the files every package has.

  A file an alert names is labelled with it, in its severity's color, in the Files list and in Compare's file heads and tree, each version by its own report.
  A script is labelled with what its code can do beyond itself: `eval`, `child_process`, `credentials`, `whole env`, `publish`, `shell` or `persistence`.
  A file that names a host of those kinds is labelled Exfiltration, Remote or IP lookup.
  Each label is in its color, as Compare labels them, with its lines in the tooltip; a label on a single line opens the file's code at that line when clicked.

  Under the facts come its languages, then its readable files as UTF-8 or ASCII, then its file types, side by side where they fit.
  The file types are:

  - Package, for the files every package has at its root: `package.json`, a readme, and license files such as `LICENSE`, `LICENSE-MIT` or `LICENCE.md`.
  - Then each extension with its count.
    An extension that only those Package files have is left out; one that other files have too counts them as well.

  Each type's tooltip gives its files' size and, where they are text, their lines of code.
  Then, for a public package, come Socket's scores: supply chain, vulnerability, quality, maintenance and license, out of 100, as Socket's page shows them.
  Socket's overall score is only the lowest of them.
  Each is a small chip as wide as its text, after a ring gauge filled to the score.
  It is tinted for 80 and over (85 for supply chain and vulnerability), for 50 and over, and for under 50, in red; a full score's number is green.
  Each category's chip, and each file type's, narrows the Files list to its files, one at a time.
  The Files head names the filter, with a way back to every file.

  Then come its columns:

  - Dependencies, where it has any (peer and optional ones included), with their kinds and ranges lined up.
    A dependency opens in the viewer at its latest version (an `npm:` alias at the package it names) where npm installs it from its registry.
    It does not open for a path (`file:` or `./x`), a repository, a URL, or what npm doesn't install (`workspace:`), as the registry's package of that name isn't what npm installs.
    Each is tagged after its name where it calls for a look:

    - non-registry: npm fetches it from elsewhere than its registry, as npm-package-arg resolves a dependency's spec, with hosted-git-info reading a repository's host.
      This covers a repository on GitHub, GitLab, Bitbucket, Gist or SourceHut in any form npm takes (`github:owner/repo`, GitHub's `owner/repo` shorthand, `git@github.com:owner/repo`, `ssh://`, `git+https://` or `https://github.com/owner/repo`), named for its host.
      It also covers another `git:`, `git+https:` or `git+ssh:` repository, and an `http:` or `https:` tarball.
      It does not cover a `file:` path, what npm doesn't install (`workspace:`, `ssh:` to another host), or what npm reads as a path (`git@example.com:org/repo`).
      Its spec is in its tooltip.
    - unimported: nothing of the version imports it.
      No code file names it as an import would: quoted, alone or before a path (`'name'` or `"name/sub"`), after webpack's `~` too, or built from a part of its name up to a `-` or `/`, as a package picks its platform's build (`` `@rollup/rollup-${platform}` `` or `"@typescript/" + name`).
      Prose (but not MDX, which imports), source maps, lockfiles and the package's own package.json are not searched.
      No install script npm runs names it either.
      npm installs it all the same and runs its install scripts, as it would for a dependency added for those alone.
      A peer dependency is never tagged, as whoever installs the package provides it.
      Nor is one of DefinitelyTyped's `@types/`, nor the package a DefinitelyTyped stub of its types depends on once that package has types of its own (`@types/mkdirp` 2.0.0 on mkdirp).
      Such a stub is nothing but prose beside its package.json, with no code to import it, and depends on the registry's package by that name (not an `npm:` alias of another, a repository, a URL or a path).

  - Advisories, across every published version, one row each.
    Its head counts those that affect the version shown.
    Those come first and are marked; those fixed in it (affecting only older versions) are struck through; those affecting later versions, and perhaps older ones too, are plain.
    Each opens its text, where its source has one, as on the Advisories tab.
  - Files, each with its type's icon (a source map's is a folded map) and tagged with its category.
    Its tags name the control or invisible characters or long lines it holds.
    Each label a file has shows (Controls, Invisible and Long lines beside its category), except ASCII, as most files are, and Map, as a source map's name says it; Compare's file heads tag both, and how a file changed.
    Before them, Large shows quietly on a JavaScript or TypeScript file of 256 KiB or more (not a declaration file), which says little of a file alone.
    Obfuscated shows as a warning on a file with an obfuscator's fingerprint: 20 or more names such as `_0x1a2b` (`_0x` and four to six hex digits), or the loop `while(!![])`, as javascript-obfuscator writes.
    Prose is never Obfuscated, nor is a source map, which holds the names of the code it maps.
    The files are ordered by name or size.
    Where any file listed is flagged, they are ordered by their flags instead: the most severe first, then the most flags, then the flags' names, then the path, with unflagged files last.
    Severity runs from a critical alert, to a warning's flag or a high alert, to a moderate or a low alert, to a notice's flag.
    A file's flags are Socket's alerts on it, what it runs beyond itself, the hosts it names (critical for Exfiltration, a warning's for Remote and moderate for IP lookup, in Compare a level higher where new to the file), and a warning's or a notice's tag.
  - Its binary files again on their own, where the package has any.

- **Code**: the file tree and source viewer, opening on what `main` names.
  Each file's head links it on GitHub at the commit the version was published from, where npm recorded both its repository and that commit, as a stasis bundle's heads do.
  The link is in the directory its repository names; a file its build wrote may not be in the repository.
  Compare's file heads link each file as the side it is read from has it.
  A minified file (as the Overview tags them) of a language the server formats has a pretty-print toggle in its bar, as a managed bundle's has.
  Turned on, the file shows as the server formatted it, and so does each minified file opened after, until it is turned off.
  The first time one is wanted, the version's minified files are asked for all at once, in one request (see `GET /api/npm/pretty` below).
  The formatted copy has lines of its own, so line links and marks stay on the file as published.
- **Search**: the bundle Search across the version's text files, at `/npm/<name>@<version>/search`; a file that isn't text has nothing to match.
  Each match shows with the lines around it, with case and regular expressions as toggles.
  A result opens its file beside the results, with its pretty-print toggle there as in Code.
- **Treemap**: the files by size, as for bundles.
  They are colored by the top-most directories that tell them apart, as package colors can't tell one package's files apart.
  Below the directories every file shares, each directory has its color, and the files loose in a directory passed on the way have one more, the largest first: `src/a/`, `src/b/` and `src/*.js` for `src/a/a.js`, `src/b/b.js` and `src/c.js`.
  A package of loose files alone is colored by extension.
  Any bundle of a single package is colored the same way.
- **Compare**: the bundle Compare, with another version of the same package.
  The other version is picked from its versions, newest first, each with the day it was published, flagged under two weeks old as on the Overview, with how long ago in its tooltip.
  Both pickers have one width.
  From the start, that width is at least as wide as the package's name with a version as long as `10.90.90` tagged `latest`, so most pickers don't move as the versions arrive.
  Then it grows wide enough for any version listed, each whole with its tags (up to 24 characters of them).

  At the end of its picker row, once the two are compared, chips flag what calls for a look:

  - The open version's risk score against the one compared with, as the Overview shows it.
  - An open version npm says is deprecated, with its message in the tooltip.
    npm's placeholder message (`Package no longer supported. Contact Support at https://www.npmjs.com/support for more info.`) is cut to its first sentence, as the Overview lists it.
  - A publisher that changed, where npm names the account that published each version and they differ (`~alice → ~bob`), as when a package changes hands or is taken over.
    It links the new account's profile.
  - Provenance lost, where npm lists provenance for the version compared with and none for the open one, as for a version published by hand with a token taken from its maintainers.
  - Install scripts the open version adds or changes (`postinstall added`), including node-gyp's `install` for a `binding.gyp` it adds, but not one it drops.
    Its tooltip has each version's scripts with their commands.
  - In red, code that runs beyond itself and is new to a file the open version adds or changes, though the files' own tags say little of it alone or warn of it in orange.
    The chip names the kinds alone, as the file's tags say them (eval, child_process, whole env, publish, shell, persistence), with `Runs code` heading its tooltip.
    The tooltip lists each file with its new kinds and their lines, each way a string runs as code by its own name (`Function (line 2)`).
  - A credential new to a file the open version adds or changes, under `Credentials`, each by its name (`NPM_TOKEN or GITHUB_TOKEN (line 7, new)`).
  - A host new to a file the open version adds or changes, a chip for each tag, a level higher than the tag's own (`Exfiltration` and `Remote` in red, `IP lookup` in orange), with the services named (`webhook.site`).
    Its tooltip lists each file with its new services and their lines.
  - `Large new code`: a code file of 256 KiB or more that the open version adds (not one renamed).
  - `Now unreadable`: a file it changes that had no line over 200 characters and now has one over 2,000.
    Prose, source maps and an inline map's line are left aside, as its Long lines or Minified tag says of it.
  - `Obfuscated`: a file it adds or changes with an obfuscator's fingerprint, where the version compared with had none.
  - `Binary code`: a JavaScript or TypeScript file it adds or changes that isn't text (not UTF-8, or holding a NUL), where the version compared with's file was not one.
    Each of these four counts its files where there are several; only its tooltip lists them, each with its size, its longest line before and now, or what its fingerprint holds.
  - In orange, as the files' tags are, what any file of the open version runs beyond itself that the red chip doesn't name, kept from the version compared with (the kinds alone).
    Its tooltip lists each file with its kinds and their lines.
  - `New hosts`, in orange as a whole, as a chip naming its issue is: the hosts the open version's code names that none of the compared version's files named.
    The chip shows the host where there is one, else how many.
    A host counts where a URL names it in a script's strings, regular expressions and template literals, comments aside.
    A host built as the code runs does not count, nor does this machine's, the names kept for examples and tests, a local network's, or W3C's, whose URLs name XML namespaces.
    Its tooltip lists each host with every file that names it and the line it is first named on there.
    Where one host is named in one file alone, the chip opens that file at its line in Code.
    Each file naming one is tagged `New host` in its head and in the tree.
    That tag's tooltip lists the hosts with their lines and, under them, the version none of whose files named them (`None of 1.0.0-beta.3's files named them`).
  - `Non-registry deps`: dependencies the open version takes from elsewhere than npm's registry, as the Overview tags them, where the version compared with didn't, or took them by another spec.
    Their names and each version's spec are in its tooltip.
  - `Unused deps`: new dependencies that nothing of the open version imports, as the Overview tells (`plain-crypto-js`, which axios 1.14.1 added to run its postinstall).
    Their names and ranges are in its tooltip.
    One that was another kind of dependency before is not new.
    The chip is tinted as risk grades the dependencies by their packages:

    - red for one first published since the version compared with (`new package, 18 hours old`), or whose range installs a version published since with install scripts that is not its package's latest (`installs 3.0.1 (its latest 4.0.0), published since 1.0.0, running its install scripts`);
    - orange where that version has install scripts;
    - yellow for one among npm's top 20,000 (`npm's top 200`), as a dependency named for another's peer is, or where they were all kept from the version compared with;
    - orange otherwise;
    - a notice's tint for lodash and Babel's presets alone (`no risk counted`).

  - An open version under two weeks old, as on the Overview, showing how long ago (`3 days ago`), with the day in its tooltip.
  - The advisories affecting either version, counted from the version compared with to the open one (`2 → 1`, one number where they match).
    The chip is tinted by the worst still affecting the open version, or green where none does.
    Its tooltip has a row for each version's advisories, their severities in their colors, and how many the open version brings and fixes.
    A click lists them in a dialog, with rows as in the Overview's Advisories column: those the open version brings, marked; those it still has; and those it fixes, struck through.
  - For a public package, each of Socket's scores the open version has under its bar, from the version compared with to it.
    A score it raised past the bar, as `81 → 100`, isn't flagged.
    Its tooltip has a row for each version's score with its ring, and the bar it is shown under, tinted as on the Overview.
    The bars are:

    - supply chain under 85;
    - vulnerability under 85, only where it tells of worse than the advisories found affecting the version, as where none are found, or a moderate one next to its 84;
    - quality under 70 (a sabotaged release such as faker's 6.6.6 scores 38; most widely used packages score 70 and up);
    - maintenance under 70 (a deprecated or abandoned package's is 50, a finished one's 75 and up), and for a deprecated open version only under 50, as its Deprecated chip says as much;
    - license under 80 (a copyleft or unusual license's is 70, as AGPL's or WTFPL's).

    Socket's vulnerability score counts much the same advisories: under 85 for a high one (84 for one alone), and 25, its floor, for a critical one or many high ones.
  - The package's tier by downloads where it is orange or red (past the top 20,000), with its last complete month's downloads in its tooltip.

  Compare's Overview has a Dependencies section in place of Packages.
  It lists the dependencies only one version has and the ranges that changed, each opening its package.
  A changed one whose ranges each name a version (`^1.2.0` → `^1.3.0`) opens its Compare between those.
  Each one the open version adds or changes is tagged as its chips flag it.
  One it adds that opens a package is tagged with that package's tier by downloads, whatever it is, tinted as the package's own is.
  That tier goes by its downloads to the day before its latest two weeks (which a package a release just pulled in could owe to that release alone), as the server's risk tells it (`/api/npm/risk`).
  A version-specific check, as of a version's age or publisher, would have to cover every version its range takes.
  The tier is unpopular where npm counts none of its downloads, and npm has the package for anyone.
  npm counts none of a package's downloads until the day after it was first published: axios 1.14.1, published 21 minutes past midnight, named plain-crypto-js, first published the morning before.
  A private package has no tier, as npm's API tells no one its downloads.
  One below the top 20,000 whose package didn't exist when the version compared with was published (its first version, one since unpublished among them, published after it) is tagged with how old it was when the open version was published (`18 hours old`).
  Where it came after that, it is tagged `published later`, as a name someone took once a release named it would be.
  Either tag has the day in its tooltip.
  Its whole document is asked for only then, as a package many install isn't one to doubt for being new.

  Compare's Files section is open from the start, under the Overview's warning where any of the files can be hard to review by reading them.
  It shows each file's type, and, for the files the open version adds or changes, their category and Large or Obfuscated, as in the Files list.
  Each group is ordered by name or size, or, where a file in it is flagged, by its flags, as the Files list orders them; a stasis bundle's flags include what it records of a changed file, such as `+x` or a format.
  Files that are not text compare by digest.
  **Swap** opens the version compared with, comparing it with the one before.
  Both sides are pickers, in the same order as for bundles, the version compared with first.
  Picking the open side's version opens that version compared with the same one, and picking the other side's swaps them.

  Code reviews the changes as for bundles.
  Over the package's package.json, its dependencies' changes (plain, peer and optional ones, not dev ones) show under one head counting them.
  Each is a chip with its range beside its name, and a new one's tier by downloads after it.
  The chips are tinted as the Dependencies section's groups are: those the open version adds, those whose range it changes (`~1.3.8 → ^2.0.0`), and those it drops, struck through.
  Each opens and is tagged as there, and the head counts those tagged by each tag (`1 non-registry`).

  As Compare opens, it asks the server for every changed file's two sides pretty-printed, in one request (`GET /api/bundles/:id/pretty?other=`, `GET /api/npm/pretty?otherVersion=`), whether the toggle is on or not.
  Copies the server kept come at once.
  A file that request brought none of is asked for alone, and a failure that may pass is asked again a while after, twice as long each time.
  The pretty-print toggle is offered where printing changes a diff, in the file shown or any file the Diff view lists.
  That is a file minified on either side, as the Code tab prints one, or one whose two copies diff in fewer changed lines than its texts as published, as where only its formatting changed (a semicolon added to every line).
  With the toggle on, those files diff as the server formatted each, and the others as published.
  A file whose copies are the same says there are no actual code changes in it, without telling its texts as the same.

  Printed, a JavaScript file (`.js`, `.mjs`, `.cjs` without JSX) that is minified on both sides, with a minifier's names, marks its renamed lines.
  The two sides are diffed as they are, and the lines that differ only in renamed names are drawn faint and counted apart (`≈`).
  The diff is drawn plain until the server answers.
  Renamed names are those a minifier renamed alike throughout: short ASCII names that a declaration in scope stands for, on every line, removed ones too.
  Short means three characters at most, as a minifier gives them, and none that a reader can't tell apart from another.
  **Hide renamed names** instead gives the old side the new side's names, so that the two sides then diff as they are.
  It is offered where the server finds lines to mark, and, while on, so that it can be turned off.
  An old variable that no new one stands for reads as `r_old` where the new side uses its name `r`, never as the new one.
  The server works this out from the two copies (`GET /api/npm/rename-diff` below, `GET /api/bundles/:id/rename-diff` for bundles), so it is done with the pretty-print toggle on, for a managed bundle's or a version's files.
  The server says why where it hides no names after all.
  The viewer takes the server's diff, checked there, as it is, once the diff names the two files asked about and, by their hashes, names the two copies the viewer draws as those it was worked out from.
  Otherwise the viewer shows the names, and asks again when the names are hidden again.
  Where either side reads names, whose values a rename may change, hidden renamed names come with a note saying so and offering them marked.
  Reading names means `.name` (told only where a renamed name is a function's or class's), `.toString`, `.stack`, `.callee` or `.caller`.
  This is done for those files alone: an author's name renamed, to a minifier's or to another author's, always shows.
  A global (`Map`, `$`) is kept, as is a name declared at a script's top level, which another script may read as a global.
  A module's top-level names (`import`, `export`), or a CommonJS module's (`require(…)`, `module.exports`, `exports.…`), are its own.
  These keep their names: keywords, properties (after `.`, or an object's, a pattern's or a class's keys and methods), labels, names a module exports or imports by their own name, shorthand properties' names, strings, templates, regular expressions, comments, and longer names.

A dist-tag link, such as `/npm/lodash`, is committed to history at the exact version it opened.
Code links name files by number and lines in the fragment, and Compare links name the version compared with and its mode, as for bundles.
The browser keeps the last three public versions it read, and the package's version list, figures and advisories, in memory for the session and role that read them, so a swap or Back reopens one without another request.
A private version is asked for each time it opens, so the server checks again for access the reader may have lost since, such as to a team's npm scopes.
A version list, figures or advisories that failed are asked for again after ten seconds, then twice as long after each failure in a row, up to five minutes, on a repaint scheduled for then.

`GET /api/npm/package?name=&version=` returns `{ name, version, private, integrity, tarballSize, published, manifest, files, known }`.
`version` defaults to `latest`.
In it:

- the manifest's `publisher` is the npm account that published the version, never its email;
- or the manifest's `trustedPublisher` is the CI npm trusted to publish it, as npm names it (`GitHub Actions`);
- its `knownAccounts` are those of its publisher and author known to publish (`@preventive/publishers`);
- its `provenance` is true where npm keeps a provenance statement for it;
- its `gitlab` is the GitLab project its `repository` names (`group/project`), as `github` names a GitHub one;
- each file row is `[path, bytes, text]`, or, for a file that is not UTF-8, `[path, bytes, null, 'sha256-<base64>']`.

`published` is when the version was published (ISO), or null where that isn't known yet.
A version's time never changes once published.
Each publish time that a read of the package's whole document gives is kept in memory while the server runs, up to 100,000 of them.
A public version's time is also kept in the database for a month (`npm/publish-times` rows of `managed_upstream_cache`, `npm-kept.ts`), so it comes with the version on any instance, or after a restart.
Because of this, the Overview needn't wait for the version list to show it.
A private version's time is never read from or written to the database.
`known` carries what the server already keeps about the package, so the viewer need not ask for it: `stats`, `advisories`, `tags`, `socket` and `provenance`, each as its own route below answers it.
`stats` is there where the figures of the repository the latest version names are kept too, `advisories` where they are kept for a version list that has this version, and `tags`, `socket` and `provenance` for this version.
While the version's files load, the server asks for each of these itself, as its route would, so that what is answered by the time the files are encoded comes with them.
Nothing waits on it: what isn't answered yet is left out, for the viewer's own request to share.
The package's whole document, read for its advisories' version list and for when each version was published, is read here only where registry reads leave room for two more of readers' own.
The version list the viewer shows is never kept, and is always asked for separately.
A version naming no repository or commit has no tags to ask for, and a private one has no Socket report.

`GET /api/npm/versions?name=` returns `{ name, private, distTags, versions, times, created, teamScoped }`, newest first:

- `times` is when each version was published (ISO dates), from the registry's whole document rather than its abbreviated one;
- `created` is when its first version was published, one since unpublished among them: the earliest time the document lists, which npm's own `created` can postdate, as a placeholder's does for a package npm took down;
- `teamScoped` is whether any visible team lists its scope, whatever teams the reader is in.

`GET /api/npm/download?name=&version=` returns the tarball.

`GET /api/npm/risk?name=&version=&otherVersion=` returns what calls for a look at a version, as risk tells it (risk/README.md, `assessNpm`).
It compares against `otherVersion` where given, as Compare asks.
Otherwise it compares against the version of the package most likely free of what an attack injects, as risk picks it (`oldVersion: true`), as the Overview asks.
`otherVersion=(empty)` compares every file against an empty package, for initial dependency reviews, with the same risk findings and chips.
It returns `{ name, version, oldVersion, published, findings, files, dependencies, score }`:

- `oldVersion` is the version compared with, or null for none;
- `score` is its risk out of 100, with what raised it and what lowered it (risk/README.md).

What the version holds is told either way, with what changed folded into it, never lowering it.
Risk is told on this server alone.
The npm viewer shows it as told and computes none of it, on the Overview and in Compare alike, and for each side's files.
The version risk picks has its document read as the open version's is, for its tarball.
A team's own scopes are trusted however new (a minimum release age of 0); any other version is held to two weeks.
A team's own scopes are also trusted however few download them: a version of one is not flagged `popularity`, and a new dependency on a package of one is told no tier nor age, and npm is not asked about it (assessNpm `owned`).
What risk reads is kept by its type (`npm-risk.ts`):

| Record | A public package's | A private package's |
| --- | --- | --- |
| `risk/npm/assessments` | the public npm cache, by a hash of its key | memory |
| `risk/npm/versions`, versions' documents | the database's upstream cache table, shared by every instance | memory |
| `risk/npm/downloads` | the database, for risk's week, each row removed a day past it | memory |
| `risk/npm/packages`, `risk/npm/old-versions`, `risk/npm/public`, `risk/npm/advisories`, which risk asks again after an hour | memory, read first, and the database, by a hash of type and key, each row removed a day on; one over 256 KiB as JSON in memory alone | memory |

So a cold instance, as a serverless one starts, does not read again a whole document of npm's that an instance read within the hour.
Memory holds at most 2,000 records and 64 MiB as JSON, the first kept going first.
Nothing of a private package is shared.
A cache failure is a miss, never a failed assessment.
Packages' documents are read as the others here are, within their bounds and shared budget.
Tarballs are read as the viewer's loads read them, and kept where they keep them.
At most four assessments run at once, as at most four loads do.
Past any of these bounds, risk answers 429 `npm-busy`.
A tarball past their bounds or risk's is 413 `package-too-large`.

`GET /api/npm/stats?name=` returns `{ name, downloads, github }`:

- `downloads` is `{ start, end, days }`, a count a day over the last year from npm's downloads API, reaching back to the first of the month the year starts in, so its months are whole; the last 365 days make the year's total;
- `github` is `{ repo, stars, forks, openIssues, openPulls, archived, pushedAt }` for the repository the latest version's manifest names;
- `openIssues` takes in the open pull requests, which `openPulls` counts separately, from the last page of their list at one per page (null where GitHub didn't say).

Either is null where it can't be had, and `github` is null for a repository GitHub does not say is public.
GitHub answers for a repository renamed or transferred since with a redirect to it by its id (`https://api.github.com/repositories/<id>`).
Upstream follows that redirect once (`getRepo`'s `followRedirect`), with the same token, and `repo` is then the repository's current name.
A redirect anywhere else, or a second one, means there is no repository to show.

`GET /api/npm/tags?name=&version=` returns `{ name, version, tags }`: the tags of its GitHub repository that point to its publish commit (`gitHead`), among those whose names hold the version (`v1.2.3`, `pkg@1.2.3`).
The Overview shows them after the commit.
GitHub's GraphQL API finds them by name, and needs a token: the reader's own, where they have one; without one, none are asked for.
Only a public repository's tags are answered, kept an hour for that repository and commit.

`GET /api/npm/advisories?name=` returns `{ name, versions, advisories, repository, keptAt? }`, asked as bundle advisories with repository advisories are:

- what `npm audit` asks npm's registry, for every published version at once (`source: 'registry'`);
- what OSV has besides, for a package anyone may read (`source: 'osv'`), the malicious packages' records among them;
- what the package's GitHub repository publishes that npm does not report yet (`source: 'repository'`).

That repository is the one its latest version names.
It is asked for only where GitHub says it is public, asked afresh rather than from its figures' kept answer, since the list is kept for every reader and the reader's token could read a private repository's.
Its listing is kept where bundle audits keep theirs.
A repository renamed or transferred is followed as for its figures; its listing is asked for and kept under its current name, and taken as kept under that name where GitHub refuses it.
For one that leads to a repository GitHub doesn't say is public, none is asked for, leaving npm's, with `repository` true.
Each advisory is `{ id, source, ghsa?, url?, title?, severity?, cvss?, cwe, range?, details?, affected }`:

- `details` is its text (Markdown): OSV's record of an npm advisory's GHSA, or a repository advisory's own description;
- `affected` indexes `versions`.

There is one row per advisory: npm's registry answers once for each range an advisory covers, and those rows are merged here, their ranges joined with `||`.
Where GitHub refuses the listing (its anonymous rate limit, say), or can't say whether the repository is public, the listing last kept for it is taken instead, however old.
It is read where audits keep listings, on disk or in `managed_upstream_cache`, never written, and checked by upstream as its own listings are.
`keptAt` says when it was kept.
GitHub is asked nothing for it, and an audit that fails with it is npm's failing, not asked a third time.
Only where none is kept, or upstream won't take it, is `repository` false, leaving npm's alone.
A repository GitHub says isn't public never has its kept listing taken.
Such a list, with a kept listing or npm's alone, is asked for again on the next request.

`GET /api/npm/socket?name=&version=` returns `{ name, version, socket }`: Socket's report on the version, as Socket Firewall asks for it (no key).
`socket` is `{ scores, alerts }`, or null where Socket has none:

- `scores` are each 0 to 1 (`overall`, `supplyChain`, `vulnerability`, `quality`, `maintenance`, `license`), cut to two decimals;
- `supplyChain` takes the version's Socket badge's rounding where that is lower, or at most 0.01 higher;
- `alerts` are most severe first, each `{ type, severity, category, file, note }`, `file` being its path in the package.

Where the badge can't be had, as while Socket limits how often it's asked, the report is answered as Socket gives it and asked for again next time.
Socket is asked only about a version npm answers for without a token: a private package's name never leaves for it.

`GET /api/npm/provenance?name=&version=` returns `{ name, version, provenance }`: npm's provenance for the version, `{ repository, commit, workflow, ref, builder, run, logIndex, runner }`:

- `repository` (its source repository) and `run` are https URLs;
- `runner` is the runner environment that the certificate that signed it names: `github-hosted`, `gitlab-hosted` or `self-hosted`;
- each part is null where they don't say.

It is read from the SLSA statement npm's registry keeps beside the version, v1 or v0.2.
A v0.2 run, given as `<run id>-<attempt>`, is made into GitHub's URL.
GitLab's statement, as npm writes it, names its project with no ref, and its job's URL as its run.
It is read only where the statement names this version's tarball by its name, version and sha512 digest.
Its signature isn't checked here, as npm checks it when the version is published.
It is null where npm keeps none, and for a private package.
It is asked for only where the version's manifest says npm keeps one, without a token, and kept for an hour; a failure is answered as one.

`GET /api/npm/pretty?name=&version=` returns every one of the version's files that needs pretty-printing (`needsPrettyPrint` in `common/pretty-print.js`): one the viewer tags minified, of a language formatted, of at most 4 MiB.
Each is formatted and checked as a bundle's are (`GET /api/bundles/:id/pretty`).
It is Brotli-encoded `application/x-ndjson`: a line per file, in path order, each sent as it is formatted.
Copies already kept are read up to eight ahead of the line being sent.
Each line is `{ path, source, text }`, or `{ path, source, error, status }` where the file has no copy (`unformattable`, `pretty-mismatch`, `pretty-busy`, …).
`source` is the `sha512-<base64>` of the file's bytes it was formatted from, which the client checks against the text it was sent.
With `otherVersion=`, it returns instead the files that changed between the two versions, both sides', as `GET /api/bundles/:id/pretty?other=` has them for two bundles.
Each line then names its `side`, and the response is private where either version is.
With `path=&hash=`, it returns one of the version's files, as `GET /api/bundles/:id/pretty?path=&hash=` does for a bundle, for a pair a comparison brought none of.
The files are loaded once, as for `package` and within the same four loads at once, before anything is answered, so a version that can't be loaded is refused as `package` refuses it.
Access is checked again before each line, and a reader who lost it has the response cut short.
A public version's copies are kept by content hash under `cache/npm/`, unencrypted, as what they are made from is public.
Anyone who may read a public version reads them from there.
A private version's copies are made for each request and never kept.

`GET /api/npm/rename-diff?name=&version=&path=&hash=&otherVersion=&otherPath=&otherHash=` diffs one of the version's JavaScript files with one of `otherVersion`'s, of the same package, from both pretty-printed as `pretty` has them, as a bundle's are (`GET /api/bundles/:id/rename-diff`).
Without a file, it diffs every pair of them, a line each, as for a bundle.
A diff of two public versions' files is kept in memory among the last few dozen; a private one's never is.
A private one's sides are formatted again for it, and read in its turn among the diffs waiting.

`GET /api/npm/type-only?name=&version=&otherVersion=` tells which of their TypeScript files changed in types alone, as for a bundle (`GET /api/bundles/:id/type-only`); nothing of it is kept.

`GET /api/npm/delta?name=&version=&otherVersion=` counts the lines the version adds and removes against `otherVersion`, or its whole package's against `(empty)` (`npm-delta.ts`).
It returns `{ name, version, otherVersion, additions, deletions, typeless, binary }`:

- `additions` and `deletions` count their text files' lines, as git's `--numstat` counts them, with renames found as git finds them;
- `typeless` gives the counts of the rest where some declaration files changed in types alone, as compareTrees proves them (`typeOnly`, an added one's left an empty runtime or a bare `export {}`), else null;
- `binary` says whether a binary file, none of whose lines are counted, was added, removed or changed; one moved counts as unchanged.

A delta kept before it told of binary files is worked out again.
It is worked out in a worker, two at a time per process, and the versions' files are read only once its turn comes.
Sixty-four more may wait (`429 delta-busy` past them).
One asked for again meanwhile shares the first's, even while the database is still being looked in.
It waits at most a minute for its turn, and counting takes at most a minute (`504 delta-timeout`).
Both sides' text together may not pass 64 MiB (`413 package-too-large`).
It is kept by both sides' integrities, in the instance and in the database (`npm/deltas`, a month), as what a version holds never changes.

`GET /api/npm/comparison?name=&version=&otherVersion=&otherName=` compares the version shown with `otherVersion`, as for a bundle (`GET /api/bundles/:id/comparison`).
`otherVersion` is of `otherName` where Review compares a dependency replaced by another package, or `(empty)` for none.
Each package's private access is checked before, and again once the comparison is worked out.

Responses are `private, no-store`.
Apart from what is said above to be kept, and a public version's unpacked files, kept in memory for a minute (see below), nothing derived from a package's files is kept on the server.
A package's figures and advisories, which are public, are kept an hour.
npm is asked for them without the server's npm token, and GitHub with the reader's own token where they have one.
Access to the package is checked first on every request, as for its versions.

Anyone with workspace access can read public packages.
Private packages need the server's `NPM_TOKEN`, the same one bundle builds use, and a reader with access to them: an admin or manager, or a member of a visible team that lists the package's scope.
Admins list scopes per team in **Manage → Teams → npm scopes** (`POST /api/admin/teams/set-npm-scopes` with `{ teamId, scopes }`, replacing the team's list).
`GET /api/admin/teams` returns each team's `npmScopes`.
Scopes are lowercase, with `@` added when typed without one.
Changes are recorded in the activity history, and scopes are removed with their team.

For everyone else, a version is public only when the registry answers for it without credentials.
Only that answer is kept, never one read with the token.
Leaving the token out is not enough: documents and tarballs that a bundle build fetched with the token can remain in upstream's caches, readable without one.
An exact version's document that npm answered anonymously is kept in the database (`npm-kept.ts`), with only the fields read of it.
The viewer, dependency reviews and repository risk scans read it from there for a day rather than ask npm on every read, then ask again.
npm never changes a version's files, but its document can change within that day: its owner can deprecate it or make a scoped package private (a private answer is never kept), or npm can remove it.
A dist-tag such as `latest` is asked for each time.
A version npm removed stays readable for that day where its document is kept (and its tarball, where that is kept too); risk tells it as removed, from the package's whole document.
Tarballs may still come from upstream's caches, as the anonymous answer names the sha512 the tarball must have.
A tarball kept in upstream's cache directory (`npm/tarballs`, where bundle builds keep theirs), or in npm's own cache, is served only when it matches.
Otherwise the tarball comes from the registry, at the package's own path, without credentials for a public version.
It is checked against that sha512, and then kept in upstream's cache, where the server has one.
A package's whole document, as risk and the version list with publish times read it, is kept there too where it is public (`npm/packuments`, gzipped, with npm's ETag).
It is served only when the registry, asked anonymously with that ETag, answers 304.
The request is still made on every read, but npm sends nothing more while the document is unchanged (a large package's runs to megabytes).
One only the token could read is never kept, and one npm no longer has for anyone is dropped.
This is off Vercel only, as upstream's cache is.
Readers with private access also try the registry anonymously first, and retry a scoped package with the token.
Their answer says `private: true` when only the token could read it.
Access is checked again after the registry answers, and a reader who lost private access meanwhile gets 404.
A version npm doesn't have, and a private one the reader cannot open, are both 404 `package-not-found`.

Packages unpack in memory, within these bounds:

| What | Bound | Past it |
| --- | --- | --- |
| A package's files | 64 MiB and 20,000 files | 413 `package-too-large` |
| Its tar stream | 96 MiB, of at most 40,000 entries, directories among them, given up on as the one past that is reached | 413 `package-too-large` |
| Its files as the viewer's JSON | 96 Mi characters, counted before it is written, as escaping can grow a text sixfold | 413 `package-too-large` |
| A tarball as it arrives | 96 MiB, whatever sizes its document declares | 413 `package-too-large` |
| Loads at once per process | 4 | 429 `npm-busy` |
| Registry documents being read at once | 256 MiB, each counted at its limit until it is parsed: 8 MiB for a version, 64 MiB for a version list | 429 `npm-busy` |

A package is refused with 413 before download when the registry's `dist.unpackedSize` or `dist.fileCount` says it is too large.
A tarball is read by `@preventive/archive`, which refuses with 422 `bad-tarball`:

- a malformed one;
- one with a path or a symlink that would leave it;
- one naming a path twice as different entries.

Directories and links are not extracted.
A repository directory's load larger than a package counts as more of the four loads (Repository code viewer, above).
A version's loads (its tarball, its files and its response) take one place between them, as they read its tarball and unpack it once.
Readers asking for the same version at once share one tarball read, one unpacking, and its encoded response.
A load holds its place until its response is encoded and every response holding it is written or abandoned; a response left unread for a minute is dropped.
A public version's unpacked files are then kept in memory for a minute, at most 128 MiB between them, the least lately read going first, so Compare's and the Code tab's requests that follow unpack none again.
A private version's files are never kept.
A download is the tarball as the registry has it, not unpacked.
Public workspace links cannot reach these endpoints.

# Report access and blocked accounts

Report lists, previews, downloads and triage reads use the same access scope:

- Admins can read all reports.
- Managers can read their own uploads, or reports within their teams' repository paths.
- Other readers need a published report inside a team path.

For the view, triage and `none` roles, being the uploader grants no access.
Changing a report's repository, publishing it or deleting it also requires access to its current repository path.
New links require access to the destination path.

The `none` (No access) role is denied at the managed data API boundary, even when the account owns uploads or belongs to teams.
This covers:

- team names and avatars;
- report and triage data;
- bundle caches;
- GitHub pull-request lookups;
- upload parts;
- every management endpoint.

Unauthenticated requests receive 401.
Unapproved accounts receive 403 before request bodies or resources are read.
Public bootstrap, the user's own session status and sign-out remain available.
When the role changes, the client shows a no-access page and clears previously loaded data.

## Creating GitHub issues

In managed mode, a finding's **Issue** action opens an editable title and description.
The issue is created as the signed-in GitHub user once they select **Create issue**.
The confirmation shows the fetched title, description, author, status, number and labels.
Creation uses the user's server-held user access token, never an installation token.
When reauthorization is needed, it must return the same GitHub account, and it keeps the existing DeepView session.

Use one GitHub App for sign-in and repository access:

| Variables | What they are |
| --- | --- |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | The app's user-authorization credentials |
| `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_SLUG` | The app's installation credentials |

Keep **Account permissions** unset or minimal, so login requests no elevated account access.
Repository permissions are approved when connecting repositories, not added as login OAuth scopes:

- **Contents: read**, **Issues: read and write** and **Pull requests: read**.
- **Checks: read** and **Commit statuses: read**, so the Pull requests tab can show a pull request's checks.
- **Dependabot alerts: read**, so a repository risk scan can blend a repository's alerts into npm's advisories, for an admin whom GitHub lets see them.

The owner of an existing installation must approve each permission update; the issue dialog offers the installation flow when approval is missing.
GitHub App permissions are configured on the app, not requested as incremental OAuth scopes.
See [GitHub's permission model](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app).

API creation is limited to a visible finding in the current team and a repository assigned to that team where the app is installed.
The target must match the finding's declared repository, or the report's managed assignment when the finding has no repository.
A different repository in the same team is rejected.
Other repositories, public workspace views, and E2E/local mode use GitHub's prefilled issue form.
The dialog offers that form only when the server selects the repository fallback.
No issue is posted by signing in, checking authorization, or connecting a repository.

Both the form and API creation request the label `deepview`, plus `security` for `isSecurity` findings, then the comma-separated labels in `GITHUB_NEW_ISSUE_LABELS` (optional).
Labels are trimmed and deduplicated.
The API checks every requested label with the acting user's token and silently leaves out names the repository lacks.
It never creates labels as a side effect.
On the API path, security labels come from the server's team-wide classification, including hidden siblings and links.

`GET /api/teams/:id/issues?reportId=...&findingId=...&repository=owner/repo` checks availability.
`POST` to the same path takes these fields plus `title` and `body`, requires the session's CSRF token, and rechecks current workspace access before creating.
A lost GitHub response is not retried automatically, since the issue may already exist.
Explicit preflight failures (for example, a failed label lookup) stay retryable by the user.
Unknown server failures and lost or malformed responses stay uncertain.

The `managed_finding_issue.issue_url` field stores one permanent reference per finding ID, shared across reports and teams.
No triage, import or management write can replace or clear it.
Findings with a saved issue show its link and GitHub status instead of the creation action.
Reading the reference still requires finding visibility and access to its repository through the current team.
A matching finding ID alone does not reveal another team's repository or issue URL.

Issue details, manual Fix metadata and linked PR states are read in a single GraphQL batch with the viewer's GitHub token.
Further batches handle pagination or more than 200 distinct links.
The newest linked PR by creation time, leaving out PRs closed without merging, is saved separately in `managed_finding_issue.auto_fix_url`.
Every successful complete refresh replaces or clears this derived value; failed or incomplete reads keep it.
Linked PRs outside the current team's repository grants are neither exposed nor saved.
Public shares do not expose saved issue records.

Manual `fix` stays a user override only.
Findings show both Fix links when they differ, and small Kanban cards prefer the manual Fix whatever the PR status.
Either link satisfies **Has fix**.
Derived updates do not create triage history.

An atomic database reservation stops simultaneous requests, including those on different servers, from creating duplicate issues.
A definite GitHub rejection releases the reservation.
Ambiguous failures keep it for operator reconciliation instead of automatically creating another issue.
The reference is saved before details are fetched, so a failed detail request still returns creation success with the saved URL and the submitted content.
If the final workspace access check fails, the response confirms creation without exposing the issue URL or details, and the dialog offers a status check instead of another creation.
Pending responses link to the repository's issue list, never its new-issue form.

### Dependency reviews

A package's **Review** tab opens `/npm/<package>@<version>/review`.
With no base, all package files are reviewed as additions.
Append `/<basePackage>@<baseVersion>` to review an update; a bare base version is accepted as a shortcut for the same package.
The tab shows to those who review dependencies in some visible team that reviews them (the session's `dependencyReview`):

- a member of that team who triages with its **Dependencies** permission;
- a member of it who manages;
- an admin, for any such team.

Tags resolve to exact versions.
Review uses the Compare header and stats.
Clicking **Review** reopens the author's latest review for that exact package version and integrity, including its original base.
Explicit review links keep their base.
Changed files totaling less than 50,000 lines and 2 MiB across both versions use the whole diff; larger reviews use the per-file Code view.
Both views support file reviews and whole-diff notes (a null file path).

Those reviewers can save private review sets with notes and optional verdicts: **Accept**, **Accept with nits (non-blocking)**, **Request changes**, or **Reject**.
In Manage teams, the **Enable dependency review** switch follows the npm scopes count.
Only enabled, visible teams the author reviews in (any team, for an admin) are offered for publication.
A sole eligible team is selected at first; with several, none is preselected.
**Publish** requires at least one selected team.
The account menu and the review page link to **My reviews** (`/my/reviews`), a paginated list of the user's unpublished, published and revoked review sets.
Authors can discard an unpublished set from My reviews after an explicit confirmation.
`POST /api/npm/reviews/discard` requires its ID and current revision, and atomically deletes the set and its file rows.
Published and revoked sets cannot be discarded.
Discarding does not require fetching the package again.

Selecting a file verdict saves it immediately.
Review always wraps source lines.
Notes save when their field loses focus, and **Finalize review** also saves pending notes before opening its confirmation.
Each file has one verdict and one text note; later saves update that same row.
The note editor shows for Accept with nits, Request changes and Reject.
At least one changed file must have a saved verdict before publishing.

**Finalize review** opens a separate confirmation step with a required final verdict and an optional final comment.
The final verdict cannot be more favorable than the least favorable file verdict.
A final verdict does not check any remaining files.
Every published set is classified **Full** or **Partial** by the exact changed paths from the same diff engine as the UI, including added, removed, renamed and binary files.
Notes alone do not check a file, and checking three of four files gives a partial review.
The changed paths are frozen on first publication, along with the final verdict and comment.

One's own published, unrevoked review offers **Copy dependency review** where the host formats it (`formatDependencyReviews`, above), with the text as the host answers it.
Another author's review never offers it.

Publication freezes the entire set.
Its author can publish that same snapshot to more eligible teams, or **Revoke** it.
Revocation is permanent, and the set's file reviews and team links stay visible, labeled revoked.
**Continue in a new review** copies the set into new private review and file-review rows; it never edits the published original.
Only one unpublished set per author and comparison is active.

`GET /api/npm/reviews` takes `ecosystem=npm`, `package`, exact `version`, `integrity`, and optional `basePackage`, `baseVersion` and `baseIntegrity`.
It returns the author's own sets, the published sets shared with the visible teams they review in, and the eligible publication teams.
Private npm access is checked for both sides.
`POST` takes that context plus an `action`:

| `action` | Fields |
| --- | --- |
| `start` | None; it starts an empty private set |
| `save` | `file`, `comment`, optional `status`, optional `reviewId`/`revision`/`entryId` |
| `publish` | `reviewId`, `revision`, `teamIds`, and on first publication a required `finalStatus` and optional `finalComment` |
| `revoke` | `reviewId`, `revision` |
| `continue` | `reviewId`, `revision` |

Every mutation requires a session, a CSRF token and the triage role.
All but `publish`, which is held to its teams, and `revoke` also require reviewing in some team (`403 review-access-required`).
`GET /api/npm/reviews/mine` lists only the current user's sets, in pages of 50, with an optional `beforeTime`/`beforeId` cursor.
`GET /api/npm/reviews/team?teamId=` lists, with the same cursor and page size, the sets published to a team, the latest publication first, for one who reads reviews there.
Access is asked again once npm is read, as it may be taken away meanwhile (`404 no-team`).
Either list checks each version a page names once, eight at a time, as npm's reads hold no more than thirty-two version documents at once.
Revision conflicts return 409.
Version and integrity mismatches also return 409.
Unknown file paths are refused, including paths not present on either side.
Notes are limited to 20,000 characters.

Storage uses three tables:

| Table | Holds |
| --- | --- |
| `managed_dependency_review` | Author, comparison, changed paths, final verdict and comment, revision, and publication and revocation times |
| `managed_dependency_file_review` | File paths, comments, verdicts and times |
| `managed_dependency_review_team` | Publication links |

There is no draft flag.
`managed_team.dependency_review` controls publication eligibility and defaults to off.
Both SQLite and Postgres migrate existing installations without altering their existing team membership.
