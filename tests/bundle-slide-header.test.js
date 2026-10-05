import assert from 'node:assert/strict'
import { test } from 'node:test'

const frames = new Map()
let frameId = 0
const mode = new EventTarget()
const overlay = new EventTarget()
globalThis.requestAnimationFrame = callback => { frames.set(++frameId, callback); return frameId }
globalThis.cancelAnimationFrame = id => frames.delete(id)
globalThis.matchMedia = () => mode
Object.defineProperty(globalThis, 'navigator', { value: { windowControlsOverlay: overlay }, configurable: true })
globalThis.getComputedStyle = element => ({ height: element.titlebarHeight + 'px' })
globalThis.HTMLElement = class {
  classes = new Set()
  classList = {
    remove: name => this.classes.delete(name),
    toggle: (name, enabled) => enabled ? this.classes.add(name) : this.classes.delete(name),
  }
  titlebarHeight = 33
  top = 0
  barTop = 0
  barHeight = 30
  getBoundingClientRect() { return { top: this.top } }
  bar = { getBoundingClientRect: () => {
    assert.equal(this.classes.has('boxed'), false, 'always measure without panel padding and border')
    return { top: this.barTop, height: this.barHeight }
  } }
  tabs = {}
  querySelector(selector) { return selector === '.bundles-slide-bar' ? this.bar : this.tabs }
}
globalThis.ResizeObserver = globalThis.MutationObserver = class {
  constructor(callback) { this.callback = callback }
  observe() {}
  disconnect() { this.disconnected = true }
}
let Header
globalThis.customElements = { define(_name, value) { Header = value } }
await import('../ui/view/bundle-slide-header.js')

function flush() {
  const pending = [...frames.values()]
  frames.clear()
  for (const callback of pending) callback()
}

test('bundle header restores its box below the titlebar and removes it when space returns', () => {
  const header = new Header()
  header.connectedCallback()
  flush()
  assert.equal(header.classes.has('boxed'), false)
  header.barTop = 33
  header._resize.callback()
  flush()
  assert.equal(header.classes.has('boxed'), true)
  header.barTop = 0
  header._resize.callback()
  flush()
  assert.equal(header.classes.has('boxed'), false)
  header.disconnectedCallback()
})

test('wrapped controls need a box even without right-side controls; native height and mode changes recompute it', () => {
  const header = new Header()
  header.barHeight = 40
  header.connectedCallback()
  flush()
  assert.equal(header.classes.has('boxed'), true)
  header.titlebarHeight = 48
  overlay.dispatchEvent(new Event('geometrychange'))
  flush()
  assert.equal(header.classes.has('boxed'), false)
  header.barTop = 48
  header._resize.callback()
  flush()
  assert.equal(header.classes.has('boxed'), true)
  header.titlebarHeight = 0
  mode.dispatchEvent(new Event('change'))
  flush()
  assert.equal(header.classes.has('boxed'), false, 'normal mode uses the existing panel styles')
  header.disconnectedCallback()
})

test('changed titles and tabs recalculate fit, coalesce observer notifications, and stop observing on unmount', () => {
  const header = new Header()
  header.connectedCallback()
  flush()
  header.barTop = 33
  header._mutation.callback()
  header._resize.callback()
  assert.equal(frames.size, 1)
  flush()
  assert.equal(header.classes.has('boxed'), true)
  header._mutation.callback()
  header.disconnectedCallback()
  assert.equal(header._resize.disconnected, true)
  assert.equal(header._mutation.disconnected, true)
  assert.equal(frames.size, 0)
  mode.dispatchEvent(new Event('change'))
  overlay.dispatchEvent(new Event('geometrychange'))
  assert.equal(frames.size, 0)
})
