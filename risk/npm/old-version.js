// The version an open version is compared with where the caller leaves it to
// risk (assess.js `oldVersion: true`): of the package's others, the one most
// likely free of what an attack injects, as a pair's findings flag only what
// is new against it, so an attack's own earlier version, or one published
// with it, would hide what it injected. Told by what npm's document says of
// each version alone (registry.js npmPackageFacts): when it was published,
// its publisher and whether that account is known (manifest.js), its
// deprecation, and those since removed from npm, whose times it keeps; no
// tarball is read for it.
import { DAY_MS } from './downloads.js'

// How long a version is on npm before it is taken as looked at: a month, as
// an attack's versions are mostly found and pulled within days.
const SETTLED_MS = 30 * DAY_MS
// How near the open version's publish, either side, a version comes with it:
// a week, as an attack publishes its versions within days of each other.
const CLOSE_MS = 7 * DAY_MS
// How near a version since removed from npm, either side, a version comes
// with it: a day, as an attack's versions come within hours of each other,
// and npm removes those it finds.
const REMOVED_MS = DAY_MS
// How long before the open version an account has published the package to
// be one of its maintainers, trusted as a known account is: three months, as
// an account given a package to take it publishes its attack within weeks.
const TENURE_MS = 90 * DAY_MS

// A version as npm publishes one, `{ core, pre }`: its MAJOR.MINOR.PATCH, each
// to 16 digits and a safe integer as semver takes them, and its prerelease's
// identifiers, build metadata aside; null for any other.
const VERSION = /^(0|[1-9]\d{0,15})\.(0|[1-9]\d{0,15})\.(0|[1-9]\d{0,15})(?:-([\da-z-]+(?:\.[\da-z-]+)*))?(?:\+[\da-z-]+(?:\.[\da-z-]+)*)?$/iu
function parsed(version) {
  const match = VERSION.exec(version)
  const core = match?.slice(1, 4).map(Number)
  return core?.every(Number.isSafeInteger) ? { core, pre: match[4]?.split('.') ?? [] } : null
}

// Which of two versions is higher, by semver's precedence: their cores, a
// release above its prereleases, and prereleases by their identifiers, a
// number below a word.
function compared(a, b) {
  const core = a.core.findIndex((part, at) => part !== b.core[at])
  if (core !== -1) return a.core[core] - b.core[core]
  if (a.pre.length === 0 || b.pre.length === 0) return b.pre.length - a.pre.length
  for (let at = 0; at < Math.max(a.pre.length, b.pre.length); at++) {
    const x = a.pre[at], y = b.pre[at]
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1
    if (x === y) continue
    const xNumber = /^\d+$/u.test(x), yNumber = /^\d+$/u.test(y)
    if (xNumber !== yNumber) return xNumber ? -1 : 1
    if (xNumber && x.length !== y.length) return x.length - y.length
    return x < y ? -1 : 1
  }
  return 0
}

// Of a package's versions (`releases`, `{ version, published, publisher,
// known, deprecated, removed }` each, `removed` one since removed from npm,
// its time alone kept), the one `version` is compared with at `now`, or null
// where none is below it. An account is trusted where it is known
// (manifest.js `knownAccounts`: one that published one of npm's most
// downloaded packages, as @preventive/publishers lists them), or where it
// published the package three months or more before the open version, as
// one of its maintainers (TENURE_MS). Of those below it, a release where it
// is one, the highest that is preferred, each preference kept only where some
// version holds it, in turn:
//
// - Where an account not trusted published it, one another published, as an
//   attack may have published more than one.
// - One published before it, not after, as one published since (a
//   backport) is no version it came from.
// - Where it isn't trusted and the highest of those a trusted account
//   published, as when a package is taken from its maintainers, one a
//   trusted account published.
// - One published a day or more apart from any version since removed from
//   npm, as not one of the attack npm removed those of.
// - One published a week or more apart from it, as not one of an attack's,
//   and on npm a month or more, as looked at; but for one a trusted account
//   other than its own published, trusted however new, as an account taken
//   leaves another's versions alone. Its own account's are held to both, as
//   it may be the one taken.
// - One npm doesn't say is deprecated, as one a maintainer took back.
//
// The highest is in its branch (`1.x.y`, `0.2.y`, `0.0.y`) where one is
// there, else in the closest branch below.
export function npmOldVersion(version, releases, now) {
  const open = releases.find(row => row.version === version && !row.removed)
  const at = open && parsed(version)
  if (!at) return null
  const prefer = (rows, wanted) => { const kept = rows.filter(wanted); return kept.length > 0 ? kept : rows }
  const time = row => row.published === null ? Number.NaN : Date.parse(row.published)
  const opened = time(open)
  const versions = releases.flatMap(row => { const of = parsed(row.version); return of ? [{ ...row, of }] : [] })
  const removed = versions.filter(row => row.removed).map(time).filter(Number.isFinite)
  // When each account first published the package.
  const since = new Map()
  for (const row of versions) {
    const first = since.get(row.publisher)
    if (row.publisher && !Number.isNaN(time(row)) && !(first <= time(row))) since.set(row.publisher, time(row))
  }
  const trusted = row => Boolean(row?.publisher) && (row.known || opened - since.get(row.publisher) >= TENURE_MS)
  const taken = Boolean(open.publisher) && !trusted(open)
  let rows = prefer(versions.filter(row => !row.removed && compared(row.of, at) < 0).toSorted((a, b) => compared(b.of, a.of)),
    row => row.of.pre.length === 0 || at.pre.length > 0)
  if (taken) rows = prefer(rows, row => row.publisher !== open.publisher)
  rows = prefer(rows, row => time(row) < opened)
  if (taken && trusted(rows[0])) rows = rows.filter(trusted)
  rows = prefer(rows, row => removed.every(gone => Math.abs(time(row) - gone) >= REMOVED_MS))
  const vouched = row => trusted(row) && row.publisher !== open.publisher
  rows = prefer(prefer(rows, row => vouched(row) || Math.abs(time(row) - opened) >= CLOSE_MS), row => vouched(row) || now - time(row) >= SETTLED_MS)
  return prefer(rows, row => !row.deprecated)[0]?.version ?? null
}
