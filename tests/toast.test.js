import assert from 'node:assert/strict'
import { test } from 'node:test'

test('a loading toast dismisses safely without hiding a newer notice or reappearing after completion', async () => {
  const frames = []
  const classes = new Set()
  const node = {
    setAttribute() {}, textContent: '',
    get className() { return [...classes].join(' ') },
    set className(value) { classes.clear(); classes.add(value) },
    classList: { add: value => classes.add(value), remove: value => classes.delete(value) },
  }
  const originalDocument = globalThis.document
  const originalFrame = globalThis.requestAnimationFrame
  globalThis.document = { createElement: () => node, body: { append() {} } }
  globalThis.requestAnimationFrame = callback => frames.push(callback)
  const { showToast, hideToast } = await import('../ui/view/toast.js')
  try {
    const first = showToast('Loading bundle…', { duration: 0 })
    first()
    frames.splice(0).forEach(frame => frame())
    assert.equal(classes.has('visible'), false)
    const loading = showToast('Loading another bundle…', { duration: 0 })
    const warning = showToast('App mode warning', { kind: 'warning', duration: 0 })
    frames.splice(0).forEach(frame => frame())
    loading()
    assert.equal(node.textContent, 'App mode warning')
    assert.equal(classes.has('visible'), true)
    warning()
    assert.equal(classes.has('visible'), false)
  } finally {
    hideToast()
    globalThis.document = originalDocument
    globalThis.requestAnimationFrame = originalFrame
  }
})
