import assert from 'node:assert/strict'
import { beforeEach, mock, test } from 'node:test'
import './_polyfills.js'
import '../ui/view/frontend-install.js'
import { state } from '../client/state.ts'
import { canViewFindingHistory } from '../ui/view/finding-history.js'
import { findingHistoryChanges } from '../ui/view/finding-history-changes.js'
import { managedAppState } from '../ui/managed/state.js'

class TestDialog {
  static styles = []
  isConnected = true
  _finish() { this._settled = true; this.isConnected = false; this.disconnectedCallback() }
  _onClose = () => this._finish(null)
  disconnectedCallback() {}
}
mock.module('../ui/view/dialogs/app-dialog.js', { namedExports: { AppDialog: TestDialog, openAppDialog: () => {} } })
await import('../ui/view/dialogs/finding-history-dialog.js')
const Dialog = customElements.get('finding-history-dialog')
const finding = { id: 'finding', _managedReportId: 'report', file: 'src/main.js' }
const events = [{ seq: 1, at: 100, actorLogin: 'alice', entry: { triage: 'fixed' } }]
let calls, gate

beforeEach(t => {
  managedAppState.reset(); managedAppState.setSession({ id: 'alice', role: 'triage' })
  calls = []; gate = null
  t.mock.method(managedAppState, 'notify', () => {})
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options })
    if (gate) await gate.promise
    return Response.json({ finding: finding.id, events })
  })
})
function dialog() { return Object.assign(new Dialog(), { finding, teamId: 'team', isCurrent: () => true }) }

test('history is restricted to authenticated managed triage roles with a report-backed finding', t => {
  const previous = { serverMode: state.serverMode, localMode: state.localMode, managedSession: state.managedSession }
  t.after(() => Object.assign(state, previous))
  Object.assign(state, { serverMode: 'managed', localMode: false })
  for (const role of ['none', 'view', 'triage', 'manage', 'admin', undefined]) {
    state.managedSession = { role }
    assert.equal(canViewFindingHistory(finding), ['triage', 'manage', 'admin'].includes(role), role)
  }
  state.managedSession = { role: 'admin', publicShare: true }
  assert.equal(canViewFindingHistory(finding), false)
  state.managedSession = { role: 'triage' }
  assert.equal(canViewFindingHistory({ id: 'finding' }), false)
  state.localMode = true
  assert.equal(canViewFindingHistory(finding), false)
  state.localMode = false; state.serverMode = 'e2e'
  assert.equal(canViewFindingHistory(finding), false)
})

test('history displays changes and clears without inventing a baseline before retained events', () => {
  assert.deepEqual(findingHistoryChanges({ triage: 'fixed' }, { triage: 'inprogress' }), [
    { label: 'Status', before: 'In progress', after: 'Fixed' },
  ])
  assert.deepEqual(findingHistoryChanges(null, { color: 'red', flagged: true }), [
    { label: 'Label', before: 'red', after: 'None' }, { label: 'Flagged', before: 'Yes', after: 'No' },
  ])
  assert.deepEqual(findingHistoryChanges({ fix: 'PR #12', flagged: false }, undefined), [
    { label: 'Flagged', after: 'No' }, { label: 'Fix', after: 'PR #12' },
  ])
  assert.deepEqual(findingHistoryChanges(null, undefined), [])
})

test('history requests use the finding report and team, refresh each open, and discard data on close', async () => {
  const view = dialog()
  view.teamId = 'team +/'
  await view._load()
  const url = new URL(calls[0].url, 'https://example.test')
  assert.equal(url.pathname, '/api/reports/report/triage/history')
  assert.equal(url.searchParams.get('team'), view.teamId)
  assert.equal(url.searchParams.get('finding'), finding.id)
  assert.deepEqual(view._events, events)
  view._finish(null)
  assert.deepEqual(view._events, [])
  assert.equal(managedAppState.resources.size, 0)
  const reopened = dialog()
  await reopened._load()
  assert.equal(calls.length, 2)
  reopened._finish(null)
})

for (const change of ['session', 'catalog', 'reload']) {
  test(`${change} invalidation closes open history and clears its events`, async () => {
    const view = dialog()
    await view._load()
    if (change === 'session') managedAppState.reset()
    else if (change === 'catalog') managedAppState.setReportCatalog([{ id: 'team', reports: [{ id: 'report', cacheKey: 'new-permissions' }] }])
    else managedAppState.invalidate(['finding-history'])
    assert.equal(view._settled, true)
    assert.deepEqual(view._events, [])
  })
}

test('revocation or close while loading cannot repopulate the dialog with a late response', async () => {
  for (const close of [() => managedAppState.reset(), view => view._finish(null)]) {
    gate = Promise.withResolvers()
    const view = dialog()
    const loading = view._load()
    close(view)
    gate.resolve()
    await loading
    assert.equal(view._settled, true)
    assert.deepEqual(view._events, [])
  }
})

test('a lost caller scope cannot issue a request; failures are distinct from empty history', async t => {
  const stale = dialog()
  stale.isCurrent = () => false
  await stale._load()
  assert.equal(calls.length, 0)
  for (const status of [404, 503]) {
    t.mock.method(globalThis, 'fetch', () => Promise.resolve(new Response(null, { status })))
    const view = dialog()
    await view._load()
    assert.equal(view._error, true)
    assert.deepEqual(view._events, [])
    view._finish(null)
  }
})
