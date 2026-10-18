// Agents' sessions and their tasks, reconstructed from what each
// leaves on GitHub (the code viewer's Agents tab, repository-agents.js): a
// task is a pull request it opened, or a commit it pushed to the default
// branch without one; a session holds as many as name it, with the branches
// they are on and the issues they work on. The server reads each artifact's
// own texts, never others' comments on it (a pull request's body and its
// head and merge commits' messages, where an agent links its session; a
// commit's message; a branch's tip commit) for the marks an agent leaves
// (agentSignals), sending those alone; agentSessions then groups them:
// those naming one session, a pull request with its branch, a branch with
// the session its commits name, an issue with the pull requests closing it
// or a branch named for it. Without a session named, a branch's pull
// requests are one session, and a commit its own.
//
// The agents are Claude and Codex, and those the server knows by their GitHub
// Apps or accounts (repository-agents.ts APP_AGENTS): each told by its
// fingerprint, a line of its texts, by the account its work is authored by,
// or by its branches' prefix, the server's to read, and named to the client
// by its id, name and avatar (AppAgent). Such an agent names no session:
// a pull request of its is a session alone, with its branch; Claude's or
// Codex's marks on its work show those as its tools. A pull request labelled
// for an agent (labelAgents) is that agent's too, where its own texts and
// branch name none: the mark one who ran it gives work it left unmarked.

// 'claude', 'codex', or an app agent's id.
export type Agent = string

// An agent known by its GitHub App or account, as the server names it to the
// client: its id, its name, and its avatar, its mark (/api/avatar/<avatar>:
// `app-<id>` a GitHub App's, `user-<id>` a GitHub account's), where the app
// draws no mark of its own for it (Copilot's, ui/view/repository-tiles.js).
export interface AppAgent { id: string; name: string; avatar?: string }
// How the server tells one: its fingerprint, a line of an artifact's texts
// starting with it; the GitHub account its work is authored by, its id and
// the logins GitHub names it by, none for one known by its id alone; its
// branches' prefix.
export interface AppAgentMarks { id: string; fingerprint?: string; account?: { id: number; logins: readonly string[] }; prefix: string }
// An artifact's author, as GitHub names its account: its login and id.
export interface AgentAuthor { login: string; id: number }

// What an artifact's texts say of the agents that made it: the Claude Code
// sessions and Codex tasks they link, whether they carry Claude's marks,
// its co-author trailer or its "Generated with" line, and Codex's, its
// co-author trailer, and the app agents whose fingerprints they carry, or
// whose branch it is.
export interface AgentSignals { sessions: string[]; tasks: string[]; claude: boolean; codex: boolean; agents: string[] }

// Each by its author's login, and their account's numeric id (`authorId`)
// where GitHub names it.
export interface AgentPull { number: number; title: string; state: 'open' | 'merged' | 'closed'; draft: boolean; author: string | null; authorId?: number | null
  // Its branch, and the owner of the fork it is in, null where it is in the
  // repository itself.
  createdAt: number | null; updatedAt: number | null; head: string | null; fork: string | null; additions: number; deletions: number; commits: number
  closes: number[]; signals: AgentSignals }
export interface AgentIssue { number: number; title: string; state: 'open' | 'closed'; author: string | null; authorId?: number | null; createdAt: number | null; updatedAt: number | null }
export interface AgentBranch { name: string; at: number | null; author: string | null; authorId?: number | null; signals: AgentSignals }
// A commit to the default branch no pull request merged.
export interface AgentCommit { oid: string; title: string; at: number | null; author: string | null; authorId?: number | null; additions: number; deletions: number
  signals: AgentSignals }

export interface AgentSession {
  id: string
  agents: Agent[]
  // Where to open it: a Claude Code session or a Codex task.
  sessions: string[]
  tasks: string[]
  title: string
  authors: string[]
  startedAt: number | null
  updatedAt: number | null
  state: 'open' | 'merged' | 'closed' | 'branch'
  // Its tasks: the pull requests it opened, and the commits it pushed to
  // the default branch, the newest first.
  pulls: Pick<AgentPull, 'number' | 'title' | 'state' | 'draft'>[]
  commits: Pick<AgentCommit, 'oid' | 'title'>[]
  issues: Pick<AgentIssue, 'number' | 'title' | 'state'>[]
  branches: string[]
  // The commits its pull requests hold, and their lines and its commits'.
  commitCount: number
  additions: number
  deletions: number
}

const SESSION = /https:\/\/claude\.ai\/code\/(session_[A-Za-z\d]{6,64})\b/gu
const CODEX_TASK = /https:\/\/chatgpt\.com\/codex\/tasks\/(task_[a-z]_[A-Za-z\d]{6,64})\b/gu
// Claude's marks on its commits and pull requests: its co-author trailer,
// its "Generated with" line, its session trailer.
const CLAUDE_MARK = /^co-authored-by: claude\b|generated with \[claude code\]|^claude-session:/imu
// Codex's: its co-author trailer, by its address, as Codex names itself
// co-author of the commits it makes as whoever ran it; a trailer of a text's
// trailers (trailerBlock), not a line before them that shows one.
const CODEX_MARK = /^co-authored-by:[ \t]*[^<\n]*<codex@openai\.com>[ \t]*$/imu
const MAX_LINKS = 8

// A message's trailers, as git reads them (`git interpret-trailers`): its
// last paragraph, past its subject's, where each of its lines is a trailer
// (`Key: value`) or goes on with one (indented), or, where it holds git's
// own `Signed-off-by:`, a quarter of them are; none where it isn't, as
// lines a description or example holds, fenced or not, are not.
const TRAILER_LINE = /^[A-Za-z\d-]+[ \t]*:/u
export function trailerBlock(text: string): string {
  const paragraphs = text.replaceAll('\r\n', '\n').trim().split(/\n[ \t]*\n/u)
  const block = paragraphs.length > 1 ? paragraphs.at(-1)! : ''
  const lines = block.split('\n')
  const trailers = lines.filter(line => TRAILER_LINE.test(line)).length
  const others = lines.filter((line, at) => !TRAILER_LINE.test(line) && !(at > 0 && /^[ \t]/u.test(line))).length
  return others === 0 || (lines.some(line => /^signed-off-by[ \t]*:/iu.test(line)) && trailers * 3 >= others) ? block : ''
}

// The agents of those whose ids are `ids` that `labels` name (a pull
// request's): a label an agent's id, regardless of case, alone or after
// `agent:` or `agent/` (`Codex`, `agent: claude`).
const LABEL = /^(?:agent[:/] ?)?([a-z][a-z\d-]*)$/u
export function labelAgents(labels: unknown[], ids: readonly string[]): Agent[] {
  return [...new Set(labels.flatMap(label => {
    const id = typeof label === 'string' ? LABEL.exec(label.trim().toLowerCase())?.[1] : undefined
    return id !== undefined && ids.includes(id) ? [id] : []
  }))]
}

// The sessions and tasks `texts` link, whether they carry Claude's marks and
// Codex's, and the agents of `apps` whose fingerprints start a line of them
// (not one a text quotes, as one describing it may), whose account `author`
// is, by its id and login both (its id alone where it names no login), or
// whose prefix the branch `branch` is under;
// Claude, Codex or the agents of `apps` its `labels` name (labelAgents).
export function agentSignals(texts: unknown[], apps: readonly AppAgentMarks[] = [], branch: string | null = null,
  author: AgentAuthor | null = null, labels: unknown[] = []): AgentSignals {
  const strings = texts.filter((text): text is string => typeof text === 'string')
  const found = (pattern: RegExp) => [...new Set(strings.flatMap(text => [...text.matchAll(pattern)].map(match => match[1]!)))].slice(0, MAX_LINKS)
  const lines = strings.flatMap(text => text.split('\n').map(line => line.trimStart()))
  const login = author?.login.toLowerCase()
  const authored = ({ account }: AppAgentMarks) => author !== null && account !== undefined && account.id === author.id
    && (account.logins.length === 0 || account.logins.some(name => name.toLowerCase() === login))
  const labelled = labelAgents(labels, ['claude', 'codex', ...apps.map(app => app.id)])
  return { sessions: found(SESSION), tasks: found(CODEX_TASK), claude: labelled.includes('claude') || strings.some(text => CLAUDE_MARK.test(text)),
    codex: labelled.includes('codex') || strings.some(text => CODEX_MARK.test(trailerBlock(text))),
    agents: apps.filter(app => (app.fingerprint && lines.some(line => line.startsWith(app.fingerprint!)))
      || authored(app) || branch?.startsWith(app.prefix) || labelled.includes(app.id)).map(app => app.id) }
}

// The agent a branch's name says made it, and the issue or pull request the
// Claude GitHub App names its branch for (`claude/issue-12-…`).
export function agentBranch(name: string | null): { agent: Agent | null; issue: number | null; pull: number | null } {
  const agent = name?.startsWith('claude/') ? 'claude' : name?.startsWith('codex/') ? 'codex' : null
  const named = agent === 'claude' ? /^claude\/(issue|pr)-([1-9]\d{0,9})-/u.exec(name!) : null
  return { agent, issue: named?.[1] === 'issue' ? Number(named[2]) : null, pull: named?.[1] === 'pr' ? Number(named[2]) : null }
}

// A pull request's branch, as GitHub names one in a fork: `owner:branch`;
// two forks' of one name, or a fork's and the repository's, are two.
const headName = (pull: AgentPull) => pull.head && pull.fork ? `${pull.fork}:${pull.head}` : pull.head

const signalAgents = (signals: AgentSignals): Agent[] => [...signals.agents, ...signals.sessions.length > 0 || signals.claude ? ['claude'] : [],
  ...signals.tasks.length > 0 || signals.codex ? ['codex'] : []]
const TOOLS = new Set(['claude', 'codex'])

type Artifacts = { pulls?: AgentPull[]; commits?: AgentCommit[]; issues?: AgentIssue[]; branches?: AgentBranch[] }
type Group = { agents: Set<Agent>; keys: string[] }

// The artifacts joined (`pull:<n>`, `commit:<oid>`, `branch:<name>`,
// `session:<id>`, `task:<id>`), each set with the agents whose marks are on
// them: by the sessions and tasks they link and the branches pull requests
// are from. An app agent's join none by what they link, and a pull request
// of its its branch alone, where no pull request newer is from it, an app
// agent's or another's: one a session.
function artifactGroups({ pulls = [], commits = [], branches = [] }: Artifacts): Group[] {
  const parent = new Map<string, string>()
  const find = (key: string): string => {
    let root = key
    while (parent.has(root) && parent.get(root) !== root) root = parent.get(root)!
    parent.set(key, root)
    return root
  }
  const join = (a: string, b: string) => {
    const [x, y] = [find(a), find(b)]
    if (x !== y) parent.set(y, x)
  }
  const agentsOf = new Map<string, Set<Agent>>()
  const mark = (key: string, agents: Agent[]) => { for (const agent of agents) agentsOf.set(key, new Set([...agentsOf.get(key) ?? [], agent])) }
  const linked = (key: string, signals: AgentSignals) => {
    find(key)
    if (signals.agents.length === 0) for (const session of signals.sessions) join(key, `session:${session}`)
    if (signals.agents.length === 0) for (const task of signals.tasks) join(key, `task:${task}`)
    mark(key, signalAgents(signals))
  }
  const branchNames = new Set(branches.map(branch => branch.name))
  for (const branch of branches) {
    const key = `branch:${branch.name}`
    linked(key, branch.signals)
    const { agent } = agentBranch(branch.name)
    if (agent) mark(key, [agent])
  }
  // The newest pull request read from each branch, by its number, as GitHub
  // numbers them as they are opened: they are read as they were updated.
  const newest = new Map<string, number>()
  for (const pull of pulls) {
    const head = headName(pull)
    if (head !== null && pull.number > (newest.get(head) ?? 0)) newest.set(head, pull.number)
  }
  for (const pull of pulls) {
    const key = `pull:${pull.number}`
    linked(key, pull.signals)
    const { agent, pull: named } = agentBranch(pull.head)
    if (agent) mark(key, [agent])
    // Its branch, an agent's or its own, read or not; a fork's its own.
    const head = headName(pull)
    if (pull.signals.agents.length > 0) {
      if (head !== null && newest.get(head) === pull.number) join(key, `branch:${head}`)
      continue
    }
    if (head && (agent || signalAgents(pull.signals).length > 0 || branchNames.has(head))) join(key, `branch:${head}`)
    if (named) join(key, `pull:${named}`)
  }
  for (const commit of commits) linked(`commit:${commit.oid}`, commit.signals)

  const groups = new Map<string, Group>()
  for (const key of parent.keys()) {
    const root = find(key)
    const group = groups.get(root) ?? { agents: new Set(), keys: [] }
    group.keys.push(key)
    for (const agent of agentsOf.get(key) ?? []) group.agents.add(agent)
    groups.set(root, group)
  }
  return [...groups.values()]
}

const byTime = <T>(time: (item: T) => number | null) => (a: T, b: T) => (time(a) ?? 0) - (time(b) ?? 0)

// The session a group of artifacts is, its tasks and what they touched; null
// for one no agent left marks on, or holding none read.
function sessionOf({ agents, keys }: Group, { pulls, commits, issues, branches }: {
  pulls: Map<number, AgentPull>; commits: Map<string, AgentCommit>; issues: Map<number, AgentIssue>; branches: Map<string, AgentBranch> }): AgentSession | null {
  if (agents.size === 0) return null
  const of = (prefix: string) => keys.filter(key => key.startsWith(prefix)).map(key => key.slice(prefix.length))
  const taskPulls = of('pull:').flatMap(number => pulls.get(Number(number)) ?? []).toSorted(byTime(pull => pull.createdAt))
  const taskCommits = of('commit:').flatMap(oid => commits.get(oid) ?? []).toSorted(byTime(commit => commit.at))
  const names = [...new Set([...of('branch:'), ...taskPulls.flatMap(pull => headName(pull) ?? [])])]
  // The issues its pull requests close, and those its branches are named
  // for, by a pull request's own name for its branch, a fork's too.
  const issueNumbers = new Set([...taskPulls.flatMap(pull => pull.closes),
    ...taskPulls.flatMap(pull => agentBranch(pull.head).issue ?? []), ...of('branch:').flatMap(name => agentBranch(name).issue ?? [])])
  const taskIssues = [...issueNumbers].flatMap(number => issues.get(number) ?? []).toSorted(byTime(issue => issue.createdAt))
  const taskBranches = names.flatMap(name => branches.get(name) ?? [])
  const items = [...taskPulls, ...taskCommits, ...taskIssues, ...taskBranches]
  if (items.length === 0) return null
  const [codexTasks, sessions] = [of('task:'), of('session:')]
  const started = items.flatMap(item => ('createdAt' in item ? item.createdAt : item.at) ?? [])
  const updated = items.flatMap(item => ('updatedAt' in item ? item.updatedAt : item.at) ?? [])
  const states = new Set(taskPulls.map(pull => pull.state))
  // Its first task names it: the earliest of its pull requests and commits.
  const first = [...taskPulls.map(pull => ({ at: pull.createdAt, title: pull.title })), ...taskCommits.map(commit => ({ at: commit.at, title: commit.title }))]
    .toSorted(byTime(task => task.at))[0]
  const landed = [...taskPulls, ...taskCommits]
  return {
    id: sessions[0] ?? codexTasks[0] ?? (taskPulls[0] ? `pull-${taskPulls[0].number}` : taskCommits[0]?.oid ?? names[0] ?? ''),
    // An app agent's first, the one whose session it is, then the tools it
    // used, Claude's or Codex's.
    agents: [...[...agents].filter(agent => !TOOLS.has(agent)), ...['claude', 'codex'].filter(agent => agents.has(agent))],
    sessions, tasks: codexTasks,
    title: first?.title ?? taskIssues[0]?.title ?? names[0] ?? '',
    authors: [...new Set(items.flatMap(item => item.author ?? []))],
    startedAt: started.length > 0 ? Math.min(...started) : null,
    updatedAt: updated.length > 0 ? Math.max(...updated) : null,
    state: states.has('open') ? 'open' : states.has('merged') || taskCommits.length > 0 ? 'merged' : states.has('closed') ? 'closed' : 'branch',
    pulls: taskPulls.map(({ number, title, state, draft }) => ({ number, title, state, draft })).toReversed(),
    commits: taskCommits.map(({ oid, title }) => ({ oid, title })).toReversed(),
    issues: taskIssues.map(({ number, title, state }) => ({ number, title, state })),
    branches: names,
    commitCount: taskPulls.reduce((sum, pull) => sum + pull.commits, 0) + taskCommits.length,
    additions: landed.reduce((sum, item) => sum + item.additions, 0),
    deletions: landed.reduce((sum, item) => sum + item.deletions, 0),
  }
}

// The sessions `pulls`, `commits`, `issues` and `branches` make, the most
// recently updated first: each a set of them, joined by the sessions and
// tasks they link and the branches pull requests are from, with the issues
// a pull request closes or a branch is named for.
// Artifacts no agent left marks on belong to none. Where pull requests
// updated before `branchesSince` are yet to be read, a session of branches
// alone older than that waits for them: its pull request may be among them.
export function agentSessions(artifacts: Artifacts, { branchesSince = null }: { branchesSince?: number | null } = {}): AgentSession[] {
  const lookups = {
    pulls: new Map((artifacts.pulls ?? []).map(pull => [pull.number, pull])),
    commits: new Map((artifacts.commits ?? []).map(commit => [commit.oid, commit])),
    issues: new Map((artifacts.issues ?? []).map(issue => [issue.number, issue])),
    branches: new Map((artifacts.branches ?? []).map(branch => [branch.name, branch])),
  }
  const waiting = (session: AgentSession) => branchesSince !== null && session.pulls.length === 0 && session.commits.length === 0
    && (session.updatedAt ?? 0) < branchesSince
  return artifactGroups(artifacts).flatMap(group => sessionOf(group, lookups) ?? []).filter(session => !waiting(session))
    .toSorted(byTime(session => session.updatedAt)).toReversed()
}
