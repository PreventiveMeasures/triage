import assert from 'node:assert/strict'
import { test } from 'node:test'
import './_polyfills.js'
import '../ui/scan/page.js'
import { SCAN_REPOSITORY_FIXTURES, cloneScanFixtures } from '../ui/scan/fixtures.js'

const Scans = customElements.get('deepview-scan-page')
test('the host can block scan actions while disconnected even with selected files', () => {
  const page = createPage()
  page.canRun = false
  page._runScan()
  assert.deepEqual(page._scans, [])
})
test('shared scan page has no built-in managed data', () => {
  const page = new Scans()
  assert.deepEqual(page._bundles, [])
  assert.deepEqual(page._repositories, [])
  assert.equal(page._reportInput, null)
  assert.deepEqual(page._scans, [])
})
function createPage() {
  const page = new Scans()
  page.source = { bundles: cloneScanFixtures(), repositories: SCAN_REPOSITORY_FIXTURES }
  page.willUpdate(new Map([['source', null]]))
  return page
}

test('changing repository selects its first bundle and resets bundle-specific scope', () => {
  const page = createPage()
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
  const page = createPage()
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
  const page = createPage()
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
  const page = createPage()
  const bundle = page._bundles.find(item => item.repoId !== page._selectedRepoId)
  page._restartScan({ bundleId: bundle.id, mode: 'code', reason: bundle.reasons[1].label })
  assert.equal(page._selectedRepoId, bundle.repoId)
  assert.equal(page._selectedBundleId, bundle.id)
  assert.equal(page._bundle, bundle)
  assert.equal(page._reason, bundle.reasons[1].id)
  page._restartScan({ bundleId: 'deleted-bundle', mode: 'code' })
  assert.equal(page._bundle, bundle)
})

test('late bundle reads cannot replace a more recent selection', async () => {
  const page = new Scans()
  page._bundles = ['first', 'second'].map(id => ({ id, repoId: 'unattached', files: null, reasons: [] }))
  const pending = new Map()
  page.loadBundle = (bundle, signal) => new Promise(resolve => { pending.set(bundle.id, { resolve, signal }) })
  page._selectedRepoId = 'unattached'
  page._selectedBundleId = 'first'
  const first = page._loadSelectedBundle()
  page._selectedBundleId = 'second'
  const second = page._loadSelectedBundle()
  assert.equal(pending.get('first').signal.aborted, true)
  pending.get('second').resolve({ ...page._bundles[1], files: [{ path: 'second.js', bytes: 12, module: '__own__' }], reasons: [{ id: 'all' }] })
  await second
  pending.get('first').resolve({ ...page._bundles[0], files: [{ path: 'first.js' }], reasons: [] })
  await first
  assert.equal(page._bundle.id, 'second')
  assert.deepEqual(page._files.map(file => file.path), ['second.js'])
  page._bundle.reasons.push({ id: 'reason:one', filePaths: [] })
  page._reason = 'reason:one'
  assert.deepEqual(page._files, [])
})
