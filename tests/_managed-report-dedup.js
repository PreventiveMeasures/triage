import assert from 'node:assert/strict'

// Both SQL adapters must choose one identity within their writer transaction,
// while retaining old duplicate rows (and their references) during upgrades.
export async function checkReportDedup(db, other = db) {
  const original = { id: 'original', filename: 'scan.json', contentType: 'application/json', byteSize: 10,
    sha256: 'same', uploadedBy: null, repoId: null, visible: true }
  await db.insertReport(original, 1)
  await db.insertReport({ ...original, id: 'legacy-copy' }, 2)
  const stored = await db.getReport('original')
  assert.deepEqual(await other.insertOrReuseReport({ ...original, id: 'retry', filename: 'renamed.json', visible: false }, 3), stored)
  assert.deepEqual(await db.getReportByHash('same', null), stored)
  assert.equal((await db.listReports()).length, 2)

  const [a, b] = await Promise.all([
    db.insertOrReuseReport({ ...original, id: 'first', sha256: 'new' }, 4),
    other.insertOrReuseReport({ ...original, id: 'second', sha256: 'new' }, 5),
  ])
  assert.equal(a.id, b.id)
  assert.equal((await db.listReports()).length, 3)
  assert.equal((await db.listActivity({ page: 1, limit: 100, kind: 'upload', query: '' })).total, 3,
    'reuse does not create another upload event')

  const csv = await db.insertOrReuseReport({ ...original, id: 'csv', analyzer: 'codex-security' }, 6)
  assert.equal(csv.id, 'csv', 'a recognized CSV does not reuse an unrecognized upload of the same bytes')
  await db.deleteReport('original')
  assert.equal((await db.getReportByHash('same', null)).id, 'legacy-copy')
  await db.deleteReport('legacy-copy')
  assert.equal((await db.insertOrReuseReport({ ...original, id: 'reuploaded' }, 7)).id, 'reuploaded')
}
