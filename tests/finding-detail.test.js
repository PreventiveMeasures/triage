import assert from 'node:assert/strict'
import { test } from 'node:test'
import { FINDING_DETAIL_FIELDS, liteReportData, liteWorkspace } from '../common/managed/finding-detail.js'
import { readLiteReportData } from '../common/managed/lite-name.js'

test('a report\'s board copy leaves each finding\'s detail out, an untitled one keeping as much of its name as a card shows', () => {
  const detail = Object.fromEntries(FINDING_DETAIL_FIELDS.map(field => [field, field]))
  const long = 'y'.repeat(300)
  const data = { source: 'codex-security', bundleHashes: ['b'], findings: [
    { id: 'a', title: 'Named', severity: 'high', ...detail },
    [{ id: 'b', ...detail, description: `${long}\nbody` }, { id: 'c', description: '' }, null],
  ] }
  const lite = liteReportData(data)
  assert.deepEqual(lite, { source: 'codex-security', bundleHashes: ['b'], findings: [
    { id: 'a', title: 'Named', severity: 'high' },
    [{ id: 'b', description: `${long.slice(0, 117)}...` }, { id: 'c' }, null],
  ] })
  assert.equal(data.findings[0].evidence, 'evidence', 'the report itself is left whole')
  assert.deepEqual(liteReportData({ groups: [[{ id: 'g', impact: 'i' }]] }), { groups: [[{ id: 'g' }]] })
  const links = { source: 'links', links: [['a', 'b']] }
  assert.strictEqual(liteReportData(links), links)
  const read = readLiteReportData(structuredClone(lite))
  assert.equal(read.findings[1][0].description, `${long.slice(0, 117)}…`, 'a name cut ends in an ellipsis once read')
  assert.deepEqual(readLiteReportData({ findings: [{ id: 'd', description: 'Wait... then' }, { id: 'e', description: 'Then wait...' }] }).findings.map(f => f.description),
    ['Wait... then', 'Then wait...'], 'dots in a name not cut are its own')
})

const pass = (id, extra = {}) => ({ id, file: 'src/a.js', isApp: true, revalidate: 'revalidation', title: `App ${id}`, ...extra })
const under = (id, extra = {}) => ({ id, file: 'src/a.js', revalidate: 'partial', title: `Source ${id}`, evidence: 'e', ...extra })

test('an App board\'s copy of an entry holding the revalidation pass\'s row is that row alone; every other entry is sent as it is', () => {
  const data = { source: 'deepview', findings: [
    [pass('p'), under('u'), under('v', { revalidate: 'confirmed' })],
    [pass('q'), pass('r')], [under('alone')], pass('s'), [under('w'), under('x')],
  ] }
  assert.deepEqual(liteReportData(data, { fold: true }).findings.map(entry => Array.isArray(entry) ? entry.map(f => f.id) : entry.id),
    [['p'], ['q', 'r'], ['alone'], 's', ['w', 'x']])
  assert.deepEqual(liteReportData(data).findings[0].map(f => f.id), ['p', 'u', 'v'], 'unfolded unless asked')
})

test('a team\'s board copy folds only where nothing contradicts the pass, telling so where that left rows out', () => {
  const revalidated = { id: 'r', filename: 'app.json', data: { findings: [[pass('p', { revalidateInputs: ['u'] }), under('u')]] } }
  const folded = liteWorkspace([revalidated, { id: 'a', filename: 'analysis.json', data: { findings: [under('o', { revalidate: undefined })] } }], [])
  assert.equal(folded.folded, 'rows', 'an App view showing a row not answering Confirmed folds its entries alone')
  assert.deepEqual(folded.reports.map(report => report.data.findings.flat().map(f => f.id)), [['p'], ['o']])
  assert.deepEqual(folded.lens, { drop: true, detail: true, upstream: false }, 'what the rows left out tell the toolbar')
  assert.equal(folded.reports[0].id, 'r', 'each report as it was, but for its findings')
  // Another report's copy of the pass's row, telling otherwise of what it
  // judged; one ruling it out is dropped before rows merge, contradicting none.
  const contradicted = liteWorkspace([revalidated, { id: 'b', filename: 'other.json', data: { findings: [[pass('p'), under('u', { revalidate: 'confirmed' })]] } }], [])
  assert.equal(contradicted.folded, false)
  assert.deepEqual(contradicted.reports[0].data.findings.flat().map(f => f.id), ['p', 'u'])
  const plain = liteWorkspace([{ id: 'c', filename: 'c.json', data: { findings: [[under('w'), under('x')]] } }], [])
  assert.deepEqual([plain.folded, plain.lens, plain.reports[0].data.findings[0].length], [false, null, 2], 'nothing to leave out, nothing told')
})

test('a team whose App view locks Confirmed sends its board only the rows that view shows: no row under an App row, ruled out, or not answering Confirmed', () => {
  const original = (id, file) => ({ id, file, severity: 'high', confidence: 8, title: `Original ${id}` })
  const deepview = { id: 'r', filename: 'deepview.json', data: { source: 'deepview', findings: [
    [pass('p', { severity: 'high', confidence: 9, revalidateInputs: ['u', 'o', 'q'] }), under('u', { severity: 'high', confidence: 8 })],
    { id: 'gone', file: 'node_modules/x/a.js', severity: 'high', confidence: 8, revalidate: 'refuted' },
    original('o', 'node_modules/x/b.js'), original('q', 'src/q.js'),
  ] } }
  const lite = liteWorkspace([deepview], [])
  assert.deepEqual([lite.folded, lite.reports[0].data.findings], ['app', [[liteReportData({ findings: [deepview.data.findings[0][0]] }).findings[0]]]])
  assert.deepEqual(lite.lens, { drop: true, detail: true, upstream: true }, 'the App switch, its detail stop and the upstream lens, offered as the whole reports would')
  assert.deepEqual(liteReportData(deepview.data, { shown: new Set(['o']) }).findings, [[original('o', 'node_modules/x/b.js')]], 'an entry kept as the rows it holds that are shown')
})
