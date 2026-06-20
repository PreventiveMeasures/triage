// HTTP router for the managed auth server. Mounts the GitHub OAuth flow plus
// the session endpoints + the mode probe; there is NO api/sync here (a managed
// server doesn't speak the e2e sync protocol yet). Every handler is async; the
// boot's `track()` keeps in-flight requests drainable on shutdown.
//
//   GET  /api/config             → { mode:'managed', managed:{ loginPath, cookieName } }  (public)
//   GET  /api/oauth/github/login → 302 to GitHub (+ state cookie)
//   GET  /api/oauth/github/callback → the OAuth hook (see github-oauth.ts)
//   GET  /api/auth/session       → { user, csrfToken } | 401
//   GET  /api/teams              → the current user's teams + their reports | 401
//   GET  /api/reports/<id>       → view a report reachable via team membership | 401/404
//   GET  /api/avatar/<id>        → cached avatar bytes by user id | 401/404
//   GET  /api/admin/users        → admin-only user list | 401/403
//   POST /api/admin/set-role     → admin sets another user's role | 401/403/404
//   GET  /api/admin/repositories → admin|manage repo list (each flagged selected) | 401/403
//   POST /api/admin/repositories/select → admin|manage selects/deselects a repo | 401/403
//   GET  /api/admin/reports      → admin|manage list of uploaded reports | 401/403
//   POST /api/admin/reports      → admin|manage uploads a report (raw body) | 401/403/413
//   GET  /api/admin/reports/<id> → admin|manage downloads a stored report | 401/403/404
//   DELETE /api/admin/reports/<id> → admin|manage deletes a report | 401/403/404
//   POST /api/admin/reports/set-repo → admin|manage attaches/detaches a report's repo | 401/403/404
//   GET  /api/admin/bundles      → admin|manage list of uploaded bundles | 401/403
//   POST /api/admin/bundles      → admin|manage uploads a bundle (raw body) | 401/403/413
//   GET  /api/admin/bundles/<id> → admin|manage downloads a stored bundle | 401/403/404
//   DELETE /api/admin/bundles/<id> → admin|manage deletes a bundle | 401/403/404
//   POST /api/admin/bundles/set-repo → admin|manage attaches/detaches a bundle's repo | 401/403/404
//   GET  /api/admin/teams        → admin|manage teams (+ members/repos) + pickers | 401/403
//   POST /api/admin/teams        → admin|manage creates a team | 401/403/409
//   POST /api/admin/teams/rename → admin|manage renames a team | 401/403/404/409
//   POST /api/admin/teams/delete → admin|manage deletes a team | 401/403/404
//   POST /api/admin/teams/{set,remove}-repo   → admin|manage links/unlinks a repo (+path) | 401/403/404
//   POST /api/admin/teams/{set,remove}-member → admin|manage links/unlinks a user (+perms) | 401/403/404
//   POST /api/auth/logout        → same-origin + CSRF, drops the session
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Buffer } from 'node:buffer'
import { createHash, randomUUID } from 'node:crypto'
import type { AvatarStore } from './avatar-store.ts'
import type { BlobStore } from './blob-store.ts'
import { bundleIntegrity, bundleKind, reportBundleHashes } from './bundle.ts'
import type { ManagedConfig } from './config.ts'
import type { ManagedDb, ManagedSession, StoredUser } from './db.ts'
import type { OriginGate } from '../server-common/origin.ts'
import { isRole } from '../common/managed/roles.ts'
import { VISIBILITY_PERMISSIONS, parseTeamUserPermissions } from '../common/managed/permissions.ts'
import { CONFIG_PATH } from '../common/server-info.ts'
import { collectRepos, installUrl } from './github-app.ts'
import { CALLBACK_PATH, LOGIN_PATH, OAuthError, buildLoginRedirect, ensureUserAccessToken, handleCallback } from './github-oauth.ts'
import { clearCookie, endSession, readSession } from './session.ts'

const SESSION_PATH = '/api/auth/session'
const AVATAR_PREFIX = '/api/avatar/'
const LOGOUT_PATH = '/api/auth/logout'
const ADMIN_USERS_PATH = '/api/admin/users'
const SET_ROLE_PATH = '/api/admin/set-role'
const ADMIN_REPOS_PATH = '/api/admin/repositories'
const SELECT_REPO_PATH = '/api/admin/repositories/select'
const ADMIN_REPORTS_PATH = '/api/admin/reports'
const REPORT_SET_REPO_PATH = '/api/admin/reports/set-repo'
const REPORT_PREFIX = '/api/admin/reports/'
const ADMIN_BUNDLES_PATH = '/api/admin/bundles'
const BUNDLE_SET_REPO_PATH = '/api/admin/bundles/set-repo'
const BUNDLE_PREFIX = '/api/admin/bundles/'
const MY_TEAMS_PATH = '/api/teams'
const MY_REPORT_PREFIX = '/api/reports/'
const ADMIN_TEAMS_PATH = '/api/admin/teams'
const TEAM_DELETE_PATH = '/api/admin/teams/delete'
const TEAM_RENAME_PATH = '/api/admin/teams/rename'
const TEAM_SET_REPO_PATH = '/api/admin/teams/set-repo'
const TEAM_REMOVE_REPO_PATH = '/api/admin/teams/remove-repo'
const TEAM_SET_MEMBER_PATH = '/api/admin/teams/set-member'
const TEAM_REMOVE_MEMBER_PATH = '/api/admin/teams/remove-member'
const MAX_TEAM_NAME = 100
const MAX_TEAM_PATH = 500

export interface ManagedHttpDeps {
  config: ManagedConfig
  db: ManagedDb
  avatarStore: AvatarStore
  reportStore: BlobStore
  bundleStore: BlobStore
  originGate: OriginGate
  isShuttingDown: () => boolean
  track: (p: Promise<unknown>) => void
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
    'cache-control': 'private, max-age=600',
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

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const buf = await readBodyBytes(req, MAX_JSON_BODY_BYTES)
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
  const ok = await deps.db.setUserRole(userId, role)
  if (!ok) { sendJson(res, 404, { error: 'not-found' }); return }
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

// GET /api/admin/repositories — the user's repositories for the "Manage
// repositories" page, each flagged `selected` (whether it's in the operate-on
// set). Visible to admin OR manage. Read-only (no mutation), so no CSRF, like
// /api/admin/users. Merges PUBLIC (the user's login token, refreshed on demand)
// + PRIVATE (the App's installation tokens). `installUrl` is the App-install
// link; `tokenMissing:true` tells the page to ask the user to log in again.
async function handleListRepositories(req: IncomingMessage, res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined): Promise<void> {
  if ((req.method ?? 'GET') !== 'GET') { send405(res, 'GET'); return }
  const s = await readManageSession(res, deps, cookie)
  if (s == null) return
  const token = await ensureUserAccessToken(deps.config, deps.db, s.user.id, Date.now())
  const { repositories, tokenMissing } = await collectRepos(deps.config, token)
  const selected = new Set((await deps.db.listSelectedRepos()).map((r) => r.repoId))
  sendJson(res, 200, {
    installUrl: installUrl(deps.config),
    repositories: repositories.map((r) => ({
      id: r.id, fullName: r.fullName, private: r.private, htmlUrl: r.htmlUrl,
      // `installed` = reached through the App (readable) — the default tab lists
      // only these; `selected` = in the operate-on set.
      installed: r.installationId != null, selected: selected.has(r.id),
    })),
    tokenMissing,
  })
}

// The select half of the toggle: re-list the caller's reachable repos to VERIFY
// access (never trust a client-supplied id) and capture the server-derived read
// context (installation id, default branch). A PRIVATE repo with no installation
// can't be read server-side → 409. Stores via selectRepo (upsert).
async function selectRepository(res: ServerResponse, deps: ManagedHttpDeps, userId: string, repoId: number): Promise<void> {
  const token = await ensureUserAccessToken(deps.config, deps.db, userId, Date.now())
  const { repositories } = await collectRepos(deps.config, token)
  const repo = repositories.find((r) => r.id === repoId)
  if (repo == null) { sendJson(res, 404, { error: 'repo-not-accessible' }); return }
  if (repo.private && repo.installationId == null) { sendJson(res, 409, { error: 'repo-not-readable' }); return }
  await deps.db.selectRepo({
    repoId: repo.id, fullName: repo.fullName, private: repo.private,
    installationId: repo.installationId, defaultBranch: repo.defaultBranch,
    htmlUrl: repo.htmlUrl, addedBy: userId,
  }, Date.now())
  sendJson(res, 200, { ok: true, selected: true })
}

// POST /api/admin/repositories/select — admin|manage toggles whether a repo is
// in the operate-on set. Mutation: same-origin + CSRF. Body { repoId, selected }.
// selected:true verifies + records the read context; selected:false drops the row.
async function handleSelectRepository(req: IncomingMessage, res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined): Promise<void> {
  if ((req.method ?? 'GET') !== 'POST') { send405(res, 'POST'); return }
  const s = await checkMutation(req, res, deps, cookie)
  if (s == null) return
  if (!requireManageRole(res, s.user)) return
  let body: unknown
  try { body = await readJsonBody(req) } catch { sendJson(res, 400, { error: 'bad-body' }); return }
  const repoId = (body as { repoId?: unknown } | null)?.repoId
  const selected = (body as { selected?: unknown } | null)?.selected
  if (typeof repoId !== 'number' || !Number.isSafeInteger(repoId) || typeof selected !== 'boolean') {
    sendJson(res, 400, { error: 'bad-request' }); return
  }
  if (!selected) { await deps.db.deselectRepo(repoId); sendJson(res, 200, { ok: true, selected: false }); return }
  await selectRepository(res, deps, s.user.id, repoId)
}

// Strip a client-supplied upload filename to a safe display string. The bytes
// are keyed by a server uuid, so this is for display + Content-Disposition only:
// URL-decoded if encoded, control chars + path separators removed, length-capped.
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
  return cleaned.trim().slice(0, 200) || fallback
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

// POST /api/admin/reports/set-repo — attach / detach a stored report's repo
// link. Mutation: same-origin + CSRF, admin|manage. Body { reportId, repoId }
// where repoId is null (detach) or a currently-selected repo id.
async function handleSetReportRepo(req: IncomingMessage, res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined): Promise<void> {
  const s = await manageMutation(req, res, deps, cookie)
  if (s == null) return
  let body: unknown
  try { body = await readJsonBody(req) } catch { sendJson(res, 400, { error: 'bad-body' }); return }
  const reportId = (body as { reportId?: unknown } | null)?.reportId
  const repoId = (body as { repoId?: unknown } | null)?.repoId ?? null
  if (typeof reportId !== 'string') { sendJson(res, 400, { error: 'bad-request' }); return }
  if (!(await repoIdAllowed(deps, repoId))) { sendJson(res, 400, { error: 'bad-repo' }); return }
  if (!(await deps.db.setReportRepo(reportId, repoId as number | null))) { sendJson(res, 404, { error: 'no-report' }); return }
  sendJson(res, 200, { ok: true })
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
  if (!(await repoIdAllowed(deps, repoId))) { sendJson(res, 400, { error: 'bad-repo' }); return }
  if (!(await deps.db.setBundleRepo(bundleId, repoId as number | null))) { sendJson(res, 404, { error: 'no-bundle' }); return }
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
    reports: await deps.db.listReports(),
    maxBytes: deps.config.maxReportBytes,
    repos: selectableRepos(await deps.db.listSelectedRepos()),
  })
}

// Resolve a report's bundle link from its embedded `bundleHashes`: the first
// declared integrity that has a stored bundle wins (bundleId set). When none is
// stored yet, keep the first declared integrity so a later bundle upload of it
// re-links (see linkReportsToBundle). Returns the (bundleId, integrity) to store.
async function resolveReportBundle(deps: ManagedHttpDeps, bytes: Buffer): Promise<{ bundleId: string | null; integrity: string | null }> {
  const hashes = reportBundleHashes(bytes)
  for (const h of hashes) {
    const b = await deps.db.getBundleByIntegrity(h)
    if (b != null) return { bundleId: b.id, integrity: h }
  }
  return { bundleId: null, integrity: hashes[0] ?? null }
}

// POST /api/admin/reports — upload a report. Mutation: same-origin + CSRF,
// admin|manage. The body is the raw report bytes (any findings format — JSON /
// markdown / CSV — archived as-is, like the e2e objstore; the server parses them
// downstream). Display name rides X-Report-Filename; an optional X-Repo-Id links
// it to a selected repo; the bundle link is auto-resolved from the report's
// bundleHashes. Bytes are written first (keyed by a fresh uuid) then the metadata
// row — a failed insert drops the orphan blob. 413 over the cap, 400 on empty.
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
  const repo = await resolveUploadRepoId(req, res, deps)
  if (!repo.ok) return
  const id = randomUUID()
  const filename = sanitizeFilename(firstHeader(req.headers['x-report-filename']), 'report.json')
  const contentType = (firstHeader(req.headers['content-type']) ?? '').split(';', 1)[0]!.trim() || 'application/json'
  const sha256 = createHash('sha256').update(bytes).digest('base64url')
  const { bundleId, integrity } = await resolveReportBundle(deps, bytes)
  await deps.reportStore.put(id, bytes)
  try {
    await deps.db.insertReport({
      id, filename, contentType, byteSize: bytes.length, sha256,
      uploadedBy: s.user.id, repoId: repo.repoId, bundleId, bundleIntegrity: integrity,
    }, Date.now())
  } catch (err) {
    await deps.reportStore.delete(id).catch(() => {})
    throw err
  }
  sendJson(res, 201, { id, filename, byteSize: bytes.length, sha256, repoId: repo.repoId, bundleId })
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
  const rec = await deps.db.getReport(id)
  if (rec == null) { sendJson(res, 404, { error: 'no-report' }); return }
  const bytes = await deps.reportStore.get(id)
  if (bytes == null) { sendJson(res, 503, { error: 'unavailable' }); return }
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
  const existed = await deps.db.deleteReport(id)
  await deps.reportStore.delete(id).catch((err) => { console.warn('managed: report bytes delete failed:', err) })
  if (!existed) { sendJson(res, 404, { error: 'no-report' }); return }
  sendJson(res, 200, { ok: true })
}

// GET /api/admin/bundles — the uploaded bundles for the "Manage bundles" page.
// admin|manage, read-only (no CSRF). `maxBytes` is the upload cap; `repos` feeds
// the upload repo picker.
async function handleListBundles(res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined): Promise<void> {
  const s = await readManageSession(res, deps, cookie)
  if (s == null) return
  sendJson(res, 200, {
    bundles: await deps.db.listBundles(),
    maxBytes: deps.config.maxBundleBytes,
    repos: selectableRepos(await deps.db.listSelectedRepos()),
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
  const integrity = bundleIntegrity(bytes)
  const filename = sanitizeFilename(firstHeader(req.headers['x-bundle-filename']), 'bundle')
  const existing = await deps.db.getBundleByIntegrity(integrity)
  if (existing != null) {
    // Same bytes already stored → dedupe; the link to any referencing reports
    // was already made when this integrity first landed.
    sendJson(res, 200, { id: existing.id, integrity, filename: existing.filename, deduped: true })
    return
  }
  const id = randomUUID()
  await deps.bundleStore.put(id, bytes)
  try {
    await deps.db.insertBundle({
      id, integrity, filename, kind: bundleKind(filename),
      byteSize: bytes.length, uploadedBy: s.user.id, repoId: repo.repoId,
    }, Date.now())
  } catch (err) {
    await deps.bundleStore.delete(id).catch(() => {})
    // A concurrent upload of identical bytes can insert this integrity (UNIQUE)
    // between our dedup check and this insert — treat that as a dedup, not a 500.
    // Any other failure rethrows.
    const raced = await deps.db.getBundleByIntegrity(integrity)
    if (raced != null) { sendJson(res, 200, { id: raced.id, integrity, filename: raced.filename, deduped: true }); return }
    throw err
  }
  // Auto-link reports that declared this integrity before the bundle existed.
  await deps.db.linkReportsToBundle(integrity, id)
  sendJson(res, 201, { id, integrity, filename, byteSize: bytes.length, repoId: repo.repoId })
}

// GET /api/admin/bundles/<id> — download a stored bundle (admin|manage). Bytes
// are opaque archives, so served as application/octet-stream. 404 no such
// bundle; 503 row-without-bytes (store desync).
async function handleGetBundle(res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined, id: string): Promise<void> {
  const s = await readManageSession(res, deps, cookie)
  if (s == null) return
  const rec = await deps.db.getBundle(id)
  if (rec == null) { sendJson(res, 404, { error: 'no-bundle' }); return }
  const bytes = await deps.bundleStore.get(id)
  if (bytes == null) { sendJson(res, 503, { error: 'unavailable' }); return }
  const dispoName = rec.filename.replaceAll('"', '')
  res.writeHead(200, {
    'content-type': 'application/octet-stream',
    'content-length': String(bytes.length),
    'content-disposition': `attachment; filename="${dispoName}"`,
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-store',
  })
  res.end(bytes)
}

// DELETE /api/admin/bundles/<id> — remove a bundle (admin|manage). Mutation:
// same-origin + CSRF. Drops the row (referencing reports' bundle_id null out via
// the FK; their bundle_integrity stays, so a re-upload re-links), then the bytes
// best-effort. 404 when there was no such bundle.
async function handleDeleteBundle(req: IncomingMessage, res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined, id: string): Promise<void> {
  const s = await checkMutation(req, res, deps, cookie)
  if (s == null) return
  if (!requireManageRole(res, s.user)) return
  const existed = await deps.db.deleteBundle(id)
  await deps.bundleStore.delete(id).catch((err) => { console.warn('managed: bundle bytes delete failed:', err) })
  if (!existed) { sendJson(res, 404, { error: 'no-bundle' }); return }
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

// Normalise an optional team-repo subpath into a clean RELATIVE path inside the
// repo: trim, drop control chars, fold both separators, drop empty + '.'
// segments, and REJECT any '..' segment so the subpath can't escape the repo
// subtree once the (later) data plane reads from it. `{ ok:false }` = traversal
// (the handler 400s); `{ path:null }` = the whole repo. Result is '/'-joined and
// length-capped.
function normalizeTeamPath(raw: unknown): { ok: true; path: string | null } | { ok: false } {
  if (typeof raw !== 'string') return { ok: true, path: null }
  let cleaned = ''
  for (const ch of raw.trim()) {
    const code = ch.codePointAt(0) ?? 0
    if (code < 0x20 || code === 0x7f) continue
    cleaned += ch
  }
  const segments: string[] = []
  for (const seg of cleaned.replaceAll('\\', '/').split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') return { ok: false }
    segments.push(seg)
  }
  const path = segments.join('/').slice(0, MAX_TEAM_PATH)
  return { ok: true, path: path === '' ? null : path }
}

// GET /api/teams — the CURRENT user's teams, each with the reports attached to
// the team's repos, for the sidebar's per-user Teams section. Any authenticated
// user (not just admin|manage); a user only ever sees their own teams.
async function handleMyTeams(res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined): Promise<void> {
  const s = await readSession(deps.config, deps.db, cookie, Date.now())
  if (s == null) { sendJson(res, 401, { error: 'unauthenticated' }); return }
  sendJson(res, 200, { teams: await deps.db.listTeamsForUser(s.user.id) })
}

// GET /api/reports/<id> — view a report a team member can reach (its repo is in
// one of the user's teams). Any authenticated user; NOT gated to admin|manage.
// Serves the raw content as text/plain (+ nosniff) for in-app rendering — the
// client renders it without caching to OPFS. 404 covers both "no such report"
// and "not reachable" (so team membership isn't probeable); 503 = row without
// bytes (store desync).
async function handleViewReport(res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined, id: string): Promise<void> {
  const s = await readSession(deps.config, deps.db, cookie, Date.now())
  if (s == null) { sendJson(res, 401, { error: 'unauthenticated' }); return }
  if (!(await deps.db.userCanReadReport(s.user.id, id))) { sendJson(res, 404, { error: 'no-report' }); return }
  const bytes = await deps.reportStore.get(id)
  if (bytes == null) { sendJson(res, 503, { error: 'unavailable' }); return }
  res.writeHead(200, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': String(bytes.length),
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-store',
  })
  res.end(bytes)
}

// GET /api/admin/teams — every team (members + repos inlined) plus the pickers
// the page needs: all users (member dropdown), selected repos (repo dropdown),
// and the visibility-permission keys. admin|manage, read-only (no CSRF).
async function handleListTeams(res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined): Promise<void> {
  const s = await readManageSession(res, deps, cookie)
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
  const s = await manageMutation(req, res, deps, cookie)
  if (s == null) return
  let body: unknown
  try { body = await readJsonBody(req) } catch { sendJson(res, 400, { error: 'bad-body' }); return }
  const rawName = (body as { name?: unknown } | null)?.name
  const name = typeof rawName === 'string' ? rawName.trim() : ''
  if (name === '' || name.length > MAX_TEAM_NAME) { sendJson(res, 400, { error: 'bad-name' }); return }
  const id = randomUUID()
  if (!(await deps.db.createTeam(id, name, Date.now()))) { sendJson(res, 409, { error: 'name-taken' }); return }
  sendJson(res, 201, { id, name })
}

// POST /api/admin/teams/rename — rename a team. Body { teamId, name }. 404 if no
// such team; 409 if the new name is already taken by another team.
async function handleRenameTeam(req: IncomingMessage, res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined): Promise<void> {
  const s = await manageMutation(req, res, deps, cookie)
  if (s == null) return
  let body: unknown
  try { body = await readJsonBody(req) } catch { sendJson(res, 400, { error: 'bad-body' }); return }
  const teamId = (body as { teamId?: unknown } | null)?.teamId
  const rawName = (body as { name?: unknown } | null)?.name
  const name = typeof rawName === 'string' ? rawName.trim() : ''
  if (typeof teamId !== 'string' || name === '' || name.length > MAX_TEAM_NAME) { sendJson(res, 400, { error: 'bad-name' }); return }
  const result = await deps.db.renameTeam(teamId, name, Date.now())
  if (result === 'not-found') { sendJson(res, 404, { error: 'no-team' }); return }
  if (result === 'name-taken') { sendJson(res, 409, { error: 'name-taken' }); return }
  sendJson(res, 200, { ok: true, name })
}

// POST /api/admin/teams/delete — drop a team (its links cascade). Body { teamId }.
async function handleDeleteTeam(req: IncomingMessage, res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined): Promise<void> {
  const s = await manageMutation(req, res, deps, cookie)
  if (s == null) return
  let body: unknown
  try { body = await readJsonBody(req) } catch { sendJson(res, 400, { error: 'bad-body' }); return }
  const teamId = (body as { teamId?: unknown } | null)?.teamId
  if (typeof teamId !== 'string') { sendJson(res, 400, { error: 'bad-request' }); return }
  if (!(await deps.db.deleteTeam(teamId))) { sendJson(res, 404, { error: 'no-team' }); return }
  sendJson(res, 200, { ok: true })
}

// POST /api/admin/teams/set-repo — link a repo to a team (upsert + optional
// subpath). Body { teamId, repoId, path? }. Repo must be in the selected set.
async function handleSetTeamRepo(req: IncomingMessage, res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined): Promise<void> {
  const s = await manageMutation(req, res, deps, cookie)
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
  if ((await deps.db.getTeam(teamId)) == null) { sendJson(res, 404, { error: 'no-team' }); return }
  if (!(await deps.db.listSelectedRepos()).some((r) => r.repoId === repoId)) { sendJson(res, 400, { error: 'repo-not-selected' }); return }
  await deps.db.setTeamRepo(teamId, repoId, path.path)
  sendJson(res, 200, { ok: true })
}

// POST /api/admin/teams/remove-repo — unlink a repo. Body { teamId, repoId }.
async function handleRemoveTeamRepo(req: IncomingMessage, res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined): Promise<void> {
  const s = await manageMutation(req, res, deps, cookie)
  if (s == null) return
  let body: unknown
  try { body = await readJsonBody(req) } catch { sendJson(res, 400, { error: 'bad-body' }); return }
  const teamId = (body as { teamId?: unknown } | null)?.teamId
  const repoId = (body as { repoId?: unknown } | null)?.repoId
  if (typeof teamId !== 'string' || typeof repoId !== 'number') { sendJson(res, 400, { error: 'bad-request' }); return }
  if (!(await deps.db.removeTeamRepo(teamId, repoId))) { sendJson(res, 404, { error: 'not-linked' }); return }
  sendJson(res, 200, { ok: true })
}

// POST /api/admin/teams/set-member — add/update a member + their visibility
// permissions. Body { teamId, userId, dependencies?, security? }.
async function handleSetTeamMember(req: IncomingMessage, res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined): Promise<void> {
  const s = await manageMutation(req, res, deps, cookie)
  if (s == null) return
  let body: unknown
  try { body = await readJsonBody(req) } catch { sendJson(res, 400, { error: 'bad-body' }); return }
  const teamId = (body as { teamId?: unknown } | null)?.teamId
  const userId = (body as { userId?: unknown } | null)?.userId
  if (typeof teamId !== 'string' || typeof userId !== 'string') { sendJson(res, 400, { error: 'bad-request' }); return }
  if ((await deps.db.getTeam(teamId)) == null) { sendJson(res, 404, { error: 'no-team' }); return }
  if (!(await deps.db.listUserOptions()).some((u) => u.id === userId)) { sendJson(res, 404, { error: 'no-user' }); return }
  await deps.db.setTeamMember(teamId, userId, parseTeamUserPermissions(body))
  sendJson(res, 200, { ok: true })
}

// POST /api/admin/teams/remove-member — remove a membership. Body { teamId, userId }.
async function handleRemoveTeamMember(req: IncomingMessage, res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined): Promise<void> {
  const s = await manageMutation(req, res, deps, cookie)
  if (s == null) return
  let body: unknown
  try { body = await readJsonBody(req) } catch { sendJson(res, 400, { error: 'bad-body' }); return }
  const teamId = (body as { teamId?: unknown } | null)?.teamId
  const userId = (body as { userId?: unknown } | null)?.userId
  if (typeof teamId !== 'string' || typeof userId !== 'string') { sendJson(res, 400, { error: 'bad-request' }); return }
  if (!(await deps.db.removeTeamMember(teamId, userId))) { sendJson(res, 404, { error: 'not-member' }); return }
  sendJson(res, 200, { ok: true })
}

export function createManagedRequestHandler(deps: ManagedHttpDeps): Handler {
  const { config, db, avatarStore, isShuttingDown, track } = deps

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname
    const method = req.method ?? 'GET'
    const cookie = req.headers.cookie

    // Public mode probe — lets a client detect the managed protocol up front.
    if (path === CONFIG_PATH) {
      if (method !== 'GET') { send405(res, 'GET'); return }
      sendJson(res, 200, { mode: 'managed', managed: { loginPath: LOGIN_PATH, cookieName: config.sessionCookieName } })
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
    // Cached avatar by user id, served same-origin (the page CSP forbids the
    // github CDN). The id in the path keys the browser cache per user, so a user
    // switch never serves a stale avatar. Any valid session may fetch one.
    if (path.startsWith(AVATAR_PREFIX)) {
      if (method !== 'GET') { send405(res, 'GET'); return }
      const s = await readSession(config, db, cookie, Date.now())
      if (s == null) { sendJson(res, 401, { error: 'unauthenticated' }); return }
      await serveAvatar(res, avatarStore, path.slice(AVATAR_PREFIX.length))
      return
    }
    // Admin: list users (admin-only).
    if (path === ADMIN_USERS_PATH) {
      if (method !== 'GET') { send405(res, 'GET'); return }
      const s = await readSession(config, db, cookie, Date.now())
      if (s == null) { sendJson(res, 401, { error: 'unauthenticated' }); return }
      if (s.user.role !== 'admin') { sendJson(res, 403, { error: 'forbidden' }); return }
      sendJson(res, 200, { users: await db.listUsers() })
      return
    }
    if (path === SET_ROLE_PATH) { await handleSetRole(req, res, deps, cookie); return }
    if (path === ADMIN_REPOS_PATH) { await handleListRepositories(req, res, deps, cookie); return }
    if (path === SELECT_REPO_PATH) { await handleSelectRepository(req, res, deps, cookie); return }
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
    if (path.startsWith(REPORT_PREFIX)) {
      const id = path.slice(REPORT_PREFIX.length)
      if (method === 'GET') { await handleGetReport(res, deps, cookie, id); return }
      if (method === 'DELETE') { await handleDeleteReport(req, res, deps, cookie, id); return }
      send405(res, 'GET, DELETE'); return
    }
    // Bundles: list / upload on the exact path, download / delete per-id on the
    // prefix (same shape as reports).
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
      if (method === 'GET') { await handleGetBundle(res, deps, cookie, id); return }
      if (method === 'DELETE') { await handleDeleteBundle(req, res, deps, cookie, id); return }
      send405(res, 'GET, DELETE'); return
    }
    // Team-scoped report view (any authenticated user who's in a team holding
    // the report's repo). Distinct prefix from /api/admin/reports/.
    if (path.startsWith(MY_REPORT_PREFIX)) {
      if (method !== 'GET') { send405(res, 'GET'); return }
      await handleViewReport(res, deps, cookie, path.slice(MY_REPORT_PREFIX.length)); return
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
