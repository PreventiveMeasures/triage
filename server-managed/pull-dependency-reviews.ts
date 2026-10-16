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
import { createClient } from '@preventive/upstream/github.js'
import { upstreamGithub } from './github-errors.ts'
import { GithubApiError } from './github-app.ts'
import type { LockedPackage } from './locked-packages.ts'
import { type Lru, lru } from './lru.ts'
import { type AddedPackage, type DirectoryDependencies, MAX_ADDED, type PullDependencies, lockedWith, lockfileFormat, readLockfile } from './pull-dependencies.ts'
import type { PassingReview, RepoReviewState } from './repository-dependency-reviews.ts'
import { type ReviewedDependencies, type ReviewedDependency, askReviewed } from './reviewed-dependencies.ts'

// Lockfiles at a commit read for its versions, and the other versions told
// unreviewed, and those told unsupported, of each directory, those past them
// counted.
const MAX_BASELINE_LOCKFILES = 100
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
// reviewed (reviewedAs), as kept, else read of GitHub and kept; with the
// lockfiles there its reader refuses, isn't one of, or past
// MAX_BASELINE_LOCKFILES (`unread`). GitHub having none of a lockfile it
// lists there is a failure of the whole, as of any file, never kept.
export async function reviewBaseline(fullName: string, token: string, repoId: number, since: string, kept: ReviewBaselineStore): Promise<Baseline> {
  const key = `${repoId}\0${since}`
  const known = baselines.get(key)
  if (known) return known
  const stored = await kept.read(key)
  if (stored) { const baseline = { versions: new Set(stored.versions), unread: stored.unread }; baselines.set(key, baseline); return baseline }
  const { lockfiles } = await upstreamGithub(() => createClient({ token, userAgent: 'deepview-triage' }).findRepoLockfiles({ repo: fullName, sha: since }))
  const read = lockfiles.flatMap(({ path }) => { const format = lockfileFormat(path); return format ? [{ path, format }] : [] })
  const versions = new Set<string>()
  const unread = read.slice(MAX_BASELINE_LOCKFILES).map(({ path }) => path)
  for (const lockfile of read.slice(0, MAX_BASELINE_LOCKFILES)) {
    const packages = await readLockfile(fullName, token, since, lockfile)
    if ('error' in packages && packages.error === 'github-not-found') throw new GithubApiError(404, 'github-not-found')
    if ('error' in packages) { unread.push(lockfile.path); continue }
    for (const pkg of packages.packages) if (reviewedAs(pkg) === 'version') for (const held of baselineKeys(pkg)) versions.add(held)
  }
  const baseline = { versions, unread: unread.toSorted() }
  baselines.set(key, baseline)
  await kept.write(key, { versions: [...versions], unread: baseline.unread })
  return baseline
}

// Passing reviews by the version they are of, its name and version.
type ReviewsOf = Map<string, PassingReview[]>
function reviewsByVersion(reviews: PassingReview[]): ReviewsOf {
  const by: ReviewsOf = new Map()
  for (const review of reviews) {
    const key = `${review.package}@${review.version}`
    const held = by.get(key)
    if (held) held.push(review)
    else by.set(key, [review])
  }
  return by
}

// Who passed `pkg` among `reviews`: those of its version, of an integrity
// it is locked with, whole or compared with one of `bases` of its package
// (any, for `any`), each reviewer once.
function reviewersOf(pkg: LockedPackage, reviews: ReviewsOf, bases: string[] | 'any') {
  const hashes = hashesOf(pkg)
  return new Set((reviews.get(`${pkg.name}@${pkg.version}`) ?? []).filter(review => hashes.includes(review.integrity)
    && (review.basePackage === null || (review.basePackage === pkg.name && (bases === 'any' || bases.includes(review.baseVersion ?? ''))))).map(review => review.reviewer)).size
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
type Review = { unsupported: Unsupported } | { baseline: true } | { reviewed: true } | { reviews: number } | Record<string, never>
interface Judged { review: Review; wants: boolean }
type Judge = (pkg: LockedPackage, bases: string[] | 'any') => Judged
interface Context { state: RepoReviewState; reviews: ReviewsOf; baseline: Set<string> | null }
function judge(pkg: LockedPackage, bases: string[] | 'any', { state, reviews, baseline }: Context): Judged {
  const as = reviewedAs(pkg)
  if (as === 'skip') return { review: {}, wants: false }
  if (as !== 'version') return { review: { unsupported: as }, wants: false }
  if (baselineKeys(pkg).some(key => baseline?.has(key))) return { review: { baseline: true }, wants: false }
  if (pkg.patchHash) return { review: {}, wants: true }
  const count = reviewersOf(pkg, reviews, bases)
  return { review: { reviews: count }, wants: count < state.required }
}

// A directory as the client is told it: what it adds, as many as MAX_ADDED,
// each version with its review (`review`, as judged), those past them judged
// as they are, against the versions they were, and how many of all want one
// (`toReview`); the others its lockfiles lock that want reviews, and every one
// that can't be reviewed (as many of each as MAX_UNREVIEWED, how many more,
// once `capped`); and how many it locks past those read (`moreLocked`), which
// aren't checked; without `review`, what it adds alone.
function reviewedDirectory(dir: DirectoryDependencies, review: Judge | null) {
  if ('error' in dir) return dir
  const { locked, moreLocked, added, ...told } = dir
  if (!review) return { ...told, added: added.slice(0, MAX_ADDED).map(shown) }
  const adds = new Set(added.map(lockedWith))
  const own = added.map((pkg: AddedPackage) => ({ pkg, judged: review(pkg, pkg.was ?? []) }))
  const others = locked.filter(pkg => !adds.has(lockedWith(pkg))).map(pkg => ({ pkg, judged: review(pkg, 'any') }))
  const unsupported = locked.flatMap(pkg => { const as = reviewedAs(pkg); return as === 'version' || as === 'skip' ? [] : [{ ...shown(pkg), unsupported: as }] })
  return { ...told, added: own.slice(0, MAX_ADDED).map(({ pkg, judged }) => ({ ...shown(pkg), ...judged.review })),
    toReview: own.filter(({ judged }) => judged.wants).map(({ pkg }) => shown(pkg)),
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

// A pull request's dependencies as the client is told them: without the
// versions its directories lock; with `state`, a repository's review in
// effect, each version's review (reviewedDirectory), those wanting one asked
// of the registered reviewed dependencies (`reviewed`), and the review's
// terms (`review`), with how many versions across its directories want
// reviews, of those it adds (`toReview`) and the rest (`unreviewed`), and
// can't be reviewed (`unsupported`), each once; how many the reviewed dependencies failed to
// answer (`unasked`), and whether they are registered (`reviewedDependencies`,
// the commit reviewed since then none); and where the baseline couldn't be
// read, why (`baselineError`), every version then wanting its reviews, or
// the lockfiles there left unread (`baselineUnread`), whose versions do. It
// fails where a version can't be reviewed, a directory's lockfiles couldn't
// be read or lock more than are checked, or the pull request changes more
// lockfiles than are read (`cut`).
export async function reviewedDependencies(told: PullDependencies, state: RepoReviewState | null,
  { baseline = null, baselineUnread = [], baselineError = null, reviewed = null }:
  { baseline?: Set<string> | null; baselineUnread?: string[]; baselineError?: string | null; reviewed?: ReviewedDependencies | null } = {}) {
  if (!state) return { ...told, lockfiles: told.lockfiles.map(dir => reviewedDirectory(dir, null)) }
  const context = { state, reviews: reviewsByVersion(state.reviews), baseline: reviewed ? null : baseline }
  // What wants a review here, as the reviewed dependencies are asked of.
  const asked = new Map<string, ReviewedDependency>()
  const asking: Judge = (pkg, bases) => {
    const judged = judge(pkg, bases, context)
    if (judged.wants) asked.set(...askedOf(pkg))
    return judged
  }
  if (reviewed) for (const dir of told.lockfiles) reviewedDirectory(dir, asking)
  const { passed, unasked } = asked.size > 0 && reviewed ? await askReviewed(reviewed, asked) : { passed: new Set<string>(), unasked: 0 }
  const dirs = told.lockfiles.map(dir => reviewedDirectory(dir, (pkg, bases) => {
    const judged = judge(pkg, bases, context)
    return judged.wants && passed.has(askedOf(pkg)[0]) ? { review: { reviewed: true }, wants: false } : judged
  }))
  const listed = dirs.flatMap(dir => 'unreviewed' in dir ? [dir] : [])
  return { ...told, lockfiles: dirs.map(dir => 'unreviewed' in dir ? capped(dir) : dir), review: { required: state.required,
    since: reviewed ? null : state.since, canReview: state.canReview, ...reviewed ? { reviewedDependencies: true } : {},
    toReview: distinct(listed.map(dir => dir.toReview), versionKey), unreviewed: distinct(listed.map(dir => dir.unreviewed), versionKey),
    unsupported: distinct(listed.map(dir => dir.unsupported), sourceKey),
    ...unasked > 0 ? { unasked } : {}, ...baselineError && !reviewed ? { baselineError } : {},
    ...baselineUnread.length > 0 && !reviewed ? { baselineUnread: baselineUnread.slice(0, MAX_UNREVIEWED) } : {} } }
}

// The packages a pull request's lockfiles lock that its reviews here may
// pass, whose reviews are asked: those that can be reviewed, unpatched.
export const reviewedPackages = (told: PullDependencies) => told.lockfiles
  .flatMap(dir => 'error' in dir ? [] : dir.locked.filter(pkg => reviewedAs(pkg) === 'version' && !pkg.patchHash).map(pkg => pkg.name))

// A repository's baseline as read for a pull request: its versions and the
// lockfiles there left unread; none where it reviews since no commit; and
// where GitHub doesn't read it, none and why.
export async function baselineFor(fullName: string, token: string, repoId: number, state: RepoReviewState, kept: ReviewBaselineStore) {
  if (!state.since) return { baseline: null, unread: [], error: null }
  try {
    const { versions, unread } = await reviewBaseline(fullName, token, repoId, state.since, kept)
    return { baseline: versions, unread, error: null }
  } catch (err) {
    if (err instanceof GithubApiError && err.status !== 429 && err.status !== 401) return { baseline: null, unread: [], error: err.message }
    throw err
  }
}
