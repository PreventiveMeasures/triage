// Slot coordinates stay fixed during sunflower ordering. Index them once so
// checking a larger disk's new home only visits nearby occupied slots.
// Equal-radius swaps preserve every clearance. With unequal radii, the smaller
// disk can only improve clearance; require the larger disk to fit at its new
// slot without overlapping another disk. Thus no slot pair's overlap increases.
export function diskSwapCheck(xs, ys, radii, nodeAtSlot) {
  let maxRadius = 0
  for (const radius of radii) maxRadius = Math.max(maxRadius, radius)
  if (maxRadius === 0) return () => true
  const cellSize = 2 * maxRadius
  const cells = new Map()
  const cellX = Int32Array.from(xs, x => Math.floor(x / cellSize))
  const cellY = Int32Array.from(ys, y => Math.floor(y / cellSize))
  for (let slot = 0; slot < xs.length; slot++) {
    const key = `${cellX[slot]}:${cellY[slot]}`
    if (!cells.has(key)) cells.set(key, [])
    cells.get(key).push(slot)
  }
  // Bound this work separately from the edge/slot search. Exhausting the
  // budget rejects further unequal-radius swaps; equal disks remain free.
  let checks = 0
  return (a, b, sa, sb) => {
    if (radii[a] === radii[b]) return true
    const larger = radii[a] > radii[b] ? a : b
    const target = larger === a ? sb : sa
    for (let x = cellX[target] - 1; x <= cellX[target] + 1; x++) {
      for (let y = cellY[target] - 1; y <= cellY[target] + 1; y++) {
        for (const slot of cells.get(`${x}:${y}`) ?? []) {
          if (++checks > 8_000_000) return false
          const other = nodeAtSlot[slot]
          if (other === a || other === b) continue
          const clearance = radii[larger] + radii[other]
          const dx = xs[target] - xs[slot], dy = ys[target] - ys[slot]
          if (dx * dx + dy * dy < clearance * clearance - 1e-7) return false
        }
      }
    }
    return true
  }
}
