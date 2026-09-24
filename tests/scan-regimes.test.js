import assert from 'node:assert/strict'
import { test } from 'node:test'
import './_polyfills.js'
import { duplicateRegimes, normalizeRegimes } from '../ui/scan/regimes.js'
import { RegimeEditor } from '../ui/scan/regime-editor.js'
import { ScanPage } from '../ui/scan/page.js'
import { cloneScanFixtures } from '../ui/scan/fixtures.js'

const catalogue = { defaultModel: 'model-a', models: [
  { id: 'model-a', efforts: ['low', 'high'] }, { id: 'model-b', efforts: ['medium', 'max'] },
] }
const regime = { mode: 'generic', model: 'model-a', effort: 'high', isolate: false }

test('regime validation preserves duplicates and compares the entire mode/model/effort/search tuple', () => {
  const rows = [regime, { ...regime }, { ...regime, mode: 'security' }, { ...regime, model: 'model-b', effort: 'max' },
    { ...regime, effort: 'low' }, { ...regime, isolate: true }]
  assert.deepEqual(duplicateRegimes(normalizeRegimes(rows, catalogue)), [false, true, false, false, false, false])
  assert.equal(normalizeRegimes([], catalogue).length, 1)
  assert.deepEqual(normalizeRegimes([], { models: [] }), [])
})

test('Add regime copies the last row, labels duplicates, and blocks running without silently changing settings', async () => {
  const editor = new RegimeEditor()
  editor.value = [regime]
  editor.loadModels = () => Promise.resolve(catalogue)
  let latest
  editor.addEventListener('regimes-change', e => { latest = e.detail })
  await editor._load()
  assert.deepEqual(latest, { value: [regime], ready: true })
  editor._remove(editor._rows[0].id)
  assert.equal(editor._rows.length, 1)
  editor._add()
  assert.deepEqual(latest.value, [regime, regime])
  assert.equal(latest.ready, false)
  assert.notEqual(editor._rows[0].id, editor._rows[1].id)
  editor._change(editor._rows[1].id, { isolate: true })
  assert.equal(latest.ready, true)
  editor._add()
  assert.equal(latest.value[2].isolate, true, 'copy the last row, not the first')
  assert.equal(latest.ready, false)
  editor._change(editor._rows[2].id, { effort: 'low' })
  assert.equal(latest.ready, true)
  editor._change(editor._rows[2].id, { effort: 'high' })
  assert.equal(latest.value[2].effort, 'high', 'retain a duplicate edit for the user to correct')
  assert.equal(latest.ready, false)
  editor._remove(editor._rows[2].id)
  assert.equal(latest.ready, true)
})

test('provider changes revalidate unsupported models/efforts without removing rows; stale catalogue loads cannot enable Run', async () => {
  const editor = new RegimeEditor()
  editor.value = [regime, { ...regime, model: 'model-b', effort: 'max' }]
  let latest
  editor.addEventListener('regimes-change', e => { latest = e.detail })
  editor.loadModels = () => Promise.resolve(catalogue)
  await editor._load()
  const pending = []
  editor.loadModels = signal => new Promise(resolve => { pending.push({ signal, resolve }) })
  const first = editor._load()
  assert.equal(latest.ready, false)
  const second = editor._load()
  assert.equal(pending[0].signal.aborted, true)
  pending[1].resolve({ defaultModel: 'only', models: [{ id: 'only', efforts: ['max'] }] })
  await second
  assert.equal(editor._rows.length, 2)
  assert.deepEqual(latest.value.map(row => [row.model, row.effort]), [['only', 'max'], ['only', 'max']])
  assert.equal(latest.ready, false, 'model filtering can create a duplicate and must block Run')
  pending[0].resolve(catalogue)
  await first
  assert.equal(editor._rows[0].model, 'only')
  editor._change(editor._rows[1].id, { mode: 'correctness' })
  assert.equal(latest.ready, true)
  editor.loadModels = () => Promise.reject(new Error('offline'))
  await editor._load()
  assert.equal(latest.ready, false)
  assert.match(editor._error, /offline/u)
})

test('Advanced scan records and restores every regime, and reselecting Advanced does not block a ready editor', () => {
  const page = new ScanPage()
  page.source = { bundles: cloneScanFixtures() }
  page.willUpdate(new Map([['source', null]]))
  page._options = { ...page._options, ...regime, analyzer: 'security' }
  page._setOption('analyzer', 'advanced')
  assert.equal(page._regimes[0].mode, 'security')
  page._regimes = [regime, { ...regime, isolate: true }]
  page._regimesReady = false
  page._runScan()
  assert.equal(page._scans.length, 0)
  page._regimesReady = true
  page._setOption('analyzer', 'advanced')
  assert.equal(page._regimesReady, true)
  page._runScan()
  for (const timer of page._timers) clearTimeout(timer)
  const scan = page._scans[0]
  assert.deepEqual(scan.regimes, [regime, { ...regime, isolate: true }])
  assert.notEqual(scan.regimes, page._regimes)
  page._restartScan(scan)
  assert.deepEqual(page._regimes, scan.regimes)
  assert.equal(page._regimesReady, false)
  assert.equal(page._options.analyzer, 'advanced')
  assert.equal(page._reason, scan.scopeId)
  page._setOption('analyzer', 'correctness')
  page._runScan()
  for (const timer of page._timers) clearTimeout(timer)
  const basic = page._scans[0]
  page._setOption('analyzer', 'advanced')
  page._restartScan(basic)
  assert.equal(page._options.analyzer, 'correctness', 'restarting a basic run leaves Advanced')
})
