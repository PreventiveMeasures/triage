// What the code viewer's Agents tab reconstructs agents' sessions
// from (GET /api/admin/repositories/agents, common/managed/agent-tasks.ts):
// a page of the repository's pull requests, the most recently updated first,
// and of its default branch's commits, the newest first, those no pull
// request merged; on the first page, its latest issues and the newest of
// its agents' branches (GitHub lists branches by name alone, so every one an
// agent's prefix names is read, as many as fifty pages of each, and the newest
// kept). Each artifact's own texts (never comments: an agent links its
// session in a pull request's body and its commits' messages) are read here
// for the marks an agent leaves, and those alone are answered, never the
// texts. GraphQL alone gives them, so it needs a token.
import { type AgentAuthor, type AgentBranch, type AgentCommit, type AgentIssue, type AgentPull, type AppAgent, type AppAgentMarks, agentSignals }
  from '../common/managed/agent-tasks.ts'
import { GITHUB_AGENTS } from '../common/managed/github-agents.ts'
import { GithubApiError } from './github-app.ts'
import { ACTOR, type NamedAccount, actorOf, commitAccount, githubGraphql } from './repository-history.ts'
import { ISSUES_CURSOR } from './repository-issues.ts'

export const AGENT_PULLS_PAGE = 50
export const AGENT_COMMITS_PAGE = 100
const AGENT_ISSUES = 100
const AGENT_BRANCHES = 500
const MAX_BRANCH_PAGES = 50
const CLOSES = 5
const MAX_TITLE = 1000
const MAX_NAME = 256
const LOGIN = /^[A-Za-z\d][A-Za-z\d-]{0,38}(?:\[bot\])?$/u
const SHA = /^[a-f\d]{40}$/u
// The address Claude's own commits are authored with.
const CLAUDE_EMAIL = 'noreply@anthropic.com'

// The agents known by their GitHub Apps or accounts, beside Claude and
// Codex: each its id and name, its avatar (its mark, served by
// /api/avatar/<avatar>, for these alone: a GitHub App's, `app-<id>`, or
// account's, `user-<id>`), the fingerprint it leaves as a line of its pull
// requests' bodies and its commits' messages, the account its work is
// authored by (its id and the logins GitHub names it by, told by both), and
// its branches' prefix. Their work may carry Claude's or
// Codex's marks too, those its tools. Copilot's coding agent opens its pull
// requests and authors its commits as its account, Copilot (198982749), on
// `copilot/` branches; Dependabot, its GitHub App (29110), opens its pull
// requests as its account, `dependabot` (49699333, `dependabot[bot]` to
// GitHub's REST API and in its address), on `dependabot/<ecosystem>/…`
// branches. Their accounts and marks are those the app draws their work by
// wherever it shows it (common/managed/github-agents.ts): Copilot's its own,
// the app's to draw, no avatar.
const { copilot, dependabot } = GITHUB_AGENTS
export const APP_AGENTS: readonly (AppAgent & AppAgentMarks)[] = [
  { id: 'neo', name: 'Neo', avatar: 'app-3115942', fingerprint: '🤖 Generated with [Neo](', prefix: 'neo/' },
  { id: 'copilot', name: copilot.name, account: copilot.accounts[0], prefix: 'copilot/' },
  { id: 'dependabot', name: dependabot.name, avatar: dependabot.avatar, account: dependabot.accounts[0], prefix: 'dependabot/' },
]
// The app agents' accounts' no-reply addresses, by each login of theirs.
const AGENT_EMAILS = APP_AGENTS.flatMap(({ account }) => account?.logins.map(login => `${account.id}+${login}@users.noreply.github.com`) ?? [])
// Whose branches are read, by their prefixes.
const BRANCH_PREFIXES = ['claude/', 'codex/', ...APP_AGENTS.map(agent => agent.prefix)]

// An agent's branches, a page at a time, as GitHub lists them, by name;
// each its tip commit's time, message and author.
const BRANCHES_QUERY = `query($owner: String!, $name: String!, $prefix: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    refs(refPrefix: $prefix, first: 100, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes { prefix name target { ... on Commit { committedDate message author { email user { login databaseId } } } } }
    }
  }
}`
// What a commit of the default branch is read by.
const COMMIT_FIELDS = 'oid messageHeadline message committedDate additions deletions author { email user { login databaseId } } associatedPullRequests(first: 1) { totalCount }'
// The newest of the default branch's commits the app agents' accounts
// authored, by their GitHub no-reply addresses, however far back: a bot's
// commits pushed with no pull request here (as before a repository moved)
// may lie deeper than pages are read on to.
const AUTHORED_QUERY = `query($owner: String!, $name: String!, $emails: [String!]!) {
  repository(owner: $owner, name: $name) {
    defaultBranchRef { target { ... on Commit { history(first: ${AGENT_COMMITS_PAGE}, author: { emails: $emails }) { nodes { ${COMMIT_FIELDS} } } } } }
  }
}`
const PAGE_QUERY = `query($owner: String!, $name: String!, $pulls: String, $commits: String, $first: Boolean!, $readPulls: Boolean!, $readCommits: Boolean!) {
  repository(owner: $owner, name: $name) {
    pullRequests(first: ${AGENT_PULLS_PAGE}, after: $pulls, orderBy: { field: UPDATED_AT, direction: DESC }) @include(if: $readPulls) {
      pageInfo { hasNextPage endCursor }
      nodes { number title state isDraft createdAt updatedAt author { ${ACTOR} } body headRefName isCrossRepository headRepositoryOwner { login } additions deletions
        commits(last: 1) { totalCount nodes { commit { message } } }
        mergeCommit { message }
        closingIssuesReferences(first: ${CLOSES}) { nodes { number } } }
    }
    defaultBranchRef { target { ... on Commit {
      history(first: ${AGENT_COMMITS_PAGE}, after: $commits) @include(if: $readCommits) {
        pageInfo { hasNextPage endCursor }
        nodes { ${COMMIT_FIELDS} }
      }
    } } }
    issues(first: ${AGENT_ISSUES}, orderBy: { field: UPDATED_AT, direction: DESC }) @include(if: $first) {
      nodes { number title state createdAt updatedAt author { ${ACTOR} } }
    }
  }
}`

type Login = { login?: unknown; databaseId?: unknown } | null | undefined
type PullNode = { number?: unknown; title?: unknown; state?: unknown; isDraft?: unknown; createdAt?: unknown; updatedAt?: unknown; author?: Login; body?: unknown
  headRefName?: unknown; isCrossRepository?: unknown; headRepositoryOwner?: Login; additions?: unknown; deletions?: unknown; commits?: { totalCount?: unknown; nodes?: ({ commit?: { message?: unknown } | null } | null)[] }
  mergeCommit?: { message?: unknown } | null; closingIssuesReferences?: { nodes?: ({ number?: unknown } | null)[] } }
type GitActor = { email?: unknown; user?: Login }
type CommitNode = { oid?: unknown; messageHeadline?: unknown; message?: unknown; committedDate?: unknown; additions?: unknown; deletions?: unknown
  author?: GitActor | null; associatedPullRequests?: { totalCount?: unknown } }
type IssueNode = { number?: unknown; title?: unknown; state?: unknown; createdAt?: unknown; updatedAt?: unknown; author?: Login }
type RefNode = { prefix?: unknown; name?: unknown; target?: { committedDate?: unknown; message?: unknown; author?: GitActor | null } | null }
type Connection<T> = { pageInfo?: { hasNextPage?: unknown; endCursor?: unknown }; nodes?: (T | null)[] }
type Page = { repository?: { pullRequests?: Connection<PullNode>; defaultBranchRef?: { target?: { history?: Connection<CommitNode> } | null } | null
  issues?: Connection<IssueNode> } | null }
type RefsPage = { repository?: { refs?: Connection<RefNode> } | null }

const count = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : 0
const number = (value: unknown) => Number.isSafeInteger(value) && (value as number) > 0 ? value as number : null
const timeOf = (value: unknown) => {
  const at = typeof value === 'string' ? Date.parse(value) : Number.NaN
  return Number.isSafeInteger(at) ? at : null
}
const nameOf = (value: unknown, max = MAX_NAME) => typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null
const loginOf = (author: Login) => typeof author?.login === 'string' && LOGIN.test(author.login) ? author.login : null
const PULL_STATES: Record<string, AgentPull['state']> = { OPEN: 'open', MERGED: 'merged', CLOSED: 'closed' }

function pull(node: PullNode | null): AgentPull | null {
  const at = number(node?.number)
  if (!node || !at) return null
  const author = accountOf(node.author)
  return { number: at, title: nameOf(node.title, MAX_TITLE) ?? '', state: PULL_STATES[String(node.state)] ?? 'closed', draft: node.isDraft === true,
    author: loginOf(node.author), authorId: author?.id ?? null, createdAt: timeOf(node.createdAt), updatedAt: timeOf(node.updatedAt), head: nameOf(node.headRefName),
    // A fork's, its owner; one GitHub no longer names, a fork of its own.
    fork: node.isCrossRepository === true ? loginOf(node.headRepositoryOwner) ?? `pull-${at}` : null,
    additions: count(node.additions), deletions: count(node.deletions), commits: count(node.commits?.totalCount),
    closes: (node.closingIssuesReferences?.nodes ?? []).flatMap(closed => number(closed?.number) ?? []),
    signals: agentSignals([node.body, node.commits?.nodes?.[0]?.commit?.message, node.mergeCommit?.message], APP_AGENTS, nameOf(node.headRefName),
      author) }
}

// An account as GitHub names it, by its login and id, both.
const both = ({ login, id }: NamedAccount): AgentAuthor | null => login !== null && id !== null ? { login, id } : null
const accountOf = (actor: Login) => both(actorOf(actor))
// A commit's author: the account GitHub knows by its address, else the one
// its no-reply address names by id and login, as a bot's, Copilot's or
// Dependabot's, is told by that alone (repository-history.ts commitAccount).
const authorOf = (actor: GitActor | null | undefined) => both(commitAccount(actor))

// A commit to the default branch no pull request merged, where an agent left
// its marks on it, or Claude authored it.
function directCommit(node: CommitNode | null): AgentCommit | null {
  if (!node || typeof node.oid !== 'string' || !SHA.test(node.oid) || count(node.associatedPullRequests?.totalCount) > 0) return null
  const author = authorOf(node.author)
  const signals = agentSignals([node.message], APP_AGENTS, null, author)
  if (node.author?.email === CLAUDE_EMAIL) signals.claude = true
  if (!signals.claude && signals.agents.length === 0 && signals.sessions.length === 0 && signals.tasks.length === 0) return null
  return { oid: node.oid, title: nameOf(node.messageHeadline, MAX_TITLE) ?? '', at: timeOf(node.committedDate),
    author: author?.login ?? loginOf(node.author?.user), authorId: author?.id ?? null,
    additions: count(node.additions), deletions: count(node.deletions), signals }
}

function issue(node: IssueNode | null): AgentIssue | null {
  const at = number(node?.number)
  if (!node || !at) return null
  return { number: at, title: nameOf(node.title, MAX_TITLE) ?? '', state: node.state === 'OPEN' ? 'open' : 'closed', author: loginOf(node.author),
    authorId: accountOf(node.author)?.id ?? null, createdAt: timeOf(node.createdAt), updatedAt: timeOf(node.updatedAt) }
}

// A branch under `prefix`, an agent's, named in full however GitHub splits
// its name from the prefix it was listed under.
const branch = (prefix: string) => (node: RefNode | null): AgentBranch | null => {
  const ref = typeof node?.prefix === 'string' && typeof node.name === 'string' ? `${node.prefix}${node.name}` : null
  const name = ref?.startsWith('refs/heads/') ? nameOf(ref.slice('refs/heads/'.length)) : null
  const author = authorOf(node?.target?.author)
  return name?.startsWith(prefix) ? { name, at: timeOf(node?.target?.committedDate), author: author?.login ?? loginOf(node?.target?.author?.user),
    authorId: author?.id ?? null, signals: agentSignals([node?.target?.message], APP_AGENTS, name, author) } : null
}

// The newest of an agent's branches, those under `prefix`: every one, as many
// as MAX_BRANCH_PAGES of them list, kept by their tips' times.
async function agentBranches(owner: string, name: string, prefix: string, token: string, fetchImpl: typeof fetch) {
  const found: AgentBranch[] = []
  let after: string | null = null
  for (let page = 0; page < MAX_BRANCH_PAGES; page++) {
    const refs: Connection<RefNode> | undefined = (await githubGraphql(BRANCHES_QUERY, { owner, name, prefix: `refs/heads/${prefix}`, after }, token, fetchImpl) as RefsPage)
      ?.repository?.refs
    found.push(...(refs?.nodes ?? []).flatMap(node => branch(prefix)(node) ?? []))
    const next: Connection<RefNode>['pageInfo'] = refs?.pageInfo
    if (next?.hasNextPage !== true || typeof next.endCursor !== 'string') break
    after = next.endCursor
  }
  return found.toSorted((a, b) => (b.at ?? 0) - (a.at ?? 0)).slice(0, AGENT_BRANCHES)
}

// What its answers are kept by, with their cursors (http.ts
// handleRepositoryAgents): bumped as what a page reads, or how it tells an
// agent, changes, so that no answer an older server kept is sent for a day.
export const AGENTS_READ_VERSION = 3

// A cursor of the default branch's commits: GitHub names one by a commit
// and how many on from it, `<oid> <offset>`, a space between.
export const COMMITS_CURSOR = /^(?:[!-~]{1,256}|[\da-f]{40} \d{1,9})$/u

const nextCursor = (connection: Connection<unknown> | undefined, cursor = ISSUES_CURSOR) => {
  const info = connection?.pageInfo
  return info?.hasNextPage === true && typeof info.endCursor === 'string' && cursor.test(info.endCursor) ? info.endCursor : null
}

// A page of what the repository's agents left: its pull requests on from
// the cursor `pulls` ends at, its default branch's commits on from
// `commits` (the first page where neither is named, with its issues, its
// agents' branches and the commits the app agents' accounts authored, and
// the app agents it may name), and the cursors reading on from each, null
// where either is read whole.
export async function repositoryAgents(fullName: string, token: string, cursors: { pulls: string | null; commits: string | null },
  fetchImpl: typeof fetch = globalThis.fetch) {
  const [owner, name] = fullName.split('/') as [string, string]
  const first = cursors.pulls === null && cursors.commits === null
  const [data, branches, authored] = await Promise.all([
    githubGraphql(PAGE_QUERY, { owner, name, pulls: cursors.pulls, commits: cursors.commits, first,
      readPulls: first || cursors.pulls !== null, readCommits: first || cursors.commits !== null }, token, fetchImpl) as Promise<Page>,
    first ? Promise.all(BRANCH_PREFIXES.map(prefix => agentBranches(owner, name, prefix, token, fetchImpl))) : [],
    first ? githubGraphql(AUTHORED_QUERY, { owner, name, emails: AGENT_EMAILS }, token, fetchImpl) as Promise<Page> : null,
  ])
  const repository = data?.repository
  if (!repository) throw new GithubApiError(404, 'github-not-found')
  const history = repository.defaultBranchRef?.target?.history
  const after = { pulls: nextCursor(repository.pullRequests), commits: nextCursor(history, COMMITS_CURSOR) }
  const commits = [...history?.nodes ?? [], ...authored?.repository?.defaultBranchRef?.target?.history?.nodes ?? []].flatMap(node => directCommit(node) ?? [])
  return {
    pulls: (repository.pullRequests?.nodes ?? []).flatMap(node => pull(node) ?? []),
    commits: commits.filter((commit, index) => commits.findIndex(other => other.oid === commit.oid) === index),
    ...first ? {
      issues: (repository.issues?.nodes ?? []).flatMap(node => issue(node) ?? []),
      branches: branches.flat(),
      agents: APP_AGENTS.map(({ id, name: agent, avatar }): AppAgent => ({ id, name: agent, ...avatar ? { avatar } : {} })),
    } : {},
    more: after.pulls !== null || after.commits !== null, after,
  }
}
