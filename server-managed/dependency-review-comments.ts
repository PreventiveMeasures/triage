// The comment a host formats of one's own dependency reviews, for a copy
// button to give (reviewed-dependencies.ts `formatDependencyReviews`): of each
// of one's reviews, as their lists and the review page show them
// (`withFormatted`), and of those of the versions an open pull request adds
// (`formattedPull`). It is given one's own published reviews alone, never
// another's, a draft or a revoked one, however it is asked (`formatOwn`, the
// only caller of the hook); and is told of none where it answers nothing, or
// fails, which is logged.
import type { DependencyReview, DependencyReviewStore } from './dependency-reviews.ts'
import { type AddedPackage, type PullDependencies, eachOf } from './pull-dependencies.ts'
import type { PublishedReview, RepoReviewState } from './repository-dependency-reviews.ts'
import type { DependencyReviewEntry, ReviewedDependencies } from './reviewed-dependencies.ts'

const FORMAT_AT_ONCE = 8
// The longest comment told, past which none is.
const MAX_FORMATTED = 1_000_000
// The reviews of a pull request's versions read at once, those past them
// read after, every one formatted.
const REVIEWS_AT_ONCE = 200

// `review` as the hook is given it: each version with the integrity and
// shasum the review keeps of the tarball it read, and the version it is of
// with the patch `locked`, a pull request's lockfile, locks it with, where it
// is one's.
function entryOf(review: DependencyReview, locked?: AddedPackage | undefined): DependencyReviewEntry {
  return { ecosystem: 'npm', old: review.basePackage === null ? null : { name: review.basePackage, version: review.baseVersion ?? '', integrity: review.baseIntegrity ?? '',
      ...review.baseShasum ? { shasum: review.baseShasum } : {} },
    new: { name: review.package, version: review.version, integrity: review.integrity, ...review.shasum ? { shasum: review.shasum } : {},
      ...locked?.patchHash ? { patchHash: locked.patchHash } : {} },
    status: review.status!, coverage: review.coverage === 'full' ? 'full' : 'partial', comment: review.comment,
    files: review.entries.filter(entry => entry.status !== null || entry.comment.trim() !== '').map(entry => ({ path: entry.file, status: entry.status, comment: entry.comment })),
    reviewer: review.userLogin, publishedAt: review.publishedAt! }
}

// Whether `review` is `user`'s own, published, not revoked, with its verdict.
const ownPublished = (review: DependencyReview, user: string) => review.user === user && review.publishedAt !== null && review.revokedAt === null && review.status !== null

// What the host formats of `reviews`, of them `user`'s own published ones
// alone, and the pull request they are of the versions of, where it is
// one's; none where it formats none of them.
async function formatOwn(reviewed: ReviewedDependencies | null, user: string, reviews: { review: DependencyReview; locked?: AddedPackage | undefined }[],
  pullRequest?: { repository: string; number: number }): Promise<string | null> {
  const format = reviewed?.formatDependencyReviews
  const own = reviews.filter(({ review }) => ownPublished(review, user))
  if (!format || own.length === 0) return null
  try {
    const text = await format({ reviews: own.map(({ review, locked }) => entryOf(review, locked)), ...pullRequest ? { pullRequest } : {} })
    return typeof text === 'string' && text.trim() !== '' && text.length <= MAX_FORMATTED ? text : null
  } catch (error) {
    console.warn('reviewed dependencies: failed to format dependency reviews', error instanceof Error ? error.message : error)
    return null
  }
}

// `reviews`, each of `user`'s own with the comment the host formats of it
// (`formatted`), where it formats one; another's never asked of.
export function withFormatted<T extends DependencyReview>(reviewed: ReviewedDependencies | null, user: string, reviews: T[]): Promise<(T & { formatted?: string })[]> {
  if (!reviewed?.formatDependencyReviews) return Promise.resolve(reviews)
  return eachOf(reviews, FORMAT_AT_ONCE, async review => {
    const formatted = ownPublished(review, user) ? await formatOwn(reviewed, user, [{ review }]) : null
    return formatted ? { ...review, formatted } : review
  })
}

// Those of `reviews` `user` published of the versions `told` adds, by their
// ids, with each version as its lockfile locks it: of its version, of an
// integrity it is locked with and of its patch, whole or compared with a
// version it was.
function ownOfPull(told: PullDependencies, reviews: PublishedReview[], user: string): Map<string, AddedPackage> {
  // Theirs by the version they are of, each version probed once.
  const theirs = new Map<string, PublishedReview[]>()
  for (const review of reviews) {
    if (review.id === undefined || review.reviewer !== user) continue
    const key = `${review.package}@${review.version}`
    theirs.set(key, [...theirs.get(key) ?? [], review])
  }
  const mine = new Map<string, AddedPackage>()
  if (theirs.size === 0) return mine
  for (const pkg of told.lockfiles.flatMap(dir => 'added' in dir ? dir.added : [])) {
    const hashes = new Set((pkg.integrity ?? '').split(/\s+/u).filter(Boolean))
    for (const review of theirs.get(`${pkg.name}@${pkg.version}`) ?? []) {
      if (!hashes.has(review.integrity) || (review.patchHash ?? '') !== (pkg.patchHash ?? '')) continue
      if (review.basePackage === null || (review.basePackage === pkg.name && (pkg.was ?? []).includes(review.baseVersion ?? ''))) mine.set(review.id!, pkg)
    }
  }
  return mine
}

// The comment the host formats of `user`'s reviews of the versions pull
// request `number` of `repository` adds (`told`), those its review's state
// tells of, published to a team counting for it; none where it has none.
export async function formattedPull(reviewed: ReviewedDependencies | null, db: Pick<DependencyReviewStore, 'listOwnDependencyReviewsById'>, user: string,
  told: PullDependencies, state: RepoReviewState | null, pullRequest: { repository: string; number: number }): Promise<string | null> {
  if (!reviewed?.formatDependencyReviews || !state) return null
  const mine = ownOfPull(told, state.reviews, user)
  if (mine.size === 0) return null
  const ids = [...mine.keys()], reviews: DependencyReview[] = []
  for (let at = 0; at < ids.length; at += REVIEWS_AT_ONCE) reviews.push(...await db.listOwnDependencyReviewsById(user, ids.slice(at, at + REVIEWS_AT_ONCE)))
  return formatOwn(reviewed, user, reviews.map(review => ({ review, locked: mine.get(review.id) })), pullRequest)
}
