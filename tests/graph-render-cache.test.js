import assert from 'node:assert/strict'
import { it } from 'node:test'
import { circleOutside, createRenderCache, edgeGradient, edgeOutside, haloGradient, updateRenderCache } from '../ui/view/graph/render-cache.js'

function fixture() {
  const nodes = [
    { file: 'a', pkg: 'app', x: 1, y: 2 },
    { file: 'b', pkg: 'app', x: -3, y: 4 },
    { file: 'c', pkg: 'dep', x: 5, y: -6 },
    { file: 'd', pkg: 'dep', x: 7, y: 8 },
  ]
  const edges = [{ a: 'a', b: 'b' }, { a: 'b', b: 'c' }, { a: 'a', b: 'missing' }]
  return { nodes, edges, adj: new Map([['a', [0, 2]], ['b', [0, 1]], ['c', [1]]]) }
}

it('resolves endpoints once without changing node or edge painter order', () => {
  const graph = fixture(), snapshot = structuredClone(graph)
  const cache = createRenderCache(graph)
  assert.deepEqual(cache.nodes.map((entry) => entry.node), graph.nodes)
  assert.deepEqual(cache.edges.map((entry) => entry.edge), graph.edges.slice(0, 2))
  assert.equal(cache.edges[0].a, cache.nodes[0])
  assert.equal(cache.edges[0].b, cache.edges[1].a)
  assert.deepEqual(graph, snapshot)
})

it('refreshes geometry, filters, and theme colors without stale cached node state', () => {
  const cache = createRenderCache(fixture())
  const hidden = new Set(), muted = new Set()
  const viewport = { k: 1.4, tx: 20, ty: -15 }
  let colorCalls = 0, dimCalls = 0, palette = 'dark'
  const options = { viewport, selected: null, visible: (n) => !hidden.has(n.file), dimmed: (n) => { dimCalls++; return muted.has(n.file) },
    radius: () => 3.5, color: (pkg) => { colorCalls++; return `${palette}:${pkg}` } }
  updateRenderCache(cache, options)
  assert.equal(colorCalls, 2, 'one color lookup per package, not per node or edge')
  assert.equal(dimCalls, 4, 'one filter evaluation per visible node')
  for (const entry of cache.nodes) {
    assert.equal(entry.x, entry.node.x * viewport.k + viewport.tx)
    assert.equal(entry.y, entry.node.y * viewport.k + viewport.ty)
    assert.equal(entry.color, `dark:${entry.node.pkg}`)
    assert.equal(entry.dimmed, false)
  }
  hidden.add('a'); muted.add('b'); palette = 'light'; viewport.k = 5
  updateRenderCache(cache, options)
  assert.equal(cache.nodes[0].visible, false)
  assert.equal(cache.nodes[1].dimmed, true)
  assert.equal(cache.nodes[1].color, 'light:app')
  assert.equal(cache.nodes[1].x, -3 * 5 + 20)
  hidden.clear(); muted.clear()
  updateRenderCache(cache, options)
  assert.equal(cache.nodes[0].visible, true)
  assert.equal(cache.nodes[0].color, 'light:app')
  assert.equal(cache.nodes[1].dimmed, false)
})

it('matches the original adjacency scan for every selection and clears old neighbors', () => {
  const graph = fixture()
  const cache = createRenderCache(graph)
  const options = { viewport: { k: 1, tx: 0, ty: 0 }, visible: () => true, dimmed: () => false, radius: () => 3.5, color: () => '#fff' }
  for (const selected of ['a', 'b', 'c', 'd', null, 'a']) {
    updateRenderCache(cache, { ...options, selected })
    for (const node of graph.nodes) {
      const wasConnected = (graph.adj.get(selected) ?? []).some((i) => graph.edges[i].a === node.file || graph.edges[i].b === node.file)
      assert.equal(cache.neighbors.has(node.file), wasConnected)
    }
  }
})

it('reuses node paint data for hover/selection and refreshes it when the paint key changes', () => {
  const cache = createRenderCache(fixture())
  let calls = 0
  const options = { viewport: { k: 1, tx: 0, ty: 0 }, selected: null, paintKey: 'initial', visible: () => true,
    dimmed: () => { calls++; return false }, radius: () => 3.5, color: () => '#aabbcc' }
  updateRenderCache(cache, options)
  assert.equal(calls, 4)
  options.selected = 'b'
  updateRenderCache(cache, options)
  assert.equal(calls, 4)
  assert.equal(cache.neighbors.has('c'), true, 'selection still refreshes independently of node paint data')
  options.paintKey = 'new theme/filter'; options.color = () => '#112233'
  updateRenderCache(cache, options)
  assert.equal(calls, 8)
  assert.equal(cache.nodes[0].color, '#112233')
})

it('retains crossing edges and stroke fringes while culling fully offscreen geometry', () => {
  const height = 80, width = 100
  assert.equal(edgeOutside({ x: -100, y: 40 }, { x: 200, y: 40 }, width, height), false)
  assert.equal(edgeOutside({ x: 50, y: -100 }, { x: 50, y: 200 }, width, height), false)
  assert.equal(edgeOutside({ x: -1, y: -100 }, { x: -1, y: 200 }, width, height), false)
  assert.equal(edgeOutside({ x: -3, y: -100 }, { x: -3, y: 200 }, width, height), true)
  assert.equal(circleOutside(-12, 40, 11, width, height), false, 'a halo may contribute even when its dot is outside')
  assert.equal(circleOutside(-14, 40, 11, width, height), true)
  assert.equal(circleOutside(50, 90, 9, width, height), false)
  assert.equal(circleOutside(50, 93, 9, width, height), true)
})

it('evaluates filters per node even for a densely connected selection', () => {
  const count = 26423
  const nodes = Array.from({ length: count }, (_, i) => ({ file: String(i), pkg: 'app', x: i, y: 0 }))
  const edges = nodes.slice(1).map((node) => ({ a: '0', b: node.file }))
  const graph = { nodes, edges, adj: new Map([['0', edges.map((_, i) => i)]]) }
  const cache = createRenderCache(graph)
  let checks = 0
  updateRenderCache(cache, { viewport: { k: 1, tx: 0, ty: 0 }, selected: '0', visible: () => true,
    dimmed: () => { checks++; return false }, radius: () => 3.5, color: () => '#fff' })
  assert.equal(checks, count)
  assert.equal(cache.neighbors.size, count)
})

it('reuses gradient paint objects and refreshes them for geometry, theme, and emphasis changes', () => {
  const cache = createRenderCache(fixture())
  const options = { viewport: { k: 1, tx: 0, ty: 0 }, selected: null, visible: () => true, dimmed: () => false, radius: () => 3.5, color: () => '#aabbcc' }
  const gradient = (...coordinates) => ({ coordinates, stops: [], addColorStop(...stop) { this.stops.push(stop) } })
  const ctx = { createLinearGradient: gradient, createRadialGradient: gradient }
  const alphaHex = (alpha) => Math.round(alpha * 255).toString(16).padStart(2, '0')
  updateRenderCache(cache, options)
  const entry = cache.edges[0], node = cache.nodes[0]
  const halo = haloGradient(node, 12, ctx), line = edgeGradient(entry, cache, .22, ctx, alphaHex)
  assert.deepEqual(line.coordinates, [1, 2, -3, 4])
  assert.deepEqual(line.stops, [[0, '#aabbcc38'], [1, '#aabbcc38']])
  assert.deepEqual(halo.coordinates, [1, 2, 0, 1, 2, 12])
  assert.deepEqual(halo.stops, [[0, '#aabbcc55'], [1, '#aabbcc00']])
  updateRenderCache(cache, options)
  assert.equal(edgeGradient(entry, cache, .22, ctx, alphaHex), line)
  assert.equal(haloGradient(node, 12, ctx), halo)
  assert.notEqual(edgeGradient(entry, cache, .85, ctx, alphaHex), line)
  assert.notEqual(haloGradient(node, 18, ctx), halo)
  options.viewport.tx = 100
  updateRenderCache(cache, options)
  assert.deepEqual(edgeGradient(entry, cache, .22, ctx, alphaHex).coordinates, [101, 2, 97, 4])
  assert.deepEqual(haloGradient(node, 12, ctx).coordinates, [101, 2, 0, 101, 2, 12])
  options.color = () => '#112233'
  updateRenderCache(cache, options)
  assert.deepEqual(edgeGradient(entry, cache, .22, ctx, alphaHex).stops, [[0, '#11223338'], [1, '#11223338']])
  assert.deepEqual(haloGradient(node, 12, ctx).stops, [[0, '#11223355'], [1, '#11223300']])
})
