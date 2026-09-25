import assert from 'node:assert/strict'
import { beforeEach, mock, test } from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { managedAppState } from '../ui/managed/state.js'
import { clearReportSources, fetchReportSources, readReportSources } from '../ui/managed/report-sources.js'
import { pushed, stepped } from '../ui/view/focus-code-history.js'

let fullBundleLoads = 0, managed = true
const state = { focusCodeTick: 0, focusCodeStack: [], focusCodeAt: 0, bundles: [] }
mock.module('../client/index.js', { namedExports: {
  state, isManagedUiMode: () => managed,
  bundleFilePath: (_integrity, path) => path,
  bundlesForFileHash: () => [{ integrity: 'bundle', file: 'src/main.js' }],
} })
mock.module('../ui/view/client-managed.js', { namedExports: { fetchReportSources, readReportSources } })
mock.module('../ui/view/bundle-load.js', { namedExports: { buildBundleDetails: () => {
  fullBundleLoads++
  return Promise.resolve({ kind: 'sourcemap', json: { sources: ['src/main.js'], sourcesContent: ['local source'] } })
} } })
mock.module('../ui/view/group.js', { namedExports: { activeTabFor: group => group[0] } })
mock.module('../ui/view/format.js', { namedExports: { lineRange: line => line ? { start: Number(line), end: Number(line) } : null } })
mock.module('../ui/view/render.js', { namedExports: { render: () => {} } })
mock.module('../ui/view/dom.js', { namedExports: { report: { querySelectorAll: () => [] } } })
mock.module('../ui/view/prism-highlight.js', { namedExports: { langForPath: () => null, highlight: () => Promise.resolve(null) } })
const { attachedBundle, bundleSource, findingSourcePath, focusCodeHistory, focusCodePosition, getFocusCode } = await import('../ui/view/focus-code.js')
const finding = { _managedReportId: 'report/id', _bundleHashes: ['bundle'], file: 'main.js', line: 1, evidence: [{ file: 'evidence.js' }] }
const payload = { integrity: 'bundle', files: [['src/main.js', 'main source'], ['src/evidence.js', 'proof source']], paths: [['main.js', 'src/main.js'], ['evidence.js', 'src/evidence.js']] }
let calls, gate
beforeEach(t => {
  managed = true; fullBundleLoads = 0; calls = []; gate = null
  state.focusCodeStack = []; state.focusCodeAt = 0
  managedAppState.reset(); managedAppState.setSession({ id: 'alice', role: 'view' })
  t.mock.method(managedAppState, 'notify', () => {})
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options })
    if (gate) await gate.promise
    return Response.json(payload)
  })
})

test('rendering source controls is lazy; focused/fullscreen panels share one report request', async () => {
  assert.ok(attachedBundle(finding), 'findings need no file hash or bundle metadata in managed mode')
  assert.equal(calls.length, 0)
  gate = Promise.withResolvers()
  assert.deepEqual(getFocusCode([finding]), { loading: true })
  assert.deepEqual(getFocusCode([finding]), { loading: true })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, '/api/reports/report%2Fid/sources')
  assert.equal(calls[0].options.cache, 'no-store')
  gate.resolve(); await setImmediate()
  assert.equal(getFocusCode([finding]).content, 'main source')
  assert.equal(getFocusCode([finding]).file, 'src/main.js')
  assert.equal(findingSourcePath(attachedBundle(finding), 'evidence.js'), 'src/evidence.js')
  assert.equal(findingSourcePath(attachedBundle(finding), 'missing.js'), null)
  assert.equal(bundleSource('bundle', 'src/evidence.js', { reportId: finding._managedReportId }).content, 'proof source')
  assert.equal(calls.length, 1); assert.equal(fullBundleLoads, 0)
})

test('managed navigation waits for the actual bundle and resolved paths, then retains evidence history', async () => {
  const multiple = { ...finding, _bundleHashes: ['unavailable-bundle', 'bundle'] }
  gate = Promise.withResolvers()
  assert.deepEqual(getFocusCode([multiple]), { loading: true })
  assert.equal(attachedBundle(multiple).integrity, null, 'do not guess the first declared bundle')
  assert.equal(focusCodeHistory([multiple]), null, 'no history can be seeded by a click during loading')
  assert.equal(focusCodePosition(multiple), null)
  gate.resolve(); await setImmediate()
  const bundle = attachedBundle(multiple)
  assert.equal(bundle.integrity, 'bundle')
  const base = focusCodeHistory([multiple]).base
  assert.equal(base.file, 'src/main.js', 'resolve the source path before seeding history, too')
  const evidence = { integrity: bundle.integrity, file: findingSourcePath(bundle, 'evidence.js'), range: { start: 2, end: 2 } }
  const next = pushed(focusCodeHistory([multiple]), evidence)
  state.focusCodeStack = next.stack; state.focusCodeAt = next.at
  assert.deepEqual(focusCodePosition(multiple), evidence)
  assert.equal(getFocusCode([multiple]).content, 'proof source')
  assert.equal(focusCodeHistory([multiple]).stack.length, 2)
  state.focusCodeAt = stepped(state.focusCodeStack, state.focusCodeAt, -1)
  assert.deepEqual(focusCodePosition(multiple), base)
  assert.equal(getFocusCode([multiple]).content, 'main source')
  state.focusCodeAt = stepped(state.focusCodeStack, state.focusCodeAt, 1)
  assert.equal(getFocusCode([multiple]).content, 'proof source')
  assert.equal(calls.length, 1)
})

test('opening a code preview loads only its report and retains no whole bundle', async () => {
  const bundle = attachedBundle(finding)
  assert.equal(bundleSource(bundle.integrity, 'evidence.js', { reportId: bundle.reportId, kick: false }), null)
  assert.equal(calls.length, 0)
  assert.deepEqual(bundleSource(bundle.integrity, 'evidence.js', { reportId: bundle.reportId }), { loading: true })
  await setImmediate()
  assert.equal(bundleSource(bundle.integrity, 'evidence.js', { reportId: bundle.reportId }).content, 'proof source')
  assert.equal(readReportSources('other-report'), undefined)
  assert.equal(calls.length, 1); assert.equal(fullBundleLoads, 0)
})

test('a missing primary location can still show evidence, using its own line range', async () => {
  await fetchReportSources(finding._managedReportId)
  const code = getFocusCode([{ ...finding, file: 'missing.js', line: 99, evidence: [{ file: 'evidence.js', line: 2 }] }])
  assert.equal(code.content, 'proof source')
  assert.equal(code.file, 'src/evidence.js')
  assert.deepEqual(code.range, { start: 2, end: 2 })
})

test('no declared bundle does nothing; an unavailable linked bundle quietly drops source controls', async t => {
  assert.equal(getFocusCode([{ ...finding, _bundleHashes: [] }]), null)
  assert.equal(calls.length, 0)
  t.mock.method(globalThis, 'fetch', () => Promise.resolve(new Response(null, { status: 204 })))
  assert.deepEqual(getFocusCode([finding]), { loading: true })
  await setImmediate()
  assert.equal(attachedBundle(finding), null)
  assert.equal(getFocusCode([finding]), null)
  assert.equal(fullBundleLoads, 0)
})

async function checkReset(reset) {
  gate = Promise.withResolvers()
  const loading = fetchReportSources('report/id')
  const rejected = assert.rejects(loading, { name: 'AbortError' })
  reset()
  assert.equal(calls[0].options.signal.aborted, true)
  gate.resolve()
  await rejected
  assert.equal(readReportSources('report/id'), undefined)
  managedAppState.setSession({ id: 'alice', role: 'view' })
  assert.equal((await fetchReportSources('report/id')).sources.get('src/main.js'), 'main source')
  assert.equal(calls.length, 2)
  reset()
  assert.equal(readReportSources('report/id'), undefined)
}

for (const [name, reset] of [
  ['logout', () => managedAppState.setSession(null)],
  ['role change', () => managedAppState.setSession({ id: 'alice', role: 'none' })],
  ['mode change', () => managedAppState.reset()],
  ['report reload', () => clearReportSources()],
]) {
  test(`${name} clears memory and discards a stale source response`, () => checkReset(reset))
}

test('failed requests do not retry on every render; reloading allows retry', async t => {
  const network = t.mock.method(globalThis, 'fetch', () => Promise.resolve(new Response(null, { status: 503 })))
  assert.deepEqual(getFocusCode([finding]), { loading: true })
  await setImmediate()
  assert.equal(getFocusCode([finding]), null)
  assert.equal(network.mock.callCount(), 1)
  clearReportSources()
  assert.deepEqual(getFocusCode([finding]), { loading: true })
  await setImmediate()
  assert.equal(network.mock.callCount(), 2)
})

test('local/e2e findings keep their existing full-bundle path', async () => {
  managed = false
  state.bundles = [{ integrity: 'bundle', name: 'bundle.map' }]
  const local = { file: 'src/main.js', fileHash: 'hash', _bundleHashes: ['bundle'], line: 1 }
  assert.deepEqual(getFocusCode([local]), { loading: true })
  await setImmediate()
  assert.equal(getFocusCode([local]).content, 'local source')
  assert.equal(fullBundleLoads, 1); assert.equal(calls.length, 0)
})
