import assert from 'node:assert/strict'

const identity = (id, login) => ({ githubUserId: 9000 + id, login, name: login === 'viewer' ? 'Viewer Admin' : null, avatarUrl: null })

// Shared SQLite/Postgres semantics of an administrator's read-only views.
export async function checkViewSessions(db) {
  const admin = await db.upsertUser(identity(1, 'viewer'), 1)
  const viewed = await db.upsertUser(identity(2, 'viewed'), 1)
  const other = await db.upsertUser(identity(3, 'other'), 1)
  await db.setUserRole(admin, 'admin')
  await db.setUserRole(viewed, 'triage')
  await db.setUserRole(other, 'admin')
  await db.createSession({ id: 'admin-session', userId: admin, csrfToken: 'admin-csrf', expiresAt: 1000 }, 1)
  await db.createSession({ id: 'other-session', userId: other, csrfToken: 'other-csrf', expiresAt: 1000 }, 1)
  const open = (id, userId, viewerSessionId = 'admin-session', now = 2) =>
    db.createViewSession({ id, viewerSessionId, userId, csrfToken: `${id}-csrf` }, now)
  const lastSeen = async id => (await db.listUsers()).find(user => user.id === id).lastSeenAt

  assert.equal(await open('view', viewed), true)
  const view = await db.viewSessionWithUser('view', 'admin-session', 5)
  assert.deepEqual(view.user, { id: viewed, login: 'viewed', name: null, avatarUrl: null, role: 'triage' })
  assert.deepEqual(view.session, { id: 'view', userId: viewed, csrfToken: 'view-csrf', expiresAt: 1000, uploadKey: null,
    viewer: { id: admin, login: 'viewer', name: 'Viewer Admin' } }, 'the view expires with the admin session')
  assert.equal(await lastSeen(viewed), null, 'viewing is not the viewed user being present')
  assert.equal(await lastSeen(admin), 5, 'it is the admin being present')
  assert.equal(await db.sessionWithUser('view', 5), null, 'a view token is not a sign-in')
  assert.equal(await db.viewSessionWithUser('view', 'other-session', 5), null, 'only its own admin session carries a view')
  assert.equal(await db.viewSessionWithUser('admin-session', 'admin-session', 5), null, 'a sign-in is not a view')
  assert.equal(await db.viewSessionWithUser('view', 'admin-session', 1000), null, 'expired with the admin session')

  assert.equal(await open('self', admin), false, 'admins cannot view as themselves')
  assert.equal(await open('missing', 'missing-user'), false)
  assert.equal(await open('expired', viewed, 'admin-session', 1000), false)
  assert.equal(await open('nested', other, 'view'), false, 'a view cannot open another view')
  await db.createSession({ id: 'triage-session', userId: viewed, csrfToken: 'csrf', expiresAt: 1000 }, 1)
  assert.equal(await open('escalation', admin, 'triage-session'), false, 'only admins open views')
  assert.ok(await db.viewSessionWithUser('view', 'admin-session', 5), 'refused attempts leave the open view')

  assert.equal(await open('replacement', other), true)
  assert.equal(await db.viewSessionWithUser('view', 'admin-session', 5), null, 'one view per admin session')
  assert.equal((await db.viewSessionWithUser('replacement', 'admin-session', 5)).user.id, other)
  assert.equal(await open('second-admin', viewed, 'other-session'), true, 'other admins keep their own views')

  await db.setUserRole(admin, 'manage')
  assert.equal(await db.viewSessionWithUser('replacement', 'admin-session', 5), null)
  await db.setUserRole(admin, 'admin')
  assert.equal(await db.viewSessionWithUser('replacement', 'admin-session', 5), null, 'a former admin\'s views stay ended')
  assert.ok(await db.viewSessionWithUser('second-admin', 'other-session', 5))

  assert.equal(await open('ending', viewed), true)
  await db.deleteSession('admin-session')
  assert.equal(await db.viewSessionWithUser('ending', 'admin-session', 5), null)
  await db.createSession({ id: 'admin-session', userId: admin, csrfToken: 'admin-csrf', expiresAt: 1000 }, 6)
  assert.equal(await db.viewSessionWithUser('ending', 'admin-session', 7), null, 'signing out removed the view itself')
  await db.setUserRole(viewed, 'none')
  assert.equal((await db.viewSessionWithUser('second-admin', 'other-session', 7)).user.role, 'none', 'views follow the current role')
  await db.deleteExpiredSessions(1000)
  assert.equal(await db.viewSessionWithUser('second-admin', 'other-session', 7), null)
}
