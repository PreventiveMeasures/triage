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
function details(integrity, target, conditions = 'node, import') {
  return { integrity, kind: 'stasis', bundle: new Bundle({
    modules: new Map([['.', { name: 'app', version: '1.0.0', files: { 'app.js': 'import "dep"', 'a.js': 'a', 'b.js': 'b' } }]]),
    reason: { deps: ['a.js', 'b.js'] },
    imports: new Map([[conditions, new Map([['app.js', new Map([['dep', target]])]])]]),
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

test('Differences renders resolution-only changes as a collapsed File | Import | Before | After | Conditions table and a summary count', () => {
  const view = compare()
  const collapsed = renderText(view._renderDiff())
  assert.match(collapsed, /<summary class="bundle-compare-section-head"[^]*?>Import resolutions <span class="bundle-compare-section-count">1/u)
  assert.doesNotMatch(collapsed, /<table/u, 'collapsed by default')
  view._openSections = new Set(['resolutions'])
  const markup = renderText(view._renderDiff())
  assert.match(markup, /Repointed/u)
  assert.match(markup, /<th>File<\/th><th>Import<\/th><th>Before<\/th><th>After<\/th><th>Conditions<\/th>/u)
  const row = markup.slice(markup.indexOf('<tbody>'))
  // Lazy up to the tag's end: a click handler renders inline here, `=>` and all.
  const cells = [...row.matchAll(/<td[^>]*>\s*<(?:button|code|span)[^]*?>([^<>]*)</gu)].map(m => m[1])
  assert.deepEqual(cells, ['app.js', 'dep', 'a.js', 'b.js', 'node, import'])
  assert.match(markup, /File contents are unchanged; import resolutions differ/u)
  assert.doesNotMatch(markup, /These two bundles carry identical files/u)
  assert.match(renderText(view._renderSummary(view._diffFor())), /1 repointed resolution/u)
  assert.equal(view._diffFor().totals.changedFiles, 0)
})

test('Repointed drops the Conditions column when every row reads `*`', () => {
  const view = compare()
  view.details = details('base', 'a.js', '*')
  view._otherDetails = details('other', 'b.js', '*')
  view._openSections = new Set(['resolutions'])
  const markup = renderText(view._renderDiff())
  assert.match(markup, /<th>File<\/th><th>Import<\/th><th>Before<\/th><th>After<\/th><\/tr>/u)
  assert.match(markup, /<table class=bundle-compare-resolutions--no-context>/u)
  assert.doesNotMatch(markup, /bundle-compare-resolution-context/u)
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
  view._openSections = new Set(['resolutions'])
  const markup = renderText(view._renderResolutions({ changed: rows, totalChanges: rows.length }))
  assert.match(markup, /bundle-compare-group-count">405/u)
  assert.match(markup, /file-399\.js/u)
  assert.doesNotMatch(markup, /file-400\.js/u)
  assert.match(markup, /and 5 more/u)
})

test('added and removed resolutions never appear or contribute to the summary', () => {
  const view = compare()
  view.details.bundle.imports.get('node, import').get('app.js').set('removed-only', 'a.js')
  view._otherDetails.bundle.imports.get('node, import').get('app.js').set('added-only', 'b.js')
  view._openSections = new Set(['resolutions'])
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
    // Changed orders by the size of the change (200, 80, 0), the others by size.
    assert.deepEqual(order(kind), kind === 'changed' ? ['a.js', 'z.js', 'b.js'] : ['b.js', 'z.js', 'a.js'])
    for (const other of ['removed', 'added', 'changed'].filter(value => value !== kind)) assert.deepEqual(order(other), ['a.js', 'b.js', 'z.js'])
  }
  assert.deepEqual(rows.map(row => row.path), ['z.js', 'a.js', 'b.js'], 'sorting must not mutate the cached diff')
})

test('file groups list every file, in a list that scrolls, in the order chosen', () => {
  const view = compare()
  view._fileSort = { ...view._fileSort, added: 'size' }
  const rows = Array.from({ length: 405 }, (_, i) => ({ path: `file-${String(i).padStart(3, '0')}.js`, bytes: i }))
  const markup = renderText(view._fileGroup('Added', rows, 'added', path => path))
  const paths = [...markup.matchAll(/class="bundle-compare-row-path mono"[^>]*>(.*?)<\/span>/gu)].map(match => match[1])
  assert.equal(paths.length, 405)
  assert.equal(paths[0], 'file-404.js')
  assert.equal(paths.at(-1), 'file-000.js')
  assert.match(markup, /class=bundle-compare-rows bundle-compare-rows--scroll/u)
  assert.doesNotMatch(markup, /more…/u)
})

test('the Files section is collapsed until opened, then lists Removed | Added | Changed', () => {
  const view = compare()
  view._otherDetails.bundle.modules.get('.').files['a.js'] = 'changed'
  view._diffKey = null
  const collapsed = renderText(view._renderDiff())
  assert.match(collapsed, /<summary class="bundle-compare-section-head"[^]*?>Files <span class="bundle-compare-section-count">1/u)
  const filesPart = markup => markup.slice(markup.indexOf('>Files <span'))
  assert.doesNotMatch(filesPart(collapsed), /bundle-compare-cols/u)
  view._openSections = new Set(['files'])
  assert.match(filesPart(renderText(view._renderDiff())), /bundle-compare-cols[^]*bundle-compare-changed/u)
})

test('Swap hands both parsed bundles to their new roles instead of loading them again', () => {
  const view = compare()
  view._status = 'ready'
  const base = view.details, other = view._otherDetails
  let swapped = null
  view.addEventListener('bundle-swap', event => {
    swapped = event.detail.integrity
    // What events.js does: hand both over for the swap's navigation.
    handedOff = { bundles: new Map(event.detail.bundles.map(parsed => [parsed.integrity, parsed])) }
  })
  view._swap()
  assert.equal(swapped, 'other')
  assert.equal(handedOff.bundles.get('other'), other, 'the target opens as the new base without a read')
  assert.equal(handedOff.bundles.get('base'), base, 'and the old base rides along to be compared against')
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

test('packages list Removed | Added | Changed, each package once with its versions and sizes', async () => {
  const { comparePackages } = await import('../ui/view/bundle-compare-diff.js')
  const view = compare()
  const rows = comparePackages(
    { onlyBase: [{ pkg: 'left-pad', bytes: 40 }], onlyOther: [{ pkg: 'zod', bytes: 90 }],
      changed: [{ pkg: '__own__', baseBytes: 100, otherBytes: 120, delta: 20 }, { pkg: 'lodash', baseBytes: 50, otherBytes: 60, delta: 10 }],
      unchanged: [{ pkg: 'react', bytes: 70 }] },
    new Map([['left-pad', new Set(['1.3.0'])], ['lodash', new Set(['4.17.20'])], ['react', new Set(['18.2.0'])]]),
    new Map([['zod', new Set(['3.23.8'])], ['lodash', new Set(['4.17.21'])], ['react', new Set(['18.3.0'])]]),
  )
  const markup = renderText(view._renderPackages(rows, 'Before', 'After'))
  assert.deepEqual([...markup.matchAll(/class=bundle-compare-group bundle-compare-(\w+)/gu)].map(m => m[1]), ['removed', 'added', 'changed'])
  assert.equal([...markup.matchAll(/aria-label=(?:removed|added|changed) package order/gu)].length, 3, 'each group orders by Name | Size')
  const changed = markup.slice(markup.indexOf('bundle-compare-group bundle-compare-changed'))
  const row = name => changed.match(new RegExp(`data-tooltip=${name}>${name}</span>[^]*?</li>`, 'u'))[0]
  assert.match(row('lodash'), /4\.17\.20<\/span>[^]*4\.17\.21[^]*↑[^]*data-tooltip=50 B → 60 B>\+10 B</u)
  assert.match(row('react'), /18\.2\.0[^]*18\.3\.0[^]*data-tooltip=70 B → 70 B>±0 B</u, 'a version-only change keeps its (equal) sizes')
  assert.match(row('Own source'), /data-tooltip=100 B → 120 B>\+20 B</u)
  assert.doesNotMatch(changed, /bundle-compare-row-size/u, 'a changed row shows its sizes only in the tooltip')
  assert.doesNotMatch(row('Own source'), /bundle-compare-ver/u, 'own source carries sizes alone')
  assert.match(markup, /left-pad<\/span>\s*<span class="bundle-compare-dep-ver" data-tooltip-truncated data-tooltip=1\.3\.0>1\.3\.0/u)
  const changedOrder = () => {
    const group = renderText(view._renderPackages(rows, 'Before', 'After'))
    return [...group.slice(group.indexOf('bundle-compare-group bundle-compare-changed')).matchAll(/bundle-compare-row-path" data-tooltip-truncated data-tooltip=([^>]+)>/gu)].map(m => m[1])
  }
  assert.deepEqual(changedOrder(), ['Own source', 'lodash', 'react'], 'size order by default')
  view._pkgSort = { ...view._pkgSort, changed: 'name' }
  assert.deepEqual(changedOrder(), ['lodash', 'Own source', 'react'])
  view._pkgSort = { ...view._pkgSort, changed: 'size' }
  rows.changed.push({ pkg: 'axios', baseBytes: 5, otherBytes: 15, delta: 10, baseVersions: [], otherVersions: [], direction: null })
  assert.deepEqual(changedOrder(), ['Own source', 'axios', 'lodash', 'react'], 'the largest change first, name breaking ties')
})

test('a package installed under an npm alias keeps one row, its versions joined to its sizes', () => {
  const side = (integrity, version, code) => ({ integrity, kind: 'stasis', bundle: new Bundle({
    modules: new Map([['.', { name: 'app', version: '1.0.0', files: { 'app.js': 'app' } }],
      ['node_modules/alias', { name: 'actual-package', version, files: { 'index.js': code } }]]),
  }) })
  const view = compare()
  view.details = side('base', '1.0.0', 'one')
  view._otherDetails = side('other', '1.1.0', 'one, two')
  view._diffKey = null
  const { packageRows } = view._diffFor()
  assert.deepEqual(packageRows.removed, [])
  assert.deepEqual(packageRows.added, [])
  assert.deepEqual(packageRows.changed, [{ pkg: 'alias', baseBytes: 3, otherBytes: 8, delta: 5,
    baseVersions: ['1.0.0'], otherVersions: ['1.1.0'], direction: 'up' }])
})

test('a request picks the bundle and mode to compare with; the user\'s picks and mode switches are reported', () => {
  const view = new Compare()
  const reported = []
  view.addEventListener('bundle-compare-change', event => reported.push(event.detail))
  view.integrity = 'base'
  view.details = details('base', 'a.js')
  view.request = { bundle: 'base', target: 'other', mode: 'code' }
  const before = loads
  view.willUpdate(new Map([['integrity', undefined], ['details', undefined], ['request', undefined]]))
  assert.equal(view._targetIntegrity, 'other')
  assert.equal(view._mode, 'code')
  assert.equal(view._status, 'loading')
  assert.equal(loads, before + 1)
  view.request = { ...view.request }
  view.willUpdate(new Map([['request', null]]))
  assert.equal(loads, before + 1, 'the bundle already compared with is not read again')
  view.request = { bundle: 'elsewhere', target: 'base', mode: 'overview' }
  view.willUpdate(new Map([['request', null]]))
  assert.equal(view._targetIntegrity, 'other', 'another bundle\'s request is not this one\'s')
  assert.deepEqual(reported, [], 'what was asked for is not reported back')
  view._openFile('a.js')
  view._pick(null)
  assert.deepEqual(reported, [{ base: 'base', target: 'other', mode: 'code' }, { base: 'base', target: null, mode: 'code' }])
})

test('a withdrawn request — the same bundle reopened on a bare Compare route — clears the comparison', () => {
  const view = new Compare()
  view.integrity = 'base'
  view.details = details('base', 'a.js')
  view.request = { bundle: 'base', target: 'other', mode: 'code' }
  view.willUpdate(new Map([['integrity', undefined], ['details', undefined], ['request', undefined]]))
  assert.equal(view._targetIntegrity, 'other')
  const previous = view.request
  view.request = null
  view.willUpdate(new Map([['request', previous]]))
  assert.equal(view._targetIntegrity, null)
  assert.equal(view._mode, 'overview')
  assert.equal(view._status, 'idle')
  // A comparison picked with no request (local bundles) is left alone.
  view._choose('other')
  view.willUpdate(new Map([['request', null]]))
  assert.equal(view._targetIntegrity, 'other')
})

test('a section heading opens and closes its section through the render, contents with it', () => {
  const view = compare()
  const summaryClick = () => view._collapsible('files', 'Files', 1, () => 'rows').values.find(value => typeof value === 'function' && /preventDefault/u.test(String(value)))
  let prevented = 0
  summaryClick()({ preventDefault() { prevented++ } })
  assert.equal(prevented, 1, 'the browser does not open it a frame ahead of its contents')
  assert.ok(view._openSections.has('files'))
  assert.match(renderText(view._collapsible('files', 'Files', 1, () => 'rows')), /rows/u)
  summaryClick()({ preventDefault() { prevented++ } })
  assert.ok(!view._openSections.has('files'))
  view._setSection('files', true)
  assert.ok(view._openSections.has('files'), 'a toggle the browser makes on its own still lands')
})

test('no "Changes from" caption; the root the file rows leave out rides on the Files heading', () => {
  const side = (integrity, code) => ({ integrity, kind: 'stasis', bundle: new Bundle({
    modules: new Map([['.', { name: 'app', version: '1.0.0', files: { 'src/app.js': code, 'src/util.js': code } }]]),
  }) })
  const view = compare()
  view.details = side('base', 'one')
  view._otherDetails = side('other', 'one, two')
  view._diffKey = null
  const markup = renderText(view._renderDiff())
  assert.doesNotMatch(markup, /Changes from/u)
  assert.match(markup, /Files <span class="bundle-compare-section-count">2<\/span><span class="bundle-compare-section-note" data-tooltip-truncated data-tooltip=src\/>src\/<\/span><\/summary>/u)
})

test('Files lines up under Packages\' lanes, or lays out its own when it lists a kind Packages lacks', () => {
  const side = (integrity, files) => ({ integrity, kind: 'stasis', bundle: new Bundle({
    modules: new Map([['.', { name: 'app', version: '1.0.0', files }],
      ...integrity === 'base' ? [['node_modules/gone', { name: 'gone', version: '1.0.0', files: { 'index.js': 'g' } }]] : []]),
  }) })
  const lanesOf = (base, other) => {
    const view = compare()
    view.details = side('base', base)
    view._otherDetails = side('other', other)
    view._diffKey = null
    view._openSections = new Set(['files'])
    return [...renderText(view._renderDiff()).matchAll(/class="bundle-compare-cols" data-lanes=(\d)/gu)].map(m => m[1])
  }
  // Packages: Removed (gone) | Changed (own source); Files the same kinds,
  // laid out in Packages' lanes.
  assert.deepEqual(lanesOf({ 'src/app.js': 'one' }, { 'src/app.js': 'one, two' }), ['2', '2'])
  // Files also adds one: Packages keeps its two lanes, Files lays out three.
  assert.deepEqual(lanesOf({ 'src/app.js': 'one' }, { 'src/app.js': 'one, two', 'src/new.js': 'n' }), ['2', '3'])
})
