import assert from 'node:assert/strict'
import { hashToken } from '../server-managed/crypto.ts'
import { createSession } from '../server-managed/session.ts'

export async function checkLinkReports(db, readRows) {
  const config = { sessionCookieName: 'sid', cookieSecure: false, sessionTtlMs: 3600000 }
  const session = await createSession(config, db, { githubUserId: 456, login: 'links-admin', name: null, avatarUrl: null }, Date.now())
  await db.setUserRole(session.userId, 'admin')
  session.sessionId = hashToken(session.setCookie.split(';')[0].slice(4))
  const { session: stored } = await db.sessionWithUser(session.sessionId, Date.now()) ?? {}
  // createSession returns the raw token's hash as sessionId.
  assert.ok(stored)
  const imported = await db.importLinkReport(session.sessionId, 'duplicates.link.json', '[["visible-a", "hidden-bridge"], ["hidden-bridge", "visible-b"]]')
  assert.equal(imported.reused, false)
  assert.equal(imported.report.enabled, true)
  const rows = await readRows()
  assert.equal(rows.length, 1)
  assert.equal(JSON.stringify(rows).includes('hidden-bridge'), false, 'finding IDs are encrypted in SQL')
  assert.equal(rows[0].encrypted_groups.includes('visible-a'), false)
  assert.deepEqual(await db.listReports(), [], 'link reports have no report/team/repository identity')
  const revision = await db.getLinkRevision()
  assert.deepEqual(await db.getEnabledLinkGroups(revision), [['visible-a', 'hidden-bridge'], ['hidden-bridge', 'visible-b']])
  await db.setLinkReportEnabled(session.sessionId, imported.report.id, false)
  assert.equal(await db.getLinkRevision(), '')
  await assert.rejects(db.getEnabledLinkGroups(revision), /deduplication-changed/u)
  assert.deepEqual(await db.getEnabledLinkGroups(''), [])
  const repeated = await db.importLinkReport(session.sessionId, 'again.link.json', '[[{"id":"visible-a"},{"id":"hidden-bridge"}], [{"id":"hidden-bridge"},{"id":"visible-b"}]]')
  assert.equal(repeated.reused, true)
  assert.equal(repeated.report.id, imported.report.id)
  assert.equal(repeated.report.enabled, false, 'retrying an import preserves its current setting')
  await db.setLinkReportEnabled(session.sessionId, imported.report.id, true)
  assert.equal(await db.getLinkRevision(), revision)
  await db.setUserRole(session.userId, 'manage')
  await assert.rejects(db.setLinkReportEnabled(session.sessionId, imported.report.id, false), /forbidden/u)
  await assert.rejects(db.importLinkReport(session.sessionId, 'new.link.json', '[["a", "b"]]'), /forbidden/u)
  return imported.report.id
}
