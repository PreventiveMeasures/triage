import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { type ManagedComment, canDeleteComment } from '../common/managed/comments.ts'
import type { ManagedSql } from './sql.ts'

export interface CommentInput {
  findingId: string
  body: string
  // Runtime imports may omit authorship, including future admin UI imports.
  // Ordinary comment posts always supply the authenticated user as author.
  authorId: string | null
  authorLogin: string | null
  // The user performing an import need not be the author of its comments.
  // Omitted for ordinary posts, where the author is also the acting user.
  actor?: { id: string; login: string }
  // Omitted dates default to the action time; null preserves unknown dates.
  createdAt?: number | null
  updatedAt?: number | null
  reportId?: string | null
}

export interface CommentStore {
  listComments(findingIds: readonly string[]): Promise<ManagedComment[]>
  listCommentedFindingIds(findingIds: readonly string[]): Promise<string[]>
  getComment(id: string): Promise<ManagedComment | null>
  createComment(input: CommentInput, now: number): Promise<ManagedComment>
  editComment(id: string, authorId: string, authorLogin: string, body: string, version: number, reportId: string, now: number): Promise<ManagedComment | 'conflict' | 'forbidden' | null>
  deleteComment(id: string, actorId: string, actorLogin: string, version: number, reportId: string, now: number): Promise<'deleted' | 'conflict' | 'forbidden' | null>
}

const COMMENT_COLUMNS = `id TEXT PRIMARY KEY, finding_id TEXT NOT NULL, body TEXT NOT NULL,
  author_id TEXT REFERENCES managed_user(id) ON DELETE SET NULL,
  author_login TEXT, created_at INTEGER, updated_at INTEGER,
  version INTEGER NOT NULL DEFAULT 1`

export const COMMENT_SCHEMA = `
    CREATE TABLE IF NOT EXISTS finding_comment (${COMMENT_COLUMNS}) STRICT;
    CREATE INDEX IF NOT EXISTS finding_comment_finding_idx ON finding_comment(finding_id, created_at, id);
    CREATE TABLE IF NOT EXISTS finding_comment_event (
      seq INTEGER PRIMARY KEY, comment_id TEXT NOT NULL, finding_id TEXT NOT NULL,
      actor_id TEXT REFERENCES managed_user(id) ON DELETE SET NULL,
      actor_login TEXT, action TEXT NOT NULL, at INTEGER NOT NULL,
      report_id TEXT, report TEXT, repo TEXT
    ) STRICT;
    CREATE INDEX IF NOT EXISTS finding_comment_event_finding_idx ON finding_comment_event(finding_id, seq);
    CREATE INDEX IF NOT EXISTS finding_comment_event_actor_at_idx ON finding_comment_event(actor_id, at);
    CREATE INDEX IF NOT EXISTS finding_comment_event_at_idx ON finding_comment_event(at, seq);
`

export function initCommentMethods(db: DatabaseSync): void {
  db.exec(COMMENT_SCHEMA)
  migrateCommentDates(db)
  // updated_by belongs to the whole triage row, not necessarily its comment.
  // Preserve legacy text without guessing an author. Clearing the old column
  // in the same transaction makes the migration safe to restart. Use a fresh
  // ID so a later legacy-server write cannot collide with an earlier import.
  db.exec('BEGIN')
  try {
    db.exec(`INSERT INTO finding_comment (id, finding_id, body, created_at, updated_at)
      SELECT 'legacy:' || lower(hex(randomblob(16))), finding_id, comment, updated_at, updated_at
      FROM finding_triage WHERE comment IS NOT NULL AND comment != '';
      UPDATE finding_triage SET comment = NULL WHERE comment IS NOT NULL;`)
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

export function commentMethods(db: ManagedSql): CommentStore {
  const fields = `c.id, c.finding_id AS findingId, c.body, c.author_id AS authorId,
    COALESCE(u.login, c.author_login) AS authorLogin,
    c.created_at AS createdAt, c.updated_at AS updatedAt, c.version`
  const select = db.prepare(`SELECT ${fields} FROM finding_comment c
    LEFT JOIN managed_user u ON u.id = c.author_id WHERE c.id = ?`)
  const list = db.prepare(`SELECT ${fields} FROM finding_comment c
    LEFT JOIN managed_user u ON u.id = c.author_id
    WHERE c.finding_id IN (SELECT value FROM json_each(?)) ORDER BY c.created_at NULLS FIRST, c.id`)
  const insert = db.prepare(`INSERT INTO finding_comment
    (id, finding_id, body, author_id, author_login, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
  const update = db.prepare(`UPDATE finding_comment SET body = ?, updated_at = ?, version = version + 1
    WHERE id = ? AND author_id = ? AND version = ?`)
  const remove = db.prepare('DELETE FROM finding_comment WHERE id = ? AND (author_id = ? OR (author_id IS NULL AND ? IS NULL)) AND version = ?')
  const userRole = db.prepare('SELECT role FROM managed_user WHERE id = ?')
  // Deleted comments still have audit events which explicit annotation purges
  // must find, including when no current triage/comment record remains.
  const annotated = db.prepare(`SELECT finding_id AS id FROM finding_comment WHERE finding_id IN (SELECT value FROM json_each(?))
    UNION SELECT finding_id AS id FROM finding_comment_event WHERE finding_id IN (SELECT value FROM json_each(?))`)
  const event = db.prepare(`INSERT INTO finding_comment_event
    (comment_id, finding_id, actor_id, actor_login, action, at, report_id, report, repo)
    VALUES (?, ?, ?, ?, ?, ?, ?, (SELECT filename FROM managed_report WHERE id = ?),
      (SELECT p.full_name FROM managed_report r JOIN selected_repo p ON p.repo_id = r.repo_id WHERE r.id = ?))`)
  const read = async (id: string) => (await select.get(id)) as ManagedComment | undefined
  return {
    async listComments(ids) { return ids.length > 0 ? (await list.all(JSON.stringify(ids))) as unknown as ManagedComment[] : [] },
    async listCommentedFindingIds(ids) {
      const json = JSON.stringify(ids)
      return ((await annotated.all(json, json)) as { id: string }[]).map(row => row.id)
    },
    async getComment(id) { return (await read(id)) ?? null },
    async createComment(input, now) {
      const id = randomUUID()
      const createdAt = input.createdAt === undefined ? now : input.createdAt
      const updatedAt = input.updatedAt === undefined ? createdAt : input.updatedAt
      await insert.run(id, input.findingId, input.body, input.authorId, input.authorLogin, createdAt, updatedAt)
      await event.run(id, input.findingId, input.actor?.id ?? input.authorId, input.actor?.login ?? input.authorLogin, 'added a comment', now,
        input.reportId ?? null, input.reportId ?? null, input.reportId ?? null)
      return (await read(id))!
    },
    async editComment(id, authorId, authorLogin, body, version, reportId, now) {
      // Identity/version checks and the event share the operation transaction.
      const current = await read(id)
      if (!current || current.authorId !== authorId || current.version !== version || current.body === body) {
        if (!current) return null
        if (current.authorId !== authorId) return 'forbidden'
        if (current.version !== version) return 'conflict'
        return current
      }
      await update.run(body, now, id, authorId, version)
      await event.run(id, current.findingId, authorId, authorLogin, 'edited a comment', now, reportId, reportId, reportId)
      return (await read(id))!
    },
    async deleteComment(id, actorId, actorLogin, version, reportId, now) {
      const current = await read(id)
      const role = (await userRole.get(actorId) as { role: string } | undefined)?.role ?? 'none'
      const allowed = current != null && canDeleteComment(current, { id: actorId, role })
      if (!current || !allowed || current.version !== version) {
        if (!current) return null
        return allowed ? 'conflict' : 'forbidden'
      }
      await remove.run(id, current.authorId, current.authorId, version)
      await event.run(id, current.findingId, actorId, actorLogin, 'deleted a comment', now, reportId, reportId, reportId)
      return 'deleted'
    },
  }
}

function migrateCommentDates(db: DatabaseSync): void {
  const columns = db.prepare('PRAGMA table_info(finding_comment)').all() as { name: string; notnull: number }[]
  if (!columns.some(column => ['created_at', 'updated_at'].includes(column.name) && column.notnull)) return
  db.exec('BEGIN')
  try {
    db.exec(`CREATE TABLE finding_comment_nullable_dates (${COMMENT_COLUMNS}) STRICT;
      INSERT INTO finding_comment_nullable_dates (id, finding_id, body, author_id, author_login, created_at, updated_at, version)
        SELECT id, finding_id, body, author_id, author_login, created_at, updated_at, version FROM finding_comment;
      DROP TABLE finding_comment;
      ALTER TABLE finding_comment_nullable_dates RENAME TO finding_comment;
      CREATE INDEX finding_comment_finding_idx ON finding_comment(finding_id, created_at, id);`)
    db.exec('COMMIT')
  } catch (err) { db.exec('ROLLBACK'); throw err }
}
