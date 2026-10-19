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
  assert.deepEqual(readLiteReportData({ findings: [{ id: 'd', description: 'Wait... then' }] }).findings[0].description, 'Wait... then', 'dots not at its end are its own')
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
  assert.equal(folded.folded, true)
  assert.deepEqual(folded.reports.map(report => report.data.findings.flat().map(f => f.id)), [['p'], ['o']])
  assert.equal(folded.reports[0].id, 'r', 'each report as it was, but for its findings')
  // Another report's copy of the pass's row, telling otherwise of what it judged.
  const contradicted = liteWorkspace([revalidated, { id: 'b', filename: 'other.json', data: { findings: [[pass('p'), under('u', { revalidate: 'refuted' })]] } }], [])
  assert.equal(contradicted.folded, false)
  assert.deepEqual(contradicted.reports[0].data.findings.flat().map(f => f.id), ['p', 'u'])
  const plain = liteWorkspace([{ id: 'c', filename: 'c.json', data: { findings: [[under('w'), under('x')]] } }], [])
  assert.deepEqual([plain.folded, plain.reports[0].data.findings[0].length], [false, 2], 'nothing to leave out, nothing told')
})
