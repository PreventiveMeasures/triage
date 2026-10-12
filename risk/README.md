# risk

What calls for a look at an npm package version, for a reviewer: every heuristic the npm viewer flags a version or a file by, apart from any view of them. Plain JavaScript, no DOM, no UI.

Risk is to be told on the managed server alone (`GET /api/npm/risk`, server-managed/npm-risk.ts), never in the e2e and local modes. Until the viewer reads it from there, it still computes its tags and chips with these modules itself.

## Asking

```js
import { assessNpm } from './risk/index.js'

const assessment = await assessNpm('axios', '1.14.1', {
  oldVersion: '1.14.0', // compared with; without one, everything of the version is new
  minimumReleaseAge: 14 * 24 * 60 * 60_000, // the default, two weeks; 0 for none, as a caller's own scopes take
  cache, // as @preventive/upstream's CacheStore: read(type, key) and write(type, key, value)
})
```

`assessNpm` reads npm's registry and downloads API itself, and keeps what it reads in `cache`, each record under its own type, for the caller to route each type where it belongs:

| Type | Key | What | Changes |
| --- | --- | --- | --- |
| `npm/tarballs` | `<name>@<version>` | a version's tarball, its bytes (upstream's `getTarball`, checked against its integrity) | never |
| `risk/npm/versions` | `<name>@<version>` | what its document says: manifest, publish time, dist | never |
| `risk/npm/packages` | `<name>` | its deprecated versions, when its first version was published | asked again after an hour |
| `risk/npm/public` | `<name>` | when a public package (a dependency) was first published | asked again after an hour |
| `risk/npm/downloads` | `<name>@<from>:<to>` | its downloads a day | another range each day |
| `risk/npm/assessments` | `<reading>/<name>@<version>[..<old>]` | what of an assessment holds whatever the time | read anew when `RISK_VERSION` moves |

An assessment kept needs no tarball. What depends on the time (a deprecation, being too new, popularity, a new dependency's tier and age) is told fresh on each call.

The package assessed is asked for with the npm token the environment has for a scoped one, as upstream asks. Its dependencies' downloads and first publish are asked with none: a private dependency reads as unknown, not unpopular.

## What it tells

- `findings`, each `{ id, severity, … }`, in the order a reviewer reads them:
  - `deprecated`
  - `publisher`: red from a known account, orange between unknown ones, yellow to a known one
  - `provenance-lost`
  - `install-scripts`
  - `non-registry-deps`, `unused-deps`
  - `runs-code`, `exfiltration`, `large-code`, `now-unreadable`, `obfuscated`, `kept-runs-code`
  - `new-hosts`
  - `too-new`
  - `popularity`
- `files`: each file's stamps (`{ name, severity }`, as a list of files tags and orders it), and what was read of it:
  - how it reads (binary, minified, long lines, source maps, control and invisible characters, an obfuscator's fingerprint)
  - what its code runs beyond itself (eval and its kin, child_process, credentials, the whole environment, publishing)
  - the exfiltration hosts it names
  - the hosts its code calls
- `dependencies`: those added and changed, each with its flags (from elsewhere than the registry, imported by nothing), an added one with its package's tier by downloads (its latest two weeks left out) and, where it is new since the version compared with, when it was first published.

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
  - `compare.js`: the findings.
  - `diff.js`: renames, as Compare pairs them.
  - `manifest.js`, `tarball.js`, `registry.js`, `assess.js`

Each pure function takes a version as the viewer holds one (`{ kind: 'sourcemap', npm, json }`).
