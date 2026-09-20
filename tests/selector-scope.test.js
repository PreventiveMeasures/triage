// Toolbar statistics and repository choices follow the source/confidence/
// outcome scope, independently of the filters that refine those choices.
import assert from 'node:assert/strict'
import { beforeEach, describe, it } from 'node:test'
import './_polyfills.js'

const slotKey = Symbol.for('@rray/frontend')
if (!globalThis[slotKey]) {
  globalThis[slotKey] = {
    LitElement: class {}, html: () => null, nothing: null, render: () => null,
    unsafeCSS: () => null, StateElement: class {}, classMap: () => null,
    repeat: () => null, styleMap: () => null,
  }
}
const { state } = await import('../client/state.ts')
const { applyFilters, applyScopeFilters, resetFilters } = await import('../ui/view/filters.js')
const { configureDepsDir, configureRevalidation } = await import('../ui/view/format.js')
const { getMergedGroups } = await import('../ui/view/group.js')
const finding = (id, extra = {}) => ({ id, file: `src/${id}.js`, severity: 'high', confidence: 9, ...extra })
const ids = (groups) => groups.map((g) => g.map((f) => f.id))

beforeEach(() => {
  state.reports = []
  state.currentWorkspace = null
  state.workspaceMerges = []
  state.showRevalidation = true
  state.revalidationDetailed = false
  state.upstreamOnly = false
  state.triage = new Map()
  configureDepsDir([])
  configureRevalidation(true)
  resetFilters()
})

describe('selector scope', () => {
  it('applies both confidence bounds and retains whole matching rows', () => {
    const mixed = [finding('low-tab', { confidence: 2 }), finding('match', { confidence: 8 })]
    const groups = [[finding('low', { confidence: 3 })], mixed, [finding('high', { confidence: 10 })]]
    state.filterConfMin = 6
    state.filterConfMax = 9
    assert.deepEqual(applyScopeFilters(groups), [mixed])
    assert.equal(applyScopeFilters(groups)[0], mixed, 'no trimming or copying of surviving rows')
  })

  it('lets Confirmed replace confidence and respects its partial selector', () => {
    const groups = [
      [finding('confirmed', { confidence: 2, revalidate: 'confirmed' })],
      [finding('pass', { confidence: 2, revalidate: 'revalidation' })],
      [finding('partial', { confidence: 9, revalidate: 'partial' })],
      [finding('unconfirmed')],
      [finding('refuted', { revalidate: 'refuted' })],
    ]
    state.filterConfMin = 8
    state.filterRevalidate = 'confirmed'
    assert.deepEqual(ids(applyScopeFilters(groups)), [['confirmed'], ['pass'], ['partial']])
    state.filterPartial = 'exclude'
    assert.deepEqual(ids(applyScopeFilters(groups)), [['confirmed']])
    state.filterPartial = 'only'
    assert.deepEqual(ids(applyScopeFilters(groups)), [['partial']])
  })

  it('combines sources/dependencies with confidence on the same finding', () => {
    const dep = finding('dep', { file: 'dependencies/pkg/index.js' })
    const ownLow = finding('own-low', { confidence: 2 })
    const own = finding('own')
    const groups = [[dep, ownLow], [own]]
    state.filterSources = new Set(['own'])
    state.filterConfMin = 6
    assert.deepEqual(applyScopeFilters(groups), [[own]])
    state.filterSources = new Set(['modules'])
    assert.deepEqual(applyScopeFilters(groups), [[dep, ownLow]])
    state.filterSources.add('own')
    assert.deepEqual(applyScopeFilters(groups), groups)
  })

  it('does not let severity, analyzer, model, repository, color, search or annotations shrink the base', () => {
    const groups = [[finding('visible')]]
    state.filterSeverities = new Set(['critical'])
    state.filterAnalyzer = 'missing'
    state.filterModel = 'missing'
    state.filterRepo = 'missing'
    state.filterColors = new Set(['red'])
    state.filterInclude = 'missing'
    state.filterComment = 'with'
    state.filterFix = 'with'
    state.filterFlagged = 'with'
    assert.deepEqual(applyFilters(groups), [])
    assert.deepEqual(applyScopeFilters(groups), groups)
  })

  it('uses the rows supplied by the App, underlying, source and upstream lenses', () => {
    const app = finding('app', { isApp: true, revalidate: 'revalidation' })
    const dep = finding('dep', { isUpstream: true, file: 'dependencies/pkg/index.js', revalidate: 'confirmed' })
    const refuted = finding('refuted', { isUpstream: true, file: 'dependencies/pkg/other.js', revalidate: 'refuted' })
    state.reports = [{ fileName: 'report.json', groups: [[app, dep], [refuted]] }]
    assert.deepEqual(ids(applyScopeFilters(getMergedGroups())), [['app']])
    state.revalidationDetailed = true
    assert.deepEqual(ids(applyScopeFilters(getMergedGroups())), [['app', 'dep'], ['refuted']])
    state.revalidationDetailed = false
    state.showRevalidation = false
    configureRevalidation(false)
    assert.deepEqual(ids(applyScopeFilters(getMergedGroups())), [['dep'], ['refuted']])
    state.showRevalidation = true
    state.upstreamOnly = true
    configureRevalidation(true, true)
    assert.deepEqual(ids(applyScopeFilters(getMergedGroups())), [['dep'], ['refuted']])
  })
})
