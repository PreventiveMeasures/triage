import assert from 'node:assert/strict'
import { it } from 'node:test'
import { outsideDamage, panDamage } from '../ui/view/graph/pan-damage.js'

it('redraws the exposed strips for each pan direction, including diagonal overlap', () => {
  const previous = { key: 'same', tx: 20, ty: 30 }
  for (const [dx, dy] of [[10, 0], [-10, 0], [0, 12], [0, -12], [10, 12], [-10, -12]]) {
    const damage = panDamage(previous, { key: 'same', tx: 20 + dx, ty: 30 + dy }, 100, 80, 2)
    assert.equal(damage.dx, dx * 2)
    assert.equal(damage.dy, dy * 2)
    for (let x = .5; x < 100; x++) {
      for (let y = .5; y < 80; y++) {
        const exposed = dx > 0 && x < dx + 2 || dx < 0 && x >= 100 + dx - 2
          || dy > 0 && y < dy + 2 || dy < 0 && y >= 80 + dy - 2
        assert.equal(!outsideDamage(damage, x, y, x, y), exposed)
      }
    }
  }
})

it('only reuses exact device-pixel translations with unchanged paint state', () => {
  const previous = { key: 'same', tx: 20, ty: 30 }
  for (const next of [
    previous, { ...previous, tx: 20.25 }, { ...previous, ty: 110 },
    { ...previous, tx: 120 }, { ...previous, tx: 21, key: 'changed' },
  ]) assert.equal(panDamage(previous, next, 100, 80, 2), null)
  assert.equal(panDamage(null, previous, 100, 80, 2), null)
  assert.equal(panDamage(previous, { ...previous, tx: 20.5 }, 100, 80, 2), null)
  assert.ok(!outsideDamage(null, 0, 0, 1, 1), 'full repaint does not cull on damage bounds')
})
