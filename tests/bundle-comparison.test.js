import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { prepareComparison } from '../common/bundle-comparison.js'

// The server's comparisons, each held till the test answers it.
const asked = []
const held = (kind, args) => new Promise((resolve, reject) => { asked.push({ kind, args, resolve, reject }) })
mock.module('../ui/view/client-managed.js', { namedExports: {
  fetchBundleComparison: (...args) => held('bundle', args),
  fetchNpmComparison: (...args) => held('npm', args),
} })
const { bundleComparison, bundleComparisonDiff } = await import('../ui/view/bundle-comparison.js')

const sourcemap = (integrity, sources, extra = {}) => ({ integrity, kind: 'sourcemap', size: 0,
  json: { version: 3, sources: Object.keys(sources), sourcesContent: Object.values(sources) }, ...extra })
const settle = () => new Promise(resolve => { setImmediate(resolve) })
const answered = { files: { onlyBase: [], onlyOther: [], changed: [], root: null, basePaths: new Map() } }

test('two managed bundles are compared by the server, once, the view told when it comes', async () => {
  const [base, other] = [sourcemap('m-base', { 'a.js': 'a' }, { managedId: 'b1' }), sourcemap('m-other', { 'a.js': 'b' }, { managedId: 'b2' })]
  let told = 0
  assert.deepEqual(bundleComparison(base, other, 'reason:web', () => { told++ }), { status: 'loading' })
  const request = asked.at(-1)
  assert.deepEqual([request.kind, request.args], ['bundle', ['b1', 'b2', { scope: 'reason:web' }]])
  assert.deepEqual(bundleComparison(base, other, 'reason:web', () => { told++ }), { status: 'loading' }, 'asked for once')
  assert.equal(asked.length, 1)
  request.resolve(answered)
  await settle()
  assert.equal(told, 1)
  assert.deepEqual(bundleComparison(base, other, 'reason:web', () => {}), { status: 'ready', diff: answered })
  assert.equal(asked.length, 1, 'kept')
})

test('a package version is compared by the server with another, another package\'s, or none', async () => {
  const npm = (name, version) => sourcemap(`${name}@${version}`, { 'a.js': version }, { npm: { name, version } })
  const now = npm('lib', '2.0.0')
  for (const [base, args] of [[npm('lib', '1.0.0'), ['lib', '2.0.0', '1.0.0', { otherName: 'lib' }]], [npm('fork', '1.0.0'), ['lib', '2.0.0', '1.0.0', { otherName: 'fork' }]],
    [sourcemap('(empty)', {}), ['lib', '2.0.0', '(empty)', { otherName: 'lib' }]]]) {
    const before = asked.length
    bundleComparison(base, now, null, () => {})
    assert.equal(asked.length, before + 1)
    assert.deepEqual([asked.at(-1).kind, asked.at(-1).args], ['npm', args])
    asked.at(-1).resolve(answered)
  }
  await settle()
})

test('a package version as a pnpm patch changes it is compared by the server, with the patch, apart from the version as npm has it', async () => {
  const patch = { hash: 'a'.repeat(64), repoId: 1, commit: 'b'.repeat(40), path: 'patches/lib@2.0.0.patch' }
  const patched = sourcemap(`lib@2.0.0 patch:${patch.hash}`, { 'a.js': 'patched' }, { npmPatch: { name: 'lib', version: '2.0.0', patch } })
  const base = sourcemap('lib@1.0.0', { 'a.js': '1.0.0' }, { npm: { name: 'lib', version: '1.0.0' } })
  for (const [side, args] of [[base, ['lib', '2.0.0', '1.0.0', { otherName: 'lib', patch }]], [sourcemap('(empty)', {}), ['lib', '2.0.0', '(empty)', { otherName: 'lib', patch }]]]) {
    const before = asked.length
    assert.equal(bundleComparison(side, patched, null, () => {}).status, 'loading')
    assert.equal(asked.length, before + 1)
    assert.deepEqual([asked.at(-1).kind, asked.at(-1).args], ['npm', args])
    asked.at(-1).resolve(answered)
  }
  await settle()
  assert.deepEqual(bundleComparison(base, patched, null, () => {}), { status: 'ready', diff: answered }, 'kept by the patched side\'s own')
})

test('bundles opened here are compared here, the first once its chunk loads, the rest at once, by the details read', async () => {
  const before = asked.length
  const [base, other] = [sourcemap('l-base', { 'a.js': 'a', 'b.js': 'b' }), sourcemap('l-other', { 'a.js': 'a2', 'c.js': 'b' })]
  let told = 0
  assert.equal(bundleComparison(base, other, null, () => { told++ }).status, 'loading')
  await bundleComparisonDiff(base, other)
  assert.equal(told, 1)
  const ready = bundleComparison(base, other, null, () => {})
  assert.deepEqual(ready, { status: 'ready', diff: prepareComparison(base, other) })
  // The same integrities read again, of other content: compared anew, at once.
  const reread = sourcemap('l-other', { 'a.js': 'a3' })
  assert.deepEqual(bundleComparison(base, reread, null, () => {}), { status: 'ready', diff: prepareComparison(base, reread) })
  assert.equal(asked.length, before, 'none asked of the server')
})

test('a failure that may pass is asked again a while after, another not; a session changed asks again at once', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_000_000 })
  const pair = (n) => [sourcemap(`f-base-${n}`, {}, { managedId: `f${n}` }), sourcemap(`f-other-${n}`, {}, { managedId: `g${n}` })]
  const [busyBase, busyOther] = pair(1)
  let told = 0
  bundleComparison(busyBase, busyOther, null, () => { told++ })
  asked.at(-1).reject(Object.assign(new Error('Too many bundles are being compared. Try again shortly.'), { status: 429 }))
  await settle()
  assert.deepEqual(bundleComparison(busyBase, busyOther, null, () => { told++ }), { status: 'error', message: 'Too many bundles are being compared. Try again shortly.' })
  const before = asked.length
  t.mock.timers.tick(5_000)
  assert.equal(told, 2, 'its view painted again once due')
  assert.equal(bundleComparison(busyBase, busyOther, null, () => {}).status, 'loading', 'and asked again')
  assert.equal(asked.length, before + 1)
  asked.at(-1).resolve(answered)
  const [goneBase, goneOther] = pair(2)
  bundleComparison(goneBase, goneOther, null, () => {})
  asked.at(-1).reject(Object.assign(new Error('This bundle is no longer available.'), { status: 404 }))
  await settle()
  t.mock.timers.tick(10 * 60_000)
  assert.equal(bundleComparison(goneBase, goneOther, null, () => {}).status, 'error', 'kept')
  const [movedBase, movedOther] = pair(3)
  const waited = bundleComparisonDiff(movedBase, movedOther)
  asked.at(-1).reject(new DOMException('Managed session changed', 'AbortError'))
  await settle()
  asked.at(-1).resolve(answered)
  assert.equal(await waited, answered, 'asked again under the new session')
})

test('a view drawing a comparison and one waiting for it whole are both told', async () => {
  const [base, other] = [sourcemap('w-base', {}, { managedId: 'w1' }), sourcemap('w-other', {}, { managedId: 'w2' })]
  const waited = bundleComparisonDiff(base, other)
  let told = 0
  bundleComparison(base, other, null, () => { told++ })
  asked.at(-1).resolve(answered)
  assert.equal(await waited, answered)
  assert.equal(told, 1)
  const [lostBase, lostOther] = [sourcemap('x-base', {}, { managedId: 'x1' }), sourcemap('x-other', {}, { managedId: 'x2' })]
  const lost = bundleComparisonDiff(lostBase, lostOther)
  asked.at(-1).reject(Object.assign(new Error('This bundle is no longer available.'), { status: 404 }))
  await assert.rejects(lost, { message: 'This bundle is no longer available.' })
})

test('one waiting for it whole is told of a failure that may pass, and asking again asks the server again at once', async () => {
  const [base, other] = [sourcemap('r-base', {}, { managedId: 'r1' }), sourcemap('r-other', {}, { managedId: 'r2' })]
  const busy = bundleComparisonDiff(base, other)
  asked.at(-1).reject(Object.assign(new Error('Too many bundles are being compared. Try again shortly.'), { status: 429 }))
  await assert.rejects(busy, { message: 'Too many bundles are being compared. Try again shortly.' })
  const before = asked.length
  assert.equal(bundleComparison(base, other, null, () => {}).status, 'error', 'a view drawing it waits for the retry')
  assert.equal(asked.length, before)
  const again = bundleComparisonDiff(base, other)
  assert.equal(asked.length, before + 1, 'Retry asks at once')
  asked.at(-1).resolve(answered)
  assert.equal(await again, answered)
})
