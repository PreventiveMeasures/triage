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
import { findingsRepository, readManagedReport } from '../common/managed/report-content.ts'
import { type ManagedComment, canDeleteComment, parseCommentBody } from '../common/managed/comments.ts'
import { createHash, randomUUID } from 'node:crypto'
import { reportEntries } from '@preventive/report'
import { teamCatalogRevision } from './team-catalog.ts'
import { BundleBuildError, githubBundleFilename, parseBundleBuild } from './bundle-build.ts'
import { NpmPackageError, readNpmVersion, readNpmVersions } from './npm-packages.ts'
import { loadNpmPackageBody, loadNpmTarball } from './npm-loads.ts'
import { parseTeamNpmScopes } from './team-npm-scopes.ts'
import { npmPackageScope } from '../common/managed/npm-packages.js'

const host = process.env['MANAGED_TEST_HOST'] ?? '127.0.0.1'
const port = Number(process.env['MANAGED_TEST_PORT'] ?? 8766)
const role = process.env['MANAGED_TEST_ROLE'] ?? 'admin'

// The real service will return the model ids and the effort levels it allows
// for each model. Printable names are intentionally omitted: the client owns
// the small, stable catalogue used to turn known ids into friendly labels.
const scanModels = MANAGED_SCAN_MODELS

const repositories = [
  {
    id: 101, fullName: 'example/managed-fixtures', private: true, visibility: 'private',
    installed: true, selected: true, htmlUrl: 'https://github.com/example/managed-fixtures',
  },
  {
    id: 102, fullName: 'example/worker-service', private: true, visibility: 'private',
    installed: true, selected: true, htmlUrl: 'https://github.com/example/worker-service',
  },
  {
    id: 103, fullName: 'example/public-playground', private: false, visibility: 'public',
    installed: false, selected: false, htmlUrl: 'https://github.com/example/public-playground',
  },
  {
    id: 104, fullName: 'example/managed-public', private: false, visibility: 'public',
    installed: true, selected: false, htmlUrl: 'https://github.com/example/managed-public',
  },
  {
    id: 105, fullName: 'acme/api-service', private: false, visibility: 'internal',
    installed: true, selected: true, htmlUrl: 'https://github.com/acme/api-service',
  },
  {
    id: 106, fullName: 'tools/public-library', private: false, visibility: 'public',
    installed: false, selected: true, htmlUrl: 'https://github.com/tools/public-library',
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
  { id: 'history-3', bundleId: 'fixture-bundle-1', kind: 'upload', actor: 'alex-security', action: 'built a bundle', reportId: '', report: 'managed-fixtures.stasis', repo: 'example/managed-fixtures', finding: '', at: 1_757_998_000_000 },
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
        id: 'managed-fixture-3', severity: 'high', confidence: 9, isApp: true, revalidate: 'revalidation',
        title: 'API fixture finding', file: 'src/api.js', line: 27,
        description: 'A third canned report keeps the managed list realistic.',
      }],
    }),
  },
  {
    id: 'fixture-report-md', slug: 'fixture-report-md', filename: 'report.md', repoId: 101,
    repoDirectory: '', repoEmbedded: true, analyzer: 'claude-security', visible: true,
    uploadedByLogin: 'sam-observer', byteSize: 340, bundleFilename: 'managed-fixtures.stasis',
    bundleIntegrity: 'sha512-fixture-managed-1',
    content: [
      '# Markdown security finding',
      '', '## Details', 'A Claude Security Markdown report for sidebar navigation.',
      '', '## Location', '[src/example.js](https://github.com/example/managed-fixtures/blob/main/src/example.js#L12)',
      '', '---', '**Severity:** high', '**Repository:** example/managed-fixtures',
    ].join('\n'),
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
        repo: { github: 'example/worker-service' },
      }],
    }),
  },
]

reportFixtures.push({ ...reportFixtures[0]!, id: 'fixture-links', slug: 'fixture-links', filename: 'managed-links.json',
  repoId: 101, analyzer: 'links', repoEmbedded: false, visible: true, bundleFilename: null, bundleIntegrity: '',
  content: JSON.stringify([[{ id: 'managed-fixture-1' }, { id: 'managed-fixture-3' }]]),
})

const reports = new Map(reportFixtures.map((report) => [report.id, report.content]))
const reportMetadata = reportFixtures.map(({ content: _content, ...metadata }) => ({
  ...metadata,
  repoFullName: repoById(metadata.repoId)?.fullName ?? null,
  uploadedAt: 1_758_000_000_000,
}))

const bundles = [
  {
    id: 'fixture-bundle-1', slug: 'fixture-bundle-1', filename: 'managed-fixtures.stasis', kind: 'stasis',
    repoDirectory: '', integrity: 'sha512-fixture-managed-1', byteSize: 4_827_136, repoId: 101,
    visible: true, uploadedByLogin: 'alex-security', uploadedAt: 1_757_900_000_000, provenance: 'build',
  },
  {
    id: 'fixture-bundle-2', slug: 'fixture-bundle-2', filename: 'worker-sourcemaps.zip', kind: 'sourcemaps',
    repoDirectory: 'services/worker', integrity: 'sha512-fixture-managed-2', byteSize: 1_204_288, repoId: 102,
    visible: false, uploadedByLogin: 'riley-reviewer', uploadedAt: 1_757_700_000_000, provenance: 'upload',
  },
  {
    id: 'fixture-bundle-3', slug: 'fixture-bundle-3', filename: 'detached-preview.stasis', kind: 'stasis',
    repoDirectory: '', integrity: 'sha512-fixture-managed-3', byteSize: 786_432, repoId: null,
    visible: false, uploadedByLogin: 'sam-observer', uploadedAt: 1_757_500_000_000, provenance: 'upload',
  },
  {
    id: 'fixture-bundle-4', slug: 'fixture-bundle-4', filename: 'managed-fixtures-sourcemaps.zip', kind: 'sourcemaps',
    repoDirectory: 'packages/api', integrity: 'sha512-fixture-managed-4', byteSize: 512_000, repoId: 101,
    visible: true, uploadedByLogin: 'alex-security', uploadedAt: 1_757_300_000_000, provenance: null,
  },
]

const teamFixtures = [
  {
    id: 'fixture-team', slug: 'fixture-team', name: 'Security fixtures',
    reportIds: ['fixture-report-1', 'fixture-report-2', 'fixture-report-3', 'fixture-report-md', 'fixture-links'],
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
    .filter(report => report.visible || role === 'admin' || role === 'manage')
    .map((report) => ({ id: report.id, slug: report.slug, filename: report.filename, visible: report.visible, analyzer: report.analyzer, repoFullName: report.repoFullName, repoDirectory: report.repoDirectory }))
}

const currentTeams = () => teamFixtures.map((team) => ({
  id: team.id,
  slug: team.slug,
  name: team.name,
  permissions: { dependencies: true, security: true },
  reports: teamReportRefs(team),
  bundles: bundles.filter(bundle => bundle.visible || role === 'admin' || role === 'manage').filter((bundle) => team.repoLinks.some((link) => link.repoId === bundle.repoId && (!link.path || bundle.repoDirectory === link.path || bundle.repoDirectory.startsWith(link.path + '/')))).map((bundle) => ({ id: bundle.id, slug: bundle.slug, visible: bundle.visible, integrity: bundle.integrity, byteSize: bundle.byteSize, repoId: bundle.repoId!, repoDirectory: bundle.repoDirectory, filename: bundle.filename, repoFullName: repoById(bundle.repoId)?.fullName ?? '' })),
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
  if (url.pathname === '/api/admin/scan/models') {
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
      (readManagedReport(report.content, report.filename).data.findings as { id: string }[]).map((finding) => finding.id))
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

// A repository's history for the History tab: main merging a feature and a
// fix, develop merging main back, a branch still open, tags on main, and a
// long line of older commits under them. main's head is the code fixture's
// `a…`, develop's its `b…`.
const HISTORY_FIXTURE: [string, string, string[], number, string][] = [
  ['main', 'Merge pull request #42 from org/feature/code-viewer', ['m9', 'cv3'], 2, 'Ada Lovelace'],
  ['cv3', 'Code viewer: a History tab with the graph of branches', ['cv2'], 3, 'Grace Hopper'],
  ['bp2', 'Bundle picker: remember the last repository picked', ['bp1'], 5, 'Linus Torvalds'],
  ['develop', 'Experimental: read trees lazily', ['d2'], 9, 'Margaret Hamilton'],
  ['m9', 'Fix a flaky upload test', ['m8'], 20, 'Ada Lovelace'],
  ['cv2', 'Code viewer: the repository as a dropdown', ['cv1'], 26, 'Grace Hopper'],
  ['bp1', 'Bundle picker: list the repositories connected', ['m8'], 30, 'Linus Torvalds'],
  ['d2', 'Merge branch main into develop', ['d1', 'm8'], 34, 'Margaret Hamilton'],
  ['cv1', 'Code viewer: open a directory at a revision', ['m7'], 50, 'Grace Hopper'],
  ['m8', 'Merge pull request #41 from org/fix/ci-cache', ['m7', 'f1'], 70, 'Ada Lovelace'],
  ['f1', 'CI: cache node_modules between runs', ['m6'], 80, 'Ken Thompson'],
  ['m7', 'Release 1.0.0', ['m6'], 100, 'Ada Lovelace'],
  ['d1', 'Experimental: a worker pool for scans', ['m5'], 130, 'Margaret Hamilton'],
  ['m6', 'Bump dependencies', ['m5'], 160, 'Dependabot'],
  ['m5', 'Merge pull request #40 from org/feature/treemap', ['m4', 't2'], 200, 'Ada Lovelace'],
  ['t2', 'Treemap: label the largest files', ['t1'], 230, 'Barbara Liskov'],
  ['m4', 'Docs: the managed mode', ['m3'], 260, 'Ada Lovelace'],
  ['t1', 'Treemap: size files by their bytes', ['m3'], 300, 'Barbara Liskov'],
  ['m3', 'Search: match case and whole words', ['m2'], 400, 'Edsger Dijkstra'],
  ['m2', 'Release 0.19.0', ['m1'], 600, 'Ada Lovelace'],
  ['m1', 'Code: open files by their number', ['o1'], 900, 'Edsger Dijkstra'],
  ...Array.from({ length: 140 }, (_, index): [string, string, string[], number, string] =>
    [`o${index + 1}`, `Older work, part ${140 - index}`, index === 139 ? [] : [`o${index + 2}`], 1000 + index * 40, index % 3 === 0 ? 'Ada Lovelace' : 'Alan Turing']),
]
const historySha = (label: string) => label === 'main' ? 'a'.repeat(40) : label === 'develop' ? 'b'.repeat(40) : createHash('sha1').update(label).digest('hex')
const HISTORY_BRANCHES = [['main', 'main'], ['develop', 'develop'], ['feature/bundle-picker', 'bp2'], ['feature/code-viewer', 'cv3']]
// Read on from, by All branches' Older commits: as if past the most recently
// committed to.
const HISTORY_STALE_BRANCHES = [['release/0.x', 'o90']]
const HISTORY_TAGS = [['v1.0.0', 'm7'], ['v0.19.0', 'm2']]
// All branches' commits from each tip, fewer than GitHub's, so that it reads
// on.
const HISTORY_ALL_DEPTH = 40

// A repository's issues and pull requests for its Issues and Pull requests
// tabs: a few of each kind of state, review and checks, then a long tail of
// older ones, read twenty at a time.
const ISSUE_LABELS: [string, string][] = [['bug', 'd73a4a'], ['enhancement', 'a2eeef'], ['ui', '7057ff'], ['performance', 'fbca04'], ['docs', '0075ca'],
  ['good first issue', '7057ff'], ['security', 'b60205'], ['dependencies', '0366d6']]
const ISSUE_AUTHORS = ['ada', 'grace-hopper', 'linus', 'margaret', 'kenthompson', 'barbara-liskov', 'dependabot[bot]']
const ISSUE_TITLES = ['Treemap labels overlap on narrow screens', 'History graph: merge lanes cross when a branch is reverted',
  'Search: match case is lost when switching files', 'Support .tgz bundles in the uploader', 'Code viewer opens the wrong line after a rename',
  'Slow first paint for reports with 2,000 findings', 'Document the managed mode\'s team grants', 'Bump lit from 3.2.1 to 3.3.0',
  'Advisories: show the fixed version beside the affected range', 'Keyboard: Escape should close the revision picker',
  'The bundle picker forgets the last repository', 'Dark mode: tag chips are hard to read']
const ISSUES_FIXTURE_PAGE = 20

function issuesFixture(url: URL, res: ServerResponse): void {
  const now = Date.now()
  const kind = url.searchParams.get('kind') === 'pulls' ? 'pulls' : 'issues'
  const all = Array.from({ length: kind === 'pulls' ? 46 : 63 }, (_, index) => {
    const hours = index < 6 ? [1, 3, 9, 20, 30, 50][index]! : 60 + index * index * 2
    const labels = ISSUE_LABELS.flatMap(([name, color], at) => (index * 7 + at * 3) % 11 < (index % 4 === 0 ? 3 : 1) ? [{ name, color }] : [])
    const common = { number: (kind === 'pulls' ? 900 : 880) - index * 3, title: `${ISSUE_TITLES[index % ISSUE_TITLES.length]}${index >= ISSUE_TITLES.length ? ` (${Math.floor(index / ISSUE_TITLES.length) + 1})` : ''}`,
      author: ISSUE_AUTHORS[index % ISSUE_AUTHORS.length]!, createdAt: now - (hours + 40) * 3_600_000, updatedAt: now - hours * 3_600_000, comments: (index * 5) % 13,
      labels: labels.slice(0, 3), moreLabels: Math.max(0, labels.length - 3) }
    const closed = index % 3 === 2
    if (kind === 'issues') return { ...common, state: closed ? 'closed' : 'open', closedAt: closed ? common.updatedAt : null, reason: closed ? index % 2 ? 'not-planned' : 'completed' : null }
    const state = closed ? index % 2 ? 'closed' : 'merged' : 'open'
    return { ...common, state, closedAt: closed ? common.updatedAt : null, mergedAt: state === 'merged' ? common.updatedAt : null, draft: state === 'open' && index % 5 === 3,
      review: state === 'open' ? (['approved', 'changes', 'required', null] as const)[index % 4]! : null, checks: (['success', 'failure', 'pending', null] as const)[(index * 3) % 4]!,
      additions: (index * 37) % 400 + 2, deletions: (index * 19) % 150, head: `feature/${common.title.toLowerCase().replaceAll(/[^a-z\d]+/gu, '-').slice(0, 24).replace(/-$/u, '')}`, base: 'main' }
  })
  const state = url.searchParams.get('state') === 'closed' ? 'closed' : 'open'
  const listed = all.filter(item => (item.state === 'open') === (state === 'open'))
  // Cursors with a `_`, as GitHub's base64url ones can have.
  const from = Number(/^page_(\d+)$/u.exec(url.searchParams.get('after') ?? '')?.[1] ?? '0')
  const end = from + ISSUES_FIXTURE_PAGE
  sendJson(res, 200, { kind, state, items: listed.slice(from, end), counts: { open: all.filter(item => item.state === 'open').length, closed: all.filter(item => item.state !== 'open').length },
    more: end < listed.length, after: end < listed.length ? `page_${end}` : null })
}

// What a repository's agents left, for its Agents tab: Claude Code sessions,
// one holding several pull requests and commits pushed to main, one the
// Claude GitHub App ran for an issue; Codex tasks on branches of their own, one
// a Codex cloud task linked; work no agent touched; read ten pull requests
// and twenty commits at a time, as the server answers, its texts read.
const AGENT_FIXTURE_PAGE = { pulls: 10, commits: 20 }

function agentsFixture(url: URL, res: ServerResponse): void {
  const now = Date.now()
  const hours = (count: number) => now - count * 3_600_000
  const none = { sessions: [], tasks: [], claude: false }
  const session = (id: string) => ({ sessions: [`session_${id}`], tasks: [], claude: true })
  const commits: object[] = [], pulls: object[] = []
  const pull = (number: number, title: string, head: string, at: number, signals: object, more: object = {}) => pulls.push({ number, title, state: 'merged', draft: false,
    author: 'ChristopherTuring', createdAt: hours(at + 1), updatedAt: hours(at), head, additions: (number * 37) % 900 + 4, deletions: (number * 13) % 200, commits: number % 4 + 1,
    closes: [], signals, ...more })
  // A long session: the code viewer, a pull request at a time, and two fixes pushed to main.
  const viewer = ['Code viewer: a repository\'s directory at a revision', 'Code: open from repository rows, picked in the viewer\'s header',
    'Code: show switches loading; no tooltip on a repository\'s code link', 'Code: a History tab with the graph of branches',
    'Revision picker: focus ring on keyboard focus only', 'History: All branches reads older commits', 'Code viewer: Issues and Pull requests tabs']
  viewer.forEach((title, index) => pull(882 + index * 3, title, index === 5 ? 'claude/magical-mayer-83oicz-history-reuse' : 'claude/magical-mayer-83oicz', 30 - index * 4,
    session('01MamW9SFrduHwBFipxyjRnn'), index === 6 ? { state: 'open' } : index === 3 ? { closes: [860] } : {}))
  for (const [index, title] of ['History: keep the graph\'s lanes in their colors', 'Issues: read past the first page'].entries()) {
    commits.push({ oid: createHash('sha1').update(title).digest('hex'), title, at: hours(5 + index * 9), author: 'ChristopherTuring', additions: 12, deletions: 4,
      signals: session('01MamW9SFrduHwBFipxyjRnn') })
  }
  // Another session, of two pull requests on one branch.
  pull(870, 'Repository risk: packages toggled All/Production/Development', 'claude/practical-ride-7Qx2', 52, session('01Practical7Qx2Ride'))
  pull(874, 'Repository risk: the progress line counts dev', 'claude/practical-ride-7Qx2', 48, session('01Practical7Qx2Ride'), { state: 'closed' })
  // The Claude GitHub App, asked on an issue.
  pull(861, 'Dark mode: tag chips are readable', 'claude/issue-842-20261013-0912', 70, { sessions: [], tasks: [], claude: true }, { closes: [842] })
  // Codex: a branch a task, one a cloud task linked, one still open, one left without a pull request.
  const codex = ['Use Compare directory expansion defaults in Review', 'Preserve Markdown in copied audit notes', 'Fix My reviews empty-state alignment and spacing',
    'Advisories: show the fixed version beside the range', 'Align the popup header', 'Workspace import: keep unattributed comments']
  codex.forEach((title, index) => pull(845 - index * 4, title, `codex/${title.toLowerCase().replaceAll(/[^a-z\d]+/gu, '-').slice(0, 30).replace(/-$/u, '')}`,
    12 + index * 11, index === 1 ? { sessions: [], tasks: ['task_e_68ecb1f0a2c88191'], claude: false } : none, index === 0 ? { state: 'open', draft: true } : index === 4 ? { state: 'closed' } : {}))
  // A commit Claude authored straight to main, naming no session.
  commits.push({ oid: createHash('sha1').update('direct').digest('hex'), title: 'Fix a flaky upload test', at: hours(26), author: null, additions: 3, deletions: 1,
    signals: { sessions: [], tasks: [], claude: true } })
  // Work no agent touched.
  pull(850, 'Bump dependencies', 'deps/bump', 40, none)
  pull(851, 'Docs: the managed mode', 'docs/managed', 44, none)
  pulls.sort((a, b) => (b as { updatedAt: number }).updatedAt - (a as { updatedAt: number }).updatedAt)
  commits.sort((a, b) => (b as { at: number }).at - (a as { at: number }).at)
  const issues = [{ number: 842, title: 'Dark mode: tag chips are hard to read', state: 'closed', author: 'ada', createdAt: hours(90), updatedAt: hours(70) },
    { number: 860, title: 'Code viewer: history of a directory', state: 'closed', author: 'ChristopherTuring', createdAt: hours(34), updatedAt: hours(17) },
    { number: 855, title: 'Slow first paint', state: 'open', author: 'grace', createdAt: hours(80), updatedAt: hours(60) }]
  const branches = [{ name: 'claude/magical-mayer-83oicz', at: hours(2), author: 'ChristopherTuring', signals: session('01MamW9SFrduHwBFipxyjRnn') },
    { name: 'codex/try-lazy-trees', at: hours(8), author: 'ChristopherTuring', signals: none }]
  // Cursors with a `_`, as GitHub's base64url ones can have.
  const at = (name: string) => Number(/^page_(\d+)$/u.exec(url.searchParams.get(name) ?? '')?.[1] ?? '0')
  const first = !url.searchParams.has('pulls') && !url.searchParams.has('commits')
  const read = (list: object[], name: 'pulls' | 'commits') => {
    if (!first && !url.searchParams.has(name)) return { items: [], after: null }
    const from = at(name)
    const end = from + AGENT_FIXTURE_PAGE[name]
    return { items: list.slice(from, end), after: end < list.length ? `page_${end}` : null }
  }
  const [readPulls, readCommits] = [read(pulls, 'pulls'), read(commits, 'commits')]
  sendJson(res, 200, { pulls: readPulls.items, commits: readCommits.items, ...first ? { issues, branches } : {},
    more: readPulls.after !== null || readCommits.after !== null, after: { pulls: readPulls.after, commits: readCommits.after } })
}

function historyFixture(url: URL, res: ServerResponse): void {
  const now = Date.now()
  const commits = HISTORY_FIXTURE.map(([label, subject, parents, hours, author]) => ({
    sha: historySha(label), parents: parents.map(historySha), subject, authorName: author, authorLogin: null, committedAt: now - hours * 3_600_000,
  }))
  const branches = HISTORY_BRANCHES.map(([name, label]) => ({ name, sha: historySha(label!) }))
  const tags = HISTORY_TAGS.map(([name, label]) => ({ name, sha: historySha(label!) }))
  const bySha = new Map(commits.map(item => [item.sha, item]))
  // The commits `commit` reaches, newest first.
  const reaching = (commit: string) => {
    const reached = new Set<string>()
    for (const queue = [commit]; queue.length > 0;) {
      const sha = queue.pop()!
      if (reached.has(sha) || !bySha.has(sha)) continue
      reached.add(sha)
      queue.push(...bySha.get(sha)!.parents)
    }
    return commits.filter(item => reached.has(item.sha))
  }
  const page = Number(url.searchParams.get('page') ?? '1')
  if (url.searchParams.get('all') === 'true') {
    const from = url.searchParams.get('from')?.split(',') ?? null
    const read = new Map((from ?? branches.map(branch => branch.sha)).flatMap(sha => reaching(sha).slice(0, HISTORY_ALL_DEPTH)).map(item => [item.sha, item]))
    if (from) { sendJson(res, 200, { all: true, page, commits: [...read.values()], more: page < 100 }); return }
    const stale = HISTORY_STALE_BRANCHES.map(([name, label]) => ({ name, sha: historySha(label!), at: bySha.get(historySha(label!))!.committedAt }))
    sendJson(res, 200, { all: true, commits: [...read.values()], branches: [...branches, ...stale.filter(head => read.has(head.sha)).map(({ name, sha }) => ({ name, sha }))],
      tags, defaultBranch: 'main', unread: stale.filter(head => !read.has(head.sha)), more: true })
    return
  }
  const ref = url.searchParams.get('ref') ?? ''
  const commit = /^[a-f\d]{40}$/u.test(ref) ? ref : 'a'.repeat(40)
  const path = url.searchParams.get('path') ?? ''
  const listed = reaching(commit).filter(item => !path || commits.indexOf(item) % 3 === 0)
  sendJson(res, 200, { commit, path, page, commits: listed.slice((page - 1) * 100, page * 100), more: listed.length > page * 100, ...page === 1 ? { branches, tags } : {} })
}

// The fixture repository's package-lock.json, as npm 11 writes one, for the
// code viewer's View lockfile: debug's own ms a second copy of ms.
const fixtureLockfile = `${JSON.stringify({
  name: 'managed-fixtures', version: '1.0.0', lockfileVersion: 3, requires: true,
  packages: {
    '': { name: 'managed-fixtures', version: '1.0.0', dependencies: { debug: '4.3.4' }, devDependencies: { ms: '2.0.0' } },
    'node_modules/debug': { version: '4.3.4', resolved: 'https://registry.npmjs.org/debug/-/debug-4.3.4.tgz',
      integrity: 'sha512-PRWFHuSU3eDtQJPvnNY7Jcket1j0t5OuOsFzPPzsekD52Zl8qUfFIPEiswXqIvHWGVHOgX+7G/vCNNhehwxfkQ==', license: 'MIT',
      dependencies: { ms: '2.1.2' }, engines: { node: '>=6.0' }, peerDependenciesMeta: { 'supports-color': { optional: true } } },
    'node_modules/debug/node_modules/ms': { version: '2.1.2', resolved: 'https://registry.npmjs.org/ms/-/ms-2.1.2.tgz',
      integrity: 'sha512-sGkPx+VjMtmA6MX27oA4FBFELFCZZ4S4XqeGOXCv68tT+jb3vk/RyaKWP0PTKyWtmLSM0b+adUTEvbs1PEaH2w==', license: 'MIT' },
    'node_modules/ms': { version: '2.0.0', resolved: 'https://registry.npmjs.org/ms/-/ms-2.0.0.tgz',
      integrity: 'sha512-Tpp60P6IUJDTuOq/5Z8cdskzJujfwqfOTkrwIwj7IRISpnkJnT6SyJ4PCPnGMoFjC9ddhal5KVIYtAt97ix05A==', dev: true, license: 'MIT' },
  },
}, null, 2)}\n`

function handleRepositoryBrowserFixture(url: URL, method: string, res: ServerResponse): void {
  if (method !== 'GET') { sendJson(res, 405, { error: 'method-not-allowed' }); return }
  if (url.pathname.endsWith('/browsable')) {
    sendJson(res, 200, { repos: repositories.filter(repo => repo.selected).map(repo => ({ repoId: repo.id, fullName: repo.fullName })) }); return
  }
  const repo = repoById(Number(url.searchParams.get('repoId')))
  if (!repo?.selected) { sendJson(res, 404, { error: 'no-repository' }); return }
  if (url.pathname.endsWith('/history')) { historyFixture(url, res); return }
  if (url.pathname.endsWith('/issues')) { issuesFixture(url, res); return }
  if (url.pathname.endsWith('/agents')) { agentsFixture(url, res); return }
  const refs = url.pathname.endsWith('/refs') ? { defaultBranch: 'main', branches: ['main', 'develop', 'feature/bundle-picker'], tags: ['v1.0.0', ...Array.from({ length: 20 }, (_, index) => `v0.${19 - index}.0`)] } : null
  if (refs && url.searchParams.get('withDefault') !== 'true') { sendJson(res, 200, refs); return }
  const path = refs ? '' : url.searchParams.get('path') ?? ''
  const ref = refs ? 'heads/main' : url.searchParams.get('ref') ?? 'heads/main'
  const files = repo.id === 102 ? ['src/main.rs', 'src/lib.rs', 'Cargo.toml', 'README.md']
    : ['src/index.ts', 'src/app.tsx', 'src/utils/format.js', 'src/utils/types.d.ts', 'contracts/Token.sol', 'contracts/vault/Vault.sol', 'contracts/test/Token.t.sol', 'native/src/lib.rs', 'test/index.test.ts', 'vendor/lib/huge.js', 'package.json', 'package-lock.json', 'README.md']
  if (ref === 'heads/develop' || ref === 'b'.repeat(40)) files.push('src/experimental.ts')
  const prefix = path ? path + '/' : ''
  const commit = /^[a-f\d]{40}$/iu.test(ref) ? ref : (ref === 'heads/develop' ? 'b' : 'a').repeat(40)
  // The code viewer's read of a directory: its files as `GET
  // /api/npm/package` answers a version's, a line of text each.
  if (url.pathname.endsWith('/code')) {
    // `vendor` stands for a directory too large to open.
    if (path === 'vendor') { sendJson(res, 413, { error: 'directory-too-large', commit }); return }
    const inside = files.filter(file => file.startsWith(prefix)).toSorted()
    if (inside.length === 0) { sendJson(res, 404, { error: 'no-directory' }); return }
    const rows = inside.map(file => {
      const text = file === 'README.md' ? `# ${repo.fullName}\n\nFixture repository for the managed code viewer.\n`
        : file === 'package-lock.json' ? fixtureLockfile : `// ${file} at ${commit.slice(0, 7)}\n`
      return [file.slice(prefix.length), Buffer.byteLength(text), text]
    })
    sendJson(res, 200, { repoId: repo.id, repo: repo.fullName, commit, path, tree: 'f'.repeat(40), files: rows }); return
  }
  const entries = new Map()
  for (const file of files.filter(candidate => candidate.startsWith(prefix))) {
    const rest = file.slice(prefix.length)
    const name = rest.split('/')[0]!
    entries.set(name, { name, path: prefix + name, type: rest.includes('/') ? 'dir' : 'file' })
  }
  const contents = { path, commit, entries: [...entries.values()], limited: false,
    ...(entries.has('package.json') ? { packageEntryPoints: ['src/index.ts', 'src/app.tsx', 'src/utils/format.js'] } : {}),
    ...(repo.id !== 102 && (path === '' || path === 'contracts') ? { solidityEntryPoints: ['contracts/Token.sol', ...(path === '' ? ['contracts/vault/Vault.sol'] : [])], soliditySuggestionsLimited: false } : {}),
  }
  sendJson(res, 200, refs ? { ...refs, defaultContents: contents } : contents)
}

async function connectAppFixture(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let raw = ''
  for await (const chunk of req) raw += String(chunk)
  const repo = repoById((JSON.parse(raw) as { repoId: number }).repoId)
  if (!repo?.selected) { sendJson(res, 404, { error: 'repo-not-connected' }); return }
  repo.installed = true
  sendJson(res, 200, { connected: true })
}

async function createBundleFixture(req: IncomingMessage, res: ServerResponse, method: string): Promise<void> {
  if (method !== 'POST') { sendJson(res, 405, { error: 'method-not-allowed' }); return }
  if (req.headers['x-csrf-token'] !== 'fixture-csrf-token') { sendJson(res, 403, { error: 'forbidden' }); return }
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk)
    size += bytes.length
    if (size > 128 * 1024) { sendJson(res, 413, { error: 'too-large' }); return }
    chunks.push(bytes)
  }
  try {
    const input = parseBundleBuild(JSON.parse(Buffer.concat(chunks).toString()))
    const repo = repoById(input.repoId)
    if (!repo) { sendJson(res, 404, { error: 'no-repository' }); return }
    const id = randomUUID()
    const bundle = { id, slug: id, filename: githubBundleFilename(repo.fullName, input.directory, input.commit), kind: 'stasis',
      repoDirectory: input.directory, integrity: `sha512-fixture-${id}`, byteSize: 1024, repoId: input.repoId,
      visible: true, uploadedByLogin: 'managed-preview', uploadedAt: Date.now(), provenance: 'build' }
    bundles.unshift(bundle)
    sendJson(res, 201, bundle)
  } catch (error) { sendJson(res, 400, { error: error instanceof BundleBuildError ? error.code : 'bad-body' }) }
}

// Teams' npm scopes, in memory. The fixture has no npm token: its viewer opens
// public packages alone, read from the registry as the real server reads them.
const teamNpmScopes = new Map<string, string[]>()

async function setFixtureNpmScopes(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let raw = ''
  for await (const chunk of req) raw += String(chunk)
  const body = JSON.parse(raw) as { teamId?: string; scopes?: unknown }
  if (!teamFixtures.some(team => team.id === body.teamId)) { sendJson(res, 404, { error: 'no-team' }); return }
  let scopes
  try { scopes = parseTeamNpmScopes(body.scopes) } catch (err) { sendJson(res, 400, { error: (err as Error).message }); return }
  teamNpmScopes.set(body.teamId!, scopes)
  sendJson(res, 200, { ok: true, scopes })
}

// The npm viewer's routes, and the Teams page's scope edits (admin only).
function serveNpmFixture(req: IncomingMessage, url: URL, method: string, res: ServerResponse): boolean {
  const done = (work: Promise<void>) => { work.catch(() => { if (!res.headersSent) sendJson(res, 400, { error: 'bad-request' }) }); return true }
  if (url.pathname === '/api/admin/teams/set-npm-scopes') {
    if (method !== 'POST' || role !== 'admin') { sendJson(res, method === 'POST' ? 403 : 405, { error: method === 'POST' ? 'forbidden' : 'method-not-allowed' }); return true }
    return done(setFixtureNpmScopes(req, res))
  }
  if (!['/api/npm/package', '/api/npm/versions', '/api/npm/download'].includes(url.pathname)) return false
  if (method !== 'GET') { sendJson(res, 405, { error: 'method-not-allowed' }); return true }
  return done(serveFixtureNpm(url, res))
}

async function serveFixtureNpm(url: URL, res: ServerResponse): Promise<void> {
  const name = url.searchParams.get('name') ?? '', spec = url.searchParams.get('version') ?? 'latest'
  const signal = AbortSignal.timeout(60_000)
  try {
    // With whether a team lists its scope, as the real server answers.
    if (url.pathname === '/api/npm/versions') {
      const versions = await readNpmVersions(name, false, signal, { times: true })
      const scope = npmPackageScope(name)
      const teamScoped = scope !== null && [...teamNpmScopes.values()].some(scopes => scopes.includes(scope))
      sendJson(res, versions ? 200 : 404, versions ? { ...versions, teamScoped } : { error: 'package-not-found' }); return
    }
    const doc = await readNpmVersion(name, spec, false, signal)
    if (!doc) { sendJson(res, 404, { error: 'package-not-found' }); return }
    const download = url.pathname === '/api/npm/download'
    const load = download ? loadNpmTarball(doc) : loadNpmPackageBody(doc)
    res.once('close', load.release)
    const bytes = await load.result
    res.writeHead(200, { ...download ? { 'content-type': 'application/gzip' } : { 'content-type': 'application/json', 'content-encoding': 'br' }, 'cache-control': 'no-store' })
    res.end(bytes)
  } catch (err) {
    sendJson(res, err instanceof NpmPackageError ? err.status : 502, { error: err instanceof NpmPackageError ? err.message : 'upstream-unavailable' })
  }
}

async function setFixtureVisible(req: IncomingMessage, res: ServerResponse, bundle: boolean): Promise<void> {
  let raw = ''
  for await (const chunk of req) raw += String(chunk)
  const body = JSON.parse(raw) as { bundleId?: string; reportId?: string; visible?: boolean }
  const item = bundle ? bundles.find(candidate => candidate.id === body.bundleId) : reportMetadata.find(candidate => candidate.id === body.reportId)
  if (!item || typeof body.visible !== 'boolean') { sendJson(res, 400, { error: 'bad-request' }); return }
  item.visible = body.visible
  for (const client of fixtureFeeds) client.write(`event: teams\ndata: ${JSON.stringify({ revision: teamCatalogRevision(currentTeams()) })}\n\n`)
  sendJson(res, 200, { ok: true, visible: body.visible })
}

// The report location editor's suggestion: the selected fixture repository
// named by the report's findings, as the managed server resolves it.
function serveReportLocation(url: URL, res: ServerResponse): boolean {
  const match = /^\/api\/admin\/reports\/([^/]+)\/location$/u.exec(url.pathname)
  if (!match) return false
  const report = reportFixtures.find(candidate => candidate.id === decodeURIComponent(match[1]!))
  if (report == null) { sendJson(res, 404, { error: 'not-found' }); return true }
  const data = readManagedReport(report.content, report.filename).data
  const github = report.repoEmbedded ? null : findingsRepository(data)
  const repo = github == null ? null : repositories.find(candidate => candidate.selected && candidate.fullName.toLowerCase() === github.toLowerCase())
  sendJson(res, 200, { location: github == null ? null : { repoId: repo?.id ?? null, github: repo?.fullName ?? github, directory: null } })
  return true
}

type RiskFixtureLine = { type: string; id?: number; repo?: number; name?: string; packages?: ({ name: string } & Record<string, unknown>)[] } & Record<string, unknown>

// A scan of the connected repositories' npm lockfiles (repository-risk.ts),
// or a team's (`team`) or one's (`repo`), its lines a little apart as the
// server's come, and stopped with its reader.
function serveRiskFixture(url: URL, method: string, res: ServerResponse): boolean {
  if (url.pathname !== '/api/admin/repositories/risk' || method !== 'GET') return false
  const selected = repositories.filter(repo => repo.selected)
  const repoId = url.searchParams.get('repo'), teamId = url.searchParams.get('team')
  if (repoId !== null && teamId !== null) { sendJson(res, 400, { error: 'bad-scope' }); return true }
  const team = teamId === null ? null : adminTeams().find(item => item.id === teamId) ?? null
  const scanned = new Set(selected.filter(repo => repoId === null ? !team || team.repos.some(link => link.repoId === repo.id) : String(repo.id) === repoId).map(repo => repo.id))
  if ((teamId !== null && !team) || (repoId !== null && scanned.size === 0)) { sendJson(res, 404, { error: 'no-repository' }); return true }
  const [first, second, ...rest] = selected
  const commit = 'f'.repeat(40)
  const chalk = { name: 'chalk', version: '5.3.0', integrity: 'sha512-fixture' }
  const advisory = (name: string, id: string, title: string, severity: string, cwe: string[], range: string, versions: string[]) => ({
    ecosystem: 'npm', name, source: 'registry', id, ghsa: id, url: `https://github.com/advisories/${id}`, aliases: [], title, severity, cwe, range, versions,
    malware: cwe.includes('CWE-506'),
  })
  const risk = (name: string, version: string, findings: [string, string][]) => ({ type: 'risk', name, version, published: '2024-05-01T00:00:00.000Z',
    severity: findings[0]?.[1] ?? null, findings: findings.map(([id, severity]) => ({ id, severity })) })
  const lines: RiskFixtureLine[] = [
    { type: 'repos', repos: selected.filter(repo => scanned.has(repo.id)).map(repo => ({ id: repo.id, fullName: repo.fullName })) },
    { type: 'repo', id: first!.id, commit, lockfiles: [{ path: 'package-lock.json', format: 'npm' }, { path: 'docs/bun.lock', format: 'bun' }] },
    { type: 'lockfile', repo: first!.id, path: 'package-lock.json', format: 'npm', packages: [
      // left-pad and minimist 0.0.8 only devDependencies need; lodash too, but
      // the second repository's lockfile needs it otherwise.
      { name: 'left-pad', version: '1.3.0', source: 'registry', dev: true }, { name: 'lodash', version: '4.17.21', source: 'registry', dev: true },
      { name: 'event-stream', version: '3.3.6', source: 'registry' }, { name: 'minimist', version: '0.0.8', source: 'registry', dev: true },
      { name: 'minimist', version: '1.2.5', source: 'registry' }, { name: 'internal-utils', version: '1.0.0', source: 'git', from: 'git+ssh://github.com/example/internal-utils.git' },
    ] },
    { type: 'lockfile', repo: first!.id, path: 'docs/bun.lock', format: 'bun', error: 'unsupported-format' },
    { type: 'advisories', repo: first!.id, path: 'package-lock.json', advisories: [
      advisory('event-stream', 'GHSA-mh6f-8j2x-4483', 'Critical severity vulnerability that affects event-stream and flatmap-stream', 'critical', ['CWE-506'], '=3.3.6', ['3.3.6']),
      advisory('lodash', 'GHSA-35jh-r3h4-6jhm', 'Command Injection in lodash', 'high', ['CWE-77', 'CWE-94'], '<4.17.21', []),
      // npm answers an advisory once a range it covers.
      advisory('minimist', 'GHSA-xvch-5gv4-984h', 'Prototype Pollution in minimist', 'critical', ['CWE-1321'], '<0.2.4', ['0.0.8']),
      advisory('minimist', 'GHSA-xvch-5gv4-984h', 'Prototype Pollution in minimist', 'critical', ['CWE-1321'], '>=1.0.0 <1.2.6', ['1.2.5']),
    ].filter(row => row.versions.length > 0) },
    risk('minimist', '0.0.8', []),
    { type: 'risk', name: 'minimist', version: '1.2.5', error: 'upstream-unavailable', detail: 'npm couldn\'t be asked for minimist\'s downloads: The operation was aborted due to timeout' },
    risk('left-pad', '1.3.0', [['deprecated', 'critical'], ['popularity', 'high']]),
    { type: 'repo', id: second!.id, commit, lockfiles: [{ path: 'pnpm-lock.yaml', format: 'pnpm' }] },
    { type: 'lockfile', repo: second!.id, path: 'pnpm-lock.yaml', format: 'pnpm', packages: [
      { name: 'lodash', version: '4.17.21', source: 'registry' }, { ...chalk, source: 'mirror', from: 'https://npm.example.com/api/npm/remote/chalk/-/chalk-5.3.0.tgz' },
    ] },
    risk('lodash', '4.17.21', []),
    { type: 'advisories', repo: second!.id, path: 'pnpm-lock.yaml', advisories: [
      advisory('lodash', 'GHSA-xxjr-mmjv-4gpg', 'Lodash has Prototype Pollution Vulnerability in `_.unset` and `_.omit`', 'moderate', ['CWE-1321'], '>=4.0.0 <=4.17.22', ['4.17.21']),
    ] },
    risk('event-stream', '3.3.6', [['held-runs-code', 'high'], ['held-obfuscated', 'high']]),
    ...rest.map(repo => ({ type: 'repo', id: repo.id, error: 'no-repository' })),
    { type: 'risk', ...chalk, error: 'integrity-mismatch' },
    { type: 'done' },
  ]
  // Those of the repositories scanned, and of the packages their lockfiles lock.
  const names = new Set(lines.flatMap(line => line.type === 'lockfile' && scanned.has(line.repo!) ? (line.packages ?? []).map(pkg => pkg.name) : []))
  const told = lines.filter(line => line.type === 'repo' ? scanned.has(line.id!) : ['lockfile', 'advisories'].includes(line.type) ? scanned.has(line.repo!)
    : line.type !== 'risk' || names.has(line.name!))
  res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' })
  let at = 0
  const timer = setInterval(() => {
    if (at < told.length) res.write(`${JSON.stringify(told[at++])}\n`)
    else { clearInterval(timer); res.end() }
  }, 400)
  res.on('close', () => { clearInterval(timer) })
  return true
}

async function handleAdmin(req: IncomingMessage, url: URL, method: string, res: ServerResponse): Promise<void> {
  const repositoryBrowser = /^\/api\/admin\/repositories\/(?:browsable|refs|contents|code|history|issues|agents)$/u.test(url.pathname)
  const adminOnly = !repositoryBrowser && /^\/api\/admin\/(?:users|set-role|repositories|teams)(?:\/|$)/u.test(url.pathname)
  if (!['admin', 'manage'].includes(role) || (adminOnly && role !== 'admin')) {
    sendJson(res, 403, { error: 'forbidden' }); return
  }
  if (handleAdminCatalog(url, method, res)) return
  if (repositoryBrowser) { handleRepositoryBrowserFixture(url, method, res); return }
  if (url.pathname === '/api/admin/bundles/create') { await createBundleFixture(req, res, method); return }
  if (url.pathname === '/api/admin/repositories/connect-app' && method === 'POST') { await connectAppFixture(req, res); return }
  if (['/api/admin/reports/set-visible', '/api/admin/bundles/set-visible'].includes(url.pathname) && method === 'POST') {
    await setFixtureVisible(req, res, url.pathname.includes('/bundles/'))
    return
  }
  if (serveReportLocation(url, res) || serveRiskFixture(url, method, res)) return
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
    const filtered = repositories
      .filter((repo) => scope === 'connected'
        ? repo.selected
        : scope === 'installed' ? repo.installed : (!repo.private && !repo.installed))
      .toSorted((a, b) => a.fullName.localeCompare(b.fullName))
    sendJson(res, 200, {
      repositories: filtered,
      connectedCount: repositories.filter((repo) => repo.selected).length,
      total: filtered.length,
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
      teams: adminTeams().map(team => ({ ...team, npmScopes: teamNpmScopes.get(team.id) ?? [] })),
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
  const ids = new Set((readManagedReport(report.content, report.filename).data.findings as { id: string }[]).map(finding => finding.id))
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
  const allowed = req.method === 'DELETE' ? canDeleteComment(comment, { id: 'fixture-user', role }) : comment.authorId === 'fixture-user'
  if (!allowed) { sendJson(res, 403, { error: 'not-comment-author' }); return }
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
  const ids = new Set<string>(readManagedReport(fixture.content, fixture.filename).data.findings.map((finding: { id: string }) => finding.id))
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

async function handleReportQuery(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const chunks = []
  for await (const chunk of req) chunks.push(Buffer.from(chunk))
  const { ids } = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string')) { sendJson(res, 400, { error: 'bad-ids' }); return }
  const selected = [...new Set(ids)].map(id => reportFixtures.find(report => report.id === id))
  if (selected.some(report => !report)) { sendJson(res, 404, { error: 'no-report' }); return }
  sendJson(res, 200, { reports: selected.map(report => ({ id: report!.id, data: readManagedReport(report!.content, report!.filename).data,
    repo: { github: repoById(report!.repoId)?.fullName ?? null, directory: report!.repoDirectory } })) })
}

function serveTeamReports(url: URL, res: ServerResponse): boolean {
  const match = /^\/api\/teams\/([^/]+)\/(reports|annotations)$/u.exec(url.pathname)
  if (!match) return false
  const team = currentTeams().find(entry => entry.id === match[1])
  if (!team) { sendJson(res, 404, { error: 'no-team' }); return true }
  const reportId = url.searchParams.get('reportId')
  if (reportId !== null && !team.reports.some(report => report.id === reportId)) { sendJson(res, 404, { error: 'no-report' }); return true }
  const hidden = team.reports.find(report => report.id === reportId && !report.visible)
  const selected = hidden ? [hidden] : team.reports.filter(report => report.visible)
  if (match[2] === 'annotations') {
    const byReport = new Map(selected.filter(report => reportId === null || report.id === reportId).map(entry => {
      const report = reportFixtures.find(item => item.id === entry.id)!
      const data = readManagedReport(report.content, report.filename).data
      const ids = (reportEntries(data) ?? []).flat().map(finding => (finding as { id: string }).id).filter(id => typeof id === 'string')
      return [entry.id, ids] as const
    }))
    const ids = new Set([...byReport.values()].flat())
    sendJson(res, 200, { reports: Object.fromEntries(byReport), entries: Object.fromEntries([...triage].filter(([id]) => ids.has(id))), comments: comments.filter(comment => ids.has(comment.findingId)) })
    return true
  }
  sendJson(res, 200, { reports: selected.map(entry => {
    const report = reportFixtures.find(item => item.id === entry.id)!
    return { id: report.id, filename: report.filename, data: readManagedReport(report.content, report.filename).data,
      repo: { github: repoById(report.repoId)?.fullName ?? null, directory: report.repoDirectory } }
  }) })
  return true
}

const fixtureFeeds = new Set<ServerResponse>()

// Keep the fixture feed open and publish catalog changes after visibility edits.
function serveFixtureFeed(path: string, res: ServerResponse): boolean {
  if (!/^\/api\/teams(?:\/[^/]+)?\/feed$/u.test(path)) return false
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
  fixtureFeeds.add(res)
  res.write(': fixture\n\n')
  const heartbeat = setInterval(() => { res.write(': fixture\n\n') }, 20_000)
  heartbeat.unref()
  res.on('close', () => { clearInterval(heartbeat); fixtureFeeds.delete(res) })
  return true
}

function handle(req: IncomingMessage, res: ServerResponse): void {
  const method = req.method ?? 'GET', url = new URL(req.url ?? '/', `http://${host}`)

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
    const teams = currentTeams()
    sendJson(res, 200, { teams, revision: teamCatalogRevision(teams) }); return
  }
  if (serveFixtureFeed(url.pathname, res) || serveTeamReports(url, res) || serveNpmFixture(req, url, method, res)) return
  if (url.pathname === '/api/reports/query') {
    if (method !== 'POST') { sendJson(res, 405, { error: 'method-not-allowed' }); return }
    void handleReportQuery(req, res).catch(() => { if (!res.headersSent) sendJson(res, 400, { error: 'bad-body' }) })
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
        data: readManagedReport(report.content, report.filename).data,
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
  // fixture. App connections only update the in-memory fixture repository.
  if (url.pathname.startsWith('/api/admin/')) { void handleAdmin(req, url, method, res).catch(() => sendJson(res, 400, { error: 'bad-request' })); return }
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
