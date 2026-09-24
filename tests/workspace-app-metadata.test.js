import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import './_polyfills.js'

globalThis[Symbol.for('@rray/frontend')] ??= { html: () => null, nothing: null, LitElement: class {}, StateElement: class {} }
const { workspaceAppMetadata } = await import('../ui/view/workspace-app.js')
const { configureRevalidation } = await import('../ui/view/format.js')
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
  it('does not promote empty, source-only, or import-only workspaces without a Confirmed default', () => {
    for (const reports of [[], [report('empty')], [report('source', [source('S')])], [report('import', [source('I', { isApp: true, _source: 'codex-security' })])]]) {
      assert.deepEqual(workspaceAppMetadata(reports), { appMode: false })
    }
  })
})
