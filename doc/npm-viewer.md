# npm package viewer

The npm package viewer opens any published npm package version to read and review: its facts, files, code, risk, and changes against another version.
Public packages are open to every workspace reader.
Private packages need the server's `NPM_TOKEN` and a team that lists their scope.
A private package's name never reaches Socket or OSV, and [Privacy](#privacy) lists all that is ever kept of it.

## Opening a package

Every role but `none` can open a version from the landing page's **npm packages** card, from `/npm`, or at `/npm/<name>[@<version>]`.
A dist-tag link such as `/npm/lodash` is rewritten to the exact version it opened.
`/npm` lists the reader's last ten searches, kept in the browser per signed-in user as a convenience, not access control.
See [navigation](./navigation.md) for the tab, Code and Compare routes.

## Tabs

| Tab | What it shows |
| --- | --- |
| **Overview** | The version's facts, risk, dependencies, advisories and files (below). |
| **Code** | The file tree and source viewer, opening on `main`. |
| **Search** | Text search across the version's text files, with case and regular-expression toggles. |
| **Treemap** | The files by size, colored by directory. |
| **Compare** | The version against another version of the same package (below). |
| **Review** | Dependency review of the version or an update, for dependency reviewers; see [dependency reviews](./dependency-review.md). |

These are the bundle view's tabs; see [bundles](./bundles.md) for what they share.

### Overview

- A readability warning counts the files that are hard to review by reading, by category: not UTF-8, control characters (bidirectional controls included), invisible characters text can be hidden in, lines over 1,000 characters, minified, source maps, and inline source maps.
  Each category filters the Files list.
- The manifest's facts: description, license (opening its file), author, publisher, publish date, GitHub repository with its stars, forks, issues and pull requests, publish commit with its tags, provenance, homepage and integrity.
- A publisher or author known to publish one of npm's most downloaded packages is marked as such.
- A version under two weeks old is flagged, except in a scope a visible team lists.
- Provenance shows npm's SLSA statement: what built the version, from which repository and commit, and with which workflow and run.
  It is flagged where that repository is not the one the package names, or where npm lists provenance but no statement names the tarball.
- Entry points, engines, install scripts in the order npm runs them, the dependency count, and the files, lines, tarball size and unpacked size.
- Downloads for the latest week and year, a chart across the year, and the package's tier among npm's packages (top 10 through top 100,000, else unpopular).
- Links to the version on npmjs.com and, for a public package, on Socket, and the tarball download.
- The risk score and its chips (see [Risk](#risk)).
- A banner where npm's security team took the package down, and Socket's alerts on a public version, each naming its file.
- Languages, encodings, file types, and Socket's supply chain, vulnerability, quality, maintenance and license scores for a public package.
- **Dependencies** (peer and optional ones included), each opening in the viewer where npm installs it from its registry.
  `non-registry` tags one npm fetches from elsewhere (a repository, a URL tarball).
  `unimported` tags one that no code file imports and no install script names; peer dependencies and `@types/` packages are never tagged.
- **Advisories** across every published version: those affecting this version first, those fixed in it struck through.
- **Files**, tagged with their category and flags: Socket alerts, code that runs beyond itself (`eval`, `child_process`, `credentials`, `whole env`, `publish`, `shell`, `persistence`), hosts named (`Exfiltration`, `Remote`, `IP lookup`), `Large` and `Obfuscated`.
  Flagged files sort first, the most severe first.
- Binary files, listed again on their own.

### Code

Each file links to GitHub at the commit the version was published from, where npm recorded both the repository and that commit.
A file its build wrote may not be in the repository.
A minified file of up to 4 MiB, in a language the server formats, has a pretty-print toggle.
The formatted copy has its own lines, so line links and marks stay on the file as published.

### Compare

Compare picks another version of the same package, newest first, flagging those under two weeks old.
**Swap** opens the version compared with, against the one before it.

Chips at the end of the picker row flag what calls for a look:

- each version's risk score;
- deprecation of the open version;
- a changed publisher (`~alice → ~bob`), as when a package changes hands;
- provenance lost;
- install scripts added or changed;
- in red, code that runs beyond itself new to a file the open version adds or changes, and in orange, such code kept from the older version;
- credentials, and hosts by tag, new to a file the open version adds or changes, the hosts a level more severe than their tag;
- `New hosts`: hosts the open version names that no file of the older version did;
- `Large new code` (an added code file of 256 KiB or more), `Now unreadable` (a changed file gains a line over 2,000 characters), `Obfuscated` and `Binary code`;
- `Non-registry deps` and `Unused deps`, the latter red where, for example, a new dependency's package was first published since the older version;
- an open version under two weeks old;
- advisories from one version to the other;
- Socket scores below their bar, for a public package;
- the package's download tier where it is past the top 20,000.

Compare's Overview lists the dependencies only one version has and the ranges that changed.
A new dependency is tagged with its package's download tier, and with its age or `published later` where its package did not exist when the older version was published.
Compare's Files section lists every changed file; files that are not text compare by digest.

In Code, the pretty-print toggle is offered wherever formatting changes the diff.
For JavaScript minified on both sides, lines that differ only in names the minifier renamed are drawn faint and counted apart.
**Hide renamed names** gives the old side the new side's names; where either side reads names (`.name`, `.toString`, `.stack`), a note warns that values may change.

## Risk

Risk is worked out on the server by [risk](../risk/README.md); the viewer shows it as told and computes none of it.
The Overview compares against the version risk judges most likely free of an injected attack, Compare against the version picked, and Review with no base against an empty package.

The score is out of 100, with four levels:

| Score | Level | Ring |
| --- | --- | --- |
| 75 and up | critical | red |
| 50 to 74 | high | orange |
| 25 to 49 | moderate | yellow |
| under 25 | low | plain |

- Malware scores 100: npm took the package down, or an advisory of npm's or OSV's names the version as malware.
- Every other finding raises the score by its severity, each adding less the more there are: one red finding alone is 50, two are 75.
- The version's exposure lowers the score by up to 90%: how long it has been out (from two weeks to two years) and how widely its package is downloaded.
- Findings on the version alone: deprecation, install scripts, code that runs beyond itself, credentials reached for, hosts named, obfuscation, non-registry or unused dependencies, and low popularity.
- Against another version, what the change brought can only raise a finding's severity, never lower it.
- Findings only a change tells: a changed publisher, provenance lost, new install scripts, new hosts, large new code, a file now unreadable, and code that is not text.
- Popularity is at most yellow where a known account published the version, or where it was published with provenance in a known scope.
- A team's own scopes are trusted however new and however few download them: no age or popularity finding, and npm is not asked about a new dependency on one of their packages.
- The score's tooltip lists the findings that raised it and how much exposure lowered it.

## Access

- Anyone with workspace access can read public packages.
- A version is public only when npm's registry answers for it without credentials.
- A private package needs the server's `NPM_TOKEN` (the one bundle builds use) and a reader who is an admin, a manager, or a member of a visible team that lists the package's scope.
- Admins set a team's scopes in **Manage → Teams → npm scopes**.
- Scopes are lowercase, with `@` added when typed without one.
- Scope changes are recorded in the activity history, and a team's scopes are removed with it.
- Readers with private access try the registry anonymously first, and retry a scoped package with the token.
- Access is checked on every request, and again after the registry answers; a reader who lost private access meanwhile gets 404.
- Streamed pretty-printed files recheck access before each file and stop when it is lost; a comparison rechecks once it is worked out.
- Line counts asked for many versions at once get the same checks as one, each version on its own.
- A version npm does not have and a private one the reader cannot open are both 404 `package-not-found`.
- The browser reuses public versions it read in the session; a private version is fetched each time it opens, so access is rechecked.
- Public workspace links cannot reach the npm endpoints.
- Responses are `private, no-store`.

## Privacy

- Registry documents are kept only as npm answered them anonymously; none read with `NPM_TOKEN` is kept.
- Tarballs, including those bundle builds and private reads fetch with the token, can be kept in upstream's tarball cache on disk (off Vercel).
- A kept tarball is served only when it matches the sha512 named by the reader's own access-checked registry answer, which is the anonymous one for a public version.
- A private version's unpacked files, pretty-printed copies and rename diffs are never kept.
- A private package's publish times and risk records never reach the database or any cache shared between instances; risk records stay in the instance's memory.
- Compare's line counts are kept in the database for private versions too, keyed by the tarballs' integrities alone, with no name or content.
- A private package's name is never sent to Socket or OSV: both are asked only about packages npm answers for anonymously.
- A private package has no provenance lookup, no Socket report and no download tier.
- The publisher is shown by npm account, never by email.
- GitHub figures, tags and repository advisories are shown only for repositories GitHub says are public, as they are kept for every reader.
- What is derived from a public version (formatted copies, assessments, line counts, publish times) is shared by every reader, and formatted copies are kept unencrypted, since their source is public.

## Upstream services

| Service | Asked for | Credentials |
| --- | --- | --- |
| npm registry | Version documents, version lists, tarballs, provenance statements, and audit advisories for every version | None; `NPM_TOKEN` only as the private-access retry above |
| npm downloads API | Daily downloads over the last year | None |
| GitHub | Repository figures, tags at the publish commit, and repository advisories, for public repositories only | The reader's own token where they have one; tags are not asked for without one |
| OSV | Advisories and malicious-package records the registry lacks | None; public packages only |
| Socket | Scores and alerts for the version | None; public packages only |

## Limits and errors

A package is refused before download when the registry's declared unpacked size or file count is past the limits.

| What | Limit | Error |
| --- | --- | --- |
| A package's files | 64 MiB and 20,000 files | 413 `package-too-large` |
| Its tarball, as downloaded or unpacked | 96 MiB and 40,000 entries | 413 `package-too-large` |
| Its files as sent to the viewer | 96 Mi characters | 413 `package-too-large` |
| Compare's line counts | 64 MiB of text across both versions | 413 `package-too-large` |
| Package loads, registry reads or risk assessments at once | Server capacity | 429 `npm-busy` |
| Compare's line counts waiting | Server capacity | 429 `delta-busy`, or 504 `delta-timeout` after a minute |
| A malformed tarball, one with a path or symlink leaving it, or one naming a path twice | | 422 `bad-tarball` |

Directories and links in a tarball are never extracted.
