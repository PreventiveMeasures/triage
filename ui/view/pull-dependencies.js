// The package versions a pull request's lockfiles add, a package's new to them
// or a new version of one they locked before, as an open pull request's tile
// (repository-issues.js) and any one's popup
// (dialogs/repository-item-dialog.js) show them (GET
// /api/admin/repositories/pull-dependencies): read only of one GitHub says
// changes a lockfile, or may, its files more than it listed
// (`touchesLockfile`), as many at once as READ_AT_ONCE, those asked first
// read first, as a page of tiles asks of each in turn, those a page asks of
// in the background (a team's Dependencies tab) after the rest, as many of a
// repository's as READ_TOGETHER asked together, one asked of meanwhile moved
// before them; and kept for the session that read them a
// while, as the tiles are, one grown old shown while it is read again. Each
// answer's versions are worked out once (`once`). An open one's are asked
// with their review, where the repository reviews dependencies
// (server-managed/pull-dependency-reviews.ts): each version's, the other
// versions its lockfiles lock that want reviews, and what fails it.
import { state } from '#client/index.js'
import { fetchPullDependencies, fetchPullDependenciesOf } from './client-managed.js'

const KEEP_MS = 5 * 60_000
const RETRY_MS = 30_000
const READ_AT_ONCE = 2
const READ_TOGETHER = 20

const held = new Map()
// Those waiting their turn, those asked in the background after (`behind`),
// by their keys (`queued`).
const waiting = []
const behind = []
const queued = new Map()
const listeners = new Set()
let keptFor = null
let reading = 0

// Calls `notify` as what is held changes, with the pull request it is of
// (`{ repoId, number }`), none where all may have, till the returned
// function is called.
export function subscribePullDependencies(notify) {
  listeners.add(notify)
  return () => listeners.delete(notify)
}
const changed = pull => { for (const notify of listeners) notify(pull) }

function forget() {
  held.clear()
  waiting.length = 0
  behind.length = 0
  queued.clear()
}

// A repository's review set anew (the admin's repository page): what is
// held, of pull requests' reviews among it, asked again.
globalThis.addEventListener?.('dependency-review-changed', () => {
  forget()
  changed()
})

function sessionHeld() {
  const session = state.managedSession ? `${state.managedSession.id}\0${state.managedSession.role}` : null
  if (session !== keptFor) {
    forget()
    keptFor = session
  }
  return held
}

// Whether a pull request's new packages are read: one GitHub says changes a
// lockfile, or may.
export const readsDependencies = item => item?.touchesLockfile === true || item?.touchesLockfile === null

const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null
const UNSUPPORTED = new Set(['git', 'tarball', 'integrity'])

// A version as an answer names it: the versions it was, those it names,
// whether it is patched, and its review, where it tells one: why it can't be
// reviewed (`unsupported`), needing none (`baseline`), passed by the
// server's reviewed dependencies (`reviewed`), or how many pass it
// (`reviews`), whether a reviewer rejects it (`rejected`), and how many
// review it in its pull request's comments alone, which count for it alone
// (`commented`).
function checkedVersion(pkg) {
  if (typeof pkg?.name !== 'string') return []
  const { was, reviews, rejected, commented, baseline, reviewed, unsupported, patched, ...version } = pkg
  return [{ ...version, ...Array.isArray(was) && was.length > 0 && was.every(other => typeof other === 'string') ? { was } : {}, ...patched === true ? { patched } : {},
    ...UNSUPPORTED.has(unsupported) ? { unsupported } : baseline === true ? { baseline } : reviewed === true ? { reviewed }
      : count(reviews) === null ? {} : { reviews, ...rejected === true ? { rejected } : {}, ...count(commented) > 0 ? { commented } : {} } }]
}
const versionsOf = list => Array.isArray(list) ? list.flatMap(checkedVersion) : []

// A server's answer, its directories those it names by their lockfiles'
// paths, each's versions those it names (checkedVersion), and its review's
// terms, where it tells them, with how many versions across its directories
// want reviews and can't be reviewed, whether the server's reviewed
// dependencies pass them, and how many those failed to answer; by how many
// reviewers its comments review them, or that they couldn't be read; the
// lockfiles it holds to, where not every one, those of the rest told to none;
// and the comment the server's host formats of the reader's own reviews of
// its versions, to copy (`formatted`), where it formats one.
export function checked(answer) {
  if (!Array.isArray(answer?.lockfiles)) throw new Error('The server answered with no lockfiles.')
  const lockfiles = answer.lockfiles.filter(dir => Array.isArray(dir?.paths) && (Array.isArray(dir.added) || typeof dir.error === 'string')).map(dir => dir.error ? dir
    : { ...dir, added: dir.added.flatMap(checkedVersion), more: count(dir.more) ?? 0, unreviewed: versionsOf(dir.unreviewed),
      moreUnreviewed: count(dir.moreUnreviewed) ?? 0, unsupported: versionsOf(dir.unsupported), moreUnsupported: count(dir.moreUnsupported) ?? 0,
      moreLocked: count(dir.moreLocked) ?? 0 })
  const review = answer.review
  return { lockfiles, cut: answer.cut === true, ...typeof answer.formatted === 'string' && answer.formatted.trim() !== '' ? { formatted: answer.formatted } : {},
    ...count(review?.required) > 0 ? { review: { required: review.required,
    since: typeof review.since === 'string' ? review.since : null, canReview: review.canReview === true,
    ...count(review.toReview) === null ? {} : { toReview: review.toReview },
    ...count(review.unreviewed) === null ? {} : { unreviewed: review.unreviewed }, ...count(review.unsupported) === null ? {} : { unsupported: review.unsupported },
    ...Array.isArray(review.baselineUnread) && review.baselineUnread.every(path => typeof path === 'string') ? { baselineUnread: review.baselineUnread } : {},
    ...review.reviewedDependencies === true ? { reviewedDependencies: true } : {}, ...count(review.unasked) > 0 ? { unasked: review.unasked } : {},
    ...count(review.commentReviews) > 0 ? { commentReviews: review.commentReviews } : {}, ...review.commentsFailed === true ? { commentsFailed: true } : {},
    ...typeof review.baselineError === 'string' ? { baselineError: review.baselineError } : {},
    ...['exclude', 'include'].includes(review.lockfiles?.mode) && Array.isArray(review.lockfiles.paths) && review.lockfiles.paths.every(path => typeof path === 'string')
      ? { lockfiles: { mode: review.lockfiles.mode, paths: review.lockfiles.paths } } : {} } } : {} }
}

// The next asked read as one is, as many at once as READ_AT_ONCE, those
// asked in the background after the rest, one of them read with as many of
// its repository's waiting as READ_TOGETHER.
function readNext() {
  while (reading < READ_AT_ONCE && waiting.length + behind.length > 0) {
    const first = waiting.shift() ?? behind.shift()
    const jobs = [first]
    for (let at = 0; first.background && at < behind.length && jobs.length < READ_TOGETHER;) {
      const job = behind[at]
      if (job.pull.repoId === first.pull.repoId && job.review === first.review) jobs.push(...behind.splice(at, 1))
      else at++
    }
    for (const job of jobs) queued.delete(job.key)
    reading++
    readOf(jobs).finally(() => readDone(jobs))
  }
}
function readDone(jobs) {
  reading--
  for (const job of jobs) changed(job.pull)
  readNext()
}
// `jobs`, one alone, else several of a repository's together, each told
// its answer or why it failed.
function readOf(jobs) {
  const [{ pull: { repoId, number }, review }] = jobs
  if (jobs.length === 1) return fetchPullDependencies(repoId, number, { review }).then(jobs[0].settle, jobs[0].settle)
  return fetchPullDependenciesOf(repoId, jobs.map(job => job.pull.number), { review }).then(answers => {
    for (const job of jobs) job.settle(answers.get(job.pull.number) ?? new Error('The server answered with none of it.'))
    return null
  }, err => { for (const job of jobs) job.settle(err) })
}

// What pull request `number` of repository `repoId` adds, as held, else
// asked: `{ status }`, 'loading', then 'ready' with its `lockfiles`, `cut`,
// and with `review` (an open one's), its review's terms where in effect, or
// 'error' with its `error`; asked again once old, shown as it was meanwhile
// (`refreshing`), or once an error's retry is due. One asked in the
// `background` is read after those asked otherwise.
export function pullDependencies(repoId, number, review = false, { background = false } = {}) {
  const data = sessionHeld()
  const key = `${repoId}\0${number}\0${review}`
  const entry = data.get(key)
  if (entry && Date.now() < entry.until) {
    const job = queued.get(key)
    if (!background && job?.background) {
      behind.splice(behind.indexOf(job), 1)
      job.background = false
      waiting.push(job)
    }
    return entry
  }
  const loading = entry?.status === 'ready' ? { ...entry, until: Number.POSITIVE_INFINITY, refreshing: true } : { status: 'loading', until: Number.POSITIVE_INFINITY }
  data.set(key, loading)
  // Its answer, else why it failed, held as it is.
  const settle = told => {
    if (data.get(key) !== loading) return
    let failure = told instanceof Error ? told : null
    if (!failure) {
      try { data.set(key, { status: 'ready', until: Date.now() + KEEP_MS, ...checked(told) }); return } catch (err) { failure = err }
    }
    if (failure?.name === 'AbortError') {
      if (entry?.status === 'ready') data.set(key, entry)
      else data.delete(key)
    } else data.set(key, { status: 'error', until: Date.now() + RETRY_MS, error: failure?.message || 'Its lockfiles could not be read.' })
  }
  const job = { key, background, review, pull: { repoId, number }, settle }
  queued.set(key, job)
  ;(background ? behind : waiting).push(job)
  readNext()
  return loading
}

// `work` of an answer's lockfiles and review, worked out once each, as
// they never change.
const worked = new WeakMap()
function once(name, { lockfiles, review }, work) {
  const of = worked.get(lockfiles) ?? worked.set(lockfiles, new Map()).get(lockfiles)
  const known = of.get(name)
  if (known && known.review === review) return known.value
  const value = work()
  of.set(name, { review, value })
  return value
}

// What an answer tells new: each package version once, across its
// directories, those of packages new to them first (`fresh`, no `was`), then
// the new versions of those they locked before; how many of each; whether
// it tells more than it sends (`more`); and how many want reviews
// (`toReview`), as its review counts them, those it didn't send among
// them. A version new to one directory's lockfiles and an update in
// another's is an update, with the versions it was in each, whichever
// directory comes first; and its review the less passing of theirs
// (bothReviewed).
export function addedVersions(answer) {
  return once('added', answer, () => added(answer))
}
function added({ lockfiles, review }) {
  const all = new Map()
  for (const pkg of lockfiles.flatMap(dir => dir.added ?? [])) {
    const key = `${pkg.name}@${pkg.version ?? ''}`
    const had = all.get(key)
    if (!had) { all.set(key, pkg); continue }
    const { reviews: _reviews, baseline: _baseline, reviewed: _reviewed, unsupported: _unsupported, patched: _patched, ...version } = had
    all.set(key, { ...version, ...pkg.was || had.was ? { was: [...new Set([...had.was ?? [], ...pkg.was ?? []])] } : {}, ...bothReviewed(had, pkg, review) })
  }
  const versions = [...all.values()]
  const fresh = versions.filter(pkg => !pkg.was)
  return { versions: [...fresh, ...versions.filter(pkg => pkg.was)], fresh: fresh.length, updated: versions.length - fresh.length, more: lockfiles.some(dir => dir.more > 0),
    toReview: review?.toReview ?? versions.filter(pkg => reviewOf(pkg, review) === 'wanted').length }
}

// The review of a version two directories lock, the less passing of theirs
// (reviewOf, one that can't be reviewed the least), of the fewer reviews
// where both want them; patched where either is.
const PASSING = { unsupported: 0, wanted: 1, passed: 2, baseline: 3 }
function bothReviewed(had, pkg, review) {
  const passing = one => PASSING[reviewOf(one, review)] ?? 4
  const less = passing(pkg) < passing(had) || (passing(pkg) === passing(had) && (pkg.reviews ?? Infinity) < (had.reviews ?? Infinity)) ? pkg : had
  const { unsupported, baseline, reviewed, reviews, rejected } = less
  const commented = Math.max(had.commented ?? 0, pkg.commented ?? 0)
  return { ...had.patched || pkg.patched ? { patched: true } : {}, ...unsupported ? { unsupported } : baseline ? { baseline } : reviewed ? { reviewed }
    : reviews == null ? {} : { reviews, ...rejected ? { rejected } : {}, ...commented > 0 ? { commented } : {} } }
}

// A version's review, where its pull request's is in effect (`review`):
// 'unsupported', where it can't be reviewed, 'baseline', needing none,
// 'passed', having as many reviews as required, no reviewer rejecting it, or
// the server's reviewed dependencies passing it, or 'wanted'; null where it
// tells none, a file of the project's, which isn't reviewed.
export function reviewOf(pkg, review) {
  if (!review) return null
  if (pkg.unsupported) return 'unsupported'
  if (pkg.baseline) return 'baseline'
  if (pkg.reviewed) return 'passed'
  if (pkg.reviews == null) return null
  return pkg.reviews >= review.required && !pkg.rejected ? 'passed' : 'wanted'
}

// The other versions an answer's lockfiles lock that want reviews, each once
// across its directories, and how many it counts in all (`count`), those it
// didn't send among them: as its review tells, each once, else as its
// directories do.
export function unreviewedVersions(answer) {
  return once('unreviewed', answer, () => unreviewed(answer))
}
function unreviewed({ lockfiles, review }) {
  const all = new Map()
  for (const pkg of lockfiles.flatMap(dir => dir.unreviewed ?? [])) {
    const key = `${pkg.name}@${pkg.version ?? ''}`
    if (!all.has(key)) all.set(key, pkg)
  }
  return { versions: [...all.values()], count: review?.unreviewed ?? all.size + lockfiles.reduce((more, dir) => more + (dir.moreUnreviewed ?? 0), 0) }
}

// What fails a pull request's review, where it is in effect: the versions
// its lockfiles lock that can't be reviewed, each once across its
// directories, and how many it counts in all (`count`, as its review tells,
// else as its directories do); the directories
// whose lockfiles couldn't be read (`unread`); how many versions they lock past those checked
// (`unchecked`); and whether it changes lockfiles left unread (`cut`). Null
// where nothing does.
export function reviewFailures(answer) {
  return once(answer.cut ? 'failures-cut' : 'failures', answer, () => failures(answer))
}
function failures({ lockfiles, cut, review }) {
  if (!review) return null
  const all = new Map()
  for (const pkg of lockfiles.flatMap(dir => dir.unsupported ?? [])) {
    const key = `${pkg.source}\0${pkg.name}@${pkg.version ?? ''}\0${pkg.from ?? ''}`
    if (!all.has(key)) all.set(key, pkg)
  }
  const sum = field => lockfiles.reduce((total, dir) => total + (dir[field] ?? 0), 0)
  const failed = { versions: [...all.values()], count: review.unsupported ?? all.size + sum('moreUnsupported'), unread: lockfiles.filter(dir => dir.error), unchecked: sum('moreLocked'), cut }
  return failed.count > 0 || failed.unread.length > 0 || failed.unchecked > 0 || cut ? failed : null
}
