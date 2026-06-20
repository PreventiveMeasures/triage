// Managed-server store: the user-identity + session tables backing GitHub
// auth, the `selected_repo` table (repositories an admin/manage user chose for
// the workspace to operate on), and the `managed_report` table (reports
// uploaded via the "Manage reports" page; the bytes live in the report-store,
// this row holds the metadata + attribution). The `ManagedDb` interface is
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
import type { TeamUserPermissions } from '../common/managed/permissions.ts'

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

-- Bundles uploaded to the server (the "Manage bundles" page). Like reports, the
-- bytes are stored in the clear (blob-store, keyed by this opaque uuid id) for
-- the server to operate on. integrity is the content hash (sha512-<base64>,
-- byte-identical to the client's) so re-uploading the same bytes dedupes (UNIQUE);
-- it is also the key a report's bundleHashes match to auto-link.
-- uploaded_by / repo_id are the (nullable) user + repo links, both nulled (not
-- cascaded) when the referenced user / selected repo goes away.
CREATE TABLE IF NOT EXISTS managed_bundle (
  id           TEXT PRIMARY KEY,
  integrity    TEXT NOT NULL UNIQUE,
  filename     TEXT NOT NULL,
  kind         TEXT,
  byte_size    INTEGER NOT NULL,
  uploaded_by  TEXT REFERENCES managed_user(id) ON DELETE SET NULL,
  repo_id      INTEGER REFERENCES selected_repo(repo_id) ON DELETE SET NULL,
  uploaded_at  INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS managed_bundle_uploaded_at_idx ON managed_bundle(uploaded_at);

-- Reports uploaded to the server (the "Manage reports" page). A managed server
-- is TRUSTED, so the bytes are stored in the clear (blob-store, keyed by this
-- opaque uuid id) for the server to operate on later; this row carries the
-- metadata + attribution. uploaded_by / repo_id are the (nullable) user + repo
-- links, nulled (not cascaded) when the user / selected repo goes away. bundle_id
-- is the (nullable) auto-resolved link to a stored bundle; bundle_integrity is
-- the report's declared primary bundle (from its bundleHashes), kept so a later
-- bundle upload of that integrity can re-link.
CREATE TABLE IF NOT EXISTS managed_report (
  id               TEXT PRIMARY KEY,
  filename         TEXT NOT NULL,
  content_type     TEXT NOT NULL,
  byte_size        INTEGER NOT NULL,
  sha256           TEXT NOT NULL,
  uploaded_by      TEXT REFERENCES managed_user(id) ON DELETE SET NULL,
  repo_id          INTEGER REFERENCES selected_repo(repo_id) ON DELETE SET NULL,
  bundle_id        TEXT REFERENCES managed_bundle(id) ON DELETE SET NULL,
  bundle_integrity TEXT,
  uploaded_at      INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS managed_report_uploaded_at_idx ON managed_report(uploaded_at);
CREATE INDEX IF NOT EXISTS managed_report_bundle_integrity_idx ON managed_report(bundle_integrity);

-- Teams group users + repos for access scoping. A team has just a name here;
-- the two link tables below carry the many-many relations.
CREATE TABLE IF NOT EXISTS managed_team (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
) STRICT;

-- Team <-> repo, many-many, with an OPTIONAL path (a subpath of the repo the
-- team is scoped to; NULL = the whole repo). Keyed by (team, repo) so a team
-- links a given repo once; CASCADE so the link dies with either side. repo_id
-- references the selected (operate-on) repos.
CREATE TABLE IF NOT EXISTS team_repo (
  team_id  TEXT NOT NULL REFERENCES managed_team(id) ON DELETE CASCADE,
  repo_id  INTEGER NOT NULL REFERENCES selected_repo(repo_id) ON DELETE CASCADE,
  path     TEXT,
  PRIMARY KEY (team_id, repo_id)
) STRICT;

CREATE INDEX IF NOT EXISTS team_repo_repo_idx ON team_repo(repo_id);

-- Team <-> user, many-many, with per-membership visibility permissions (see
-- common/managed/permissions.ts) — view_dependencies / view_security, both
-- default 0 (off). CASCADE so the membership dies with either side.
CREATE TABLE IF NOT EXISTS team_user (
  team_id           TEXT NOT NULL REFERENCES managed_team(id) ON DELETE CASCADE,
  user_id           TEXT NOT NULL REFERENCES managed_user(id) ON DELETE CASCADE,
  view_dependencies INTEGER NOT NULL DEFAULT 0,
  view_security     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (team_id, user_id)
) STRICT;

CREATE INDEX IF NOT EXISTS team_user_user_idx ON team_user(user_id);
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

// A stored report's metadata. The bytes live in the blob-store keyed by `id`;
// `contentType` + `filename` ride here so a download can label them, `sha256`
// (base64url) is the content hash for integrity, `uploadedBy` is the opaque
// uploader id (null once that user is removed).
export interface ReportRecord {
  id: string
  filename: string
  contentType: string
  byteSize: number
  sha256: string
  uploadedBy: string | null
  uploadedAt: number
}

// What the upload handler supplies to record a report; the store stamps
// uploaded_at. `repoId` / `bundleId` are the (nullable) repo + auto-resolved
// bundle links; `bundleIntegrity` is the report's declared primary bundle (kept
// so a later bundle upload of that integrity re-links it).
export interface ReportRecordInput {
  id: string
  filename: string
  contentType: string
  byteSize: number
  sha256: string
  uploadedBy: string | null
  repoId: number | null
  bundleId: string | null
  bundleIntegrity: string | null
}

// A report row for the "Manage reports" list — adds display joins: uploader
// login, repo full name, and the linked bundle's filename (each null when
// absent / since removed).
export interface AdminReport {
  id: string
  filename: string
  contentType: string
  byteSize: number
  sha256: string
  uploadedByLogin: string | null
  repoId: number | null
  repoFullName: string | null
  bundleId: string | null
  bundleFilename: string | null
  bundleIntegrity: string | null
  uploadedAt: number
}

// A stored bundle's metadata. Bytes live in the blob-store keyed by `id`;
// `integrity` (sha512-<base64>) is the content-addressed identity (UNIQUE),
// matched against a report's bundleHashes to auto-link.
export interface ManagedBundle {
  id: string
  integrity: string
  filename: string
  kind: string | null
  byteSize: number
  uploadedBy: string | null
  repoId: number | null
  uploadedAt: number
}

// What the upload handler supplies to record a bundle; the store stamps
// uploaded_at.
export type BundleInput = Omit<ManagedBundle, 'uploadedAt'>

// A bundle row for the "Manage bundles" list — adds the uploader login + repo
// full name display joins (null when absent / since removed).
export interface AdminBundle {
  id: string
  integrity: string
  filename: string
  kind: string | null
  byteSize: number
  uploadedByLogin: string | null
  repoId: number | null
  repoFullName: string | null
  uploadedAt: number
}

// A team's repo link (with its optional subpath) and member (with resolved
// login + visibility permissions), as carried in the AdminTeam detail.
export interface TeamRepoLink {
  repoId: number
  fullName: string
  path: string | null
}
export interface TeamMember extends TeamUserPermissions {
  userId: string
  login: string
}

// A team with its links inlined, for the "Manage teams" page.
export interface AdminTeam {
  id: string
  name: string
  repos: TeamRepoLink[]
  members: TeamMember[]
}

// A user id + login, for the team-member picker (lighter than the admin users
// list, and usable by manage — not just admin). A `type` (not interface) so a
// SQLite row casts straight to it.
export type UserOption = {
  id: string
  login: string
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
  // Reports ("Manage reports"). insertReport records an uploaded report's
  // metadata (bytes are written to the blob-store separately); listReports joins
  // the uploader login + repo + linked-bundle filename for the admin list;
  // getReport reads one row (for download); deleteReport resolves true iff a row
  // was removed.
  insertReport(report: ReportRecordInput, now: number): Promise<void>
  listReports(): Promise<AdminReport[]>
  getReport(id: string): Promise<ReportRecord | null>
  deleteReport(id: string): Promise<boolean>
  // Attach / detach a report's repo link (repoId null = detach); resolves true
  // iff the report exists. The caller validates repoId is a selected repo.
  setReportRepo(id: string, repoId: number | null): Promise<boolean>
  // Bundles ("Manage bundles"). insertBundle records an uploaded bundle (bytes
  // in the blob-store); getBundleByIntegrity dedupes uploads + resolves a
  // report's bundleHashes; getBundle reads one row (download); listBundles joins
  // uploader login + repo; deleteBundle resolves true iff a row was removed
  // (referencing reports' bundle_id null out via the FK). linkReportsToBundle
  // attaches a freshly-stored bundle to the (still-unlinked) reports that
  // declared its integrity.
  insertBundle(bundle: BundleInput, now: number): Promise<void>
  getBundleByIntegrity(integrity: string): Promise<ManagedBundle | null>
  getBundle(id: string): Promise<ManagedBundle | null>
  listBundles(): Promise<AdminBundle[]>
  deleteBundle(id: string): Promise<boolean>
  // Attach / detach a bundle's repo link (repoId null = detach); resolves true
  // iff the bundle exists. The caller validates repoId is a selected repo.
  setBundleRepo(id: string, repoId: number | null): Promise<boolean>
  linkReportsToBundle(integrity: string, bundleId: string): Promise<void>
  // Teams ("Manage teams"). createTeam inserts a team (false iff the name is
  // taken); renameTeam changes a team's name ('name-taken' iff another team
  // already has it, 'not-found' iff no such team, 'ok' otherwise — same name is
  // idempotent); deleteTeam drops it (cascading its links); listTeams returns
  // every team with its repos + members inlined; listUserOptions is the id+login
  // set for the member picker. The set*/remove* pairs maintain the link tables:
  // setTeamRepo upserts a repo link + its optional path, setTeamMember upserts a
  // membership + its visibility permissions (each resolves true iff a row was
  // written / removed; the caller validates the team/repo/user exist first).
  createTeam(id: string, name: string, now: number): Promise<boolean>
  renameTeam(id: string, name: string, now: number): Promise<'ok' | 'name-taken' | 'not-found'>
  deleteTeam(id: string): Promise<boolean>
  getTeam(id: string): Promise<{ id: string; name: string } | null>
  listTeams(): Promise<AdminTeam[]>
  listUserOptions(): Promise<UserOption[]>
  // The teams a given user belongs to (id + name, name-sorted) — for that user's
  // own sidebar Teams section. Any user; only their own memberships.
  listTeamsForUser(userId: string): Promise<{ id: string; name: string }[]>
  setTeamRepo(teamId: string, repoId: number, path: string | null): Promise<void>
  removeTeamRepo(teamId: string, repoId: number): Promise<boolean>
  setTeamMember(teamId: string, userId: string, perms: TeamUserPermissions): Promise<void>
  removeTeamMember(teamId: string, userId: string): Promise<boolean>
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
    insertReportStmt: db.prepare(
      `INSERT INTO managed_report (id, filename, content_type, byte_size, sha256, uploaded_by, repo_id, bundle_id, bundle_integrity, uploaded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    // LEFT JOINs so a report whose uploader / repo / bundle was removed (the FK
    // nulled) still lists, with null display fields.
    selectReportsStmt: db.prepare(
      `SELECT r.id AS id, r.filename AS filename, r.content_type AS contentType,
              r.byte_size AS byteSize, r.sha256 AS sha256, u.login AS uploadedByLogin,
              r.repo_id AS repoId, sr.full_name AS repoFullName,
              r.bundle_id AS bundleId, b.filename AS bundleFilename, r.bundle_integrity AS bundleIntegrity,
              r.uploaded_at AS uploadedAt
         FROM managed_report r
         LEFT JOIN managed_user u ON u.id = r.uploaded_by
         LEFT JOIN selected_repo sr ON sr.repo_id = r.repo_id
         LEFT JOIN managed_bundle b ON b.id = r.bundle_id
        ORDER BY r.uploaded_at DESC, r.filename ASC`,
    ),
    selectReportStmt: db.prepare(
      `SELECT id, filename, content_type AS contentType, byte_size AS byteSize,
              sha256, uploaded_by AS uploadedBy, uploaded_at AS uploadedAt
         FROM managed_report WHERE id = ?`,
    ),
    deleteReportStmt: db.prepare(`DELETE FROM managed_report WHERE id = ?`),
    setReportRepoStmt: db.prepare(`UPDATE managed_report SET repo_id = ? WHERE id = ?`),
    insertBundleStmt: db.prepare(
      `INSERT INTO managed_bundle (id, integrity, filename, kind, byte_size, uploaded_by, repo_id, uploaded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    selectBundleByIntegrityStmt: db.prepare(
      `SELECT id, integrity, filename, kind, byte_size AS byteSize,
              uploaded_by AS uploadedBy, repo_id AS repoId, uploaded_at AS uploadedAt
         FROM managed_bundle WHERE integrity = ?`,
    ),
    selectBundleStmt: db.prepare(
      `SELECT id, integrity, filename, kind, byte_size AS byteSize,
              uploaded_by AS uploadedBy, repo_id AS repoId, uploaded_at AS uploadedAt
         FROM managed_bundle WHERE id = ?`,
    ),
    selectBundlesStmt: db.prepare(
      `SELECT b.id AS id, b.integrity AS integrity, b.filename AS filename, b.kind AS kind,
              b.byte_size AS byteSize, u.login AS uploadedByLogin,
              b.repo_id AS repoId, sr.full_name AS repoFullName, b.uploaded_at AS uploadedAt
         FROM managed_bundle b
         LEFT JOIN managed_user u ON u.id = b.uploaded_by
         LEFT JOIN selected_repo sr ON sr.repo_id = b.repo_id
        ORDER BY b.uploaded_at DESC, b.filename ASC`,
    ),
    deleteBundleStmt: db.prepare(`DELETE FROM managed_bundle WHERE id = ?`),
    setBundleRepoStmt: db.prepare(`UPDATE managed_bundle SET repo_id = ? WHERE id = ?`),
    // Attach a freshly-stored bundle to the reports that declared its integrity
    // but haven't been linked yet (bundle uploaded after the report).
    linkReportsToBundleStmt: db.prepare(
      `UPDATE managed_report SET bundle_id = ? WHERE bundle_integrity = ? AND bundle_id IS NULL`,
    ),
    // OR IGNORE: a duplicate name (UNIQUE) is the "taken" signal (0 changes); the
    // uuid PK never collides.
    insertTeamStmt: db.prepare(`INSERT OR IGNORE INTO managed_team (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`),
    deleteTeamStmt: db.prepare(`DELETE FROM managed_team WHERE id = ?`),
    selectTeamStmt: db.prepare(`SELECT id, name FROM managed_team WHERE id = ?`),
    selectTeamByNameStmt: db.prepare(`SELECT id FROM managed_team WHERE name = ?`),
    renameTeamStmt: db.prepare(`UPDATE managed_team SET name = ?, updated_at = ? WHERE id = ?`),
    selectTeamsStmt: db.prepare(`SELECT id, name FROM managed_team ORDER BY name ASC`),
    selectTeamsForUserStmt: db.prepare(
      `SELECT t.id AS id, t.name AS name
         FROM team_user tu JOIN managed_team t ON t.id = tu.team_id
        WHERE tu.user_id = ? ORDER BY t.name ASC`,
    ),
    selectUserOptionsStmt: db.prepare(`SELECT id, login FROM managed_user ORDER BY login ASC`),
    selectTeamReposStmt: db.prepare(
      `SELECT tr.team_id AS teamId, tr.repo_id AS repoId, sr.full_name AS fullName, tr.path AS path
         FROM team_repo tr JOIN selected_repo sr ON sr.repo_id = tr.repo_id
        ORDER BY sr.full_name ASC`,
    ),
    selectTeamMembersStmt: db.prepare(
      `SELECT tu.team_id AS teamId, tu.user_id AS userId, u.login AS login,
              tu.view_dependencies AS viewDependencies, tu.view_security AS viewSecurity
         FROM team_user tu JOIN managed_user u ON u.id = tu.user_id
        ORDER BY u.login ASC`,
    ),
    upsertTeamRepoStmt: db.prepare(
      `INSERT INTO team_repo (team_id, repo_id, path) VALUES (?, ?, ?)
       ON CONFLICT(team_id, repo_id) DO UPDATE SET path = excluded.path`,
    ),
    deleteTeamRepoStmt: db.prepare(`DELETE FROM team_repo WHERE team_id = ? AND repo_id = ?`),
    upsertTeamMemberStmt: db.prepare(
      `INSERT INTO team_user (team_id, user_id, view_dependencies, view_security) VALUES (?, ?, ?, ?)
       ON CONFLICT(team_id, user_id) DO UPDATE SET
         view_dependencies = excluded.view_dependencies, view_security = excluded.view_security`,
    ),
    deleteTeamMemberStmt: db.prepare(`DELETE FROM team_user WHERE team_id = ? AND user_id = ?`),
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

type ReportListRow = {
  id: string; filename: string; contentType: string; byteSize: number
  sha256: string; uploadedByLogin: string | null
  repoId: number | null; repoFullName: string | null
  bundleId: string | null; bundleFilename: string | null; bundleIntegrity: string | null
  uploadedAt: number
}
type ReportRow = {
  id: string; filename: string; contentType: string; byteSize: number
  sha256: string; uploadedBy: string | null; uploadedAt: number
}

// The report slice of ManagedDb, split out (like selectedRepoMethods) to keep
// openSqliteManagedDb small. Closes over its prepared statements.
function reportMethods(stmts: ReturnType<typeof prepareStatements>) {
  const { insertReportStmt, selectReportsStmt, selectReportStmt, deleteReportStmt, setReportRepoStmt } = stmts
  return {
    insertReport(report: ReportRecordInput, now: number): Promise<void> {
      insertReportStmt.run(
        report.id, report.filename, report.contentType, report.byteSize,
        report.sha256, report.uploadedBy, report.repoId, report.bundleId,
        report.bundleIntegrity, now,
      )
      return Promise.resolve()
    },
    listReports(): Promise<AdminReport[]> {
      const rows = selectReportsStmt.all() as ReportListRow[]
      return Promise.resolve(rows.map((r) => ({
        id: r.id, filename: r.filename, contentType: r.contentType, byteSize: r.byteSize,
        sha256: r.sha256, uploadedByLogin: r.uploadedByLogin,
        repoId: r.repoId, repoFullName: r.repoFullName,
        bundleId: r.bundleId, bundleFilename: r.bundleFilename, bundleIntegrity: r.bundleIntegrity,
        uploadedAt: r.uploadedAt,
      })))
    },
    getReport(id: string): Promise<ReportRecord | null> {
      const row = selectReportStmt.get(id) as ReportRow | undefined
      if (row == null) return Promise.resolve(null)
      return Promise.resolve({
        id: row.id, filename: row.filename, contentType: row.contentType, byteSize: row.byteSize,
        sha256: row.sha256, uploadedBy: row.uploadedBy, uploadedAt: row.uploadedAt,
      })
    },
    deleteReport(id: string): Promise<boolean> {
      return Promise.resolve(Number(deleteReportStmt.run(id).changes) > 0)
    },
    setReportRepo(id: string, repoId: number | null): Promise<boolean> {
      return Promise.resolve(Number(setReportRepoStmt.run(repoId, id).changes) > 0)
    },
  }
}

type BundleRow = {
  id: string; integrity: string; filename: string; kind: string | null; byteSize: number
  uploadedBy: string | null; repoId: number | null; uploadedAt: number
}
type BundleListRow = {
  id: string; integrity: string; filename: string; kind: string | null; byteSize: number
  uploadedByLogin: string | null; repoId: number | null; repoFullName: string | null; uploadedAt: number
}

function mapBundle(r: BundleRow): ManagedBundle {
  return {
    id: r.id, integrity: r.integrity, filename: r.filename, kind: r.kind,
    byteSize: r.byteSize, uploadedBy: r.uploadedBy, repoId: r.repoId, uploadedAt: r.uploadedAt,
  }
}

// The bundle slice of ManagedDb. Closes over its prepared statements.
function bundleMethods(stmts: ReturnType<typeof prepareStatements>) {
  const {
    insertBundleStmt, selectBundleByIntegrityStmt, selectBundleStmt,
    selectBundlesStmt, deleteBundleStmt, setBundleRepoStmt, linkReportsToBundleStmt,
  } = stmts
  return {
    insertBundle(bundle: BundleInput, now: number): Promise<void> {
      insertBundleStmt.run(
        bundle.id, bundle.integrity, bundle.filename, bundle.kind,
        bundle.byteSize, bundle.uploadedBy, bundle.repoId, now,
      )
      return Promise.resolve()
    },
    getBundleByIntegrity(integrity: string): Promise<ManagedBundle | null> {
      const row = selectBundleByIntegrityStmt.get(integrity) as BundleRow | undefined
      return Promise.resolve(row == null ? null : mapBundle(row))
    },
    getBundle(id: string): Promise<ManagedBundle | null> {
      const row = selectBundleStmt.get(id) as BundleRow | undefined
      return Promise.resolve(row == null ? null : mapBundle(row))
    },
    listBundles(): Promise<AdminBundle[]> {
      const rows = selectBundlesStmt.all() as BundleListRow[]
      return Promise.resolve(rows.map((r) => ({
        id: r.id, integrity: r.integrity, filename: r.filename, kind: r.kind, byteSize: r.byteSize,
        uploadedByLogin: r.uploadedByLogin, repoId: r.repoId, repoFullName: r.repoFullName,
        uploadedAt: r.uploadedAt,
      })))
    },
    deleteBundle(id: string): Promise<boolean> {
      return Promise.resolve(Number(deleteBundleStmt.run(id).changes) > 0)
    },
    setBundleRepo(id: string, repoId: number | null): Promise<boolean> {
      return Promise.resolve(Number(setBundleRepoStmt.run(repoId, id).changes) > 0)
    },
    linkReportsToBundle(integrity: string, bundleId: string): Promise<void> {
      linkReportsToBundleStmt.run(bundleId, integrity)
      return Promise.resolve()
    },
  }
}

type TeamRow = { id: string; name: string }
type TeamRepoRow = { teamId: string; repoId: number; fullName: string; path: string | null }
type TeamMemberRow = { teamId: string; userId: string; login: string; viewDependencies: number; viewSecurity: number }

// The team slice of ManagedDb. listTeams reads the three tables in full and
// groups in JS (3 queries, not N+1) — fine for the handful of teams a managed
// workspace has.
function teamMethods(stmts: ReturnType<typeof prepareStatements>) {
  const {
    insertTeamStmt, selectTeamByNameStmt, renameTeamStmt, deleteTeamStmt, selectTeamStmt,
    selectTeamsStmt, selectTeamsForUserStmt, selectUserOptionsStmt, selectTeamReposStmt,
    selectTeamMembersStmt, upsertTeamRepoStmt, deleteTeamRepoStmt, upsertTeamMemberStmt,
    deleteTeamMemberStmt,
  } = stmts
  return {
    createTeam(id: string, name: string, now: number): Promise<boolean> {
      return Promise.resolve(Number(insertTeamStmt.run(id, name, now, now).changes) > 0)
    },
    renameTeam(id: string, name: string, now: number): Promise<'ok' | 'name-taken' | 'not-found'> {
      // The driver is synchronous, so these reads + the update run with no await
      // between them — the existence + name-clash checks can't race a concurrent
      // rename, and we get to distinguish 404 (no team) from 409 (name taken).
      if (selectTeamStmt.get(id) == null) return Promise.resolve('not-found')
      const clash = selectTeamByNameStmt.get(name) as { id: string } | undefined
      if (clash != null && clash.id !== id) return Promise.resolve('name-taken')
      renameTeamStmt.run(name, now, id)
      return Promise.resolve('ok')
    },
    deleteTeam(id: string): Promise<boolean> {
      return Promise.resolve(Number(deleteTeamStmt.run(id).changes) > 0)
    },
    getTeam(id: string): Promise<{ id: string; name: string } | null> {
      const row = selectTeamStmt.get(id) as TeamRow | undefined
      return Promise.resolve(row == null ? null : { id: row.id, name: row.name })
    },
    listUserOptions(): Promise<UserOption[]> {
      return Promise.resolve((selectUserOptionsStmt.all() as UserOption[]).map((u) => ({ id: u.id, login: u.login })))
    },
    listTeamsForUser(userId: string): Promise<{ id: string; name: string }[]> {
      return Promise.resolve(selectTeamsForUserStmt.all(userId) as { id: string; name: string }[])
    },
    listTeams(): Promise<AdminTeam[]> {
      const teams = selectTeamsStmt.all() as TeamRow[]
      const reposByTeam = new Map<string, TeamRepoLink[]>()
      for (const r of selectTeamReposStmt.all() as TeamRepoRow[]) {
        const list = reposByTeam.get(r.teamId) ?? []
        list.push({ repoId: r.repoId, fullName: r.fullName, path: r.path })
        reposByTeam.set(r.teamId, list)
      }
      const membersByTeam = new Map<string, TeamMember[]>()
      for (const m of selectTeamMembersStmt.all() as TeamMemberRow[]) {
        const list = membersByTeam.get(m.teamId) ?? []
        list.push({ userId: m.userId, login: m.login, dependencies: m.viewDependencies === 1, security: m.viewSecurity === 1 })
        membersByTeam.set(m.teamId, list)
      }
      return Promise.resolve(teams.map((t) => ({
        id: t.id, name: t.name,
        repos: reposByTeam.get(t.id) ?? [],
        members: membersByTeam.get(t.id) ?? [],
      })))
    },
    setTeamRepo(teamId: string, repoId: number, path: string | null): Promise<void> {
      upsertTeamRepoStmt.run(teamId, repoId, path)
      return Promise.resolve()
    },
    removeTeamRepo(teamId: string, repoId: number): Promise<boolean> {
      return Promise.resolve(Number(deleteTeamRepoStmt.run(teamId, repoId).changes) > 0)
    },
    setTeamMember(teamId: string, userId: string, perms: TeamUserPermissions): Promise<void> {
      upsertTeamMemberStmt.run(teamId, userId, perms.dependencies ? 1 : 0, perms.security ? 1 : 0)
      return Promise.resolve()
    },
    removeTeamMember(teamId: string, userId: string): Promise<boolean> {
      return Promise.resolve(Number(deleteTeamMemberStmt.run(teamId, userId).changes) > 0)
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
    ...reportMethods(stmts),
    ...bundleMethods(stmts),
    ...teamMethods(stmts),
    close() {
      db.close()
      return Promise.resolve()
    },
  }
}
