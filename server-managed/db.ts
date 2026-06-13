// Managed-server store: the user-identity + session tables backing GitHub
// auth. The `ManagedDb` interface is backend-agnostic and ASYNC so a future
// PostgreSQL backend can be added without refactoring any caller — but SQLite
// is the ONLY implementation for now (no alternative storage is wired yet).
//
// This SQLite impl mirrors server-e2e/db.ts: WAL, FULL sync, foreign keys,
// STRICT tables, `CREATE TABLE IF NOT EXISTS` at open. No GitHub token column
// yet — this slice authenticates identity only.
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

// SQLite DDL (STRICT tables). Kept close to portable SQL so a future Postgres
// backend can map the same columns to its own types without schema drift.
const SQLITE_SCHEMA = `
CREATE TABLE IF NOT EXISTS managed_user (
  github_user_id INTEGER PRIMARY KEY,
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

export interface ManagedSession {
  id: string
  githubUserId: number
  csrfToken: string
  expiresAt: number
}

// Backend-agnostic store surface (SQLite + PostgreSQL implementations).
export interface ManagedDb {
  upsertUser(user: ManagedUser, now: number): Promise<void>
  createSession(session: ManagedSession, now: number): Promise<void>
  sessionWithUser(id: string, now: number): Promise<{ session: ManagedSession; user: ManagedUser } | null>
  deleteSession(id: string): Promise<void>
  deleteExpiredSessions(now: number): Promise<number>
  close(): Promise<void>
}

type SessionRow = {
  id: string; uid: number; csrf: string; exp: number
  login: string; name: string | null; avatar: string | null
}

export function openSqliteManagedDb(path: string): ManagedDb {
  mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  try {
    db.exec('PRAGMA journal_mode = WAL;')
    db.exec('PRAGMA synchronous = FULL;')
    db.exec('PRAGMA foreign_keys = ON;')
    db.exec(SQLITE_SCHEMA)
  } catch (err) {
    try { db.close() } catch {}
    throw err
  }

  const upsertUserStmt = db.prepare(
    `INSERT INTO managed_user (github_user_id, login, name, avatar_url, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(github_user_id) DO UPDATE SET
       login = excluded.login, name = excluded.name,
       avatar_url = excluded.avatar_url, updated_at = excluded.updated_at`,
  )
  const insertSessionStmt = db.prepare(
    `INSERT INTO managed_session (id, github_user_id, csrf_token, created_at, expires_at) VALUES (?, ?, ?, ?, ?)`,
  )
  const selectSessionStmt = db.prepare(
    `SELECT s.id AS id, s.github_user_id AS uid, s.csrf_token AS csrf, s.expires_at AS exp,
            u.login AS login, u.name AS name, u.avatar_url AS avatar
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
      upsertUserStmt.run(user.githubUserId, user.login, user.name, user.avatarUrl, now, now)
      return Promise.resolve()
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
        user: { githubUserId: row.uid, login: row.login, name: row.name, avatarUrl: row.avatar },
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
