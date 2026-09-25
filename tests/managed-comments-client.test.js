import assert from 'node:assert/strict'
import { beforeEach, mock, test } from 'node:test'

const state = { serverMode: 'managed', localMode: false, managedSession: null, managedReports: [], reports: [], managedComments: new Map() }
let deleteResult, deletes, fetchResult, saveResult, writes
mock.module('../client/index.js', { namedExports: {
  state, isManagedUiMode: () => state.serverMode === 'managed' && !state.localMode,
} })
mock.module('../ui/view/client-managed.js', { namedExports: {
  fetchReportComments: () => Promise.resolve(typeof fetchResult === 'function' ? fetchResult() : fetchResult),
  saveReportComment: (...args) => { writes.push(args); return Promise.resolve(typeof saveResult === 'function' ? saveResult() : saveResult) },
  deleteReportComment: (...args) => { deletes.push(args); return Promise.resolve(typeof deleteResult === 'function' ? deleteResult() : deleteResult) },
} })
const { deleteManagedComment, loadManagedReportComments, managedCommentsFor, writeManagedComment } = await import('../ui/view/managed-comments.js')
const finding = { id: 'f', _managedReportId: 'r' }
const comment = { id: 'c', findingId: 'f', body: 'Note', authorId: 'alice', authorLogin: 'alice', createdAt: 10, updatedAt: 10, version: 1 }

beforeEach(() => {
  state.serverMode = 'managed'; state.localMode = false
  state.managedSession = { id: 'alice', login: 'alice', role: 'triage', csrfToken: 'token' }
  state.managedReports = [{ id: 'r' }]
  state.reports = [{ _managedReportId: 'r', groups: [[finding]] }]
  state.managedComments.clear()
  fetchResult = [comment]
  saveResult = { status: 201, comment }
  writes = []
  deletes = []
  deleteResult = 204
})

test('managed comment hydration stays in its report scope and accepts unattributed notes', async () => {
  const legacy = { ...comment, id: 'legacy', authorId: null, authorLogin: null, createdAt: null, updatedAt: null }
  fetchResult = [legacy, { ...comment, findingId: 'foreign' }]
  assert.equal(await loadManagedReportComments('r'), true)
  assert.deepEqual(managedCommentsFor(finding), [legacy])
  assert.equal(state.managedComments.has('foreign'), false)
  assert.equal(await loadManagedReportComments('not-open'), false)
})

test('posting keeps undated comments ahead of dated comments without treating epoch zero as missing', async () => {
  const undated = { ...comment, id: 'undated', createdAt: null, updatedAt: null }
  const beforeEpoch = { ...comment, id: 'before', createdAt: -10 }
  state.managedComments.set('f', [undated, beforeEpoch])
  saveResult = { status: 201, comment: { ...comment, createdAt: 0 } }
  await writeManagedComment(finding, 'Note')
  assert.deepEqual(managedCommentsFor(finding).map(entry => entry.id), ['undated', 'before', 'c'])
})

test('deletion removes only the owned comment after server confirmation', async () => {
  const other = { ...comment, id: 'other', authorId: 'bob' }
  const anonymous = { ...comment, id: 'anonymous', authorId: null }
  state.managedComments.set('f', [comment, other, anonymous])
  assert.equal(await deleteManagedComment(finding, other), 403)
  assert.equal(await deleteManagedComment(finding, anonymous), 403)
  assert.equal(deletes.length, 0)
  deleteResult = 409
  assert.equal(await deleteManagedComment(finding, comment), 409)
  assert.equal(managedCommentsFor(finding).length, 3)
  deleteResult = 204
  assert.equal(await deleteManagedComment(finding, comment), 204)
  assert.deepEqual(deletes[1], ['r', 'c', 1, 'token'])
  assert.deepEqual(managedCommentsFor(finding), [other, anonymous])
})

test('stale deletions cannot change another view and read-only users cannot delete', async () => {
  let finish
  state.managedComments.set('f', [comment])
  deleteResult = () => new Promise(resolve => { finish = resolve })
  const pending = deleteManagedComment(finding, comment)
  state.reports = []
  finish(204)
  assert.equal(await pending, 0)
  assert.deepEqual(managedCommentsFor(finding), [comment])
  state.reports = [{ _managedReportId: 'r', groups: [[finding]] }]
  state.managedSession.role = 'view'
  assert.equal(await deleteManagedComment(finding, comment), 403)
  state.managedSession.role = 'triage'
  state.localMode = true
  assert.equal(await deleteManagedComment(finding, comment), 403)
  assert.equal(deletes.length, 1)
})

test('posting and editing use separate requests and preserve other authors comments', async () => {
  const other = { ...comment, id: 'other', authorId: 'bob', authorLogin: 'bob' }
  state.managedComments.set('f', [other])
  assert.equal((await writeManagedComment(finding, 'Note')).status, 201)
  assert.equal(managedCommentsFor(finding).length, 2)
  assert.deepEqual(writes[0], ['r', { findingId: 'f', body: 'Note', commentId: undefined, version: undefined }, 'token'])
  saveResult = { status: 200, comment: { ...comment, body: 'Edited', version: 2, updatedAt: 20 } }
  await writeManagedComment(finding, 'Edited', comment)
  assert.equal(writes[1][1].commentId, 'c')
  assert.equal(writes[1][1].version, 1)
  assert.deepEqual(managedCommentsFor(finding).find(entry => entry.id === 'other'), other)
  assert.equal(managedCommentsFor(finding).find(entry => entry.id === 'c').body, 'Edited')
  assert.equal((await writeManagedComment(finding, 'Overwrite', other)).status, 403)
  assert.equal(writes.length, 2)
  saveResult = { status: 409, comment: null }
  await writeManagedComment(finding, 'Stale', comment)
  assert.equal(managedCommentsFor(finding).find(entry => entry.id === 'c').body, 'Edited', 'failed edits never optimistically replace stored text')
})

function staleLoadTest(transition) {
  return async () => {
    let finish
    fetchResult = () => new Promise(resolve => { finish = resolve })
    const pending = loadManagedReportComments('r')
    if (transition === 'local') state.localMode = true
    if (transition === 'report') state.reports = []
    if (transition === 'user') state.managedSession = { ...state.managedSession, id: 'bob' }
    finish([comment])
    assert.equal(await pending, false)
    assert.equal(state.managedComments.size, 0)
  }
}
for (const transition of ['local', 'report', 'user']) {
  test(`in-flight comments cannot hydrate after a ${transition} switch`, staleLoadTest(transition))
}

test('stale saves and read-only/local modes cannot mutate managed comment state', async () => {
  let finish
  saveResult = () => new Promise(resolve => { finish = resolve })
  const pending = writeManagedComment(finding, 'Note')
  state.localMode = true
  finish({ status: 201, comment })
  assert.equal((await pending).status, 0)
  assert.equal(state.managedComments.size, 0)
  assert.deepEqual(managedCommentsFor(finding), [])
  assert.equal((await writeManagedComment(finding, 'Local note')).status, 403)
  state.localMode = false
  state.managedSession.role = 'view'
  assert.equal((await writeManagedComment(finding, 'Read-only note')).status, 403)
  assert.equal(writes.length, 1)
})
