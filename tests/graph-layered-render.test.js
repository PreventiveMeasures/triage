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
