import assert from 'node:assert/strict'

const identity = (id, login, name = null) => ({ githubUserId: 7000 + id, login, name, avatarUrl: null })

// Shared SQLite/Postgres semantics of linked GitHub accounts and the profile
// choices they offer (server-managed/github-links.ts).
export async function checkGithubLinks(db) {
  const alice = await db.upsertUser(identity(1, 'alice', 'Alice'), 1)
  const bob = await db.upsertUser(identity(2, 'bob'), 1)
  const pending = await db.upsertUser(identity(3, 'pending'), 1)
  await db.setUserRole(alice, 'view')
  await db.setUserRole(bob, 'admin')
  for (const [id, userId] of [['alice-session', alice], ['bob-session', bob], ['pending-session', pending]]) {
    await db.createSession({ id, userId, csrfToken: `${id}-csrf`, expiresAt: 1000 }, 1)
  }
  const work = identity(10, 'alice-work', 'Alice at Work')
  const userOf = async (session, now = 5) => (await db.sessionWithUser(session, now)).user

  const first = await db.linkGithubAccount('alice-session', work, 2)
  assert.equal(first.created, true)
  assert.equal(await db.upsertUser(work, 3), null, 'a linked account cannot register')
  assert.equal((await db.listUsers()).length, 3)
  assert.deepEqual(await db.getProfile(alice), { login: 'alice', name: 'Alice', githubName: 'Alice', nameAccount: null, avatarAccount: null,
    accounts: [{ id: first.id, login: 'alice-work', name: 'Alice at Work', linkedAt: 2 }] })

  await assert.rejects(db.linkGithubAccount('alice-session', identity(1, 'alice'), 3), /github-account-own/u)
  await assert.rejects(db.linkGithubAccount('alice-session', identity(2, 'bob'), 3), /github-account-registered/u)
  await assert.rejects(db.linkGithubAccount('bob-session', work, 3), /github-account-linked/u, 'one user per linked account')
  await assert.rejects(db.linkGithubAccount('pending-session', identity(11, 'pending-work'), 3), /forbidden/u, 'No access links nothing')
  await assert.rejects(db.linkGithubAccount('missing', identity(11, 'nobody'), 3), /unauthenticated/u)
  await assert.rejects(db.linkGithubAccount('alice-session', identity(11, 'late'), 1000), /unauthenticated/u, 'an expired session')
  assert.equal(await db.createViewSession({ id: 'view', viewerSessionId: 'bob-session', userId: alice, csrfToken: 'view-csrf' }, 2), true)
  await assert.rejects(db.linkGithubAccount('view', identity(11, 'viewed-work'), 3), /unauthenticated/u, 'never through a view')
  await assert.rejects(db.setProfileChoice('view', { name: first.id }, 3), /unauthenticated/u)
  await assert.rejects(db.unlinkGithubAccount('view', first.id, 3), /unauthenticated/u)
  await assert.rejects(db.setProfileChoice('alice-session', { name: '00000000-0000-4000-8000-000000000000' }, 3), /no-account/u)

  // The name and avatar may come from a linked account; the login never does.
  await db.setProfileChoice('alice-session', { name: first.id, avatar: first.id }, 4)
  assert.deepEqual(await userOf('alice-session'), { id: alice, login: 'alice', name: 'Alice at Work', avatarUrl: null, role: 'view' })
  assert.equal((await db.listUsers()).find(user => user.id === alice).name, 'Alice at Work', 'shown everywhere the user is')
  assert.equal(await db.getAvatarKey(alice), first.id)
  assert.equal(await db.getAvatarKey(bob), bob)
  assert.equal(await db.getAvatarKey(first.id), first.id, 'a linked account serves its own')
  await assert.rejects(db.setProfileChoice('bob-session', { avatar: first.id }, 4), /no-account/u, 'only the user who linked it')

  // Signing in refreshes the sign-in account's own name, keeping the chosen one.
  assert.equal(await db.upsertUser(identity(1, 'alice-renamed', 'Alice R'), 5), alice)
  assert.equal((await userOf('alice-session')).name, 'Alice at Work')
  assert.equal((await userOf('alice-session')).login, 'alice-renamed')
  assert.equal((await db.getProfile(alice)).githubName, 'Alice R')
  // Linking it again refreshes its snapshot, and the name it gives.
  assert.deepEqual(await db.linkGithubAccount('alice-session', { ...work, login: 'alice-job', name: 'A. Work' }, 6), { id: first.id, created: false })
  assert.equal((await userOf('alice-session')).name, 'A. Work')
  assert.deepEqual((await db.getProfile(alice)).accounts, [{ id: first.id, login: 'alice-job', name: 'A. Work', linkedAt: 2 }])

  const nameless = await db.linkGithubAccount('alice-session', identity(12, 'alice-anon'), 7)
  await db.setProfileChoice('alice-session', { name: nameless.id }, 7)
  assert.equal((await userOf('alice-session')).name, null, 'a nameless account leaves no name')
  await db.setProfileChoice('alice-session', { name: null }, 7)
  assert.equal((await userOf('alice-session')).name, 'Alice R', 'back to the sign-in account')
  assert.equal(await db.getAvatarKey(alice), first.id, 'an absent choice is kept')
  await db.setProfileChoice('alice-session', { name: first.id }, 7)

  // Unlinking returns what it gave to the sign-in account; the account may
  // then sign in on its own.
  assert.equal(await db.unlinkGithubAccount('bob-session', first.id, 8), null)
  assert.deepEqual(await db.unlinkGithubAccount('alice-session', first.id, 8), { id: first.id, login: 'alice-job', name: 'A. Work', linkedAt: 2 })
  assert.equal(await db.unlinkGithubAccount('alice-session', first.id, 8), null)
  assert.deepEqual(await db.getProfile(alice), { login: 'alice-renamed', name: 'Alice R', githubName: 'Alice R', nameAccount: null, avatarAccount: null,
    accounts: [{ id: nameless.id, login: 'alice-anon', name: null, linkedAt: 7 }] })
  assert.equal(await db.getAvatarKey(alice), alice)
  const registered = await db.upsertUser(work, 9)
  assert.ok(registered && registered !== alice)
  await assert.rejects(db.linkGithubAccount('alice-session', work, 9), /github-account-registered/u)
  assert.equal(await db.getProfile('00000000-0000-4000-8000-000000000000'), null)
}
