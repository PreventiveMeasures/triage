// Whether each team's sidebar entry opens collapsed to its App findings,
// decided before the catalog is sent so the first paint is already final. A
// team is classified from the same filtered, published workspace its view
// loads. Results are keyed by the catalog's own content keys: an unchanged
// catalog reuses them, and every change that can move a result also changes
// the catalog revision that clients refresh on.
//
// The same read names the reports a restricted reader would find nothing in:
// under -deps or -security the catalog leaves those out of the team's list.
// Readers with both permissions keep every report, empty or not.
//
// A team that is not App also says how many of its reports open in App mode
// on their own, and its findings for the badge it collapses to. None is as
// uniform as an App team, and collapses like one. A team mixing App and non-App
// reports stays expanded, and so does one whose reports each open as App but
// whose combined workspace does not (contradicting verdicts, say): it has App
// findings, and only expanded does it show that they fail to combine.
import type { TeamAppMetadata } from '../common/managed/team-app.js'
import type { BlobStore } from './blob-store.ts'
import type { ManagedDb, TeamReportAccessSnapshot, UserTeam } from './db.ts'
import type { WorkspaceShareSnapshot } from './workspace-shares.ts'
import { TeamReportsError, loadTeamSummary } from './team-reports.ts'
import { teamAppSummaryKey } from './team-app-summaries.ts'

export type { TeamAppMetadata }
export interface TeamWorkspaceSummary { app: TeamAppMetadata; empty: readonly string[] }
const NO_APP: TeamWorkspaceSummary = { app: { appMode: false }, empty: [] }

const CACHE_MAX_ENTRIES = 4096
// Each workspace build already reads four reports at a time.
const CLASSIFY_CONCURRENCY = 2
const caches = new WeakMap<ManagedDb, Map<string, TeamWorkspaceSummary>>()
const pendingJobs = new WeakMap<ManagedDb, Map<string, Promise<TeamWorkspaceSummary | null>>>()

// Published reports with their content keys, and the team's own key (access,
// scopes and links). Equal keys describe the same filtered workspace, whoever
// reads it, so accounts with the same access share one classification.
export function teamAppKey(team: UserTeam): string {
  return JSON.stringify([team.cacheKey ?? null, published(team).map(report => [report.id, report.cacheKey]).toSorted()])
}

function published(team: UserTeam) {
  return team.reports.filter(report => report.visible !== false)
}

function remember(db: ManagedDb, key: string, summary: TeamWorkspaceSummary): TeamWorkspaceSummary {
  let cache = caches.get(db)
  if (!cache) { cache = new Map(); caches.set(db, cache) }
  cache.delete(key)
  cache.set(key, summary)
  for (const oldest of cache.keys()) {
    if (cache.size <= CACHE_MAX_ENTRIES) break
    cache.delete(oldest)
  }
  return summary
}

// Summaries kept in the database for every instance (team-app-summaries.ts),
// by key; a failed read is a miss, never a failed catalog, and an unreadable
// summary one to work out again.
async function storedSummaries(db: ManagedDb, keys: readonly string[]): Promise<Map<string, TeamWorkspaceSummary>> {
  const hashed = new Map(keys.map(key => [teamAppSummaryKey(key), key]))
  let rows: Map<string, string>
  try { rows = await db.getTeamAppSummaries([...hashed.keys()]) } catch (error) {
    console.warn('managed: stored team App classification read failed:', error)
    return new Map()
  }
  const summaries = new Map<string, TeamWorkspaceSummary>()
  for (const [hash, text] of rows) {
    const key = hashed.get(hash), summary = readSummary(text)
    if (summary && key !== undefined) summaries.set(key, summary)
  }
  return summaries
}

function readSummary(text: string): TeamWorkspaceSummary | null {
  try {
    const summary = JSON.parse(text) as TeamWorkspaceSummary
    return typeof summary?.app?.appMode === 'boolean' && Array.isArray(summary.empty) && summary.empty.every(id => typeof id === 'string') ? summary : null
  } catch { return null }
}

// One worked out, remembered and stored for every instance.
async function settle(db: ManagedDb, key: string, summary: TeamWorkspaceSummary): Promise<TeamWorkspaceSummary> {
  remember(db, key, summary)
  try { await db.setTeamAppSummary(teamAppSummaryKey(key), JSON.stringify(summary), Date.now()) } catch (error) {
    console.warn('managed: storing team App classification failed:', error)
  }
  return summary
}

// Null when the team cannot be classified right now: its catalog went stale,
// the access snapshot is gone, or storage failed. The sidebar then keeps the
// team expanded and lists every report, and a later catalog asks again.
// Oversized and unreadable workspaces never have an App view, so they are
// remembered as such, hiding nothing. One kept in memory, or stored (`read`,
// where the caller has not asked already), is not worked out again.
async function classify(db: ManagedDb, store: BlobStore, key: string, team: UserTeam,
  snapshot: () => Promise<TeamReportAccessSnapshot | null>, read = true): Promise<TeamWorkspaceSummary | null> {
  const cached = caches.get(db)?.get(key)
  if (cached) return remember(db, key, cached)
  const keys = new Map(published(team).map(report => [report.id, report.cacheKey]))
  if (keys.size === 0) return remember(db, key, NO_APP)
  const stored = read ? (await storedSummaries(db, [key])).get(key) : undefined
  if (stored) return remember(db, key, stored)
  let jobs = pendingJobs.get(db)
  if (!jobs) { jobs = new Map(); pendingJobs.set(db, jobs) }
  const existing = jobs.get(key)
  if (existing) return existing
  const job = (async () => {
    const access = await snapshot()
    // A catalog read before a concurrent change names other reports, or
    // other content or access of them: what is read now is no workspace of
    // its key, so nothing is kept under it.
    if (!access?.teamId || access.reports.length !== keys.size || access.reports.some(report => access.catalogKeys?.[report.id] !== keys.get(report.id))) return null
    // Worked out as the workspace is built (team-reports.ts).
    return settle(db, key, await loadTeamSummary(db, store, access))
  })().catch((error: unknown) => {
    if (error instanceof TeamReportsError && [413, 422].includes(error.status)) return settle(db, key, NO_APP)
    if (!(error instanceof TeamReportsError)) console.warn('managed: team App classification failed:', error)
    return null
  })
  jobs.set(key, job)
  try { return await job } finally { jobs.delete(key) }
}

// The catalog's view of a classified team: its App classification, and its
// reports without the ones its restricted reader would find empty.
export function withWorkspaceSummary<T extends { reports: readonly { id: string }[] }>(team: T, summary: TeamWorkspaceSummary | null | undefined) {
  const empty = new Set(summary?.empty)
  return { ...team, app: summary?.app ?? null, reports: team.reports.filter(report => !empty.has(report.id)) }
}

// Classify a user's catalog, keyed by teamAppKey. `known` carries results from
// an earlier read of the same request, so only changed teams are classified.
export async function teamAppStates(db: ManagedDb, store: BlobStore, sessionId: string, teams: readonly UserTeam[],
  known: ReadonlyMap<string, TeamWorkspaceSummary | null> = new Map()): Promise<Map<string, TeamWorkspaceSummary | null>> {
  const states = new Map(known)
  const missing = [...new Map(teams.map(team => [teamAppKey(team), team])).entries()].filter(([key]) => !states.has(key))
  // Those kept in no memory of this instance's are read of the database at
  // once, in one statement.
  const unknown = missing.filter(([key, team]) => !caches.get(db)?.has(key) && published(team).length > 0).map(([key]) => key)
  for (const [key, summary] of unknown.length > 0 ? await storedSummaries(db, unknown) : []) remember(db, key, summary)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(CLASSIFY_CONCURRENCY, missing.length) }, async () => {
    while (next < missing.length) {
      const [key, team] = missing[next++]!
      states.set(key, await classify(db, store, key, team, () => db.getTeamReportAccessSnapshot(sessionId, Date.now(), team.id), false))
    }
  }))
  return states
}

// A public link's workspace is its own access snapshot.
export function sharedTeamApp(db: ManagedDb, store: BlobStore, snapshot: WorkspaceShareSnapshot): Promise<TeamWorkspaceSummary | null> {
  return classify(db, store, JSON.stringify(['share', teamAppKey(snapshot.team)]), snapshot.team, () => Promise.resolve(snapshot))
}
