// `ui/view/markdown-export.js` — the Download button's adapter over
// the report library's writer. The document itself is pinned in
// report/tests/write-md.test.js; this suite pins what the adapter
// feeds it: the on-screen selection (the triage bucket, the filters,
// the merged groups, the sort), the header the confirmation dialog's
// summary supplies, and the viewer's own answers — annotations off the
// TRIAGE ENTRY (findings carry no `fix` or `comment` field, ever),
// links resolved the way the card's are, and the report each case came
// from.

import assert from 'node:assert/strict'
import { beforeEach, describe, it } from 'node:test'

import './_polyfills.js'

// markdown-export → format.js → frontend-global.js throws at module
// load without the `@rray/frontend` slot; the boot path that installs
// it doesn't run under the test runner.
const slotKey = Symbol.for('@rray/frontend')
if (!globalThis[slotKey]) {
  globalThis[slotKey] = {
    LitElement: class {}, html: () => null, nothing: null, render: () => null,
    unsafeCSS: () => null, StateElement: class {}, classMap: () => null,
    repeat: () => null, styleMap: () => null,
  }
}

// markdown-export also pulls in `./dom.js`, which caches element
// references at module load, and lit-html, whose node build reaches
// for `document.createTreeWalker` when a `document` exists at all.
// Only `downloadReportsAsMarkdown` touches either; the serializer
// under test does not. `createTreeWalker` returns the same empty
// object lit's own no-document fallback uses.
globalThis.document ??= { querySelector: () => null, createTreeWalker: () => ({}) }

const { state } = await import('../client/state.ts')
const { createWorkspace } = await import('../client/workspaces.js')
const { clearFilterOverride, cloneFilterFields, setFilterOverride } = await import('../ui/view/filters.js')
const { reportsToMarkdown, targetFilename } = await import('../ui/view/markdown-export.js')

const PR = 'https://github.com/owner/repo/pull/42'

const finding = (extra = {}) => ({
  id: 'f1', severity: 'high', file: 'src/a.js', line: 7,
  description: 'Token comparison is not constant-time.', _reportName: 'r.json', ...extra,
})

function load(...findings) {
  state.reports = [{ fileName: 'r.json', source: null, repo: null, groups: findings.map((f) => [f]) }]
}

const line = (md, label) => {
  const m = new RegExp(`^- \\*\\*${label}:\\*\\* (.*)$`, 'mu').exec(md)
  return m ? m[1] : null
}
const findingHeadings = (md) => [...md.matchAll(/^### (.+)$/gmu)].map((m) => m[1])

function reset() {
  state.triage.clear()
  state.reports = []
  state.workspaceMerges = []
  state.currentFile = null
  state.currentWorkspace = null
  state.repoUrl = ''
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
  state.shownTriage = null
  state.showRevalidation = true
  state.severityMode = 'corrected'
  state.sortBy = 'severity'
}

describe('reportsToMarkdown — triage annotations', () => {
  beforeEach(reset)

  it('emits the fix link recorded on the finding\'s triage entry', () => {
    load(finding())
    state.triage.set('f1', { fix: PR })
    assert.equal(line(reportsToMarkdown(), 'Fix'), `<${PR}>`)
  })

  it('emits no Fix line when the entry carries none; the comment gets its section', () => {
    load(finding())
    state.triage.set('f1', { comment: 'not fixed yet', color: 'red', flagged: true })
    const md = reportsToMarkdown()
    assert.equal(line(md, 'Fix'), null)
    assert.equal(line(md, 'Triage'), 'Red mark · Flagged')
    assert.ok(md.endsWith('#### Comment\n\nnot fixed yet\n'), md)
  })
})

describe('reportsToMarkdown — the selection, as the dialog describes it', () => {
  beforeEach(reset)

  it('names the active filters and the counts in the header', () => {
    load(finding({ severity: 'critical', description: 'Kept' }), finding({ id: 'f2', severity: 'low', description: 'Dropped' }))
    state.filterSeverities = new Set(['critical'])
    state.filterInclude = 'kept'
    const md = reportsToMarkdown()
    assert.equal(line(md, 'Filters'), 'Severity: Critical · Search: "kept"')
    assert.equal(line(md, 'Included'), '1 of 2 findings (1 filtered out)')
    assert.deepEqual(findingHeadings(md), ['1. Kept'])
  })

  it('says so when nothing is filtered', () => {
    load(finding(), finding({ id: 'f2' }))
    const md = reportsToMarkdown()
    assert.equal(line(md, 'Filters'), 'none')
    assert.equal(line(md, 'Included'), 'all 2 findings')
    assert.equal(line(md, 'View'), 'Live findings')
  })

  it('exports the trash bucket being viewed, and says which', () => {
    load(finding({ description: 'Live one' }), finding({ id: 'f2', description: 'Deleted one' }))
    state.triage.set('f2', { triage: 'deleted' })
    state.shownTriage = 'deleted'
    const md = reportsToMarkdown()
    assert.equal(line(md, 'View'), 'Deleted findings')
    assert.deepEqual(findingHeadings(md), ['1. Deleted one'])
    assert.equal(line(md, 'Triage'), 'Deleted')
  })

  it('orders the findings as the screen does', () => {
    load(
      finding({ confidence: 3, description: 'Three' }),
      finding({ id: 'f2', confidence: 9, description: 'Nine' }),
      finding({ id: 'f3', confidence: 6, description: 'Six' }),
    )
    assert.deepEqual(findingHeadings(reportsToMarkdown()), ['1. Nine', '2. Six', '3. Three'])
  })

  it('writes a workspace merge as one finding with a case per report', () => {
    const a = finding({ id: 'A', _reportName: 'r1.json', description: 'Same finding' })
    const b = finding({ id: 'B', _reportName: 'r2.json', description: 'Same finding' })
    state.reports = [
      { fileName: 'r1.json', source: null, repo: null, groups: [[a]] },
      { fileName: 'r2.json', source: 'claude-security', repo: null, groups: [[b]] },
    ]
    state.workspaceMerges = [new Set(['A', 'B'])]
    const md = reportsToMarkdown()
    assert.equal(line(md, 'Reports'), '`r1.json`, `r2.json`')
    assert.equal(line(md, 'Source'), 'Claude Security')
    assert.equal(line(md, 'Included'), 'all 1 finding')
    assert.deepEqual(findingHeadings(md), ['1. Same finding'])
    assert.ok(md.includes('2 cases of this finding — reported in `r1.json`, `r2.json`.'), md)
    assert.match(md, /- \*\*Report:\*\* `r1.json`$/mu)
    assert.match(md, /- \*\*Report:\*\* `r2.json`$/mu)
  })
})

describe('reportsToMarkdown — the lenses', () => {
  beforeEach(reset)

  it('takes the revalidation layer off with the App switch', () => {
    load(finding({ revalidate: 'refuted', revalidateVerdict: 'Not reachable.' }))
    const on = reportsToMarkdown()
    assert.equal(line(on, 'View'), 'Live findings · app view — the revalidation pass is applied')
    assert.equal(line(on, 'Revalidation'), 'refuted')
    assert.ok(on.includes('#### Revalidation verdict\n\nNot reachable.'))
    state.showRevalidation = false
    const off = reportsToMarkdown()
    assert.equal(line(off, 'View'), 'Live findings · code view — the revalidation pass is not applied')
    assert.doesNotMatch(off, /Revalidation|Not reachable/u)
  })

  it('says nothing about a layer the set does not carry', () => {
    load(finding())
    state.showRevalidation = false
    assert.equal(line(reportsToMarkdown(), 'View'), 'Live findings')
  })

  it('follows the severity lens', () => {
    load(finding({ severity: 'medium', correctedSeverity: 'high' }))
    const corrected = reportsToMarkdown()
    assert.equal(line(corrected, 'View'), 'Live findings · corrected severities')
    assert.ok(corrected.includes('## High (1)'))
    state.severityMode = 'original'
    const original = reportsToMarkdown()
    assert.equal(line(original, 'View'), 'Live findings · original analyzer severities')
    assert.ok(original.includes('## Medium (1)'))
    assert.equal(line(original, 'Severity'), 'Medium — corrected to High')
  })
})

describe('reportsToMarkdown — links and names', () => {
  beforeEach(reset)

  it('links a location the way the card does, against the header chip\'s repo', () => {
    load(finding())
    state.repoUrl = 'https://github.com/o/r'
    const md = reportsToMarkdown()
    assert.equal(line(md, 'Repository'), '<https://github.com/o/r>')
    assert.equal(line(md, 'Location'), '[`src/a.js:7`](https://github.com/o/r/blob/HEAD/src/a.js#L7)')
  })

  it('links a dependency finding against its own upstream, and names it', () => {
    load(
      finding({ repo: { github: 'o/r' } }),
      finding({ id: 'f2', file: 'node_modules/left-pad/index.js', repo: { github: 'left-pad/left-pad' } }),
    )
    const md = reportsToMarkdown()
    assert.equal(line(md, 'Repository'), '[o/r](https://github.com/o/r)', 'the document is about the own-source repo')
    assert.match(md, /- \*\*Location:\*\* \[`node_modules\/left-pad\/index\.js:7`\]\(https:\/\/github\.com\/left-pad\/left-pad\/blob\/HEAD\/index\.js#L7\)\n- \*\*Severity:\*\* High\n- \*\*Repository:\*\* \[left-pad\/left-pad\]/u)
  })

  it('names a single report by its file, without the extension it arrived in', () => {
    load(finding())
    state.reports[0].fileName = 'security-foo.json'
    assert.match(reportsToMarkdown(), /^# security-foo\n\n- \*\*Report:\*\* `security-foo\.json`\n/u)
    assert.equal(targetFilename(), 'security-foo.md')
    state.reports[0].fileName = 'report.md'
    assert.equal(targetFilename(), 'report.md', 'not report.md.md')
    state.reports[0].fileName = 'org__repo:scan.codex'
    assert.equal(targetFilename(), 'org__repo-scan.md')
  })

  it('names a batch by what its reports share', () => {
    state.reports = [
      { fileName: 'security-a.json', source: null, repo: null, groups: [[finding({ id: 'A' })]] },
      { fileName: 'security-b.json', source: null, repo: null, groups: [[finding({ id: 'B' })]] },
    ]
    assert.match(reportsToMarkdown(), /^# security\n/u)
    assert.equal(targetFilename(), 'security-.md')
    state.reports[1].fileName = 'other.json'
    assert.match(reportsToMarkdown(), /^# 2 reports\n/u)
    assert.equal(targetFilename(), 'deepview-report.md')
  })

  it('names a workspace by its own name', async () => {
    const ws = await createWorkspace('Q3 audit / acme')
    assert.ok(ws, 'the workspace was created')
    load(finding())
    state.currentWorkspace = ws.id
    const md = reportsToMarkdown()
    assert.match(md, new RegExp(`^# ${ws.name.replaceAll(/[/.]/gu, '\\$&')}\n`, 'u'))
    assert.equal(line(md, 'Workspace'), ws.name)
    assert.equal(targetFilename(), `${ws.name.replaceAll('/', '-')}.md`)
  })
})

// The export confirm dialog lets a filter be dropped from the file
// without touching the toolbar. Mechanically that is a filter override
// installed around this serializer (events.js withExportFilters), so
// what the dialog counted and what gets written stay the same set — and
// the header has to describe THAT selection, not the toolbar's.
describe('reportsToMarkdown — under a dropped filter', () => {
  beforeEach(reset)

  it('writes what the relaxed selection lets through, and says so in the header', () => {
    load(finding({ severity: 'critical', description: 'Critical one' }), finding({ id: 'f2', severity: 'low', description: 'Low one' }))
    state.filterSeverities = new Set(['critical'])
    state.filterInclude = 'one'

    // As the toolbar has it: the low finding is filtered out.
    const narrow = reportsToMarkdown()
    assert.deepEqual(findingHeadings(narrow), ['1. Critical one'])
    assert.equal(line(narrow, 'Filters'), 'Severity: Critical · Search: "one"')

    // With the severity filter dropped from THIS export, both land, and
    // the header lists only the filter still narrowing.
    setFilterOverride({ ...cloneFilterFields(), filterSeverities: new Set() })
    let md
    try {
      md = reportsToMarkdown()
    } finally {
      clearFilterOverride()
    }
    assert.deepEqual(findingHeadings(md), ['1. Critical one', '2. Low one'])
    assert.equal(line(md, 'Filters'), 'Search: "one"')
    assert.equal(line(md, 'Included'), 'all 2 findings')

    // The toolbar never moved, and the next export is narrow again.
    assert.deepEqual([...state.filterSeverities], ['critical'])
    assert.deepEqual(findingHeadings(reportsToMarkdown()), ['1. Critical one'])
  })
})
