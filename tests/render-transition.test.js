import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createViewRenderer, startViewTransition } from '../ui/view/render-transition.js'

globalThis.document = {}

function fixture(t, { supported = true } = {}) {
  const paints = [], transitions = []
  let current
  const startNativeTransition = update => {
    const finished = Promise.withResolvers(), ready = Promise.withResolvers()
    const transition = { ready: ready.promise, finished: finished.promise,
      skipped: false, skipTransition() { this.skipped = true; ready.reject(new DOMException('Skipped', 'AbortError')) },
      update() { update(); ready.resolve() }, finish() { finished.resolve() },
    }
    transitions.push(transition)
    return transition
  }
  t.mock.property(globalThis, 'document', supported ? { startViewTransition: startNativeTransition } : {})
  t.after(async () => {
    for (const transition of transitions) transition.finish()
    await Promise.all(transitions.map(transition => transition.finished))
  })
  const render = createViewRenderer(() => paints.push({ ...current }))
  const repaint = () => render(current.view)
  const show = (view, ready = false) => { current = { view, ready }; render(view) }
  return { paints, repaint, show, transitions }
}

for (const supported of [true, false]) {
  test(`navigation always paints synchronously without a crossfade (API supported: ${supported})`, t => {
    const { paints, show, transitions } = fixture(t, { supported })
    for (const view of ['findings', 'workspace-bundles', 'bundles', 'findings', 'bundles', 'files',
      'workspace-reports', 'packages', 'repositories', 'findings']) {
      show(view)
      assert.deepEqual(paints.at(-1), { view, ready: false })
      show(view, true)
      assert.deepEqual(paints.at(-1), { view, ready: true })
    }
    assert.equal(transitions.length, 0)
  })
}

for (const phase of ['pending', 'animating']) {
  for (const to of ['bundles', 'files', 'workspace-bundles']) {
    test(`navigation to ${to} skips a detail transition in its ${phase} phase`, t => {
      const { paints, repaint, show, transitions } = fixture(t)
      show('findings')
      const transition = startViewTransition(repaint)
      if (phase === 'animating') transition.update()
      show('findings', true)
      assert.equal(transition.skipped, false, 'same-view updates preserve the detail animation')
      show(to, true)
      assert.equal(transition.skipped, true, 'the detail snapshot is removed on navigation')
      assert.deepEqual(paints.at(-1), { view: to, ready: true }, 'the destination paints immediately')
      assert.equal(transitions.length, 1, 'navigation does not start a replacement animation')
      if (phase === 'pending') transition.update()
      assert.deepEqual(paints.at(-1), { view: to, ready: true }, 'a late callback keeps the destination visible')
    })
  }
}

test('an older completion cannot clear a newer detail transition', async t => {
  const { repaint, show } = fixture(t)
  show('findings')
  const older = startViewTransition(repaint)
  older.update()
  const newer = startViewTransition(repaint)
  older.finish()
  await older.finished
  show('bundles')
  assert.equal(newer.skipped, true)
  newer.update()
})

test('a completed detail transition is no longer cancelled on navigation', async t => {
  const { repaint, show } = fixture(t)
  show('findings')
  const transition = startViewTransition(repaint)
  transition.update()
  transition.finish()
  await transition.finished
  show('files')
  assert.equal(transition.skipped, false)
})
