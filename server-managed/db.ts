// SQLite bootstrap and legacy upgrades. Runtime methods are shared with Neon.
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { migrateSlugs } from './slugs.ts'
import { migrateReportLocations } from './report-migration.ts'
import { initCommentMethods } from './comments.ts'
import { initActivityMethods } from './activity.ts'
import { MANAGED_SCHEMA } from './db-schema.ts'
import { type ManagedDb, type ManagedDbOptions, createManagedMethods } from './db-methods.ts'
import { createSqliteDriver, scopeManagedMethods } from './sql.ts'
export type * from './db-methods.ts'

// Preserve the legacy single-path links while adding path to their identity.
function migrateTeamRepoPaths(db: DatabaseSync): void {
  const columns = db.prepare('PRAGMA table_info(team_repo)').all() as { name: string; pk: number }[]
  if (columns.some(column => column.name === 'path' && column.pk === 3)) return
  db.exec('BEGIN IMMEDIATE')
  try {
    db.exec(`CREATE TABLE team_repo_paths (
      team_id TEXT NOT NULL REFERENCES managed_team(id) ON DELETE CASCADE,
      repo_id INTEGER NOT NULL REFERENCES selected_repo(repo_id) ON DELETE CASCADE,
      path TEXT NOT NULL DEFAULT '', PRIMARY KEY (team_id, repo_id, path)
    ) STRICT;
    INSERT INTO team_repo_paths SELECT team_id, repo_id, COALESCE(path, '') FROM team_repo;
    DROP TABLE team_repo;
    ALTER TABLE team_repo_paths RENAME TO team_repo;
    CREATE INDEX team_repo_repo_idx ON team_repo(repo_id);`)
    db.exec('COMMIT')
  } catch (err) { db.exec('ROLLBACK'); throw err }
}

// Add `column` to `table` if it's missing (a lightweight migration for DBs that
// predate the column; `table`/`column` are code constants, never user input).
function ensureColumn(db: DatabaseSync, table: string, column: string, type: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  if (cols.some((c) => c.name === column)) return false
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`)
  return true
}

export function openSqliteManagedDb(path: string, options: ManagedDbOptions = {}): ManagedDb {
  mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  try {
    db.exec('PRAGMA journal_mode = WAL;')
    db.exec('PRAGMA synchronous = FULL;')
    db.exec('PRAGMA foreign_keys = ON;')
    db.exec(MANAGED_SCHEMA)
    migrateTeamRepoPaths(db)
    migrateSlugs(db)
    // Migrate DBs created before a column existed (CREATE TABLE IF NOT EXISTS
    // never alters an already-present table). Idempotent — skipped on fresh DBs.
    const addedLastSeen = ensureColumn(db, 'managed_user', 'last_seen_at', 'INTEGER')
    if (addedLastSeen) {
      // Session creation is known authentication activity. updated_at is not:
      // role changes and token refreshes also wrote it. Keep unknowns NULL.
      db.exec(`UPDATE managed_user SET last_seen_at = (
        SELECT MAX(s.created_at) FROM managed_session s WHERE s.user_id = managed_user.id
      )`)
    }
    ensureColumn(db, 'managed_report', 'uploaded_by_login', 'TEXT')
    ensureColumn(db, 'managed_report', 'repo_embedded', 'INTEGER NOT NULL DEFAULT 0')
    migrateReportLocations(db, join(dirname(path), 'reports'))
    ensureColumn(db, 'managed_report', 'analyzer', 'TEXT')
    // Existing rows predate publication controls and were already visible.
    // Backfill only when adding the column; newly inserted rows still use the
    // hidden default and must be explicitly published.
    const addedVisible = ensureColumn(db, 'managed_report', 'visible', 'INTEGER NOT NULL DEFAULT 0')
    if (addedVisible) db.prepare('UPDATE managed_report SET visible = 1 WHERE visible = 0').run()
    ensureColumn(db, 'managed_bundle', 'uploaded_by_login', 'TEXT')
    ensureColumn(db, 'selected_repo', 'active', 'INTEGER NOT NULL DEFAULT 1')
    ensureColumn(db, 'finding_triage_event', 'report_id', 'TEXT')
    ensureColumn(db, 'finding_triage_event', 'report', 'TEXT')
    ensureColumn(db, 'finding_triage_event', 'repo', 'TEXT')
    initCommentMethods(db)
    initActivityMethods(db)
  } catch (err) {
    try { db.close() } catch {}
    throw err
  }

  const driver = createSqliteDriver(db)
  return scopeManagedMethods(createManagedMethods(driver, options), driver)
}
