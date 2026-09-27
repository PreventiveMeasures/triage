import type { IncomingMessage, ServerResponse } from 'node:http'
import { pipeline } from 'node:stream/promises'
import { Buffer } from 'node:buffer'
import type { ManagedHttpDeps } from './http.ts'
import type { ManagedBundle } from './db.ts'
import type { OpenedBlob } from './blob-store.ts'
import type { WorkspaceShareSnapshot } from './workspace-shares.ts'
import { sendJson } from './http-response.ts'
import { hashToken } from './crypto.ts'
import { TeamReportsError, loadTeamReports, teamReportVisibility } from './team-reports.ts'
import { MAX_FINDING_ID, MAX_TRIAGE_HISTORY } from '../common/managed/triage.ts'
import { triageWireEntry } from './triage-response.ts'
import { MAX_PACKAGE_INVENTORY_BYTES } from './bundle-cache.ts'
import { NPM_ADVISORIES_TIMEOUT_MS, fetchNpmAdvisories } from '../server-common/npm-advisories.ts'
import { serveTeamFeed } from './team-feed.ts'

function json(res: ServerResponse, status: number, body: unknown): void {
  sendJson(res, status, body, { 'cache-control': 'private, no-store', 'referrer-policy': 'no-referrer' })
}

// Called before ALL other routing, including OAuth, discovery, static and the
// combined server fallback. A supplied capability never inherits cookie auth.
export async function handlePublicWorkspace(req: IncomingMessage, res: ServerResponse, deps: ManagedHttpDeps, url: URL): Promise<void> {
  const token = req.headers['x-deepview-share']
  if (!deps.config.allowShare || typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(token)) {
    json(res, 401, { error: 'invalid-share' }); return
  }
  const method = req.method ?? 'GET'
  if (method !== 'GET' && method !== 'HEAD') { json(res, 403, { error: 'share-read-only' }); return }
  const teamRoute = /^\/api\/teams\/([^/]+)\/(shared|reports|feed)$/u.exec(url.pathname)
  const reportRoute = /^\/api\/reports\/([^/]+)\/(triage|triage\/history|comments|sources)$/u.exec(url.pathname)
  const bundleRoute = /^\/api\/bundles\/([^/]+)\/(metadata|contents|download|advisories)$/u.exec(url.pathname)
  if (!teamRoute && !reportRoute && !bundleRoute) { json(res, 403, { error: 'share-scope-required' }); return }
  const tokenHash = hashToken(token)
  const snapshot = await deps.db.getWorkspaceShare(tokenHash)
  if (!snapshot) { json(res, 401, { error: 'invalid-share' }); return }
  const recheck = async () => {
    const current = deps.config.allowShare && await deps.db.getWorkspaceShare(tokenHash)
    if (!current || JSON.stringify(current) !== JSON.stringify(snapshot)) throw new TeamReportsError(404, 'workspace-changed')
  }
  const send = async (body: unknown) => { await recheck(); json(res, 200, body) }
  const stream = async (stored: OpenedBlob, encoding: string | null, contentType = 'application/json') => {
    try { await recheck() } catch (error) { stored.stream.destroy(); throw error }
    res.writeHead(200, { 'content-type': contentType, 'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff', ...(encoding ? { 'content-encoding': encoding } : {}),
      ...(stored.size == null ? {} : { 'content-length': String(stored.size) }),
    })
    if (method === 'HEAD') { stored.stream.destroy(); res.end(); return }
    try { await pipeline(stored.stream, res) } catch { res.destroy() }
  }
  if (url.searchParams.has('team') && (url.searchParams.getAll('team').length !== 1 || url.searchParams.get('team') !== snapshot.teamId)) {
    json(res, 404, { error: 'no-team' }); return
  }
  if (teamRoute) {
    if (teamRoute[1] !== snapshot.teamId) { json(res, 404, { error: 'no-team' }); return }
    if (teamRoute[2] === 'feed') {
      if (method !== 'GET') { json(res, 405, { error: 'method-not-allowed' }); return }
      await serveTeamFeed(res, deps, snapshot, recheck); return
    }
    if (teamRoute[2] === 'shared') { await send({ user: snapshot.user, team: snapshot.team }); return }
    await send({ reports: await loadTeamReports(deps.db, deps.reportStore, snapshot) }); return
  }
  if (reportRoute) {
    const id = reportRoute[1]!, part = reportRoute[2]!
    if (!snapshot.reports.some(report => report.id === id)) { json(res, 404, { error: 'no-report' }); return }
    const visible = await teamReportVisibility(deps.db, deps.reportStore, snapshot, id)
    await recheck()
    if (part === 'sources') { await sources(res, deps, snapshot, id, visible.sourcePaths, recheck, stream); return }
    if (part === 'comments') { await send({ comments: await deps.db.listComments([...visible.ids]) }); return }
    if (part === 'triage/history') {
      const finding = url.searchParams.get('finding') ?? ''
      if (!finding || finding.length > MAX_FINDING_ID) { json(res, 400, { error: 'bad-request' }); return }
      if (!visible.ids.has(finding)) { json(res, 404, { error: 'no-finding' }); return }
      const events = (await deps.db.listTriageHistory(finding, MAX_TRIAGE_HISTORY)).map(row => ({
        seq: row.seq, at: row.at, actorLogin: row.actorLogin, batchId: row.batchId, entry: triageWireEntry(row, true),
      }))
      await send({ finding, events }); return
    }
    const entries = Object.fromEntries((await deps.db.listTriage([...visible.ids])).map(row => [row.findingId, triageWireEntry(row)]))
    await send({ entries }); return
  }
  const bundle = snapshot.bundles.find(item => item.id === bundleRoute![1])
  if (!bundle) { json(res, 404, { error: 'no-bundle' }); return }
  await serveBundle(res, deps, bundle, bundleRoute![2]!, url, recheck, stream)
}

async function serveBundle(res: ServerResponse, deps: ManagedHttpDeps, bundle: ManagedBundle, part: string, url: URL,
  recheck: () => Promise<void>, stream: (stored: OpenedBlob, encoding: string | null, contentType?: string) => Promise<void>) {
  if (part === 'download') {
    const stored = await deps.bundleStore.open(bundle.id, bundle.kind)
    if (!stored) { json(res, 503, { error: 'unavailable' }); return }
    await stream(stored, bundle.kind === 'sourcemap' ? 'br' : null, 'application/octet-stream'); return
  }
  if (!deps.bundleCache) { json(res, 503, { error: 'unavailable' }); return }
  if (part === 'advisories') {
    if (bundle.kind !== 'stasis') { json(res, 422, { error: 'unsupported-bundle' }); return }
    const packages = await deps.bundleCache.packageVersions(bundle, url.searchParams.get('reason') ?? '')
    await recheck()
    if (packages === null) { json(res, 413, { error: 'payload-too-large' }); return }
    if (packages === undefined) { json(res, 400, { error: 'unknown-reason' }); return }
    const body = Buffer.from(JSON.stringify(packages))
    if (body.length > MAX_PACKAGE_INVENTORY_BYTES) { json(res, 413, { error: 'payload-too-large' }); return }
    const result = Object.keys(packages).length === 0 ? { status: 200, body: {} }
      : await fetchNpmAdvisories(body, AbortSignal.timeout(NPM_ADVISORIES_TIMEOUT_MS), deps.config.debug)
    await recheck()
    json(res, result.status, result.status === 200 ? { packages, advisories: result.body } : result.body); return
  }
  let cached
  try { cached = await deps.bundleCache.open(bundle, part as 'metadata' | 'contents') }
  catch { json(res, 422, { error: 'bundle-unavailable' }); return }
  await stream(cached, 'br')
}

async function sources(res: ServerResponse, deps: ManagedHttpDeps, snapshot: WorkspaceShareSnapshot,
  id: string, paths: Set<string>, recheck: () => Promise<void>, stream: (stored: OpenedBlob, encoding: string | null) => Promise<void>) {
  const report = await deps.db.getReport(id)
  const bundle = report?.bundleId ? await deps.db.getBundle(report.bundleId) : null
  const empty = async () => { await recheck(); res.writeHead(204, { 'cache-control': 'private, no-store' }); res.end() }
  if (!report || !bundle || !['stasis', 'sourcemap'].includes(bundle.kind ?? '') || bundle.repoId !== report.repoId) { await empty(); return }
  if (!deps.reportSourcesCache) { json(res, 503, { error: 'unavailable' }); return }
  let cached
  try { cached = await deps.reportSourcesCache.open(report, bundle, { dependencies: true, security: true }, paths) }
  catch { await empty(); return }
  if (!cached) { await empty(); return }
  const current = await deps.db.getReport(id), currentBundle = await deps.db.getBundle(bundle.id)
  if (JSON.stringify(current) !== JSON.stringify(report) || JSON.stringify(currentBundle) !== JSON.stringify(bundle)
      || snapshot.reports.find(item => item.id === id)?.repo.github !== cached.repo.github) {
    cached.stream.destroy(); throw new TeamReportsError(404, 'workspace-changed')
  }
  await stream(cached, 'gzip')
}
