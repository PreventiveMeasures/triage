import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { layoutDependencyLayers } from '../ui/view/graph/layered-layout.js'

function layout(sizes, imports, roots = ['app']) {
  return layoutDependencyLayers(Object.entries(sizes).map(([id, size]) => ({ id, size })), new Map(Object.entries(imports)), roots, { width: 600 })
}

describe('dependency layers', () => {
  it('places the app first and uses shortest directed paths, including cycles', () => {
    const result = layout({ app: 12, a: 30, b: 60, c: 25, reverse: 1, isolated: 4 }, {
      app: ['a', 'c'], a: ['b'], b: ['c'], c: ['a', 'app'], reverse: ['app'],
    })
    assert.deepEqual([...result.depth], [['app', 0], ['a', 1], ['c', 1], ['b', 2]])
    assert.deepEqual(result.levels.map((r) => r.level), [0, 1, 2, null])
    assert.deepEqual(result.levels.at(-1).ids, ['isolated', 'reverse'])
    assert.equal(result.edges.length, 7)
  })

  it('allocates exact byte proportions within each row, with a connection gap', () => {
    const result = layout({ app: 10, big: 300, small: 100, tiny: 0.01 }, { app: ['big', 'small', 'tiny'] })
    const { rects } = result
    assert.equal(rects.get('app').width, 600)
    assert.equal(rects.get('big').width / rects.get('small').width, 3)
    assert.ok(rects.get('tiny').width < 0.02)
    assert.ok(Math.abs(result.levels[1].ids.reduce((n, id) => n + rects.get(id).width, 0) - 600) < 1e-9)
    assert.equal(rects.get('big').y - rects.get('app').height, result.gap)
    for (const e of result.edges) {
      assert.ok(e.sourcePort > 0 && e.sourcePort < 1)
      assert.ok(e.targetPort > 0 && e.targetPort < 1)
    }
    assert.equal(new Set(result.edges.map((e) => e.sourcePort)).size, 3)
  })

  it('does not invent reachability when roots or imports are unavailable', () => {
    assert.deepEqual(layout({ a: 10, b: 20 }, { a: ['b'] }).levels.map((r) => r.level), [null])
    assert.deepEqual(layout({ app: 10, b: 20 }, {}).levels.map((r) => r.level), [0, null])
    const empty = layout({}, {})
    assert.equal(empty.height, 0)
    assert.equal(empty.rects.size, 0)
  })

  it('moves only the largest dependency to the left of each row', () => {
    const result = layout({ app: 10, a: 20, b: 50, z: 100, p: 2, q: 8, x: 1, y: 3 }, {
      app: ['a', 'b', 'z'], z: ['p', 'q'],
    })
    assert.deepEqual(result.levels.map((r) => r.ids), [['app'], ['z', 'a', 'b'], ['q', 'p'], ['y', 'x']])
    for (const row of result.levels) assert.equal(result.rects.get(row.ids[0]).x, 0)
    const tied = layout({ app: 1, a: 2, b: 5, c: 5 }, { app: ['c', 'b', 'a'] })
    assert.deepEqual(tied.levels[1].ids, ['b', 'a', 'c'])
  })

  it('reports each level’s share of total bytes, including unreached packages', () => {
    const result = layout({ app: 100, a: 200, b: 100, isolated: 100 }, { app: ['a', 'b'] })
    assert.equal(result.totalSize, 500)
    assert.deepEqual(result.levels.map((r) => r.share), [0.2, 0.6, 0.2])
    assert.equal(layout({ app: null }, {}).levels[0].share, null)
  })

  it('keeps zero-byte nodes at zero area and explicitly marks equal-width fallback rows', () => {
    const mixed = layout({ app: 1, empty: 0, real: 2 }, { app: ['empty', 'real'] })
    assert.equal(mixed.rects.get('empty').width, 0)
    assert.equal(mixed.rects.get('real').width, 600)
    const missing = layout({ app: 0, a: null, b: NaN, c: -10 }, { app: ['a', 'b', 'c'] })
    assert.equal(missing.levels[1].proportional, false)
    assert.deepEqual(missing.levels[1].ids.map((id) => missing.rects.get(id).width), [200, 200, 200])
  })

  it('deduplicates imports, ignores missing targets/self-edges, and works with file ids', () => {
    const result = layout({ 'src/index.js': 12, 'src/util.js': 8 }, {
      'src/index.js': ['src/util.js', 'src/util.js', 'external', 'src/index.js'],
      external: ['src/util.js'],
    }, ['src/index.js', 'src/index.js'])
    assert.equal(result.depth.get('src/util.js'), 1)
    assert.equal(result.edges.length, 1)
  })

  it('is deterministic without mutating input nodes or imports', () => {
    const nodes = [{ id: 'app', size: 10 }, { id: 'z', size: 4 }, { id: 'a', size: 2 }]
    const imports = new Map([['app', ['z', 'a']]])
    const before = structuredClone({ nodes, imports })
    const a = layoutDependencyLayers(nodes, imports, ['app'])
    const b = layoutDependencyLayers(nodes.toReversed(), new Map([['app', ['a', 'z']]]), ['app'])
    assert.deepEqual(a.rects, b.rects)
    assert.deepEqual(a.edges, b.edges)
    assert.deepEqual({ nodes, imports }, before)
  })
})
