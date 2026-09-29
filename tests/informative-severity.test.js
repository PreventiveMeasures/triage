import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import './_polyfills.js'

globalThis[Symbol.for('@rray/frontend')] ??= {
  LitElement: class {}, StateElement: class {}, html: () => null, nothing: null,
}
const { state } = await import('../client/state.ts')
const { matchesFilters, resetFilters } = await import('../ui/view/filters.js')
const { computeFindingCountsByFile } = await import('../ui/view/file-counts.js')
const { loadManagedFindings } = await import('../common/managed/report-content.ts')

afterEach(() => { resetFilters(); state.severityMode = 'corrected' })

test('the Info filter and file/graph counts include Informative in both severity lenses', () => {
  resetFilters()
  state.filterConfMin = 0
  state.filterSeverities = new Set(['informational'])
  const f = { id: 'note', file: 'src/a.js', severity: 'informative', description: 'Note' }
  for (const mode of ['original', 'corrected']) {
    state.severityMode = mode
    assert.equal(matchesFilters(f), true)
    assert.equal(matchesFilters({ ...f, severity: 'low' }), false)
    const counts = computeFindingCountsByFile([[f]], mode).get(f.file)
    assert.equal(counts.informational, 1)
    assert.equal(counts.informative, undefined)
  }
  assert.equal(matchesFilters({ ...f, severity: 'high', correctedSeverity: 'Informative' }), true)
})

test('managed report loading exposes the canonical tier with the saved identity', async () => {
  const content = JSON.stringify({ findings: [{ id: 'saved-note', severity: 'informative', correctedSeverity: 'Informative', description: 'Note' }] })
  const [f] = (await loadManagedFindings(content, 'report.json')).findings
  assert.equal(f.id, 'saved-note')
  assert.equal(f.severity, 'informational')
  assert.equal(f.correctedSeverity, 'informational')
})
