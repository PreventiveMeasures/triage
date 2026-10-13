// What calls for a look at a version beside its files: one too new to
// trust yet, one npm says is deprecated, a publisher that changed, provenance
// the version before had and this one lost, and install scripts it adds or
// changes. Each from what npm's version documents say, as manifest.js reads
// them (`publisher`, `knownAccounts`, `provenance`, `installScripts`,
// `deprecated`).
import { DAY_MS } from './downloads.js'
import { npmInstallScripts } from './install-scripts.js'

// How old a version must be to be trusted, by default: two weeks, as a
// compromised release is mostly found and pulled within days, so one this
// new hasn't yet had the time to be. A caller's own packages (a team's npm
// scopes) take 0: trusted however new.
export const DEFAULT_MINIMUM_RELEASE_AGE = 14 * DAY_MS

// Whether a version published at `published` (an ISO time) is too new to
// trust at `now`: younger than `minimumReleaseAge`, none at 0.
export const npmTooNew = (published, { minimumReleaseAge = DEFAULT_MINIMUM_RELEASE_AGE, now = Date.now() } = {}) =>
  minimumReleaseAge > 0 && typeof published === 'string' && now - Date.parse(published) < minimumReleaseAge

// How long before a version an account has published its package to be one
// of its maintainers: three months, as an account given a package to take it
// publishes its attack within weeks.
const TENURE_MS = 90 * DAY_MS

// Each account's standing on a package when a version of it was published
// (`at`, an ISO time), by the package's versions as npm's document lists them
// (`releases`, registry.js, `{ publisher, published }` each), as
// `(account, known) => standing`: `known` where it publishes one of npm's
// most downloaded packages (`known`, manifest.js `knownAccounts`), green;
// `maintainer` where it published the package three months or more before,
// or first, as its sole maintainer has, yellow; else `new`, as an account
// taking the package from its maintainers is, orange.
export function npmAccountStanding(releases, at) {
  const since = new Map()
  for (const { publisher, published } of releases) {
    const time = Date.parse(published)
    if (publisher && !Number.isNaN(time) && !(since.get(publisher) <= time)) since.set(publisher, time)
  }
  const first = [...since].reduce((earliest, row) => earliest && earliest[1] <= row[1] ? earliest : row, null)?.[0]
  return (account, known) => known ? 'known' : account && (account === first || Date.parse(at) - since.get(account) >= TENURE_MS) ? 'maintainer' : 'new'
}

// The npm account that published each version, where npm says for both and
// they differ, as when a package changes hands, or is taken over: `{ was,
// now, wasKnown, nowKnown, severity }`, each account known where it publishes
// one of npm's most downloaded packages (`knownAccounts`), and with the
// package's versions told (`standing`, npmAccountStanding's of the open
// version), each one's standing on it (`wasStanding`, `nowStanding`);
// `moderate` where the open version's is known, or one of the package's
// maintainers, `critical` where a known one gave way to one that isn't, else
// `high`. Null where it didn't change.
export function npmPublisherChange(from, to, standing = null) {
  const now = to?.publisher, was = from?.publisher
  if (!was || !now || was === now) return null
  const nowKnown = to.knownAccounts?.includes(now) === true, wasKnown = from.knownAccounts?.includes(was) === true
  const told = standing ? { wasStanding: standing(was, wasKnown), nowStanding: standing(now, nowKnown) } : {}
  return { was, now, wasKnown, nowKnown, ...told, severity: nowKnown || told.nowStanding === 'maintainer' ? 'moderate' : wasKnown ? 'critical' : 'high' }
}

// Provenance the one compared with has and the open version hasn't, as a
// version published by hand, with a token taken from its maintainers,
// wouldn't.
export const npmProvenanceLost = (from, to) => Boolean(from?.provenance && !to?.provenance)

// The scripts npm runs installing the open version (`other`, its manifest
// and `paths`, its files; install-scripts.js npmInstallScripts, node-gyp's
// for a binding.gyp among them) that the one compared with (`base`) didn't,
// or ran another command for: `{ was, now, flagged }`, each version's
// scripts by name and the names flagged; null for none. One dropped isn't
// flagged.
export function npmInstallScriptsChange(base, other) {
  const scripts = ({ manifest, paths }) => new Map(npmInstallScripts(manifest, paths))
  const now = scripts(other), was = scripts(base)
  const flagged = [...now].filter(([script, command]) => was.get(script) !== command).map(([script]) => script)
  return flagged.length === 0 ? null : { was, now, flagged }
}
