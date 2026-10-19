// The app's users and agents a repository's activity names by GitHub
// account (server-managed/github-users.ts): resolved on the server as each
// answer is sent, for the accounts it names alone, by their ids where named,
// a linked account as its user.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { openSqliteManagedDb } from '../server-managed/db.ts'
import { withAppUsers } from '../server-managed/github-users.ts'
import { createManagedRequestHandler } from '../server-managed/http.ts'
import { agentOperated, githubAgent } from '../common/managed/github-agents.ts'
import { namedAccounts } from '../common/managed/github-logins.ts'
import { createSession } from '../server-managed/session.ts'
import { hashToken } from '../server-managed/crypto.ts'
import { checkUsersByAccount } from './_managed-github-links.js'

const config = { sessionCookieName: 'sid', cookieSecure: false, sessionTtlMs: 60_000 }
const repo = { repoId: 1, fullName: 'org/repo', private: false, installationId: null, defaultBranch: 'main', htmlUrl: '', addedBy: null }
const publicMetadata = { id: 1, full_name: 'org/repo', private: false, visibility: 'public', default_branch: 'main' }
const identity = (id, login, name = null) => ({ githubUserId: id, login, name, avatarUrl: null })

test('the app\'s users by GitHub account: SQLite semantics', async t => {
  const db = openSqliteManagedDb(':memory:')
  t.after(() => db.close())
  await checkUsersByAccount(db)
})

test('an answer\'s accounts are those it names as an author, one who merged or a contributor, each once, with the id named beside it', () => {
  const answer = {
    commits: [{ authorLogin: 'ada', authorName: 'Not a login', authorId: null }, { authorLogin: null, authorId: 9 }, { authorLogin: 'ada', authorId: 1 }],
    items: [{ author: 'grace', authorId: 2, title: 'author' }, { author: 'dependabot[bot]' }, { author: 'not a login!' }, { author: 'mallory', authorId: '3' }],
    item: { mergedBy: 'linus', mergedById: 4, body: 'mergedBy: someone' },
    stats: { contributors: [{ login: 'ken', id: 5, weeks: [] }] },
    head: 'author', fork: 'forker', more: true,
  }
  assert.deepEqual([...namedAccounts(answer)].toSorted(), [['ada', 1], ['dependabot[bot]', null], ['grace', 2], ['ken', 5], ['linus', 4], ['mallory', null]])
  assert.deepEqual([...namedAccounts(null)], [])
})

test('an agent\'s account is told by its login, its id confirming it where both are known; a commit GitHub names no account for, by its name', () => {
  assert.deepEqual([['dependabot', 49699333], ['Dependabot[bot]', null], ['dependabot', 1], ['Copilot', 198982749], ['ada', 198982749], ['claude', 81847], ['claude', 5],
    ['claude[bot]', 123], ['chatgpt-codex-connector', 199175422]].map(([login, id]) => githubAgent(login, id)),
  ['dependabot', 'dependabot', null, 'copilot', null, 'claude', null, 'claude', 'codex'], 'an account whose id GitHub gives no agent, by its login alone')
  // Copilot's code review, by its own bot, which GitHub names Copilot as it names Copilot's coding agent.
  assert.deepEqual([['Copilot', 175728472], ['copilot-pull-request-reviewer', 175728472], ['copilot-pull-request-reviewer[bot]', null], ['Copilot', 1], ['copilot-swe-agent', 175728472]]
    .map(([login, id]) => githubAgent(login, id)), ['copilot', 'copilot', 'copilot', null, null], 'a login two accounts are named by is either\'s, by its id')
  // GitHub Actions' bot, as agentic workflows (gh-aw) review as; workflows' commits by the names they are commonly given, GitHub naming no account for them.
  assert.deepEqual([['github-actions', 41898282], ['github-actions[bot]', null], ['github-actions', 7], [null, 'github-actions[bot]'], [null, 'github-actions'],
    [null, 'GitHub Action'], [null, 'GitHub Actions fan']].map(([login, account]) => login ? githubAgent(login, account) : githubAgent(null, null, account)),
  ['actions', 'actions', null, 'actions', 'actions', 'actions', null])
  assert.deepEqual([[null, ' Claude '], [null, 'copilot'], [null, 'dependabot[bot]'], [null, 'Dependabot'], ['someone', 'Codex'], [null, 'Claude Monet'], [null, null]]
    .map(([login, name]) => githubAgent(login, null, name)), ['claude', 'copilot', 'dependabot', null, null, null, null], 'a human\'s account is theirs, whatever their commits name them')
  // Neo's account and its App's bot, each known by its id alone, whatever GitHub names it; its GitHub App's id, another's account.
  assert.deepEqual([['any-login', 274065190], ['any-login[bot]', 268952163], ['renamed', 274065190], ['claude', 274065190], ['neo', null], ['someone', 3115942],
    [null, 'Neo']].map(([login, id]) => login ? githubAgent(login, id) : githubAgent(null, null, id)), ['neo', 'neo', 'neo', 'neo', null, null, null])
})

test('an account agents work as is told by its id where GitHub gives it, whatever it is renamed to, else by its login; no agent\'s own', () => {
  assert.deepEqual([['ChristopherTuring', 188797125], ['christopherturing', null], ['renamed', 188797125], ['ChristopherTuring', 7], ['ada', null], [null, null]]
    .map(([login, id]) => agentOperated(login, id)), [true, true, true, false, false, false])
  assert.equal(githubAgent('ChristopherTuring', 188797125), null, 'what else it does its person\'s')
})

test('a login an answer names beside more than one account, one GitHub named by it once and one it names by it now, is no one\'s', async t => {
  const db = openSqliteManagedDb(':memory:')
  t.after(() => db.close())
  const octo = await db.upsertUser({ githubUserId: 2, login: 'octo', name: 'Octo', avatarUrl: null }, 1)
  await db.setUserRole(octo, 'view')
  const answer = { commits: [{ authorLogin: 'octo', authorId: 2 }, { authorLogin: 'Octo', authorId: 3 }, { authorLogin: 'octo', authorId: null }],
    items: [{ author: 'dependabot', authorId: 49699333 }, { author: 'Dependabot', authorId: 5 }, { author: 'ada', authorId: 7 }, { author: 'ada', authorId: 7 }] }
  assert.deepEqual([...namedAccounts(answer)], [['octo', 'ambiguous'], ['Octo', 'ambiguous'], ['dependabot', 'ambiguous'], ['Dependabot', 'ambiguous'], ['ada', 7]],
    'matched as GitHub matches logins; one named by the same account twice is not')
  assert.deepEqual((await withAppUsers(db, answer)).users, {}, 'neither a user nor an agent')
  answer.commits.splice(1, 1)
  assert.deepEqual((await withAppUsers(db, answer)).users, { octo: { id: octo, login: 'octo', name: 'Octo' } }, 'one named once with its id and once without is that account')
  // A pull request Copilot's coding agent opened, and Copilot's code review requested on another: both Copilot.
  const copilot = { items: [{ author: 'Copilot', authorId: 198982749 }, { reviews: { reviewers: [{ login: 'Copilot', id: 175728472 }] } }] }
  assert.deepEqual([...namedAccounts(copilot)], [['Copilot', null]], 'accounts all one agent\'s, that agent\'s by its login')
  assert.deepEqual((await withAppUsers(db, copilot)).users, { Copilot: { agent: 'copilot' } })
  copilot.items.push({ author: 'copilot', authorId: 3 })
  assert.deepEqual([...namedAccounts(copilot)], [['Copilot', 'ambiguous'], ['copilot', 'ambiguous']], 'one no agent\'s beside them, no one\'s')
})

// The Issues tab's endpoint, read by an admin with a token, GitHub answering
// issues by `authors` (a login, or a login and its account's id); `asked` how
// many times GitHub was.
async function fixture(t, authors) {
  const db = openSqliteManagedDb(':memory:')
  t.after(() => db.close())
  const reader = await createSession(config, db, identity(1, 'reader'), Date.now())
  await db.setUserRole(reader.userId, 'admin')
  await db.setUserTokens(reader.userId, { accessToken: 'token', refreshToken: null, expiresAt: null })
  await db.selectRepo(repo, Date.now())
  const github = { asked: 0 }
  t.mock.method(globalThis, 'fetch', (input) => {
    const url = new URL(typeof input === 'string' ? input : input.url)
    if (url.pathname === '/repos/org/repo') return Promise.resolve(Response.json(publicMetadata))
    if (url.pathname !== '/graphql') return Promise.resolve(Response.json({ message: 'Not Found' }, { status: 404 }))
    github.asked++
    return Promise.resolve(Response.json({ data: { repository: { open: { totalCount: authors.length }, closed: { totalCount: 0 },
      page: { pageInfo: { hasNextPage: false }, nodes: authors.map((author, at) => ({ number: at + 1, title: `Issue ${at + 1}`, state: 'OPEN',
        author: typeof author === 'string' ? { login: author } : author, comments: { totalCount: 0 }, labels: { totalCount: 0, nodes: [] } })) } } } }))
  })
  const handler = createManagedRequestHandler({ config, db, originGate: { isOriginAllowed: () => true }, isShuttingDown: () => false, track() {} })
  const request = async () => {
    const res = { status: 0, body: '', writeHead(status) { this.status = status }, end(body) { this.body = body } }
    await handler({ method: 'GET', url: '/api/admin/repositories/issues?repoId=1&kind=issues', headers: { cookie: reader.setCookie.split(';')[0] } }, res)
    return { status: res.status, body: JSON.parse(res.body) }
  }
  return { db, request, github }
}

test('activity answers name the app\'s users and agents among their authors, a linked account as its user, resolved afresh even where the answer was kept', async t => {
  const { db, request, github } = await fixture(t, ['alice-work', 'Alice', { login: 'alice-renamed', databaseId: 2 }, { login: 'stranger', databaseId: 9 }, 'pending',
    { login: 'dependabot', databaseId: 49699333 }, 'renovate[bot]', null])
  const alice = await createSession(config, db, identity(2, 'alice', 'Alice'), Date.now())
  await db.setUserRole(alice.userId, 'view')
  await createSession(config, db, identity(3, 'pending'), Date.now())
  const sessionId = hashToken(alice.setCookie.split(';')[0].split('=')[1])
  const work = await db.linkGithubAccount(sessionId, identity(4, 'alice-work', 'Alice at Work'), Date.now())

  const first = await request()
  assert.equal(first.status, 200)
  assert.deepEqual(first.body.items.map(item => item.author), ['alice-work', 'Alice', 'alice-renamed', 'stranger', 'pending', 'dependabot', 'renovate[bot]', null])
  assert.deepEqual(first.body.users, {
    'alice-work': { id: alice.userId, login: 'alice', name: 'Alice' },
    Alice: { id: alice.userId, login: 'alice', name: 'Alice' },
    'alice-renamed': { id: alice.userId, login: 'alice', name: 'Alice' },
    dependabot: { agent: 'dependabot' },
  }, 'the accounts it names alone, by id where named: none unknown, of No access, nor another GitHub App\'s; an agent as the app draws it')

  await db.setProfileChoice(sessionId, { name: work.id }, Date.now())
  const kept = await request()
  assert.equal(github.asked, 1, 'the answer was kept')
  assert.deepEqual(kept.body.users['alice-work'], { id: alice.userId, login: 'alice', name: 'Alice at Work' }, 'its users were not')
  await db.unlinkGithubAccount(sessionId, work.id, Date.now())
  assert.deepEqual(Object.keys((await request()).body.users).toSorted(), ['Alice', 'alice-renamed', 'dependabot'])
})
