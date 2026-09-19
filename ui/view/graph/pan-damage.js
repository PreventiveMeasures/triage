// Reuse pixels only for exact device-pixel translations. Fractional movement
// needs a full repaint to retain the renderer's original antialiasing.
export function panDamage(previous, next, width, height, dpr) {
  if (!previous || previous.key !== next.key) return null
  const dx = (next.tx - previous.tx) * dpr, dy = (next.ty - previous.ty) * dpr
  if (!Number.isInteger(dx) || !Number.isInteger(dy) || !Number.isInteger(dx / dpr) || !Number.isInteger(dy / dpr) || (!dx && !dy)
      || Math.abs(dx) >= width * dpr || Math.abs(dy) >= height * dpr) return null
  const x = dx / dpr, y = dy / dpr
  const rects = []
  // Repaint the former canvas boundary too: a clipped primitive there may
  // have different antialiasing from the same primitive in the interior.
  const pad = 2
  if (x > 0) rects.push({ x: 0, y: 0, w: Math.min(width, x + pad), h: height })
  if (x < 0) rects.push({ x: Math.max(0, width + x - pad), y: 0, w: Math.min(width, -x + pad), h: height })
  if (y > 0) rects.push({ x: 0, y: 0, w: width, h: Math.min(height, y + pad) })
  if (y < 0) rects.push({ x: 0, y: Math.max(0, height + y - pad), w: width, h: Math.min(height, -y + pad) })
  return { dx, dy, rects }
}

export function outsideDamage(damage, x0, y0, x1, y1) {
  return damage && damage.rects.every((r) => x1 < r.x || x0 > r.x + r.w || y1 < r.y || y0 > r.y + r.h)
}
