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

An open pull request's tile ([code-viewer.md](./code-viewer.md)) names its added versions, and the popup of any pull request lists them by directory under **New dependency versions**, marking new packages, the versions an update replaced, sources other than npm's registry, and versions only devDependencies need.
Each npm version opens in the npm viewer, an update compared with the highest version it replaced.

## When a pull request passes

Review is in effect for a repository once it is [turned on](#repository-settings) and a visible team that reviews dependencies has the repository.
Each version the pull request adds then needs the required number of counting reviews, of it whole or compared with a version it replaced.
Every other version its lockfiles lock needs them too, of it whole or compared with any version of its package, unless the [baseline commit](#repository-settings) or the [host](#host-reviewed-dependencies) passes it.
A version is reviewed as npm's registry has it, by name, version and integrity, so a version locked with several integrities needs reviews of each.

A review counts where it is:

- published to a visible team that reviews dependencies and has the repository;
- full, with every changed file checked (a partial review counts for nothing yet);
- accepting (**Accept** or **Accept with nits**);
- not revoked.

Each reviewer counts once, and their latest review of a version decides where they stand.
A reviewer whose latest review is **Reject** holds the version as rejected, however many others accept it, until they accept it again.

The tile shows whether every version passes, how many want reviews (`1 + 4 to review`), or that the review fails, and the popup shows what fails it and each version's state (`2/2`, **reviewed** by the host, **rejected**, **baseline** or **can't review**).
For a reader who publishes to a counting team, each version links to its review page, an update's compared with the version it replaced.

## What can't be reviewed

A version can be reviewed only where it is locked from npm's registry, by name or by the exact link to its tarball (with only a hash after it, as Yarn 1 writes its sha1), and with an integrity.
These versions fail the pull request's review even where its lockfiles locked them before: one from git, a tarball another host serves (a mirror's too) or a tarball link with a query, and one locked with no integrity.
The review also fails for a changed lockfile that couldn't be read, a Bun lockfile, lockfiles left unread because the pull request changes too many files or directories, or a directory that locks more versions than are checked (see [Limits](#limits)).
A file of the project's own is not reviewed.

The app does not review pnpm patches yet, so team reviews never pass a patched version, and it never links to a review page.
It passes only by the host's `lookup`, by reviews of its patch in the open pull request's comments through `parseComments`, or, where the host registers no hook, by being locked the same way, patch included, at the baseline commit.

## Repository settings

An admin turns on a connected repository's review in its page under Repositories, with the switch in its **Dependency review** section.

| Setting | Values |
| --- | --- |
| Required reviews | How many counting reviews each version needs, one to ten |
| Since commit | Optional: the full id of the baseline commit (below) |
| Lockfiles | Every lockfile (the default), every lockfile but those named, or only those named |

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

## Who reviews and publishes

A team reviews dependencies once an admin turns on its **Enable dependency review** switch in **Manage → Teams**; it is off by default.
A user reviews dependencies in such a team, where it is visible to them, if they are a member who triages with its **Dependencies** permission, a member who manages, or an admin (for any such team).
Only they see a package's **Review** tab.
They publish only to enabled, visible teams they review in (any such team, for an admin).

## Reviewing a version

A package version's **Review** tab opens `/npm/<package>@<version>/review`, and with no base every file is reviewed as an addition.
Append `/<basePackage>@<baseVersion>` to review an update, or a bare version for the same package; tags resolve to exact versions.

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
Its sub-tabs are:

- **Pull requests**: those whose versions want reviews or whose review fails, fewest added versions first, each a card that opens its popup.
- **Versions**: every added version that wants reviews, once, with the pull requests that add it.
- **Default branch**, where anything there wants reviews: what each repository's default branch locks that wants reviews or fails them, and its lockfiles left unread.
- **Reviews**: the reviews published to the team, revoked ones too, latest first, with their authors.

A version is listed under the first pull request that adds it, as one review passes it everywhere, and later pull requests that add it say so.

The tab reads all its repositories in one request, and shows each one as soon as the server has read it.
A repository whose review is off, or that the reader may read only part of, is answered at once, without asking GitHub.
What the tab read is kept for two minutes; drawn after that, it is shown while it is read again.
A pull request's popup, and its repository's tiles, reuse what the tab read.
The line counts on its rows come with the tab's answer where they are already counted, and the rest are asked for 50 at a time.

## Host reviewed dependencies

A host that keeps reviewed dependencies of its own registers them once, before `init()`.
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

Once registered, `lookup` replaces the baseline commit: the repository page shows none and the server refuses one.
A commit stored before is kept unused, for a server that later registers no hook.

### `lookup`

`lookup` is asked about each version an open pull request's lockfiles lock that its teams' reviews don't pass.
Where the host has `parseComments`, it is also asked about each added version the teams' reviews do pass, before comments are read for it.
It receives the version as the lockfile locks it: `ecosystem` (`npm`), `lockfile` (`npm`, `pnpm` or `yarn1`), and always `name`, `version` and `integrity`, as a version with no integrity fails the review instead.
It also receives `shasum`, the hex sha1 Yarn 1 writes after a tarball's `#`, and `patchHash`, pnpm's patch hash, where the lockfile has them.
A version it answers `true` for passes, and shows as **reviewed**.
A version it fails to answer for wants its reviews and is counted as unasked in the popup, and the error is logged.
Each version is asked once per request, up to sixteen at once, and an answer may be reused for a minute.

### `parseComments`

`parseComments`, optional, reads the reviews an open pull request's comments make, and is asked only about an open pull request whose held lockfiles change.
It receives the pull request (`repository`, `number`), its comments (`comments`, up to a thousand), and the versions it may review (`dependencies`).
Each comment has `kind`, `id`, `author` (a GitHub login), `body`, `createdAt`, `editedAt` where edited, and `url`.
`kind` is `comment`, `review` (a review's own comment, with its `state`), or `review-comment` (on a line of the diff).
`dependencies` are:

- every reviewable version the held lockfiles add that neither the teams' reviews nor `lookup` pass;
- those the teams' reviews pass but `lookup` doesn't, so that other pull requests learn what this one reviews;
- the other versions its lockfiles lock that still want reviews.

A version that `lookup` passes is never given.
It returns the reviews the comments make, `[{ user, time?, dependencies: [{ name, version, integrity, patchHash?, status }] }]`.
`status` is `accept`, `accept-with-nits`, `request-changes` or `reject`, each review is taken as full, and a patched version's review is of its patch.

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
| `new` | The version reviewed, `{ name, version, integrity, shasum?, patchHash? }`: the integrity and shasum the review keeps of the tarball it read (`shasum` where it keeps one), and `patchHash` where a pull request's lockfile has it |
| `old` | The version it was compared with, `{ name, version, integrity, shasum? }` as the review keeps them, or null where the package was read whole |
| `status` | `accept`, `accept-with-nits`, `request-changes` or `reject` |
| `coverage` | `full` or `partial` |
| `comment` | The final comment |
| `files` | The `{ path, status, comment }` of each file checked or commented on |
| `reviewer`, `publishedAt` | The author's login and the publication time |

It is asked of each of the asker's reviews alone, wherever it is shown to its author.
For an open pull request, it is asked of all the asker's reviews published to a team counting for its repository of the versions it adds (matched by integrity and patch, whole or compared with a version they replaced), with `pullRequest` as `{ repository, number }`, for its popup and its card on a team's Dependencies tab to copy.
It returns the text to copy, and an empty, null or undefined answer, one over a million characters, or a failure (logged) gives nothing to copy.
It is given only the asker's own published, unrevoked reviews, however it is asked, so another author's review never offers the button.

## Limits

| Limit | Effect |
| --- | --- |
| A pull request changes over 3,000 files, or lockfiles in over 20 directories | It is cut, and its review fails |
| A directory locks over 20,000 versions | The review fails |
| Over 100 lockfiles at the baseline commit, or held on the default branch | The rest are unread: the baseline's need reviews, and the default branch's fail its review |
| Over 1,000 open pull requests in a repository | The Dependencies tab reads the 1,000 updated latest, and says so |
| The Dependencies tab's request runs over 4 minutes | The repositories left are read again, up to 3 times; any still left show as failed until the tab is drawn again 30 seconds or more later |
| A note over 20,000 characters | Refused |
| A review changed elsewhere meanwhile, or a version or integrity that no longer matches | `409`, and the change is not saved |
| GitHub refuses the repository's contents or the pull request | The popup says so (`502 github-status-403`) |

## Access and privacy

- Dependencies, of a pull request or the default branch, are read and checked as the pull request itself is (see [code-viewer.md](./code-viewer.md)), and access is checked again after GitHub answers, unless the whole answer came from kept data.
- A repository that reviews no dependencies answers so without asking GitHub, but only once the reader's access in the app is checked.
- The team Dependencies tab leaves out any repository the reader may read only part of.
- While the tab's request runs, the reader's session is checked before each repository's answer.
- Before each answer showing a repository's dependencies, the request also checks that the team is still the reader's and still holds the repository, and that the reader may still read all of it; where not, the answer stops there.
- The review page and its list check private npm access for both versions of a comparison (see [npm-viewer.md](./npm-viewer.md) for who reads private packages).
- A team's published reviews list only for one who reads reviews in that team, access is asked again once npm is read (`404 no-team`), and each review is held to the reader's npm access.
- Every change to a review needs a session, a CSRF token and the triage role, and all but publishing (held to its teams) and revoking also need reviewing in some team (`403 review-access-required`).
