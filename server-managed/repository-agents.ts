// What the code viewer's Agents tab reconstructs agents' sessions
// from (GET /api/admin/repositories/agents, common/managed/agent-tasks.ts):
// a page of the repository's pull requests, the most recently updated first,
// as kept for the Pulse too (repository-pulls.ts readPulls), those past
// them searched for, and of its default branch's commits, the newest first,
// those no pull request merged, read from its history as the Commits tab
// keeps it, the
// marks an agent left kept with each (repository-history.ts commitMarks),
// whether a pull request brought one looked up for those marked alone, and
// kept by the commit; on the first page, its latest issues and the newest of
// its agents' branches (GitHub lists branches by name alone, so every one an
// agent's prefix names is read, as many as fifty pages of each, and the newest
// kept). Each artifact's own texts (never comments: an agent links its
// session in a pull request's body and its commits' messages) are read here
// for the marks an agent leaves, and a pull request's labels for one naming
// an agent, and those alone are answered, never the texts. GraphQL alone
// gives them, so it needs a token.
import { type AgentAuthor, type AgentBranch, type AgentCommit, type AgentIssue, type AgentPull, type AgentSignals, type AppAgent, agentSignals } from '../common/managed/agent-tasks.ts'
import { GITHUB_AGENTS, type GithubAgentAccount, type GithubAgentId } from '../common/managed/github-agents.ts'
import { AGENT_BRANCH_PREFIXES, APP_AGENTS } from './app-agents.ts'
import type { GraphqlError } from './github-graphql.ts'
import { ACTOR, ALL_BRANCHES, type HistoryCommit, type HistoryPages, type NamedAccount, actorOf, commitAccount, commitMarks, githubGraphql, historyFrom, historyMarks,
  inBatches, linkNoreplyUsers, messageMarks, variablesOf } from './repository-history.ts'
import type { IssueList, PullList } from './repository-pulls.ts'

export const AGENT_PULLS_PAGE = 50
export const AGENT_COMMITS_PAGE = 100
const AGENT_ISSUES = 100
const AGENT_BRANCHES = 500
const MAX_BRANCH_PAGES = 50
const CLOSES = 5
// A pull request's labels read, for one naming an agent: GitHub's most a
// page.
const LABELS = 100
const MAX_TITLE = 1000
const MAX_NAME = 256
const LOGIN = /^[A-Za-z\d][A-Za-z\d-]{0,38}(?:\[bot\])?$/u
const SHA = /^[a-f\d]{40}$/u
// Commits whether a pull request brought each is looked up of, in a query,
// and queries at once.
const PULLED_COMMITS = 100
const PULLED_PARALLEL = 4

// The app agents' accounts' no-reply addresses, by each login of theirs.
const AGENT_EMAILS = APP_AGENTS.flatMap(({ id }) => GITHUB_AGENTS[id as GithubAgentId].accounts
  .flatMap(({ id: account, logins }: GithubAgentAccount) => account === undefined ? [] : logins.map(login => `${account}+${login}@users.noreply.github.com`)))

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
// What a pull request is read by, for its row (pull): its texts for the
// marks an agent leaves in them (its body, its last commit's message, its
// merge commit's), never answered; its commits counted beside (`commits {
// totalCount }`, as the reads of it ask theirs).
export const AGENT_PULL_FIELDS = `number title state isDraft createdAt updatedAt author { __typename ${ACTOR} } body headRefName isCrossRepository
  headRepositoryOwner { login } additions deletions last: commits(last: 1) { nodes { commit { message } } } mergeCommit { message }
  closingIssuesReferences(first: ${CLOSES}) { nodes { number } } labels(first: ${LABELS}) { nodes { name } }`
// What an issue is read by, for its row (issue).
export const AGENT_ISSUE_FIELDS = `number title state createdAt updatedAt author { ${ACTOR} }`
// A page of the pull requests a search finds, as GitHub sorts them, on from
// where `after` says its page before ended.
const SEARCH_QUERY = `query($query: String!, $after: String) {
  search(type: ISSUE, query: $query, first: ${AGENT_PULLS_PAGE}, after: $after) {
    pageInfo { endCursor } nodes { ... on PullRequest { ${AGENT_PULL_FIELDS} commits { totalCount } } }
  }
}`

type Login = { login?: unknown; databaseId?: unknown } | null | undefined
export type PullNode = { number?: unknown; title?: unknown; state?: unknown; isDraft?: unknown; createdAt?: unknown; updatedAt?: unknown; author?: Login; body?: unknown
  headRefName?: unknown; isCrossRepository?: unknown; headRepositoryOwner?: Login; additions?: unknown; deletions?: unknown; commits?: { totalCount?: unknown } | null
  last?: { nodes?: ({ commit?: { message?: unknown } | null } | null)[] } | null; mergeCommit?: { message?: unknown } | null
  closingIssuesReferences?: { nodes?: ({ number?: unknown } | null)[] }; labels?: { nodes?: ({ name?: unknown } | null)[] } }
type GitActor = { email?: unknown; user?: Login }
type CommitNode = { oid?: unknown; messageHeadline?: unknown; message?: unknown; committedDate?: unknown; additions?: unknown; deletions?: unknown
  author?: GitActor | null; associatedPullRequests?: { totalCount?: unknown } }
export type IssueNode = { number?: unknown; title?: unknown; state?: unknown; createdAt?: unknown; updatedAt?: unknown; author?: Login }
type RefNode = { prefix?: unknown; name?: unknown; target?: { committedDate?: unknown; message?: unknown; author?: GitActor | null } | null }
type Connection<T> = { pageInfo?: { hasNextPage?: unknown; endCursor?: unknown }; nodes?: (T | null)[] }
// Whether a pull request brought each commit, `c<n>` the `n`th's.
const pulledQuery = (count: number) => `query($owner: String!, $name: String!, ${variablesOf('o', count, 'GitObjectID!')}) {
  repository(owner: $owner, name: $name) {
    ${Array.from({ length: count }, (_, at) => `c${at}: object(oid: $o${at}) { ... on Commit { associatedPullRequests(first: 1) { totalCount } } }`).join('\n    ')}
  }
}`
type Pulled = { repository?: Record<string, { associatedPullRequests?: { totalCount?: unknown } } | null> | null }
type Page = { repository?: { defaultBranchRef?: { target?: { history?: Connection<CommitNode> } | null } | null } | null }
type Found = { search?: { pageInfo?: { endCursor?: unknown }; nodes?: (PullNode | null)[] } | null } | null
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

// A pull request's row: what it is, and the marks an agent left on it.
export function pull(node: PullNode | null): AgentPull | null {
  const at = number(node?.number)
  if (!node || !at) return null
  const author = accountOf(node.author)
  return { number: at, title: nameOf(node.title, MAX_TITLE) ?? '', state: PULL_STATES[String(node.state)] ?? 'closed', draft: node.isDraft === true,
    author: loginOf(node.author), authorId: author?.id ?? null, createdAt: timeOf(node.createdAt), updatedAt: timeOf(node.updatedAt), head: nameOf(node.headRefName),
    // A fork's, its owner; one GitHub no longer names, a fork of its own.
    fork: node.isCrossRepository === true ? loginOf(node.headRepositoryOwner) ?? `pull-${at}` : null,
    additions: count(node.additions), deletions: count(node.deletions), commits: count(node.commits?.totalCount),
    closes: (node.closingIssuesReferences?.nodes ?? []).flatMap(closed => number(closed?.number) ?? []),
    signals: agentSignals([node.body, node.last?.nodes?.[0]?.commit?.message, node.mergeCommit?.message], APP_AGENTS, nameOf(node.headRefName),
      author, (node.labels?.nodes ?? []).map(label => label?.name)) }
}

// An account as GitHub names it, by its login and id, both.
const both = ({ login, id }: NamedAccount): AgentAuthor | null => login !== null && id !== null ? { login, id } : null
const accountOf = (actor: Login) => both(actorOf(actor))
// A commit's author: the account GitHub knows by its address, else the one
// its no-reply address names by id and login, as a bot's, Copilot's or
// Dependabot's, is told by that alone (repository-history.ts commitAccount).
const authorOf = (actor: GitActor | null | undefined) => both(commitAccount(actor))

// A commit to the default branch no pull request merged, where an agent left
// its marks on it, or Claude authored it (commitMarks).
function directCommit(node: CommitNode | null): AgentCommit | null {
  if (!node || typeof node.oid !== 'string' || !SHA.test(node.oid) || count(node.associatedPullRequests?.totalCount) > 0) return null
  const author = authorOf(node.author)
  const signals = commitMarks(messageMarks(node.message), { name: null, email: node.author?.email, account: commitAccount(node.author) })
  if (!signals) return null
  return { oid: node.oid, title: nameOf(node.messageHeadline, MAX_TITLE) ?? '', at: timeOf(node.committedDate),
    author: author?.login ?? loginOf(node.author?.user), authorId: author?.id ?? null,
    additions: count(node.additions), deletions: count(node.deletions), signals }
}

// A commit of the history kept an agent marked (`signals`,
// repository-history.ts historyMarks), as one of the default branch's.
const keptCommit = (commit: HistoryCommit, signals: AgentSignals): AgentCommit => ({ oid: commit.sha, title: commit.subject, at: commit.committedAt,
  author: commit.authorLogin, authorId: commit.authorId ?? null, additions: commit.additions ?? 0, deletions: commit.deletions ?? 0, signals })

// Whether a pull request brought each commit, kept by the commit.
export interface CommitPulls {
  read(shas: string[]): Promise<Map<string, boolean>>
  write(sha: string, pulled: boolean): Promise<void>
}

// A commit GitHub has none of, as one rewritten away: its field null.
const notFound = (error: GraphqlError) => error?.type === 'NOT_FOUND'

// Those of `shas` a pull request brought: as kept (`kept`), the rest looked
// up, PULLED_COMMITS a query, and kept; one GitHub has none of, none.
async function pulledCommits(fullName: string, token: string, shas: string[], kept: CommitPulls, fetchImpl: typeof fetch) {
  const [owner, name] = fullName.split('/') as [string, string]
  const known = await kept.read(shas)
  await inBatches(shas.filter(sha => !known.has(sha)), PULLED_COMMITS, PULLED_PARALLEL, async batch => {
    const data = await githubGraphql(pulledQuery(batch.length), { owner, name, ...Object.fromEntries(batch.map((sha, at) => [`o${at}`, sha])) }, token, fetchImpl,
      notFound) as Pulled
    await Promise.all(batch.map((sha, at) => {
      const node = data?.repository?.[`c${at}`]
      if (!node) return Promise.resolve()
      known.set(sha, count(node.associatedPullRequests?.totalCount) > 0)
      return kept.write(sha, known.get(sha)!)
    }))
  })
  return new Set(shas.filter(sha => known.get(sha) === true))
}

// Where commits listed stop: those the cursor named but left unread still
// unlisted (`left`, newer than those below the commits read from the rest),
// then the parents of those listed not listed, the newest first (each by its
// child's time), as the Commits tab reads on from (repository-history.js):
// each read in its turn, as many as ALL_BRANCHES an answer, none dropped
// till MAX_FRONTIER are left (a cursor's length bounded, a URL's); null
// where none are.
function frontier(commits: HistoryCommit[], left: string[]) {
  const listed = new Set(commits.map(commit => commit.sha))
  const at = new Map<string, number>()
  for (const commit of commits) {
    for (const parent of commit.parents) if (!listed.has(parent)) at.set(parent, Math.max(at.get(parent) ?? Number.NEGATIVE_INFINITY, commit.committedAt ?? 0))
  }
  const below = [...at].toSorted((a, b) => b[1] - a[1]).map(([sha]) => sha)
  const starts = [...new Set([...left.filter(sha => !listed.has(sha)), ...below])].slice(0, MAX_FRONTIER)
  return starts.length > 0 ? starts.join(',') : null
}

// An issue's row: what it is, and who opened it.
export function issue(node: IssueNode | null): AgentIssue | null {
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
    await linkNoreplyUsers((refs?.nodes ?? []).map(node => node?.target?.author), token, fetchImpl)
    found.push(...(refs?.nodes ?? []).flatMap(node => branch(prefix)(node) ?? []))
    const next: Connection<RefNode>['pageInfo'] = refs?.pageInfo
    if (next?.hasNextPage !== true || typeof next.endCursor !== 'string') break
    after = next.endCursor
  }
  return found.toSorted((a, b) => (b.at ?? 0) - (a.at ?? 0)).slice(0, AGENT_BRANCHES)
}

// What its answers are kept by, with their cursors (http.ts
// handleRepositoryAgents): bumped as what a page reads, or how it tells an
// agent, changes (with AGENT_MARKS_READ, app-agents.ts, where commits' marks
// do), so that no answer an older server kept is sent for a day.
export const AGENTS_READ_VERSION = 9

// A cursor of the default branch's commits: those the pages before stopped
// at (frontier), as many as MAX_FRONTIER, commas between, the first
// ALL_BRANCHES of them read next; one an older server gave, GitHub's,
// `<oid> <offset>`, read on from its commit.
const MAX_FRONTIER = 4 * ALL_BRANCHES
export const COMMITS_CURSOR = new RegExp(`^(?:[\\da-f]{40}(?:,[\\da-f]{40}){0,${MAX_FRONTIER - 1}}|[\\da-f]{40} \\d{1,9})$`, 'u')
const startsOf = (cursor: string) => cursor.split(/[ ,]/u).filter(part => SHA.test(part))

// A cursor of the pull requests: the last listed, by when it was updated and
// its number (`<ms>.<number>`), those below it read next; of a search's page
// all updated together, the time it searched by and where its page ended too
// (`~<ms>~<cursor>`), those updated with them read on through the same
// search; any other, as an older server gave (GitHub's), read from the
// newest again.
const POSITION = /^(\d{1,15})\.(\d{1,10})(?:~(\d{1,15})~([\w+/=-]{1,200}))?$/u
const positionOf = (item: AgentPull) => `${item.updatedAt ?? 0}.${item.number}`
// Those updated by a time, as GitHub's search takes it, to the second; any
// where it names none.
const updatedBy = (at: number) => Number.isFinite(at) ? ` updated:<=${new Date(at).toISOString().replace(/\.\d{3}Z$/u, '+00:00')}` : ''

// What the repository's tabs read and keep together (http.ts): its pull
// requests and its issues (repository-pulls.ts PullList, IssueList), each
// read as far back as their first page where none are, and those updated
// since read as they are (keptList), and its default branch's head
// (defaultTip).
export interface Kept { pulls(): Promise<PullList>; issues(): Promise<IssueList>; head(): Promise<string | null> }

// A page of the repository's pull requests, the most recently updated
// first, below the one `cursor` names (none: from the newest): of those kept
// (`kept`), as far back as every one is read; past them, as GitHub's search
// finds those updated before, a page a query. With where it reads on from,
// null where none are left: past every one kept where all are.
async function agentPulls(fullName: string, token: string, cursor: string | null, kept: Kept['pulls'], fetchImpl: typeof fetch) {
  const at = cursor === null ? null : POSITION.exec(cursor)
  const [time, past] = at ? [Number(at[1]), Number(at[2])] : [Number.POSITIVE_INFINITY, 0]
  const below = (item: AgentPull) => (item.updatedAt ?? 0) < time || ((item.updatedAt ?? 0) === time && item.number < past)
  const list = await kept()
  // Since when every one updated is read (as repository-pulls.ts pullsReadTo
  // tells, which reads its pages by these fields): all since the year's
  // start, -∞.
  const read = list.next ? list.next.to ?? Number.POSITIVE_INFINITY : list.reach ?? Number.NEGATIVE_INFINITY
  // As far back as every one is read: the year's start, where all since are.
  const bottom = Math.max(read, list.since)
  const listed = list.rows.filter(item => below(item) && (item.updatedAt ?? 0) >= bottom)
  const whole = list.all === true && read === Number.NEGATIVE_INFINITY
  if (listed.length > 0) {
    const page = listed.slice(0, AGENT_PULLS_PAGE)
    return { pulls: page, after: listed.length > page.length || !whole ? positionOf(page.at(-1)!) : null }
  }
  if (whole) return { pulls: [], after: null }
  // Those updated by when the last was, those updated with it again among
  // them (GitHub orders those by no number), the last itself left out; a
  // page all updated together read on through the same search, past them.
  const [by, through] = at?.[3] === undefined ? [Math.min(time, bottom), null] : [Number(at[3]), at[4]!]
  const found = await githubGraphql(SEARCH_QUERY, { query: `repo:${fullName} is:pr sort:updated-desc${updatedBy(by)}`, after: through }, token, fetchImpl) as Found
  const nodes = found?.search?.nodes ?? []
  const rows = nodes.flatMap(node => pull(node) ?? [])
  const last = rows.at(-1)
  const ended = found?.search?.pageInfo?.endCursor
  const together = Number.isFinite(by) && rows.every(item => item.updatedAt === last?.updatedAt) && typeof ended === 'string' && /^[\w+/=-]{1,200}$/u.test(ended)
  const after = nodes.length >= AGENT_PULLS_PAGE && last ? `${positionOf(last)}${together ? `~${by}~${ended}` : ''}` : null
  return { pulls: rows.filter(item => item.updatedAt !== time || item.number !== past), after: after === cursor ? null : after }
}

// A page of what the repository's agents left: its pull requests below the
// one the cursor `pulls` names, as kept (`kept`, agentPulls), its default
// branch's commits on from those `commits` names, as its history is kept
// (`pages`, historyFrom: the first page from its head, as kept), whether a
// pull request brought those marked kept (`pulled`) (the first page where
// neither is named, with its latest issues, as kept, its agents' branches
// and the commits the app agents' accounts authored, and the app agents it
// may name), and the cursors reading on from each, null where either is
// read whole.
export async function repositoryAgents(fullName: string, token: string, cursors: { pulls: string | null; commits: string | null }, pages: HistoryPages,
  pulled: CommitPulls, kept: Kept, fetchImpl: typeof fetch = globalThis.fetch) {
  const [owner, name] = fullName.split('/') as [string, string]
  const first = cursors.pulls === null && cursors.commits === null
  const [head, issues, branches, authored, pulls] = await Promise.all([
    first ? kept.head() : null,
    first ? kept.issues() : null,
    first ? Promise.all(AGENT_BRANCH_PREFIXES.map(prefix => agentBranches(owner, name, prefix, token, fetchImpl))) : [],
    first ? githubGraphql(AUTHORED_QUERY, { owner, name, emails: AGENT_EMAILS }, token, fetchImpl) as Promise<Page> : null,
    first || cursors.pulls !== null ? agentPulls(fullName, token, cursors.pulls, kept.pulls, fetchImpl) : { pulls: [], after: null },
  ])
  const named = cursors.commits === null ? first && typeof head === 'string' && SHA.test(head) ? [head] : [] : startsOf(cursors.commits)
  const starts = named.slice(0, ALL_BRANCHES)
  const history = starts.length > 0 ? (await historyFrom(fullName, token, starts, pages, fetchImpl)).commits : []
  const marked = history.flatMap(commit => { const signals = historyMarks(commit); return signals ? [{ commit, signals }] : [] })
  const nodes = authored?.repository?.defaultBranchRef?.target?.history?.nodes ?? []
  const [brought] = await Promise.all([pulledCommits(fullName, token, marked.map(({ commit }) => commit.sha), pulled, fetchImpl),
    linkNoreplyUsers(nodes.map(node => node?.author), token, fetchImpl)])
  const commits = [...marked.flatMap(({ commit, signals }) => brought.has(commit.sha) ? [] : [keptCommit(commit, signals)]), ...nodes.flatMap(node => directCommit(node) ?? [])]
  const after = { pulls: pulls.after, commits: frontier(history, named.slice(ALL_BRANCHES)) }
  return {
    pulls: pulls.pulls.map(({ merged: _merged, ...row }: AgentPull & { merged?: unknown }) => row),
    commits: commits.filter((commit, index) => commits.findIndex(other => other.oid === commit.oid) === index),
    ...first ? {
      issues: (issues?.rows ?? []).slice(0, AGENT_ISSUES).map(({ closedAt: _closedAt, reason: _reason, ...row }) => row),
      branches: branches.flat(),
      agents: APP_AGENTS.map(({ id, name: agent, avatar }): AppAgent => ({ id, name: agent, ...avatar ? { avatar } : {} })),
    } : {},
    more: after.pulls !== null || after.commits !== null, after,
  }
}
