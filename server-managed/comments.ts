import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { ManagedComment } from '../common/managed/comments.ts'

export interface CommentInput {
  findingId: string
  body: string
  authorId: string | null
  authorLogin: string | null
  reportId?: string | null
}

export interface CommentStore {
  listComments(findingIds: readonly string[]): Promise<ManagedComment[]>
  getComment(id: string): Promise<ManagedComment | null>
  createComment(input: CommentInput, now: number): Promise<ManagedComment>
  editComment(id: string, authorId: string, authorLogin: string, body: string, version: number, reportId: string, now: number): Promise<ManagedComment | 'conflict' | 'forbidden' | null>
}

export function commentMethods(db: DatabaseSync): CommentStore {
  db.exec(`
    CREATE TABLE IF NOT EXISTS finding_comment (
      id TEXT PRIMARY KEY, finding_id TEXT NOT NULL, body TEXT NOT NULL,
      author_id TEXT REFERENCES managed_user(id) ON DELETE SET NULL,
      author_login TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      version INTEGER NOT NULL DEFAULT 1
    ) STRICT;
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
  `)
  // updated_by belongs to the whole triage row, not necessarily its comment.
  // Preserve legacy text without guessing an author. Clearing the old column
  // in the same transaction makes the migration safe to restart.
  db.exec('BEGIN')
  try {
    db.exec(`INSERT INTO finding_comment (id, finding_id, body, created_at, updated_at)
      SELECT 'legacy:' || finding_id, finding_id, comment, updated_at, updated_at
      FROM finding_triage WHERE comment IS NOT NULL AND comment != '';
      UPDATE finding_triage SET comment = NULL WHERE comment IS NOT NULL;`)
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
  const fields = `c.id, c.finding_id AS findingId, c.body, c.author_id AS authorId,
    COALESCE(u.login, c.author_login) AS authorLogin,
    c.created_at AS createdAt, c.updated_at AS updatedAt, c.version`
  const select = db.prepare(`SELECT ${fields} FROM finding_comment c
    LEFT JOIN managed_user u ON u.id = c.author_id WHERE c.id = ?`)
  const list = db.prepare(`SELECT ${fields} FROM finding_comment c
    LEFT JOIN managed_user u ON u.id = c.author_id
    WHERE c.finding_id IN (SELECT value FROM json_each(?)) ORDER BY c.created_at, c.id`)
  const insert = db.prepare(`INSERT INTO finding_comment
    (id, finding_id, body, author_id, author_login, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
  const update = db.prepare(`UPDATE finding_comment SET body = ?, updated_at = ?, version = version + 1
    WHERE id = ? AND author_id = ? AND version = ?`)
  const event = db.prepare(`INSERT INTO finding_comment_event
    (comment_id, finding_id, actor_id, actor_login, action, at, report_id, report, repo)
    VALUES (?, ?, ?, ?, ?, ?, ?, (SELECT filename FROM managed_report WHERE id = ?),
      (SELECT p.full_name FROM managed_report r JOIN selected_repo p ON p.repo_id = r.repo_id WHERE r.id = ?))`)
  const read = (id: string) => select.get(id) as ManagedComment | undefined
  return {
    listComments(ids) { return Promise.resolve(ids.length > 0 ? list.all(JSON.stringify(ids)) as unknown as ManagedComment[] : []) },
    getComment(id) { return Promise.resolve(read(id) ?? null) },
    createComment(input, now) {
      const id = randomUUID()
      db.exec('BEGIN')
      try {
        insert.run(id, input.findingId, input.body, input.authorId, input.authorLogin, now, now)
        event.run(id, input.findingId, input.authorId, input.authorLogin, 'added a comment', now,
          input.reportId ?? null, input.reportId ?? null, input.reportId ?? null)
        db.exec('COMMIT')
      } catch (err) { db.exec('ROLLBACK'); throw err }
      return Promise.resolve(read(id)!)
    },
    editComment(id, authorId, authorLogin, body, version, reportId, now) {
      // No await between reading and committing: identity/version checks and
      // the history event belong to the same SQLite transaction.
      db.exec('BEGIN')
      try {
        const current = read(id)
        if (!current || current.authorId !== authorId || current.version !== version || current.body === body) {
          db.exec('COMMIT')
          if (!current) return Promise.resolve(null)
          if (current.authorId !== authorId) return Promise.resolve('forbidden')
          if (current.version !== version) return Promise.resolve('conflict')
          return Promise.resolve(current)
        }
        update.run(body, now, id, authorId, version)
        event.run(id, current.findingId, authorId, authorLogin, 'edited a comment', now, reportId, reportId, reportId)
        db.exec('COMMIT')
        return Promise.resolve(read(id)!)
      } catch (err) { db.exec('ROLLBACK'); throw err }
    },
  }
}
