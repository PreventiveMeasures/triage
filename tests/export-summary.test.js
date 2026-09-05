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
const { NO_REPO_SENTINEL, NULL_ANALYZER_SENTINEL, applyFilters, cloneFilterFields } = await import('../ui/view/filters.js')
const { exportSelectionSummary, activeFilterDescriptions } = await import('../ui/view/export-summary.js')

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

describe('exportSelectionSummary — print vs download basis', () => {
  beforeEach(reset)

  it('counts merged super-groups for print but per-report groups for download', () => {
    // Finding A in report 1, B in report 2, unioned by a cross-report
    // workspace merge — so the merged on-screen set (print) collapses
    // them into one super-group while the markdown download iterates
    // each report's own groups.
    const a = makeFinding('A')
    const b = makeFinding('B')
    state.reports = [
      { fileName: 'r1.json', groups: [[a]] },
      { fileName: 'r2.json', groups: [[b]] },
    ]
    state.workspaceMerges = [new Set(['A', 'B'])]

    const print = exportSelectionSummary('print')
    assert.equal(print.total, 1)
    assert.equal(print.included, 1)

    const download = exportSelectionSummary('download')
    assert.equal(download.total, 2)
    assert.equal(download.included, 2)
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

// The wording / ordering / gating assertions below care about what a
// row SAYS. Each row also carries the `key` and `clear` patch the
// confirm dialog drops it with; those are pinned in their own block
// further down rather than repeated into every expectation here.
function described(fields) {
  return activeFilterDescriptions(fields).map(({ label, value }) => ({ label, value }))
}

describe('activeFilterDescriptions', () => {
  beforeEach(reset)

  it('is empty when no filter narrows the export', () => {
    assert.deepEqual(described(), [])
    // Both source sides ticked is a no-op (same as none), so it must
    // not appear — mirrors matchesFilters' size === 1 gate.
    state.filterSources = new Set(['own', 'modules'])
    assert.deepEqual(described(), [])
  })

  it('lists severities in canonical order regardless of insertion order', () => {
    state.filterSeverities = new Set(['low', 'critical'])
    assert.deepEqual(described(), [{ label: 'Severity', value: 'Critical, Low' }])
  })

  it('describes a single-sided source filter', () => {
    state.filterSources = new Set(['modules'])
    assert.deepEqual(described(), [{ label: 'Source', value: 'Dependencies only' }])
  })

  it('formats the confidence range three ways', () => {
    state.filterConfMin = 5
    assert.deepEqual(described(), [{ label: 'Confidence', value: '≥ 5' }])
    reset()
    state.filterConfMax = 8
    assert.deepEqual(described(), [{ label: 'Confidence', value: '≤ 8' }])
    reset()
    state.filterConfMin = 3
    state.filterConfMax = 8
    assert.deepEqual(described(), [{ label: 'Confidence', value: '3–8' }])
  })

  it('distinguishes a search query from a negated one', () => {
    state.filterInclude = 'sql'
    assert.deepEqual(described(), [{ label: 'Search', value: '"sql"' }])
    state.filterIncludeNegate = true
    assert.deepEqual(described(), [{ label: 'Excluding', value: '"sql"' }])
  })

  it('maps the analyzer / repo sentinels to the no-value buckets', () => {
    state.filterAnalyzer = NULL_ANALYZER_SENTINEL
    state.filterRepo = NO_REPO_SENTINEL
    assert.deepEqual(described(), [
      { label: 'Analyzer', value: '(none)' },
      { label: 'Repository', value: '(no repo)' },
    ])
  })

  it('renders annotation tri-state filters as with / without', () => {
    state.filterComment = 'with'
    state.filterFix = 'without'
    assert.deepEqual(described(), [
      { label: 'Annotation', value: 'With comment' },
      { label: 'Annotation', value: 'Without fix' },
    ])
  })
})

// The confirm dialog's × drops a filter from the EXPORT and nothing
// else: it works on a clone of the filter state, applies the row's own
// `clear` patch to it, and recounts. These pin both halves — that the
// patch removes exactly its row, and that `state` never moves.
describe('activeFilterDescriptions — dropping a filter', () => {
  beforeEach(reset)

  it('every row carries a key and a clear patch that removes it', () => {
    state.filterSeverities = new Set(['critical'])
    state.filterColors = new Set(['red'])
    state.filterSources = new Set(['own'])
    state.filterAnalyzer = 'semgrep'
    state.filterRepo = 'acme/app'
    state.filterConfMin = 4
    state.filterInclude = 'sql'
    state.filterComment = 'with'

    const rows = activeFilterDescriptions()
    assert.equal(new Set(rows.map((r) => r.key)).size, rows.length, 'keys are unique')

    // Dropping each row in turn leaves the others exactly as they were.
    for (const row of rows) {
      const relaxed = { ...cloneFilterFields(), ...row.clear }
      const left = activeFilterDescriptions(relaxed)
      assert.deepEqual(left.map((r) => r.key), rows.filter((r) => r !== row).map((r) => r.key), row.key)
    }
  })

  it('a drop leaves the live toolbar selection untouched', () => {
    state.filterSeverities = new Set(['critical', 'high'])
    const [severity] = activeFilterDescriptions()
    const relaxed = { ...cloneFilterFields(), ...severity.clear }

    assert.deepEqual(activeFilterDescriptions(relaxed), [])
    // The clone was relaxed; the real selection was not.
    assert.deepEqual([...state.filterSeverities], ['critical', 'high'])
    assert.equal(activeFilterDescriptions().length, 1)
  })

  it('the confidence row hands back both bounds, and search its negate flag', () => {
    state.filterConfMin = 3
    state.filterConfMax = 8
    const [confidence] = activeFilterDescriptions()
    assert.deepEqual(confidence.clear, { filterConfMin: 0, filterConfMax: 10 })

    reset()
    state.filterInclude = 'sql'
    state.filterIncludeNegate = true
    const [search] = activeFilterDescriptions()
    // The flag filters nothing alone, but left set it would invert
    // whatever query was assigned next.
    assert.deepEqual(search.clear, { filterInclude: '', filterIncludeNegate: false })
  })

  it('gives the three annotation rows distinct keys under one label', () => {
    state.filterComment = 'with'
    state.filterFix = 'without'
    state.filterFlagged = 'with'
    const rows = activeFilterDescriptions()
    assert.deepEqual(rows.map((r) => r.label), ['Annotation', 'Annotation', 'Annotation'])
    assert.deepEqual(rows.map((r) => r.key), ['annotation:comment', 'annotation:fix', 'annotation:flag'])
    // Dropping the middle one leaves the other two.
    const relaxed = { ...cloneFilterFields(), ...rows[1].clear }
    assert.deepEqual(activeFilterDescriptions(relaxed).map((r) => r.key), ['annotation:comment', 'annotation:flag'])
  })
})

describe('exportSelectionSummary — counting under a relaxed selection', () => {
  beforeEach(reset)

  it('recounts against the clone without moving the real filters', () => {
    loadFindings(
      makeFinding('A', { severity: 'critical' }),
      makeFinding('B', { severity: 'high' }),
      makeFinding('C', { severity: 'low' }),
    )
    state.filterSeverities = new Set(['critical'])

    const before = exportSelectionSummary('print')
    assert.equal(before.included, 1)
    assert.equal(before.excluded, 2)

    const [severity] = before.filters
    const after = exportSelectionSummary('print', { ...before.fields, ...severity.clear })
    assert.equal(after.included, 3)
    assert.equal(after.excluded, 0)
    assert.deepEqual(after.filters, [])
    // Same bucket either way — dropping a filter widens what is
    // included, never what is in scope.
    assert.equal(after.total, before.total)

    // And the toolbar is where the user left it.
    assert.deepEqual([...state.filterSeverities], ['critical'])
    assert.equal(exportSelectionSummary('print').included, 1)
  })

  it('echoes the fields it counted under, defaulting to a clone of state', () => {
    loadFindings(makeFinding('A'))
    state.filterSeverities = new Set(['critical'])
    const s = exportSelectionSummary('download')
    assert.deepEqual([...s.fields.filterSeverities], ['critical'])
    // A clone, not the live Set: mutating it must not reach `state`.
    s.fields.filterSeverities.clear()
    assert.deepEqual([...state.filterSeverities], ['critical'])
  })

  it('leaves the override off after counting, so the app filters normally', () => {
    loadFindings(
      makeFinding('A', { severity: 'critical' }),
      makeFinding('B', { severity: 'low' }),
    )
    state.filterSeverities = new Set(['critical'])
    // Count under a relaxed clone…
    exportSelectionSummary('print', { ...cloneFilterFields(), filterSeverities: new Set() })
    // …then the next unrelaxed pass must be back to the real filters.
    assert.equal(applyFilters(state.reports[0].groups).length, 1)
  })
})
