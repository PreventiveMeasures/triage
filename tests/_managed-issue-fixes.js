import assert from 'node:assert/strict'
import { hashToken } from '../server-managed/crypto.ts'
import { setup } from './_managed-mutation-safety.js'

export async function checkManagedIssueFixes(db) {
  const session = await setup(db), sessionId = hashToken(session.setCookie.split(';')[0].slice(4))
  await db.createTeam('team', 'Team', 1)
  await db.setTeamRepo('team', 1, '')
  await db.setTeamMember('team', session.userId, { dependencies: true, security: true })
  const snapshot = await db.getTeamReportAccessSnapshot(sessionId, Date.now(), 'team')
  const issueUrl = 'https://github.com/org/repo1/issues/1', next = 'https://github.com/org/repo1/pull/2'
  const revision = await db.getAnnotationRevision(['finding'])
  await db.claimManagedIssue({ findingId: 'finding', repoId: 1, repository: 'org/repo1', requestId: 'request', createdBy: session.userId, createdAt: 1 })
  assert.equal(await db.getAnnotationRevision(['finding']), revision, 'pending creation is not a visible issue')
  await db.finishManagedIssue('finding', 'request', issueUrl)
  assert.notEqual(await db.getAnnotationRevision(['finding']), revision, 'saved issues notify existing viewers')
  await db.setTriage('finding', { fix: 'manual override', comment: 'keep', triage: 'in-progress' }, session.userId, 'admin', 1)
  const history = await db.listTriageHistory('finding', 100), manual = await db.listTriage(['finding'])
  const beforeFix = await db.getAnnotationRevision(['finding'])
  const fixed = { autoFix: next, duplicateOf: null }, none = { autoFix: null, duplicateOf: null }
  const update = { findingId: 'finding', issueUrl, previous: none, next: fixed, checkedAt: 100 }
  assert.equal(await db.applyManagedIssueFixes(sessionId, snapshot, [update]), true)
  assert.equal((await db.getManagedIssue('finding')).autoFixUrl, next)
  assert.deepEqual(await db.listTriage(['finding']), manual)
  assert.deepEqual(await db.listTriageHistory('finding', 100), history, 'derived metadata is not a user edit')
  const afterFix = await db.getAnnotationRevision(['finding'])
  assert.notEqual(afterFix, beforeFix)
  assert.equal(await db.setManagedIssueTracking('finding', issueUrl, fixed, fixed, 200), true)
  assert.equal(await db.getAnnotationRevision(['finding']), afterFix, 'a timestamp refresh does not broadcast unchanged annotations')
  assert.equal(await db.setManagedIssueTracking('finding', issueUrl, fixed, none, 150), false, 'older responses cannot clear newer results')
  assert.equal(await db.setManagedIssueTracking('finding', issueUrl, none, none, 300), false, 'stale values cannot win')
  assert.equal(await db.setManagedIssueTracking('finding', issueUrl + '0', fixed, none, 300), false, 'updates belong to the same saved issue')
  assert.equal(await db.setManagedIssueTracking('finding', issueUrl, fixed, none, 300), true)
  assert.equal((await db.getAnnotations(['finding'])).issues[0].autoFixUrl, null)

  // The issue it was closed as a duplicate of sits beside the saved one, which
  // stays; it is compared and ordered as the derived Fix is, and notifies.
  const duplicateOf = 'https://github.com/org/repo1/issues/9'
  const duplicate = { autoFix: null, duplicateOf }
  const beforeDuplicate = await db.getAnnotationRevision(['finding'])
  assert.equal(await db.setManagedIssueTracking('finding', issueUrl, fixed, duplicate, 310), false, 'the duplicate read must be the one stored')
  assert.equal(await db.setManagedIssueTracking('finding', issueUrl, none, duplicate, 310), true)
  const saved = await db.getManagedIssue('finding')
  assert.equal(saved.issueUrl, issueUrl, 'the saved issue is never replaced')
  assert.equal(saved.duplicateOfUrl, duplicateOf)
  assert.equal((await db.getAnnotations(['finding'])).issues[0].duplicateOfUrl, duplicateOf)
  assert.notEqual(await db.getAnnotationRevision(['finding']), beforeDuplicate, 'a new duplicate notifies existing viewers')
  assert.equal(await db.setManagedIssueTracking('finding', issueUrl, duplicate, none, 305), false, 'an older lookup cannot drop it')
  assert.equal(await db.setManagedIssueTracking('finding', issueUrl, duplicate, none, 320), true, 'a reopened issue drops it')
  assert.equal((await db.getManagedIssue('finding')).duplicateOfUrl, null)
  await db.setTeamHidden('team', true, 400)
  assert.equal(await db.applyManagedIssueFixes(sessionId, snapshot, [{ ...update, checkedAt: 500 }]), false)
  assert.equal((await db.getManagedIssue('finding')).autoFixUrl, null, 'revoked workspace access prevents persistence')
}
