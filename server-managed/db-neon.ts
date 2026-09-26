import { AsyncLocalStorage } from 'node:async_hooks'
import { WebSocket } from 'ws'
import { type ManagedDb, type ManagedDbOptions, createManagedMethods } from './db-methods.ts'
import { MANAGED_SCHEMA } from './db-schema.ts'
import { COMMENT_SCHEMA } from './comments.ts'
import { ACTIVITY_SCHEMA } from './activity.ts'
import { type ManagedSqlDriver, scopeManagedMethods } from './sql.ts'
import { postgresSchema, postgresSql } from './sql-postgres.ts'

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
    if ((await db.query('SELECT version FROM managed_schema_version WHERE version = 1')).rows.length === 0) {
      await db.query(postgresSchema(MANAGED_SCHEMA + COMMENT_SCHEMA + ACTIVITY_SCHEMA))
      await db.query(`ALTER TABLE finding_triage_event ADD COLUMN report_id TEXT, ADD COLUMN report TEXT, ADD COLUMN repo TEXT;
        CREATE UNIQUE INDEX managed_team_slug_idx ON managed_team(slug);
        CREATE UNIQUE INDEX managed_report_slug_idx ON managed_report(slug);
        CREATE INDEX managed_activity_actor_at_idx ON managed_activity(actor_id, at);`)
      for (const type of ['report', 'bundle']) await createUploadTrigger(db, type)
      await db.query('INSERT INTO managed_schema_version VALUES (1)')
    }
    await db.query('COMMIT')
  } catch (err) {
    await db.query('ROLLBACK')
    throw err
  }
}

async function createUploadTrigger(db: PgConnection, type: string): Promise<void> {
  await db.query(`CREATE FUNCTION managed_${type}_activity_insert() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      INSERT INTO managed_activity (id, kind, actor, action, repo, report_id, report, at, bundle_id, actor_id)
      VALUES ('${type}-upload:' || NEW.id, 'upload',
        COALESCE(NEW.uploaded_by_login, (SELECT login FROM managed_user WHERE id = NEW.uploaded_by)),
        'uploaded a ${type}', (SELECT full_name FROM selected_repo WHERE repo_id = NEW.repo_id),
        ${type === 'report' ? 'NEW.id' : 'NULL'}, NEW.filename, NEW.uploaded_at,
        ${type === 'bundle' ? 'NEW.id' : 'NULL'}, NEW.uploaded_by);
      RETURN NEW;
    END $$;
    CREATE TRIGGER managed_${type}_activity AFTER INSERT ON managed_${type}
      FOR EACH ROW EXECUTE FUNCTION managed_${type}_activity_insert();`)
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
      try {
        await db.query(write ? 'BEGIN' : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
        if (write) await db.query(LOCK)
        const result = await context.run(db, work)
        await db.query('COMMIT')
        return result
      } catch (err) {
        await db.query('ROLLBACK').catch(() => {})
        throw err
      } finally { await db.release() }
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
