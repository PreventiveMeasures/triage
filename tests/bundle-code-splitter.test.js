import assert from 'node:assert/strict'
import { test } from 'node:test'

class TestElement extends EventTarget {
  attributes = new Map()
  classes = new Set()
  capture = null
  classList = { add: name => this.classes.add(name), remove: name => this.classes.delete(name) }
  setAttribute(name, value) { this.attributes.set(name, value) }
  closest() { return this.view }
  setPointerCapture(id) { this.capture = id }
  hasPointerCapture(id) { return this.capture === id }
  releasePointerCapture() { this.capture = null }
}

globalThis.HTMLElement = TestElement
globalThis.ResizeObserver = class {
  constructor(callback) { this.callback = callback }
  observe(view) { view.observer = this }
  disconnect() { this.disconnected = true }
}
let Splitter, TerminalSplitter
globalThis.customElements = { define(name, element) {
  if (name === 'bundle-code-splitter') Splitter = element
  if (name === 'bundle-code-terminal-splitter') TerminalSplitter = element
} }
// Any storage access is a failure: the width must live only in memory.
globalThis.localStorage = globalThis.sessionStorage = {
  getItem() { assert.fail('must not read storage') },
  setItem() { assert.fail('must not write storage') },
}

let boot = 0
async function reload() {
  const path = `../ui/view/bundle-code-splitter.js?boot=${boot++}`
  await import(path)
}

function mount(width = 1000) {
  const view = {
    width,
    railWidth: 320,
    getBoundingClientRect() { return { width: this.width } },
    querySelector() { return { getBoundingClientRect: () => ({ width: this.railWidth }) } },
    style: { setProperty(_name, value) { view.railWidth = parseFloat(value) } },
  }
  const handle = new Splitter()
  handle.view = view
  handle.connectedCallback()
  return { handle, view }
}

// The terminal pane's handle, in a Code column `height` tall.
function mountTerminal(height = 800) {
  const view = {
    height,
    paneHeight: null,
    getBoundingClientRect() { return { height: this.height } },
    querySelector() { return { getBoundingClientRect: () => ({ height: this.paneHeight }) } },
    style: { setProperty(name, value) { assert.equal(name, '--bundle-code-terminal-height'); view.paneHeight = parseFloat(value) } },
  }
  const handle = new TerminalSplitter()
  handle.view = view
  handle.connectedCallback()
  return { handle, view }
}

function fire(handle, type, options = {}) {
  const event = new Event(type, { cancelable: true })
  Object.assign(event, { pointerId: 1, button: 0, isPrimary: true, clientX: 322 }, options)
  handle.dispatchEvent(event)
  return event
}

test('dragging preserves the grab offset, clamps both panes, and ignores other pointers', async () => {
  await reload()
  const { handle, view } = mount()
  assert.equal(view.railWidth, 320)
  assert.equal(fire(handle, 'pointerdown').defaultPrevented, true)
  assert.equal(handle.capture, 1)
  fire(handle, 'pointermove', { clientX: 402 })
  assert.equal(view.railWidth, 400)
  assert.equal(handle.attributes.get('aria-valuenow'), '400')
  fire(handle, 'pointermove', { pointerId: 2, clientX: 502 })
  fire(handle, 'pointerup', { pointerId: 2 })
  assert.equal(view.railWidth, 400)
  assert.equal(handle.capture, 1)
  fire(handle, 'pointermove', { clientX: 2000 })
  assert.equal(view.railWidth, 600)
  fire(handle, 'pointermove', { clientX: -100 })
  assert.equal(view.railWidth, 180)
  fire(handle, 'pointerup')
  assert.equal(handle.capture, null)
  assert.equal(handle.classes.has('dragging'), false)
  fire(handle, 'pointermove', { clientX: 500 })
  assert.equal(view.railWidth, 180, 'moves after release do not resize')
})

test('secondary buttons and secondary touches cannot start a drag', async () => {
  await reload()
  const { handle, view } = mount()
  for (const options of [{ button: 2 }, { isPrimary: false }]) {
    assert.equal(fire(handle, 'pointerdown', options).defaultPrevented, false)
    fire(handle, 'pointermove', { clientX: 502 })
    assert.equal(view.railWidth, 320)
    assert.equal(handle.capture, null)
  }
})

test('cancellation, lost capture, and unmount all end the drag', async () => {
  await reload()
  for (const end of ['pointercancel', 'lostpointercapture', 'unmount']) {
    const { handle, view } = mount()
    fire(handle, 'pointerdown')
    if (end === 'unmount') handle.disconnectedCallback()
    else fire(handle, end)
    fire(handle, 'pointermove', { clientX: 502 })
    assert.equal(view.railWidth, 320)
    assert.equal(handle.capture, null)
    assert.equal(handle.classes.has('dragging'), false)
    if (end === 'unmount') assert.equal(view.observer.disconnected, true)
  }
})

test('keyboard resizing and reset retain the width across mounts without storage', async () => {
  await reload()
  const { handle, view } = mount()
  assert.equal(fire(handle, 'keydown', { key: 'ArrowRight' }).defaultPrevented, true)
  assert.equal(view.railWidth, 336)
  fire(handle, 'keydown', { key: 'ArrowLeft' })
  assert.equal(view.railWidth, 320)
  fire(handle, 'keydown', { key: 'End' })
  assert.equal(view.railWidth, 600)
  fire(handle, 'keydown', { key: 'Home' })
  assert.equal(view.railWidth, 180)
  assert.equal(fire(handle, 'keydown', { key: 'ArrowRight', ctrlKey: true }).defaultPrevented, false)
  assert.equal(view.railWidth, 180)
  handle.disconnectedCallback()
  const next = mount()
  assert.equal(next.view.railWidth, 180)
  fire(next.handle, 'dblclick')
  assert.equal(next.view.railWidth, 320)
})

test('container resizing clamps the rail without forgetting the preferred width', async () => {
  await reload()
  const { handle, view } = mount()
  fire(handle, 'pointerdown')
  fire(handle, 'pointermove', { clientX: 502 })
  fire(handle, 'pointerup')
  assert.equal(view.railWidth, 500)
  view.width = 400
  view.observer.callback()
  assert.equal(view.railWidth, 240)
  assert.equal(handle.attributes.get('aria-valuemax'), '240')
  assert.equal(handle.attributes.get('aria-valuenow'), '240')
  view.width = 1000
  view.observer.callback()
  assert.equal(view.railWidth, 500)
  view.width = 0
  view.observer.callback()
  assert.equal(view.railWidth, 500, 'hidden views do not overwrite the width')
})

test('a fresh page starts at 320px even after a previous instance was resized', async () => {
  await reload()
  const { handle } = mount()
  fire(handle, 'keydown', { key: 'End' })
  assert.equal(mount().view.railWidth, 600)
  await reload()
  assert.equal(mount().view.railWidth, 320)
})

test('the terminal pane starts at 40% of the column, dragged up to grow and down to shrink, within bounds', async () => {
  await reload()
  const { handle, view } = mountTerminal()
  assert.equal(view.paneHeight, 320)
  fire(handle, 'pointerdown', { clientY: 480 })
  fire(handle, 'pointermove', { clientY: 380 })
  assert.equal(view.paneHeight, 420)
  fire(handle, 'pointermove', { clientY: 530 })
  assert.equal(view.paneHeight, 270)
  fire(handle, 'pointermove', { clientY: -1000 })
  assert.equal(view.paneHeight, 680, 'the code keeps 15% of the column')
  fire(handle, 'pointermove', { clientY: 2000 })
  assert.equal(view.paneHeight, 96)
  fire(handle, 'pointerup')
  assert.equal(handle.capture, null)
})

test('the terminal pane resizes by keyboard, keeps its height across mounts apart from the rail\'s width, and resets to 40%', async () => {
  await reload()
  const { handle, view } = mountTerminal()
  assert.equal(fire(handle, 'keydown', { key: 'ArrowUp' }).defaultPrevented, true)
  assert.equal(view.paneHeight, 336)
  fire(handle, 'keydown', { key: 'ArrowDown' })
  fire(handle, 'keydown', { key: 'ArrowDown' })
  assert.equal(view.paneHeight, 304)
  assert.equal(fire(handle, 'keydown', { key: 'ArrowLeft' }).defaultPrevented, false)
  fire(handle, 'keydown', { key: 'Home' })
  assert.equal(view.paneHeight, 96)
  fire(handle, 'keydown', { key: 'End' })
  assert.equal(view.paneHeight, 680)
  handle.disconnectedCallback()
  assert.equal(mount().view.railWidth, 320)
  const next = mountTerminal()
  assert.equal(next.view.paneHeight, 680)
  fire(next.handle, 'dblclick')
  assert.equal(next.view.paneHeight, 320)
})

test('until one is chosen, the terminal pane follows the column at 40%; once chosen, it is clamped to it', async () => {
  await reload()
  const { handle, view } = mountTerminal()
  view.height = 500
  view.observer.callback()
  assert.equal(view.paneHeight, 200)
  fire(handle, 'keydown', { key: 'End' })
  assert.equal(view.paneHeight, 425)
  view.height = 300
  view.observer.callback()
  assert.equal(view.paneHeight, 255)
  view.height = 1000
  view.observer.callback()
  assert.equal(view.paneHeight, 425)
})
