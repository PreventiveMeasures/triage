// A package version's risk, as the managed server asks it: what calls for a
// look at it, against the version before it where one is given or risk picks
// one (old-version.js), each file's stamps, and its dependencies', from npm's
// registry, kept in the caller's cache (registry.js) as it goes.
import { npmBaseFilesTell, npmCompareFindings } from './compare.js'
import { npmCombinedFindings, npmHeldDependencyFindings } from './combined.js'
import { npmHeldFindings, npmVersionFindings } from './held.js'
import { npmVersionFileRisk } from './files.js'
import { npmDependencyChanges, npmFlagDependencyChanges, npmUnusedDependencyCounted } from './dependencies.js'
import { npmDownloadMonths, npmDownloadTier, npmSettledDownloads, npmTierLevel } from './downloads.js'
import { NpmRiskError, npmDownloads, npmPackageFacts, npmPackageReleases, npmPublicFacts, npmVersionAdvisories, npmVersionFiles } from './registry.js'
import { npmMalwareFinding } from './malware.js'
import { npmKnownScope } from './manifest.js'
import { DEFAULT_MINIMUM_RELEASE_AGE, npmAccountStanding } from './release.js'
import { npmAddedDependency, npmUnusedDependencySeverity } from './new-dependency.js'
import { SEVERITIES } from '../files/stamps.js'
import { npmRiskScore } from './score.js'

// Which reading of a version an assessment kept (`risk/npm/assessments`) is:
// one more whenever a heuristic changes what it finds, so one kept by an
// older reading is read anew.
const RISK_VERSION = 18

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

// What of an assessment holds whatever the time, of the open version
// (`other`) against the one compared with (`base`), or alone without one,
// each as compare.js takes a version, as JSON holds it: what it holds,
// always (held.js npmHeldFindings, and its dependencies against none,
// combined.js npmHeldDependencyFindings), and against `base` what its files,
// dependencies, install scripts, publisher and provenance call for anew
// (compare.js npmCompareFindings), folded into what it holds, never lowering
// it (combined.js npmCombinedFindings); each file's stamps and what risk read
// of it (filesRisk); and its dependencies added and changed, each with its
// flags (dependencies.js), against `base` each it holds too (`held`). Its own findings are told fresh
// (npmAssessmentOf). The managed server's assessments keep it (`lasting`),
// and a test can tell what one says of versions it holds. Each publisher's
// standing on the package is told where `standing` is given (release.js
// npmAccountStanding, of the open version).
export const npmLastingRisk = (other, base = null, standing = null) => lastingOf(other, base, filesRisk(other, `${other.npm.name}@${other.npm.version}`), standing)

// npmLastingRisk's, the open version's files read within bounds (`files`,
// filesRisk's), as the one compared with's are where `base` has them, before
// the findings read them all.
function lastingOf(other, base, files, standing) {
  if (base?.json) filesRisk(base, `${base.npm.name}@${base.npm.version}`)
  const all = npmFlagDependencyChanges(npmDependencyChanges(undefined, other.npm.manifest), null, other)
  const held = [...npmHeldFindings(other), ...npmHeldDependencyFindings(all)]
  const { added, changed } = base ? npmFlagDependencyChanges(npmDependencyChanges(base.npm.manifest, other.npm.manifest), base, other) : all
  const findings = base ? npmCombinedFindings(held, npmCompareFindings(base, other, { added, changed }, standing)) : held
  const kept = { findings: plain(findings), files, dependencies: plain({ added, changed, ...base ? { held: all.added } : {} }) }
  if (JSON.stringify(kept).length > MAX_ASSESSMENT_LENGTH) throw tooLarge(`${other.npm.name}@${other.npm.version}`)
  return kept
}

// What of an assessment holds whatever the time (npmLastingRisk), kept once a
// reading and pair, its versions' files read from npm only where it isn't:
// the open version's first, then the one compared with's only where they
// could change what is found (compare.js npmBaseFilesTell), that one else
// told by what npm's document of it says alone; and where another account
// published it, each one's standing on the package (release.js
// npmAccountStanding), by its versions as `facts` read them, or as its
// document is read again where they were kept. A standing changes as npm
// removes a version, its publisher then unknown, and never else, so such a
// pair is kept by how many npm has removed (`~<removals>`), read anew as it
// removes another.
async function lasting(name, version, oldVersion, facts, context, fromEmpty) {
  const old = oldVersion === null ? null : facts.versions.get(oldVersion)
  const publishers = [old, facts.versions.get(version)].map(fact => fact?.manifest.publisher)
  const changed = publishers.every(Boolean) && publishers[0] !== publishers[1]
  const key = `${RISK_VERSION}/${name}@${version}${fromEmpty ? '..(empty)' : oldVersion === null ? '' : `..${oldVersion}`}${changed ? `~${facts.removals}` : ''}`
  const hit = context.cache ? await context.cache.read('risk/npm/assessments', key) : null
  if (hit) return hit
  const other = await npmVersionFiles(name, version, facts.versions.get(version), context)
  const files = filesRisk(other, `${name}@${version}`)
  const base = fromEmpty ? { npm: { name, version: '', manifest: {} }, json: { sources: [], sourcesContent: [] } } : old === null ? null : npmBaseFilesTell(other, old.manifest) ? await npmVersionFiles(name, oldVersion, old, context)
    : { npm: { name, version: oldVersion, manifest: old.manifest, published: old.published }, json: null }
  const standing = changed ? npmAccountStanding(facts.releases ?? await npmPackageReleases(name, context), other.npm.published) : null
  const kept = lastingOf(other, base, files, standing)
  if (context.cache) await context.cache.write('risk/npm/assessments', key, kept)
  return kept
}

// How many dependencies added are told of at most, however many a version
// adds, as each costs npm a request or two: the rest are left as they are,
// their packages unknown.
const MAX_TOLD_DEPENDENCIES = 100

// Each dependency `added` that npm installs from its registry, up to
// MAX_TOLD_DEPENDENCIES of them, but for the caller's own packages (`owned`,
// as its own scopes take, few downloading them, as new as its releases),
// with what risk tells of its package
// (new-dependency.js npmAddedDependency): its tier, its last whole month's
// downloads by what its tier goes by where it has one (`month`, `{ total,
// from }`), `uncounted` where npm counts none of them, `created` and `gap`
// where it is new since the version compared with (`published`, when that
// and the open version were), and for one nothing imports (flagged so, or
// among `unusedKeys`) that risk counts (dependencies.js
// npmUnusedDependencyCounted), the version its spec installs (`installs`,
// registry.js npmPublicFacts); `missing` where
// its package was looked up and npm has none of it for anyone, as once
// unpublished or taken down; four asked at a time, whether each is the
// caller's own among them, none more once one fails or MAX_TOLD_DEPENDENCIES
// not the caller's own were taken, however many a version adds.
async function addedDependencies(added, published, context, owned, unusedKeys = new Set()) {
  const told = [...added]
  const asked = told.flatMap((row, at) => row.opens ? [at] : [])
  let next = 0, taken = 0
  const tell = async row => {
    const downloads = await npmDownloads(row.opens, context)
    const unused = (row.flags.some(flag => flag.check === 'unimported') || unusedKeys.has(keyOf(row))) && npmUnusedDependencyCounted(row)
    let facts = npmAddedDependency({ downloads, published, unused }, context.now), missing = false
    if (facts.wanted) {
      const listed = await npmPublicFacts(row.opens, context, unused ? row.range : null)
      missing = listed === null
      facts = npmAddedDependency({ downloads, listed: listed && { ...listed, private: false }, published, unused }, context.now)
    }
    const settled = npmSettledDownloads(downloads, context.now)
    const month = npmDownloadMonths(settled).at(-1)
    return { ...row, ...facts.tier === null ? {} : { ...tierOf(facts.tier), ...settled ? month && { month: { total: month.total, from: month.from.toISOString().slice(0, 10) } } : { uncounted: true } },
      ...facts.created ? { created: facts.created, gap: facts.gap } : {}, ...facts.installs ? { installs: facts.installs } : {}, ...missing ? { missing } : {} }
  }
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (next < asked.length && taken < MAX_TOLD_DEPENDENCIES) {
      const at = asked[next++]
      try {
        if (await owned(told[at].opens)) continue
        if (taken >= MAX_TOLD_DEPENDENCIES) break
        taken++
        told[at] = await tell(told[at])
      } catch (error) { next = asked.length; throw error }
    }
  }))
  return told
}

// What calls for a look at `version` of package `name`, as JSON holds it:
// malware first (malware.js npmMalwareFinding: its package taken down by
// npm, and npm's advisories of malware naming it where `advisories`, true
// unless given false, has them asked, OSV's too where `osv` is, true unless
// given false, as a private package's name is never sent it); against `oldVersion` where given,
// true for the one of its versions most likely free of what an attack
// injects, as risk picks it by npm's document (old-version.js npmOldVersion;
// none where none is below it), the one it picked said as `oldVersion`
// (compare.js npmCompareFindings's order), else what it holds (held.js
// npmHeldFindings), a deprecation first, and last
// one younger than `minimumReleaseAge` (two weeks unless given; 0 for none, as
// a caller's own scopes take), and the package's tier past the top 20,000
// (`popularity`, held.js npmVersionFindings, unless `popularity` is given
// false, as a caller's own scopes take); `files`, each file's stamps and what risk read of it; and
// `dependencies`, those added and changed against it, each with its flags,
// an added one with its package's tier and age where `downloads` (true unless
// given false) has them asked, and `dependencies` (true unless given false)
// too, but where `owned` says its package is the caller's own, as its own scopes
// take (none unless given). `cache` keeps what is read (registry.js),
// `packument` asks for a package's whole document and `tarball` for a
// version's tarball in risk's stead (registry.js), `now` is when it is asked, `signal` gives up on what is
// still asked of npm. A version npm removed, as it removes every one it finds
// malware in, is told of by its malware alone (`removed`), nothing of it left
// to read. Throws an NpmRiskError (registry.js), its `code` saying why, where
// npm has no such package or version (nor malware explaining one removed),
// answers past risk's bounds, or can't be asked.
export async function assessNpm(name, version, { oldVersion = null, fromEmpty = false, minimumReleaseAge = DEFAULT_MINIMUM_RELEASE_AGE, popularity = true, cache, packument, tarball, now = Date.now(), signal, downloads = true, dependencies = true, advisories = true, osv = true, owned = () => false } = {}) {
  const context = { cache, packument, tarball, now, signal }
  const facts = await npmPackageFacts(name, version, oldVersion, context)
  const old = facts.oldVersion
  if (old !== null && !facts.versions.has(old)) throw new NpmRiskError('version-not-found', `npm has no ${name}@${old}`)
  // Its advisories, its lasting risk and its downloads need none of each
  // other, so all are asked at once, and waited on in this order, so that a
  // failure fails it as the first of them failing would.
  const listed = facts.versions.has(version)
  const advised = settledLater(advisories ? npmVersionAdvisories(name, version, osv, context) : Promise.resolve([]))
  const keeping = listed ? settledLater(lasting(name, version, old, facts, context, fromEmpty)) : null
  const counting = listed && downloads && popularity ? settledLater(npmDownloads(name, context)) : null
  const malware = npmMalwareFinding({ takenDown: facts.takenDown, advisories: await advised })
  if (!listed) {
    if (!malware) throw new NpmRiskError('version-not-found', `npm has no ${name}@${version}`)
    return { name, version, oldVersion: null, published: facts.removed.get(version), removed: true, findings: [malware], files: {}, dependencies: { added: [], changed: [] },
      score: npmRiskScore([malware]) }
  }
  const { published, manifest } = facts.versions.get(version)
  const kept = await keeping
  const counted = await counting
  const own = npmVersionFindings({ deprecated: facts.deprecated[version], published, minimumReleaseAge, now, known: Boolean(manifest.knownAccounts), scope: npmKnownScope(name),
    provenance: Boolean(manifest.provenance), downloads: counted })
  const was = old === null ? null : facts.versions.get(old).published
  // Those it holds that nothing imports by another spec than the version
  // compared with's, told by their new spec as an added one nothing imports
  // is (`respecified`), and an added one nothing imports however it was
  // flagged, as one moved from another kind of dependency is.
  const unusedKeys = unusedKeysOf(kept)
  const respecified = kept.dependencies.changed.filter(row => unusedKeys.has(keyOf(row))).map(row => ({ ...row, range: row.to }))
  const told = downloads && dependencies ? await addedDependencies([...kept.dependencies.added, ...respecified], [was, published], context, owned, unusedKeys)
    : [...kept.dependencies.added, ...respecified]
  const added = told.slice(0, kept.dependencies.added.length)
  const assessment = npmAssessmentOf(kept, malware ? [malware, ...own] : own, added, told.slice(added.length))
  return { name, version, oldVersion: old, published, ...assessment, score: npmRiskScore(assessment.findings, { published, now, tier: counted ? npmDownloadTier(counted) : null }) }
}

// A dependency's key among a version's, by its kind and name.
const keyOf = row => `${row.kind ?? ''}\0${row.name}`

// `promise`, waited on later: its failure, if it fails before then, not
// thrown as unhandled meanwhile.
const settledLater = promise => { promise.catch(() => {}); return promise }

// The keys of the dependencies a version holds that nothing of it imports
// (`kept`, npmLastingRisk's: its `held-unused-deps`), those risk counts
// (dependencies.js npmUnusedDependencyCounted).
const unusedKeysOf = kept => new Set((kept.findings.find(({ id }) => id === 'held-unused-deps')?.dependencies ?? []).filter(npmUnusedDependencyCounted).map(keyOf))

// The dependencies nothing of a version imports (`held-unused-deps`), each
// graded by what risk tells of its package fresh (`told`, as
// addedDependencies tells it; new-dependency.js
// npmUnusedDependencySeverity), with its tier, when its package was first
// published and the version its spec installs where told: kept from the
// version compared with where there was one (`compared`) and it named it as
// the same kind of dependency by the same spec: not one marked new, nor
// `added` (its kind and name new, as one moved from another kind is), nor
// `changed` (each said with the spec it had, `was`); one risk doesn't count
// (dependencies.js npmUnusedDependencyCounted) a notice, told all the same.
// The finding as its most severe.
function unusedGraded(finding, told, compared, { added, changed }) {
  const facts = new Map(told.map(row => [keyOf(row), row])), was = new Map(changed.map(row => [keyOf(row), row.from]))
  const anew = new Set(added.map(keyOf))
  const dependencies = finding.dependencies.map(row => {
    const of = facts.get(keyOf(row))
    return { ...row, ...was.has(keyOf(row)) ? { was: was.get(keyOf(row)) } : {}, severity: npmUnusedDependencyCounted(row)
      ? npmUnusedDependencySeverity(of, compared && !row.added && !anew.has(keyOf(row)) && !was.has(keyOf(row))) : 'notice',
      ...of?.level ? { tier: of.tier, level: of.level } : {}, ...of?.created ? { created: of.created, gap: of.gap } : {}, ...of?.installs ? { installs: of.installs } : {},
      ...of?.missing ? { missing: true } : {} }
  })
  return { ...finding, severity: SEVERITIES[Math.min(...dependencies.map(row => SEVERITIES.indexOf(row.severity)))], dependencies }
}

// An assessment of what of it holds whatever the time (`kept`,
// npmLastingRisk's) and what is told fresh: the open version's own findings
// (`own`, held.js npmVersionFindings, and its malware), its malware and
// deprecation first and the rest last, its tier as JSON holds it (tierOf),
// and its dependencies `added`, as addedDependencies tells them, those it
// holds by another spec that nothing imports beside them (`respecified`),
// for its unused dependencies' grades. The managed
// server's (assessNpm), and a test's of versions it holds.
const FIRST = new Set(['malware', 'deprecated'])
export function npmAssessmentOf(kept, own, added = kept.dependencies.added, respecified = []) {
  return {
    findings: [...own.filter(({ id }) => FIRST.has(id)), ...kept.findings.map(finding => finding.id === 'held-unused-deps'
      ? unusedGraded(finding, [...added, ...respecified], Boolean(kept.dependencies.held), kept.dependencies) : finding),
      ...own.filter(({ id }) => !FIRST.has(id)).map(finding => finding.id === 'popularity' ? { ...finding, ...tierOf(finding.tier) } : finding)],
    files: kept.files,
    dependencies: { ...kept.dependencies, added },
  }
}
