// A package version's risk, as the managed server asks it: what calls for a
// look at it, against the version before it where one is given, each file's
// stamps, and its dependencies', from npm's registry, kept in the caller's
// cache (registry.js) as it goes.
import { npmCompareFindings, npmDependencyFindings } from './compare.js'
import { npmHeldFindings, npmVersionFindings } from './held.js'
import { npmVersionFileRisk } from './files.js'
import { npmDependencyChanges, npmFlagDependencyChanges } from './dependencies.js'
import { npmTierLevel } from './downloads.js'
import { NpmRiskError, npmDownloads, npmPackageFacts, npmPublicFacts, npmVersionFiles } from './registry.js'
import { DEFAULT_MINIMUM_RELEASE_AGE } from './release.js'
import { npmAddedDependency } from './new-dependency.js'
import { npmFilesDiff } from './diff.js'

// Which reading of a version an assessment kept (`risk/npm/assessments`) is:
// one more whenever a heuristic changes what it finds, so one kept by an
// older reading is read anew.
export const RISK_VERSION = 1

// How long an assessment kept may be as JSON, and what risk reads of either
// version's files: a package past it, whose files name thousands of hosts or
// do what they run on thousands of lines each, is refused as too large as its
// files are read, before more of them is held (filesRisk), and the assessment
// once told, rather than kept and answered. A package's files tell a few
// hundred characters each, a few MiB for the most files npm's viewer reads.
const MAX_ASSESSMENT_LENGTH = 16 * 1024 * 1024
const tooLarge = what => new NpmRiskError('package-too-large', `what risk tells of ${what} is past ${MAX_ASSESSMENT_LENGTH} characters`)

// A value as JSON holds it: a Map as an object, its keys as strings.
const plain = value => value instanceof Map ? Object.fromEntries([...value].map(([key, item]) => [key, plain(item)]))
  : Array.isArray(value) ? value.map(plain)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, plain(item)])) : value

// A tier among npm's packages as an assessment says it: `{ tier, level }`, the
// rank a package is among (null past the last, unpopular) and its tint
// (downloads.js npmTierLevel).
const tierOf = tier => ({ tier: Number.isFinite(tier) ? tier : null, level: npmTierLevel(tier) })

// Each of a version's files' stamps and what risk read of it (stamps.js
// npmFileRisk), by path, as JSON holds them: read a file at a time and given
// up on, as too large, once they are past MAX_ASSESSMENT_LENGTH as JSON
// altogether, so that no more of them is held than that.
function filesRisk(version, what) {
  let length = 0
  return Object.fromEntries(version.json.sources.map(path => {
    const { readability, runsCode, exfiltration, hosts, stamps } = npmVersionFileRisk(version, path)
    const risk = plain({ stamps, readability, runsCode, exfiltration, hosts })
    length += path.length + JSON.stringify(risk).length
    if (length > MAX_ASSESSMENT_LENGTH) throw tooLarge(what)
    return [path, risk]
  }))
}

// What of an assessment holds whatever the time, kept once a reading and pair:
// what its files, dependencies, install scripts, publisher and provenance call
// for (compare.js npmCompareFindings), or with no version compared with, what
// it holds (held.js npmHeldFindings) and its dependencies against none; each
// file's stamps and what risk read of it (stamps.js npmFileRisk); and its
// dependencies added and changed, each with its flags (dependencies.js).
async function lasting(name, version, oldVersion, facts, context) {
  const key = `${RISK_VERSION}/${name}@${version}${oldVersion === null ? '' : `..${oldVersion}`}`
  const hit = context.cache ? await context.cache.read('risk/npm/assessments', key) : null
  if (hit) return hit
  const [other, base] = await Promise.all([npmVersionFiles(name, version, facts.versions.get(version), context),
    oldVersion === null ? { kind: 'sourcemap', npm: { name, version: null, manifest: {} }, json: { version: 3, sources: [], sourcesContent: [] } }
      : npmVersionFiles(name, oldVersion, facts.versions.get(oldVersion), context)])
  // Each version's files read within bounds before the findings read them all.
  const files = filesRisk(other, `${name}@${version}`)
  if (oldVersion !== null) filesRisk(base, `${name}@${oldVersion}`)
  const findings = oldVersion === null ? [...npmHeldFindings(other), ...npmDependencyFindings(base, other)]
    : npmCompareFindings(base, other, npmFilesDiff(base, other), { minimumReleaseAge: 0, published: null })
  const { added, changed } = npmFlagDependencyChanges(npmDependencyChanges(base.npm.manifest, other.npm.manifest), base, other)
  const kept = { findings: plain(findings), files, dependencies: plain({ added, changed }) }
  if (JSON.stringify(kept).length > MAX_ASSESSMENT_LENGTH) throw tooLarge(`${name}@${version}`)
  if (context.cache) await context.cache.write('risk/npm/assessments', key, kept)
  return kept
}

// How many dependencies added are told of at most, however many a version
// adds, as each costs npm a request or two: the rest are left as they are,
// their packages unknown.
const MAX_TOLD_DEPENDENCIES = 100

// Each dependency `added` that npm installs from its registry, up to
// MAX_TOLD_DEPENDENCIES of them, with what risk tells of its package
// (new-dependency.js npmAddedDependency): its tier, and `created` and `gap`
// where it is new since the version compared with (`published`, when that
// and the open version were); four asked at a time, none more once one
// fails.
async function addedDependencies(added, published, context) {
  const told = [...added]
  const asked = told.flatMap((row, at) => row.opens ? [at] : []).slice(0, MAX_TOLD_DEPENDENCIES)
  let next = 0
  const tell = async row => {
    const downloads = await npmDownloads(row.opens, context)
    let facts = npmAddedDependency({ downloads, published }, context.now)
    if (facts.wanted) {
      const listed = await npmPublicFacts(row.opens, context)
      facts = npmAddedDependency({ downloads, listed: listed && { ...listed, private: false }, published }, context.now)
    }
    return { ...row, ...facts.tier === null ? {} : tierOf(facts.tier), ...facts.created ? { created: facts.created, gap: facts.gap } : {} }
  }
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (next < asked.length) {
      const at = asked[next++]
      try { told[at] = await tell(told[at]) } catch (error) { next = asked.length; throw error }
    }
  }))
  return told
}

// What calls for a look at `version` of package `name`, as JSON holds it:
// against `oldVersion` where given (compare.js npmCompareFindings's order),
// else what it holds (held.js npmHeldFindings), a deprecation first, and last
// one younger than `minimumReleaseAge` (two weeks unless given; 0 for none, as
// a caller's own scopes take), and the package's tier past the top 20,000
// (`popularity`; held.js npmVersionFindings); `files`, each file's stamps and what risk read of it; and
// `dependencies`, those added and changed against it, each with its flags,
// an added one with its package's tier and age where `downloads` (true unless
// given false) has them asked. `cache` keeps what is read (registry.js),
// `packument` asks for a package's whole document and `tarball` for a
// version's tarball in risk's stead (registry.js), `now` is when it is asked, `signal` gives up on what is
// still asked of npm. Throws an NpmRiskError (registry.js), its `code` saying
// why, where npm has no such package or version, answers past risk's bounds,
// or can't be asked.
export async function assessNpm(name, version, { oldVersion = null, minimumReleaseAge = DEFAULT_MINIMUM_RELEASE_AGE, cache, packument, tarball, now = Date.now(), signal, downloads = true } = {}) {
  const context = { cache, packument, tarball, now, signal }
  const facts = await npmPackageFacts(name, oldVersion === null ? [version] : [version, oldVersion], context)
  const { published } = facts.versions.get(version)
  const kept = await lasting(name, version, oldVersion, facts, context)
  const own = npmVersionFindings({ npm: { manifest: { deprecated: facts.deprecated[version] }, published } },
    { minimumReleaseAge, now, downloads: downloads ? await npmDownloads(name, context) : null })
  const was = oldVersion === null ? null : facts.versions.get(oldVersion).published
  const added = downloads ? await addedDependencies(kept.dependencies.added, [was, published], context) : kept.dependencies.added
  return {
    name, version, oldVersion, published,
    findings: [...own.filter(({ id }) => id === 'deprecated'), ...kept.findings,
      ...own.filter(({ id }) => id !== 'deprecated').map(finding => finding.id === 'popularity' ? { ...finding, ...tierOf(finding.tier) } : finding)],
    files: kept.files,
    dependencies: { added, changed: kept.dependencies.changed },
  }
}
