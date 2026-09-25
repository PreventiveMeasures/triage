// Persistent workspace activity. Uploads are recorded in the same transaction
// as their metadata; triage reuses its existing immutable trail, including
// legacy entries. Never copy annotation bodies or credentials into this feed.
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

export interface ActivityInput {
  kind: 'access' | 'repository' | 'visibility' | 'delete'
  actor: string
  action: string
  repo?: string | null
  reportId?: string | null
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
}

export interface ActivityStore {
  recordActivity(entry: ActivityInput, at: number): Promise<void>
  listActivity(query: ActivityQuery): Promise<{ history: ActivityEntry[]; total: number; page: number; limit: number }>
}

export function activityMethods(db: DatabaseSync): ActivityStore {
  db.exec(`
    CREATE TABLE IF NOT EXISTS managed_activity (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, actor TEXT, action TEXT NOT NULL,
      repo TEXT, report_id TEXT, report TEXT, at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS managed_activity_at_idx ON managed_activity(at, id);
    CREATE INDEX IF NOT EXISTS finding_triage_event_at_idx ON finding_triage_event(at, seq);
  `)
  // Stable upload IDs make backfill idempotent, including after restarts.
  // Snapshots deliberately have no cascading FKs: deletion is itself activity.
  for (const type of ['report', 'bundle']) {
    const columns = `id, kind, actor, action, repo, report_id, report, at`
    const values = (alias: string) => `'${type}-upload:' || ${alias}.id, 'upload',
      COALESCE(${alias}.uploaded_by_login, (SELECT login FROM managed_user WHERE id = ${alias}.uploaded_by)), 'uploaded a ${type}',
      (SELECT full_name FROM selected_repo WHERE repo_id = ${alias}.repo_id),
      ${type === 'report' ? `${alias}.id` : 'NULL'}, ${alias}.filename, ${alias}.uploaded_at`
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS managed_${type}_activity AFTER INSERT ON managed_${type}
      BEGIN INSERT INTO managed_activity (${columns}) SELECT ${values('NEW')}; END;
      INSERT OR IGNORE INTO managed_activity (${columns}) SELECT ${values('source')} FROM managed_${type} source;
    `)
  }
  const insert = db.prepare(`INSERT INTO managed_activity (id, kind, actor, action, repo, report_id, report, at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
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
    LEFT JOIN managed_user u ON u.id = e.actor_id`
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
  return {
    recordActivity(entry, at) {
      insert.run(randomUUID(), entry.kind, entry.actor, entry.action, entry.repo ?? null, entry.reportId ?? null, entry.report ?? null, at)
      return Promise.resolve()
    },
    listActivity({ page, limit, kind, query, contexts }) {
      const stmts = contexts == null ? admin : manager
      const params = contexts == null ? { kind, query } : { kind, query, contexts: JSON.stringify(contexts) }
      const { total } = stmts.count.get(params) as { total: number }
      const currentPage = Math.min(page, Math.max(1, Math.ceil(total / limit)))
      const history = stmts.rows.all({ ...params, limit, offset: (currentPage - 1) * limit }) as ActivityEntry[]
      return Promise.resolve({ history, total, page: currentPage, limit })
    },
  }
}
