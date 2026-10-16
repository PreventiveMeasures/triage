import assert from 'node:assert/strict'
import { test } from 'node:test'
import { agentBranch, agentSessions, agentSignals } from '../common/managed/agent-tasks.ts'

const none = { sessions: [], tasks: [], claude: false, codex: false, agents: [] }
const session = id => ({ sessions: [id], tasks: [], claude: true, codex: false, agents: [] })
// An agent the server knows by its app, as it tells one, and its marks.
const apps = [{ id: 'neo', fingerprint: '🤖 Generated with [Neo](', prefix: 'neo/' }, { id: 'copilot', account: { id: 198982749, logins: ['Copilot', 'copilot-swe-agent'] }, prefix: 'copilot/' },
  { id: 'dependabot', account: { id: 49699333, logins: ['dependabot', 'dependabot[bot]'] }, prefix: 'dependabot/' }]
const neo = { ...none, agents: ['neo'] }
const pull = (number, head, signals = none, more = {}) => ({ number, title: `Pull ${number}`, state: 'merged', draft: false, author: 'ada', createdAt: number * 10,
  updatedAt: number * 10 + 5, head, fork: null, additions: 10, deletions: 2, commits: 1, closes: [], signals, ...more })
const commit = (oid, signals, at) => ({ oid: oid.repeat(40), title: `Commit ${oid}`, at, author: 'ada', additions: 3, deletions: 1, signals })
const issue = number => ({ number, title: `Issue ${number}`, state: 'open', author: 'grace', createdAt: number, updatedAt: number })
const branch = (name, signals = none, at = 1) => ({ name, at, author: 'ada', signals })

test('an artifact\'s texts name the sessions and tasks they link, and Claude\'s marks', () => {
  const body = 'Fixes it.\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n\nhttps://claude.ai/code/session_01MamW9SFrduHwBFipxyjRnn'
  const merge = 'Title (#9)\n\n* Work\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_01MamW9SFrduHwBFipxyjRnn'
  assert.deepEqual(agentSignals([body, merge, null], apps), { sessions: ['session_01MamW9SFrduHwBFipxyjRnn'], tasks: [], claude: true, codex: false, agents: [] })
  assert.deepEqual(agentSignals(['Codex ran it: https://chatgpt.com/codex/tasks/task_e_68a1b2c3d4e5f6']),
    { sessions: [], tasks: ['task_e_68a1b2c3d4e5f6'], claude: false, codex: false, agents: [] })
  // An app agent's fingerprint, Claude Code's line with it or not, or its branch's prefix.
  assert.deepEqual(agentSignals(['Links.\n\n🤖 Generated with [Neo](https://neo.example)\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)'], apps),
    { ...neo, claude: true })
  assert.deepEqual([agentSignals(['🤖 Generated with [Neo](https://neo.example)'], apps), agentSignals(['Work'], apps, 'neo/fix-links')], [neo, neo])
  assert.deepEqual(agentSignals(['Neo, the film', '🤖 Generated with [Neon](x)', 'Generated with [Neo](x)'], apps, 'feature/neo'), none)
  assert.deepEqual(agentSignals(['🤖 Generated with [Neo](x)']), none, 'none known, none told')
  // Its fingerprint a line of its own, not one a text quotes, as one
  // describing it does.
  assert.deepEqual(agentSignals(['Its fingerprint: `🤖 Generated with [Neo](`, its prefix `neo/`.', '- `{ fingerprint: \'🤖 Generated with [Neo](\' }`'], apps), none)
  assert.deepEqual(agentSignals(['Done.\r\n  🤖 Generated with [Neo](x)\r\n'], apps), neo, 'indented, or after a carriage return')
  // An agent known by the account its work is authored by, whatever its case.
  const copilot = { ...none, agents: ['copilot'] }
  assert.deepEqual([agentSignals(['Move the database'], apps, 'feature/db', { login: 'Copilot', id: 198982749 }),
    agentSignals(['Work'], apps, null, { login: 'copilot-swe-agent', id: 198982749 }), agentSignals(['Work'], apps, 'copilot/fix-db'),
    agentSignals(['Copilot said so'], apps, null, { login: 'ada', id: 1 })], [copilot, copilot, copilot, none])
  // Its account by its id and login both: neither alone.
  assert.deepEqual([agentSignals(['Work'], apps, null, { login: 'Copilot', id: 1 }), agentSignals(['Work'], apps, null, { login: 'ada', id: 198982749 }),
    agentSignals(['Work'], apps, null, { login: 'dependabot', id: 198982749 })], [none, none, none])
  const dependabot = { ...none, agents: ['dependabot'] }
  assert.deepEqual([agentSignals(['Bump ws'], apps, 'dependabot/npm_and_yarn/ws-8.21.0', { login: 'dependabot', id: 49699333 }),
    agentSignals(['Bump ws'], apps, null, { login: 'dependabot[bot]', id: 49699333 }), agentSignals(['@dependabot rebase'], apps, 'feature/ws', { login: 'ada', id: 1 })],
  [dependabot, dependabot, none])
  // Codex's co-author trailer, by its address, whatever name it gives; not one a line quotes.
  assert.deepEqual([agentSignals(['Tidy\n\nCo-authored-by: Codex <codex@openai.com>']), agentSignals(['Tidy\n\nco-authored-by: codex <Codex@OpenAI.com>'])],
    [{ ...none, codex: true }, { ...none, codex: true }])
  assert.deepEqual(agentSignals(['Credit it as `Co-authored-by: Codex <codex@openai.com>`', 'Co-authored-by: Codex Fan <fan@example.com>']), none)
  // Claude Code's own page, or Codex's settings, is no task.
  assert.deepEqual(agentSignals(['[Claude Code](https://claude.ai/code)', 'https://chatgpt.com/codex/cloud/settings/general']), none)
  assert.deepEqual([agentBranch('claude/issue-12-20260101-1200'), agentBranch('claude/pr-7-x'), agentBranch('codex/fix-it'), agentBranch('feature/claude')], [
    { agent: 'claude', issue: 12, pull: null }, { agent: 'claude', issue: null, pull: 7 }, { agent: 'codex', issue: null, pull: null },
    { agent: null, issue: null, pull: null },
  ])
})

test('one session holds every pull request and commit to the default branch that names it, whatever branch each is on', () => {
  const sessions = agentSessions({
    pulls: [pull(1, 'claude/magical-mayer', session('session_A')), pull(2, 'claude/magical-mayer', session('session_A'), { state: 'open' }),
      pull(3, 'claude/magical-mayer-history', session('session_A'), { additions: 5 }), pull(4, 'feature/by-hand')],
    commits: [commit('a', session('session_A'), 100), commit('b', { ...none, claude: true }, 7), commit('c', { ...none, codex: true }, 6)],
    branches: [branch('claude/magical-mayer', session('session_A'), 50)],
  })
  assert.equal(sessions.length, 3, 'a pull request without marks is none of them')
  const [claude, alone, codex] = sessions
  assert.deepEqual([claude.id, claude.agents, claude.sessions, claude.state], ['session_A', ['claude'], ['session_A'], 'open'])
  assert.deepEqual(claude.pulls.map(item => item.number), [3, 2, 1], 'the newest first')
  assert.deepEqual(claude.commits.map(item => item.title), ['Commit a'])
  assert.deepEqual(claude.branches.toSorted(), ['claude/magical-mayer', 'claude/magical-mayer-history'])
  assert.equal(claude.title, 'Pull 1', 'its first task names it')
  assert.deepEqual([claude.commitCount, claude.additions, claude.deletions, claude.updatedAt], [4, 28, 7, 100])
  // A commit Claude marked, naming no session, is a session of its own, landed.
  assert.deepEqual([alone.id, alone.agents, alone.state, alone.title, alone.pulls], ['b'.repeat(40), ['claude'], 'merged', 'Commit b', []])
  assert.deepEqual([codex.id, codex.agents, codex.title], ['c'.repeat(40), ['codex'], 'Commit c'], 'one Codex co-authored, Codex\'s')
})

test('without a session named, a branch\'s pull requests are one, an agent\'s branch without any its own, and an issue joins the session closing it or named for it', () => {
  const sessions = agentSessions({
    pulls: [pull(5, 'codex/advisory-layout', none, { closes: [40] }), pull(6, 'codex/advisory-layout', none, { state: 'closed' }), pull(7, 'codex/other')],
    branches: [branch('codex/abandoned', none, 3), branch('claude/issue-41-20260101-1200', none, 2)],
    issues: [issue(40), issue(41), issue(43)],
  })
  const byId = new Map(sessions.map(item => [item.id, item]))
  assert.deepEqual(byId.get('pull-5').pulls.map(item => item.number), [6, 5])
  assert.deepEqual([byId.get('pull-5').agents, byId.get('pull-5').state, byId.get('pull-5').issues.map(item => item.number)], [['codex'], 'merged', [40]])
  assert.deepEqual(byId.get('pull-7').branches, ['codex/other'])
  assert.deepEqual([byId.get('codex/abandoned').state, byId.get('codex/abandoned').pulls], ['branch', []])
  assert.deepEqual(byId.get('claude/issue-41-20260101-1200').issues.map(item => item.number), [41])
  assert.equal(sessions.some(item => item.issues.some(linked => linked.number === 43)), false, 'one no agent touched is none\'s')
})

test('where older pull requests are yet to be read, a session of branches alone older than those read waits for them, one named for an issue too', () => {
  const artifacts = { pulls: [pull(9, 'codex/new')], branches: [branch('codex/new', none, 80), branch('codex/old', none, 50), branch('codex/fresh', none, 120),
    branch('claude/issue-12-old', none, 40)], issues: [issue(12)] }
  assert.deepEqual(agentSessions(artifacts, { branchesSince: 95 }).map(item => item.id), ['codex/fresh', 'pull-9'])
  assert.deepEqual(agentSessions(artifacts).map(item => item.id), ['codex/fresh', 'pull-9', 'codex/old', 'claude/issue-12-old'], 'all read, they show')
})

test('pull requests from forks, of one branch name, are a session each, apart from the repository\'s own branch of that name', () => {
  const sessions = agentSessions({ pulls: [pull(1, 'codex/fix', none, { fork: 'ada' }), pull(2, 'codex/fix', none, { fork: 'grace' }), pull(3, 'codex/fix'),
    pull(4, 'codex/fix', none, { fork: 'ada' })], branches: [branch('codex/fix')] })
  assert.deepEqual(sessions.map(item => [item.pulls.map(linked => linked.number), item.branches]).toSorted(), [
    [[2], ['grace:codex/fix']], [[3], ['codex/fix']], [[4, 1], ['ada:codex/fix']],
  ])
  // A fork's branch named for an issue is that issue's all the same.
  const [named] = agentSessions({ pulls: [pull(5, 'claude/issue-12-fix', none, { fork: 'ada' })], issues: [issue(12)] })
  assert.deepEqual([named.branches, named.issues.map(item => item.number)], [['ada:claude/issue-12-fix'], [12]])
})

test('a Claude session a Codex task pushed to is both agents\'', () => {
  const [both] = agentSessions({ pulls: [pull(8, 'claude/shared', session('session_C')), pull(9, 'claude/shared', { ...none, tasks: ['task_e_123456'] })] })
  assert.deepEqual([both.agents, both.sessions, both.tasks], [['claude', 'codex'], ['session_C'], ['task_e_123456']])
})

test('an agent known by its app names no session: a pull request of its is one alone, its branch with the newest; it first, Claude or Codex beside it where their marks are on it', () => {
  const sessions = agentSessions({
    pulls: [pull(12, 'neo/retry', neo, { state: 'open' }), pull(11, 'neo/retry', neo, { state: 'closed' }), pull(10, 'neo/links', { ...neo, claude: true }),
      pull(9, 'feature/by-neo', { ...neo, tasks: ['task_e_123456'] }), pull(8, 'neo/linked', { ...session('session_A'), agents: ['neo'] }),
      pull(7, 'claude/other', session('session_A'))],
    commits: [commit('n', neo, 5)],
    branches: [branch('neo/retry', neo, 120), branch('neo/alone', neo, 90)],
  })
  const byId = new Map(sessions.map(item => [item.id, item]))
  assert.deepEqual([...byId.keys()].toSorted(), ['neo/alone', 'n'.repeat(40), 'pull-10', 'pull-11', 'pull-12', 'pull-8', 'pull-9', 'session_A'])
  assert.deepEqual(['pull-12', 'pull-11', 'pull-10', 'pull-9', 'pull-8'].map(id => [byId.get(id).pulls.map(item => item.number), byId.get(id).agents]),
    [[[12], ['neo']], [[11], ['neo']], [[10], ['neo', 'claude']], [[9], ['neo', 'codex']], [[8], ['neo', 'claude']]], 'one pull request a session, never joined by what it links')
  assert.deepEqual([byId.get('pull-12').branches, byId.get('pull-11').branches], [['neo/retry'], ['neo/retry']])
  assert.deepEqual([byId.get('pull-12').startedAt, byId.get('pull-11').startedAt], [120, 110], 'the branch read with the newest of its pull requests alone')
  assert.deepEqual([byId.get('pull-8').sessions, byId.get('session_A').pulls.map(item => item.number)], [[], [7]])
  assert.deepEqual([byId.get('neo/alone').agents, byId.get('neo/alone').state], [['neo'], 'branch'])
  assert.deepEqual([byId.get('n'.repeat(40)).agents, byId.get('n'.repeat(40)).state], [['neo'], 'merged'])
})

test('an agent\'s pull request older than another\'s from its branch, the agent\'s or not, keeps apart from it', () => {
  // Claude's session, a pull request of which an app agent's marks are on
  // (as one quoting them may have), its branch the newer's.
  const sessions = agentSessions({ pulls: [pull(25, 'claude/x', session('session_B')), pull(21, 'claude/x', { ...session('session_B'), agents: ['neo'] })] })
  const byId = new Map(sessions.map(item => [item.id, item]))
  assert.deepEqual([byId.get('session_B').agents, byId.get('session_B').pulls.map(item => item.number)], [['claude'], [25]])
  assert.deepEqual([byId.get('pull-21').agents, byId.get('pull-21').branches], [['neo', 'claude'], ['claude/x']])
  // Read first, as one updated since the newer was opened is: newest by when
  // it was opened all the same, the marks on its branch's tip the newer's.
  const updated = new Map(agentSessions({ pulls: [pull(21, 'neo/y', neo), pull(25, 'neo/y', neo)], branches: [branch('neo/y', { ...neo, claude: true }, 300)] })
    .map(item => [item.id, item]))
  assert.deepEqual([updated.get('pull-25').agents, updated.get('pull-21').agents], [['neo', 'claude'], ['neo']])
})
