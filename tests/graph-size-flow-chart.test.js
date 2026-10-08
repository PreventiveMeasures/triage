import assert from 'node:assert/strict'
import { test } from 'node:test'
import '../ui/view/frontend-install.js'
import '../ui/view/graph/size-flow.js'
import { buildGraph } from '../ui/view/graph/data.js'
import { graph2 } from '../ui/view/graph/state.js'

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
  function element(dataset = {}) {
    const attributes = new Map()
    const rect = { setAttribute(name, value) { attributes.set(`rect:${name}`, value); writes++ } }
    return { dataset, attributes, querySelector: () => rect, setAttribute(name, value) { attributes.set(name, value); writes++ } }
  }
  const nodes = new Map(host.layout.nodes.map(n => [n.id, element({ flowNode: n.id })]))
  const edges = new Map(host.layout.edges.map(e => [e.id, element({ flowEdge: e.id })]))
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

test('node descriptions and search order use removal impact rather than reachable size', t => {
  const { chart, host } = mounted(t)
  assert.deepEqual(chart.searchMatches().map(n => n.id), ['f:entry.js', 'f:shared.js', 'f:b.js', 'f:a.js'])
  const template = chart.renderNode(host.layout.byId.get('f:a.js'))
  assert.ok(template.values.includes('a.js\n20 B removed if deleted · 1020 B reachable · 20 B own'))
})
