import assert from 'node:assert/strict'
import { test } from 'node:test'
import '../ui/view/frontend-install.js'
import { buildGraph } from '../ui/view/graph/data.js'
import { buildSizeFlow, layoutSizeFlow } from '../ui/view/graph/size-flow-model.js'
import { SizeFlowCanvas, canvasSizeFlow } from '../ui/view/graph/size-flow-canvas.js'
import { flowEdgeBounds, flowHitCandidates, flowHitIndex, flowOutside, flowVisibleRibbons } from '../ui/view/graph/size-flow-hit.js'

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

test('live ribbon queries count only visible ribbons, preserving crossings and paint order', () => {
  const entries = Array.from({ length: 15000 }, (_, order) => {
    const left = (order * 137) % 12000, top = (order * 31) % 5000
    return { order, left, right: left + 5 + order % 400, top, bottom: top + 26 + order % 300,
      ...(order % 3 === 0 ? { node: {} } : { edge: {} }) }
  })
  entries.push({ order: entries.length, edge: {}, ...flowEdgeBounds({ x1: -100, x2: 100, width1: 10, width2: 20, y1: 100, y2: 0, returning: true }) })
  const index = flowHitIndex(entries)
  for (const view of [{ left: 0, right: 50, top: 110, bottom: 120 }, ...Array.from({ length: 20 }, (_, i) =>
    ({ left: i * 277, right: i * 277 + 300, top: i * 101, bottom: i * 101 + 600 }))]) {
    const expected = entries.filter(entry => entry.edge && !flowOutside(entry, view))
    assert.deepEqual(flowVisibleRibbons(index, view, expected.length), expected, 'the cutoff is inclusive and paint order is retained')
    assert.equal(flowVisibleRibbons(index, view, expected.length - 1), null, 'dense views use the complete cached image')
  }
  assert.deepEqual(flowVisibleRibbons(index, { left: -500, right: -400, top: -500, bottom: -400 }, 500), [])
  assert.deepEqual(flowVisibleRibbons(null, {}, 500), [])
})

function mounted(t, { dense = false } = {}) {
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
    const copyCalls = [], fills = [], strokes = [], texts = []
    let clears = 0, copies = 0
    const ctx = {
      setTransform() {}, save() {}, restore() {}, beginPath() {}, rect() {}, clip() {}, setLineDash() {}, stroke() {},
      fillText(...args) { texts.push(args) },
      fill(path) { fills.push(path) }, fillRect(...rect) { fills.push(rect) },
      strokeRect(...rect) { strokes.push({ rect, width: this.lineWidth }) },
      clearRect() { clears++ }, drawImage(...args) { copies++; copyCalls.push(args) }, isPointInPath: () => true,
    }
    return { width: 0, height: 0, style: {}, dataset: {}, getContext: () => ctx, getBoundingClientRect: () => ({ left: 5, top: 10 }),
      setAttribute() {}, fills, strokes, texts, copyCalls, clears: () => clears, copies: () => copies }
  }
  globalThis.document = { createElement: canvas }
  const bars = canvas(), base = canvas(), overlay = canvas()
  const root = { querySelector: selector => ({ '.flow-base': base, '.flow-bars': bars, '.flow-overlay': overlay })[selector], contains: () => false }
  const tree = { 'entry.js': { size: 1, imports: ['a.js', 'b.js'] }, 'a.js': { size: 2, imports: ['b.js'] }, 'b.js': { size: 3, imports: [] } }
  const graph = buildGraph(tree, Object.keys(tree), new Map(), null, null, null, null, { pkgOf: () => 'app' })
  graph.flowEntries = [{ file: 'entry.js' }]
  const model = buildSizeFlow(graph)
  const layout = layoutSizeFlow(model)
  if (dense) layout.edges = Array.from({ length: 1000 }, (_, i) => layout.edges.map(edge => ({ ...edge, id: i ? `${edge.id}:${i}` : edge.id }))).flat()
  const host = { model, graph, width: 1100, height: 600, pan: { x: 0, y: 0 }, zoom: 1, minSize: 0,
    layout, matchesNode: () => true, renderRoot: root,
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
  return { chart, host, root, base, bars, overlay, frame, frames, paths: () => paths }
}

test('canvas zoom batches frames, caches paths, and hover/selection never repaint the base graph', t => {
  const { chart, host, root, base, bars, overlay, frame, frames, paths } = mounted(t)
  assert.equal(canvasSizeFlow({ nodes: Array.from({ length: 1501 }), edges: [] }), true)
  assert.equal(canvasSizeFlow({ nodes: Array.from({ length: 1500 }), edges: [] }), false)
  assert.equal(paths(), host.layout.edges.length)
  assert.equal(base.width, host.width * 2)
  const barPaints = bars.clears(), basePaints = base.clears(), overlayPaints = overlay.clears()
  chart.setHover(host.model.edges[0].id); frame()
  host.select('f:b.js'); chart.update(root); frame()
  assert.equal(base.clears(), basePaints)
  assert.equal(bars.clears(), barPaints, 'hover and selection leave bar pixels intact')
  assert.ok(overlay.clears() > overlayPaints)
  assert.equal(overlay.copies(), 0, 'highlights reveal the separate bars layer without copying its pixels')
  assert.equal(base.texts.length, 0, 'ribbon rasters never contain labels')
  assert.equal(base.strokes.length, 0, 'ribbon rasters never contain bar borders')
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

test('keyboard navigation starts at the first bar without skipping and stays within its bounds', t => {
  const { chart, host, root } = mounted(t)
  const press = key => chart.key({ key, preventDefault() {} })
  const reset = () => { chart.clearHover(); host.select(null) }
  const nodes = host.layout.nodes
  for (const forward of ['ArrowRight', 'ArrowDown']) {
    reset(); press(forward); press('Enter')
    assert.equal(host.selection.node, nodes[0].id, `${forward} starts on the first bar`)
    press(forward)
    assert.equal(chart.focused, nodes[1].id, 'subsequent arrows advance normally')
    press('End'); press(forward)
    assert.equal(chart.focused, nodes.at(-1).id, 'forward navigation stops at the last bar')
  }
  for (const backward of ['ArrowLeft', 'ArrowUp']) {
    reset(); press(backward); press(backward)
    assert.equal(chart.focused, nodes[0].id, 'backward navigation stops at the first bar')
  }
  for (const activate of ['Enter', ' ']) {
    reset(); press(activate)
    assert.equal(host.selection.node, nodes[0].id, 'activation without a focused bar still selects the first')
  }
  reset(); host.layout = { ...host.layout, nodes: [], edges: [] }; chart.update(root)
  for (const key of ['ArrowRight', 'ArrowDown', 'Enter', ' ']) press(key)
  assert.equal(host.selection, null, 'empty graphs do not activate a nonexistent bar')
})

test('sparse views repaint ribbons at the current scale on every zoom frame', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { chart, host, base, bars, frame, frames, paths } = mounted(t)
  const paintPath = t.mock.method(chart, 'paintPath'), paints = base.clears()
  host.fitted = false
  for (let i = 0; i < 10; i++) {
    const before = paintPath.mock.callCount()
    host.zoom *= 1.05; chart.viewportChanged(); frame(); t.mock.timers.tick(16)
    assert.equal(chart.preview, false, 'a light view bypasses the cached preview immediately')
    assert.equal(base.clears(), paints + i + 1)
    assert.equal(chart.paintedViewport.zoom, host.zoom)
    const visible = chart.paths.filter(entry => !flowOutside(entry, chart.view))
    assert.deepEqual(paintPath.mock.calls.slice(before).map(call => call.arguments[1]), visible)
  }
  assert.equal(paths(), host.layout.edges.length, 'live repaint reuses parsed paths')
  assert.equal(bars.copies(), 0, 'live ribbons do not require a raster preview')
  t.mock.timers.tick(100)
  assert.equal(frames.size, 0, 'live frames cancel the redundant idle repaint')
})

test('panning between dense and empty views switches modes without stale preview pixels', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { chart, host, base, bars, frame } = mounted(t, { dense: true })
  host.fitted = false; host.zoom = 1.1; chart.viewportChanged(); frame()
  assert.equal(chart.previewVisible, true)
  const barPaints = bars.clears(), overview = chart.overview, paints = base.clears()
  host.pan.y = -10000; chart.viewportChanged(); frame()
  assert.equal(chart.previewVisible, false)
  assert.equal(base.clears(), paints + 1, 'the newly empty viewport is painted immediately')
  assert.equal(bars.clears(), barPaints + 1, 'cached ribbon pixels are cleared from the bars layer')
  assert.deepEqual(chart.visiblePaths, [])
  host.pan.y = 0; chart.viewportChanged(); frame()
  assert.equal(chart.previewVisible, true, 'returning to dense ribbons restores the cached mode')
  assert.equal(base.clears(), paints + 1)
  assert.equal(bars.copyCalls.at(-1)[0], overview.canvas, 'the full overview covers the area absent from the empty raster')
  t.mock.timers.tick(100); frame(); frame(); frame()
  assert.equal(chart.previewVisible, false)
  assert.equal(base.clears(), paints + 2, 'dense ribbons are refined when the gesture settles')
})

test('continuous zoom reprojects ribbons, redraws bars each frame, and refines ribbons after input settles', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { chart, host, base, bars, overlay, frame, frames } = mounted(t, { dense: true })
  assert.ok(chart.overview, 'a fitted overview covers newly exposed regions')
  const paints = base.clears(), snapshot = chart.paintedViewport
  const paintNode = t.mock.method(chart, 'paintNode')
  host.fitted = false
  host.select('f:b.js')
  for (let i = 0; i < 20; i++) {
    const barPaints = paintNode.mock.callCount()
    host.zoom *= 1.05; host.pan.x -= 5
    chart.viewportChanged(); frame(); t.mock.timers.tick(16)
    assert.ok(paintNode.mock.callCount() > barPaints, 'bars repaint on each zoom frame')
    for (const { arguments: [ctx, node] } of paintNode.mock.calls.slice(barPaints)) {
      assert.equal(ctx, bars.getContext('2d'))
      assert.ok(node.x + node.width >= chart.view.left && node.x <= chart.view.right, 'bar culling follows the current viewport')
    }
  }
  assert.equal(base.clears(), paints, 'no ribbon redraw during continuous input')
  const scale = host.zoom / snapshot.zoom
  const [source, ...rect] = bars.copyCalls.at(-1)
  assert.equal(source, base)
  const expected = [-host.pan.x / scale * snapshot.dpr, 0, host.width / scale * snapshot.dpr, host.height / scale * snapshot.dpr, 0, 0, host.width, host.height]
  rect.forEach((value, i) => assert.ok(Math.abs(value - expected[i]) < 1e-9))
  assert.equal(bars.copies(), 20, 'each zoom frame copies only the visible portion of the ribbon raster')
  assert.ok(overlay.strokes.length > 0, 'the selected node remains outlined during zoom')
  t.mock.timers.tick(100); frame()
  host.zoom *= 1.01; chart.viewportChanged(); frame()
  assert.equal(base.clears(), paints, 'queued zoom input cancels an idle repaint before it starts')
  t.mock.timers.tick(100); frame(); frame(); frame()
  assert.equal(base.clears(), paints + 1)
  assert.equal(chart.previewVisible, false)
  assert.equal(chart.paintedViewport.zoom, host.zoom)
  host.zoom = .5; chart.viewportChanged(); frame()
  assert.equal(bars.copyCalls.at(-2)[0], chart.overview.canvas, 'zoom-out fills uncovered areas from the overview')
  chart.dispose(); t.mock.timers.tick(100)
  assert.equal(frames.size, 0, 'disconnect cancels delayed redraws')
})

test('bar labels become readable during zoom without waiting for the ribbon repaint', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { chart, host, base, bars, frame } = mounted(t, { dense: true })
  const paints = base.clears(), texts = bars.texts.length
  host.fitted = false; host.zoom = .25; chart.viewportChanged(); frame()
  assert.equal(bars.texts.length, texts, 'unreadable subpixel text is omitted')
  host.zoom = .5; chart.viewportChanged(); frame()
  assert.equal(chart.preview, true, 'the gesture has not settled yet')
  assert.ok(bars.texts.length > texts, 'labels are drawn immediately at their new scale')
  assert.equal(base.clears(), paints, 'ribbons remain cached throughout')
})

test('fit, viewport resize, and changed graph filters bypass the zoom preview', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { chart, host, root, base, frame } = mounted(t, { dense: true })
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

test('canvas filters invalidate both layers, and borders occupy at most half a bar at every zoom', t => {
  const { chart, host, root, base, bars, frame } = mounted(t)
  for (const zoom of [.01, 1, 8]) {
    host.zoom = zoom; chart.viewportChanged(); frame()
    for (const { rect, width } of bars.strokes) assert.ok(width * 2 <= (rect[2] + width) / 2 + 1e-9)
  }
  const barPaints = bars.clears(), before = base.clears()
  host.graph.issuesHidden = true; chart.update(root); frame()
  assert.equal(base.clears(), before + 1)
  assert.equal(bars.clears(), barPaints + 1)
  host.layout = { ...host.layout, nodes: host.layout.nodes.slice(0, 1), edges: [] }
  chart.update(root); frame()
  assert.equal(chart.paths.length, 0)
})
