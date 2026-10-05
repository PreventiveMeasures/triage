import assert from 'node:assert/strict'
import { beforeEach, mock, test } from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { managedAppState } from '../ui/managed/state.js'
import { clearReportSources, fetchReportSources, readReportSources } from '../ui/managed/report-sources.js'
import { pushed, stepped } from '../ui/view/focus-code-history.js'
import { Bundle } from '@exodus/stasis-core/bundle'
import { highlight } from '../ui/prism.js'
import { langForPath } from '../common/code-language.js'

let fullBundleLoads = 0, localDetails, localFile = 'src/main.js', localIntegrity = 'bundle', managed = true
const state = { focusCodeTick: 0, focusCodeStack: [], focusCodeAt: 0, bundles: [] }
mock.module('../client/index.js', { namedExports: {
  state, isManagedUiMode: () => managed,
  bundleFilePath: (_integrity, path) => path,
  bundlesForFileHash: () => [{ integrity: localIntegrity, file: localFile }],
} })
mock.module('../ui/view/client-managed.js', { namedExports: { fetchReportSources, readReportSources } })
mock.module('../ui/view/bundle-load.js', { namedExports: { buildBundleDetails: () => {
  fullBundleLoads++
  return Promise.resolve(localDetails)
} } })
mock.module('../ui/view/group.js', { namedExports: { activeTabFor: group => group[0] } })
mock.module('../ui/view/format.js', { namedExports: { lineRange: line => line ? { start: Number(line), end: Number(line) } : null } })
mock.module('../ui/view/render.js', { namedExports: { render: () => {} } })
mock.module('../ui/view/dom.js', { namedExports: { report: { querySelectorAll: () => [] } } })
mock.module('../ui/view/prism-highlight.js', { namedExports: { langForPath, highlight: (...args) => Promise.resolve(highlight(...args)) } })
const { attachedBundle, bundleSource, findingSourcePath, focusCodeHistory, focusCodeLinkPosition, focusCodePosition, getFocusCode } = await import('../ui/view/focus-code.js')
const finding = { _managedReportId: 'report/id', _bundleHashes: ['bundle'], file: 'main.js', line: 1, evidence: [{ file: 'evidence.js' }] }
const payload = { integrity: 'bundle', files: [['src/main.js', 'main source'], ['src/evidence.js', 'proof source']], paths: [['main.js', 'src/main.js'], ['evidence.js', 'src/evidence.js']] }
let calls, gate
beforeEach(t => {
  managed = true; fullBundleLoads = 0; calls = []; gate = null
  localIntegrity = 'bundle'
  localFile = 'src/main.js'
  localDetails = { kind: 'sourcemap', json: { sources: ['src/main.js'], sourcesContent: ['local source'] } }
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

test('managed panels highlight only available relative paths and unambiguous recorded imports, with history', async t => {
  const data = {
    ...payload,
    files: [['src/main.js', "const a = './evidence.js'; const b = 'proof'; const c = 'platform'; const d = '../hidden.js';"], ...payload.files.slice(1)],
    imports: [['src/main.js', [['proof', 'src/evidence.js'], ['platform', null], ['../hidden.js', null]]]],
  }
  t.mock.method(globalThis, 'fetch', () => Promise.resolve(Response.json(data)))
  await fetchReportSources(finding._managedReportId)
  getFocusCode([finding])
  await setImmediate()
  const code = getFocusCode([finding])
  assert.equal((code.highlighted.match(/data-bundle-source-link="src\/evidence.js"/gu) ?? []).length, 2)
  assert.equal((code.highlighted.match(/data-bundle-source-link=/gu) ?? []).length, 2)
  state.bundleDetails = { integrity: 'unrelated-bundle' }
  const pos = focusCodeLinkPosition([finding], 'bundle', 'src/main.js', 'src/evidence.js')
  assert.deepEqual(pos, { integrity: 'bundle', file: 'src/evidence.js', range: null })
  assert.equal(focusCodeLinkPosition([finding], 'unrelated-bundle', 'src/main.js', 'src/evidence.js'), null)
  assert.equal(focusCodeLinkPosition([finding], 'bundle', 'stale.js', 'src/evidence.js'), null)
  assert.equal(focusCodeLinkPosition([finding], 'bundle', 'src/main.js', 'hidden.js'), null)
  const next = pushed(focusCodeHistory([finding]), pos)
  state.focusCodeStack = next.stack; state.focusCodeAt = next.at
  assert.equal(getFocusCode([finding]).file, 'src/evidence.js')
  assert.equal(getFocusCode([finding]).range, null)
  state.focusCodeAt = stepped(state.focusCodeStack, state.focusCodeAt, -1)
  assert.equal(getFocusCode([finding]).file, 'src/main.js')
  assert.deepEqual(getFocusCode([finding]).range, { start: 1, end: 1 })
  state.focusCodeAt = stepped(state.focusCodeStack, state.focusCodeAt, 1)
  assert.equal(getFocusCode([finding]).file, 'src/evidence.js')
  assert.equal(fullBundleLoads, 0)
})

test('local Stasis focus/fullscreen sources retain imports across chained navigation', async () => {
  managed = false; localIntegrity = 'source-links-local'
  state.bundles = [{ integrity: localIntegrity, name: 'links.stasis' }]
  localDetails = { kind: 'stasis', bundle: new Bundle({
    modules: new Map([['.', { name: 'app', version: '1', files: {
      'src/main.js': "import x from 'pkg'; const relative = './other.js'; const conflict = 'conflict';",
      'src/other.js': "export { x } from 'pkg';",
      'node_modules/pkg/index.js': "const source = '../../src/other.js';",
    } }]]),
    imports: new Map([
      ['node', new Map([['src/main.js', new Map([['pkg', 'node_modules/pkg/index.js'], ['conflict', 'src/other.js']])], ['src/other.js', new Map([['pkg', 'node_modules/pkg/index.js']])]])],
      ['browser', new Map([['src/main.js', new Map([['pkg', 'node_modules/pkg/index.js'], ['conflict', 'src/main.js']])]])],
    ]),
  }) }
  const local = { file: 'src/main.js', fileHash: 'hash', _bundleHashes: [localIntegrity], line: 1 }
  getFocusCode([local]); await setImmediate()
  getFocusCode([local]); await setImmediate()
  const code = getFocusCode([local])
  assert.match(code.highlighted, /data-bundle-source-link="node_modules\/pkg\/index.js"/u)
  assert.match(code.highlighted, /data-bundle-source-link="src\/other.js"/u)
  assert.equal((code.highlighted.match(/data-bundle-source-link=/gu) ?? []).length, 2)
  const pos = focusCodeLinkPosition([local], localIntegrity, code.file, 'node_modules/pkg/index.js')
  const next = pushed(focusCodeHistory([local]), pos)
  state.focusCodeStack = next.stack; state.focusCodeAt = next.at
  await setImmediate()
  assert.match(getFocusCode([local]).highlighted, /data-bundle-source-link="src\/other.js"/u)
  assert.equal(focusCodeLinkPosition([local], localIntegrity, pos.file, 'src/other.js').file, 'src/other.js')
  assert.equal(fullBundleLoads, 1); assert.equal(calls.length, 0)
})

test('local focus and fullscreen previews link package imports using a manifest captured as a resource', async () => {
  managed = false; localIntegrity = 'package-import-links-local'
  state.bundles = [{ integrity: localIntegrity, name: 'aliases.stasis' }]
  localDetails = { kind: 'stasis', bundle: new Bundle({
    modules: new Map([['.', { name: 'app', version: '1', files: {
      'package.json': JSON.stringify({ imports: { '#local/*': './_local/*' } }),
      'src/main.js': "import { linking } from '#local/linking';",
      '_local/linking/index.js': 'export const linking = true;',
    } }]]),
    formats: new Map([['package.json', 'resource']]),
    imports: new Map([['node', new Map([['src/main.js', new Map([['./_local/linking', '_local/linking/index.js']])]])]]),
  }) }
  const local = { file: 'src/main.js', fileHash: 'hash', _bundleHashes: [localIntegrity], line: 1 }
  getFocusCode([local]); await setImmediate()
  getFocusCode([local]); await setImmediate()
  assert.match(getFocusCode([local]).highlighted, /data-bundle-source-link="_local\/linking\/index.js"/u)
  assert.match(bundleSource(localIntegrity, 'src/main.js').highlighted, /data-bundle-source-link="_local\/linking\/index.js"/u)
  assert.deepEqual(focusCodeLinkPosition([local], localIntegrity, 'src/main.js', '_local/linking/index.js'), {
    integrity: localIntegrity, file: '_local/linking/index.js', range: null,
  })
  assert.equal(fullBundleLoads, 1)
})

async function checkWorkspacePreviews(t, mode, ownManifest) {
  const file = 'packages/app/src/main.js', target = 'packages/app/local.js'
  const rootFiles = { 'package.json': JSON.stringify({ imports: { '#local': './shared.js' } }), 'shared.js': '' }
  const workspaceFiles = { 'src/main.js': "import x from '#local'; import y from '#direct';", 'local.js': '' }
  if (ownManifest) workspaceFiles['package.json'] = JSON.stringify({ imports: { '#local': './local.js' } })
  const imports = [[file, [['./shared.js', 'shared.js'], ['./local.js', target], ['#direct', 'shared.js']]]]
  const integrity = `workspace-${mode}-${ownManifest}`, reportId = `workspace-report-${ownManifest}`
  const scopedFinding = { file, fileHash: 'hash', line: 1, evidence: [], _bundleHashes: [integrity] }
  if (mode === 'managed') {
    scopedFinding._managedReportId = reportId
    const files = [...Object.entries(rootFiles), ...Object.entries(workspaceFiles).map(([path, content]) => [`packages/app/${path}`, content])]
    t.mock.method(globalThis, 'fetch', () => Promise.resolve(Response.json({
      integrity, files, paths: [[file, file]], imports,
      packageDirs: files.map(([path]) => [path, path.startsWith('packages/app/') ? 'packages/app' : '.']),
    })))
    await fetchReportSources(reportId)
  } else {
    managed = false; localIntegrity = integrity; localFile = file
    state.bundles = [{ integrity, name: 'workspace.stasis' }]
    localDetails = { kind: 'stasis', bundle: new Bundle({
      modules: new Map([['.', { files: rootFiles }], ['packages/app', { files: workspaceFiles }]]),
      formats: new Map([['package.json', 'resource'], ...(ownManifest ? [['packages/app/package.json', 'resource']] : [])]),
      imports: new Map([['node', new Map(imports.map(([parent, edges]) => [parent, new Map(edges)]))]]),
    }) }
  }
  getFocusCode([scopedFinding]); await setImmediate()
  getFocusCode([scopedFinding]); await setImmediate()
  const code = getFocusCode([scopedFinding])
  assert.match(code.highlighted, /data-bundle-source-link="shared\.js"/u)
  assert.equal(code.highlighted.includes(`data-bundle-source-link="${target}"`), ownManifest)
  assert.equal((code.highlighted.match(/data-bundle-source-link=/gu) ?? []).length, ownManifest ? 2 : 1)
  const fullscreen = bundleSource(integrity, file, { reportId: mode === 'managed' ? reportId : null })
  assert.equal(fullscreen.highlighted, code.highlighted)
  assert.equal(fullBundleLoads, mode === 'local' ? 1 : 0)
}

for (const mode of ['local', 'managed']) {
  for (const ownManifest of [false, true]) {
    test(`${mode} focus and fullscreen previews respect workspace boundaries (own manifest: ${ownManifest})`, t => checkWorkspacePreviews(t, mode, ownManifest))
  }
}

test('local and managed finding previews retain the format for an extensionless source', async t => {
  const content = 'const example = require("pkg")', path = 'bin/example'
  t.mock.method(globalThis, 'fetch', () => Promise.resolve(Response.json({ integrity: 'format-managed',
    files: [[path, content]], paths: [['example', path]], formats: [[path, 'commonjs']] })))
  await fetchReportSources('format-report')
  bundleSource('format-managed', 'example', { reportId: 'format-report' })
  await setImmediate()
  assert.match(bundleSource('format-managed', path, { reportId: 'format-report' }).highlighted, /class="token keyword">const/u)

  managed = false; localIntegrity = 'format-local'
  state.bundles = [{ integrity: localIntegrity, name: 'formats.stasis' }]
  localDetails = { kind: 'stasis', bundle: new Bundle({
    modules: new Map([['.', { files: { [path]: content } }]]), formats: new Map([[path, 'commonjs']]),
  }) }
  bundleSource(localIntegrity, path)
  await setImmediate()
  bundleSource(localIntegrity, path)
  await setImmediate()
  assert.match(bundleSource(localIntegrity, path).highlighted, /class="token keyword">const/u)
})

const sourceCatalog = (bundles = []) => [
  { id: 'team', reports: [{ id: 'report/id', cacheKey: 'unchanged' }], bundles },
  { id: 'unrelated', reports: [{ id: 'other', cacheKey: 'unchanged' }], bundles: [] },
]
const sourceBundle = { id: 'bundle', filename: 'source.stasis', repoFullName: 'org/repo' }

for (const status of [204, 404]) {
  test(`a bundle upload clears a cached ${status} and fetches newly linked report sources`, async t => {
    let available = false, reads = 0
    t.mock.method(globalThis, 'fetch', () => {
      reads++
      return Promise.resolve(available ? Response.json(payload) : new Response(null, { status }))
    })
    managedAppState.setReportCatalog(sourceCatalog())
    assert.equal(await fetchReportSources('report/id', 'team'), null)
    available = true
    managedAppState.setReportCatalog(sourceCatalog([sourceBundle]))
    assert.equal(readReportSources('report/id', 'team'), undefined)
    assert.equal((await fetchReportSources('report/id', 'team')).sources.get('src/main.js'), 'main source')
    assert.equal(reads, 2)
  })

  test(`a repaired report link clears cached ${status} sources with an unchanged bundle catalog`, async t => {
    let available = false, reads = 0
    t.mock.method(globalThis, 'fetch', () => {
      reads++
      return Promise.resolve(available ? Response.json(payload) : new Response(null, { status }))
    })
    managedAppState.setReportCatalog(sourceCatalog([sourceBundle]))
    for (const team of ['team', undefined]) assert.equal(await fetchReportSources('report/id', team), null)
    available = true
    const repaired = sourceCatalog([sourceBundle])
    repaired[0].reports[0].cacheKey = 'linked'
    const changed = managedAppState.setReportCatalog(repaired)
    assert.ok(changed.has('team:team'), 'reload the focused team')
    assert.ok(changed.has('report/id'), 'reload the focused report')
    assert.equal(changed.has('bundle:bundle'), false)
    for (const team of ['team', undefined]) {
      assert.equal(readReportSources('report/id', team), undefined)
      assert.equal((await fetchReportSources('report/id', team)).sources.get('src/main.js'), 'main source')
    }
    assert.equal(reads, 4)
  })
}

test('bundle removal evicts scoped and privileged source caches and cancels stale reads', async () => {
  managedAppState.setReportCatalog(sourceCatalog([sourceBundle]))
  await fetchReportSources('report/id')
  await fetchReportSources('other', 'unrelated')
  gate = Promise.withResolvers()
  const loading = fetchReportSources('report/id', 'team')
  const rejected = assert.rejects(loading, { name: 'AbortError' })
  const pendingSignal = calls.at(-1).options.signal
  managedAppState.setReportCatalog(sourceCatalog())
  assert.equal(pendingSignal.aborted, true)
  assert.equal(readReportSources('report/id'), undefined)
  assert.equal(readReportSources('report/id', 'team'), undefined)
  assert.ok(readReportSources('other', 'unrelated').data, 'other team sources stay cached')
  gate.resolve(); await rejected
  assert.equal(readReportSources('report/id', 'team'), undefined, 'old bytes cannot repopulate the cache')
})
