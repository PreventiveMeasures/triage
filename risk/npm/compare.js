// What calls for a look at a package version against the one before it, as
// findings: `{ id, severity, ... }` each (stamps.js SEVERITIES), what it found
// beside. Each version as the viewer holds one (`{ kind: 'sourcemap', npm,
// json, fileSizes? }`: npm's facts, `npm.manifest` as manifest.js reads a
// version's document and `npm.published` when it was published, its files as
// a source map lists them, `json.sources` and `json.sourcesContent`, a text
// or null each, and their sizes by path where known), and
// `files` how they differ, as Compare's diff has it (computeBundleDiff,
// diff.js): `onlyOther`, the files the open version adds, and `changed`, those
// it changes, each `{ path, basePath?, renamedFrom?, modified? }`, by its path
// in the open version, the one compared with's `basePath` where it differs.
import { bundleFileSizes, bundleFilesAsMap } from '../../common/bundle-sources.js'
import { npmBecameUnreadable, npmLargeCode } from '../files/readability.js'
import { npmFoundAdded, npmRunsCodeFlags, npmRunsCodeWithout } from '../files/runs-code.js'
import { npmFileRisk } from '../files/stamps.js'
import { npmDependencyChanges, npmDependencySpecs, npmFlagDependencyChanges } from './dependencies.js'
import { npmDownloadTier, npmTierLevel, npmTierLow } from './downloads.js'
import { npmInstallScriptsChange, npmProvenanceLost, npmPublisherChange, npmTooNew } from './release.js'

// What a version's files are kept by: its bundle where it is one, else its
// files' list, else itself.
const keyOf = version => version.bundle ?? version.json ?? version

// What risk reads of each file of a version (stamps.js npmFileRisk), once a
// version and path.
const reads = new WeakMap()
export function npmVersionFileRisk(version, path) {
  let files = reads.get(keyOf(version))
  if (!files) reads.set(keyOf(version), files = new Map())
  if (!files.has(path)) {
    const text = bundleFilesAsMap(version).get(path)
    files.set(path, npmFileRisk(path, typeof text === 'string' ? text : null, bundleFileSizes(version).get(path)))
  }
  return files.get(path)
}

// Every host a version's scripts name (hosts.js npmHosts), once a version.
const versionHosts = new WeakMap()
function hostsOf(version) {
  let hosts = versionHosts.get(keyOf(version))
  if (!hosts) {
    hosts = new Set()
    for (const path of bundleFilesAsMap(version).keys()) for (const host of npmVersionFileRisk(version, path).hosts?.keys() ?? []) hosts.add(host)
    versionHosts.set(keyOf(version), hosts)
  }
  return hosts
}

// What the open version does to its files that calls for a look, as red
// findings: code that runs beyond itself (runs-code.js), new to a file it
// adds or changes, the kinds with their lines (`runs-code`); a host malicious
// packages send what they take to, new to a file it adds or changes
// (hosts.js npmExfiltration, `exfiltration`); a code file of 256 KiB or more
// it adds (npmLargeCode, `large-code`); a file it changes that had no line
// over 200 characters and now has one over 2,000 (npmBecameUnreadable,
// `now-unreadable`); and a file it adds or changes with an obfuscator's
// fingerprint where the one compared with had none (`obfuscated`). Then in
// orange what any of its files runs beyond itself that `runs-code` doesn't
// name, kept from the version compared with (`kept-runs-code`). A renamed
// file by its old path; one renamed alone, unchanged, holds what it held.
export function npmFileFindings(base, other, files) {
  const added = new Set(files.onlyOther)
  const after = row => npmVersionFileRisk(other, row.path)
  // A file it adds was none before, whatever the one compared with holds at
  // its path, which can be another file where Compare lays the two out under
  // other roots (`package/a.js` read as `a.js`).
  const before = row => added.has(row) ? null : npmVersionFileRisk(base, row.basePath ?? row.path)
  const changed = files.changed.filter(row => row.renamedFrom == null || row.modified)
  const touched = [...files.onlyOther, ...changed]
  const sizes = bundleFileSizes(other)
  // The files that hold what they didn't before, each with that.
  const gained = key => touched.map(row => ({ path: row.path, added: npmFoundAdded(after(row)[key], before(row)?.[key] ?? null) })).filter(row => row.added)
  const exfiltration = gained('exfiltration'), runsCode = gained('runsCode')
  const flagged = new Set(runsCode.flatMap(row => npmRunsCodeFlags(row.added).map(({ name }) => name)))
  const kept = [...bundleFilesAsMap(other).keys()].map(path => ({ path, found: npmRunsCodeWithout(npmVersionFileRisk(other, path).runsCode, flagged) })).filter(row => row.found)
  return [
    { id: 'runs-code', severity: 'critical', files: runsCode },
    { id: 'exfiltration', severity: 'critical', files: exfiltration },
    { id: 'large-code', severity: 'critical', files: files.onlyOther.filter(row => npmLargeCode(row.path, sizes.get(row.path))).map(row => ({ path: row.path, bytes: sizes.get(row.path) })) },
    { id: 'now-unreadable', severity: 'critical', files: changed.filter(row => npmBecameUnreadable(row.path, before(row)?.readability, after(row).readability))
      .map(row => ({ path: row.path, was: before(row).readability.longest, now: after(row).readability.longest })) },
    { id: 'obfuscated', severity: 'critical', files: touched.filter(row => after(row).readability.obfuscation && !before(row)?.readability.obfuscation)
      .map(row => ({ path: row.path, obfuscation: after(row).readability.obfuscation })) },
    { id: 'kept-runs-code', severity: 'high', files: kept },
  ].filter(finding => finding.files.length > 0)
}

// The hosts the open version's code names in its URLs that the one compared
// with's named in none of its, each `{ host, path, line }`, the file it is
// first named in and its line: a file unchanged names what it named, so the
// files the open version adds or changes hold any it names anew.
export function npmNewHosts(base, other, files) {
  const found = new Map(), known = hostsOf(base)
  for (const { path } of [...files.onlyOther, ...files.changed]) {
    for (const [host, line] of npmVersionFileRisk(other, path).hosts ?? []) {
      if (!known.has(host) && !found.has(host)) found.set(host, { host, path, line })
    }
  }
  return [...found.values()]
}

// The dependencies the open version takes from elsewhere than npm's registry,
// where the one compared with didn't, or by another spec (`non-registry-deps`,
// each `{ name, was, now }`, its specs); and those it adds that nothing of it
// imports, which npm installs all the same, its install scripts and all, as a
// dependency added to run them would be (`unused-deps`, each `{ name, kind,
// range }`); as dependencies.js flags each.
export function npmDependencyFindings(base, other) {
  const { added, changed } = npmFlagDependencyChanges(npmDependencyChanges(base.npm.manifest, other.npm.manifest), base, other)
  const flagged = check => [...added, ...changed].filter(row => row.flags.some(flag => flag.check === check))
  const was = npmDependencySpecs(base.npm.manifest)
  const fetched = flagged('source').map(row => ({ name: row.name, was: was.get(row.name) ?? null, now: row.to ?? row.range }))
  const unimported = flagged('unimported').map(({ name, kind, range }) => ({ name, kind, range }))
  return [
    ...fetched.length > 0 ? [{ id: 'non-registry-deps', severity: 'high', dependencies: fetched }] : [],
    ...unimported.length > 0 ? [{ id: 'unused-deps', severity: 'high', dependencies: unimported }] : [],
  ]
}

// Everything that calls for a look at the open version (`other`) against the
// one compared with (`base`), in the order a reviewer reads them: an open
// version npm says is deprecated (`deprecated`); a publisher that changed
// (release.js npmPublisherChange, `publisher`); provenance lost
// (`provenance-lost`); install scripts added or changed (`install-scripts`);
// its dependencies (npmDependencyFindings); its files (npmFileFindings), with
// `files` how they differ, none without; the hosts its code names anew
// (npmNewHosts, `new-hosts`); an open version younger than
// `minimumReleaseAge` (release.js npmTooNew, `too-new`); and the package's
// tier by `downloads` (downloads.js) where it is past the top 20,000
// (`popularity`, red where unpopular, else orange). `published` is when the
// open version was published, where its `npm` doesn't say.
export function npmCompareFindings(base, other, files = null, { minimumReleaseAge, now = Date.now(), downloads = null, published = other.npm.published } = {}) {
  const { manifest } = other.npm
  const publisher = npmPublisherChange(base.npm.manifest, manifest)
  const scripts = npmInstallScriptsChange(...[base, other].map(version => ({ manifest: version.npm.manifest, paths: version.json?.sources })))
  const hosts = files && base.json && other.json ? npmNewHosts(base, other, files) : []
  const tier = downloads ? npmDownloadTier(downloads) : null
  return [
    ...manifest?.deprecated ? [{ id: 'deprecated', severity: 'critical', message: manifest.deprecated }] : [],
    ...publisher ? [{ id: 'publisher', ...publisher }] : [],
    ...npmProvenanceLost(base.npm.manifest, manifest) ? [{ id: 'provenance-lost', severity: 'critical' }] : [],
    ...scripts ? [{ id: 'install-scripts', severity: 'high', ...scripts }] : [],
    ...npmDependencyFindings(base, other),
    ...files && base.json && other.json ? npmFileFindings(base, other, files) : [],
    ...hosts.length > 0 ? [{ id: 'new-hosts', severity: 'high', hosts }] : [],
    ...published && npmTooNew(published, { minimumReleaseAge, now }) ? [{ id: 'too-new', severity: 'high', published }] : [],
    ...tier !== null && npmTierLow(tier) ? [{ id: 'popularity', severity: npmTierLevel(tier) === 'is-unpopular' ? 'critical' : 'high', tier }] : [],
  ]
}
