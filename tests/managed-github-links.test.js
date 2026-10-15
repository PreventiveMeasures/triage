// Linked GitHub accounts and the profile page's API: a linked account neither
// signs in nor registers, linking runs GitHub's authorization for the other
// account against the session that asked, and the displayed name and avatar
// may come from any of a user's accounts while the login stays the sign-in one.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openSqliteManagedDb } from '../server-managed/db.ts'
import { createSession, readSession } from '../server-managed/session.ts'
import { OAuthError, handleCallback } from '../server-managed/github-oauth.ts'
import { isLinkOAuthCallback, linkLoginRedirect, linkOAuthCallback } from '../server-managed/github-link-oauth.ts'
import { createManagedRequestHandler } from '../server-managed/http.ts'
import { checkGithubLinks } from './_managed-github-links.js'
import { config, memoryStore } from './_managed-mutation-safety.js'

const identity = (id, login, name = null) => ({ githubUserId: id, login, name, avatarUrl: null })
const cookiePair = setCookie => setCookie.split(';', 1)[0]
const json = (body, status = 200) => Promise.resolve(Response.json(body, { status }))

// GitHub as the link callback reads it: a token for any code, then the
// identity and avatar of `user`.
function github(user, avatar = 'linked-avatar') {
  return (url) => {
    const u = String(url)
    if (u.includes('login/oauth/access_token')) return json({ access_token: `token-for-${user.login}` })
    if (u === 'https://api.github.com/user') return json(user)
    if (u.startsWith('https://avatars.githubusercontent.com/')) return Promise.resolve(new Response(avatar, { headers: { 'content-type': 'image/png' } }))
    return json({}, 404)
  }
}

function avatarStore() {
  const map = new Map()
  return { map,
    put(id, contentType, bytes) { map.set(id, { contentType, bytes }); return Promise.resolve() },
    get(id) { return Promise.resolve(map.get(id) ?? null) },
    delete(id) { map.delete(id); return Promise.resolve() } }
}

function routes(db, avatars) {
  const handler = createManagedRequestHandler({ config, db, avatarStore: avatars, reportStore: memoryStore(), bundleStore: memoryStore(),
    originGate: { isOriginAllowed: () => true }, isShuttingDown: () => false, track() {} })
  return async (method, url, { cookie, csrf, body } = {}) => {
    const req = { method, url, headers: { ...cookie ? { cookie } : {}, ...csrf ? { 'x-csrf-token': csrf } : {} },
      async *[Symbol.asyncIterator]() { if (body !== undefined) yield Buffer.from(JSON.stringify(body)) } }
    const res = { status: 0, headers: {}, body: Buffer.alloc(0), headersSent: false,
      writeHead(status, headers = {}) { this.status = status; this.headers = headers; this.headersSent = true; return this },
      write(chunk) { this.body = Buffer.concat([this.body, Buffer.from(chunk)]); return true },
      end(chunk) { if (chunk != null) this.write(chunk) } }
    await handler(req, res)
    return { status: res.status, headers: res.headers, body: res.body, json: () => JSON.parse(res.body.toString()) }
  }
}

test('linked GitHub accounts: SQLite semantics', async t => {
  const db = openSqliteManagedDb(':memory:')
  t.after(() => db.close())
  await checkGithubLinks(db)
})

test('SQLite upgrade keeps existing names as the sign-in accounts\' own', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'managed-github-links-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'managed.sqlite')
  let db = openSqliteManagedDb(path)
  const user = await db.upsertUser(identity(1, 'alice', 'Alice'), 1)
  await db.close()
  const legacy = new DatabaseSync(path)
  legacy.exec(`ALTER TABLE managed_user DROP COLUMN avatar_link; ALTER TABLE managed_user DROP COLUMN name_link;
    ALTER TABLE managed_user DROP COLUMN github_name; DROP TABLE managed_github_link;`)
  legacy.close()
  db = openSqliteManagedDb(path)
  t.after(() => db.close())
  assert.deepEqual(await db.getProfile(user), { login: 'alice', name: 'Alice', githubName: 'Alice', nameAccount: null, avatarAccount: null, accounts: [] })
  assert.equal(await db.upsertUser(identity(1, 'alice', 'Alice R'), 2), user)
  assert.equal((await db.getProfile(user)).name, 'Alice R', 'no name was chosen, so sign-in still renames')
})

test('sign-in refuses a linked account without creating a user', async t => {
  const db = openSqliteManagedDb(':memory:')
  t.after(() => db.close())
  const alice = await createSession(config, db, identity(1, 'alice'), Date.now())
  await db.setUserRole(alice.userId, 'view')
  const { session } = await readSession(config, db, cookiePair(alice.setCookie), Date.now())
  await db.linkGithubAccount(session.id, identity(2, 'alice-work'), Date.now())
  const login = handleCallback(new URLSearchParams({ code: 'code', state: 'state' }), 'dvstate=state',
    { config: { ...config, initialAdminGithubId: 2 }, db, fetchImpl: github({ id: 2, login: 'alice-work' }) })
  await assert.rejects(login, error => error instanceof OAuthError && error.status === 403 && error.message === 'github-account-linked')
  assert.equal(await createSession(config, db, identity(2, 'alice-work'), Date.now()), null)
  assert.deepEqual((await db.listUsers()).map(user => user.login), ['alice'])
})

test('link authorization asks for GitHub\'s account picker and lands on the profile, bound to the session that asked', async t => {
  const db = openSqliteManagedDb(':memory:')
  t.after(() => db.close())
  const alice = await createSession(config, db, identity(1, 'alice'), 1000)
  await db.setUserRole(alice.userId, 'view')
  const { session } = await readSession(config, db, cookiePair(alice.setCookie), 1000)
  const now = 2000, redirect = linkLoginRedirect(config, session, now)
  const url = new URL(redirect.location)
  assert.equal(url.origin + url.pathname, 'https://github.com/login/oauth/authorize')
  assert.equal(url.searchParams.get('client_id'), config.githubClientId)
  assert.equal(url.searchParams.get('redirect_uri'), config.oauthCallbackUrl)
  assert.equal(url.searchParams.get('prompt'), 'select_account')
  assert.equal(url.searchParams.has('scope'), false)
  assert.match(redirect.setCookie, /^dvlinkstate=[\w-]+\.[\w-]+\.2000;/u)
  const cookie = cookiePair(redirect.setCookie)
  const query = new URLSearchParams({ code: 'code', state: url.searchParams.get('state') })
  assert.equal(isLinkOAuthCallback(config, query, cookie), true)
  assert.equal(isLinkOAuthCallback(config, new URLSearchParams({ code: 'code', state: 'other' }), cookie), false)

  const work = { id: 2, login: 'alice-work', name: 'Alice at Work', avatar_url: 'https://avatars.githubusercontent.com/u/2' }
  const refused = async (args, error) => {
    const result = await linkOAuthCallback(config, db, ...args)
    assert.equal(result.location, `/my/profile?link-error=${error}`)
    assert.match(result.setCookie, /^dvlinkstate=;.*Max-Age=0/u)
    assert.equal(result.linked, null)
  }
  const options = { fetchImpl: github(work), now }
  await refused([{ ...session, id: 'another' }, query, cookie, options], 'invalid-oauth-state')
  await refused([session, query, cookie, { ...options, now: now + 600_001 }], 'invalid-oauth-state')
  await refused([session, query, 'dvlinkstate=forged.state.2000', options], 'invalid-oauth-state')
  await refused([session, new URLSearchParams({ error: 'access_denied', state: query.get('state') }), cookie, options], 'github-authorization-declined')
  await refused([session, query, cookie, { ...options, fetchImpl: github({ id: 1, login: 'alice' }) }], 'github-account-own')
  assert.deepEqual((await db.getProfile(alice.userId)).accounts, [])

  const avatars = avatarStore()
  const linked = await linkOAuthCallback(config, db, session, query, cookie, { ...options, avatarStore: avatars })
  assert.deepEqual({ ...linked, setCookie: undefined }, { location: '/my/profile', linked: 'alice-work', setCookie: undefined })
  const [account] = (await db.getProfile(alice.userId)).accounts
  assert.deepEqual(account, { id: account.id, githubId: 2, login: 'alice-work', name: 'Alice at Work', linkedAt: now })
  assert.equal(avatars.map.get(account.id).bytes.toString(), 'linked-avatar', 'its avatar is cached under the link')
  assert.equal(await db.getUserTokens(alice.userId), null, 'the linked account\'s token is never kept')
  const again = await linkOAuthCallback(config, db, session, query, cookie, { ...options, fetchImpl: github({ ...work, name: 'Renamed' }) })
  assert.equal(again.linked, null, 'linking it again only refreshes it')
  assert.equal((await db.getProfile(alice.userId)).accounts[0].name, 'Renamed')
})

test('profile routes: workspace access, CSRF, read-only views, avatar choice and unlinking', async t => {
  const db = openSqliteManagedDb(':memory:')
  t.after(() => db.close())
  const avatars = avatarStore()
  const send = routes(db, avatars)
  const alice = await createSession(config, db, identity(1, 'alice', 'Alice'), Date.now())
  const pending = await createSession(config, db, identity(2, 'pending'), Date.now())
  const bob = await createSession(config, db, identity(3, 'bob'), Date.now())
  await db.setUserRole(alice.userId, 'view')
  await db.setUserRole(bob.userId, 'admin')
  const as = (s, extra = {}) => ({ cookie: cookiePair(s.setCookie), csrf: s.csrfToken, ...extra })
  await avatars.put(alice.userId, 'image/png', Buffer.from('own-avatar'))

  // Starting a link needs workspace access, and never runs in a view.
  assert.equal((await send('GET', '/api/oauth/github/link')).status, 401)
  assert.equal((await send('GET', '/api/oauth/github/link', as(pending))).status, 403)
  const start = await send('GET', '/api/oauth/github/link', as(alice))
  assert.equal(start.status, 302)
  assert.equal(new URL(start.headers.location).searchParams.get('prompt'), 'select_account')
  const viewAs = await send('POST', '/api/auth/view-as', as(bob, { body: { userId: alice.userId } }))
  assert.equal(viewAs.status, 204)
  const viewing = { cookie: `${cookiePair(bob.setCookie)}; ${cookiePair(viewAs.headers['set-cookie'])}`, csrf: bob.csrfToken }
  assert.deepEqual((await send('GET', '/api/oauth/github/link', viewing)).json(), { error: 'view-only' })

  // GitHub returns to the shared callback; the state cookie routes it here.
  const state = new URL(start.headers.location).searchParams.get('state')
  const callback = `/api/oauth/github/callback?${new URLSearchParams({ code: 'code', state })}`
  const linkCookie = `${cookiePair(alice.setCookie)}; ${cookiePair(start.headers['set-cookie'])}`
  t.mock.method(globalThis, 'fetch', github({ id: 4, login: 'alice-work', name: 'Alice at Work', avatar_url: 'https://avatars.githubusercontent.com/u/4' }))
  assert.deepEqual((await send('GET', callback, { cookie: `${viewing.cookie}; ${cookiePair(start.headers['set-cookie'])}` })).json(), { error: 'view-only' })
  const landed = await send('GET', callback, { cookie: linkCookie })
  assert.equal(landed.status, 302)
  assert.equal(landed.headers.location, '/my/profile')
  assert.match(landed.headers['set-cookie'], /^dvlinkstate=;/u)
  assert.equal((await send('GET', callback, { cookie: linkCookie })).headers.location, '/my/profile', 'a replayed state refreshes the same link')
  assert.notEqual((await db.listUsers()).find(user => user.id === alice.userId).lastActivityAt, null, 'linking is recorded as access activity')

  assert.equal((await send('GET', '/api/auth/profile')).status, 401)
  assert.equal((await send('GET', '/api/auth/profile', as(pending))).status, 403)
  const { profile } = (await send('GET', '/api/auth/profile', as(alice))).json()
  const [work] = profile.accounts
  assert.deepEqual(profile, { login: 'alice', name: 'Alice', githubName: 'Alice', nameAccount: null, avatarAccount: null,
    accounts: [{ id: work.id, githubId: 4, login: 'alice-work', name: 'Alice at Work', linkedAt: work.linkedAt }] })
  assert.deepEqual((await send('GET', '/api/auth/profile', viewing)).json().profile, profile, 'an admin\'s view reads it')

  // Choices: CSRF, a body naming linked accounts, never through a view.
  const choose = body => send('POST', '/api/auth/profile', as(alice, { body }))
  assert.equal((await send('POST', '/api/auth/profile', { cookie: cookiePair(alice.setCookie), body: { name: work.id } })).status, 403)
  assert.equal((await send('POST', '/api/auth/profile', { ...viewing, body: { name: work.id } })).status, 403)
  for (const body of [{}, null, [], { name: 'not-an-id' }, { avatar: 3 }]) assert.equal((await choose(body)).status, 400)
  assert.deepEqual((await choose({ name: '00000000-0000-4000-8000-000000000000' })).json(), { error: 'no-account' })
  const chosen = (await choose({ name: work.id, avatar: work.id })).json().profile
  assert.deepEqual([chosen.name, chosen.nameAccount, chosen.avatarAccount], ['Alice at Work', work.id, work.id])
  assert.deepEqual((await send('GET', '/api/auth/session', as(alice))).json().user,
    { id: alice.userId, login: 'alice', name: 'Alice at Work', role: 'view' }, 'the session shows the chosen name, the sign-in login')

  // A user's avatar is the chosen one; `own` is the sign-in account's.
  const avatar = async (path, s = bob) => (await send('GET', path, as(s))).body.toString()
  assert.equal(await avatar(`/api/avatar/${alice.userId}`), 'linked-avatar')
  assert.equal(await avatar(`/api/avatar/${alice.userId}?own`), 'own-avatar')
  assert.equal(await avatar(`/api/avatar/${work.id}`), 'linked-avatar')
  await avatars.delete(work.id)
  assert.equal(await avatar(`/api/avatar/${alice.userId}`), 'own-avatar', 'one not cached falls back to the sign-in account\'s')

  // Unlinking: CSRF, only one's own, never in a view; what it gave reverts.
  const unlink = `/api/auth/profile/accounts/${work.id}`
  assert.equal((await send('DELETE', unlink, { cookie: cookiePair(alice.setCookie) })).status, 403)
  assert.equal((await send('DELETE', unlink, viewing)).status, 403)
  assert.equal((await send('DELETE', unlink, as(bob))).status, 404)
  assert.equal((await send('POST', unlink, as(alice))).status, 405)
  await avatars.put(work.id, 'image/png', Buffer.from('linked-avatar'))
  const unlinked = await send('DELETE', unlink, as(alice))
  assert.equal(unlinked.status, 200)
  assert.deepEqual(unlinked.json().profile, { login: 'alice', name: 'Alice', githubName: 'Alice', nameAccount: null, avatarAccount: null, accounts: [] })
  assert.equal(avatars.map.has(work.id), false, 'its cached avatar goes with it')
  assert.equal((await send('DELETE', unlink, as(alice))).status, 404)
  assert.ok(await db.upsertUser(identity(4, 'alice-work'), Date.now()), 'it may register again')
})
