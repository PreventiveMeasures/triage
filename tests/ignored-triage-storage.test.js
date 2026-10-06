import './_polyfills.js'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { state } from '../client/state.ts'
import { deleteFile, saveFile } from '../client/storage.js'
import { readTriageBlob, reloadTriageFromStorage, saveTriage, setTriageChangeNotifier } from '../client/triage.js'
import { setFindingTriage } from '../client/ignored-triage.js'
import { applyTriageImport } from '../client/triage-export.js'
import { defaultSyncHost } from '../client/sync-host.js'
import { applyToReactiveState, hydrateStateFromBaseState } from '../client/sync/triage-state-projection.ts'
import { managedWorkspaceImportDeps } from '../client/managed/local-import.js'

const reportName = 'ignored-storage-migration.json'
const content = JSON.stringify({ findings: [
  { id: 'own', file: 'src/app.js', isApp: false },
  { id: 'app', file: 'node_modules/pkg/app.js', isApp: true },
  { id: 'dep', file: 'node_modules/pkg/source.js', isApp: false },
] })
const legacy = () => Object.fromEntries(['own', 'app', 'dep'].map(id => [id, { ignoredReports: [reportName] }]))
const expected = { own: { triage: 'ignored' }, app: { triage: 'ignored' }, dep: { ignoredReports: [reportName], scopedIgnoredReports: [reportName] } }
async function fixture(t) {
  state.serverMode = 'e2e'
  state.localMode = false
  state.reports = []
  state.triage.clear()
  await saveFile(reportName, content)
  t.after(async () => {
    await deleteFile(reportName)
    state.triage.clear()
    state.reports = []
    localStorage.removeItem('deepview.triage.pending')
    localStorage.removeItem('deepview.triage')
    setTriageChangeNotifier(null)
  })
}

test('legacy local storage migrates and persists without opening the report', async t => {
  await fixture(t)
  localStorage.setItem('deepview.triage.pending', JSON.stringify(legacy()))
  await reloadTriageFromStorage()
  assert.deepEqual(Object.fromEntries(state.triage), expected)
  assert.deepEqual(await readTriageBlob(), expected)
  await reloadTriageFromStorage()
  assert.deepEqual(Object.fromEntries(state.triage), expected)
})

test('restoring a migrated shared ignore survives save, reload, E2E hydration, and import', async t => {
  await fixture(t)
  const dep = { id: 'same', file: 'node_modules/pkg/a.js', isApp: false, _reportName: reportName }
  const app = { ...dep, isApp: true }
  await saveFile(reportName, JSON.stringify({ findings: [app, dep] }))
  localStorage.setItem('deepview.triage.pending', JSON.stringify({ same: { ignoredReports: [reportName] } }))
  await reloadTriageFromStorage()
  state.reports = [{ name: reportName, groups: [[app], [dep]] }]
  setFindingTriage(state.triage, app, 'untriaged')
  const restored = { same: { ignoredReports: [reportName], scopedIgnoredReports: [reportName] } }
  await saveTriage()
  assert.deepEqual(await readTriageBlob(), restored)
  state.triage.clear()
  await reloadTriageFromStorage()
  assert.deepEqual(Object.fromEntries(state.triage), restored)
  state.triage.clear()
  hydrateStateFromBaseState(restored, ['same'])
  await defaultSyncHost.saveTriage()
  assert.deepEqual(await readTriageBlob(), restored)
  for (const mode of ['replace', 'prefer-current', 'prefer-imported']) {
    state.triage.clear()
    await applyTriageImport({ triage: restored, repoUrls: {} }, mode)
    assert.deepEqual(await readTriageBlob(), restored, mode)
  }
})

test('received E2E legacy state is migrated before persistence and sync notification', async t => {
  await fixture(t)
  const notifications = []
  setTriageChangeNotifier(() => notifications.push(Object.fromEntries(state.triage)))
  applyToReactiveState(legacy(), ['own', 'app', 'dep'])
  await defaultSyncHost.saveTriage()
  assert.deepEqual(await readTriageBlob(), expected)
  assert.deepEqual(notifications, [expected])
  const mixed = { own: { triage: 'ignored', ignoredReports: ['other-dependency.json'] } }
  applyToReactiveState(mixed, ['own'])
  assert.deepEqual(state.triage.get('own'), mixed.own)
  state.triage.delete('own')
  assert.deepEqual(hydrateStateFromBaseState(mixed, ['own']), [])
  assert.deepEqual(state.triage.get('own'), mixed.own)
})

test('managed import/compare migrates a detached local snapshot without hydrating managed state', async t => {
  await fixture(t)
  localStorage.setItem('deepview.triage.pending', JSON.stringify(legacy()))
  state.serverMode = 'managed'
  state.triage.set('server-only', { triage: 'fixed' })
  assert.deepEqual(await managedWorkspaceImportDeps().readTriageBlob(), expected)
  assert.deepEqual(Object.fromEntries(state.triage), { 'server-only': { triage: 'fixed' } })
  assert.deepEqual(await readTriageBlob(), legacy(), 'managed preview must not write local storage')
})
