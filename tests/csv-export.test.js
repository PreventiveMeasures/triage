// `ui/view/csv-export.js` — the CSV format behind the download dialog.
// Pins the row shape, RFC-4180 quoting, formula-injection guard, the
// filtered-vs-"export everything" selection, and that per-finding
// triage annotations are included. Pure (no DOM — the download itself
// lives in download-reports.js), so the test imports it straight.

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
const { reportsToCsv } = await import('../ui/view/csv-export.js')

const HEADER = 'Report,Severity,Confidence,File,Line,Name,Triage,Mark,Flagged,Comment,Fix,Description'

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
}

function loadFindings(...findings) {
  state.reports = [{ fileName: 'r.json', groups: findings.map((f) => [f]) }]
}
function makeFinding(id, extra = {}) {
  return { id, severity: 'high', file: `src/${id}.js`, line: 10, description: `desc ${id}`, ...extra }
}
// CRLF-terminated rows; the trailing CRLF yields a final '' which we drop.
function rows(csv) {
  const parts = csv.split('\r\n')
  assert.equal(parts.at(-1), '', 'CSV should end with a trailing CRLF')
  return parts.slice(0, -1)
}

describe('reportsToCsv', () => {
  beforeEach(reset)

  it('emits the header then one row per finding', () => {
    loadFindings(makeFinding('A'), makeFinding('B'))
    const r = rows(reportsToCsv(state.reports))
    assert.equal(r[0], HEADER)
    assert.equal(r.length, 3)
    assert.equal(r[1], 'r.json,high,,src/A.js,10,,,,,,,desc A')
  })

  it('follows the active filters by default, exports all with { all: true }', () => {
    loadFindings(
      makeFinding('A', { severity: 'critical' }),
      makeFinding('B', { severity: 'low' }),
    )
    state.filterSeverities = new Set(['critical'])
    assert.equal(rows(reportsToCsv(state.reports)).length, 2) // header + critical
    assert.equal(rows(reportsToCsv(state.reports, { all: true })).length, 3) // header + both
  })

  it('{ all: true } also bypasses the triage bucket', () => {
    const live = makeFinding('A')
    const deleted = makeFinding('B')
    loadFindings(live, deleted)
    state.triage = new Map([[deleted.id, { triage: 'deleted' }]])
    // Default (live view): the deleted finding is out.
    assert.equal(rows(reportsToCsv(state.reports)).length, 2)
    // Everything: both, regardless of triage state.
    assert.equal(rows(reportsToCsv(state.reports, { all: true })).length, 3)
  })

  it('quotes cells with commas / quotes per RFC 4180', () => {
    loadFindings(makeFinding('A', { description: 'a,"b"' }))
    assert.ok(rows(reportsToCsv(state.reports))[1].endsWith(',"a,""b"""'))
  })

  it('neutralizes spreadsheet formula injection in leading =,+,-,@ cells', () => {
    loadFindings(makeFinding('A', { description: '=SUM(A1:A2)' }))
    assert.ok(rows(reportsToCsv(state.reports))[1].endsWith(",'=SUM(A1:A2)"))
  })

  it('includes the viewer per-finding triage annotations', () => {
    const f = makeFinding('A')
    loadFindings(f)
    state.triage = new Map([[f.id, { triage: 'fixed', color: 'red', flagged: true, comment: 'cmt', fix: 'PR#1' }]])
    // A `fixed` finding leaves the live bucket, so read it via { all }.
    assert.equal(rows(reportsToCsv(state.reports, { all: true }))[1], 'r.json,high,,src/A.js,10,,fixed,red,yes,cmt,PR#1,desc A')
  })
})
