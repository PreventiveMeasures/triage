// Managed-server store: the user-identity + session tables backing GitHub
// auth, plus the `selected_repo` table — the repositories an admin/manage user
// has chosen for the workspace to operate on. The `ManagedDb` interface is
// backend-agnostic and ASYNC so a future PostgreSQL backend can be added
// without refactoring any caller — but SQLite is the ONLY implementation for
// now (no alternative storage is wired yet).
//
// Users are keyed by a server-assigned `id` (an opaque uuid), NOT the GitHub
// numeric id: identity is just one provider, so nothing downstream (sessions,
// avatars, the client API) is locked to GitHub. `github_user_id` is kept only
// as the unique lookup key for the OAuth upsert; sessions reference `user_id`.
// Each user carries a `role` (see common/managed/roles.ts); the FIRST registered user
// is `admin`, later users default to `none`.
//
// SQLite impl mirrors server-e2e/db.ts: WAL, FULL sync, foreign keys, STRICT
// tables, `CREATE TABLE IF NOT EXISTS` at open.
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Role } from '../common/managed/roles.ts'

const SQLITE_SCHEMA = `
CREATE TABLE IF NOT EXISTS managed_user (
  id             TEXT PRIMARY KEY,
  github_user_id INTEGER NOT NULL UNIQUE,
  login          TEXT NOT NULL,
  name           TEXT,
  avatar_url     TEXT,
  role           TEXT NOT NULL DEFAULT 'none',
  -- GitHub user-to-server token, persisted so the repositories page can list
  -- the user's repos (GET /user/repos) on demand. Refresh token + expiry are
  -- null for non-expiring tokens (GitHub App with expiring tokens disabled).
  gh_access_token      TEXT,
  gh_refresh_token     TEXT,
  gh_token_expires_at  INTEGER,
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

-- Repositories selected to operate on. Keyed by GitHub's numeric repo id
-- (stable across renames). The row carries everything needed to read the repo's
-- contents server-side later: installation_id mints an App installation token
-- (Contents: Read) for PRIVATE repos — NULL means a PUBLIC repo readable without
-- the App — and full_name + default_branch locate the contents. added_by is the
-- selector, nulled (not cascaded) if that user is removed so the selection
-- survives.
CREATE TABLE IF NOT EXISTS selected_repo (
  repo_id         INTEGER PRIMARY KEY,
  full_name       TEXT NOT NULL,
  is_private      INTEGER NOT NULL,
  installation_id INTEGER,
  default_branch  TEXT NOT NULL,
  html_url        TEXT NOT NULL,
  added_by        TEXT REFERENCES managed_user(id) ON DELETE SET NULL,
  added_at        INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS selected_repo_full_name_idx ON selected_repo(full_name);
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
  role: Role
}

// A user row for the admin users list.
export interface AdminUser {
  id: string
  login: string
  name: string | null
  role: Role
  createdAt: number
}

// A user's persisted GitHub user-to-server token. `refreshToken` / `expiresAt`
// are null when the App issues non-expiring tokens.
export interface UserTokens {
  accessToken: string
  refreshToken: string | null
  expiresAt: number | null
}

export interface ManagedSession {
  id: string
  userId: string
  csrfToken: string
  expiresAt: number
}

// A repository selected for the workspace to operate on, with the context to
// read its contents: `installationId` mints an App installation token (Contents:
// Read) for a PRIVATE repo — null for a PUBLIC repo readable without the App —
// and `fullName` + `defaultBranch` locate the contents
// (GET /repos/{fullName}/contents?ref={defaultBranch}).
export interface SelectedRepo {
  repoId: number
  fullName: string
  private: boolean
  installationId: number | null
  defaultBranch: string
  htmlUrl: string
  addedBy: string | null
  addedAt: number
}

// What a caller supplies to select (upsert) a repo; the store stamps the
// timestamps.
export type SelectedRepoInput = Omit<SelectedRepo, 'addedAt'>

// Backend-agnostic store surface (SQLite + PostgreSQL implementations).
export interface ManagedDb {
  // Upsert the identity; returns the user's opaque id (stable across logins).
  upsertUser(user: ManagedUser, now: number): Promise<string>
  createSession(session: ManagedSession, now: number): Promise<void>
  sessionWithUser(id: string, now: number): Promise<{ session: ManagedSession; user: StoredUser } | null>
  deleteSession(id: string): Promise<void>
  deleteExpiredSessions(now: number): Promise<number>
  listUsers(): Promise<AdminUser[]>
  // Set a user's role; resolves true iff a matching user row was updated.
  setUserRole(id: string, role: Role): Promise<boolean>
  // Persist / read a user's GitHub token (for on-demand repo listing).
  setUserTokens(id: string, tokens: UserTokens): Promise<void>
  getUserTokens(id: string): Promise<UserTokens | null>
  // Repo selection ("operate on"). selectRepo upserts by repo id, refreshing the
  // mutable context while keeping the original added_by/added_at; deselectRepo
  // resolves true iff a row was removed.
  selectRepo(repo: SelectedRepoInput, now: number): Promise<void>
  deselectRepo(repoId: number): Promise<boolean>
  listSelectedRepos(): Promise<SelectedRepo[]>
  close(): Promise<void>
}

type SessionRow = {
  id: string; csrf: string; exp: number
  uid: string; login: string; name: string | null; avatar: string | null; role: Role
}

type UserRow = { id: string; login: string; name: string | null; role: Role; created: number }

// Prepare every statement the store uses, returned as a bag the factory
// destructures — keeps openSqliteManagedDb itself small (one place per query).
function prepareStatements(db: DatabaseSync) {
  return {
    // role: the FIRST registered user (table empty at insert time) is admin;
    // later users default to none. The subquery evaluates before this row is
    // added. ON CONFLICT keeps an existing user's role untouched.
    upsertUserStmt: db.prepare(
      `INSERT INTO managed_user (id, github_user_id, login, name, avatar_url, role, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, (SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM managed_user) THEN 'admin' ELSE 'none' END), ?, ?)
       ON CONFLICT(github_user_id) DO UPDATE SET
         login = excluded.login, name = excluded.name,
         avatar_url = excluded.avatar_url, updated_at = excluded.updated_at`,
    ),
    selectUserIdStmt: db.prepare(`SELECT id FROM managed_user WHERE github_user_id = ?`),
    insertSessionStmt: db.prepare(
      `INSERT INTO managed_session (id, user_id, csrf_token, created_at, expires_at) VALUES (?, ?, ?, ?, ?)`,
    ),
    selectSessionStmt: db.prepare(
      `SELECT s.id AS id, s.csrf_token AS csrf, s.expires_at AS exp,
              u.id AS uid, u.login AS login, u.name AS name, u.avatar_url AS avatar, u.role AS role
         FROM managed_session s
         JOIN managed_user u ON u.id = s.user_id
        WHERE s.id = ? AND s.expires_at > ?`,
    ),
    selectUsersStmt: db.prepare(
      `SELECT id, login, name, role, created_at AS created
         FROM managed_user ORDER BY created_at ASC, login ASC`,
    ),
    updateRoleStmt: db.prepare(`UPDATE managed_user SET role = ?, updated_at = ? WHERE id = ?`),
    updateTokensStmt: db.prepare(
      `UPDATE managed_user
          SET gh_access_token = ?, gh_refresh_token = ?, gh_token_expires_at = ?, updated_at = ?
        WHERE id = ?`,
    ),
    selectTokensStmt: db.prepare(
      `SELECT gh_access_token AS access, gh_refresh_token AS refresh, gh_token_expires_at AS exp
         FROM managed_user WHERE id = ?`,
    ),
    deleteSessionStmt: db.prepare(`DELETE FROM managed_session WHERE id = ?`),
    deleteExpiredStmt: db.prepare(`DELETE FROM managed_session WHERE expires_at <= ?`),
    upsertRepoStmt: db.prepare(
      `INSERT INTO selected_repo (repo_id, full_name, is_private, installation_id, default_branch, html_url, added_by, added_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(repo_id) DO UPDATE SET
         full_name = excluded.full_name, is_private = excluded.is_private,
         installation_id = excluded.installation_id, default_branch = excluded.default_branch,
         html_url = excluded.html_url, updated_at = excluded.updated_at`,
    ),
    deleteRepoStmt: db.prepare(`DELETE FROM selected_repo WHERE repo_id = ?`),
    selectReposStmt: db.prepare(
      `SELECT repo_id AS repoId, full_name AS fullName, is_private AS priv,
              installation_id AS installId, default_branch AS branch, html_url AS htmlUrl,
              added_by AS addedBy, added_at AS addedAt
         FROM selected_repo ORDER BY full_name ASC`,
    ),
  }
}

type RepoRow = {
  repoId: number; fullName: string; priv: number; installId: number | null
  branch: string; htmlUrl: string; addedBy: string | null; addedAt: number
}

// The repo-selection slice of ManagedDb, split out to keep openSqliteManagedDb
// within the per-function line budget. Closes over its prepared statements.
function selectedRepoMethods(stmts: ReturnType<typeof prepareStatements>) {
  const { upsertRepoStmt, deleteRepoStmt, selectReposStmt } = stmts
  return {
    selectRepo(repo: SelectedRepoInput, now: number): Promise<void> {
      upsertRepoStmt.run(
        repo.repoId, repo.fullName, repo.private ? 1 : 0, repo.installationId,
        repo.defaultBranch, repo.htmlUrl, repo.addedBy, now, now,
      )
      return Promise.resolve()
    },
    deselectRepo(repoId: number): Promise<boolean> {
      return Promise.resolve(Number(deleteRepoStmt.run(repoId).changes) > 0)
    },
    listSelectedRepos(): Promise<SelectedRepo[]> {
      const rows = selectReposStmt.all() as RepoRow[]
      return Promise.resolve(rows.map((r) => ({
        repoId: r.repoId, fullName: r.fullName, private: r.priv === 1,
        installationId: r.installId, defaultBranch: r.branch, htmlUrl: r.htmlUrl,
        addedBy: r.addedBy, addedAt: r.addedAt,
      })))
    },
  }
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

  const stmts = prepareStatements(db)
  const {
    upsertUserStmt, selectUserIdStmt, insertSessionStmt, selectSessionStmt, selectUsersStmt,
    updateRoleStmt, updateTokensStmt, selectTokensStmt, deleteSessionStmt, deleteExpiredStmt,
  } = stmts

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
        user: { id: row.uid, login: row.login, name: row.name, avatarUrl: row.avatar, role: row.role },
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
      return Promise.resolve(rows.map((r) => ({ id: r.id, login: r.login, name: r.name, role: r.role, createdAt: r.created })))
    },
    setUserRole(id, role) {
      return Promise.resolve(Number(updateRoleStmt.run(role, Date.now(), id).changes) > 0)
    },
    setUserTokens(id, tokens) {
      updateTokensStmt.run(tokens.accessToken, tokens.refreshToken, tokens.expiresAt, Date.now(), id)
      return Promise.resolve()
    },
    getUserTokens(id) {
      const row = selectTokensStmt.get(id) as { access: string | null; refresh: string | null; exp: number | null } | undefined
      if (row == null || row.access == null) return Promise.resolve(null)
      return Promise.resolve({ accessToken: row.access, refreshToken: row.refresh, expiresAt: row.exp })
    },
    ...selectedRepoMethods(stmts),
    close() {
      db.close()
      return Promise.resolve()
    },
  }
}
