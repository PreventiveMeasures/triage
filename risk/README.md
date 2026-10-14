# risk

What calls for a look at an npm package version, for a reviewer: every heuristic the npm viewer flags a version or a file by, apart from any view of them. Plain JavaScript, no DOM, no UI.

Risk is told on the managed server alone (`GET /api/npm/risk`, server-managed/npm-risk.ts), never in the e2e and local modes. The npm viewer reads what it tells of a version, and of a pair, from there (ui/view/npm-risk.js, file-risk.js): its chips, its files' tags and its dependencies' flags, tiers and ages, computing none of them. What the viewer still reads of files itself:

- A Stasis bundle's, for their tags (`npm/files.js`), as no server tells them.
- What it does with a file: whether it is minified, to pretty-print it or hide a minifier's renames in it; its characters, to show them; its lines.
- What it lists: a version's dependencies and their changes, its install scripts, its downloads by week and month, and a release's age in its version list.

## Asking

```js
import { assessNpm } from './risk/index.js'

const assessment = await assessNpm('axios', '1.14.1', {
  oldVersion: '1.14.0', // compared with; true for one risk picks (below); without one, everything of the version is new
  fromEmpty: false, // true for an initial dependency review: compare every file with an empty package
  minimumReleaseAge: 14 * 24 * 60 * 60_000, // the default, two weeks; 0 for none, as a caller's own scopes take
  popularity: true, // the default; false for none, as a caller's own scopes take
  advisories: true, // the default; false to ask none of npm's advisories, as a scan asking them of a lockfile at once does
  osv: true, // the default; false to ask OSV of none, as a private package's name is never sent it
  owned: name => name.startsWith('@mine/'), // the caller's own packages, a new dependency on one told no tier nor age; none by default
  cache, // as @preventive/upstream's CacheStore: read(type, key) and write(type, key, value)
})
```

## Picking the version compared with

A pair's findings flag only what is new against the version compared with, so an attack's own earlier version, or one published with it, hides what it injected. With `oldVersion: true`, risk compares with the one of the package's versions most likely free of that (`npm/old-version.js` `npmOldVersion`), and says which as the assessment's `oldVersion`: none where none is below the open version, which is then assessed alone. Each account is told by its standing on the package when the open version was published (`npm/release.js` `npmAccountStanding`), as the `publisher` finding tells it, and the viewer tints it:

- `known`, green: one that publishes one of npm's most downloaded packages (`@preventive/publishers`, `npm/manifest.js` `knownAccounts`), and only that.
- `maintainer`, yellow: one of the package's maintainers, known to no list but on it three months or more, or the first to publish it, as its sole maintainer is. The package's own history tells what the list can't of most packages.
- `new`, orange: an unknown publisher new to the package, as one taking it from its maintainers is.

Of the versions below it, a release where it is one, the highest that is preferred, each preference kept only where some version holds it, in turn:

1. Where an account new to it published it, one another account published, as an attack may have published more than one.
2. One published before it, not after, as one published since (a backport) is no version it came from.
3. Where the highest of those an account of a higher standing than its own published, as when a package is taken from its maintainers, one an account of that standing or higher published.
4. One published a day or more apart from any version since removed from npm, as not one of the attack npm removed those of: npm's document keeps a removed version's time, though not the version.
5. One published a week or more apart from it, as not one of an attack's, and on npm a month or more, as looked at; but for one a known account other than its own published, trusted however new, as an account taken leaves another's versions alone, and one another of its maintainers published, held to the week alone, as a maintainer no list knows of is taken with its peers as often. Its own account's are held to both, as it may be the one taken.
6. One npm doesn't say is deprecated, as one a maintainer took back.

The highest is in the open version's branch (`1.x.y`, `0.2.y`, `0.0.y`) where one is there, else in the closest branch below. The pick is told by npm's document alone, read at most once an assessment, and kept an hour: no tarball is read for it, and the one picked has its tarball read only where its files could change what is found, as any version compared with.

What of an assessment holds whatever the time is `npmLastingRisk(other, base?)` (`npm/assess.js`), of versions held as the viewer holds one, and `npmAssessmentOf` makes an assessment of it with what is told fresh: the managed server's, and a test's of versions it holds.

`assessNpm` reads npm's registry, its advisories (as `npm audit` asks them, through upstream's `advisories`) and its downloads API itself, and keeps what it reads in `cache`, each record under its own type, for the caller to route each type where it belongs:

| Type | Key | What | Changes |
| --- | --- | --- | --- |
| `npm/tarballs` | `<name>@<version>` | a version's tarball, its bytes (upstream's `getTarball`, checked against its integrity) | never |
| `risk/npm/versions` | `<name>@<version>` | what its document says: manifest, publish time, dist | never |
| `risk/npm/packages` | `<name>` | its deprecated versions, those npm removed, and whether npm took it down | asked again after an hour |
| `risk/npm/old-versions` | `<name>@<version>` | the version risk picked to compare it with, or none (`oldVersion: true`) | picked again after an hour |
| `risk/npm/advisories` | `<name>@<version>` | npm's advisories of it, and where `osv`, OSV's records of it npm's registry hasn't (upstream's `osv`) | asked again after an hour |
| `risk/npm/public` | `<name>` | when a public package (a dependency) was first published | asked again after an hour |
| `risk/npm/downloads` | `<name>` | its downloads a day, and when they were asked; `npmReadyDownloads` keeps many at once, unscoped ones in one lookup of 128, and `npmReadyDownload` one, so that assessments ask npm none | asked again after a week, as the tier they put it in hardly moves in one |
| `risk/npm/assessments` | `<reading>/<name>@<version>[..<old>][~<removals>]` | what of an assessment holds whatever the time | read anew when `RISK_VERSION` moves, and a pair another account published as npm removes a version, as its publishers' standings may change |

An assessment kept needs no tarball. Against `oldVersion`, its tarball is read only where its files could change what is found (`npm/compare.js` `npmBaseFilesTell`): the open version's files are read first, and a pair's file findings only ever flag what they hold that the old version's didn't, so where none of them runs code beyond itself, names a service under one of the hosts' tags or a host past `ALLOWED_HOSTS`, bears an obfuscator's fingerprint, has a line over 2,000 characters, is large code or is code that isn't text, nor could a `binding.gyp` change the old version's install scripts, the old version is told by npm's document of it alone: its publisher, provenance, install scripts and dependencies. What depends on the time (malware, a deprecation, being too new, popularity, a new dependency's tier and age) is told fresh on each call.

The package assessed is asked for with the npm token the environment has for a scoped one, as upstream asks. Its dependencies' downloads and first publish are asked with none: a private dependency reads as unknown, not unpopular.

Risk is bounded, however a package is made:

- Of each file, it tells the first 100 places the file does each thing it runs or names each exfiltration service, the first 1,000 hosts it names, and how its lines are minified by its first 4 MiB.
- An assessment past 16 MiB as JSON is refused (`package-too-large`), its files measured as they are read, for either version read, so that no more is held.
- Each request it makes of npm itself is given up on after 30 seconds, and a tarball upstream is still downloading once `signal` aborts.
- It asks after the packages of at most 100 dependencies added, the rest left unknown.
- It reads a package's document to 64 MiB, a tarball's tar stream to 96 MiB as it unpacks, and its files to 20,000 and 64 MiB, as the npm viewer does (`NpmRiskError` `upstream-too-large`, `package-too-large`).

A caller holding its reads of npm to bounds of its own asks for documents and tarballs itself: `packument: (name, { authorized, signal }) => document | null`, `authorized` for the package assessed, not its dependencies, and `tarball: (name, version, { signal }) => bytes`, gzipped, for the version assessed or the one compared with. The managed server does both, its documents within the budget they all share and its tarballs as the viewer loads them. Without `tarball`, a tarball is upstream's `getTarball`'s, held to upstream's bounds (512 MiB).

## What it tells

- `findings`, each `{ id, severity, … }`, in the order a reviewer reads them. First, with or without `oldVersion`:
  - `malware`, critical (`npm/malware.js`): its package taken down by npm (`takenDown`), whatever version is asked, its latest version npm's placeholder, a "security holding package" from `npm/security-holder` published by npm; and the advisories of malware naming the version (`advisories`, each `{ id, url, title }`): npm's, CWE-506 (embedded malicious code) whatever their title, or a title naming malware, as @solana/web3.js's GHSA-jcxm-7wvp-g6p5 does with CWE-200 alone; and, where `osv`, OSV's records npm's registry hasn't (upstream's `osv`), the malicious packages OpenSSF lists (`MAL-…`) among them, as nx's malicious versions have none of npm's but OSV's MAL-2025-41443; an advisory of npm's that such a record names, by id or alias, is of malware too, whatever its title and CWEs. A version npm removed, as it removes every one it finds malware in, is told of by its malware alone (`removed: true`, its `published` from npm's `time`, no files nor dependencies); one removed with no malware told of is `version-not-found`, as one npm never had.

  Then, with or without `oldVersion`, what npm says of the version and what it holds (`npm/held.js`), as the npm Overview and Compare flag it alike, as no change hides any of it:
  - `deprecated`
  - `held-install-scripts`
  - `held-runs-code`, `held-credentials` (the kinds reaching for credentials, apart from the code a file runs: `files/runs-code.js` `CREDENTIAL_TAGS`), `held-exfiltration` (red), `held-remote` (orange), `held-ip-lookup` (yellow), `held-obfuscated`
  - its dependencies' `held-non-registry-deps` and `held-unused-deps`, flagged against none
  - `too-new`
  - `popularity`: red where unpopular, else orange; yellow at most, whatever its tier, where an account known to publish one of npm's most downloaded packages published the version (`known`), as few download a new package such an account starts, or else, as many are published by a CI that names no account, where the version was published with provenance, as a token alone, stolen, publishes none, and the package is in a known scope (`known` with its `scope`): one of those packages' scopes (`@preventive/publishers/npm-scopes.js`), or a known account's own, `@` and its name (its `account` too), whose owner alone publishes in it

  Against `oldVersion`, what changed is folded into what it holds, never lowering it (`npm/combined.js`): each held finding the more severe of its own and its change's, what the change brought marked (`added`), a file moved told against its old one (`npm/diff.js`), paired by its content as git diff -M pairs it, or by its name but its hash where a build names it by its content (`assets/index-CyWAfh-p.js`), one removed and one added; and what only a change tells added:
  - `publisher`: each account's standing on the package (`wasStanding`, `nowStanding`, below), yellow to a known account or one of its maintainers, red from a known account to one new to it, else orange; a level lower in a major release (its major number higher, or its minor for 0.x), as a package changing hands with a rewrite is
  - `provenance-lost`
  - `held-install-scripts`: those added or changed (`flagged`), and what ran before (`was`)
  - `held-non-registry-deps`, `held-unused-deps`: those new (`added`), a spec before (`was`)
  - `held-unused-deps` graded fresh, each dependency by its package as `dependencies` tells it (`npm/new-dependency.js` `npmUnusedDependencySeverity`), the finding as the most severe: one kept from `oldVersion` yellow, as that version held it; a new one red where its package was first published since `oldVersion` (plain-crypto-js to axios 1.14.1, the `@tanstack/setup` and `@antv/setup` packages to theirs), or where the version its spec installs (`installs`: `{ version, latest, published, scripts, new }`, as npm picks it: a tag it names, else `latest` where that satisfies it, else the highest, one not deprecated first) was, has install scripts and isn't its package's latest, as an old package's old major line given a release to run them would, where a package still releasing its latest wouldn't; orange where that version has install scripts, as installing an unused dependency runs them and nothing else; yellow among npm's top 20,000, as a dependency named for another's peer or by a tool's config is (react, typescript, eslint), else orange, as where its package isn't told; a version alone, each by its package. Each with its `severity`, its `tier` and `level`, its package's `created` and `gap`, and `installs`, where told
  - `held-runs-code`, `held-credentials`: red where code a file runs beyond itself, or a credential it reaches for, is new to it; `held-exfiltration`, `held-remote`, `held-ip-lookup`: a level higher where a file names a service anew under the tag (`files/hosts.js`), so red, red and orange; `held-obfuscated`: red where a file's fingerprint is new
  - `large-code`, `now-unreadable`; `now-unreadable` orange where each file's source map was rebuilt with it (its last line names its map, and the `.map` beside it is new or changed) or in a major release
  - `binary-code`: a JavaScript or TypeScript file (a declaration file too) added or changed that isn't text (not UTF-8, or holding a NUL), where the old version's wasn't one: no one can read it in review, yet a UTF-16 one, by its byte order mark, runs as a browser's classic script or in Windows Script Host, and TypeScript reads it
  - `new-hosts`, but for nine where packages keep their code and docs (`npm/compare.js` `ALLOWED_HOSTS`: `github.com`, `lit.dev`, MDN, …), each as written: `api.github.com` is still named, as is a repository `github.com` serves files or releases from (`github.com/owner/repo`)
- `files`: each file's stamps (`{ name, severity }`, as a list of files tags and orders it), and what was read of it:
  - how it reads (binary, minified, long lines, source maps, control and invisible characters, an obfuscator's fingerprint)
  - what its code runs beyond itself (eval and its kin, child_process, credentials, the whole environment, publishing, shell commands fetching or handing off code, places code runs from again later); credentials as a credential file's path (`.npmrc`, `.ssh`, `.aws`), a token's name where it is read (`NPM_TOKEN`, `GITHUB_TOKEN`), `gh auth token`, the cloud's instance metadata endpoint (`169.254.169.254`, `metadata.google.internal`), the GitHub Actions runner's process (`Runner.Worker`), another process's memory (`/proc/<pid>/mem`) and trufflehog; a shell script's (`.sh`, `.bat`, `.ps1` …) shell commands, places and the credentials a command reaches for (all but files, tokens and the metadata endpoint), read whole
  - the services it names that malicious packages send what they take to, fetch what they run from or look the machine up with, under three tags: Exfiltration (request catchers and out-of-band testing hosts, `critical`), Remote (what could be fine: bot and webhook APIs, paste sites and file drops, tunnels, Bun's install script, `high`) and IP lookup (`moderate`)
  - the hosts its code calls
- `dependencies`: those added and changed, each with its flags (from elsewhere than the registry, imported by nothing), and against `oldVersion` each it holds, flagged against none (`held`), an added one with its package's tier by downloads (its latest two weeks left out), its last whole month's downloads by what that goes by (`month`), whether npm counts none of them (`uncounted`) and, where it is new since the version compared with, when it was first published. A version alone is flagged against none.

- `score` (`npm/score.js`): the version's risk as one number, out of 100, for a reviewer to tell at a glance which versions to read first. Its findings stay what to read; the score only weighs them:
  - `malware` is 100, however old the version.
  - Else each finding raises it by its severity, combined as independent chances are (`1 − Π(1 − weight)`), so each adds less the more there are and none takes it past 100: `critical` 0.5, `high` 0.2, `moderate` 0.08, `low` 0.03, a `notice` none. One red finding alone is 50; two red, or a red one and two orange, 75 or more. `too-new` counts for nothing, as the version's age is told below.
  - Then its exposure lowers that, by up to 90%: how long the version has been out, from two weeks (none before, as an attack on the most downloaded package is new) to two years on a log scale, times how widely its package is downloaded now, by its tier: fully in the top 200, 95% to the top 1,000, 85% to 5,000, 65% to 20,000, 35% to 100,000, 10% past that, and 25% where its downloads aren't known (a caller's own package, `popularity: false`). A version out for years among millions would have been found and pulled were it an attack: progress@2.0.3, whose publisher a known account gave way to one new to it in 2018 (a red `publisher` finding), scores 7.
  - `{ score, level, raised, lowered? }`: `level` named as the findings' severities are, `critical` from 75, `high` from 50, `moderate` from 25, else `low`; `raised`, the findings it counts, `{ id, severity }` each; and where its exposure lowered it, `lowered`, `{ days, tier, by }`: the days the version has been out, its package's tier (null past the last or where unknown), and the share taken off.

  On the earlier evaluation's pairs, each as a reviewer would have seen it the hour it came out (no exposure, no deprecation made since, its package's tier then), the score tells the dataset's compromised versions from popular packages' latest releases, each against the version before it:

  | Score | Compromised (1,240 of 1,259; 19 too large to assess) | Popular (989 of 990) |
  | --- | --- | --- |
  | 75 or more, critical | 87.4% | 0% |
  | 50 or more | 98.8% | 0.8% |
  | 25 or more | 99.4% | 2.2% |

  A compromised version outscores a popular one 99.9% of the time. The 15 it leaves under 50 call for a look by one or two orange findings alone: xrpl's new hosts, eslint-config-prettier's install script, a dependency from elsewhere than npm's registry that nothing imports. Today, the 350 popular releases out over two years score 34 at most, all but one low.

Severities, the most first: `critical` (red), `high` (orange), `moderate` (yellow), `low`, `notice`.

## Inside

- `files/`: one file's readers.
  - `script.js`: JavaScript's and CSS's tokens.
  - `characters.js`: controls and invisible characters.
  - `readability.js`
  - `runs-code.js`
  - `hosts.js`
  - `stamps.js`: all of a file's stamps.
- `npm/`: a version's and a pair's.
  - `specs.js`, `dependencies.js`, `install-scripts.js`, `downloads.js`, `release.js`, `new-dependency.js`
  - `old-version.js`: the version compared with, where risk picks it.
  - `combined.js`: what a version holds with what changed folded in.
  - `compare.js`: a pair's findings; `held.js`: a version's own.
  - `files.js`: each file read once a version.
  - `diff.js`: renames, as Compare pairs them, and a build's content-hashed files by their names.
  - `malware.js`: what tells of malware, npm's takedown and its advisories.
  - `score.js`: the risk score, from the findings and the version's exposure.
  - `manifest.js`, `tarball.js`, `registry.js`, `assess.js`

Each pure function takes a version as the viewer holds one (`{ kind: 'sourcemap', npm, json }`), but `held.js` `npmVersionFindings`, which takes what npm says of it now: its deprecation, when it was published, and its package's downloads.
