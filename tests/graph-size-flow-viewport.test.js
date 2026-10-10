import assert from 'node:assert/strict'
import { test } from 'node:test'
import '../ui/view/graph/size-flow.js'
import { buildGraph } from '../ui/view/graph/data.js'
import { graph2 } from '../ui/view/graph/state.js'

function fixture() {
  const tree = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`lib/${i}.js`, { size: 10, imports: i < 11 ? [`lib/${i + 1}.js`] : [] }]))
  tree['entry.js'] = { size: 1, imports: ['lib/0.js'] }
  const graph = buildGraph(tree, Object.keys(tree), new Map(), null, null, null, null, { pkgOf: file => file.split('/')[0] })
  graph.flowEntries = [{ file: 'entry.js' }]
  return graph
}

function mounted(t, width = 1000, height = 400) {
  const previousState = graph2.graphState
  const globals = ['window', 'ResizeObserver'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)])
  let disconnects = 0, resized
  globalThis.window = new EventTarget()
  globalThis.ResizeObserver = class {
    constructor(callback) { resized = callback }
    observe() {}
    disconnect() { disconnects++ }
  }
  const Flow = customElements.get('size-flow'), flow = new Flow()
  const box = { width, height, left: 20, top: 30 }
  const stage = new EventTarget()
  stage.getBoundingClientRect = () => box
  const elements = new Map([
    ['.flow-viewport', stage], ['.g2-zoom-pct', {}],
    ['[aria-label="Zoom in"]', {}], ['[aria-label="Zoom out"]', {}],
  ])
  flow.renderRoot = Object.assign(new EventTarget(), { querySelector: selector => elements.get(selector) ?? null, contains: () => false })
  flow.graph = fixture(); flow.willUpdate(new Map([['graph', null]])); flow.updated()
  t.after(() => {
    flow.disconnectedCallback()
    assert.equal(disconnects, 1, 'the viewport observer is cleaned up on removal')
    graph2.graphState = previousState
    for (const [key, descriptor] of globals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete globalThis[key]
    }
  })
  return { flow, stage, elements, box, resize(w, h) { box.width = w; box.height = h; resized() } }
}

const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} ≠ ${expected}`)
const world = (flow, x, y) => [(x - flow.pan.x) / flow.zoom, (y - flow.pan.y) / flow.zoom]

test('flow fits full depth with 10px side margins, preserving manual framing on refresh', t => {
  const { flow, box } = mounted(t)
  near(flow.layout.width * flow.zoom, box.width - 20)
  assert.ok(flow.layout.height * flow.zoom <= box.height + .001)
  near(flow.pan.x, 10)
  near(Math.min(...flow.layout.nodes.map(n => n.x)), 0)
  near(Math.max(...flow.layout.nodes.map(n => n.x + n.width)) * flow.zoom + flow.pan.x, box.width - 10)
  near(flow.pan.y, (box.height - flow.layout.height * flow.zoom) / 2)
  assert.equal(flow.needsFit, false)
  flow.zoomBy(2)
  flow.pan.x += 50; flow.pan.y -= 80
  const pan = { ...flow.pan }, zoom = flow.zoom
  flow.graph = fixture(); flow.willUpdate(new Map([['graph', null]])); flow.updated()
  assert.equal(flow.zoom, zoom)
  near(flow.pan.x, pan.x)
  near(flow.pan.y, pan.y)
})

test('minimum zoom follows files/package content, with 100% as the floor when fit is larger', t => {
  const { flow, box, resize, elements } = mounted(t)
  const fileFit = flow.zoom
  flow.zoomBy(.01)
  assert.equal(flow.zoom, fileFit)
  flow.packages = true; flow.willUpdate(new Map([['packages', false]])); flow.updated()
  assert.ok(flow.zoom > fileFit)
  assert.equal(flow.zoom, flow.fitScale())
  near(flow.pan.x, 10)
  near(flow.layout.width * flow.zoom + flow.pan.x, box.width - 10)
  assert.equal(elements.get('[aria-label="Zoom out"]').disabled, true)
  flow.packages = false; flow.willUpdate(new Map([['packages', true]])); flow.updated()
  assert.equal(flow.zoom, fileFit, 'automatically fitted views remain fitted on content switches')
  flow.zoomBy(1.2)
  resize(2200, 3000)
  assert.equal(flow.zoom, 1, 'a larger viewport enforces the new minimum immediately')
  flow.fit()
  assert.ok(flow.zoom > 1)
  flow.zoomBy(.01)
  assert.equal(flow.zoom, 1, 'min(fit, 100%) allows zooming out to 100% when fit is above it')
  flow.zoomBy(100)
  assert.equal(flow.zoom, 9.99)
  assert.equal(elements.get('[aria-label="Zoom in"]').disabled, true)
})

test('buttons zoom around the center and wheel zoom preserves the point under the cursor', t => {
  const { flow, box, elements } = mounted(t)
  const updates = t.mock.method(flow, 'requestUpdate')
  const before = flow.zoom, center = world(flow, box.width / 2, box.height / 2)
  flow.zoomBy(1.4)
  near(flow.zoom, before * 1.4)
  world(flow, box.width / 2, box.height / 2).forEach((n, i) => near(n, center[i]))
  const pointer = world(flow, 140, 90), wheelBefore = flow.zoom
  let prevented = false
  flow.wheel({ deltaY: -100, clientX: box.left + 140, clientY: box.top + 90, preventDefault() { prevented = true } })
  assert.equal(prevented, true)
  near(flow.zoom, wheelBefore * Math.exp(.15))
  world(flow, 140, 90).forEach((n, i) => near(n, pointer[i]))
  assert.equal(elements.get('.g2-zoom-pct').textContent, `${Math.round(flow.zoom * 100)}%`)
  assert.equal(updates.mock.callCount(), 0, 'zooming repaints the chart without rerendering the component')
})

test('scrolling out at the minimum recenters instead of shrinking below the fitted overview', t => {
  const { flow, box } = mounted(t)
  const center = { ...flow.pan }, fit = flow.zoom
  flow.pan.x += 100; flow.pan.y -= 80
  flow.wheel({ deltaY: 120, clientX: box.left + 100, clientY: box.top + 100, preventDefault() {} })
  assert.equal(flow.zoom, fit)
  near(flow.pan.x, center.x + 60)
  assert.ok(flow.pan.y < center.y && flow.pan.y > center.y - 80)
})

test('dragging pans without selecting a node, while ordinary clicks still work', t => {
  const { flow, stage } = mounted(t)
  flow.select('f:entry.js')
  const pan = { ...flow.pan }
  flow.startPan({ button: 0, pointerId: 1, clientX: 100, clientY: 100 })
  flow.movePan({ pointerId: 2, clientX: 200, clientY: 200 })
  assert.deepEqual(flow.pan, pan, 'unrelated pointers cannot move the viewport')
  flow.movePan({ pointerId: 1, clientX: 160, clientY: 130 })
  assert.deepEqual(flow.pan, { x: pan.x + 60, y: pan.y + 30 })
  flow.endPan({ pointerId: 1 })
  const dragClick = Object.assign(new Event('click', { cancelable: true }), { detail: 1 })
  stage.dispatchEvent(dragClick)
  assert.equal(dragClick.defaultPrevented, true)
  assert.equal(flow.selection.node, 'f:entry.js', 'a drag ending on empty space must not clear selection')
  flow.startPan({ button: 0, pointerId: 1, clientX: 100, clientY: 100 })
  flow.endPan({ pointerId: 1 })
  const click = Object.assign(new Event('click', { cancelable: true }), { detail: 1 })
  stage.dispatchEvent(click)
  assert.equal(click.defaultPrevented, false)
  assert.equal(flow.selection, null, 'a click on empty space clears selection')
})

test('resizing fitted views and switching file/package modes restore the full fitted view', t => {
  const { flow, box, resize } = mounted(t)
  for (const [width, height] of [[400, 900], [1600, 200], [1200, 700]]) {
    resize(width, height)
    near(flow.pan.x, 10)
    near(Math.max(...flow.layout.nodes.map(n => n.x + n.width)) * flow.zoom + flow.pan.x, width - 10)
    assert.ok(flow.layout.height * flow.zoom <= height + .001)
  }
  for (const packages of [true, false]) {
    flow.zoomBy(3)
    flow.pan.x += 50; flow.pan.y -= 80
    assert.equal(flow.fitted, false)
    flow.packages = packages; flow.willUpdate(new Map([['packages', !packages]])); flow.updated()
    assert.equal(flow.zoom, flow.fitScale())
    assert.equal(flow.fitted, true)
    near(flow.pan.x, 10)
    near(flow.pan.y, (box.height - flow.layout.height * flow.zoom) / 2)
    near(flow.layout.width * flow.zoom, box.width - 20)
  }
})

test('turning Large off and on refits after manual framing in files and packages', t => {
  const { flow, box } = mounted(t)
  const files = Array.from({ length: 120 }, (_, i) => `pkg${i}/index.js`)
  const tree = Object.fromEntries(files.map((file, i) => [file, { size: i < 60 ? 512 : 8192, imports: [] }]))
  tree['entry.js'] = { size: 1, imports: files }
  flow.graph = buildGraph(tree, Object.keys(tree), new Map(), null, null, null, null, { pkgOf: file => file.split('/')[0] })
  flow.graph.flowEntries = [{ file: 'entry.js' }]
  flow.willUpdate(new Map([['graph', null]])); flow.updated()
  for (const packages of [false, true]) {
    if (packages) { flow.packages = true; flow.willUpdate(new Map([['packages', false]])); flow.updated() }
    assert.ok(flow.minSize > 0)
    assert.equal(flow.layout.nodes.length, 61)
    for (const large of [false, true]) {
      flow.zoomBy(3)
      flow.pan.x += 50; flow.pan.y -= 80
      assert.equal(flow.fitted, false)
      flow.toggleLarge(); flow.willUpdate(new Map()); flow.updated()
      assert.equal(flow.largeOnly, large)
      assert.equal(flow.layout.nodes.length, large ? 61 : 121)
      assert.equal(flow.zoom, flow.fitScale())
      assert.equal(flow.fitted, true)
      near(flow.pan.x, 10)
      near(flow.pan.y, (box.height - flow.layout.height * flow.zoom) / 2)
      near(flow.layout.width * flow.zoom, box.width - 20)
    }
  }
})

test('a hidden flow waits for measurable dimensions and keeps enforcing bounds on resize', t => {
  const { flow, resize } = mounted(t, 0, 0)
  assert.equal(flow.needsFit, true)
  assert.equal(flow.zoom, 1)
  resize(800, 200)
  assert.equal(flow.needsFit, false)
  assert.ok(flow.zoom > 0 && flow.zoom < 1)
  resize(300, 2000)
  near(flow.zoom, 280 / flow.layout.width)
  flow.zoomBy(2)
  const zoom = flow.zoom
  resize(301, 2000)
  assert.equal(flow.zoom, zoom, 'cosmetic resizes retain a valid user zoom')
})

test('theme changes repaint Size flow without changing its geometry or viewport', t => {
  const { flow } = mounted(t)
  const updates = t.mock.method(flow, 'requestUpdate')
  const layout = flow.layout, pan = { ...flow.pan }, zoom = flow.zoom
  window.dispatchEvent(new Event('deepview-theme-changed'))
  assert.equal(updates.mock.callCount(), 1)
  assert.equal(flow.layout, layout)
  assert.deepEqual(flow.pan, pan)
  assert.equal(flow.zoom, zoom)
})

test('file/package switches reuse computed sizes until graph data changes', t => {
  const { flow } = mounted(t)
  const files = flow.model
  flow.packages = true; flow.willUpdate(new Map([['packages', false]]))
  const packages = flow.model
  flow.packages = false; flow.willUpdate(new Map([['packages', true]]))
  assert.equal(flow.model, files)
  flow.packages = true; flow.willUpdate(new Map([['packages', false]]))
  assert.equal(flow.model, packages)
  flow.graph = fixture()
  flow.graph.nodeByFile.get('entry.js').size += 100
  flow.willUpdate(new Map([['graph', null]]))
  assert.notEqual(flow.model, packages, 'new bundle data invalidates both cached modes')
  assert.equal(flow.model.total.size, packages.total.size + 100)
  flow.packages = false; flow.willUpdate(new Map([['packages', true]]))
  assert.notEqual(flow.model, files)
  assert.equal(flow.model.total.size, files.total.size + 100)
  assert.equal(flow.models.size, 2, 'the component retains at most its two current graph models')
})
