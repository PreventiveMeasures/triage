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
import { npmVersionFileRisk, npmVersionHosts } from './files.js'
import { npmHostFinding } from './held.js'
import { HOST_TAGS, npmHostSeverity, npmHostsTagged } from '../files/hosts.js'
import { npmBecameUnreadable, npmLargeCode } from '../files/readability.js'
import { npmFoundAdded, npmRunsCodeFlags, npmRunsCodeWithout } from '../files/runs-code.js'
import { npmDependencySpecs } from './dependencies.js'
import { npmFilesDiff } from './diff.js'
import { npmInstallScriptsChange, npmProvenanceLost, npmPublisherChange } from './release.js'

// What the open version does to its files that calls for a look, as red
// findings: code that runs beyond itself (runs-code.js), new to a file it
// adds or changes, the kinds with their lines (`runs-code`); a service under
// one of the hosts' tags new to a file it adds or changes (hosts.js
// npmExfiltration), a finding a tag a level higher than its own
// (npmHostSeverity: `exfiltration` and `remote` red, `ip-lookup` orange); a
// code file of 256 KiB or more it adds (npmLargeCode, `large-code`); a file
// it changes that had no line over 200 characters and now has one over 2,000
// (npmBecameUnreadable, `now-unreadable`); and a file it adds or changes with
// an obfuscator's fingerprint where the one compared with had none
// (`obfuscated`). Then in orange what any of its files runs beyond itself that
// `runs-code` doesn't name, kept from the version compared with
// (`kept-runs-code`). A renamed file by its old path; one renamed alone,
// unchanged, holds what it held.
function npmFileFindings(base, other, files) {
  const added = new Set(files.onlyOther)
  const after = row => npmVersionFileRisk(other, row.path)
  const before = row => added.has(row) ? null : npmVersionFileRisk(base, row.renamedFrom ?? row.path)
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
    ...[...HOST_TAGS.keys()].map(tag => {
      const rows = exfiltration.map(row => ({ path: row.path, added: npmHostsTagged(row.added, tag) })).filter(row => row.added)
      return { id: npmHostFinding(tag), severity: rows.length > 0 ? npmHostSeverity(tag, rows[0].added, null) : HOST_TAGS.get(tag), files: rows }
    }),
    { id: 'large-code', severity: 'critical', files: files.onlyOther.filter(row => npmLargeCode(row.path, sizes.get(row.path))).map(row => ({ path: row.path, bytes: sizes.get(row.path) })) },
    { id: 'now-unreadable', severity: 'critical', files: changed.filter(row => npmBecameUnreadable(row.path, before(row)?.readability, after(row).readability))
      .map(row => ({ path: row.path, was: before(row).readability.longest, now: after(row).readability.longest })) },
    { id: 'obfuscated', severity: 'critical', files: touched.filter(row => after(row).readability.obfuscation && !before(row)?.readability.obfuscation)
      .map(row => ({ path: row.path, obfuscation: after(row).readability.obfuscation })) },
    { id: 'kept-runs-code', severity: 'high', files: kept },
  ].filter(finding => finding.files.length > 0)
}

// The hosts the open version's code names in its URLs that the one compared
// with's named in none of its, each `{ host, path, line, places }`: the file
// it is first named in and its line, and `places` every file that names it,
// `{ path, line }` each, the line it is first named on there. A file
// unchanged names what it named, so the files the open version adds or
// changes hold all it names anew.
function npmNewHosts(base, other, files) {
  const found = new Map(), known = npmVersionHosts(base)
  for (const { path } of [...files.onlyOther, ...files.changed]) {
    for (const [host, line] of npmVersionFileRisk(other, path).hosts ?? []) {
      if (known.has(host)) continue
      const place = { path, line }
      if (found.has(host)) found.get(host).places.push(place)
      else found.set(host, { host, ...place, places: [place] })
    }
  }
  return [...found.values()]
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
// `publisher`); provenance lost (`provenance-lost`); install scripts added or
// changed (`install-scripts`); its `dependencies` added and changed, as
// flagged (npmDependencyFindings); its files, by how they differ (diff.js
// npmFilesDiff, npmFileFindings); and the hosts its code names anew
// (npmNewHosts, `new-hosts`).
export function npmCompareFindings(base, other, dependencies) {
  const publisher = npmPublisherChange(base.npm.manifest, other.npm.manifest)
  const scripts = npmInstallScriptsChange(...[base, other].map(version => ({ manifest: version.npm.manifest, paths: version.json.sources })))
  const files = npmFilesDiff(base, other)
  const hosts = npmNewHosts(base, other, files)
  return [
    ...publisher ? [{ id: 'publisher', ...publisher }] : [],
    ...npmProvenanceLost(base.npm.manifest, other.npm.manifest) ? [{ id: 'provenance-lost', severity: 'critical' }] : [],
    ...scripts ? [{ id: 'install-scripts', severity: 'high', ...scripts }] : [],
    ...npmDependencyFindings(dependencies, base),
    ...npmFileFindings(base, other, files),
    ...hosts.length > 0 ? [{ id: 'new-hosts', severity: 'high', hosts }] : [],
  ]
}
