import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { Bundle } from '@exodus/stasis-core/bundle'
import '../ui/view/frontend-install.js'

mock.module('../client/index.js', { namedExports: { state: { bundles: [
  { integrity: 'base', name: 'Before' }, { integrity: 'other', name: 'After' },
] } } })
let handedOff = null, loads = 0
mock.module('../ui/view/bundle-load.js', { namedExports: {
  buildBundleDetails() { loads++; return new Promise(() => {}) },
  handOffBundles(opening, bundles) { handedOff = { opening, bundles: new Map(bundles.filter(Boolean).map(parsed => [parsed.integrity, parsed])) } },
  takeHandedOffBundle(integrity) { const parsed = handedOff?.bundles.get(integrity) ?? null; handedOff?.bundles.delete(integrity); return parsed },
} })
mock.module('../ui/view/bundle-compare-code.js', { namedExports: {} })
mock.module('../ui/view/bundle-selector.js', { namedExports: {} })
mock.module('../ui/view/bundle-scope-selector.js', { namedExports: {} })
mock.module('lit/directives/repeat.js', { namedExports: { repeat: (items, _key, template) => items.map(template) } })
await import('../ui/view/bundle-compare.js')
const Compare = customElements.get('bundle-compare')

function renderText(value) {
  if (Array.isArray(value)) return value.map(renderText).join('')
  if (value?.strings) return value.strings.map((text, i) => text + renderText(value.values[i])).join('')
  return value == null || typeof value === 'symbol' ? '' : String(value)
}
function details(integrity, target) {
  return { integrity, kind: 'stasis', bundle: new Bundle({
    modules: new Map([['.', { name: 'app', version: '1.0.0', files: { 'app.js': 'import "dep"', 'a.js': 'a', 'b.js': 'b' } }]]),
    reason: { deps: ['a.js', 'b.js'] },
    imports: new Map([['node, import', new Map([['app.js', new Map([['dep', target]])]])]]),
  }) }
}
function compare() {
  const view = new Compare()
  view.integrity = 'base'
  view._targetIntegrity = 'other'
  view.details = details('base', 'a.js')
  view._otherDetails = details('other', 'b.js')
  return view
}

test('the summary row offers Overview and Code, Overview first, and a file row opens its diff in Code', () => {
  const view = compare()
  view._status = 'ready'
  const tabs = renderText(view._renderSummary(view._diffFor())).match(/<div class="bundle-compare-modes"[^]*?<\/div>/u)?.[0] ?? ''
  assert.deepEqual([...tabs.matchAll(/aria-selected=(\w+)/gu)].map(m => m[1]), ['true', 'false'])
  assert.deepEqual([...tabs.matchAll(/>(\w+)<\/button>/gu)].map(m => m[1]), ['Overview', 'Code'])
  assert.match(renderText(view.render()), /class="bundle-compare-body"/u)
  view._openFile('app.js')
  assert.equal(view._mode, 'code')
  assert.equal(view._codePath, 'app.js')
})

test('Differences renders resolution-only changes with before/after targets and a summary count', () => {
  const view = compare()
  const markup = renderText(view._renderDiff())
  assert.match(markup, /Import resolutions/u)
  assert.match(markup, /Repointed/u)
  assert.match(markup, /app\.js/u)
  assert.match(markup, /dep/u)
  assert.match(markup, /node, import/u)
  assert.match(markup, /Before<\/span><code[^>]*>a\.js/u)
  assert.match(markup, /After<\/span><code[^>]*>b\.js/u)
  assert.match(markup, /File contents are unchanged; import resolutions differ/u)
  assert.doesNotMatch(markup, /These two bundles carry identical files/u)
  assert.match(renderText(view._renderSummary(view._diffFor())), /1 repointed resolution/u)
  assert.equal(view._diffFor().totals.changedFiles, 0)
})

test('changing scope recomputes resolution changes and restores the identical state when none remain', () => {
  const view = compare()
  assert.equal(view._diffFor().resolutions.totalChanges, 1)
  view._scope = 'reason:deps'
  const markup = renderText(view._renderDiff())
  assert.match(markup, /These two bundles carry identical files/u)
  assert.doesNotMatch(markup, /Import resolutions/u)
  assert.doesNotMatch(renderText(view._renderSummary(view._diffFor())), /repointed resolution/u)
  view._scope = ''
  assert.equal(view._diffFor().resolutions.totalChanges, 1)
})

test('resolution groups cap visible rows while preserving exact counts', () => {
  const view = compare()
  const row = view._diffFor().resolutions.changed[0]
  const rows = Array.from({ length: 405 }, (_, i) => ({ ...row, key: String(i), parent: `file-${i}.js` }))
  const markup = renderText(view._resolutionGroup(rows))
  assert.match(markup, /bundle-compare-group-count">405/u)
  assert.match(markup, /file-399\.js/u)
  assert.doesNotMatch(markup, /file-400\.js/u)
  assert.match(markup, /and 5 more/u)
})

test('added and removed resolutions never appear or contribute to the summary', () => {
  const view = compare()
  view.details.bundle.imports.get('node, import').get('app.js').set('removed-only', 'a.js')
  view._otherDetails.bundle.imports.get('node, import').get('app.js').set('added-only', 'b.js')
  const markup = renderText(view._renderDiff())
  assert.match(markup, /Repointed/u)
  assert.doesNotMatch(markup, /removed-only|added-only/u)
  assert.match(renderText(view._renderSummary(view._diffFor())), /1 repointed resolution/u)
  view._otherDetails.bundle.imports.get('node, import').get('app.js').set('dep', 'a.js')
  view._diffKey = null
  assert.doesNotMatch(renderText(view._renderDiff()), /Import resolutions|Repointed/u)
  assert.doesNotMatch(renderText(view._renderSummary(view._diffFor())), /repointed resolution/u)
})

test('file groups default to name order and sort independently by displayed size', () => {
  const view = compare()
  const rows = [
    { path: 'z.js', bytes: 20, baseBytes: 100, otherBytes: 20, delta: -80 },
    { path: 'a.js', bytes: 0, baseBytes: 200, otherBytes: 0, delta: -200 },
    { path: 'b.js', bytes: 20, baseBytes: 20, otherBytes: 20, delta: 0 },
  ]
  const order = (kind) => {
    const files = kind === 'changed' ? rows.map(({ bytes: _bytes, ...row }) => row) : rows
    const markup = renderText(view._fileGroup(kind, files, kind, path => path))
    return [...markup.matchAll(/class="bundle-compare-row-path mono"[^>]*>(.*?)<\/span>/gu)].map(match => match[1])
  }
  for (const kind of ['removed', 'added', 'changed']) assert.deepEqual(order(kind), ['a.js', 'b.js', 'z.js'])
  for (const kind of ['removed', 'added', 'changed']) {
    view._fileSort = { removed: 'name', added: 'name', changed: 'name', [kind]: 'size' }
    assert.deepEqual(order(kind), ['b.js', 'z.js', 'a.js'])
    for (const other of ['removed', 'added', 'changed'].filter(value => value !== kind)) assert.deepEqual(order(other), ['a.js', 'b.js', 'z.js'])
  }
  assert.deepEqual(rows.map(row => row.path), ['z.js', 'a.js', 'b.js'], 'sorting must not mutate the cached diff')
})

test('file size sorting happens before the visible row limit', () => {
  const view = compare()
  view._fileSort = { ...view._fileSort, added: 'size' }
  const rows = Array.from({ length: 405 }, (_, i) => ({ path: `file-${String(i).padStart(3, '0')}.js`, bytes: i }))
  const markup = renderText(view._fileGroup('Added', rows, 'added', path => path))
  const paths = [...markup.matchAll(/class="bundle-compare-row-path mono"[^>]*>(.*?)<\/span>/gu)].map(match => match[1])
  assert.equal(paths.length, 400)
  assert.equal(paths[0], 'file-404.js')
  assert.equal(paths.at(-1), 'file-005.js')
  assert.match(markup, /bundle-compare-group-count">405/u)
  assert.match(markup, /and 5 more/u)
})

test('Swap hands both parsed bundles to their new roles instead of loading them again', () => {
  const view = compare()
  view._status = 'ready'
  const base = view.details, other = view._otherDetails
  let swapped = null
  view.addEventListener('bundle-swap', event => { swapped = event.detail.integrity })
  view._swap()
  assert.equal(swapped, 'other')
  assert.equal(handedOff.opening, 'other')
  assert.equal(handedOff.bundles.get('other'), other, 'the target opens as the new base without a read')
  // The app opens the old target; the comparison flips onto the old base.
  view.integrity = 'other'
  view.details = other
  view.willUpdate(new Map([['integrity', 'base'], ['details', base]]))
  assert.equal(view._targetIntegrity, 'base')
  assert.equal(view._otherDetails, base)
  assert.equal(view._status, 'ready')
  assert.equal(loads, 0, 'nothing is read again')
  assert.deepEqual([...handedOff.bundles.keys()], ['other'], 'the old base was taken; the new one waits for its open')
})

test('a swap that lands on another bundle is dropped, not resumed later', () => {
  const view = compare()
  view._status = 'ready'
  view._swap()
  view.integrity = 'third'
  view.willUpdate(new Map([['integrity', 'base']]))
  assert.equal(view._targetIntegrity, null)
  view.integrity = 'other'
  view.willUpdate(new Map([['integrity', 'third']]))
  assert.equal(view._targetIntegrity, null, 'opening the swap\'s bundle afterwards starts a fresh comparison')
})

test('dependency updates list Removed, Added and Updated side by side in one row of columns', () => {
  const view = compare()
  const markup = renderText(view._renderVersionUpdates({
    updated: [{ pkg: 'lodash', baseVersions: ['4.17.20'], otherVersions: ['4.17.21'], direction: 'up' }],
    removed: [{ pkg: 'left-pad', versions: ['1.3.0'] }],
    added: [{ pkg: 'zod', versions: ['3.23.8'] }],
    totals: {},
  }, 'Before', 'After'))
  const cols = markup.slice(markup.indexOf('class="bundle-compare-cols"'))
  assert.deepEqual([...cols.matchAll(/class=bundle-compare-group bundle-compare-(\w+)/gu)].map(m => m[1]), ['removed', 'added', 'updated'])
  assert.equal(markup.match(/class="bundle-compare-cols"/gu).length, 1)
})
