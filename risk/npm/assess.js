// A package version's risk, as the managed server asks it: what calls for a
// look at it, against the version before it where one is given or risk picks
// one (old-version.js), each file's stamps, and its dependencies', from npm's
// registry, kept in the caller's cache (registry.js) as it goes.
import { npmBaseFilesTell, npmCompareFindings } from './compare.js'
import { npmCombinedFindings, npmHeldDependencyFindings } from './combined.js'
import { npmHeldFindings, npmVersionFindings } from './held.js'
import { npmVersionFileRisk } from './files.js'
import { npmDependencyChanges, npmFlagDependencyChanges } from './dependencies.js'
import { npmDownloadMonths, npmSettledDownloads, npmTierLevel } from './downloads.js'
import { NpmRiskError, npmDownloads, npmPackageFacts, npmPackageReleases, npmPublicFacts, npmVersionAdvisories, npmVersionFiles } from './registry.js'
import { npmMalwareFinding } from './malware.js'
import { npmKnownScope } from './manifest.js'
import { DEFAULT_MINIMUM_RELEASE_AGE, npmAccountStanding } from './release.js'
import { npmAddedDependency } from './new-dependency.js'

// Which reading of a version an assessment kept (`risk/npm/assessments`) is:
// one more whenever a heuristic changes what it finds, so one kept by an
// older reading is read anew.
const RISK_VERSION = 9

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
// from }`), `uncounted` where npm counts none of them, and `created` and `gap`
// where it is new since the version compared with (`published`, when that
// and the open version were); four asked at a time, whether each is the
// caller's own among them, none more once one fails or MAX_TOLD_DEPENDENCIES
// not the caller's own were taken, however many a version adds.
async function addedDependencies(added, published, context, owned) {
  const told = [...added]
  const asked = told.flatMap((row, at) => row.opens ? [at] : [])
  let next = 0, taken = 0
  const tell = async row => {
    const downloads = await npmDownloads(row.opens, context)
    let facts = npmAddedDependency({ downloads, published }, context.now)
    if (facts.wanted) {
      const listed = await npmPublicFacts(row.opens, context)
      facts = npmAddedDependency({ downloads, listed: listed && { ...listed, private: false }, published }, context.now)
    }
    const settled = npmSettledDownloads(downloads, context.now)
    const month = npmDownloadMonths(settled).at(-1)
    return { ...row, ...facts.tier === null ? {} : { ...tierOf(facts.tier), ...settled ? month && { month: { total: month.total, from: month.from.toISOString().slice(0, 10) } } : { uncounted: true } },
      ...facts.created ? { created: facts.created, gap: facts.gap } : {} }
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
  const malware = npmMalwareFinding({ takenDown: facts.takenDown, advisories: advisories ? await npmVersionAdvisories(name, version, osv, context) : [] })
  if (!facts.versions.has(version)) {
    if (!malware) throw new NpmRiskError('version-not-found', `npm has no ${name}@${version}`)
    return { name, version, oldVersion: null, published: facts.removed.get(version), removed: true, findings: [malware], files: {}, dependencies: { added: [], changed: [] } }
  }
  const { published, manifest } = facts.versions.get(version)
  const kept = await lasting(name, version, old, facts, context, fromEmpty)
  const own = npmVersionFindings({ deprecated: facts.deprecated[version], published, minimumReleaseAge, now, known: Boolean(manifest.knownAccounts), scope: npmKnownScope(name),
    downloads: downloads && popularity ? await npmDownloads(name, context) : null })
  const was = old === null ? null : facts.versions.get(old).published
  const added = downloads && dependencies ? await addedDependencies(kept.dependencies.added, [was, published], context, owned) : kept.dependencies.added
  return { name, version, oldVersion: old, published, ...npmAssessmentOf(kept, malware ? [malware, ...own] : own, added) }
}

// An assessment of what of it holds whatever the time (`kept`,
// npmLastingRisk's) and what is told fresh: the open version's own findings
// (`own`, held.js npmVersionFindings, and its malware), its malware and
// deprecation first and the rest last, its tier as JSON holds it (tierOf),
// and its dependencies `added`, as addedDependencies tells them. The managed
// server's (assessNpm), and a test's of versions it holds.
const FIRST = new Set(['malware', 'deprecated'])
export function npmAssessmentOf(kept, own, added = kept.dependencies.added) {
  return {
    findings: [...own.filter(({ id }) => FIRST.has(id)), ...kept.findings,
      ...own.filter(({ id }) => !FIRST.has(id)).map(finding => finding.id === 'popularity' ? { ...finding, ...tierOf(finding.tier) } : finding)],
    files: kept.files,
    dependencies: { ...kept.dependencies, added },
  }
}
