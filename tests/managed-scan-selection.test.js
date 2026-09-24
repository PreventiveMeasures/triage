import assert from 'node:assert/strict'
import { test } from 'node:test'
import './_polyfills.js'
import '../ui/client-managed.js'

const Scans = customElements.get('managed-admin-scans')

test('changing repository selects its first bundle and resets bundle-specific scope', () => {
  const page = new Scans()
  for (const repo of [...page._repositories, ...page._repositories.toReversed()]) {
    if (repo.id === page._selectedRepoId) continue
    page._excluded.add('old-file')
    page._excludedModules.add('old-module')
    page._reason = 'old-reason'
    page._selectRepoById(repo.id)
    assert.equal(page._bundle, page._repoBundles[0])
    assert.equal(page._selectedBundleId, page._bundle.id)
    assert.equal(page._reason, page._bundle.reasons[0].id)
    assert.equal(page._excluded.size, 0)
    assert.equal(page._excludedModules.size, 0)
    assert.deepEqual(new Set(page._files), new Set(page._bundle.files))
  }
})

test('reselecting a repository keeps its chosen bundle; unrelated bundle IDs are rejected', () => {
  const page = new Scans()
  const second = { ...page._bundle, id: 'second-bundle' }
  page._bundles = [...page._bundles, second]
  page._selectBundleById(second.id)
  page._selectRepoById(second.repoId)
  assert.equal(page._bundle, second)
  page._selectBundleById(page._bundles.find(bundle => bundle.repoId !== second.repoId).id)
  page._selectRepoById('missing-repo')
  assert.equal(page._bundle, second)
})

test('missing bundles never silently fall back to a different scan input', () => {
  const page = new Scans()
  page._selectedBundleId = 'missing-bundle'
  assert.equal(page._bundle, undefined)
  assert.deepEqual(page._files, [])
  const count = page._scans.length
  page._runScan()
  assert.equal(page._scans.length, count)
  page._repositories.push({ id: 'empty', label: 'No bundles' })
  page._selectRepoById('empty')
  assert.equal(page._selectedBundleId, null)
  assert.equal(page._bundle, undefined)
  page._runScan()
  assert.equal(page._scans.length, count)
})

test('restarting a scan restores its repository and bundle together', () => {
  const page = new Scans()
  const bundle = page._bundles.find(item => item.repoId !== page._selectedRepoId)
  page._restartScan({ bundleId: bundle.id, mode: 'code', reason: bundle.reasons[1].label })
  assert.equal(page._selectedRepoId, bundle.repoId)
  assert.equal(page._selectedBundleId, bundle.id)
  assert.equal(page._bundle, bundle)
  assert.equal(page._reason, bundle.reasons[1].id)
  page._restartScan({ bundleId: 'deleted-bundle', mode: 'code' })
  assert.equal(page._bundle, bundle)
})
