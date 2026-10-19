// What an open pull request's lockfiles' versions want of review, in a
// repository that reviews dependencies (repository-dependency-reviews.ts), as
// its tile and popup show it: each version it adds, whether it passes, by as
// many reviewers' reviews as the repository requires (`reviews`) or by the
// reviewed dependencies the host registers (`reviewed`,
// reviewed-dependencies.ts), or needs none, being among those the
// repository's lockfiles locked at the commit it is reviewed since
// (`baseline`); apart from them, the other versions its lockfiles lock that
// neither passes nor needs none (`unreviewed`); and those that can't be
// reviewed (`unsupported`), which fail its review, as a lockfile it changes
// that isn't read does. Without that commit, every version wants its
// reviews; registered reviewed dependencies replace it.
//
// A version is reviewed as npm's registry has it, by its name, version and
// integrity: one locked of npm's registry, by its name or its link to its
// tarball (locked-packages.ts), with an integrity. One from git, another
// tarball (a mirror's too), or with no integrity can't be; a file of the
// project's isn't. Its reviews are those of it, of an integrity it is locked
// with, either whole, or compared with a version of its package: for a
// version the pull request adds, one it was; for another, any. A patched one
// (`patched`) passes by none of them, the app reviewing no patch yet: only
// by the reviewed dependencies, or locked so, its patch too, at that commit.
// Which versions the repository's lockfiles locked at that commit never
// changes: it is read once, every lockfile there of those read here
// (pull-dependencies.ts), and kept by the commit (`baselines` in this
// instance, `kept` beyond it), never stored as reviews.
import { lockedAt, lockedIn } from './commit-lockfiles.ts'
import { GithubApiError } from './github-app.ts'
import type { LockedPackage } from './locked-packages.ts'
import { EVERY_LOCKFILE, type LockfileScope, heldTo, isEvery, reviewedIn } from './lockfile-scope.ts'
import { type Lru, lru } from './lru.ts'
import { type DirectoryDependencies, type GithubAsked, type LockfileStore, MAX_ADDED, type PullDependencies, lockedAs, lockedWith } from './pull-dependencies.ts'
import type { PublishedReview, RepoReviewState } from './repository-dependency-reviews.ts'
import { type ReviewedDependencies, type ReviewedDependency, askReviewed } from './reviewed-dependencies.ts'

// The other versions told unreviewed, and those told unsupported, of each
// directory, those past them counted.
export const MAX_UNREVIEWED = 200

// The versions a commit's lockfiles lock, and the lockfiles there that
// couldn't be read (`unread`), whose versions want reviews all the same.
export interface Baseline { versions: Set<string>; unread: string[] }
export interface ReviewBaselineStore {
  read(key: string): Promise<{ versions: string[]; unread: string[] } | null>
  write(key: string, value: { versions: string[]; unread: string[] }): Promise<void>
}
const baselines: Lru<Baseline> = lru(500_000, baseline => baseline.versions.size + baseline.unread.length + 1)

// Why a version can't be reviewed: from git, of a tarball not npm's
// registry's of its version, or locked with no integrity.
export type Unsupported = 'git' | 'tarball' | 'integrity'
// How a version is reviewed: by its name, version and integrity
// (`version`), not at all (`skip`), or why it can't be.
function reviewedAs(pkg: LockedPackage): 'version' | 'skip' | Unsupported {
  if (pkg.source === 'file') return 'skip'
  if (pkg.source === 'git') return 'git'
  if (pkg.source !== 'registry' || pkg.version === null) return 'tarball'
  return pkg.integrity ? 'version' : 'integrity'
}
// The hashes an integrity names, each of which is npm's of it.
const hashesOf = (pkg: LockedPackage) => (pkg.integrity ?? '').split(/\s+/u).filter(Boolean)
// A version as a baseline holds it: its name and version with each hash,
// and its patch.
const baselineKeys = (pkg: LockedPackage) => hashesOf(pkg).map(hash => `${pkg.name}@${pkg.version ?? ''}\0${hash}\0${pkg.patchHash ?? ''}`)

// The versions the repository's lockfiles locked at commit `since` that are
// reviewed (reviewedAs), as kept, else read of GitHub (commit-lockfiles.ts,
// its lockfiles as `reads` keeps them) and kept; with the lockfiles there its
// reader refuses, isn't one of, or past those read (`unread`). GitHub having
// none of a lockfile it lists there is a failure of the whole, as of any
// file, never kept.
export async function reviewBaseline(fullName: string, token: string, repoId: number, since: string, kept: ReviewBaselineStore, reads: LockfileStore | null = null,
  asked?: GithubAsked): Promise<Baseline> {
  const key = `${repoId}\0${since}`
  const known = baselines.get(key)
  if (known) return known
  const stored = await kept.read(key)
  if (stored) { const baseline = { versions: new Set(stored.versions), unread: stored.unread }; baselines.set(key, baseline); return baseline }
  const read = await lockedAt(fullName, token, since, reads, () => true, asked)
  const { packages } = lockedIn(read), { unread } = read
  const versions = new Set<string>()
  for (const pkg of packages) if (reviewedAs(pkg) === 'version') for (const held of baselineKeys(pkg)) versions.add(held)
  const baseline = { versions, unread }
  baselines.set(key, baseline)
  await kept.write(key, { versions: [...versions], unread: baseline.unread })
  return baseline
}

// Passing reviews by the version they are of, its name and version.
type ReviewsOf = Map<string, PublishedReview[]>
function reviewsByVersion(reviews: PublishedReview[]): ReviewsOf {
  const by: ReviewsOf = new Map()
  for (const review of reviews) {
    const key = `${review.package}@${review.version}`
    const held = by.get(key)
    if (held) held.push(review)
    else by.set(key, [review])
  }
  return by
}

const ACCEPTING = new Set(['accept', 'accept-with-nits'])
// Where `pkg`'s reviewers stand on it among `reviews`, those of its version,
// of an integrity it is locked with, and of its patch: each one's latest
// telling it, any rejecting it holding it unreviewed (`rejected`); those
// accepting it passing it (`passing`), each once, by a full, accepting
// review of theirs, whole or compared with one of `bases` of its package
// (any, for `any`); and how many review it in its pull request's comments
// alone (`commented`), which count for it alone: whose reviews passing it,
// else whose latest, are its comments'.
function stancesOf(pkg: LockedPackage, reviews: ReviewsOf, bases: string[] | 'any') {
  const hashes = hashesOf(pkg)
  const by = new Map<string, PublishedReview[]>()
  for (const review of reviews.get(`${pkg.name}@${pkg.version}`) ?? []) {
    if (!hashes.includes(review.integrity) || (review.patchHash ?? '') !== (pkg.patchHash ?? '')) continue
    by.set(review.reviewer, [...by.get(review.reviewer) ?? [], review])
  }
  const qualifies = (review: PublishedReview) => review.full && ACCEPTING.has(review.status)
    && (review.basePackage === null || (review.basePackage === pkg.name && (bases === 'any' || bases.includes(review.baseVersion ?? ''))))
  let commented = 0, passing = 0, rejected = false
  for (const theirs of by.values()) {
    const latest = theirs.reduce((one, other) => other.time > one.time ? other : one)
    // In its comments alone where those telling where they stand are: those
    // passing it, where they pass it, else their latest.
    const telling = ACCEPTING.has(latest.status) && theirs.some(qualifies) ? theirs.filter(qualifies) : [latest]
    if (telling.every(review => review.comment)) commented++
    if (latest.status === 'reject') rejected = true
    else if (ACCEPTING.has(latest.status) && theirs.some(qualifies)) passing++
  }
  return { passing, rejected, commented }
}

// A version as the client is told it: what its reviews are held to left
// out, but whether it is patched.
function shown<T extends LockedPackage>(pkg: T): Omit<T, 'integrity' | 'shasum' | 'patchHash' | 'lockfile'> & { patched?: true } {
  const copy = { ...pkg }
  for (const field of ['integrity', 'shasum', 'patchHash', 'lockfile'] as const) delete copy[field]
  return { ...copy, ...pkg.patchHash ? { patched: true as const } : {} }
}

// A version as the registered reviewed dependencies are asked of it, by
// what it is asked.
function askedOf(pkg: LockedPackage): [string, ReviewedDependency] {
  const dependency: ReviewedDependency = { ecosystem: 'npm', lockfile: pkg.lockfile ?? 'npm', name: pkg.name, version: pkg.version ?? '', integrity: pkg.integrity ?? '',
    ...pkg.shasum ? { shasum: pkg.shasum } : {}, ...pkg.patchHash ? { patchHash: pkg.patchHash } : {} }
  return [JSON.stringify(dependency), dependency]
}

// A version's review, and whether it wants one (`wants`), neither passing
// nor needing none, as only one that can be reviewed may.
type Review = { unsupported: Unsupported } | { baseline: true } | { reviewed: true } | { reviews: number; rejected?: true; commented?: number } | Record<string, never>
interface Judged { review: Review; wants: boolean }
type Judge = (pkg: LockedPackage, bases: string[] | 'any') => Judged
interface Context { state: RepoReviewState; reviews: ReviewsOf; baseline: Set<string> | null }
function judge(pkg: LockedPackage, bases: string[] | 'any', { state, reviews, baseline }: Context): Judged {
  const as = reviewedAs(pkg)
  if (as === 'skip') return { review: {}, wants: false }
  if (as !== 'version') return { review: { unsupported: as }, wants: false }
  if (baselineKeys(pkg).some(key => baseline?.has(key))) return { review: { baseline: true }, wants: false }
  const { passing, rejected, commented } = stancesOf(pkg, reviews, bases)
  const told = { reviews: passing, ...commented > 0 ? { commented } : {} }
  if (rejected) return { review: { ...told, rejected: true }, wants: true }
  return { review: told, wants: passing < state.required }
}

// A directory as the client is told it: what it adds, as many as MAX_ADDED,
// each version with its review (`review`, as judged), those past them judged
// as they are, against the versions they were, as is every one its lockfiles
// lock of them (another integrity of it, say), each told by the least passing
// of them, and those of all that want one (`toReview`); the others its lockfiles lock that want reviews, and every one
// that can't be reviewed (as many of each as MAX_UNREVIEWED, how many more,
// once `capped`); and how many it locks past those read (`moreLocked`), which
// aren't checked; without `review`, what it adds alone.
function reviewedDirectory(dir: DirectoryDependencies, review: Judge | null) {
  if ('error' in dir) return dir
  const { locked, moreLocked, added, ...told } = dir
  if (!review) return { ...told, added: added.slice(0, MAX_ADDED).map(shown) }
  const adds = new Map(added.map(pkg => [lockedAs(pkg), { pkg, variants: [pkg] }]))
  for (const pkg of locked) {
    const of = adds.get(lockedAs(pkg))
    if (of && lockedWith(pkg) !== lockedWith(of.pkg)) of.variants.push(pkg)
  }
  const own = [...adds.values()].map(({ pkg, variants }) => {
    const judged = variants.map(variant => ({ variant, ...review(variant, pkg.was ?? []) }))
    const least = judged.find(one => 'unsupported' in one.review) ?? judged.find(one => one.wants) ?? judged[0]!
    return { pkg, judged: least, wanting: judged.filter(one => one.wants).map(({ variant }) => variant) }
  })
  const others = locked.filter(pkg => !adds.has(lockedAs(pkg))).map(pkg => ({ pkg, judged: review(pkg, 'any') }))
  const unsupported = locked.flatMap(pkg => { const as = reviewedAs(pkg); return as === 'version' || as === 'skip' ? [] : [{ ...shown(pkg), unsupported: as }] })
  return { ...told, added: own.slice(0, MAX_ADDED).map(({ pkg, judged }) => ({ ...shown(pkg), ...judged.review })),
    toReview: own.flatMap(({ wanting }) => wanting.map(shown)),
    unreviewed: others.filter(({ judged }) => judged.wants).map(({ pkg, judged }) => ({ ...shown(pkg), ...judged.review })), unsupported, moreLocked }
}
function capped<T extends { toReview: unknown[]; unreviewed: unknown[]; unsupported: unknown[] }>({ toReview: _toReview, ...dir }: T) {
  return { ...dir, unreviewed: dir.unreviewed.slice(0, MAX_UNREVIEWED), moreUnreviewed: Math.max(0, dir.unreviewed.length - MAX_UNREVIEWED),
    unsupported: dir.unsupported.slice(0, MAX_UNREVIEWED), moreUnsupported: Math.max(0, dir.unsupported.length - MAX_UNREVIEWED) }
}
// How many versions of `lists` there are, each once across them, by `key`,
// as the client tells them once: one wanting reviews by its name and
// version, one that can't be reviewed by where it is from too.
type Shown = Pick<LockedPackage, 'name' | 'version' | 'source' | 'from'>
const distinct = (lists: Shown[][], key: (pkg: Shown) => string) => new Set(lists.flat().map(key)).size
const versionKey = (pkg: Shown) => `${pkg.name}@${pkg.version ?? ''}`
const sourceKey = (pkg: Shown) => `${pkg.source}\0${versionKey(pkg)}\0${pkg.from ?? ''}`

// The reviews an open pull request's comments make of `wanting`, the
// versions still wanting one (pull-comment-reviews.ts): those that count,
// and whether they couldn't be read.
export type CommentReviews = (wanting: ReviewedDependency[]) => Promise<{ reviews: PublishedReview[]; failed: boolean }>

// What a pull request's lockfiles lock, but in directories none of whose
// lockfiles `scope` holds to, as they aren't reviewed: left out, as lockfiles
// left unread are where it holds to none of them (`omitted`, told to none).
export function heldDependencies<T extends PullDependencies>(told: T, scope: LockfileScope): Omit<T, 'omitted'> {
  const { omitted, ...answered } = told
  if (isEvery(scope)) return answered
  return { ...answered, cut: told.cut && !(omitted && !omitted.some(path => heldTo(scope, path))), lockfiles: told.lockfiles.filter(dir => reviewedIn(scope, dir.paths)) }
}

// A pull request's dependencies as the client is told them: without the
// versions its directories lock; with `state`, a repository's review in
// effect, each version's review (reviewedDirectory), those wanting one asked
// of the registered reviewed dependencies (`reviewed`), and those still
// wanting one of the reviews its comments make (`commentReviews`, where the
// host reads them), and the review's terms (`review`), with how many
// reviewers' its comments count (`commentReviews`), or that they couldn't be
// read (`commentsFailed`), and how many versions across its directories want
// reviews, of those it adds (`toReview`) and the rest (`unreviewed`), and
// can't be reviewed (`unsupported`), each once; how many the reviewed dependencies failed to
// answer (`unasked`), and whether they are registered (`reviewedDependencies`,
// the commit reviewed since then none); and where the baseline couldn't be
// read, why (`baselineError`), every version then wanting its reviews, or
// the lockfiles there left unread (`baselineUnread`), whose versions do. It
// fails where a version can't be reviewed, a directory's lockfiles couldn't
// be read or lock more than are checked, or the pull request changes more
// lockfiles than are read (`cut`). Those of directories none of whose
// lockfiles the review holds to (`lockfiles`, lockfile-scope.ts, told in its
// terms where not every one) are left out (heldDependencies).
export async function reviewedDependencies(told: PullDependencies, state: RepoReviewState | null,
  { baseline = null, baselineUnread = [], baselineError = null, reviewed = null, commentReviews = null }: { baseline?: Set<string> | null; baselineUnread?: string[]
    baselineError?: string | null; reviewed?: ReviewedDependencies | null; commentReviews?: CommentReviews | null } = {}) {
  const scope = state?.lockfiles ?? EVERY_LOCKFILE
  const answered = heldDependencies(told, scope)
  if (!state) return { ...answered, lockfiles: answered.lockfiles.map(dir => reviewedDirectory(dir, null)) }
  const { cut, lockfiles: held } = answered
  let context = { state, reviews: reviewsByVersion(state.reviews), baseline: reviewed ? null : baseline }
  // What wants a review, as `lookup` is asked of, each once.
  const wanting = () => {
    const asked = new Map<string, ReviewedDependency>()
    const asking: Judge = (pkg, bases) => {
      const judged = judge(pkg, bases, context)
      if (judged.wants) asked.set(...askedOf(pkg))
      return judged
    }
    for (const dir of held) reviewedDirectory(dir, asking)
    return asked
  }
  const passed = new Set<string>()
  let unasked = 0
  const ask = async (asked: Map<string, ReviewedDependency>) => {
    const answer = asked.size > 0 && reviewed ? await askReviewed(reviewed.lookup, asked) : { passed: new Set<string>(), unasked: 0 }
    for (const key of answer.passed) passed.add(key)
    unasked += answer.unasked
  }
  const asked = wanting()
  await ask(asked)
  // Of those still wanting one, and every other one the lockfiles it holds
  // to add that its teams' reviews pass, telling other pull requests those
  // it reviews (`commented`), but those `lookup` passes, reviewed, the
  // reviews its comments make, an open one's alone (pull-comment-reviews.ts),
  // which count as its teams' do; those their rejects hold asked of `lookup`
  // too.
  const parsing = new Map([...asked].filter(([key]) => !passed.has(key)))
  if (commentReviews) {
    const others = new Map<string, ReviewedDependency>()
    for (const pkg of held.flatMap(dir => 'added' in dir ? dir.added : [])) {
      const [key, dependency] = askedOf(pkg)
      if (!asked.has(key) && 'reviews' in judge(pkg, pkg.was ?? [], context).review) others.set(key, dependency)
    }
    const vouched = others.size > 0 && reviewed ? (await askReviewed(reviewed.lookup, others)).passed : new Set<string>()
    for (const [key, dependency] of others) if (!vouched.has(key)) parsing.set(key, dependency)
  }
  const comments = parsing.size > 0 && commentReviews ? await commentReviews([...parsing.values()]) : { reviews: [], failed: false }
  if (comments.reviews.length > 0) {
    context = { ...context, reviews: reviewsByVersion([...state.reviews, ...comments.reviews.map(review => ({ ...review, comment: true as const }))]) }
    await ask(new Map([...wanting()].filter(([key]) => !asked.has(key))))
  }
  const dirs = held.map(dir => reviewedDirectory(dir, (pkg, bases) => {
    const judged = judge(pkg, bases, context)
    return judged.wants && passed.has(askedOf(pkg)[0]) ? { review: { reviewed: true }, wants: false } : judged
  }))
  const unread = baselineUnread.filter(path => heldTo(scope, path))
  const listed = dirs.flatMap(dir => 'unreviewed' in dir ? [dir] : [])
  return { ...answered, cut, lockfiles: dirs.map(dir => 'unreviewed' in dir ? capped(dir) : dir), review: { required: state.required,
    since: reviewed ? null : state.since, canReview: state.canReview, ...reviewed ? { reviewedDependencies: true } : {},
    toReview: distinct(listed.map(dir => dir.toReview), versionKey), unreviewed: distinct(listed.map(dir => dir.unreviewed), versionKey),
    unsupported: distinct(listed.map(dir => dir.unsupported), sourceKey),
    ...unasked > 0 ? { unasked } : {}, ...baselineError && !reviewed ? { baselineError } : {},
    ...comments.reviews.length > 0 ? { commentReviews: new Set(comments.reviews.map(review => review.reviewer)).size } : {}, ...comments.failed ? { commentsFailed: true } : {},
    ...unread.length > 0 && !reviewed ? { baselineUnread: unread.slice(0, MAX_UNREVIEWED) } : {}, ...isEvery(scope) ? {} : { lockfiles: scope } } }
}

// The package versions a pull request's lockfiles lock that its reviews here
// may pass, whose reviews are asked: those that can be reviewed, unpatched.
export const reviewedPackages = (told: PullDependencies) => told.lockfiles
  .flatMap(dir => 'error' in dir ? [] : dir.locked.filter(pkg => reviewedAs(pkg) === 'version' && !pkg.patchHash).map(pkg => ({ name: pkg.name, version: pkg.version! })))

// A repository's baseline as read for a pull request: its versions and the
// lockfiles there left unread; none where it reviews since no commit; and
// where GitHub doesn't read it, none and why.
export async function baselineFor(fullName: string, token: string, repoId: number, state: RepoReviewState, kept: ReviewBaselineStore, reads: LockfileStore | null,
  asked?: GithubAsked) {
  if (!state.since) return { baseline: null, unread: [], error: null }
  try {
    const { versions, unread } = await reviewBaseline(fullName, token, repoId, state.since, kept, reads, asked)
    return { baseline: versions, unread, error: null }
  } catch (err) {
    if (err instanceof GithubApiError && err.status !== 429 && err.status !== 401) return { baseline: null, unread: [], error: err.message }
    throw err
  }
}
