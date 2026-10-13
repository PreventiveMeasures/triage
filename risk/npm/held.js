// What calls for a look at a version on its own, as the npm Overview shows
// it: what npm says of it and when it was published (npmVersionFindings),
// and what it holds that calls for a look whatever came before it
// (npmHeldFindings), as Compare's findings (compare.js) say what changed.
import { bundleFilesAsMap } from '../../common/bundle-sources.js'
import { npmDownloadTier, npmTierLevel, npmTierLow } from './downloads.js'
import { npmInstallScripts } from './install-scripts.js'
import { npmTooNew } from './release.js'
import { npmVersionFileRisk } from './files.js'

// What npm says of a version and of its package, told fresh as it changes in
// time: deprecated, `deprecated` its message (`deprecated`, red); younger
// than `minimumReleaseAge` at `now`, published at `published` (release.js
// npmTooNew, `too-new`, orange); and its package past the top 20,000 by
// `downloads` (downloads.js, `popularity`, red where unpopular, else orange),
// `tier` its rank (Infinity past the last).
export function npmVersionFindings({ deprecated, published, minimumReleaseAge, now, downloads }) {
  const tier = downloads ? npmDownloadTier(downloads) : null
  return [
    ...deprecated ? [{ id: 'deprecated', severity: 'critical', message: deprecated }] : [],
    ...published && npmTooNew(published, { minimumReleaseAge, now }) ? [{ id: 'too-new', severity: 'high', published }] : [],
    ...tier !== null && npmTierLow(tier) ? [{ id: 'popularity', severity: npmTierLevel(tier) === 'is-unpopular' ? 'critical' : 'high', tier }] : [],
  ]
}

// What a version holds that calls for a look, whatever came before it, each in
// orange, as its files' tags are: the scripts npm runs installing it
// (install-scripts.js, `held-install-scripts`, `[script, command]` each); and
// its files, each with what it holds, that run code beyond themselves
// (`held-runs-code`), name an exfiltration host (`held-exfiltration`), or bear
// an obfuscator's fingerprint (`held-obfuscated`).
export function npmHeldFindings(version) {
  const scripts = npmInstallScripts(version.npm.manifest, version.json?.sources)
  const reads = [...bundleFilesAsMap(version).keys()].map(path => ({ path, read: npmVersionFileRisk(version, path) }))
  const holding = of => reads.map(({ path, read }) => ({ path, found: of(read) })).filter(row => row.found)
  return [
    ...scripts.length > 0 ? [{ id: 'held-install-scripts', severity: 'high', scripts }] : [],
    { id: 'held-runs-code', severity: 'high', files: holding(read => read.runsCode) },
    { id: 'held-exfiltration', severity: 'high', files: holding(read => read.exfiltration) },
    { id: 'held-obfuscated', severity: 'high', files: holding(read => read.readability.obfuscation) },
  ].filter(finding => !finding.files || finding.files.length > 0)
}
