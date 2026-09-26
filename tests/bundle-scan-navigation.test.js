import assert from 'node:assert/strict'
import { beforeEach, mock, test } from 'node:test'
import './_polyfills.js'
import { beginViewNavigation, currentViewGeneration } from '../ui/view/view-navigation.js'

const state = { bundles: [] }
let managed = false, modeGate = null, navigated = null, rendered = false
mock.module('../client/index.js', { namedExports: {
  state, isManagedUiMode: () => managed,
  forgetScanAccess() {}, hasSavedScanAccess() {}, onSavedScanAccessChange() {}, readSavedScanAccess() {}, saveScanAccess() {},
} })
mock.module('../ui/view/sidebar.js', { namedExports: {
  ensureClientMode: () => modeGate,
  navigateToAdminPage: (view, options) => { navigated = { view, options } },
  renderSidebar() {},
} })
mock.module('../ui/view/ingest.js', { namedExports: {
  currentViewGeneration,
  goHome: () => {
    beginViewNavigation()
    state.selectedBundle = null
    state.selectedBundleWorkspace = null
    state.scanSelection = null
  },
} })
mock.module('../ui/view/render.js', { namedExports: { render: () => { rendered = true } } })
mock.module('../ui/view/scan-local-source.js', { namedExports: { loadLocalReportSources() {}, loadLocalScanBundle() {}, loadLocalScanSource() {} } })
mock.module('../ui/scan/page.js', { namedExports: {} })
mock.module('../ui/view/toast.js', { namedExports: { showToast() {} } })
const { canScanBundle, openScan } = await import('../ui/view/scan-navigation.js')
globalThis.window = { location: { hostname: 'triage.test' } }
globalThis.document = { querySelector: () => null }

beforeEach(() => {
  managed = false; modeGate = null; navigated = null; rendered = false
  state.serverMode = 'e2e'; state.localMode = false
  state.deepviewScanServer = 'https://scan.example/'
  state.managedSession = null
  state.currentView = 'bundles'; state.selectedBundle = 'shared'
  state.selectedBundleWorkspace = 'second-workspace'; state.scanSelection = null
})

test('local bundle scan preserves the clicked workspace across navigation cleanup', async () => {
  const entry = { integrity: 'shared' }
  assert.equal(canScanBundle(entry), true)
  await openScan(entry)
  assert.deepEqual(state.scanSelection, { bundleId: 'shared', repoId: 'second-workspace' })
  assert.equal(state.currentView, 'scan')
  assert.equal(rendered, true)
})

test('bundle Scan obeys local service availability and managed roles', async () => {
  state.deepviewScanServer = null
  assert.equal(canScanBundle({ integrity: 'local' }), false)
  await openScan({ integrity: 'local' })
  assert.equal(rendered, false)
  managed = true
  for (const role of ['none', 'view', 'triage', 'manage', 'admin']) {
    state.managedSession = { role }
    assert.equal(canScanBundle({ managedId: 'managed-bundle' }), ['manage', 'admin'].includes(role))
    assert.equal(canScanBundle({ integrity: 'local' }), false)
  }
  await openScan({ managedId: 'managed-bundle' })
  assert.deepEqual(navigated, { view: 'manage-scans', options: { bundleId: 'managed-bundle' } })
})

test('a newer navigation cancels a pending bundle Scan click', async () => {
  const ready = Promise.withResolvers()
  modeGate = ready.promise
  const open = openScan({ integrity: 'shared' })
  beginViewNavigation()
  ready.resolve()
  await open
  assert.equal(rendered, false)
  assert.equal(state.scanSelection, null)
})
