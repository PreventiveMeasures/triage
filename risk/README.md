# risk

`risk` tells a reviewer what calls for a look at an npm package version.
It holds every heuristic the npm viewer uses to flag a version or a file, kept apart from any view of them.
It also checks a repository's GitHub Actions (`actions/`, below).
It is plain JavaScript, with no DOM and no UI.

Only the managed server computes risk (`GET /api/npm/risk`, `server-managed/npm-risk.ts`).
The e2e and local modes never do.
The npm viewer reads what risk says of a version, and of a pair of versions, from that endpoint (`ui/view/npm-risk.js`, `file-risk.js`).
That covers its chips, its files' tags, and its dependencies' flags, tiers and ages; the viewer computes none of them.
The viewer still reads these from files itself:

- A Stasis bundle's file tags (`npm/files.js`), because no server provides them.
- What it does with a file: whether the file is minified (to pretty-print it, or to hide a minifier's renames in it), its characters (to show them), and its lines.
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

A pair's findings flag only what is new against the version compared with.
So if that version is an attack's own earlier version, or one published with it, the findings hide what the attack injected.
With `oldVersion: true`, risk compares with the package's version most likely free of that (`npm/old-version.js` `npmOldVersion`).
The assessment's `oldVersion` names the version it picked.
If no version is below the open version, risk picks none and assesses the open version alone.

Each account gets a standing on the package as of when the open version was published (`npm/release.js` `npmAccountStanding`).
The `publisher` finding reports that standing, and the viewer tints it:

- `known`, green: an account that publishes one of npm's most downloaded packages (`@preventive/publishers`, `npm/manifest.js` `knownAccounts`), and only such an account.
- `maintainer`, yellow: one of the package's maintainers that no list knows, who has published the package for three months or more, or who published it first, as a sole maintainer has.
  For most packages, the package's own history tells what the list can't.
- `new`, orange: an unknown publisher new to the package, such as one taking it from its maintainers.

Among the versions below the open version, risk picks the highest one that meets these preferences.
If the open version is a release, releases are preferred.
The preferences apply in this order, and each applies only where some remaining version meets it:

1. If an account new to the package published the open version, prefer a version another account published, because an attack may have published more than one.
2. Prefer a version published before the open version, not after: one published since (a backport) is not the version it came from.
3. If the highest remaining version was published by an account of higher standing than the open version's publisher, prefer versions published by an account of that standing or higher, as when a package is taken from its maintainers.
4. Prefer a version published a day or more apart from any version since removed from npm, so that it is not part of an attack npm removed versions of.
   npm's document keeps a removed version's time, though not the version.
5. Prefer a version published a week or more apart from the open version, so that it is not one of an attack's, and on npm for a month or more, so that it has been looked at.
   A version published by a known account other than the open version's publisher is trusted however new, because a taken account leaves other accounts' versions alone.
   A version published by another of the package's maintainers is held to the week rule alone, because a maintainer no list knows of is taken with its peers as often.
   Versions published by the open version's own account are held to both rules, because that account may be the one taken.
6. Prefer a version npm doesn't say is deprecated, because a maintainer may have taken it back.

The highest version is in the open version's branch (`1.x.y`, `0.2.y`, `0.0.y`) where one is there, else in the closest branch below.
The pick uses npm's document alone, which risk reads at most once per assessment, and risk keeps the pick for an hour.
No tarball is read for the pick.
As with any version compared with, the picked version's tarball is read only where its files could change what is found.

`npmLastingRisk(other, base?)` (`npm/assess.js`) computes the part of an assessment that holds whatever the time, from versions held as the viewer holds them.
`npmAssessmentOf` makes an assessment from that and what is told fresh.
The managed server uses both, and so do tests of versions they hold.

`assessNpm` itself reads npm's registry, npm's advisories (as `npm audit` asks for them, through upstream's `advisories`) and npm's downloads API.
It keeps what it reads in `cache`, each record under its own type, so the caller can route each type where it belongs:

| Type | Key | What | Changes |
| --- | --- | --- | --- |
| `npm/tarballs` | `<name>@<version>` | a version's tarball, its bytes (upstream's `getTarball`, checked against its integrity) | never |
| `risk/npm/versions` | `<name>@<version>` | what its document says: manifest, publish time, dist | never |
| `risk/npm/packages` | `<name>` | its deprecated versions, those npm removed, and whether npm took it down | asked again after an hour |
| `risk/npm/old-versions` | `<name>@<version>` | the version risk picked to compare it with, or none (`oldVersion: true`) | picked again after an hour |
| `risk/npm/advisories` | `<name>@<version>` | npm's advisories of it, and where `osv`, OSV's records of it npm's registry hasn't (upstream's `osv`) | asked again after an hour |
| `risk/npm/public` | `<name>`, or `<name>@<spec>` for a dependency nothing imports | when a public package (a dependency) was first published, and for a spec, the version it installs (`installs`) | asked again after an hour |
| `risk/npm/downloads` | `<name>` | its downloads a day, and when they were asked; `npmReadyDownloads` keeps many at once, unscoped ones in one lookup of 128, and `npmReadyDownload` one, so that assessments ask npm none | asked again after a week, as the tier they put it in hardly moves in one |
| `risk/npm/assessments` | `<reading>/<name>@<version>[..<old>][~<removals>]` | what of an assessment holds whatever the time | read anew when `RISK_VERSION` moves, and a pair another account published as npm removes a version, as its publishers' standings may change |

A cache may also offer the optional `readEach(entries)`, which reads records of any types at once.
Each entry is `[type, key]`, and the answers come back in the same order, with null where nothing is kept.
Where a cache has it, risk reads a package's record and its versions' records together in one call.
Without it, risk calls `read` once per record.

A kept assessment needs no tarball.
Against `oldVersion`, the old version's tarball is read only where its files could change what is found (`npm/compare.js` `npmBaseFilesTell`).
The open version's files are read first.
A pair's file findings only ever flag what the open version's files hold that the old version's didn't.
So the old version's files are read only where one of the open version's files does one of these:

- runs code beyond itself
- names a service under one of the hosts' tags, or a host past `ALLOWED_HOSTS`
- bears an obfuscator's fingerprint
- has a line over 2,000 characters
- is large code, or code that isn't text

They are also read where a `binding.gyp` could change the old version's install scripts.
Otherwise npm's document alone tells of the old version: its publisher, provenance, install scripts and dependencies.
What depends on the time is told fresh on each call: malware, a deprecation, being too new, popularity, and a new dependency's tier and age.

For a scoped package, risk asks for the package assessed with the npm token the environment has, as upstream asks.
It asks for its dependencies' downloads and first publish with no token.
So a private dependency reads as unknown, not unpopular.

Risk is bounded, however a package is made:

- For each file, it reports the first 100 places the file does each thing it runs or names each exfiltration service.
- For each file, it reports the first 1,000 hosts the file names.
- It judges how a file's lines are minified by the file's first 4 MiB.
- It refuses an assessment past 16 MiB as JSON (`package-too-large`).
  It measures files as it reads them, for either version read, so that it never holds more.
- It gives up on each request it makes of npm itself after 30 seconds, and on a tarball upstream is still downloading once `signal` aborts.
- It asks after the packages of at most 100 added dependencies, and leaves the rest unknown.
- It reads a package's document up to 64 MiB, a tarball's tar stream up to 96 MiB as it unpacks, and its files up to 20,000 and 64 MiB, as the npm viewer does (`NpmRiskError` `upstream-too-large`, `package-too-large`).

A caller that holds its reads of npm to its own bounds asks for documents and tarballs itself:

- `packument: (name, { authorized, signal }) => document | null`, where `authorized` is true for the package assessed, not its dependencies.
- `tarball: (name, version, { signal }) => bytes`, gzipped, for the version assessed or the one compared with.

The managed server does both: its documents stay within the budget they all share, and its tarballs are read as the viewer loads them.
Without `tarball`, a tarball comes from upstream's `getTarball`, held to upstream's bounds (512 MiB).

## What it tells

- `findings`, each `{ id, severity, … }`, in the order a reviewer reads them.
  First, with or without `oldVersion`:
  - `malware`, critical (`npm/malware.js`), where either of these holds:
    - npm took the package down (`takenDown`), whatever version is asked: its latest version is npm's placeholder, a "security holding package" from `npm/security-holder` published by npm.
    - An advisory of malware names the version (`advisories`, each `{ id, url, title }`).
      npm's advisory counts where it has CWE-506 (embedded malicious code), whatever its title, or a title naming malware, as @solana/web3.js's GHSA-jcxm-7wvp-g6p5 does with CWE-200 alone.
      Where `osv` is on, OSV's records that npm's registry hasn't count too (upstream's `osv`), among them the malicious packages OpenSSF lists (`MAL-…`).
      For example, nx's malicious versions have no advisory of npm's, but OSV has MAL-2025-41443.
      An advisory of npm's that such a record names, by id or alias, is of malware too, whatever its title and CWEs.

    npm removes every version it finds malware in.
    A removed version is told of by its malware alone: `removed: true`, its `published` from npm's `time`, and no files or dependencies.
    A removed version with no malware told of is `version-not-found`, like a version npm never had.

  Then, with or without `oldVersion`, come what npm says of the version and what the version holds (`npm/held.js`).
  The npm Overview and Compare flag these alike, because no change hides any of them:
  - `deprecated`
  - `held-install-scripts`
  - `held-runs-code`, `held-credentials` (the kinds reaching for credentials, apart from the code a file runs: `files/runs-code.js` `CREDENTIAL_TAGS`), `held-exfiltration` (red), `held-remote` (orange), `held-ip-lookup` (yellow), `held-obfuscated`
  - `held-non-registry-deps` and `held-unused-deps` for its dependencies, flagged against none
  - `too-new`
  - `popularity`: red where the package is unpopular, else orange.
    It is yellow at most, whatever its tier, in two cases.
    The first is where an account known to publish one of npm's most downloaded packages published the version (`known`), because few download a new package such an account starts.
    The second is where the version was published with provenance and the package is in a known scope (`known` with its `scope`).
    Many packages are published by a CI that names no account, and a stolen token alone publishes no provenance.
    A known scope is one of those packages' scopes (`@preventive/publishers/npm-scopes.js`), or a known account's own scope, `@` and its name (with its `account` too), where only its owner publishes.

  Against `oldVersion`, what changed is folded into what the version holds, never lowering it (`npm/combined.js`).
  Each held finding takes the more severe of its own severity and its change's.
  What the change brought is marked (`added`).
  A moved file is told against its old one (`npm/diff.js`), one removed and one added.
  The two are paired by content, as `git diff -M` pairs them, or by name but for its hash where a build names a file by its content (`assets/index-CyWAfh-p.js`).
  What only a change tells is added:
  - `publisher`: each account's standing on the package (`wasStanding`, `nowStanding`), as described above.
    It is yellow where the new publisher is a known account or one of the package's maintainers, red where a known account gave way to one new to the package, and orange otherwise.
    It is one level lower in a major release (a higher major number, or a higher minor for 0.x), as when a package changes hands with a rewrite.
  - `provenance-lost`
  - `held-install-scripts`: the scripts added or changed (`flagged`), and what ran before (`was`).
  - `held-non-registry-deps`, `held-unused-deps`: the new ones (`added`), and a spec's earlier value (`was`).
  - `held-unused-deps` is graded fresh, each dependency by its package as `dependencies` tells it (`npm/new-dependency.js` `npmUnusedDependencySeverity`).
    The finding takes its most severe dependency's grade:
    - Yellow: one kept from `oldVersion`, because that version held it.
    - Red: a new one whose package was first published since `oldVersion` (plain-crypto-js to axios 1.14.1, and the `@tanstack/setup` and `@antv/setup` packages to theirs).
    - Red: a new one where the version its spec installs was published since `oldVersion`, has install scripts and isn't its package's latest.
      That version is `installs`, `{ version, latest, published, scripts, new }`, as npm picks it: a tag the spec names, else `latest` where that satisfies it, else the highest, preferring one not deprecated.
      This catches an old package's old major line given a release to run install scripts, but not a package still releasing its latest.
    - Orange: one where that version has install scripts, because installing an unused dependency runs them and nothing else.
    - Orange: one whose package npm has for no one (`missing`), as when it was unpublished or taken down, whatever downloads npm still counts.
    - Yellow: one among npm's top 20,000, as a dependency named for another's peer or by a tool's config is (react, typescript, eslint).
    - Orange: any other, as is one whose package isn't told.

    A version alone is graded the same way, each dependency by its package.
    lodash and Babel's own presets (`@babel/preset-*`), where npm installs that package from its registry, are told all the same, as notices.
    They count nothing toward the score and are not looked up as unused (`npm/dependencies.js` `npmUnusedDependencyCounted`).
    Packages keep naming lodash after their code stops importing it, and a config names a preset by a string.
    Each dependency carries its `severity`, its `tier` and `level`, its package's `created` and `gap`, and `installs`, where told.
  - `held-runs-code`, `held-credentials`: red where code a file runs beyond itself, or a credential it reaches for, is new to that file.
  - `held-exfiltration`, `held-remote`, `held-ip-lookup`: one level higher where a file names a service under the tag anew (`files/hosts.js`), so red, red and orange.
  - `held-obfuscated`: red where a file's fingerprint is new.
  - `large-code`, `now-unreadable`.
    `now-unreadable` is orange where each such file's source map was rebuilt with it (its last line names its map, and the `.map` beside it is new or changed), or in a major release; else it is red.
  - `binary-code`: a JavaScript or TypeScript file (a declaration file too) added or changed that isn't text (not UTF-8, or holding a NUL), where the old version's file wasn't one.
    No one can read it in review.
    Yet a UTF-16 file, marked by its byte order mark, runs as a browser's classic script or in Windows Script Host, and TypeScript reads it.
  - `new-hosts`, except for nine hosts where packages keep their code and docs (`npm/compare.js` `ALLOWED_HOSTS`: `github.com`, `lit.dev`, MDN, …).
    Each host is matched as written: `api.github.com` is still named, as is a repository `github.com` serves files or releases from (`github.com/owner/repo`).
- `files`: each file's stamps (`{ name, severity }`, as a list of files tags and orders them), and what was read of it:
  - how it reads (binary, minified, long lines, source maps, control and invisible characters, an obfuscator's fingerprint)
  - what its code runs beyond itself: eval and its kin, child_process, credentials, the whole environment, publishing, shell commands fetching or handing off code, and places code runs from again later.
    Credentials are a credential file's path (`.npmrc`, `.ssh`, `.aws`), a token's name where it is read (`NPM_TOKEN`, `GITHUB_TOKEN`), `gh auth token`, the cloud's instance metadata endpoint (`169.254.169.254`, `metadata.google.internal`), the GitHub Actions runner's process (`Runner.Worker`), another process's memory (`/proc/<pid>/mem`) and trufflehog.
    A shell script (`.sh`, `.bat`, `.ps1` …) is read whole for its shell commands, places and the credentials a command reaches for (all but files, tokens and the metadata endpoint).
  - the services it names that malicious packages send what they take to, fetch what they run from, or look the machine up with, under three tags:
    - Exfiltration: request catchers and out-of-band testing hosts, `critical`.
    - Remote: what could be fine, such as bot and webhook APIs, paste sites and file drops, tunnels, and Bun's install script, `high`.
    - IP lookup: `moderate`.
  - the hosts its code calls

  A file that node runs as JavaScript, though its name says otherwise, is read as a script too (`npm/files.js` `npmLoadedScripts`).
  Its code, hosts and size (`Large`, `large-code`) are read as any script's.
  Prose and source maps are no longer passed over for it, but a stylesheet is still read as one.
  Such files are:
  - Text that a script of the version names by a relative path, written out whole as a string anywhere in its text, whatever takes it (`require(('./x.txt'))`, `module.require`, a template's `${…}`, a comment or another string too, as code can be written to have its tokens read wrong).
    A path through the package's own name counts too (`'<name>/x.txt'`).
    `require` runs any file but JSON and a native addon (`require('./data.txt')`, `require('./.npmignore')`, the `.gitignore` npm installs as that), and `import` runs one with no extension (`import('./payload')`).
    A path it takes is read as a URL (`%2E`, `?query`).
    Each file is found as Windows and macOS find it, telling neither case nor Unicode's normalization apart (`Payload.txt` for `payload.txt`).
    A file among them that isn't text is told as code that isn't text (`binary-code`), because node runs it decoded as UTF-8.
  - A directory's package.json `main`, where code requires the directory.
    A `\` in it is a separator too, as on Windows.
  - The package's own `main`, and what the `exports` and `imports` of its package.json files name, read as URLs too.
- `dependencies`: those added and changed, each with its flags (from elsewhere than the registry, imported by nothing).
  Against `oldVersion`, it also lists each dependency the version holds, flagged against none (`held`).
  An added dependency carries:
  - its package's tier by downloads, its latest two weeks left out
  - its last whole month's downloads, by what its tier goes by (`month`)
  - whether npm counts none of its downloads (`uncounted`)
  - where it is new since the version compared with, when it was first published

  A version alone is flagged against none.

- `score` (`npm/score.js`): the version's risk as one number out of 100, so a reviewer can tell at a glance which versions to read first.
  Its findings stay what to read; the score only weighs them:
  - `malware` is 100, however old the version.
  - Otherwise each finding raises the score by its severity: `critical` 0.5, `high` 0.2, `moderate` 0.08, `low` 0.03, a `notice` none.
    The weights combine as independent chances do (`1 − Π(1 − weight)`), so each finding adds less the more there are, and none takes the score past 100.
    One red finding alone is 50, two red are 75, and a red one with two orange is 68.
    `too-new` counts for nothing, because the version's age is told below.
  - Then the version's exposure lowers the score, by up to 90%.
    Exposure is how long the version has been out, from two weeks (none before, as an attack on the most downloaded package is new) to two years on a log scale.
    It is multiplied by how widely its package is downloaded now, by its tier: fully in the top 200, 95% to the top 1,000, 85% to 5,000, 65% to 20,000, 35% to 100,000, 10% past that, and 25% where its downloads aren't known (a caller's own package, `popularity: false`).
    A version out for years among millions would have been found and pulled were it an attack.
    For example, progress@2.0.3, whose publisher changed from a known account to one new to it in 2018 (a red `publisher` finding), scores 7.
  - The result is `{ score, level, raised, lowered? }`:
    - `level` is named as the findings' severities are: `critical` from 75, `high` from 50, `moderate` from 25, else `low`.
    - `raised` lists the findings it counts, `{ id, severity }` each.
    - `lowered`, where exposure lowered it, is `{ days, tier, by }`: the days the version has been out, its package's tier (null past the last or where unknown), and the share taken off.

  The earlier evaluation scored each of its pairs as a reviewer would have seen it the hour it came out: no exposure, no deprecation made since, and its package's tier then.
  Each version was compared with the version before it.
  The score tells the dataset's compromised versions apart from popular packages' latest releases:

  | Score | Compromised (1,240 of 1,259; 19 too large to assess) | Popular (989 of 990) |
  | --- | --- | --- |
  | 75 or more, critical | 87.4% | 0% |
  | 50 or more | 98.8% | 0.8% |
  | 25 or more | 99.4% | 2.2% |

  A compromised version outscores a popular one 99.9% of the time.
  The 15 it leaves under 50 call for a look by one or two orange findings alone: xrpl's new hosts, eslint-config-prettier's install script, and a dependency from elsewhere than npm's registry that nothing imports.
  Today, the 350 popular releases out over two years score 34 at most, and all but one are low.

Severities, the most severe first: `critical` (red), `high` (orange), `moderate` (yellow), `low`, `notice`.

## GitHub Actions

`actions/` tells what calls for a look at a repository's GitHub Actions.
It covers the repository's workflows, the actions of its own they use, and every action and reusable workflow of another repository they name.
Each is read from its code and resolved on GitHub.
Only the managed server runs it, in a repository risk scan (`server-managed/repository-actions.ts`).
The results show on Manage → Repositories → Risk's Actions tab (`ui/managed/repository-risk-actions.js`).

```js
import { keptSource, resolveAction, scanWorkflow, usesOfKey } from './risk/index.js'

// A workflow's own findings, and the references it makes, each with its line; `error`
// (`workflow-unreadable`, its `detail`) for one GitHub can't run.
const { uses, findings } = scanWorkflow('workflow', text, {
  owner: 'org', // whose repository it is: an unpinned `uses:` of the same owner's, as of GitHub's own, is yellow, another's orange
  lockfiles: [{ path: 'web/package-lock.json', names: new Set(['eslint']), dev: new Set(['eslint']) }], // what npx runs of the project's own, by where its step runs, `dev` those an install omitting devDependencies leaves out
  actions: new Map([['.github/actions/setup', actionYml]]), // its own actions' metadata, for where they install its packages; else each anywhere
})

// A reference resolved on GitHub, its own code read in turn.
const resolved = await resolveAction(usesOfKey('actions/checkout@v4'), keptSource(source), { owner: 'org' })
```

`scanWorkflow('action', text)` reads an action's metadata (`action.yml`) the same way.
`source` is GitHub as the asker can read it (`index.d.ts` `ActionsSource`; the managed server's is `server-managed/github-actions.ts`).
`keptSource` keeps what `source` answers for as long as it is held, which is one scan.
On the managed server, what GitHub answers of a public repository is also kept for every scan, whoever's repositories name it (`server-managed/repository-actions.ts` `sharedSource`), because many repositories use the same few actions.
The repository, its tags and its branches are kept for an hour.
What GitHub answers of a commit (another commit in its history, a file at it) is kept for good.
A resolved reference to a public repository is kept by its key for an hour.
YAML is read as GitHub reads it, by @preventive/lockfile's `parseYaml` with `workflow`.
A tag (`!!js/function` and all others), a merge key and tab indentation are refused (`workflow-unreadable`), and what it reads is plain data alone.

Each finding is `{ id, severity, line, … }`, where `line` is the file's line, counted from 1.
A finding in a resolved reference's own code also has the `file` it is in.

- Where an action comes from (`resolve.js`):
  - `repo-missing`: a repository GitHub has none of, red, because anyone who takes its owner's name can publish one.
    It is yellow where only the same owner's workflows name it, because it may only be one the asker can't read.
  - `repo-moved`: renamed or transferred, orange, because GitHub redirects the old name until someone takes it.
  - `repo-fork` and `repo-archived`: low.
- A ref that is not a commit (`findings.js`, `resolve.js`):
  - `unpinned`: by a tag or a branch, orange; yellow for GitHub's own and the same owner's.
  - `short-sha`: orange, because GitHub also reads it as a branch or tag of that name.
  - `branch-ref`: orange.
  - `ambiguous-ref`: a tag and a branch of one name, orange.
  - `ref-missing`: yellow, because GitHub runs whichever is pushed first.
  - `not-version` (`latest`): yellow.
  - `tag-off-release`: a major or minor tag (`v4`) on a commit no release of its line is on, orange, as a tag moved by whoever took the repository would be.
  - `tag-off-branch`: a tag whose commit is on none of its branches, low.
  - `outdated`: an older major line than the latest release, low.
- A commit:
  - `imposter-commit`: in the history of none of the repository's branches and releases, red, because GitHub serves a fork's commit under the name of the repository it forked.
    Risk looks in its default branch, each major line's latest release and every other branch GitHub lists (100), each commit once.
    Where the repository has more, the finding is `unverified-commit`, orange.
  - `commit-missing`: orange.
  - `untagged-commit`: no release, yellow.
  - `comment-mismatch`: the version a comment beside it names (`# v4.1.1`) is not one of its tags nor in their line, orange.
  - A commit's key holds its comment (`owner/repo@sha # v4.1.1`).
- What a step runs past a pin (`scripts/`), in a workflow and in each action alike:
  - `fetched-package`: a package fetched as it resolves now, orange.
    It is yellow where a version or a variable names the package, and a notice for pip, setuptools and wheel.
    A Go module by its version, and a crate by its version built `--locked`, get none.
    npx, `npm exec`, bunx and `bun x` get none where a lockfile at or above the step's directory locks the package (by its name, or by the package giving the program, typescript for `tsc`) and an install ran before.
    That install ran there or above (`--prefix`, `-C`, `--dir` or `--cwd` naming where), and was not a global one.
    For a package only devDependencies need, it was not one leaving devDependencies out (`--omit=dev`, or `NODE_ENV` production set by the step's, job's or workflow's `env`, by `export` or by the command's own).
    An install in a directory an expression names counts for that same directory alone, where only lockfiles at the root count.
    An action that installs counts as an install too: one whose name says it installs (`bahmutov/npm-install`), cypress-io/github-action, pnpm/action-setup's `run_install`, or one of the repository's own whose steps install or use another of its own that does.
    In another repository's action, an install that ran before is enough.
  - `unlocked-install`: an install resolving anew (`npm install`, `pnpm install --no-frozen-lockfile`), yellow; low for Yarn's and Bun's.
  - `remote-script`: a script fetched and run (`curl … | sh`, `bash <(curl …)`, `iex (irm …)`, or saved and then run), orange.
  - `unpinned-image`: an image by a tag (`docker://`, `container:`, `services:`, `docker run`, a Dockerfile's `FROM`), yellow; orange with no tag or `latest`.
  - `clone`: low.
- What else runs code no one expected:
  - `script-injection`: an expression anyone can write (a title, a body, a branch's name, a commit's message, a fork's description) in a script, orange.
    It also covers such an expression handed to an input of another owner's reusable workflow, or to an input that an action or reusable workflow of the repository's own writes into a script.
    It is red where the workflow runs with its secrets for anyone (`pull_request_target`, `workflow_run`, `issue_comment`, …).
  - `pwn-request`: such a workflow checking out the pull request's code (its head's commit or branch, or the fork's repository), red.
  - `untrusted-artifact`: a workflow on `workflow_run` taking its artifacts, orange.
  - `secrets-inherited`: another owner's reusable workflow handed every secret, orange.
  - `hosts`: the services a script names, by `files/hosts.js`'s tags.
  - `deprecated-runtime`, `invalid-uses`: low.
  - `action-missing`: no action.yml where a reference names one, yellow.

A reference's own code is what it runs: a composite action's steps, a reusable workflow's jobs, or a Docker action's Dockerfile.
Each is read as a workflow is, and each reference it makes is resolved in turn, up to 4 deep and 1,000 per scan.
A reusable workflow's `./` and `$/` references resolve at its own commit.
For a JavaScript action, only its runtime is read.
A shell's command line (`bash -c '…'`, a Dockerfile's `RUN ["sh", "-c", "…"]`) and a Dockerfile's heredoc (`RUN <<EOF`) are read as the script's own.
This is a quick read, not a shell's parse.
A command built as the script runs (`$x install`, `eval "$cmd"`), or a package an action's JavaScript fetches, goes unseen.

## Inside

- `files/`: one file's readers.
  - `script.js`: JavaScript's and CSS's tokens.
  - `characters.js`: controls and invisible characters.
  - `readability.js`
  - `runs-code.js`
  - `hosts.js`
  - `stamps.js`: all of a file's stamps.
- `npm/`: a version's and a pair's findings.
  - `specs.js`, `dependencies.js`, `install-scripts.js`, `downloads.js`, `release.js`, `new-dependency.js`
  - `old-version.js`: the version compared with, where risk picks it.
  - `combined.js`: what a version holds, with what changed folded in.
  - `compare.js`: a pair's findings; `held.js`: a version's own.
  - `files.js`: each file read once per version.
  - `diff.js`: renames, as Compare pairs them, and a build's content-hashed files by their names.
  - `malware.js`: what tells of malware: npm's takedown and its advisories.
  - `score.js`: the risk score, from the findings and the version's exposure.
  - `manifest.js`, `tarball.js`, `registry.js`, `assess.js`
- `actions/`: a repository's GitHub Actions.
  - `uses.js`: what a `uses:` names, its pin and its key.
  - `workflow.js`: a workflow or an action's metadata, read; `findings.js`: its findings.
  - `scripts/`: a script's commands (`shell.js`), what each fetches (`commands.js`, `packages.js`), graded (`grade.js`), with what anyone can write of an expression.
  - `resolve.js`: a reference resolved on GitHub, its tags as versions and its Dockerfile read.

Each pure function takes a version as the viewer holds one (`{ kind: 'sourcemap', npm, json }`).
The exception is `held.js` `npmVersionFindings`, which takes what npm says of the version now: its deprecation, when it was published, and its package's downloads.
