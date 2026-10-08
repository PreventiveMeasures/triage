import assert from 'node:assert/strict'
import { test } from 'node:test'
import '../ui/view/frontend-install.js'
import '../ui/view/graph/size-flow.js'
import { buildGraph } from '../ui/view/graph/data.js'
import { graph2 } from '../ui/view/graph/state.js'
import { pkgColor } from '../ui/view/graph/utils.js'
import { graphBackground, textOnPackage } from '../ui/view/graph/colors.js'

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
  const { chart } = host
  chart.render()
  let writes = 0
  function element(dataset = {}, initial = {}) {
    const attributes = new Map(Object.entries(initial))
    const rect = { setAttribute(name, value) { attributes.set(`rect:${name}`, value); writes++ } }
    return { dataset, attributes, querySelector: () => rect, setAttribute(name, value) { attributes.set(name, value); writes++ } }
  }
  const nodes = new Map(host.layout.nodes.map(n => [n.id, element({ flowNode: n.id }, { fill: textOnPackage(pkgColor(n.pkg)), 'rect:fill': pkgColor(n.pkg) })]))
  const edges = new Map(host.layout.edges.map(e => [e.id, element({ flowEdge: e.id }, { fill: pkgColor(host.model.byId.get(e.to).pkg) })]))
  const outline = element()
  const root = { querySelectorAll: selector => [...(selector === '[data-flow-node]' ? nodes : edges).values()], querySelector: () => outline }
  chart.update(root)
  return { host, chart, root, nodes, edges, outline, writes: () => writes }
}

test('hover and selection retain geometry and update only affected highlights', t => {
  const { host, chart, root, nodes, edges, outline, writes } = mounted(t)
  const geometry = chart.render()
  const renderEdge = t.mock.method(chart, 'renderEdge'), renderNode = t.mock.method(chart, 'renderNode')
  const matching = t.mock.method(host, 'matches'), updates = t.mock.method(host, 'requestUpdate')
  const [first, second] = host.model.edges
  const before = writes()
  chart.setHover(first.id)
  assert.equal(edges.get(first.id).attributes.get('opacity'), '0.8')
  chart.setHover(second.id)
  assert.equal(edges.get(first.id).attributes.get('opacity'), '0.22')
  assert.equal(edges.get(second.id).attributes.get('opacity'), '0.8')
  assert.equal(writes() - before, 3, 'hovering touches the previous and next ribbon only')
  assert.equal(updates.mock.callCount(), 0, 'hover never triggers a component rerender')
  host.select('f:a.js'); chart.update(root)
  assert.equal(nodes.get('f:a.js').attributes.get('aria-pressed'), 'true')
  assert.equal(outline.attributes.get('visibility'), 'visible')
  for (const key of ['x', 'y', 'width']) assert.equal(outline.attributes.get(key), String(host.layout.byId.get('f:a.js')[key]))
  chart.setHover(null)
  for (const e of host.model.edges) assert.equal(edges.get(e.id).attributes.get('opacity'), e.from === 'f:a.js' || e.to === 'f:a.js' ? '0.6' : '0.22')
  host.select('f:b.js'); chart.update(root)
  assert.equal(nodes.get('f:a.js').attributes.get('aria-pressed'), 'false')
  assert.equal(nodes.get('f:b.js').attributes.get('aria-pressed'), 'true')
  assert.equal(outline.attributes.get('x'), String(host.layout.byId.get('f:b.js').x))
  assert.equal(chart.render(), geometry)
  assert.equal(renderNode.mock.callCount(), 0)
  assert.equal(renderEdge.mock.callCount(), 0)
  assert.equal(matching.mock.callCount(), 0, 'unchanged filters reuse node matches')
  host.select(null); chart.update(root)
  assert.equal(outline.attributes.get('visibility'), 'hidden')
})

test('filter changes refresh highlights and cached search results without replacing geometry', t => {
  const { host, chart, root, nodes, edges } = mounted(t)
  const geometry = chart.render()
  const matching = t.mock.method(host, 'matches')
  graph2.pathFilter = 'shared'
  const results = chart.searchMatches()
  assert.deepEqual(results.map(n => n.id), ['f:shared.js'])
  assert.equal(chart.searchMatches(), results)
  chart.update(root)
  assert.equal(matching.mock.callCount(), host.model.byId.size, 'evaluate each node once, not once per incident ribbon')
  assert.equal(nodes.get('f:a.js').attributes.get('opacity'), '.15')
  assert.equal(nodes.get('f:shared.js').attributes.get('opacity'), '1')
  for (const e of host.model.edges) assert.equal(edges.get(e.id).attributes.get('opacity'), e.to === 'f:shared.js' ? '0.22' : '0.04')
  assert.equal(chart.render(), geometry)
  graph2.pathFilter = ''
  chart.update(root)
  assert.equal(nodes.get('f:a.js').attributes.get('opacity'), '1')
  assert.equal(chart.searchMatches().length, 4)
})

test('delegated chart actions retain node, edge, and follow-import navigation', t => {
  const { host, chart } = mounted(t)
  const node = { dataset: { flowNode: 'f:a.js' } }
  chart.activate({ target: { closest: () => node } })
  assert.deepEqual(host.selection, { node: 'f:a.js', edge: null })
  const edge = host.model.edges.find(e => e.from === 'f:a.js')
  chart.activate({ target: { closest: () => ({ dataset: { flowEdge: edge.id } }) } })
  assert.deepEqual(host.selection, { node: edge.to, edge: edge.id })
  chart.activate({ target: { closest: () => node } }, true)
  assert.equal(host.focus, 'f:a.js')
  assert.equal(host.needsFit, true)
  const old = chart.render()
  host.willUpdate(new Map())
  assert.notEqual(chart.render(), old, 'new geometry is generated when the focused graph changes')
})

test('hiding Issues ignores saved severity and mark filters while keeping path and Large filters', t => {
  const { chart, host, nodes, root } = mounted(t)
  const colors = graph2.selectedColors, severities = graph2.selectedSeverities
  t.after(() => { graph2.selectedColors = colors; graph2.selectedSeverities = severities })
  graph2.selectedColors = new Set(['red'])
  graph2.selectedSeverities = new Set(['high'])
  Object.assign(host.model.files.get('a.js'), { severitySet: new Set(['high']), colorSet: new Set(['red']) })
  chart.update(root)
  assert.deepEqual(chart.searchMatches().map(n => n.id), ['f:a.js'])
  host.graph.issuesHidden = true
  chart.update(root)
  assert.equal(chart.searchMatches().length, 4)
  assert.ok([...nodes.values()].every(el => el.attributes.get('opacity') === '1'))
  graph2.pathFilter = 'shared'
  assert.deepEqual(chart.searchMatches().map(n => n.id), ['f:shared.js'], 'path filtering remains active with Issues off')
  graph2.pathFilter = ''
  host.largeThreshold = 2000
  assert.equal(chart.searchMatches().length, 0, 'Large filtering remains active with Issues off')
  host.largeThreshold = 0
  host.graph.issuesHidden = false
  chart.update(root)
  assert.deepEqual(chart.searchMatches().map(n => n.id), ['f:a.js'], 'turning Issues on restores the saved filters')
  assert.equal(nodes.get('f:shared.js').attributes.get('opacity'), '.15')
})

test('node descriptions and search order use removal impact rather than reachable size', t => {
  const { chart, host } = mounted(t)
  assert.deepEqual(chart.searchMatches().map(n => n.id), ['f:entry.js', 'f:shared.js', 'f:b.js', 'f:a.js'])
  const template = chart.renderNode(host.layout.byId.get('f:a.js'))
  assert.ok(template.values.includes('a.js\n20 B unique · 1020 B reachable · 20 B own'))
})

test('theme changes repaint retained flow bars and labels with the Layers colors', t => {
  const { chart, edges, host, nodes, root } = mounted(t)
  const originalDocument = globalThis.document
  let theme = ''
  globalThis.document = { body: { classList: { contains: name => name === theme } } }
  t.after(() => { if (originalDocument) globalThis.document = originalDocument; else delete globalThis.document })
  const geometry = chart.render()
  const backgrounds = [['', '#0c0c0c'], ['theme-light', '#f6f8fa'], ['theme-paper', '#fff'], ['theme-pink', '#fff0f7'], ['theme-green', '#0c0c0c']]
  for (const [name, background] of backgrounds) {
    theme = name
    chart.update(root)
    assert.equal(chart.render(), geometry, 'changing colors must not rebuild geometry')
    assert.equal(graphBackground(), background)
    for (const [id, el] of nodes) {
      const color = pkgColor(host.model.byId.get(id).pkg)
      assert.equal(el.attributes.get('rect:fill'), color)
      assert.equal(el.attributes.get('fill'), textOnPackage(color))
    }
    for (const [id, el] of edges) assert.equal(el.attributes.get('fill'), pkgColor(host.model.byId.get(host.model.edgeById.get(id).to).pkg))
  }
  assert.equal(textOnPackage('#e15759'), '#000', 'the red bar in the reported dark-theme example needs dark text')
  assert.equal(textOnPackage('#8a5d40'), '#fff', 'darker bars retain white text')
})

test('small retained connectors explain why they remain under Large', t => {
  const { chart, host } = mounted(t)
  host.largeThreshold = 500; host.willUpdate(new Map())
  const connector = chart.renderNode(host.layout.byId.get('f:a.js'))
  assert.ok(connector.values.some(value => typeof value === 'string' && value.includes('Kept by Large to preserve an entry-point path')))
  const shared = chart.renderNode(host.layout.byId.get('f:shared.js'))
  assert.ok(!shared.values.some(value => typeof value === 'string' && value.includes('Kept by Large')))
  host.toggleLarge(); host.willUpdate(new Map())
  const unfiltered = chart.renderNode(host.layout.byId.get('f:a.js'))
  assert.ok(!unfiltered.values.some(value => typeof value === 'string' && value.includes('Kept by Large')))
})
