// The managed server's risk, as the viewer's tests have it answer
// (GET /api/npm/risk): of the versions a test holds, each as the viewer
// holds one, what risk tells whatever the time (risk/npm/assess.js
// npmLastingRisk), against the one asked for or else the one risk picks of
// those held (risk/npm/old-version.js npmOldVersion), with the open
// version's own findings, by its package's downloads (npmAssessmentOf), as
// the server tells them, through JSON as its answer comes.
import { npmAssessmentOf, npmLastingRisk } from '../risk/npm/assess.js'
import { npmVersionFindings } from '../risk/npm/held.js'
import { npmKnownScope } from '../risk/npm/manifest.js'
import { DEFAULT_MINIMUM_RELEASE_AGE, npmAccountStanding } from '../risk/npm/release.js'
import { npmOldVersion } from '../risk/npm/old-version.js'
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

// Each account's standing on a package when a version of it was published
// (`at`), as the server tells it of npm's document (release.js
// npmAccountStanding), of the versions of it held, each published as it says
// or as `times` say.
// The versions of a package held, as npm's document lists them to risk
// (risk/npm/registry.js), each published as it says or as `times` say.
const releasesOf = (name, times) => [...held.values()].filter(({ npm }) => npm.name === name).map(({ npm }) => ({ version: npm.version,
  publisher: npm.manifest?.publisher ?? null, known: Boolean(npm.manifest?.knownAccounts), deprecated: Boolean(npm.manifest?.deprecated), removed: false,
  published: npm.published ?? times[npm.version] ?? null }))
const standingOf = (name, at, times) => npmAccountStanding(releasesOf(name, times), at)

// What the server answers of `name@version` against `otherVersion`, else the
// version risk picks of those held, none where it picks none, as it is asked with its package's `downloads`, when each version was
// published (`times`, where a version held says none), the open version's
// minimum release age (`minimumReleaseAge`, two weeks unless given), and the
// `malware` finding npm's takedown and advisories make of it, where they do.
export function riskAnswer(name, version, otherVersion = null, { downloads = null, times = {}, minimumReleaseAge = DEFAULT_MINIMUM_RELEASE_AGE, malware = null } = {}) {
  const other = versionOf(name, version), published = other.npm.published ?? times[version] ?? null
  const old = otherVersion ?? npmOldVersion(version, releasesOf(name, times), Date.now())
  const base = old === '(empty)' ? { npm: { name, version: '', manifest: {} }, json: { sources: [], sourcesContent: [] } } : old === null ? null : versionOf(name, old)
  const kept = base === null ? npmLastingRisk(other) : npmLastingRisk(other, base, standingOf(name, published, times))
  const own = npmVersionFindings({ deprecated: other.npm.manifest.deprecated, published, minimumReleaseAge, downloads,
    known: Boolean(other.npm.manifest.knownAccounts), scope: npmKnownScope(name) })
  return JSON.parse(JSON.stringify({ name, version, oldVersion: old, published, ...npmAssessmentOf(kept, malware ? [malware, ...own] : own) }))
}
