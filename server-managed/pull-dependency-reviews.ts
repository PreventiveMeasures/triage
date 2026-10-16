// What an open pull request's lockfiles' versions want of review, in a
// repository that reviews dependencies (repository-dependency-reviews.ts), as
// its tile and popup show it: each version it adds, whether it passes, by
// as many passing reviews as the repository requires (`reviews`), or needs
// none, being among those the repository's lockfiles locked at the commit it
// is reviewed since (`baseline`); apart from them, the other versions its
// lockfiles lock that neither passes nor needs none (`unreviewed`); and
// those that can't be reviewed (`unsupported`), which fail its review, as a
// lockfile it changes that isn't read does. Without that commit, every
// version wants its reviews.
//
// A version is reviewed as npm's registry has it, by its name, version and
// integrity: one locked of npm's registry, by its name or its link to its
// tarball (locked-packages.ts), with an integrity. One from git, another
// tarball (a mirror's too), or with no integrity can't be; a file of the
// project's isn't. Its reviews are those of it, of an integrity it is locked
// with, either whole, or compared with a version of its package: for a
// version the pull request adds, one it was; for another, any. Which
// versions the repository's lockfiles locked at that commit never changes:
// it is read once, every lockfile there of those read here
// (pull-dependencies.ts), and kept by the commit (`baselines` in this
// instance, `kept` beyond it), never stored as reviews.
import { createClient } from '@preventive/upstream/github.js'
import { upstreamGithub } from './github-errors.ts'
import { GithubApiError } from './github-app.ts'
import type { LockedPackage } from './locked-packages.ts'
import { type Lru, lru } from './lru.ts'
import { type AddedPackage, type DirectoryDependencies, type PullDependencies, lockedWith, lockfileFormat, readLockfile } from './pull-dependencies.ts'
import type { PassingReview, RepoReviewState } from './repository-dependency-reviews.ts'

// Lockfiles at a commit read for its versions, and the other versions told
// unreviewed, and those told unsupported, of each directory, those past them
// counted.
const MAX_BASELINE_LOCKFILES = 100
export const MAX_UNREVIEWED = 200

export interface ReviewBaselineStore { read(key: string): Promise<string[] | null>; write(key: string, versions: string[]): Promise<void> }
const baselines: Lru<Set<string>> = lru(500_000, versions => versions.size + 1)

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
// A version as a baseline holds it: its name and version with each hash.
const baselineKeys = (pkg: LockedPackage) => hashesOf(pkg).map(hash => `${pkg.name}@${pkg.version ?? ''}\0${hash}`)

// The versions the repository's lockfiles locked at commit `since` that are
// reviewed (reviewedAs), as kept, else read of GitHub and kept.
export async function reviewBaseline(fullName: string, token: string, repoId: number, since: string, kept: ReviewBaselineStore): Promise<Set<string>> {
  const key = `${repoId}\0${since}`
  const known = baselines.get(key)
  if (known) return known
  const stored = await kept.read(key)
  if (stored) { const versions = new Set(stored); baselines.set(key, versions); return versions }
  const { lockfiles } = await upstreamGithub(() => createClient({ token, userAgent: 'deepview-triage' }).findRepoLockfiles({ repo: fullName, sha: since }))
  const versions = new Set<string>()
  for (const { path } of lockfiles.slice(0, MAX_BASELINE_LOCKFILES)) {
    const format = lockfileFormat(path)
    if (!format) continue
    const read = await readLockfile(fullName, token, since, { path, format })
    for (const pkg of 'packages' in read ? read.packages : []) if (reviewedAs(pkg) === 'version') for (const held of baselineKeys(pkg)) versions.add(held)
  }
  baselines.set(key, versions)
  await kept.write(key, [...versions])
  return versions
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

// A version as the client is told it, its integrity left out.
function shown<T extends LockedPackage>(pkg: T): Omit<T, 'integrity'> {
  const copy = { ...pkg }
  delete copy.integrity
  return copy
}

// A directory as the client is told it: what it adds, each version with its
// review; the others its lockfiles lock that want reviews, and every one
// that can't be reviewed (as many of each as MAX_UNREVIEWED, how many more,
// once `capped`); and how many it locks past those read (`moreLocked`),
// which aren't checked; without `state`, what it adds alone.
function reviewedDirectory(dir: DirectoryDependencies, state: RepoReviewState | null, reviews: ReviewsOf, baseline: Set<string> | null) {
  if ('error' in dir) return dir
  const { locked, moreLocked, added, ...told } = dir
  if (!state) return { ...told, added: added.map(shown) }
  const review = (pkg: LockedPackage, bases: string[] | 'any') => {
    const as = reviewedAs(pkg)
    if (as === 'skip') return {}
    if (as !== 'version') return { unsupported: as }
    return baselineKeys(pkg).some(key => baseline?.has(key)) ? { baseline: true as const } : { reviews: reviewersOf(pkg, reviews, bases) }
  }
  const adds = new Set(added.map(lockedWith))
  const others = locked.filter(pkg => !adds.has(lockedWith(pkg))).map(pkg => ({ ...shown(pkg), ...review(pkg, 'any') }))
  const unreviewed = others.filter(pkg => 'reviews' in pkg && pkg.reviews < state.required)
  const unsupported = locked.flatMap(pkg => { const as = reviewedAs(pkg); return as === 'version' || as === 'skip' ? [] : [{ ...shown(pkg), unsupported: as }] })
  return { ...told, added: added.map((pkg: AddedPackage) => ({ ...shown(pkg), ...review(pkg, pkg.was ?? []) })), unreviewed, unsupported, moreLocked }
}
function capped<T extends { unreviewed: unknown[]; unsupported: unknown[] }>(dir: T) {
  return { ...dir, unreviewed: dir.unreviewed.slice(0, MAX_UNREVIEWED), moreUnreviewed: Math.max(0, dir.unreviewed.length - MAX_UNREVIEWED),
    unsupported: dir.unsupported.slice(0, MAX_UNREVIEWED), moreUnsupported: Math.max(0, dir.unsupported.length - MAX_UNREVIEWED) }
}
// How many versions of `lists` there are, each once across them, by `key`,
// as the client tells them once: one wanting reviews by its name and
// version, one that can't be reviewed by where it is from too.
const distinct = (lists: Omit<LockedPackage, 'integrity'>[][], key: (pkg: Omit<LockedPackage, 'integrity'>) => string) => new Set(lists.flat().map(key)).size
const versionKey = (pkg: Omit<LockedPackage, 'integrity'>) => `${pkg.name}@${pkg.version ?? ''}`
const sourceKey = (pkg: Omit<LockedPackage, 'integrity'>) => `${pkg.source}\0${versionKey(pkg)}\0${pkg.from ?? ''}`

// A pull request's dependencies as the client is told them: without the
// versions its directories lock; with `state`, a repository's review in
// effect, each version's review (reviewedDirectory), and the review's terms
// (`review`), with how many versions across its directories want reviews
// (`unreviewed`, those it adds aside) and can't be reviewed (`unsupported`),
// each once; where its baseline couldn't be read, why (`baselineError`),
// every version then wanting its reviews. It fails where a version can't be
// reviewed, a directory's lockfiles couldn't be read or lock more than are
// checked, or the pull request changes more lockfiles than are read (`cut`).
export function reviewedDependencies(told: PullDependencies, state: RepoReviewState | null, baseline: Set<string> | null, baselineError: string | null = null) {
  const reviews = reviewsByVersion(state?.reviews ?? [])
  const dirs = told.lockfiles.map(dir => reviewedDirectory(dir, state, reviews, baseline))
  if (!state) return { ...told, lockfiles: dirs }
  const listed = dirs.flatMap(dir => 'unreviewed' in dir ? [dir] : [])
  return { ...told, lockfiles: dirs.map(dir => 'unreviewed' in dir ? capped(dir) : dir), review: { required: state.required, since: state.since, canReview: state.canReview,
    unreviewed: distinct(listed.map(dir => dir.unreviewed), versionKey), unsupported: distinct(listed.map(dir => dir.unsupported), sourceKey),
    ...baselineError ? { baselineError } : {} } }
}

// The packages a pull request's lockfiles lock that are reviewed, whose
// reviews are asked.
export const reviewedPackages = (told: PullDependencies) => told.lockfiles
  .flatMap(dir => 'error' in dir ? [] : dir.locked.filter(pkg => reviewedAs(pkg) === 'version').map(pkg => pkg.name))

// A repository's baseline as read for a pull request: none where it reviews
// since no commit, and where GitHub doesn't read it, none and why.
export async function baselineFor(fullName: string, token: string, repoId: number, state: RepoReviewState, kept: ReviewBaselineStore) {
  if (!state.since) return { baseline: null, error: null }
  try {
    return { baseline: await reviewBaseline(fullName, token, repoId, state.since, kept), error: null }
  } catch (err) {
    if (err instanceof GithubApiError && err.status !== 429 && err.status !== 401) return { baseline: null, error: err.message }
    throw err
  }
}
