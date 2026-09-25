// Persistent workspace activity. Uploads are recorded in the same transaction
// as their metadata; triage reuses its existing immutable trail, including
// legacy entries. Never copy annotation bodies or credentials into this feed.
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

export interface ActivityInput {
  kind: 'access' | 'repository' | 'visibility' | 'delete'
  actor: string
  actorId?: string | null
  action: string
  repo?: string | null
  reportId?: string | null
  bundleId?: string | null
  repoId?: number | null
  repoDirectory?: string | null
  report?: string | null
}

export interface ActivityContext {
  finding: string
  reportId: string
  report: string
  repo: string | null
}

export type ActivityEntry = {
  id: string; kind: string; actor: string | null; action: string
  repo: string | null; reportId: string | null; report: string | null
  finding: string | null; at: number
}

export interface ActivityQuery {
  page: number
  limit: number
  kind: string
  query: string
  // null = admin; [] = no accessible findings. Context is supplied by the
  // server, never by the client. It also replaces potentially private context
  // from an old report carrying the same globally shared finding.
  contexts: ActivityContext[] | null
  userId?: string
}

export interface ActivityStore {
  recordActivity(entry: ActivityInput, at: number): Promise<void>
  listActivityReports(userId: string): Promise<Omit<ActivityContext, 'finding'>[]>
  listActivity(query: ActivityQuery): Promise<{ history: ActivityEntry[]; total: number; page: number; limit: number }>
}

const triageFields = `'triage:' || e.seq AS id, 'triage' AS kind,
  COALESCE(u.login, e.actor_login) AS actor,
  CASE WHEN e.color IS NULL AND e.triage IS NULL AND e.comment IS NULL AND e.fix IS NULL AND e.flagged IS NULL
    THEN 'cleared triage' ELSE 'updated triage' END AS action`
const triage = `SELECT ${triageFields}, e.repo, e.report_id AS reportId, e.report, e.finding_id AS finding, e.at
  FROM finding_triage_event e LEFT JOIN managed_user u ON u.id = e.actor_id`
const adminSource = `${triage} UNION ALL
  SELECT id, kind, actor, action, repo, report_id AS reportId, report, NULL AS finding, at FROM managed_activity`
// Keep the finite set of accessible findings outside the indexed event
// lookup. Scanning all events against json_each for every row is quadratic.
const managerSource = `SELECT ${triageFields},
  json_extract(c.value, '$.repo') AS repo, json_extract(c.value, '$.reportId') AS reportId,
  json_extract(c.value, '$.report') AS report, e.finding_id AS finding, e.at
  FROM json_each(:contexts) c
  CROSS JOIN finding_triage_event e ON e.finding_id = json_extract(c.value, '$.finding')
  LEFT JOIN managed_user u ON u.id = e.actor_id
  UNION ALL SELECT a.id, a.kind, a.actor,
    CASE WHEN a.kind = 'repository' THEN 'changed a report repository assignment' ELSE a.action END AS action,
    p.full_name AS repo, r.id AS reportId, r.filename AS report, NULL AS finding, a.at
  FROM managed_activity a JOIN managed_report r ON r.id = a.report_id
  LEFT JOIN selected_repo p ON p.repo_id = r.repo_id
  WHERE EXISTS (
    SELECT 1 FROM team_repo tr JOIN team_user tu ON tu.team_id = tr.team_id
    WHERE tu.user_id = :userId AND tr.repo_id = r.repo_id AND ${withinTeamPath('r.repo_directory')}
  )
  UNION ALL SELECT a.id, a.kind, a.actor,
    CASE WHEN a.kind = 'repository' THEN 'changed a bundle repository assignment' ELSE a.action END AS action,
    p.full_name AS repo, NULL AS reportId, b.filename AS report, NULL AS finding, a.at
  FROM managed_activity a JOIN managed_bundle b ON b.id = a.bundle_id
  LEFT JOIN selected_repo p ON p.repo_id = b.repo_id
  WHERE a.report_id IS NULL AND EXISTS (
    SELECT 1 FROM team_repo tr JOIN team_user tu ON tu.team_id = tr.team_id
    WHERE tu.user_id = :userId AND tr.repo_id = b.repo_id
  )
  UNION ALL SELECT a.id, a.kind, a.actor, a.action, a.repo, a.report_id AS reportId,
    a.report, NULL AS finding, a.at FROM managed_activity a
  WHERE a.kind = 'delete' AND (a.report_id IS NOT NULL OR a.bundle_id IS NOT NULL)
    AND NOT EXISTS (SELECT 1 FROM managed_report WHERE id = a.report_id)
    AND NOT EXISTS (SELECT 1 FROM managed_bundle WHERE id = a.bundle_id)
    AND EXISTS (SELECT 1 FROM team_repo tr JOIN team_user tu ON tu.team_id = tr.team_id
      WHERE tu.user_id = :userId AND tr.repo_id = a.repo_id
      AND (a.report_id IS NULL OR ${withinTeamPath('a.repo_directory')}))`

export function activityMethods(db: DatabaseSync): ActivityStore {
  db.exec(`
    CREATE TABLE IF NOT EXISTS managed_activity (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, actor TEXT, action TEXT NOT NULL,
      repo TEXT, report_id TEXT, report TEXT, at INTEGER NOT NULL,
      bundle_id TEXT, repo_id INTEGER, repo_directory TEXT, actor_id TEXT
    ) STRICT;
    CREATE INDEX IF NOT EXISTS managed_activity_at_idx ON managed_activity(at, id);
    CREATE INDEX IF NOT EXISTS finding_triage_event_at_idx ON finding_triage_event(at, seq);
  `)
  migrateActivityScope(db)
  db.exec('CREATE INDEX IF NOT EXISTS managed_activity_actor_at_idx ON managed_activity(actor_id, at)')
  // Stable upload IDs make backfill idempotent, including after restarts.
  // Snapshots deliberately have no cascading FKs: deletion is itself activity.
  for (const type of ['report', 'bundle']) {
    const columns = `id, kind, actor, action, repo, report_id, report, at, bundle_id, actor_id`
    const values = (alias: string) => `'${type}-upload:' || ${alias}.id, 'upload',
      COALESCE(${alias}.uploaded_by_login, (SELECT login FROM managed_user WHERE id = ${alias}.uploaded_by)), 'uploaded a ${type}',
      (SELECT full_name FROM selected_repo WHERE repo_id = ${alias}.repo_id),
      ${type === 'report' ? `${alias}.id` : 'NULL'}, ${alias}.filename, ${alias}.uploaded_at,
      ${type === 'bundle' ? `${alias}.id` : 'NULL'}, ${alias}.uploaded_by`
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS managed_${type}_activity AFTER INSERT ON managed_${type}
      BEGIN INSERT INTO managed_activity (${columns}) SELECT ${values('NEW')}; END;
      INSERT OR IGNORE INTO managed_activity (${columns}) SELECT ${values('source')} FROM managed_${type} source;
    `)
  }
  const insert = db.prepare(`INSERT INTO managed_activity (id, kind, actor, action, repo, report_id, report, at, bundle_id, repo_id, repo_directory, actor_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  function statements(source: string) {
    const filtered = `WITH activity AS (${source}) SELECT * FROM activity
      WHERE (:kind = 'all' OR kind = :kind)
      AND (:query = '' OR instr(lower(coalesce(actor, '') || ' ' || action || ' ' ||
        coalesce(repo, '') || ' ' || coalesce(report, '') || ' ' || coalesce(finding, '')), lower(:query)) > 0)`
    return {
      count: db.prepare(`SELECT count(*) AS total FROM (${filtered})`),
      rows: db.prepare(`${filtered} ORDER BY at DESC,
        CASE WHEN kind = 'triage' THEN CAST(substr(id, 8) AS INTEGER) ELSE 0 END DESC,
        id DESC LIMIT :limit OFFSET :offset`),
    }
  }
  const admin = statements(adminSource)
  const manager = statements(managerSource)
  const reports = db.prepare(`SELECT r.id AS reportId, r.filename AS report, p.full_name AS repo
    FROM managed_report r JOIN selected_repo p ON p.repo_id = r.repo_id
    WHERE EXISTS (SELECT 1 FROM team_repo tr JOIN team_user tu ON tu.team_id = tr.team_id
      WHERE tu.user_id = ? AND tr.repo_id = r.repo_id AND ${withinTeamPath('r.repo_directory')})
    ORDER BY r.uploaded_at DESC, r.id`)
  return {
    recordActivity(entry, at) {
      insert.run(randomUUID(), entry.kind, entry.actor, entry.action, entry.repo ?? null, entry.reportId ?? null, entry.report ?? null, at,
        entry.bundleId ?? null, entry.repoId ?? null, entry.repoDirectory ?? null, entry.actorId ?? null)
      return Promise.resolve()
    },
    listActivityReports(userId) {
      return Promise.resolve(reports.all(userId) as Omit<ActivityContext, 'finding'>[])
    },
    listActivity({ page, limit, kind, query, contexts, userId }) {
      const stmts = contexts == null ? admin : manager
      const params = contexts == null ? { kind, query } : { kind, query, contexts: JSON.stringify(contexts), userId: userId ?? '' }
      const { total } = stmts.count.get(params) as { total: number }
      const currentPage = Math.min(page, Math.max(1, Math.ceil(total / limit)))
      const history = stmts.rows.all({ ...params, limit, offset: (currentPage - 1) * limit }) as ActivityEntry[]
      return Promise.resolve({ history, total, page: currentPage, limit })
    },
  }
}

// Literal path comparison preserves separators, case and SQL wildcard chars.
function withinTeamPath(path: string): string {
  return `(tr.path IS NULL OR tr.path = '' OR ${path} = tr.path OR substr(${path}, 1, length(tr.path) + 1) = tr.path || '/')`
}

function migrateActivityScope(db: DatabaseSync): void {
  const columns = new Set((db.prepare('PRAGMA table_info(managed_activity)').all() as { name: string }[]).map(column => column.name))
  const missing = [['bundle_id', 'TEXT'], ['repo_id', 'INTEGER'], ['repo_directory', 'TEXT'], ['actor_id', 'TEXT']].filter(([name]) => !columns.has(name!))
  if (missing.length === 0) return
  db.exec('BEGIN')
  try {
    for (const [name, type] of missing) db.exec(`ALTER TABLE managed_activity ADD COLUMN ${name} ${type}`)
    if (!columns.has('bundle_id') || !columns.has('actor_id')) {
      db.exec('DROP TRIGGER IF EXISTS managed_report_activity; DROP TRIGGER IF EXISTS managed_bundle_activity;')
    }
    if (!columns.has('bundle_id')) db.exec("UPDATE managed_activity SET bundle_id = substr(id, 15) WHERE id LIKE 'bundle-upload:%'")
    if (!columns.has('actor_id')) {
      // Existing upload targets retain a reliable uploader identity. Do not
      // guess identities from historical logins: names can change or be reused.
      for (const type of ['report', 'bundle']) {
        db.exec(`UPDATE managed_activity SET actor_id = (
          SELECT uploaded_by FROM managed_${type} WHERE id = substr(managed_activity.id, 15)
        ) WHERE id LIKE '${type}-upload:%'`)
      }
    }
    // Legacy deletions/assignments without a durable target/scope remain
    // admin-only; neither filenames nor repository names authorize access.
    db.exec('COMMIT')
  } catch (err) { db.exec('ROLLBACK'); throw err }
}
