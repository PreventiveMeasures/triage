import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'
import { litSvgAsHtml } from '../build-lit-svg.js'

// Scans, Compare and the dialogs are bundles of their own, loaded the first
// time they open (view/lazy-entry.js). What a page loads up front is an entry
// with every chunk it statically imports; none of them may be in it.
const { metafile } = await build({
  entryPoints: ['ui/*.js'], bundle: true, format: 'esm', splitting: true, chunkNames: 'chunk-[hash]',
  outdir: 'out', write: false, loader: { '.css': 'text' }, plugins: [litSvgAsHtml], metafile: true,
})
function loads(entry) {
  const inputs = new Set(), queue = [entry], seen = new Set([entry])
  for (const output of queue) {
    for (const input of Object.keys(metafile.outputs[output].inputs)) inputs.add(input)
    for (const { path, kind } of metafile.outputs[output].imports) if (kind === 'import-statement' && !seen.has(path)) { seen.add(path); queue.push(path) }
  }
  return inputs
}
const managed = loads('out/client-managed.js'), view = loads('out/view.js')
const compare = loads('out/compare.js'), dialogs = loads('out/dialogs.js'), scan = loads('out/scan.js')
const isDialog = path => path.startsWith('ui/view/dialogs/')
// Two dialogs are held up front (view/lazy-dialogs.js says why), with what they import.
const upFront = new Set(['ui/view/dialogs/proxy-auth-dialog.js', 'ui/view/dialogs/triage-conflict-dialog.js'])
for (const path of upFront) for (const { path: next, kind } of metafile.inputs[path].imports) if (kind === 'import-statement' && isDialog(next)) upFront.add(next)

test('view.js loads no Scans, Compare or dialog but those held up front', () => {
  for (const path of ['ui/scan/page.js', 'ui/view/local-scan-page.js', 'ui/view/bundle-compare.js', 'ui/view/npm-review.js', 'ui/view/dependency-review-list.js']) {
    assert.ok(!view.has(path), path)
  }
  assert.deepEqual([...view].filter(isDialog).toSorted(), [...upFront].toSorted())
  assert.ok(view.has('ui/view/lazy-dialogs.js') && view.has('ui/view/scan-load.js') && view.has('ui/view/compare-load.js'))
})

test('client-managed.js loads no Scans page or dialog', () => {
  assert.ok(!managed.has('ui/scan/page.js'))
  assert.deepEqual([...managed].filter(isDialog), [])
})

test('each bundle holds what it is loaded for', () => {
  assert.ok(scan.has('ui/scan/page.js') && scan.has('ui/view/local-scan-page.js'))
  for (const path of ['ui/view/bundle-compare.js', 'ui/view/npm-review.js', 'ui/view/dependency-review-list.js']) assert.ok(compare.has(path), path)
  assert.ok(dialogs.has('ui/view/dialogs/app-dialog.js') && dialogs.has('ui/view/dialogs/managed-issue-dialog.js'))
})
