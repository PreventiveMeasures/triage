import assert from 'node:assert/strict'
import { it } from 'node:test'
import { layoutDependencyLayers } from '../ui/view/graph/layered-layout.js'
import { drawDependencyLayers } from '../ui/view/graph/layered-render.js'

it('renders layer-size circles and package bars with function-based theme colors', () => {
  const layout = layoutDependencyLayers(
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
    drawDependencyLayers(ctx, layout, {
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
