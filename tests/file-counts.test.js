import assert from 'node:assert/strict'
import { it } from 'node:test'
import { makeLargeGraph } from '../examples/large-graph-sample.js'
globalThis[Symbol.for('@rray/frontend')] ??= {}
const { computeTransitiveCounts } = await import('../ui/view/file-counts.js')
const { SEVERITIES } = await import('../ui/view/format.js')

function original(tree, counts, files = Object.keys(tree)) {
  return new Map(files.map((file) => {
    const seen = new Set(), stack = (tree[file].imports ?? []).filter((f) => tree[f])
    while (stack.length > 0) {
      const f = stack.pop()
      if (seen.has(f)) continue
      seen.add(f)
      for (const next of tree[f].imports ?? []) if (tree[next]) stack.push(next)
    }
    return [file, Object.fromEntries(SEVERITIES.map((s) => [s, [...seen].reduce((sum, f) => sum + (counts.get(f)?.[s] ?? 0), 0)]))]
  }))
}

it('matches forward reachability with shared dependencies, duplicates, cycles, self imports, and absent files', () => {
  const tree = { app: { imports: ['a', 'b', 'missing'] }, a: { imports: ['leaf', 'leaf'] }, b: { imports: ['leaf'] }, leaf: { imports: ['a'] }, self: { imports: ['self'] }, isolated: {} }
  const counts = new Map([['a', { high: 2 }], ['leaf', { medium: 3 }], ['self', { low: 1 }], ['missing', { critical: 7 }]])
  assert.deepEqual(computeTransitiveCounts(tree, counts), original(tree, counts))
})

it('matches the original counts across random sparse and dense graphs', () => {
  let seed = 129
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32 }
  for (let trial = 0; trial < 80; trial++) {
    const files = Array.from({ length: 40 }, (_, i) => `file${i}`)
    const tree = Object.fromEntries(files.map((file) => [file, { imports: files.filter(() => random() < (trial % 2 ? .03 : .15)) }]))
    const counts = new Map(files.filter(() => random() < .4).map((file) => [file, { high: Math.floor(random() * 5), low: Math.floor(random() * 7) }]))
    assert.deepEqual(computeTransitiveCounts(tree, counts), original(tree, counts))
  }
})

it('handles the 26k-file bundle without recursion or per-file reachability walks', () => {
  const graph = makeLargeGraph()
  const tree = Object.fromEntries([...graph.importsOf].map(([file, imports]) => [file, { imports }]))
  const counts = new Map(graph.nodes.filter((_, i) => i % 61 === 0).map((n) => [n.file, { high: 1 }]))
  const result = computeTransitiveCounts(tree, counts)
  assert.equal(result.size, 26423)
  // Compare representative roots, cycle members, and leaves against the old walk.
  const files = Object.keys(tree).filter((_, i) => i % 2600 === 0)
  const expected = original(tree, counts, files)
  for (const [file, value] of expected) assert.deepEqual(result.get(file), value)
})
