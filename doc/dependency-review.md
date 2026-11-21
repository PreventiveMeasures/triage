# Dependency review

Dependency review holds a repository's pull requests to reviews of the npm package versions their lockfiles add.
An admin turns it on per repository, members of teams that review dependencies review versions in the [npm viewer](./npm-viewer.md) and publish their reviews to those teams, and each open pull request shows which of its versions still want reviews.
A host can also pass versions from its own records, and count reviews made in pull request comments, through `registerReviewedDependencies`.

## What a pull request adds

A pull request adds the package versions its lockfiles lock at its head that none of them locked at its merge base, the commit **Files changed** compares from.
A version is either a package new to the lockfiles or an update of one they already locked, and both are reviewed alike.
Versions are matched by where each is installed from, so a lockfile replaced by another (Yarn's by pnpm's, say) is compared with the one it replaced.
A version that pnpm patches counts as new wherever its patch is new.

The lockfiles read are `package-lock.json` and `npm-shrinkwrap.json` with `lockfileVersion: 3`, `pnpm-lock.yaml` of pnpm 9 to 12, and Yarn 1's `yarn.lock`.
Bun's lockfiles (`bun.lock`, `bun.lockb`) are recognized but not read, and their directory says so.
Lockfiles under `node_modules` or in test fixtures are ignored, as no install uses them.

An open pull request's tile ([code-viewer.md](./code-viewer.md)) names its added versions, and the popup of any pull request lists them by directory under **New dependency versions**, marking the versions an update replaced, sources other than npm's registry, versions only devDependencies need, and [patched](#patched-versions) ones.
Each npm version opens in the npm viewer, an update compared with the highest version it replaced.
Where the host [names bases](#base), a version is reviewed against the one it names instead.

## When a pull request passes

Review is in effect for a repository once it is [turned on](#repository-settings) and a visible team that reviews dependencies has the repository.
Each version the pull request adds then needs the required number of counting reviews, of it whole, compared with a version it replaced, compared with the version the host names as its [base](#base), or compared with any version of another package.
Every other version its lockfiles lock needs them too, of it whole or compared with any version of its package or another, unless the [baseline commit](#repository-settings) or the [host](#host-reviewed-dependencies) passes it.
A version is reviewed as npm's registry has it, by name, version and integrity, so a version locked with several integrities needs reviews of each.
A patched version is reviewed as its patch changes it, by its patch too (see [Patched versions](#patched-versions)).

A review counts where it is:

- published to a visible team that reviews dependencies and has the repository;
- full, with every changed file checked (a partial review counts for nothing yet);
- accepting (**Accept** or **Accept with nits**);
- not revoked.

Each reviewer counts once, and their latest review of a version decides where they stand.
A reviewer whose latest review is **Reject** holds the version as rejected, however many others accept it, until they accept it again.

Where a host reads reviews from pull request comments ([`parseComments`](#parsecomments)), none of this applies: reviews published here count for nothing, and the comments and the host's `lookup` alone decide.

The tile shows whether every version passes, how many want reviews (`1 + 4 to review`), or that the review fails, and the popup shows what fails it and each version's state (`2/2`, **reviewed** by the host, **rejected**, **baseline** or **can't review**).
For a reader who publishes to a counting team, each version links to its review page, an update's compared with the version it replaced.

## What can't be reviewed

A version can be reviewed only where it is locked from npm's registry, by name or by the exact link to its tarball (with only a hash after it, as Yarn 1 writes its sha1), and with an integrity.
These versions fail the pull request's review even where its lockfiles locked them before: one from git, a tarball another host serves (a mirror's too) or a tarball link with a query, and one locked with no integrity, unless the [host's `lookup`](#lookup) passes it.
The review also fails for a changed lockfile that couldn't be read, a Bun lockfile, lockfiles left unread because the pull request changes too many files or directories, or a directory that locks more versions than are checked (see [Limits](#limits)).
A file of the project's own is not reviewed.
Neither is a package installed from a directory (a `file:` dependency, which pnpm and yarn copy into `node_modules`): it is the repository's own code, wherever the directory is, not any registry's package of its name.
Stasis tags one `npm:directory` (an ecosystem's `:directory`), naming the directory it was copied from and no integrity, as no archive was installed; triage reviews none, asks the [host](#host-reviewed-dependencies) of none, and audits none for advisories.
A record so tagged with an integrity, or naming no directory, fails its [Stasis build](#stasis-entries) and its [bundle's review](#a-bundles-dependencies), and its bundle's advisories list it as not audited.
A Stasis from before that tag records one as npm's, with no integrity, by the version its `package.json` names, which pnpm's lockfile doesn't: it is held to the lockfile that installs it, a pnpm or Yarn 1 one locking a package of its name from a directory (none locking that version) installing it from there, so it needs no review either.

## Patched versions

A version pnpm patches as it installs it (pnpm's `patchedDependencies`) is reviewed as patched: its files as its patch changes them, whole or compared with a version it replaced.
Where its lockfiles locked the version it patches before, unpatched or patched otherwise, a review compared with that version is of the patch alone.
Its reviews are held to its patch's hash, as its lockfile names it, so they are apart from those of the version unpatched or patched otherwise, and a version patched alike in several pull requests is reviewed once.
Locked the same way at the baseline commit, patch included, it needs none.

Its review page reads the patch of the repository at the commit the pull request's lockfiles were read at, from its file.
A lockfile of pnpm 10 names that file. pnpm 11 and later name a patch by its hash alone, so its file is found as its version is listed, where the repository's review is in effect: the one the `pnpm-workspace.yaml` beside the lockfile names for the package under `patchedDependencies`, held to the lockfile's hash.
A version whose patch isn't found, or that pnpm 9 patches, by an md5, has no review page here: it passes by the host's `lookup`, by reviews of its patch in the open pull request's comments through `parseComments`, or by the baseline commit.

A patch read is kept by its repository and its hash, for good, never removed: what a sha256 names never changes, so it is found once, and read of GitHub no more, whatever commit and path a later request names.
A team's **Dependencies** tab keeps every patch its repositories' default branches lock, those whose files their lockfiles name too, so that each can be found by its hash alone later.
The patch is read only where:

- the reader may read all of that repository, with their own GitHub access, which is checked again after GitHub answers;
- the file hashes to the lockfile's hash of it, as pnpm hashes it: a sha256 in hex of its text with its CRLFs read as LFs, any other CR kept;
- it is as git writes a diff, of no file's bytes (a binary patch) and of no file outside the package.

It is applied as pnpm applies it (the patch-package code pnpm 10 and 11 bundle): each file it deletes, creates, renames or changes, each hunk found in the file as it was, where its header says, else as many as 20 lines either side, its lines matched but for the whitespace they end in, the lines it keeps left as the file has them, and the lines it adds as the patch has them, CRs and all. The review page says why where it doesn't apply.
What it changes of a file's mode isn't shown.

The Dependencies tab and a pull request's popup link a patched version to its review where its patch's file is known, against the version it patches where that was one, and mark it **patched**; its line count is of its files as the patch changes them, the patch read as its review page reads it, so a version patched against itself counts the patch's lines alone.
A review keeps where its patch was read, so one listed under **My reviews** or a team's **Reviews** opens as patched for a reader who may still read that repository.

A review's base can be a version as a patch changes it too, named by the patch's hash alone (`basePatch`, below): only a patch kept here, of a repository its reader may read all of, is read so.
Where none is, the review page says so in place of the comparison, under its selectors, which still pick another base or version.
Its reviews are apart from those against the base unpatched, and count for no pull request, as what a pull request replaced isn't told by its patch.

## Repository settings

An admin turns on a connected repository's review in its page under Repositories, with the switch in its **Dependency review** section.

| Setting | Values |
| --- | --- |
| Required reviews | How many counting reviews each version needs, one to ten |
| Since commit | Optional: the full id of the baseline commit (below) |
| Lockfiles | Every lockfile (the default), every lockfile but those named, or only those named, a `stasis.config.json` among them (see [Stasis entries](#stasis-entries)) |

The page warns where no team that would count the reviews has the repository.

With a baseline commit, only what is new since then needs reviews; without one, every version needs them.
The versions locked at that commit need no reviews, show as **baseline**, and are never stored as reviews.
They are the reviewable versions of every npm lockfile at that commit, up to a hundred lockfiles.
A lockfile there that can't be read, a Bun lockfile, or one past the hundred is reported as unread, and the versions it locked need reviews.
Where GitHub can't read the commit, or lacks a lockfile it lists there, every version needs reviews and the popup says why.

Up to a hundred lockfiles can be named, each by its path in the repository, or by a directory ending in `/` for every lockfile under it.
While only some lockfiles are held to:

- a pull request's directory with none of them is left out for every reader: not listed, not asked of the host, and not failing the review where it can't be read, so a pull request that changes only such lockfiles shows no dependencies;
- a directory with any held lockfile is reviewed whole;
- a pull request with too many changed directories fails only where a held lockfile is among those left unread;
- the default branch reads only the held lockfiles, and the baseline commit passes what any of its lockfiles locked but reports as unread only held ones.

### Stasis entries

Under **Only those selected**, the settings also list the `stasis.config.json` files of the default branch (none under `node_modules`), and take another by its path.
A selected one holds the review to the npm versions its entries reach: what ships, without the devDependencies and unused packages a lockfile also locks.
It can't be named under **All but those selected** (`400`).

What it reaches is what Stasis builds in its directory, as `stasis github-bundle --lockfile-only` does; nothing of the repository runs, and only the versions are kept, each with the integrity it was installed by and the hash of the patch pnpm applied to it, but [one installed from a directory](#what-cant-be-reviewed), the repository's own.
Each version is then reviewed as the lockfiles in that directory or above it lock it at the commit, the nearest that locks it as it was installed first, so a [patched version](#patched-versions) is reviewed as patched.
A version none of them locks can't be reviewed (**can't review**).

It shows as a directory of its own, named by its path: on the default branch, what its entries reach at the head; in a pull request, what they reach at its head that they didn't at its merge base.
A pull request is read where it changes a lockfile or a `stasis.config.json`, as before.

A build can take minutes, so no answer waits for one:

- it is asked for the first time an answer finds it missing at a commit, once that answer's review is known, and built behind it; the answer says Stasis is still building (**Stasis building…**) and fails nothing yet; the page asks again every 30 seconds; the Dependencies tab shows Stasis's mark, a bar and how many of the builds its answers read are made (`3/7`), each once, one already kept made at once;
- builds are made one at a time, in the worker bundle creation uses, and give way to a bundle being created;
- the next build is the one of highest priority waiting: one of a `stasis.config.json` whose directory has a selected lockfile, by how many versions that lockfile adds in the pull request that want reviews, so the pull requests where Stasis can spare the most reviews come first; the rest, and the default branch's, after, the one asked for last first;
- a build that ends within a minute of the first of a run is followed at once by the next; after a longer one, or one that found the worker busy, the next starts when the page asks again (every 30 seconds while it shows one); one not asked for in 2 minutes is dropped;
- what a build downloads from npm (tarballs and version documents) is kept on disk for the builds after it: in the server's cache directory, or, where there is none, as on Vercel, in the instance's temporary directory for as long as that instance lives, shared with bundle creation, up to 512 MiB, emptied when found past that or when its disk is nearly full (Vercel's holds 500 MB);
- what is built is kept in the database for a month by the repository, the commit and the file's path, so each commit is built once;
- a pull request's builds tell Stasis the branch each commit is of (its `branch` option), its base branch for the merge base and its head branch where that is the repository's own, so it needn't list tags and branches to hold the commit to the repository's history.

A build that fails fails the review, and its directory names the failure's code. It is tried again when asked for an hour later, or a minute later where GitHub failed it.
An open pull request whose head is a fork's is told `commit-not-own` at once, and nothing is built for it: Stasis builds only commits of the repository's own branches and tags. A merge base that can't be built, or has no such file, reaches nothing, so every version at the head is new.

Where a `stasis.config.json` and a lockfile in its directory are both selected, the lockfile is reviewed whole as before and its versions are listed at once.
Once Stasis has built the file, a team's [Dependencies tab](#a-teams-dependencies-tab) marks (**!**) each version the lockfile locks that none of its entries reaches: one only the package manager asks a review of.
Every other row is regular: one Stasis reaches, alone or with the lockfile, one a lockfile with no such file beside it locks, and any row while Stasis is still building or couldn't build.

## Who reviews and publishes

A team reviews dependencies once an admin turns on its **Enable dependency review** switch in **Manage → Teams**; it is off by default.
A user reviews dependencies in such a team, where it is visible to them, if they are a member who triages with its **Dependencies** permission, a member who manages, or an admin (for any such team).
Only they see a package's **Review** tab.
They publish only to enabled, visible teams they review in (any such team, for an admin).

## Reviewing a version

A package version's **Review** tab opens `/npm/<package>@<version>/review`, and with no base every file is reviewed as an addition.
Append `/<basePackage>@<baseVersion>` to review an update, or a bare version for the same package; tags resolve to exact versions.
The base can be a version of another package, as for a fork or a renamed package (`/npm/@fork/lib@2.0.0/review/lib@1.0.0`): its picker doesn't offer one, but a link names it.
Such a review counts for the version reviewed wherever it is locked, whatever a pull request replaced, but where the host reads reviews from comments ([`parseComments`](#parsecomments)), as no published review does.
A [patched version](#patched-versions)'s names its patch after them, by its hash and where it is read: `?patch=<hash>&repo=<repository>&commit=<commit>&path=<path>`.
`repo` is a connected repository's id, as the links here write it, or its name (`owner/name`), which is matched only against the connected repositories its reader reads.
`path` can be left out where the repository's dependency review is on: the patch is then looked for at that commit, among the `.patch` files of each `patches/` directory beside a pnpm lockfile or a `stasis.config.json`, which are each kept by their hash, so the commit is looked in once.
`?patch=<hash>` alone names a patch kept here, of a repository its reader may read all of.
`&basePatch=<hash>` names the base as a patch, kept, changes it; the base selector then lists the base twice, as patched and as npm has it.
Picking another version to review leaves the patch out.

Changed files under 50,000 lines and 2 MiB across both versions show as one diff, and larger reviews use the per-file Code view.
Both take one verdict and one note per file, and notes on the whole diff.
The verdicts are **Accept**, **Accept with nits (non-blocking)**, **Request changes** and **Reject**.

A review is private until published, and **Finalize review** asks for a final verdict, which can't be more favorable than the least favorable file verdict, and an optional final comment.
Publishing needs at least one changed file with a verdict, and at least one team selected (a sole eligible team is selected at first).
A published review is **Full** where every changed path, added, removed, renamed and binary files included, has a verdict (notes and the final verdict check no file), else **Partial**.

A review is of the tarballs npm's registry serves for both versions: each change to it but a revocation loads their files again, from tarballs held to their integrity and to their shasum (the hex sha1 npm lists) where npm lists one, and is refused (`502 upstream-invalid`) where either doesn't match.
The review keeps both versions' shasums as checked, and a review written before they were kept has none.

Publication freezes the review, its changed paths, final verdict and comment included, and the shasums it was published with.
Its author can publish it to more eligible teams, or **Revoke** it for good, and a revoked review stays visible, labeled revoked.
**Continue in a new review** copies it into a new private review, and never edits the original.
Each author has one unpublished review per comparison.
**My reviews** (`/my/reviews`) lists one's unpublished, published and revoked reviews, and discards an unpublished one after a confirmation.

## A team's Dependencies tab

A team that reviews dependencies shows a **Dependencies** tab (`/team/<slug>/dependencies`) to those who review in it.
It reads the open pull requests of each team repository whose review is in effect for the reader, up to the 1,000 updated latest per repository, and says where there are more.
Where a repository has a `dependencies` label, as Dependabot's pull requests carry, it reads only the open pull requests carrying that label.
An open pull request without the label is then not listed there, whatever it adds; its tile and its popup still tell its versions' reviews.
Its sub-tabs are:

- **Pull requests**: those whose versions want reviews or whose review fails, each a card that opens its popup.
  One into a branch other than the default that adds no version to review is left out, unless its comments review its dependencies.
  A selector orders them newest first (the default), most recently updated first, or fewest versions to review first.
  Pull requests into a branch other than their repository's default are hidden, and their dependencies aren't read, until **All branches** is switched on; each is then read on its own, and its card names the branch it targets.
  Drafts are hidden alike until **Drafts** is switched on, and their cards are labelled **Draft**.
  Pull requests that add only versions listed under others come after the rest, one line each, and can be hidden; one whose base branch holds versions that want reviews says how many on its line (`141 on the base branch`).
- **Versions**: every added version that wants reviews, once, with the pull requests that add it; those lacking a review made in another are red.
  Where the host reads reviews of comments, a version its pull request's comments pass but `lookup` doesn't yet stays listed, green (`2/2`), on both sub-tabs.
- **Default branch**, where anything there wants reviews: what each repository's default branch locks that wants reviews or fails them, and its lockfiles left unread.
- **Reviews**: the reviews published to the team, revoked ones too, latest first, one line each: the version, the verdict, how much was checked (`Partial · 22/24`), the author, any other teams it is published to, and when.
  Clicking how much was checked opens the review's notes and file verdicts under its line.
  Each author shows with their avatar and their name in the app, with their GitHub login in its tooltip.

Where several pull requests add a version, its reviews in each are compared: who passes it and who rejects it there, by login.
A version's tooltip names its reviewers with their avatars and names in the app.

- Reviewed alike, one pull request lists it, the one with the fewest reviews left to make, and the others show it dimmed, naming that one.
- A pull request that holds some reviews of it but lacks one made in another's comments shows it red, and its tooltip names whose review and where.
  Where each lacks a review of the other's, both are red; where one holds every such review, it lists the version as usual.
  Only reviews made in comments are compared this way, as they count where they were posted and can be posted again.
  A review published to a team is never "lacked": it counts wherever the rules above let it (a version a pull request adds needs it whole, compared with a version it replaced, or compared with another package's, one it only locks takes it compared with any), so without `parseComments` it may count in a pull request stacked on another and not in the one it stacks on.
- A pull request with no reviews of it is never red: it is simply unreviewed, and shows it dimmed under a pull request that has reviews of it and still wants it.
  Where none of those wanting it has any, one of them lists it and the rest show it dimmed.

A patched version stands by its patch, as each patch of it is reviewed apart.
A version you reviewed yourself, published to a team counting for the repository, ends its row with your latest verdict's icon (a green check for **Accept**), and its tooltip names it, partial ones too, whether or not your review counts there: it marks what you reviewed that still waits on others' reviews or on the host.
A version with a review of those it needs shows how many (`1/2`), and its tooltip names the reviewers; one with none shows no count.
Each list shows the versions with a review already (`1/2`, or rejected) first, and those marked **!** (see [Stasis entries](#stasis-entries)) last; on a card, the dimmed ones stay below both.
Where some of a card's versions to review are marked **!**, its count says how many Stasis reaches, by Stasis's mark: `3 deps (2 ◆)`, or `1 dep (0 ◆)` for a lone one, which otherwise shows no count; where its pull request adds more than are listed, of those listed, at least that many (`205 deps (150+ ◆)`).

The tab reads all its repositories in one request, and shows each one as soon as the server has read it.
A repository whose review is off, or that the reader may read only part of, is answered at once, without asking GitHub.
What the tab read is kept for two minutes; drawn after that, it is shown while it is read again.
It reads a repository's open pull requests in pages of its own, 50 at a time, asking GitHub only for what its cards show and for the files and commits that tell what each one's lockfiles add.
A page GitHub fails to answer in time is asked for again with 20, then 5, and the pages after it ask for no more than that.
Where a page fails all the same, the tab shows the pull requests read till then, says the rest weren't read, and asks again once drawn 30 seconds or more later, reading on from the pages already kept.
Each pull request's dependencies are found by the base and head commits that the page of open pull requests names, so the tab doesn't ask GitHub for those commits.
The list of lockfiles at the default branch's head and at the baseline commit, and each lockfile's versions by its contents, are kept in the database for a month.
Another server instance then reads none of them from GitHub again, and after a push that changes no lockfile only the list is read again.
A pull request's popup, and its repository's tiles, reuse what the tab read.
The line counts on its rows come with the tab's answer, and with a pull request's own read, where they are already counted; public versions' are kept by their names and versions for a month. The rest are asked for 50 at a time.

## A bundle's dependencies

A Stasis bundle attached to a repository whose review is in effect for the reader shows a **Dependency review** line among its Overview's facts.
It checks the npm package versions the bundle holds, those it has code of as `stasis audit` counts them, as they are locked at the commit its stamp names; not [one installed from a directory](#what-cant-be-reviewed), the repository's own.
They are read from the lockfiles in the bundle's directory and the directories above it, as an install there reads a workspace's root lockfile; a sibling directory's are not.
Each version is checked as the nearest of those directories that locks it locks it, every integrity and patch it locks it with.

They are held to the rules a pull request's other versions are: each needs the required number of counting reviews, of it whole or compared with any version of its package or another, unless the [baseline commit](#repository-settings) or the [host](#host-reviewed-dependencies) passes it.
The review fails for a version that [can't be reviewed](#what-cant-be-reviewed), for one none of those lockfiles locks (`not locked at its commit`), as nothing holds its reviews to an integrity, and for one of those lockfiles that can't be read.

The line says **Passes**, how many versions want reviews (`3 to review`, of the versions the bundle holds), or **Fails** and why.
**Details** tells the review's terms and the lockfiles read, and lists the versions failing the review, then those wanting reviews, each opening its review page for one who publishes to a counting team.
While only some lockfiles are held to, only those are read, and a bundle none of whose lockfiles are held to shows no line, as a pull request's directory with none of them shows nothing.

No line shows for a bundle of no repository, no commit or no npm versions, nor for a reader who may read only part of its repository; nor is GitHub asked then, or where its repository reviews no dependencies.
What the line reads is kept for two minutes, or till the bundle moves to another repository or directory, and its lockfiles as the Dependencies tab keeps them.
It is read with the reader's own GitHub access as a default branch's dependencies are (`GET /api/bundles/:id/dependency-review`), and the bundle's access and location are checked again before it is shown.

## Host reviewed dependencies

A host that keeps reviewed dependencies of its own registers them once, before `init()`.
Registering after `init()`, or a second time, throws.

```js
import { init, registerReviewedDependencies } from '@preventive/triage/server'
registerReviewedDependencies({
  async lookup({ ecosystem, lockfile, name, version, integrity, shasum, patchHash }) { return isReviewed(...) },
  // Optional: the reviewed version to review a pull request's version against, of its package or another.
  async base({ ecosystem, lockfile, name, version, integrity, shasum, patchHash }) { return reviewedBaseOf(...) ?? null },
  // Optional: the reviews an open pull request's comments make.
  async parseComments({ repository, number, comments, dependencies }) { return reviewsIn(comments) },
  // Optional: one's own dependency reviews as a comment, to copy.
  async formatDependencyReviews({ reviews, pullRequest }) { return commentOf(reviews) },
})
const server = await init('managed')
```

Once registered, `lookup` replaces the baseline commit: the repository page shows none and the server refuses one.
A commit stored before is kept unused, for a server that later registers no hook.

### `lookup`

`lookup` is asked about each version an open pull request's lockfiles lock that its teams' reviews don't pass.
Where the host has `parseComments`, it is also asked about each added version the teams' reviews do pass, before comments are read for it.
It receives the version as the lockfile locks it: `ecosystem` (`npm`), `lockfile` (`npm`, `pnpm` or `yarn1`), `name`, `version`, and `integrity` where the lockfile has one.
A version of npm's registry locked with no integrity, which reviews here can't hold, is asked about without it: it passes where `lookup` passes it, else it fails the review as it does with no host. Whether to pass a version by its name alone, or how to hold it to an integrity, is the host's to decide.
It also receives `shasum`, the hex sha1 Yarn 1 writes after a tarball's `#`, and `patchHash`, pnpm's patch hash, where the lockfile has them.
A version it answers `true` for passes, and shows as **reviewed**.
A version it fails to answer for wants its reviews and is counted as unasked in the popup, and the error is logged.
Each version is asked once per request, up to sixteen at once, and an answer may be reused for a minute.

### `base`

`base`, optional, names the reviewed version to review a pull request's version against, in place of the versions its lockfiles locked before.
It receives the version as `lookup` does, is asked about each one `lookup` doesn't pass, as `lookup` is, and returns `{ name, version }`, an exact version of its own package or another's (a fork's original, say), or null for none.
Once it is registered:

- each version's row links its review against the version named, whole where none is, and counts its lines against it, of its own package or another's, a patched one's as patched;
- a review against the version named counts, as one against a version it replaced does;
- a pull request into the default branch, where its review is on, is read without its merge base (no lockfile read there, no Stasis build), every unreviewed version its head locks its own, its review asked for or not (a closed one's popup then lists none); the branch's own state shows on the Dependencies tab's **Default branch**.

### `parseComments`

`parseComments`, optional, reads the reviews an open pull request's comments make, and is asked only about an open pull request whose held lockfiles change.

Once it is registered, reviews published in the app count for nothing in any repository's dependency review, whatever they were compared with:

- an open pull request's versions pass by the reviews its comments make, or by `lookup`;
- the default branch's and a bundle's versions pass by `lookup` alone;
- a version reads the same whether a pull request adds it or only locks it, so a pull request stacked on another tells it as that one does.

Published reviews still list under **Reviews** and **My reviews**, and are what `formatDependencyReviews` formats for their author to post as a comment.

It receives the pull request (`repository`, `number`), its comments (`comments`, up to a thousand), and the versions it may review (`dependencies`).
Each comment has `kind`, `id`, `author` (a GitHub login), `body`, `createdAt`, `editedAt` where edited, and `url`.
`kind` is `comment`, `review` (a review's own comment, with its `state`), or `review-comment` (on a line of the diff).
`dependencies` are:

- every reviewable version the held lockfiles add that `lookup` doesn't pass;
- the other versions its lockfiles lock that still want reviews.

A version that `lookup` passes is never given.
It returns the reviews the comments make, `[{ user, time?, dependencies: [{ name, version, integrity, patchHash?, status }] }]`.
`status` is `accept`, `accept-with-nits`, `request-changes` or `reject`, each review is taken as full, and a patched version's review is of it as its patch changes it, as one here is.

A returned review counts only where its `user` wrote one of the comments, and the app's user for that GitHub account (by id, else login, linked accounts included) publishes reviews to a team counting for the repository.
It counts as that user's review as of its `time`, else as of their latest comment as last written or edited, and their latest review decides where they stand.
These reviews count for that open pull request alone, and are never stored.
A closed pull request's comments are never read, so the host should merge a pull request reviewed this way only once those reviews reach what its `lookup` reads.
Where the comments can't be read, the popup says so and the error is logged.

### `formatDependencyReviews`

`formatDependencyReviews`, optional, formats the asker's dependency reviews as a comment, which **Copy dependency review** gives; without it, no review or pull request has that button.
It receives `reviews`, each entry with:

| Field | Value |
| --- | --- |
| `ecosystem` | `npm` |
| `new` | The version reviewed, `{ name, version, integrity, shasum?, patchHash? }`: the integrity and shasum the review keeps of the tarball it read (`shasum` where it keeps one), and `patchHash` where the review is of it [patched](#patched-versions) |
| `old` | The version it was compared with, `{ name, version, integrity, shasum? }` as the review keeps them, or null where the package was read whole |
| `status` | `accept`, `accept-with-nits`, `request-changes` or `reject` |
| `coverage` | `full` or `partial` |
| `comment` | The final comment |
| `files` | The `{ path, status, comment }` of each file checked or commented on |
| `reviewer`, `publishedAt` | The author's login and the publication time |

It is asked of each of the asker's reviews alone, wherever it is shown to its author.
For an open pull request, it is asked of all the asker's reviews published to a team counting for its repository of the versions it adds (matched by integrity and patch; where the host has no `parseComments`, only those whole, compared with a version they replaced, or compared with another package's), with `pullRequest` as `{ repository, number }`, for its popup and its card on a team's Dependencies tab to copy.
Reviews of versions `lookup` already passes are left out, as they want no review there, and so are those the asker's own comments on that pull request already make with the same verdict; where none is left, there is nothing to copy.
It returns the text to copy, and an empty, null or undefined answer, one over a million characters, or a failure (logged) gives nothing to copy.
It is given only the asker's own published, unrevoked reviews, however it is asked, so another author's review never offers the button.

## Limits

| Limit | Effect |
| --- | --- |
| A pull request changes over 3,000 files, or lockfiles in over 20 directories | It is cut, and its review fails |
| A directory locks over 20,000 versions | The review fails |
| Over 100 lockfiles at the baseline commit, or held on the default branch | The rest are unread: the baseline's need reviews, and the default branch's fail its review |
| A Stasis build of a `stasis.config.json` runs over 3 minutes, or past the worker's memory | It fails, and so does the review, for an hour (see [Stasis entries](#stasis-entries)) |
| Over 1,000 open pull requests in a repository | The Dependencies tab reads the 1,000 updated latest, and says so |
| The Dependencies tab's request runs over 4 minutes | The repositories left are read again, up to 3 times; any still left show as failed until the tab is drawn again 30 seconds or more later |
| A note over 20,000 characters | Refused |
| A patch over 8 MiB | It isn't read, and the version can't be reviewed as patched |
| Over 100 patches named by their hash alone not yet found | The rest are looked for as their versions are listed again |
| Over 100 patch files in the `patches/` directories of a commit a link names no path at | The rest aren't looked in |
| A review changed elsewhere meanwhile, or a version or integrity that no longer matches | `409`, and the change is not saved |
| GitHub refuses the repository's contents or the pull request | The popup says so (`502 github-status-403`) |

## Access and privacy

- Dependencies, of a pull request or the default branch, are read and checked as the pull request itself is (see [code-viewer.md](./code-viewer.md)), and access is checked again after GitHub answers, unless the whole answer came from kept data.
- A repository that reviews no dependencies answers so without asking GitHub, but only once the reader's access in the app is checked.
- The team Dependencies tab leaves out any repository the reader may read only part of.
- What a `stasis.config.json` reaches is built with the GitHub access of a reader who may read all of its repository, kept for every reader, and shown only once the asker's own access is checked, as kept lockfiles are.
  The build worker gets that GitHub credential and `NPM_TOKEN` alone, as a bundle's does.
- A bundle's **Dependency review** line needs read access to the bundle and to all of its repository, and the bundle's access is checked again before it is answered.
- While the tab's request runs, the reader's session is checked before each repository's answer.
- Before each answer showing a repository's dependencies, the request also checks that the team is still the reader's and still holds the repository, and that the reader may still read all of it; where not, the answer stops there.
- The review page and its list check private npm access for both versions of a comparison (see [npm-viewer.md](./npm-viewer.md) for who reads private packages).
- A patched version's files, its comparison, and each change to its review but a revocation read its patch, which only a reader who may read all of its repository is given (`404 no-repository` or `no-directory`); its reviews are listed whoever reads its version.
- A team's published reviews list only for one who reads reviews in that team, access is asked again once npm is read (`404 no-team`), and each review is held to the reader's npm access.
- Every change to a review needs a session, a CSRF token and the triage role, and all but publishing (held to its teams) and revoking also need reviewing in some team (`403 review-access-required`).
