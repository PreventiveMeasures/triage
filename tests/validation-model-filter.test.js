// The `<analyzer-select>` dropdown in App mode: Analyzer | Model |
// Validation model. Validation model asks a revalidation pass's own row
// (`revalidate: "revalidation"`), Model every other row of the row — the
// scans beneath it, folded away unless the reader shows them — so a pass
// run on one model everywhere leaves that model's own findings to ask
// for. Any row matching shows the whole row, and the counts read whole
// rows whatever the detail stop.
import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import './_polyfills.js'

const { state } = await import('../client/state.ts')
const { applyFilters, applyScopeFilters, matchesFilters, resetFilters, runFilterCounts, runFiltersOffered, scopeRows } = await import('../ui/view/filters.js')
const { configureDepsDir, configureRevalidation } = await import('../ui/view/format.js')
const { activeTabFor, getMergedGroups } = await import('../ui/view/group.js')

const finding = (id, model, extra = {}) => ({ id, file: `src/${id}.js`, severity: 'high', confidence: 9, model, _analyzer: 'security', ...extra })
// A pass's row, and a scan's beneath it, which the pass confirmed.
const pass = (id, model, extra = {}) => finding(id, model, { isApp: true, revalidate: 'revalidation', ...extra })
const scan = (id, model, extra = {}) => finding(id, model, { revalidate: 'confirmed', ...extra })
const ids = (groups) => groups.map((g) => g.map((f) => f.id))
const plain = (counts) => Object.fromEntries(Object.entries(counts).map(([column, values]) => [column, Object.fromEntries(values)]))

beforeEach(() => {
  state.reports = []
  state.currentWorkspace = null
  state.workspaceMerges = []
  state.showRevalidation = true
  state.revalidationDetailed = false
  state.upstreamOnly = false
  state.triage = new Map()
  state.activeTabByGroup = new Map()
  configureDepsDir([])
  configureRevalidation(true)
  resetFilters()
})
afterEach(() => configureRevalidation(true))

describe('App mode: Model and Validation model', () => {
  // [[revalidateA0, A0], [revalidateA1, B1]]
  const load = () => {
    state.reports = [{ fileName: 'report.json', groups: [[pass('pA0', 'A'), scan('A0', 'A')], [pass('pA1', 'A'), scan('B1', 'B')]] }]
  }

  it('counts each model once per row it would show, whatever the detail stop', () => {
    load()
    for (const detailed of [false, true]) {
      state.revalidationDetailed = detailed
      assert.deepEqual(plain(runFilterCounts(scopeRows(getMergedGroups()))),
        { analyzers: { security: 2 }, models: { A: 1, B: 1 }, validationModels: { A: 2 } }, `detailed: ${detailed}`)
    }
    // Under another column's selection, as the row would show.
    state.filterModel = 'B'
    assert.deepEqual(plain(runFilterCounts(scopeRows(getMergedGroups()))),
      { analyzers: { security: 1 }, models: { A: 1, B: 1 }, validationModels: { A: 1 } })
    state.filterModel = ''
    state.filterValidationModel = 'B'
    assert.deepEqual(plain(runFilterCounts(scopeRows(getMergedGroups()))),
      { analyzers: {}, models: {}, validationModels: { A: 2 } })
  })

  // The Analyzer column counted the drawn tabs, so another analyzer's
  // finding folded under a pass read 0, though picking it shows the row.
  it('counts an analyzer folded under a pass, as picking it shows the row', () => {
    state.reports = [{ fileName: 'report.json', groups: [
      [pass('pass', 'A'), scan('import', 'A', { _analyzer: 'claude-security' })], [finding('lone', 'A')],
    ] }]
    for (const detailed of [false, true]) {
      state.revalidationDetailed = detailed
      assert.deepEqual(plain(runFilterCounts(scopeRows(getMergedGroups()))).analyzers, { security: 2, 'claude-security': 1 }, `detailed: ${detailed}`)
      state.filterAnalyzer = 'claude-security'
      assert.deepEqual(ids(applyFilters(getMergedGroups())), [['pass', 'import']], `detailed: ${detailed}`)
      state.filterAnalyzer = ''
    }
  })

  it('shows the rows whose scans have the Model, drawn as the pass alone unless detailed', () => {
    load()
    for (const [model, row] of [['A', ['pA0', 'A0']], ['B', ['pA1', 'B1']]]) {
      state.filterModel = model
      state.revalidationDetailed = false
      assert.deepEqual(ids(applyFilters(getMergedGroups())), [row], model)
      assert.deepEqual(ids(applyScopeFilters(applyFilters(getMergedGroups()))), [[row[0]]], model)
      state.revalidationDetailed = true
      assert.deepEqual(ids(applyFilters(getMergedGroups())), [row], model)
    }
  })

  it('shows the rows with a pass of the Validation model, and asks both of a row as a whole', () => {
    load()
    state.filterValidationModel = 'A'
    assert.deepEqual(ids(applyFilters(getMergedGroups())), [['pA0', 'A0'], ['pA1', 'B1']])
    state.filterModel = 'B'
    assert.deepEqual(ids(applyFilters(getMergedGroups())), [['pA1', 'B1']])
    state.filterValidationModel = 'B'
    assert.deepEqual(ids(applyFilters(getMergedGroups())), [])
    // A row with no pass has no Validation model.
    state.filterModel = ''
    state.filterValidationModel = 'A'
    assert.deepEqual(applyFilters([[finding('lone', 'A')]]), [])
  })

  // The pass's row is what App mode draws: its severity, confidence and
  // outcome are the row's, and the scan the Model asks for need not
  // share them.
  it('asks a row with a pass the Model apart from what its other filters ask', () => {
    const row = [pass('p', 'A', { severity: 'critical' }), scan('s', 'B', { severity: 'high' })]
    state.filterSeverities = new Set(['critical'])
    state.filterModel = 'B'
    assert.deepEqual(applyFilters([row]), [row])
    assert.equal(row.some(matchesFilters), false, 'no one tab is both')
    // Without a pass the two are asked of one tab, as before.
    const unpassed = [finding('x', 'A', { severity: 'critical' }), finding('y', 'B')]
    assert.deepEqual(applyFilters([unpassed]), [])
  })

  it('asks the Analyzer and Model pair of one scan, the Analyzer alone of any tab', () => {
    const row = [pass('p', 'A', { _analyzer: 'pass' }), scan('s', 'B', { _analyzer: 'scan' })]
    state.filterAnalyzer = 'pass'
    assert.deepEqual(applyFilters([row]), [row])
    state.filterModel = 'B'
    assert.deepEqual(applyFilters([row]), [], 'the pass has no Model')
    state.filterAnalyzer = 'scan'
    assert.deepEqual(applyFilters([row]), [row])
    state.filterModel = 'A'
    assert.deepEqual(applyFilters([row]), [], 'nor does the scan have the pass\'s')
  })

  it('opens a detailed row on the scan with the Model, or the pass with the Validation model', () => {
    const row = [scan('s', 'B'), pass('p', 'A')]
    state.revalidationDetailed = true
    assert.equal(activeTabFor(row).id, 'p', 'the pass leads')
    state.filterModel = 'B'
    assert.equal(activeTabFor(row).id, 's')
    state.filterModel = ''
    state.filterValidationModel = 'A'
    assert.equal(activeTabFor(row).id, 'p')
  })

  // One analyzer, one model beneath, one validation model: the dropdown
  // is offered where picking that validation model leaves a row out.
  it('offers a single validation model where some row has no pass of it', () => {
    const one = (...values) => new Set(values)
    const columns = { analyzers: one('security'), models: one('A'), validationModels: one('A') }
    const validated = [pass('p', 'A'), scan('s', 'A')]
    assert.equal(runFiltersOffered([validated], columns), false)
    assert.equal(runFiltersOffered([validated, [finding('lone', 'A')]], columns), true)
    state.filterValidationModel = 'A'
    assert.deepEqual(ids(applyFilters([validated, [finding('lone', 'A')]])), [['p', 's']])
    assert.equal(runFiltersOffered([[finding('lone', 'A')]], { ...columns, validationModels: one() }), false)
    assert.equal(runFiltersOffered([[finding('lone', 'A')]], { ...columns, models: one('A', 'B'), validationModels: one() }), true)
  })

  // With the layer off no row is a pass's, so Model asks every row and
  // there is no Validation model.
  it('is plain Model with the revalidation layer off', () => {
    const rows = [[pass('pA0', 'A'), scan('A0', 'A')], [pass('pA1', 'A'), scan('B1', 'B')]]
    configureRevalidation(false)
    assert.deepEqual(plain(runFilterCounts(rows)), { analyzers: { security: 2 }, models: { A: 2, B: 1 }, validationModels: {} })
    state.filterModel = 'A'
    assert.deepEqual(applyFilters(rows), rows)
  })
})
