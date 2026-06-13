// `ui/view/markdown-export.js` — the markdown format behind the
// download dialog. Pins the "export everything" toggle (bypassing
// filters + triage bucket) and the filename heuristic. Pure (no DOM —
// the download itself lives in download-reports.js), so imported direct.

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
const { reportsToMarkdown, exportFilename } = await import('../ui/view/markdown-export.js')

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
function makeFinding(id, extra = {}) {
  return { id, severity: 'high', file: `src/${id}.js`, line: 10, description: `desc ${id}`, ...extra }
}

describe('reportsToMarkdown — export scope', () => {
  beforeEach(reset)

  it('follows the active filters by default', () => {
    state.reports = [{ fileName: 'r.json', groups: [
      [makeFinding('A', { severity: 'critical' })],
      [makeFinding('B', { severity: 'low' })],
    ] }]
    state.filterSeverities = new Set(['critical'])
    const md = reportsToMarkdown(state.reports)
    assert.match(md, /src\/A\.js/u)
    assert.doesNotMatch(md, /src\/B\.js/u)
  })

  it('{ all: true } ignores both filters and the triage bucket', () => {
    const deleted = makeFinding('B', { severity: 'low' })
    state.reports = [{ fileName: 'r.json', groups: [
      [makeFinding('A', { severity: 'critical' })],
      [deleted],
    ] }]
    state.triage = new Map([[deleted.id, { triage: 'deleted' }]])
    state.filterSeverities = new Set(['critical'])
    const md = reportsToMarkdown(state.reports, { all: true })
    assert.match(md, /src\/A\.js/u)
    assert.match(md, /src\/B\.js/u) // included despite the filter + deleted state
  })
})

describe('exportFilename', () => {
  it('uses a single report name, stripping .json and applying the extension', () => {
    assert.equal(exportFilename([{ fileName: 'security-foo.json' }], 'md'), 'security-foo.md')
    assert.equal(exportFilename([{ fileName: 'security-foo.json' }], 'csv'), 'security-foo.csv')
  })

  it('uses the common prefix for multiple reports', () => {
    assert.equal(
      exportFilename([{ fileName: 'security-foo.json' }, { fileName: 'security-bar.json' }], 'csv'),
      'security-.csv',
    )
  })

  it('falls back to a default stem when there is no name', () => {
    assert.equal(exportFilename([{ fileName: '' }], 'md'), 'deepview-report.md')
  })
})
