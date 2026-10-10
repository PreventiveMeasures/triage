import assert from 'node:assert/strict'
import { test } from 'node:test'
import { batchedReachability } from '../ui/view/graph/size-flow-reachability.js'
import { buildSizeFlow } from '../ui/view/graph/size-flow-model.js'

function reachable(next, starts, weights, unknown) {
  const seen = new Set(), stack = [...starts]
  let missing = 0, size = 0
  while (stack.length > 0) {
    const id = stack.pop()
    if (seen.has(id)) continue
    seen.add(id); size += weights[id]; missing += unknown[id]
    stack.push(...next[id])
  }
  return { size, missing }
}

test('batched reachability matches independent traversal across word boundaries and arbitrary component order', () => {
  let seed = 123
  const random = max => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % max }
  for (const count of [0, 1, 31, 32, 33, 63, 64, 65, 127, 257]) {
    const order = Array.from({ length: count }, (_, i) => i)
    for (let i = count - 1; i > 0; i--) { const j = random(i + 1); [order[i], order[j]] = [order[j], order[i]] }
    const next = order.map(() => new Set())
    for (let i = 0; i < count - 1; i++) {
      next[order[i]].add(order[i + 1])
      for (let j = 0; j < 4; j++) next[order[i]].add(order[i + 1 + random(count - i - 1)])
    }
    const weights = order.map(() => random(10000))
    const unknown = order.map(() => random(3))
    for (const remaining of [order, order.filter((_, i) => i % 3 === 0)]) {
      for (const [id, total] of batchedReachability(next, order, weights, unknown, remaining)) {
        assert.deepEqual(total, reachable(next, [id], weights, unknown), `${count} components, node ${id}`)
      }
    }
  }
})

test('large overlapping closures retain exact file, package, edge and bundle totals', () => {
  const count = 800
  const next = Array.from({ length: count }, (_, i) => [i + 1, i + 2, i + 53].filter(id => id < count))
  // Condensed cycles and an unreachable component must also be counted once.
  next[45].push(39)
  const weights = next.map((_, i) => i % 13 ? i + 1 : 0)
  const unknown = next.map((_, i) => Number(i % 13 === 0))
  const names = next.map((_, i) => `pkg${Math.floor(i / 20)}/${i}`)
  const graph = {
    nodes: names.map((file, i) => ({ file, pkg: file.split('/')[0], size: unknown[i] ? null : weights[i] })),
    importsOf: new Map(names.map((file, i) => [file, next[i].map(id => names[id])])),
    flowEntries: [{ file: names[0] }, { file: names[10] }],
  }
  graph.nodes.push({ file: 'unreachable', pkg: 'unreachable', size: 1e9 })
  graph.importsOf.set('unreachable', [])
  const index = new Map(names.map((file, i) => [file, i]))
  for (const packages of [false, true]) {
    const model = buildSizeFlow(graph, { packages })
    for (const node of model.byId.values()) {
      assert.deepEqual({ size: node.size, missing: node.missing }, reachable(next, node.files.map(file => index.get(file)), weights, unknown))
    }
    for (const edge of model.edges) {
      assert.deepEqual({ size: edge.size, missing: edge.missing }, reachable(next, [...edge.targets].map(file => index.get(file)), weights, unknown))
    }
    assert.deepEqual(model.total, reachable(next, [0, 10], weights, unknown))
  }
})
