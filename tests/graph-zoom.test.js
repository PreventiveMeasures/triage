import assert from 'node:assert/strict'
import { it } from 'node:test'
import { graphZoomMetrics } from '../ui/view/graph/zoom.js'

it('uses fit as 100% for small and large dependency graphs, with a consistent zoom range', () => {
  for (const fit of [.44, 1.16, 2.34, 4]) {
    const initial = graphZoomMetrics(fit, fit, true)
    assert.equal(initial.percent, 100)
    assert.equal(initial.min, fit)
    assert.equal(graphZoomMetrics(fit * 1.4, fit, true).percent, 140)
    assert.equal(graphZoomMetrics(initial.max, fit, true).percent, 999)
    const zoomed = Math.max(initial.min, Math.min(initial.max, fit * 1.4))
    const back = Math.max(initial.min, Math.min(initial.max, zoomed / 1.4))
    assert.equal(graphZoomMetrics(back, fit, true).percent, 100)
    assert.equal(Math.max(initial.min, fit / 1.4), fit, 'cannot zoom out past the fitted safe area')
  }
})

it('preserves the original scale reference in the existing graph modes', () => {
  assert.deepEqual(graphZoomMetrics(1.16, 1.16), { min: 1.16, max: 9.99, percent: 116 })
  assert.deepEqual(graphZoomMetrics(.44, .44), { min: .44, max: 9.99, percent: 44 })
})
