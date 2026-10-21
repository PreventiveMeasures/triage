// Team content is filtered as one workspace, with separate report envelopes.
// Bounded snapshots retain filtered content and visibility for repeated reads.
import { mergeLinkGroups } from './link-reports.ts'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { backfillFindingIds, reportEntries, stampSecurityGroups } from '@preventive/report'
import { managedFindingSourcePaths, readManagedReport } from '../common/managed/report-content.ts'
import { filterReportData, projectFinding } from '../common/managed/report-filter.ts'
import { revalidationLinks, securityLinks } from '../common/security-links.js'
import { treeDependencyDirectory } from '../client/dependency-paths.js'
import { liteWorkspace } from '../common/managed/finding-detail.js'
import { managedTeamView } from '../common/managed/team-app.js'
import { expandFindingValues, findingValueIndex } from '../common/managed/finding-values.js'
import type { BlobStore } from './blob-store.ts'
import type { ManagedDb, TeamReportAccessSnapshot } from './db.ts'
import type { TeamWorkspaceSummary } from './team-app.ts'
import { triageWireEntry } from './triage-response.ts'
import { visibleManagedIssues } from './managed-issues.ts'
import { MAX_REPORT_QUERY_BYTES, MAX_REPORT_QUERY_COUNT } from './report-query.ts'

type Finding = Record<string, unknown>
type TeamReport = { id: string; filename: string; data: unknown; repo: { github: string | null; directory: string } }
type ReportVisibility = { ids: Set<string>; sourcePaths: Set<string> }
type Visibility = Map<string, ReportVisibility>
const VISIBILITY_CACHE_MAX_ITEMS = 250_000
const VISIBILITY_CACHE_MAX_SNAPSHOTS = 32
const caches = new WeakMap<ManagedDb, Map<string, Visibility>>()
const REPORT_CACHE_BYTES = 16 * 1024 * 1024
// A workspace's encoded reports, the same without their findings' detail for
// the board (`lite`), its reports' file trees apart, and its team's catalog
// summary (team-app.ts).
type EncodedWorkspace = { reports: Buffer; lite: Buffer; trees: Buffer; summary: TeamWorkspaceSummary }
export type TeamResponsePart = 'reports' | 'lite' | 'trees'
// The part a team's `reports` or `trees` route asks for.
export const teamResponsePart = (route: string, url: URL): TeamResponsePart =>
  route === 'trees' ? 'trees' : url.searchParams.get('lite') === '1' ? 'lite' : 'reports'
const reportCaches = new WeakMap<ManagedDb, Map<string, EncodedWorkspace>>()
const encodedBytes = ({ reports, lite, trees }: EncodedWorkspace) => reports.length + lite.length + trees.length
// A workspace's report reads at once. Its reports' sizes are bounded together
// before any is read, and each is held parsed till the build ends, so more at
// once costs only the raw bytes in flight: a cold build of a team's reports
// is so many storage round trips one after another.
const WORKSPACE_READS_AT_ONCE = 16
function retainReports(db: ManagedDb, key: string, encoded: EncodedWorkspace) {
  if (encodedBytes(encoded) > REPORT_CACHE_BYTES) return
  let cache = reportCaches.get(db)
  if (!cache) { cache = new Map(); reportCaches.set(db, cache) }
  cache.delete(key)
  let total = encodedBytes(encoded) + [...cache.values()].reduce((sum, value) => sum + encodedBytes(value), 0)
  for (const [oldest, value] of cache) {
    if (total <= REPORT_CACHE_BYTES && cache.size < VISIBILITY_CACHE_MAX_SNAPSHOTS) break
    cache.delete(oldest); total -= encodedBytes(value)
  }
  cache.set(key, encoded)
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
  return JSON.stringify([snapshot.user.id, snapshot.user.role, snapshot.teamId, snapshot.hiddenReportId ?? null, snapshot.reports, snapshot.repositories, snapshot.linkRevision])
}
// What a built workspace is kept by: everything its build reads, and nothing
// of who asked. A user's role and grants decide which reports (and which
// hidden preview) their snapshot holds and each one's permissions, all of it
// in the key, so members whose snapshots agree share one build.
function workspaceKey(snapshot: TeamReportAccessSnapshot): string {
  return JSON.stringify([snapshot.teamId, snapshot.hiddenReportId ?? null, snapshot.reports, snapshot.repositories, snapshot.linkRevision])
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
// A links document counts by its links, every other report by its findings.
function hasContent(data: unknown): boolean {
  const links = linksOf(data)
  if (links) return links.length > 0
  return (reportEntries(data) ?? []).some(entry => !Array.isArray(entry) || entry.length > 0)
}
function linksOf(data: unknown): string[][] | null {
  const record = data as { source?: string; links?: string[][] }
  if (record?.source !== 'links' || !Array.isArray(record.links)) return null
  if (!record.links.every(ids => Array.isArray(ids) && ids.every(id => typeof id === 'string'))) throw new TeamReportsError(422, 'unreadable-links')
  return record.links
}
// A report's file tree goes apart, asked for by its graph or Files alone
// (loadTeamTreesResponse). The report tells in its place how many files it
// holds (`treeFiles`) and the dependency directory it names
// (`treeDependencies`), which classifies findings as the tree itself would
// (client/dependency-paths.js). Each file's is sent without the hash of its
// tree (`treeHash`), which no team view reads.
function withoutTree(report: TeamReport): string | null {
  const tree = (report.data as { tree?: unknown } | null)?.tree
  if (!tree || typeof tree !== 'object' || Array.isArray(tree)) return null
  const { tree: _tree, ...data } = report.data as Finding
  const named = treeDependencyDirectory(tree)
  report.data = { ...data, treeFiles: Object.keys(tree).length, ...(named ? { treeDependencies: named } : {}) }
  const files = Object.entries(tree).map(([file, entry]) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [file, entry]
    const { treeHash: _treeHash, ...kept } = entry as Finding
    return [file, kept]
  })
  return `${JSON.stringify(report.id)}:${JSON.stringify(Object.fromEntries(files))}`
}
async function buildTeamWorkspace(db: ManagedDb, store: BlobStore, snapshot: TeamReportAccessSnapshot): Promise<EncodedWorkspace & { visible: Visibility }> {
  if (snapshot.reports.length > MAX_REPORT_QUERY_COUNT || snapshot.reports.reduce((n, r) => n + r.byteSize, 0) > MAX_REPORT_QUERY_BYTES) throw new TeamReportsError(413, 'batch-too-large')
  const reports: TeamReport[] = []
  let inputBytes = 0, next = 0
  // Bound both remote reads and raw buffers, retaining stable report order for
  // the cross-report classification that follows. Finish workers on failure.
  const results = await Promise.allSettled(Array.from({ length: Math.min(WORKSPACE_READS_AT_ONCE, snapshot.reports.length) }, async () => {
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
  const globalLinks = snapshot.linkRevision ? await db.getEnabledLinkGroups(snapshot.linkRevision) : []
  const groups = reports.flatMap(report => groupsOf(report.data).map(group => group.map(f => projectFinding(f, report.data as Finding)!)))
  // Unknown IDs can connect known findings. App findings link to the inputs
  // they revalidated in other reports, as the App view counts them.
  stampSecurityGroups(groups, { linkedIds: securityLinks([
    ...globalLinks, ...reports.flatMap(report => linksOf(report.data) ?? []), ...revalidationLinks(groups.flat()),
  ]).linkedIds })
  const securityIds = new Set(groups.flat().filter(f => f['isSecurity'] === true).map(f => String(f['id'])))
  const allIds = new Set<string>(), visible: Visibility = new Map()
  for (let i = 0; i < reports.length; i++) {
    const access = snapshot.reports[i]!, report = reports[i]!
    report.data = filterReportData(report.data, access.permissions, access.repo, securityIds)
    if (report.data && typeof report.data === 'object' && ('think' in report.data || 'reportRepo' in report.data)) {
      const { think: _think, reportRepo: _reportRepo, ...data } = report.data as Finding
      report.data = data
    }
    const ids = new Set<string>()
    for (const finding of groupsOf(report.data).flat()) {
      // Preserve linked security classification for the UI lens, including a
      // linked component that a dependency permission will hide from the UI.
      finding['isSecurity'] = securityIds.has(String(finding['id']))
      // The hash of its file's tree, the fingerprint its ID was derived from,
      // whether its run thought and the repository its report named, which
      // nothing a team view reads, nor an export (@preventive/report
      // write-md-finding.js) writes.
      delete finding['treeHash']
      delete finding['_idBasis']
      delete finding['think']
      delete finding['reportRepo']
      if (typeof finding['id'] === 'string') { ids.add(finding['id']); allIds.add(finding['id']) }
    }
    visible.set(report.id, { ids, sourcePaths: managedFindingSourcePaths(groupsOf(report.data).flat()) })
  }
  for (const report of reports) {
    const links = linksOf(report.data)
    // Hidden previews are independently authorized; preserve a hidden links
    // document even though its referenced findings are outside this response.
    if (links && !snapshot.hiddenReportId) report.data = { source: 'links', findings: [], links: links.map(ids => [...new Set(ids.filter(id => allIds.has(id)))]).filter(ids => ids.length >= 2) }
  }
  const trees = Buffer.from(`{"trees":{${reports.map(withoutTree).filter(tree => tree !== null).join(',')}}}`)
  const links = mergeLinkGroups(globalLinks, allIds)
  // Its rows read once (common/managed/team-app.js managedTeamView) for both
  // what its catalog entry tells and the board's copy: its findings without
  // their detail, and in App mode its rows as the App view shows them
  // (common/managed/finding-detail.js).
  const view = managedTeamView(Object.assign(reports.map(({ filename, data }) => ({ filename, data })), { links }))
  const lite = liteWorkspace(reports, links, view)
  const restricted = snapshot.reports.some(report => !report.permissions.dependencies || !report.permissions.security)
  const encoded = {
    // Bounded together, as when the trees were sent with their reports.
    reports: encodeReports(reports, links, trees.length),
    lite: encodeReports(lite.reports, links, 0, { folded: lite.folded, lens: lite.lens }),
    trees,
    // Its App classification, and the reports a restricted reader finds
    // nothing in, which its catalog leaves out.
    summary: { app: view.app, empty: restricted ? reports.filter(report => !hasContent(report.data)).map(report => report.id) : [] },
  }
  retainVisibility(db, workspaceKey(snapshot), visible)
  retainReports(db, workspaceKey(snapshot), encoded)
  return { ...encoded, visible }
}
// `{ reports, links }` as a response sends them, `spent` bytes already
// counted against the bound; `folded` and its `lens` where the board's copy
// left out rows App mode does not show (common/managed/finding-detail.js).
// Its findings' packages and repositories are sent once each, in `values`
// (common/managed/finding-values.js).
function encodeReports(reports: readonly TeamReport[], links: readonly string[][], spent: number,
  { folded = false, lens = null }: { folded?: false | 'rows' | 'app'; lens?: unknown } = {}): Buffer {
  let outputBytes = spent + 14
  const parts = [Buffer.from('{"reports":[')]
  const values = findingValueIndex()
  for (const [index, report] of reports.entries()) {
    const bytes = Buffer.from(JSON.stringify({ ...report, data: values.index(report.data) }))
    outputBytes += bytes.length + 1
    if (outputBytes > MAX_REPORT_QUERY_BYTES) throw new TeamReportsError(413, 'batch-too-large')
    if (index) parts.push(Buffer.from(','))
    parts.push(bytes)
  }
  const tail = JSON.stringify({ ...links.length > 0 ? { links } : {}, ...folded ? { folded, lens } : {}, ...values.values.length > 0 ? { values: values.values } : {} })
  const suffix = Buffer.from(tail === '{}' ? ']}' : `],${tail.slice(1)}`)
  if (outputBytes + suffix.length > MAX_REPORT_QUERY_BYTES) throw new TeamReportsError(413, 'batch-too-large')
  parts.push(suffix)
  return Buffer.concat(parts)
}
const pendingWorkspaces = new WeakMap<ManagedDb, Map<string, ReturnType<typeof buildTeamWorkspace>>>()
async function loadTeamWorkspace(db: ManagedDb, store: BlobStore, snapshot: TeamReportAccessSnapshot) {
  let pending = pendingWorkspaces.get(db)
  if (!pending) { pending = new Map(); pendingWorkspaces.set(db, pending) }
  const key = workspaceKey(snapshot)
  const existing = pending.get(key)
  if (existing) return existing
  const job = buildTeamWorkspace(db, store, snapshot)
  pending.set(key, job)
  try { return await job } finally { pending.delete(key) }
}
// Treat the encoded body as immutable and recheck access before sending it.
// Warm HTTP reads need neither a parsed copy nor another serialization pass.
// Its `lite` reports and its `trees`, by report ID (withoutTree), are of the
// same snapshot and take the same recheck.
export async function loadTeamReportsResponse(db: ManagedDb, store: BlobStore, snapshot: TeamReportAccessSnapshot,
  part: TeamResponsePart = 'reports'): Promise<Buffer> {
  const cached = reportCaches.get(db)?.get(workspaceKey(snapshot))
  return cached?.[part] ?? (await loadTeamWorkspace(db, store, snapshot))[part]
}
// A team's catalog summary (team-app.ts), as its workspace was built.
export async function loadTeamSummary(db: ManagedDb, store: BlobStore, snapshot: TeamReportAccessSnapshot): Promise<TeamWorkspaceSummary> {
  return reportCaches.get(db)?.get(workspaceKey(snapshot))?.summary ?? (await loadTeamWorkspace(db, store, snapshot)).summary
}
export async function loadTeamReports(db: ManagedDb, store: BlobStore, snapshot: TeamReportAccessSnapshot): Promise<TeamReport[]> {
  // Object consumers get their own copy, including when sharing a cold load.
  const body = JSON.parse((await loadTeamReportsResponse(db, store, snapshot)).toString('utf8')) as { reports: TeamReport[]; values?: unknown[] }
  for (const report of body.reports) expandFindingValues(report.data, body.values)
  return body.reports
}
async function teamVisibility(db: ManagedDb, store: BlobStore, snapshot: TeamReportAccessSnapshot): Promise<Visibility> {
  let visible = caches.get(db)?.get(workspaceKey(snapshot))
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

// What a focused team's annotations are at, for the snapshot reading them, as
// its feed tells it (team-feed.ts serveUserTeamFeed) and its annotations
// answer it (loadTeamAnnotations): the snapshot's key and the revision of
// every visible finding's annotations (getAnnotationRevision), its workspace's
// findings being `ids` (teamWorkspaceFindingIds).
export async function teamAnnotationRevision(db: ManagedDb, snapshot: TeamReportAccessSnapshot, ids: readonly string[]): Promise<string> {
  return JSON.stringify([teamSnapshotKey(snapshot), await db.getAnnotationRevision(ids)])
}

// A revision as the client is told it: a digest, telling only whether what it
// covers changed, none of the finding IDs, batches or issues it is read from.
export const annotationRevisionDigest = (revision: string): string => createHash('sha256').update(revision).digest('base64url')
export async function teamReportVisibility(db: ManagedDb, store: BlobStore, snapshot: TeamReportAccessSnapshot, reportId: string): Promise<ReportVisibility> {
  if (!snapshot.reports.some(r => r.id === reportId)) throw new TeamReportsError(404, 'no-report')
  const visible = await teamVisibility(db, store, snapshot)
  return visible.get(reportId)!
}
// A report's visibility for the session's current snapshot. A workspace built
// (or waited for) here outlives that snapshot's read, so the team's access is
// read again after it; one kept is answered with no read in between, which
// leaves nothing for another snapshot read to guard.
async function sessionReportVisibility(db: ManagedDb, store: BlobStore, sessionId: string, teamId: string, reportId: string): Promise<ReportVisibility> {
  const snapshot = await teamSnapshot(db, sessionId, teamId, reportId)
  const kept = caches.get(db)?.get(workspaceKey(snapshot))?.get(reportId)
  if (kept) return kept
  const visible = await teamReportVisibility(db, store, snapshot, reportId)
  await recheckTeam(db, sessionId, snapshot)
  return visible
}
export async function teamFindingIds(db: ManagedDb, store: BlobStore, sessionId: string, teamId: string, reportId: string): Promise<Set<string>> {
  return (await sessionReportVisibility(db, store, sessionId, teamId, reportId)).ids
}
export async function teamSourcePaths(db: ManagedDb, store: BlobStore, sessionId: string, teamId: string, reportId: string): Promise<Set<string>> {
  return (await sessionReportVisibility(db, store, sessionId, teamId, reportId)).sourcePaths
}

// Serialize shared annotation bodies once. Reports carry only the annotated
// finding IDs visible in that report; callers revalidate access before sending.
// With them, the digest of the revision the whole workspace's are at, as the
// team's feed tells it (`revision`), read before them: a write between leaves
// it older than what is sent, so the feed's next differs and the client reads
// again, never the reverse.
export async function loadTeamAnnotations(db: ManagedDb, store: BlobStore, snapshot: TeamReportAccessSnapshot, reportId: string | null = null) {
  // Restrict annotation reads only after classifying the complete workspace:
  // links and findings in other reports can affect this report's visibility.
  if (reportId !== null && !snapshot.reports.some(r => r.id === reportId)) throw new TeamReportsError(404, 'no-report')
  const workspace = await teamVisibility(db, store, snapshot)
  const visible = reportId === null ? workspace : new Map([[reportId, workspace.get(reportId)!]])
  const all = new Set<string>(), ids = new Set<string>()
  for (const report of visible.values()) for (const id of report.ids) ids.add(id)
  for (const report of workspace.values()) for (const id of report.ids) all.add(id)
  const revision = await teamAnnotationRevision(db, snapshot, [...all])
  const { triage, comments, issues: savedIssues } = await db.getAnnotations([...ids])
  const issues = Object.fromEntries(visibleManagedIssues(savedIssues, snapshot)
    .map(issue => [issue.findingId, { url: issue.issueUrl!, autoFix: issue.autoFixUrl }]))
  const entries = Object.fromEntries(triage.map(row => [row.findingId, triageWireEntry(row)]))
  const annotated = new Set([...triage.map(row => row.findingId), ...comments.map(comment => comment.findingId), ...Object.keys(issues)])
  const reports = Object.fromEntries([...visible].map(([id, report]) => [id, [...report.ids].filter(finding => annotated.has(finding))]))
  return { reports, entries, comments, issues, revision: annotationRevisionDigest(revision) }
}
