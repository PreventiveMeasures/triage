// The reviewed dependencies a host keeps beyond the app, as it registers
// them before the server is assembled (server.ts registerReviewedDependencies):
// an async method telling whether a dependency, as a lockfile locks it, is
// reviewed there (`lookup`), and, optionally, one reading the reviews of
// dependencies an open pull request's comments make (`parseComments`,
// pull-comment-reviews.ts), and one formatting one's own dependency reviews
// as a comment, for a copy button to give (`formatDependencyReviews`,
// dependency-review-comments.ts). Registered, they replace the commit a repository
// is reviewed since (pull-dependency-reviews.ts): a version passes by the
// reviews its teams publish, and those its pull request's comments make, as
// many as the repository requires, or by `lookup`'s saying so, and is
// otherwise unreviewed. A patched version (pnpm's patchedDependencies)
// passes by `lookup`, or reviews its comments make of its patch, alone, the
// app reviewing no patch yet. Those comments' reviews count for the pull
// request alone, as it is open: the host's to keep, as it is merged, among
// those `lookup` tells of.
//
// Each version is asked of `lookup` once a request, as many at once as
// ASK_AT_ONCE, its answer kept in this instance KEPT_MS; one it fails to
// answer is unreviewed, and counted so (`unasked`).
import { type Lru, lru } from './lru.ts'

export type ReviewedLockfile = 'npm' | 'pnpm' | 'yarn1'
// A dependency as a lockfile locks it: npm's always with its integrity (one
// with none is never reviewed, nor asked of), its shasum where the lockfile
// has one (Yarn 1's, after a tarball's `#`), and the hash of its patch where
// it is patched (pnpm's).
export interface ReviewedDependency {
  ecosystem: 'npm'
  lockfile: ReviewedLockfile
  name: string
  version: string
  integrity?: string
  shasum?: string
  patchHash?: string
}
export type ReviewVerdict = 'accept' | 'accept-with-nits' | 'request-changes' | 'reject'
// A comment of an open pull request's, as `parseComments` is given it: one
// on the pull request (`comment`), a review's own (`review`, whatever its
// state, a comment's alone too), or one on a line of its diff
// (`review-comment`); by its author's GitHub login; when it was written, and
// last edited (`editedAt`) where it was.
export interface ReviewComment {
  kind: 'comment' | 'review' | 'review-comment'
  id: string
  author: string | null
  body: string
  state?: string
  createdAt: string
  editedAt?: string
  url: string
}
// What `parseComments` reads: the pull request, its comments, and the
// dependencies wanting reviews.
export interface ParseCommentsInput { repository: string; number: number; comments: ReviewComment[]; dependencies: ReviewedDependency[] }
// A review its comments make, by `user` (a GitHub login, one of their
// authors'), of each of `dependencies`, with its verdict, as of `time` (when
// it was made, an ISO date or milliseconds; that user's latest comment's
// where none is told).
export interface CommentReview {
  user: string
  time?: string | number
  dependencies: { ecosystem?: 'npm'; name: string; version: string; integrity: string; patchHash?: string; status: ReviewVerdict }[]
}
// A version a dependency review is of, or compared it with: its package's
// name, its version and integrity, and its tarball's shasum and its patch's
// hash where they are known (a lockfile's, pnpm's patched dependencies').
export interface ReviewedVersion { name: string; version: string; integrity: string; shasum?: string; patchHash?: string }
// One of one's own published dependency reviews, as `formatDependencyReviews`
// is given it: the version it is of (`new`) and the one it compared it with
// (`old`, none where it read its package whole); its verdict (`status`);
// whether it read every file (`coverage`, `full`, else `partial`); its final
// comment; each file's verdict and comment (`files`, of those with either);
// by whom (`reviewer`, their GitHub login), and when it was published.
export interface DependencyReviewEntry {
  ecosystem: 'npm'
  old: ReviewedVersion | null
  new: ReviewedVersion
  status: ReviewVerdict
  coverage: 'full' | 'partial'
  comment: string
  files: { path: string; status: ReviewVerdict | null; comment: string }[]
  reviewer: string
  publishedAt: number
}
// What `formatDependencyReviews` formats: one's own reviews, never another's,
// and the pull request whose versions they are of, where its copy asks.
export interface FormatDependencyReviewsInput { reviews: DependencyReviewEntry[]; pullRequest?: { repository: string; number: number } }
export interface ReviewedDependencies {
  lookup(dependency: ReviewedDependency): Promise<boolean>
  parseComments?(input: ParseCommentsInput): Promise<CommentReview[]>
  // The comment to copy, none where it is empty, null or undefined.
  formatDependencyReviews?(input: FormatDependencyReviewsInput): Promise<string | null | undefined>
}

const ASK_AT_ONCE = 16
const KEPT_MS = 60_000

let registered: ReviewedDependencies | null = null
let assembled = false
// Each lookup's answers, apart.
const answers = new WeakMap<ReviewedDependencies['lookup'], Lru<{ at: number; reviewed: boolean }>>()

// Registers the host's reviewed dependencies, once, before the server is
// assembled (init()): a server already assembled keeps what it was given.
export function registerReviewedDependencies(reviewed: ReviewedDependencies): void {
  const optional = (method: unknown) => method === undefined || typeof method === 'function'
  if (typeof reviewed?.lookup !== 'function' || !optional(reviewed.parseComments) || !optional(reviewed.formatDependencyReviews)) {
    throw new TypeError('registerReviewedDependencies: expected { lookup, parseComments?, formatDependencyReviews? }, async methods')
  }
  if (assembled) throw new Error('registerReviewedDependencies: call it before init(), as the server takes them as it is assembled')
  if (registered) throw new Error('registerReviewedDependencies: reviewed dependencies are registered already')
  registered = { lookup: reviewed.lookup.bind(reviewed), ...reviewed.parseComments ? { parseComments: reviewed.parseComments.bind(reviewed) } : {},
    ...reviewed.formatDependencyReviews ? { formatDependencyReviews: reviewed.formatDependencyReviews.bind(reviewed) } : {} }
}

// The reviewed dependencies registered, as a server takes them once it is
// assembled; none registers after.
export function assembledReviewedDependencies(): ReviewedDependencies | null {
  assembled = true
  return registered
}

// Which of `dependencies`, by their keys, `lookup` passes, and how many it
// failed to answer.
export async function askReviewed(lookup: ReviewedDependencies['lookup'], dependencies: Map<string, ReviewedDependency>): Promise<{ passed: Set<string>; unasked: number }> {
  const passed = new Set<string>()
  let unasked = 0
  const pending = [...dependencies]
  const kept = answers.get(lookup) ?? answers.set(lookup, lru(100_000)).get(lookup)!
  await Promise.all(Array.from({ length: Math.min(ASK_AT_ONCE, pending.length) }, async () => {
    for (let next = pending.pop(); next; next = pending.pop()) {
      const [key, dependency] = next
      const known = kept.get(key)
      let answer = known && Date.now() - known.at < KEPT_MS ? known.reviewed : null
      if (answer === null) {
        try { answer = await lookup({ ...dependency }) === true } catch (error) {
          unasked++
          console.warn('reviewed dependencies: failed to answer', `${dependency.name}@${dependency.version}`, error instanceof Error ? error.message : error)
          continue
        }
        kept.set(key, { at: Date.now(), reviewed: answer })
      }
      if (answer) passed.add(key)
    }
  }))
  return { passed, unasked }
}
