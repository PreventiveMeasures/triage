// The package versions a pull request's lockfiles add, as an open one's tile
// (repository-issues.js) and any one's popup (dialogs/repository-item-dialog.js)
// show them (GET /api/admin/repositories/pull-dependencies): read only of
// one GitHub says changes a lockfile, or may (`touchesLockfile`), READ_AT_ONCE
// at a time in the order asked, those of one repository waiting together
// asked together (SHOWN_TOGETHER, or READ_TOGETHER for those asked in the
// background, which go after the rest); held for the session a while, one
// grown old shown while read again; a team's Dependencies tab seeds them
// (seedPullDependencies). An open one's are asked with their review
// (server-managed/pull-dependency-reviews.ts): each version's, the others
// its lockfiles lock wanting reviews, and what fails it. While Stasis still
// builds a stasis.config.json its review holds to (`stasis-pending`), its
// answer is held a short while (PENDING_MS), then asked again.
import { state } from '#client/index.js'
import { fetchPullDependencies, fetchPullDependenciesOf } from './client-managed.js'
import { knowGithubUsers } from './github-users.js'
import { seedNpmDeltas } from './npm-delta.js'
import { isPatchPath } from '../../common/managed/npm-packages.js'

const KEEP_MS = 5 * 60_000
const RETRY_MS = 30_000
const PENDING_MS = 30_000
const READ_AT_ONCE = 2
const SHOWN_TOGETHER = 5
const READ_TOGETHER = 20

const held = new Map()
// Those waiting their turn, those asked in the background after (`behind`), by key (`queued`).
const waiting = []
const behind = []
const queued = new Map()
const listeners = new Set()
let keptFor = null
let reading = 0

// Calls `notify` as what is held changes, with its pull request (`{ repoId,
// number }`, none where all may have), till the returned function is called.
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

// A repository's review set anew (the admin's repository page): all held asked again.
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

// Whether a pull request's new packages are read: one GitHub says changes a lockfile, or may.
export const readsDependencies = item => item?.touchesLockfile === true || item?.touchesLockfile === null

const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null
// Why a version can't be reviewed, as its row says it.
export const UNSUPPORTED_WHY = { git: 'From git, which isn’t reviewed', tarball: 'A tarball not npm’s registry’s of its version, which isn’t reviewed',
  integrity: 'Locked with no integrity, which its reviews are held to',
  unlocked: 'Locked by none of the lockfiles read for it at its commit, so nothing holds its reviews to an integrity' }
const UNSUPPORTED = new Set(Object.keys(UNSUPPORTED_WHY))
// A directory telling a stasis.config.json Stasis is still building, which fails nothing yet.
export const isPending = dir => dir.error === 'stasis-pending'

// A version as one is told once: by name, version and patch hash, each patch reviewed apart.
export const versionKey = pkg => `${pkg.name}@${pkg.version ?? ''}\0${pkg.patch?.hash ?? ''}`

// A version as an answer names it: the versions it `was`, its `patch` (hash,
// and its file's path where known), its review where told (`unsupported`,
// `baseline`, `reviewed` by the server's reviewed dependencies, or how many
// `reviews` pass it, `rejected`, how many review it in its pull request's
// comments alone, `commented`, and its `reviewers`), whether only its
// lockfile asks for it (`unreached`), the `base` the host names to review it
// against, and the reader's own latest published review (`yours`).
function checkedVersion(pkg) {
  if (typeof pkg?.name !== 'string') return []
  const { was, base, reviews, rejected, commented, reviewers, baseline, reviewed, unsupported, patch, unreached, yours, ...version } = pkg
  const by = checkedReviewers(reviewers)
  return [{ ...version, ...Array.isArray(was) && was.length > 0 && was.every(other => typeof other === 'string') ? { was } : {},
    ...VERDICTS.has(yours?.status) ? { yours: { status: yours.status, ...yours.partial === true ? { partial: true } : {} } } : {},
    ...typeof base?.name === 'string' && typeof base.version === 'string' ? { base: { name: base.name, version: base.version } } : {},
    ...typeof patch?.hash === 'string' ? { patch: { hash: patch.hash, ...isPatchPath(patch.path) ? { path: patch.path } : {} } } : {},
    ...unreached === true ? { unreached } : {},
    ...UNSUPPORTED.has(unsupported) ? { unsupported } : baseline === true ? { baseline } : reviewed === true ? { reviewed }
      : count(reviews) === null ? {} : { reviews, ...rejected === true ? { rejected } : {}, ...count(commented) > 0 ? { commented } : {}, ...by.length > 0 ? { reviewers: by } : {} } }]
}
// Each reviewer of a version: login, latest verdict, whether they pass it,
// and whether it is its pull request's comments' (`comment`), counting there alone.
const VERDICTS = new Set(['accept', 'accept-with-nits', 'request-changes', 'reject'])
const checkedReviewers = list => Array.isArray(list) ? list.flatMap(one => typeof one?.login === 'string' && VERDICTS.has(one.status)
  ? [{ login: one.login, status: one.status, ...one.passes === true ? { passes: true } : {}, ...one.comment === true ? { comment: true } : {} }] : []) : []
const versionsOf = list => Array.isArray(list) ? list.flatMap(checkedVersion) : []

// A server's answer checked: its directories by their lockfiles' paths with
// their versions (checkedVersion), the commit its lockfiles were read at
// (`head`), its review's terms where told (counts across its directories,
// reviewed dependencies and bases, comment reviews, the lockfiles it holds
// to), the reader's reviews formatted to copy, whether it is into another
// branch than the default, and whether Stasis still builds one (`pending`).
export function checked(answer) {
  if (!Array.isArray(answer?.lockfiles)) throw new TypeError('The server answered with no lockfiles.')
  const lockfiles = answer.lockfiles.filter(dir => Array.isArray(dir?.paths) && (Array.isArray(dir.added) || typeof dir.error === 'string')).map(dir => dir.error ? dir
    : { ...dir, added: dir.added.flatMap(checkedVersion), more: count(dir.more) ?? 0, unreviewed: versionsOf(dir.unreviewed),
      moreUnreviewed: count(dir.moreUnreviewed) ?? 0, unsupported: versionsOf(dir.unsupported), moreUnsupported: count(dir.moreUnsupported) ?? 0,
      moreLocked: count(dir.moreLocked) ?? 0 })
  const review = answer.review
  return { lockfiles, cut: answer.cut === true, pending: lockfiles.some(isPending), ...typeof answer.head === 'string' && /^[\da-f]{40}$/u.test(answer.head) ? { head: answer.head } : {},
    ...typeof answer.formatted === 'string' && answer.formatted.trim() !== '' ? { formatted: answer.formatted } : {}, ...answer.intoOther === true ? { intoOther: true } : {},
    ...count(review?.required) > 0 ? { review: { required: review.required,
    since: typeof review.since === 'string' ? review.since : null, canReview: review.canReview === true,
    ...fieldsOf(review, ['toReview', 'unreviewed', 'unsupported'], value => count(value) !== null),
    ...fieldsOf(review, ['unasked', 'commentReviews'], value => count(value) > 0),
    ...fieldsOf(review, ['reviewedDependencies', 'reviewedBases', 'commentsFailed', 'byComments'], value => value === true),
    ...Array.isArray(review.baselineUnread) && review.baselineUnread.every(path => typeof path === 'string') ? { baselineUnread: review.baselineUnread } : {},
    ...typeof review.baselineError === 'string' ? { baselineError: review.baselineError } : {},
    ...['exclude', 'include'].includes(review.lockfiles?.mode) && Array.isArray(review.lockfiles.paths) && review.lockfiles.paths.every(path => typeof path === 'string')
      ? { lockfiles: { mode: review.lockfiles.mode, paths: review.lockfiles.paths } } : {} } } : {} }
}
// The `keys` of `from` whose values are `valid`.
const fieldsOf = (from, keys, valid) => Object.fromEntries(keys.filter(key => valid(from[key])).map(key => [key, from[key]]))

// The next asked read, READ_AT_ONCE at a time, with its repository's waiting
// alike (SHOWN_TOGETHER, or READ_TOGETHER in the background).
function readNext() {
  while (reading < READ_AT_ONCE && waiting.length + behind.length > 0) {
    const first = waiting.shift() ?? behind.shift()
    const [queue, together] = first.background ? [behind, READ_TOGETHER] : [waiting, SHOWN_TOGETHER]
    const jobs = [first]
    for (let at = 0; at < queue.length && jobs.length < together;) {
      const job = queue[at]
      if (job.pull.repoId === first.pull.repoId && job.review === first.review && job.listed === first.listed) jobs.push(...queue.splice(at, 1))
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
// `jobs`, one alone or a repository's together, each told its answer or why it failed.
function readOf(jobs) {
  const [{ pull: { repoId, number }, review, listed }] = jobs
  if (jobs.length === 1) return fetchPullDependencies(repoId, number, { review, listed }).then(jobs[0].settle, jobs[0].settle)
  return fetchPullDependenciesOf(repoId, jobs.map(job => job.pull.number), { review, listed }).then(answers => {
    for (const job of jobs) job.settle(answers.get(job.pull.number) ?? new Error('The server answered with none of it.'))
    return null
  }, err => { for (const job of jobs) job.settle(err) })
}

// What a pull request adds, as held, else asked: `{ status }`, 'loading',
// then 'ready' with its `lockfiles`, `cut` and (with `review`) its review's
// terms, or 'error'; asked again once old, shown as it was meanwhile
// (`refreshing`). One asked in the `background` is read after the rest; one
// `listed` (its tile asks by the commits its page names) held apart from
// its popup's, which a page kept from before a push tells none of.
export function pullDependencies(repoId, number, review = false, { background = false, listed = false } = {}) {
  const data = sessionHeld()
  const key = `${repoId}\0${number}\0${review}${listed ? '\0listed' : ''}`
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
    const next = answered(told, entry)
    if (next) data.set(key, next)
    else data.delete(key)
    if (next?.pending) toldAgain({ repoId, number })
  }
  const job = { key, background, review, listed, pull: { repoId, number }, settle }
  queued.set(key, job)
  ;(background ? behind : waiting).push(job)
  readNext()
  return loading
}

// Those showing `pull` told again once what it awaits may be built.
const toldAgain = pull => { setTimeout(() => changed(pull), PENDING_MS).unref?.() }

// What `told` is held as: an answer ready (one awaiting a build for less),
// else why it failed; on an abort, `entry` as read before, or none.
function answered(told, entry) {
  let failure = told instanceof Error ? told : null
  if (!failure) {
    try {
      // Its line counts held before its rows ask for them (npm-delta.js).
      if (Array.isArray(told?.deltas)) seedNpmDeltas(told.deltas)
      // The app's users it names kept: one telling none forgets none.
      const answer = checked(told?.users ? knowGithubUsers(told) : told)
      return { status: 'ready', until: Date.now() + (answer.pending ? PENDING_MS : KEEP_MS), ...answer }
    } catch (err) { failure = err }
  }
  if (failure?.name === 'AbortError') return entry?.status === 'ready' ? entry : null
  return { status: 'error', until: Date.now() + RETRY_MS, error: failure?.message || 'Its lockfiles could not be read.' }
}

// A repository's pull requests' answers told together (`answers`, by number,
// each an answer or an error), held as those asked are; one waiting its turn asked no more.
export function seedPullDependencies(repoId, answers, review = false) {
  const data = sessionHeld()
  for (const [number, told] of answers) {
    const key = `${repoId}\0${number}\0${review}`
    const job = queued.get(key)
    if (job) {
      const list = job.background ? behind : waiting
      list.splice(list.indexOf(job), 1)
      queued.delete(key)
    }
    const next = answered(told, null)
    if (next) data.set(key, next)
    if (next?.pending) toldAgain({ repoId, number })
    changed({ repoId, number })
  }
}

// What a pull request adds as held, however old, nothing asked: null where nothing is.
export function heldPullDependencies(repoId, number, review = false) {
  return sessionHeld().get(`${repoId}\0${number}\0${review}`) ?? null
}

// `work` of an answer's lockfiles and review, worked out once, as they never change.
const worked = new WeakMap()
function once(name, { lockfiles, review }, work) {
  const of = worked.get(lockfiles) ?? worked.set(lockfiles, new Map()).get(lockfiles)
  const known = of.get(name)
  if (known && known.review === review) return known.value
  const value = work()
  of.set(name, { review, value })
  return value
}

// What an answer tells new: each version once across its directories, new
// packages first (`fresh`, no `was`), then updates; how many of each;
// whether it tells more than it sends; and how many want reviews
// (`toReview`). One new in one directory and an update in another is an
// update, its review the less passing of theirs (bothReviewed).
export function addedVersions(answer) {
  return once('added', answer, () => added(answer))
}
function added({ lockfiles, review }) {
  const all = new Map()
  for (const pkg of lockfiles.flatMap(dir => dir.added ?? [])) {
    const key = versionKey(pkg)
    const had = all.get(key)
    if (!had) { all.set(key, pkg); continue }
    const { reviews: _reviews, baseline: _baseline, reviewed: _reviewed, unsupported: _unsupported, reviewers: _reviewers, base: _base, ...version } = had
    all.set(key, { ...version, ...pkg.was || had.was ? { was: [...new Set([...had.was ?? [], ...pkg.was ?? []])] } : {}, ...patchedOf(had, pkg),
      ...!had.yours && pkg.yours ? { yours: pkg.yours } : {}, ...bothReviewed(had, pkg, review) })
  }
  const versions = [...all.values()]
  const fresh = versions.filter(pkg => !pkg.was)
  return { versions: [...fresh, ...versions.filter(pkg => pkg.was)], fresh: fresh.length, updated: versions.length - fresh.length, more: lockfiles.some(dir => dir.more > 0),
    toReview: review?.toReview ?? versions.filter(pkg => reviewOf(pkg, review) === 'wanted').length }
}

// The patch of a version two directories lock patched alike: the first's,
// else the other's where only it tells its file, which a review needs.
const patchedOf = (had, pkg) => !had.patch?.path && pkg.patch?.path ? { patch: pkg.patch } : {}

// The review of a version two directories lock: the less passing of theirs
// (one that can't be reviewed the least), of fewer reviews where both want
// them, with its reviewers and `base`.
const PASSING = { unsupported: 0, wanted: 1, passed: 2, baseline: 3 }
function bothReviewed(had, pkg, review) {
  const passing = one => PASSING[reviewOf(one, review)] ?? 4
  const less = passing(pkg) < passing(had) || (passing(pkg) === passing(had) && (pkg.reviews ?? Infinity) < (had.reviews ?? Infinity)) ? pkg : had
  const { unsupported, baseline, reviewed, reviews, rejected, reviewers, base } = less
  const commented = Math.max(had.commented ?? 0, pkg.commented ?? 0)
  return { ...base ? { base } : {}, ...unsupported ? { unsupported } : baseline ? { baseline } : reviewed ? { reviewed }
    : reviews == null ? {} : { reviews, ...rejected ? { rejected } : {}, ...commented > 0 ? { commented } : {}, ...reviewers ? { reviewers } : {} } }
}

// A version's review where its pull request's is in effect: 'unsupported',
// 'baseline' (needing none), 'passed' (enough reviews and none rejecting,
// or the server's reviewed dependencies passing it) or 'wanted'; null where
// it tells none (a file of the project's).
export function reviewOf(pkg, review) {
  if (!review) return null
  if (pkg.unsupported) return 'unsupported'
  if (pkg.baseline) return 'baseline'
  if (pkg.reviewed) return 'passed'
  if (pkg.reviews == null) return null
  return pkg.reviews >= review.required && !pkg.rejected ? 'passed' : 'wanted'
}

// Whether `pkg` passes by its pull request's comments alone (`byComments`),
// which its reviewed dependencies take in only once merged.
export const passedByComments = (pkg, review) => Boolean(review?.byComments) && pkg.commented > 0 && !pkg.reviewed && reviewOf(pkg, review) === 'passed'

// The other versions an answer's lockfiles lock wanting reviews, each once,
// and how many in all (`count`, as its review tells, else its directories).
export function unreviewedVersions(answer) {
  return once('unreviewed', answer, () => unreviewed(answer))
}
function unreviewed({ lockfiles, review }) {
  const all = new Map()
  for (const pkg of lockfiles.flatMap(dir => dir.unreviewed ?? [])) {
    const key = versionKey(pkg)
    const had = all.get(key)
    all.set(key, had ? { ...had, ...patchedOf(had, pkg) } : pkg)
  }
  return { versions: [...all.values()], count: review?.unreviewed ?? all.size + lockfiles.reduce((more, dir) => more + (dir.moreUnreviewed ?? 0), 0) }
}

// What fails a pull request's review where in effect: the versions locked
// that can't be reviewed, each once, and how many (`count`); the directories
// whose lockfiles couldn't be read (`unread`, a Stasis build failed among
// them); how many versions past those checked (`unchecked`); and whether it
// changes lockfiles left unread (`cut`). Null where nothing does.
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
  const failed = { versions: [...all.values()], count: review.unsupported ?? all.size + sum('moreUnsupported'), unread: lockfiles.filter(dir => dir.error && !isPending(dir)), unchecked: sum('moreLocked'), cut }
  return failed.count > 0 || failed.unread.length > 0 || failed.unchecked > 0 || cut ? failed : null
}
