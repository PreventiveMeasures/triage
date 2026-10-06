// Team content is filtered as one workspace, with separate report envelopes.
// Bounded snapshots retain filtered content and visibility for repeated reads.
import { Buffer } from 'node:buffer'
import { backfillFindingIds, reportEntries, stampSecurityGroups } from '@preventive/report'
import { managedFindingSourcePaths, readManagedReport } from '../common/managed/report-content.ts'
import { filterReportData, projectFinding } from '../common/managed/report-filter.ts'
import type { BlobStore } from './blob-store.ts'
import type { ManagedDb, TeamReportAccessSnapshot } from './db.ts'
import { triageWireEntry } from './triage-response.ts'
import { MAX_REPORT_QUERY_BYTES, MAX_REPORT_QUERY_COUNT } from './report-query.ts'

type Finding = Record<string, unknown>
type TeamReport = { id: string; filename: string; data: unknown; repo: { github: string | null; directory: string } }
type ReportVisibility = { ids: Set<string>; sourcePaths: Set<string> }
type Visibility = Map<string, ReportVisibility>
const VISIBILITY_CACHE_MAX_ITEMS = 250_000
const VISIBILITY_CACHE_MAX_SNAPSHOTS = 32
const caches = new WeakMap<ManagedDb, Map<string, Visibility>>()
const REPORT_CACHE_BYTES = 16 * 1024 * 1024
const reportCaches = new WeakMap<ManagedDb, Map<string, Buffer>>()
function retainReports(db: ManagedDb, key: string, bytes: Buffer) {
  if (bytes.length > REPORT_CACHE_BYTES) return
  let cache = reportCaches.get(db)
  if (!cache) { cache = new Map(); reportCaches.set(db, cache) }
  cache.delete(key)
  let total = bytes.length + [...cache.values()].reduce((sum, value) => sum + value.length, 0)
  for (const [oldest, value] of cache) {
    if (total <= REPORT_CACHE_BYTES && cache.size < VISIBILITY_CACHE_MAX_SNAPSHOTS) break
    cache.delete(oldest); total -= value.length
  }
  cache.set(key, bytes)
}
function visibilityWeight(visible: Visibility): number {
  return [...visible.values()].reduce((sum, v) => sum + v.ids.size + v.sourcePaths.size, 0)
}
function retainVisibility(db: ManagedDb, key: string, visible: Visibility): void {
  let cache = caches.get(db)
  // Replacement contributes its weight once and does not evict a peer merely
  // because the cache already holds the maximum number of snapshots.
  cache?.delete(key)
  const incoming = visibilityWeight(visible)
  if (incoming > VISIBILITY_CACHE_MAX_ITEMS) return
  if (!cache) { cache = new Map(); caches.set(db, cache) }
  let total = incoming + [...cache.values()].reduce((sum, entry) => sum + visibilityWeight(entry), 0)
  for (const [oldest, entry] of cache) {
    if (cache.size < VISIBILITY_CACHE_MAX_SNAPSHOTS && total <= VISIBILITY_CACHE_MAX_ITEMS) break
    cache.delete(oldest)
    total -= visibilityWeight(entry)
  }
  cache.set(key, visible)
}
export class TeamReportsError extends Error {
  status: number
  constructor(status: number, error: string) { super(error); this.status = status }
}
export function teamSnapshotKey(snapshot: TeamReportAccessSnapshot): string {
  return JSON.stringify([snapshot.user.id, snapshot.user.role, snapshot.teamId, snapshot.reports, snapshot.repositories])
}
export async function teamSnapshot(db: ManagedDb, sessionId: string, teamId: string, reportId: string | null = null): Promise<TeamReportAccessSnapshot> {
  const snapshot = await db.getTeamReportAccessSnapshot(sessionId, Date.now(), teamId, reportId)
  if (!snapshot) throw new TeamReportsError(401, 'unauthenticated')
  if (!snapshot.teamId) throw new TeamReportsError(404, 'no-team')
  if (reportId !== null && !snapshot.reports.some(report => report.id === reportId)) throw new TeamReportsError(404, 'no-report')
  return snapshot
}
export async function recheckTeam(db: ManagedDb, sessionId: string, snapshot: TeamReportAccessSnapshot): Promise<void> {
  if (teamSnapshotKey(await teamSnapshot(db, sessionId, snapshot.teamId!, snapshot.reportId)) !== teamSnapshotKey(snapshot)) throw new TeamReportsError(404, 'workspace-changed')
}
function groupsOf(data: unknown): Finding[][] {
  return (reportEntries(data) ?? []).map(entry => (Array.isArray(entry) ? entry : [entry]).filter(
    (finding): finding is Finding => finding !== null && typeof finding === 'object' && !Array.isArray(finding),
  ))
}
function linksOf(data: unknown): string[][] | null {
  const record = data as { source?: string; links?: string[][] }
  if (record?.source !== 'links' || !Array.isArray(record.links)) return null
  if (!record.links.every(ids => Array.isArray(ids) && ids.every(id => typeof id === 'string'))) throw new TeamReportsError(422, 'unreadable-links')
  return record.links
}
async function buildTeamWorkspace(db: ManagedDb, store: BlobStore, snapshot: TeamReportAccessSnapshot): Promise<{ body: Buffer; visible: Visibility }> {
  if (snapshot.reports.length > MAX_REPORT_QUERY_COUNT || snapshot.reports.reduce((n, r) => n + r.byteSize, 0) > MAX_REPORT_QUERY_BYTES) throw new TeamReportsError(413, 'batch-too-large')
  const reports: TeamReport[] = []
  let inputBytes = 0, next = 0
  // Bound both remote reads and raw buffers, retaining stable report order for
  // the cross-report classification that follows. Finish workers on failure.
  const results = await Promise.allSettled(Array.from({ length: Math.min(4, snapshot.reports.length) }, async () => {
    while (next < snapshot.reports.length) {
      const index = next++
      const access = snapshot.reports[index]!

      const bytes = await store.get(access.id)
      if (!bytes) throw new TeamReportsError(503, 'unavailable')
      inputBytes += bytes.length
      if (inputBytes > MAX_REPORT_QUERY_BYTES) throw new TeamReportsError(413, 'batch-too-large')
      const parsed = readManagedReport(bytes.toString('utf8'), access.filename)
      if (!parsed.data) throw new TeamReportsError(422, 'unreadable-report')
      // Backfill before filtering so links, annotations and the client agree on
      // IDs even when hiding a component would change the original row shape.
      await backfillFindingIds(groupsOf(parsed.data).flat())
      reports[index] = { id: access.id, filename: access.filename, data: parsed.data, repo: access.repo }
    }
  }))
  for (const result of results) if (result.status === 'rejected') throw result.reason
  const edges = new Map<string, Set<string>>()
  const connect = (a: string, b: string) => {
    if (!edges.has(a)) edges.set(a, new Set())
    edges.get(a)!.add(b)
  }
  // A star is enough for transitive security propagation, without a quadratic
  // expansion for large links. Unknown IDs can connect known findings.
  for (const report of reports) {
    for (const ids of linksOf(report.data) ?? []) {
      for (const id of ids.slice(1)) { connect(ids[0]!, id); connect(id, ids[0]!) }
    }
  }
  const groups = reports.flatMap(report => groupsOf(report.data).map(group => group.map(f => projectFinding(f, report.data as Finding)!)))
  stampSecurityGroups(groups, { linkedIds: id => edges.get(id) ?? [] })
  const securityIds = new Set(groups.flat().filter(f => f['isSecurity'] === true).map(f => String(f['id'])))
  const allIds = new Set<string>(), visible: Visibility = new Map()
  for (let i = 0; i < reports.length; i++) {
    const access = snapshot.reports[i]!, report = reports[i]!
    report.data = filterReportData(report.data, access.permissions, access.repo, securityIds)
    const ids = new Set<string>()
    for (const finding of groupsOf(report.data).flat()) {
      // Preserve linked security classification for the UI lens, including a
      // linked component that a dependency permission will hide from the UI.
      finding['isSecurity'] = securityIds.has(String(finding['id']))
      if (typeof finding['id'] === 'string') { ids.add(finding['id']); allIds.add(finding['id']) }
    }
    visible.set(report.id, { ids, sourcePaths: managedFindingSourcePaths(groupsOf(report.data).flat()) })
  }
  for (const report of reports) {
    const links = linksOf(report.data)
    if (links) report.data = { source: 'links', findings: [], links: links.map(ids => [...new Set(ids.filter(id => allIds.has(id)))]).filter(ids => ids.length >= 2) }
  }
  let outputBytes = 14
  const parts = [Buffer.from('{"reports":[')]
  for (const [index, report] of reports.entries()) {
    const bytes = Buffer.from(JSON.stringify(report))
    outputBytes += bytes.length + 1
    if (outputBytes > MAX_REPORT_QUERY_BYTES) throw new TeamReportsError(413, 'batch-too-large')
    if (index) parts.push(Buffer.from(','))
    parts.push(bytes)
  }
  parts.push(Buffer.from(']}'))
  const body = Buffer.concat(parts)
  retainVisibility(db, teamSnapshotKey(snapshot), visible)
  retainReports(db, teamSnapshotKey(snapshot), body)
  return { body, visible }
}
const pendingWorkspaces = new WeakMap<ManagedDb, Map<string, ReturnType<typeof buildTeamWorkspace>>>()
async function loadTeamWorkspace(db: ManagedDb, store: BlobStore, snapshot: TeamReportAccessSnapshot) {
  let pending = pendingWorkspaces.get(db)
  if (!pending) { pending = new Map(); pendingWorkspaces.set(db, pending) }
  const key = teamSnapshotKey(snapshot)
  const existing = pending.get(key)
  if (existing) return existing
  const job = buildTeamWorkspace(db, store, snapshot)
  pending.set(key, job)
  try { return await job } finally { pending.delete(key) }
}
// Treat the encoded body as immutable and recheck access before sending it.
// Warm HTTP reads need neither a parsed copy nor another serialization pass.
export async function loadTeamReportsResponse(db: ManagedDb, store: BlobStore, snapshot: TeamReportAccessSnapshot): Promise<Buffer> {
  const cached = reportCaches.get(db)?.get(teamSnapshotKey(snapshot))
  return cached ?? (await loadTeamWorkspace(db, store, snapshot)).body
}
export async function loadTeamReports(db: ManagedDb, store: BlobStore, snapshot: TeamReportAccessSnapshot): Promise<TeamReport[]> {
  // Object consumers get their own copy, including when sharing a cold load.
  const body = await loadTeamReportsResponse(db, store, snapshot)
  return (JSON.parse(body.toString('utf8')) as { reports: TeamReport[] }).reports
}
async function teamVisibility(db: ManagedDb, store: BlobStore, snapshot: TeamReportAccessSnapshot): Promise<Visibility> {
  const key = teamSnapshotKey(snapshot)
  let visible = caches.get(db)?.get(key)
  if (!visible) {
    // A large snapshot may deliberately remain uncached, or be evicted by
    // another request. Authorization uses this load's result in either case.
    visible = (await loadTeamWorkspace(db, store, snapshot)).visible
  }
  return visible
}
export async function teamWorkspaceFindingIds(db: ManagedDb, store: BlobStore, snapshot: TeamReportAccessSnapshot): Promise<Set<string>> {
  const ids = new Set<string>()
  for (const report of (await teamVisibility(db, store, snapshot)).values()) for (const id of report.ids) ids.add(id)
  return ids
}
export async function teamReportVisibility(db: ManagedDb, store: BlobStore, snapshot: TeamReportAccessSnapshot, reportId: string): Promise<ReportVisibility> {
  if (!snapshot.reports.some(r => r.id === reportId)) throw new TeamReportsError(404, 'no-report')
  const visible = await teamVisibility(db, store, snapshot)
  return visible.get(reportId)!
}
export async function teamFindingIds(db: ManagedDb, store: BlobStore, sessionId: string, teamId: string, reportId: string): Promise<Set<string>> {
  const snapshot = await teamSnapshot(db, sessionId, teamId, reportId)
  const visible = await teamReportVisibility(db, store, snapshot, reportId)
  await recheckTeam(db, sessionId, snapshot)
  return visible.ids
}
export async function teamSourcePaths(db: ManagedDb, store: BlobStore, sessionId: string, teamId: string, reportId: string): Promise<Set<string>> {
  const snapshot = await teamSnapshot(db, sessionId, teamId, reportId)
  const visible = await teamReportVisibility(db, store, snapshot, reportId)
  await recheckTeam(db, sessionId, snapshot)
  return visible.sourcePaths
}

// Serialize shared annotation bodies once. Reports carry only the annotated
// finding IDs visible in that report; callers revalidate access before sending.
export async function loadTeamAnnotations(db: ManagedDb, store: BlobStore, snapshot: TeamReportAccessSnapshot, reportId: string | null = null) {
  // Restrict annotation reads only after classifying the complete workspace:
  // links and findings in other reports can affect this report's visibility.
  const visible = reportId === null ? await teamVisibility(db, store, snapshot)
    : new Map([[reportId, await teamReportVisibility(db, store, snapshot, reportId)]])
  const ids = new Set<string>()
  for (const report of visible.values()) for (const id of report.ids) ids.add(id)
  const { triage, comments } = await db.getAnnotations([...ids])
  const entries = Object.fromEntries(triage.map(row => [row.findingId, triageWireEntry(row)]))
  const annotated = new Set([...triage.map(row => row.findingId), ...comments.map(comment => comment.findingId)])
  const reports = Object.fromEntries([...visible].map(([id, report]) => [id, [...report.ids].filter(finding => annotated.has(finding))]))
  return { reports, entries, comments }
}
