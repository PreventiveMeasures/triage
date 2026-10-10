import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import './_polyfills.js'

// Render the actual card without the page renderer and source-preview DOM.
mock.module('../ui/view/render.js', { namedExports: { render() {} } })
mock.module('../ui/view/dom.js', { namedExports: { report: null } })
// The console façade, without the sidebar, sync client and dialogs it re-exports.
mock.module('../ui/view/sidebar.js', { namedExports: { forceManagedMode() {} } })
mock.module('../ui/view/client-sync.js', { namedExports: { triageSync: {} } })
mock.module('../ui/view/theme.js', { namedExports: { getTheme() {}, setTheme() {} } })
mock.module('../ui/view/dialogs/triage-export-dialog.js', { namedExports: { openTriageExportDialog() {} } })
mock.module('../ui/view/dialogs/report-compare-dialog.js', { namedExports: { openReportCompareDialog() {} } })
const { state } = await import('../client/state.ts')
const { canApplyFixToGroup, canEditTriage, canTriageFinding, fixApplies, syncGroupTriage, triageActionPlan, triageScope, triageEntry } = await import('../ui/view/group.js')
const { findingCardInnerTemplate } = await import('../ui/view/render-finding.js')
// Only now: the modules above would take a `window` for a browser page.
globalThis.window ??= globalThis
await import('../ui/view/api.js')

const SESSIONS = {
  'a public link': { id: 'share', role: 'view', publicShare: true, csrfToken: 'csrf' },
  'the Viewer role': { id: 'viewer', role: 'view', csrfToken: 'csrf' },
  'an admin viewing as a Viewer': { id: 'viewer', role: 'view', csrfToken: 'csrf', viewer: { id: 'admin', login: 'admin', name: null } },
}
const EDITORS = {
  'the Triage role': { id: 'triager', role: 'triage', csrfToken: 'csrf' },
  // The admin sees what the account sees; the server refuses the writes.
  'an admin viewing as a Triage user': { id: 'triager', role: 'triage', csrfToken: 'csrf', viewer: { id: 'admin', login: 'admin', name: null } },
}

function use(t, session, overrides = {}) {
  const next = { serverMode: 'managed', localMode: false, currentManagedTeam: 'team', managedSession: session, ...overrides }
  const previous = Object.fromEntries(Object.keys(next).map(key => [key, state[key]]))
  Object.assign(state, next)
  state.triage.clear()
  t.after(() => { Object.assign(state, previous); state.triage.clear() })
}

let nextId = 0
function finding(entry = null) {
  const f = { id: `f${nextId++}`, severity: 'high', title: 'Finding title', description: 'Finding description', file: 'src/file.js', line: '1',
    repo: { github: 'https://github.com/o/r' }, _managedReportId: 'report', _reportName: 'report.json' }
  if (entry) state.triage.set(f.id, entry)
  return f
}

function templates(value) {
  if (Array.isArray(value)) return value.flatMap(templates)
  return value?.strings ? [value, ...value.values.flatMap(templates)] : []
}

// The bound value of `name` (`?disabled=`, `.disabled=`) in the first
// template whose markup or class map mentions `marker`.
function bound(all, marker, name) {
  const named = template => template.strings.some(s => s.includes(marker))
    || template.values.some(value => value?.values?.[0]?.[marker] === true)
  const template = all.find(named)
  assert.ok(template, `${marker} is rendered`)
  const at = template.strings.findIndex(s => s.trimEnd().endsWith(name))
  assert.notEqual(at, -1, `${marker} binds ${name}`)
  return template.values[at]
}

function controls(group) {
  const all = templates(findingCardInnerTemplate(group))
  return {
    comment: bound(all, 'mark-comment', '?disabled='),
    fix: bound(all, 'mark-fix', '?disabled='),
    flag: bound(all, 'mark-flag', '?disabled='),
    color: bound(all, '<color-marker', '.disabled='),
    triage: bound(all, 'popovertargetaction="toggle"', '?disabled='),
  }
}

for (const [who, session] of Object.entries(SESSIONS)) {
  test(`${who} sees triage but cannot edit it`, t => {
    use(t, session)
    const group = [finding({ triage: 'inprogress', fix: 'https://github.com/o/r/pull/1', flagged: true }), finding({ color: 'red' })]
    assert.equal(canTriageFinding(group[0]), true, 'the saved triage is still read')
    assert.equal(triageEntry(group[0]).triage, 'inprogress')
    assert.equal(canEditTriage(group[0]), false)
    assert.deepEqual(controls(group), { comment: false, fix: true, flag: true, color: true, triage: true },
      'comments still open the discussion; every edit control is disabled')
    assert.deepEqual(triageActionPlan(group, 'fixed').targets, [])
    assert.deepEqual(triageScope(group), [], 'kanban cards cannot be dragged')
    assert.equal(canApplyFixToGroup(group, ''), false)
    assert.equal(fixApplies(group[1], ''), false)
    assert.equal(syncGroupTriage(group), false, 'opening a group does not level it locally')
    assert.equal(state.triage.get(group[1].id).triage, undefined)
  })
}

for (const [who, session] of Object.entries(EDITORS)) {
  test(`${who} keeps the triage controls`, t => {
    use(t, session)
    const group = [finding({ triage: 'inprogress' }), finding()]
    assert.equal(canEditTriage(group[0]), true)
    assert.deepEqual(controls(group), { comment: false, fix: false, flag: false, color: false, triage: false })
    assert.deepEqual(triageActionPlan(group, 'fixed').targets, group)
    assert.equal(syncGroupTriage(group), true)
  })
}

test('the console triage API refuses where the controls are disabled', async t => {
  use(t, SESSIONS['a public link'])
  const f = finding({ triage: 'inprogress' })
  await assert.rejects(window.DeepView.triage.set(f.id, { triage: 'fixed' }), /read-only/u)
  assert.equal(state.triage.get(f.id).triage, 'inprogress')
  state.managedSession = EDITORS['the Triage role']
  assert.equal(await window.DeepView.triage.set(f.id, { triage: 'fixed' }), true)
  assert.equal(state.triage.get(f.id).triage, 'fixed')
})

test('outside the managed surface a Viewer session does not lock local triage', t => {
  use(t, SESSIONS['the Viewer role'], { localMode: true })
  assert.equal(canEditTriage(finding()), true)
})
