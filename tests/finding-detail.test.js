import assert from 'node:assert/strict'
import { test } from 'node:test'
import { FINDING_DETAIL_FIELDS, liteReportData } from '../common/managed/finding-detail.js'

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
    [{ id: 'b', description: `${long.slice(0, 199)}…` }, { id: 'c' }, null],
  ] })
  assert.equal(data.findings[0].evidence, 'evidence', 'the report itself is left whole')
  assert.deepEqual(liteReportData({ groups: [[{ id: 'g', impact: 'i' }]] }), { groups: [[{ id: 'g' }]] })
  const links = { source: 'links', links: [['a', 'b']] }
  assert.strictEqual(liteReportData(links), links)
})
