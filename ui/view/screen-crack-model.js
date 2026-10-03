// Adapted from the cracking-screen reference:
// https://claude.ai/artifact/LBvFRqcw2PJhuWcRksxWwg
// All geometry uses viewport pixels, including the HTML backdrop mask.
const TAU = Math.PI * 2

function randomGenerator(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let value = seed
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

function edgeDistance(impact, angle, width, height) {
  const dx = Math.cos(angle), dy = Math.sin(angle)
  return Math.min(
    dx > 0 ? (width - impact.x) / dx : dx < 0 ? -impact.x / dx : Infinity,
    dy > 0 ? (height - impact.y) / dy : dy < 0 ? -impact.y / dy : Infinity,
  )
}

function polygonArea(points) {
  return Math.abs(points.reduce((sum, point, i) => {
    const next = points[(i + 1) % points.length]
    return sum + point.x * next.y - next.x * point.y
  }, 0)) / 2
}

function pathLength(points) {
  return points.slice(1).reduce((sum, point, i) =>
    sum + Math.hypot(point.x - points[i].x, point.y - points[i].y), 0)
}

function pieceMotion(points, impact, height, random) {
  const xs = points.map(point => point.x), ys = points.map(point => point.y)
  const center = { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 }
  const radius = Math.max(...points.map(point => Math.hypot(point.x - center.x, point.y - center.y)))
  const angle = Math.atan2(center.y - impact.y, center.x - impact.x)
  return {
    center,
    distance: Math.hypot(center.x - impact.x, center.y - impact.y),
    dx: Math.cos(angle) * (80 + random() * 200) + (random() - .5) * 90,
    // Even after rotation, the topmost vertex finishes below the viewport.
    // A fixed 1200px fall left large/rotated pieces hanging on screen.
    dy: height - center.y + radius + 40,
    rotation: (random() - .5) * 160,
    delay: random() * 120,
  }
}

export function createCrackModel(width, height, seed = 7) {
  const random = randomGenerator(seed)
  const impact = { x: width * 1820 / 1920, y: height * 90 / 1080 }
  const diagonal = Math.hypot(width, height)
  const clampCoordinate = (value, limit) => value < 1e-8 ? 0 : value > limit - 1e-8 ? limit : value
  const clamp = point => ({ x: clampCoordinate(point.x, width), y: clampCoordinate(point.y, height) })
  const angles = Array.from({ length: 20 }, (_, i) => ((i + (random() - .5) * .35) * TAU / 20 + TAU) % TAU)
  // Corner rays keep the outer band on the rectangular screen boundary.
  for (const [x, y] of [[0, 0], [width, 0], [width, height], [0, height]]) {
    angles.push((Math.atan2(y - impact.y, x - impact.x) + TAU) % TAU)
  }
  angles.sort((a, b) => a - b)
  const radii = [.045, .29, .58].map(r => r * Math.min(width, height))
  const loops = radii.map(radius => angles.map(angle => {
    const distance = Math.min(radius * (.92 + random() * .16), edgeDistance(impact, angle, width, height))
    return clamp({ x: impact.x + Math.cos(angle) * distance, y: impact.y + Math.sin(angle) * distance })
  }))
  loops.push(angles.map(angle => {
    const distance = edgeDistance(impact, angle, width, height)
    return clamp({ x: impact.x + Math.cos(angle) * distance, y: impact.y + Math.sin(angle) * distance })
  }))

  // Each edge is built once and shared by its neighbors, including the core.
  // The reference randomized the core separately, leaving overlaps and holes.
  const ringEdges = loops.map((points, ring) => points.map((point, i) => {
    const next = points[(i + 1) % points.length]
    const midpoint = { x: (point.x + next.x) / 2, y: (point.y + next.y) / 2 }
    const length = Math.hypot(next.x - point.x, next.y - point.y)
    const onEdge = (point.x === next.x && (point.x === 0 || point.x === width)) ||
      (point.y === next.y && (point.y === 0 || point.y === height))
    const jitter = ring === loops.length - 1 || onEdge ? 0 : (random() - .5) * length * .08
    const angle = Math.atan2(midpoint.y - impact.y, midpoint.x - impact.x)
    return [point, clamp({ x: midpoint.x + Math.cos(angle) * jitter, y: midpoint.y + Math.sin(angle) * jitter }), next]
  }))
  const radialEdges = loops.slice(1).map((points, ring) => points.map((point, i) => {
    const start = loops[ring][i]
    const length = Math.hypot(point.x - start.x, point.y - start.y)
    const midpoint = { x: (start.x + point.x) / 2, y: (start.y + point.y) / 2 }
    const before = (angles[i] - angles[(i + angles.length - 1) % angles.length] + TAU) % TAU
    const after = (angles[(i + 1) % angles.length] - angles[i] + TAU) % TAU
    const gap = Math.min(before, after) * Math.hypot(midpoint.x - impact.x, midpoint.y - impact.y)
    const jitter = (random() - .5) * Math.min(length * .12, gap * .14)
    return [start, clamp({ x: midpoint.x - Math.sin(angles[i]) * jitter, y: midpoint.y + Math.cos(angles[i]) * jitter }), point]
  }))
  const pieces = []
  const addPiece = points => {
    if (polygonArea(points) > .01) pieces.push({ points, ...pieceMotion(points, impact, height, random) })
  }
  addPiece(ringEdges[0].flatMap(edge => edge.slice(0, -1)))
  for (let ring = 0; ring < loops.length - 1; ring++) {
    for (let i = 0; i < angles.length; i++) {
      const next = (i + 1) % angles.length
      addPiece([
        ...radialEdges[ring][i], ...ringEdges[ring + 1][i].slice(1),
        ...radialEdges[ring][next].toReversed().slice(1), ...ringEdges[ring][i].toReversed().slice(1),
      ])
    }
  }
  const maxDistance = Math.max(...pieces.map(piece => piece.distance))
  for (const piece of pieces) piece.delay += piece.distance / maxDistance * 400

  const cracks = []
  const addCrack = (points, delay, duration, strokeWidth) => {
    const length = pathLength(points)
    if (length > .1) cracks.push({ points, length, delay, duration, width: strokeWidth })
  }
  for (let i = 0; i < angles.length; i++) {
    const points = [impact, loops[0][i], ...radialEdges.flatMap(edges => edges[i].slice(1))]
    addCrack(points, 0, 200 + pathLength(points) / diagonal * 1000, 1.1)
  }
  for (const edges of ringEdges.slice(0, -1)) {
    for (const points of edges) {
      const distance = Math.hypot(points[0].x - impact.x, points[0].y - impact.y)
      addCrack(points, distance / diagonal * 1000, 220 + pathLength(points) / diagonal * 400, .7)
    }
  }
  // Smaller branches retain the reference's organic spiderweb appearance.
  for (const point of loops[1]) {
    const angle = Math.atan2(point.y - impact.y, point.x - impact.x) + (random() - .5) * 1.4
    const length = Math.min(width, height) * (.07 + random() * .12)
    const points = [point]
    for (let i = 1; i <= 3; i++) {
      points.push(clamp({
        x: point.x + Math.cos(angle + (random() - .5) * .3) * length * i / 3,
        y: point.y + Math.sin(angle + (random() - .5) * .3) * length * i / 3,
      }))
    }
    addCrack(points, Math.hypot(point.x - impact.x, point.y - impact.y) / diagonal * 1000 + 80, 220, .5)
  }
  return { width, height, impact, pieces, cracks }
}
