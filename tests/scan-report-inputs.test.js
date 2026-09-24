import assert from 'node:assert/strict'
import { test } from 'node:test'
import './_polyfills.js'
import { appFindingCount, linkableReport, localReportSources, managedReportSources } from '../ui/scan/report-source.js'
import { ReportInputs } from '../ui/scan/report-inputs.js'
import { ScanPage } from '../ui/scan/page.js'
import { bundleOptions } from '../ui/view/bundle-selector.js'

const reportText = (repo, findings = [{ title: 'Finding' }]) => JSON.stringify({ source: 'claude-security', repo: { github: repo }, findings })

test('Link requires an application-layer finding using the report library source and revalidation rules', () => {
  const eligible = [
    { source: 'claude-security', findings: [{ title: 'External' }] },
    { findings: [{ revalidate: 'revalidation' }] },
    { groups: [[{ title: 'Source' }, { revalidate: 'revalidation' }]] },
    { groups: [[{ source: 'codex-security' }]] },
  ]
  const ineligible = [
    { source: 'claude-security', findings: [] },
    { source: 'claude-security', findings: [null, 'not a finding'] },
    { findings: [{ title: 'Source only' }] },
    { findings: [{ isApp: true }] },
    { findings: [{ revalidate: 'verdict' }] },
    { findings: [{ revalidate: 'validation' }] },
    { groups: [[{ title: 'No stamp' }]] },
    { source: 'claude-security', findings: [{ source: 'deepview' }] },
  ]
  for (const data of eligible) assert.ok(linkableReport(JSON.stringify(data)))
  for (const data of ineligible) assert.equal(linkableReport(JSON.stringify(data)), null)
  const sources = localReportSources([...eligible, ...ineligible].map((data, index) => ({ name: `report-${index}`, content: JSON.stringify(data) })), [])
  assert.equal(sources.link.reports.length, eligible.length)
  assert.equal(appFindingCount({ findings: [{ title: 'Source' }, { revalidate: 'revalidation' }, { revalidate: 'verdict' }] }), 1)
  assert.equal(appFindingCount({ source: 'claude-security', groups: [[{ title: 'One' }, { title: 'Duplicate' }], [{ title: 'Two' }]] }), 2)
  assert.equal(sources.link.reports[0].appFindings, 1)
  assert.equal('size' in sources.link.reports[0], false)
})

test('local Link inputs use stored reports and exact workspace memberships, while Merge stays empty', () => {
  const source = localReportSources([
    { name: 'one.json', content: reportText('https://github.com/acme/app.git'), fallbackRepo: 'wrong/repo' },
    { name: 'two.json', content: reportText(null, [{ id: 'two', file: 'src/main.js' }]), fallbackRepo: 'acme/worker' },
    { name: 'unattached.json', content: reportText(null) },
    { name: 'links.json', content: JSON.stringify([{ ids: ['one', 'two'] }]) },
    { name: 'invalid.json', content: '{}' },
  ], [
    { id: 'work-1', name: 'One', privateKey: 'never-copy', reports: ['one.json', 'two.json', 'missing.json', 'links.json'] },
    { id: 'work-2', name: 'Two', reports: ['one.json', 'unattached.json'] },
    { id: 'empty-workspace', name: 'Empty', reports: ['missing.json'] },
  ])
  assert.deepEqual(source.merge, { bundles: [], results: [] })
  assert.deepEqual(source.link.reports.map(report => report.id), ['one.json', 'two.json', 'unattached.json'])
  assert.deepEqual(source.link.repositories, [{ id: 'acme/app', label: 'acme/app' }, { id: 'acme/worker', label: 'acme/worker' }])
  assert.deepEqual(source.link.workspaces, [
    { id: 'work-1', label: 'One', reports: ['one.json', 'two.json'] },
    { id: 'work-2', label: 'Two', reports: ['one.json', 'unattached.json'] },
  ])
})

test('reports without a repository header can name multiple own-code repositories, excluding dependencies', () => {
  const source = localReportSources([{ name: 'many.json', content: reportText(null, [
    { file: 'src/a.js', repo: { github: 'acme/a' } },
    [{ file: 'src/b.js', repo: { github: 'https://github.com/acme/b' } }],
    { file: 'node_modules/dep/a.js', repo: { github: 'vendor/dependency' } },
  ]) }], [])
  assert.deepEqual(source.link.reports[0].repoIds, ['acme/a', 'acme/b'])
})

test('managed Merge results are independent of report visibility; Link contains only visible reports', () => {
  const source = managedReportSources({ reports: [
    { id: 'hidden', repoId: 1, visible: false },
    { id: 'visible', filename: 'saved.json', repoId: 1, repoFullName: 'acme/app', visible: true, byteSize: 1024, content: reportText('acme/app') },
    { id: 'source-only', repoId: 1, visible: true, content: JSON.stringify({ findings: [{ title: 'No revalidation' }] }) },
    { id: 'not-readable', repoId: 1, visible: true },
    { id: 'unassigned', repoId: null, visible: true },
  ], repos: [{ repoId: 1, fullName: 'acme/app' }, { repoId: 2, fullName: 'acme/empty' }] }, {
    bundles: [{ id: 'bundle', filename: 'app.zip', kind: 'sourcemaps' }, { id: 'no-results' }],
    results: [{ id: 'unsaved-result', bundleId: 'bundle', findings: 8 }],
  })
  assert.deepEqual(source.link.reports.map(report => report.id), ['visible'])
  assert.equal(source.link.reports[0].appFindings, 1)
  assert.equal('size' in source.link.reports[0], false)
  assert.deepEqual(source.link.repositories, [{ id: 1, label: 'acme/app' }])
  assert.equal('workspaces' in source.link, false)
  assert.deepEqual(source.merge.results.map(result => result.id), ['unsaved-result'])
  assert.deepEqual(source.merge.bundles.map(bundle => bundle.id), ['bundle'])
  assert.equal(bundleOptions(source.merge.bundles)[0].format, 'sourcemap')
})

function inputs() {
  const component = new ReportInputs()
  component.mode = 'merge'
  component._sources = {
    merge: { bundles: [{ id: 'bundle-1', filename: 'one.stasis' }, { id: 'bundle-2', filename: 'two.stasis' }],
      results: [{ id: 'result-1', bundleId: 'bundle-1' }, { id: 'result-2', bundleId: 'bundle-1' }, { id: 'result-3', bundleId: 'bundle-2' }] },
    link: { repositories: [{ id: 1, label: 'acme/one' }, { id: 2, label: 'acme/two' }],
      workspaces: [{ id: 'workspace-1', label: 'Workspace', reports: ['report-1', 'report-3'] }, { id: 'empty', label: 'Empty', reports: [] }],
      reports: [{ id: 'report-1', repoIds: [1] }, { id: 'report-2', repoIds: [1] }, { id: 'report-3', repoIds: [2] }] },
  }
  return component
}

const selectedIds = component => component.selection.inputs.map(input => input.id)

test('Merge selects all results for the chosen bundle and prevents cross-bundle selection', () => {
  const component = inputs()
  assert.deepEqual(selectedIds(component), [])
  component._selectSource('bundle-1')
  assert.deepEqual(selectedIds(component), ['result-1', 'result-2'])
  component._toggle('result-3', true)
  assert.deepEqual(selectedIds(component), ['result-1', 'result-2'])
  component._toggle('result-1', false)
  component._selectSource('bundle-1')
  assert.deepEqual(selectedIds(component), ['result-2'])
  component._selectSource('missing')
  assert.deepEqual(selectedIds(component), ['result-2'])
  component._selectSource('bundle-2')
  assert.deepEqual(selectedIds(component), ['result-3'])
  component._selectAll(false)
  assert.deepEqual(selectedIds(component), [])
  component._selectAll(true)
  assert.deepEqual(selectedIds(component), ['result-3'])
})

test('Link scopes select all reports, without changing the independent Merge selection', () => {
  const component = inputs()
  component._selectSource('bundle-1')
  component._toggle('result-1', false)
  component.mode = 'link'
  component._changeKind('workspace')
  component._selectSource('workspace-1')
  assert.deepEqual(selectedIds(component), ['report-1', 'report-3'])
  component._toggle('report-2', true)
  assert.deepEqual(selectedIds(component), ['report-1', 'report-3'])
  component._toggle('report-1', false)
  component.mode = 'merge'
  assert.deepEqual(selectedIds(component), ['result-2'])
  component.mode = 'link'
  assert.deepEqual(selectedIds(component), ['report-3'])
  component._changeKind('repository')
  assert.deepEqual(selectedIds(component), [])
  component._selectSource(1)
  assert.deepEqual(selectedIds(component), ['report-1', 'report-2'])
  component._changeKind('workspace')
  component._selectSource('empty')
  assert.deepEqual(selectedIds(component), ['report-1', 'report-3'])
  assert.deepEqual(component._parents.map(parent => parent.id), ['workspace-1'])
})

test('Link auto-selects a sole workspace or repository, without undoing deselection or choosing among multiple scopes', async () => {
  const component = inputs()
  component.mode = 'link'
  component._changeKind('repository')
  assert.equal(component.selection.source, null)
  assert.deepEqual(component._scopeOptions.map(option => option.detail), ['2 reports', '1 report'])
  component._changeKind('workspace')
  assert.equal(component.selection.source.id, 'workspace-1')
  assert.deepEqual(selectedIds(component), ['report-1', 'report-3'])
  component._selectAll(false)
  component._changeKind('workspace')
  assert.deepEqual(selectedIds(component), [])
  component._sources.link.reports = [{ id: 'report-1', repoIds: [1] }]
  component._changeKind('repository')
  assert.equal(component.selection.source.id, 1)
  assert.deepEqual(selectedIds(component), ['report-1'])
  component.loadSources = () => Promise.resolve(component._sources)
  await component._load()
  assert.equal(component.selection.source.id, 'workspace-1')
  assert.deepEqual(selectedIds(component), ['report-1'])
})

test('managed Link rejects workspace scopes and restored inputs stay within their original source', () => {
  const component = inputs()
  component.mode = 'link'
  delete component._sources.link.workspaces
  component._changeKind('workspace')
  assert.equal(component._current.kind, 'repository')
  component.restore = { mode: 'link', source: { kind: 'repository', id: 1 }, inputIds: ['report-2', 'report-3', 'deleted'] }
  component._restore()
  assert.deepEqual(selectedIds(component), ['report-2'])
  component.restore = { mode: 'link', source: { kind: 'repository', id: 99 }, inputIds: ['report-2'] }
  component._restore()
  assert.deepEqual(selectedIds(component), [])
  assert.equal(component.selection.source, null)
})

test('stale report-source loads are ignored and loading/errors cannot submit earlier selections', async () => {
  const component = inputs()
  const source = component._sources
  component._selectSource('bundle-1')
  const pending = []
  component.loadSources = signal => new Promise(resolve => { pending.push({ signal, resolve }) })
  const first = component._load()
  assert.deepEqual(selectedIds(component), [])
  const second = component._load()
  assert.equal(pending[0].signal.aborted, true)
  pending[1].resolve(source)
  await second
  component._selectSource('bundle-2')
  pending[0].resolve({})
  await first
  assert.deepEqual(selectedIds(component), ['result-3'])
  component.loadSources = () => Promise.reject(new Error('unavailable'))
  await component._load()
  assert.deepEqual(selectedIds(component), [])
  assert.match(component._error, /unavailable/u)
})

test('report scan settings retain the exact submode, source, and selected IDs for restart', () => {
  for (const mode of ['merge', 'link']) {
    const page = new ScanPage()
    page._mode = 'report'
    page._reportMode = mode
    page._reportInput = { mode, source: { kind: mode === 'merge' ? 'bundle' : 'workspace', id: 'scope', label: 'Scope' }, inputs: [{ id: 'second' }, { id: 'fourth' }] }
    page._runScan()
    for (const timer of page._timers) clearTimeout(timer)
    const scan = page._scans[0]
    assert.deepEqual(scan.inputIds, ['second', 'fourth'])
    assert.equal(scan.reportMode, mode)
    assert.equal(scan.bundleId, mode === 'merge' ? 'scope' : null)
    page._restartScan(scan)
    assert.deepEqual(page._reportRestore, { mode, source: page._reportInput?.source ?? scan.reportSource, inputIds: ['second', 'fourth'] })
  }
})
