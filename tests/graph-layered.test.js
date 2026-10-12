import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { layoutDependencyLayers } from '../ui/view/graph/layered-layout.js'
import { drawDependencyLayers } from '../ui/view/graph/layered-render.js'

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

describe('layered render', () => {
  it('renders layer-size circles and package bars with function-based theme colors', () => {
    const layered = layoutDependencyLayers(
      [{ id: 'app', size: 100 }, { id: 'dep', size: 300 }],
      new Map([['app', ['dep']]]), ['app'],
    )
    for (const rgb of ['180, 195, 215', '50, 70, 100']) {
      const fills = [], labels = [], strokes = []
      const ctx = {
        save() {}, restore() {}, beginPath() {}, closePath() {},
        moveTo() {}, lineTo() {}, bezierCurveTo() {},
        arc() {}, rect() {}, clip() {}, fill() {}, strokeRect() {},
        stroke() { strokes.push(this.strokeStyle) },
        fillRect(...rect) { fills.push(rect) },
        fillText(label) { labels.push(label) },
      }
      drawDependencyLayers(ctx, layered, {
        theme: {
          bg: '#0c0c0c', labelDefault: '#cccccc', selectRing: '#ffffff',
          edgeIntra: (alpha) => `rgba(${rgb}, ${alpha})`,
        },
        scale: 1, colorOf: () => '#8899aa', labelOf: (id) => id,
        sizeLabel: String, dimmed: () => false,
        selected: null, hovered: null,
      })
      assert.equal(strokes.filter((color) => color === `rgba(${rgb}, 0.16)`).length, 2)
      assert.equal(fills.length, 2, 'drawing reaches both package bars after the circles')
      for (const label of ['25%', '75%', 'app', 'dep']) assert.ok(labels.includes(label))
    }
  })

  it('omits vertical separators that would cover more than half a bar after zoom', () => {
    for (const scale of [0.25, 1, 4]) {
      const boxes = [], clips = [], strokes = []
      let path = []
      const ctx = {
        save() {}, restore() {}, beginPath() { path = [] },
        rect(...rect) { path.push(rect) }, clip() { clips.push(path) },
        moveTo(...point) { path.push(point) }, lineTo(...point) { path.push(point) },
        stroke() { strokes.push(path) }, strokeRect(...rect) { boxes.push({ rect, clip: clips.at(-1), width: this.lineWidth, color: this.strokeStyle }) },
        fillRect() {}, fillText() {},
      }
      const widths = [0.5, 1.99, 2, 8]
      const rects = new Map(widths.map((width, i) => [String(i), { id: String(i), x: i * 10 / scale, y: 0, width: width / scale, height: 26 }]))
      drawDependencyLayers(ctx, { edges: [], levels: [], rects }, {
        theme: { bg: '#0c0c0c', selectRing: '#fff', edgeIntra: () => '#333' }, scale,
        colorOf: () => '#e15759', labelOf: String, sizeLabel: String, dimmed: () => false, selected: '0', hovered: null,
      })
      const separators = boxes.filter(box => box.color === '#0c0c0c')
      assert.deepEqual(separators.map(box => box.rect[2] * scale), [2, 8], 'verticals start at the exact half-width boundary')
      assert.equal(strokes.length, 2, 'thin bars retain only their horizontal separators')
      for (const pathPoints of strokes) {
        assert.equal(pathPoints[0][1], pathPoints[1][1])
        assert.equal(pathPoints[2][1], pathPoints[3][1])
      }
      for (const box of separators) assert.deepEqual(box.clip, [box.rect], 'each separator is clipped to its own bar')
      const selected = boxes.find(box => box.color === '#fff')
      assert.ok(selected.width <= rects.get('0').width / 4, 'the two inset selection strokes leave the center of a thin bar visible')
    }
  })
})
