// What calls for a look at a package version against the one before it, as
// findings: `{ id, severity, ... }` each (stamps.js SEVERITIES), what it found
// beside. Each version as risk holds one (`{ kind: 'sourcemap', npm, json,
// fileSizes? }`: npm's facts, `npm.manifest` as manifest.js reads a version's
// document, its files as a source map lists them, `json.sources` and
// `json.sourcesContent`, a text or null each, and their sizes by path where
// known), and `files` how they differ (diff.js npmFilesDiff): `onlyOther`, the
// files the open version adds, and `changed`, those it changes, each `{ path,
// renamedFrom?, modified? }`, by its path in the open version.
import { bundleFileSizes, bundleFilesAsMap } from '../../common/bundle-sources.js'
import { npmLoadedScripts, npmVersionFileRisk, npmVersionHosts } from './files.js'
import { npmHostFinding } from './held.js'
import { HOST_TAGS, npmHostSeverity, npmHostsTagged } from '../files/hosts.js'
import { npmBecameUnreadable, npmBinaryCode, npmLargeCode, npmUnreadable } from '../files/readability.js'
import { SEVERITIES } from '../files/stamps.js'
import { CREDENTIAL_TAGS, npmFoundAdded, npmRunsCodeFlags, npmRunsCodeTagged, npmRunsCodeWithout } from '../files/runs-code.js'
import { npmDependencySpecs } from './dependencies.js'
import { npmFilesDiff } from './diff.js'
import { npmInstallScripts } from './install-scripts.js'
import { npmInstallScriptsChange, npmProvenanceLost, npmPublisherChange } from './release.js'

// The files the open version (`other`) runs as scripts that the one compared
// with (`base`) held alike but didn't run (npm/files.js npmLoadedScripts),
// as its code now loads them, each a row as npmFilesDiff's `changed` holds
// one: what node runs of them is new, as a changed file's is.
function npmWokenFiles(base, other, files) {
  const listed = new Set([...files.onlyOther, ...files.changed].map(row => row.path)), loaded = npmLoadedScripts(other), loadedBefore = npmLoadedScripts(base)
  return [...files.changed.filter(row => row.renamedFrom != null && !row.modified && loaded.has(row.path) && !loadedBefore.has(row.renamedFrom)),
    ...[...loaded].filter(path => !listed.has(path) && !loadedBefore.has(path)).map(path => ({ path }))]
}

// What the open version does to its files that calls for a look, as red
// findings: code that runs beyond itself (runs-code.js), new to a file it
// adds or changes, the kinds with their lines (`runs-code`), those reaching
// for credentials apart (CREDENTIAL_TAGS, `credentials`); a service under
// one of the hosts' tags new to a file it adds or changes (hosts.js
// npmExfiltration), a finding a tag a level higher than its own
// (npmHostSeverity: `exfiltration` and `remote` red, `ip-lookup` orange); a
// code file of 256 KiB or more it adds, one node runs as a script whatever
// its name too (npmLargeCode, `large-code`); a file
// it changes that had no line over 200 characters and now has one over 2,000
// (npmBecameUnreadable, `now-unreadable`); a file it adds or changes with
// an obfuscator's fingerprint where the one compared with had none
// (`obfuscated`); and a code file it adds or changes that isn't text, where
// the one compared with's was text, or no code, or none (npmBinaryCode,
// `binary-code`). Then in orange what any of its files runs beyond itself that
// `runs-code` doesn't name, kept from the version compared with
// (`kept-runs-code`, `kept-credentials`). A renamed file by its old path; one renamed alone,
// unchanged, holds what it held. A file become unreadable calls for less
// where its source map was rebuilt with it (`rebuilt`, rebuiltWithMap), as a
// build minifies a file and writes its map together, and in a `major`
// release (npmMajorRelease): `now-unreadable` orange where every such file is
// either, else red. A file it held alike that node now runs as a script
// (npmWokenFiles) counts as one it changes, unreadable now where it wasn't
// as no script, its lines alike.
function npmFileFindings(base, other, files, major) {
  const added = new Set(files.onlyOther)
  const after = row => npmVersionFileRisk(other, row.path)
  const before = row => added.has(row) ? null : npmVersionFileRisk(base, row.renamedFrom ?? row.path)
  const changed = files.changed.filter(row => row.renamedFrom == null || row.modified)
  const woken = npmWokenFiles(base, other, files)
  const touched = [...files.onlyOther, ...changed, ...woken]
  const sizes = bundleFileSizes(other)
  // The files that hold what they didn't before, each with that.
  const gained = key => touched.map(row => ({ path: row.path, added: npmFoundAdded(after(row)[key], before(row)?.[key] ?? null) })).filter(row => row.added)
  const exfiltration = gained('exfiltration'), runsCode = gained('runsCode')
  const flagged = new Set(runsCode.flatMap(row => npmRunsCodeFlags(row.added).map(({ name }) => name)))
  const kept = [...bundleFilesAsMap(other).keys()].map(path => ({ path, found: npmRunsCodeWithout(npmVersionFileRisk(other, path).runsCode, flagged) })).filter(row => row.found)
  // Code that runs beyond itself, or of the kinds reaching for credentials.
  const ofKinds = (rows, key, of) => rows.map(row => ({ ...row, [key]: of(row[key], CREDENTIAL_TAGS) })).filter(row => row[key])
  return [
    { id: 'runs-code', severity: 'critical', files: ofKinds(runsCode, 'added', npmRunsCodeWithout) },
    { id: 'credentials', severity: 'critical', files: ofKinds(runsCode, 'added', npmRunsCodeTagged) },
    ...[...HOST_TAGS.keys()].map(tag => {
      const rows = exfiltration.map(row => ({ path: row.path, added: npmHostsTagged(row.added, tag) })).filter(row => row.added)
      return { id: npmHostFinding(tag), severity: rows.length > 0 ? npmHostSeverity(tag, rows[0].added, null) : HOST_TAGS.get(tag), files: rows }
    }),
    { id: 'large-code', severity: 'critical', files: [...files.onlyOther, ...woken].filter(row => npmLargeCode(row.path, sizes.get(row.path), npmLoadedScripts(other).has(row.path)))
      .map(row => ({ path: row.path, bytes: sizes.get(row.path) })) },
    { id: 'now-unreadable', ...unreadableFinding(major, [...changed.filter(row => npmBecameUnreadable(row.path, before(row)?.readability, after(row).readability, npmLoadedScripts(other).has(row.path))),
      ...woken.filter(row => npmUnreadable(row.path, after(row).readability, true) && !npmUnreadable(row.renamedFrom ?? row.path, before(row).readability))]
      .map(row => ({ path: row.path, was: before(row).readability.longest, now: after(row).readability.longest,
        ...rebuiltWithMap(base, other, row.path, row.renamedFrom ?? row.path) ? { rebuilt: true } : {} }))) },
    { id: 'obfuscated', severity: 'critical', files: touched.filter(row => after(row).readability.obfuscation && !before(row)?.readability.obfuscation)
      .map(row => ({ path: row.path, obfuscation: after(row).readability.obfuscation })) },
    { id: 'binary-code', severity: 'critical', files: touched.filter(row => npmBinaryCode(row.path, after(row).readability, npmLoadedScripts(other).has(row.path))
      && !npmBinaryCode(row.renamedFrom ?? row.path, before(row)?.readability, npmLoadedScripts(base).has(row.renamedFrom ?? row.path)))
      .map(row => ({ path: row.path, bytes: sizes.get(row.path) })) },
    { id: 'kept-runs-code', severity: 'high', files: ofKinds(kept, 'found', npmRunsCodeWithout) },
    { id: 'kept-credentials', severity: 'high', files: ofKinds(kept, 'found', npmRunsCodeTagged) },
  ].filter(finding => finding.files.length > 0)
}

// Hosts whose naming anew calls for no look: where packages keep their code
// and docs, as their links and error messages name them, the most a version
// names anew of popular packages a year apart (lit.dev, Lit's), and none
// whose content anyone may publish (a wiki's raw pages) but github.com's
// pages, as hosts.js githubNamed names them: a repository's own URL, its
// files and releases are named by it. Each as it is written, not a host
// under it, so one an attack sends to or fetches from there
// (`api.github.com`, `raw.githubusercontent.com`) is still named; and no link
// shortener (`git.io`, `git.new`), which can lead anywhere.
const ALLOWED_HOSTS = new Set(['github.com', 'lit.dev', 'developer.mozilla.org', 'json-schema.org', 'nodejs.org', 'babeljs.io', 'tseslint.com',
  'devblogs.microsoft.com', 'semver.org'])

// A severity one level lower (stamps.js SEVERITIES).
const lower = severity => SEVERITIES[Math.min(SEVERITIES.indexOf(severity) + 1, SEVERITIES.length - 1)]

// Whether the open version (`now`) is a major release past the one compared
// with (`was`): its major number higher, or its minor for 0.x. A rewrite
// changes how a package's files read and who publishes it, and npm's `^`
// ranges don't take a major release by themselves, as a hijacked release
// wants them to.
function npmMajorRelease(was, now) {
  const [a, b] = [was, now].map(version => /^v?(\d+)\.(\d+)\./u.exec(version ?? '')?.slice(1).map(Number))
  return Boolean(a && b) && (b[0] > a[0] || (a[0] === 0 && b[0] === 0 && b[1] > a[1]))
}

// Whether the open version's file at `path` (`basePath` in the one compared
// with) had its source map rebuilt with it: its last line, a
// `sourceMappingURL` comment and no more, names a map file of the package by
// a plain path from the file's own (MAP_NAME), a source map
// (its `mappings`, or each of an indexed map's `sections`, told), new or
// changed from the one at its path, or beside the file's own before it was
// renamed, as a build writes them together. An attack editing a built file
// leaves its map as it was.
const SOURCE_MAP_FILE = /^\s*(?:\/\/[#@] sourceMappingURL=(\S+)|\/\*[#@] sourceMappingURL=(\S+?)\s*\*\/)\s*$/u
// A map name a build writes (`a.js.map`, `../maps/a.map`): segments of
// letters, digits and `._~@+-`, as a browser reads them alike. One at a URL,
// from a site's root, or with an escape or a backslash names none.
const MAP_NAME = /^(?:[\w.~@+-]+\/)*[\w.~@+-]+\.map$/u
function besideFile(file, name) {
  const parts = file.split('/').slice(0, -1)
  for (const part of name.split('/')) {
    if (part === '..' && parts.length === 0) return null
    if (part === '..') parts.pop()
    else if (part !== '.') parts.push(part)
  }
  return parts.join('/')
}
function rebuiltWithMap(base, other, path, basePath) {
  const text = bundleFilesAsMap(other).get(path)
  const directive = typeof text === 'string' ? SOURCE_MAP_FILE.exec(text.trimEnd().split('\n').at(-1)) : null
  const name = directive?.[1] ?? directive?.[2]
  if (!name || !MAP_NAME.test(name)) return false
  const [map, was] = [bundleFilesAsMap(other).get(besideFile(path, name)), bundleFilesAsMap(base)]
  return isSourceMap(map) && map !== was.get(besideFile(path, name)) && map !== was.get(besideFile(basePath, name))
}
const isSourceMap = text => {
  try {
    const json = JSON.parse(text)
    return typeof json?.mappings === 'string'
      || (Array.isArray(json?.sections) && json.sections.length > 0 && json.sections.every(section => typeof section?.map?.mappings === 'string'))
  } catch { return false }
}

// The files become unreadable as a finding says them: red, but orange in a
// major release, or where each had its source map rebuilt with it.
const unreadableFinding = (major, files) => ({ severity: major || files.every(row => row.rebuilt) ? 'high' : 'critical', ...major ? { major } : {}, files })

// The hosts the open version's code names in its URLs that the one compared
// with's named in none of its, ALLOWED_HOSTS aside, each `{ host, path, line,
// places }`: the file it is first named in and its line, and `places` every
// file that names it, `{ path, line }` each, the line it is first named on
// there. A file unchanged names what it named, so the files the open version
// adds or changes hold all it names anew.
function npmNewHosts(base, other, files) {
  const found = new Map(), known = npmVersionHosts(base)
  for (const path of new Set([...files.onlyOther, ...files.changed, ...npmWokenFiles(base, other, files)].map(row => row.path))) {
    for (const [host, line] of npmVersionFileRisk(other, path).hosts ?? []) {
      if (known.has(host) || ALLOWED_HOSTS.has(host)) continue
      const place = { path, line }
      if (found.has(host)) found.get(host).places.push(place)
      else found.set(host, { host, ...place, places: [place] })
    }
  }
  return [...found.values()]
}

// Whether the files of the version compared with could change what
// npmCompareFindings finds of the open version (`other`), told before they
// are read, by the open version's files and the manifest npm's document of
// the one compared with gives (`manifest`): what its files call for
// (npmFileFindings, npmNewHosts) is only ever what the open version's own
// files hold that the one compared with's didn't, so where none of them runs
// code beyond itself, names a service under one of the hosts' tags or a host
// past ALLOWED_HOSTS, bears an obfuscator's fingerprint, has a line no one
// writes (npmUnreadable), is large code or is code that isn't text
// (npmBinaryCode), nothing is found of them whatever
// the one compared with holds. Nor do the one compared with's install scripts
// differ by a binding.gyp among its files, but where its manifest names
// neither `preinstall` nor `install`, and the open version has some.
export function npmBaseFilesTell(other, manifest) {
  if (npmInstallScripts(other.npm.manifest, other.json.sources).length > 0
    && npmInstallScripts(manifest).length !== npmInstallScripts(manifest, ['binding.gyp']).length) return true
  const sizes = bundleFileSizes(other)
  return [...bundleFilesAsMap(other).keys()].some(path => {
    const { runsCode, exfiltration, readability, hosts } = npmVersionFileRisk(other, path)
    return Boolean(runsCode || exfiltration || readability.obfuscation) || npmUnreadable(path, readability, npmLoadedScripts(other).has(path)) || npmLargeCode(path, sizes.get(path), npmLoadedScripts(other).has(path))
      || npmBinaryCode(path, readability, npmLoadedScripts(other).has(path))
      || [...hosts?.keys() ?? []].some(host => !ALLOWED_HOSTS.has(host))
  })
}

// Of the dependencies the open version adds and changes against `base`, or
// alone, none given, each with its flags (dependencies.js
// npmFlagDependencyChanges): those it takes from elsewhere than npm's
// registry, where the one compared with didn't, or by another spec
// (`non-registry-deps`, each `{ name, was, now }`, its specs); and those it
// adds that nothing of it imports, which npm installs all the same, its
// install scripts and all, as a dependency added to run them would be
// (`unused-deps`, each `{ name, kind, range }`).
export function npmDependencyFindings({ added, changed }, base) {
  const flagged = check => [...added, ...changed].filter(row => row.flags.some(flag => flag.check === check))
  const was = base ? npmDependencySpecs(base.npm.manifest) : null
  const fetched = flagged('source').map(row => ({ name: row.name, was: was?.get(row.name) ?? null, now: row.to ?? row.range }))
  const unimported = flagged('unimported').map(({ name, kind, range }) => ({ name, kind, range }))
  return [
    ...fetched.length > 0 ? [{ id: 'non-registry-deps', severity: 'high', dependencies: fetched }] : [],
    ...unimported.length > 0 ? [{ id: 'unused-deps', severity: 'high', dependencies: unimported }] : [],
  ]
}

// Everything that calls for a look at the open version (`other`) against the
// one compared with (`base`), whatever the time, in the order a reviewer reads
// them: a publisher that changed (release.js npmPublisherChange,
// `publisher`, each account's standing on the package told where `standing`
// is given), a level lower in a major release (npmMajorRelease, `major`),
// as a package changing hands with a rewrite does; provenance lost (`provenance-lost`); install scripts added or
// changed (`install-scripts`); its `dependencies` added and changed, as
// flagged (npmDependencyFindings); its files, by how they differ (diff.js
// npmFilesDiff, npmFileFindings); and the hosts its code names anew
// (npmNewHosts, `new-hosts`). A `base` without its files (`json` null),
// where npmBaseFilesTell says they would change nothing, is found nothing of
// by them.
export function npmCompareFindings(base, other, dependencies, standing = null) {
  const major = npmMajorRelease(base.npm.version, other.npm.version)
  const publisher = npmPublisherChange(base.npm.manifest, other.npm.manifest, standing)
  const scripts = npmInstallScriptsChange(...[base, other].map(version => ({ manifest: version.npm.manifest, paths: version.json?.sources })))
  const files = base.json ? npmFilesDiff(base, other) : null
  const hosts = files ? npmNewHosts(base, other, files) : []
  return [
    ...publisher ? [{ id: 'publisher', ...publisher, ...major ? { severity: lower(publisher.severity), major } : {} }] : [],
    ...npmProvenanceLost(base.npm.manifest, other.npm.manifest) ? [{ id: 'provenance-lost', severity: 'critical' }] : [],
    ...scripts ? [{ id: 'install-scripts', severity: 'high', ...scripts }] : [],
    ...npmDependencyFindings(dependencies, base),
    ...files ? npmFileFindings(base, other, files, major) : [],
    ...hosts.length > 0 ? [{ id: 'new-hosts', severity: 'high', hosts }] : [],
  ]
}
