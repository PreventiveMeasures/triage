import assert from 'node:assert/strict'
import { it } from 'node:test'
import { createNodePicker } from '../ui/view/graph/node-picker.js'

function linearPick(nodes, sx, sy, viewport, radius, visible) {
  let best = null, bestD = Infinity
  for (const node of nodes) {
    if (!visible(node)) continue
    const dx = node.x * viewport.k + viewport.tx - sx, dy = node.y * viewport.k + viewport.ty - sy
    const d = dx * dx + dy * dy, r = radius(node) + 6
    if (d < r * r && d < bestD) { best = node; bestD = d }
  }
  return best
}

it('matches the full scan under pan, zoom, varying radii, and hidden packages', () => {
  let seed = 42
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32 }
  const nodes = Array.from({ length: 1200 }, (_, i) => ({ x: random() * 1600 - 800, y: random() * 1600 - 800, isHub: i % 3 === 0, pkg: i % 5 }))
  const pick = createNodePicker(nodes)
  const visible = (node) => node.pkg !== 2
  for (const k of [0.05, 0.6, 1, 1.6, 5, 9.99]) {
    const viewport = { k, tx: -123.5, ty: 401.25 }
    const radius = (node) => (node.isHub ? 4.9 : 3.5) * Math.max(0.6, Math.min(1.6, k))
    for (let i = 0; i < 300; i++) {
      const n = nodes[i], sx = n.x * k + viewport.tx + random() * 24 - 12, sy = n.y * k + viewport.ty + random() * 24 - 12
      assert.equal(pick(sx, sy, viewport, radius({ isHub: true }), radius, visible), linearPick(nodes, sx, sy, viewport, radius, visible))
    }
  }
})

it('preserves original-order ties across cell boundaries and strict hit-radius edges', () => {
  const nodes = [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 1, y: 0 }]
  const pick = createNodePicker(nodes), viewport = { k: 1, tx: 0, ty: 0 }
  const radius = () => 4, visible = () => true
  assert.equal(pick(0, 0, viewport, 4, radius, visible), nodes[0])
  assert.equal(pick(1, 0, viewport, 4, radius, visible), nodes[0])
  assert.equal(pick(11, 0, viewport, 4, radius, visible), null)
  assert.equal(pick(10.999, 0, viewport, 4, radius, visible), nodes[0])
  assert.equal(pick(0, 0, viewport, 4, radius, (node) => node !== nodes[0]), nodes[1])
  assert.equal(pick(0, 0, viewport, 4, radius, () => false), null)
})

it('visits only local candidates in a large layout, and rebuilds after layout changes', () => {
  const nodes = Array.from({ length: 26423 }, (_, i) => ({ x: i % 200 * 10, y: Math.floor(i / 200) * 10 }))
  const viewport = { k: 1, tx: 0, ty: 0 }
  let checks = 0
  const radius = () => 4.9, visible = () => { checks++; return true }
  assert.equal(createNodePicker(nodes)(1000, 800, viewport, 4.9, radius, visible), nodes[16100])
  assert.ok(checks < 100, `only nearby nodes should be tested, got ${checks}`)
  for (const node of nodes) { node.x += 5000; node.y += 5000 }
  const rebuilt = createNodePicker(nodes)
  assert.equal(rebuilt(1000, 800, viewport, 4.9, radius, visible), null)
  assert.equal(rebuilt(6000, 5800, viewport, 4.9, radius, visible), nodes[16100])
})
