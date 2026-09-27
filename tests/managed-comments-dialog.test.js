import assert from 'node:assert/strict'
import { beforeEach, mock, test } from 'node:test'

const state = { serverMode: 'managed', localMode: false, managedSession: { id: 'alice', role: 'triage' },
  managedReports: [{ id: 'report' }], reports: [], managedComments: new Map() }
const finding = { id: 'finding', _managedReportId: 'report' }
const original = { id: 'comment', findingId: 'finding', authorId: 'alice', authorLogin: 'alice', body: 'Original', version: 1 }
let serverComments
const events = new EventTarget()
class TestDialog {
  static styles = []
  isConnected = true
  updateComplete = Promise.resolve()
  thread = { scrollHeight: 1000, clientHeight: 200, scrollTop: 800 }
  renderRoot = { querySelector: selector => selector === '.discussion-log' ? this.thread : null }
  connectedCallback() {}
  disconnectedCallback() {}
  _finish() { this._settled = true; this.isConnected = false; this.disconnectedCallback() }
}
mock.module('../client/index.js', { namedExports: { state, isManagedUiMode: () => !state.localMode } })
mock.module('../ui/view/dialogs/app-dialog.js', { namedExports: { AppDialog: TestDialog, openAppDialog() {} } })
mock.module('../ui/view/client-managed.js', { namedExports: {
  fetchReportComments: () => Promise.resolve(serverComments),
  deleteReportComment() { assert.fail('Live updates must not delete comments') },
  saveReportComment() { assert.fail('Live updates must not save comments') },
} })
mock.module('../ui/view/render-finding.js', { namedExports: { renderCommentText: text => text } })
mock.module('../ui/view/managed-comment.js', { namedExports: { managedCommentAvatar() {}, managedCommentTemplate() {} } })
const { loadManagedReportComments } = await import('../ui/view/managed-comments.js')
await import('../ui/view/dialogs/managed-comments-dialog.js')
const Dialog = customElements.get('managed-comments-dialog')
globalThis.document = events
const settle = async () => { for (let i = 0; i < 5; i++) await Promise.resolve() }

beforeEach(() => {
  state.localMode = false
  state.reports = [{ _managedReportId: 'report', groups: [[finding], [{ id: 'other-finding' }]] }]
  state.managedComments.clear()
  serverComments = [original]
})
async function open(t) {
  const dialog = new Dialog()
  dialog.finding = finding
  dialog.connectedCallback()
  dialog.beforeOpen()
  await settle()
  t.after(() => { if (dialog.isConnected) dialog._finish() })
  return dialog
}

test('an open discussion receives remote comment additions, edits and deletions without Refresh', async t => {
  const dialog = await open(t)
  const added = { ...original, id: 'second', body: 'Added elsewhere' }
  serverComments = [original, added]
  await loadManagedReportComments('report')
  assert.deepEqual(dialog._comments, serverComments)
  serverComments = [{ ...original, body: 'Edited elsewhere', version: 2 }, added]
  await loadManagedReportComments('report')
  assert.deepEqual(dialog._comments, serverComments)
  serverComments = []
  await loadManagedReportComments('report')
  assert.deepEqual(dialog._comments, [])
})

test('live updates preserve drafts, original edit versions, busy state and errors', async t => {
  const dialog = await open(t)
  dialog._edit(dialog._comments[0])
  dialog._value = 'Unsent draft'
  dialog._busy = true
  dialog._error = 'Existing error'
  serverComments = [{ ...original, body: 'Remote edit', version: 2 }]
  await loadManagedReportComments('report')
  assert.equal(dialog._comments[0].body, 'Remote edit')
  assert.equal(dialog._value, 'Unsent draft')
  assert.equal(dialog._editing.version, 1, 'keep optimistic concurrency protection for the draft')
  assert.equal(dialog._busy, true)
  assert.equal(dialog._error, 'Existing error')
})

test('live discussion scrolling follows the bottom but preserves a reader browsing older comments', async t => {
  const dialog = await open(t)
  dialog.thread.scrollTop = 800
  serverComments = [original, { ...original, id: 'new' }]
  await loadManagedReportComments('report')
  await settle()
  assert.equal(dialog.thread.scrollTop, 1000)
  dialog.thread.scrollTop = 100
  serverComments = []
  await loadManagedReportComments('report')
  await settle()
  assert.equal(dialog.thread.scrollTop, 100)
})

test('disconnect removes the live subscription and reopening reads the latest comments', async t => {
  const dialog = await open(t)
  dialog._finish()
  const before = dialog._comments
  serverComments = [{ ...original, body: 'After closing' }]
  await loadManagedReportComments('report')
  assert.equal(dialog._comments, before)
  const reopened = await open(t)
  assert.equal(reopened._comments[0].body, 'After closing')
})

test('a dialog from the previous view closes instead of adopting another report view’s updates', async t => {
  const dialog = await open(t)
  const before = dialog._comments
  state.reports = [{ _managedReportId: 'report', groups: [[finding]] }]
  serverComments = [{ ...original, body: 'Next view' }]
  await loadManagedReportComments('report')
  assert.equal(dialog._settled, true)
  assert.equal(dialog._comments, before)
})
