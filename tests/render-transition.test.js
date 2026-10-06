import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createViewRenderer, startViewTransition } from '../ui/view/render-transition.js'

globalThis.document = {}
globalThis.matchMedia = () => ({ matches: false })

function fixture(t, { reduced = false, supported = true } = {}) {
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
  t.mock.property(globalThis, 'matchMedia', () => ({ matches: reduced }))
  t.after(async () => {
    for (const transition of transitions) transition.finish()
    await Promise.all(transitions.map(transition => transition.finished))
  })
  const render = createViewRenderer(() => paints.push({ ...current }))
  const repaint = () => render(current.view)
  const show = (view, ready = false, options) => { current = { view, ready }; render(view, options) }
  return { paints, repaint, show, transitions }
}

for (const from of ['workspace-bundles', 'findings']) {
  test(`opening a bundle from ${from} paints its shell and metadata without a document transition`, t => {
    const { paints, show, transitions } = fixture(t)
    show(from)
    show('bundles')
    assert.deepEqual(paints.at(-1), { view: 'bundles', ready: false }, 'loading shell is painted synchronously')
    show('bundles', true)
    assert.deepEqual(paints.at(-1), { view: 'bundles', ready: true }, 'metadata replaces the shell without being hidden by a snapshot')
    assert.equal(transitions.length, 0)
  })
}

for (const to of ['findings', 'files', 'workspace-reports', 'workspace-bundles']) {
  test(`returning from a bundle to ${to} paints immediately without a document transition`, t => {
    const { paints, show, transitions } = fixture(t)
    show('bundles', true)
    show(to)
    assert.deepEqual(paints.at(-1), { view: to, ready: false })
    show(to, true)
    assert.deepEqual(paints.at(-1), { view: to, ready: true })
    assert.equal(transitions.length, 0)
  })
}

test('bundle entry skips an earlier pending crossfade and its late callback paints current content', async t => {
  const { paints, show, transitions } = fixture(t)
  show('findings')
  show('files')
  assert.equal(transitions.length, 1)
  show('bundles', true)
  assert.equal(transitions[0].skipped, true)
  transitions[0].update()
  assert.deepEqual(paints.slice(1), [{ view: 'bundles', ready: true }, { view: 'bundles', ready: true }])
  transitions[0].finish()
  await transitions[0].finished
})

for (const phase of ['pending', 'animating']) {
  test(`bundle entry skips an outside detail transition in its ${phase} phase`, async t => {
    const { paints, repaint, show, transitions } = fixture(t)
    show('findings')
    const transition = startViewTransition(repaint)
    if (phase === 'animating') transition.update()
    assert.equal(transition.skipped, false, 'the detail animation runs while findings remains active')
    show('bundles', true)
    assert.equal(transition.skipped, true, 'the detail snapshot is removed on bundle entry')
    assert.deepEqual(paints.at(-1), { view: 'bundles', ready: true }, 'the bundle paints immediately')
    assert.equal(transitions.length, 1, 'bundle entry does not start a replacement animation')
    if (phase === 'pending') transition.update()
    assert.deepEqual(paints.at(-1), { view: 'bundles', ready: true }, 'a late detail callback keeps the bundle visible')
    transition.finish()
    await transition.finished
  })
}

test('a completed view transition does not lose a newer detail transition', async t => {
  const { repaint, show, transitions } = fixture(t)
  show('files')
  show('findings')
  transitions[0].update()
  const detail = startViewTransition(repaint)
  transitions[0].finish()
  await transitions[0].finished
  show('bundles')
  assert.equal(detail.skipped, true)
  detail.update()
})

test('other view switches still animate; completed transitions do not replace newer transitions', async t => {
  const { paints, show, transitions } = fixture(t)
  show('workspace-bundles', true)
  show('findings')
  transitions[0].update()
  show('files')
  transitions[0].finish()
  await transitions[0].finished
  show('bundles')
  assert.equal(transitions[1].skipped, true, 'the older completion cannot lose the pending transition')
  assert.equal(transitions[0].skipped, false)
  transitions[1].update()
  transitions[1].finish()
  assert.equal(paints.at(-1).view, 'bundles')
})

for (const options of [{ reduced: true }, { supported: false }, {}]) {
  test(`initial, same-view, and explicit non-animated paints remain immediate: ${JSON.stringify(options)}`, t => {
    const { paints, show, transitions } = fixture(t, options)
    show('findings')
    show('findings', true)
    show('workspace-bundles', false, { animate: false })
    if (options.reduced || options.supported === false) show('files')
    assert.equal(transitions.length, 0)
    assert.equal(paints.length, options.reduced || options.supported === false ? 4 : 3)
  })
}
