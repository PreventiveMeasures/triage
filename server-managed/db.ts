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
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Role } from '../common/managed/roles.ts'
import type { TeamUserPermissions } from '../common/managed/permissions.ts'
import type { TriageEntryPatch } from '../common/managed/triage.ts'
import { migrateSlugs, preferredSlug } from './slugs.ts'
import { type CommentStore, commentMethods } from './comments.ts'
import { migrateReportLocations } from './report-migration.ts'
import { type ActivityStore, activityMethods } from './activity.ts'

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
  updated_at     INTEGER NOT NULL,
  -- Presence is independent of admin edits and background token refreshes.
  -- NULL for legacy accounts until a known session authenticates them.
  last_seen_at   INTEGER
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
  updated_at      INTEGER NOT NULL,
  active          INTEGER NOT NULL DEFAULT 1
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
  -- Durable snapshot of the uploader's login at upload time, so "who uploaded
  -- this" survives the uploader being removed (when uploaded_by nulls out).
  uploaded_by_login TEXT,
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
  slug             TEXT NOT NULL,
  filename         TEXT NOT NULL,
  content_type     TEXT NOT NULL,
  byte_size        INTEGER NOT NULL,
  sha256           TEXT NOT NULL,
  uploaded_by      TEXT REFERENCES managed_user(id) ON DELETE SET NULL,
  -- Durable snapshot of the uploader's login (see managed_bundle).
  uploaded_by_login TEXT,
  repo_id          INTEGER REFERENCES selected_repo(repo_id) ON DELETE SET NULL,
  repo_directory   TEXT NOT NULL DEFAULT '',
  repo_embedded    INTEGER NOT NULL DEFAULT 0,
  analyzer         TEXT,
  visible          INTEGER NOT NULL DEFAULT 0,
  bundle_id        TEXT REFERENCES managed_bundle(id) ON DELETE SET NULL,
  bundle_integrity TEXT,
  uploaded_at      INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS managed_report_uploaded_at_idx ON managed_report(uploaded_at);
CREATE INDEX IF NOT EXISTS managed_report_bundle_integrity_idx ON managed_report(bundle_integrity);

-- Per-finding triage annotations — the managed (trusted-plaintext) counterpart
-- of the client's localStorage triage map, keyed the same way: by finding id
-- alone, not by report. Reports mostly repeat one another (a re-scan of the
-- same code carries the same finding ids) and a finding's triage is shared by
-- every report that carries it; which ids a viewer may read or write is
-- decided per report at the endpoint, not here. The wire shape lives in
-- common/managed/triage.ts. Whole-entry replace, NULL columns are unset;
-- flagged is tri-state: NULL unset / 1 flagged / 0 an explicit un-flag
-- tombstone. A cleared entry keeps its row with every field NULL — a
-- tombstone a reader adopts as "cleared", where a missing row means "never
-- annotated" (so a stale client copy can't resurrect a teammate's clear).
-- updated_by is the last writer (nulled when that user is removed);
-- updated_by_login is the durable login snapshot (see managed_bundle).
CREATE TABLE IF NOT EXISTS finding_triage (
  finding_id       TEXT PRIMARY KEY,
  color            TEXT,
  triage           TEXT,
  comment          TEXT,
  fix              TEXT,
  flagged          INTEGER,
  updated_by       TEXT REFERENCES managed_user(id) ON DELETE SET NULL,
  updated_by_login TEXT,
  updated_at       INTEGER NOT NULL
) STRICT;

-- The trail behind finding_triage: one row per write that CHANGED an entry,
-- holding the entry as written (every field NULL = a clear), who wrote it and
-- when. finding_triage stays the current-state projection reads hit; this is
-- walked only for a finding's history. The wire is whole-entry replace, so a
-- snapshot per write is exactly what arrived and "what changed" is the diff
-- against the previous row for the same id, computed on read. batch_id groups
-- the rows of one request. seq is the rowid: a total order that breaks ties
-- on at. actor_id / actor_login follow the uploaded_by / uploaded_by_login
-- convention (live account, durable login snapshot). Everything is kept by
-- default — the trail is the record; an operator may bound it per finding
-- (TRIAGE_HISTORY_LIMIT), in which case a finding's older events are trimmed
-- as new ones land. An id no report carries any more is the tombstone GC's
-- concern.
CREATE TABLE IF NOT EXISTS finding_triage_event (
  seq          INTEGER PRIMARY KEY,
  finding_id   TEXT NOT NULL,
  batch_id     TEXT NOT NULL,
  color        TEXT,
  triage       TEXT,
  comment      TEXT,
  fix          TEXT,
  flagged      INTEGER,
  actor_id     TEXT REFERENCES managed_user(id) ON DELETE SET NULL,
  actor_login  TEXT,
  at           INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS finding_triage_event_finding_idx ON finding_triage_event(finding_id, seq);
CREATE INDEX IF NOT EXISTS finding_triage_event_actor_at_idx ON finding_triage_event(actor_id, at);

-- Teams group users + repos for access scoping. A team has just a name here;
-- the two link tables below carry the many-many relations.
CREATE TABLE IF NOT EXISTS managed_team (
  id          TEXT PRIMARY KEY,
  slug        TEXT NOT NULL,
  name        TEXT NOT NULL UNIQUE,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
) STRICT;

-- Team <-> repo, many-many, with an OPTIONAL path (a subpath of the repo the
-- team is scoped to; empty path = the whole repo). Distinct paths can coexist;
-- adding the whole repo replaces them. CASCADE removes links with either side. repo_id
-- references the selected (operate-on) repos.
CREATE TABLE IF NOT EXISTS team_repo (
  team_id  TEXT NOT NULL REFERENCES managed_team(id) ON DELETE CASCADE,
  repo_id  INTEGER NOT NULL REFERENCES selected_repo(repo_id) ON DELETE CASCADE,
  path     TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (team_id, repo_id, path)
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
  lastSeenAt: number | null
  lastActivityAt: number | null
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

// The admin repository directory includes inactive connections as well. Their
// metadata remains available for existing reports/bundles, while only active
// rows are returned by listSelectedRepos for new scans and attachments.
export interface ManagedRepo extends SelectedRepo {
  active: boolean
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
  slug: string
  filename: string
  contentType: string
  byteSize: number
  sha256: string
  uploadedBy: string | null
  uploadedAt: number
  repoId: number | null
  repoDirectory: string
  repoEmbedded: boolean
  analyzer: string | null
  visible: boolean
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
  uploadedByLogin: string | null
  repoId: number | null
  repoDirectory: string
  repoEmbedded?: boolean
  analyzer: string | null
  visible: boolean
  bundleId: string | null
  bundleIntegrity: string | null
}

// A report row for the "Manage reports" list — adds display joins: uploader
// login, repo full name, and the linked bundle's filename (each null when
// absent / since removed).
export interface AdminReport {
  id: string
  slug: string
  filename: string
  contentType: string
  byteSize: number
  sha256: string
  uploadedByLogin: string | null
  repoId: number | null
  repoFullName: string | null
  repoDirectory: string
  repoEmbedded: boolean
  analyzer: string | null
  visible: boolean
  bundleId: string | null
  bundleFilename: string | null
  bundleIntegrity: string | null
  uploadedAt: number
}

export interface RepoDataItem {
  id: string
  filename: string
}

// A stored per-finding triage row, with the last writer's login resolved like
// listReports (live login, falling back to the durable snapshot). `flagged`
// maps the tri-state column: null unset, true/false set. Every field null =
// the tombstone of a cleared entry.
export interface TriageRow {
  findingId: string
  color: string | null
  triage: string | null
  comment: string | null
  fix: string | null
  flagged: boolean | null
  updatedByLogin: string | null
  updatedAt: number
}

// One row of a finding's triage trail: the entry as written by that event
// (every field null = a clear), the actor's login resolved like TriageRow's
// writer, and the request it came in with.
export interface TriageEventRow {
  seq: number
  findingId: string
  batchId: string
  color: string | null
  triage: string | null
  comment: string | null
  fix: string | null
  flagged: boolean | null
  actorLogin: string | null
  at: number
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
// uploaded_at. `uploadedByLogin` is the durable uploader-login snapshot.
export type BundleInput = Omit<ManagedBundle, 'uploadedAt'> & { uploadedByLogin: string | null }

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
  slug: string
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
  name: string | null
}

// A team as shown in a member's own sidebar: the team name plus the reports and
// bundles attached to the team's repos (id + filename, newest first). An item
// shows under a team when its repo is one of the team's linked repos.
export interface UserTeamReport {
  id: string
  slug: string
  filename: string
}
export interface UserTeamBundle {
  id: string
  filename: string
  repoFullName: string
}
export interface UserTeam {
  id: string
  slug: string
  name: string
  reports: UserTeamReport[]
  bundles: UserTeamBundle[]
}

// Backend-agnostic store surface (SQLite + PostgreSQL implementations).
export interface ManagedDb extends ActivityStore, CommentStore {
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
  listAllRepos(): Promise<ManagedRepo[]>
  deactivateRepo(repoId: number): Promise<boolean>
  reactivateRepo(repoId: number): Promise<boolean>
  deleteRepo(repoId: number): Promise<boolean>
  listReportsForRepo(repoId: number): Promise<RepoDataItem[]>
  listBundlesForRepo(repoId: number): Promise<RepoDataItem[]>
  deleteReportsForRepo(repoId: number): Promise<number>
  deleteBundlesForRepo(repoId: number): Promise<number>
  // Permanently delete current annotations AND their history atomically.
  // Returns the number of current rows removed (not the number of events).
  deleteTriage(findingIds: readonly string[]): Promise<number>
  // Reports ("Manage reports"). insertReport records an uploaded report's
  // metadata (bytes are written to the blob-store separately); listReports joins
  // the uploader login + repo + linked-bundle filename for the admin list;
  // getReport reads one row (for download); deleteReport resolves true iff a row
  // was removed.
  insertReport(report: ReportRecordInput, now: number): Promise<void>
  listReports(userId?: string): Promise<AdminReport[]>
  getReport(id: string): Promise<ReportRecord | null>
  deleteReport(id: string): Promise<boolean>
  // Attach / detach a report's repo + directory link (repoId null = detach);
  // resolves true iff the report exists. The caller validates repoId and the
  // directory path.
  setReportRepo(id: string, repoId: number | null, repoDirectory?: string): Promise<boolean>
  setReportVisible(id: string, visible: boolean): Promise<boolean>
  // Per-finding triage annotations, keyed by finding id alone (shared by every
  // report carrying the finding). listTriage reads the rows for a set of ids —
  // the endpoint passes a viewer's visible findings of one report; a cleared
  // entry comes back as a row with every field null (its tombstone).
  // setTriage replaces one row wholesale, stamping the writer — a null/empty
  // entry writes the tombstone rather than deleting; setTriageEntries does the
  // same for a batch in one transaction: it lands whole or not at all. A write
  // that leaves the entry as it is changes nothing — neither the row's writer
  // stamp nor the trail. Every change also appends to finding_triage_event;
  // listTriageHistory walks one finding's trail, newest first.
  listTriage(findingIds: readonly string[]): Promise<TriageRow[]>
  setTriage(findingId: string, entry: TriageEntryPatch | null, updatedBy: string | null, updatedByLogin: string | null, now: number): Promise<void>
  setTriageEntries(entries: readonly (readonly [string, TriageEntryPatch | null])[], updatedBy: string | null, updatedByLogin: string | null, now: number, reportId?: string): Promise<void>
  listTriageHistory(findingId: string, limit: number): Promise<TriageEventRow[]>
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
  listBundles(userId?: string): Promise<AdminBundle[]>
  userCanReadBundle(userId: string, id: string): Promise<boolean>
  userCanReadRepo(userId: string, repoId: number): Promise<boolean>
  userCanReadRepoPath(userId: string, repoId: number, directory: string): Promise<boolean>
  deleteBundle(id: string): Promise<boolean>
  // Attach / detach a bundle's repo link (repoId null = detach); resolves true
  // iff the bundle exists. The caller validates repoId is a selected repo.
  setBundleRepo(id: string, repoId: number | null): Promise<boolean>
  linkReportsToBundle(integrity: string, bundleId: string, userId?: string): Promise<void>
  // Teams ("Manage teams"). createTeam inserts a team (false iff the name is
  // taken); renameTeam changes a team's name ('name-taken' iff another team
  // already has it, 'not-found' iff no such team, 'ok' otherwise — same name is
  // idempotent); deleteTeam drops it (cascading its links); listTeams returns
  // every team with its repos + members inlined; listUserOptions is the id+login+name
  // set for the member picker. The set*/remove* pairs maintain the link tables:
  // setTeamRepo adds a path (whole repo replaces paths); setTeamMember upserts a
  // membership + its visibility permissions (each resolves true iff a row was
  // written / removed; the caller validates the team/repo/user exist first).
  createTeam(id: string, name: string, now: number): Promise<boolean>
  renameTeam(id: string, name: string, now: number): Promise<'ok' | 'name-taken' | 'not-found'>
  deleteTeam(id: string): Promise<boolean>
  getTeam(id: string): Promise<{ id: string; slug: string; name: string } | null>
  listTeams(): Promise<AdminTeam[]>
  listUserOptions(): Promise<UserOption[]>
  // Current grants for manager content reads, writes, and repository pickers.
  listRepoScopesForUser(userId: string): Promise<{ repoId: number; path: string | null }[]>
  // The teams a given user belongs to (name-sorted), each with reports and
  // bundles attached to that team's repos — for that user's own sidebar Teams section.
  // Any user; only their own memberships.
  listTeamsForUser(userId: string): Promise<UserTeam[]>
  // Whether `userId` may read `reportId`: true iff the report's repo belongs to
  // a team the user is a member of. Backs the team-scoped report view endpoint.
  userCanReadReport(userId: string, reportId: string): Promise<boolean>
  // The viewer's effective visibility permissions for a report, OR'd across the
  // teams (holding the report's repo) the user belongs to — drives the content
  // filter (a viewer without a permission has those findings stripped).
  reportPermissionsFor(userId: string, reportId: string): Promise<TeamUserPermissions>
  setTeamRepo(teamId: string, repoId: number, path: string | null): Promise<void>
  removeTeamRepo(teamId: string, repoId: number, path?: string | null): Promise<boolean>
  setTeamMember(teamId: string, userId: string, perms: TeamUserPermissions): Promise<void>
  removeTeamMember(teamId: string, userId: string): Promise<boolean>
  close(): Promise<void>
}

type SessionRow = {
  id: string; csrf: string; exp: number
  uid: string; login: string; name: string | null; avatar: string | null; role: Role
}

type UserRow = { id: string; login: string; name: string | null; role: Role; created: number; lastSeen: number | null; lastActivity: number | null }

// Shared by listing, access checks, and permission aggregation. A team sees
// reports rooted at its path or below it. Literal substring comparison keeps
// separators, case, and SQL wildcard characters significant.
const REPORT_IN_TEAM_PATH_SQL = `(tr.path IS NULL OR tr.path = ''
  OR r.repo_directory = tr.path
  OR substr(r.repo_directory, 1, length(tr.path) + 1) = tr.path || '/')`

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
      `SELECT u.id, u.login, u.name, u.role, u.created_at AS created, u.last_seen_at AS lastSeen,
              (SELECT MAX(at) FROM (
                SELECT MAX(e.at) AS at FROM finding_triage_event e WHERE e.actor_id = u.id
                UNION ALL SELECT MAX(a.at) AS at FROM managed_activity a WHERE a.actor_id = u.id
                UNION ALL SELECT MAX(c.at) AS at FROM finding_comment_event c WHERE c.actor_id = u.id
              )) AS lastActivity
         FROM managed_user u ORDER BY u.created_at ASC, u.login ASC`,
    ),
    touchUserSeenStmt: db.prepare(
      `UPDATE managed_user SET last_seen_at = ? WHERE id = ? AND (last_seen_at IS NULL OR last_seen_at < ?)`,
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
      `INSERT INTO selected_repo (repo_id, full_name, is_private, installation_id, default_branch, html_url, added_by, added_at, updated_at, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
       ON CONFLICT(repo_id) DO UPDATE SET
         full_name = excluded.full_name, is_private = excluded.is_private,
         installation_id = excluded.installation_id, default_branch = excluded.default_branch,
         html_url = excluded.html_url, updated_at = excluded.updated_at, active = 1`,
    ),
    deleteRepoStmt: db.prepare(`DELETE FROM selected_repo WHERE repo_id = ?`),
    deactivateRepoStmt: db.prepare(`UPDATE selected_repo SET active = 0 WHERE repo_id = ? AND active = 1`),
    reactivateRepoStmt: db.prepare(`UPDATE selected_repo SET active = 1 WHERE repo_id = ? AND active = 0`),
    selectReportsForRepoStmt: db.prepare(`SELECT id, filename FROM managed_report WHERE repo_id = ? ORDER BY filename ASC`),
    selectBundlesForRepoStmt: db.prepare(`SELECT id, filename FROM managed_bundle WHERE repo_id = ? ORDER BY filename ASC`),
    deleteReportsForRepoStmt: db.prepare(`DELETE FROM managed_report WHERE repo_id = ?`),
    deleteBundlesForRepoStmt: db.prepare(`DELETE FROM managed_bundle WHERE repo_id = ?`),
    deleteTriageStmt: db.prepare(`DELETE FROM finding_triage WHERE finding_id IN (SELECT value FROM json_each(?))`),
    deleteTriageHistoryStmt: db.prepare(`DELETE FROM finding_triage_event WHERE finding_id IN (SELECT value FROM json_each(?))`),
    deleteCommentsStmt: db.prepare(`DELETE FROM finding_comment WHERE finding_id IN (SELECT value FROM json_each(?))`),
    deleteCommentHistoryStmt: db.prepare(`DELETE FROM finding_comment_event WHERE finding_id IN (SELECT value FROM json_each(?))`),
    countAnnotationsStmt: db.prepare(`SELECT count(*) AS total FROM (
      SELECT finding_id FROM finding_triage WHERE finding_id IN (SELECT value FROM json_each(?))
      UNION SELECT finding_id FROM finding_comment WHERE finding_id IN (SELECT value FROM json_each(?))
      UNION SELECT finding_id FROM finding_comment_event WHERE finding_id IN (SELECT value FROM json_each(?)))`),
    selectReposStmt: db.prepare(
      `SELECT repo_id AS repoId, full_name AS fullName, is_private AS priv,
              installation_id AS installId, default_branch AS branch, html_url AS htmlUrl,
              added_by AS addedBy, added_at AS addedAt, active AS active
         FROM selected_repo WHERE active = 1 ORDER BY full_name ASC`,
    ),
    selectAllReposStmt: db.prepare(
      `SELECT repo_id AS repoId, full_name AS fullName, is_private AS priv,
              installation_id AS installId, default_branch AS branch, html_url AS htmlUrl,
              added_by AS addedBy, added_at AS addedAt, active AS active
         FROM selected_repo ORDER BY full_name ASC`,
    ),
    insertReportStmt: db.prepare(
      `WITH candidate(id, slug) AS (VALUES (?, ?))
       INSERT INTO managed_report (id, slug, filename, content_type, byte_size, sha256, uploaded_by, uploaded_by_login, repo_id, repo_directory, repo_embedded, analyzer, visible, bundle_id, bundle_integrity, uploaded_at)
       SELECT id, CASE WHEN EXISTS (SELECT 1 FROM managed_report WHERE slug = candidate.slug) THEN id ELSE slug END,
              ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM candidate`,
    ),
    // LEFT JOINs so a report whose uploader / repo / bundle was removed (the FK
    // nulled) still lists, with null display fields.
    selectReportsStmt: db.prepare(
      `SELECT r.id AS id, r.slug AS slug, r.filename AS filename, r.content_type AS contentType,
              r.byte_size AS byteSize, r.sha256 AS sha256, COALESCE(u.login, r.uploaded_by_login) AS uploadedByLogin,
              r.repo_id AS repoId, sr.full_name AS repoFullName,
              r.repo_directory AS repoDirectory, r.repo_embedded AS repoEmbedded,
              r.analyzer AS analyzer, r.visible AS visible,
              r.bundle_id AS bundleId, b.filename AS bundleFilename, r.bundle_integrity AS bundleIntegrity,
              r.uploaded_at AS uploadedAt
         FROM managed_report r
         LEFT JOIN managed_user u ON u.id = r.uploaded_by
         LEFT JOIN selected_repo sr ON sr.repo_id = r.repo_id
         LEFT JOIN managed_bundle b ON b.id = r.bundle_id
        WHERE (? IS NULL OR r.uploaded_by = ? OR EXISTS (
          SELECT 1 FROM team_repo tr JOIN team_user tu ON tu.team_id = tr.team_id
          WHERE tr.repo_id = r.repo_id AND tu.user_id = ? AND ${REPORT_IN_TEAM_PATH_SQL}))
        ORDER BY r.uploaded_at DESC, r.filename ASC`,
    ),
    selectReportStmt: db.prepare(
      `SELECT id, slug, filename, content_type AS contentType, byte_size AS byteSize,
              sha256, uploaded_by AS uploadedBy, uploaded_at AS uploadedAt,
              repo_id AS repoId, repo_directory AS repoDirectory, repo_embedded AS repoEmbedded,
              analyzer AS analyzer, visible AS visible
         FROM managed_report WHERE id = ?`,
    ),
    deleteReportStmt: db.prepare(`DELETE FROM managed_report WHERE id = ?`),
    setReportRepoStmt: db.prepare(`UPDATE managed_report SET repo_id = ?, repo_directory = ? WHERE id = ?`),
    setReportVisibleStmt: db.prepare(`UPDATE managed_report SET visible = ? WHERE id = ?`),
    upsertTriageStmt: db.prepare(
      `INSERT INTO finding_triage (finding_id, color, triage, comment, fix, flagged, updated_by, updated_by_login, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(finding_id) DO UPDATE SET
         color = excluded.color, triage = excluded.triage, comment = excluded.comment,
         fix = excluded.fix, flagged = excluded.flagged, updated_by = excluded.updated_by,
         updated_by_login = excluded.updated_by_login, updated_at = excluded.updated_at`,
    ),
    selectTriageStateStmt: db.prepare(
      `SELECT color, triage, comment, fix, flagged FROM finding_triage WHERE finding_id = ?`,
    ),
    insertTriageEventStmt: db.prepare(
      `INSERT INTO finding_triage_event (finding_id, batch_id, color, triage, comment, fix, flagged, actor_id, actor_login, at, report_id, report, repo)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
         (SELECT filename FROM managed_report WHERE id = ?),
         (SELECT p.full_name FROM managed_report r JOIN selected_repo p ON p.repo_id = r.repo_id WHERE r.id = ?))`,
    ),
    // With a retention limit set: keep the newest N events of a finding.
    trimTriageEventsStmt: db.prepare(
      `DELETE FROM finding_triage_event
        WHERE finding_id = ?
          AND seq NOT IN (SELECT seq FROM finding_triage_event WHERE finding_id = ? ORDER BY seq DESC LIMIT ?)`,
    ),
    selectTriageHistoryStmt: db.prepare(
      `SELECT e.seq AS seq, e.finding_id AS findingId, e.batch_id AS batchId, e.color AS color, e.triage AS triage,
              e.comment AS comment, e.fix AS fix, e.flagged AS flagged,
              COALESCE(u.login, e.actor_login) AS actorLogin, e.at AS at
         FROM finding_triage_event e
         LEFT JOIN managed_user u ON u.id = e.actor_id
        WHERE e.finding_id = ?
        ORDER BY e.seq DESC
        LIMIT ?`,
    ),
    // The ids arrive as one JSON array (json_each), so a report's worth of
    // them is one statement, not a chunked IN list. COALESCE the live login
    // over the durable snapshot, like selectReportsStmt.
    selectTriageStmt: db.prepare(
      `SELECT t.finding_id AS findingId, t.color AS color, t.triage AS triage,
              t.comment AS comment, t.fix AS fix, t.flagged AS flagged,
              COALESCE(u.login, t.updated_by_login) AS updatedByLogin, t.updated_at AS updatedAt
         FROM finding_triage t
         LEFT JOIN managed_user u ON u.id = t.updated_by
        WHERE t.finding_id IN (SELECT value FROM json_each(?))
        ORDER BY t.finding_id ASC`,
    ),
    insertBundleStmt: db.prepare(
      `INSERT INTO managed_bundle (id, integrity, filename, kind, byte_size, uploaded_by, uploaded_by_login, repo_id, uploaded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
              b.byte_size AS byteSize, COALESCE(u.login, b.uploaded_by_login) AS uploadedByLogin,
              b.repo_id AS repoId, sr.full_name AS repoFullName, b.uploaded_at AS uploadedAt
         FROM managed_bundle b
         LEFT JOIN managed_user u ON u.id = b.uploaded_by
         LEFT JOIN selected_repo sr ON sr.repo_id = b.repo_id
        WHERE (? IS NULL OR (b.uploaded_by = ? OR EXISTS (
          SELECT 1 FROM team_repo tr JOIN team_user tu ON tu.team_id = tr.team_id
          WHERE tr.repo_id = b.repo_id AND tu.user_id = ?)))
        ORDER BY b.uploaded_at DESC, b.filename ASC`,
    ),
    selectBundleReadableStmt: db.prepare(
      `SELECT 1 FROM managed_bundle b WHERE b.id = ? AND (b.uploaded_by = ? OR EXISTS (
          SELECT 1 FROM team_repo tr JOIN team_user tu ON tu.team_id = tr.team_id
          WHERE tr.repo_id = b.repo_id AND tu.user_id = ?))`,
    ),
    selectRepoReadableStmt: db.prepare(
      `SELECT 1 FROM team_repo tr JOIN team_user tu ON tu.team_id = tr.team_id
        WHERE tr.repo_id = ? AND tu.user_id = ? LIMIT 1`,
    ),
    selectRepoPathReadableStmt: db.prepare(
      `WITH r(repo_directory) AS (VALUES (?))
        SELECT 1 FROM r JOIN team_repo tr ON tr.repo_id = ? AND ${REPORT_IN_TEAM_PATH_SQL}
        JOIN team_user tu ON tu.team_id = tr.team_id WHERE tu.user_id = ? LIMIT 1`,
    ),
    deleteBundleStmt: db.prepare(`DELETE FROM managed_bundle WHERE id = ?`),
    setBundleRepoStmt: db.prepare(`UPDATE managed_bundle SET repo_id = ? WHERE id = ?`),
    // Attach a freshly-stored bundle to the reports that declared its integrity
    // but haven't been linked yet (bundle uploaded after the report).
    linkReportsToBundleStmt: db.prepare(
      `UPDATE managed_report AS r SET bundle_id = ? WHERE bundle_integrity = ? AND bundle_id IS NULL
       AND (? IS NULL OR r.uploaded_by = ? OR EXISTS (SELECT 1 FROM team_repo tr JOIN team_user tu ON tu.team_id = tr.team_id
         WHERE tu.user_id = ? AND tr.repo_id = r.repo_id AND ${REPORT_IN_TEAM_PATH_SQL}))`,
    ),
    // OR IGNORE: a duplicate name (UNIQUE) is the "taken" signal (0 changes); the
    // uuid PK never collides.
    insertTeamStmt: db.prepare(`WITH candidate(id, slug) AS (VALUES (?, ?))
      INSERT OR IGNORE INTO managed_team (id, slug, name, created_at, updated_at)
      SELECT id, CASE WHEN EXISTS (SELECT 1 FROM managed_team WHERE slug = candidate.slug) THEN id ELSE slug END,
             ?, ?, ? FROM candidate`),
    deleteTeamStmt: db.prepare(`DELETE FROM managed_team WHERE id = ?`),
    selectTeamStmt: db.prepare(`SELECT id, slug, name FROM managed_team WHERE id = ?`),
    selectTeamByNameStmt: db.prepare(`SELECT id FROM managed_team WHERE name = ?`),
    renameTeamStmt: db.prepare(`UPDATE managed_team SET name = ?, updated_at = ? WHERE id = ?`),
    selectTeamsStmt: db.prepare(`SELECT id, slug, name FROM managed_team ORDER BY name ASC`),
    selectTeamsForUserStmt: db.prepare(
      `SELECT t.id AS id, t.slug AS slug, t.name AS name
         FROM team_user tu JOIN managed_team t ON t.id = tu.team_id
        WHERE tu.user_id = ? ORDER BY t.name ASC`,
    ),
    // Reports attached to the repos of the user's teams, tagged by team (a report
    // shows under every team whose repo it's attached to). Newest first.
    selectUserTeamReportsStmt: db.prepare(
      `SELECT DISTINCT tr.team_id AS teamId, r.id AS id, r.slug AS slug, r.filename AS filename
         FROM team_user tu
         JOIN team_repo tr ON tr.team_id = tu.team_id
         JOIN managed_report r ON r.repo_id = tr.repo_id AND ${REPORT_IN_TEAM_PATH_SQL}
        WHERE tu.user_id = ? AND (r.visible = 1 OR (SELECT role FROM managed_user WHERE id = tu.user_id) = 'manage')
        ORDER BY r.uploaded_at DESC, r.filename ASC`,
    ),
    // Bundles are scoped through the same team -> repository links as reports.
    // They have no visibility flag: membership in a team that can see the repo
    // is the visibility decision for the bundle row in the sidebar.
    selectUserTeamBundlesStmt: db.prepare(
      `SELECT DISTINCT tr.team_id AS teamId, b.id AS id, b.filename AS filename, sr.full_name AS repoFullName
         FROM team_user tu
         JOIN team_repo tr ON tr.team_id = tu.team_id
         JOIN managed_bundle b ON b.repo_id = tr.repo_id
         JOIN selected_repo sr ON sr.repo_id = b.repo_id
        WHERE tu.user_id = ?
        ORDER BY b.uploaded_at DESC, b.filename ASC`,
    ),
    selectUserRepoScopesStmt: db.prepare(
      `SELECT DISTINCT tr.repo_id AS repoId, NULLIF(tr.path, '') AS path
         FROM team_repo tr JOIN team_user tu ON tu.team_id = tr.team_id WHERE tu.user_id = ?`,
    ),
    // A report is readable iff one of the user's team scopes contains it.
    selectReportReadableStmt: db.prepare(
      `SELECT 1 FROM managed_report r
         JOIN team_repo tr ON tr.repo_id = r.repo_id AND ${REPORT_IN_TEAM_PATH_SQL}
         JOIN team_user tu ON tu.team_id = tr.team_id
        WHERE r.id = ? AND tu.user_id = ? LIMIT 1`,
    ),
    // The viewer's effective visibility permissions for a report: OR'd (MAX over
    // 0/1) across memberships whose repository path contains the report. NULLs
    // (no such membership) read as 0 = no permission.
    selectReportPermsStmt: db.prepare(
      `SELECT MAX(tu.view_dependencies) AS dependencies, MAX(tu.view_security) AS security
         FROM managed_report r
         JOIN team_repo tr ON tr.repo_id = r.repo_id AND ${REPORT_IN_TEAM_PATH_SQL}
         JOIN team_user tu ON tu.team_id = tr.team_id AND tu.user_id = ?
        WHERE r.id = ?`,
    ),
    selectUserOptionsStmt: db.prepare(`SELECT id, login, name FROM managed_user ORDER BY login ASC`),
    selectTeamReposStmt: db.prepare(
      `SELECT tr.team_id AS teamId, tr.repo_id AS repoId, sr.full_name AS fullName, NULLIF(tr.path, '') AS path
         FROM team_repo tr JOIN selected_repo sr ON sr.repo_id = tr.repo_id
        ORDER BY sr.full_name ASC, tr.path ASC`,
    ),
    selectTeamMembersStmt: db.prepare(
      `SELECT tu.team_id AS teamId, tu.user_id AS userId, u.login AS login,
              tu.view_dependencies AS viewDependencies, tu.view_security AS viewSecurity
         FROM team_user tu JOIN managed_user u ON u.id = tu.user_id
        ORDER BY u.login ASC`,
    ),
    upsertTeamRepoStmt: db.prepare(
      `INSERT OR IGNORE INTO team_repo (team_id, repo_id, path)
       SELECT ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM team_repo WHERE team_id = ? AND repo_id = ? AND path = '')`,
    ),
    deleteTeamRepoStmt: db.prepare(`DELETE FROM team_repo WHERE team_id = ? AND repo_id = ?`),
    deleteTeamRepoPathStmt: db.prepare(`DELETE FROM team_repo WHERE team_id = ? AND repo_id = ? AND path = ?`),
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
  branch: string; htmlUrl: string; addedBy: string | null; addedAt: number; active: number
}

// The repo-selection slice of ManagedDb, split out to keep openSqliteManagedDb
// within the per-function line budget. Closes over its prepared statements.
function selectedRepoMethods(stmts: ReturnType<typeof prepareStatements>) {
  const { upsertRepoStmt, deleteRepoStmt, deactivateRepoStmt, reactivateRepoStmt, selectReposStmt, selectAllReposStmt,
    selectReportsForRepoStmt, selectBundlesForRepoStmt, deleteReportsForRepoStmt, deleteBundlesForRepoStmt } = stmts
  const readRepo = (r: RepoRow): SelectedRepo => ({
    repoId: r.repoId, fullName: r.fullName, private: r.priv === 1,
    installationId: r.installId, defaultBranch: r.branch, htmlUrl: r.htmlUrl,
    addedBy: r.addedBy, addedAt: r.addedAt,
  })
  const readManagedRepo = (r: RepoRow): ManagedRepo => ({ ...readRepo(r), active: r.active === 1 })
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
      return Promise.resolve(rows.map(readRepo))
    },
    listAllRepos(): Promise<ManagedRepo[]> {
      const rows = selectAllReposStmt.all() as RepoRow[]
      return Promise.resolve(rows.map(readManagedRepo))
    },
    deactivateRepo(repoId: number): Promise<boolean> {
      return Promise.resolve(Number(deactivateRepoStmt.run(repoId).changes) > 0)
    },
    reactivateRepo(repoId: number): Promise<boolean> {
      return Promise.resolve(Number(reactivateRepoStmt.run(repoId).changes) > 0)
    },
    deleteRepo(repoId: number): Promise<boolean> {
      return Promise.resolve(Number(deleteRepoStmt.run(repoId).changes) > 0)
    },
    listReportsForRepo(repoId: number): Promise<RepoDataItem[]> {
      return Promise.resolve(selectReportsForRepoStmt.all(repoId) as unknown as RepoDataItem[])
    },
    listBundlesForRepo(repoId: number): Promise<RepoDataItem[]> {
      return Promise.resolve(selectBundlesForRepoStmt.all(repoId) as unknown as RepoDataItem[])
    },
    deleteReportsForRepo(repoId: number): Promise<number> {
      return Promise.resolve(Number(deleteReportsForRepoStmt.run(repoId).changes))
    },
    deleteBundlesForRepo(repoId: number): Promise<number> {
      return Promise.resolve(Number(deleteBundlesForRepoStmt.run(repoId).changes))
    },
  }
}

type ReportListRow = {
  id: string; slug: string; filename: string; contentType: string; byteSize: number
  sha256: string; uploadedByLogin: string | null
  repoId: number | null; repoFullName: string | null
  repoDirectory: string; repoEmbedded: number; analyzer: string | null; visible: number
  bundleId: string | null; bundleFilename: string | null; bundleIntegrity: string | null
  uploadedAt: number
}
type ReportRow = {
  id: string; slug: string; filename: string; contentType: string; byteSize: number
  sha256: string; uploadedBy: string | null; uploadedAt: number
  repoId: number | null; repoDirectory: string; repoEmbedded: number; analyzer: string | null; visible: number
}

// The report slice of ManagedDb, split out (like selectedRepoMethods) to keep
// openSqliteManagedDb small. Closes over its prepared statements.
function reportMethods(stmts: ReturnType<typeof prepareStatements>) {
  const { insertReportStmt, selectReportsStmt, selectReportStmt, deleteReportStmt, setReportRepoStmt, setReportVisibleStmt } = stmts
  return {
    insertReport(report: ReportRecordInput, now: number): Promise<void> {
      insertReportStmt.run(
        report.id, preferredSlug(report.id), report.filename, report.contentType, report.byteSize,
        report.sha256, report.uploadedBy, report.uploadedByLogin ?? null, report.repoId,
        report.repoDirectory ?? '', report.repoEmbedded ? 1 : 0, report.analyzer ?? null, report.visible == null ? 0 : report.visible ? 1 : 0, report.bundleId ?? null,
        report.bundleIntegrity ?? null, now,
      )
      return Promise.resolve()
    },
    listReports(userId?: string): Promise<AdminReport[]> {
      const rows = selectReportsStmt.all(userId ?? null, userId ?? null, userId ?? null) as ReportListRow[]
      return Promise.resolve(rows.map((r) => ({
        id: r.id, slug: r.slug, filename: r.filename, contentType: r.contentType, byteSize: r.byteSize,
        sha256: r.sha256, uploadedByLogin: r.uploadedByLogin,
        repoId: r.repoId, repoFullName: r.repoFullName,
        repoDirectory: r.repoDirectory, repoEmbedded: r.repoEmbedded === 1, analyzer: r.analyzer, visible: r.visible === 1,
        bundleId: r.bundleId, bundleFilename: r.bundleFilename, bundleIntegrity: r.bundleIntegrity,
        uploadedAt: r.uploadedAt,
      })))
    },
    getReport(id: string): Promise<ReportRecord | null> {
      const row = selectReportStmt.get(id) as ReportRow | undefined
      if (row == null) return Promise.resolve(null)
      return Promise.resolve({
        id: row.id, slug: row.slug, filename: row.filename, contentType: row.contentType, byteSize: row.byteSize,
        sha256: row.sha256, uploadedBy: row.uploadedBy, uploadedAt: row.uploadedAt,
        repoId: row.repoId, repoDirectory: row.repoDirectory, repoEmbedded: row.repoEmbedded === 1, analyzer: row.analyzer, visible: row.visible === 1,
      })
    },
    deleteReport(id: string): Promise<boolean> {
      return Promise.resolve(Number(deleteReportStmt.run(id).changes) > 0)
    },
    setReportRepo(id: string, repoId: number | null, repoDirectory = ''): Promise<boolean> {
      return Promise.resolve(Number(setReportRepoStmt.run(repoId, repoId == null ? '' : repoDirectory, id).changes) > 0)
    },
    setReportVisible(id: string, visible: boolean): Promise<boolean> {
      return Promise.resolve(Number(setReportVisibleStmt.run(visible ? 1 : 0, id).changes) > 0)
    },
  }
}

type TriageDbRow = {
  findingId: string; color: string | null; triage: string | null
  comment: string | null; fix: string | null; flagged: number | null
  updatedByLogin: string | null; updatedAt: number
}
type TriageStateDbRow = { color: string | null; triage: string | null; comment: string | null; fix: string | null; flagged: number | null }
type TriageEventDbRow = TriageStateDbRow & { seq: number; findingId: string; batchId: string; actorLogin: string | null; at: number }

// The per-finding triage slice of ManagedDb. Closes over its prepared
// statements (and the handle, for the batch write's transaction). A
// null/empty entry writes the tombstone — every field NULL, writer and time
// stamped — so a later reader learns the entry was cleared rather than never
// set. Every change is also appended to the trail; a write equal to the
// current row is skipped altogether, so a client re-pushing what already
// stands neither re-stamps the writer nor echoes into the trail. `historyLimit`
// > 0 keeps only that many events per finding; 0 keeps everything.
function triageMethods(db: DatabaseSync, stmts: ReturnType<typeof prepareStatements>, historyLimit: number) {
  const { upsertTriageStmt, selectTriageStmt, selectTriageStateStmt, insertTriageEventStmt, trimTriageEventsStmt, selectTriageHistoryStmt,
    deleteTriageStmt, deleteTriageHistoryStmt, deleteCommentsStmt, deleteCommentHistoryStmt, countAnnotationsStmt } = stmts
  function writeEntry(findingId: string, entry: TriageEntryPatch | null, batchId: string, updatedBy: string | null, updatedByLogin: string | null, now: number, reportId: string | null = null): void {
    const e = entry ?? {}
    // `flagged: false` is a real value (the explicit un-flag tombstone), so it
    // is 0 here and only null/absent maps to NULL.
    const next: TriageStateDbRow = {
      color: e.color ?? null, triage: e.triage ?? null, comment: e.comment ?? null,
      fix: e.fix ?? null, flagged: e.flagged == null ? null : (e.flagged ? 1 : 0),
    }
    const cur = selectTriageStateStmt.get(findingId) as TriageStateDbRow | undefined
    if (cur != null && cur.color === next.color && cur.triage === next.triage && cur.comment === next.comment
      && cur.fix === next.fix && cur.flagged === next.flagged) return
    upsertTriageStmt.run(findingId, next.color, next.triage, next.comment, next.fix, next.flagged, updatedBy, updatedByLogin, now)
    insertTriageEventStmt.run(findingId, batchId, next.color, next.triage, next.comment, next.fix, next.flagged, updatedBy, updatedByLogin, now, reportId, reportId, reportId)
    if (historyLimit > 0) trimTriageEventsStmt.run(findingId, findingId, historyLimit)
  }
  return {
    deleteTriage(findingIds: readonly string[]): Promise<number> {
      if (findingIds.length === 0) return Promise.resolve(0)
      const ids = JSON.stringify(findingIds)
      db.exec('BEGIN')
      try {
        const { total: deleted } = countAnnotationsStmt.get(ids, ids, ids) as { total: number }
        deleteTriageStmt.run(ids)
        deleteTriageHistoryStmt.run(ids)
        deleteCommentsStmt.run(ids)
        deleteCommentHistoryStmt.run(ids)
        db.exec('COMMIT')
        return Promise.resolve(deleted)
      } catch (err) {
        try { db.exec('ROLLBACK') } catch {}
        throw err
      }
    },
    listTriageHistory(findingId: string, limit: number): Promise<TriageEventRow[]> {
      const rows = selectTriageHistoryStmt.all(findingId, limit) as TriageEventDbRow[]
      return Promise.resolve(rows.map((r) => ({
        seq: r.seq, findingId: r.findingId, batchId: r.batchId,
        color: r.color, triage: r.triage, comment: r.comment, fix: r.fix,
        flagged: r.flagged == null ? null : r.flagged === 1,
        actorLogin: r.actorLogin, at: r.at,
      })))
    },
    listTriage(findingIds: readonly string[]): Promise<TriageRow[]> {
      if (findingIds.length === 0) return Promise.resolve([])
      const rows = selectTriageStmt.all(JSON.stringify(findingIds)) as TriageDbRow[]
      return Promise.resolve(rows.map((r) => ({
        findingId: r.findingId, color: r.color, triage: r.triage, comment: r.comment, fix: r.fix,
        flagged: r.flagged == null ? null : r.flagged === 1,
        updatedByLogin: r.updatedByLogin, updatedAt: r.updatedAt,
      })))
    },
    setTriage(findingId: string, entry: TriageEntryPatch | null, updatedBy: string | null, updatedByLogin: string | null, now: number): Promise<void> {
      // A single write is its own batch. The row and its event go together.
      db.exec('BEGIN')
      try {
        writeEntry(findingId, entry, randomUUID(), updatedBy, updatedByLogin, now)
        db.exec('COMMIT')
      } catch (err) {
        try { db.exec('ROLLBACK') } catch {}
        throw err
      }
      return Promise.resolve()
    },
    setTriageEntries(entries: readonly (readonly [string, TriageEntryPatch | null])[], updatedBy: string | null, updatedByLogin: string | null, now: number, reportId?: string): Promise<void> {
      // One transaction, so a batch is never half-applied by a mid-loop error
      // (and costs one fsync under synchronous = FULL, not one per row); one
      // batch id groups its rows in the trail.
      const batchId = randomUUID()
      db.exec('BEGIN')
      try {
        for (const [findingId, entry] of entries) writeEntry(findingId, entry, batchId, updatedBy, updatedByLogin, now, reportId)
        db.exec('COMMIT')
      } catch (err) {
        try { db.exec('ROLLBACK') } catch {}
        throw err
      }
      return Promise.resolve()
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
    selectBundlesStmt, deleteBundleStmt, setBundleRepoStmt, linkReportsToBundleStmt, selectBundleReadableStmt, selectRepoReadableStmt, selectRepoPathReadableStmt,
  } = stmts
  return {
    insertBundle(bundle: BundleInput, now: number): Promise<void> {
      insertBundleStmt.run(
        bundle.id, bundle.integrity, bundle.filename, bundle.kind,
        bundle.byteSize, bundle.uploadedBy, bundle.uploadedByLogin ?? null, bundle.repoId, now,
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
    listBundles(userId?: string): Promise<AdminBundle[]> {
      const rows = selectBundlesStmt.all(userId ?? null, userId ?? null, userId ?? null) as BundleListRow[]
      return Promise.resolve(rows.map((r) => ({
        id: r.id, integrity: r.integrity, filename: r.filename, kind: r.kind, byteSize: r.byteSize,
        uploadedByLogin: r.uploadedByLogin, repoId: r.repoId, repoFullName: r.repoFullName,
        uploadedAt: r.uploadedAt,
      })))
    },
    userCanReadBundle(userId: string, id: string): Promise<boolean> {
      return Promise.resolve(selectBundleReadableStmt.get(id, userId, userId) != null)
    },
    userCanReadRepo(userId: string, repoId: number): Promise<boolean> {
      return Promise.resolve(selectRepoReadableStmt.get(repoId, userId) != null)
    },
    userCanReadRepoPath(userId: string, repoId: number, directory: string): Promise<boolean> {
      return Promise.resolve(selectRepoPathReadableStmt.get(directory, repoId, userId) != null)
    },
    deleteBundle(id: string): Promise<boolean> {
      return Promise.resolve(Number(deleteBundleStmt.run(id).changes) > 0)
    },
    setBundleRepo(id: string, repoId: number | null): Promise<boolean> {
      return Promise.resolve(Number(setBundleRepoStmt.run(repoId, id).changes) > 0)
    },
    linkReportsToBundle(integrity: string, bundleId: string, userId?: string): Promise<void> {
      linkReportsToBundleStmt.run(bundleId, integrity, userId ?? null, userId ?? null, userId ?? null)
      return Promise.resolve()
    },
  }
}

type TeamRow = { id: string; slug: string; name: string }
type TeamRepoRow = { teamId: string; repoId: number; fullName: string; path: string | null }
type TeamMemberRow = { teamId: string; userId: string; login: string; viewDependencies: number; viewSecurity: number }

// The team slice of ManagedDb. listTeams reads the three tables in full and
// groups in JS (3 queries, not N+1) — fine for the handful of teams a managed
// workspace has.
function teamMethods(db: DatabaseSync, stmts: ReturnType<typeof prepareStatements>) {
  const {
    insertTeamStmt, selectTeamByNameStmt, renameTeamStmt, deleteTeamStmt, selectTeamStmt,
    selectUserRepoScopesStmt, selectTeamsStmt, selectTeamsForUserStmt, selectUserTeamReportsStmt, selectUserTeamBundlesStmt, selectReportReadableStmt,
    selectReportPermsStmt, selectUserOptionsStmt, selectTeamReposStmt, selectTeamMembersStmt,
    upsertTeamRepoStmt, deleteTeamRepoStmt, deleteTeamRepoPathStmt, upsertTeamMemberStmt, deleteTeamMemberStmt,
  } = stmts
  return {
    createTeam(id: string, name: string, now: number): Promise<boolean> {
      return Promise.resolve(Number(insertTeamStmt.run(id, preferredSlug(id), name, now, now).changes) > 0)
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
    getTeam(id: string): Promise<{ id: string; slug: string; name: string } | null> {
      const row = selectTeamStmt.get(id) as TeamRow | undefined
      return Promise.resolve(row == null ? null : { id: row.id, slug: row.slug, name: row.name })
    },
    listUserOptions(): Promise<UserOption[]> {
      return Promise.resolve((selectUserOptionsStmt.all() as UserOption[]).map((u) => ({ id: u.id, login: u.login, name: u.name })))
    },
    listRepoScopesForUser(userId: string): Promise<{ repoId: number; path: string | null }[]> {
      return Promise.resolve(selectUserRepoScopesStmt.all(userId) as { repoId: number; path: string | null }[])
    },
    listTeamsForUser(userId: string): Promise<UserTeam[]> {
      const teams = selectTeamsForUserStmt.all(userId) as { id: string; slug: string; name: string }[]
      const reportsByTeam = new Map<string, UserTeamReport[]>()
      for (const r of selectUserTeamReportsStmt.all(userId) as { teamId: string; id: string; slug: string; filename: string }[]) {
        const list = reportsByTeam.get(r.teamId) ?? []
        list.push({ id: r.id, slug: r.slug, filename: r.filename })
        reportsByTeam.set(r.teamId, list)
      }
      const bundlesByTeam = new Map<string, UserTeamBundle[]>()
      for (const b of selectUserTeamBundlesStmt.all(userId) as { teamId: string; id: string; filename: string; repoFullName: string }[]) {
        const list = bundlesByTeam.get(b.teamId) ?? []
        list.push({ id: b.id, filename: b.filename, repoFullName: b.repoFullName })
        bundlesByTeam.set(b.teamId, list)
      }
      return Promise.resolve(teams.map((t) => ({
        id: t.id, slug: t.slug, name: t.name,
        reports: reportsByTeam.get(t.id) ?? [],
        bundles: bundlesByTeam.get(t.id) ?? [],
      })))
    },
    userCanReadReport(userId: string, reportId: string): Promise<boolean> {
      return Promise.resolve(selectReportReadableStmt.get(reportId, userId) != null)
    },
    reportPermissionsFor(userId: string, reportId: string): Promise<TeamUserPermissions> {
      const row = selectReportPermsStmt.get(userId, reportId) as { dependencies: number | null; security: number | null } | undefined
      return Promise.resolve({ dependencies: row?.dependencies === 1, security: row?.security === 1 })
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
        id: t.id, slug: t.slug, name: t.name,
        repos: reposByTeam.get(t.id) ?? [],
        members: membersByTeam.get(t.id) ?? [],
      })))
    },
    setTeamRepo(teamId: string, repoId: number, path: string | null): Promise<void> {
      // A whole-repository grant supersedes all its path grants atomically.
      // Adding a redundant path to an existing whole-repo grant is a no-op.
      db.exec('BEGIN IMMEDIATE')
      try {
        if (path == null || path === '') deleteTeamRepoStmt.run(teamId, repoId)
        upsertTeamRepoStmt.run(teamId, repoId, path ?? '', teamId, repoId)
        db.exec('COMMIT')
      } catch (err) { db.exec('ROLLBACK'); throw err }
      return Promise.resolve()
    },
    removeTeamRepo(teamId: string, repoId: number, path?: string | null): Promise<boolean> {
      const result = path === undefined ? deleteTeamRepoStmt.run(teamId, repoId) : deleteTeamRepoPathStmt.run(teamId, repoId, path ?? '')
      return Promise.resolve(Number(result.changes) > 0)
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

// Preserve the legacy single-path links while adding path to their identity.
function migrateTeamRepoPaths(db: DatabaseSync): void {
  const columns = db.prepare('PRAGMA table_info(team_repo)').all() as { name: string; pk: number }[]
  if (columns.some(column => column.name === 'path' && column.pk === 3)) return
  db.exec('BEGIN IMMEDIATE')
  try {
    db.exec(`CREATE TABLE team_repo_paths (
      team_id TEXT NOT NULL REFERENCES managed_team(id) ON DELETE CASCADE,
      repo_id INTEGER NOT NULL REFERENCES selected_repo(repo_id) ON DELETE CASCADE,
      path TEXT NOT NULL DEFAULT '', PRIMARY KEY (team_id, repo_id, path)
    ) STRICT;
    INSERT INTO team_repo_paths SELECT team_id, repo_id, COALESCE(path, '') FROM team_repo;
    DROP TABLE team_repo;
    ALTER TABLE team_repo_paths RENAME TO team_repo;
    CREATE INDEX team_repo_repo_idx ON team_repo(repo_id);`)
    db.exec('COMMIT')
  } catch (err) { db.exec('ROLLBACK'); throw err }
}

// Add `column` to `table` if it's missing (a lightweight migration for DBs that
// predate the column; `table`/`column` are code constants, never user input).
function ensureColumn(db: DatabaseSync, table: string, column: string, type: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  if (cols.some((c) => c.name === column)) return false
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`)
  return true
}

// `triageHistoryLimit`: events kept per finding in the triage trail; 0 (the
// default) keeps everything. See ManagedConfig.
export interface ManagedDbOptions {
  triageHistoryLimit?: number
}

export function openSqliteManagedDb(path: string, options: ManagedDbOptions = {}): ManagedDb {
  mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  try {
    db.exec('PRAGMA journal_mode = WAL;')
    db.exec('PRAGMA synchronous = FULL;')
    db.exec('PRAGMA foreign_keys = ON;')
    db.exec(SQLITE_SCHEMA)
    migrateTeamRepoPaths(db)
    migrateSlugs(db)
    // Migrate DBs created before a column existed (CREATE TABLE IF NOT EXISTS
    // never alters an already-present table). Idempotent — skipped on fresh DBs.
    const addedLastSeen = ensureColumn(db, 'managed_user', 'last_seen_at', 'INTEGER')
    if (addedLastSeen) {
      // Session creation is known authentication activity. updated_at is not:
      // role changes and token refreshes also wrote it. Keep unknowns NULL.
      db.exec(`UPDATE managed_user SET last_seen_at = (
        SELECT MAX(s.created_at) FROM managed_session s WHERE s.user_id = managed_user.id
      )`)
    }
    ensureColumn(db, 'managed_report', 'uploaded_by_login', 'TEXT')
    ensureColumn(db, 'managed_report', 'repo_embedded', 'INTEGER NOT NULL DEFAULT 0')
    migrateReportLocations(db, join(dirname(path), 'reports'))
    ensureColumn(db, 'managed_report', 'analyzer', 'TEXT')
    // Existing rows predate publication controls and were already visible.
    // Backfill only when adding the column; newly inserted rows still use the
    // hidden default and must be explicitly published.
    const addedVisible = ensureColumn(db, 'managed_report', 'visible', 'INTEGER NOT NULL DEFAULT 0')
    if (addedVisible) db.prepare('UPDATE managed_report SET visible = 1 WHERE visible = 0').run()
    ensureColumn(db, 'managed_bundle', 'uploaded_by_login', 'TEXT')
    ensureColumn(db, 'selected_repo', 'active', 'INTEGER NOT NULL DEFAULT 1')
    ensureColumn(db, 'finding_triage_event', 'report_id', 'TEXT')
    ensureColumn(db, 'finding_triage_event', 'report', 'TEXT')
    ensureColumn(db, 'finding_triage_event', 'repo', 'TEXT')
  } catch (err) {
    try { db.close() } catch {}
    throw err
  }

  // History tables and migrations must exist before preparing the users query.
  const comments = commentMethods(db)
  const activity = activityMethods(db)
  const stmts = prepareStatements(db)
  const {
    upsertUserStmt, selectUserIdStmt, insertSessionStmt, selectSessionStmt, selectUsersStmt,
    touchUserSeenStmt, updateRoleStmt, updateTokensStmt, selectTokensStmt, deleteSessionStmt, deleteExpiredStmt,
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
      touchUserSeenStmt.run(now, session.userId, now)
      return Promise.resolve()
    },
    sessionWithUser(id, now) {
      const row = selectSessionStmt.get(id, now) as SessionRow | undefined
      if (row == null) return Promise.resolve(null)
      touchUserSeenStmt.run(now, row.uid, now)
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
      return Promise.resolve(rows.map((r) => ({ id: r.id, login: r.login, name: r.name, role: r.role, createdAt: r.created, lastSeenAt: r.lastSeen, lastActivityAt: r.lastActivity })))
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
    ...activity,
    ...comments,
    ...reportMethods(stmts),
    ...triageMethods(db, stmts, options.triageHistoryLimit ?? 0),
    ...bundleMethods(stmts),
    ...teamMethods(db, stmts),
    close() {
      db.close()
      return Promise.resolve()
    },
  }
}
