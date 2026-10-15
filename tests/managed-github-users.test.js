// The app's users a repository's activity names by GitHub login
// (server-managed/github-users.ts): resolved on the server as each answer is
// sent, for the logins it names alone, a linked account as its user.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { openSqliteManagedDb } from '../server-managed/db.ts'
import { createManagedRequestHandler } from '../server-managed/http.ts'
import { namedLogins } from '../common/managed/github-logins.ts'
import { createSession } from '../server-managed/session.ts'
import { hashToken } from '../server-managed/crypto.ts'
import { checkUsersByLogin } from './_managed-github-links.js'

const config = { sessionCookieName: 'sid', cookieSecure: false, sessionTtlMs: 60_000 }
const repo = { repoId: 1, fullName: 'org/repo', private: false, installationId: null, defaultBranch: 'main', htmlUrl: '', addedBy: null }
const publicMetadata = { id: 1, full_name: 'org/repo', private: false, visibility: 'public', default_branch: 'main' }
const identity = (id, login, name = null) => ({ githubUserId: id, login, name, avatarUrl: null })

test('the app\'s users by GitHub login: SQLite semantics', async t => {
  const db = openSqliteManagedDb(':memory:')
  t.after(() => db.close())
  await checkUsersByLogin(db)
})

test('an answer\'s logins are those it names as an author, one who merged or a contributor, each once, never a GitHub App\'s', () => {
  const answer = {
    commits: [{ authorLogin: 'ada', authorName: 'Not a login' }, { authorLogin: null }, { authorLogin: 'ada' }],
    items: [{ author: 'grace', title: 'author' }, { author: 'dependabot[bot]' }, { author: 'not a login!' }],
    item: { mergedBy: 'linus', body: 'mergedBy: someone' },
    stats: { contributors: [{ login: 'ken', weeks: [] }] },
    head: 'author', fork: 'forker', more: true,
  }
  assert.deepEqual([...namedLogins(answer)].toSorted(), ['ada', 'grace', 'ken', 'linus'])
  assert.deepEqual([...namedLogins(null)], [])
})

// The Issues tab's endpoint, read by an admin with a token, GitHub answering
// issues by `logins`; `asked` how many times GitHub was.
async function fixture(t, logins) {
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
    return Promise.resolve(Response.json({ data: { repository: { open: { totalCount: logins.length }, closed: { totalCount: 0 },
      page: { pageInfo: { hasNextPage: false }, nodes: logins.map((login, at) => ({ number: at + 1, title: `Issue ${at + 1}`, state: 'OPEN',
        author: login === null ? null : { login }, comments: { totalCount: 0 }, labels: { totalCount: 0, nodes: [] } })) } } } }))
  })
  const handler = createManagedRequestHandler({ config, db, originGate: { isOriginAllowed: () => true }, isShuttingDown: () => false, track() {} })
  const request = async () => {
    const res = { status: 0, body: '', writeHead(status) { this.status = status }, end(body) { this.body = body } }
    await handler({ method: 'GET', url: '/api/admin/repositories/issues?repoId=1&kind=issues', headers: { cookie: reader.setCookie.split(';')[0] } }, res)
    return { status: res.status, body: JSON.parse(res.body) }
  }
  return { db, request, github }
}

test('activity answers name the app\'s users among their authors, a linked account as its user, resolved afresh even where the answer was kept', async t => {
  const { db, request, github } = await fixture(t, ['alice-work', 'Alice', 'stranger', 'pending', 'dependabot[bot]', null])
  const alice = await createSession(config, db, identity(2, 'alice', 'Alice'), Date.now())
  await db.setUserRole(alice.userId, 'view')
  await createSession(config, db, identity(3, 'pending'), Date.now())
  const sessionId = hashToken(alice.setCookie.split(';')[0].split('=')[1])
  const work = await db.linkGithubAccount(sessionId, identity(4, 'alice-work', 'Alice at Work'), Date.now())

  const first = await request()
  assert.equal(first.status, 200)
  assert.deepEqual(first.body.items.map(item => item.author), ['alice-work', 'Alice', 'stranger', 'pending', 'dependabot[bot]', null])
  assert.deepEqual(first.body.users, {
    'alice-work': { id: alice.userId, login: 'alice', name: 'Alice' },
    Alice: { id: alice.userId, login: 'alice', name: 'Alice' },
  }, 'the logins it names alone: none unknown, of No access, nor a GitHub App\'s')

  await db.setProfileChoice(sessionId, { name: work.id }, Date.now())
  const kept = await request()
  assert.equal(github.asked, 1, 'the answer was kept')
  assert.deepEqual(kept.body.users['alice-work'], { id: alice.userId, login: 'alice', name: 'Alice at Work' }, 'its users were not')
  await db.unlinkGithubAccount(sessionId, work.id, Date.now())
  assert.deepEqual(Object.keys((await request()).body.users), ['Alice'])
})
