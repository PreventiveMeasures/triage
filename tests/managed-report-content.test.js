import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadManagedFindings, readManagedReport } from '../common/managed/report-content.ts'
import { filterReportContent } from '../common/managed/report-filter.ts'
import { managedCsv, managedCsvIds } from './_managed-csv.js'

test('managed CSV reading includes every scan and preserves upstream ids and repositories', async () => {
  const parsed = readManagedReport(managedCsv, 'export.CSV')
  assert.equal(parsed.format, 'codex')
  assert.equal(parsed.data.source, 'codex-security')
  assert.deepEqual(parsed.data.findings.map((finding) => finding.id), managedCsvIds)
  assert.ok(parsed.data.findings.every((finding) => finding.repo.github === 'o/r'))
  assert.equal(parsed.data.repo, undefined, 'per-finding repositories do not invent a blob-level assignment')
  const loaded = await loadManagedFindings(managedCsv, 'export.csv')
  assert.deepEqual(loaded.findings.map((finding) => finding.id), managedCsvIds)
})

test('managed CSV reading rejects invalid exports without guessing from non-CSV filenames', async () => {
  assert.equal(readManagedReport(managedCsv, 'report.txt').data, null)
  for (const invalid of ['', 'finding_url,repository\nx,o/r', managedCsv.split('\n')[0]]) {
    const parsed = readManagedReport(invalid, 'bad.csv')
    assert.equal(parsed.data, null)
    assert.match(parsed.reason, /Codex CSV/u)
    assert.equal(await loadManagedFindings(invalid, 'bad.csv'), null)
  }
})

test('CSV visibility filtering and JSON responses under CSV filenames preserve the authorized set', async () => {
  const text = filterReportContent(managedCsv, { dependencies: false, security: true }, 'report.csv')
  assert.deepEqual(readManagedReport(text, 'report.csv').data.findings.map((finding) => finding.id), managedCsvIds.slice(0, 1))
  assert.deepEqual((await loadManagedFindings(text, 'report.csv')).findings.map((finding) => finding.id), managedCsvIds.slice(0, 1))
  const hidden = filterReportContent(managedCsv, { dependencies: true, security: false }, 'report.csv')
  assert.deepEqual(readManagedReport(hidden, 'report.csv').data.findings, [])
  assert.equal(filterReportContent(managedCsv, { dependencies: true, security: true }, 'report.csv'), managedCsv)
  assert.throws(() => filterReportContent('bad,csv\nmissing,columns', { dependencies: false, security: true }, 'bad.csv'), /unreadable CSV/u, 'invalid exports cannot bypass permission filtering')
})
