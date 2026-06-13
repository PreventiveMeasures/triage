// Managed-server store: the user-identity + session tables backing GitHub
// auth. The `ManagedDb` interface is backend-agnostic and ASYNC so a future
// PostgreSQL backend can be added without refactoring any caller — but SQLite
// is the ONLY implementation for now (no alternative storage is wired yet).
//
// This SQLite impl mirrors server-e2e/db.ts: WAL, FULL sync, foreign keys,
// STRICT tables, `CREATE TABLE IF NOT EXISTS` at open. No GitHub token column
// yet — this slice authenticates identity only. Each user carries a
// server-assigned `uuid` (opaque id) used to key the avatar cache + identify
// the user to clients without leaking the GitHub numeric id.
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

// SQLite DDL (STRICT tables). Kept close to portable SQL so a future Postgres
// backend can map the same columns to its own types without schema drift.
const SQLITE_SCHEMA = `
CREATE TABLE IF NOT EXISTS managed_user (
  github_user_id INTEGER PRIMARY KEY,
  uuid           TEXT NOT NULL UNIQUE,
  login          TEXT NOT NULL,
  name           TEXT,
  avatar_url     TEXT,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS managed_session (
  id             TEXT PRIMARY KEY,
  github_user_id INTEGER NOT NULL REFERENCES managed_user(github_user_id) ON DELETE CASCADE,
  csrf_token     TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  expires_at     INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS managed_session_user_idx ON managed_session(github_user_id);
CREATE INDEX IF NOT EXISTS managed_session_expires_idx ON managed_session(expires_at);
`

// A managed user identity (the subset of GitHub's `GET /user` we keep).
export interface ManagedUser {
  githubUserId: number
  login: string
  name: string | null
  avatarUrl: string | null
}

// A persisted user as read back — adds the server-assigned opaque id used to
// key the avatar cache and identify the user to clients.
export interface StoredUser extends ManagedUser {
  uuid: string
}

export interface ManagedSession {
  id: string
  githubUserId: number
  csrfToken: string
  expiresAt: number
}

// Backend-agnostic store surface (SQLite + PostgreSQL implementations).
export interface ManagedDb {
  // Upsert the identity; returns the user's opaque uuid (stable across logins).
  upsertUser(user: ManagedUser, now: number): Promise<string>
  createSession(session: ManagedSession, now: number): Promise<void>
  sessionWithUser(id: string, now: number): Promise<{ session: ManagedSession; user: StoredUser } | null>
  deleteSession(id: string): Promise<void>
  deleteExpiredSessions(now: number): Promise<number>
  close(): Promise<void>
}

type SessionRow = {
  id: string; uid: number; csrf: string; exp: number
  uuid: string; login: string; name: string | null; avatar: string | null
}

// Migrate a pre-uuid managed_user table (the auth-core schema had no uuid):
// add the column, backfill a uuid per existing row, then enforce uniqueness. A
// fresh DB already has `uuid NOT NULL UNIQUE` from the schema, so this no-ops.
function ensureUuidColumn(db: DatabaseSync): void {
  const cols = db.prepare('PRAGMA table_info(managed_user)').all() as Array<{ name: string }>
  if (cols.some((c) => c.name === 'uuid')) return
  db.exec('ALTER TABLE managed_user ADD COLUMN uuid TEXT')
  const rows = db.prepare('SELECT github_user_id AS gid FROM managed_user WHERE uuid IS NULL').all() as Array<{ gid: number }>
  const upd = db.prepare('UPDATE managed_user SET uuid = ? WHERE github_user_id = ?')
  for (const r of rows) upd.run(randomUUID(), r.gid)
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS managed_user_uuid_idx ON managed_user(uuid)')
}

export function openSqliteManagedDb(path: string): ManagedDb {
  mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  try {
    db.exec('PRAGMA journal_mode = WAL;')
    db.exec('PRAGMA synchronous = FULL;')
    db.exec('PRAGMA foreign_keys = ON;')
    db.exec(SQLITE_SCHEMA)
    ensureUuidColumn(db)
  } catch (err) {
    try { db.close() } catch {}
    throw err
  }

  const upsertUserStmt = db.prepare(
    `INSERT INTO managed_user (github_user_id, uuid, login, name, avatar_url, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(github_user_id) DO UPDATE SET
       login = excluded.login, name = excluded.name,
       avatar_url = excluded.avatar_url, updated_at = excluded.updated_at`,
  )
  const selectUserUuidStmt = db.prepare(`SELECT uuid FROM managed_user WHERE github_user_id = ?`)
  const insertSessionStmt = db.prepare(
    `INSERT INTO managed_session (id, github_user_id, csrf_token, created_at, expires_at) VALUES (?, ?, ?, ?, ?)`,
  )
  const selectSessionStmt = db.prepare(
    `SELECT s.id AS id, s.github_user_id AS uid, s.csrf_token AS csrf, s.expires_at AS exp,
            u.uuid AS uuid, u.login AS login, u.name AS name, u.avatar_url AS avatar
       FROM managed_session s
       JOIN managed_user u ON u.github_user_id = s.github_user_id
      WHERE s.id = ? AND s.expires_at > ?`,
  )
  const deleteSessionStmt = db.prepare(`DELETE FROM managed_session WHERE id = ?`)
  const deleteExpiredStmt = db.prepare(`DELETE FROM managed_session WHERE expires_at <= ?`)

  // The driver is synchronous; each method returns a resolved promise so a
  // synchronous throw still surfaces as the caller's awaited rejection.
  return {
    upsertUser(user, now) {
      // Generate a uuid for a NEW row; the ON CONFLICT update leaves an
      // existing user's uuid untouched, so re-read the stored value to return.
      upsertUserStmt.run(user.githubUserId, randomUUID(), user.login, user.name, user.avatarUrl, now, now)
      const row = selectUserUuidStmt.get(user.githubUserId) as { uuid: string }
      return Promise.resolve(row.uuid)
    },
    createSession(session, now) {
      insertSessionStmt.run(session.id, session.githubUserId, session.csrfToken, now, session.expiresAt)
      return Promise.resolve()
    },
    sessionWithUser(id, now) {
      const row = selectSessionStmt.get(id, now) as SessionRow | undefined
      if (row == null) return Promise.resolve(null)
      return Promise.resolve({
        session: { id: row.id, githubUserId: row.uid, csrfToken: row.csrf, expiresAt: row.exp },
        user: { uuid: row.uuid, githubUserId: row.uid, login: row.login, name: row.name, avatarUrl: row.avatar },
      })
    },
    deleteSession(id) {
      deleteSessionStmt.run(id)
      return Promise.resolve()
    },
    deleteExpiredSessions(now) {
      return Promise.resolve(Number(deleteExpiredStmt.run(now).changes))
    },
    close() {
      db.close()
      return Promise.resolve()
    },
  }
}
