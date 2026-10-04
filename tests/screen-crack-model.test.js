import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createCrackModel } from '../ui/view/screen-crack-model.js'

function area(points) {
  return Math.abs(points.reduce((sum, point, i) => {
    const next = points[(i + 1) % points.length]
    return sum + point.x * next.y - point.y * next.x
  }, 0)) / 2
}

function contains(points, x, y) {
  let inside = false
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i], b = points[j]
    if ((a.y > y) !== (b.y > y) && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x) inside = !inside
  }
  return inside
}

function assertFallsBelow(piece, height, description) {
  // Verify all possible rotations, beyond the randomly chosen one.
  for (let degrees = -180; degrees <= 180; degrees += 15) {
    const angle = degrees * Math.PI / 180
    for (const point of piece.points) {
      const y = piece.center.y + piece.dy +
        (point.x - piece.center.x) * Math.sin(angle) + (point.y - piece.center.y) * Math.cos(angle)
      assert.ok(y >= height + 39.9, `${description}: shard must clear the bottom`)
    }
  }
}

test('the glass tiles wide and tall viewports without overlaps, gaps, or out-of-bounds shards', () => {
  for (const [width, height] of [[1920, 1080], [640, 360], [390, 844], [2560, 1440], [3440, 1440], [200, 100]]) {
    for (let seed = 1; seed <= 12; seed++) {
      const { pieces } = createCrackModel(width, height, seed)
      assert.ok(pieces.length > 20)
      let totalArea = 0
      for (const { points } of pieces) {
        totalArea += area(points)
        for (const { x, y } of points) assert.ok(x >= 0 && x <= width && y >= 0 && y <= height)
      }
      assert.ok(Math.abs(totalArea - width * height) < width * height * 1e-9, `${width}×${height}, seed ${seed}: tiled area`)
      for (let i = 0; i < 24; i++) {
        for (let j = 0; j < 18; j++) {
          const x = (i + .37) / 24 * width, y = (j + .63) / 18 * height
          assert.equal(pieces.filter(({ points }) => contains(points, x, y)).length, 1,
            `${width}×${height}, seed ${seed}: ${x},${y} belongs to exactly one shard`)
        }
      }
    }
  }
})

test('every rotated shard, including the largest outer piece, finishes below the screen', () => {
  for (const [width, height] of [[1920, 1080], [390, 844], [3440, 1440], [320, 200], [200, 1600]]) {
    for (let seed = 1; seed <= 20; seed++) {
      const { pieces } = createCrackModel(width, height, seed)
      for (const piece of pieces) {
        assertFallsBelow(piece, height, `${width}×${height}, seed ${seed}`)
        assert.ok(Number.isFinite(piece.dx) && piece.delay >= 0 && piece.delay <= 520)
      }
    }
  }
})

test('the fracture and fall are deterministic and the visible cracks stay inside the viewport', () => {
  const first = createCrackModel(800, 600, 7)
  assert.deepEqual(createCrackModel(800, 600, 7), first)
  assert.notDeepEqual(createCrackModel(800, 600, 8).pieces, first.pieces)
  for (const crack of first.cracks) {
    assert.ok(crack.length > 0 && crack.duration > 0 && crack.delay >= 0)
    for (const { x, y } of crack.points) assert.ok(x >= 0 && x <= 800 && y >= 0 && y <= 600)
  }
})
