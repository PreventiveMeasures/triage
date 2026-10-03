import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { Bundle } from '@exodus/stasis-core/bundle'
import '../ui/view/frontend-install.js'

mock.module('../client/index.js', { namedExports: { state: { bundles: [
  { integrity: 'base', name: 'Before' }, { integrity: 'other', name: 'After' },
] } } })
mock.module('../ui/view/bundle-load.js', { namedExports: { buildBundleDetails() {} } })
let fileDialogProps
mock.module('../ui/view/dialogs/bundle-file-dialog.js', { namedExports: { openBundleFileDialog(props) { fileDialogProps = props; return Promise.resolve() } } })
mock.module('../ui/view/toast.js', { namedExports: { showToast() {} } })
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

test('file previews receive the format from the displayed side of the comparison', () => {
  const view = compare()
  view.details.bundle.formats.set('app.js', 'commonjs')
  view._otherDetails.bundle.formats.set('app.js', 'commonjs-typescript')
  view._openFile('app.js', 'added')
  assert.equal(fileDialogProps.format, 'commonjs-typescript')
  view._openFile('app.js', 'removed')
  assert.equal(fileDialogProps.format, 'commonjs')
})

test('Differences renders resolution-only changes with before/after targets and a summary count', () => {
  const view = compare()
  const markup = renderText(view._renderDiff())
  assert.match(markup, /Import resolutions/u)
  assert.match(markup, /Repointed/u)
  assert.match(markup, /app\.js/u)
  assert.match(markup, /dep/u)
  assert.match(markup, /node, import/u)
  assert.match(markup, /Before<\/span><code>a\.js/u)
  assert.match(markup, /After<\/span><code>b\.js/u)
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
