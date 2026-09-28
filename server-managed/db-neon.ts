import { AsyncLocalStorage } from 'node:async_hooks'
import { WebSocket } from 'ws'
import { type ManagedDb, type ManagedDbOptions, createManagedMethods } from './db-methods.ts'
import { MANAGED_SCHEMA } from './db-schema.ts'
import { STORAGE_SCHEMA } from './storage-db.ts'
import { GITHUB_METADATA_SCHEMA, GITHUB_STATE_REASON_COLUMN } from './github-metadata.ts'
import { MANAGED_ISSUE_SCHEMA } from './managed-issues.ts'
import { COMMENT_SCHEMA } from './comments.ts'
import { ACTIVITY_SCHEMA } from './activity.ts'
import { ManagedCommitError, type ManagedSqlDriver, scopeManagedMethods } from './sql.ts'
import { postgresSchema, postgresSql } from './sql-postgres.ts'
import { managedTableRenames } from './db-table-names.ts'
import { WORKSPACE_SHARE_SCHEMA } from './workspace-shares.ts'
import { allocateMissingSlugs } from './slugs.ts'

export interface PgConnection {
  query(sql: string, params?: unknown[]): Promise<{
    rows: Record<string, unknown>[]; rowCount?: number | null
    fields?: { name: string; dataTypeID: number }[]
  }>
  release(): Promise<void>
}
export type PgConnect = () => Promise<PgConnection>
// All managed writers cooperate on this transaction-scoped lock. Reads use a
// consistent snapshot without taking it. Also protects concurrent cold starts.
const LOCK = 'SELECT pg_advisory_xact_lock(1937006964, 1835101793)'

async function initialize(db: PgConnection): Promise<void> {
  await db.query('BEGIN')
  try {
    await db.query(LOCK)
    await db.query('CREATE TABLE IF NOT EXISTS managed_schema_version (version INTEGER PRIMARY KEY)')
    const initialized = (await db.query('SELECT version FROM managed_schema_version WHERE version = 1')).rows.length > 0
    const prefixed = (await db.query('SELECT version FROM managed_schema_version WHERE version = 3')).rows.length > 0
    if (initialized && !prefixed) {
      const { rows } = await db.query("SELECT relname AS name FROM pg_class WHERE relkind IN ('r', 'p') AND pg_table_is_visible(oid)")
      for (const [from, to] of managedTableRenames(new Set(rows.map(row => String(row['name']))))) {
        await db.query(`ALTER TABLE ${from} RENAME TO ${to}`)
      }
      // PL/pgSQL function bodies retain literal table names after ALTER TABLE.
      for (const type of ['report', 'bundle']) await createUploadTrigger(db, type, false)
    }
    if (!initialized) {
      await db.query(postgresSchema(MANAGED_SCHEMA + COMMENT_SCHEMA + ACTIVITY_SCHEMA))
      await db.query(`ALTER TABLE managed_finding_triage_event ADD COLUMN report_id TEXT, ADD COLUMN report TEXT, ADD COLUMN repo TEXT;
        CREATE UNIQUE INDEX managed_team_slug_idx ON managed_team(slug);
        CREATE UNIQUE INDEX managed_report_slug_idx ON managed_report(slug);
        CREATE INDEX managed_activity_actor_at_idx ON managed_activity(actor_id, at);`)
      for (const type of ['report', 'bundle']) await createUploadTrigger(db, type)
      await db.query('INSERT INTO managed_schema_version VALUES (1)')
    }
    if ((await db.query('SELECT version FROM managed_schema_version WHERE version = 2')).rows.length === 0) {
      await db.query('CREATE INDEX IF NOT EXISTS managed_report_bundle_hash_idx ON managed_report(bundle_id, sha256)')
      await db.query('INSERT INTO managed_schema_version VALUES (2)')
    }
    if (!prefixed) await db.query('INSERT INTO managed_schema_version VALUES (3)')
    if ((await db.query('SELECT version FROM managed_schema_version WHERE version = 4')).rows.length === 0) {
      await db.query(postgresSchema(WORKSPACE_SHARE_SCHEMA))
      await db.query('INSERT INTO managed_schema_version VALUES (4)')
    }
    await db.query(postgresSchema(GITHUB_METADATA_SCHEMA + MANAGED_ISSUE_SCHEMA + STORAGE_SCHEMA))
    await db.query(`ALTER TABLE managed_github_metadata ADD COLUMN IF NOT EXISTS state_reason ${GITHUB_STATE_REASON_COLUMN}`)
    await db.query('ALTER TABLE managed_github_metadata ADD COLUMN IF NOT EXISTS attempted_at BIGINT')
    if ((await db.query('SELECT version FROM managed_schema_version WHERE version = 5')).rows.length === 0) {
      await db.query(`ALTER TABLE managed_workspace_share ADD COLUMN IF NOT EXISTS dependencies INTEGER NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS security INTEGER NOT NULL DEFAULT 0`)
      await db.query('INSERT INTO managed_schema_version VALUES (5)')
    }
    if ((await db.query('SELECT version FROM managed_schema_version WHERE version = 6')).rows.length === 0) {
      await db.query('ALTER TABLE managed_bundle ADD COLUMN IF NOT EXISTS slug TEXT')
      const { rows } = await db.query('SELECT id, slug FROM managed_bundle ORDER BY id')
      for (const row of allocateMissingSlugs(rows as { id: string; slug: string | null }[])) {
        await db.query('UPDATE managed_bundle SET slug = $1 WHERE id = $2', [row.slug, row.id])
      }
      await db.query(`ALTER TABLE managed_bundle ALTER COLUMN slug SET NOT NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS managed_bundle_slug_idx ON managed_bundle(slug);
        INSERT INTO managed_schema_version VALUES (6)`)
    }
    if ((await db.query('SELECT version FROM managed_schema_version WHERE version = 7')).rows.length === 0) {
      await db.query("ALTER TABLE managed_bundle ADD COLUMN IF NOT EXISTS repo_directory TEXT NOT NULL DEFAULT ''")
      await db.query('INSERT INTO managed_schema_version VALUES (7)')
    }
    if ((await db.query('SELECT version FROM managed_schema_version WHERE version = 8')).rows.length === 0) {
      await db.query('CREATE INDEX IF NOT EXISTS managed_report_hash_idx ON managed_report(sha256, uploaded_at, id)')
      await db.query('INSERT INTO managed_schema_version VALUES (8)')
    }
    await db.query('COMMIT')
  } catch (err) {
    await db.query('ROLLBACK')
    throw err
  }
}

async function createUploadTrigger(db: PgConnection, type: string, createTrigger = true): Promise<void> {
  await db.query(`CREATE OR REPLACE FUNCTION managed_${type}_activity_insert() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      INSERT INTO managed_activity (id, kind, actor, action, repo, report_id, report, at, bundle_id, actor_id)
      VALUES ('${type}-upload:' || NEW.id, 'upload',
        COALESCE(NEW.uploaded_by_login, (SELECT login FROM managed_user WHERE id = NEW.uploaded_by)),
        'uploaded a ${type}', (SELECT full_name FROM managed_selected_repo WHERE repo_id = NEW.repo_id),
        ${type === 'report' ? 'NEW.id' : 'NULL'}, NEW.filename, NEW.uploaded_at,
        ${type === 'bundle' ? 'NEW.id' : 'NULL'}, NEW.uploaded_by);
      RETURN NEW;
    END $$;`)
  if (createTrigger) {
    await db.query(`CREATE TRIGGER managed_${type}_activity AFTER INSERT ON managed_${type}
      FOR EACH ROW EXECUTE FUNCTION managed_${type}_activity_insert();`)
  }
}

// Exposed for parity tests against real PostgreSQL semantics via PGlite.
export async function openPostgresManagedDb(connect: PgConnect, options: ManagedDbOptions = {}): Promise<ManagedDb> {
  const initial = await connect()
  try { await initialize(initial) } finally { await initial.release() }
  const context = new AsyncLocalStorage<PgConnection>()
  let closed = false
  const driver: ManagedSqlDriver = {
    prepare(source) {
      const { sql, names } = postgresSql(source)
      async function query(args: unknown[]) {
        const db = context.getStore()
        if (!db) throw new Error('Managed query outside transaction')
        const values = names.length > 0 ? names.map(name => (args[0] as Record<string, unknown>)[name])
          : args.length === 1 && typeof args[0] === 'object' && args[0] !== null ? [] : args
        const result = await db.query(sql, values)
        // Postgres int8 is returned as text by node-postgres/Neon. All store
        // numbers are JS safe integers (timestamps, IDs, sizes and sequences).
        for (const field of result.fields ?? []) {
          if (field.dataTypeID !== 20) continue
          for (const row of result.rows) {
            if (row[field.name] == null) continue
            const value = Number(row[field.name])
            if (!Number.isSafeInteger(value)) throw new Error('Managed integer exceeds safe range')
            row[field.name] = value
          }
        }
        return result
      }
      return {
        get: async (...args) => (await query(args)).rows[0],
        all: async (...args) => (await query(args)).rows,
        run: async (...args) => ({ changes: (await query(args)).rowCount ?? 0 }),
      }
    },
    async scope(write, work) {
      if (closed) throw new Error('Managed database is closed')
      const db = await connect()
      let commitAttempted = false
      let result
      try {
        await db.query(write ? 'BEGIN' : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
        if (write) await db.query(LOCK)
        result = await context.run(db, work)
        commitAttempted = true
        await db.query('COMMIT')
      } catch (err) {
        await db.query('ROLLBACK').catch(() => {})
        await db.release().catch(() => {})
        if (write && commitAttempted) throw new ManagedCommitError(err)
        throw err
      }
      try { await db.release() }
      catch (err) { if (write) throw new ManagedCommitError(err); throw err }
      return result
    },
    close() { closed = true },
  }
  return scopeManagedMethods(createManagedMethods(driver, options), driver)
}

export async function openNeonManagedDb(url: string, options: ManagedDbOptions = {}): Promise<ManagedDb> {
  // Reuse the e2e optional-driver boundary. Each operation closes its socket
  // before returning; no open connection has to survive a frozen invocation.
  const { Client, neonConfig } = await import('../server-e2e/neon-driver.ts') as unknown as {
    Client: new (url: string) => { connect(): Promise<void>; end(): Promise<void>; query: PgConnection['query'] }
    neonConfig: { webSocketConstructor: typeof WebSocket }
  }
  neonConfig.webSocketConstructor = WebSocket
  return openPostgresManagedDb(async () => {
    const client = new Client(url)
    try { await client.connect() } catch (err) { await client.end().catch(() => {}); throw err }
    return { query: (sql, params) => client.query(sql, params), release: () => client.end() }
  }, options)
}
