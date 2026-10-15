// The issues and pull requests the code viewer's Issues and Pull requests
// tabs show (GET /api/admin/repositories/issues): those open, or those
// closed (a pull request's merged among them), the most recently updated
// first, a page at a time, each as one tile has room for, with how many are
// open and closed. A pull request's tile names its branches, its size, its
// review and its checks, which GraphQL alone gives, so it needs a token. A
// nonpublic repository's are read with its GitHub App's installation, which
// reads pull requests only with their own permission (README).
import { GithubApiError } from './github-app.ts'
import { type GraphqlError, githubGraphql } from './repository-history.ts'

export const ISSUES_PAGE = 50
const MAX_LABELS = 6
const MAX_TITLE = 1000
const MAX_NAME = 256
const LOGIN = /^[A-Za-z\d][A-Za-z\d-]{0,38}(?:\[bot\])?$/u
const COLOR = /^[a-f\d]{6}$/iu
// A page's cursor as GitHub gives it, to read on from: opaque, base64 or
// base64url as it is now (`…rOrK_u7Q==`), passed back to GitHub alone, so any
// printable one is, but none with spaces or control characters.
export const ISSUES_CURSOR = /^[!-~]{1,256}$/u

export type IssuesKind = 'issues' | 'pulls'
export type IssuesState = 'open' | 'closed'

const shared = `number title createdAt updatedAt closedAt author { login } comments { totalCount } labels(first: ${MAX_LABELS}) { totalCount nodes { name color } }`
const fields = {
  issues: `${shared} state stateReason`,
  pulls: `${shared} state isDraft mergedAt reviewDecision additions deletions headRefName baseRefName
      commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }`,
}
const connection = { issues: 'issues', pulls: 'pullRequests' }
const states = { issues: { open: '[OPEN]', closed: '[CLOSED]' }, pulls: { open: '[OPEN]', closed: '[CLOSED, MERGED]' } }

// A page of `kind`, those in `state`, after the page `after` ends, and how
// many of each state there are.
const pageQuery = (kind: IssuesKind, state: IssuesState) => `query($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    open: ${connection[kind]}(states: ${states[kind].open}) { totalCount }
    closed: ${connection[kind]}(states: ${states[kind].closed}) { totalCount }
    page: ${connection[kind]}(states: ${states[kind][state]}, first: ${ISSUES_PAGE}, after: $after, orderBy: { field: UPDATED_AT, direction: DESC }) {
      pageInfo { hasNextPage endCursor }
      nodes { ${fields[kind]} }
    }
  }
}`

type Node = { number?: unknown; title?: unknown; createdAt?: unknown; updatedAt?: unknown; closedAt?: unknown; mergedAt?: unknown; author?: { login?: unknown } | null
  comments?: { totalCount?: unknown }; labels?: { totalCount?: unknown; nodes?: { name?: unknown; color?: unknown }[] }; state?: unknown; stateReason?: unknown
  isDraft?: unknown; reviewDecision?: unknown; additions?: unknown; deletions?: unknown; headRefName?: unknown; baseRefName?: unknown
  commits?: { nodes?: { commit?: { statusCheckRollup?: { state?: unknown } | null } | null }[] } }
type Page = { repository?: { open?: { totalCount?: unknown }; closed?: { totalCount?: unknown }
  page?: { pageInfo?: { hasNextPage?: unknown; endCursor?: unknown }; nodes?: (Node | null)[] } } | null }

const count = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : 0
const timeOf = (value: unknown) => {
  const at = typeof value === 'string' ? Date.parse(value) : Number.NaN
  return Number.isSafeInteger(at) ? at : null
}
const nameOf = (value: unknown, max = MAX_NAME) => typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null
const REVIEWS: Record<string, string> = { APPROVED: 'approved', CHANGES_REQUESTED: 'changes', REVIEW_REQUIRED: 'required' }
const CHECKS: Record<string, string> = { SUCCESS: 'success', FAILURE: 'failure', ERROR: 'failure', PENDING: 'pending', EXPECTED: 'pending' }
const REASONS: Record<string, string> = { COMPLETED: 'completed', NOT_PLANNED: 'not-planned', DUPLICATE: 'duplicate' }

// An issue or pull request as a tile shows it; null for one GitHub names no
// number for.
function item(kind: IssuesKind, node: Node | null) {
  if (!node || !Number.isSafeInteger(node.number) || (node.number as number) <= 0) return null
  const login = typeof node.author?.login === 'string' && LOGIN.test(node.author.login) ? node.author.login : null
  const labels = (node.labels?.nodes ?? []).flatMap(label => {
    const name = nameOf(label?.name)
    return name ? [{ name, color: typeof label?.color === 'string' && COLOR.test(label.color) ? label.color.toLowerCase() : null }] : []
  })
  const common = { number: node.number as number, title: nameOf(node.title, MAX_TITLE) ?? '', author: login, createdAt: timeOf(node.createdAt), updatedAt: timeOf(node.updatedAt),
    closedAt: timeOf(node.closedAt), comments: count(node.comments?.totalCount), labels, moreLabels: Math.max(0, count(node.labels?.totalCount) - labels.length) }
  if (kind === 'issues') {
    return { ...common, state: node.state === 'OPEN' ? 'open' : 'closed', reason: REASONS[String(node.stateReason)] ?? null }
  }
  const checks = node.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state
  return { ...common, state: node.state === 'MERGED' ? 'merged' : node.state === 'OPEN' ? 'open' : 'closed', draft: node.isDraft === true, mergedAt: timeOf(node.mergedAt),
    review: REVIEWS[String(node.reviewDecision)] ?? null, checks: CHECKS[String(checks)] ?? null, additions: count(node.additions), deletions: count(node.deletions),
    head: nameOf(node.headRefName), base: nameOf(node.baseRefName) }
}

// A pull request's checks, which a GitHub App reads only with the Checks and
// Commit statuses permissions, refused: its tile then shows none. Any other
// field refused, the list is, as one without Pull requests: read is.
const checksRefused = (error: GraphqlError) => error?.type === 'FORBIDDEN' && Array.isArray(error.path) && error.path.includes('statusCheckRollup')

// A page of the repository's issues or pull requests in `state`, after the
// page `after` ended (null for the first): its `items`, how many are open and
// closed (`counts`), and, where more follow, the cursor reading them (`after`).
export async function repositoryIssues(fullName: string, token: string, kind: IssuesKind, state: IssuesState, after: string | null, fetchImpl: typeof fetch = globalThis.fetch) {
  const [owner, name] = fullName.split('/') as [string, string]
  const data = await githubGraphql(pageQuery(kind, state), { owner, name, after }, token, fetchImpl, checksRefused) as Page
  const repository = data?.repository
  if (!repository) throw new GithubApiError(404, 'github-not-found')
  const info = repository.page?.pageInfo
  const next = info?.hasNextPage === true && typeof info.endCursor === 'string' && ISSUES_CURSOR.test(info.endCursor) ? info.endCursor : null
  return {
    items: (repository.page?.nodes ?? []).flatMap(node => item(kind, node) ?? []),
    counts: { open: count(repository.open?.totalCount), closed: count(repository.closed?.totalCount) },
    more: next !== null, after: next,
  }
}
