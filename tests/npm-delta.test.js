// The lines a version wanting reviews changes, beside its row
// (ui/view/npm-delta.js): read once the row nears the viewport, as many at
// once as READ_AT_ONCE, each once a session; `+x −y`, and, where some
// declaration files changed in types alone, those without them.
import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import { mock, test } from 'node:test'
import './_polyfills.js'
import { templateText } from './_lit.js'

const state = { managedSession: { id: 's', role: 'triage' } }
const asked = []
const pending = []
mock.module('../client/index.js', { exports: { state } })
mock.module('../ui/view/client-managed.js', { exports: {
  fetchNpmDelta(name, version, base) {
    asked.push([name, version, base])
    return new Promise((resolve, reject) => { pending.push({ resolve, reject }) })
  },
} })
const near = new Map()
mock.module('../ui/view/lazy-render.js', { exports: { watchNearViewport(target, cb) { near.set(target, cb) }, unwatchNearViewport(target) { near.delete(target) } } })
const { deltaBase, npmDelta } = await import('../ui/view/npm-delta.js')
// Not connected: its watching asked of it alone, its updates none.
const Delta = class extends customElements.get('npm-delta') { requestUpdate() {} }

test('a row\'s lines are read once it nears the viewport, two at a time, each once; told added and removed, and without types where some changed in types alone', async () => {
  const delta = Object.assign(new Delta(), { name: 'ms', version: '2.1.3', base: '2.1.2' })
  delta._watch()
  assert.equal(templateText(delta.render()), '', 'nothing till it nears the viewport')
  assert.deepEqual(asked, [])
  near.get(delta)(true)
  assert.match(templateText(delta.render()), /class="npm-delta is-loading"/u)
  assert.deepEqual(asked, [['ms', '2.1.3', '2.1.2']])
  npmDelta('a', '1.0.0', '(empty)')
  npmDelta('b', '1.0.0', '(empty)')
  assert.equal(asked.length, 2, 'two at a time, the rest waiting their turn')
  pending[0].resolve({ additions: 1234, deletions: 2, typeless: { additions: 30, deletions: 1 } })
  await setImmediate()
  assert.equal(asked.length, 3)
  const text = templateText(delta.render())
  assert.match(text, /data-tooltip=Lines it adds and removes, against 2\.1\.2><span class="is-added">\+1,234<\/span> <span class="is-deleted">−2<\/span>/u)
  assert.match(text, /\(<span class="is-added">\+30<\/span> <span class="is-deleted">−1<\/span>\s+without types\)/u)
  npmDelta('ms', '2.1.3', '2.1.2')
  assert.equal(asked.length, 3, 'held, not asked again')

  pending[1].resolve({ additions: 5, deletions: 0, typeless: null })
  pending[2].reject(new Error('Counting its lines took too long.'))
  await setImmediate()
  const whole = Object.assign(new Delta(), { name: 'a', version: '1.0.0', base: '(empty)' })
  whole._watch()
  near.get(whole)(true)
  assert.doesNotMatch(templateText(whole.render()), /without types/u, 'none apart where none changed in types alone')
  assert.match(templateText(whole.render()), /the whole package/u)
  const failed = Object.assign(new Delta(), { name: 'b', version: '1.0.0', base: '(empty)' })
  failed._watch()
  near.get(failed)(true)
  assert.match(templateText(failed.render()), /class="npm-delta is-error" data-tooltip=Counting its lines took too long\.>\?</u)
  failed._unwatch()
  assert.equal(near.has(failed), false)

  assert.deepEqual([deltaBase({ version: '2.1.3', was: ['2.1.3', '2.1.2'] }), deltaBase({ version: '1.0.0' })], ['2.1.2', '(empty)'], 'against the version it was, else whole')
})
