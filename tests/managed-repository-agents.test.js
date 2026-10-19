import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AGENT_BRANCH_PREFIXES, APP_AGENTS } from '../server-managed/app-agents.ts'
import { openSqliteManagedDb } from '../server-managed/db.ts'
import { createManagedRequestHandler } from '../server-managed/http.ts'
import { AGENT_MARKS_READ } from '../server-managed/app-agents.ts'
import { COAUTHORS_READ } from '../server-managed/commit-coauthors.ts'
import { historyPageStore, repositoryReadStore } from '../server-managed/npm-kept.ts'
import { AGENTS_READ_VERSION } from '../server-managed/repository-agents.ts'
import { graphCommit } from '../server-managed/repository-history.ts'
import { createSession } from '../server-managed/session.ts'

test('the app agents are those of GITHUB_AGENTS with branches of their own, each told by its prefix and its fingerprint', () => {
  assert.deepEqual(APP_AGENTS, [
    { id: 'neo', name: 'Neo', avatar: 'app-3115942', prefix: 'neo/', fingerprint: '🤖 Generated with [Neo](' },
    { id: 'copilot', name: 'Copilot', prefix: 'copilot/' },
    { id: 'dependabot', name: 'Dependabot', avatar: 'app-29110', prefix: 'dependabot/' },
  ])
  assert.deepEqual(AGENT_BRANCH_PREFIXES, ['claude/', 'codex/', 'neo/', 'copilot/', 'dependabot/'])
})

const config = { sessionCookieName: 'sid', cookieSecure: false, sessionTtlMs: 60_000 }
const repo = { repoId: 1, fullName: 'org/repo', private: false, installationId: null, defaultBranch: 'main', htmlUrl: '', addedBy: null }
const publicMetadata = { id: 1, full_name: 'org/repo', private: false, visibility: 'public', default_branch: 'main' }
const userTokens = { accessToken: 'login-token', refreshToken: null, expiresAt: null }

// GitHub, as the reader and the agents' work read it: `asked` the GraphQL queries made.
function github(t, graphql) {
  const asked = []
  t.mock.method(globalThis, 'fetch', (input, options = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url)
    if (url.pathname === '/repos/org/repo') return Promise.resolve(Response.json(publicMetadata))
    if (url.pathname === '/graphql') {
      const body = JSON.parse(options.body)
      asked.push({ ...body, auth: options.headers?.authorization ?? null })
      return Promise.resolve(Response.json(graphql(body)))
    }
    return Promise.resolve(Response.json({ message: 'Not Found' }, { status: 404 }))
  })
  return asked
}

async function fixture(t, { role = 'admin', tokens = userTokens } = {}) {
  const db = openSqliteManagedDb(':memory:')
  t.after(() => db.close())
  const session = await createSession(config, db, { githubUserId: 1, login: 'manager', name: null, avatarUrl: null }, Date.now())
  await db.setUserRole(session.userId, role)
  await db.selectRepo(repo, Date.now())
  if (tokens) await db.setUserTokens(session.userId, tokens)
  await db.createTeam('team', 'Team', Date.now())
  await db.setTeamRepo('team', 1, 'src/allowed')
  await db.setTeamMember('team', session.userId, { dependencies: true, security: true })
  const handler = createManagedRequestHandler({ config, db, originGate: { isOriginAllowed: () => true }, isShuttingDown: () => false, track() {} })
  return Object.assign(async (query, { method = 'GET' } = {}) => {
    const res = { status: 0, body: '', headers: {}, writeHead(status, headers) { this.status = status; this.headers = headers }, end(body) { this.body = body } }
    await handler({ method, url: `/api/admin/repositories/agents?${new URLSearchParams(query)}`, headers: { cookie: session.setCookie.split(';')[0] } }, res)
    return { status: res.status, body: JSON.parse(res.body) }
  }, { db })
}

const cursor = 'Y3Vyc29yOnYyOpK0MjAyNi0xMC0xNVQwODozNToxN1rOrK_u7Q=='
const session = 'https://claude.ai/code/session_01MamW9SFrduHwBFipxyjRnn'
const [a, b, c] = ['a', 'b', 'c'].map(char => char.repeat(40))
const pullNode = (number, more) => ({ number, title: `Pull ${number}`, state: 'MERGED', isDraft: false, createdAt: '2026-10-14T00:00:00Z', updatedAt: '2026-10-15T00:00:00Z',
  author: { login: 'ChristopherTuring' }, body: '', headRefName: 'feature/x', additions: 7, deletions: 2, commits: { totalCount: 3, nodes: [{ commit: { message: 'Work' } }] },
  mergeCommit: null, closingIssuesReferences: { nodes: [] }, ...more })
const commitNode = (oid, message, more = {}) => ({ oid, messageHeadline: message.split('\n')[0], message, committedDate: '2026-10-15T01:00:00Z', additions: 3, deletions: 1,
  author: { email: 'christopher@rray.org', user: { login: 'ChristopherTuring' } }, associatedPullRequests: { totalCount: 0 }, ...more })
const firstPage = () => ({ data: { repository: {
  pullRequests: { pageInfo: { hasNextPage: true, endCursor: cursor }, nodes: [
    pullNode(904, { body: `Tabs.\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n\n${session}`, headRefName: 'claude/magical-mayer-83oicz', state: 'OPEN',
      closingIssuesReferences: { nodes: [{ number: 12 }] } }),
    // Its merge commit alone names its session.
    pullNode(901, { mergeCommit: { message: `History (#901)\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\nClaude-Session: ${session}` } }),
    // Neo's, with Claude Code's line too.
    pullNode(830, { headRefName: 'neo/fix-links', body: 'Links.\n\n🤖 Generated with [Neo](https://neo.example)\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)' }),
    // Codex's task linked in its body; its settings link names none.
    pullNode(845, { headRefName: 'codex/review-defaults', isCrossRepository: true, headRepositoryOwner: { login: 'ada' },
      body: 'Defaults.\n\n[Settings](https://chatgpt.com/codex/cloud/settings/general)\n\n------\nhttps://chatgpt.com/codex/tasks/task_e_68ecb1f0a2c88191' }),
    // Copilot's, opened as its account; and one describing Neo's fingerprint, quoting it.
    pullNode(50, { author: { login: 'Copilot', databaseId: 198982749 }, headRefName: 'copilot/move-db', body: 'Moves the database.' }),
    // Dependabot's, opened as its app.
    pullNode(187, { author: { login: 'dependabot', databaseId: 49699333 }, headRefName: 'dependabot/npm_and_yarn/ws-8.21.0', body: 'Bumps ws.' }),
    // One by an account named as it, but another.
    pullNode(188, { author: { login: 'dependabot', databaseId: 1 }, headRefName: 'deps/ws', body: 'Bumps ws.' }),
    pullNode(921, { headRefName: 'claude/apps', body: `Apps.\n\n- Its fingerprint, \`🤖 Generated with [Neo](\`.\n\n${session}` }),
    // Codex's, run as whoever ran it, unmarked but for the label they gave it.
    pullNode(560, { headRefName: 'fix/review', labels: { nodes: [{ name: 'bug' }, { name: 'Codex' }, null] } }),
    null, { number: 'x' },
  ] },
  defaultBranchRef: { target: { oid: a } },
  issues: { nodes: [{ number: 12, title: 'Chips', state: 'OPEN', createdAt: null, updatedAt: null, author: { login: 'ada', databaseId: 7 } },
    { number: 13, title: 'History', state: 'CLOSED', createdAt: null, updatedAt: null, author: null }, null] },
} } })
// The default branch's commits, the newest first, from its head.
const branchCommits = [
    commitNode(a, `Fix it\n\nClaude-Session: ${session}`),
    // A commit Claude authored, naming no session; one a pull request merged; one by hand.
    commitNode(b, 'Fix a flaky test', { author: { email: 'noreply@anthropic.com', user: null } }),
    commitNode(c, `History (#901)\n\nClaude-Session: ${session}`, { associatedPullRequests: { totalCount: 1 } }),
    commitNode('d'.repeat(40), 'By hand'),
    // One whoever ran Codex pushed, by Codex's co-author trailer.
    commitNode('3'.repeat(40), 'Tidy the docs\n\nCo-authored-by: Codex <codex@openai.com>'),
    // One Neo pushed, by its line; one Copilot authored, its pull request
    // another repository's (as one moved has), told by its no-reply address
    // alone, as GitHub names no user for a bot.
    commitNode('e'.repeat(40), 'Bump esbuild\n\n🤖 Generated with [Neo](https://neo.example)'),
    // One Neo's account authored by GitHub's older no-reply address, naming no id, its account looked up by its login.
    commitNode('4'.repeat(40), 'Pin pnpm', { author: { email: 'any-login@users.noreply.github.com', user: null } }),
    commitNode('f'.repeat(40), 'Move the database (#50)', { author: { email: '198982749+Copilot@users.noreply.github.com', user: null } }),
    // Ones by addresses naming no agent: another's, Copilot's login with another's id, and its id with another's login.
    commitNode('0'.repeat(40), 'Not Copilot', { author: { email: 'copilot@example.com', user: null } }),
    commitNode('1'.repeat(40), 'Not Copilot', { author: { email: '1+Copilot@users.noreply.github.com', user: null } }),
    commitNode('2'.repeat(40), 'Not Copilot', { author: { email: '198982749+ada@users.noreply.github.com', user: null } }),
]
// Its history as the Commits tab reads it, a page from its head, each
// commit's parent the next, the last's one unlisted.
const unlisted = '8'.repeat(40)
const historyPage = ({ o0 }) => ({ data: { repository: { b0: { history: { pageInfo: { hasNextPage: true }, nodes: o0 === a ? branchCommits.map((node, at) => ({
  oid: node.oid, message: node.message, committedDate: node.committedDate, additions: node.additions, deletions: node.deletions,
  author: { name: 'Someone', email: node.author.email, date: node.committedDate, user: node.author.user }, authors: { nodes: [{ name: 'Someone', ...node.author }] },
  parents: { nodes: [{ oid: branchCommits[at + 1]?.oid ?? unlisted }] } })) : [] } } } } })
// Whether a pull request brought each commit asked of: the third's alone.
const pulledPage = variables => ({ data: { repository: Object.fromEntries(Object.entries(variables).flatMap(([key, sha]) => /^o\d+$/u.test(key)
  ? [[`c${key.slice(1)}`, { associatedPullRequests: { totalCount: sha === c ? 1 : 0 } }]] : [])) } })
// An agent's branches as GitHub lists them, by name, a page at a time; a
// name whole under `refs/heads/`, or under the prefix listed.
const ref = (prefix, name, at, message = 'Work') => ({ prefix, name, target: { committedDate: at, message, author: { user: { login: 'ChristopherTuring' } } } })
const refPages = {
  'refs/heads/claude/': { null: { pageInfo: { hasNextPage: true, endCursor: 'b_2' }, nodes: [ref('refs/heads/', 'claude/aaa-old', '2026-01-01T00:00:00Z'),
    ref('refs/heads/', 'claude/magical-mayer-83oicz', '2026-10-15T02:00:00Z', `Tabs\n\nClaude-Session: ${session}`)] },
  b_2: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [ref('refs/heads/', 'claude/zzz-newest', '2026-10-15T04:00:00Z')] } },
  'refs/heads/codex/': { null: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [ref('refs/heads/codex/', 'try-lazy-trees', '2026-10-15T03:00:00Z'), null] } },
  'refs/heads/neo/': { null: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [ref('refs/heads/neo/', 'try-pnpm', '2026-10-15T05:00:00Z')] } },
  'refs/heads/copilot/': { null: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } },
  'refs/heads/dependabot/': { null: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ prefix: 'refs/heads/dependabot/', name: 'npm_and_yarn/ws-8.21.0',
    target: { committedDate: '2026-10-15T06:00:00Z', message: 'Bump ws', author: { email: '49699333+dependabot[bot]@users.noreply.github.com', user: null } } }] } },
}
// The commits the app agents' accounts authored, however far back: one
// deeper than the first page, and one it holds too.
const authoredPage = () => ({ data: { repository: { defaultBranchRef: { target: { history: { nodes: [
  commitNode('f'.repeat(40), 'Move the database (#50)', { author: { email: '198982749+Copilot@users.noreply.github.com', user: null } }),
  commitNode('9'.repeat(40), 'Fix the build (#7)', { committedDate: '2026-05-14T00:00:00Z',
    author: { email: '198982749+Copilot@users.noreply.github.com', user: null } }),
] } } } } } })
const graphql = ({ query, variables }) => query.includes('user(login:') ? { data: { u0: { login: 'any-login', databaseId: 274065190 } } }
  : query.includes('refs(refPrefix: $prefix')
  ? { data: { repository: { refs: refPages[variables.prefix][variables.after ?? 'null'] } } }
  : query.includes('author: { emails: $emails }') ? authoredPage() : query.includes('nodes { ...historyCommit }') ? historyPage(variables)
  : query.includes('... on Commit { associatedPullRequests') ? pulledPage(variables) : firstPage()

test('the first page reads pull requests, the default branch\'s commits no pull request merged, issues and agents\' branches, and answers their agents\' marks, never their texts', async t => {
  const request = await fixture(t)
  const asked = github(t, graphql)
  const { status, body } = await request({ repoId: '1' })
  assert.equal(status, 200)
  const sessionSignals = { sessions: ['session_01MamW9SFrduHwBFipxyjRnn'], tasks: [], claude: true, codex: false, agents: [] }
  assert.deepEqual(body.pulls.map(pull => [pull.number, pull.state, pull.head, pull.fork, pull.closes, pull.signals]), [
    [904, 'open', 'claude/magical-mayer-83oicz', null, [12], sessionSignals],
    [901, 'merged', 'feature/x', null, [], sessionSignals],
    [830, 'merged', 'neo/fix-links', null, [], { sessions: [], tasks: [], claude: true, codex: false, agents: ['neo'] }],
    [845, 'merged', 'codex/review-defaults', 'ada', [], { sessions: [], tasks: ['task_e_68ecb1f0a2c88191'], claude: false, codex: false, agents: [] }],
    [50, 'merged', 'copilot/move-db', null, [], { sessions: [], tasks: [], claude: false, codex: false, agents: ['copilot'] }],
    [187, 'merged', 'dependabot/npm_and_yarn/ws-8.21.0', null, [], { sessions: [], tasks: [], claude: false, codex: false, agents: ['dependabot'] }],
    [188, 'merged', 'deps/ws', null, [], { sessions: [], tasks: [], claude: false, codex: false, agents: [] }],
    [921, 'merged', 'claude/apps', null, [], { ...sessionSignals, claude: false }],
    [560, 'merged', 'fix/review', null, [], { sessions: [], tasks: [], claude: false, codex: true, agents: [] }],
  ], 'a fingerprint quoted is none')
  assert.deepEqual(body.pulls[0], { ...body.pulls[0], title: 'Pull 904', draft: false, author: 'ChristopherTuring', additions: 7, deletions: 2, commits: 3,
    createdAt: Date.parse('2026-10-14T00:00:00Z'), updatedAt: Date.parse('2026-10-15T00:00:00Z') })
  assert.deepEqual(body.commits.map(commit => [commit.oid, commit.title, commit.signals]), [[a, 'Fix it', sessionSignals],
    [b, 'Fix a flaky test', { sessions: [], tasks: [], claude: true, codex: false, agents: [] }],
    ['3'.repeat(40), 'Tidy the docs', { sessions: [], tasks: [], claude: false, codex: true, agents: [] }],
    ['e'.repeat(40), 'Bump esbuild', { sessions: [], tasks: [], claude: false, codex: false, agents: ['neo'] }],
    ['4'.repeat(40), 'Pin pnpm', { sessions: [], tasks: [], claude: false, codex: false, agents: ['neo'] }],
    ['f'.repeat(40), 'Move the database (#50)', { sessions: [], tasks: [], claude: false, codex: false, agents: ['copilot'] }],
    ['9'.repeat(40), 'Fix the build (#7)', { sessions: [], tasks: [], claude: false, codex: false, agents: ['copilot'] }]],
  'those no agent marked, or a pull request merged, are not; those the app agents authored however far back, each once')
  const pulled = asked.find(query => query.query.includes('... on Commit { associatedPullRequests'))
  assert.deepEqual(Object.entries(pulled.variables).flatMap(([key, sha]) => /^o\d+$/u.test(key) ? [sha] : []).toSorted(),
    [a, b, c, '3'.repeat(40), 'e'.repeat(40), '4'.repeat(40), 'f'.repeat(40)].toSorted(), 'whether a pull request brought one looked up of those marked alone')
  assert.deepEqual(asked.find(query => query.query.includes('author: { emails: $emails }')).variables.emails, ['198982749+Copilot@users.noreply.github.com',
    '198982749+copilot-swe-agent@users.noreply.github.com', '175728472+Copilot@users.noreply.github.com', '175728472+copilot-pull-request-reviewer@users.noreply.github.com',
    '175728472+copilot-pull-request-reviewer[bot]@users.noreply.github.com', '49699333+dependabot@users.noreply.github.com', '49699333+dependabot[bot]@users.noreply.github.com'])
  const moved = body.commits.find(commit => commit.oid === 'f'.repeat(40))
  assert.deepEqual([moved.author, moved.authorId], ['Copilot', 198982749], 'each by its author\'s login and account id')
  assert.deepEqual(body.issues, [{ number: 12, title: 'Chips', state: 'open', author: 'ada', authorId: 7, createdAt: null, updatedAt: null },
    { number: 13, title: 'History', state: 'closed', author: null, authorId: null, createdAt: null, updatedAt: null }])
  assert.deepEqual(body.users, { Copilot: { agent: 'copilot' }, 'dependabot[bot]': { agent: 'dependabot' }, 'any-login': { agent: 'neo' } },
    'its agents\' accounts as the app draws them; `dependabot`, named by Dependabot\'s account and another, no one\'s')
  // Every page of each agent's branches read, the newest first, named in full.
  assert.deepEqual(body.branches.map(branch => [branch.name, branch.signals.sessions, branch.signals.agents]), [['claude/zzz-newest', [], []],
    ['claude/magical-mayer-83oicz', ['session_01MamW9SFrduHwBFipxyjRnn'], []], ['claude/aaa-old', [], []], ['codex/try-lazy-trees', [], []], ['neo/try-pnpm', [], ['neo']],
    ['dependabot/npm_and_yarn/ws-8.21.0', [], ['dependabot']]])
  // A bot's commit, named by its no-reply address, GitHub naming no user for it.
  assert.deepEqual([body.commits.find(commit => commit.oid === 'f'.repeat(40)).author, body.branches.at(-1).author], ['Copilot', 'dependabot[bot]'])
  // The agents it knows by their apps or accounts, each by id, name and avatar, never how it tells them.
  assert.deepEqual(body.agents, [{ id: 'neo', name: 'Neo', avatar: 'app-3115942' }, { id: 'copilot', name: 'Copilot' },
    { id: 'dependabot', name: 'Dependabot', avatar: 'app-29110' }])
  assert.deepEqual([body.more, body.after], [true, { pulls: cursor, commits: unlisted }], 'read on from GitHub\'s cursor, and where the history listed stops')
  assert.doesNotMatch(JSON.stringify(body), /Generated with|Defaults/u, 'no text read is answered')
  const page = asked.find(query => query.query.includes('pullRequests('))
  // An agent links its session in its own texts: no comment is read, nor an issue's body.
  assert.doesNotMatch(page.query, /comments|issues\([^)]*\) [^]*body/u)
  assert.deepEqual(page.variables, { owner: 'org', name: 'repo', pulls: null, first: true })
  assert.match(page.query, /labels\(first: 100\) \{ nodes \{ name \} \}/u, 'a pull request\'s labels read, as many as GitHub gives a page')
  assert.deepEqual(asked.filter(query => query.query.includes('refs(refPrefix: $prefix')).map(query => [query.variables.prefix, query.variables.after]).toSorted(),
    [['refs/heads/claude/', null], ['refs/heads/claude/', 'b_2'], ['refs/heads/codex/', null], ['refs/heads/copilot/', null], ['refs/heads/dependabot/', null], ['refs/heads/neo/', null]])
  assert.ok(asked.every(query => query.auth === 'Bearer login-token'))
  // Asked again, kept: nothing read of GitHub's GraphQL again, branches neither.
  const reads = asked.length
  assert.deepEqual((await request({ repoId: '1' })).body, body)
  assert.equal(asked.length, reads)
  // Kept no longer: the history read of its pages kept, whether a pull
  // request brought each of what was looked up, neither read again.
  await repositoryReadStore(request.db).remove('1\0agents\0' + AGENTS_READ_VERSION + '\0\0')
  assert.deepEqual((await request({ repoId: '1' })).body.commits, body.commits)
  assert.equal(asked.filter(query => query.query.includes('nodes { ...historyCommit }') || query.query.includes('... on Commit { associatedPullRequests')).length, 2)
})

test('the history the Commits tab and Pulse keep is the Agents tab\'s: a page kept with its commits\' marks not read again; one kept before they were, read again', async t => {
  const request = await fixture(t)
  const asked = github(t, graphql)
  const pages = historyPageStore(request.db)
  const kept = (top, commits) => pages.write(`1\0${COAUTHORS_READ}\0${top}`, commits, Date.now())
  const commit = (sha, parent, more) => ({ sha, parents: [parent], subject: `Commit ${sha[0]}`, authorName: 'Ada', authorLogin: 'ada', authorId: 7, coauthors: [],
    committedAt: Date.parse('2026-10-15T00:00:00Z'), additions: 1, deletions: 0, authoredAt: null, authorZone: null, marked: AGENT_MARKS_READ, ...more })
  const marks = { sessions: ['session_01MamW9SFrduHwBFipxyjRnn'], tasks: [], claude: true, codex: false, agents: [] }
  await kept(a, [commit(a, b, { marks }), commit(b, unlisted)])
  const { body } = await request({ repoId: '1' })
  assert.equal(asked.filter(query => query.query.includes('nodes { ...historyCommit }')).length, 0, 'the page kept read')
  assert.deepEqual(body.commits.filter(item => item.oid === a).map(item => [item.title, item.author, item.signals]), [['Commit a', 'ada', marks]])
  assert.equal(body.after.commits, unlisted)
  // Kept before its commits' marks were: read again, and kept so.
  await kept(b, [commit(b, unlisted, { marked: undefined })])
  await request({ repoId: '1', commits: b })
  assert.deepEqual(asked.filter(query => query.query.includes('nodes { ...historyCommit }')).map(query => query.variables.o0), [b])
})

test('a commit\'s marks kept with the history as it is read: its message\'s, Claude\'s address, an agent\'s account; none where none is', () => {
  const ada = { name: 'Ada', email: 'ada@example.com', user: { login: 'ada', databaseId: 7 } }
  const node = (message, author = ada) => ({ oid: a, message, committedDate: '2026-10-15T00:00:00Z', additions: 1, deletions: 0, author, authors: { nodes: [author] },
    parents: { nodes: [] } })
  assert.deepEqual(graphCommit(node(`Fix it\n\nClaude-Session: ${session}`)).marks.sessions, ['session_01MamW9SFrduHwBFipxyjRnn'])
  assert.equal(graphCommit(node('Tidy', { name: 'Claude', email: 'noreply@anthropic.com', user: null })).marks.claude, true)
  assert.deepEqual(graphCommit(node('Move', { name: 'Copilot', email: '198982749+Copilot@users.noreply.github.com', user: null })).marks.agents, ['copilot'])
  const plain = graphCommit(node('By hand'))
  assert.deepEqual(['marks' in plain, plain.marked], [false, AGENT_MARKS_READ])
})

test('an answer an older server kept, as it read and told agents then, is not sent: read again', async t => {
  const request = await fixture(t)
  const asked = github(t, graphql)
  // Kept a minute ago by a server before the reads were versioned.
  await repositoryReadStore(request.db).write('1\0agents\0\0', { pulls: [], commits: [], issues: [], branches: [], agents: [], more: false,
    after: { pulls: null, commits: null } }, Date.now() - 60_000)
  const { status, body } = await request({ repoId: '1' })
  assert.equal(status, 200)
  assert.ok(asked.length > 0, 'read of GitHub')
  assert.ok(body.commits.some(commit => commit.oid === 'f'.repeat(40)))
})

test('a later page reads on from the cursors it names alone, without issues and branches again', async t => {
  const request = await fixture(t)
  const asked = github(t, () => ({ data: { repository: { pullRequests: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [pullNode(800, {})] } } } }))
  const { body } = await request({ repoId: '1', pulls: cursor })
  assert.equal(asked.length, 1, 'no branches read again')
  assert.deepEqual(asked[0].variables, { owner: 'org', name: 'repo', pulls: cursor, first: false })
  assert.deepEqual([body.pulls.map(pull => pull.number), body.commits, body.issues, body.branches, body.more], [[800], [], undefined, undefined, false])
  // The default branch's commits read on from where those listed stopped,
  // its history alone read, from each commit named.
  assert.equal((await request({ repoId: '1', commits: [b, c].join(',') })).status, 200)
  assert.deepEqual([asked.length, asked.at(-1).variables], [2, { owner: 'org', name: 'repo', o0: b, o1: c }])
  // One an older server gave, GitHub's, on from its commit.
  assert.equal((await request({ repoId: '1', commits: `${'d'.repeat(40)} 99` })).status, 200)
  assert.deepEqual(asked.at(-1).variables, { owner: 'org', name: 'repo', o0: 'd'.repeat(40) })
})

test('agents\' work is read only with a token by a reader whose grants reach the whole repository; a cursor that isn\'t one is a bad request', async t => {
  github(t, graphql)
  assert.deepEqual(await (await fixture(t, { tokens: null }))({ repoId: '1' }), { status: 403, body: { error: 'github-token-required' } })
  assert.deepEqual(await (await fixture(t, { role: 'manage' }))({ repoId: '1' }), { status: 404, body: { error: 'no-directory' } })
  const request = await fixture(t)
  for (const query of [{ repoId: '0' }, { repoId: '1', pulls: 'a b' }, { repoId: '1', commits: '' }, { repoId: '1', commits: 'a b' },
    { repoId: '1', pulls: `${'c'.repeat(40)} 99` }]) assert.equal((await request(query)).status, 400, JSON.stringify(query))
  assert.equal((await request({ repoId: '1' }, { method: 'POST' })).status, 405)
})
