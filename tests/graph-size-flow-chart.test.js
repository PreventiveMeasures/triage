import assert from 'node:assert/strict'
import { test } from 'node:test'
import '../ui/view/frontend-install.js'
import '../ui/view/graph/size-flow.js'
import { buildGraph } from '../ui/view/graph/data.js'
import { graph2 } from '../ui/view/graph/state.js'
import { flowNodeTooltip } from '../ui/view/graph/size-flow-chart.js'

function mounted(t) {
  const previousQuery = graph2.pathFilter
  graph2.pathFilter = ''
  t.after(() => { graph2.pathFilter = previousQuery })
  const tree = {
    'entry.js': { size: 10, imports: ['a.js', 'b.js'] },
    'a.js': { size: 20, imports: ['shared.js'] },
    'b.js': { size: 30, imports: ['shared.js'] },
    'shared.js': { size: 1000, imports: [] },
  }
  const graph = buildGraph(tree, Object.keys(tree), new Map(), null, null, null, null, { pkgOf: () => 'app' })
  graph.flowEntries = [{ file: 'entry.js' }]
  const Flow = customElements.get('size-flow'), host = new Flow()
  host.graph = graph; host.willUpdate(new Map([['graph', null]]))
  return { host, chart: host.chart }
}

test('tooltips show a single version or group installed copies by version with their own sizes', () => {
  const node = { label: 'dep', removable: 5120, size: 8192, own: 5120, filterSize: 5120 }
  assert.match(flowNodeTooltip({ ...node, version: '1.2.3' }, 0), /\nVersion: 1\.2\.3$/u, 'file nodes retain their recorded package version')
  const instances = [{ version: '1.2.3', size: 1024, missing: 0 }, { version: '1.2.3', size: 2048, missing: 0 },
    { version: '2.0.0', size: 2048, missing: 0 }, { version: undefined, size: 0, missing: 1 }]
  assert.match(flowNodeTooltip({ ...node, instances: instances.slice(0, 1) }, 0), /\nVersion: 1\.2\.3$/u)
  const tooltip = flowNodeTooltip({ ...node, instances }, 0)
  assert.match(tooltip, /Versions · own source size\n1\.2\.3 · 3\.0 KiB · 2 copies\n2\.0\.0 · 2\.0 KiB · 1 copy\nUnknown version · 0 B\+ · 1 copy/u)
  assert.equal(tooltip.split('1.2.3').length - 1, 1, 'repeated versions are grouped only in the tooltip')
})

test('filter changes refresh dimming and cached search results', t => {
  const { host, chart } = mounted(t)
  const matching = t.mock.method(host, 'matchesNode')
  graph2.pathFilter = 'shared'
  const results = chart.searchMatches()
  assert.deepEqual(results.map(n => n.id), ['f:shared.js'])
  assert.equal(chart.searchMatches(), results)
  assert.equal(matching.mock.callCount(), host.model.byId.size, 'evaluate each node once, not once per incident ribbon')
  for (const e of host.model.edges) assert.equal(chart.edgeAlpha(e), e.to === 'f:shared.js' ? .22 : .04)
  graph2.pathFilter = ''
  assert.equal(chart.searchMatches().length, 4)
  for (const e of host.model.edges) assert.equal(chart.edgeAlpha(e), .22)
})
test('hiding Issues ignores saved severity and mark filters while keeping path and Large filters', t => {
  const { chart, host } = mounted(t)
  const colors = graph2.selectedColors, severities = graph2.selectedSeverities
  t.after(() => { graph2.selectedColors = colors; graph2.selectedSeverities = severities })
  graph2.selectedColors = new Set(['red'])
  graph2.selectedSeverities = new Set(['high'])
  Object.assign(host.model.files.get('a.js'), { severitySet: new Set(['high']), colorSet: new Set(['red']) })
  assert.deepEqual(chart.searchMatches().map(n => n.id), ['f:a.js'])
  host.graph.issuesHidden = true
  assert.equal(chart.searchMatches().length, 4)
  graph2.pathFilter = 'shared'
  assert.deepEqual(chart.searchMatches().map(n => n.id), ['f:shared.js'], 'path filtering remains active with Issues off')
  graph2.pathFilter = ''
  host.largeThreshold = 2000
  assert.equal(chart.searchMatches().length, 0, 'Large filtering remains active with Issues off')
  host.largeThreshold = 0
  host.graph.issuesHidden = false
  assert.deepEqual(chart.searchMatches().map(n => n.id), ['f:a.js'], 'turning Issues on restores the saved filters')
  assert.equal(chart.matchingNodes().has('f:shared.js'), false)
})
test('node descriptions and search order use removal impact rather than reachable size', t => {
  const { chart, host } = mounted(t)
  assert.deepEqual(chart.searchMatches().map(n => n.id), ['f:entry.js', 'f:shared.js', 'f:b.js', 'f:a.js'])
  assert.ok(flowNodeTooltip(host.layout.byId.get('f:a.js'), host.minSize).startsWith('a.js\n20 B unique · 1020 B reachable · 20 B own'))
})

test('small retained connectors explain why they remain under Large', t => {
  const { host } = mounted(t)
  const tooltip = id => flowNodeTooltip(host.layout.byId.get(id), host.minSize)
  host.largeThreshold = 500; host.willUpdate(new Map())
  assert.match(tooltip('f:a.js'), /Kept by Large to preserve an entry-point path/u)
  assert.doesNotMatch(tooltip('f:shared.js'), /Kept by Large/u)
  host.toggleLarge(); host.willUpdate(new Map())
  assert.doesNotMatch(tooltip('f:a.js'), /Kept by Large/u)
})
