import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import './_polyfills.js'

const { workspaceAppMetadata } = await import('../common/workspace-app.js')
const { configureRevalidation } = await import('../ui/view/format.js')
const { applyOpeningFilters, shouldLockConfirmed } = await import('../ui/view/filters.js')
const { state } = await import('../client/state.ts')
const { collectDuplicates } = await import('../client/linked-findings.js')
const source = (id, extra = {}) => ({ id, severity: 'high', confidence: 9, file: 'src/app.js', isApp: false, ...extra })
const app = (id, extra = {}) => source(id, { revalidate: 'revalidation', isApp: true, ...extra })
const report = (fileName, ...groups) => ({ fileName, groups })
const links = (...groups) => {
  const index = new Map()
  collectDuplicates(groups, index)
  return (id) => [...index.get(id) ?? []]
}

describe('workspace App promotion', () => {
  let saved
  beforeEach(() => {
    const fields = ['showRevalidation', 'upstreamOnly', 'revalidationDetailed', 'shownTriage', 'severityMode']
    saved = Object.fromEntries(fields.map((key) => [key, state[key]]))
    state.severityMode = 'corrected'
  })
  afterEach(() => {
    Object.assign(state, saved)
    configureRevalidation(state.showRevalidation, state.upstreamOnly)
  })
  it('evaluates basic App mode without changing the current lens or triage bucket', () => {
    state.showRevalidation = false
    state.upstreamOnly = true
    state.revalidationDetailed = true
    state.shownTriage = 'confirmed'
    configureRevalidation(false, true)
    const before = { ...state }
    const reports = [report('source', [source('S')]), report('app', [app('A'), source('S', { revalidate: 'confirmed' })])]
    assert.deepEqual(workspaceAppMetadata(reports), { appMode: true, appFindings: 1 })
    for (const key of Object.keys(saved)) assert.equal(state[key], before[key])
  })
  it('counts rows after duplicate reports and explicit links, excluding source-only rows', () => {
    const reports = [
      report('first', [app('A')], [app('B')], [source('low', { confidence: 2 })]),
      report('copy', [app('A')]),
      report('import', [source('C', { isApp: true, _source: 'codex-security' })]),
    ]
    assert.deepEqual(workspaceAppMetadata(reports), { appMode: true, appFindings: 3 })
    assert.deepEqual(workspaceAppMetadata(reports, links(['A', 'B'], ['B', 'C'])), { appMode: true, appFindings: 1 })
  })
  it('uses corrected severity for promotion regardless of the active severity lens', () => {
    const reports = [report('app',
      ...Array.from({ length: 30 }, (_, i) => [app(`A${i}`)]),
      [source('uncovered', { confidence: 6, correctedSeverity: 'low' })],
    )]
    for (const mode of ['original', 'corrected']) {
      state.severityMode = mode
      assert.deepEqual(workspaceAppMetadata(reports), { appMode: true, appFindings: 30 }, mode)
      assert.equal(state.severityMode, mode, 'metadata calculation must not change the selected lens')
    }
  })
  it('does not link through folded-away source tabs or count ruled-out App findings', () => {
    const reports = [report('app', [app('A'), source('S', { revalidate: 'confirmed' })], [app('B')], [app('R', { revalidate: 'refuted' })])]
    assert.deepEqual(workspaceAppMetadata(reports, links(['S', 'B'])), { appMode: true, appFindings: 2 })
  })
  it('resets promotion for uncovered source findings and contradictory verdicts', () => {
    const reports = [report('app', [app('A')])]
    assert.equal(workspaceAppMetadata(reports).appMode, true)
    assert.deepEqual(workspaceAppMetadata([...reports, report('new', [source('new')])]), { appMode: false })
    assert.deepEqual(workspaceAppMetadata([
      report('a', [app('A'), source('S', { revalidate: 'confirmed' })]),
      report('b', [app('A'), source('S', { revalidate: 'partial' })]),
    ]), { appMode: false })
  })
  it('does not promote empty or source-only workspaces without a Confirmed default', () => {
    for (const reports of [[], [report('empty')], [report('source', [source('S')])]]) {
      assert.deepEqual(workspaceAppMetadata(reports), { appMode: false })
    }
  })
  it('counts the rows of a workspace that is not App only when asked', () => {
    const reports = [report('source', [source('S')], [source('T')]), report('copy', [source('S')])]
    assert.deepEqual(workspaceAppMetadata(reports, () => [], { countFindings: true }), { appMode: false, findings: 2 }, 'duplicate rows merge before counting')
    assert.deepEqual(workspaceAppMetadata(reports, links(['S', 'T']), { countFindings: true }), { appMode: false, findings: 1 }, 'linked rows count once')
    assert.deepEqual(workspaceAppMetadata([report('app', [app('A')])], () => [], { countFindings: true }), { appMode: true, appFindings: 1 }, 'an App workspace keeps its App count')
  })
  it('promotes a workspace of nothing but unjudged imports, which is its own App view', () => {
    const imported = (id, extra = {}) => source(id, { isApp: true, _source: 'codex-security', confidence: undefined, ...extra })
    assert.deepEqual(workspaceAppMetadata([report('import', [imported('I')], [imported('J')])]), { appMode: true, appFindings: 2 })
    assert.deepEqual(workspaceAppMetadata([report('import', [imported('I', { _sourcePass: true })])]), { appMode: false },
      'an import its report holds a pass for still needs the pass to answer it')
    assert.deepEqual(workspaceAppMetadata([report('import', [imported('I')]), report('source', [source('S')])]), { appMode: false },
      'an uncovered source row keeps a mixed workspace out of App mode')
  })
  it('keeps the confidence range of scored imports in their App view, with no outcome filter', () => {
    const scored = [[source('high', { isApp: true, _source: 'deepsec', confidence: 9 })], [source('low', { isApp: true, _source: 'deepsec', confidence: 3 })]]
    assert.deepEqual(workspaceAppMetadata([report('deepsec', ...scored)]), { appMode: true, appFindings: 2 })
    const fields = ['filterConfMin', 'filterConfMax', 'filterRevalidate', 'filterPartial', 'sortBy']
    const before = Object.fromEntries(fields.map((key) => [key, state[key]]))
    try {
      state.showRevalidation = true
      state.upstreamOnly = false
      state.revalidationDetailed = false
      configureRevalidation(true)
      applyOpeningFilters(scored)
      assert.equal(state.filterConfMin, 4, 'the opening floor still tunes to the imports\' own scores')
      assert.equal(state.filterRevalidate, '', 'no pass, so no outcome to open on')
      assert.equal(shouldLockConfirmed(scored), false)
    } finally {
      Object.assign(state, before)
    }
  })
})
