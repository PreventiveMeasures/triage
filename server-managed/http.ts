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
//   POST /api/github/pull-requests → batch PR titles/statuses, restricted to the user's team repos
//   GET  /api/reports/<id>       → view a report: admin, or ≥view role + team membership | 401/404
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
//   POST /api/admin/repositories/remove → admin permanently removes a repo
//   GET  /api/admin/reports      → admin|manage list of uploaded reports | 401/403
//   POST /api/admin/reports      → admin|manage uploads a report (raw body) | 401/403/413
//   GET  /api/admin/reports/<id> → admin|manage downloads a stored report | 401/403/404
//   DELETE /api/admin/reports/<id> → admin|manage deletes a report | 401/403/404
//   POST /api/admin/reports/set-repo → admin|manage attaches/detaches a report's repo | 401/403/404
//   GET  /api/bundles/<id>/{metadata,contents} → authorized encoded bytes | 401/404/422
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
import type { BundleCache, BundleCachePart } from './bundle-cache.ts'
import type { BundleStore } from './bundle-store.ts'
import { Buffer } from 'node:buffer'
import { createHash, randomUUID } from 'node:crypto'
import type { AvatarStore } from './avatar-store.ts'
import type { BlobStore } from './blob-store.ts'
import { bundleIntegrity, bundleKind, reportBundleHashes } from './bundle.ts'
import type { ManagedConfig } from './config.ts'
import type { ManagedDb, ManagedSession, StoredUser, TriageEventRow, TriageRow } from './db.ts'
import type { OriginGate } from '../server-common/origin.ts'
import { isRole, roleAtLeast } from '../common/managed/roles.ts'
import { VISIBILITY_PERMISSIONS, parseTeamUserPermissions } from '../common/managed/permissions.ts'
import { filterReportContent } from '../common/managed/report-filter.ts'
import type { TriageEntryPatch } from '../common/managed/triage.ts'
import { MAX_FINDING_ID, MAX_TRIAGE_BODY_BYTES, MAX_TRIAGE_ENTRIES, MAX_TRIAGE_HISTORY, isTriageBucket, parseTriageEntryPatch } from '../common/managed/triage.ts'
import { reportRepoGithub } from '../report/index.js'
import { loadManagedFindings, readManagedReport } from '../common/managed/report-content.ts'
import type { ReportSourcesCache } from './report-sources.ts'
import { normalizeTeamPath } from './repo-path.ts'
import { DEFAULT_MANAGED_SCAN_MODEL, MANAGED_SCAN_MODELS } from '../common/managed/scan-models.ts'
import { CONFIG_PATH, type ServerInfo } from '../common/server-info.ts'
import { GithubApiError, collectRepos, fetchPublicRepository, installUrl, publicRepositoryName } from './github-app.ts'
import type { ConnectedRepo } from './github-app.ts'
import { canAddAnyPublicRepository, canAddRepositories, passesPublicRepositorySafeguard } from './repository-policy.ts'
import { RepositoryDiscovery } from './repository-discovery.ts'
import { CALLBACK_PATH, LOGIN_PATH, OAuthError, buildLoginRedirect, ensureUserAccessToken, handleCallback } from './github-oauth.ts'
import { clearCookie, endSession, readSession } from './session.ts'
import type { ActivityContext, ActivityInput } from './activity.ts'
import { acceptsReportMetadata } from './report-response.ts'
import { MAX_PULL_REQUESTS, MAX_PULL_REQUEST_URL } from '../common/github-pr.ts'
import { lookupPullRequests } from './github-pulls.ts'
import { canDeleteComment, parseCommentBody } from '../common/managed/comments.ts'

const SESSION_PATH = '/api/auth/session'
const AVATAR_PREFIX = '/api/avatar/'
const LOGOUT_PATH = '/api/auth/logout'
const ADMIN_USERS_PATH = '/api/admin/users'
const ADMIN_HISTORY_PATH = '/api/admin/history'
const ADMIN_MODELS_PATH = '/api/admin/models'
const SET_ROLE_PATH = '/api/admin/set-role'
const ADMIN_REPOS_PATH = '/api/admin/repositories'
const SELECT_REPO_PATH = '/api/admin/repositories/select'
const ADD_PUBLIC_REPO_PATH = '/api/admin/repositories/add-public'
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

async function handlePullRequests(req: IncomingMessage, res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined): Promise<void> {
  const s = await checkMutation(req, res, deps, cookie)
  if (!s) return
  let body: unknown
  try { body = await readJsonBody(req, 128 * 1024) } catch { sendJson(res, 400, { error: 'bad-body' }); return }
  const urls = (body as { urls?: unknown } | null)?.urls
  if (!Array.isArray(urls) || urls.length > MAX_PULL_REQUESTS
    || urls.some(url => typeof url !== 'string' || url.length > MAX_PULL_REQUEST_URL)) {
    sendJson(res, 400, { error: 'bad-urls' }); return
  }
  sendJson(res, 200, { pullRequests: await lookupPullRequests(deps.config, deps.db, s.user.id, urls) })
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
      for (const finding of await visibleFindingIds(deps, s.user, report.reportId)) {
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
  originGate: OriginGate
  isShuttingDown: () => boolean
  track: (p: Promise<unknown>) => void
  // Combined boot delegates unmatched paths to e2e and overrides discovery.
  serveStatic?: (req: IncomingMessage, res: ServerResponse) => boolean
  next?: Handler
  serverInfo?: ServerInfo
}

type Handler = (req: IncomingMessage, res: ServerResponse) => void

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers })
  res.end(JSON.stringify(body))
}

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

// GET /api/admin/models — the server's canonical scan model ids and effort
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
async function selectRepository(res: ServerResponse, deps: ManagedHttpDeps, user: StoredUser, repoId: number): Promise<void> {
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
    await deps.db.deactivateRepo(repoId)
    if (repo) await activity(deps, s.user, 'repository', 'deactivated a repository', { repo: repo.fullName })
    sendJson(res, 200, { ok: true, selected: false }); return
  }
  await selectRepository(res, deps, s.user, repoId)
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

async function repositoryExclusiveTriageIds(deps: ManagedHttpDeps, reports: { id: string, filename: string }[], otherReports: { id: string, filename: string }[]): Promise<string[]> {
  const targetIds = await repositoryFindingIds(deps, reports)
  const triage = await deps.db.listTriage([...targetIds])
  const commentIds = await deps.db.listCommentedFindingIds([...targetIds])
  const annotatedIds = new Set([...triage.map(entry => entry.findingId), ...commentIds])
  if (annotatedIds.size === 0) return []
  // Only annotated findings need an overlap check.
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
  const reports = await deps.db.listReportsForRepo(repoId)
  const bundles = await deps.db.listBundlesForRepo(repoId)
  const triageIds = deleteTriage
    ? await repositoryExclusiveTriageIds(deps, reports, (await deps.db.listReports()).filter((report) => report.repoId !== repoId))
    : []
  const deletedReports = await deps.db.deleteReportsForRepo(repoId)
  const deletedBundles = await deps.db.deleteBundlesForRepo(repoId)
  // Remove metadata first so a blob-store failure leaves an orphaned blob for
  // later cleanup, rather than a live row pointing at missing report data.
  for (const report of reports) {
    await deps.reportSourcesCache?.deleteReport(report).catch((err) => { console.warn('managed: report sources delete failed:', err) })
    await deps.reportStore.delete(report.id).catch(() => {})
  }
  for (const bundle of bundles) {
    // Cache cleanup must not interrupt triage/repository removal after the
    // report rows needed to reconstruct exclusive finding IDs are gone.
    await deps.bundleCache?.delete(bundle.id).catch((err) => { console.warn('managed: bundle cache delete failed:', err) })
    await deps.reportSourcesCache?.deleteBundle(bundle.id).catch((err) => { console.warn('managed: report sources delete failed:', err) })
    await deps.bundleStore.delete(bundle.id).catch(() => {})
  }
  const deletedTriage = await deps.db.deleteTriage(triageIds)
  await deps.db.deleteRepo(repoId)
  await activity(deps, s.user, 'delete', `removed a repository (${deletedReports} reports, ${deletedBundles} bundles, ${deletedTriage} triage entries)`, { repo: repo.fullName })
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

// True iff `repoId` may be linked to a report / bundle: null (detach) or a
// currently-selected repo id (so the FK can't dangle and you can only attach to
// a managed repo).
async function repoIdAllowed(deps: ManagedHttpDeps, repoId: unknown): Promise<boolean> {
  if (repoId == null) return true
  if (typeof repoId !== 'number' || !Number.isSafeInteger(repoId)) return false
  return (await deps.db.listSelectedRepos()).some((r) => r.repoId === repoId)
}

async function canChangeReportRepo(deps: ManagedHttpDeps, user: StoredUser, reportId: string): Promise<boolean> {
  if (!roleAtLeast(user.role, 'manage') || !(await canViewReport(deps, user, reportId))) return false
  const report = await deps.db.getReport(reportId)
  return report != null && (user.role === 'admin' || report.repoId === null || await deps.db.userCanReadReport(user.id, reportId))
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
  if (!(await canViewReport(deps, s.user, reportId))) { sendJson(res, 404, { error: 'no-report' }); return }
  const report = await deps.db.getReport(reportId)
  if (report == null) { sendJson(res, 404, { error: 'no-report' }); return }
  if (!(await canChangeReportRepo(deps, s.user, reportId))) { sendJson(res, 403, { error: 'repo-forbidden' }); return }
  if (report.repoEmbedded) { sendJson(res, 409, { error: 'repo-in-report' }); return }
  if (!(await repoIdAllowed(deps, repoId))) { sendJson(res, 400, { error: 'bad-repo' }); return }
  const normalized = normalizeTeamPath(directory)
  if (!normalized.ok) { sendJson(res, 400, { error: 'bad-directory' }); return }
  if (repoId !== null && s.user.role !== 'admin' && !(await deps.db.userCanReadRepoPath(s.user.id, repoId as number, normalized.path ?? ''))) { sendJson(res, 403, { error: 'repo-forbidden' }); return }
  if (!(await deps.db.setReportRepo(reportId, repoId as number | null, normalized.path ?? ''))) { sendJson(res, 404, { error: 'no-report' }); return }
  if (report.repoId !== repoId || report.repoDirectory !== (repoId == null ? '' : normalized.path ?? '')) {
    await activity(deps, s.user, 'repository', repoId == null ? 'detached a report from its repository' : `assigned a report to repository path ${normalized.path || '/'}`, { reportId, report: report.filename, repo: await repositoryName(deps, (repoId as number | null) ?? report.repoId) })
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
  if (!(await canViewReport(deps, s.user, reportId))) { sendJson(res, 404, { error: 'no-report' }); return }
  if (!(await canChangeReportRepo(deps, s.user, reportId))) { sendJson(res, 403, { error: 'repo-forbidden' }); return }
  const report = await deps.db.getReport(reportId)
  if (report == null) { sendJson(res, 404, { error: 'no-report' }); return }
  if (!(await deps.db.setReportVisible(reportId, visible))) { sendJson(res, 404, { error: 'no-report' }); return }
  if (report.visible !== visible) await activity(deps, s.user, 'visibility', visible ? 'published a report' : 'hid a report', { reportId, report: report.filename, repo: await repositoryName(deps, report.repoId) })
  sendJson(res, 200, { ok: true, visible })
}

// POST /api/admin/bundles/set-repo — attach / detach a stored bundle's repo link
// (same shape as reports). Body { bundleId, repoId }.
async function handleSetBundleRepo(req: IncomingMessage, res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined): Promise<void> {
  const s = await manageMutation(req, res, deps, cookie)
  if (s == null) return
  let body: unknown
  try { body = await readJsonBody(req) } catch { sendJson(res, 400, { error: 'bad-body' }); return }
  const bundleId = (body as { bundleId?: unknown } | null)?.bundleId
  const repoId = (body as { repoId?: unknown } | null)?.repoId ?? null
  if (typeof bundleId !== 'string') { sendJson(res, 400, { error: 'bad-request' }); return }
  if (!(await canAccessBundle(deps, s.user, bundleId))) { sendJson(res, 404, { error: 'no-bundle' }); return }
  const bundle = await deps.db.getBundle(bundleId)
  if (bundle == null) { sendJson(res, 404, { error: 'no-bundle' }); return }
  if (!(await canChangeBundleRepo(deps, s.user, bundle?.repoId ?? null))) { sendJson(res, 403, { error: 'repo-forbidden' }); return }
  if (!(await repoIdAllowed(deps, repoId))) { sendJson(res, 400, { error: 'bad-repo' }); return }
  if (repoId !== null && s.user.role !== 'admin' && !(await deps.db.userCanReadRepo(s.user.id, repoId as number))) {
    sendJson(res, 403, { error: 'forbidden' }); return
  }
  if (!(await deps.db.setBundleRepo(bundleId, repoId as number | null))) { sendJson(res, 404, { error: 'no-bundle' }); return }
  if (bundle.repoId !== repoId) await activity(deps, s.user, 'repository', repoId == null ? 'detached a bundle from its repository' : 'assigned a bundle to a repository', { bundleId, report: bundle.filename, repo: await repositoryName(deps, (repoId as number | null) ?? bundle.repoId) })
  sendJson(res, 200, { ok: true })
}

// GET /api/admin/reports — the uploaded reports for the "Manage reports" page.
// Visible to admin|manage. Read-only, so no CSRF (like /api/admin/users).
// `maxBytes` lets the page show / pre-check the upload size cap; `repos` feeds
// the upload repo picker.
async function handleListReports(res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined): Promise<void> {
  const s = await readManageSession(res, deps, cookie)
  if (s == null) return
  sendJson(res, 200, {
    reports: await Promise.all((await deps.db.listReports(s.user.role === 'admin' ? undefined : s.user.id)).map(async report => {
      const bundleAllowed = report.bundleId != null && await canAccessBundle(deps, s.user, report.bundleId)
      return { ...report, canChangeRepo: await canChangeReportRepo(deps, s.user, report.id),
        bundleId: bundleAllowed ? report.bundleId : null, bundleFilename: bundleAllowed ? report.bundleFilename : null }
    })),
    maxBytes: deps.config.maxReportBytes,
    repos: selectableRepos(await bundleRepos(deps, s.user)),
    repoScopes: s.user.role === 'admin' ? null : await deps.db.listRepoScopesForUser(s.user.id),
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

// POST /api/admin/reports — upload a report. Mutation: same-origin + CSRF,
// admin|manage. The body is the raw report bytes (any findings format — JSON /
// markdown / CSV — archived as-is, like the e2e objstore; the server parses them
// downstream). Display name rides X-Report-Filename; the repository and
// directory come from the report header, or from optional repository/directory
// headers when the report has no repository metadata. The bundle link is
// auto-resolved from the report's bundleHashes. New reports start hidden until
// published. Bytes
// are written first (keyed by a fresh uuid) then the metadata row — a failed
// insert drops the orphan blob. 413 over the cap, 400 on empty.
async function handleUploadReport(req: IncomingMessage, res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined): Promise<void> {
  const s = await checkMutation(req, res, deps, cookie)
  if (s == null) return
  if (!requireManageRole(res, s.user)) return
  let bytes: Buffer
  try {
    bytes = await readBodyBytes(req, deps.config.maxReportBytes)
  } catch (err) {
    const tooLarge = err instanceof Error && err.message === 'too-large'
    sendJson(res, tooLarge ? 413 : 400, { error: tooLarge ? 'too-large' : 'bad-body' })
    return
  }
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
  const id = randomUUID()
  const contentType = (firstHeader(req.headers['content-type']) ?? '').split(';', 1)[0]!.trim() || 'application/json'
  const sha256 = createHash('sha256').update(bytes).digest('base64url')
  const { bundleId, integrity } = await resolveReportBundle(deps, s.user, bytes)
  await deps.reportStore.put(id, bytes)
  try {
    await deps.db.insertReport({
      id, filename, contentType, byteSize: bytes.length, sha256,
      uploadedBy: s.user.id, uploadedByLogin: s.user.login, repoId: matchedRepo?.repoId ?? null,
      repoDirectory: directory, repoEmbedded, analyzer, visible: false, bundleId, bundleIntegrity: integrity,
    }, Date.now())
  } catch (err) {
    await deps.reportStore.delete(id).catch(() => {})
    throw err
  }
  sendJson(res, 201, { id, slug: (await deps.db.getReport(id))!.slug, filename, byteSize: bytes.length, sha256, repoId: matchedRepo?.repoId ?? null, repoDirectory: directory, repoEmbedded, analyzer, visible: false, bundleId })
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
  res.end(bytes)
}

// DELETE /api/admin/reports/<id> — remove a report (admin|manage). Mutation:
// same-origin + CSRF. Drops the row, then best-effort the bytes; 404 when there
// was no such report.
async function handleDeleteReport(req: IncomingMessage, res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined, id: string): Promise<void> {
  const s = await checkMutation(req, res, deps, cookie)
  if (s == null) return
  if (!requireManageRole(res, s.user)) return
  if (!(await canViewReport(deps, s.user, id))) { sendJson(res, 404, { error: 'no-report' }); return }
  if (!(await canChangeReportRepo(deps, s.user, id))) { sendJson(res, 403, { error: 'repo-forbidden' }); return }
  const report = await deps.db.getReport(id)
  if (report == null) { sendJson(res, 404, { error: 'no-report' }); return }
  const existed = await deps.db.deleteReport(id)
  await deps.reportSourcesCache?.deleteReport(report).catch((err) => { console.warn('managed: report sources delete failed:', err) })
  await deps.reportStore.delete(id).catch((err) => { console.warn('managed: report bytes delete failed:', err) })
  if (!existed) { sendJson(res, 404, { error: 'no-report' }); return }
  await activity(deps, s.user, 'delete', 'deleted a report', { repoId: report.repoId, repoDirectory: report.repoDirectory, reportId: id, report: report.filename, repo: await repositoryName(deps, report.repoId) })
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
  return rec.repoId !== null && deps.db.userCanReadRepo(user.id, rec.repoId)
}

async function canChangeBundleRepo(deps: ManagedHttpDeps, user: StoredUser, repoId: number | null) {
  return roleAtLeast(user.role, 'manage') && (user.role === 'admin' || repoId === null || await deps.db.userCanReadRepo(user.id, repoId))
}

async function bundleRepos(deps: ManagedHttpDeps, user: StoredUser) {
  const repos = await deps.db.listSelectedRepos()
  if (user.role === 'admin') return repos
  const allowed = await Promise.all(repos.map(repo => deps.db.userCanReadRepo(user.id, repo.repoId)))
  return repos.filter((_, index) => allowed[index])
}

function prebuildBundle(deps: ManagedHttpDeps, id: string) {
  if (!deps.bundleCache) return
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
    'content-length': String(cached.size), 'cache-control': 'private, no-store',
    'x-content-type-options': 'nosniff',
  })
  if (req.method === 'HEAD') { cached.stream.destroy(); res.end(); return }
  try { await pipeline(cached.stream, res) } catch { res.destroy() }
}

// GET /api/admin/bundles — the uploaded bundles for the "Manage bundles" page.
// admin|manage, read-only (no CSRF). `maxBytes` is the upload cap; `repos` feeds
// the upload repo picker.
async function handleListBundles(res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined): Promise<void> {
  const s = await readManageSession(res, deps, cookie)
  if (s == null) return
  sendJson(res, 200, {
    bundles: await Promise.all((await deps.db.listBundles(s.user.role === 'admin' ? undefined : s.user.id)).map(async bundle => ({
      ...bundle, canChangeRepo: await canChangeBundleRepo(deps, s.user, bundle.repoId),
    }))),
    maxBytes: deps.config.maxBundleBytes,
    repos: selectableRepos(await bundleRepos(deps, s.user)),
    repoScopes: s.user.role === 'admin' ? null : await deps.db.listRepoScopesForUser(s.user.id),
  })
}

// POST /api/admin/bundles — upload a bundle. Mutation: same-origin + CSRF,
// admin|manage. Raw bytes; X-Bundle-Filename names it, optional X-Repo-Id links
// a repo. The bundle's identity is its content hash (sha512), UNIQUE — a
// re-upload of identical bytes dedupes to the existing row (no second copy).
// After storing, any reports that declared this integrity but weren't linked yet
// get attached (auto-link). 413 over the cap, 400 on empty.
async function handleUploadBundle(req: IncomingMessage, res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined): Promise<void> {
  const s = await checkMutation(req, res, deps, cookie)
  if (s == null) return
  if (!requireManageRole(res, s.user)) return
  let bytes: Buffer
  try {
    bytes = await readBodyBytes(req, deps.config.maxBundleBytes)
  } catch (err) {
    const tooLarge = err instanceof Error && err.message === 'too-large'
    sendJson(res, tooLarge ? 413 : 400, { error: tooLarge ? 'too-large' : 'bad-body' })
    return
  }
  if (bytes.length === 0) { sendJson(res, 400, { error: 'empty' }); return }
  const repo = await resolveUploadRepoId(req, res, deps)
  if (!repo.ok) return
  if (repo.repoId !== null && s.user.role !== 'admin' && !(await deps.db.userCanReadRepo(s.user.id, repo.repoId))) {
    sendJson(res, 403, { error: 'forbidden' }); return
  }
  const integrity = bundleIntegrity(bytes)
  const filename = sanitizeFilename(firstHeader(req.headers['x-bundle-filename']), 'bundle')
  const existing = await deps.db.getBundleByIntegrity(integrity)
  if (existing != null) {
    if (!(await canAccessBundle(deps, s.user, existing.id))) { sendJson(res, 409, { error: 'bundle-conflict' }); return }
    // Reports uploaded while this bundle was inaccessible retain only its
    // integrity. An authorized re-upload repairs those pending links too.
    await deps.db.linkReportsToBundle(integrity, existing.id, s.user.role === 'admin' ? undefined : s.user.id)
    prebuildBundle(deps, existing.id)
    sendJson(res, 200, { id: existing.id, integrity, filename: existing.filename, deduped: true })
    return
  }
  const id = randomUUID()
  const kind = bundleKind(filename)
  await deps.bundleStore.put(id, bytes, kind)
  try {
    await deps.db.insertBundle({
      id, integrity, filename, kind,
      byteSize: bytes.length, uploadedBy: s.user.id, uploadedByLogin: s.user.login, repoId: repo.repoId,
    }, Date.now())
  } catch (err) {
    await deps.bundleStore.delete(id).catch(() => {})
    // A concurrent upload of identical bytes can insert this integrity (UNIQUE)
    // between our dedup check and this insert — treat that as a dedup, not a 500.
    // Any other failure rethrows.
    const raced = await deps.db.getBundleByIntegrity(integrity)
    if (raced != null) {
      if (!(await canAccessBundle(deps, s.user, raced.id))) { sendJson(res, 409, { error: 'bundle-conflict' }); return }
      await deps.db.linkReportsToBundle(integrity, raced.id, s.user.role === 'admin' ? undefined : s.user.id)
      prebuildBundle(deps, raced.id)
      sendJson(res, 200, { id: raced.id, integrity, filename: raced.filename, deduped: true }); return }
    throw err
  }
  // Auto-link reports that declared this integrity before the bundle existed.
  await deps.db.linkReportsToBundle(integrity, id, s.user.role === 'admin' ? undefined : s.user.id)
  prebuildBundle(deps, id)
  sendJson(res, 201, { id, integrity, filename, byteSize: bytes.length, repoId: repo.repoId })
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
    'content-length': String(stored.size),
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
  if (!(await canAccessBundle(deps, s.user, id))) { sendJson(res, 404, { error: 'no-bundle' }); return }
  const bundle = await deps.db.getBundle(id)
  if (bundle == null) { sendJson(res, 404, { error: 'no-bundle' }); return }
  if (!(await canChangeBundleRepo(deps, s.user, bundle?.repoId ?? null))) { sendJson(res, 403, { error: 'repo-forbidden' }); return }
  const existed = await deps.db.deleteBundle(id)
  await deps.bundleCache?.delete(id).catch((err) => { console.warn('managed: bundle cache delete failed:', err) })
  await deps.reportSourcesCache?.deleteBundle(id).catch((err) => { console.warn('managed: report sources delete failed:', err) })
  await deps.bundleStore.delete(id).catch((err) => { console.warn('managed: bundle bytes delete failed:', err) })
  if (!existed) { sendJson(res, 404, { error: 'no-bundle' }); return }
  await activity(deps, s.user, 'delete', 'deleted a bundle', { repoId: bundle.repoId, bundleId: id, report: bundle.filename, repo: await repositoryName(deps, bundle.repoId) })
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
// attached to the team's repos, for the sidebar's per-user Teams section. Any authenticated
// user (not just admin|manage); a user only ever sees their own teams.
async function handleMyTeams(res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined): Promise<void> {
  const s = await readSession(deps.config, deps.db, cookie, Date.now())
  if (s == null) { sendJson(res, 401, { error: 'unauthenticated' }); return }
  const teams = await deps.db.listTeamsForUser(s.user.id)
  sendJson(res, 200, { teams })
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
async function handleReportSources(req: IncomingMessage, res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined, id: string) {
  const s = await readSession(deps.config, deps.db, cookie, Date.now())
  if (!s) { sendJson(res, 401, { error: 'unauthenticated' }); return }
  if (!(await canViewReport(deps, s.user, id))) { sendJson(res, 404, { error: 'no-report' }); return }
  const report = await deps.db.getReport(id)
  const bundle = report?.bundleId ? await deps.db.getBundle(report.bundleId) : null
  const empty = () => { res.writeHead(204, { 'cache-control': 'private, no-store' }); res.end() }
  if (!report || !bundle || !['stasis', 'sourcemap'].includes(bundle.kind ?? '') || !(await canAccessBundle(deps, s.user, bundle.id))) { empty(); return }
  if (!deps.reportSourcesCache) { sendJson(res, 503, { error: 'unavailable' }); return }
  const permissions = s.user.role === 'admin' || s.user.role === 'manage'
    ? { dependencies: true, security: true } : await deps.db.reportPermissionsFor(s.user.id, id)
  let cached
  try { cached = await deps.reportSourcesCache.open(report, bundle, permissions) }
  catch { empty(); return }
  if (!cached) { empty(); return }
  // Cold parsing can outlast role/team changes, report deletion, or relinking.
  const current = await readSession(deps.config, deps.db, cookie, Date.now())
  const latest = await deps.db.getReport(id)
  const currentPermissions = current && (current.user.role === 'admin' || current.user.role === 'manage'
    ? { dependencies: true, security: true } : await deps.db.reportPermissionsFor(current.user.id, id))
  if (!current || !(await canViewReport(deps, current.user, id)) || !(await canAccessBundle(deps, current.user, bundle.id))
      || latest?.bundleId !== bundle.id || latest.sha256 !== report.sha256
      || currentPermissions?.dependencies !== permissions.dependencies || currentPermissions?.security !== permissions.security) {
    cached.stream.destroy()
    sendJson(res, current ? 404 : 401, { error: current ? 'no-report' : 'unauthenticated' })
    return
  }
  res.writeHead(200, {
    'content-type': 'application/json', 'content-encoding': 'gzip',
    'content-length': String(cached.size), 'cache-control': 'private, no-store',
    'x-content-type-options': 'nosniff',
  })
  if (req.method === 'HEAD') { cached.stream.destroy(); res.end(); return }
  try { await pipeline(cached.stream, res) } catch { res.destroy() }
}

// GET /api/reports/<id> — view a report the caller is authorized to read (see
// canViewReport: admin, manager ownership, or team access with publication rules).
// Accept: application/json includes the server's repo assignment alongside the
// filtered content. Other callers retain the raw text/plain response. The
// client renders either without caching to OPFS. 404 covers "no such report" AND
// "not authorized" (so neither existence nor membership is probeable); 503 = row
// without bytes (store desync).
async function handleViewReport(req: IncomingMessage, res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined, id: string): Promise<void> {
  const s = await readSession(deps.config, deps.db, cookie, Date.now())
  if (s == null) { sendJson(res, 401, { error: 'unauthenticated' }); return }
  if (!(await canViewReport(deps, s.user, id))) { sendJson(res, 404, { error: 'no-report' }); return }
  const bytes = await deps.reportStore.get(id)
  if (bytes == null) { sendJson(res, 503, { error: 'unavailable' }); return }
  const current = await readSession(deps.config, deps.db, cookie, Date.now())
  if (!current || !(await canViewReport(deps, current.user, id))) { sendJson(res, 404, { error: 'no-report' }); return }
  const out = await viewerReportBytes(deps, current.user, id, bytes)
  if (out == null) { sendJson(res, 404, { error: 'no-report' }); return }
  if (acceptsReportMetadata(req.headers.accept)) {
    const report = await deps.db.getReport(id)
    if (report == null) { sendJson(res, 404, { error: 'no-report' }); return }
    sendJson(res, 200, {
      content: out.toString('utf8'),
      repo: { github: await repositoryName(deps, report.repoId), directory: report.repoDirectory },
    }, { vary: 'Accept', 'x-content-type-options': 'nosniff' })
    return
  }
  res.writeHead(200, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': String(out.length),
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-store',
    vary: 'Accept',
  })
  res.end(out)
}

// Apply the viewer's visibility-permission filter to a report's bytes. Admin and
// manage roles see the report whole; everyone else (triage / view — 'none' can't
// reach here) has dependency / security findings they lack permission for
// stripped server-side, per their team memberships. Unchanged → original bytes.
async function viewerReportBytes(deps: ManagedHttpDeps, user: StoredUser, reportId: string, bytes: Buffer): Promise<Buffer | null> {
  // Deletion can win while the authorized request is reading the blob. Missing
  // metadata means unavailable, never a filename-free filtering fallback.
  const rec = await deps.db.getReport(reportId)
  if (rec == null) return null
  if (user.role === 'admin' || user.role === 'manage') return bytes
  const perms = await deps.db.reportPermissionsFor(user.id, reportId)
  const text = bytes.toString('utf8')
  const filtered = filterReportContent(text, perms, rec.filename)
  return filtered === text ? bytes : Buffer.from(filtered, 'utf8')
}

// Triage requires both a writing role and access to the report itself.
async function canTriageReport(deps: ManagedHttpDeps, user: StoredUser, reportId: string): Promise<boolean> {
  return roleAtLeast(user.role, 'triage') && await canViewReport(deps, user, reportId)
}

// The finding ids a viewer sees in a report — what the report-scoped triage
// endpoints read and write, since the rows themselves are per finding id. The
// stored bytes run through the viewer's content filter (viewerReportBytes'
// rule: admin/manage whole, others per their visibility permissions), then
// parse + flatten + id-backfill THE SAME WAY the client ingests them, so the
// set matches the ids that viewer's client renders and keys triage by. Missing
// bytes or an unparseable report yield an empty set (nothing is provably
// visible). A report is immutable, so the set is memoized per (report, filter)
// — a bounded map per deps, dropping the oldest entries — rather than
// re-parsed on every debounced push. Handlers warm this cache before their
// session/access recheck, then call again with the current user so permissions
// revoked during the cold read/parse cannot authorize triage reads or writes.
const VISIBLE_IDS_CACHE_MAX = 256
const visibleIdsCaches = new WeakMap<ManagedHttpDeps, Map<string, Set<string>>>()
async function visibleFindingIds(deps: ManagedHttpDeps, user: StoredUser, reportId: string): Promise<Set<string>> {
  const whole = user.role === 'admin' || user.role === 'manage'
  const perms = whole ? null : await deps.db.reportPermissionsFor(user.id, reportId)
  const key = `${reportId}\n${perms == null ? 'whole' : `${perms.dependencies}/${perms.security}`}`
  let cache = visibleIdsCaches.get(deps)
  if (cache == null) { cache = new Map(); visibleIdsCaches.set(deps, cache) }
  const hit = cache.get(key)
  if (hit != null) return hit
  const ids = new Set<string>()
  const bytes = await deps.reportStore.get(reportId)
  if (bytes == null) return ids
  const text = bytes.toString('utf8')
  const rec = await deps.db.getReport(reportId)
  if (rec == null) return ids
  const report = await loadManagedFindings(perms == null ? text : filterReportContent(text, perms, rec.filename), rec.filename)
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

// A stored triage row (current state or a trail event) → its wire entry: only
// set fields present, `false` kept for flagged (the explicit un-flag tombstone
// must round-trip), and null for the row of a cleared entry (every field
// null) — the reader adopts the clear.
function triageWireEntry(row: Pick<TriageRow, 'color' | 'triage' | 'comment' | 'fix' | 'flagged'>, legacyHistory = false): TriageEntryPatch | null {
  const e: TriageEntryPatch = {}
  if (row.color != null) e.color = row.color
  if (isTriageBucket(row.triage)) e.triage = row.triage
  if (legacyHistory && row.comment != null) e.comment = row.comment
  if (row.fix != null) e.fix = row.fix
  if (row.flagged != null) e.flagged = row.flagged
  return Object.keys(e).length > 0 ? e : null
}

// GET /api/reports/<id>/triage — the stored triage entries for the findings of
// a report the caller may view (canViewReport; 404 hides existence and denial
// alike, matching handleViewReport). Entries are keyed by finding id and shared
// by every report carrying the finding; a viewer only receives entries for
// findings their visibility permissions keep in THIS report — an entry on a
// stripped finding must not leak that the finding exists. A cleared entry is
// sent as null (the server's tombstone), distinct from one never set.
async function handleGetReportTriage(res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined, id: string): Promise<void> {
  const s = await readSession(deps.config, deps.db, cookie, Date.now())
  if (s == null) { sendJson(res, 401, { error: 'unauthenticated' }); return }
  if (!(await canViewReport(deps, s.user, id))) { sendJson(res, 404, { error: 'no-report' }); return }
  await visibleFindingIds(deps, s.user, id)
  const current = await readSession(deps.config, deps.db, cookie, Date.now())
  if (!current || !(await canViewReport(deps, current.user, id)) || current.user.role !== s.user.role) { sendJson(res, 404, { error: 'no-report' }); return }
  const visible = await visibleFindingIds(deps, current.user, id)
  const entries: Record<string, TriageEntryPatch | null> = {}
  for (const row of await deps.db.listTriage([...visible])) entries[row.findingId] = triageWireEntry(row)
  sendJson(res, 200, { entries })
}

// GET /api/reports/<id>/triage/history?finding=<fid> — one finding's triage
// trail (newest first, capped), gated exactly like the entries: the caller
// may view the report, and the finding is one their visibility permissions
// keep in it (a stripped or foreign id 404s without revealing whether it
// exists). Each event is the entry as written then (null = a clear), who
// wrote it and when; "what changed" is the diff against the next-older event.
async function handleGetReportTriageHistory(res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined, id: string, query: URLSearchParams): Promise<void> {
  const s = await readSession(deps.config, deps.db, cookie, Date.now())
  if (s == null) { sendJson(res, 401, { error: 'unauthenticated' }); return }
  if (!(await canViewReport(deps, s.user, id))) { sendJson(res, 404, { error: 'no-report' }); return }
  const finding = query.get('finding') ?? ''
  if (finding === '' || finding.length > MAX_FINDING_ID) { sendJson(res, 400, { error: 'bad-request' }); return }
  await visibleFindingIds(deps, s.user, id)
  const current = await readSession(deps.config, deps.db, cookie, Date.now())
  if (!current || !(await canViewReport(deps, current.user, id)) || current.user.role !== s.user.role) { sendJson(res, 404, { error: 'no-report' }); return }
  const visible = await visibleFindingIds(deps, current.user, id)
  if (!visible.has(finding)) { sendJson(res, 404, { error: 'no-finding' }); return }
  const events = (await deps.db.listTriageHistory(finding, MAX_TRIAGE_HISTORY)).map((row: TriageEventRow) => ({
    seq: row.seq, at: row.at, actorLogin: row.actorLogin, batchId: row.batchId, entry: triageWireEntry(row, true),
  }))
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
async function handleSetReportTriage(req: IncomingMessage, res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined, id: string): Promise<void> {
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
  await visibleFindingIds(deps, s.user, id)
  const current = await readSession(deps.config, deps.db, cookie, Date.now())
  if (!current || !(await canViewReport(deps, current.user, id)) || current.user.role !== s.user.role) { sendJson(res, 404, { error: 'no-report' }); return }
  const visible = await visibleFindingIds(deps, current.user, id)
  if (parsed.some(([findingId]) => !visible.has(findingId))) {
    sendJson(res, 404, { error: 'no-finding' }); return
  }
  await deps.db.setTriageEntries(parsed, s.user.id, s.user.login, Date.now(), id)
  sendJson(res, 200, { ok: true })
}

// A report grants access to its visible findings; comments themselves are
// shared by finding ID. Author IDs always come from the authenticated session.
async function handleReportComments(req: IncomingMessage, res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined, reportId: string, commentId: string | null): Promise<void> {
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
  await visibleFindingIds(deps, s.user, reportId)
  const session = await readSession(deps.config, deps.db, cookie, Date.now())
  if (!session || session.user.role !== s.user.role || !(await canViewReport(deps, session.user, reportId))) {
    sendJson(res, 404, { error: 'no-report' }); return
  }
  const visible = await visibleFindingIds(deps, session.user, reportId)
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
  if (!(await deps.db.removeTeamMember(teamId, userId))) { sendJson(res, 404, { error: 'not-member' }); return }
  const team = await deps.db.getTeam(teamId)
  const user = (await deps.db.listUserOptions()).find(row => row.id === userId)
  await activity(deps, s.user, 'access', `removed ${user?.login ?? userId} from team ${team?.name ?? teamId}`)
  sendJson(res, 200, { ok: true })
}

export function createManagedRequestHandler(deps: ManagedHttpDeps): Handler {
  const { config, db, avatarStore, isShuttingDown, track } = deps
  const repositoryDiscovery = new RepositoryDiscovery(config)

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname
    const method = req.method ?? 'GET'
    const cookie = req.headers.cookie

    if (path === '/api/github/pull-requests') {
      if (method !== 'POST') { send405(res, 'POST'); return }
      await handlePullRequests(req, res, deps, cookie); return
    }
    // Public mode probe — lets a client detect the managed protocol up front.
    if (path === CONFIG_PATH) {
      if (method !== 'GET') { send405(res, 'GET'); return }
      sendJson(res, 200, deps.serverInfo ?? { mode: 'managed', managed: { loginPath: LOGIN_PATH, cookieName: config.sessionCookieName } })
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
        const result = await handleCallback(url.searchParams, cookie, { config, db, avatarStore })
        res.writeHead(302, { location: result.location, 'set-cookie': result.setCookies, 'cache-control': 'no-store' })
        res.end()
      } catch (err) {
        if (err instanceof OAuthError) sendJson(res, err.status, { error: err.message })
        else throw err
      }
      return
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
    const managedDataPath = path.startsWith('/api/admin/') || path.startsWith(MY_REPORT_PREFIX)
      || path.startsWith('/api/bundles/') || path === MY_TEAMS_PATH || path.startsWith(AVATAR_PREFIX)
    if (managedDataPath) {
      const s = await readSession(config, db, cookie, Date.now())
      if (s && !roleAtLeast(s.user.role, 'view')) { sendJson(res, 403, { error: 'forbidden' }); return }
    }
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
    if (path === ADMIN_MODELS_PATH) {
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
    if (path === ADMIN_REPOS_PATH) { await handleListRepositories(req, res, deps, cookie, repositoryDiscovery); return }
    if (path === SELECT_REPO_PATH) { await handleSelectRepository(req, res, deps, cookie); return }
    if (path === ADD_PUBLIC_REPO_PATH) { await handleAddPublicRepository(req, res, deps, cookie); return }
    // Reports: list / upload on the exact path, download / delete per-id on the
    // prefix. Method-dispatched here since each path carries two verbs.
    if (path === ADMIN_REPORTS_PATH) {
      if (method === 'GET') { await handleListReports(res, deps, cookie); return }
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
    if (path.startsWith(REPORT_PREFIX)) {
      const id = path.slice(REPORT_PREFIX.length)
      if (method === 'GET') { await handleGetReport(res, deps, cookie, id); return }
      if (method === 'DELETE') { await handleDeleteReport(req, res, deps, cookie, id); return }
      send405(res, 'GET, DELETE'); return
    }
    // Bundles: list / upload on the exact path, download / delete per-id on the
    // prefix (same shape as reports).
    const bundleRead = /^\/api\/bundles\/([a-f\d-]{36})\/(metadata|contents|download)$/iu.exec(path)
    if (bundleRead) {
      if (method !== 'GET' && method !== 'HEAD') { send405(res, 'GET, HEAD'); return }
      const id = bundleRead[1]!
      if (bundleRead[2] === 'download') await handleGetBundle(req, res, deps, cookie, id)
      else await handleBundleCache(req, res, deps, cookie, id, bundleRead[2] as BundleCachePart)
      return
    }
    if (path === ADMIN_BUNDLES_PATH) {
      if (method === 'GET') { await handleListBundles(res, deps, cookie); return }
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
    const sourcesRoute = /^\/api\/reports\/([^/]+)\/sources$/u.exec(path)
    if (sourcesRoute) {
      if (method !== 'GET' && method !== 'HEAD') { send405(res, 'GET, HEAD'); return }
      await handleReportSources(req, res, deps, cookie, sourcesRoute[1]!); return
    }
    const commentsRoute = /^\/api\/reports\/([^/]+)\/comments(?:\/([^/]+))?$/u.exec(path)
    if (commentsRoute) {
      await handleReportComments(req, res, deps, cookie, commentsRoute[1]!, commentsRoute[2] ?? null); return
    }
    // Per-finding triage on a viewable report. The '/triage' suffixes are
    // matched before the bare per-id slice below (a report id is a uuid, so it
    // never ends in them) — same trick as REPORT_SET_REPO_PATH above; the
    // longer '/triage/history' goes first.
    if (path.startsWith(MY_REPORT_PREFIX) && path.endsWith(MY_REPORT_TRIAGE_HISTORY_SUFFIX)) {
      const id = path.slice(MY_REPORT_PREFIX.length, -MY_REPORT_TRIAGE_HISTORY_SUFFIX.length)
      if (method !== 'GET') { send405(res, 'GET'); return }
      await handleGetReportTriageHistory(res, deps, cookie, id, url.searchParams); return
    }
    if (path.startsWith(MY_REPORT_PREFIX) && path.endsWith(MY_REPORT_TRIAGE_SUFFIX)) {
      const id = path.slice(MY_REPORT_PREFIX.length, -MY_REPORT_TRIAGE_SUFFIX.length)
      if (method === 'GET') { await handleGetReportTriage(res, deps, cookie, id); return }
      if (method === 'POST') { await handleSetReportTriage(req, res, deps, cookie, id); return }
      send405(res, 'GET, POST'); return
    }
    // Team-scoped report view (any authenticated user who's in a team holding
    // the report's repo). Distinct prefix from /api/admin/reports/.
    if (path.startsWith(MY_REPORT_PREFIX)) {
      if (method !== 'GET') { send405(res, 'GET'); return }
      await handleViewReport(req, res, deps, cookie, path.slice(MY_REPORT_PREFIX.length)); return
    }
    // The signed-in user's own team memberships (any authenticated user).
    if (path === MY_TEAMS_PATH) {
      if (method !== 'GET') { send405(res, 'GET'); return }
      await handleMyTeams(res, deps, cookie); return
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
    track(route(req, res).catch((err) => {
      console.warn('managed: request handler error:', err)
      if (res.headersSent) { try { res.destroy() } catch {} }
      else sendJson(res, 500, { error: 'internal' })
    }))
  }
}
