import assert from 'node:assert/strict'
import { test } from 'node:test'
import '../ui/view/frontend-install.js'
import { buildGraph } from '../ui/view/graph/data.js'
import { buildSizeFlow, layoutSizeFlow } from '../ui/view/graph/size-flow-model.js'
import { SizeFlowCanvas, canvasSizeFlow } from '../ui/view/graph/size-flow-canvas.js'
import { flowEdgeBounds, flowHitCandidates, flowHitIndex, flowOutside } from '../ui/view/graph/size-flow-hit.js'

test('flow hit index matches exhaustive bounds, preserving draw order and long crossings', () => {
  const entries = Array.from({ length: 15000 }, (_, order) => {
    const left = (order * 137) % 12000, top = (order * 31) % 5000
    return { order, left, right: left + 5 + order % 400, top, bottom: top + 26 + order % 300 }
  })
  const edge = { x1: -100, x2: 100, width1: 10, width2: 20, y1: 100, y2: 0, returning: true }
  const bounds = flowEdgeBounds(edge)
  assert.deepEqual(bounds, { left: -100, right: 120, top: 0, bottom: 135 })
  assert.equal(flowOutside(bounds, { left: 0, right: 50, top: 110, bottom: 120 }), false, 'return control points keep the ribbon visible')
  entries.push({ order: entries.length, ...bounds })
  const index = flowHitIndex(entries)
  for (const [x, y] of [[0, 120], [-100, 135], ...Array.from({ length: 50 }, (_, i) => [i * 277, i * 101])]) {
    const point = { left: x, right: x, top: y, bottom: y }
    const expected = entries.filter(entry => !flowOutside(entry, point)).toSorted((a, b) => b.order - a.order)
    assert.deepEqual(flowHitCandidates(index, x, y), expected)
  }
})

function mounted(t) {
  const saved = ['document', 'getComputedStyle', 'Path2D', 'requestAnimationFrame', 'cancelAnimationFrame', 'devicePixelRatio']
    .map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)])
  const frames = new Map()
  let nextFrame = 0, paths = 0
  globalThis.requestAnimationFrame = callback => { frames.set(++nextFrame, callback); return nextFrame }
  globalThis.cancelAnimationFrame = id => frames.delete(id)
  globalThis.Path2D = class { constructor() { paths++ } }
  globalThis.devicePixelRatio = 2
  globalThis.getComputedStyle = () => ({ getPropertyValue: () => '#fff' })
  const canvas = () => {
    const copyCalls = [], fills = [], strokes = []
    let clears = 0, copies = 0
    const ctx = {
      setTransform() {}, save() {}, restore() {}, beginPath() {}, rect() {}, clip() {}, setLineDash() {}, fillText() {}, stroke() {},
      fill(path) { fills.push(path) }, fillRect(...rect) { fills.push(rect) },
      strokeRect(...rect) { strokes.push({ rect, width: this.lineWidth }) },
      clearRect() { clears++ }, drawImage(...args) { copies++; copyCalls.push(args) }, isPointInPath: () => true,
    }
    return { width: 0, height: 0, style: {}, dataset: {}, getContext: () => ctx, getBoundingClientRect: () => ({ left: 5, top: 10 }),
      setAttribute() {}, fills, strokes, copyCalls, clears: () => clears, copies: () => copies }
  }
  globalThis.document = { createElement: canvas }
  const base = canvas(), overlay = canvas()
  const root = { querySelector: selector => selector === '.flow-base' ? base : overlay, contains: () => false }
  const tree = { 'entry.js': { size: 1, imports: ['a.js', 'b.js'] }, 'a.js': { size: 2, imports: ['b.js'] }, 'b.js': { size: 3, imports: [] } }
  const graph = buildGraph(tree, Object.keys(tree), new Map(), null, null, null, null, { pkgOf: () => 'app' })
  graph.flowEntries = [{ file: 'entry.js' }]
  const model = buildSizeFlow(graph)
  const host = { model, graph, width: 1100, height: 600, pan: { x: 0, y: 0 }, zoom: 1, minSize: 0,
    layout: layoutSizeFlow(model), matches: () => true, renderRoot: root,
    select(node, edge) { this.selection = node ? { node, edge } : null }, follow(node) { this.focus = node },
  }
  const chart = new SizeFlowCanvas(host)
  host.drawViewport = () => chart.viewportChanged()
  const frame = () => { const pending = [...frames.values()]; frames.clear(); for (const callback of pending) callback() }
  chart.update(root); chart.viewportChanged(); frame()
  t.after(() => {
    chart.dispose()
    for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key] }
  })
  return { chart, host, root, base, overlay, frame, frames, paths: () => paths }
}

test('canvas zoom batches frames, caches paths, and hover/selection never repaint the base graph', t => {
  const { chart, host, root, base, overlay, frame, frames, paths } = mounted(t)
  assert.equal(canvasSizeFlow({ nodes: Array.from({ length: 1501 }), edges: [] }), true)
  assert.equal(canvasSizeFlow({ nodes: Array.from({ length: 1500 }), edges: [] }), false)
  assert.equal(paths(), host.layout.edges.length)
  assert.equal(base.width, host.width * 2)
  const basePaints = base.clears(), overlayPaints = overlay.clears()
  chart.setHover(host.model.edges[0].id); frame()
  host.select('f:b.js'); chart.update(root); frame()
  assert.equal(base.clears(), basePaints)
  assert.equal(overlay.clears(), overlayPaints + 2)
  assert.equal(overlay.copies(), 2, 'restore bar pixels above highlighted ribbons')
  for (let i = 0; i < 20; i++) { host.zoom *= 1.01; chart.viewportChanged() }
  assert.equal(frames.size, 1, 'coalesce input into one draw per animation frame')
  frame()
  assert.equal(base.clears(), basePaints + 1)
  assert.equal(paths(), host.layout.edges.length, 'zoom never reparses ribbon paths')
  chart.dispose()
  assert.equal(frames.size, 0, 'disconnect cancels pending paints, including hover cleanup')
})

test('canvas hit testing uses transformed coordinates, prioritizes bars, and retains click and keyboard navigation', t => {
  const { chart, host, frame } = mounted(t)
  host.zoom = .5; host.pan = { x: 20, y: 30 }; chart.viewportChanged(); frame()
  const node = host.layout.nodes[0]
  const event = { clientX: 5 + host.pan.x + (node.x + node.width / 2) * host.zoom,
    clientY: 10 + host.pan.y + (node.y + 13) * host.zoom }
  assert.equal(chart.hit(event).node, node)
  chart.click(event)
  assert.equal(host.selection.node, node.id)
  chart.click(event, true)
  assert.equal(host.focus, node.id)
  chart.click({ clientX: -1000, clientY: -1000 })
  assert.equal(host.selection, null)
  chart.key({ key: 'End', preventDefault() {} })
  chart.key({ key: 'Enter', preventDefault() {} })
  assert.equal(host.selection.node, host.layout.nodes.at(-1).id)
  chart.click({ ...event, defaultPrevented: true })
  assert.equal(host.selection.node, host.layout.nodes.at(-1).id, 'a suppressed drag click never selects')
})

test('continuous zoom reprojects cached bitmaps and redraws exact geometry once input settles', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { chart, host, base, overlay, frame, frames } = mounted(t)
  assert.ok(chart.overview, 'a fitted overview covers newly exposed regions')
  const paints = base.clears(), snapshot = chart.paintedViewport
  host.fitted = false
  host.select('f:b.js')
  for (let i = 0; i < 20; i++) {
    host.zoom *= 1.05; host.pan.x -= 5
    chart.viewportChanged(); frame(); t.mock.timers.tick(16)
  }
  assert.equal(base.clears(), paints, 'no ribbon redraw during continuous input')
  const scale = host.zoom / snapshot.zoom
  const [source, ...rect] = overlay.copyCalls.at(-1)
  assert.equal(source, base)
  const expected = [-host.pan.x / scale * snapshot.dpr, 0, host.width / scale * snapshot.dpr, host.height / scale * snapshot.dpr, 0, 0, host.width, host.height]
  rect.forEach((value, i) => assert.ok(Math.abs(value - expected[i]) < 1e-9))
  assert.equal(overlay.copies(), 20, 'each zoom frame copies only the visible portion of the detailed raster')
  assert.ok(overlay.strokes.length > 0, 'the selected node remains outlined during zoom')
  t.mock.timers.tick(100); frame()
  host.zoom *= 1.01; chart.viewportChanged(); frame()
  assert.equal(base.clears(), paints, 'queued zoom input cancels an idle repaint before it starts')
  t.mock.timers.tick(100); frame(); frame(); frame()
  assert.equal(base.clears(), paints + 1)
  assert.equal(chart.previewVisible, false)
  assert.equal(chart.paintedViewport.zoom, host.zoom)
  host.zoom = .5; chart.viewportChanged(); frame()
  assert.equal(overlay.copyCalls.at(-2)[0], chart.overview.canvas, 'zoom-out fills uncovered areas from the overview')
  chart.dispose(); t.mock.timers.tick(100)
  assert.equal(frames.size, 0, 'disconnect cancels delayed redraws')
})

test('fit, viewport resize, and changed graph filters bypass the zoom preview', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { chart, host, root, base, frame } = mounted(t)
  const startPreview = () => { host.fitted = false; host.zoom *= 1.1; chart.viewportChanged(); frame(); assert.equal(chart.preview, true) }
  startPreview()
  let paints = base.clears()
  host.fitted = true; host.zoom = 1; chart.viewportChanged(); frame()
  assert.equal(chart.preview, false)
  assert.equal(chart.previewVisible, false, 'fit clears the preview even when the original raster can be reused')
  startPreview()
  host.width += 10; chart.viewportChanged(); frame()
  assert.equal(base.clears(), paints + 1, 'resize rerenders at the correct resolution immediately')
  startPreview(); paints = base.clears()
  host.graph.issuesHidden = true; chart.update(root); frame()
  assert.equal(chart.preview, false)
  assert.equal(base.clears(), paints + 1)
  assert.equal(chart.overview, null, 'an outdated overview is never reused for new filter results')
})

test('canvas filters invalidate the base, and borders occupy at most half a bar at every zoom', t => {
  const { chart, host, root, base, frame } = mounted(t)
  for (const zoom of [.01, 1, 8]) {
    host.zoom = zoom; chart.viewportChanged(); frame()
    for (const { rect, width } of base.strokes) assert.ok(width * 2 <= (rect[2] + width) / 2 + 1e-9)
  }
  const before = base.clears()
  host.graph.issuesHidden = true; chart.update(root); frame()
  assert.equal(base.clears(), before + 1)
  host.layout = { ...host.layout, nodes: host.layout.nodes.slice(0, 1), edges: [] }
  chart.update(root); frame()
  assert.equal(chart.paths.length, 0)
})
