import { type LinkReportStore, linkReportMethods, linkRevision } from './link-reports.ts'
import { type RepositoryAliasStore, repositoryAliasMethods } from './repository-aliases.ts'
import { createHash, randomUUID } from 'node:crypto'
import { teamCatalogRevision } from './team-catalog.ts'
import { type Role, roleAtLeast } from '../common/managed/roles.ts'
import type { TeamUserPermissions } from '../common/managed/permissions.ts'
import type { TriageEntryPatch } from '../common/managed/triage.ts'
import { preferredSlug } from './slugs.ts'
import { type CommentStore, commentMethods } from './comments.ts'
import { type ActivityStore, activityMethods } from './activity.ts'
import { type GithubMetadataStore, githubMetadataMethods } from './github-metadata.ts'
import { type ManagedIssueStore, managedIssueMethods } from './managed-issues.ts'
import { type BundleBuildLeaseStore, bundleBuildLeaseMethods } from './bundle-build-leases.ts'
import { type ImportTriageStore, importTriageMethods } from './import-triage.ts'
import type { ManagedSql } from './sql.ts'
import { type WorkspaceShareStore, workspaceShareMethods } from './workspace-shares.ts'
import { ManagedMutationError, type ManagementStore, managementMethods } from './management.ts'
import { type ManagementCatalogStore, managementCatalogMethods } from './management-catalog.ts'
import { type StorageKey } from '../server-common/storage-crypto.ts'
import { type StorageDb, type StoredTokens, decodeStorageTokens, encodeStorageTokens, storageMethods, storageState, validateStorageUpload } from './storage-db.ts'

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
  // Last live default observed by the repository browser, independent of the
  // selection/discovery snapshot above. NULL means unknown or unavailable.
  cachedDefaultBranch: string | null
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
export type SelectedRepoInput = Omit<SelectedRepo, 'addedAt' | 'cachedDefaultBranch'>

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
  bundleId: string | null
}

// One transaction snapshots all metadata needed to authorize, filter and
// revalidate a report batch. Unauthorized/missing reports are omitted.
export interface ReportAccessRecord {
  id: string
  filename: string
  byteSize: number
  sha256: string
  repo: { github: string | null; directory: string }
  permissions: TeamUserPermissions
}
export interface TeamReportAccessSnapshot extends ReportAccessSnapshot {
  teamId: string | null
  reportId?: string | null
  hiddenReportId?: string | null
  repositories: { repoId: number; github: string; path: string | null }[]
}
export interface ReportAccessSnapshot {
  user: StoredUser
  linkRevision?: string
  reports: ReportAccessRecord[]
}

// What the upload handler supplies to record a report; the store stamps
// uploaded_at. `repoId` / `bundleId` are the (nullable) repo + auto-resolved
// bundle links; `bundleIntegrity` is the report's declared primary bundle (kept
// so a later bundle upload of that integrity re-links it).
export interface ReportRecordInput {
  dataKey?: string | null
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

export type RepoReportItem = Pick<ReportRecord, 'id' | 'filename' | 'sha256' | 'bundleId'>

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
  actorId: string | null
  actorLogin: string | null
  actorName: string | null
  at: number
}

// A stored bundle's metadata. Bytes live in the blob-store keyed by `id`;
// `integrity` (sha512-<base64>) is the content-addressed identity (UNIQUE),
// matched against a report's bundleHashes to auto-link.
export interface ManagedBundle {
  visible: boolean
  id: string
  slug: string
  integrity: string
  filename: string
  kind: string | null
  byteSize: number
  uploadedBy: string | null
  repoDirectory: string
  repoId: number | null
  uploadedAt: number
}

// What the upload handler supplies to record a bundle; the store stamps
// uploaded_at. `uploadedByLogin` is the durable uploader-login snapshot.
export type BundleInput = Omit<ManagedBundle, 'uploadedAt' | 'slug' | 'repoDirectory' | 'visible'> & { visible?: boolean; uploadedByLogin: string | null; repoDirectory?: string; dataKey?: string | null }

// A bundle row for the "Manage bundles" list — adds the uploader login + repo
// full name display joins (null when absent / since removed).
export interface AdminBundle {
  visible: boolean
  id: string
  slug: string
  integrity: string
  filename: string
  kind: string | null
  byteSize: number
  uploadedByLogin: string | null
  repoDirectory: string
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
  hidden: boolean
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
  role: Role
}

// A team as shown in a member's own sidebar: the team name plus the reports and
// bundles attached to the team's repos (id + filename, newest first). An item
// shows under a team when its repo is one of the team's linked repos.
export interface UserTeamReport {
  visible: boolean
  id: string
  slug: string
  filename: string
  analyzer: string | null
  repoFullName: string | null
  repoDirectory: string
  cacheKey: string
}
export interface UserTeamBundle {
  visible: boolean
  id: string
  slug: string
  integrity: string
  filename: string
  kind: string | null
  byteSize: number
  repoDirectory: string
  repoId: number
  repoFullName: string
}
export interface UserTeam {
  id: string
  slug: string
  name: string
  permissions: TeamUserPermissions
  cacheKey?: string
  reports: UserTeamReport[]
  bundles: UserTeamBundle[]
}

// Backend-agnostic store surface (SQLite + PostgreSQL implementations).
export interface ManagedDb extends ActivityStore, CommentStore, GithubMetadataStore, ManagedIssueStore, BundleBuildLeaseStore, WorkspaceShareStore, ImportTriageStore, ManagementStore, ManagementCatalogStore, StorageDb, LinkReportStore, RepositoryAliasStore {
  claimMaintenanceLease(owner: string, now: number, until: number, migration?: boolean): Promise<boolean>
  finishMaintenanceLease(owner: string, until: number): Promise<void>
  getFeedState(sessionId: string, now: number): Promise<{ user: Pick<StoredUser, 'id' | 'role'>; catalog: number; annotations: number } | null>
  // Reuse connections within a finite request or one feed polling iteration.
  withRequest?<T>(work: () => Promise<T>): Promise<T>
  // Upsert the identity; returns the user's opaque id (stable across logins).
  // Initial-admin approval comes only from trusted login configuration. It
  // promotes a matching No access identity only while it is the sole user.
  upsertUser(user: ManagedUser, now: number, initialAdminGithubId?: number | null): Promise<string>
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
  getUserGithubId(id: string): Promise<number | null>
  // Repo selection ("operate on"). selectRepo upserts by repo id, refreshing the
  // mutable context while keeping the original added_by/added_at; deselectRepo
  // resolves true iff a row was removed.
  selectRepo(repo: SelectedRepoInput, now: number): Promise<void>
  cacheRepoDefaultBranch(repo: SelectedRepo, branch: string | null): Promise<boolean>
  connectRepoInstallation(repo: SelectedRepo, installationId: number, sessionId: string, now: number): Promise<boolean>
  deselectRepo(repoId: number): Promise<boolean>
  listSelectedRepos(): Promise<SelectedRepo[]>
  listAllRepos(): Promise<ManagedRepo[]>
  deactivateRepo(repoId: number): Promise<boolean>
  reactivateRepo(repoId: number): Promise<boolean>
  deleteRepo(repoId: number): Promise<boolean>
  listReportsForRepo(repoId: number): Promise<RepoReportItem[]>
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
  // Content reuse is atomic with insertion, including across server instances.
  // Existing copies are kept; the oldest matching row is the stable identity.
  // HTTP uploads pass sessionId to recheck role/destination in that transaction.
  insertOrReuseReport(report: ReportRecordInput, now: number, sessionId?: string): Promise<ReportRecord>
  getReportByHash(sha256: string, analyzer: string | null): Promise<ReportRecord | null>
  listReports(userId?: string): Promise<AdminReport[]>
  listFindingCatalogReports(after: string, limit: number): Promise<Pick<ReportRecord, 'id' | 'byteSize'>[]>
  getReport(id: string): Promise<ReportRecord | null>
  // Writer-locked reconciliation waits for an uncertain earlier insert.
  resolveReportUpload(id: string): Promise<ReportRecord | null>
  getTeamReportAccessSnapshot(sessionId: string, now: number, teamId: string, reportId?: string | null): Promise<TeamReportAccessSnapshot | null>
  getReportAccessSnapshot(sessionId: string, now: number, ids: readonly string[]): Promise<ReportAccessSnapshot | null>
  listReportFilenamesWithBundleHash(bundleId: string, sha256: string): Promise<string[]>
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
  // stamp nor the trail. Every change also appends to managed_finding_triage_event;
  // listTriageHistory walks one finding's trail, newest first.
  listTriage(findingIds: readonly string[]): Promise<TriageRow[]>
  getAnnotations(findingIds: readonly string[]): Promise<{ triage: TriageRow[]; comments: Awaited<ReturnType<CommentStore['listComments']>> }>
  // A content-free fingerprint of current annotations, read in one snapshot.
  getAnnotationRevision(findingIds: readonly string[]): Promise<string>
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
  insertBundle(bundle: BundleInput, now: number, sessionId?: string): Promise<void>
  getBundleByIntegrity(integrity: string): Promise<ManagedBundle | null>
  resolveBundleUpload(integrity: string): Promise<ManagedBundle | null>
  getBundle(id: string): Promise<ManagedBundle | null>
  // One read snapshot of the live session, bundle and grants. Passing a team
  // (or null for any team) also checks advisory security access; omission skips it.
  getBundleAccessSnapshot(sessionId: string, now: number, id: string, advisoriesTeamId?: string | null): Promise<{
    bundle: ManagedBundle | null; canReadAdvisories: boolean
  } | null>
  listBundles(userId?: string): Promise<AdminBundle[]>
  listReadableBundleIds(userId: string, ids: readonly string[]): Promise<string[]>
  userCanReadBundle(userId: string, id: string): Promise<boolean>
  userCanReadRepo(userId: string, repoId: number): Promise<boolean>
  userCanReadBundleAdvisories(userId: string, bundleId: string, teamId: string | null): Promise<boolean>
  userCanReadRepoPath(userId: string, repoId: number, directory: string): Promise<boolean>
  deleteBundle(id: string): Promise<boolean>
  // Set a bundle's repository and normalized directory (repoId null detaches
  // and clears the directory). The caller validates the location and access.
  setBundleRepo(id: string, repoId: number | null, directory?: string): Promise<boolean>
  setBundleVisible(id: string, visible: boolean): Promise<boolean>
  linkReportsToBundle(integrity: string, bundleId: string, userId?: string): Promise<void>
  // Teams ("Manage teams"). createTeam inserts a team (false iff the name is
  // taken); renameTeam changes a team's name ('name-taken' iff another team
  // already has it, 'not-found' iff no such team, 'ok' otherwise — same name is
  // idempotent); deleteTeam drops it (cascading its links); listTeams returns
  // every team (including hidden ones) with its repos + members inlined; listUserOptions is the id+login+name
  // set for the member picker. The set*/remove* pairs maintain the link tables:
  // setTeamRepo adds a path (whole repo replaces paths); setTeamMember upserts a
  // membership + its visibility permissions (each resolves true iff a row was
  // written / removed; the caller validates the team/repo/user exist first).
  createTeam(id: string, name: string, now: number): Promise<boolean>
  renameTeam(id: string, name: string, now: number): Promise<'ok' | 'name-taken' | 'not-found'>
  // Hiding preserves links but disables all grants and workspace access.
  setTeamHidden(id: string, hidden: boolean, now: number): Promise<boolean>
  deleteTeam(id: string): Promise<boolean>
  getTeam(id: string): Promise<{ id: string; slug: string; name: string; hidden: boolean } | null>
  listTeams(): Promise<AdminTeam[]>
  listUserOptions(): Promise<UserOption[]>
  // Current grants for manager content reads, writes, and repository pickers.
  listRepoScopesForUser(userId: string): Promise<{ repoId: number; path: string | null }[]>
  // The non-hidden teams a given user belongs to (name-sorted), each with reports and
  // bundles attached to that team's repos — for that user's own sidebar Teams section.
  // Any user; only their own memberships.
  listTeamsForUser(userId: string): Promise<UserTeam[]>
  getUserTeamFeedSnapshot(sessionId: string, now: number): Promise<{ user: Pick<StoredUser, 'id' | 'role'>; revision: string; teams: UserTeam[]; catalog: number } | null>
  // Whether `userId` may read `reportId`: true iff the report's repo belongs to
  // a non-hidden team the user is a member of. Backs the team-scoped report view endpoint.
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

const BUNDLE_IN_TEAM_PATH_SQL = REPORT_IN_TEAM_PATH_SQL.replaceAll('r.repo_directory', 'b.repo_directory')

// Prepare every statement the store uses, returned as a bag the factory
// destructures — keeps openSqliteManagedDb itself small (one place per query).
function prepareStatements(db: ManagedSql) {
  return {
    // Identity refreshes preserve roles. Login can separately bootstrap the
    // configured sole No access user within this same writer transaction.
    upsertUserStmt: db.prepare(
      `INSERT INTO managed_user (id, github_user_id, login, name, avatar_url, role, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'none', ?, ?)
       ON CONFLICT(github_user_id) DO UPDATE SET
         login = excluded.login, name = excluded.name,
         avatar_url = excluded.avatar_url, updated_at = excluded.updated_at`,
    ),
    selectUserIdStmt: db.prepare(`SELECT id, role FROM managed_user WHERE github_user_id = ?`),
    promoteInitialAdminStmt: db.prepare(
      `UPDATE managed_user SET role = 'admin' WHERE id = ? AND role = 'none'
         AND NOT EXISTS(SELECT 1 FROM managed_user WHERE id <> ?)`,
    ),
    selectGithubIdStmt: db.prepare(`SELECT github_user_id AS githubId FROM managed_user WHERE id = ?`),
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
                SELECT MAX(e.at) AS at FROM managed_finding_triage_event e WHERE e.actor_id = u.id
                UNION ALL SELECT MAX(a.at) AS at FROM managed_activity a WHERE a.actor_id = u.id
                UNION ALL SELECT MAX(c.at) AS at FROM managed_finding_comment_event c WHERE c.actor_id = u.id
              ) AS events) AS lastActivity
         FROM managed_user u ORDER BY u.created_at ASC, u.login ASC`,
    ),
    touchUserSeenStmt: db.prepare(
      `UPDATE managed_user SET last_seen_at = ? WHERE id = ? AND (last_seen_at IS NULL OR last_seen_at < ?)`,
    ),
    updateRoleStmt: db.prepare(`UPDATE managed_user SET role = ?, updated_at = ? WHERE id = ?`),
    updateTokensStmt: db.prepare(
      `UPDATE managed_user
          SET gh_access_token = ?, gh_refresh_token = ?, gh_token_expires_at = ?, gh_tokens_encrypted = ?, updated_at = ?
        WHERE id = ?`,
    ),
    selectTokensStmt: db.prepare(
      `SELECT gh_access_token AS access, gh_refresh_token AS refresh, gh_token_expires_at AS exp, gh_tokens_encrypted AS encrypted
         FROM managed_user WHERE id = ?`,
    ),
    deleteSessionStmt: db.prepare(`DELETE FROM managed_session WHERE id = ?`),
    deleteExpiredStmt: db.prepare(`DELETE FROM managed_session WHERE expires_at <= ?`),
    upsertRepoStmt: db.prepare(
      `INSERT INTO managed_selected_repo (repo_id, full_name, is_private, installation_id, default_branch, html_url, added_by, added_at, updated_at, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
       ON CONFLICT(repo_id) DO UPDATE SET
         full_name = excluded.full_name, is_private = excluded.is_private,
         installation_id = excluded.installation_id, default_branch = excluded.default_branch,
         html_url = excluded.html_url, updated_at = excluded.updated_at, active = 1`,
    ),
    // Never reactivate or recreate a repo, overwrite another connection, or
    // commit after the administrator's session/role was revoked during GitHub I/O.
    connectRepoInstallationStmt: db.prepare(`UPDATE managed_selected_repo SET installation_id = ?, updated_at = ?
      WHERE repo_id = ? AND full_name = ? AND added_at = ? AND installation_id IS NULL
        AND EXISTS (SELECT 1 FROM managed_session s JOIN managed_user u ON u.id = s.user_id
          WHERE s.id = ? AND s.expires_at > ? AND u.role = 'admin')`),
    cacheRepoDefaultBranchStmt: db.prepare(`UPDATE managed_selected_repo SET cached_default_branch = ?
      WHERE repo_id = ? AND full_name = ? AND added_at = ? AND active = 1`),
    deleteRepoStmt: db.prepare(`DELETE FROM managed_selected_repo WHERE repo_id = ?`),
    deactivateRepoStmt: db.prepare(`UPDATE managed_selected_repo SET active = 0 WHERE repo_id = ? AND active = 1`),
    reactivateRepoStmt: db.prepare(`UPDATE managed_selected_repo SET active = 1 WHERE repo_id = ? AND active = 0`),
    selectReportsForRepoStmt: db.prepare(`SELECT id, filename, sha256, bundle_id AS bundleId FROM managed_report WHERE repo_id = ? ORDER BY filename ASC`),
    selectBundlesForRepoStmt: db.prepare(`SELECT id, filename FROM managed_bundle WHERE repo_id = ? ORDER BY filename ASC`),
    deleteReportsForRepoStmt: db.prepare(`DELETE FROM managed_report WHERE repo_id = ?`),
    deleteBundlesForRepoStmt: db.prepare(`DELETE FROM managed_bundle WHERE repo_id = ?`),
    deleteTriageStmt: db.prepare(`DELETE FROM managed_finding_triage WHERE finding_id IN (SELECT value FROM json_each(?))`),
    deleteTriageHistoryStmt: db.prepare(`DELETE FROM managed_finding_triage_event WHERE finding_id IN (SELECT value FROM json_each(?))`),
    deleteCommentsStmt: db.prepare(`DELETE FROM managed_finding_comment WHERE finding_id IN (SELECT value FROM json_each(?))`),
    deleteCommentHistoryStmt: db.prepare(`DELETE FROM managed_finding_comment_event WHERE finding_id IN (SELECT value FROM json_each(?))`),
    countAnnotationsStmt: db.prepare(`SELECT count(*) AS total FROM (
      SELECT finding_id FROM managed_finding_triage WHERE finding_id IN (SELECT value FROM json_each(?))
      UNION SELECT finding_id FROM managed_finding_comment WHERE finding_id IN (SELECT value FROM json_each(?))
      UNION SELECT finding_id FROM managed_finding_comment_event WHERE finding_id IN (SELECT value FROM json_each(?))) AS annotations`),
    selectReposStmt: db.prepare(
      `SELECT repo_id AS repoId, full_name AS fullName, is_private AS priv,
              installation_id AS installId, default_branch AS branch, cached_default_branch AS cachedDefaultBranch, html_url AS htmlUrl,
              added_by AS addedBy, added_at AS addedAt, active AS active
         FROM managed_selected_repo WHERE active = 1 ORDER BY full_name ASC`,
    ),
    selectAllReposStmt: db.prepare(
      `SELECT repo_id AS repoId, full_name AS fullName, is_private AS priv,
              installation_id AS installId, default_branch AS branch, cached_default_branch AS cachedDefaultBranch, html_url AS htmlUrl,
              added_by AS addedBy, added_at AS addedAt, active AS active
         FROM managed_selected_repo ORDER BY full_name ASC`,
    ),
    insertReportStmt: db.prepare(
      `WITH candidate(id, slug) AS (VALUES (?, ?))
       INSERT INTO managed_report (id, slug, filename, content_type, byte_size, sha256, uploaded_by, uploaded_by_login, repo_id, repo_directory, repo_embedded, analyzer, visible, bundle_id, bundle_integrity, uploaded_at, data_key, storage_encrypted)
       SELECT id, CASE WHEN EXISTS (SELECT 1 FROM managed_report WHERE slug = candidate.slug) THEN id ELSE slug END,
              ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM candidate`,
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
         LEFT JOIN managed_selected_repo sr ON sr.repo_id = r.repo_id
         LEFT JOIN managed_bundle b ON b.id = r.bundle_id
        WHERE (? IS NULL OR r.uploaded_by = ? OR EXISTS (
          SELECT 1 FROM managed_team_repo tr JOIN managed_team_user tu ON tu.team_id = tr.team_id
          JOIN managed_team t ON t.id = tu.team_id AND t.hidden = 0
          WHERE tr.repo_id = r.repo_id AND tu.user_id = ? AND ${REPORT_IN_TEAM_PATH_SQL}))
        ORDER BY r.uploaded_at DESC, r.filename ASC`,
    ),
    findingCatalogReportsStmt: db.prepare(`SELECT id, byte_size AS byteSize FROM managed_report WHERE id > ? ORDER BY id LIMIT ?`),
    selectReportStmt: db.prepare(
      `SELECT id, slug, filename, content_type AS contentType, byte_size AS byteSize,
              sha256, uploaded_by AS uploadedBy, uploaded_at AS uploadedAt,
              repo_id AS repoId, repo_directory AS repoDirectory, repo_embedded AS repoEmbedded,
              analyzer AS analyzer, visible AS visible, bundle_id AS bundleId
         FROM managed_report WHERE id = ?`,
    ),
    selectReportByHashStmt: db.prepare(
      `SELECT id FROM managed_report WHERE sha256 = ? AND COALESCE(analyzer, '') = COALESCE(?, '')
       ORDER BY uploaded_at, id LIMIT 1`,
    ),
    selectReportAccessStmt: db.prepare(
      `WITH requested AS (SELECT value AS id FROM json_each(?)), report_grants AS (
         SELECT r.id AS id, MAX(tu.view_dependencies) AS dependencies, MAX(tu.view_security) AS security
           FROM managed_report r JOIN requested q ON q.id = r.id
           JOIN managed_team_repo tr ON tr.repo_id = r.repo_id AND ${REPORT_IN_TEAM_PATH_SQL}
           JOIN managed_team_user tu ON tu.team_id = tr.team_id AND tu.user_id = ?
           JOIN managed_team t ON t.id = tu.team_id AND t.hidden = 0
          GROUP BY r.id
       )
       SELECT r.id AS id, r.filename AS filename, r.byte_size AS byteSize, r.sha256 AS sha256,
              r.repo_directory AS repoDirectory, sr.full_name AS repoFullName,
              COALESCE(g.dependencies, 0) AS dependencies, COALESCE(g.security, 0) AS security
         FROM managed_report r JOIN requested q ON q.id = r.id
         LEFT JOIN managed_selected_repo sr ON sr.repo_id = r.repo_id
         LEFT JOIN report_grants g ON g.id = r.id
        WHERE ? = 1 OR (? = 1 AND r.uploaded_by = ?)
           OR (g.id IS NOT NULL AND (? = 1 OR r.visible = 1))`,
    ),
    selectTeamAccessStmt: db.prepare(`SELECT 1 FROM managed_team_user tu JOIN managed_team t ON t.id = tu.team_id
      WHERE tu.user_id = ? AND tu.team_id = ? AND t.hidden = 0`),
    selectTeamRepositoriesStmt: db.prepare(
      `SELECT tr.repo_id AS repoId, sr.full_name AS github, tr.path AS path
         FROM managed_team_repo tr JOIN managed_selected_repo sr ON sr.repo_id = tr.repo_id
        WHERE tr.team_id = ? ORDER BY tr.repo_id, tr.path`,
    ),
    selectTeamReportAccessStmt: db.prepare(
      `SELECT DISTINCT r.id AS id, r.filename AS filename, r.byte_size AS byteSize, r.sha256 AS sha256, r.visible AS visible,
              r.repo_directory AS repoDirectory, sr.full_name AS repoFullName,
              tu.view_dependencies AS dependencies, tu.view_security AS security
         FROM managed_team_user tu
         JOIN managed_team t ON t.id = tu.team_id AND t.hidden = 0
         JOIN managed_team_repo tr ON tr.team_id = tu.team_id
         JOIN managed_report r ON r.repo_id = tr.repo_id AND ${REPORT_IN_TEAM_PATH_SQL}
         LEFT JOIN managed_selected_repo sr ON sr.repo_id = r.repo_id
        WHERE tu.user_id = ? AND tu.team_id = ? AND (r.visible = 1 OR (? = 1 AND r.id = ?))
        ORDER BY r.id`,
    ),
    reportFilenamesWithBundleHashStmt: db.prepare(`SELECT DISTINCT filename FROM managed_report WHERE bundle_id = ? AND sha256 = ?`),
    deleteReportStmt: db.prepare(`DELETE FROM managed_report WHERE id = ?`),
    setReportRepoStmt: db.prepare(`UPDATE managed_report SET repo_id = ?, repo_directory = ? WHERE id = ?`),
    setReportVisibleStmt: db.prepare(`UPDATE managed_report SET visible = ? WHERE id = ?`),
    upsertTriageStmt: db.prepare(
      `INSERT INTO managed_finding_triage (finding_id, color, triage, comment, fix, flagged, updated_by, updated_by_login, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(finding_id) DO UPDATE SET
         color = excluded.color, triage = excluded.triage, comment = excluded.comment,
         fix = excluded.fix, flagged = excluded.flagged, updated_by = excluded.updated_by,
         updated_by_login = excluded.updated_by_login, updated_at = excluded.updated_at`,
    ),
    selectTriageStateStmt: db.prepare(
      `SELECT color, triage, comment, fix, flagged FROM managed_finding_triage WHERE finding_id = ?`,
    ),
    insertTriageEventStmt: db.prepare(
      `INSERT INTO managed_finding_triage_event (finding_id, batch_id, color, triage, comment, fix, flagged, actor_id, actor_login, at, report_id, report, repo)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
         (SELECT filename FROM managed_report WHERE id = ?),
         (SELECT p.full_name FROM managed_report r JOIN managed_selected_repo p ON p.repo_id = r.repo_id WHERE r.id = ?))`,
    ),
    // With a retention limit set: keep the newest N events of a finding.
    trimTriageEventsStmt: db.prepare(
      `DELETE FROM managed_finding_triage_event
        WHERE finding_id = ?
          AND seq NOT IN (SELECT seq FROM managed_finding_triage_event WHERE finding_id = ? ORDER BY seq DESC LIMIT ?)`,
    ),
    selectTriageHistoryStmt: db.prepare(
      `SELECT e.seq AS seq, e.finding_id AS findingId, e.batch_id AS batchId, e.color AS color, e.triage AS triage,
              e.comment AS comment, e.fix AS fix, e.flagged AS flagged,
              u.id AS actorId, COALESCE(u.login, e.actor_login) AS actorLogin, u.name AS actorName, e.at AS at
         FROM managed_finding_triage_event e
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
         FROM managed_finding_triage t
         LEFT JOIN managed_user u ON u.id = t.updated_by
        WHERE t.finding_id IN (SELECT value FROM json_each(?))
        ORDER BY t.finding_id ASC`,
    ),
    annotationTriageRevisionStmt: db.prepare(`
      SELECT t.finding_id AS id,
        (SELECT e.batch_id FROM managed_finding_triage_event e
          WHERE e.finding_id = t.finding_id ORDER BY e.seq DESC LIMIT 1) AS revision
      FROM managed_finding_triage t WHERE t.finding_id IN (SELECT value FROM json_each(?))
      ORDER BY t.finding_id`),
    annotationCommentRevisionStmt: db.prepare(`
      SELECT id, version FROM managed_finding_comment
      WHERE finding_id IN (SELECT value FROM json_each(?)) ORDER BY id`),
    insertBundleStmt: db.prepare(
      `WITH candidate(id, slug) AS (VALUES (?, ?))
       INSERT INTO managed_bundle (id, slug, integrity, filename, kind, byte_size, uploaded_by, uploaded_by_login, repo_id, repo_directory, visible, uploaded_at, data_key, storage_encrypted)
       SELECT id, CASE WHEN EXISTS (SELECT 1 FROM managed_bundle WHERE slug = candidate.slug) THEN id ELSE slug END,
              ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM candidate`,
    ),
    selectBundleByIntegrityStmt: db.prepare(
      `SELECT id, slug, integrity, filename, kind, byte_size AS byteSize,
              uploaded_by AS uploadedBy, repo_id AS repoId, repo_directory AS repoDirectory, visible, uploaded_at AS uploadedAt
         FROM managed_bundle WHERE integrity = ?`,
    ),
    selectBundleStmt: db.prepare(
      `SELECT id, slug, integrity, filename, kind, byte_size AS byteSize,
              uploaded_by AS uploadedBy, repo_id AS repoId, repo_directory AS repoDirectory, visible, uploaded_at AS uploadedAt
         FROM managed_bundle WHERE id = ?`,
    ),
    selectBundlesStmt: db.prepare(
      `SELECT b.id AS id, b.slug AS slug, b.integrity AS integrity, b.filename AS filename, b.kind AS kind,
              b.byte_size AS byteSize, COALESCE(u.login, b.uploaded_by_login) AS uploadedByLogin,
              b.repo_id AS repoId, b.repo_directory AS repoDirectory, b.visible, sr.full_name AS repoFullName, b.uploaded_at AS uploadedAt
         FROM managed_bundle b
         LEFT JOIN managed_user u ON u.id = b.uploaded_by
         LEFT JOIN managed_selected_repo sr ON sr.repo_id = b.repo_id
        WHERE (? IS NULL OR (b.uploaded_by = ? OR EXISTS (
          SELECT 1 FROM managed_team_repo tr JOIN managed_team_user tu ON tu.team_id = tr.team_id
          JOIN managed_team t ON t.id = tu.team_id AND t.hidden = 0
          WHERE tr.repo_id = b.repo_id AND ${BUNDLE_IN_TEAM_PATH_SQL} AND tu.user_id = ?)))
        ORDER BY b.uploaded_at DESC, b.filename ASC`,
    ),
    selectBundleReadableStmt: db.prepare(
      `SELECT 1 FROM managed_bundle b WHERE b.id = ? AND (b.uploaded_by = ? OR EXISTS (
          SELECT 1 FROM managed_team_repo tr JOIN managed_team_user tu ON tu.team_id = tr.team_id
          JOIN managed_team t ON t.id = tu.team_id AND t.hidden = 0
          WHERE tr.repo_id = b.repo_id AND ${BUNDLE_IN_TEAM_PATH_SQL} AND tu.user_id = ?))`,
    ),
    selectReadableBundleIdsStmt: db.prepare(
      `SELECT b.id FROM managed_bundle b WHERE b.id IN (SELECT value FROM json_each(?)) AND (b.uploaded_by = ? OR EXISTS (
          SELECT 1 FROM managed_team_repo tr JOIN managed_team_user tu ON tu.team_id = tr.team_id
          JOIN managed_team t ON t.id = tu.team_id AND t.hidden = 0
          WHERE tr.repo_id = b.repo_id AND ${BUNDLE_IN_TEAM_PATH_SQL} AND tu.user_id = ?))`,
    ),
    selectRepoReadableStmt: db.prepare(
      `SELECT 1 FROM managed_team_repo tr JOIN managed_team_user tu ON tu.team_id = tr.team_id
         JOIN managed_team t ON t.id = tu.team_id AND t.hidden = 0
        WHERE tr.repo_id = ? AND tu.user_id = ? LIMIT 1`,
    ),
    selectRepoPathReadableStmt: db.prepare(
      `WITH r(repo_directory) AS (VALUES (?))
        SELECT 1 FROM r JOIN managed_team_repo tr ON tr.repo_id = ? AND ${REPORT_IN_TEAM_PATH_SQL}
        JOIN managed_team_user tu ON tu.team_id = tr.team_id
        JOIN managed_team t ON t.id = tu.team_id AND t.hidden = 0
        WHERE tu.user_id = ? LIMIT 1`,
    ),
    deleteBundleStmt: db.prepare(`DELETE FROM managed_bundle WHERE id = ?`),
    setBundleRepoStmt: db.prepare(`UPDATE managed_bundle SET repo_id = ?, repo_directory = ? WHERE id = ?`),
    setBundleVisibleStmt: db.prepare(`UPDATE managed_bundle SET visible = ? WHERE id = ?`),
    // Attach a freshly-stored bundle to the reports that declared its integrity
    // but haven't been linked yet (bundle uploaded after the report).
    linkReportsToBundleStmt: db.prepare(
      `UPDATE managed_report AS r SET bundle_id = ? WHERE bundle_integrity = ? AND bundle_id IS NULL
       AND (? IS NULL OR r.uploaded_by = ? OR EXISTS (SELECT 1 FROM managed_team_repo tr JOIN managed_team_user tu ON tu.team_id = tr.team_id
         JOIN managed_team t ON t.id = tu.team_id AND t.hidden = 0
         WHERE tu.user_id = ? AND tr.repo_id = r.repo_id AND ${REPORT_IN_TEAM_PATH_SQL}))`,
    ),
    // OR IGNORE: a duplicate name (UNIQUE) is the "taken" signal (0 changes); the
    // uuid PK never collides.
    insertTeamStmt: db.prepare(`WITH candidate(id, slug) AS (VALUES (?, ?))
      INSERT OR IGNORE INTO managed_team (id, slug, name, created_at, updated_at)
      SELECT id, CASE WHEN EXISTS (SELECT 1 FROM managed_team WHERE slug = candidate.slug) THEN id ELSE slug END,
             ?, ?, ? FROM candidate`),
    deleteTeamStmt: db.prepare(`DELETE FROM managed_team WHERE id = ?`),
    selectTeamStmt: db.prepare(`SELECT id, slug, name, hidden FROM managed_team WHERE id = ?`),
    selectTeamByNameStmt: db.prepare(`SELECT id FROM managed_team WHERE name = ?`),
    renameTeamStmt: db.prepare(`UPDATE managed_team SET name = ?, updated_at = ? WHERE id = ?`),
    setTeamHiddenStmt: db.prepare(`UPDATE managed_team SET hidden = ?, updated_at = ? WHERE id = ?`),
    selectTeamsStmt: db.prepare(`SELECT id, slug, name, hidden FROM managed_team ORDER BY name ASC`),
    selectTeamsForUserStmt: db.prepare(
      `SELECT t.id AS id, t.slug AS slug, t.name AS name,
              tu.view_dependencies AS dependencies, tu.view_security AS security
         FROM managed_team_user tu JOIN managed_team t ON t.id = tu.team_id
        WHERE tu.user_id = ? AND t.hidden = 0 ORDER BY t.name ASC, t.id ASC`,
    ),
    selectUserTeamScopesStmt: db.prepare(
      `SELECT tr.team_id AS teamId, tr.repo_id AS repoId, tr.path AS path, sr.full_name AS fullName
         FROM managed_team_repo tr JOIN managed_team_user tu ON tu.team_id = tr.team_id
         JOIN managed_team t ON t.id = tu.team_id AND t.hidden = 0
         JOIN managed_selected_repo sr ON sr.repo_id = tr.repo_id
        WHERE tu.user_id = ? ORDER BY tr.team_id, tr.repo_id, tr.path`,
    ),
    // Reports attached to the repos of the user's teams, tagged by team (a report
    // shows under every team whose repo it's attached to). Newest first.
    selectUserTeamReportsStmt: db.prepare(
      `SELECT DISTINCT tr.team_id AS teamId, r.id AS id, r.slug AS slug, r.filename AS filename, r.analyzer, r.visible, r.uploaded_at,
              r.sha256 AS sha256, r.bundle_id AS bundleId, r.repo_id AS repoId, r.repo_directory AS repoDirectory, sr.full_name AS repoFullName,
              tu.view_dependencies AS dependencies, tu.view_security AS security,
              (SELECT role FROM managed_user WHERE id = tu.user_id) AS role
         FROM managed_team_user tu
         JOIN managed_team t ON t.id = tu.team_id AND t.hidden = 0
         JOIN managed_team_repo tr ON tr.team_id = tu.team_id
         JOIN managed_report r ON r.repo_id = tr.repo_id AND ${REPORT_IN_TEAM_PATH_SQL}
         LEFT JOIN managed_selected_repo sr ON sr.repo_id = r.repo_id
        WHERE tu.user_id = ? AND (r.visible = 1 OR (SELECT role FROM managed_user WHERE id = tu.user_id) IN ('admin', 'manage'))
        ORDER BY r.uploaded_at DESC, r.filename ASC, r.id ASC`,
    ),
    // Bundles are scoped through the same team -> repository links as reports.
    // Hidden bundles remain available to managers within their team scopes.
    selectUserTeamBundlesStmt: db.prepare(
      `SELECT DISTINCT tr.team_id AS teamId, b.id AS id, b.slug AS slug, b.integrity AS integrity,
              b.filename AS filename, b.kind, b.visible, b.byte_size AS byteSize, b.repo_id AS repoId, b.repo_directory AS repoDirectory, sr.full_name AS repoFullName, b.uploaded_at
         FROM managed_team_user tu
         JOIN managed_team t ON t.id = tu.team_id AND t.hidden = 0
         JOIN managed_team_repo tr ON tr.team_id = tu.team_id
         JOIN managed_bundle b ON b.repo_id = tr.repo_id AND ${BUNDLE_IN_TEAM_PATH_SQL}
         JOIN managed_selected_repo sr ON sr.repo_id = b.repo_id
        WHERE tu.user_id = ? AND (b.visible = 1 OR (SELECT role FROM managed_user WHERE id = tu.user_id) IN ('admin', 'manage'))
        ORDER BY b.uploaded_at DESC, b.filename ASC, b.id ASC`,
    ),
    selectUserRepoScopesStmt: db.prepare(
      `SELECT DISTINCT tr.repo_id AS repoId, NULLIF(tr.path, '') AS path
         FROM managed_team_repo tr JOIN managed_team_user tu ON tu.team_id = tr.team_id
         JOIN managed_team t ON t.id = tu.team_id AND t.hidden = 0
        WHERE tu.user_id = ?`,
    ),
    // A report is readable iff one of the user's team scopes contains it.
    selectReportReadableStmt: db.prepare(
      `SELECT 1 FROM managed_report r
         JOIN managed_team_repo tr ON tr.repo_id = r.repo_id AND ${REPORT_IN_TEAM_PATH_SQL}
         JOIN managed_team_user tu ON tu.team_id = tr.team_id
        JOIN managed_team t ON t.id = tu.team_id AND t.hidden = 0
        WHERE r.id = ? AND tu.user_id = ? LIMIT 1`,
    ),
    selectBundleSecurityStmt: db.prepare(
      `SELECT 1 FROM managed_bundle b
         JOIN managed_team_repo tr ON tr.repo_id = b.repo_id AND ${BUNDLE_IN_TEAM_PATH_SQL}
         JOIN managed_team_user tu ON tu.team_id = tr.team_id
        JOIN managed_team t ON t.id = tu.team_id AND t.hidden = 0
        WHERE b.id = ? AND tu.user_id = ? AND tu.view_security = 1
          AND (? IS NULL OR tr.team_id = ?) LIMIT 1`,
    ),
    // The viewer's effective visibility permissions for a report: OR'd (MAX over
    // 0/1) across memberships whose repository path contains the report. NULLs
    // (no such membership) read as 0 = no permission.
    selectReportPermsStmt: db.prepare(
      `SELECT MAX(tu.view_dependencies) AS dependencies, MAX(tu.view_security) AS security
         FROM managed_report r
         JOIN managed_team_repo tr ON tr.repo_id = r.repo_id AND ${REPORT_IN_TEAM_PATH_SQL}
         JOIN managed_team_user tu ON tu.team_id = tr.team_id AND tu.user_id = ?
         JOIN managed_team t ON t.id = tu.team_id AND t.hidden = 0
        WHERE r.id = ?`,
    ),
    selectUserOptionsStmt: db.prepare(`SELECT id, login, name, role FROM managed_user ORDER BY login ASC`),
    selectTeamReposStmt: db.prepare(
      `SELECT tr.team_id AS teamId, tr.repo_id AS repoId, sr.full_name AS fullName, NULLIF(tr.path, '') AS path
         FROM managed_team_repo tr JOIN managed_selected_repo sr ON sr.repo_id = tr.repo_id
        ORDER BY sr.full_name ASC, tr.path ASC`,
    ),
    selectTeamMembersStmt: db.prepare(
      `SELECT tu.team_id AS teamId, tu.user_id AS userId, u.login AS login,
              tu.view_dependencies AS viewDependencies, tu.view_security AS viewSecurity
         FROM managed_team_user tu JOIN managed_user u ON u.id = tu.user_id
        ORDER BY u.login ASC`,
    ),
    upsertTeamRepoStmt: db.prepare(
      `INSERT OR IGNORE INTO managed_team_repo (team_id, repo_id, path)
       SELECT ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM managed_team_repo WHERE team_id = ? AND repo_id = ? AND path = '')`,
    ),
    deleteTeamRepoStmt: db.prepare(`DELETE FROM managed_team_repo WHERE team_id = ? AND repo_id = ?`),
    deleteTeamRepoPathStmt: db.prepare(`DELETE FROM managed_team_repo WHERE team_id = ? AND repo_id = ? AND path = ?`),
    upsertTeamMemberStmt: db.prepare(
      `INSERT INTO managed_team_user (team_id, user_id, view_dependencies, view_security) VALUES (?, ?, ?, ?)
       ON CONFLICT(team_id, user_id) DO UPDATE SET
         view_dependencies = excluded.view_dependencies, view_security = excluded.view_security`,
    ),
    deleteTeamMemberStmt: db.prepare(`DELETE FROM managed_team_user WHERE team_id = ? AND user_id = ?`),
  }
}

type RepoRow = {
  repoId: number; fullName: string; priv: number; installId: number | null
  branch: string; cachedDefaultBranch: string | null; htmlUrl: string; addedBy: string | null; addedAt: number; active: number
}

// The repo-selection slice of ManagedDb, split out to keep openSqliteManagedDb
// within the per-function line budget. Closes over its prepared statements.
function selectedRepoMethods(stmts: ReturnType<typeof prepareStatements>) {
  const { upsertRepoStmt, deleteRepoStmt, deactivateRepoStmt, reactivateRepoStmt, selectReposStmt, selectAllReposStmt,
    selectReportsForRepoStmt, selectBundlesForRepoStmt, deleteReportsForRepoStmt, deleteBundlesForRepoStmt } = stmts
  const readRepo = (r: RepoRow): SelectedRepo => ({
    repoId: r.repoId, fullName: r.fullName, private: r.priv === 1,
    installationId: r.installId, defaultBranch: r.branch, cachedDefaultBranch: r.cachedDefaultBranch, htmlUrl: r.htmlUrl,
    addedBy: r.addedBy, addedAt: r.addedAt,
  })
  const readManagedRepo = (r: RepoRow): ManagedRepo => ({ ...readRepo(r), active: r.active === 1 })
  return {
    async selectRepo(repo: SelectedRepoInput, now: number): Promise<void> {
      await upsertRepoStmt.run(
        repo.repoId, repo.fullName, repo.private ? 1 : 0, repo.installationId,
        repo.defaultBranch, repo.htmlUrl, repo.addedBy, now, now,
      )
    },
    async cacheRepoDefaultBranch(repo: SelectedRepo, branch: string | null): Promise<boolean> {
      return Number((await stmts.cacheRepoDefaultBranchStmt.run(branch, repo.repoId, repo.fullName, repo.addedAt)).changes) > 0
    },
    async deselectRepo(repoId: number): Promise<boolean> {
      return Number((await deleteRepoStmt.run(repoId)).changes) > 0
    },
    async connectRepoInstallation(repo: SelectedRepo, installationId: number, sessionId: string, now: number): Promise<boolean> {
      return Number((await stmts.connectRepoInstallationStmt.run(installationId, now, repo.repoId, repo.fullName, repo.addedAt, sessionId, now)).changes) > 0
    },
    async listSelectedRepos(): Promise<SelectedRepo[]> {
      const rows = (await selectReposStmt.all()) as RepoRow[]
      return rows.map(readRepo)
    },
    async listAllRepos(): Promise<ManagedRepo[]> {
      const rows = (await selectAllReposStmt.all()) as RepoRow[]
      return rows.map(readManagedRepo)
    },
    async deactivateRepo(repoId: number): Promise<boolean> {
      return Number((await deactivateRepoStmt.run(repoId)).changes) > 0
    },
    async reactivateRepo(repoId: number): Promise<boolean> {
      return Number((await reactivateRepoStmt.run(repoId)).changes) > 0
    },
    async deleteRepo(repoId: number): Promise<boolean> {
      return Number((await deleteRepoStmt.run(repoId)).changes) > 0
    },
    async listReportsForRepo(repoId: number): Promise<RepoReportItem[]> {
      return (await selectReportsForRepoStmt.all(repoId)) as unknown as RepoReportItem[]
    },
    async listBundlesForRepo(repoId: number): Promise<RepoDataItem[]> {
      return (await selectBundlesForRepoStmt.all(repoId)) as unknown as RepoDataItem[]
    },
    async deleteReportsForRepo(repoId: number): Promise<number> {
      return Number((await deleteReportsForRepoStmt.run(repoId)).changes)
    },
    async deleteBundlesForRepo(repoId: number): Promise<number> {
      return Number((await deleteBundlesForRepoStmt.run(repoId)).changes)
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
  bundleId: string | null
}

// Byte storage may outlast a logout or grant change. HTTP uploads reauthorize
// inside the metadata writer transaction after their bytes have been stored.
async function authorizeUpload(stmts: ReturnType<typeof prepareStatements>, sessionId: string | undefined,
  item: { uploadedBy: string | null; repoId: number | null; repoDirectory?: string }) {
  if (sessionId === undefined) return // Trusted imports and fixtures use the raw store API.
  const user = await stmts.selectSessionStmt.get(sessionId, Date.now()) as SessionRow | undefined
  if (!user) throw new ManagedMutationError(401, 'unauthenticated')
  if (user.uid !== item.uploadedBy || !roleAtLeast(user.role, 'manage')) throw new ManagedMutationError(403, 'forbidden')
  if (item.repoId === null) return
  if (!(await stmts.selectReposStmt.all() as RepoRow[]).some(repo => repo.repoId === item.repoId)) throw new ManagedMutationError(400, 'repo-not-selected')
  if (user.role !== 'admin' && !await stmts.selectRepoPathReadableStmt.get(item.repoDirectory ?? '', item.repoId, user.uid)) throw new ManagedMutationError(403, 'repo-forbidden')
}

// The report slice of ManagedDb closes over its prepared statements.
function reportMethods(stmts: ReturnType<typeof prepareStatements>, db: ManagedSql, key: StorageKey | null) {
  const { insertReportStmt, selectReportsStmt, selectReportStmt, deleteReportStmt, setReportRepoStmt, setReportVisibleStmt } = stmts
  async function getReport(id: string): Promise<ReportRecord | null> {
    const row = (await selectReportStmt.get(id)) as ReportRow | undefined
    if (row == null) return null
    return { ...row, repoEmbedded: row.repoEmbedded === 1, visible: row.visible === 1 }
  }
  async function getReportByHash(sha256: string, analyzer: string | null): Promise<ReportRecord | null> {
    const row = await stmts.selectReportByHashStmt.get(sha256, analyzer) as { id: string } | undefined
    return row ? getReport(row.id) : null
  }
  async function insertReport(report: ReportRecordInput, now: number): Promise<void> {
    await validateStorageUpload(db, key, 'report', report.id, report.dataKey)
    await insertReportStmt.run(
      report.id, preferredSlug(report.id), report.filename, report.contentType, report.byteSize,
      report.sha256, report.uploadedBy, report.uploadedByLogin ?? null, report.repoId,
      report.repoDirectory ?? '', report.repoEmbedded ? 1 : 0, report.analyzer ?? null, report.visible == null ? 0 : report.visible ? 1 : 0, report.bundleId ?? null,
      report.bundleIntegrity ?? null, now, report.dataKey ?? null, report.dataKey ? 1 : 0,
    )
  }
  return {
    insertReport,
    getReport,
    resolveReportUpload: getReport,
    getReportByHash,
    async insertOrReuseReport(report: ReportRecordInput, now: number, sessionId?: string): Promise<ReportRecord> {
      await authorizeUpload(stmts, sessionId, report)
      // The driver holds its writer lock for this whole operation. Checking
      // again here closes the race between the HTTP lookup and blob upload.
      const existing = await getReportByHash(report.sha256, report.analyzer ?? null)
      if (existing) return existing
      await insertReport(report, now)
      return (await getReport(report.id))!
    },
    async listReports(userId?: string): Promise<AdminReport[]> {
      const rows = (await selectReportsStmt.all(userId ?? null, userId ?? null, userId ?? null)) as ReportListRow[]
      return rows.map((r) => ({
        id: r.id, slug: r.slug, filename: r.filename, contentType: r.contentType, byteSize: r.byteSize,
        sha256: r.sha256, uploadedByLogin: r.uploadedByLogin,
        repoId: r.repoId, repoFullName: r.repoFullName,
        repoDirectory: r.repoDirectory, repoEmbedded: r.repoEmbedded === 1, analyzer: r.analyzer, visible: r.visible === 1,
        bundleId: r.bundleId, bundleFilename: r.bundleFilename, bundleIntegrity: r.bundleIntegrity,
        uploadedAt: r.uploadedAt,
      }))
    },
    async listFindingCatalogReports(after: string, limit: number): Promise<Pick<ReportRecord, 'id' | 'byteSize'>[]> {
      return await stmts.findingCatalogReportsStmt.all(after, limit) as Pick<ReportRecord, 'id' | 'byteSize'>[]
    },
    async getTeamReportAccessSnapshot(sessionId: string, now: number, teamId: string, reportId: string | null = null): Promise<TeamReportAccessSnapshot | null> {
      const session = await stmts.selectSessionStmt.get(sessionId, now) as SessionRow | undefined
      if (!session) return null
      const user: StoredUser = { id: session.uid, login: session.login, name: session.name, avatarUrl: session.avatar, role: session.role }
      if (user.role === 'none' || !await stmts.selectTeamAccessStmt.get(user.id, teamId)) return { user, teamId: null, reports: [], repositories: [] }
      const whole = user.role === 'admin' || user.role === 'manage'
      const rows = await stmts.selectTeamReportAccessStmt.all(user.id, teamId, whole ? 1 : 0, reportId) as {
        id: string; filename: string; byteSize: number; sha256: string; repoDirectory: string
        repoFullName: string | null; dependencies: number; security: number; visible: number
      }[]
      // Only privileged callers can receive a hidden row from this query. Give
      // that individual preview its own capacity; published report selections
      // still use the complete workspace for cross-report classification.
      const hidden = rows.find(row => row.id === reportId && row.visible === 0)
      const selected = hidden ? [hidden] : rows
      const repositories = await stmts.selectTeamRepositoriesStmt.all(teamId) as TeamReportAccessSnapshot['repositories']
      return { user, teamId, reportId, hiddenReportId: hidden?.id ?? null, repositories, linkRevision: await linkRevision(db), reports: selected.map(row => ({
        id: row.id, filename: row.filename, byteSize: row.byteSize, sha256: row.sha256,
        repo: { github: row.repoFullName, directory: row.repoDirectory },
        permissions: { dependencies: whole || row.dependencies === 1, security: whole || row.security === 1 },
      })) }
    },
    async getReportAccessSnapshot(sessionId: string, now: number, ids: readonly string[]): Promise<ReportAccessSnapshot | null> {
      const session = await stmts.selectSessionStmt.get(sessionId, now) as SessionRow | undefined
      if (!session) return null
      const user: StoredUser = { id: session.uid, login: session.login, name: session.name, avatarUrl: session.avatar, role: session.role }
      if (user.role === 'none' || ids.length === 0) return { user, reports: [] }
      const admin = user.role === 'admin', manage = user.role === 'manage'
      const rows = await stmts.selectReportAccessStmt.all(JSON.stringify([...new Set(ids)]), user.id,
        admin ? 1 : 0, manage ? 1 : 0, user.id, manage ? 1 : 0) as {
        id: string; filename: string; byteSize: number; sha256: string; repoDirectory: string
        repoFullName: string | null; dependencies: number; security: number
      }[]
      return { user, linkRevision: await linkRevision(db), reports: rows.map(row => ({
        id: row.id, filename: row.filename, byteSize: row.byteSize, sha256: row.sha256,
        repo: { github: row.repoFullName, directory: row.repoDirectory },
        permissions: { dependencies: admin || manage || row.dependencies === 1, security: admin || manage || row.security === 1 },
      })) }
    },
    async listReportFilenamesWithBundleHash(bundleId: string, sha256: string): Promise<string[]> {
      const rows = (await stmts.reportFilenamesWithBundleHashStmt.all(bundleId, sha256)) as { filename: string }[]
      return rows.map(row => row.filename)
    },
    async deleteReport(id: string): Promise<boolean> {
      return Number((await deleteReportStmt.run(id)).changes) > 0
    },
    async setReportRepo(id: string, repoId: number | null, repoDirectory = ''): Promise<boolean> {
      return Number((await setReportRepoStmt.run(repoId, repoId == null ? '' : repoDirectory, id)).changes) > 0
    },
    async setReportVisible(id: string, visible: boolean): Promise<boolean> {
      return Number((await setReportVisibleStmt.run(visible ? 1 : 0, id)).changes) > 0
    },
  }
}

type TriageDbRow = {
  findingId: string; color: string | null; triage: string | null
  comment: string | null; fix: string | null; flagged: number | null
  updatedByLogin: string | null; updatedAt: number
}
type TriageStateDbRow = { color: string | null; triage: string | null; comment: string | null; fix: string | null; flagged: number | null }
type TriageEventDbRow = TriageStateDbRow & {
  seq: number; findingId: string; batchId: string; actorId: string | null; actorLogin: string | null; actorName: string | null; at: number
}

// The per-finding triage slice of ManagedDb. Closes over its prepared
// statements (and the handle, for the batch write's transaction). A
// null/empty entry writes the tombstone — every field NULL, writer and time
// stamped — so a later reader learns the entry was cleared rather than never
// set. Every change is also appended to the trail; a write equal to the
// current row is skipped altogether, so a client re-pushing what already
// stands neither re-stamps the writer nor echoes into the trail. `historyLimit`
// > 0 keeps only that many events per finding; 0 keeps everything.
function triageMethods(stmts: ReturnType<typeof prepareStatements>, historyLimit: number, db: ManagedSql) {
  const { upsertTriageStmt, selectTriageStmt, selectTriageStateStmt, insertTriageEventStmt, trimTriageEventsStmt, selectTriageHistoryStmt,
    deleteTriageStmt, deleteTriageHistoryStmt, deleteCommentsStmt, deleteCommentHistoryStmt, countAnnotationsStmt } = stmts
  async function writeEntry(findingId: string, entry: TriageEntryPatch | null, batchId: string, updatedBy: string | null, updatedByLogin: string | null, now: number, reportId: string | null = null): Promise<void> {
    const e = entry ?? {}
    // `flagged: false` is a real value (the explicit un-flag tombstone), so it
    // is 0 here and only null/absent maps to NULL.
    const next: TriageStateDbRow = {
      color: e.color ?? null, triage: e.triage ?? null, comment: e.comment ?? null,
      fix: e.fix ?? null, flagged: e.flagged == null ? null : (e.flagged ? 1 : 0),
    }
    const cur = (await selectTriageStateStmt.get(findingId)) as TriageStateDbRow | undefined
    if (cur != null && cur.color === next.color && cur.triage === next.triage && cur.comment === next.comment
      && cur.fix === next.fix && cur.flagged === next.flagged) return
    await upsertTriageStmt.run(findingId, next.color, next.triage, next.comment, next.fix, next.flagged, updatedBy, updatedByLogin, now)
    await insertTriageEventStmt.run(findingId, batchId, next.color, next.triage, next.comment, next.fix, next.flagged, updatedBy, updatedByLogin, now, reportId, reportId, reportId)
    if (historyLimit > 0) await trimTriageEventsStmt.run(findingId, findingId, historyLimit)
  }
  return {
    async getAnnotationRevision(findingIds: readonly string[]): Promise<string> {
      if (findingIds.length === 0) return '[]'
      const ids = JSON.stringify(findingIds)
      // Batch UUIDs survive history trimming and distinguish same-timestamp
      // writes, even if SQLite reuses a sequence after an annotation purge.
      return JSON.stringify([
        await stmts.annotationTriageRevisionStmt.all(ids),
        await stmts.annotationCommentRevisionStmt.all(ids),
      ])
    },
    async deleteTriage(findingIds: readonly string[]): Promise<number> {
      if (findingIds.length === 0) return 0
      const ids = JSON.stringify(findingIds)
      const { total: deleted } = (await countAnnotationsStmt.get(ids, ids, ids)) as { total: number }
      await deleteTriageStmt.run(ids)
      await deleteTriageHistoryStmt.run(ids)
      await deleteCommentsStmt.run(ids)
      await deleteCommentHistoryStmt.run(ids)
      return deleted
    },
    async listTriageHistory(findingId: string, limit: number): Promise<TriageEventRow[]> {
      const rows = (await selectTriageHistoryStmt.all(findingId, limit)) as TriageEventDbRow[]
      return rows.map((r) => ({
        seq: r.seq, findingId: r.findingId, batchId: r.batchId,
        color: r.color, triage: r.triage, comment: r.comment, fix: r.fix,
        flagged: r.flagged == null ? null : r.flagged === 1,
        actorId: r.actorId, actorLogin: r.actorLogin, actorName: r.actorName, at: r.at,
      }))
    },
    async listTriage(findingIds: readonly string[]): Promise<TriageRow[]> {
      if (findingIds.length === 0) return []
      const rows = (await selectTriageStmt.all(JSON.stringify(findingIds))) as TriageDbRow[]
      return rows.map((r) => ({
        findingId: r.findingId, color: r.color, triage: r.triage, comment: r.comment, fix: r.fix,
        flagged: r.flagged == null ? null : r.flagged === 1,
        updatedByLogin: r.updatedByLogin, updatedAt: r.updatedAt,
      }))
    },
    async setTriage(findingId: string, entry: TriageEntryPatch | null, updatedBy: string | null, updatedByLogin: string | null, now: number): Promise<void> {
      // A single write is its own batch. The row and its event go together.
      await writeEntry(findingId, entry, randomUUID(), updatedBy, updatedByLogin, now)
    },
    async setTriageEntries(entries: readonly (readonly [string, TriageEntryPatch | null])[], updatedBy: string | null, updatedByLogin: string | null, now: number, reportId?: string): Promise<void> {
      // One transaction, so a batch is never half-applied by a mid-loop error
      // (and costs one fsync under synchronous = FULL, not one per row); one
      // batch id groups its rows in the trail.
      const batchId = randomUUID()
      if (new Set(entries.map(([id]) => id)).size !== entries.length) {
        // Preserve the ordered history of callers that supply repeated IDs.
        for (const [id, entry] of entries) await writeEntry(id, entry, batchId, updatedBy, updatedByLogin, now, reportId)
        return
      }
      const current = new Map((await selectTriageStmt.all(JSON.stringify(entries.map(([id]) => id))) as TriageDbRow[])
        .map(row => [row.findingId, row]))
      const changed = entries.flatMap(([id, entry]) => {
        const e = entry ?? {}, previous = current.get(id)
        const next = { color: e.color ?? null, triage: e.triage ?? null, comment: e.comment ?? null,
          fix: e.fix ?? null, flagged: e.flagged == null ? null : e.flagged ? 1 : 0 }
        if (previous && Object.entries(next).every(([key, value]) => previous[key as keyof TriageStateDbRow] === value)) return []
        return [[id, next.color, next.triage, next.comment, next.fix, next.flagged]]
      })
      // Bound SQL parameters while keeping the entire batch/history atomic.
      for (let offset = 0; offset < changed.length; offset += 200) {
        const rows = changed.slice(offset, offset + 200), values = rows.flat()
        const input = `WITH changes(finding_id, color, triage, comment, fix, flagged, ordinal) AS
          (VALUES ${rows.map((_, index) => `(?, ?, ?, ?, ?, CAST(? AS INTEGER), ${index})`).join(',')})`
        await db.prepare(`${input}
          INSERT INTO managed_finding_triage (finding_id, color, triage, comment, fix, flagged, updated_by, updated_by_login, updated_at)
          SELECT finding_id, color, triage, comment, fix, flagged, ?, ?, CAST(? AS BIGINT) FROM changes WHERE TRUE
          ON CONFLICT(finding_id) DO UPDATE SET color = excluded.color, triage = excluded.triage,
            comment = excluded.comment, fix = excluded.fix, flagged = excluded.flagged, updated_by = excluded.updated_by,
            updated_by_login = excluded.updated_by_login, updated_at = excluded.updated_at`).run(...values, updatedBy, updatedByLogin, now)
        await db.prepare(`${input}
          INSERT INTO managed_finding_triage_event (finding_id, batch_id, color, triage, comment, fix, flagged, actor_id, actor_login, at, report_id, report, repo)
          SELECT c.finding_id, ?, c.color, c.triage, c.comment, c.fix, c.flagged, ?, ?, CAST(? AS BIGINT), ?, r.filename, p.full_name
          FROM changes c LEFT JOIN managed_report r ON r.id = ? LEFT JOIN managed_selected_repo p ON p.repo_id = r.repo_id ORDER BY c.ordinal`)
          .run(...values, batchId, updatedBy, updatedByLogin, now, reportId ?? null, reportId ?? null)
        if (historyLimit > 0) {
          await db.prepare(`DELETE FROM managed_finding_triage_event WHERE seq IN (
          SELECT seq FROM (SELECT seq, ROW_NUMBER() OVER (PARTITION BY finding_id ORDER BY seq DESC) AS position
            FROM managed_finding_triage_event WHERE finding_id IN (SELECT value FROM json_each(?))) ranked WHERE position > ?)`)
          .run(JSON.stringify(rows.map(row => row[0])), historyLimit)
        }
      }
    },
  }
}

type BundleRow = {
  visible: number
  id: string; slug: string; integrity: string; filename: string; kind: string | null; byteSize: number
  uploadedBy: string | null; repoId: number | null; repoDirectory: string; uploadedAt: number
}
type BundleListRow = {
  visible: number
  id: string; slug: string; integrity: string; filename: string; kind: string | null; byteSize: number
  uploadedByLogin: string | null; repoId: number | null; repoFullName: string | null; repoDirectory: string; uploadedAt: number
}

function mapBundle(r: BundleRow): ManagedBundle {
  return {
    id: r.id, slug: r.slug, integrity: r.integrity, filename: r.filename, kind: r.kind,
    byteSize: r.byteSize, uploadedBy: r.uploadedBy, repoId: r.repoId, repoDirectory: r.repoDirectory, uploadedAt: r.uploadedAt, visible: r.visible === 1,
  }
}

// The bundle slice of ManagedDb. Closes over its prepared statements.
function bundleMethods(stmts: ReturnType<typeof prepareStatements>, db: ManagedSql, key: StorageKey | null) {
  const {
    insertBundleStmt, selectBundleByIntegrityStmt, selectBundleStmt,
    selectBundlesStmt, deleteBundleStmt, setBundleRepoStmt, linkReportsToBundleStmt, selectBundleReadableStmt, selectRepoReadableStmt, selectRepoPathReadableStmt,
  } = stmts
  async function getBundleByIntegrity(integrity: string): Promise<ManagedBundle | null> {
    const row = (await selectBundleByIntegrityStmt.get(integrity)) as BundleRow | undefined
    return row == null ? null : mapBundle(row)
  }
  return {
    async insertBundle(bundle: BundleInput, now: number, sessionId?: string): Promise<void> {
      await authorizeUpload(stmts, sessionId, bundle)
      await validateStorageUpload(db, key, 'bundle', bundle.id, bundle.dataKey)
      await insertBundleStmt.run(
        bundle.id, preferredSlug(bundle.id), bundle.integrity, bundle.filename, bundle.kind,
        bundle.byteSize, bundle.uploadedBy, bundle.uploadedByLogin ?? null, bundle.repoId, bundle.repoId == null ? '' : bundle.repoDirectory ?? '', bundle.visible === false ? 0 : 1, now, bundle.dataKey ?? null, bundle.dataKey ? 1 : 0,
      )
    },
    getBundleByIntegrity,
    // The distinct method name selects a writer-locked reconciliation scope.
    resolveBundleUpload: getBundleByIntegrity,
    async getBundle(id: string): Promise<ManagedBundle | null> {
      const row = (await selectBundleStmt.get(id)) as BundleRow | undefined
      return row == null ? null : mapBundle(row)
    },
    async getBundleAccessSnapshot(sessionId: string, now: number, id: string, advisoriesTeamId?: string | null) {
      const session = await stmts.selectSessionStmt.get(sessionId, now) as SessionRow | undefined
      if (!session) return null
      const denied = { bundle: null, canReadAdvisories: false }
      if (!roleAtLeast(session.role, 'view')) return denied
      const row = await selectBundleStmt.get(id) as BundleRow | undefined
      if (!row) return denied
      const manager = roleAtLeast(session.role, 'manage')
      if (!manager && row.visible !== 1) return denied
      if (session.role !== 'admin') {
        const allowed = manager ? await selectBundleReadableStmt.get(id, session.uid, session.uid)
          : row.repoId !== null && await selectRepoPathReadableStmt.get(row.repoDirectory, row.repoId, session.uid)
        if (!allowed) return denied
      }
      const canReadAdvisories = manager || (advisoriesTeamId !== undefined
        && await stmts.selectBundleSecurityStmt.get(id, session.uid, advisoriesTeamId, advisoriesTeamId) != null)
      return { bundle: mapBundle(row), canReadAdvisories }
    },
    async listBundles(userId?: string): Promise<AdminBundle[]> {
      const rows = (await selectBundlesStmt.all(userId ?? null, userId ?? null, userId ?? null)) as BundleListRow[]
      return rows.map((r) => ({
        id: r.id, slug: r.slug, integrity: r.integrity, filename: r.filename, kind: r.kind, byteSize: r.byteSize,
        uploadedByLogin: r.uploadedByLogin, repoId: r.repoId, repoFullName: r.repoFullName, repoDirectory: r.repoDirectory, visible: r.visible === 1,
        uploadedAt: r.uploadedAt,
      }))
    },
    async userCanReadBundle(userId: string, id: string): Promise<boolean> {
      return (await selectBundleReadableStmt.get(id, userId, userId)) != null
    },
    async listReadableBundleIds(userId: string, ids: readonly string[]): Promise<string[]> {
      if (ids.length === 0) return []
      const rows = await stmts.selectReadableBundleIdsStmt.all(JSON.stringify([...new Set(ids)]), userId, userId) as { id: string }[]
      return rows.map(row => row.id)
    },
    async userCanReadRepo(userId: string, repoId: number): Promise<boolean> {
      return (await selectRepoReadableStmt.get(repoId, userId)) != null
    },
    async userCanReadRepoPath(userId: string, repoId: number, directory: string): Promise<boolean> {
      return (await selectRepoPathReadableStmt.get(directory, repoId, userId)) != null
    },
    async deleteBundle(id: string): Promise<boolean> {
      return Number((await deleteBundleStmt.run(id)).changes) > 0
    },
    async setBundleVisible(id: string, visible: boolean): Promise<boolean> {
      return Number((await stmts.setBundleVisibleStmt.run(visible ? 1 : 0, id)).changes) > 0
    },
    async setBundleRepo(id: string, repoId: number | null, directory?: string): Promise<boolean> {
      return Number((await setBundleRepoStmt.run(repoId, repoId == null ? '' : directory ?? '', id)).changes) > 0
    },
    async linkReportsToBundle(integrity: string, bundleId: string, userId?: string): Promise<void> {
      await linkReportsToBundleStmt.run(bundleId, integrity, userId ?? null, userId ?? null, userId ?? null)
    },
  }
}

type TeamRow = { id: string; slug: string; name: string; hidden: number }
type TeamRepoRow = { teamId: string; repoId: number; fullName: string; path: string | null }
type TeamMemberRow = { teamId: string; userId: string; login: string; viewDependencies: number; viewSecurity: number }

// The team slice of ManagedDb. listTeams reads the three tables in full and
// groups in JS (3 queries, not N+1) — fine for the handful of teams a managed
// workspace has.
function teamMethods(stmts: ReturnType<typeof prepareStatements>, db: ManagedSql) {
  const {
    insertTeamStmt, selectTeamByNameStmt, renameTeamStmt, setTeamHiddenStmt, deleteTeamStmt, selectTeamStmt,
    selectUserRepoScopesStmt, selectTeamsStmt, selectTeamsForUserStmt, selectUserTeamReportsStmt, selectUserTeamBundlesStmt, selectReportReadableStmt,
    selectReportPermsStmt, selectUserOptionsStmt, selectTeamReposStmt, selectTeamMembersStmt,
    upsertTeamRepoStmt, deleteTeamRepoStmt, deleteTeamRepoPathStmt, upsertTeamMemberStmt, deleteTeamMemberStmt,
  } = stmts
  const methods = {
    async createTeam(id: string, name: string, now: number): Promise<boolean> {
      return Number((await insertTeamStmt.run(id, preferredSlug(id), name, now, now)).changes) > 0
    },
    async renameTeam(id: string, name: string, now: number): Promise<'ok' | 'name-taken' | 'not-found'> {
      // The operation transaction serializes the existence/name checks and rename.
      if ((await selectTeamStmt.get(id)) == null) return 'not-found'
      const clash = (await selectTeamByNameStmt.get(name)) as { id: string } | undefined
      if (clash != null && clash.id !== id) return 'name-taken'
      await renameTeamStmt.run(name, now, id)
      return 'ok'
    },
    async deleteTeam(id: string): Promise<boolean> {
      return Number((await deleteTeamStmt.run(id)).changes) > 0
    },
    async setTeamHidden(id: string, hidden: boolean, now: number): Promise<boolean> {
      return Number((await setTeamHiddenStmt.run(hidden ? 1 : 0, now, id)).changes) > 0
    },
    async getTeam(id: string): Promise<{ id: string; slug: string; name: string; hidden: boolean } | null> {
      const row = (await selectTeamStmt.get(id)) as TeamRow | undefined
      return row == null ? null : { id: row.id, slug: row.slug, name: row.name, hidden: row.hidden === 1 }
    },
    async listUserOptions(): Promise<UserOption[]> {
      return ((await selectUserOptionsStmt.all()) as UserOption[]).map((u) => ({ id: u.id, login: u.login, name: u.name, role: u.role }))
    },
    async listRepoScopesForUser(userId: string): Promise<{ repoId: number; path: string | null }[]> {
      return (await selectUserRepoScopesStmt.all(userId)) as { repoId: number; path: string | null }[]
    },
    async listTeamsForUser(userId: string): Promise<UserTeam[]> {
      const teams = (await selectTeamsForUserStmt.all(userId)) as { id: string; slug: string; name: string; dependencies: number; security: number }[]
      const scopes = await stmts.selectUserTeamScopesStmt.all(userId) as { teamId: string; repoId: number; path: string; fullName: string }[]
      const links = await linkRevision(db)
      const reportsByTeam = new Map<string, UserTeamReport[]>()
      for (const r of (await selectUserTeamReportsStmt.all(userId)) as {
        teamId: string; id: string; slug: string; filename: string; analyzer: string | null; sha256: string; bundleId: string | null; repoId: number
        repoDirectory: string; repoFullName: string | null; visible: number; dependencies: number; security: number; role: string
      }[]) {
        const list = reportsByTeam.get(r.teamId) ?? []
        const cacheKey = createHash('sha256').update(JSON.stringify([
          r.sha256, r.bundleId, r.filename, r.repoId, r.repoDirectory, r.repoFullName, r.dependencies, r.security, r.role, links,
        ])).digest('base64url')
        list.push({ id: r.id, slug: r.slug, filename: r.filename, visible: r.visible === 1, analyzer: r.analyzer, repoFullName: r.repoFullName, repoDirectory: r.repoDirectory, cacheKey })
        reportsByTeam.set(r.teamId, list)
      }
      const bundlesByTeam = new Map<string, UserTeamBundle[]>()
      for (const b of (await selectUserTeamBundlesStmt.all(userId)) as (Omit<UserTeamBundle, 'visible'> & { teamId: string; visible: number })[]) {
        const list = bundlesByTeam.get(b.teamId) ?? []
        list.push({ id: b.id, slug: b.slug, integrity: b.integrity, filename: b.filename, visible: b.visible === 1,
          kind: b.kind, byteSize: b.byteSize, repoId: b.repoId, repoDirectory: b.repoDirectory, repoFullName: b.repoFullName })
        bundlesByTeam.set(b.teamId, list)
      }
      return teams.map((t) => ({
        id: t.id, slug: t.slug, name: t.name,
        permissions: { dependencies: t.dependencies === 1, security: t.security === 1 },
        cacheKey: createHash('sha256').update(JSON.stringify([
          t.dependencies, t.security, links, scopes.filter(scope => scope.teamId === t.id),
        ])).digest('base64url'),
        reports: reportsByTeam.get(t.id) ?? [],
        bundles: bundlesByTeam.get(t.id) ?? [],
      }))
    },
    async getFeedState(sessionId: string, now: number) {
      const row = await db.prepare(`SELECT u.id, u.role, r.catalog, r.annotations FROM managed_session s
        JOIN managed_user u ON u.id = s.user_id JOIN managed_change_revision r ON r.id = 1
        WHERE s.id = ? AND s.expires_at > ?`).get(sessionId, now) as { id: string; role: Role; catalog: number; annotations: number } | undefined
      return row ? { user: { id: row.id, role: row.role }, catalog: row.catalog, annotations: row.annotations } : null
    },
    async getUserTeamFeedSnapshot(sessionId: string, now: number) {
      // One short read-only transaction, shared by SQLite and Postgres. Never
      // touch last-seen timestamps or include other users' memberships.
      const state = await methods.getFeedState(sessionId, now)
      if (!state) return null
      const teams = state.user.role === 'none' ? [] : await methods.listTeamsForUser(state.user.id)
      return { user: state.user, catalog: state.catalog, teams, revision: teamCatalogRevision(teams) }
    },
    async userCanReadReport(userId: string, reportId: string): Promise<boolean> {
      return (await selectReportReadableStmt.get(reportId, userId)) != null
    },
    async userCanReadBundleAdvisories(userId: string, bundleId: string, teamId: string | null): Promise<boolean> {
      return (await stmts.selectBundleSecurityStmt.get(bundleId, userId, teamId, teamId)) != null
    },
    async reportPermissionsFor(userId: string, reportId: string): Promise<TeamUserPermissions> {
      const row = (await selectReportPermsStmt.get(userId, reportId)) as { dependencies: number | null; security: number | null } | undefined
      return { dependencies: row?.dependencies === 1, security: row?.security === 1 }
    },
    async listTeams(): Promise<AdminTeam[]> {
      const teams = (await selectTeamsStmt.all()) as TeamRow[]
      const reposByTeam = new Map<string, TeamRepoLink[]>()
      for (const r of (await selectTeamReposStmt.all()) as TeamRepoRow[]) {
        const list = reposByTeam.get(r.teamId) ?? []
        list.push({ repoId: r.repoId, fullName: r.fullName, path: r.path })
        reposByTeam.set(r.teamId, list)
      }
      const membersByTeam = new Map<string, TeamMember[]>()
      for (const m of (await selectTeamMembersStmt.all()) as TeamMemberRow[]) {
        const list = membersByTeam.get(m.teamId) ?? []
        list.push({ userId: m.userId, login: m.login, dependencies: m.viewDependencies === 1, security: m.viewSecurity === 1 })
        membersByTeam.set(m.teamId, list)
      }
      return teams.map((t) => ({
        id: t.id, slug: t.slug, name: t.name,
        hidden: t.hidden === 1,
        repos: reposByTeam.get(t.id) ?? [],
        members: membersByTeam.get(t.id) ?? [],
      }))
    },
    async setTeamRepo(teamId: string, repoId: number, path: string | null): Promise<void> {
      // A whole-repository grant supersedes all its path grants atomically.
      // Adding a redundant path to an existing whole-repo grant is a no-op.
      if (path == null || path === '') await deleteTeamRepoStmt.run(teamId, repoId)
      await upsertTeamRepoStmt.run(teamId, repoId, path ?? '', teamId, repoId)
    },
    async removeTeamRepo(teamId: string, repoId: number, path?: string | null): Promise<boolean> {
      const result = path === undefined ? (await deleteTeamRepoStmt.run(teamId, repoId)) : (await deleteTeamRepoPathStmt.run(teamId, repoId, path ?? ''))
      return Number(result.changes) > 0
    },
    async setTeamMember(teamId: string, userId: string, perms: TeamUserPermissions): Promise<void> {
      await upsertTeamMemberStmt.run(teamId, userId, perms.dependencies ? 1 : 0, perms.security ? 1 : 0)
    },
    async removeTeamMember(teamId: string, userId: string): Promise<boolean> {
      return Number((await deleteTeamMemberStmt.run(teamId, userId)).changes) > 0
    },
  }
  return methods
}

// `triageHistoryLimit`: events kept per finding in the triage trail; 0 (the
// default) keeps everything. See ManagedConfig.
export interface ManagedDbOptions {
  storageEncryptionKey?: StorageKey | null
  triageHistoryLimit?: number
}

export function createManagedMethods(db: ManagedSql, options: ManagedDbOptions = {}): ManagedDb {
  const key = options.storageEncryptionKey ?? null
  const comments = commentMethods(db)
  const activity = activityMethods(db)
  const stmts = prepareStatements(db)
  const reports = reportMethods(stmts, db, key)
  const triage = triageMethods(stmts, options.triageHistoryLimit ?? 0, db)
  const {
    upsertUserStmt, selectUserIdStmt, promoteInitialAdminStmt, selectGithubIdStmt, insertSessionStmt, selectSessionStmt, selectUsersStmt,
    touchUserSeenStmt, updateRoleStmt, updateTokensStmt, selectTokensStmt, deleteSessionStmt, deleteExpiredStmt,
  } = stmts

  const methods: Omit<ManagedDb, keyof ManagementStore | keyof ManagementCatalogStore> = {
    ...storageMethods(db, key),
    ...linkReportMethods(db, key),
    ...repositoryAliasMethods(db),
    ...bundleBuildLeaseMethods(db),
    async claimMaintenanceLease(owner, now, until, migration = false) {
      return !!await db.prepare(`INSERT INTO managed_maintenance_lease (id, owner, expires_at) VALUES (?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET owner = excluded.owner, expires_at = excluded.expires_at
        WHERE managed_maintenance_lease.expires_at <= ? RETURNING id`).get(migration ? 2 : 1, owner, until, now)
    },
    async finishMaintenanceLease(owner, until) {
      await db.prepare('UPDATE managed_maintenance_lease SET expires_at = ? WHERE owner = ?').run(until, owner)
    },
    async upsertUser(user, now, initialAdminGithubId = null) {
      // New row → a fresh id; ON CONFLICT(github_user_id) keeps an existing
      // user's id (DO UPDATE leaves it untouched), so re-read to return it.
      await upsertUserStmt.run(randomUUID(), user.githubUserId, user.login, user.name, user.avatarUrl, now, now)
      const row = (await selectUserIdStmt.get(user.githubUserId)) as { id: string; role: Role }
      // Avoid the population check unless this login matches the configured
      // identity and still needs approval. NOT EXISTS stops at any other user.
      if (initialAdminGithubId != null && Number.isSafeInteger(initialAdminGithubId) && initialAdminGithubId > 0
        && user.githubUserId === initialAdminGithubId && row.role === 'none') {
        await promoteInitialAdminStmt.run(row.id, row.id)
      }
      return row.id
    },
    async createSession(session, now) {
      await insertSessionStmt.run(session.id, session.userId, session.csrfToken, now, session.expiresAt)
      await touchUserSeenStmt.run(now, session.userId, now)
    },
    async sessionWithUser(id, now) {
      const row = (await selectSessionStmt.get(id, now)) as SessionRow | undefined
      if (row == null) return null
      await touchUserSeenStmt.run(now, row.uid, now)
      return {
        session: { id: row.id, userId: row.uid, csrfToken: row.csrf, expiresAt: row.exp },
        user: { id: row.uid, login: row.login, name: row.name, avatarUrl: row.avatar, role: row.role },
      }
    },
    async deleteSession(id) {
      await deleteSessionStmt.run(id)
    },
    async deleteExpiredSessions(now) {
      return Number((await deleteExpiredStmt.run(now)).changes)
    },
    async listUsers() {
      const rows = (await selectUsersStmt.all()) as UserRow[]
      return rows.map((r) => ({ id: r.id, login: r.login, name: r.name, role: r.role, createdAt: r.created, lastSeenAt: r.lastSeen, lastActivityAt: r.lastActivity }))
    },
    async setUserRole(id, role) {
      return Number((await updateRoleStmt.run(role, Date.now(), id)).changes) > 0
    },
    async setUserTokens(id, tokens) {
      const state = await storageState(db, key)
      const value = state ? encodeStorageTokens(key!, id, tokens.accessToken, tokens.refreshToken) : { access: tokens.accessToken, refresh: tokens.refreshToken }
      await updateTokensStmt.run(value.access, value.refresh, tokens.expiresAt, state ? 1 : 0, Date.now(), id)
    },
    async getUserTokens(id) {
      const state = await storageState(db, key)
      const row = (await selectTokensStmt.get(id)) as StoredTokens | undefined
      if (row == null || row.access == null) return null
      if (row.encrypted && !state) throw new Error('Encrypted tokens without storage encryption state')
      if (!row.encrypted && state?.complete) throw new Error('Unexpected plaintext GitHub tokens')
      const value = row.encrypted ? decodeStorageTokens(key!, id, row) : row
      return { accessToken: value.access!, refreshToken: value.refresh, expiresAt: row.exp }
    },
    async getUserGithubId(id) {
      const row = (await selectGithubIdStmt.get(id)) as { githubId: number } | undefined
      return row?.githubId ?? null
    },
    ...githubMetadataMethods(db),
    ...managedIssueMethods(db),
    ...selectedRepoMethods(stmts),
    ...activity,
    ...comments,
    async getAnnotations(ids) {
      return { triage: await triage.listTriage(ids), comments: await comments.listComments(ids) }
    },
    ...workspaceShareMethods(db),
    ...reports,
    ...triage,
    ...importTriageMethods({ getReport: reports.getReport, ...triage, ...comments }),
    ...bundleMethods(stmts, db, key),
    ...teamMethods(stmts, db),
    async close() {
      await db.close()
    },
  }
  return { ...methods, ...managementMethods(methods), ...managementCatalogMethods(methods) }
}
