import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { Bundle } from '@exodus/stasis-core/bundle'
import { templateText as renderText, templates } from './_lit.js'

mock.module('../client/index.js', { namedExports: { state: { bundles: [
  { integrity: 'base', name: 'Before' }, { integrity: 'other', name: 'After' },
] } } })
let handedOff = null, loads = 0
mock.module('../ui/view/bundle-load.js', { namedExports: {
  buildBundleDetails() { loads++; return new Promise(() => {}) },
  takeHandedOffBundle(integrity) { const parsed = handedOff?.bundles.get(integrity) ?? null; handedOff?.bundles.delete(integrity); return parsed },
} })
mock.module('../ui/view/bundle-compare-code.js', { namedExports: {} })
// The rows the Diff view would list, as each test sets them.
let combinedRows = 10
mock.module('../ui/view/bundle-compare-all.js', { namedExports: {
  COMBINED_DIFF_MAX: 25_000, combinedDiffRows: () => ({ rows: combinedRows, models: new Map() }),
} })
mock.module('../ui/view/bundle-selector.js', { namedExports: {} })
mock.module('../ui/view/bundle-scope-selector.js', { namedExports: {} })
mock.module('lit/directives/repeat.js', { namedExports: { repeat: (items, _key, template) => items.map(template) } })
// The server's comparisons (bundle-comparison.js), of bundles none of these are.
mock.module('../ui/view/client-managed.js', { namedExports: {
  fetchBundleComparison: () => Promise.reject(new Error('not a managed bundle')), fetchNpmComparison: () => Promise.reject(new Error('not an npm version')),
} })
await import('../ui/view/bundle-compare.js')
const { npmDependencyFlagTags } = await import('../ui/view/npm-dependency-checks.js')
const Compare = customElements.get('bundle-compare')
const { state: compareState } = await import('../client/index.js')

function details(integrity, target, conditions = 'node, import') {
  return { integrity, kind: 'stasis', bundle: new Bundle({
    modules: new Map([['.', { name: 'app', version: '1.0.0', files: { 'app.js': 'import "dep"', 'a.js': 'a', 'b.js': 'b' } }]]),
    reason: { deps: ['a.js', 'b.js'] },
    imports: new Map([[conditions, new Map([['app.js', new Map([['dep', target]])]])]]),
  }) }
}
// Bundles opened here are compared here, at once once the chunk that does it
// is loaded (bundle-comparison.js): loaded before the views are drawn.
const { bundleComparisonDiff } = await import('../ui/view/bundle-comparison.js')
await bundleComparisonDiff(details('base', 'a.js'), details('other', 'b.js'))
// The comparison a view draws.
function diffOf(view) {
  const paired = view._comparison()
  assert.equal(paired.status, 'ready')
  return paired.diff
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
  const tabs = renderText(view._renderSummary(diffOf(view))).match(/<div class="bundle-compare-modes"[^]*?<\/div>/u)?.[0] ?? ''
  assert.deepEqual([...tabs.matchAll(/aria-selected=(\w+)/gu)].map(m => m[1]), ['true', 'false'])
  assert.deepEqual([...tabs.matchAll(/>(\w+)<\/button>/gu)].map(m => m[1]), ['Overview', 'Code'])
  assert.match(renderText(view.render()), /class="bundle-compare-body"/u)
  view._openFile('app.js')
  assert.equal(view._mode, 'code')
  assert.equal(view._codePath, 'app.js')
})

test('a source\'s chip opening a line opens Code at the open version\'s file there, each time anew', () => {
  const view = compare()
  view._status = 'ready'
  view._openLine({ path: 'b.js', line: 3, query: 'x.dev' })
  assert.equal(view._mode, 'code')
  assert.equal(view._codePath, 'b.js')
  const first = view._codeSeek
  assert.deepEqual(first, { path: 'b.js', line: 2, query: 'x.dev' }, 'its line from 0, as Code counts them')
  view._openLine({ path: 'b.js', line: 3, query: 'x.dev' })
  assert.notEqual(view._codeSeek, first, 'asked again, sought again')
  assert.match(renderText(view.render()), /<bundle-compare-(?:all|code)[^>]*\.seek=\[object Object\]/u, 'handed to Code')
  // As the chip asks it, its event bubbling to the row it sits in.
  const row = templates(view.render()).find(template => template.strings.some(part => part.includes('@compare-open-line=')))
  row.values[row.strings.findIndex(part => part.includes('@compare-open-line='))]({ detail: { path: 'a.js', line: 1, query: 'y.dev' } })
  assert.deepEqual(view._codeSeek, { path: 'a.js', line: 0, query: 'y.dev' })
  assert.equal(view._codePath, 'a.js')
})

test('Code lists every file\'s diff while that list is under 25,000 rows, and a file at a time beside the tree past it', t => {
  t.after(() => { combinedRows = 10 })
  const view = compare()
  view._status = 'ready'
  view._mode = 'code'
  const listed = renderText(view.render())
  assert.match(listed, /<bundle-compare-all /u)
  assert.doesNotMatch(listed, /<bundle-compare-code /u)
  combinedRows = 25_000
  delete diffOf(view).combined
  const tabs = renderText(view._renderSummary(diffOf(view))).match(/<div class="bundle-compare-modes"[^]*?<\/div>/u)?.[0] ?? ''
  assert.deepEqual([...tabs.matchAll(/>(\w+)<\/button>/gu)].map(m => m[1]), ['Overview', 'Code'])
  assert.deepEqual([...tabs.matchAll(/aria-selected=(\w+)/gu)].map(m => m[1]), ['false', 'true'])
  assert.match(renderText(view.render()), /<bundle-compare-code /u)
})

test('Differences renders resolution-only changes as a collapsed File | Import | Before | After | Conditions table and a summary count', () => {
  const view = compare()
  const collapsed = renderText(view._renderDiff(diffOf(view)))
  assert.match(collapsed, /<summary class="bundle-compare-section-head"[^]*?>Import resolutions <span class="bundle-compare-section-count">1/u)
  assert.doesNotMatch(collapsed, /<table/u, 'collapsed by default')
  view._openSections = new Set(['resolutions'])
  const markup = renderText(view._renderDiff(diffOf(view)))
  assert.match(markup, /Repointed/u)
  assert.match(markup, /<th>File<\/th><th>Import<\/th><th>Before<\/th><th>After<\/th><th>Conditions<\/th>/u)
  const row = markup.slice(markup.indexOf('<tbody>'))
  // Lazy up to the tag's end: a click handler renders inline here, `=>` and all.
  const cells = [...row.matchAll(/<td[^>]*>\s*<(?:button|code|span)[^]*?>([^<>]*)</gu)].map(m => m[1])
  // From the one picked to compare with, b.js, to the open one, a.js.
  assert.deepEqual(cells, ['app.js', 'dep', 'b.js', 'a.js', 'node, import'])
  assert.match(markup, /File contents are unchanged; import resolutions differ/u)
  assert.doesNotMatch(markup, /These two bundles carry identical files/u)
  assert.match(renderText(view._renderSummary(diffOf(view))), /1 repointed resolution/u)
  assert.equal(diffOf(view).totals.changedFiles, 0)
})

test('Repointed drops the Conditions column when every row reads `*`', () => {
  const view = compare()
  view.details = details('base', 'a.js', '*')
  view._otherDetails = details('other', 'b.js', '*')
  view._openSections = new Set(['resolutions'])
  const markup = renderText(view._renderDiff(diffOf(view)))
  assert.match(markup, /<th>File<\/th><th>Import<\/th><th>Before<\/th><th>After<\/th><\/tr>/u)
  assert.match(markup, /<table class=bundle-compare-resolutions--no-context>/u)
  assert.doesNotMatch(markup, /bundle-compare-resolution-context/u)
})

test('changing scope recomputes resolution changes and restores the identical state when none remain', () => {
  const view = compare()
  assert.equal(diffOf(view).resolutions.totalChanges, 1)
  view._scope = 'reason:deps'
  const markup = renderText(view._renderDiff(diffOf(view)))
  assert.match(markup, /These two bundles carry identical files/u)
  assert.doesNotMatch(markup, /Import resolutions/u)
  assert.doesNotMatch(renderText(view._renderSummary(diffOf(view))), /repointed resolution/u)
  view._scope = ''
  assert.equal(diffOf(view).resolutions.totalChanges, 1)
})

test('resolution groups cap visible rows while preserving exact counts', () => {
  const view = compare()
  const row = diffOf(view).resolutions.changed[0]
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
  const markup = renderText(view._renderDiff(diffOf(view)))
  assert.match(markup, /Repointed/u)
  assert.doesNotMatch(markup, /removed-only|added-only/u)
  assert.match(renderText(view._renderSummary(diffOf(view))), /1 repointed resolution/u)
  view._otherDetails.bundle.imports.get('node, import').get('app.js').set('dep', 'a.js')
  // Read anew, as a bundle that changed is.
  view._otherDetails = { ...view._otherDetails }
  assert.doesNotMatch(renderText(view._renderDiff(diffOf(view))), /Import resolutions|Repointed/u)
  assert.doesNotMatch(renderText(view._renderSummary(diffOf(view))), /repointed resolution/u)
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

test('file groups offer Flags where a file in them is flagged, as its tags show it, ordered by them', () => {
  const view = compare()
  const flags = { 'eval.js': [{ name: 'eval', severity: 'high' }], 'min.js': [{ name: 'Minified', severity: 'notice' }],
    'both.js': [{ name: 'Minified', severity: 'notice' }, { name: 'Obfuscated', severity: 'high' }] }
  view.details = { integrity: 'open' }
  view.source = { files: { icon: () => '', tag: () => '', flags: (of, path) => { assert.equal(of, view.details); return flags[path] ?? [] } } }
  const rows = ['plain.js', 'min.js', 'eval.js', 'both.js', 'a.js'].map(path => ({ path, bytes: 1 }))
  const group = (kind, files = rows) => {
    const markup = renderText(view._fileGroup(kind, files, kind, path => path))
    const header = markup.match(/aria-label="?\w+ file order"?>(.*?)<\/span>/su)[1]
    return { header, pressed: /aria-pressed=true[^<]*?>(\w+)<\/button>/u.exec(header)[1],
      order: [...markup.matchAll(/class="bundle-compare-row-path mono"[^>]*>(.*?)<\/span>/gu)].map(match => match[1]) }
  }
  assert.match(group('added').header, />Name<[^]*>Size<[^]*>Flags</u)
  view._fileSort = { removed: 'flags', added: 'flags', changed: 'flags' }
  assert.deepEqual(group('added').order, ['both.js', 'eval.js', 'min.js', 'a.js', 'plain.js'], 'the most severe, then the most flags, then the path')
  assert.equal(group('added').pressed, 'Flags')
  // A removed file has no tags, so none to order by, and Name's order instead.
  const removed = group('removed')
  assert.doesNotMatch(removed.header, />Flags</u)
  assert.equal(removed.pressed, 'Name')
  assert.deepEqual(removed.order, ['a.js', 'both.js', 'eval.js', 'min.js', 'plain.js'])
  // What a stasis bundle records of a changed file flags it too, but what it no longer is.
  view.source = null
  const changed = [{ path: 'b.js', delta: 1, meta: [{ field: 'executable', from: false, to: true }] }, { path: 'a.js', delta: 1, meta: [{ field: 'entry', from: true, to: false }] }]
  assert.deepEqual(group('changed', changed).order, ['b.js', 'a.js'])
  assert.doesNotMatch(group('changed', [changed[1]]).header, />Flags</u, 'nothing but what a file no longer is')
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
  const collapsed = renderText(view._renderDiff(diffOf(view)))
  assert.match(collapsed, /<summary class="bundle-compare-section-head"[^]*?>Files <span class="bundle-compare-section-count">1/u)
  const filesPart = markup => markup.slice(markup.indexOf('>Files <span'))
  assert.doesNotMatch(filesPart(collapsed), /bundle-compare-cols/u)
  view._openSections = new Set(['files'])
  assert.match(filesPart(renderText(view._renderDiff(diffOf(view)))), /bundle-compare-cols[^]*bundle-compare-changed/u)
})

test('the Files section lists as changed a file whose record alone changed, saying how', () => {
  const view = compare()
  // The open bundle runs a.js, its bytes the same, as an entry point with its execute bit set.
  view.details.bundle.entries.add('a.js')
  view.details.bundle.executable.add('a.js')
  view._openSections = new Set(['files'])
  const markup = renderText(view._renderDiff(diffOf(view)))
  assert.match(markup, /<summary class="bundle-compare-section-head"[^]*?>Files <span class="bundle-compare-section-count">1/u)
  assert.match(markup, /bundle-compare-changed[^]*a\.js[^]*bundle-compare-code-meta"?>\+x<[^]*bundle-compare-code-meta"?>new entry</u)
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

test('a source\'s dependencies list in place of Packages, each tagged as the source tags it, with what calls for a look at it', () => {
  const view = compare()
  view.source = { dependencyTags: row => npmDependencyFlagTags(row.flags) }
  const flag = (check, label) => ({ check, label, tooltip: `${label}, as said` })
  const rows = { removed: [{ key: '\0gone', name: 'gone', kind: null, range: 'github:a/gone' }],
    added: [{ key: '\0plain-crypto-js', name: 'plain-crypto-js', kind: null, range: '^4.2.1', flags: [flag('unimported', 'unimported')] }],
    changed: [{ key: 'optional\0websocket', name: 'websocket', kind: 'optional', from: '^1.0.29', to: 'github:a/websocket', flags: [flag('source', 'non-registry')] }] }
  const markup = renderText(view._renderDependencies(rows, 'Before', 'After', ['removed', 'added', 'changed']))
  assert.match(markup, /data-tooltip=plain-crypto-js>plain-crypto-js<\/span>\s*<span class=npm-dependency-flag is-unimported data-tooltip=unimported, as said>unimported<\/span>\s*<span class="bundle-compare-dep-ver"/u)
  assert.match(markup, /data-tooltip=websocket>websocket<\/span>\s*<span class=npm-dependency-flag is-source data-tooltip=non-registry, as said>non-registry<\/span><span class="npm-dependency-kind">optional<\/span>/u,
    'before its kind')
  assert.doesNotMatch(markup.slice(0, markup.indexOf('bundle-compare-group bundle-compare-added')), /npm-dependency-flag/u, 'none on one removed')
})

test('a package installed under an npm alias keeps one row, its versions joined to its sizes', () => {
  const side = (integrity, version, code) => ({ integrity, kind: 'stasis', bundle: new Bundle({
    modules: new Map([['.', { name: 'app', version: '1.0.0', files: { 'app.js': 'app' } }],
      ['node_modules/alias', { name: 'actual-package', version, files: { 'index.js': code } }]]),
  }) })
  const view = compare()
  view.details = side('other', '1.1.0', 'one, two')
  view._otherDetails = side('base', '1.0.0', 'one')
  const { packageRows } = diffOf(view)
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
  const markup = renderText(view._renderDiff(diffOf(view)))
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
    view._openSections = new Set(['files'])
    return [...renderText(view._renderDiff(diffOf(view))).matchAll(/class="bundle-compare-cols" data-lanes=(\d) data-section=(\w+)/gu)].map(m => `${m[2]} ${m[1]}`)
  }
  // Packages: Removed (gone) | Changed (own source); Files the same kinds,
  // laid out in Packages' lanes.
  assert.deepEqual(lanesOf({ 'src/app.js': 'one' }, { 'src/app.js': 'one, two' }), ['packages 2', 'files 2'])
  // Files also adds one: Packages keeps its two lanes, Files lays out three.
  assert.deepEqual(lanesOf({ 'src/app.js': 'one' }, { 'src/app.js': 'one, two', 'src/new.js': 'n' }), ['packages 2', 'files 3'])
})

test('the Overview lists a renamed file under Changed as `{old → new}`, and the summary counts it there', () => {
  const side = (integrity, files) => ({ integrity, kind: 'stasis', bundle: new Bundle({
    modules: new Map([['.', { name: 'app', version: '1.0.0', files }]]),
  }) })
  const view = compare()
  view.details = side('other', { 'src/app.js': 'one', 'lib/util.ts': 'u: 1' })
  view._otherDetails = side('base', { 'src/app.js': 'one', 'src/util.js': 'u' })
  view._openSections = new Set(['files'])
  const markup = renderText(view._renderDiff(diffOf(view)))
  assert.doesNotMatch(markup, /bundle-compare-group bundle-compare-(?:removed|added)/u, 'neither removed nor added')
  const changed = markup.slice(markup.lastIndexOf('bundle-compare-group bundle-compare-changed'))
  assert.match(changed, /data-tooltip=src\/util\.js → lib\/util\.ts>\{<span class="bundle-compare-rename-from">src\/util\.js<\/span> → <span class="bundle-compare-rename-to">lib\/util\.ts<\/span>\}</u)
  assert.match(renderText(view._renderSummary(diffOf(view))), /1 changed \(1 renamed\)/u)
})

// A `source` offers what to compare with in place of the bundles on hand, as
// an npm package version offers the package's other versions.
function sourced({ options = [{ id: '1.0.0', name: 'pkg@1.0.0', displayLabel: '1.0.0', format: 'npm', detail: 'old' }], pending = false, error = null } = {}) {
  const npm = (integrity, text) => ({ integrity, kind: 'sourcemap', json: { version: 3, sources: ['a.js'], sourcesContent: [text] } })
  const calls = { loads: [], opens: [] }
  const source = base => ({
    noun: 'version', base, pending, error, options, choices: [{ id: base, name: `pkg@${base}`, displayLabel: base, format: 'npm', detail: '' }, ...options],
    widest: { name: 'pkg@10.90.90', detail: 'latest' },
    name: id => `pkg@${id.replace(/^sha512-/u, '')}`,
    load: id => { calls.loads.push(id); return Promise.resolve(npm(`sha512-${id}`, id)) },
    open: (opened, target, mode) => calls.opens.push([opened, target, mode]),
    dependencies: () => ({ removed: [], added: [{ key: '\0dep', name: 'dep', kind: 'peer', range: '^1.0.0' }], changed: [] }),
  })
  const view = new Compare()
  view.integrity = 'sha512-2.0.0'
  view.details = npm('sha512-2.0.0', '2.0.0')
  view.source = source('2.0.0')
  return { view, calls, source, npm }
}

test('a source\'s options, names and loads stand in for the bundles on hand', async () => {
  const { view, calls } = sourced()
  assert.deepEqual(view._otherOptions(), [{ id: '1.0.0', integrity: '1.0.0', kind: 'npm', format: 'npm', detail: 'old', filename: 'pkg@1.0.0', displayLabel: '1.0.0', size: '—', summary: null }])
  const listed = view.source
  view.source = { ...listed, options: [{ ...listed.options[0], date: '2026-10-01', dateWarning: 'Too new' }] }
  assert.deepEqual(view._otherOptions().map(option => [option.date, option.dateWarning]), [['2026-10-01', 'Too new']], 'a date flagged where the source says why')
  view.source = listed
  view.request = { bundle: 'sha512-2.0.0', target: '1.0.0', mode: 'code' }
  view.willUpdate(new Map([['request', null]]))
  assert.equal(view._targetIntegrity, '1.0.0')
  assert.equal(view._mode, 'code')
  await Promise.resolve()
  assert.deepEqual(calls.loads, ['1.0.0'])
  assert.equal(view._otherDetails.integrity, 'sha512-1.0.0')
  assert.equal(view._status, 'ready')
  const diff = renderText(view._renderDiff(diffOf(view)))
  assert.match(diff, /<h3 class="bundle-compare-section-head">Dependencies<\/h3>/u, 'its dependencies in place of Packages')
  assert.doesNotMatch(diff, />Packages</u)
  assert.match(diff, /Added · only in pkg@2\.0\.0[^]*dep[^]*npm-dependency-kind">peer[^]*\^1\.0\.0/u)
  view.source = { ...view.source, dependencyTags: (row, kind) => `[${kind} ${row.name}]` }
  assert.match(renderText(view._renderDiff(diffOf(view))), /\[added dep\]<span class="npm-dependency-kind">peer<\/span>/u, 'what the source tags one with, before its kind')
})

test('a source\'s badges are given the one compared with, the open one, and the comparison\'s files', async () => {
  const { view, source } = sourced()
  view.source = { ...source('2.0.0'), badges: (base, other, files) => `<badges ${base.integrity} → ${other.integrity}: ${files.changed.map(row => row.path)}>` }
  view.request = { bundle: 'sha512-2.0.0', target: '1.0.0', mode: 'overview' }
  view.willUpdate(new Map([['request', null]]))
  await Promise.resolve()
  assert.match(renderText(view.render()), /<badges sha512-1\.0\.0 → sha512-2\.0\.0: a\.js>/u)
})

test('a file\'s icon reads each side under that side\'s own path, a removed one under the root it had', () => {
  const { view, source } = sourced()
  const asked = new Map()
  view.source = { ...source('2.0.0'), files: { icon: (path, sides) => { asked.set(path, sides.map(([side, at]) => `${side.integrity} ${at}`)); return '' }, tag: () => '', warning: () => '' } }
  view.willUpdate(new Map([['source', null]]))
  const map = (integrity, sources) => ({ integrity, kind: 'sourcemap', json: { version: 3, sources: Object.keys(sources), sourcesContent: Object.values(sources) } })
  view.details = map('sha512-2.0.0', { 'src/index.js': 'b\n', 'src/lib/a.js': 'b\n' })
  view._otherDetails = map('sha512-1.0.0', { 'LICENSE': 'l\n', 'index.js': 'a\n', 'lib/a.js': 'a\n' })
  view._targetIntegrity = '1.0.0'
  renderText(view._renderDiff(diffOf(view)))
  assert.deepEqual(asked.get('src/LICENSE'), ['sha512-1.0.0 LICENSE', 'sha512-2.0.0 src/LICENSE'], 'removed: the base read where it had the file')
  assert.deepEqual(asked.get('src/index.js'), ['sha512-1.0.0 index.js', 'sha512-2.0.0 src/index.js'], 'changed: each side under its own path')
})

test('a source\'s files list open, each with its type\'s icon, those the open one has tagged under its warning; its lines of code are counted; its dependencies open', () => {
  const { view, source } = sourced()
  const files = { icon: path => `<icon ${path}>`, tag: (shown, path, base) => `<tag ${shown.integrity} ${path} as ${base ? `${base.details.integrity} ${base.path}` : base}>`,
    warning: (shown, paths) => `<warning ${shown.integrity} ${paths.join(',')}>` }
  const opened = []
  view.source = { ...source('2.0.0'), files, openDependency: row => opened.push(row),
    dependencies: () => ({ removed: [], added: [{ key: '\0dep', name: 'dep', kind: null, range: '^1.0.0', opens: 'dep' }, { key: '\0local', name: 'local', kind: null, range: 'file:..', opens: null }], changed: [] }) }
  view.willUpdate(new Map([['source', null]]))
  assert.ok(view._openSections.has('files'), 'a package version\'s files list open')
  const map = (integrity, sources) => ({ integrity, kind: 'sourcemap', json: { version: 3, sources: Object.keys(sources), sourcesContent: Object.values(sources) } })
  view.details = map('sha512-2.0.0', { 'kept.js': 'a\n\nb\n', 'new.js': 'n\n' })
  view._otherDetails = map('sha512-1.0.0', { 'kept.js': 'a\n', 'gone.js': 'g\n' })
  view._targetIntegrity = '1.0.0'
  const markup = renderText(view._renderDiff(diffOf(view)))
  assert.match(markup, /<warning sha512-2\.0\.0 new\.js,kept\.js>/u, 'warned of what the open one adds or changes')
  for (const path of ['gone.js', 'new.js', 'kept.js']) assert.match(markup, new RegExp(`<icon ${path}>`, 'u'))
  assert.match(markup, /<tag sha512-2\.0\.0 new\.js as null>/u, 'an added file as none the version compared with had')
  assert.match(markup, /<tag sha512-2\.0\.0 kept\.js as sha512-1\.0\.0 kept\.js>/u, 'a changed one as that version has it, for what is new to it')
  assert.doesNotMatch(markup, /<tag [^>]* gone\.js>/u, 'a file only the one compared with has is not')
  assert.match(markup, /data-tooltip=2 B → 5 B · 1 → 2 LoC>/u, 'a changed file\'s lines of code')
  const summary = renderText(view._renderSummary(diffOf(view)))
  assert.match(summary, /LoC<\/span>\s*<span class="bundle-compare-metric-value">2 → 3<\/span>[^]*?\+1/u)
  assert.match(summary, /Files<\/span>[^]*?<div class="bundle-compare-chips">/u, 'the file count leads its chips')
  assert.match(summary, /bundle-compare-chip removed">−1 removed[^]*bundle-compare-chip added">\+1 added[^]*bundle-compare-chip changed">1 changed/u)
  const diff = diffOf(view)
  const none = renderText(view._renderSummary({ ...diff, totals: { ...diff.totals, onlyBaseFiles: 0, onlyOtherFiles: 0, changedFiles: 0 } }))
  assert.doesNotMatch(none, /bundle-compare-chip (?:removed|added|changed)"/u, 'no −0 removed, +0 added or 0 changed')
  assert.match(none, /bundle-compare-chip unchanged">0 unchanged/u)
  assert.equal(summary.match(/<div/gu).length, summary.match(/<\/div>/gu).length, 'balanced')
  assert.match(summary, /<div class="bundle-compare-modes"[^]*<\/div>\s*<\/div>$/u, 'the mode tabs inside the summary')
  assert.match(markup, /<button type="button" class="bundle-compare-row bundle-compare-row-link"[^]*?data-tooltip=dep>dep</u, 'a dependency it can open is a link')
  assert.match(markup, /<div class="bundle-compare-row">\s*<span class="bundle-compare-row-path" data-tooltip-truncated data-tooltip=local>/u, 'one it can\'t is not')
})

test('a source\'s selects are one width, its widest at least from the start, then wide enough for any it lists', () => {
  const width = view => /--compare-select-chars: (\d+)/u.exec(renderText(view._renderPicker(view._otherOptions(), false, '', '')))?.[1]
  const { view: pending } = sourced({ options: [], pending: true })
  // pkg@10.90.90 and `latest` at the tag's smaller size: 12 + 6 × .87 + 1.
  assert.equal(width(pending), '19', 'while its versions are on their way')
  const { view: short } = sourced()
  assert.equal(width(short), '19', 'as long as all it lists are shorter')
  // pkg@10.0.0-beta.123 and `next`: 19 + 4 × .87 + 1.
  const { view: listed } = sourced({ options: [{ id: '10.0.0-beta.123', name: 'pkg@10.0.0-beta.123', displayLabel: '10.0.0-beta.123', format: 'npm', detail: 'next' }] })
  assert.equal(width(listed), '24', 'a longer one listed, whole with its tag')
  // pkg@1.0.0 and 24 characters of its tags: 9 + 24 × .87 + 1.
  const { view: tagged } = sourced({ options: [{ id: '1.0.0', name: 'pkg@1.0.0', displayLabel: '1.0.0', format: 'npm', detail: Array.from({ length: 12 }, (_, i) => `ts${i}.0`).join(', ') }] })
  assert.equal(width(tagged), '31', 'its tags only as many as fit')
})

test('a source opens the other side to swap, which compares with the old base once it arrives', async () => {
  const { view, calls, source, npm } = sourced()
  view._targetIntegrity = '1.0.0'
  view._otherDetails = npm('sha512-1.0.0', '1.0.0')
  view._status = 'ready'
  view._swap()
  assert.deepEqual(calls.opens, [['1.0.0', '2.0.0', 'overview']], 'the other side opens, compared with this one')
  const old = view.details
  view.integrity = 'sha512-1.0.0'
  view.details = view._otherDetails
  view.source = source('1.0.0')
  view.willUpdate(new Map([['integrity', 'sha512-2.0.0'], ['details', old]]))
  assert.equal(view._targetIntegrity, '2.0.0', 'the old base, by its id')
  await Promise.resolve()
  assert.deepEqual(calls.loads, ['2.0.0'])
  assert.equal(view._otherDetails.integrity, 'sha512-2.0.0')
})

test('a source says when its options are loading, missing or failed, and a failed load why', async () => {
  const text = options => { const { view } = sourced(options); return renderText(view.render()) }
  assert.match(text({ pending: true, options: [] }), /Loading versions…/u)
  assert.match(text({ options: [] }), /No other versions to compare <strong>pkg@2\.0\.0<\/strong> with\./u)
  assert.match(text({ error: "Couldn't list the versions of pkg.", options: [] }), /is-error[^]*Couldn't list the versions of pkg\./u)
  assert.match(text(), /Pick a version above to compare <strong>pkg@2\.0\.0<\/strong> against\./u)
  const { view } = sourced()
  view.source = { ...view.source, load: () => Promise.reject(new Error('No such package version, or it is not available to you.')) }
  view._choose('9.9.9')
  await Promise.resolve(); await Promise.resolve()
  assert.match(renderText(view.render()), /Couldn't read the selected version: No such package version/u)
})

test('this side is a picker too, listing the open bundle and those it compares with; picking the target swaps', () => {
  const view = compare()
  view._status = 'ready'
  const events = []
  view.addEventListener('bundle-swap', event => events.push(event.detail))
  assert.deepEqual(view._baseOptions().map(option => option.filename), ['Before', 'After'])
  view._pickBase('base')
  assert.equal(events.length, 0, 'the bundle shown is no change')
  view._pickBase('other')
  assert.deepEqual(events.map(detail => [detail.integrity, detail.target]), [['other', 'base']])
})

test('a pick on this side opens it compared with the same target, handing over the target already parsed', t => {
  compareState.bundles.push({ integrity: 'third', name: 'Third' })
  t.after(() => { compareState.bundles.pop(); handedOff = null })
  const view = compare()
  view._status = 'ready'
  const other = view._otherDetails
  let detail = null
  view.addEventListener('bundle-swap', event => { detail = event.detail })
  view._pickBase('third')
  assert.equal(detail.integrity, 'third')
  assert.equal(detail.target, 'other')
  assert.deepEqual(detail.bundles, [other], 'the target is parsed; the new base is read as it opens')
  // The navigation lands on Third, which compares with the same target.
  handedOff = { bundles: new Map(detail.bundles.map(parsed => [parsed.integrity, parsed])) }
  view.integrity = 'third'
  view.details = details('third', 'a.js')
  view.willUpdate(new Map([['integrity', 'base']]))
  assert.equal(view._targetIntegrity, 'other')
  assert.equal(view._otherDetails, other)
  assert.equal(view._status, 'ready')
})

test('a source\'s own side lists every choice; a pick opens it with the same target, or with none', () => {
  const { view, calls } = sourced({ options: [{ id: '1.0.0', name: 'pkg@1.0.0', format: 'npm', detail: '' }, { id: '0.9.0', name: 'pkg@0.9.0', format: 'npm', detail: '' }] })
  assert.deepEqual(view._baseOptions().map(option => option.id), ['2.0.0', '1.0.0', '0.9.0'])
  view._pickBase('0.9.0')
  assert.deepEqual(calls.opens, [['0.9.0', null, 'overview']], 'nothing picked to compare with yet')
  view._targetIntegrity = '1.0.0'
  view._mode = 'code'
  view._codePath = 'a.js'
  view._pickBase('0.9.0')
  assert.deepEqual(calls.opens.at(-1), ['0.9.0', '1.0.0', 'code'])
  // Its navigation lands: the same target, mode and file, the target read again.
  view.integrity = 'sha512-0.9.0'
  view.source = { ...view.source, base: '0.9.0' }
  view._targetIntegrity = null
  view._codePath = null
  view.willUpdate(new Map([['integrity', 'sha512-2.0.0']]))
  assert.equal(view._targetIntegrity, '1.0.0')
  assert.equal(view._mode, 'code')
  assert.equal(view._codePath, 'a.js')
  assert.deepEqual(calls.loads.at(-1), '1.0.0')
})
