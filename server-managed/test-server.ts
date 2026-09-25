// Small fixture server for exercising the managed UI locally.
//
// This deliberately does not implement managed auth, persistence, OAuth, or
// report administration. It only advertises `mode: managed` and answers the
// requests the UI makes with deterministic fixture data and in-memory triage. Run it
// beside `node build.js serve`:
//
//   node server-managed/test-server.ts
//   BACKEND_PORT=8766 PROXY_PORT=8016 node build.js serve
//
// Defaults to admin so all management pages are available. Set MANAGED_TEST_ROLE=view
// to preview the team landing, or manage to exercise the content-management role.
/* eslint-disable max-lines */
import { type IncomingMessage, type ServerResponse, createServer } from 'node:http'
import { DEFAULT_MANAGED_SCAN_MODEL, MANAGED_SCAN_MODELS } from '../common/managed/scan-models.ts'
import { MAX_TRIAGE_BODY_BYTES, MAX_TRIAGE_ENTRIES, type TriageEntryPatch, parseTriageEntryPatch } from '../common/managed/triage.ts'
import { acceptsReportMetadata } from './report-response.ts'
import { type ManagedComment, parseCommentBody } from '../common/managed/comments.ts'
import { randomUUID } from 'node:crypto'

const host = process.env['MANAGED_TEST_HOST'] ?? '127.0.0.1'
const port = Number(process.env['MANAGED_TEST_PORT'] ?? 8766)
const role = process.env['MANAGED_TEST_ROLE'] ?? 'admin'

// The real service will return the model ids and the effort levels it allows
// for each model. Printable names are intentionally omitted: the client owns
// the small, stable catalogue used to turn known ids into friendly labels.
const scanModels = MANAGED_SCAN_MODELS

const repositories = [
  {
    id: 101, fullName: 'example/managed-fixtures', private: true,
    installed: true, selected: true, htmlUrl: 'https://github.com/example/managed-fixtures',
  },
  {
    id: 102, fullName: 'example/worker-service', private: true,
    installed: true, selected: true, htmlUrl: 'https://github.com/example/worker-service',
  },
  {
    id: 103, fullName: 'example/public-playground', private: false,
    installed: false, selected: false, htmlUrl: 'https://github.com/example/public-playground',
  },
  {
    id: 104, fullName: 'example/managed-public', private: false,
    installed: true, selected: false, htmlUrl: 'https://github.com/example/managed-public',
  },
]

const users = [
  { id: 'fixture-user', login: 'managed-preview', name: 'Managed preview', role, lastSeenAt: 1_758_000_000_000, lastActivityAt: 1_757_999_000_000 },
  { id: 'fixture-alex', login: 'alex-security', name: 'Alex Security', role: 'manage', lastSeenAt: 1_757_997_000_000, lastActivityAt: 1_757_996_000_000 },
  { id: 'fixture-riley', login: 'riley-reviewer', name: 'Riley Reviewer', role: 'triage', lastSeenAt: 1_757_991_000_000, lastActivityAt: 1_757_988_000_000 },
  { id: 'fixture-sam', login: 'sam-observer', name: 'Sam Observer', role: 'view', lastSeenAt: 1_757_950_000_000, lastActivityAt: 1_757_900_000_000 },
]

const history = [
  { id: 'history-1', kind: 'triage', actor: 'riley-reviewer', action: 'marked a finding In progress', reportId: 'fixture-report-1', report: 'managed-fixture.json', repo: 'example/managed-fixtures', finding: 'managed-fixture-1', at: 1_758_000_000_000 },
  { id: 'history-2', kind: 'visibility', actor: 'alex-security', action: 'made a report visible', reportId: 'fixture-report-3', report: 'managed-api.json', repo: 'example/managed-fixtures', finding: '', at: 1_757_999_000_000 },
  { id: 'history-3', bundleId: 'fixture-bundle-1', kind: 'upload', actor: 'alex-security', action: 'uploaded a bundle', reportId: '', report: 'managed-fixtures.stasis', repo: 'example/managed-fixtures', finding: '', at: 1_757_998_000_000 },
  { id: 'history-4', kind: 'triage', actor: 'sam-observer', action: 'added a comment', reportId: 'fixture-report-2', report: 'managed-worker.json', repo: 'example/worker-service', finding: 'managed-fixture-2', at: 1_757_910_000_000 },
]

const reportFixtures = [
  {
    id: 'fixture-report-1', slug: 'fixture-report-1', filename: 'managed-fixture.json', repoId: 101,
    repoDirectory: '', repoEmbedded: true, analyzer: null, visible: false,
    uploadedByLogin: 'alex-security', byteSize: 318, bundleFilename: 'managed-fixtures.stasis',
    bundleIntegrity: 'sha512-fixture-managed-1',
    content: JSON.stringify({
      source: 'deepview',
      repo: { github: 'https://github.com/example/managed-fixtures' },
      tree: {
        'src/example.js': { size: 120, imports: ['src/worker.js'] },
        'src/worker.js': { size: 80, imports: [] },
      },
      findings: [{
        id: 'managed-fixture-1', severity: 'medium', confidence: 8,
        title: 'Fixture finding', file: 'src/example.js', line: 12,
        description: 'A dummy managed report for local UI preview.',
      }],
    }),
  },
  {
    id: 'fixture-report-2', slug: 'fixture-report-2', filename: 'managed-worker.json', repoId: 102,
    repoDirectory: 'services/worker', repoEmbedded: true, analyzer: 'codex-security', visible: false,
    uploadedByLogin: 'riley-reviewer', byteSize: 342, bundleFilename: null,
    bundleIntegrity: 'sha512-fixture-managed-2',
    content: JSON.stringify({
      source: 'deepview',
      repo: { github: 'https://github.com/example/worker-service' },
      findings: [{
        id: 'managed-fixture-2', severity: 'low', confidence: 6,
        title: 'Second fixture finding', file: 'src/worker.js', line: 4,
        description: 'Another canned report returned by the preview server.',
      }],
    }),
  },
  {
    id: 'fixture-report-3', slug: 'fixture-report-3', filename: 'managed-api.json', repoId: 101,
    repoDirectory: 'packages/api', repoEmbedded: true, analyzer: 'claude-security', visible: true,
    uploadedByLogin: 'sam-observer', byteSize: 356, bundleFilename: 'managed-fixtures.stasis',
    bundleIntegrity: 'sha512-fixture-managed-1',
    content: JSON.stringify({
      source: 'claude-security',
      repo: { github: 'https://github.com/example/managed-fixtures' },
      findings: [{
        id: 'managed-fixture-3', severity: 'high', confidence: 9,
        title: 'API fixture finding', file: 'src/api.js', line: 27,
        description: 'A third canned report keeps the managed list realistic.',
      }],
    }),
  },
  {
    id: 'fixture-report-4', slug: 'fixture-report-4', filename: 'detached-preview.json', repoId: null,
    repoDirectory: '', repoEmbedded: false, analyzer: 'deepsec', visible: false,
    uploadedByLogin: 'alex-security', byteSize: 284, bundleFilename: null,
    bundleIntegrity: null,
    content: JSON.stringify({
      source: 'deepview',
      findings: [{
        id: 'managed-fixture-4', severity: 'medium', confidence: 7,
        title: 'Unattached preview finding', file: 'src/preview.js', line: 8,
        description: 'An unattached report used to preview assigning a repository later.',
      }],
    }),
  },
]

const reports = new Map(reportFixtures.map((report) => [report.id, report.content]))
const reportMetadata = reportFixtures.map(({ content: _content, ...metadata }) => ({
  ...metadata,
  repoFullName: repoById(metadata.repoId)?.fullName ?? null,
  uploadedAt: 1_758_000_000_000,
}))

const bundles = [
  {
    id: 'fixture-bundle-1', filename: 'managed-fixtures.stasis', kind: 'stasis',
    integrity: 'sha512-fixture-managed-1', byteSize: 4_827_136, repoId: 101,
    uploadedByLogin: 'alex-security', uploadedAt: 1_757_900_000_000,
  },
  {
    id: 'fixture-bundle-2', filename: 'worker-sourcemaps.zip', kind: 'sourcemaps',
    integrity: 'sha512-fixture-managed-2', byteSize: 1_204_288, repoId: 102,
    uploadedByLogin: 'riley-reviewer', uploadedAt: 1_757_700_000_000,
  },
  {
    id: 'fixture-bundle-3', filename: 'detached-preview.stasis', kind: 'stasis',
    integrity: 'sha512-fixture-managed-3', byteSize: 786_432, repoId: null,
    uploadedByLogin: 'sam-observer', uploadedAt: 1_757_500_000_000,
  },
  {
    id: 'fixture-bundle-4', filename: 'managed-fixtures-sourcemaps.zip', kind: 'sourcemaps',
    integrity: 'sha512-fixture-managed-4', byteSize: 512_000, repoId: 101,
    uploadedByLogin: 'alex-security', uploadedAt: 1_757_300_000_000,
  },
]

const teamFixtures = [
  {
    id: 'fixture-team', slug: 'fixture-team', name: 'Security fixtures',
    reportIds: ['fixture-report-1', 'fixture-report-2', 'fixture-report-3'],
    repoLinks: [{ repoId: 101, path: '' }, { repoId: 102, path: 'services/worker' }],
    memberIds: ['fixture-user', 'fixture-alex', 'fixture-riley'],
  },
  {
    id: 'fixture-team-platform', slug: 'fixture-team-platform', name: 'Platform review',
    reportIds: ['fixture-report-2'],
    repoLinks: [{ repoId: 102, path: '' }],
    memberIds: ['fixture-user', 'fixture-sam'],
  },
]

function canManageFixture(content: { repoId: number | null; repoDirectory?: string }): boolean {
  return teamFixtures.some(team => team.memberIds.includes('fixture-user') && team.repoLinks.some(link => link.repoId === content.repoId
    && (content.repoDirectory == null || !link.path || content.repoDirectory === link.path || content.repoDirectory.startsWith(link.path + '/'))))
}

function repoById(id: number | null) { return id == null ? undefined : repositories.find((repo) => repo.id === id) }

function userById(id: string) {
  return users.find((user) => user.id === id)
}

function teamReportRefs(team: (typeof teamFixtures)[number]) {
  return team.reportIds
    .map((id) => reportMetadata.find((report) => report.id === id))
    .filter((report): report is (typeof reportMetadata)[number] => report != null)
    .map((report) => ({ id: report.id, slug: report.slug, filename: report.filename }))
}

const teams = teamFixtures.map((team) => ({
  id: team.id,
  slug: team.slug,
  name: team.name,
  reports: teamReportRefs(team),
  bundles: bundles.filter((bundle) => team.repoLinks.some((link) => link.repoId === bundle.repoId)).map((bundle) => ({ id: bundle.id, filename: bundle.filename, repoFullName: repoById(bundle.repoId)?.fullName ?? '' })),
}))

function adminTeams() {
  return teamFixtures.map((team) => ({
    id: team.id,
    slug: team.slug,
    name: team.name,
    repos: team.repoLinks.map((link) => ({
      repoId: link.repoId,
      fullName: repoById(link.repoId)?.fullName ?? `repository-${link.repoId}`,
      path: link.path,
    })),
    members: team.memberIds.map((id) => {
      const user = userById(id)
      return {
        userId: id,
        login: user?.login ?? id,
        dependencies: id === 'fixture-user' || id === 'fixture-alex',
        security: id !== 'fixture-sam',
      }
    }),
  }))
}

function handleAdminCatalog(url: URL, method: string, res: ServerResponse): boolean {
  if (url.pathname === '/api/admin/scan-results') {
    if (method !== 'GET') { sendJson(res, 405, { error: 'method-not-allowed' }); return true }
    // Scan-server results exist independently of saved/exported reports. These
    // IDs deliberately do not reference reportMetadata or its visibility flags.
    sendJson(res, 200, {
      bundles: bundles.filter(bundle => ['fixture-bundle-1', 'fixture-bundle-2'].includes(bundle.id)),
      results: [
        { id: 'result-security-1', bundleId: 'fixture-bundle-1', title: 'Security scan', model: 'anthropic/claude-opus-5', analyzer: 'claude-security', findings: 12, createdAt: 'Today, 09:42' },
        { id: 'result-generic-1', bundleId: 'fixture-bundle-1', title: 'Generic scan', model: 'openai/gpt-6-astra', analyzer: 'codex-security', findings: 28, createdAt: 'Today, 10:15' },
        { id: 'result-correctness-1', bundleId: 'fixture-bundle-1', title: 'Correctness scan', model: 'moonshotai/kimi-k3', findings: 7, createdAt: 'Today, 10:38' },
        { id: 'result-security-2', bundleId: 'fixture-bundle-2', title: 'Security scan', model: 'anthropic/claude-opus-5', analyzer: 'claude-security', findings: 4, createdAt: 'Yesterday, 17:20' },
        { id: 'result-generic-2', bundleId: 'fixture-bundle-2', title: 'Generic scan', model: 'openai/gpt-6-astra', analyzer: 'codex-security', findings: 9, createdAt: 'Yesterday, 17:55' },
      ],
    })
    return true
  }
  if (url.pathname === '/api/admin/models') {
    if (method !== 'GET') { sendJson(res, 405, { error: 'method-not-allowed' }); return true }
    sendJson(res, 200, { models: scanModels, defaultModel: DEFAULT_MANAGED_SCAN_MODEL })
    return true
  }
  if (url.pathname === '/api/admin/history') {
    if (method !== 'GET') { sendJson(res, 405, { error: 'method-not-allowed' }); return true }
    if (role !== 'admin' && role !== 'manage') { sendJson(res, 403, { error: 'forbidden' }); return true }
    const query = (url.searchParams.get('q') ?? '').toLowerCase()
    const kind = url.searchParams.get('kind') ?? 'all'
    const actor = url.searchParams.get('actor') ?? '', repo = url.searchParams.get('repo') ?? ''
    const actorKey = (login: string) => {
      const user = users.find(entry => entry.login === login)
      return user ? `user:${user.id}` : `legacy:${login}`
    }
    const accessible = history.filter(entry => role === 'admin' || reportMetadata.some(report => report.id === entry.reportId && canManageFixture(report)) || bundles.some(bundle => bundle.id === entry.bundleId && canManageFixture(bundle)))
    const filters = {
      repos: [...new Set(accessible.map(entry => entry.repo).filter(Boolean))].toSorted(),
      users: [...new Set(accessible.map(entry => entry.actor))].toSorted().map(login => ({ id: actorKey(login), login, detail: null })),
    }
    const visible = accessible.filter(entry => (!repo || entry.repo === repo) && (!actor || actorKey(entry.actor) === actor)
      && (kind === 'all' || entry.kind === kind) && [entry.actor, entry.action, entry.repo, entry.report, entry.finding].join(' ').toLowerCase().includes(query))
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 100))
    const page = Math.min(Math.max(1, Number(url.searchParams.get('page')) || 1), Math.max(1, Math.ceil(visible.length / limit)))
    sendJson(res, 200, { history: visible.slice((page - 1) * limit, page * limit), total: visible.length, page, limit, filters })
    return true
  }
  if (url.pathname === '/api/admin/repositories/impact') {
    if (method !== 'GET') { sendJson(res, 405, { error: 'method-not-allowed' }); return true }
    const repoId = Number(url.searchParams.get('repoId'))
    const repo = repoById(repoId)
    if (!repo) { sendJson(res, 404, { error: 'no-repo' }); return true }
    const attached = reportFixtures.filter((report) => report.repoId === repoId)
    const ids = (items: typeof reportFixtures) => items.flatMap((report) =>
      (JSON.parse(report.content) as { findings: { id: string }[] }).findings.map((finding) => finding.id))
    const otherIds = new Set(ids(reportFixtures.filter((report) => report.repoId !== repoId)))
    sendJson(res, 200, {
      repoId, fullName: repo.fullName,
      reports: attached.map((report) => ({ id: report.id, filename: report.filename, repoDirectory: report.repoDirectory })),
      bundles: bundles.filter((bundle) => bundle.repoId === repoId),
      triageCount: [...new Set(ids(attached))].filter((id) => (triage.has(id) || comments.some(comment => comment.findingId === id)) && !otherIds.has(id)).length,
    })
    return true
  }
  return false
}

function handleAdmin(url: URL, method: string, res: ServerResponse): void {
  const adminOnly = /^\/api\/admin\/(?:users|set-role|repositories|teams)(?:\/|$)/u.test(url.pathname)
  if (!['admin', 'manage'].includes(role) || (adminOnly && role !== 'admin')) {
    sendJson(res, 403, { error: 'forbidden' }); return
  }
  if (handleAdminCatalog(url, method, res)) return
  if (url.pathname === '/api/admin/reports/set-visible' && method === 'POST') {
    sendJson(res, 200, { ok: true })
    return
  }
  if (url.pathname.startsWith('/api/admin/reports/')) {
    if (method !== 'GET') { sendJson(res, 405, { error: 'method-not-allowed' }); return }
    const id = decodeURIComponent(url.pathname.slice('/api/admin/reports/'.length))
    const report = reports.get(id)
    if (report == null) { sendJson(res, 404, { error: 'not-found' }); return }
    sendText(res, 200, report)
    return
  }
  if (url.pathname.startsWith('/api/admin/bundles/')) {
    if (method !== 'GET') { sendJson(res, 405, { error: 'method-not-allowed' }); return }
    const id = decodeURIComponent(url.pathname.slice('/api/admin/bundles/'.length))
    const bundle = bundles.find((candidate) => candidate.id === id)
    if (bundle == null) { sendJson(res, 404, { error: 'not-found' }); return }
    const bytes = Buffer.from(`Managed fixture bundle: ${bundle.filename}\n`, 'utf8')
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-disposition': `attachment; filename="${bundle.filename}"`,
      'cache-control': 'no-store',
      'content-length': String(bytes.byteLength),
    })
    res.end(bytes)
    return
  }
  if (url.pathname === '/api/admin/users') { sendJson(res, 200, { users }); return }
  if (url.pathname === '/api/admin/repositories') {
    const scope = url.searchParams.get('scope') ?? 'connected'
    const query = (url.searchParams.get('q') ?? '').trim().toLocaleLowerCase()
    const page = Math.max(1, Number.parseInt(url.searchParams.get('page') ?? '1', 10) || 1)
    const limit = Math.min(50, Math.max(1, Number.parseInt(url.searchParams.get('limit') ?? '20', 10) || 20))
    const filtered = repositories
      .filter((repo) => scope === 'connected'
        ? repo.selected
        : scope === 'installed' ? repo.installed : (!repo.private && !repo.installed))
      .filter((repo) => query === '' || repo.fullName.toLocaleLowerCase().includes(query))
      .toSorted((a, b) => a.fullName.localeCompare(b.fullName))
    sendJson(res, 200, {
      repositories: filtered.slice((page - 1) * limit, page * limit),
      connectedCount: repositories.filter((repo) => repo.selected).length,
      total: filtered.length, page, limit,
      tokenMissing: false,
      installUrl: 'https://github.com/apps/managed-fixtures/installations/new',
    })
    return
  }
  if (url.pathname === '/api/admin/reports') {
    sendJson(res, 200, {
      reports: reportMetadata,
      repos: repositories.filter((repo) => repo.selected).map((repo) => ({ repoId: repo.id, fullName: repo.fullName })),
    })
    return
  }
  if (url.pathname === '/api/admin/bundles') {
    sendJson(res, 200, {
      bundles: bundles.map((bundle) => ({ ...bundle, repoFullName: repoById(bundle.repoId)?.fullName ?? null })),
      repos: repositories.filter((repo) => repo.selected).map((repo) => ({ repoId: repo.id, fullName: repo.fullName })),
    })
    return
  }
  if (url.pathname === '/api/admin/teams') {
    sendJson(res, 200, {
      teams: adminTeams(),
      users,
      repos: repositories.filter((repo) => repo.selected).map((repo) => ({ repoId: repo.id, fullName: repo.fullName })),
      permissions: ['dependencies', 'security'],
    })
    return
  }
  sendJson(res, 200, { ok: true })
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': String(Buffer.byteLength(text)),
  })
  res.end(text)
}

function sendText(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': String(Buffer.byteLength(text)),
  })
  res.end(text)
}

const triage = new Map<string, TriageEntryPatch | null>()
const comments: ManagedComment[] = [{
  id: 'fixture-comment-legacy', findingId: 'managed-fixture-1', body: 'An imported note without an author.',
  authorId: null, authorLogin: null, createdAt: null, updatedAt: null, version: 1,
}]

async function handleComments(req: IncomingMessage, res: ServerResponse, reportId: string, commentId: string | null): Promise<void> {
  const report = reportFixtures.find(item => item.id === reportId)
  if (!report || !['admin', 'manage', 'triage', 'view'].includes(role)) { sendJson(res, 404, { error: 'no-report' }); return }
  const ids = new Set((JSON.parse(report.content).findings as { id: string }[]).map(finding => finding.id))
  if (req.method === 'GET' && commentId == null) {
    sendJson(res, 200, { comments: comments.filter(comment => ids.has(comment.findingId)) }); return
  }
  if (commentId == null ? req.method !== 'POST' : req.method !== 'PATCH' && req.method !== 'DELETE') { sendJson(res, 405, { error: 'method-not-allowed' }); return }
  if (!['admin', 'manage', 'triage'].includes(role) || req.headers['x-csrf-token'] !== 'fixture-csrf-token') {
    sendJson(res, 403, { error: 'forbidden' }); return
  }
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_TRIAGE_BODY_BYTES) { sendJson(res, 413, { error: 'too-large' }); return }
    chunks.push(buffer)
  }
  let raw: { body?: unknown; findingId?: string; version?: number }
  try { raw = JSON.parse(Buffer.concat(chunks).toString()) } catch { sendJson(res, 400, { error: 'bad-body' }); return }
  const body = parseCommentBody(raw?.body)
  if (!body && req.method !== 'DELETE') { sendJson(res, 400, { error: 'bad-comment' }); return }
  if (commentId == null) {
    if (!raw.findingId || !ids.has(raw.findingId)) { sendJson(res, 404, { error: 'no-finding' }); return }
    const at = Date.now()
    const comment = { id: randomUUID(), findingId: raw.findingId, body: body!, authorId: 'fixture-user', authorLogin: 'managed-preview', createdAt: at, updatedAt: at, version: 1 }
    comments.push(comment)
    sendJson(res, 201, { comment }); return
  }
  const comment = comments.find(entry => entry.id === commentId && ids.has(entry.findingId))
  if (!comment) { sendJson(res, 404, { error: 'no-comment' }); return }
  if (comment.authorId !== 'fixture-user') { sendJson(res, 403, { error: 'not-comment-author' }); return }
  if (!Number.isSafeInteger(raw.version) || raw.version! < 1) { sendJson(res, 400, { error: 'bad-version' }); return }
  if (comment.version !== raw.version) { sendJson(res, 409, { error: 'comment-changed' }); return }
  if (req.method === 'DELETE') {
    comments.splice(comments.indexOf(comment), 1)
    res.writeHead(204, { 'cache-control': 'no-store' }); res.end(); return
  }
  if (comment.body !== body) { comment.body = body!; comment.updatedAt = Date.now(); comment.version++ }
  sendJson(res, 200, { comment })
}

async function handleTriage(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
  const fixture = reportFixtures.find((report) => report.id === id)
  if (!fixture) { sendJson(res, 404, { error: 'not-found' }); return }
  const ids = new Set<string>(JSON.parse(fixture.content).findings.map((finding: { id: string }) => finding.id))
  if (req.method === 'GET') {
    sendJson(res, 200, { entries: Object.fromEntries([...triage].filter(([key]) => ids.has(key))) })
    return
  }
  if (req.method !== 'POST') { sendJson(res, 405, { error: 'method-not-allowed' }); return }
  if (!['admin', 'manage', 'triage'].includes(role) || req.headers['x-csrf-token'] !== 'fixture-csrf-token') {
    sendJson(res, 403, { error: 'forbidden' }); return
  }
  const chunks: Buffer[] = []
  let bytes = 0
  let entries: unknown
  try {
    for await (const chunk of req) {
      const buffer = Buffer.from(chunk)
      bytes += buffer.length
      if (bytes > MAX_TRIAGE_BODY_BYTES) { sendJson(res, 413, { error: 'too-large' }); return }
      chunks.push(buffer)
    }
    entries = JSON.parse(Buffer.concat(chunks).toString()).entries
  } catch { sendJson(res, 400, { error: 'bad-body' }); return }
  if (!entries || typeof entries !== 'object' || Array.isArray(entries) || Object.keys(entries).length > MAX_TRIAGE_ENTRIES) {
    sendJson(res, 400, { error: 'bad-entries' }); return
  }
  const parsed = new Map<string, TriageEntryPatch | null>()
  for (const [key, value] of Object.entries(entries)) {
    if (!ids.has(key)) { sendJson(res, 404, { error: 'no-finding' }); return }
    const entry = parseTriageEntryPatch(value)
    if (value != null && typeof value === 'object' && Object.hasOwn(value, 'comment')) { sendJson(res, 400, { error: 'use-comments-endpoint' }); return }
    if (entry === 'invalid') { sendJson(res, 400, { error: 'bad-entry' }); return }
    parsed.set(key, entry)
  }
  for (const [key, value] of parsed) triage.set(key, value)
  sendJson(res, 200, { ok: true })
}

function handle(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? '/', `http://${host}`)
  const method = req.method ?? 'GET'

  if (url.pathname === '/api/config') {
    if (method !== 'GET') { sendJson(res, 405, { error: 'method-not-allowed' }); return }
    sendJson(res, 200, {
      mode: 'managed',
      managed: { loginPath: '/api/test/login', cookieName: 'managed_test_session' },
    })
    return
  }

  // The fixture is intentionally always signed in. This keeps the preview
  // useful without pretending to implement an OAuth flow.
  if (url.pathname === '/api/auth/session') {
    if (method !== 'GET') { sendJson(res, 405, { error: 'method-not-allowed' }); return }
    sendJson(res, 200, {
      user: { id: 'fixture-user', login: 'managed-preview', name: 'Managed preview', role },
      csrfToken: 'fixture-csrf-token',
    })
    return
  }
  if (url.pathname === '/api/teams') {
    if (method !== 'GET') { sendJson(res, 405, { error: 'method-not-allowed' }); return }
    sendJson(res, 200, { teams })
    return
  }
  if (url.pathname.startsWith('/api/reports/')) {
    const route = /^\/api\/reports\/([^/]+)\/comments(?:\/([^/]+))?$/u.exec(url.pathname)
    if (route) {
      void handleComments(req, res, route[1]!, route[2] ?? null).catch(() => {
        if (!res.headersSent) sendJson(res, 500, { error: 'comments-failed' })
      })
      return
    }
    if (url.pathname.endsWith('/triage')) {
      const id = decodeURIComponent(url.pathname.slice('/api/reports/'.length, -'/triage'.length))
      void handleTriage(req, res, id).catch(() => {
        if (!res.headersSent) sendJson(res, 500, { error: 'triage-failed' })
      })
      return
    }
    if (method !== 'GET') { sendJson(res, 405, { error: 'method-not-allowed' }); return }
    const id = decodeURIComponent(url.pathname.slice('/api/reports/'.length))
    const report = reportFixtures.find((entry) => entry.id === id)
    if (report == null) { sendJson(res, 404, { error: 'not-found' }); return }
    res.setHeader('vary', 'Accept')
    res.setHeader('x-content-type-options', 'nosniff')
    if (acceptsReportMetadata(req.headers.accept)) {
      sendJson(res, 200, {
        content: report.content,
        repo: { github: repoById(report.repoId)?.fullName ?? null, directory: report.repoDirectory },
      })
    } else sendText(res, 200, report.content)
    return
  }
  if (url.pathname.startsWith('/api/avatar/')) {
    if (method !== 'GET') { sendJson(res, 405, { error: 'method-not-allowed' }); return }
    // A tiny same-origin SVG means the account menu can exercise its avatar
    // path without needing an image fixture or a CDN. Use the fixture user's
    // initials so the admin user list doesn't show four identical avatars.
    const id = decodeURIComponent(url.pathname.slice('/api/avatar/'.length))
    const user = userById(id)
    const initials = (user?.name ?? user?.login ?? '?')
      .split(/\s+/u).filter(Boolean).map((part) => part[0]).join('').slice(0, 2).toUpperCase()
    const palette = ['#4b83c4', '#b66d42', '#6d8f55', '#8a6db0']
    const color = palette[Math.max(0, users.findIndex((candidate) => candidate.id === id)) % palette.length]
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="16" fill="${color}"/><text x="16" y="20.5" text-anchor="middle" font-family="system-ui, -apple-system, BlinkMacSystemFont, sans-serif" font-size="11" font-weight="600" fill="white">${initials}</text></svg>`
    res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'no-store' })
    res.end(svg)
    return
  }
  if (url.pathname === '/api/test/login') {
    res.writeHead(204, { 'cache-control': 'no-store' })
    res.end()
    return
  }

  // Management pages can still be opened from the account menu in the
  // fixture. Reads return the linked fixture data above; mutations remain
  // harmless acknowledgments because this server intentionally has no state.
  if (url.pathname.startsWith('/api/admin/')) { handleAdmin(url, method, res); return }
  if (url.pathname === '/api/auth/logout') { res.writeHead(204); res.end(); return }
  sendJson(res, 404, { error: 'not-found' })
}

export function start(): ReturnType<typeof createServer> {
  const server = createServer(handle)
  server.listen(port, host, () => {
    console.log(`managed UI test server listening on http://${host}:${port} (role=${role})`)
  })
  return server
}

if (import.meta.main) {
  const server = start(); const stop = () => server.close(() => process.exit(0))
  process.once('SIGINT', stop); process.once('SIGTERM', stop)
}
