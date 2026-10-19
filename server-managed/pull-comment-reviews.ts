// The reviews of dependencies an open pull request's comments make, as the
// host's parser reads them (reviewed-dependencies.ts `parseComments`): its
// comments, its reviews' own, whatever their state, and those on lines of
// its diff, read of GitHub's GraphQL API, as many as MAX_COMMENTS, with
// whether it is open, kept in this instance KEPT_MS; none of one not open;
// the parser's answer to the same kept PARSED_KEPT_MS.
// A review counts only where its user is one of their authors and the app's
// user that account is (by its numeric id, else its login, its linked
// accounts' too) publishes reviews to a team counting for the repository
// (`reviewers`): by that user, as their reviews here are, each once among
// them (pull-dependency-reviews.ts), as of its time, else their latest
// comment's. They count for the pull request alone, never stored.
import { createHash } from 'node:crypto'
import { ACTOR, type GraphAccount, actorOf } from './github-accounts.ts'
import { type Lru, lru } from './lru.ts'
import type { CommentReviews } from './pull-dependency-reviews.ts'
import type { PublishedReview } from './repository-dependency-reviews.ts'
import { githubGraphql } from './repository-history.ts'
import type { CommentReview, ParseCommentsInput, ReviewComment, ReviewVerdict, ReviewedDependencies } from './reviewed-dependencies.ts'

const MAX_COMMENTS = 1000
const KEPT_MS = 60_000
const PARSED_KEPT_MS = 10 * 60_000
const VERDICTS = new Set<string>(['accept', 'accept-with-nits', 'request-changes', 'reject'])

// A comment as read: when it was written, and last edited, where it was.
const COMMENT = `id author { ${ACTOR} } body createdAt lastEditedAt url`
// Its comments and its reviews, each a page on from its cursor, each only
// while it has more (`readComments`, `readReviews`).
const QUERY = `query($owner: String!, $name: String!, $number: Int!, $comments: String, $reviews: String, $readComments: Boolean!, $readReviews: Boolean!) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) { state
    comments(first: 100, after: $comments) @include(if: $readComments) { pageInfo { hasNextPage endCursor } nodes { ${COMMENT} } }
    reviews(first: 50, after: $reviews) @include(if: $readReviews) { pageInfo { hasNextPage endCursor }
      nodes { ${COMMENT} state comments(first: 100) { pageInfo { hasNextPage endCursor } nodes { ${COMMENT} } } } }
  } } }`
// A review's comments on lines of its diff, a page on from its cursor.
const REVIEW_COMMENTS = `query($id: ID!, $after: String) { node(id: $id) { ... on PullRequestReview {
  comments(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { ${COMMENT} } } } } }`

// A comment as read, and its author's account.
interface Authored { comment: ReviewComment; account: { login: string | null; id: number | null } }
type Page = { pageInfo?: { hasNextPage?: unknown; endCursor?: unknown }; nodes?: unknown }
type Node = { id?: unknown; author?: GraphAccount; body?: unknown; state?: unknown; createdAt?: unknown; lastEditedAt?: unknown; url?: unknown; comments?: Page }

// A pull request's comments as read, and whether it is open.
interface PullComments { open: boolean; read: Authored[] }
const comments: Lru<{ at: number } & PullComments> = lru(200)
const answers: Lru<{ at: number; reviews: CommentReview[] }> = lru(2000)

function authored(node: Node, kind: ReviewComment['kind']): Authored[] {
  if (typeof node?.id !== 'string' || typeof node.body !== 'string' || typeof node.createdAt !== 'string') return []
  const account = actorOf(node.author)
  return [{ account, comment: { kind, id: node.id, author: account.login, body: node.body, ...typeof node.state === 'string' ? { state: node.state } : {},
    createdAt: node.createdAt, ...typeof node.lastEditedAt === 'string' ? { editedAt: node.lastEditedAt } : {}, url: typeof node.url === 'string' ? node.url : '' } }]
}
const nodes = (list: unknown): Node[] => Array.isArray(list) ? list as Node[] : []
// The cursor a page ends at, where more follow it.
const next = (page: Page | undefined) => page?.pageInfo?.hasNextPage === true && typeof page.pageInfo.endCursor === 'string' ? page.pageInfo.endCursor : null

// Review `review`'s comments on lines of its diff: the page read with it,
// then those after it read of GitHub, till as many as `room` are.
async function inlineComments(review: Node, room: number, token: string, fetchImpl: typeof fetch): Promise<Authored[]> {
  const read = nodes(review.comments?.nodes).flatMap(inline => authored(inline, 'review-comment'))
  for (let after = typeof review.id === 'string' ? next(review.comments) : null; after !== null && read.length < room;) {
    const data = await githubGraphql(REVIEW_COMMENTS, { id: review.id, after }, token, fetchImpl) as { node?: { comments?: Page } | null } | null
    read.push(...nodes(data?.node?.comments?.nodes).flatMap(inline => authored(inline, 'review-comment')))
    after = next(data?.node?.comments)
  }
  return read
}

// Pull request `number`'s comments, its reviews' and those on its diff, each
// review's all of them, and whether it is open, as kept, else read of GitHub
// a page at a time.
export async function pullComments(fullName: string, token: string, number: number, fetchImpl: typeof fetch = globalThis.fetch): Promise<PullComments> {
  const key = `${fullName}\0${number}`
  const known = comments.get(key)
  if (known && Date.now() - known.at < KEPT_MS) return known
  const [owner, name] = fullName.split('/') as [string, string]
  const read: Authored[] = []
  let open: boolean | null = null
  // Each connection read on from its cursor till it has no more, the other
  // read on without it, never again from its first page.
  let cursors: { comments: string | null; reviews: string | null } = { comments: null, reviews: null }
  let reading = { comments: true, reviews: true }
  while ((reading.comments || reading.reviews) && read.length < MAX_COMMENTS) {
    const data = await githubGraphql(QUERY, { owner, name, number, ...cursors, readComments: reading.comments, readReviews: reading.reviews }, token, fetchImpl) as
      { repository?: { pullRequest?: { state?: unknown; comments?: Page; reviews?: Page } | null } | null } | null
    const pull = data?.repository?.pullRequest
    if (!pull) break
    open ??= pull.state === 'OPEN'
    for (const node of nodes(pull.comments?.nodes)) read.push(...authored(node, 'comment'))
    for (const node of nodes(pull.reviews?.nodes)) {
      read.push(...authored(node, 'review'))
      read.push(...await inlineComments(node, MAX_COMMENTS - read.length, token, fetchImpl))
    }
    cursors = { comments: reading.comments ? next(pull.comments) : null, reviews: reading.reviews ? next(pull.reviews) : null }
    reading = { comments: cursors.comments !== null, reviews: cursors.reviews !== null }
  }
  const kept = { open: open === true, read: read.slice(0, MAX_COMMENTS) }
  comments.set(key, { at: Date.now(), ...kept })
  return kept
}

// The parser's reviews of `input`, as kept for the same, else asked.
async function parsed(parse: NonNullable<ReviewedDependencies['parseComments']>, input: ParseCommentsInput): Promise<CommentReview[]> {
  const key = createHash('sha256').update(JSON.stringify(input)).digest('base64url')
  const known = answers.get(key)
  if (known && Date.now() - known.at < PARSED_KEPT_MS) return known.reviews
  const reviews = await parse(structuredClone(input))
  if (!Array.isArray(reviews)) throw new TypeError('parseComments answered with no list')
  answers.set(key, { at: Date.now(), reviews })
  return reviews
}

const when = (time: unknown) => typeof time === 'number' ? time : typeof time === 'string' ? Date.parse(time) : Number.NaN
// The reviews `answer` makes that count, by the users `reviewers` names,
// each dependency's of each hash its integrity names, as of the time it
// tells, else its user's latest comment's, as last written or edited.
function counted(answer: CommentReview[], read: Authored[], reviewers: Map<string, string>): PublishedReview[] {
  const latest = new Map<string, number>()
  for (const { comment } of read) {
    const login = comment.author?.toLowerCase()
    if (login) latest.set(login, Math.max(latest.get(login) ?? 0, when(comment.createdAt) || 0, when(comment.editedAt) || 0))
  }
  return answer.flatMap(review => {
    const login = typeof review?.user === 'string' ? review.user.toLowerCase() : ''
    const reviewer = reviewers.get(login)
    if (!reviewer || !latest.has(login) || !Array.isArray(review.dependencies)) return []
    const time = Number.isFinite(when(review.time)) ? when(review.time) : latest.get(login)!
    return review.dependencies.flatMap(dependency => {
      const { name, version, integrity, patchHash, status } = dependency ?? {}
      if (typeof name !== 'string' || typeof version !== 'string' || typeof integrity !== 'string' || !VERDICTS.has(status)) return []
      return integrity.split(/\s+/u).filter(Boolean).map(hash => ({ package: name, version, integrity: hash, ...typeof patchHash === 'string' && patchHash ? { patchHash } : {},
        basePackage: null, baseVersion: null, reviewer, login: review.user as string, status: status as ReviewVerdict, full: true, time }))
    })
  })
}

// The reviews pull request `number`'s comments make, as the host's parser
// reads them, of the versions still wanting one, none where it isn't open
// (the parser then not asked); `reviewers` the app's users
// the accounts are, by their logins in lower case, of those whose reviews
// count for the repository.
export function commentReviews({ fullName, number, token, parse, reviewers, fetchImpl = globalThis.fetch }: {
  fullName: string; number: number; token: string; parse: NonNullable<ReviewedDependencies['parseComments']>
  reviewers: (accounts: { login: string; githubId: number | null }[]) => Promise<Map<string, string>>; fetchImpl?: typeof fetch
}): CommentReviews {
  return async wanting => {
    try {
      const { open, read } = await pullComments(fullName, token, number, fetchImpl)
      if (!open) return { reviews: [], failed: false }
      const accounts = new Map(read.flatMap(({ account }) => account.login ? [[account.login.toLowerCase(), { login: account.login, githubId: account.id }]] : []))
      const answer = await parsed(parse, { repository: fullName, number, comments: read.map(({ comment }) => comment), dependencies: wanting })
      return { reviews: counted(answer, read, await reviewers([...accounts.values()])), failed: false }
    } catch (error) {
      console.warn('reviewed dependencies: comments of', `${fullName}#${number}`, 'not read:', error instanceof Error ? error.message : error)
      return { reviews: [], failed: true }
    }
  }
}
