import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import './_polyfills.js'

globalThis[Symbol.for('@rray/frontend')] ??= {
  LitElement: class {}, StateElement: class {}, html: () => null, nothing: null,
  render: () => null, unsafeCSS: () => null, classMap: () => null, repeat: () => null, styleMap: () => null,
}
const { state, saveFile, deleteFile, setCount, LINKS_KIND, ensureLinkedFindingsIndexed, ensureBundleFindingsIndexed } = await import('../client/index.js')
const { reportDuplicateIds } = await import('../ui/view/report-duplicates.js')
const { applyFilters, applyScopeFilters, cloneFilterFields, resetFilters } = await import('../ui/view/filters.js')
const { activeFilterDescriptions } = await import('../ui/view/export-summary.js')

let sequence = 0
const nextId = () => `deepview:${String(++sequence).padStart(8, '0')}-7777-4777-8777-777777777777`
const finding = (id, extra = {}) => ({ id, file: 'src/app.js', description: id, severity: 'high', confidence: 9, ...extra })
let a, b, c, d, e, externalName, f, groups, linksName, missing, names, reportName, x
const saveReport = async (name, rows) => {
  names.add(name)
  await saveFile(name, JSON.stringify({ type: 'security', findings: rows }))
}
const saveLinks = async (links) => {
  names.add(linksName)
  await saveFile(linksName, JSON.stringify(links.map((row) => row.map((id) => ({ id })))))
  setCount(linksName, links.length, LINKS_KIND)
  await ensureLinkedFindingsIndexed()
}

beforeEach(async () => {
  names = new Set()
  ;[a, b, c, d, e, f, x, missing] = Array.from({ length: 8 }, nextId)
  reportName = `duplicates-report-${sequence}.json`
  externalName = `duplicates-external-${sequence}.json`
  linksName = `duplicates-links-${sequence}.json`
  groups = [[finding(a), finding(b)], [finding(c)], [finding(d)], [finding(e, { confidence: 1 })], [finding(f)]]
  state.currentWorkspace = null
  state.currentFile = reportName
  state.reports = [{ fileName: reportName, groups }]
  state.triage = new Map()
  state.showRevalidation = true
  state.upstreamOnly = false
  state.revalidationDetailed = false
  resetFilters()
  await saveReport(reportName, groups)
  // E also exists elsewhere, but its ID belongs to the current report.
  await saveReport(externalName, [[finding(x)], [finding(e)]])
  await saveLinks([[b, x], [c, missing], [d, e]])
  await ensureBundleFindingsIndexed()
})
afterEach(async () => {
  resetFilters()
  for (const name of names) await deleteFile(name)
  state.reports = []
  state.currentFile = null
  state.currentWorkspace = null
})

describe('report-only Duplicates filter', () => {
  it('matches any member of a row and makes only/not complementary', () => {
    assert.deepEqual([...reportDuplicateIds()], [b])
    state.filterDuplicates = 'with'
    assert.deepEqual(applyFilters(groups), [groups[0]])
    state.filterDuplicates = 'without'
    assert.deepEqual(applyFilters(groups), groups.slice(1))
    state.filterDuplicates = ''
    assert.deepEqual(applyFilters(groups), groups)
  })

  it('ignores unresolved targets until a report supplies them, and stops counting deleted reports', async () => {
    assert.equal(reportDuplicateIds().has(c), false)
    const resolvedName = `duplicates-resolved-${sequence}.json`
    await saveReport(resolvedName, [[finding(missing)]])
    await ensureBundleFindingsIndexed()
    assert.equal(reportDuplicateIds().has(c), true)
    await deleteFile(resolvedName)
    assert.equal(reportDuplicateIds().has(c), false)
    await deleteFile(externalName)
    assert.equal(reportDuplicateIds().size, 0, 'only unresolved and report-local links remain')
  })

  it('excludes target IDs anywhere in the original report, even when hidden and also present elsewhere', () => {
    state.filterConfMin = 6
    state.filterDuplicates = 'with'
    assert.equal(reportDuplicateIds().has(d), false)
    assert.deepEqual(applyFilters(groups), [groups[0]])
  })

  it('requires an explicit direct link, not a transitive path or a repeated ID alone', async () => {
    await saveLinks([[d, e], [e, x]])
    assert.deepEqual([...reportDuplicateIds()], [e])
    assert.equal(reportDuplicateIds().has(d), false, 'D links only to E inside this report')
    assert.equal(reportDuplicateIds().has(b), false, 'overwritten links no longer count')
  })

  it('does not depend on the linked finding being triaged', () => {
    for (const triage of [undefined, 'inprogress', 'fixed', 'invalid', 'deleted', 'ignored']) {
      state.triage.set(x, { triage })
      assert.equal(reportDuplicateIds().has(b), true, String(triage))
    }
  })

  it('is inapplicable in workspace view and does not narrow second-row stats', () => {
    state.filterDuplicates = 'with'
    assert.deepEqual(applyScopeFilters(groups), groups)
    state.currentWorkspace = 'workspace'
    assert.equal(reportDuplicateIds().size, 0)
    assert.deepEqual(applyFilters(groups), groups)
    assert.ok(!activeFilterDescriptions().some((row) => row.key === 'duplicates'))
  })

  it('participates in filter resets and export selection', () => {
    state.filterDuplicates = 'without'
    const fields = cloneFilterFields()
    assert.equal(fields.filterDuplicates, 'without')
    assert.deepEqual(activeFilterDescriptions(fields).find((row) => row.key === 'duplicates'), {
      key: 'duplicates', label: 'Duplicates', value: 'Exclude rows linked to other reports', clear: { filterDuplicates: '' },
    })
    resetFilters()
    assert.equal(state.filterDuplicates, '')
  })
})
