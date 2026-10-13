// The managed server's risk, as the viewer's tests have it answer
// (GET /api/npm/risk): of the versions a test holds, each as the viewer
// holds one, what risk tells whatever the time (risk/npm/assess.js
// npmLastingRisk) with the open version's own findings, by its package's
// downloads (npmAssessmentOf), as the server tells them, through JSON as its
// answer comes.
import { npmAssessmentOf, npmLastingRisk } from '../risk/npm/assess.js'
import { npmVersionFindings } from '../risk/npm/held.js'
import { DEFAULT_MINIMUM_RELEASE_AGE } from '../risk/npm/release.js'
import { npmRiskOf } from '../ui/view/file-risk.js'

const held = new Map()

// A version the server tells of (`{ npm, json? }`), with its risk as its
// details carry it (`risk`, npm-package.js npmPackageDetails), read by
// `npmRisk` (ui/view/npm-risk.js, imported once the test's mocks are).
export function holdVersion(version, npmRisk) {
  held.set(`${version.npm.name}@${version.npm.version}`, version)
  return Object.assign(version, { risk: () => npmRisk(version.npm) })
}

// A version the server tells of, held, its risk as its details carry it
// told at once, as the server answers it of the version alone, for a test
// that reads no more of it than its files' (file-risk.js).
export function toldVersion(version) {
  held.set(`${version.npm.name}@${version.npm.version}`, version)
  let told = null
  return Object.assign(version, { risk: () => told ??= npmRiskOf(riskAnswer(version.npm.name, version.npm.version)) })
}

// A held version as risk reads one, one never held with no files, and no
// manifest beyond what it names.
function versionOf(name, version) {
  const known = held.get(`${name}@${version}`) ?? { npm: { name, version } }
  return { kind: 'sourcemap', json: { version: 3, sources: [], sourcesContent: [] }, ...known, npm: { manifest: {}, ...known.npm } }
}

// What the server answers of `name@version` against `otherVersion` (null for
// none), as it is asked with its package's `downloads`, when each version was
// published (`times`, where a version held says none), the open version's
// minimum release age (`minimumReleaseAge`, two weeks unless given), and the
// `malware` finding npm's takedown and advisories make of it, where they do.
export function riskAnswer(name, version, otherVersion = null, { downloads = null, times = {}, minimumReleaseAge = DEFAULT_MINIMUM_RELEASE_AGE, malware = null } = {}) {
  const other = versionOf(name, version), published = other.npm.published ?? times[version] ?? null
  const kept = npmLastingRisk(other, otherVersion === null ? null : versionOf(name, otherVersion))
  const own = npmVersionFindings({ deprecated: other.npm.manifest.deprecated, published, minimumReleaseAge, downloads })
  return JSON.parse(JSON.stringify({ name, version, oldVersion: otherVersion, published, ...npmAssessmentOf(kept, malware ? [malware, ...own] : own) }))
}
