// `ui/view/markdown-export.js` — the "download report" serializer.
//
// Pins the one thing that separates it from a pure formatter: the
// per-user annotations it folds in come from the finding's TRIAGE
// ENTRY (state.triage), not from the finding object. The fix link
// read `f.fix` until this test existed — a field no parser, ingest
// path or fixture ever writes — so every exported report silently
// omitted the fix links their author had recorded.

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
const { reportsToMarkdown } = await import('../ui/view/markdown-export.js')

const PR = 'https://github.com/owner/repo/pull/42'

function report(finding) {
  return [{ fileName: 'r.json', groups: [[finding]] }]
}

const finding = (extra = {}) => ({
  id: 'f1', severity: 'high', file: 'src/a.js', line: 7,
  description: 'Token comparison is not constant-time.', _reportName: 'r.json', ...extra,
})

describe('reportsToMarkdown — triage annotations', () => {
  beforeEach(() => {
    state.triage.clear()
    state.reports = []
    state.filterSeverities = new Set()
    state.filterColors = new Set()
    state.filterSources = new Set()
    state.filterAnalyzer = ''
    state.filterModel = ''
    state.filterRepo = ''
    state.filterConfMin = 0
    state.filterConfMax = 10
    state.filterInclude = ''
    state.filterComment = ''
    state.filterFix = ''
    state.filterFlagged = ''
    state.shownTriage = null
  })

  it('emits the fix link recorded on the finding\'s triage entry', () => {
    const f = finding()
    state.triage.set(f.id, { fix: PR })
    const md = reportsToMarkdown(report(f))
    assert.match(md, /\*\*Fix:\*\* https:\/\/github\.com\/owner\/repo\/pull\/42/u)
  })

  it('emits no Fix line when the entry carries none', () => {
    const f = finding()
    state.triage.set(f.id, { comment: 'not fixed yet' })
    const md = reportsToMarkdown(report(f))
    assert.doesNotMatch(md, /\*\*Fix:\*\*/u)
    assert.match(md, /\*\*Comment:\*\* not fixed yet/u, 'the sibling annotation still lands')
  })
})
