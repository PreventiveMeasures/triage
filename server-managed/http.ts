// HTTP router for the managed auth server. Mounts the GitHub OAuth flow plus
// the session endpoints + the mode probe; there is NO api/sync here (a managed
// server doesn't speak the e2e sync protocol yet). Every handler is async; the
// boot's `track()` keeps in-flight requests drainable on shutdown.
//
//   GET  /api/config             → { mode:'managed', managed:{ loginPath, cookieName } }  (public)
//   GET  /api/oauth/github/login → 302 to GitHub (+ state cookie)
//   GET  /api/oauth/github/callback → the OAuth hook (see github-oauth.ts)
//   GET  /api/auth/session       → { user, csrfToken } | 401
//   GET  /api/teams              → the current user's teams + their reports and bundles | 401
//   GET  /api/teams/<id>/fixes → PR/issue metadata from visible findings' stored Fix links
//   GET  /api/teams/<id>/reports → all reports and links filtered through this team | 401/404
//   GET  /api/teams/<id>/feed    → SSE notifications for visible triage and comments | 401/404
//   GET  /api/reports/<id>       → admin/manager report preview | 401/403/404
//   POST /api/reports/query      → admin/manager batch preview, with repository metadata | 400/401/403/404/503
//   GET  /api/reports/<id>/triage → triage entries (by finding id, shared across reports) for a viewable report's findings | 401/404
//   POST /api/reports/<id>/triage → write triage entries: admin, or ≥triage role + membership | 401/403/404
//   GET  /api/reports/<id>/triage/history?finding=<fid> → one visible finding's triage trail, newest first | 400/401/404
//   GET  /api/avatar/<id>        → cached avatar bytes by user id | 401/404
//   GET  /api/admin/users        → admin-only user list | 401/403
//   GET  /api/admin/history      → paginated activity (admin), team content activity (manage) | 401/403
//   POST /api/admin/set-role     → admin sets another user's role | 401/403/404
//   GET  /api/admin/repositories → admin repo list (each flagged selected) | 401/403
//   POST /api/admin/repositories/select → admin selects/deactivates a repo | 401/403
//   GET /api/admin/repositories/impact → admin attached data summary
//   GET /api/admin/repositories/{browsable,refs,contents} → admin|manage + GitHub read access
//   POST /api/admin/repositories/remove → admin permanently removes a repo
//   GET  /api/admin/reports      → admin|manage list of uploaded reports | 401/403
//   POST /api/admin/reports      → admin|manage uploads a report (raw body) | 401/403/413
//   GET  /api/admin/reports/<id> → admin|manage downloads a stored report | 401/403/404
//   DELETE /api/admin/reports/<id> → admin|manage deletes a report | 401/403/404
//   POST /api/admin/reports/set-repo → admin|manage attaches/detaches a report's repo | 401/403/404
//   GET  /api/bundles/<id>/{metadata,contents} → authorized encoded bytes | 401/404/422
//   GET  /api/bundles/<id>/advisories → published npm advisories (security access) | 401/403/404
//   GET  /api/bundles/<id>/download → authorized original upload | 401/404
//   GET  /api/admin/bundles      → admin all bundles; managers own/team bundles | 401/403
//   POST /api/admin/bundles      → admin|manage uploads a bundle (raw body) | 401/403/413
//   GET  /api/admin/bundles/<id> → admin|manage downloads a stored bundle | 401/403/404
//   DELETE /api/admin/bundles/<id> → admin|manage deletes a bundle | 401/403/404
//   POST /api/admin/bundles/set-repo → admin|manage attaches/detaches a bundle's repo | 401/403/404
//   GET  /api/admin/teams        → admin teams (+ members/repos) + pickers | 401/403
//   POST /api/admin/teams        → admin creates a team | 401/403/409
//   POST /api/admin/teams/rename → admin renames a team | 401/403/404/409
//   POST /api/admin/teams/delete → admin deletes a team | 401/403/404
//   POST /api/admin/teams/{set,remove}-repo   → admin links/unlinks a repo (+path) | 401/403/404
//   POST /api/admin/teams/{set,remove}-member → admin links/unlinks a user (+perms) | 401/403/404
//   POST /api/auth/logout        → same-origin + CSRF, drops the session
import type { IncomingMessage, ServerResponse } from 'node:http'
import { pipeline } from 'node:stream/promises'
import { NPM_ADVISORIES_TIMEOUT_MS, fetchNpmAdvisories } from '../server-common/npm-advisories.ts'
import { UPLOAD_CHUNK_BYTES, type UploadKind, deleteUpload, putUploadPart, readUpload, validUpload, validUploadPart } from './uploads.ts'
import { type BundleCache, type BundleCachePart, MAX_PACKAGE_INVENTORY_BYTES } from './bundle-cache.ts'
import { backfillBundleSummaries, bundleSummaries } from './bundle-catalog.ts'
import { contentAccess } from './content-access.ts'
import type { BundleStore } from './bundle-store.ts'
import { Buffer } from 'node:buffer'
import { createHash, randomUUID } from 'node:crypto'
import type { AvatarStore } from './avatar-store.ts'
import type { BlobStore } from './blob-store.ts'
import { bundleIntegrity, bundleKind, reportBundleHashes } from './bundle.ts'
import type { ManagedConfig } from './config.ts'
import type { ManagedBundle, ManagedDb, ManagedSession, ReportRecord, StoredUser, TriageEventRow } from './db.ts'
import type { OriginGate } from '../server-common/origin.ts'
import { isRole, roleAtLeast } from '../common/managed/roles.ts'
import { VISIBILITY_PERMISSIONS, parseTeamUserPermissions } from '../common/managed/permissions.ts'
import { filterReportData } from '../common/managed/report-filter.ts'
import type { TriageEntryPatch } from '../common/managed/triage.ts'
import { MAX_FINDING_ID, MAX_TRIAGE_BODY_BYTES, MAX_TRIAGE_ENTRIES, MAX_TRIAGE_HISTORY, parseTriageEntryPatch } from '../common/managed/triage.ts'
import { reportRepoGithub } from '@preventive/report'
import { loadManagedFindings, readManagedReport } from '../common/managed/report-content.ts'
import type { ReportSourcesCache } from './report-sources.ts'
import { normalizeTeamPath } from './repo-path.ts'
import { DEFAULT_MANAGED_SCAN_MODEL, MANAGED_SCAN_MODELS } from '../common/managed/scan-models.ts'
import { CONFIG_PATH, type ServerInfo } from '../common/server-info.ts'
import { GithubApiError, collectRepos, fetchPublicRepository, installUrl, publicRepositoryName, repositoryInstallation } from './github-app.ts'
import type { ConnectedRepo } from './github-app.ts'
import { canAddAnyPublicRepository, canAddRepositories, passesPublicRepositorySafeguard } from './repository-policy.ts'
import { RepositoryDiscovery } from './repository-discovery.ts'
import { createRepositoryBrowser, scopedDirectory } from './repository-browser.ts'
import { CALLBACK_PATH, LOGIN_PATH, OAuthError, buildLoginRedirect, ensureUserAccessToken, handleCallback } from './github-oauth.ts'
import { clearCookie, endSession, readSession } from './session.ts'
import type { ActivityContext, ActivityInput } from './activity.ts'
import { acceptsReportMetadata } from './report-response.ts'
import { TeamReportsError, loadTeamAnnotations, loadTeamReports, recheckTeam, teamFindingIds, teamSnapshot, teamSourcePaths, teamWorkspaceFindingIds } from './team-reports.ts'
import { FINDING_CATALOG_PAGE_BYTES, FINDING_CATALOG_PAGE_COUNT, MAX_REPORT_QUERY_BYTES, MAX_REPORT_QUERY_COUNT } from './report-query.ts'
import { lookupFixes, storedFixUrls } from './github-pulls.ts'
import { IssueError, MAX_ISSUE_BODY_BYTES, createGithubIssue, parseIssueContext, prepareGithubIssue } from './github-issues.ts'
import { ISSUE_LOGIN_PATH, isIssueOAuthCallback, issueLoginRedirect, issueOAuthCallback } from './github-issue-oauth.ts'
import { sendJson, writeResponse } from './http-response.ts'
import { triageWireEntry } from './triage-response.ts'
import { handlePublicWorkspace } from './public-workspace.ts'
import { serveUserTeamFeed } from './team-feed.ts'
import { hashToken, randomToken } from './crypto.ts'
import { canDeleteComment, parseCommentBody } from '../common/managed/comments.ts'
import { ManagedMutationError, reportReferenceSnapshot } from './management.ts'

const SESSION_PATH = '/api/auth/session'
const AVATAR_PREFIX = '/api/avatar/'
const LOGOUT_PATH = '/api/auth/logout'
const ADMIN_USERS_PATH = '/api/admin/users'
const ADMIN_HISTORY_PATH = '/api/admin/history'
const ADMIN_SCAN_MODELS_PATH = '/api/admin/scan/models'
const SET_ROLE_PATH = '/api/admin/set-role'
const ADMIN_REPOS_PATH = '/api/admin/repositories'
const BROWSABLE_REPOS_PATH = '/api/admin/repositories/browsable'
const REPO_REFS_PATH = '/api/admin/repositories/refs'
const REPO_CONTENTS_PATH = '/api/admin/repositories/contents'
const SELECT_REPO_PATH = '/api/admin/repositories/select'
const ADD_PUBLIC_REPO_PATH = '/api/admin/repositories/add-public'
const CONNECT_REPO_APP_PATH = '/api/admin/repositories/connect-app'
const REPO_IMPACT_PATH = '/api/admin/repositories/impact'
const REMOVE_REPO_PATH = '/api/admin/repositories/remove'
const ADMIN_REPORTS_PATH = '/api/admin/reports'
const REPORT_SET_REPO_PATH = '/api/admin/reports/set-repo'
const REPORT_SET_VISIBLE_PATH = '/api/admin/reports/set-visible'
const REPORT_PREFIX = '/api/admin/reports/'
const ADMIN_BUNDLES_PATH = '/api/admin/bundles'
const BUNDLE_SET_REPO_PATH = '/api/admin/bundles/set-repo'
const BUNDLE_PREFIX = '/api/admin/bundles/'
const MY_TEAMS_PATH = '/api/teams'
const MY_REPORT_PREFIX = '/api/reports/'
const MY_REPORT_TRIAGE_SUFFIX = '/triage'
const MY_REPORT_TRIAGE_HISTORY_SUFFIX = '/triage/history'
const ADMIN_TEAMS_PATH = '/api/admin/teams'
const TEAM_DELETE_PATH = '/api/admin/teams/delete'
const TEAM_RENAME_PATH = '/api/admin/teams/rename'
const TEAM_SET_REPO_PATH = '/api/admin/teams/set-repo'
const TEAM_REMOVE_REPO_PATH = '/api/admin/teams/remove-repo'
const TEAM_SET_MEMBER_PATH = '/api/admin/teams/set-member'
const TEAM_REMOVE_MEMBER_PATH = '/api/admin/teams/remove-member'
const MAX_TEAM_NAME = 100

async function handleWorkspaceFixes(res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined, teamId: string): Promise<void> {
  const s = await readWorkspaceSession(res, deps, cookie)
  if (!s) return
  const snapshot = await teamSnapshot(deps.db, s.session.id, teamId)
  const ids = [...await teamWorkspaceFindingIds(deps.db, deps.reportStore, snapshot)]
  const urls = storedFixUrls(await deps.db.listTriage(ids))
  await recheckTeam(deps.db, s.session.id, snapshot)
  const fixes = await lookupFixes(deps.config, deps.db, snapshot, urls)
  // Cold report reads, token refresh and upstream batches can outlive changes
  // to security/links, team grants, publication, sessions or the Fix links.
  const currentUrls = storedFixUrls(await deps.db.listTriage(ids))
  if (await readWorkspaceSession(res, deps, cookie) == null) return
  await recheckTeam(deps.db, s.session.id, snapshot)
  if (JSON.stringify(currentUrls) !== JSON.stringify(urls)) {
    sendJson(res, 404, { error: 'workspace-changed' }); return
  }
  sendJson(res, 200, { fixes })
}

async function handleWorkspaceIssue(req: IncomingMessage, res: ServerResponse, deps: ManagedHttpDeps,
  cookie: string | undefined, teamId: string, query: URLSearchParams): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'POST') { send405(res, 'GET, POST'); return }
  const s = req.method === 'GET' ? await readWorkspaceSession(res, deps, cookie) : await checkMutation(req, res, deps, cookie)
  if (!s) return
  if (!roleAtLeast(s.user.role, 'view')) { sendJson(res, 403, { error: 'forbidden' }); return }
  let body: unknown = Object.fromEntries(query)
  if (req.method === 'POST') {
    try { body = await readJsonBody(req, MAX_ISSUE_BODY_BYTES) }
    catch { sendJson(res, 400, { error: 'bad-body' }); return }
  }
  const context = parseIssueContext(body)
  const prepared = await prepareGithubIssue(deps.config, deps.db, deps.reportStore, s.session, teamId, context)
  await prepared.recheck()
  if (req.method === 'POST' && prepared.mode === 'api') {
    sendJson(res, 201, await createGithubIssue(prepared, body)); return
  }
  sendJson(res, 200, { mode: prepared.mode, labels: prepared.labels,
    ...(prepared.mode === 'existing' ? { url: prepared.url } : {}),
    ...(prepared.mode === 'pending' ? { repositoryUrl: prepared.repositoryUrl } : {}),
    ...(prepared.mode === 'authorize' || prepared.mode === 'permissions' ? { authorizationPath: prepared.authorizationPath } : {}) })
}

function activity(deps: ManagedHttpDeps, user: StoredUser, kind: ActivityInput['kind'], action: string, context: Pick<ActivityInput, 'repo' | 'reportId' | 'bundleId' | 'report' | 'repoId' | 'repoDirectory'> = {}): Promise<void> {
  return deps.db.recordActivity({ kind, actor: user.login, actorId: user.id, action, ...context }, Date.now())
}

async function repositoryName(deps: ManagedHttpDeps, repoId: number | null | undefined): Promise<string | null> {
  if (repoId == null) return null
  return (await deps.db.listAllRepos()).find(repo => repo.repoId === repoId)?.fullName ?? null
}

// Workspace history is authorized BEFORE filtering, counting, or paging.
// Managers get content activity for their currently accessible team content;
// even the displayed report context must come from those accessible reports.
async function handleHistory(res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined, query: URLSearchParams): Promise<void> {
  const s = await readManageSession(res, deps, cookie)
  if (s == null) return
  const page = Number(query.get('page') ?? 1)
  const limit = Number(query.get('limit') ?? 100)
  const kind = query.get('kind') ?? 'all'
  const search = (query.get('q') ?? '').trim()
  const repo = query.get('repo') ?? ''
  const actor = query.get('actor') ?? ''
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100
    || !['all', 'triage', 'upload', 'visibility', 'access', 'repository', 'delete'].includes(kind) || search.length > 500
    || repo.length > 500 || actor.length > 500) {
    sendJson(res, 400, { error: 'bad-request' }); return
  }
  let contexts: ActivityContext[] | null = null
  if (s.user.role !== 'admin') {
    const findings = new Map<string, ActivityContext>()
    const reports = kind === 'all' || kind === 'triage' ? await deps.db.listActivityReports(s.user.id) : []
    for (const report of reports) {
      for (const finding of await visibleFindingIds(deps, s.user, report.reportId, s.session.id, null)) {
        if (!findings.has(finding)) findings.set(finding, { finding, ...report })
      }
    }
    contexts = [...findings.values()]
  }
  sendJson(res, 200, await deps.db.listActivity({ page, limit, kind, query: search, repo, actor, contexts, userId: s.user.id }))
}

export interface ManagedHttpDeps {
  config: ManagedConfig
  db: ManagedDb
  avatarStore: AvatarStore
  reportStore: BlobStore
  bundleStore: BundleStore
  bundleCache?: BundleCache
  reportSourcesCache?: ReportSourcesCache
  uploadStore?: BlobStore
  originGate: OriginGate
  isShuttingDown: () => boolean
  track: (p: Promise<unknown>) => void
  // Combined boot delegates unmatched paths to e2e and overrides discovery.
  serveStatic?: (req: IncomingMessage, res: ServerResponse) => boolean
  next?: Handler
  serverInfo?: ServerInfo
}

type Handler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>

function send405(res: ServerResponse, allow: string): void {
  sendJson(res, 405, { error: 'method-not-allowed' }, { allow })
}

function firstHeader(v: string | string[] | undefined): string | null {
  if (typeof v === 'string') return v
  if (Array.isArray(v) && v.length > 0) return v[0] ?? null
  return null
}

async function serveAvatar(res: ServerResponse, avatarStore: AvatarStore, userId: string): Promise<void> {
  const avatar = await avatarStore.get(userId)
  if (avatar == null) { sendJson(res, 404, { error: 'no-avatar' }); return }
  res.writeHead(200, {
    'content-type': avatar.contentType,
    'content-length': String(avatar.bytes.length),
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-store',
  })
  res.end(avatar.bytes)
}

const MAX_JSON_BODY_BYTES = 4096

// Buffer the request body, aborting (and throwing 'too-large') once it exceeds
// `maxBytes` — bounds memory on the JSON mutations (small) and the report
// upload (config.maxReportBytes) alike.
async function readBodyBytes(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const c = chunk as Buffer
    size += c.length
    if (size > maxBytes) { req.destroy(); throw new Error('too-large') }
    chunks.push(c)
  }
  return Buffer.concat(chunks)
}

function readUploadBody(req: IncomingMessage, deps: ManagedHttpDeps, session: string, kind: UploadKind) {
  const maxBytes = kind === 'reports' ? deps.config.maxReportBytes : deps.config.maxBundleBytes
  if (req.headers['x-upload-id'] == null) return readBodyBytes(req, maxBytes)
  if (!deps.uploadStore) throw new Error('bad-upload')
  return readUpload(deps.uploadStore, req, session, kind, maxBytes)
}

async function handleUploadPart(req: IncomingMessage, res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined, path: string) {
  const cancel = req.method === 'DELETE'
  if (req.method !== 'POST' && !cancel) { send405(res, 'POST, DELETE'); return }
  const s = await checkMutation(req, res, deps, cookie)
  if (!s || !requireManageRole(res, s.user)) return
  if (!deps.uploadStore) { sendJson(res, 404, { error: 'not-found' }); return }
  const match = /^\/api\/admin\/uploads\/(reports|bundles)\/([^/]+)(?:\/(0|[1-9][0-9]*))?$/u.exec(path)
  if (!match || (cancel ? match[3] !== undefined : match[3] === undefined)) { sendJson(res, 400, { error: 'bad-upload' }); return }
  const id = match[2]!, kind = match[1] as UploadKind
  if (cancel) {
    const count = Number(req.headers['x-upload-parts'])
    if (!validUpload(id, count)) { sendJson(res, 400, { error: 'bad-upload' }); return }
    await deleteUpload(deps.uploadStore, s.session.id, kind, id, count)
    sendJson(res, 200, { ok: true }); return
  }
  const index = Number(match[3])
  const maxBytes = kind === 'reports' ? deps.config.maxReportBytes : deps.config.maxBundleBytes
  const discard = async () => {
    if (validUpload(id, index + 1)) {
      await deleteUpload(deps.uploadStore!, s.session.id, kind, id, index + 1).catch(err => console.warn('managed: upload cleanup failed:', err))
    }
  }
  if (!validUploadPart(id, index, maxBytes)) { await discard(); sendJson(res, 400, { error: 'bad-upload' }); return }
  let bytes
  try { bytes = await readBodyBytes(req, Math.min(UPLOAD_CHUNK_BYTES, maxBytes)) }
  catch { await discard(); sendJson(res, 413, { error: 'too-large' }); return }
  if (bytes.length === 0) { await discard(); sendJson(res, 400, { error: 'empty' }); return }
  if (await manageMutation(req, res, deps, cookie) == null) return
  await putUploadPart(deps.uploadStore, s.session.id, kind, id, index, bytes)
  sendJson(res, 200, { ok: true })
}

// `maxBytes` overrides the small default for the one endpoint whose JSON body
// legitimately grows (triage entry batches).
async function readJsonBody(req: IncomingMessage, maxBytes = MAX_JSON_BODY_BYTES): Promise<unknown> {
  const buf = await readBodyBytes(req, maxBytes)
  return JSON.parse(buf.toString('utf8') || 'null')
}

// Validate a mutation: same-origin gate + an authenticated session whose
// double-submit CSRF token matches the X-CSRF-Token header. Returns the session,
// or null after having already sent the 401/403.
async function checkMutation(req: IncomingMessage, res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined): Promise<{ session: ManagedSession; user: StoredUser } | null> {
  if (!deps.originGate.isOriginAllowed(req)) { sendJson(res, 403, { error: 'origin-denied' }); return null }
  const s = await readSession(deps.config, deps.db, cookie, Date.now())
  if (s == null) { sendJson(res, 401, { error: 'unauthenticated' }); return null }
  const csrf = firstHeader(req.headers['x-csrf-token'])
  if (csrf == null) { sendJson(res, 403, { error: 'csrf-missing' }); return null }
  if (csrf !== s.session.csrfToken) { sendJson(res, 403, { error: 'csrf-mismatch' }); return null }
  return s
}

// POST /api/auth/logout — drop the session (same-origin + CSRF).
async function handleLogout(req: IncomingMessage, res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined): Promise<void> {
  if ((req.method ?? 'GET') !== 'POST') { send405(res, 'POST'); return }
  const s = await checkMutation(req, res, deps, cookie)
  if (s == null) return
  await endSession(deps.config, deps.db, cookie)
  res.writeHead(204, { 'set-cookie': clearCookie(deps.config.sessionCookieName, deps.config.cookieSecure), 'cache-control': 'no-store' })
  res.end()
}

// POST /api/admin/set-role — an admin sets ANOTHER user's role. Admin-only, and
// refused for the caller's own id so an admin can't drop their own admin (keeps
// at least one admin).
async function handleSetRole(req: IncomingMessage, res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined): Promise<void> {
  if ((req.method ?? 'GET') !== 'POST') { send405(res, 'POST'); return }
  const s = await checkMutation(req, res, deps, cookie)
  if (s == null) return
  if (s.user.role !== 'admin') { sendJson(res, 403, { error: 'forbidden' }); return }
  let body: unknown
  try { body = await readJsonBody(req) } catch { sendJson(res, 400, { error: 'bad-body' }); return }
  const userId = (body as { userId?: unknown } | null)?.userId
  const role = (body as { role?: unknown } | null)?.role
  if (typeof userId !== 'string' || !isRole(role)) { sendJson(res, 400, { error: 'bad-request' }); return }
  if (userId === s.user.id) { sendJson(res, 403, { error: 'cannot-change-own-role' }); return }
  const target = (await deps.db.listUsers()).find(user => user.id === userId)
  // A caller can hold the body open while their admin access is revoked.
  if (await readAdminSession(res, deps, cookie) == null) return
  const ok = await deps.db.setUserRole(userId, role)
  if (!ok) { sendJson(res, 404, { error: 'not-found' }); return }
  if (target?.role !== role) await activity(deps, s.user, 'access', `changed ${target?.login ?? userId}'s role to ${role}`)
  sendJson(res, 200, { ok: true })
}

// admin OR manage — the roles allowed into the management pages (repositories,
// reports), matching the sidebar account-menu gate. Sends 403 + returns false
// otherwise.
function requireManageRole(res: ServerResponse, user: StoredUser): boolean {
  if (user.role === 'admin' || user.role === 'manage') return true
  sendJson(res, 403, { error: 'forbidden' })
  return false
}

// A read endpoint open to admin|manage: resolve the session (401 if absent),
// then gate on the role (403). Returns the session, or null after the response
// was already sent. No CSRF — reads aren't mutations (cf. /api/admin/users).
async function readManageSession(res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined): Promise<{ session: ManagedSession; user: StoredUser } | null> {
  const s = await readSession(deps.config, deps.db, cookie, Date.now())
  if (s == null) { sendJson(res, 401, { error: 'unauthenticated' }); return null }
  if (!requireManageRole(res, s.user)) return null
  return s
}

async function readAdminSession(res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined): Promise<{ session: ManagedSession; user: StoredUser } | null> {
  const s = await readSession(deps.config, deps.db, cookie, Date.now())
  if (s == null) { sendJson(res, 401, { error: 'unauthenticated' }); return null }
  if (s.user.role !== 'admin') { sendJson(res, 403, { error: 'forbidden' }); return null }
  return s
}

async function readWorkspaceSession(res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined): Promise<{ session: ManagedSession; user: StoredUser } | null> {
  const s = await readSession(deps.config, deps.db, cookie, Date.now())
  if (s == null) { sendJson(res, 401, { error: 'unauthenticated' }); return null }
  if (!roleAtLeast(s.user.role, 'view')) { sendJson(res, 403, { error: 'forbidden' }); return null }
  return s
}

// GET /api/admin/scan/models — the server's canonical scan model ids and effort
// levels. Names are intentionally absent; the client derives them from ids.
async function handleListModels(res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined): Promise<void> {
  const s = await readManageSession(res, deps, cookie)
  if (s == null) return
  sendJson(res, 200, { models: MANAGED_SCAN_MODELS, defaultModel: DEFAULT_MANAGED_SCAN_MODEL })
}

// GET /api/admin/repositories — the connected repositories by default. The
// potentially large GitHub discovery lists are opt-in (`scope=installed` or
// `scope=public`). Return the complete catalogue for local search and organization
// filtering. Admin-only. No CSRF.
async function handleListRepositories(req: IncomingMessage, res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined, discovery: RepositoryDiscovery): Promise<void> {
  if ((req.method ?? 'GET') !== 'GET') { send405(res, 'GET'); return }
  const s = await readAdminSession(res, deps, cookie)
  if (s == null) return
  const url = new URL(req.url ?? '/', 'http://localhost')
  // Keep the original unparameterized response shape for older clients. The
  // admin UI always sends an explicit scope, which opts into the connected-first
  // discovery flow below.
  if ([...url.searchParams.keys()].length === 0) {
    const token = await ensureUserAccessToken(deps.config, deps.db, s.user.id, Date.now())
    const listing = await collectRepos(deps.config, token)
    const selected = new Set((await deps.db.listSelectedRepos()).map((repo) => repo.repoId))
    sendJson(res, 200, {
      installUrl: installUrl(deps.config),
      repositories: listing.repositories.map((repo) => ({
        id: repo.id, fullName: repo.fullName, private: repo.private, visibility: repo.visibility, htmlUrl: repo.htmlUrl,
        installed: repo.installationId != null, selected: selected.has(repo.id),
      })),
      tokenMissing: listing.tokenMissing,
    })
    return
  }
  const scope = url.searchParams.get('scope') ?? 'connected'
  if (scope !== 'connected' && scope !== 'installed' && scope !== 'public') { sendJson(res, 400, { error: 'bad-scope' }); return }
  const selectedRows = await deps.db.listSelectedRepos()
  const allRows = scope === 'connected' ? await deps.db.listAllRepos() : []
  const selected = new Set(selectedRows.map((r) => r.repoId))
  let tokenMissing = false
  let repositories
  if (scope === 'connected') {
    repositories = allRows.map((r) => ({
      id: r.repoId, fullName: r.fullName, private: r.private, htmlUrl: r.htmlUrl,
      installed: r.installationId != null, selected: r.active, active: r.active,
    }))
  } else {
    const showAll = scope === 'installed' && url.searchParams.get('showAll') === 'true'
    const token = showAll ? null : await ensureUserAccessToken(deps.config, deps.db, s.user.id, Date.now())
    let listing
    try {
      listing = await discovery.list(scope, s.user.id, token, showAll, url.searchParams.get('refresh') === 'true')
    } catch (err) {
      if (!(err instanceof GithubApiError)) throw err
      sendJson(res, 502, { error: err.message })
      return
    }
    tokenMissing = listing.tokenMissing
    repositories = listing.repositories
      .map((r) => ({
        id: r.id, fullName: r.fullName, private: r.private, visibility: r.visibility, htmlUrl: r.htmlUrl,
        installed: r.installationId != null, selected: selected.has(r.id),
      }))
  }
  repositories.sort((a, b) => a.fullName.localeCompare(b.fullName))
  const total = repositories.length
  sendJson(res, 200, {
    installUrl: installUrl(deps.config),
    canAddAnyPublicRepository: canAddAnyPublicRepository(s.user, await deps.db.getUserGithubId(s.user.id)),
    repositories,
    connectedCount: selectedRows.length,
    inactiveCount: allRows.filter((r) => !r.active).length,
    total,
    tokenMissing,
  })
}

// The select half of the toggle: re-list the caller's reachable repos to VERIFY
// access (never trust a client-supplied id) and capture the server-derived read
// context (installation id, default branch). A PRIVATE repo with no installation
// can't be read server-side → 409. Stores via selectRepo (upsert).
async function selectRepository(res: ServerResponse, deps: ManagedHttpDeps, user: StoredUser, repoId: number, cookie: string | undefined): Promise<void> {
  if (!canAddRepositories(user)) { sendJson(res, 403, { error: 'forbidden' }); return }
  const userId = user.id
  const token = await ensureUserAccessToken(deps.config, deps.db, userId, Date.now())
  const { repositories } = await collectRepos(deps.config, token)
  let repo = repositories.find((r) => r.id === repoId)
  // A WHITEHAT addition may not appear in /user/repos. Revalidate the stored
  // canonical name when reactivating it, with the same permission gates.
  if (repo == null && canAddAnyPublicRepository(user, await deps.db.getUserGithubId(userId))) {
    const stored = (await deps.db.listAllRepos()).find(r => r.repoId === repoId)
    if (stored && !stored.private && stored.installationId == null) {
      try { repo = await fetchPublicRepository(stored.fullName) } catch (err) {
        if (!(err instanceof GithubApiError)) throw err
        sendJson(res, err.status, { error: err.message }); return
      }
      if (repo.id !== repoId) { sendJson(res, 409, { error: 'repo-identity-changed' }); return }
    }
  }
  if (repo == null) { sendJson(res, 404, { error: 'repo-not-accessible' }); return }
  // (0) Installed or explicitly public. For (3a), an admin may choose any App
  // installation; for (3b), /user/repos is the public involvement evidence.
  if (repo.installationId == null) {
    if (repo.private || repo.visibility !== 'public') { sendJson(res, 409, { error: 'repo-not-readable' }); return }
    if (!passesPublicRepositorySafeguard(await deps.db.getUserGithubId(userId), repositories.some(r => r.id === repoId))) {
      sendJson(res, 403, { error: 'forbidden' }); return
    }
  }
  if (await readAdminSession(res, deps, cookie) == null) return
  await connectRepository(res, deps, user, repo)
}

async function connectRepository(res: ServerResponse, deps: ManagedHttpDeps, user: StoredUser, repo: ConnectedRepo): Promise<void> {
  const alreadySelected = (await deps.db.listSelectedRepos()).some(row => row.repoId === repo.id)
  await deps.db.selectRepo({
    repoId: repo.id, fullName: repo.fullName, private: repo.private,
    installationId: repo.installationId, defaultBranch: repo.defaultBranch,
    htmlUrl: repo.htmlUrl, addedBy: user.id,
  }, Date.now())
  if (!alreadySelected) await activity(deps, user, 'repository', 'connected a repository', { repo: repo.fullName })
  sendJson(res, 200, { ok: true, selected: true })
}

// Separate from ordinary discovery: WHITEHAT bypasses only public involvement.
// Authentication, server admin permission, origin and CSRF remain mandatory.
async function handleAddPublicRepository(req: IncomingMessage, res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined): Promise<void> {
  if ((req.method ?? 'GET') !== 'POST') { send405(res, 'POST'); return }
  const s = await adminMutation(req, res, deps, cookie)
  if (s == null) return
  if (!canAddAnyPublicRepository(s.user, await deps.db.getUserGithubId(s.user.id))) { sendJson(res, 403, { error: 'forbidden' }); return }
  let body: unknown
  try { body = await readJsonBody(req) } catch { sendJson(res, 400, { error: 'bad-body' }); return }
  const fullName = publicRepositoryName((body as { repository?: unknown } | null)?.repository)
  if (fullName == null) { sendJson(res, 400, { error: 'bad-repository' }); return }
  let repo
  try { repo = await fetchPublicRepository(fullName) } catch (err) {
    if (!(err instanceof GithubApiError)) throw err
    sendJson(res, err.status, { error: err.message }); return
  }
  // A GitHub lookup can outlive a role change or logout.
  if (await readAdminSession(res, deps, cookie) == null) return
  // Only public access was verified. Keep its null installation context rather
  // than restoring a stored App installation that may no longer cover this repo.
  await connectRepository(res, deps, s.user, repo)
}

// Associate an existing connection with this App without changing its active
// state, ownership, team grants, or stored data. GitHub grants remain separate
// from the per-user checks required for browsing source.
async function handleConnectRepositoryApp(req: IncomingMessage, res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined): Promise<void> {
  if ((req.method ?? 'GET') !== 'POST') { send405(res, 'POST'); return }
  const s = await adminMutation(req, res, deps, cookie)
  if (s == null) return
  let body: unknown
  try { body = await readJsonBody(req) } catch { sendJson(res, 400, { error: 'bad-body' }); return }
  const repoId = (body as { repoId?: unknown } | null)?.repoId
  if (typeof repoId !== 'number' || !Number.isSafeInteger(repoId) || repoId <= 0) { sendJson(res, 400, { error: 'bad-request' }); return }
  const repo = (await deps.db.listAllRepos()).find(row => row.repoId === repoId)
  if (repo == null) { sendJson(res, 404, { error: 'repo-not-connected' }); return }
  if (repo.installationId != null) { sendJson(res, 200, { connected: true }); return }
  let installationId
  try { installationId = await repositoryInstallation(deps.config, repo.repoId, repo.fullName) } catch (err) {
    if (!(err instanceof GithubApiError)) throw err
    // These credentials belong to the server App, not the user's session.
    sendJson(res, err.status === 401 ? 502 : err.status, { error: err.message }); return
  }
  if (await readAdminSession(res, deps, cookie) == null) return
  if (installationId == null) {
    const current = (await deps.db.listAllRepos()).find(row => row.repoId === repoId)
    if (current == null || current.fullName !== repo.fullName || current.addedAt !== repo.addedAt || current.installationId != null) {
      sendJson(res, 409, { error: 'repo-connection-changed' }); return
    }
    const url = installUrl(deps.config)
    if (url == null) { sendJson(res, 503, { error: 'github-app-not-configured' }); return }
    sendJson(res, 200, { connected: false, installUrl: url }); return
  }
  if (!await deps.db.connectRepoInstallation(repo, installationId, s.session.id, Date.now())) {
    sendJson(res, 409, { error: 'repo-connection-changed' }); return
  }
  await activity(deps, s.user, 'repository', 'connected GitHub App access', { repo: repo.fullName })
  sendJson(res, 200, { connected: true })
}

// POST /api/admin/repositories/select — an admin toggles whether a repo is
// active in the operate-on set. Mutation: same-origin + CSRF. Body { repoId,
// selected }. selected:true verifies + records the read context; selected:false
// deactivates the row while retaining its reports, bundles, and metadata.
async function handleSelectRepository(req: IncomingMessage, res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined): Promise<void> {
  if ((req.method ?? 'GET') !== 'POST') { send405(res, 'POST'); return }
  const s = await adminMutation(req, res, deps, cookie)
  if (s == null) return
  let body: unknown
  try { body = await readJsonBody(req) } catch { sendJson(res, 400, { error: 'bad-body' }); return }
  const repoId = (body as { repoId?: unknown } | null)?.repoId
  const selected = (body as { selected?: unknown } | null)?.selected
  if (typeof repoId !== 'number' || !Number.isSafeInteger(repoId) || typeof selected !== 'boolean') {
    sendJson(res, 400, { error: 'bad-request' }); return
  }
  if (!selected) {
    const repo = (await deps.db.listSelectedRepos()).find(row => row.repoId === repoId)
    if (await readAdminSession(res, deps, cookie) == null) return
    await deps.db.deactivateRepo(repoId)
    if (repo) await activity(deps, s.user, 'repository', 'deactivated a repository', { repo: repo.fullName })
    sendJson(res, 200, { ok: true, selected: false }); return
  }
  await selectRepository(res, deps, s.user, repoId, cookie)
}

async function repositoryFindingIds(deps: ManagedHttpDeps, reports: { id: string, filename: string }[]): Promise<Set<string>> {
  const ids = new Set<string>()
  for (const report of reports) {
    const bytes = await deps.reportStore.get(report.id)
    if (bytes == null) throw new Error(`Cannot establish repository triage overlap: report ${report.id} is unavailable`)
    const parsed = await loadManagedFindings(bytes.toString('utf8'), report.filename)
    if (parsed == null) throw new Error(`Cannot establish repository triage overlap: report ${report.id} is unreadable`)
    for (const finding of parsed.findings) {
      const id = (finding as { id?: unknown })?.id
      if (typeof id === 'string' && id !== '') ids.add(id)
    }
  }
  return ids
}

async function repositoryImpact(deps: ManagedHttpDeps, repoId: number) {
  const allReports = await deps.db.listReports()
  const reports = allReports.filter((report) => report.repoId === repoId)
  const bundles = await deps.db.listBundlesForRepo(repoId)
  const triageIds = await repositoryExclusiveTriageIds(deps, reports, allReports.filter((report) => report.repoId !== repoId))
  return {
    reports: reports.map((report) => ({ id: report.id, filename: report.filename, repoDirectory: report.repoDirectory })),
    bundles,
    triageCount: triageIds.length,
  }
}

async function repositoryExclusiveTriageIds(deps: ManagedHttpDeps, reports: { id: string, filename: string }[], otherReports: { id: string, filename: string }[], annotationsOnly = true): Promise<string[]> {
  const targetIds = await repositoryFindingIds(deps, reports)
  const triage = annotationsOnly ? await deps.db.listTriage([...targetIds]) : []
  const commentIds = annotationsOnly ? await deps.db.listCommentedFindingIds([...targetIds]) : []
  // Removal includes every exclusive finding, including annotations created
  // during the blob scan; impact only needs the currently annotated subset.
  const annotatedIds = annotationsOnly ? new Set([...triage.map(entry => entry.findingId), ...commentIds]) : targetIds
  if (annotatedIds.size === 0) return []
  // Impact can skip unannotated findings; deletion must also cover new writes.
  // TODO(managed): Persist finding IDs per report at upload time and maintain
  // the index on report deletion. Use it for repository impact and triage
  // cleanup so overlap checks do not fetch and parse every other report blob.
  // Deferred for production; the preview still performs the blob scan below.
  const otherIds = await repositoryFindingIds(deps, otherReports)
  return [...annotatedIds].filter((id) => !otherIds.has(id))
}

// GET /api/admin/repositories/impact — show the data a permanent repository
// removal would destroy. This is intentionally separate from the repository
// list so the normal page stays cheap even with many reports.
async function handleRepositoryImpact(req: IncomingMessage, res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined): Promise<void> {
  const s = await readAdminSession(res, deps, cookie)
  if (s == null) return
  const repoId = Number(new URL(req.url ?? '/', 'http://localhost').searchParams.get('repoId'))
  if (!Number.isSafeInteger(repoId)) { sendJson(res, 400, { error: 'bad-repo' }); return }
  const repo = (await deps.db.listAllRepos()).find((candidate) => candidate.repoId === repoId)
  if (repo == null) { sendJson(res, 404, { error: 'no-repo' }); return }
  sendJson(res, 200, { repoId, fullName: repo.fullName, ...await repositoryImpact(deps, repoId) })
}

// POST /api/admin/repositories/remove — permanently remove a repository and
// attached reports/bundles. The exact name + explicit acknowledgement are
// checked server-side too; the UI's dialog is a usability guard, not the policy.
async function handleRemoveRepository(req: IncomingMessage, res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined): Promise<void> {
  const s = await checkMutation(req, res, deps, cookie)
  if (s == null) return
  if (s.user.role !== 'admin') { sendJson(res, 403, { error: 'forbidden' }); return }
  let body: unknown
  try { body = await readJsonBody(req) } catch { sendJson(res, 400, { error: 'bad-body' }); return }
  const repoId = (body as { repoId?: unknown } | null)?.repoId
  const fullName = (body as { fullName?: unknown } | null)?.fullName
  const acknowledge = (body as { acknowledge?: unknown } | null)?.acknowledge
  const deleteTriage = (body as { deleteTriage?: unknown } | null)?.deleteTriage
  if (typeof repoId !== 'number' || !Number.isSafeInteger(repoId) || typeof fullName !== 'string' || acknowledge !== true || typeof deleteTriage !== 'boolean') {
    sendJson(res, 400, { error: 'confirmation-required' }); return
  }
  const repo = (await deps.db.listAllRepos()).find((candidate) => candidate.repoId === repoId)
  if (repo == null) { sendJson(res, 404, { error: 'no-repo' }); return }
  if (repo.fullName !== fullName) { sendJson(res, 400, { error: 'repo-name-mismatch' }); return }
  const allReports = deleteTriage ? await deps.db.listReports() : []
  const triageIds = deleteTriage
    ? await repositoryExclusiveTriageIds(deps, allReports.filter(report => report.repoId === repoId), allReports.filter(report => report.repoId !== repoId), false)
    : []
  const { reports, bundles, deletedReports, deletedBundles, deletedTriage } = await deps.db.removeRepository(s.session.id, repo,
    deleteTriage ? { reports: reportReferenceSnapshot(allReports), ids: triageIds } : null)
  // Remove metadata first so a blob-store failure leaves an orphaned blob for
  // later cleanup, rather than a live row pointing at missing report data.
  for (const report of reports) {
    await deps.reportSourcesCache?.deleteReport(report).catch((err) => { console.warn('managed: report sources delete failed:', err) })
    await deps.reportStore.delete(report.id).catch(() => {})
  }
  for (const bundle of bundles) {
    // Best-effort derivative cleanup follows the committed metadata removal.
    await deps.bundleCache?.delete(bundle.id).catch((err) => { console.warn('managed: bundle cache delete failed:', err) })
    await deps.reportSourcesCache?.deleteBundle(bundle.id).catch((err) => { console.warn('managed: report sources delete failed:', err) })
    await deps.bundleStore.delete(bundle.id).catch(() => {})
  }
  sendJson(res, 200, { ok: true, deletedReports, deletedBundles, deletedTriage })
}

// Strip a client-supplied upload filename to a safe display string. The bytes
// are keyed by a server uuid. This name is used for display, Content-Disposition,
// and format detection: decode URLs, remove controls/paths, and cap the basename
// without discarding the extension that the report reader needs.
// Falls back to `fallback` when nothing usable remains.
function sanitizeFilename(raw: string | null, fallback: string): string {
  if (raw == null || raw === '') return fallback
  let decoded = raw
  try { decoded = decodeURIComponent(raw) } catch { decoded = raw }
  // Build the cleaned name char-by-char: drop control chars, fold path
  // separators to '_' (avoids a control-character regex).
  let cleaned = ''
  for (const ch of decoded) {
    const code = ch.codePointAt(0) ?? 0
    if (code < 0x20 || code === 0x7f) continue
    cleaned += ch === '/' || ch === '\\' ? '_' : ch
  }
  cleaned = cleaned.trim()
  if (cleaned.length <= 200) return cleaned || fallback
  const dot = cleaned.lastIndexOf('.')
  const suffix = dot > 0 ? cleaned.slice(dot) : ''
  // An extension that alone exceeds the cap cannot fit; ordinary extensions
  // (including case-sensitive display names such as .CSV) remain unchanged.
  const extension = suffix.length < 200 ? suffix : ''
  return cleaned.slice(0, 200 - extension.length) + extension
}

// The selected repos a report / bundle can be linked to, for the upload UI's
// repo picker. Minimal shape (id + full name).
function selectableRepos(repos: { repoId: number; fullName: string }[]): { repoId: number; fullName: string }[] {
  return repos.map((r) => ({ repoId: r.repoId, fullName: r.fullName }))
}

// Resolve the optional X-Repo-Id upload header to a selected repo id, or null
// when absent. Validates the id is currently in the selected-repos set (so the
// FK can't dangle); on a bad / unknown id sends 400 and returns { ok: false }.
async function resolveUploadRepoId(req: IncomingMessage, res: ServerResponse, deps: ManagedHttpDeps): Promise<{ ok: true; repoId: number | null } | { ok: false }> {
  const raw = firstHeader(req.headers['x-repo-id'])
  if (raw == null || raw === '') return { ok: true, repoId: null }
  const n = Number(raw)
  if (!Number.isSafeInteger(n)) { sendJson(res, 400, { error: 'bad-repo' }); return { ok: false } }
  const selected = await deps.db.listSelectedRepos()
  if (!selected.some((r) => r.repoId === n)) { sendJson(res, 400, { error: 'repo-not-selected' }); return { ok: false } }
  return { ok: true, repoId: n }
}

// POST /api/admin/reports/set-repo — attach / detach a stored report's repo
// + directory link. Mutation: same-origin + CSRF, admin|manage. Body
// { reportId, repoId, directory }, where repoId is null (detach) or a
// currently-selected repo id. Directory is relative to the repository root.
async function handleSetReportRepo(req: IncomingMessage, res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined): Promise<void> {
  const s = await manageMutation(req, res, deps, cookie)
  if (s == null) return
  let body: unknown
  try { body = await readJsonBody(req) } catch { sendJson(res, 400, { error: 'bad-body' }); return }
  const reportId = (body as { reportId?: unknown } | null)?.reportId
  const repoId = (body as { repoId?: unknown } | null)?.repoId ?? null
  const directory = (body as { directory?: unknown } | null)?.directory ?? ''
  if (typeof reportId !== 'string') { sendJson(res, 400, { error: 'bad-request' }); return }
  if (repoId !== null && (typeof repoId !== 'number' || !Number.isSafeInteger(repoId))) { sendJson(res, 400, { error: 'bad-repo' }); return }
  const normalized = normalizeTeamPath(directory)
  if (!normalized.ok) { sendJson(res, 400, { error: 'bad-directory' }); return }
  const { report, user } = await deps.db.mutateReport(s.session.id, reportId, { type: 'repo', repoId, directory: normalized.path ?? '' })
  if (report.repoId !== repoId || report.repoDirectory !== (repoId == null ? '' : normalized.path ?? '')) {
    await activity(deps, user, 'repository', repoId == null ? 'detached a report from its repository' : `assigned a report to repository path ${normalized.path || '/'}`, { reportId, report: report.filename, repo: await repositoryName(deps, repoId ?? report.repoId) })
  }
  sendJson(res, 200, { ok: true, repoId, repoDirectory: normalized.path ?? '' })
}

// POST /api/admin/reports/set-visible — publish or hide a stored report. New
// reports start hidden so an admin can inspect the parsed metadata first.
async function handleSetReportVisible(req: IncomingMessage, res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined): Promise<void> {
  const s = await manageMutation(req, res, deps, cookie)
  if (s == null) return
  let body: unknown
  try { body = await readJsonBody(req) } catch { sendJson(res, 400, { error: 'bad-body' }); return }
  const reportId = (body as { reportId?: unknown } | null)?.reportId
  const visible = (body as { visible?: unknown } | null)?.visible
  if (typeof reportId !== 'string' || typeof visible !== 'boolean') { sendJson(res, 400, { error: 'bad-request' }); return }
  const { report, user } = await deps.db.mutateReport(s.session.id, reportId, { type: 'visibility', visible })
  if (report.visible !== visible) await activity(deps, user, 'visibility', visible ? 'published a report' : 'hid a report', { reportId, report: report.filename, repo: await repositoryName(deps, report.repoId) })
  sendJson(res, 200, { ok: true, visible })
}

// POST /api/admin/bundles/set-repo — attach / detach a stored bundle's repo link
// and directory (same shape as reports). Body { bundleId, repoId, directory }.
async function handleSetBundleRepo(req: IncomingMessage, res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined): Promise<void> {
  const s = await manageMutation(req, res, deps, cookie)
  if (s == null) return
  let body: unknown
  try { body = await readJsonBody(req) } catch { sendJson(res, 400, { error: 'bad-body' }); return }
  const bundleId = (body as { bundleId?: unknown } | null)?.bundleId
  const repoId = (body as { repoId?: unknown } | null)?.repoId ?? null
  const normalized = normalizeTeamPath((body as { directory?: unknown } | null)?.directory ?? '')
  if (!normalized.ok) { sendJson(res, 400, { error: 'bad-directory' }); return }
  const directory = repoId == null ? '' : normalized.path ?? ''
  if (typeof bundleId !== 'string') { sendJson(res, 400, { error: 'bad-request' }); return }
  if (repoId !== null && (typeof repoId !== 'number' || !Number.isSafeInteger(repoId))) { sendJson(res, 400, { error: 'bad-repo' }); return }
  const { bundle, user } = await deps.db.mutateBundle(s.session.id, bundleId, { type: 'repo', repoId, directory })
  if (bundle.repoId !== repoId || bundle.repoDirectory !== directory) await activity(deps, user, 'repository', repoId == null ? 'detached a bundle from its repository' : `assigned a bundle to repository path ${directory || '/'}`, { bundleId, report: bundle.filename, repo: await repositoryName(deps, repoId ?? bundle.repoId) })
  sendJson(res, 200, { ok: true, repoId, repoDirectory: directory })
}

// GET /api/admin/reports — the uploaded reports for the "Manage reports" page.
// Visible to admin|manage. Read-only, so no CSRF (like /api/admin/users).
// `maxBytes` lets the page show / pre-check the upload size cap; `repos` feeds
// the upload repo picker.
async function handleListReports(res: ServerResponse, deps: ManagedHttpDeps, session: ManagedSession): Promise<void> {
  sendJson(res, 200, {
    ...await deps.db.getReportCatalog(session.id, Date.now()),
    maxBytes: deps.config.maxReportBytes,
  })
}

// Resolve a report's bundle link from its embedded `bundleHashes`: the first
// declared integrity that has a stored bundle wins (bundleId set). When none is
// stored yet, keep the first declared integrity so a later bundle upload of it
// re-links (see linkReportsToBundle). Returns the (bundleId, integrity) to store.
async function resolveReportBundle(deps: ManagedHttpDeps, user: StoredUser, bytes: Buffer): Promise<{ bundleId: string | null; integrity: string | null }> {
  const hashes = reportBundleHashes(bytes)
  for (const h of hashes) {
    const b = await deps.db.getBundleByIntegrity(h)
    if (b != null && await canAccessBundle(deps, user, b.id)) return { bundleId: b.id, integrity: h }
  }
  return { bundleId: null, integrity: hashes[0] ?? null }
}

async function sendUploadedReport(req: IncomingMessage, res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined, report: ReportRecord, deduped: boolean): Promise<void> {
  const current = await checkMutation(req, res, deps, cookie)
  if (!current || !requireManageRole(res, current.user)) return
  // Uploading known bytes cannot reveal another team's report or its source
  // bundle. The stored location/ownership wins over the upload headers.
  if (!(await canViewReport(deps, current.user, report.id))) { sendJson(res, 409, { error: 'report-conflict' }); return }
  const bundleId = report.bundleId != null && await canAccessBundle(deps, current.user, report.bundleId) ? report.bundleId : null
  const { id, slug, filename, byteSize, sha256, repoId, repoDirectory, repoEmbedded, analyzer, visible } = report
  sendJson(res, deduped ? 200 : 201, { id, slug, filename, byteSize, sha256, repoId, repoDirectory, repoEmbedded, analyzer, visible, bundleId, ...(deduped ? { deduped: true } : {}) })
}

// POST /api/admin/reports — upload a report. Mutation: same-origin + CSRF,
// admin|manage. The body is the raw report bytes (any findings format — JSON /
// markdown / CSV — archived as-is, like the e2e objstore; the server parses them
// downstream). Display name rides X-Report-Filename; the repository and
// directory come from the report header, or from optional repository/directory
// headers when the report has no repository metadata. The bundle link is
// auto-resolved from the report's bundleHashes. New reports start hidden until
// published. Identical content reuses its stored identity and metadata. Bytes
// are written first (keyed by a fresh uuid) then the metadata row. A definite
// insert failure or concurrent duplicate drops the orphan blob; an uncertain
// commit retains it. 413 over the cap, 400 on empty.
async function handleUploadReport(req: IncomingMessage, res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined): Promise<void> {
  let s = await checkMutation(req, res, deps, cookie)
  if (s == null) return
  if (!requireManageRole(res, s.user)) return
  let bytes: Buffer
  try {
    bytes = await readUploadBody(req, deps, s.session.id, 'reports')
  } catch (err) {
    const tooLarge = err instanceof Error && err.message === 'too-large'
    sendJson(res, tooLarge ? 413 : 400, { error: tooLarge ? 'too-large' : 'bad-body' })
    return
  }
  // Shared storage reads may outlast a session or role change.
  s = await checkMutation(req, res, deps, cookie)
  if (!s || !requireManageRole(res, s.user)) return
  if (bytes.length === 0) { sendJson(res, 400, { error: 'empty' }); return }
  const filename = sanitizeFilename(firstHeader(req.headers['x-report-filename']), 'report.json')
  const parsed = readManagedReport(bytes.toString('utf8'), filename)
  const repoGithub = parsed.data == null ? null : reportRepoGithub(parsed.data)
  const repoEmbedded = repoGithub != null
  const rawHeaderDirectory = firstHeader(req.headers['x-repo-directory']) ?? ''
  let headerDirectory = rawHeaderDirectory
  try { headerDirectory = decodeURIComponent(rawHeaderDirectory) } catch { sendJson(res, 400, { error: 'bad-directory' }); return }
  // Validate the raw header, not repoDirectory()'s display/link normalization,
  // which trims characters and turns invalid paths into the repository root.
  const requestedDirectory = repoEmbedded ? parsed.data?.repo?.directory : headerDirectory
  const normalizedDirectory = normalizeTeamPath(requestedDirectory)
  if (!normalizedDirectory.ok) { sendJson(res, 400, { error: 'bad-directory' }); return }
  const directory = normalizedDirectory.path ?? ''
  const analyzer = parsed.data != null && typeof parsed.data.source === 'string' ? parsed.data.source : null
  const selected = await deps.db.listSelectedRepos()
  let matchedRepo = repoGithub == null ? null : selected.find((repo) => repo.fullName.toLocaleLowerCase() === repoGithub.toLocaleLowerCase())
  if (repoGithub != null && matchedRepo == null) { sendJson(res, 400, { error: 'repo-not-connected', repo: repoGithub }); return }
  // When the report has no repository header, X-Repo-Id lets the managed uploader
  // assign it at upload time. Clients may omit it and attach the report later.
  if (repoGithub == null) {
    const legacyRepo = await resolveUploadRepoId(req, res, deps)
    if (!legacyRepo.ok) return
    matchedRepo = legacyRepo.repoId == null ? null : selected.find((repo) => repo.repoId === legacyRepo.repoId) ?? null
  }
  if (matchedRepo && s.user.role !== 'admin' && !(await deps.db.userCanReadRepoPath(s.user.id, matchedRepo.repoId, directory))) { sendJson(res, 403, { error: 'repo-forbidden' }); return }
  const sha256 = createHash('sha256').update(bytes).digest('base64url')
  // The analyzer also distinguishes a CSV from the same bytes previously
  // uploaded under a filename that did not identify it as a report.
  const existing = await deps.db.getReportByHash(sha256, analyzer)
  if (existing) { await sendUploadedReport(req, res, deps, cookie, existing, true); return }
  const id = randomUUID()
  const contentType = (firstHeader(req.headers['content-type']) ?? '').split(';', 1)[0]!.trim() || 'application/json'
  const { bundleId, integrity } = await resolveReportBundle(deps, s.user, bytes)
  const dataKey = await deps.reportStore.put(id, bytes)
  let report: ReportRecord
  try {
    report = await deps.db.insertOrReuseReport({
      id, filename, contentType, byteSize: bytes.length, sha256, dataKey,
      uploadedBy: s.user.id, uploadedByLogin: s.user.login, repoId: matchedRepo?.repoId ?? null,
      repoDirectory: directory, repoEmbedded, analyzer, visible: false, bundleId, bundleIntegrity: integrity,
    }, Date.now(), s.session.id)
  } catch (err) {
    // A successful COMMIT can lose its acknowledgement. Never delete a file
    // until a writer-locked read confirms that this candidate did not commit.
    let committed: ReportRecord | null
    try { committed = await deps.db.resolveReportUpload(id) }
    catch (lookup) { throw new AggregateError([err, lookup], 'Report upload reconciliation failed', { cause: lookup }) }
    if (committed) report = committed
    else { await deps.reportStore.delete(id).catch(() => {}); throw err }
  }
  if (report.id !== id) await deps.reportStore.delete(id).catch(() => {})
  await sendUploadedReport(req, res, deps, cookie, report, report.id !== id)
}

// GET /api/admin/reports/<id> — download a stored report (admin|manage). Serves
// the bytes with the recorded content-type + filename. The recorded content-type
// is uploader-supplied, so the response is forced to download
// (Content-Disposition: attachment) AND marked `nosniff` — it can't be sniffed
// or rendered inline against the app origin. 404 when there's no such report;
// 503 when the row exists but the bytes don't (store desync).
async function handleGetReport(res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined, id: string): Promise<void> {
  const s = await readManageSession(res, deps, cookie)
  if (s == null) return
  if (!(await canViewReport(deps, s.user, id))) { sendJson(res, 404, { error: 'no-report' }); return }
  const rec = await deps.db.getReport(id)
  if (rec == null) { sendJson(res, 404, { error: 'no-report' }); return }
  const bytes = await deps.reportStore.get(id)
  if (bytes == null) { sendJson(res, 503, { error: 'unavailable' }); return }
  const current = await readSession(deps.config, deps.db, cookie, Date.now())
  if (!current || !roleAtLeast(current.user.role, 'manage') || !(await canViewReport(deps, current.user, id))) { sendJson(res, 404, { error: 'no-report' }); return }
  // The stored filename is already control-/path-stripped (sanitizeReportFilename
  // at upload); only a double-quote could break the quoted Content-Disposition.
  const dispoName = rec.filename.replaceAll('"', '')
  res.writeHead(200, {
    'content-type': rec.contentType,
    'content-length': String(bytes.length),
    'content-disposition': `attachment; filename="${dispoName}"`,
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-store',
  })
  writeResponse(res, bytes)
}

// DELETE /api/admin/reports/<id> — remove a report (admin|manage). Mutation:
// same-origin + CSRF. Drops the row, then best-effort the bytes; 404 when there
// was no such report.
async function handleDeleteReport(req: IncomingMessage, res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined, id: string): Promise<void> {
  const s = await checkMutation(req, res, deps, cookie)
  if (s == null) return
  if (!requireManageRole(res, s.user)) return
  const { report, user } = await deps.db.mutateReport(s.session.id, id, { type: 'delete' })
  await deps.reportSourcesCache?.deleteReport(report).catch((err) => { console.warn('managed: report sources delete failed:', err) })
  await deps.reportStore.delete(id).catch((err) => { console.warn('managed: report bytes delete failed:', err) })
  await activity(deps, user, 'delete', 'deleted a report', { repoId: report.repoId, repoDirectory: report.repoDirectory, reportId: id, report: report.filename, repo: await repositoryName(deps, report.repoId) })
  sendJson(res, 200, { ok: true })
}

// Apply the same access rule to inventory, cached derivatives, raw downloads
// and mutations. Ownership is a manager exception; lower roles require teams.
async function canAccessBundle(deps: ManagedHttpDeps, user: StoredUser, id: string): Promise<boolean> {
  if (!roleAtLeast(user.role, 'view')) return false
  const rec = await deps.db.getBundle(id)
  if (!rec) return false
  if (user.role === 'admin') return true
  if (user.role === 'manage') return deps.db.userCanReadBundle(user.id, id)
  return rec.repoId !== null && deps.db.userCanReadRepoPath(user.id, rec.repoId, rec.repoDirectory)
}

async function bundleRepos(deps: ManagedHttpDeps, user: StoredUser) {
  const repos = await deps.db.listSelectedRepos()
  const access = await contentAccess(deps.db, user)
  return repos.filter(access.bundle)
}

async function repositoryBrowserUser(deps: ManagedHttpDeps, userId: string) {
  const [githubUserId, token] = await Promise.all([
    deps.db.getUserGithubId(userId), ensureUserAccessToken(deps.config, deps.db, userId, Date.now()),
  ])
  return { githubUserId, token }
}

// Listing connected repository names uses managed access only. Verify GitHub
// access after selection, before returning any refs or source directory data.
async function handleBrowsableRepositories(res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined): Promise<void> {
  const s = await readManageSession(res, deps, cookie)
  if (!s) return
  sendJson(res, 200, { repos: selectableRepos(await bundleRepos(deps, s.user)) })
}

// Recheck repository/path grants after upstream reads, before returning names.
async function handleRepositoryBrowser(res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined, query: URLSearchParams, refs: boolean): Promise<void> {
  const repoId = Number(query.get('repoId'))
  const normalized = normalizeTeamPath(query.get('path') ?? '')
  const ref = query.get('ref') ?? ''
  if (!Number.isSafeInteger(repoId) || repoId <= 0 || !normalized.ok || ref.length > 1024 || /\p{Cc}/u.test(ref)) {
    sendJson(res, 400, { error: 'bad-request' }); return
  }
  const path = normalized.path ?? ''
  const authorize = async () => {
    const s = await readManageSession(res, deps, cookie)
    if (!s) return null
    const repo = (await bundleRepos(deps, s.user)).find(item => item.repoId === repoId)
    if (!repo) { sendJson(res, 404, { error: 'no-repository' }); return null }
    const scopes = s.user.role === 'admin' ? [null] : (await deps.db.listRepoScopesForUser(s.user.id)).filter(scope => scope.repoId === repoId).map(scope => scope.path)
    const virtualEntries = scopedDirectory(path, scopes)
    if (!refs && virtualEntries?.length === 0) { sendJson(res, 404, { error: 'no-directory' }); return null }
    return { repo, virtualEntries, user: s.user }
  }
  const access = await authorize()
  if (!access) return
  try {
    const browser = createRepositoryBrowser(deps.config, await repositoryBrowserUser(deps, access.user.id))
    const reader = await browser.reader(access.repo)
    const commit = refs ? '' : await reader.commit(ref)
    const result = refs ? await reader.refs() : access.virtualEntries
      ? { entries: access.virtualEntries, limited: false } : await reader.directory(path, commit)
    await reader.recheckAccess()
    const current = await authorize()
    if (!current) return
    if (JSON.stringify(current.repo) !== JSON.stringify(access.repo)) { sendJson(res, 409, { error: 'repository-changed' }); return }
    sendJson(res, 200, refs ? result : {
      ...result, ...(current.virtualEntries ? { entries: current.virtualEntries, limited: false, packageEntryPoints: [], solidityEntryPoints: [], soliditySuggestionsLimited: false } : {}), path, commit,
    })
  } catch (err) {
    if (err instanceof GithubApiError) {
      sendJson(res, err.status === 401 ? 502 : err.status, { error: err.message }, err.retryAfter == null ? {} : { 'retry-after': String(err.retryAfter) })
      return
    }
    throw err
  }
}

function prebuildBundle(deps: ManagedHttpDeps, id: string) {
  if (!deps.bundleCache || deps.config.serverless) return
  deps.track((async () => {
    const record = await deps.db.getBundle(id)
    if (record?.kind) await deps.bundleCache!.prebuild(record)
  })().catch(err => console.warn('managed: bundle cache build failed:', err)))
}

// GET /api/bundles/:id/{metadata,contents}. Source/cache bytes are already encoded;
// the browser's HTTP stack decompresses them without a Brotli JS dependency.
async function handleBundleCache(req: IncomingMessage, res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined, id: string, part: BundleCachePart) {
  const s = await readSession(deps.config, deps.db, cookie, Date.now())
  if (!s) { sendJson(res, 401, { error: 'unauthenticated' }); return }
  if (!(await canAccessBundle(deps, s.user, id))) { sendJson(res, 404, { error: 'no-bundle' }); return }
  const rec = await deps.db.getBundle(id)
  if (!rec) { sendJson(res, 404, { error: 'no-bundle' }); return }
  if (!deps.bundleCache) { sendJson(res, 503, { error: 'unavailable' }); return }
  let cached
  try { cached = await deps.bundleCache.open(rec, part) }
  catch { sendJson(res, 422, { error: 'bundle-unavailable' }); return }
  // A cold build can outlast a session or membership change.
  const current = await readSession(deps.config, deps.db, cookie, Date.now())
  if (!current || !(await canAccessBundle(deps, current.user, id))) {
    cached.stream.destroy()
    sendJson(res, current ? 404 : 401, { error: current ? 'no-bundle' : 'unauthenticated' })
    return
  }
  res.writeHead(200, {
    'content-type': 'application/json', 'content-encoding': 'br',
    ...(cached.size == null ? {} : { 'content-length': String(cached.size) }), 'cache-control': 'private, no-store',
    'x-content-type-options': 'nosniff',
  })
  if (req.method === 'HEAD') { cached.stream.destroy(); res.end(); return }
  try { await pipeline(cached.stream, res) } catch { res.destroy() }
}

// Published npm advisories require security access, independently of access to
// unpublished dependency findings. Managers retain their normal bundle access.
async function handleBundleAdvisories(res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined, id: string, teamId: string | null, reason: string) {
  const authorize = async () => {
    const session = await readSession(deps.config, deps.db, cookie, Date.now())
    if (!session) { sendJson(res, 401, { error: 'unauthenticated' }); return false }
    if (!(await canAccessBundle(deps, session.user, id))) { sendJson(res, 404, { error: 'no-bundle' }); return false }
    if (!roleAtLeast(session.user.role, 'manage') && !(await deps.db.userCanReadBundleAdvisories(session.user.id, id, teamId))) {
      sendJson(res, 403, { error: 'security-access-required' }); return false
    }
    return true
  }
  if (!(await authorize())) return
  const record = await deps.db.getBundle(id)
  if (!record) { sendJson(res, 404, { error: 'no-bundle' }); return }
  if (record.kind !== 'stasis') { sendJson(res, 422, { error: 'unsupported-bundle' }); return }
  if (!deps.bundleCache) { sendJson(res, 503, { error: 'unavailable' }); return }
  let packages: Record<string, string[]> | null | undefined
  try { packages = await deps.bundleCache.packageVersions(record, reason) }
  catch { sendJson(res, 422, { error: 'bundle-unavailable' }); return }
  if (!(await authorize())) return
  if (packages === null) { sendJson(res, 413, { error: 'payload-too-large' }); return }
  if (packages === undefined) { sendJson(res, 400, { error: 'unknown-reason' }); return }
  const body = Buffer.from(JSON.stringify(packages))
  if (body.length > MAX_PACKAGE_INVENTORY_BYTES) { sendJson(res, 413, { error: 'payload-too-large' }); return }
  const controller = new AbortController()
  const onClose = () => { if (!res.writableEnded) controller.abort() }
  res.on('close', onClose)
  const timer = setTimeout(() => controller.abort(), NPM_ADVISORIES_TIMEOUT_MS)
  try {
    if (res.destroyed) return
    const result = Object.keys(packages).length === 0 ? { status: 200, body: {} }
      : await fetchNpmAdvisories(body, controller.signal, deps.config.debug)
    if (res.destroyed || !(await authorize())) return
    // Return just inventory and public advisories, never source or report data.
    sendJson(res, result.status, result.status >= 200 && result.status < 300 ? { packages, advisories: result.body } : result.body)
  } finally {
    clearTimeout(timer)
    res.off('close', onClose)
  }
}

// GET /api/admin/bundles — the uploaded bundles for the "Manage bundles" page.
// admin|manage, read-only (no CSRF). `maxBytes` is the upload cap; `repos` feeds
// the upload repo picker.
async function handleListBundles(res: ServerResponse, deps: ManagedHttpDeps, session: ManagedSession): Promise<void> {
  const before = await deps.db.getBundleCatalog(session.id, Date.now())
  const summaries = await bundleSummaries(before.bundles, deps.bundleCache)
  // Even cached storage reads may outlast changes to access or locations.
  const catalog = await deps.db.getBundleCatalog(session.id, Date.now())
  sendJson(res, 200, {
    ...catalog,
    bundles: catalog.bundles.map(bundle => ({
      ...bundle, ...(summaries.get(bundle.integrity) ?? { summary: null, summaryRetryAt: null }),
    })),
    maxBytes: deps.config.maxBundleBytes,
  })
  await backfillBundleSummaries(catalog.bundles, deps.bundleCache)
}

type UploadedBundle = Pick<ManagedBundle, 'id' | 'integrity' | 'filename' | 'byteSize' | 'repoId' | 'repoDirectory'>
async function sendUploadedBundle(req: IncomingMessage, res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined, bundle: UploadedBundle, deduped: boolean): Promise<void> {
  const s = await manageMutation(req, res, deps, cookie)
  if (!s) return
  if (deduped && !(await canAccessBundle(deps, s.user, bundle.id))) { sendJson(res, 409, { error: 'bundle-conflict' }); return }
  const { id, integrity, filename, byteSize, repoId, repoDirectory } = bundle
  // Re-uploading also repairs reports uploaded while the bundle was inaccessible.
  await deps.db.linkReportsToBundle(integrity, id, s.user.role === 'admin' ? undefined : s.user.id)
  prebuildBundle(deps, id)
  sendJson(res, deduped ? 200 : 201, { id, integrity, filename, repoId, repoDirectory, ...(deduped ? { deduped: true } : { byteSize }) })
}

// POST /api/admin/bundles — upload a bundle. Mutation: same-origin + CSRF,
// admin|manage. Raw bytes; X-Bundle-Filename names it, optional X-Repo-Id and
// X-Repo-Directory assign a repository location. The bundle's identity is its content hash (sha512), UNIQUE — a
// re-upload of identical bytes dedupes to the existing row (no second copy).
// After storing, any reports that declared this integrity but weren't linked yet
// get attached (auto-link). 413 over the cap, 400 on empty.
async function handleUploadBundle(req: IncomingMessage, res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined): Promise<void> {
  let s = await checkMutation(req, res, deps, cookie)
  if (s == null) return
  if (!requireManageRole(res, s.user)) return
  let bytes: Buffer
  try {
    bytes = await readUploadBody(req, deps, s.session.id, 'bundles')
  } catch (err) {
    const tooLarge = err instanceof Error && err.message === 'too-large'
    sendJson(res, tooLarge ? 413 : 400, { error: tooLarge ? 'too-large' : 'bad-body' })
    return
  }
  // Shared storage reads may outlast a session or role change.
  s = await checkMutation(req, res, deps, cookie)
  if (!s || !requireManageRole(res, s.user)) return
  if (bytes.length === 0) { sendJson(res, 400, { error: 'empty' }); return }
  const repo = await resolveUploadRepoId(req, res, deps)
  if (!repo.ok) return
  let rawDirectory
  try { rawDirectory = decodeURIComponent(firstHeader(req.headers['x-repo-directory']) ?? '') }
  catch { sendJson(res, 400, { error: 'bad-directory' }); return }
  const normalized = normalizeTeamPath(rawDirectory)
  if (!normalized.ok) { sendJson(res, 400, { error: 'bad-directory' }); return }
  const directory = repo.repoId == null ? '' : normalized.path ?? ''
  if (repo.repoId !== null && s.user.role !== 'admin' && !(await deps.db.userCanReadRepoPath(s.user.id, repo.repoId, directory))) {
    sendJson(res, 403, { error: 'forbidden' }); return
  }
  const integrity = bundleIntegrity(bytes)
  const filename = sanitizeFilename(firstHeader(req.headers['x-bundle-filename']), 'bundle')
  const existing = await deps.db.getBundleByIntegrity(integrity)
  if (existing) { await sendUploadedBundle(req, res, deps, cookie, existing, true); return }
  const id = randomUUID()
  const kind = bundleKind(filename)
  const dataKey = await deps.bundleStore.put(id, bytes, kind)
  try {
    await deps.db.insertBundle({
      id, integrity, filename, kind, dataKey,
      byteSize: bytes.length, uploadedBy: s.user.id, uploadedByLogin: s.user.login, repoId: repo.repoId, repoDirectory: directory,
    }, Date.now(), s.session.id)
  } catch (err) {
    // A concurrent upload of identical bytes can insert this integrity (UNIQUE)
    // between our dedup check and this insert — treat that as a dedup, not a 500.
    // Any other failure rethrows.
    let raced: ManagedBundle | null
    try { raced = await deps.db.resolveBundleUpload(integrity) }
    catch (lookup) { throw new AggregateError([err, lookup], 'Bundle upload reconciliation failed', { cause: lookup }) }
    // Preserve a committed candidate after a lost acknowledgement. If this
    // read fails too, leave the bytes for later reconciliation.
    if (raced?.id !== id) await deps.bundleStore.delete(id).catch(() => {})
    if (err instanceof ManagedMutationError) throw err
    if (!raced) throw err
    if (raced.id !== id) { await sendUploadedBundle(req, res, deps, cookie, raced, true); return }
    // Our insert committed: continue with the ordinary creation response.
  }
  await sendUploadedBundle(req, res, deps, cookie, { id, integrity, filename, byteSize: bytes.length, repoId: repo.repoId, repoDirectory: directory }, false)
}

// GET /api/admin/bundles/<id> — download a stored bundle (admin|manage). Bytes
// are opaque archives, so served as application/octet-stream. Sourcemaps use
// HTTP Brotli decoding to restore the uploaded .map bytes. 404 no such
// bundle; 503 row-without-bytes (store desync).
async function handleGetBundle(req: IncomingMessage, res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined, id: string): Promise<void> {
  const s = await readSession(deps.config, deps.db, cookie, Date.now())
  if (s == null) { sendJson(res, 401, { error: 'unauthenticated' }); return }
  if (!(await canAccessBundle(deps, s.user, id))) { sendJson(res, 404, { error: 'no-bundle' }); return }
  const rec = await deps.db.getBundle(id)
  if (rec == null) { sendJson(res, 404, { error: 'no-bundle' }); return }
  const stored = await deps.bundleStore.open(id, rec.kind)
  if (stored == null) { sendJson(res, 503, { error: 'unavailable' }); return }
  const current = await readSession(deps.config, deps.db, cookie, Date.now())
  if (!current || !(await canAccessBundle(deps, current.user, id))) {
    stored.stream.destroy()
    sendJson(res, current ? 404 : 401, { error: 'no-bundle' }); return
  }
  const dispoName = rec.filename.replaceAll('"', '')
  res.writeHead(200, {
    'content-type': 'application/octet-stream',
    ...(rec.kind === 'sourcemap' ? { 'content-encoding': 'br' } : {}),
    ...(stored.size == null ? {} : { 'content-length': String(stored.size) }),
    'content-disposition': `attachment; filename="${dispoName}"`,
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-store',
  })
  if (req.method === 'HEAD') { stored.stream.destroy(); res.end(); return }
  try { await pipeline(stored.stream, res) } catch { res.destroy() }
}

// DELETE /api/admin/bundles/<id> — remove a bundle (admin|manage). Mutation:
// same-origin + CSRF. Drops the row (referencing reports' bundle_id null out via
// the FK; their bundle_integrity stays, so a re-upload re-links), then the bytes
// best-effort. 404 when there was no such bundle.
async function handleDeleteBundle(req: IncomingMessage, res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined, id: string): Promise<void> {
  const s = await checkMutation(req, res, deps, cookie)
  if (s == null) return
  if (!requireManageRole(res, s.user)) return
  const { bundle, user } = await deps.db.mutateBundle(s.session.id, id, { type: 'delete' })
  await deps.bundleCache?.delete(id).catch((err) => { console.warn('managed: bundle cache delete failed:', err) })
  await deps.reportSourcesCache?.deleteBundle(id).catch((err) => { console.warn('managed: report sources delete failed:', err) })
  await deps.bundleStore.delete(id).catch((err) => { console.warn('managed: bundle bytes delete failed:', err) })
  await activity(deps, user, 'delete', 'deleted a bundle', { repoId: bundle.repoId, repoDirectory: bundle.repoDirectory, bundleId: id, report: bundle.filename, repo: await repositoryName(deps, bundle.repoId) })
  sendJson(res, 200, { ok: true })
}

// admin|manage mutation guard: same-origin + CSRF + role, in one step. Returns
// the session, or null after the 401/403 was sent.
async function manageMutation(req: IncomingMessage, res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined): Promise<{ session: ManagedSession; user: StoredUser } | null> {
  const s = await checkMutation(req, res, deps, cookie)
  if (s == null) return null
  if (!requireManageRole(res, s.user)) return null
  return s
}

// Workspace access and repository connections are administered separately
// from content management. Managers cannot change their own access via teams.
async function adminMutation(req: IncomingMessage, res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined): Promise<{ session: ManagedSession; user: StoredUser } | null> {
  const s = await checkMutation(req, res, deps, cookie)
  if (s == null) return null
  if (s.user.role !== 'admin') { sendJson(res, 403, { error: 'forbidden' }); return null }
  return s
}

// GET /api/teams — the CURRENT user's teams, each with the reports and bundles
// attached to the team's repos, for the sidebar's per-user Teams section. Any approved
// user (not just admin|manage); a user only ever sees their own teams.
async function handleMyTeams(res: ServerResponse, deps: ManagedHttpDeps, session: ManagedSession): Promise<void> {
  let snapshot = await deps.db.getUserTeamFeedSnapshot(session.id, Date.now())
  if (!snapshot) { sendJson(res, 401, { error: 'unauthenticated' }); return }
  const summaries = await bundleSummaries(snapshot.teams.flatMap(team => team.bundles), deps.bundleCache)
  const current = await deps.db.getFeedState(session.id, Date.now())
  if (!current) { sendJson(res, 401, { error: 'unauthenticated' }); return }
  // Keep the post-storage authorization fence, but reload the catalog only
  // when a concurrent mutation actually invalidated its consistent snapshot.
  if (current.user.id !== snapshot.user.id || current.user.role !== snapshot.user.role || current.catalog !== snapshot.catalog) {
    snapshot = await deps.db.getUserTeamFeedSnapshot(session.id, Date.now())
    if (!snapshot) { sendJson(res, 401, { error: 'unauthenticated' }); return }
  }
  const { teams, revision } = snapshot
  sendJson(res, 200, {
    teams: teams.map(team => ({ ...team, bundles: team.bundles.map(bundle => ({ ...bundle, ...(summaries.get(bundle.integrity) ?? { summary: null, summaryRetryAt: null }) })) })),
    revision,
  })
  await backfillBundleSummaries(teams.flatMap(team => team.bundles), deps.bundleCache)
}

// Admins read all reports. Managers read their uploads or reports inside their
// team repository paths, including drafts they may manage. View/triage users
// need a published report in their teams; ownership never overrides role none.
async function canViewReport(deps: ManagedHttpDeps, user: StoredUser, reportId: string): Promise<boolean> {
  if (!roleAtLeast(user.role, 'view')) return false
  const report = await deps.db.getReport(reportId)
  if (report == null) return false
  if (user.role === 'admin') return true
  if (user.role === 'manage') return report.uploadedBy === user.id || deps.db.userCanReadReport(user.id, reportId)
  if (!report.visible) return false
  return deps.db.userCanReadReport(user.id, reportId)
}

// GET/HEAD /api/reports/:id/sources. Only the linked bundle's files cited by
// visible findings (location AND evidence) are returned. Missing/unavailable
// bundles are a quiet no-op; cached gzip bodies stream directly from disk.
async function handleReportSources(req: IncomingMessage, res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined, id: string, teamId: string | null) {
  const s = await readSession(deps.config, deps.db, cookie, Date.now())
  if (!s) { sendJson(res, 401, { error: 'unauthenticated' }); return }
  if (!(await canViewReport(deps, s.user, id))) { sendJson(res, 404, { error: 'no-report' }); return }
  const sourcePaths = roleAtLeast(s.user.role, 'manage') ? undefined : await teamSourcePaths(deps.db, deps.reportStore, s.session.id, teamId ?? '', id)
  const report = await deps.db.getReport(id)
  const bundle = report?.bundleId ? await deps.db.getBundle(report.bundleId) : null
  const empty = () => { res.writeHead(204, { 'cache-control': 'private, no-store' }); res.end() }
  if (!report || !bundle || !['stasis', 'sourcemap'].includes(bundle.kind ?? '') || !(await canAccessBundle(deps, s.user, bundle.id))) { empty(); return }
  if (!deps.reportSourcesCache) { sendJson(res, 503, { error: 'unavailable' }); return }
  let cached
  try { cached = await deps.reportSourcesCache.open(report, bundle, { dependencies: true, security: true }, sourcePaths) }
  catch { empty(); return }
  if (!cached) { empty(); return }
  // Cold parsing can outlast role/team changes, report deletion, or relinking.
  const current = await readSession(deps.config, deps.db, cookie, Date.now())
  const latest = await deps.db.getReport(id)
  let latestPaths: Set<string> | undefined
  try { latestPaths = current && !roleAtLeast(current.user.role, 'manage') ? await teamSourcePaths(deps.db, deps.reportStore, current.session.id, teamId ?? '', id) : undefined }
  catch (error) { cached.stream.destroy(); throw error }
  if (!current || current.user.role !== s.user.role || sourcePaths?.size !== latestPaths?.size || [...sourcePaths ?? []].some(path => !latestPaths?.has(path)) || !(await canViewReport(deps, current.user, id)) || !(await canAccessBundle(deps, current.user, bundle.id))
      || latest?.bundleId !== bundle.id || latest.sha256 !== report.sha256
      || latest.repoId !== report.repoId || await repositoryName(deps, latest.repoId) !== cached.repo.github) {
    cached.stream.destroy()
    sendJson(res, current ? 404 : 401, { error: current ? 'no-report' : 'unauthenticated' })
    return
  }
  res.writeHead(200, {
    'content-type': 'application/json', 'content-encoding': 'gzip',
    ...(cached.size == null ? {} : { 'content-length': String(cached.size) }), 'cache-control': 'private, no-store',
    'x-content-type-options': 'nosniff',
  })
  if (req.method === 'HEAD') { cached.stream.destroy(); res.end(); return }
  try { await pipeline(cached.stream, res) } catch { res.destroy() }
}

// GET /api/reports/<id> — admin/manager preview, within management access.
// Accept: application/json includes parsed, filtered data and the server's repo
// assignment. Other callers retain the raw text/plain response. The
// client renders either without caching to OPFS. 404 covers "no such report" AND
// "not authorized" (so neither existence nor membership is probeable); 503 = row
// without bytes (store desync).
async function handleViewReport(req: IncomingMessage, res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined, id: string): Promise<void> {
  const s = await readManageSession(res, deps, cookie)
  if (s == null) return
  if (!(await canViewReport(deps, s.user, id))) { sendJson(res, 404, { error: 'no-report' }); return }
  const bytes = await deps.reportStore.get(id)
  if (bytes == null) { sendJson(res, 503, { error: 'unavailable' }); return }
  const current = await readSession(deps.config, deps.db, cookie, Date.now())
  if (!current || !roleAtLeast(current.user.role, 'manage') || !(await canViewReport(deps, current.user, id))) { sendJson(res, 404, { error: 'no-report' }); return }
  if (acceptsReportMetadata(req.headers.accept)) {
    const report = await deps.db.getReport(id)
    if (report == null) { sendJson(res, 404, { error: 'no-report' }); return }
    const repo = { github: await repositoryName(deps, report.repoId), directory: report.repoDirectory }
    const { data } = readManagedReport(bytes.toString('utf8'), report.filename)
    if (data == null) { sendJson(res, 422, { error: 'unreadable-report' }); return }
    sendJson(res, 200, {
      data,
      repo,
    }, { vary: 'Accept', 'x-content-type-options': 'nosniff' })
    return
  }
  const out = bytes
  res.writeHead(200, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': String(out.length),
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-store',
    vary: 'Accept',
  })
  writeResponse(res, out)
}

// A read-only POST avoids URL-length limits when a workspace has many reports.
// Authorize every requested id before reading blobs; never return a partial
// workspace, or let one authorized report grant access to another in the batch.
const REPORT_QUERY_CONCURRENCY = 8
const REPORT_QUERY_IN_FLIGHT_BYTES = 64 * 1024 * 1024
async function handleQueryReports(req: IncomingMessage, res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined): Promise<void> {
  const s = await readManageSession(res, deps, cookie)
  if (!s) return
  let body
  try { body = await readJsonBody(req, 1024 * 1024) } catch { sendJson(res, 400, { error: 'bad-body' }); return }
  const raw = (body as { ids?: unknown } | null)?.ids
  if (!Array.isArray(raw) || raw.some(id => typeof id !== 'string' || !id || id.length > 256)) {
    sendJson(res, 400, { error: 'bad-ids' }); return
  }
  const ids = [...new Set(raw as string[])]
  if (ids.length > MAX_REPORT_QUERY_COUNT) { sendJson(res, 413, { error: 'batch-too-large' }); return }
  const snapshot = await deps.db.getReportAccessSnapshot(s.session.id, Date.now(), ids)
  if (!snapshot || snapshot.user.id !== s.user.id) { sendJson(res, 401, { error: 'unauthenticated' }); return }
  if (!roleAtLeast(snapshot.user.role, 'manage')) { sendJson(res, 404, { error: 'no-report' }); return }
  const reports = new Map(snapshot.reports.map(report => [report.id, report]))
  if (reports.size !== ids.length) { sendJson(res, 404, { error: 'no-report' }); return }
  const storedBytes = snapshot.reports.reduce((total, report) => total + report.byteSize, 0)
  if (storedBytes > MAX_REPORT_QUERY_BYTES) { sendJson(res, 413, { error: 'batch-too-large' }); return }
  // Overlap remote blob reads, retaining only each report's encoded response
  // after processing. Check actual bytes too if storage and metadata disagree.
  const parts = [Buffer.from('{"reports":[')]
  let inputBytes = 0, outputBytes = parts[0]!.length + 2
  let next = 0, stopped = false
  let inFlightBytes = 0
  let capacity = Promise.withResolvers<void>()
  const fail = (status: number, error: string) => { stopped = true; return { status, error } }
  const workers = await Promise.allSettled(Array.from({ length: Math.min(REPORT_QUERY_CONCURRENCY, ids.length) }, async () => {
    try {
      while (next < ids.length) {
        if (stopped) return
        const index = next
        const id = ids[index]!
        const access = reports.get(id)!
        const reservedBytes = Math.max(1, access.byteSize)
        // Reserve stored bytes before starting remote reads, through encoding.
        // A report larger than the concurrent budget is still allowed alone.
        if (inFlightBytes > 0 && inFlightBytes + reservedBytes > REPORT_QUERY_IN_FLIGHT_BYTES) {
          await capacity.promise
          continue
        }
        next++
        inFlightBytes += reservedBytes
        try {
          const bytes = await deps.reportStore.get(id)
          if (stopped) return
          if (bytes == null) return fail(503, 'unavailable')
          inputBytes += bytes.length
          if (inputBytes > MAX_REPORT_QUERY_BYTES) return fail(413, 'batch-too-large')
          const { data } = readManagedReport(bytes.toString('utf8'), access.filename)
          if (!data) return fail(422, 'unreadable-report')
          const part = Buffer.from(`${index > 0 ? ',' : ''}${JSON.stringify({ id, data: filterReportData(data, access.permissions, access.repo), repo: access.repo })}`)
          outputBytes += part.length
          if (outputBytes > MAX_REPORT_QUERY_BYTES) return fail(413, 'batch-too-large')
          // Completion order may differ from the requested report order.
          parts[index + 1] = part
        } finally {
          inFlightBytes -= reservedBytes
          capacity.resolve()
          capacity = Promise.withResolvers<void>()
        }
      }
    } catch (error) {
      if (stopped) return
      stopped = true
      throw error
    }
    return undefined
  }))
  // Stop scheduling on any failure, and drain already-started reads before
  // responding so none outlive the tracked request or reject unhandled.
  for (const result of workers) {
    if (result.status === 'rejected') throw result.reason
    if (result.value) { sendJson(res, result.value.status, { error: result.value.error }); return }
  }
  // Access to an earlier report may change while a later blob is fetched.
  // Reject the whole answer if any content/access/assignment snapshot changed.
  const current = await deps.db.getReportAccessSnapshot(s.session.id, Date.now(), ids)
  if (!current || current.user.id !== snapshot.user.id) { sendJson(res, 401, { error: 'unauthenticated' }); return }
  if (current.user.role !== snapshot.user.role || current.reports.length !== reports.size
    || current.reports.some(report => JSON.stringify(report) !== JSON.stringify(reports.get(report.id)))) {
    sendJson(res, 404, { error: 'no-report' }); return
  }
  parts.push(Buffer.from(']}'))
  res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
  writeResponse(res, Buffer.concat(parts, outputBytes))
}

// The server selects the complete workspace; clients cannot omit a report
// or links file to evade classification through the rest of their team.
async function handleTeamReports(res: ServerResponse, deps: ManagedHttpDeps, session: ManagedSession, teamId: string): Promise<void> {
  const snapshot = await teamSnapshot(deps.db, session.id, teamId)
  const reports = await loadTeamReports(deps.db, deps.reportStore, snapshot)
  await recheckTeam(deps.db, session.id, snapshot)
  const parts = [Buffer.from('{"reports":[')]
  for (const [index, report] of reports.entries()) parts.push(Buffer.from(`${index ? ',' : ''}${JSON.stringify(report)}`))
  parts.push(Buffer.from(']}'))
  res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
  writeResponse(res, Buffer.concat(parts))
}

// Triage requires both a writing role and access to the report itself.
async function canTriageReport(deps: ManagedHttpDeps, user: StoredUser, reportId: string): Promise<boolean> {
  return roleAtLeast(user.role, 'triage') && await canViewReport(deps, user, reportId)
}

// Ordinary users authorize annotations through the complete team's filtered
// workspace. Privileged users retain report-scoped access and the same stable
// ID derivation. Both paths store/read annotations by finding ID alone.
const VISIBLE_IDS_CACHE_MAX = 256
const visibleIdsCaches = new WeakMap<ManagedHttpDeps, Map<string, Set<string>>>()
async function visibleFindingIds(deps: ManagedHttpDeps, user: StoredUser, reportId: string, sessionId: string, teamId: string | null): Promise<Set<string>> {
  if (!roleAtLeast(user.role, 'manage')) {
    if (!teamId) throw new TeamReportsError(404, 'no-team')
    return teamFindingIds(deps.db, deps.reportStore, sessionId, teamId, reportId)
  }
  const rec = await deps.db.getReport(reportId)
  if (rec == null) return new Set()
  const repo = { github: await repositoryName(deps, rec.repoId) }
  const key = JSON.stringify([reportId, rec.sha256, rec.filename, repo])
  let cache = visibleIdsCaches.get(deps)
  if (cache == null) { cache = new Map(); visibleIdsCaches.set(deps, cache) }
  const hit = cache.get(key)
  if (hit != null) return hit
  const ids = new Set<string>()
  const bytes = await deps.reportStore.get(reportId)
  if (bytes == null) return ids
  const text = bytes.toString('utf8')
  const { data } = readManagedReport(text, rec.filename)
  if (data == null) return ids
  const report = await loadManagedFindings(JSON.stringify(data), rec.filename)
  if (report == null) return ids
  for (const f of report.findings) {
    const id = (f as { id?: unknown }).id
    if (typeof id === 'string' && id !== '') ids.add(id)
  }
  while (cache.size >= VISIBLE_IDS_CACHE_MAX) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
  cache.set(key, ids)
  return ids
}

// GET /api/reports/<id>/triage — the stored triage entries for the findings of
// a report the caller may view (canViewReport; 404 hides existence and denial
// alike, matching handleViewReport). Entries are keyed by finding id and shared
// by every report carrying the finding; a viewer only receives entries for
// findings their visibility permissions keep in THIS report — an entry on a
// stripped finding must not leak that the finding exists. A cleared entry is
// sent as null (the server's tombstone), distinct from one never set.
async function handleGetReportTriage(res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined, id: string, teamId: string | null): Promise<void> {
  const s = await readSession(deps.config, deps.db, cookie, Date.now())
  if (s == null) { sendJson(res, 401, { error: 'unauthenticated' }); return }
  if (!(await canViewReport(deps, s.user, id))) { sendJson(res, 404, { error: 'no-report' }); return }
  await visibleFindingIds(deps, s.user, id, s.session.id, teamId)
  const current = await readSession(deps.config, deps.db, cookie, Date.now())
  if (!current || !(await canViewReport(deps, current.user, id)) || current.user.role !== s.user.role) { sendJson(res, 404, { error: 'no-report' }); return }
  const visible = await visibleFindingIds(deps, current.user, id, current.session.id, teamId)
  const entries: Record<string, TriageEntryPatch | null> = {}
  for (const row of await deps.db.listTriage([...visible])) entries[row.findingId] = triageWireEntry(row)
  sendJson(res, 200, { entries })
}

// GET /api/reports/<id>/triage/history?finding=<fid> — one finding's triage
// trail (newest first, capped). The caller must have at least triage access
// to the report, and the finding is one their visibility permissions
// keep in it (a stripped or foreign id 404s without revealing whether it
// exists). Each event is the entry as written then (null = a clear), who
// wrote it and when; "what changed" is the diff against the next-older event.
async function handleGetReportTriageHistory(res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined, id: string, query: URLSearchParams, teamId: string | null): Promise<void> {
  const s = await readSession(deps.config, deps.db, cookie, Date.now())
  if (s == null) { sendJson(res, 401, { error: 'unauthenticated' }); return }
  if (!(await canTriageReport(deps, s.user, id))) { sendJson(res, 404, { error: 'no-report' }); return }
  const finding = query.get('finding') ?? ''
  if (finding === '' || finding.length > MAX_FINDING_ID) { sendJson(res, 400, { error: 'bad-request' }); return }
  await visibleFindingIds(deps, s.user, id, s.session.id, teamId)
  const current = await readSession(deps.config, deps.db, cookie, Date.now())
  if (!current || !(await canTriageReport(deps, current.user, id)) || current.user.role !== s.user.role) { sendJson(res, 404, { error: 'no-report' }); return }
  const visible = await visibleFindingIds(deps, current.user, id, current.session.id, teamId)
  if (!visible.has(finding)) { sendJson(res, 404, { error: 'no-finding' }); return }
  const events = (await deps.db.listTriageHistory(finding, MAX_TRIAGE_HISTORY)).map((row: TriageEventRow) => ({
    seq: row.seq, at: row.at, actorId: row.actorId, actorLogin: row.actorLogin, actorName: row.actorName,
    batchId: row.batchId, entry: triageWireEntry(row, true),
  }))
  // A database read can outlive a role, membership, or visibility change.
  const latest = await readSession(deps.config, deps.db, cookie, Date.now())
  if (!latest || latest.user.role !== current.user.role || !(await canTriageReport(deps, latest.user, id))) { sendJson(res, 404, { error: 'no-report' }); return }
  if (!(await visibleFindingIds(deps, latest.user, id, latest.session.id, teamId)).has(finding)) { sendJson(res, 404, { error: 'no-finding' }); return }
  sendJson(res, 200, { finding, events })
}

// POST /api/reports/<id>/triage — write triage entries for a report's findings.
// Mutation: same-origin + CSRF, then canTriageReport (404 on any failure — role
// too low, no membership, or no such report). Body { entries: { <findingId>:
// entry|null } } — whole-entry replace, last write wins, null clears the entry
// (a tombstone, so a later reader adopts the clear); each entry validates
// through parseTriageEntryPatch (400 on a malformed one). Every id must be a
// finding the writer sees in THIS report — the report is the authorization
// scope for rows that are themselves per finding id — so a stripped (or
// foreign) finding id 404s without revealing whether it exists.
async function handleSetReportTriage(req: IncomingMessage, res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined, id: string, teamId: string | null): Promise<void> {
  const s = await checkMutation(req, res, deps, cookie)
  if (s == null) return
  if (!(await canTriageReport(deps, s.user, id))) { sendJson(res, 404, { error: 'no-report' }); return }
  let body: unknown
  try { body = await readJsonBody(req, MAX_TRIAGE_BODY_BYTES) } catch { sendJson(res, 400, { error: 'bad-body' }); return }
  const raw = (body as { entries?: unknown } | null)?.entries
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) { sendJson(res, 400, { error: 'bad-request' }); return }
  const pairs = Object.entries(raw)
  if (pairs.length > MAX_TRIAGE_ENTRIES) { sendJson(res, 400, { error: 'too-many-entries' }); return }
  const parsed: [string, TriageEntryPatch | null][] = []
  for (const [findingId, value] of pairs) {
    const patch = parseTriageEntryPatch(value)
    if (value != null && typeof value === 'object' && Object.hasOwn(value, 'comment')) {
      sendJson(res, 400, { error: 'use-comments-endpoint' }); return
    }
    if (patch === 'invalid' || findingId === '' || findingId.length > MAX_FINDING_ID) {
      sendJson(res, 400, { error: 'bad-entry' }); return
    }
    parsed.push([findingId, patch])
  }
  await visibleFindingIds(deps, s.user, id, s.session.id, teamId)
  const current = await readSession(deps.config, deps.db, cookie, Date.now())
  if (!current || !(await canViewReport(deps, current.user, id)) || current.user.role !== s.user.role) { sendJson(res, 404, { error: 'no-report' }); return }
  const visible = await visibleFindingIds(deps, current.user, id, current.session.id, teamId)
  if (parsed.some(([findingId]) => !visible.has(findingId))) {
    sendJson(res, 404, { error: 'no-finding' }); return
  }
  await deps.db.setTriageEntries(parsed, s.user.id, s.user.login, Date.now(), id)
  sendJson(res, 200, { ok: true })
}

// GET only: clients match local annotations against these IDs without sending
// their local finding IDs or annotation bodies to discover which reports exist.
async function handleImportFindingIds(res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined, search: URLSearchParams): Promise<void> {
  const s = await readAdminSession(res, deps, cookie)
  if (!s) return
  const after = search.get('after') ?? ''
  if (after && !/^[a-f\d-]{36}$/iu.test(after)) { sendJson(res, 400, { error: 'bad-cursor' }); return }
  const stored = await deps.db.listFindingCatalogReports(after, FINDING_CATALOG_PAGE_COUNT + 1)
  const reports = []
  let bytes = 0, cursor = after, processed = 0
  for (const report of stored) {
    if (processed >= FINDING_CATALOG_PAGE_COUNT || (processed > 0 && bytes + report.byteSize > FINDING_CATALOG_PAGE_BYTES)) break
    bytes += report.byteSize
    processed++
    cursor = report.id
    const findingIds = [...await visibleFindingIds(deps, s.user, report.id, s.session.id, null)]
    if (findingIds.length > 0) reports.push({ id: report.id, findingIds })
  }
  if (await readAdminSession(res, deps, cookie) == null) return
  sendJson(res, 200, { reports, nextCursor: processed < stored.length ? cursor : null })
}

// Admin imports compare the exact snapshot shown by the conflict dialog before
// writing. The store commits shared finding triage and imported comments together.
async function handleImportTriage(req: IncomingMessage, res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined, id: string): Promise<void> {
  const s = await adminMutation(req, res, deps, cookie)
  if (!s) return
  let body: { findingIds?: unknown; entries?: unknown; expected?: unknown }
  try { body = await readJsonBody(req, MAX_TRIAGE_BODY_BYTES) as typeof body }
  catch { sendJson(res, 400, { error: 'bad-body' }); return }
  if (!body || typeof body !== 'object') { sendJson(res, 400, { error: 'bad-body' }); return }
  const reading = body.entries === undefined
  const raw = body.entries
  if (!reading && (!raw || typeof raw !== 'object' || Array.isArray(raw))) { sendJson(res, 400, { error: 'bad-entries' }); return }
  const ids = reading ? body.findingIds : Object.keys(raw!)
  if (!Array.isArray(ids) || ids.length > MAX_TRIAGE_ENTRIES || ids.some(value => typeof value !== 'string' || !value || value.length > MAX_FINDING_ID)) {
    sendJson(res, 400, { error: 'bad-finding-ids' }); return
  }
  const parsed: [string, TriageEntryPatch | null][] = []
  const expected = body.expected as Record<string, string> | null
  if (!reading) {
    if (!expected || typeof expected !== 'object' || Array.isArray(expected)) { sendJson(res, 400, { error: 'bad-expected' }); return }
    for (const [findingId, value] of Object.entries(raw!)) {
      const patch = parseTriageEntryPatch(value)
      if (patch === 'invalid' || !/^[a-f\d]{64}$/u.test(expected[findingId] ?? '')) { sendJson(res, 400, { error: 'bad-entry' }); return }
      parsed.push([findingId, patch])
    }
  }
  if (!(await deps.db.getReport(id))) { sendJson(res, 404, { error: 'no-report' }); return }
  const visible = await visibleFindingIds(deps, s.user, id, s.session.id, null)
  if (await readAdminSession(res, deps, cookie) == null) return
  if (ids.some(findingId => !visible.has(findingId))) { sendJson(res, 404, { error: 'no-finding' }); return }
  if (reading) { sendJson(res, 200, { snapshots: await deps.db.getImportTriage(ids) }); return }
  const applied = await deps.db.importTriage(parsed, expected!, { id: s.user.id, login: s.user.login }, id, Date.now())
  sendJson(res, applied ? 200 : 409, { ok: applied })
}

// A report grants access to its visible findings; comments themselves are
// shared by finding ID. Author IDs always come from the authenticated session.
async function handleReportComments(req: IncomingMessage, res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined, reportId: string, commentId: string | null, teamId: string | null): Promise<void> {
  const method = req.method ?? 'GET'
  if (commentId == null ? method !== 'GET' && method !== 'POST' : method !== 'PATCH' && method !== 'DELETE') {
    send405(res, commentId == null ? 'GET, POST' : 'PATCH, DELETE'); return
  }
  const s = method === 'GET' ? await readSession(deps.config, deps.db, cookie, Date.now()) : await checkMutation(req, res, deps, cookie)
  if (s == null) { if (method === 'GET') sendJson(res, 401, { error: 'unauthenticated' }); return }
  const allowed = method === 'GET' ? await canViewReport(deps, s.user, reportId) : await canTriageReport(deps, s.user, reportId)
  if (!allowed) { sendJson(res, 404, { error: 'no-report' }); return }
  let raw: { body?: unknown; findingId?: unknown; version?: unknown } | null
  if (method === 'GET') raw = null
  else {
    try { raw = await readJsonBody(req, MAX_TRIAGE_BODY_BYTES) as typeof raw } catch { sendJson(res, 400, { error: 'bad-body' }); return }
  }
  // Body delivery and a cold report read can outlive a permission change.
  // Match triage's recheck before exposing or changing any annotation.
  await visibleFindingIds(deps, s.user, reportId, s.session.id, teamId)
  const session = await readSession(deps.config, deps.db, cookie, Date.now())
  if (!session || session.user.role !== s.user.role || !(await canViewReport(deps, session.user, reportId))) {
    sendJson(res, 404, { error: 'no-report' }); return
  }
  const visible = await visibleFindingIds(deps, session.user, reportId, session.session.id, teamId)
  if (method === 'GET') {
    sendJson(res, 200, { comments: await deps.db.listComments([...visible]) }); return
  }
  const body = parseCommentBody(raw?.body)
  if (body == null && method !== 'DELETE') { sendJson(res, 400, { error: 'bad-comment' }); return }
  if (commentId == null) {
    if (typeof raw?.findingId !== 'string' || !visible.has(raw.findingId)) { sendJson(res, 404, { error: 'no-finding' }); return }
    const comment = await deps.db.createComment({ findingId: raw.findingId, body: body!, authorId: session.user.id, authorLogin: session.user.login, reportId }, Date.now())
    sendJson(res, 201, { comment }); return
  }
  const current = await deps.db.getComment(commentId)
  if (current == null || !visible.has(current.findingId)) { sendJson(res, 404, { error: 'no-comment' }); return }
  const allowedComment = method === 'DELETE' ? canDeleteComment(current, session.user) : current.authorId === session.user.id
  if (!allowedComment) { sendJson(res, 403, { error: 'not-comment-author' }); return }
  if (typeof raw?.version !== 'number' || !Number.isSafeInteger(raw.version) || raw.version < 1) {
    sendJson(res, 400, { error: 'bad-version' }); return
  }
  const comment = method === 'DELETE'
    ? await deps.db.deleteComment(commentId, session.user.id, session.user.login, raw.version, reportId, Date.now())
    : await deps.db.editComment(commentId, session.user.id, session.user.login, body!, raw.version, reportId, Date.now())
  if (comment === 'conflict') { sendJson(res, 409, { error: 'comment-changed' }); return }
  if (comment === 'forbidden') { sendJson(res, 403, { error: 'not-comment-author' }); return }
  if (comment == null) { sendJson(res, 404, { error: 'no-comment' }); return }
  if (comment === 'deleted') { res.writeHead(204, { 'cache-control': 'no-store' }); res.end(); return }
  sendJson(res, 200, { comment })
}

// GET /api/admin/teams — every team (members + repos inlined) plus the pickers
// the page needs: all users (member dropdown), selected repos (repo dropdown),
// and the visibility-permission keys. admin, read-only (no CSRF).
async function handleListTeams(res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined): Promise<void> {
  const s = await readAdminSession(res, deps, cookie)
  if (s == null) return
  sendJson(res, 200, {
    teams: await deps.db.listTeams(),
    users: await deps.db.listUserOptions(),
    repos: selectableRepos(await deps.db.listSelectedRepos()),
    permissions: VISIBILITY_PERMISSIONS,
  })
}

// POST /api/admin/teams — create a team. Body { name }. 409 if the name's taken.
async function handleCreateTeam(req: IncomingMessage, res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined): Promise<void> {
  const s = await adminMutation(req, res, deps, cookie)
  if (s == null) return
  let body: unknown
  try { body = await readJsonBody(req) } catch { sendJson(res, 400, { error: 'bad-body' }); return }
  const rawName = (body as { name?: unknown } | null)?.name
  const name = typeof rawName === 'string' ? rawName.trim() : ''
  if (name === '' || name.length > MAX_TEAM_NAME) { sendJson(res, 400, { error: 'bad-name' }); return }
  const id = randomUUID()
  if (await readAdminSession(res, deps, cookie) == null) return
  if (!(await deps.db.createTeam(id, name, Date.now()))) { sendJson(res, 409, { error: 'name-taken' }); return }
  await activity(deps, s.user, 'access', `created team ${name}`)
  sendJson(res, 201, await deps.db.getTeam(id))
}

// POST /api/admin/teams/rename — rename a team. Body { teamId, name }. 404 if no
// such team; 409 if the new name is already taken by another team.
async function handleRenameTeam(req: IncomingMessage, res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined): Promise<void> {
  const s = await adminMutation(req, res, deps, cookie)
  if (s == null) return
  let body: unknown
  try { body = await readJsonBody(req) } catch { sendJson(res, 400, { error: 'bad-body' }); return }
  const teamId = (body as { teamId?: unknown } | null)?.teamId
  const rawName = (body as { name?: unknown } | null)?.name
  const name = typeof rawName === 'string' ? rawName.trim() : ''
  if (typeof teamId !== 'string' || name === '' || name.length > MAX_TEAM_NAME) { sendJson(res, 400, { error: 'bad-name' }); return }
  const team = await deps.db.getTeam(teamId)
  if (await readAdminSession(res, deps, cookie) == null) return
  const result = await deps.db.renameTeam(teamId, name, Date.now())
  if (result === 'not-found') { sendJson(res, 404, { error: 'no-team' }); return }
  if (result === 'name-taken') { sendJson(res, 409, { error: 'name-taken' }); return }
  if (team?.name !== name) await activity(deps, s.user, 'access', `renamed team ${team?.name ?? teamId} to ${name}`)
  sendJson(res, 200, { ok: true, name })
}

// POST /api/admin/teams/delete — drop a team (its links cascade). Body { teamId }.
async function handleDeleteTeam(req: IncomingMessage, res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined): Promise<void> {
  const s = await adminMutation(req, res, deps, cookie)
  if (s == null) return
  let body: unknown
  try { body = await readJsonBody(req) } catch { sendJson(res, 400, { error: 'bad-body' }); return }
  const teamId = (body as { teamId?: unknown } | null)?.teamId
  if (typeof teamId !== 'string') { sendJson(res, 400, { error: 'bad-request' }); return }
  const team = await deps.db.getTeam(teamId)
  if (await readAdminSession(res, deps, cookie) == null) return
  if (!(await deps.db.deleteTeam(teamId))) { sendJson(res, 404, { error: 'no-team' }); return }
  await activity(deps, s.user, 'access', `deleted team ${team?.name ?? teamId}`)
  sendJson(res, 200, { ok: true })
}

// POST /api/admin/teams/set-repo — add a repo path. Empty path replaces all
// path links with the whole repository. Body { teamId, repoId, path? }.
// Repo must be in the selected set.
async function handleSetTeamRepo(req: IncomingMessage, res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined): Promise<void> {
  const s = await adminMutation(req, res, deps, cookie)
  if (s == null) return
  let body: unknown
  try { body = await readJsonBody(req) } catch { sendJson(res, 400, { error: 'bad-body' }); return }
  const teamId = (body as { teamId?: unknown } | null)?.teamId
  const repoId = (body as { repoId?: unknown } | null)?.repoId
  if (typeof teamId !== 'string' || typeof repoId !== 'number' || !Number.isSafeInteger(repoId)) {
    sendJson(res, 400, { error: 'bad-request' }); return
  }
  const path = normalizeTeamPath((body as { path?: unknown }).path)
  if (!path.ok) { sendJson(res, 400, { error: 'bad-path' }); return }
  const team = (await deps.db.listTeams()).find(row => row.id === teamId)
  if (team == null) { sendJson(res, 404, { error: 'no-team' }); return }
  if (!(await deps.db.listSelectedRepos()).some((r) => r.repoId === repoId)) { sendJson(res, 400, { error: 'repo-not-selected' }); return }
  if (await readAdminSession(res, deps, cookie) == null) return
  await deps.db.setTeamRepo(teamId, repoId, path.path)
  if (!team.repos.some(repo => repo.repoId === repoId && (!repo.path || repo.path === (path.path ?? '')))) {
    await activity(deps, s.user, 'access', `granted team ${team.name} access to ${path.path || '/'}`, { repo: await repositoryName(deps, repoId) })
  }
  sendJson(res, 200, { ok: true })
}

// POST /api/admin/teams/remove-repo — unlink one path. Omitting path retains
// the legacy remove-all behavior. Body { teamId, repoId, path? }.
async function handleRemoveTeamRepo(req: IncomingMessage, res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined): Promise<void> {
  const s = await adminMutation(req, res, deps, cookie)
  if (s == null) return
  let body: unknown
  try { body = await readJsonBody(req) } catch { sendJson(res, 400, { error: 'bad-body' }); return }
  const teamId = (body as { teamId?: unknown } | null)?.teamId
  const repoId = (body as { repoId?: unknown } | null)?.repoId
  if (typeof teamId !== 'string' || typeof repoId !== 'number' || !Number.isSafeInteger(repoId)) { sendJson(res, 400, { error: 'bad-request' }); return }
  const rawPath = (body as { path?: unknown }).path
  if (rawPath !== undefined && rawPath !== null && typeof rawPath !== 'string') { sendJson(res, 400, { error: 'bad-path' }); return }
  const path = normalizeTeamPath(rawPath)
  if (!path.ok) { sendJson(res, 400, { error: 'bad-path' }); return }
  if (await readAdminSession(res, deps, cookie) == null) return
  if (!(await deps.db.removeTeamRepo(teamId, repoId, rawPath === undefined ? undefined : path.path))) { sendJson(res, 404, { error: 'not-linked' }); return }
  await activity(deps, s.user, 'access', `removed team ${(await deps.db.getTeam(teamId))?.name ?? teamId}'s access to ${rawPath === undefined ? 'all paths' : path.path || '/'}`, { repo: await repositoryName(deps, repoId) })
  sendJson(res, 200, { ok: true })
}

// POST /api/admin/teams/set-member — add/update a member + their visibility
// permissions. Body { teamId, userId, dependencies?, security? }.
async function handleSetTeamMember(req: IncomingMessage, res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined): Promise<void> {
  const s = await adminMutation(req, res, deps, cookie)
  if (s == null) return
  let body: unknown
  try { body = await readJsonBody(req) } catch { sendJson(res, 400, { error: 'bad-body' }); return }
  const teamId = (body as { teamId?: unknown } | null)?.teamId
  const userId = (body as { userId?: unknown } | null)?.userId
  if (typeof teamId !== 'string' || typeof userId !== 'string') { sendJson(res, 400, { error: 'bad-request' }); return }
  const team = (await deps.db.listTeams()).find(row => row.id === teamId)
  if (team == null) { sendJson(res, 404, { error: 'no-team' }); return }
  const user = (await deps.db.listUserOptions()).find(row => row.id === userId)
  if (user == null) { sendJson(res, 404, { error: 'no-user' }); return }
  const permissions = parseTeamUserPermissions(body)
  const member = team.members.find(row => row.userId === userId)
  if (await readAdminSession(res, deps, cookie) == null) return
  await deps.db.setTeamMember(teamId, userId, permissions)
  if (!member || member.dependencies !== permissions.dependencies || member.security !== permissions.security) {
    await activity(deps, s.user, 'access', `set ${user.login}'s membership in ${team.name} (dependencies: ${permissions.dependencies ? 'on' : 'off'}, security: ${permissions.security ? 'on' : 'off'})`)
  }
  sendJson(res, 200, { ok: true })
}

// POST /api/admin/teams/remove-member — remove a membership. Body { teamId, userId }.
async function handleRemoveTeamMember(req: IncomingMessage, res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined): Promise<void> {
  const s = await adminMutation(req, res, deps, cookie)
  if (s == null) return
  let body: unknown
  try { body = await readJsonBody(req) } catch { sendJson(res, 400, { error: 'bad-body' }); return }
  const teamId = (body as { teamId?: unknown } | null)?.teamId
  const userId = (body as { userId?: unknown } | null)?.userId
  if (typeof teamId !== 'string' || typeof userId !== 'string') { sendJson(res, 400, { error: 'bad-request' }); return }
  if (await readAdminSession(res, deps, cookie) == null) return
  if (!(await deps.db.removeTeamMember(teamId, userId))) { sendJson(res, 404, { error: 'not-member' }); return }
  const team = await deps.db.getTeam(teamId)
  const user = (await deps.db.listUserOptions()).find(row => row.id === userId)
  await activity(deps, s.user, 'access', `removed ${user?.login ?? userId} from team ${team?.name ?? teamId}`)
  sendJson(res, 200, { ok: true })
}

async function handleWorkspaceShare(req: IncomingMessage, res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined, teamId: string, id?: string) {
  if (!deps.config.allowShare) { sendJson(res, 404, { error: 'sharing-disabled' }); return }
  const method = req.method ?? 'GET'
  const allowed = id ? ['PATCH', 'DELETE'] : ['GET', 'POST', 'DELETE']
  if (!allowed.includes(method)) { send405(res, allowed.join(', ')); return }
  const s = method === 'GET' ? await readSession(deps.config, deps.db, cookie, Date.now()) : await checkMutation(req, res, deps, cookie)
  if (!s) { if (method === 'GET') sendJson(res, 401, { error: 'unauthenticated' }); return }
  if (!requireManageRole(res, s.user)) return
  const { db } = deps
  if (method === 'GET') {
    const shares = await db.listWorkspaceShares(s.session.id, Date.now(), teamId)
    sendJson(res, shares ? 200 : 404, shares ? { shares } : { error: 'no-team' }); return
  }
  let body
  if (method === 'POST' || method === 'PATCH') {
    try { body = await readJsonBody(req) } catch { sendJson(res, 400, { error: 'bad-body' }); return }
  }
  const permissions = parseTeamUserPermissions(body), token = method === 'POST' ? randomToken() : ''
  const shareId = id ?? hashToken(token)
  const ok = method === 'POST' ? await db.createWorkspaceShare(s.session.id, Date.now(), teamId, shareId, permissions)
    : method === 'PATCH' ? await db.updateWorkspaceShare(s.session.id, Date.now(), teamId, shareId, permissions)
    : await db.revokeWorkspaceShares(s.session.id, Date.now(), teamId, id)
  if (!ok) { sendJson(res, 404, { error: 'no-share' }); return }
  const team = await db.getTeam(teamId)
  if (!team) { sendJson(res, 404, { error: 'no-team' }); return }
  const action = method === 'POST' ? 'created a public link' : method === 'PATCH' ? 'updated a public link' : id ? 'revoked a public link' : 'revoked public links'
  const access = method === 'DELETE' ? '' : ` (dependencies: ${permissions.dependencies ? 'on' : 'off'}, security: ${permissions.security ? 'on' : 'off'})`
  await activity(deps, s.user, 'access', `${action} for team ${team.name}${access}`)
  sendJson(res, 200, method === 'POST' ? { id: shareId, path: `/team/${team.slug}#public=${shareId.slice(0, 8)}.${token}` } : { ok: true })
}

export function createManagedRequestHandler(deps: ManagedHttpDeps): Handler {
  const { config, db, avatarStore, isShuttingDown, track } = deps
  const repositoryDiscovery = new RepositoryDiscovery(config)

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname
    const method = req.method ?? 'GET'
    const cookie = req.headers.cookie

    if (req.headers['x-deepview-share'] !== undefined || path.startsWith('/api/shares/')) {
      await handlePublicWorkspace(req, res, deps, url); return
    }

    // Public mode probe — lets a client detect the managed protocol up front.
    if (path === CONFIG_PATH) {
      if (method !== 'GET') { send405(res, 'GET'); return }
      const info = deps.serverInfo ?? { mode: 'managed', managed: { loginPath: LOGIN_PATH, cookieName: config.sessionCookieName } }
      sendJson(res, 200, { ...info, ...(config.githubNewIssueLabels ? { githubNewIssueLabels: config.githubNewIssueLabels } : {}),
        managed: { ...info.managed, ...(config.allowShare ? { allowShare: true } : {}), ...(deps.uploadStore ? {
          uploadChunkBytes: UPLOAD_CHUNK_BYTES, uploadMaxBytes: { reports: config.maxReportBytes, bundles: config.maxBundleBytes },
        } : {}) } })
      return
    }
    // OAuth: start → redirect to GitHub with the CSRF state cookie.
    if (path === LOGIN_PATH) {
      if (method !== 'GET') { send405(res, 'GET'); return }
      const { location, setCookie } = buildLoginRedirect(config)
      res.writeHead(302, { location, 'set-cookie': setCookie, 'cache-control': 'no-store' })
      res.end()
      return
    }
    // OAuth: callback (the GitHub hook) → mint a session, land on the app.
    if (path === CALLBACK_PATH) {
      if (method !== 'GET') { send405(res, 'GET'); return }
      try {
        if (isIssueOAuthCallback(config, url.searchParams, cookie)) {
          const s = await readWorkspaceSession(res, deps, cookie)
          if (!s) return
          const result = await issueOAuthCallback(config, db, s.session, url.searchParams, cookie)
          res.writeHead(302, { location: result.location, 'set-cookie': result.setCookie, 'cache-control': 'no-store' })
          res.end(); return
        }
        const result = await handleCallback(url.searchParams, cookie, { config, db, avatarStore })
        res.writeHead(302, { location: result.location, 'set-cookie': result.setCookies, 'cache-control': 'no-store' })
        res.end()
      } catch (err) {
        if (err instanceof OAuthError) sendJson(res, err.status, { error: err.message })
        else throw err
      }
      return
    }
    if (path === ISSUE_LOGIN_PATH) {
      if (method !== 'GET') { send405(res, 'GET'); return }
      const s = await readWorkspaceSession(res, deps, cookie)
      if (!s) return
      const result = issueLoginRedirect(config, s.session)
      res.writeHead(302, { location: result.location, 'set-cookie': result.setCookie, 'cache-control': 'no-store' })
      res.end(); return
    }
    // Who am I?
    if (path === SESSION_PATH) {
      if (method !== 'GET') { send405(res, 'GET'); return }
      const s = await readSession(config, db, cookie, Date.now())
      if (s == null) { sendJson(res, 401, { error: 'unauthenticated' }); return }
      sendJson(res, 200, {
        user: { id: s.user.id, login: s.user.login, name: s.user.name, role: s.user.role },
        csrfToken: s.session.csrfToken,
      })
      return
    }
    // Authentication is not workspace access. Keep bootstrap/session/logout
    // available so blocked accounts can see their role and sign out, but deny
    // every managed data route before reading bodies or looking up resources.
    const managedDataPath = ['/api/admin', '/api/reports', '/api/bundles', '/api/teams', '/api/avatar', '/api/github']
      .some(prefix => path === prefix || path.startsWith(prefix + '/'))
    const workspaceSession = managedDataPath ? await readWorkspaceSession(res, deps, cookie) : null
    if (managedDataPath && !workspaceSession) return
    const issueRoute = /^\/api\/teams\/([^/]+)\/issues$/u.exec(path)
    if (issueRoute) {
      await handleWorkspaceIssue(req, res, deps, cookie, decodeURIComponent(issueRoute[1]!), url.searchParams); return
    }
    if (path === '/api/admin/links') {
      if (!config.allowShare) { sendJson(res, 404, { error: 'sharing-disabled' }); return }
      if (method !== 'GET') { send405(res, 'GET'); return }
      const s = await readSession(config, db, cookie, Date.now())
      if (!s) { sendJson(res, 401, { error: 'unauthenticated' }); return }
      if (!requireManageRole(res, s.user)) return
      const shares = await db.listManagedWorkspaceShares(s.session.id, Date.now())
      sendJson(res, shares ? 200 : 403, shares ? { shares } : { error: 'forbidden' }); return
    }
    const shareRoute = /^\/api\/teams\/([^/]+)\/share(?:\/([A-Za-z0-9_-]{43}))?$/u.exec(path)
    if (shareRoute) {
      await handleWorkspaceShare(req, res, deps, cookie, shareRoute[1]!, shareRoute[2]); return
    }
    if (path.startsWith('/api/admin/uploads/')) { await handleUploadPart(req, res, deps, cookie, path); return }
    // Cached avatar by user id, served same-origin (the page CSP forbids the
    // github CDN). The id in the path keys the browser cache per user, so a user
    // switch never serves a stale avatar. Workspace access is required.
    if (path.startsWith(AVATAR_PREFIX)) {
      if (method !== 'GET') { send405(res, 'GET'); return }
      const s = await readSession(config, db, cookie, Date.now())
      if (s == null) { sendJson(res, 401, { error: 'unauthenticated' }); return }
      await serveAvatar(res, avatarStore, path.slice(AVATAR_PREFIX.length))
      return
    }
    // Admin: list users (admin-only).
    if (path === ADMIN_HISTORY_PATH) {
      if (method !== 'GET') { send405(res, 'GET'); return }
      await handleHistory(res, deps, cookie, url.searchParams); return
    }
    if (path === ADMIN_USERS_PATH) {
      if (method !== 'GET') { send405(res, 'GET'); return }
      const s = await readSession(config, db, cookie, Date.now())
      if (s == null) { sendJson(res, 401, { error: 'unauthenticated' }); return }
      if (s.user.role !== 'admin') { sendJson(res, 403, { error: 'forbidden' }); return }
      sendJson(res, 200, { users: await db.listUsers() })
      return
    }
    if (path === ADMIN_SCAN_MODELS_PATH) {
      if (method !== 'GET') { send405(res, 'GET'); return }
      await handleListModels(res, deps, cookie); return
    }
    if (path === SET_ROLE_PATH) { await handleSetRole(req, res, deps, cookie); return }
    if (path === REPO_IMPACT_PATH) {
      if (method !== 'GET') { send405(res, 'GET'); return }
      await handleRepositoryImpact(req, res, deps, cookie); return
    }
    if (path === REMOVE_REPO_PATH) {
      if (method !== 'POST') { send405(res, 'POST'); return }
      await handleRemoveRepository(req, res, deps, cookie); return
    }
    if (path === BROWSABLE_REPOS_PATH) {
      if (method !== 'GET') { send405(res, 'GET'); return }
      await handleBrowsableRepositories(res, deps, cookie); return
    }
    if (path === REPO_REFS_PATH || path === REPO_CONTENTS_PATH) {
      if (method !== 'GET') { send405(res, 'GET'); return }
      await handleRepositoryBrowser(res, deps, cookie, url.searchParams, path === REPO_REFS_PATH); return
    }
    if (path === ADMIN_REPOS_PATH) { await handleListRepositories(req, res, deps, cookie, repositoryDiscovery); return }
    if (path === SELECT_REPO_PATH) { await handleSelectRepository(req, res, deps, cookie); return }
    if (path === ADD_PUBLIC_REPO_PATH) { await handleAddPublicRepository(req, res, deps, cookie); return }
    if (path === CONNECT_REPO_APP_PATH) { await handleConnectRepositoryApp(req, res, deps, cookie); return }
    // Reports: list / upload on the exact path, download / delete per-id on the
    // prefix. Method-dispatched here since each path carries two verbs.
    if (path === ADMIN_REPORTS_PATH) {
      if (method === 'GET') { await handleListReports(res, deps, workspaceSession!.session); return }
      if (method === 'POST') { await handleUploadReport(req, res, deps, cookie); return }
      send405(res, 'GET, POST'); return
    }
    // set-repo is an exact sub-path; check it before the per-id prefix (a report
    // id is a uuid, so it never collides with "set-repo").
    if (path === REPORT_SET_REPO_PATH) {
      if (method !== 'POST') { send405(res, 'POST'); return }
      await handleSetReportRepo(req, res, deps, cookie); return
    }
    if (path === REPORT_SET_VISIBLE_PATH) {
      if (method !== 'POST') { send405(res, 'POST'); return }
      await handleSetReportVisible(req, res, deps, cookie); return
    }
    if (path === '/api/admin/reports/finding-ids') {
      if (method !== 'GET') { send405(res, 'GET'); return }
      await handleImportFindingIds(res, deps, cookie, url.searchParams); return
    }
    const importTriage = /^\/api\/admin\/reports\/([a-f\d-]{36})\/import-triage$/iu.exec(path)
    if (importTriage) {
      if (method !== 'POST') { send405(res, 'POST'); return }
      await handleImportTriage(req, res, deps, cookie, importTriage[1]!); return
    }
    if (path.startsWith(REPORT_PREFIX)) {
      const id = path.slice(REPORT_PREFIX.length)
      if (method === 'GET') { await handleGetReport(res, deps, cookie, id); return }
      if (method === 'DELETE') { await handleDeleteReport(req, res, deps, cookie, id); return }
      send405(res, 'GET, DELETE'); return
    }
    // Bundles: list / upload on the exact path, download / delete per-id on the
    // prefix (same shape as reports).
    const bundleAdvisories = /^\/api\/bundles\/([a-f\d-]{36})\/advisories$/iu.exec(path)
    if (bundleAdvisories) {
      if (method !== 'GET') { send405(res, 'GET'); return }
      await handleBundleAdvisories(res, deps, cookie, bundleAdvisories[1]!, url.searchParams.get('team'), url.searchParams.get('reason') ?? '')
      return
    }
    const bundleRead = /^\/api\/bundles\/([a-f\d-]{36})\/(metadata|contents|download)$/iu.exec(path)
    if (bundleRead) {
      if (method !== 'GET' && method !== 'HEAD') { send405(res, 'GET, HEAD'); return }
      const id = bundleRead[1]!
      if (bundleRead[2] === 'download') await handleGetBundle(req, res, deps, cookie, id)
      else await handleBundleCache(req, res, deps, cookie, id, bundleRead[2] as BundleCachePart)
      return
    }
    if (path === ADMIN_BUNDLES_PATH) {
      if (method === 'GET') { await handleListBundles(res, deps, workspaceSession!.session); return }
      if (method === 'POST') { await handleUploadBundle(req, res, deps, cookie); return }
      send405(res, 'GET, POST'); return
    }
    if (path === BUNDLE_SET_REPO_PATH) {
      if (method !== 'POST') { send405(res, 'POST'); return }
      await handleSetBundleRepo(req, res, deps, cookie); return
    }
    if (path.startsWith(BUNDLE_PREFIX)) {
      const id = path.slice(BUNDLE_PREFIX.length)
      if (method === 'GET') { await handleGetBundle(req, res, deps, cookie, id); return }
      if (method === 'DELETE') { await handleDeleteBundle(req, res, deps, cookie, id); return }
      send405(res, 'GET, DELETE'); return
    }
    const teamFeed = /^\/api\/teams\/([^/]+)\/feed$/u.exec(path)
    if (teamFeed || path === '/api/teams/feed') {
      if (method !== 'GET') { send405(res, 'GET'); return }
      const s = await readWorkspaceSession(res, deps, cookie)
      if (!s) return
      const teamId = teamFeed?.[1] ?? null
      if (teamId) await teamSnapshot(db, s.session.id, teamId)
      await serveUserTeamFeed(res, deps, s.session.id, s.user, teamId); return
    }
    const teamFixes = /^\/api\/teams\/([^/]+)\/fixes$/u.exec(path)
    if (teamFixes) {
      if (method !== 'GET') { send405(res, 'GET'); return }
      await handleWorkspaceFixes(res, deps, cookie, teamFixes[1]!); return
    }
    const teamAnnotations = /^\/api\/teams\/([^/]+)\/annotations$/u.exec(path)
    if (teamAnnotations) {
      if (method !== 'GET') { send405(res, 'GET'); return }
      const snapshot = await teamSnapshot(db, workspaceSession!.session.id, teamAnnotations[1]!)
      const annotations = await loadTeamAnnotations(db, deps.reportStore, snapshot)
      await recheckTeam(db, workspaceSession!.session.id, snapshot)
      sendJson(res, 200, annotations); return
    }
    const teamReports = /^\/api\/teams\/([^/]+)\/reports$/u.exec(path)
    if (teamReports) {
      if (method !== 'GET') { send405(res, 'GET'); return }
      await handleTeamReports(res, deps, workspaceSession!.session, teamReports[1]!); return
    }
    if (path === '/api/reports/query') {
      if (method !== 'POST') { send405(res, 'POST'); return }
      await handleQueryReports(req, res, deps, cookie); return
    }
    const sourcesRoute = /^\/api\/reports\/([^/]+)\/sources$/u.exec(path)
    if (sourcesRoute) {
      if (method !== 'GET' && method !== 'HEAD') { send405(res, 'GET, HEAD'); return }
      await handleReportSources(req, res, deps, cookie, sourcesRoute[1]!, url.searchParams.get('team')); return
    }
    const commentsRoute = /^\/api\/reports\/([^/]+)\/comments(?:\/([^/]+))?$/u.exec(path)
    if (commentsRoute) {
      await handleReportComments(req, res, deps, cookie, commentsRoute[1]!, commentsRoute[2] ?? null, url.searchParams.get('team')); return
    }
    // Per-finding triage on a viewable report. The '/triage' suffixes are
    // matched before the bare per-id slice below (a report id is a uuid, so it
    // never ends in them) — same trick as REPORT_SET_REPO_PATH above; the
    // longer '/triage/history' goes first.
    if (path.startsWith(MY_REPORT_PREFIX) && path.endsWith(MY_REPORT_TRIAGE_HISTORY_SUFFIX)) {
      const id = path.slice(MY_REPORT_PREFIX.length, -MY_REPORT_TRIAGE_HISTORY_SUFFIX.length)
      if (method !== 'GET') { send405(res, 'GET'); return }
      await handleGetReportTriageHistory(res, deps, cookie, id, url.searchParams, url.searchParams.get('team')); return
    }
    if (path.startsWith(MY_REPORT_PREFIX) && path.endsWith(MY_REPORT_TRIAGE_SUFFIX)) {
      const id = path.slice(MY_REPORT_PREFIX.length, -MY_REPORT_TRIAGE_SUFFIX.length)
      if (method === 'GET') { await handleGetReportTriage(res, deps, cookie, id, url.searchParams.get('team')); return }
      if (method === 'POST') { await handleSetReportTriage(req, res, deps, cookie, id, url.searchParams.get('team')); return }
      send405(res, 'GET, POST'); return
    }
    // Individual report previews are reserved for admins/managers.
    if (path.startsWith(MY_REPORT_PREFIX)) {
      if (method !== 'GET') { send405(res, 'GET'); return }
      await handleViewReport(req, res, deps, cookie, path.slice(MY_REPORT_PREFIX.length)); return
    }
    // The signed-in user's own team memberships (any approved user).
    if (path === MY_TEAMS_PATH) {
      if (method !== 'GET') { send405(res, 'GET'); return }
      await handleMyTeams(res, deps, workspaceSession!.session); return
    }
    // Teams: list / create on the exact path; the link mutations are POST-only
    // action sub-paths (each carries its ids in the JSON body).
    if (path === ADMIN_TEAMS_PATH) {
      if (method === 'GET') { await handleListTeams(res, deps, cookie); return }
      if (method === 'POST') { await handleCreateTeam(req, res, deps, cookie); return }
      send405(res, 'GET, POST'); return
    }
    if (path === TEAM_DELETE_PATH || path === TEAM_RENAME_PATH || path === TEAM_SET_REPO_PATH || path === TEAM_REMOVE_REPO_PATH
      || path === TEAM_SET_MEMBER_PATH || path === TEAM_REMOVE_MEMBER_PATH) {
      if (method !== 'POST') { send405(res, 'POST'); return }
      if (path === TEAM_DELETE_PATH) { await handleDeleteTeam(req, res, deps, cookie); return }
      if (path === TEAM_RENAME_PATH) { await handleRenameTeam(req, res, deps, cookie); return }
      if (path === TEAM_SET_REPO_PATH) { await handleSetTeamRepo(req, res, deps, cookie); return }
      if (path === TEAM_REMOVE_REPO_PATH) { await handleRemoveTeamRepo(req, res, deps, cookie); return }
      if (path === TEAM_SET_MEMBER_PATH) { await handleSetTeamMember(req, res, deps, cookie); return }
      await handleRemoveTeamMember(req, res, deps, cookie); return
    }
    if (path === LOGOUT_PATH) { await handleLogout(req, res, deps, cookie); return }
    if (deps.serveStatic?.(req, res)) return
    if (deps.next) { deps.next(req, res); return }
    sendJson(res, 404, { error: 'not-found' }, { connection: 'close' })
  }

  return (req, res) => {
    if (isShuttingDown()) { sendJson(res, 503, { error: 'shutting-down' }, { connection: 'close' }); return }
    // Feeds lease a connection per poll, never across streaming sleeps. This
    // also covers capability-authenticated feeds handled by public-workspace.
    const feed = /^\/api\/teams(?:\/[^/?]+)?\/feed(?:\?|$)/u.test(req.url ?? '')
    const work = (db.withRequest && !feed ? db.withRequest(() => route(req, res)) : route(req, res)).catch((err) => {
      if ((err instanceof TeamReportsError || err instanceof IssueError || err instanceof OAuthError || err instanceof ManagedMutationError) && !res.headersSent) { sendJson(res, err.status, { error: err.message }); return }
      console.warn('managed: request handler error:', err)
      if (res.headersSent) { try { res.destroy() } catch {} }
      else sendJson(res, 500, { error: 'internal' })
    })
    track(work)
    return work
  }
}
