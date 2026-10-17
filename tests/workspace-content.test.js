import assert from 'node:assert/strict'
import { test } from 'node:test'
import { filesButtonTemplate, renderWorkspaceContent, teamHeaderTemplate, triageLoadingTemplate, workspaceContent, workspaceContentButton, workspaceTitleTemplate } from '../ui/view/workspace-content.js'
import { templateText as text } from './_lit.js'

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

test('report and bundle lists have no Files button, which a report keeps', () => {
  const workspace = { scope: 'workspace', title: 'Workspace: App', reports: [], bundles: [] }
  const team = { ...workspace, scope: 'team', title: 'Team: App', findings: 3, repositories: [] }
  for (const context of [workspace, team]) {
    for (const kind of ['reports', 'bundles']) assert.doesNotMatch(text(renderWorkspaceContent(context, kind)), /toggle-files|files</u)
  }
  assert.match(text(filesButtonTemplate(3, 'files')), /aria-pressed=true>3 files/u)
  assert.equal(text(filesButtonTemplate(1, 'findings')), '')
})

test('a team names its linked repositories, with their paths, reports and bundles, opening code where the reader may browse it', () => {
  const team = { id: 'a', name: 'First',
    repos: [{ repoId: 2, fullName: 'o/api', path: 'packages/a' }, { repoId: 2, fullName: 'o/api', path: 'packages/b' }, { repoId: 1, fullName: 'o/web', path: null }, { repoId: 3, fullName: 'o/empty', path: null }],
    reports: [{ id: 'r1', filename: 'a.json', repoFullName: 'o/api' }, { id: 'r2', filename: 'b.json', repoFullName: 'o/api', visible: false },
      { id: 'links', filename: 'links.json', analyzer: 'links', repoFullName: 'o/web' }, { id: 'r3', filename: 'c.json', repoFullName: 'o/elsewhere' }],
    bundles: [{ id: 'b1', filename: 'web.stasis', repoId: 1, repoFullName: 'o/web' }] }
  const read = role => workspaceContent({ currentWorkspace: 'managed-team:a', currentManagedTeam: 'a', managedTeams: [team], managedSession: role && { id: 's', role } }, [])
  const context = read('manage')
  assert.deepEqual(context.repositories.map(r => [r.name, r.paths, r.reports, r.bundles, r.available]), [
    ['o/api', ['packages/a', 'packages/b'], 2, 0, true], ['o/web', [], 0, 1, true], ['o/empty', [], 0, 0, true],
  ])
  const list = text(renderWorkspaceContent(context, 'repositories'))
  assert.match(list, /data-workspace-repository=2[\s\S]*data-repository-path=>[\s\S]*o\/api[\s\S]*packages\/a, packages\/b[\s\S]*2 reports/u)
  assert.match(list, /data-workspace-repository=1\s+data-repository-name=o\/web data-repository-path=>/u)
  assert.match(list, /1 bundle</u)
  // Any team member opens them: the server reads only what their grants
  // reach and their own GitHub account may read.
  for (const role of ['view', 'triage', 'admin']) {
    assert.match(text(renderWorkspaceContent(read(role), 'repositories')), /data-workspace-repository=1\s+data-repository-name=o\/web/u, role)
  }
  for (const role of ['none', null]) {
    const shown = text(renderWorkspaceContent(read(role), 'repositories'))
    assert.doesNotMatch(shown, /data-workspace-repository|<button type="button" class="workspace-content-row"/u, `${role}: listed, not opened`)
    assert.match(shown, /o\/empty/u)
  }
  assert.deepEqual(read('view').repositories.map(r => r.available), [true, true, true])
  assert.equal(workspaceContent({ currentWorkspace: 'managed-team:a', currentManagedTeam: 'a', managedSession: { id: 's', role: 'admin', publicShare: true },
    managedTeams: [team] }, []).repositories.some(r => r.available), false, 'a public share opens no code')
  assert.match(text(renderWorkspaceContent(workspaceContent({ currentWorkspace: 'managed-team:a', currentManagedTeam: 'a', managedTeams: [{ id: 'a', name: 'None' }] }, []), 'repositories')),
    /No repositories in this team/u)
})

test("a team's header is its title, its findings' bar and its tabs, each counting in a bubble", () => {
  const context = { scope: 'team', title: 'Team: triage.space', findings: 40, reports: [{}, {}], bundles: [{}],
    repositories: ['o/a', 'o/b', 'o/c'].map((name, repoId) => ({ repoId, name, paths: [], reports: 0, bundles: 0, available: false })) }
  const header = text(teamHeaderTemplate(context, 'findings', { findings: 224, statusBar: 'BAR' }))
  assert.match(header, /<bundle-slide-header[^>]*><header class="bundles-slide-bar team-slide-bar">/u)
  assert.match(header, /<h1 class="team-slide-name"[^>]*>Team: triage.space<\/h1>\s*BAR\s*<div class="bundles-slide-tabs" role="tablist"/u)
  const tabs = [...header.matchAll(/aria-selected=(true|false)\s+data-action=workspace-(\w+)>(\w+)<span class="n">(\d+)<\/span>/gu)].map(m => [m[2], m[3], m[4], m[1]])
  assert.deepEqual(tabs, [['findings', 'Findings', '224', 'true'], ['reports', 'Reports', '2', 'false'], ['bundles', 'Bundles', '1', 'false'], ['repositories', 'Repositories', '3', 'false']])
  assert.doesNotMatch(header, /repo-chip|toggle-files/u)
  // Files is its findings' tab too; lists count the team's findings as its catalog does.
  assert.match(text(teamHeaderTemplate(context, 'files')), /aria-selected=true\s+data-action=workspace-findings>Findings<span class="n">40</u)
  const list = text(renderWorkspaceContent(context, 'repositories'))
  assert.match(list, /aria-selected=true\s+data-action=workspace-repositories>Repositories<span class="n">3</u)
  assert.match(list, /data-action=workspace-findings>Findings<span class="n">40</u)
  assert.doesNotMatch(text(teamHeaderTemplate({ ...context, findings: null }, 'workspace-reports')), /Findings<span/u, 'an unknown count shows none')
  assert.doesNotMatch(header, /workspace-dependencies/u, 'its dependencies only where its reader reviews them in it')
  assert.match(text(renderWorkspaceContent(context, 'dependencies')), /You review no dependencies in this team\./u)
  const reviewing = text(renderWorkspaceContent({ ...context, dependencyReview: true }, 'dependencies'))
  assert.match(reviewing, /data-action=workspace-repositories>Repositories<span class="n">3<\/span><\/button><button[^>]*aria-selected=true\s+data-action=workspace-dependencies>Dependencies<\/button>/u,
    'after its repositories, counting none')
  assert.match(reviewing, /<team-dependencies/u)
  assert.equal(workspaceContent({ currentWorkspace: 'managed-team:a', currentManagedTeam: 'a', managedTeams: [{ id: 'a', name: 'A', dependencyReview: true }] }, []).dependencyReview, true)
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

test("a team's triage loads under its header, Findings selected, as its findings will show it; a report's shows the status alone", () => {
  const team = { id: 'a', name: 'First', app: { appMode: false, findings: 7 }, repos: [{ repoId: 1, fullName: 'o/a', path: null }],
    reports: [{ id: 'r1', filename: 'a.json', repoFullName: 'o/a' }], bundles: [] }
  const context = workspaceContent({ currentWorkspace: 'managed-team:a', currentManagedTeam: 'a', managedTeams: [team] }, [])
  const loading = text(triageLoadingTemplate(context))
  // The header the list shows, but for the tab selected, so moving between
  // them changes nothing else.
  const list = text(renderWorkspaceContent(context, 'reports'))
  const header = list.slice(list.indexOf('<bundle-slide-header'), list.indexOf('</bundle-slide-header>'))
  assert.equal(loading.slice(0, header.length).replace('aria-selected=true', 'aria-selected=false'), header.replace('aria-selected=true', 'aria-selected=false'))
  assert.match(loading, /aria-selected=true\s+data-action=workspace-findings>Findings<span class="n">7</u)
  assert.match(loading, /<\/bundle-slide-header><p class="triage-loading" role="status">Loading report triage…<\/p>$/u)
  for (const none of [null, { scope: 'workspace', title: 'Workspace: App', reports: [], bundles: [] }]) {
    assert.equal(text(triageLoadingTemplate(none)), '<p class="triage-loading" role="status">Loading report triage…</p>')
  }
})
