// SQLite deployments store report blobs beside the database. Recover location
// metadata before introducing directory-based team access. Schema and data move
// together so a missing/corrupt blob leaves the migration retryable after repair.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { reportRepoGithub } from '../report/index.js'
import { readManagedReport } from '../common/managed/report-content.ts'
import { normalizeTeamPath } from './repo-path.ts'

export function migrateReportLocations(db: DatabaseSync, reportDir: string): void {
  const columns = db.prepare('PRAGMA table_info(managed_report)').all() as { name: string }[]
  if (columns.some((column) => column.name === 'repo_directory')) return
  db.exec('BEGIN IMMEDIATE')
  try {
    db.exec("ALTER TABLE managed_report ADD COLUMN repo_directory TEXT NOT NULL DEFAULT ''")
    const update = db.prepare('UPDATE managed_report SET repo_directory = ?, repo_embedded = ? WHERE id = ?')
    const reports = db.prepare('SELECT id, filename FROM managed_report').all() as { id: string, filename: string }[]
    for (const { id, filename } of reports) {
      // Same opaque UUID boundary as the blob store; never splice arbitrary
      // database text into a filesystem path during an upgrade.
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(id)) throw new Error(`Invalid legacy report id: ${id}`)
      const { data } = readManagedReport(readFileSync(join(reportDir, id), 'utf8'), filename)
      if (data == null) throw new Error(`Cannot migrate location of unreadable report ${id}`)
      const embedded = reportRepoGithub(data) != null
      const directory = normalizeTeamPath(data.repo?.directory)
      if (!directory.ok) throw new Error(`Cannot migrate invalid directory of report ${id}`)
      update.run(directory.path ?? '', embedded ? 1 : 0, id)
    }
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}
