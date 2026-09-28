import assert from 'node:assert/strict'
import { test } from 'node:test'
import { bundleFileHistory, stepBundleFile, visitBundleFile } from '../ui/view/bundle-code-history.js'

test('file navigation seeds the current file and supports back/forward without duplicate visits', () => {
  const base = bundleFileHistory(null, 'bundle', 'main.js')
  assert.deepEqual(base.files, ['main.js'])
  assert.equal(base.at, 0)
  const history = visitBundleFile(visitBundleFile(base, 'other.js'), 'utils.ts')
  assert.deepEqual(history.files, ['main.js', 'other.js', 'utils.ts'])
  assert.equal(visitBundleFile(history, 'utils.ts'), history)
  const back = stepBundleFile(history, -1)
  assert.equal(back.files[back.at], 'other.js')
  assert.equal(stepBundleFile(back, 1).at, 2)
  assert.deepEqual(visitBundleFile(back, 'new.js').files, ['main.js', 'other.js', 'new.js'])
  assert.equal(stepBundleFile(base, -1).at, 0)
  assert.equal(stepBundleFile(history, 1).at, 2)
})

test('switching bundles or replacing the selected file cannot reuse stale history', () => {
  const history = visitBundleFile(bundleFileHistory(null, 'first', 'main.js'), 'other.js')
  assert.equal(bundleFileHistory(history, 'first', 'other.js'), history)
  assert.deepEqual(bundleFileHistory(history, 'second', 'other.js'), { bundle: 'second', files: ['other.js'], at: 0 })
  assert.deepEqual(bundleFileHistory(history, 'first', 'new.js').files, ['new.js'])
  assert.deepEqual(bundleFileHistory(history, 'first', null).files, [])
})
