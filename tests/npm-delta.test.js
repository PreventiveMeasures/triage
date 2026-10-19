// The lines a version wanting reviews changes, beside its row
// (ui/view/npm-delta.js): read once the row nears the viewport, those asked
// within a frame asked together, fifty a request, two requests at once, each
// once a session; those a team's Dependencies are told with held, never
// asked; `+x −y`, and, where some declaration files changed in types alone,
// those without them; `, binary` where binary files changed too.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { setImmediate } from 'node:timers/promises'
import { mock, test } from 'node:test'
import './_polyfills.js'
import { templateText } from './_lit.js'

const state = { managedSession: { id: 's', role: 'triage' } }
// Each request's versions, and its lines to tell and its end, as the server would.
const asked = []
const pending = []
mock.module('../client/index.js', { exports: { state } })
mock.module('../ui/view/client-managed.js', { exports: {
  fetchNpmDeltas(versions, onLine) {
    asked.push(versions)
    return new Promise((resolve, reject) => { pending.push({ versions, tell: line => onLine(line), resolve, reject }) })
  },
} })
const near = new Map()
mock.module('../ui/view/lazy-render.js', { exports: { watchNearViewport(target, cb) { near.set(target, cb) }, unwatchNearViewport(target) { near.delete(target) } } })
const { deltaBase, npmDelta, seedNpmDeltas } = await import('../ui/view/npm-delta.js')
// Not connected: its watching asked of it alone, its updates none.
const Delta = class extends customElements.get('npm-delta') { requestUpdate() {} }
// A frame past, those asked within it asked for.
const frame = () => new Promise(resolve => { setTimeout(resolve, 5) })

test('a row\'s lines are read once it nears the viewport, those asked within a frame together, each once; told added and removed, binary where binary files changed, and -types where some changed in types alone', async () => {
  const delta = Object.assign(new Delta(), { name: 'ms', version: '2.1.3', base: '2.1.2' })
  delta._watch()
  assert.equal(templateText(delta.render()), '', 'nothing till it nears the viewport')
  near.get(delta)(true)
  assert.match(templateText(delta.render()), /class="npm-delta is-loading"/u)
  npmDelta('a', '1.0.0', '(empty)')
  npmDelta('b', '1.0.0', '(empty)')
  assert.deepEqual(asked, [], 'none asked within the frame')
  await frame()
  assert.deepEqual(asked, [[['ms', '2.1.3', '2.1.2'], ['a', '1.0.0', '(empty)'], ['b', '1.0.0', '(empty)']]], 'those of the frame in one request')
  const [request] = pending
  request.tell({ name: 'ms', version: '2.1.3', otherVersion: '2.1.2', additions: 1234, deletions: 2, typeless: { additions: 30, deletions: 1 }, binary: true })
  const text = templateText(delta.render())
  assert.match(text, /data-tooltip=Lines it adds and removes, against 2\.1\.2><span class="is-added">\+1,234<\/span> <span class="is-deleted">−2<\/span><span class="npm-delta-binary"[^>]*>, binary<\/span>/u,
    'each as its line comes')
  assert.match(text, /\(<span class="is-added">\+30<\/span> <span class="is-deleted">−1<\/span>\s+-types\)/u)
  npmDelta('ms', '2.1.3', '2.1.2')
  await frame()
  assert.equal(asked.length, 1, 'held, not asked again')

  request.tell({ name: 'a', version: '1.0.0', otherVersion: '(empty)', additions: 5, deletions: 0, typeless: null })
  request.tell({ name: 'b', version: '1.0.0', otherVersion: '(empty)', error: 'Counting its lines took too long.' })
  request.resolve()
  await setImmediate()
  const whole = Object.assign(new Delta(), { name: 'a', version: '1.0.0', base: '(empty)' })
  whole._watch()
  near.get(whole)(true)
  assert.doesNotMatch(templateText(whole.render()), /-types/u, 'none apart where none changed in types alone')
  assert.doesNotMatch(templateText(whole.render()), /binary/u, 'nor binary where none changed')
  assert.match(templateText(whole.render()), /the whole package/u)
  const failed = Object.assign(new Delta(), { name: 'b', version: '1.0.0', base: '(empty)' })
  failed._watch()
  near.get(failed)(true)
  assert.match(templateText(failed.render()), /class="npm-delta is-error" data-tooltip=Counting its lines took too long\.>\?</u)
  failed._unwatch()
  assert.equal(near.has(failed), false)

  assert.deepEqual([deltaBase({ version: '2.1.3', was: ['2.1.3', '2.1.2'] }), deltaBase({ version: '1.0.0' })], ['2.1.2', '(empty)'], 'against the version it was, else whole')
})

test('fifty a request, two requests at once, the rest waiting their turn; one the server told none of, or that failed, failed; those told otherwise never asked', async () => {
  asked.length = 0
  pending.length = 0
  seedNpmDeltas([['told', '1.0.0', '(empty)', { additions: 7, deletions: 0, typeless: null }], ['bad', '1.0.0', '(empty)', { additions: -1 }]])
  assert.deepEqual(npmDelta('told', '1.0.0', '(empty)'), { status: 'ready', until: Number.POSITIVE_INFINITY, additions: 7, deletions: 0, typeless: null, binary: false })
  for (let at = 0; at < 120; at++) npmDelta(`many-${at}`, '1.0.0', '(empty)')
  await frame()
  assert.deepEqual(asked.map(versions => versions.length), [50, 50], 'two of fifty, the third waiting')
  assert.ok(!asked.flat().some(([name]) => name === 'told'), 'one told with a team\'s never asked')
  pending[0].resolve()
  await setImmediate()
  assert.deepEqual(asked.map(versions => versions.length), [50, 50, 20], 'the next once one ends')
  assert.equal(npmDelta('many-0', '1.0.0', '(empty)').error, 'The server answered with none of it.')
  pending[1].reject(new Error('Too many packages are being counted. Try again shortly.'))
  await setImmediate()
  assert.equal(npmDelta('many-50', '1.0.0', '(empty)').error, 'Too many packages are being counted. Try again shortly.')
  // One told with a team's while it waits its turn asked no more.
  for (let at = 0; at < 101; at++) npmDelta(`more-${at}`, '1.0.0', '(empty)')
  await frame()
  seedNpmDeltas([['more-100', '1.0.0', '(empty)', { additions: 1, deletions: 1, typeless: null }]])
  pending[2].resolve()
  await setImmediate()
  pending[3].resolve()
  await setImmediate()
  assert.deepEqual(asked.slice(3).map(versions => versions.length), [50, 50], 'the last of them, told meanwhile, not asked')
  // Those of another session asked again.
  state.managedSession = { id: 'other', role: 'triage' }
  assert.equal(npmDelta('told', '1.0.0', '(empty)').status, 'loading')
  state.managedSession = { id: 's', role: 'triage' }
})

test('its element is a box wherever it is styled, as its viewport\'s observer sees nothing of one with none', () => {
  for (const sheet of ['../ui/styles/report.css', '../ui/view/dialogs/dialog-repository-item.css']) {
    const rule = /(?:^|\n)npm-delta \{([^}]*)\}/u.exec(readFileSync(new URL(sheet, import.meta.url), 'utf8'))?.[1] ?? ''
    assert.match(rule, /display: inline-block/u, sheet)
    assert.match(rule, /min-width: 1px/u, sheet)
  }
})

test('a delta read draws again its own rows alone, those near the viewport, each no longer watched for it once near', async () => {
  const drawn = []
  const Counted = class extends customElements.get('npm-delta') { requestUpdate() { drawn.push(this.name) } }
  const [one, other, far] = [['one', '1.0.0'], ['other', '1.0.0'], ['one', '1.0.0']].map(([name, version]) => Object.assign(new Counted(), { name, version, base: '(empty)' }))
  for (const element of [one, other, far]) element._watch()
  near.get(one)(true)
  near.get(other)(true)
  assert.equal(near.has(one), false, 'no longer watched once near')
  drawn.length = 0
  one.render()
  other.render()
  await frame()
  const request = pending.at(-1)
  assert.deepEqual(request.versions, [['one', '1.0.0', '(empty)'], ['other', '1.0.0', '(empty)']])
  request.tell({ name: 'one', version: '1.0.0', otherVersion: '(empty)', additions: 1, deletions: 0, typeless: null })
  assert.deepEqual(drawn, ['one'], 'its own row, not another\'s, nor one not yet near')
  request.tell({ name: 'other', version: '1.0.0', otherVersion: '(empty)', additions: 2, deletions: 0, typeless: null })
  request.resolve()
  await setImmediate()
  for (const element of [one, other, far]) element._unwatch()
})
