// What calls for a look at a version on its own, as the npm Overview shows
// it: what npm says of it and when it was published (npmVersionFindings),
// and what it holds that calls for a look whatever came before it
// (npmHeldFindings), as Compare's findings (compare.js) say what changed.
import { bundleFilesAsMap } from '../../common/bundle-sources.js'
import { npmDownloadTier, npmTierLevel, npmTierLow } from './downloads.js'
import { npmInstallScripts } from './install-scripts.js'
import { npmTooNew } from './release.js'
import { HOST_TAGS, npmHostsTagged } from '../files/hosts.js'
import { CREDENTIAL_TAGS, npmRunsCodeTagged, npmRunsCodeWithout } from '../files/runs-code.js'
import { npmVersionFileRisk } from './files.js'

// What npm says of a version and of its package, told fresh as it changes in
// time: deprecated, `deprecated` its message (`deprecated`, red); younger
// than `minimumReleaseAge` at `now`, published at `published` (release.js
// npmTooNew, `too-new`, orange); and its package past the top 20,000 by
// `downloads` (downloads.js, `popularity`, red where unpopular, else orange),
// `tier` its rank (Infinity past the last); yellow at most, whatever its
// tier, where an account known to publish one of npm's most downloaded
// packages published the version (`known`, manifest.js `knownAccounts`), as
// few download a new package such an account starts; or else, as many are
// published by a CI that names no account, where the version was published
// with provenance (`provenance`, manifest.js), built where it says, as a
// token alone, stolen, publishes none, and the package is in a known scope
// (`scope`, manifest.js npmKnownScope: one of those packages', or one of
// those accounts' own, its `account` named), whose owner alone publishes in
// it.
export function npmVersionFindings({ deprecated, published, minimumReleaseAge, now, downloads, known = false, scope = null, provenance = false }) {
  const tier = downloads ? npmDownloadTier(downloads) : null
  const scoped = provenance ? scope : null
  const severity = known || scoped ? 'moderate' : npmTierLevel(tier) === 'is-unpopular' ? 'critical' : 'high'
  return [
    ...deprecated ? [{ id: 'deprecated', severity: 'critical', message: deprecated }] : [],
    ...published && npmTooNew(published, { minimumReleaseAge, now }) ? [{ id: 'too-new', severity: 'high', published }] : [],
    ...tier !== null && npmTierLow(tier) ? [{ id: 'popularity', severity, tier, ...known ? { known } : scoped ? { known: true, ...scoped } : {} }] : [],
  ]
}

// What a version holds that calls for a look, whatever came before it, in
// orange, as its files' tags are: the scripts npm runs installing it
// (install-scripts.js, `held-install-scripts`, `[script, command]` each); and
// its files, each with what it holds, that run code beyond themselves
// (`held-runs-code`), reach for credentials (runs-code.js CREDENTIAL_TAGS,
// `held-credentials`), name a service under one of the hosts' tags, at the
// tag's severity (hosts.js HOST_TAGS: `held-exfiltration` red, `held-remote`
// orange, `held-ip-lookup` yellow), or bear an obfuscator's fingerprint
// (`held-obfuscated`).
export function npmHeldFindings(version) {
  const scripts = npmInstallScripts(version.npm.manifest, version.json?.sources)
  const reads = [...bundleFilesAsMap(version).keys()].map(path => ({ path, read: npmVersionFileRisk(version, path) }))
  const holding = of => reads.map(({ path, read }) => ({ path, found: of(read) })).filter(row => row.found)
  return [
    ...scripts.length > 0 ? [{ id: 'held-install-scripts', severity: 'high', scripts }] : [],
    { id: 'held-runs-code', severity: 'high', files: holding(read => npmRunsCodeWithout(read.runsCode, CREDENTIAL_TAGS)) },
    { id: 'held-credentials', severity: 'high', files: holding(read => npmRunsCodeTagged(read.runsCode, CREDENTIAL_TAGS)) },
    ...[...HOST_TAGS].map(([tag, severity]) => ({ id: `held-${npmHostFinding(tag)}`, severity, files: holding(read => npmHostsTagged(read.exfiltration, tag)) })),
    { id: 'held-obfuscated', severity: 'high', files: holding(read => read.readability.obfuscation) },
  ].filter(finding => !finding.files || finding.files.length > 0)
}

// A hosts' tag's finding, as its id names it: `exfiltration`, `remote`,
// `ip-lookup`.
export const npmHostFinding = tag => tag.toLowerCase().replaceAll(' ', '-')
