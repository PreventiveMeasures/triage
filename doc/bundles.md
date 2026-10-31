# Bundles

A bundle is a Stasis source bundle or a sourcemap that a team reviews in the bundle view.
Managers and admins upload bundles or build them on the server from a connected repository, and admins can scan every repository's lockfiles for risky npm packages.
This page covers who may see and change bundles, what a build and a scan read from GitHub and npm, the limits users can hit, and what never leaves the server.
Connected repositories open in the same view; see [code-viewer.md](./code-viewer.md).

## Access

- Admins read and manage every bundle.
- Managers read and manage the bundles they own or reach through their teams.
- View and triage users need a visible bundle in a location their team can access.
- The `none` role has no bundle access.
- Ownership survives attaching the bundle to a repository.
- Adding a repository location needs bundle management access and access to the destination repository and directory.
- Changing visibility, detaching or deleting a bundle needs access to its current location, even for its owner.
- A team granted `/` sees the visible bundles in that repository.
  A team granted `/foo` sees bundles at `/foo` and `/foo/*`, but not at the root or `/foobar`.
  This applies to team catalogs, public workspace links, direct reads, advisories and manager activity.
- Hiding a bundle (Manage → Bundles) removes it from view and triage catalogs, direct reads and downloads, advisories and [public workspace links](./navigation.md#public-workspace-links).
  Managers and admins keep their access, and linked reports keep their publication state.
  Bundles are visible by default.
- A public workspace link reads only its own bundles, including both sides of a comparison.
- The browser keeps bundle metadata and contents in memory only, never in OPFS, IndexedDB or localStorage.
  A session or role change clears them.

## Uploads and locations

Managers and admins upload bundles on Manage → Bundles, or with `POST /api/admin/bundles` (same-origin, CSRF token, manager or admin role).
The body is the raw file, named by `X-Bundle-Filename`.
`X-Repo-Id` and a URL-encoded `X-Repo-Directory` set its location, and the uploader needs access to that location.
Without them, a Stasis bundle is attached to the connected repository its stamp names (case-insensitive), at the stamp's directory, if that is within the uploader's grants.
Otherwise it stays unattached, and its manager can assign it later.
Identical bytes reuse the existing bundle and keep its stored location.

| Limit | Value | Error |
| --- | --- | --- |
| Upload size | 200 MiB by default; `MAX_BUNDLE_BYTES` sets it, up to 1 GiB | `413 too-large` |
| Decoded size | 512 MiB | metadata `422` |

A bundle that cannot be parsed, or decodes past the limit, can still be downloaded as uploaded.
For Vercel's request-size limits and chunked uploads, see [VERCEL.md](../server-managed/VERCEL.md).

## Creating a bundle from a repository

**Manage** → **Bundles** → **Create** builds a Stasis bundle on the server.
The user picks a connected repository, a branch, tag or commit, and entry-point files from any of its directories.
The revision list suggests up to 100 branches and tags, and accepts any other name typed in.

- Supported projects are JavaScript/TypeScript with a pnpm, Yarn 1 or npm lockfile, and Solidity with Soldeer.
- All entry points must be in one language, at most 100 of them.
- Node.js and Browser builds use the export conditions chosen.
  Metro builds for iOS and Android and requires the `react-native` condition.
- The build runs from the nearest directory, at or above the entry points' common parent, that holds a `package.json` (or `foundry.toml`, `soldeer.toml` or `soldeer.lock`).
- The build never runs repository code or install scripts.

### Entries in `stasis.config.json`

A directory whose `stasis.config.json` lists `entries` suggests those, and selects them by default, instead of the entry points its `package.json` or Solidity layout would suggest.
They are built as `stasis bundle` builds them:

- An entry point is listed when the nearest `stasis.config.json` at or above it that lists it in `entries` does.
- Listed entry points are built from that file's directory, where Stasis builds each with its options there (see Stasis's [github-bundle Entries](https://github.com/PreventiveMeasures/stasis/blob/main/doc/github-bundle.md#entries)).
  They take no conditions, so the conditions chooser is hidden while only they are selected (`422 config-conditions` if a request gives some).
- Listed entry points are never combined with others, or with another file's (`422 config-mixed`).
- An entry setting an option that runs a program (`babel`, `metro-resolver`, `cargo`, `cargo-target`) fails the build (`422 config-runs-code`).
  `stasis bundle` takes these only with the same flag given as consent; a server build has none to give.
- A `stasis.config.json` whose entries can't be read, or whose options Stasis refuses, fails the build (`422 config-invalid`).

Creating a bundle requires:

- the manager or admin role, a same-origin request and a valid CSRF token;
- live GitHub read access to the repository (see [Repository access](#repository-access));
- a team grant that covers the project root the build actually used, which can sit above the selected files when a workspace lockfile installs them (`403 build-scope`).

After the build, the server checks access and the repository's identity again (`409 repository-changed`), then stores the bundle.
If the bytes match an existing bundle, it reuses that one.

## What a build reads

- From GitHub: the repository tree and files at the selected commit, with the credential the access check chose: usually the user's own token for a public repository, and the repository App's installation token for a private one.
- From npm: the lockfile's packages, their version documents and tarballs.
- The build runs in a worker that receives no server credential except `NPM_TOKEN`, which npm needs for private scoped packages.
- Build logs (`managed-bundle-build:` records) never include credentials or upstream response bodies, and the API returns only an error code.
- Off Vercel, what builds and audits download is kept in upstream's disk cache, `$XDG_CACHE_HOME/PreventiveMeasures` (or `~/.cache/PreventiveMeasures`).
  On Vercel nothing is kept on disk.

## Build limits

| Limit | Value | Error |
| --- | --- | --- |
| Concurrent builds | 2 per deployment, across all instances that share the managed database; 1 per user | `429 build-busy` |
| Build time | 3 minutes, including the wait for a build slot | `504 build-timeout` |
| Worker memory | 512 MiB heap | `422 build-failed` |
| Output | 200 MiB before compression, and the upload size limit after it | `413 too-large` |

Other failures are `422 build-lockfile` (no lockfile, or more than one could install the project), `422 github-rate-limited` and `422 github-build-failed`.
Closing the page cancels the build.

## Repository access

The repository pickers (bundle creation and the code viewer) list the active repositories the caller's teams have a grant for, or all of them for an admin.
Every read of a repository must pass both gates, each time:

1. Managed access: the caller is an admin, or a team member (view role or above) whose team has a grant for the repository, and the read is within that grant's paths.
2. GitHub access: the caller has GitHub read permission on the repository, or GitHub currently reports it as public.

- Public visibility is confirmed with GitHub, never inferred from stored flags; internal repositories need the user's permission.
- Admin status does not bypass the GitHub gate.
- Private repositories are read with the repository App, but the App's installation access alone never grants a user anything.
- Non-admins see only their teams' granted directories and the parent directories needed to reach them.
- Both gates are checked again after the source is read.
- Upload and link pickers do not grant source browsing.
- When the App's installation access is stale, reads fall back to anonymous access only after GitHub confirms the repository is public.
- Roles, teams and grants are checked on every request.
  GitHub's answer that grants access is kept for 5 minutes per user token and repository; `MANAGED_REPOSITORY_ACCESS_CACHE_MS` sets this, up to an hour, and `0` asks GitHub every time.
  A refusal is never kept, and once GitHub rejects a token with `401`, nothing kept for it is used.
- GitHub lists at most 1,000 entries per directory, and the page says when a listing hits that limit.

## Repository risk scan

Admins open the scan from the **Risk** button on the Repositories page (`/manage/repositories/risk`).
It reads the npm, pnpm and Yarn 1 lockfiles of every active repository at its default branch's head, and can be limited to one team or one repository.
For a team, it reads only the lockfiles in the team's directories and the directories above them, since a workspace's root lockfile installs their packages too.
It reads with the admin's own GitHub access through the same gates as browsing, and checks them again before it shows each repository.
Closing the page, or leaving the response idle for 5 minutes, stops the scan.
On Vercel, a request stops after 270 seconds and the page continues it at once, for up to 100 parts.
npm's downloads API answers about 40 lookups a minute, so a large scan goes at npm's pace.

### What it reports

- Each package's risk score out of 100 and its findings, assessed as the [npm viewer](./npm-viewer.md) assesses a version.
- Malware: OSV's malicious-package records (`MAL-…`), GitHub's CWE-506, or an advisory whose title names malware.
  Malware is critical and shows in every view.
- A package npm took down, or a missing version that a malware advisory names, reported as malware.
  Any other missing version shows as not on npm.
- A mirror's copy whose integrity differs from npm's (`integrity-mismatch`), flagged critical.
- Packages that only devDependencies need, tagged `dev` and filterable, as npm and pnpm lockfiles say (Yarn 1 lockfiles do not).
- An **Advisories** tab with npm's registry advisories for each lockfile, as `npm audit` reports them, merged with the repository's Dependabot alerts.
- A lockfile that cannot be read (`lockfile-unreadable`), except test fixtures and examples, which are skipped silently.
- A repository GitHub could not be reached for (`github-unreachable`), with what failed but never GitHub's text.

Packages from git, files, or tarballs without an integrity are listed but not assessed.
A package from another host is assessed as npm's package only when its lockfile integrity is npm's.

### What it sends upstream

- npm's registry: each lockfile's npm and mirror packages in one advisories request, version documents, and the downloads API.
- OSV: public packages only.
  A scoped package counts as public only when npm answers for it anonymously.
- A private package's name is never sent to OSV or Socket.
- Download counts are kept only for packages the downloads API counts, so a private package's zero is never stored with public counts.
- GitHub: the repository, its lockfiles and its Dependabot alerts.

Lockfile listings and packages, private repositories' included, are kept in the database for a day and shown only after the reader's access is checked.
Package risk results are kept indefinitely; one older than an hour shows as stale until it is assessed again.
Dependabot alerts are never kept.

### Dependabot alerts

The scan reads each repository's npm Dependabot alerts, open or dismissed, up to 2,000 per repository; fixed alerts are skipped.

- Alerts are read with the App's installation token, never the admin's own token.
- The App needs **Dependabot alerts: read**.
- The scan uses the installation GitHub says covers the repository now, not the one stored.
- The admin's sign-in must be verified, and their permission on the repository must be admin or write (maintain counts as write).
  Custom roles and the security manager role are refused, though GitHub would allow them.
- That access is checked again, with a fresh GitHub request, just before the alerts are shown.

When alerts cannot be read, the scan goes on and says why:

| Code | Reason |
| --- | --- |
| `dependabot-not-installed` | The App is not installed on the repository. |
| `dependabot-unverified` | The admin's sign-in is not verified. |
| `dependabot-forbidden` | The admin's permission does not let them see the alerts. |
| `dependabot-app-permission` | The installation may not read the alerts. |
| `dependabot-disabled` | The repository has Dependabot alerts turned off. |

## Commit details and tags

Bundle catalogs show the commit a bundle was built from, with its subject, author, date and tags.
Only the commit message's first paragraph is sent to clients.
Catalog access to the bundle is the only gate.
Missing details are read after the catalog responds, with the viewer's own GitHub access, so a later catalog shows them.
Tags are those the bundle creation page and the code viewer last read.

## Reading a bundle

| Endpoint | Returns |
| --- | --- |
| `GET /api/bundles/:id/metadata` | File inventory, sizes and hashes, lines of code, packages, imports and entry points, without source bodies |
| `GET /api/bundles/:id/contents` | The sourcemap or Stasis JSON |
| `GET /api/bundles/:id/download` | The uploaded filename and bytes; Stasis bundles stay `.br` |

Metadata and contents are always `Content-Encoding: br`, with no negotiation, support HEAD, and send `Cache-Control: private, no-store`.

The Code and Compare tabs pretty-print JavaScript, TypeScript, JSX, CSS and JSON files of up to 4 MiB on the server.
The server checks that the output differs from the source only in layout.
When 16 files are already waiting, it answers `429 pretty-busy`.
Formatted copies are encrypted like the bundle where storage is encrypted (see [STORAGE-ENCRYPTION.md](../server-managed/STORAGE-ENCRYPTION.md)) and removed with it.
Compare's **Hide renamed names** and **Hide type-only changes** are worked out on the server; reviewed code is only parsed, never compiled or run.
These requests check access before they work and again before they answer.

## Dependency review

Where the repository a Stasis bundle is attached to reviews dependencies, its Overview shows a **Dependency review** line: whether the npm versions the bundle holds pass their reviews, as the lockfiles installing it lock them at the commit it was built from.
See [A bundle's dependencies](./dependency-review.md#a-bundles-dependencies).

## Validation

A Stasis bundle's Overview has a **Validation** line with a **Validate** button, which checks that the bundle holds what it says it does:

1. **Own code** (the files of modules naming no ecosystem: the project's own and its workspace's packages, and the root's and an `npm` one's outside `node_modules` whatever they record) must be on GitHub, byte for byte, at the commit the bundle's stamp names, under the directory it was built in (the stamp's, else the bundle's location).
   Each file is compared by git's blob id with GitHub's listing of the commit's tree, so no file is downloaded; the listing is read a directory at a time, into those holding the bundle's files alone, where GitHub cuts it short.
   A file whose only difference is a checkout's CRLF line endings passes, and is counted.
2. **Dependencies** are fetched with upstream (npm's registry, and crates.io for Cargo crates), which holds each tarball to the integrity its registry publishes for it (not the lockfile's), and each file the bundle holds of a package must match the file at its path there.
   Files of a package the bundle leaves out are expected.
   A vendored crate's `.cargo-checksum.json`, which `cargo vendor` writes and no crate holds, is held to the crate instead: its package checksum, and the sha256 of each file it lists.
   An npm version the lockfiles installing the bundle lock from git alone (a git repository, or a git host's tarball) is left unverified: npm may build one as it installs it, and the registry's release of its name and version is another package.
   A module's recorded commit is no sign of one, as a registry package's `gitHead` is recorded too; without those lockfiles, such a version is held to the registry's.
   A version pnpm patches is held to its files patched, as pnpm applies the patch: the patch the lockfiles installing the bundle at its commit lock it with, read of the bundle where it holds a file of that hash, else of the repository; without those lockfiles, the patch the bundle holds named for the version, pnpm's way (`patches/name@version.patch`).
   Each installed copy of a version is held to its files patched or as published apart, as a nested copy may be unpatched, and the version is fetched once.
   Each patched version is listed with its patch, where it was read, and, valid, whether a copy of it holds its files as patched.
3. **Coverage**: every file the bundle holds must be one or the other. Stasis's empty placeholder (`.stasis/empty-module.js`, for an import a package disables) is allowed.

The line says **Valid** where every file was checked and matches, **Invalid** where any file differs (`differs`) or is neither on GitHub nor in its package (`unexpected`), and **Incomplete** where nothing failed but some files weren't checked: those of ecosystems upstream fetches no package of by name and version (Composer, Soldeer, crates from git), of versions it couldn't fetch, or not reached within 4 minutes.
**Details** lists the files failing or left unverified, up to 500, and the packages failing, unverified or patched.

Own code is checked only for a reader who may read all of the bundle's repository, with their own GitHub access, which is checked again after it is read.
For a bundle of no repository or commit, or a reader of only part of its repository, the dependencies are still validated, without the lockfiles (so without their patches, and with no version told apart as from git), and the line warns that own code couldn't be verified, and why.

Validations are kept for a month, by the bundle, its location and whether own code was checked, and shown to the next reader of the Overview without fetching anything: a reader of all of the repository sees the one that checked own code (else the other), and any other reader only one that didn't.
**Validate again** replaces it.
A validation needs the CSRF token; two run at once per server instance (`429 validation-busy`), and requests for the same one meanwhile share it: for one checking own code, only the same reader's, as it reads the repository with their GitHub access and checks theirs again after.
Private scoped npm packages are fetched with the server's `NPM_TOKEN`, as builds fetch them.

## Bundle advisories

The bundle view's **Advisories** tab audits the bundle's dependencies:

| Ecosystem | Advisory source |
| --- | --- |
| npm | The registry, plus OSV for public packages |
| Cargo, Composer | OSV |
| Soldeer, GitHub | Published repository advisories |

- A dependency counts only when the bundle records an evidence file for it, as `stasis audit` does.
- Composer dev versions, git or unknown-source crates and unsupported ecosystems are listed as skipped and never sent upstream.
- **Recheck against repositories** also asks GitHub for maintainer-published advisories, as `stasis audit --repo-advisories` does.
- View and triage users need bundle access and the team's `security` permission; `dependencies` is not required.
  `?team=<id>` limits the grant to one team.
- Credentials go only to GitHub, never to npm, OSV or other registries.
  GitHub requests use the viewer's stored token; public links and viewers without a usable token, or whose token gets a `401`, read anonymously.
- An npm-only audit contacts only npm and OSV.
- Repository advisory listings are cached for 90 minutes and shared across viewers, since only public repositories publish them.
- Failures return `502 upstream-unavailable`, without source contents or findings; an oversized package inventory returns `413` before upstream is contacted.

Report-scoped sources (`/api/reports/:id/sources`) include only the source paths cited by findings the team can see, and access is checked again before they are streamed.
