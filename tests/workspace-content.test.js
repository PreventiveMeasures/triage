import assert from 'node:assert/strict'
import { test } from 'node:test'
import { renderWorkspaceContent, workspaceContent, workspaceContentButton, workspaceTitleTemplate } from '../ui/view/workspace-content.js'

function text(value) {
  if (value == null || typeof value === 'symbol') return ''
  if (Array.isArray(value)) return value.map(text).join('')
  if (value.strings) return value.strings.reduce((s, part, i) => s + part + text(value.values[i]), '')
  return String(value)
}

test('workspace bundle count and list share membership, including unavailable bundles', () => {
  const bundles = [{ integrity: 'one', name: 'one.stasis', size: 123, kind: 'stasis' }, { integrity: 'other', name: 'unrelated.map' }]
  const state = { currentWorkspace: 'w', currentManagedTeam: null, bundles }
  const context = workspaceContent(state, [{ id: 'w', name: 'App', bundles: ['missing', 'one', 'one'] }])
  assert.deepEqual(context.bundles.map(b => [b.integrity, b.available]), [['missing', false], ['one', true]])
  assert.match(text(workspaceContentButton(context, 'bundles')), /2 bundles/u)
  const list = text(renderWorkspaceContent(context, 'bundles'))
  assert.match(list, /one.stasis/u)
  assert.match(list, /Not available locally/u)
  assert.doesNotMatch(list, /unrelated.map/u)
  assert.equal(workspaceContent({ ...state, currentWorkspace: 'gone' }, []), null)
})

test('team bundle lists follow only their current catalog and preserve hidden status', () => {
  const state = { currentWorkspace: 'managed-team:a', currentManagedTeam: 'a', bundles: [{ name: 'local' }], managedTeams: [
    { id: 'a', name: 'First', bundles: [{ id: 'shared', filename: 'shared.stasis', visible: false, byteSize: 100 }] },
    { id: 'b', name: 'Second', bundles: [{ id: 'foreign', filename: 'foreign.map' }] },
  ] }
  const context = workspaceContent(state, [])
  assert.deepEqual(context.bundles.map(b => b.managedId), ['shared'])
  assert.match(text(workspaceContentButton(context, 'bundles')), /1 bundle</u)
  const list = text(renderWorkspaceContent(context, 'bundles'))
  assert.match(list, /workspace-content-hidden/u)
  assert.match(list, /Hidden/u)
  assert.doesNotMatch(list, /foreign.map/u)
  state.managedTeams[0].bundles = []
  assert.doesNotMatch(text(workspaceContentButton(workspaceContent(state, []), 'bundles')), /button/u)
  state.managedTeams = []
  assert.equal(workspaceContent(state, []), null)
})

test('workspace titles navigate from Files and bundle lists but are plain text in findings', () => {
  const context = { title: 'Workspace: App' }
  assert.equal(workspaceTitleTemplate(context, 'findings'), context.title)
  for (const view of ['files', 'workspace-reports', 'workspace-bundles']) {
    assert.match(text(workspaceTitleTemplate(context, view)), /data-action="workspace-findings"/u)
  }
})

test('report lists match workspace membership and expose missing local files without opening them', () => {
  const state = { currentWorkspace: 'w', currentManagedTeam: null, bundles: [], storedFiles: ['local.json', 'unrelated.json'] }
  const context = workspaceContent(state, [{ id: 'w', name: 'App', reports: ['local.json', 'missing.json', 'local.json', 'links.json'] }], name => name === 'links.json' ? 'links' : null)
  assert.deepEqual(context.reports.map(report => [report.name, report.available]), [['local.json', true], ['missing.json', false]])
  assert.match(text(workspaceContentButton(context, 'reports')), /2 reports/u)
  const list = text(renderWorkspaceContent(context, 'reports'))
  assert.match(list, /data-workspace-report=local.json/u)
  assert.match(list, /Not available locally/u)
  assert.doesNotMatch(list, /unrelated.json/u)
  assert.doesNotMatch(list, /links.json/u)
})

test('team reports include hidden individual previews from the current accessible catalog', () => {
  const state = { currentWorkspace: 'managed-team:a', currentManagedTeam: 'a', managedTeams: [
    { id: 'a', name: 'First', reports: [{ id: 'r1', filename: 'public.json' }, { id: 'r2', filename: 'preview.json', visible: false }, { id: 'links', filename: 'links.json', analyzer: 'links' }] },
    { id: 'b', name: 'Second', reports: [{ id: 'r3', filename: 'foreign.json' }] },
  ] }
  const context = workspaceContent(state, [])
  assert.deepEqual(context.reports.map(report => report.managedId), ['r1', 'r2'])
  const list = text(renderWorkspaceContent(context, 'reports'))
  assert.match(list, /workspace-content-hidden/u)
  assert.match(list, /data-workspace-report=r2/u)
  assert.doesNotMatch(list, /foreign.json/u)
  assert.match(text(workspaceContentButton(context, 'reports', 'workspace-reports')), /aria-pressed=true/u)
  assert.match(text(workspaceContentButton(context, 'reports', 'findings')), /aria-pressed=false/u)
})
