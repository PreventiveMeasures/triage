import assert from 'node:assert/strict'
import { it } from 'node:test'
import { fitCompactGraph } from '../ui/view/graph/fit.js'

it('fits disconnected package circles and labels inside 4% safe zones', () => {
  const nodes = [{ x: 24, y: 24 }, { x: 1200, y: 24 }, { x: 550, y: 760 }]
  for (const [width, height] of [[1586, 700], [600, 900], [320, 260]]) {
    const insets = { left: 62, right: 62, top: 53, bottom: 58, statsHeight: 30 }
    const fit = fitCompactGraph(nodes, width, height, insets)
    const padX = Math.max(20, width * .04), padY = Math.max(20, height * .04)
    for (const n of nodes) {
      const x = n.x * fit.k + fit.tx, y = n.y * fit.k + fit.ty
      assert.ok(x - insets.left >= padX - 1e-8)
      assert.ok(x + insets.right <= width - padX + 1e-8)
      assert.ok(y - insets.top >= padY - 1e-8)
      assert.ok(y + insets.bottom <= height - padY - insets.statsHeight + 1e-8)
    }
  }
})

it('centers a single node and keeps empty fits finite', () => {
  const fit = fitCompactGraph([{ x: 123, y: 456 }], 900, 600, { left: 50, top: 20, bottom: 40, statsHeight: 24 })
  assert.equal(123 * fit.k + fit.tx, 450)
  assert.equal(456 * fit.k + fit.ty, 278)
  assert.deepEqual(fitCompactGraph([], 900, 600, { statsHeight: 24 }), { k: 1, tx: 450, ty: 288 })
})
