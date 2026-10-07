import { LINK_REPORT_SCHEMA } from './link-reports.ts'
import { REPOSITORY_ALIAS_SCHEMA } from './repository-aliases.ts'
import { AsyncLocalStorage } from 'node:async_hooks'
import { WebSocket } from 'ws'
import { type ManagedDb, type ManagedDbOptions, createManagedMethods } from './db-methods.ts'
import { revisionSchema } from './revisions.ts'
import { MANAGED_SCHEMA } from './db-schema.ts'
import { STORAGE_SCHEMA } from './storage-db.ts'
import { GITHUB_METADATA_SCHEMA, GITHUB_STATE_REASON_COLUMN } from './github-metadata.ts'
import { MANAGED_ISSUE_SCHEMA } from './managed-issues.ts'
import { BUNDLE_BUILD_LEASE_SCHEMA } from './bundle-build-leases.ts'
import { COMMENT_SCHEMA } from './comments.ts'
import { ACTIVITY_SCHEMA, uploadAction } from './activity.ts'
import { type ManagedSqlDriver, scopeManagedMethods } from './sql.ts'
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
// Content/access mutations cooperate on this transaction-scoped lock. Reads,
// presence updates, and maintenance leases do not take it. Also fences migrations.
const LOCK = 'SELECT pg_advisory_xact_lock(1937006964, 1835101793)'

async function currentSchema(db: PgConnection): Promise<boolean> {
  const exists = (await db.query("SELECT to_regclass('managed_schema_version') AS name")).rows[0]?.['name']
  if (!exists) return false
  const versions = new Set((await db.query('SELECT version FROM managed_schema_version')).rows.map(row => Number(row['version'])))
  return Array.from({ length: 20 }, (_, i) => i + 1).every(version => versions.has(version))
}

async function migrateRepositoryDefaultCache(db: PgConnection): Promise<void> {
  if ((await db.query('SELECT version FROM managed_schema_version WHERE version = 12')).rows.length > 0) return
  await db.query('ALTER TABLE managed_selected_repo ADD COLUMN IF NOT EXISTS cached_default_branch TEXT')
  await db.query('INSERT INTO managed_schema_version VALUES (12)')
}

async function migrateBundleBuildLeases(db: PgConnection): Promise<void> {
  if ((await db.query('SELECT version FROM managed_schema_version WHERE version = 13')).rows.length > 0) return
  await db.query(postgresSchema(BUNDLE_BUILD_LEASE_SCHEMA))
  await db.query('INSERT INTO managed_schema_version VALUES (13)')
}

async function migrateGithubMetadata(db: PgConnection): Promise<void> {
  await db.query(postgresSchema(GITHUB_METADATA_SCHEMA + MANAGED_ISSUE_SCHEMA))
  await db.query(`ALTER TABLE managed_github_metadata ADD COLUMN IF NOT EXISTS state_reason ${GITHUB_STATE_REASON_COLUMN}`)
  await db.query('ALTER TABLE managed_github_metadata ADD COLUMN IF NOT EXISTS attempted_at BIGINT')
  await db.query('INSERT INTO managed_schema_version VALUES (14) ON CONFLICT DO NOTHING')
}

async function migrateBundleVisibility(db: PgConnection): Promise<void> {
  if ((await db.query('SELECT version FROM managed_schema_version WHERE version = 15')).rows.length === 0) {
    await db.query('ALTER TABLE managed_bundle ADD COLUMN IF NOT EXISTS visible INTEGER NOT NULL DEFAULT 1')
    await db.query('INSERT INTO managed_schema_version VALUES (15)')
  }
}

async function migrateLinkReports(db: PgConnection): Promise<void> {
  await db.query(postgresSchema(revisionSchema(true)))
  await db.query('INSERT INTO managed_schema_version VALUES (16) ON CONFLICT DO NOTHING')
}

async function migrateRepositoryAliases(db: PgConnection): Promise<void> {
  await db.query(postgresSchema(REPOSITORY_ALIAS_SCHEMA))
  await db.query('INSERT INTO managed_schema_version VALUES (17) ON CONFLICT DO NOTHING')
}

async function migrateHiddenTeams(db: PgConnection): Promise<void> {
  if ((await db.query('SELECT version FROM managed_schema_version WHERE version = 18')).rows.length > 0) return
  await db.query('ALTER TABLE managed_team ADD COLUMN IF NOT EXISTS hidden INTEGER NOT NULL DEFAULT 0')
  await db.query('INSERT INTO managed_schema_version VALUES (18)')
}

async function migrateIssueFixes(db: PgConnection): Promise<void> {
  if ((await db.query('SELECT version FROM managed_schema_version WHERE version = 19')).rows.length > 0) return
  await db.query('ALTER TABLE managed_finding_issue ADD COLUMN IF NOT EXISTS auto_fix_url TEXT, ADD COLUMN IF NOT EXISTS auto_fix_checked_at BIGINT')
  await db.query(postgresSchema(revisionSchema(true)))
  await db.query('INSERT INTO managed_schema_version VALUES (19)')
}

// Existing rows stay NULL (unknown): some may have been built on the server.
async function migrateBundleProvenance(db: PgConnection): Promise<void> {
  if ((await db.query('SELECT version FROM managed_schema_version WHERE version = 20')).rows.length > 0) return
  await db.query('ALTER TABLE managed_bundle ADD COLUMN IF NOT EXISTS provenance TEXT')
  await createUploadTrigger(db, 'bundle', false)
  await db.query('INSERT INTO managed_schema_version VALUES (20)')
}

async function initialize(db: PgConnection): Promise<void> {
  if (await currentSchema(db)) return
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
    await migrateGithubMetadata(db)
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
    if ((await db.query('SELECT version FROM managed_schema_version WHERE version = 9')).rows.length === 0) {
      await db.query(postgresSchema(STORAGE_SCHEMA))
      for (const table of ['managed_report', 'managed_bundle']) {
        await db.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS data_key TEXT, ADD COLUMN IF NOT EXISTS storage_encrypted INTEGER NOT NULL DEFAULT 0`)
      }
      await db.query('ALTER TABLE managed_user ADD COLUMN IF NOT EXISTS gh_tokens_encrypted INTEGER NOT NULL DEFAULT 0')
      await db.query('INSERT INTO managed_schema_version VALUES (9)')
    }
    await db.query(postgresSchema(LINK_REPORT_SCHEMA))
    if ((await db.query('SELECT version FROM managed_schema_version WHERE version = 10')).rows.length === 0) {
      await db.query(postgresSchema(revisionSchema(true)) + '; INSERT INTO managed_schema_version VALUES (10)')
    }
    if ((await db.query('SELECT version FROM managed_schema_version WHERE version = 11')).rows.length === 0) {
      await db.query(postgresSchema(revisionSchema(true)) + '; INSERT INTO managed_schema_version VALUES (11)')
    }
    for (const migrate of [migrateRepositoryDefaultCache, migrateBundleBuildLeases, migrateBundleVisibility, migrateLinkReports, migrateRepositoryAliases, migrateHiddenTeams, migrateIssueFixes, migrateBundleProvenance]) await migrate(db)
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
        ${uploadAction(type, 'NEW')}, (SELECT full_name FROM managed_selected_repo WHERE repo_id = NEW.repo_id),
        ${type === 'report' ? 'NEW.id' : 'NULL'}, NEW.filename, NEW.uploaded_at,
        ${type === 'bundle' ? 'NEW.id' : 'NULL'}, NEW.uploaded_by);
      RETURN NEW;
    END $$;`)
  if (createTrigger) {
    await db.query(`CREATE TRIGGER managed_${type}_activity AFTER INSERT ON managed_${type}
      FOR EACH ROW EXECUTE FUNCTION managed_${type}_activity_insert();`)
  }
}

function requestConnections(connect: PgConnect) {
  const requests = new AsyncLocalStorage<{ connection?: PgConnection; queue: Promise<unknown>; ended: boolean }>()
  async function withConnection<T>(work: (db: PgConnection) => Promise<T>): Promise<T> {
    const request = requests.getStore()
    if (!request || request.ended) {
      const connection = await connect()
      let result: T
      try { result = await work(connection) }
      catch (error) { await connection.release().catch(() => {}); throw error }
      await connection.release()
      return result
    }
    // Serialize transactions on the leased connection, never interleave BEGINs
    // from concurrent Blob/catalog tasks. Remote Blob reads remain concurrent.
    const result = request.queue.then(async () => {
      const connection = request.connection ??= await connect()
      try { return await work(connection) }
      catch (error) {
        delete request.connection
        await connection.release().catch(() => {})
        throw error
      }
    })
    request.queue = result.catch(() => {})
    return result
  }
  async function withRequest<T>(work: () => Promise<T>): Promise<T> {
    if (requests.getStore()) return work()
    const request: { connection?: PgConnection; queue: Promise<unknown>; ended: boolean } = { queue: Promise.resolve(), ended: false }
    let failed = false
    try { return await requests.run(request, work) }
    catch (error) { failed = true; throw error }
    finally {
      request.ended = true
      await request.queue
      if (failed) await request.connection?.release().catch(() => {})
      else await request.connection?.release()
    }
  }
  return { withConnection, withRequest }
}

// Exposed for parity tests against real PostgreSQL semantics via PGlite.
export async function openPostgresManagedDb(connect: PgConnect, options: ManagedDbOptions = {}, reuseConnections = false): Promise<ManagedDb> {
  const initial = await connect()
  try { await initialize(initial) } finally { await initial.release() }
  const { withConnection, withRequest } = requestConnections(connect)
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
    async scope(write, work, { lock = write, statement = false } = {}) {
      if (closed) throw new Error('Managed database is closed')
      let committed = false
      try { return await withConnection(async db => {
        if (statement) return context.run(db, work)
        let commitAttempted = false
        try {
          await db.query(write ? 'BEGIN' : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
          if (lock) await db.query(LOCK)
          const result = await context.run(db, work)
          commitAttempted = true
          await db.query('COMMIT')
          committed = true
          return result
        } catch (err) {
          await db.query('ROLLBACK').catch(() => {})
          if (write && commitAttempted) throw new Error('Managed commit outcome is uncertain', { cause: err })
          throw err
        }
      }) } catch (error) {
        if (write && committed) throw new Error('Managed commit outcome is uncertain', { cause: error })
        throw error
      }
    },
    close() { closed = true },
  }
  const methods = scopeManagedMethods(createManagedMethods(driver, options), driver)
  if (reuseConnections) methods.withRequest = withRequest
  return methods
}

export async function openNeonManagedDb(url: string, options: ManagedDbOptions = {}): Promise<ManagedDb> {
  // Reuse the e2e optional-driver boundary. Requests lease one connection and
  // close it before returning; no socket must survive a frozen invocation.
  const { Client, neonConfig } = await import('../server-e2e/neon-driver.ts') as unknown as {
    Client: new (url: string) => { connect(): Promise<void>; end(): Promise<void>; query: PgConnection['query']; on?(event: 'error', listener: (error: Error) => void): void }
    neonConfig: { webSocketConstructor: typeof WebSocket }
  }
  neonConfig.webSocketConstructor = WebSocket
  return openPostgresManagedDb(async () => {
    const client = new Client(url)
    // A remote disconnect between operations must reject the next query, not
    // become an unhandled EventEmitter error while the request is reading Blob.
    client.on?.('error', () => {})
    try { await client.connect() } catch (err) { await client.end().catch(() => {}); throw err }
    return { query: (sql, params) => client.query(sql, params), release: () => client.end() }
  }, options, true)
}
