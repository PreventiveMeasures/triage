import assert from 'node:assert/strict'
import { test } from 'node:test'
import { agentBranch, agentSessions, agentSignals } from '../common/managed/agent-tasks.ts'

const none = { sessions: [], tasks: [], claude: false }
const session = id => ({ sessions: [id], tasks: [], claude: true })
const pull = (number, head, signals = none, more = {}) => ({ number, title: `Pull ${number}`, state: 'merged', draft: false, author: 'ada', createdAt: number * 10,
  updatedAt: number * 10 + 5, head, fork: null, additions: 10, deletions: 2, commits: 1, closes: [], signals, ...more })
const commit = (oid, signals, at) => ({ oid: oid.repeat(40), title: `Commit ${oid}`, at, author: 'ada', additions: 3, deletions: 1, signals })
const issue = number => ({ number, title: `Issue ${number}`, state: 'open', author: 'grace', createdAt: number, updatedAt: number })
const branch = (name, signals = none, at = 1) => ({ name, at, author: 'ada', signals })

test('an artifact\'s texts name the sessions and tasks they link, and Claude\'s marks', () => {
  const body = 'Fixes it.\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n\nhttps://claude.ai/code/session_01MamW9SFrduHwBFipxyjRnn'
  const merge = 'Title (#9)\n\n* Work\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_01MamW9SFrduHwBFipxyjRnn'
  assert.deepEqual(agentSignals([body, merge, null]), { sessions: ['session_01MamW9SFrduHwBFipxyjRnn'], tasks: [], claude: true })
  assert.deepEqual(agentSignals(['Codex ran it: https://chatgpt.com/codex/tasks/task_e_68a1b2c3d4e5f6']),
    { sessions: [], tasks: ['task_e_68a1b2c3d4e5f6'], claude: false })
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
    commits: [commit('a', session('session_A'), 100), commit('b', { sessions: [], tasks: [], claude: true }, 7)],
    branches: [branch('claude/magical-mayer', session('session_A'), 50)],
  })
  assert.equal(sessions.length, 2, 'a pull request without marks is none of them')
  const [claude, alone] = sessions
  assert.deepEqual([claude.id, claude.agents, claude.sessions, claude.state], ['session_A', ['claude'], ['session_A'], 'open'])
  assert.deepEqual(claude.pulls.map(item => item.number), [3, 2, 1], 'the newest first')
  assert.deepEqual(claude.commits.map(item => item.title), ['Commit a'])
  assert.deepEqual(claude.branches.toSorted(), ['claude/magical-mayer', 'claude/magical-mayer-history'])
  assert.equal(claude.title, 'Pull 1', 'its first task names it')
  assert.deepEqual([claude.commitCount, claude.additions, claude.deletions, claude.updatedAt], [4, 28, 7, 100])
  // A commit Claude marked, naming no session, is a session of its own, landed.
  assert.deepEqual([alone.id, alone.agents, alone.state, alone.title, alone.pulls], ['b'.repeat(40), ['claude'], 'merged', 'Commit b', []])
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
  const [both] = agentSessions({ pulls: [pull(8, 'claude/shared', session('session_C')), pull(9, 'claude/shared', { sessions: [], tasks: ['task_e_123456'], claude: false })] })
  assert.deepEqual([both.agents, both.sessions, both.tasks], [['claude', 'codex'], ['session_C'], ['task_e_123456']])
})
