// Claude and Codex sessions and their tasks, reconstructed from what each
// leaves on GitHub (the code viewer's Agents tab, repository-agents.js): a
// task is a pull request it opened, or a commit it pushed to the default
// branch without one; a session holds as many as name it, with the branches
// they are on and the issues they work on. The server reads each artifact's
// texts (a pull request's body, comments, head and merge commits; a commit's
// message; an issue's body and comments; a branch's tip commit) for the
// marks an agent leaves (agentSignals), sending those alone; agentSessions
// then groups them: those naming one session, a pull request with its
// branch, a branch with the session its commits name, an issue with the
// session it names or the pull requests closing it. Without a session named,
// a branch's pull requests are one session, and a commit its own.

export type Agent = 'claude' | 'codex'

// What an artifact's texts say of the agents that made it: the Claude Code
// sessions and Codex tasks they link, and whether they carry Claude's
// marks, its co-author trailer or its "Generated with" line.
export interface AgentSignals { sessions: string[]; tasks: string[]; claude: boolean }

export interface AgentPull { number: number; title: string; state: 'open' | 'merged' | 'closed'; draft: boolean; author: string | null
  createdAt: number | null; updatedAt: number | null; head: string | null; additions: number; deletions: number; commits: number
  closes: number[]; signals: AgentSignals }
export interface AgentIssue { number: number; title: string; state: 'open' | 'closed'; author: string | null; createdAt: number | null; updatedAt: number | null
  signals: AgentSignals }
export interface AgentBranch { name: string; at: number | null; author: string | null; signals: AgentSignals }
// A commit to the default branch no pull request merged.
export interface AgentCommit { oid: string; title: string; at: number | null; author: string | null; additions: number; deletions: number
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
const MAX_LINKS = 8

// The sessions and tasks `texts` link, and whether they carry Claude's marks
// (`marked`: an artifact's own texts, not others' comments on it, whose
// footers only say who wrote them).
export function agentSignals(texts: unknown[], marked: unknown[] = texts): AgentSignals {
  const strings = texts.filter((text): text is string => typeof text === 'string')
  const found = (pattern: RegExp) => [...new Set(strings.flatMap(text => [...text.matchAll(pattern)].map(match => match[1]!)))].slice(0, MAX_LINKS)
  return { sessions: found(SESSION), tasks: found(CODEX_TASK), claude: marked.some(text => typeof text === 'string' && CLAUDE_MARK.test(text)) }
}

// The agent a branch's name says made it, and the issue or pull request the
// Claude GitHub App names its branch for (`claude/issue-12-…`).
export function agentBranch(name: string | null): { agent: Agent | null; issue: number | null; pull: number | null } {
  const agent = name?.startsWith('claude/') ? 'claude' : name?.startsWith('codex/') ? 'codex' : null
  const named = agent === 'claude' ? /^claude\/(issue|pr)-([1-9]\d{0,9})-/u.exec(name!) : null
  return { agent, issue: named?.[1] === 'issue' ? Number(named[2]) : null, pull: named?.[1] === 'pr' ? Number(named[2]) : null }
}

const signalAgents = (signals: AgentSignals): Agent[] => [...signals.sessions.length > 0 || signals.claude ? ['claude' as const] : [],
  ...signals.tasks.length > 0 ? ['codex' as const] : []]

type Artifacts = { pulls?: AgentPull[]; commits?: AgentCommit[]; issues?: AgentIssue[]; branches?: AgentBranch[] }
type Group = { agents: Set<Agent>; keys: string[] }

// The artifacts joined (`pull:<n>`, `commit:<oid>`, `branch:<name>`,
// `issue:<n>`, `session:<id>`, `task:<id>`), each set with the agents whose
// marks are on them: by the sessions and tasks they link and the branches
// pull requests are from.
function artifactGroups({ pulls = [], commits = [], issues = [], branches = [] }: Artifacts): Group[] {
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
    for (const session of signals.sessions) join(key, `session:${session}`)
    for (const task of signals.tasks) join(key, `task:${task}`)
    mark(key, signalAgents(signals))
  }
  const branchNames = new Set(branches.map(branch => branch.name))
  for (const branch of branches) {
    const key = `branch:${branch.name}`
    linked(key, branch.signals)
    const { agent } = agentBranch(branch.name)
    if (agent) mark(key, [agent])
  }
  for (const pull of pulls) {
    const key = `pull:${pull.number}`
    linked(key, pull.signals)
    const { agent, pull: named } = agentBranch(pull.head)
    if (agent) mark(key, [agent])
    // Its branch, an agent's or its own, read or not.
    if (pull.head && (agent || signalAgents(pull.signals).length > 0 || branchNames.has(pull.head))) join(key, `branch:${pull.head}`)
    if (named) join(key, `pull:${named}`)
  }
  for (const commit of commits) linked(`commit:${commit.oid}`, commit.signals)
  // The issues sessions link are those sessions'; one a task's pull request
  // closes, or its branch is named for, is shown with it, joining none.
  for (const issue of issues) if (issue.signals.sessions.length > 0 || issue.signals.tasks.length > 0) linked(`issue:${issue.number}`, issue.signals)

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
  const names = [...new Set([...of('branch:'), ...taskPulls.flatMap(pull => pull.head ?? [])])]
  const issueNumbers = new Set([...of('issue:').map(Number), ...taskPulls.flatMap(pull => pull.closes), ...names.flatMap(name => agentBranch(name).issue ?? [])])
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
    id: sessions[0] ?? codexTasks[0] ?? (taskPulls[0] ? `pull-${taskPulls[0].number}` : taskCommits[0]?.oid ?? names[0] ?? `issue-${taskIssues[0]!.number}`),
    agents: (['claude', 'codex'] as const).filter(agent => agents.has(agent)),
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
// the session links, a pull request closes, or a branch is named for.
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
  const waiting = (session: AgentSession) => branchesSince !== null && session.pulls.length === 0 && session.commits.length === 0 && session.issues.length === 0
    && (session.updatedAt ?? 0) < branchesSince
  return artifactGroups(artifacts).flatMap(group => sessionOf(group, lookups) ?? []).filter(session => !waiting(session))
    .toSorted(byTime(session => session.updatedAt)).toReversed()
}
