// The comment a host formats of one's own dependency reviews, for a copy
// button to give (reviewed-dependencies.ts `formatDependencyReviews`): of each
// of one's reviews, as their lists and the review page show them
// (`withFormatted`), and of those of the versions an open pull request adds
// (`formattedPull`), but the versions the host's `lookup` passes already,
// which want no review there, and those one's own comments there review
// alike already. It is given one's own published reviews alone, never
// another's, a draft or a revoked one, however it is asked (`formatOwn`, the
// only caller of the hook); and is told of none where it answers nothing, or
// fails, which is logged.
import type { DependencyReview, DependencyReviewStore } from './dependency-reviews.ts'
import type { LockedPackage } from './locked-packages.ts'
import type { PullDependencies } from './pull-dependencies.ts'
import { askedOf, comparedWith, reviewsByVersion, reviewsOf } from './pull-dependency-reviews.ts'
import { eachOf } from './queue.ts'
import type { PublishedReview, RepoReviewState } from './repository-dependency-reviews.ts'
import { type DependencyReviewEntry, type ReviewedDependencies, askReviewed } from './reviewed-dependencies.ts'

const FORMAT_AT_ONCE = 8
// The longest comment told, past which none is.
const MAX_FORMATTED = 1_000_000
// The reviews of a pull request's versions read at once, those past them
// read after, every one formatted.
const REVIEWS_AT_ONCE = 200

// `review` as the hook is given it: each version with the integrity and
// shasum the review keeps of the tarball it read, and the patch it is of,
// where it is a patched one's.
function entryOf(review: DependencyReview): DependencyReviewEntry {
  return { ecosystem: 'npm', old: review.basePackage === null ? null : { name: review.basePackage, version: review.baseVersion ?? '', integrity: review.baseIntegrity ?? '',
      ...review.baseShasum ? { shasum: review.baseShasum } : {}, ...review.basePatchHash ? { patchHash: review.basePatchHash } : {} },
    new: { name: review.package, version: review.version, integrity: review.integrity, ...review.shasum ? { shasum: review.shasum } : {},
      ...review.patchHash ? { patchHash: review.patchHash } : {} },
    status: review.status!, coverage: review.coverage === 'full' ? 'full' : 'partial', comment: review.comment,
    files: review.entries.filter(entry => entry.status !== null || entry.comment.trim() !== '').map(entry => ({ path: entry.file, status: entry.status, comment: entry.comment })),
    reviewer: review.userLogin, publishedAt: review.publishedAt! }
}

// Whether `review` is `user`'s own, published, not revoked, with its verdict.
const ownPublished = (review: DependencyReview, user: string) => review.user === user && review.publishedAt !== null && review.revokedAt === null && review.status !== null

// What the host formats of `reviews`, of them `user`'s own published ones
// alone, and the pull request they are of the versions of, where it is
// one's; none where it formats none of them.
async function formatOwn(reviewed: ReviewedDependencies | null, user: string, reviews: DependencyReview[],
  pullRequest?: { repository: string; number: number }): Promise<string | null> {
  const format = reviewed?.formatDependencyReviews
  const own = reviews.filter(review => ownPublished(review, user))
  if (!format || own.length === 0) return null
  try {
    const text = await format({ reviews: own.map(entryOf), ...pullRequest ? { pullRequest } : {} })
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
    const formatted = ownPublished(review, user) ? await formatOwn(reviewed, user, [review]) : null
    return formatted ? { ...review, formatted } : review
  })
}

// Those of `reviews` `user` published of the versions `told` adds, by their
// ids, each with the versions it is of, as its lockfiles lock each: of its
// version, of an integrity it is locked with and of its patch, whole or
// compared with a version it was (pull-dependency-reviews.ts reviewsOf,
// comparedWith), or, `any`, with any version of its package.
interface Own { review: PublishedReview; pkgs: LockedPackage[] }
function ownOfPull(told: PullDependencies, reviews: PublishedReview[], user: string, any: boolean): Map<string, Own> {
  // Theirs by the version they are of, each version probed once.
  const theirs = reviewsByVersion(reviews.filter(review => review.id !== undefined && review.reviewer === user))
  const mine = new Map<string, Own>()
  if (theirs.size === 0) return mine
  for (const pkg of told.lockfiles.flatMap(dir => 'added' in dir ? dir.added : [])) {
    for (const review of reviewsOf(pkg, theirs)) {
      if (comparedWith(review, pkg, any ? 'any' : pkg.was ?? [])) (mine.get(review.id!) ?? mine.set(review.id!, { review, pkgs: [] }).get(review.id!)!).pkgs.push(pkg)
    }
  }
  return mine
}

// The comment the host formats of `user`'s reviews of the versions pull
// request `number` of `repository` adds (`told`), those its review's state
// tells of, published to a team counting for it; none where it has none.
// A review is left out where every version it is of, as locked, wants no
// comment of it there: the host's `lookup` passes it already, or `user`'s
// own comments there (of `commented`, the reviews its comments make) review
// it with the same verdict, as copying it would but repeat them: by their
// latest of it, which tells where they stand there (pull-dependency-
// reviews.ts stancesOf), an older one of that verdict not counting. A
// version `lookup` fails to answer of keeps its review. Where the host reads
// reviews of comments (`parseComments`), what a review was compared with is
// its to weigh, so one compared with any version is given.
export async function formattedPull(reviewed: ReviewedDependencies | null, db: Pick<DependencyReviewStore, 'listOwnDependencyReviewsById'>, user: string,
  told: PullDependencies, state: RepoReviewState | null, pullRequest: { repository: string; number: number }, commented: PublishedReview[] = []): Promise<string | null> {
  if (!reviewed?.formatDependencyReviews || !state) return null
  const mine = ownOfPull(told, state.reviews, user, reviewed.parseComments !== undefined)
  if (mine.size === 0) return null
  const { passed } = await askReviewed(reviewed.lookup, new Map([...mine.values()].flatMap(({ pkgs }) => pkgs.map(askedOf))))
  const there = reviewsByVersion(commented.filter(review => review.reviewer === user))
  const stands = (pkg: LockedPackage) => reviewsOf(pkg, there).reduce<PublishedReview | null>((one, other) => one && one.time >= other.time ? one : other, null)?.status
  const ids = [...mine].filter(([, { review, pkgs }]) => pkgs.some(pkg => !passed.has(askedOf(pkg)[0]) && stands(pkg) !== review.status)).map(([id]) => id)
  if (ids.length === 0) return null
  const reviews: DependencyReview[] = []
  for (let at = 0; at < ids.length; at += REVIEWS_AT_ONCE) reviews.push(...await db.listOwnDependencyReviewsById(user, ids.slice(at, at + REVIEWS_AT_ONCE)))
  return formatOwn(reviewed, user, reviews, pullRequest)
}
