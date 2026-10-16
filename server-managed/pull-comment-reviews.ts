// The reviews of dependencies an open pull request's comments make, as the
// host's parser reads them (reviewed-dependencies.ts `parseComments`): its
// comments, its reviews' own, whatever their state, and those on lines of
// its diff, read of GitHub's GraphQL API, as many as MAX_COMMENTS, kept in
// this instance KEPT_MS; the parser's answer to the same kept PARSED_KEPT_MS.
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

const QUERY = `query($owner: String!, $name: String!, $number: Int!, $comments: String, $reviews: String) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) {
    comments(first: 100, after: $comments) { pageInfo { hasNextPage endCursor } nodes { id author { ${ACTOR} } body createdAt url } }
    reviews(first: 50, after: $reviews) { pageInfo { hasNextPage endCursor }
      nodes { id author { ${ACTOR} } body state createdAt url comments(first: 100) { nodes { id author { ${ACTOR} } body createdAt url } } } }
  } } }`

// A comment as read, and its author's account.
interface Authored { comment: ReviewComment; account: { login: string | null; id: number | null } }
type Node = { id?: unknown; author?: GraphAccount; body?: unknown; state?: unknown; createdAt?: unknown; url?: unknown; comments?: { nodes?: unknown } }
type Page = { pageInfo?: { hasNextPage?: unknown; endCursor?: unknown }; nodes?: unknown }

const comments: Lru<{ at: number; read: Authored[] }> = lru(200)
const answers: Lru<{ at: number; reviews: CommentReview[] }> = lru(2000)

function authored(node: Node, kind: ReviewComment['kind']): Authored[] {
  if (typeof node?.id !== 'string' || typeof node.body !== 'string' || typeof node.createdAt !== 'string') return []
  const account = actorOf(node.author)
  return [{ account, comment: { kind, id: node.id, author: account.login, body: node.body, ...typeof node.state === 'string' ? { state: node.state } : {},
    createdAt: node.createdAt, url: typeof node.url === 'string' ? node.url : '' } }]
}
const nodes = (list: unknown): Node[] => Array.isArray(list) ? list as Node[] : []

// Pull request `number`'s comments, its reviews' and those on its diff, as
// kept, else read of GitHub a page at a time.
export async function pullComments(fullName: string, token: string, number: number, fetchImpl: typeof fetch = globalThis.fetch): Promise<Authored[]> {
  const key = `${fullName}\0${number}`
  const known = comments.get(key)
  if (known && Date.now() - known.at < KEPT_MS) return known.read
  const [owner, name] = fullName.split('/') as [string, string]
  const read: Authored[] = []
  let cursors: { comments: string | null; reviews: string | null } = { comments: null, reviews: null }
  for (let more = true; more && read.length < MAX_COMMENTS;) {
    const data = await githubGraphql(QUERY, { owner, name, number, ...cursors }, token, fetchImpl) as
      { repository?: { pullRequest?: { comments?: Page; reviews?: Page } | null } | null } | null
    const pull = data?.repository?.pullRequest
    if (!pull) break
    for (const node of nodes(pull.comments?.nodes)) read.push(...authored(node, 'comment'))
    for (const node of nodes(pull.reviews?.nodes)) {
      read.push(...authored(node, 'review'))
      for (const inline of nodes(node.comments?.nodes)) read.push(...authored(inline, 'review-comment'))
    }
    const next = (page: Page | undefined) => page?.pageInfo?.hasNextPage === true && typeof page.pageInfo.endCursor === 'string' ? page.pageInfo.endCursor : null
    cursors = { comments: next(pull.comments), reviews: next(pull.reviews) }
    more = cursors.comments !== null || cursors.reviews !== null
  }
  const kept = read.slice(0, MAX_COMMENTS)
  comments.set(key, { at: Date.now(), read: kept })
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
// each dependency's of each hash its integrity names.
function counted(answer: CommentReview[], read: Authored[], reviewers: Map<string, string>): PublishedReview[] {
  const latest = new Map<string, number>()
  for (const { comment } of read) {
    const login = comment.author?.toLowerCase()
    if (login) latest.set(login, Math.max(latest.get(login) ?? 0, when(comment.createdAt) || 0))
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
        basePackage: null, baseVersion: null, reviewer, status: status as ReviewVerdict, full: true, time }))
    })
  })
}

// The reviews pull request `number`'s comments make, as the host's parser
// reads them, of the versions still wanting one; `reviewers` the app's users
// the accounts are, by their logins in lower case, of those whose reviews
// count for the repository.
export function commentReviews({ fullName, number, token, parse, reviewers, fetchImpl = globalThis.fetch }: {
  fullName: string; number: number; token: string; parse: NonNullable<ReviewedDependencies['parseComments']>
  reviewers: (accounts: { login: string; githubId: number | null }[]) => Promise<Map<string, string>>; fetchImpl?: typeof fetch
}): CommentReviews {
  return async wanting => {
    try {
      const read = await pullComments(fullName, token, number, fetchImpl)
      const accounts = new Map(read.flatMap(({ account }) => account.login ? [[account.login.toLowerCase(), { login: account.login, githubId: account.id }]] : []))
      const answer = await parsed(parse, { repository: fullName, number, comments: read.map(({ comment }) => comment), dependencies: wanting })
      return { reviews: counted(answer, read, await reviewers([...accounts.values()])), failed: false }
    } catch (error) {
      console.warn('reviewed dependencies: comments of', `${fullName}#${number}`, 'not read:', error instanceof Error ? error.message : error)
      return { reviews: [], failed: true }
    }
  }
}
