// What an open pull request's reviews say, as the code viewer's Pull requests
// tab and a pull request's popup show it (repository-issues.ts): who
// reviewed it and how, each by their latest review and the commit it was on,
// its author's own aside (the replies GitHub makes reviews of in a thread);
// whose review is requested, and how many more than those read; its review
// threads open and resolved, the latest read (open ones are, mostly, those
// lately opened), the gravest open one by the P0–P3 badge Codex marks a
// finding with; and
// Codex's own, which it keeps in a comment of its own (its summary, edited in
// place) rather than in reviews, reviewing only where it finds something:
// the commit its code review and its security review were last on, either
// one still running, asked for again since, or failed since. A review an
// agentic workflow (gh-aw) posted, as GitHub Actions' bot, names its
// workflow by the marker gh-aw leaves (`<!-- gh-aw-workflow-id: NAME -->`), in
// the popup, which reads reviews' bodies.
import { githubAgent } from '../common/managed/github-agents.ts'
import { ACTOR, type GraphAccount, actorOf } from './github-accounts.ts'

const REVIEWERS = 20
const REQUESTS = 10
// The threads the Pull requests tab counts, and those a popup lists.
export const TILE_THREADS = 50
export const ITEM_THREADS = 100
// The comments read for Codex's: its summary among the first, posted as the
// pull request opens, or among the last, where it was first asked later;
// asking it again, and its failures, among the last.
const FIRST_COMMENTS = 5
const LAST_COMMENTS = 20
const MAX_TITLE = 200
const MAX_PATH = 1000
const COMMIT = /^[a-f\d]{40}$/u

// The fields a pull request's reviews are read by, its threads' places and
// links with them for its popup (`detail`).
export const reviewFields = (threads: number, detail: boolean) => `headRefOid
  latestReviews(first: ${REVIEWERS}) { totalCount nodes { author { ${ACTOR} } state submittedAt commit { oid }${detail ? ' body' : ''} } }
  reviewRequests(first: ${REQUESTS}) { totalCount nodes { requestedReviewer { __typename ... on User { login databaseId } ... on Bot { login databaseId }
    ... on Mannequin { login databaseId } ... on Team { slug } ... on EnterpriseTeam { slug } } } }
  reviewThreads(last: ${threads}) { totalCount nodes { isResolved isOutdated${detail ? ' path line originalLine' : ''}
    comments(first: 1) { nodes { author { ${ACTOR} } body${detail ? ' url' : ''} } } } }
  firstComments: comments(first: ${FIRST_COMMENTS}) { nodes { author { ${ACTOR} } body updatedAt } }
  lastComments: comments(last: ${LAST_COMMENTS}) { nodes { author { ${ACTOR} } body createdAt updatedAt } }`

// The fields read for reviews that GitHub may refuse alone, as it refuses an
// App a pull request's checks: their pull request then shows no reviews.
const REVIEW_PATHS = new Set(['latestReviews', 'reviewRequests', 'reviewThreads', 'firstComments', 'lastComments'])
export const reviewsRefused = (error: { type?: unknown; path?: unknown } | null | undefined) => error?.type === 'FORBIDDEN' && Array.isArray(error.path)
  && error.path.some(part => REVIEW_PATHS.has(part as string))

type Comment = { author?: GraphAccount; body?: unknown; updatedAt?: unknown; createdAt?: unknown } | null
type Thread = { isResolved?: unknown; isOutdated?: unknown; path?: unknown; line?: unknown; originalLine?: unknown
  comments?: { nodes?: (Comment & { url?: unknown })[] } | null } | null
export type ReviewNode = {
  headRefOid?: unknown
  latestReviews?: { totalCount?: unknown; nodes?: ({ author?: GraphAccount; state?: unknown; submittedAt?: unknown; commit?: { oid?: unknown } | null; body?: unknown } | null)[] } | null
  reviewRequests?: { totalCount?: unknown; nodes?: ({ requestedReviewer?: { __typename?: unknown; login?: unknown; databaseId?: unknown; slug?: unknown } | null } | null)[] } | null
  reviewThreads?: { totalCount?: unknown; nodes?: Thread[] } | null
  firstComments?: { nodes?: Comment[] } | null
  lastComments?: { nodes?: Comment[] } | null
}

const STATES: Record<string, string> = { APPROVED: 'approved', CHANGES_REQUESTED: 'changes', COMMENTED: 'commented', DISMISSED: 'dismissed' }
const CODEX_STATES: Record<string, string> = { completed: 'done', running: 'running', queued: 'running', pending: 'running', in_progress: 'running', failed: 'failed', error: 'failed' }
const SEVERITY = /!\[(P[0-3]) Badge\]/u
const SUMMARY = /<!--\s*codex-review-state:v1\s+(\{[^]*?\})\s*-->/u
// Asking it to review again reruns its code review alone, never its security review.
const ASKED = /^@codex\s+review\b/iu
const FAILED = /^Codex Review: Something went wrong/u
const WORKFLOW = /<!--\s*gh-aw-workflow-id:\s*([\w.-]{1,100})\s*-->/u

const timeOf = (value: unknown) => {
  const at = typeof value === 'string' ? Date.parse(value) : Number.NaN
  return Number.isSafeInteger(at) ? at : null
}
const commitOf = (value: unknown) => typeof value === 'string' && COMMIT.test(value.toLowerCase()) ? value.toLowerCase() : null
const textOf = (value: unknown) => typeof value === 'string' ? value : ''
const isCodex = (account: GraphAccount) => {
  const { login, id } = actorOf(account)
  return login !== null && githubAgent(login, id) === 'codex'
}

// A finding's gravity, by its badge, `p0` the gravest; null for none.
const severityOf = (body: string) => SEVERITY.exec(body.slice(0, 500))?.[1]?.toLowerCase() ?? null
// A thread's title: its first comment's first line with words, as written,
// but for Codex's badge and emphasis.
function titleOf(body: string) {
  for (const line of body.split('\n', 6)) {
    const words = line.replaceAll(/!\[[^\]]*\]\([^)]*\)|<\/?sub>|\*\*|__/gu, '').trim()
    if (words) return words.slice(0, MAX_TITLE)
  }
  return ''
}

// Codex's review of one kind, as its summary names it: the commit it was
// last on and how it stands.
function codexReview(value: unknown) {
  const review = value && typeof value === 'object' ? value as { commit_sha?: unknown; status?: unknown } : null
  if (!review) return null
  return { commit: commitOf(review.commit_sha), status: CODEX_STATES[String(review.status)] ?? null }
}

// What Codex's summary says of its reviews, else null.
function summaryState(body: string): { code_review?: unknown; security_review?: unknown } | null {
  try {
    const value: unknown = JSON.parse(SUMMARY.exec(body)?.[1] ?? 'null')
    return value && typeof value === 'object' ? value : null
  } catch { return null }
}

// Codex's reviews, from its summary, else none: its account, as the summary
// names it; whether it was asked again since the summary last changed
// (`@codex review`), and whether it failed since it was last asked.
function codexOf(node: ReviewNode) {
  const summary = [...node.firstComments?.nodes ?? [], ...node.lastComments?.nodes ?? []]
    .find(comment => comment && isCodex(comment.author) && SUMMARY.test(textOf(comment.body)))
  if (!summary) return null
  const state = summaryState(textOf(summary.body))
  if (!state) return null
  const since = timeOf(summary.updatedAt) ?? 0
  const later = (node.lastComments?.nodes ?? []).filter(comment => comment && (timeOf(comment.createdAt) ?? 0) > since) as NonNullable<Comment>[]
  const at = (comment: NonNullable<Comment> | undefined) => comment ? timeOf(comment.createdAt) ?? 0 : null
  const asked = at(later.findLast(comment => !isCodex(comment.author) && ASKED.test(textOf(comment.body).trim())))
  const failed = at(later.findLast(comment => isCodex(comment.author) && FAILED.test(textOf(comment.body).trim())))
  const { login, id } = actorOf(summary.author)
  return { login, id, code: codexReview(state.code_review), security: codexReview(state.security_review),
    requested: asked !== null && !(failed !== null && failed > asked), failed: failed !== null && (asked === null || failed > asked) }
}

type Reviewer = { login: string | null; id: number | null; team?: string; workflow?: string; state: string | null; requested: boolean; commit: string | null; at: number | null }

// The reviewers, each once: by their latest review, its state and commit;
// whose is requested (again, for one who reviewed), a user, a bot (Copilot's
// code review, asked for, is its bot's) or an imported account's mannequin;
// a team's, or an enterprise's team's, by its slug. Codex's reviews are its
// summary's where it has one (`codex`). How many requested GitHub named no
// one for, as `unnamed`, counted with those past the ones read.
function reviewersOf(node: ReviewNode, author: string | null, codex: boolean) {
  const own = author?.toLowerCase()
  const reviewers: Reviewer[] = (node.latestReviews?.nodes ?? []).flatMap(review => {
    const { login, id } = actorOf(review?.author)
    const state = STATES[String(review?.state)]
    if (!state || (login !== null && login.toLowerCase() === own) || (codex && isCodex(review?.author))) return []
    const workflow = WORKFLOW.exec(textOf(review?.body))?.[1]
    return [{ login, id, ...workflow ? { workflow } : {}, state, requested: false, commit: commitOf(review?.commit?.oid), at: timeOf(review?.submittedAt) }]
  })
  let unnamed = 0
  for (const request of node.reviewRequests?.nodes ?? []) {
    const reviewer = request?.requestedReviewer
    if (reviewer?.__typename === 'Team' || reviewer?.__typename === 'EnterpriseTeam') {
      if (typeof reviewer.slug === 'string' && reviewer.slug) reviewers.push({ login: null, id: null, team: reviewer.slug.slice(0, 100), state: null, requested: true, commit: null, at: null })
      else unnamed++
      continue
    }
    const { login, id } = actorOf(reviewer)
    if (login === null) {
      unnamed++
      continue
    }
    const reviewed = reviewers.find(item => item.login?.toLowerCase() === login.toLowerCase())
    if (reviewed) reviewed.requested = true
    else reviewers.push({ login, id, state: null, requested: true, commit: null, at: null })
  }
  return { reviewers, unnamed }
}

// Its review threads, the latest read: how many are open and resolved,
// whether more than those read are, the gravest open one; and, for its popup (`detail`), each
// open one: its gravity, title, file and line, whether its code changed
// since, who opened it and where it is on GitHub.
function threadsOf(node: ReviewNode, detail: boolean) {
  const threads = (node.reviewThreads?.nodes ?? []).filter(Boolean) as NonNullable<Thread>[]
  const open = threads.filter(thread => thread.isResolved !== true)
  const severities = open.map(thread => severityOf(textOf(thread.comments?.nodes?.[0]?.body))).filter(Boolean) as string[]
  const total = node.reviewThreads?.totalCount
  const counted = { open: open.length, resolved: threads.length - open.length,
    more: Number.isSafeInteger(total) && (total as number) > threads.length, severity: severities.toSorted()[0] ?? null }
  if (!detail) return counted
  return { ...counted, list: open.map(thread => {
    const first = thread.comments?.nodes?.[0]
    const body = textOf(first?.body)
    const opener = actorOf(first?.author)
    const line = Number.isSafeInteger(thread.line) ? thread.line : Number.isSafeInteger(thread.originalLine) ? thread.originalLine : null
    const url = typeof first?.url === 'string' && first.url.startsWith('https://github.com/') ? first.url : null
    return { severity: severityOf(body), title: titleOf(body), path: typeof thread.path === 'string' ? thread.path.slice(0, MAX_PATH) : null, line,
      outdated: thread.isOutdated === true, author: opener.login, authorId: opener.id, url }
  }) }
}

// A pull request's reviews (`author` its author's login), for its tile or,
// with its threads listed, its popup (`detail`); null where none was read, or
// GitHub refused its reviews, requests or threads (reviewsRefused), rather
// than none.
export function pullReviews(node: ReviewNode, author: string | null, detail = false) {
  if (node.headRefOid === undefined || node.latestReviews === null || node.reviewRequests === null || node.reviewThreads === null) return null
  const codex = codexOf(node)
  // Those past the reviews and requests read, as many as GitHub counts.
  const past = (connection: { totalCount?: unknown; nodes?: unknown[] } | null | undefined) => Number.isSafeInteger(connection?.totalCount)
    ? Math.max(0, (connection!.totalCount as number) - (connection!.nodes?.length ?? 0)) : 0
  const { reviewers, unnamed } = reviewersOf(node, author, codex !== null)
  return { head: commitOf(node.headRefOid), reviewers, moreReviewers: past(node.latestReviews) + past(node.reviewRequests) + unnamed, threads: threadsOf(node, detail), codex }
}
