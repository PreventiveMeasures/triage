// Managed-server store: the user-identity + session tables backing GitHub
// auth. The `ManagedDb` interface is backend-agnostic and ASYNC so a future
// PostgreSQL backend can be added without refactoring any caller — but SQLite
// is the ONLY implementation for now (no alternative storage is wired yet).
//
// Users are keyed by a server-assigned `id` (an opaque uuid), NOT the GitHub
// numeric id: identity is just one provider, so nothing downstream (sessions,
// avatars, the client API) is locked to GitHub. `github_user_id` is kept only
// as the unique lookup key for the OAuth upsert; sessions reference `user_id`.
// The FIRST registered user is flagged `is_admin`.
//
// SQLite impl mirrors server-e2e/db.ts: WAL, FULL sync, foreign keys, STRICT
// tables, `CREATE TABLE IF NOT EXISTS` at open.
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const SQLITE_SCHEMA = `
CREATE TABLE IF NOT EXISTS managed_user (
  id             TEXT PRIMARY KEY,
  github_user_id INTEGER NOT NULL UNIQUE,
  login          TEXT NOT NULL,
  name           TEXT,
  avatar_url     TEXT,
  is_admin       INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS managed_session (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES managed_user(id) ON DELETE CASCADE,
  csrf_token TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS managed_session_user_idx ON managed_session(user_id);
CREATE INDEX IF NOT EXISTS managed_session_expires_idx ON managed_session(expires_at);
`

// A managed user identity (the subset of GitHub's `GET /user` we keep). Input
// to the upsert; `githubUserId` is the provider lookup key, never exposed to
// clients.
export interface ManagedUser {
  githubUserId: number
  login: string
  name: string | null
  avatarUrl: string | null
}

// A persisted user as read back from a session — identified by the opaque `id`;
// the GitHub id stays server-internal.
export interface StoredUser {
  id: string
  login: string
  name: string | null
  avatarUrl: string | null
  isAdmin: boolean
}

// A user row for the admin users list.
export interface AdminUser {
  id: string
  login: string
  name: string | null
  isAdmin: boolean
  createdAt: number
}

export interface ManagedSession {
  id: string
  userId: string
  csrfToken: string
  expiresAt: number
}

// Backend-agnostic store surface (SQLite + PostgreSQL implementations).
export interface ManagedDb {
  // Upsert the identity; returns the user's opaque id (stable across logins).
  upsertUser(user: ManagedUser, now: number): Promise<string>
  createSession(session: ManagedSession, now: number): Promise<void>
  sessionWithUser(id: string, now: number): Promise<{ session: ManagedSession; user: StoredUser } | null>
  deleteSession(id: string): Promise<void>
  deleteExpiredSessions(now: number): Promise<number>
  listUsers(): Promise<AdminUser[]>
  close(): Promise<void>
}

type SessionRow = {
  id: string; csrf: string; exp: number
  uid: string; login: string; name: string | null; avatar: string | null; admin: number
}

type UserRow = { id: string; login: string; name: string | null; admin: number; created: number }

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
    // is_admin: the FIRST registered user (table empty at insert time) becomes
    // admin — the subquery evaluates before this row is added. ON CONFLICT keeps
    // an existing user's is_admin untouched.
    `INSERT INTO managed_user (id, github_user_id, login, name, avatar_url, is_admin, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, (SELECT NOT EXISTS(SELECT 1 FROM managed_user)), ?, ?)
     ON CONFLICT(github_user_id) DO UPDATE SET
       login = excluded.login, name = excluded.name,
       avatar_url = excluded.avatar_url, updated_at = excluded.updated_at`,
  )
  const selectUserIdStmt = db.prepare(`SELECT id FROM managed_user WHERE github_user_id = ?`)
  const insertSessionStmt = db.prepare(
    `INSERT INTO managed_session (id, user_id, csrf_token, created_at, expires_at) VALUES (?, ?, ?, ?, ?)`,
  )
  const selectSessionStmt = db.prepare(
    `SELECT s.id AS id, s.csrf_token AS csrf, s.expires_at AS exp,
            u.id AS uid, u.login AS login, u.name AS name, u.avatar_url AS avatar, u.is_admin AS admin
       FROM managed_session s
       JOIN managed_user u ON u.id = s.user_id
      WHERE s.id = ? AND s.expires_at > ?`,
  )
  const selectUsersStmt = db.prepare(
    `SELECT id, login, name, is_admin AS admin, created_at AS created
       FROM managed_user ORDER BY created_at ASC, login ASC`,
  )
  const deleteSessionStmt = db.prepare(`DELETE FROM managed_session WHERE id = ?`)
  const deleteExpiredStmt = db.prepare(`DELETE FROM managed_session WHERE expires_at <= ?`)

  // The driver is synchronous; each method returns a resolved promise so a
  // synchronous throw still surfaces as the caller's awaited rejection.
  return {
    upsertUser(user, now) {
      // New row → a fresh id; ON CONFLICT(github_user_id) keeps an existing
      // user's id (DO UPDATE leaves it untouched), so re-read to return it.
      upsertUserStmt.run(randomUUID(), user.githubUserId, user.login, user.name, user.avatarUrl, now, now)
      const row = selectUserIdStmt.get(user.githubUserId) as { id: string }
      return Promise.resolve(row.id)
    },
    createSession(session, now) {
      insertSessionStmt.run(session.id, session.userId, session.csrfToken, now, session.expiresAt)
      return Promise.resolve()
    },
    sessionWithUser(id, now) {
      const row = selectSessionStmt.get(id, now) as SessionRow | undefined
      if (row == null) return Promise.resolve(null)
      return Promise.resolve({
        session: { id: row.id, userId: row.uid, csrfToken: row.csrf, expiresAt: row.exp },
        user: { id: row.uid, login: row.login, name: row.name, avatarUrl: row.avatar, isAdmin: row.admin === 1 },
      })
    },
    deleteSession(id) {
      deleteSessionStmt.run(id)
      return Promise.resolve()
    },
    deleteExpiredSessions(now) {
      return Promise.resolve(Number(deleteExpiredStmt.run(now).changes))
    },
    listUsers() {
      const rows = selectUsersStmt.all() as UserRow[]
      return Promise.resolve(rows.map((r) => ({ id: r.id, login: r.login, name: r.name, isAdmin: r.admin === 1, createdAt: r.created })))
    },
    close() {
      db.close()
      return Promise.resolve()
    },
  }
}
