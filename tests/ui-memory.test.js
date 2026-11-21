// What the UI holds once a view is gone: a StateElement's reactions, the
// view callbacks caches keep, and caches' entries past their bounds.
import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import { setFlagsFromString } from 'node:v8'
import { runInNewContext } from 'node:vm'
import { test } from 'node:test'
import './_polyfills.js'
import { StateElement } from '@rray/frontend/state-element'
import { store } from '@rray/frontend/state-management'
import { readKept, trimKept } from '../ui/view/kept-entries.js'
import { weakNotify } from '../ui/view/weak-notify.js'

setFlagsFromString('--expose-gc')
const gc = runInNewContext('gc')

const watched = store({ value: 0 })
class Probe extends StateElement {
  render() { return String(watched.value) }
}
if (!customElements.get('memory-probe')) customElements.define('memory-probe', Probe)
// A probe as the document would hold it, its updates asked counted, not run.
function probe({ connected = true, updated = false } = {}) {
  const element = new Probe()
  const asked = { count: 0 }
  Object.defineProperty(element, 'isConnected', { value: connected, configurable: true, writable: true })
  Object.defineProperty(element, 'hasUpdated', { value: updated, configurable: true, writable: true })
  Object.defineProperty(element, 'updateComplete', { get: () => Promise.resolve(true), configurable: true })
  element.requestUpdate = () => { asked.count++ }
  element.bindState()
  return { element, asked }
}
const change = async () => {
  watched.value++
  await setImmediate()
}

test('a StateElement drawn again for another reason than the state it read holds one reaction, not one per draw', async () => {
  const { element, asked } = probe()
  element.render()
  element.render()
  element.render()
  await change()
  assert.equal(asked.count, 1, 'told once, as it holds one reaction')
  element.render()
  element._disposers.splice(0).forEach(dispose => dispose())
  await change()
  assert.equal(asked.count, 1, 'none once disposed, as it is on leaving')
})

test('a StateElement drawn out of the document, as an update asked before it left draws it, reacts to nothing, and observes again once back', async () => {
  const { element, asked } = probe()
  element.render()
  element._disposers.splice(0).forEach(dispose => dispose())
  element.isConnected = false
  assert.equal(element.render(), String(watched.value), 'drawn all the same')
  await change()
  assert.equal(asked.count, 0, 'its draw out of the document left no reaction to hold it')
  element.isConnected = true
  element.hasUpdated = true
  element.bindState()
  assert.equal(asked.count, 1, 'back, drawn again, to observe what it reads')
  element.render()
  await change()
  assert.equal(asked.count, 2)
})

test('a cache\'s entries past its bound let go, the least recently read first, those still wanted kept', () => {
  const map = new Map([['a', { loading: false }], ['b', { loading: true }], ['c', { loading: false }], ['d', { loading: false }]])
  assert.deepEqual(readKept(map, 'a'), { loading: false })
  assert.equal(readKept(map, 'none'), undefined)
  assert.deepEqual([...map.keys()], ['b', 'c', 'd', 'a'], 'read, moved last')
  const dropped = []
  trimKept(map, 2, entry => entry.loading, key => { dropped.push(key); map.delete(key) })
  assert.deepEqual(dropped, ['c', 'd'], 'the least recently read, but the one still loading')
  assert.deepEqual([...map.keys()], ['b', 'a'])
  trimKept(map, 1)
  assert.deepEqual([...map.keys()], ['a'], 'deleted, where told no other way')
})

test('a view\'s callback a cache holds is called while the view holds it, one wrapper for each, and lets the view go', async () => {
  let told = 0
  const repaint = () => { told++ }
  const wrapper = weakNotify(repaint)
  assert.equal(weakNotify(repaint), wrapper, 'the same wrapper, so a set of those to tell tells each once')
  wrapper()
  assert.equal(told, 1)
  assert.equal(weakNotify(null), null)
  // A view's own, gone with it.
  let collected = false
  const registry = new FinalizationRegistry(() => { collected = true })
  let held = (() => {
    const view = { repaint: () => { told++ } }
    registry.register(view, 'view')
    return weakNotify(view.repaint)
  })()
  for (let tries = 0; tries < 20; tries++) {
    await setImmediate()
    gc()
    if (collected) break
  }
  assert.ok(collected, 'the view let go, though its callback\'s wrapper is held')
  held()
  assert.equal(told, 1, 'telling none once it is gone')
  held = null
})
