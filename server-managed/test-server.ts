// Small fixture server for exercising the managed UI locally.
//
// This deliberately does not implement managed auth, persistence, OAuth, or
// report administration. It only advertises `mode: managed` and answers the
// read requests the existing UI makes with deterministic fixture data. Run it
// beside `node build.js serve`:
//
//   node server-managed/test-server.ts
//   BACKEND_PORT=8766 PROXY_PORT=8016 node build.js serve
//
// Set MANAGED_TEST_ROLE=manage (or admin) to preview landing management entry points; default `view` previews
// the managed landing where users choose reports and bundles shared with their team.
/* eslint-disable max-lines */
import { type IncomingMessage, type ServerResponse, createServer } from 'node:http'
import { DEFAULT_MANAGED_SCAN_MODEL, MANAGED_SCAN_MODELS } from '../common/managed/scan-models.ts'

const host = process.env['MANAGED_TEST_HOST'] ?? '127.0.0.1'
const port = Number(process.env['MANAGED_TEST_PORT'] ?? 8766)
const role = process.env['MANAGED_TEST_ROLE'] ?? 'view'

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
  { id: 'history-1', kind: 'triage', actor: 'riley-reviewer', action: 'marked a finding In progress', reportId: 'fixture-report-1', report: 'managed-fixture.json', repo: 'example/managed-fixtures', finding: 'managed-fixture-1', when: 'Today, 10:14' },
  { id: 'history-2', kind: 'visibility', actor: 'alex-security', action: 'made a report visible', reportId: 'fixture-report-3', report: 'managed-api.json', repo: 'example/managed-fixtures', finding: '', when: 'Today, 09:58' },
  { id: 'history-3', kind: 'upload', actor: 'alex-security', action: 'uploaded a bundle', reportId: '', report: 'managed-fixtures.stasis', repo: 'example/managed-fixtures', finding: '', when: 'Today, 09:42' },
  { id: 'history-4', kind: 'triage', actor: 'sam-observer', action: 'added a comment', reportId: 'fixture-report-2', report: 'managed-worker.json', repo: 'example/worker-service', finding: 'managed-fixture-2', when: 'Yesterday, 17:20' },
]

const reportFixtures = [
  {
    id: 'fixture-report-1', filename: 'managed-fixture.json', repoId: 101,
    repoDirectory: '', repoEmbedded: true, analyzer: null, visible: false,
    uploadedByLogin: 'alex-security', byteSize: 318, bundleFilename: 'managed-fixtures.stasis',
    bundleIntegrity: 'sha512-fixture-managed-1',
    content: JSON.stringify({
      source: 'deepview',
      repo: { github: 'https://github.com/example/managed-fixtures' },
      findings: [{
        id: 'managed-fixture-1', severity: 'medium', confidence: 8,
        title: 'Fixture finding', file: 'src/example.js', line: 12,
        description: 'A dummy managed report for local UI preview.',
      }],
    }),
  },
  {
    id: 'fixture-report-2', filename: 'managed-worker.json', repoId: 102,
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
    id: 'fixture-report-3', filename: 'managed-api.json', repoId: 101,
    repoDirectory: 'packages/api', repoEmbedded: true, analyzer: 'claude-security', visible: true,
    uploadedByLogin: 'sam-observer', byteSize: 356, bundleFilename: 'managed-fixtures.stasis',
    bundleIntegrity: 'sha512-fixture-managed-1',
    content: JSON.stringify({
      source: 'deepview',
      repo: { github: 'https://github.com/example/managed-fixtures' },
      findings: [{
        id: 'managed-fixture-3', severity: 'high', confidence: 9,
        title: 'API fixture finding', file: 'src/api.js', line: 27,
        description: 'A third canned report keeps the managed list realistic.',
      }],
    }),
  },
  {
    id: 'fixture-report-4', filename: 'detached-preview.json', repoId: null,
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
    id: 'fixture-team', name: 'Security fixtures',
    reportIds: ['fixture-report-1', 'fixture-report-2', 'fixture-report-3'],
    repoLinks: [{ repoId: 101, path: '' }, { repoId: 102, path: 'services/worker' }],
    memberIds: ['fixture-user', 'fixture-alex', 'fixture-riley'],
  },
  {
    id: 'fixture-team-platform', name: 'Platform review',
    reportIds: ['fixture-report-2'],
    repoLinks: [{ repoId: 102, path: '' }],
    memberIds: ['fixture-user', 'fixture-sam'],
  },
]

function repoById(id: number | null) { return id == null ? undefined : repositories.find((repo) => repo.id === id) }

function userById(id: string) {
  return users.find((user) => user.id === id)
}

function teamReportRefs(team: (typeof teamFixtures)[number]) {
  return team.reportIds
    .map((id) => reportMetadata.find((report) => report.id === id))
    .filter((report): report is (typeof reportMetadata)[number] => report != null)
    .map((report) => ({ id: report.id, filename: report.filename }))
}

const teams = teamFixtures.map((team) => ({
  id: team.id,
  name: team.name,
  reports: teamReportRefs(team),
  bundles: bundles.filter((bundle) => team.repoLinks.some((link) => link.repoId === bundle.repoId)).map((bundle) => ({ id: bundle.id, filename: bundle.filename, repoFullName: repoById(bundle.repoId)?.fullName ?? '' })),
}))

function adminTeams() {
  return teamFixtures.map((team) => ({
    id: team.id,
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
  if (url.pathname === '/api/admin/models') {
    if (method !== 'GET') { sendJson(res, 405, { error: 'method-not-allowed' }); return true }
    sendJson(res, 200, { models: scanModels, defaultModel: DEFAULT_MANAGED_SCAN_MODEL })
    return true
  }
  if (url.pathname === '/api/admin/history') {
    if (method !== 'GET') { sendJson(res, 405, { error: 'method-not-allowed' }); return true }
    sendJson(res, 200, { history })
    return true
  }
  return false
}

function handleAdmin(url: URL, method: string, res: ServerResponse): void {
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
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': String(Buffer.byteLength(text)),
  })
  res.end(text)
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
    if (method !== 'GET') { sendJson(res, 405, { error: 'method-not-allowed' }); return }
    const id = decodeURIComponent(url.pathname.slice('/api/reports/'.length))
    const report = reports.get(id)
    if (report == null) { sendJson(res, 404, { error: 'not-found' }); return }
    sendText(res, 200, report)
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
