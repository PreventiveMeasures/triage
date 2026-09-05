// `ui/view/export-summary.js` — the selection summary behind
// `<export-confirm-dialog>` (shown before Print / Markdown download).
// Pins the two things the dialog renders:
//   * counts — included / total / excluded over the current triage
//     bucket, narrowed by the active filters (the same applyFilters
//     both export paths use);
//   * activeFilterDescriptions — the humanized list of active filters,
//     gated to match filters.js (e.g. the source filter is a no-op
//     unless exactly one side is picked).

import assert from 'node:assert/strict'
import { beforeEach, describe, it } from 'node:test'

import './_polyfills.js'

// format.js → frontend-global.js throws at module load when the
// `@rray/frontend` slot isn't installed; stub it before the import
// chain evaluates (the summary path never calls these symbols).
const slotKey = Symbol.for('@rray/frontend')
if (!globalThis[slotKey]) {
  globalThis[slotKey] = {
    LitElement: class {}, html: () => null, nothing: null, render: () => null,
    unsafeCSS: () => null, StateElement: class {}, classMap: () => null,
    repeat: () => null, styleMap: () => null,
  }
}

const { state } = await import('../client/state.ts')
const { NO_REPO_SENTINEL, NULL_ANALYZER_SENTINEL } = await import('../ui/view/filters.js')
const { activeFilterDescriptions, exportBucketGroups, exportSelectionSummary } = await import('../ui/view/export-summary.js')

function reset() {
  state.filterSeverities = new Set()
  state.filterColors = new Set()
  state.filterSources = new Set()
  state.filterAnalyzer = ''
  state.filterModel = ''
  state.filterRepo = ''
  state.filterConfMin = 0
  state.filterConfMax = 10
  state.filterInclude = ''
  state.filterIncludeNegate = false
  state.filterComment = ''
  state.filterFix = ''
  state.filterFlagged = ''
  state.filterRevalidate = ''
  state.filterPartial = ''
  state.triage = new Map()
  state.shownTriage = null
  state.workspaceMerges = []
  state.reports = []
  state.viewMode = 'table'
}

// One single-finding group per finding (the common shape). Confidence
// is left undefined so the default 0..10 range passes everything
// through unless a test narrows it.
function loadFindings(...findings) {
  state.reports = [{ fileName: 'r.json', groups: findings.map((f) => [f]) }]
}
function makeFinding(id, extra = {}) {
  return { id, severity: 'high', file: `src/${id}.js`, description: `desc ${id}`, ...extra }
}

describe('exportSelectionSummary — counts', () => {
  beforeEach(reset)

  it('no filters: everything in the live bucket is included', () => {
    loadFindings(makeFinding('A'), makeFinding('B'), makeFinding('C'))
    const s = exportSelectionSummary('print')
    assert.equal(s.total, 3)
    assert.equal(s.included, 3)
    assert.equal(s.excluded, 0)
    assert.deepEqual(s.filters, [])
    assert.equal(s.bucketLabel, null)
  })

  it('a severity filter narrows included and reports the excluded remainder', () => {
    loadFindings(
      makeFinding('A', { severity: 'critical' }),
      makeFinding('B', { severity: 'high' }),
      makeFinding('C', { severity: 'low' }),
    )
    state.filterSeverities = new Set(['critical'])
    const s = exportSelectionSummary('print')
    assert.equal(s.total, 3)
    assert.equal(s.included, 1)
    assert.equal(s.excluded, 2)
  })

  it('the confidence range filters the count', () => {
    loadFindings(
      makeFinding('A', { confidence: 2 }),
      makeFinding('B', { confidence: 8 }),
    )
    state.filterConfMin = 5
    const s = exportSelectionSummary('print')
    assert.equal(s.included, 1)
    assert.equal(s.excluded, 1)
  })

  it('counts only the active triage bucket; bucketLabel names a trash view', () => {
    const live = makeFinding('A')
    const deleted = makeFinding('B')
    loadFindings(live, deleted)
    state.triage = new Map([[deleted.id, { triage: 'deleted' }]])
    // Live view (default): the deleted finding is out of the bucket.
    let s = exportSelectionSummary('print')
    assert.equal(s.total, 1)
    assert.equal(s.included, 1)
    assert.equal(s.bucketLabel, null)
    // Deleted view: only the deleted finding, labelled.
    state.shownTriage = 'deleted'
    s = exportSelectionSummary('print')
    assert.equal(s.total, 1)
    assert.equal(s.included, 1)
    assert.equal(s.bucketLabel, 'Deleted')
  })
})

describe('exportSelectionSummary — one basis for print and download', () => {
  beforeEach(reset)

  it('counts merged super-groups for both', () => {
    // Finding A in report 1, B in report 2, unioned by a cross-report
    // workspace merge — the merged on-screen set collapses them into
    // one super-group, and both exports serialize that set (the
    // markdown writes it as one finding with two cases), so both
    // count it once.
    const a = makeFinding('A')
    const b = makeFinding('B')
    state.reports = [
      { fileName: 'r1.json', groups: [[a]] },
      { fileName: 'r2.json', groups: [[b]] },
    ]
    state.workspaceMerges = [new Set(['A', 'B'])]

    for (const mode of ['print', 'download']) {
      const s = exportSelectionSummary(mode)
      assert.equal(s.total, 1, mode)
      assert.equal(s.included, 1, mode)
    }
    assert.equal(exportBucketGroups().length, 1)
  })
})

describe('exportSelectionSummary — focus mode print', () => {
  beforeEach(reset)

  it('flags focusedOnly only for print in the focus view-mode', () => {
    loadFindings(makeFinding('A'), makeFinding('B'))
    state.viewMode = 'focus'
    // Print from focus emits just the focused finding…
    assert.equal(exportSelectionSummary('print').focusedOnly, true)
    // …but the counts still describe the whole filtered queue, not 1.
    assert.equal(exportSelectionSummary('print').included, 2)
    // Download ignores view-mode (markdown serializes the full set).
    assert.equal(exportSelectionSummary('download').focusedOnly, false)
    // Any other view-mode prints the full filtered set.
    state.viewMode = 'list'
    assert.equal(exportSelectionSummary('print').focusedOnly, false)
  })
})

describe('activeFilterDescriptions', () => {
  beforeEach(reset)

  it('is empty when no filter narrows the export', () => {
    assert.deepEqual(activeFilterDescriptions(), [])
    // Both source sides ticked is a no-op (same as none), so it must
    // not appear — mirrors matchesFilters' size === 1 gate.
    state.filterSources = new Set(['own', 'modules'])
    assert.deepEqual(activeFilterDescriptions(), [])
  })

  it('lists severities in canonical order regardless of insertion order', () => {
    state.filterSeverities = new Set(['low', 'critical'])
    assert.deepEqual(activeFilterDescriptions(), [{ label: 'Severity', value: 'Critical, Low' }])
  })

  it('describes a single-sided source filter', () => {
    state.filterSources = new Set(['modules'])
    assert.deepEqual(activeFilterDescriptions(), [{ label: 'Source', value: 'Dependencies only' }])
  })

  it('formats the confidence range three ways', () => {
    state.filterConfMin = 5
    assert.deepEqual(activeFilterDescriptions(), [{ label: 'Confidence', value: '≥ 5' }])
    reset()
    state.filterConfMax = 8
    assert.deepEqual(activeFilterDescriptions(), [{ label: 'Confidence', value: '≤ 8' }])
    reset()
    state.filterConfMin = 3
    state.filterConfMax = 8
    assert.deepEqual(activeFilterDescriptions(), [{ label: 'Confidence', value: '3–8' }])
  })

  // The outcome dropdown replaces the confidence range in the toolbar
  // block, and filters.js skips the range while an outcome is selected
  // — so the description names the outcome instead of a range that is
  // not filtering anything.
  it('describes the revalidation outcome, in place of the confidence range', () => {
    state.filterConfMin = 5
    state.filterRevalidate = 'refuted'
    assert.deepEqual(activeFilterDescriptions(), [{ label: 'Revalidation', value: 'Refuted' }])
    state.filterRevalidate = 'unreachable'
    assert.deepEqual(activeFilterDescriptions(), [{ label: 'Revalidation', value: 'Unreachable' }])
    state.filterRevalidate = ''
    assert.deepEqual(activeFilterDescriptions(), [{ label: 'Confidence', value: '≥ 5' }], 'the range is back once the outcome is cleared')
  })

  it('folds the partial chip into the Confirmed outcome', () => {
    state.filterRevalidate = 'confirmed'
    assert.deepEqual(activeFilterDescriptions(), [{ label: 'Revalidation', value: 'Confirmed' }])
    state.filterPartial = 'exclude'
    assert.deepEqual(activeFilterDescriptions(), [{ label: 'Revalidation', value: 'Confirmed (full confirmations only)' }])
    state.filterPartial = 'only'
    assert.deepEqual(activeFilterDescriptions(), [{ label: 'Revalidation', value: 'Confirmed (partial confirmations only)' }])
    // The chip is inert under any other outcome.
    state.filterRevalidate = 'refuted'
    assert.deepEqual(activeFilterDescriptions(), [{ label: 'Revalidation', value: 'Refuted' }])
  })

  it('distinguishes a search query from a negated one', () => {
    state.filterInclude = 'sql'
    assert.deepEqual(activeFilterDescriptions(), [{ label: 'Search', value: '"sql"' }])
    state.filterIncludeNegate = true
    assert.deepEqual(activeFilterDescriptions(), [{ label: 'Excluding', value: '"sql"' }])
  })

  it('maps the analyzer / repo sentinels to the no-value buckets', () => {
    state.filterAnalyzer = NULL_ANALYZER_SENTINEL
    state.filterRepo = NO_REPO_SENTINEL
    assert.deepEqual(activeFilterDescriptions(), [
      { label: 'Analyzer', value: '(none)' },
      { label: 'Repository', value: '(no repo)' },
    ])
  })

  it('renders annotation tri-state filters as with / without', () => {
    state.filterComment = 'with'
    state.filterFix = 'without'
    assert.deepEqual(activeFilterDescriptions(), [
      { label: 'Annotation', value: 'With comment' },
      { label: 'Annotation', value: 'Without fix' },
    ])
  })
})
