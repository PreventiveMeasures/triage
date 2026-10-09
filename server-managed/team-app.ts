// Whether each team's sidebar entry opens collapsed to its App findings,
// decided before the catalog is sent so the first paint is already final. A
// team is classified from the same filtered, published workspace its view
// loads. Results are keyed by the catalog's own content keys: an unchanged
// catalog reuses them, and every change that can move a result also changes
// the catalog revision that clients refresh on.
import { type TeamAppMetadata, managedTeamAppMetadata } from '../common/managed/team-app.js'
import type { BlobStore } from './blob-store.ts'
import type { ManagedDb, TeamReportAccessSnapshot, UserTeam } from './db.ts'
import type { WorkspaceShareSnapshot } from './workspace-shares.ts'
import { TeamReportsError, loadTeamReportsResponse } from './team-reports.ts'

export type { TeamAppMetadata }

const CACHE_MAX_ENTRIES = 4096
// Each workspace build already reads four reports at a time.
const CLASSIFY_CONCURRENCY = 2
const caches = new WeakMap<ManagedDb, Map<string, TeamAppMetadata>>()
const pendingJobs = new WeakMap<ManagedDb, Map<string, Promise<TeamAppMetadata | null>>>()

// Published reports with their content keys, and the team's own key (access,
// scopes and links). Equal keys describe the same filtered workspace, whoever
// reads it, so accounts with the same access share one classification.
export function teamAppKey(team: UserTeam): string {
  return JSON.stringify([team.cacheKey ?? null, published(team).map(report => [report.id, report.cacheKey]).toSorted()])
}

function published(team: UserTeam) {
  return team.reports.filter(report => report.visible !== false)
}

function remember(db: ManagedDb, key: string, app: TeamAppMetadata): TeamAppMetadata {
  let cache = caches.get(db)
  if (!cache) { cache = new Map(); caches.set(db, cache) }
  cache.delete(key)
  cache.set(key, app)
  for (const oldest of cache.keys()) {
    if (cache.size <= CACHE_MAX_ENTRIES) break
    cache.delete(oldest)
  }
  return app
}

// Null when the team cannot be classified right now: its catalog went stale,
// the access snapshot is gone, or storage failed. The sidebar then keeps the
// team expanded, and a later catalog asks again. Oversized and unreadable
// workspaces never have an App view, so they are remembered as such.
async function classify(db: ManagedDb, store: BlobStore, key: string, team: UserTeam,
  snapshot: () => Promise<TeamReportAccessSnapshot | null>): Promise<TeamAppMetadata | null> {
  const cached = caches.get(db)?.get(key)
  if (cached) return remember(db, key, cached)
  const ids = new Set(published(team).map(report => report.id))
  if (ids.size === 0) return remember(db, key, { appMode: false })
  let jobs = pendingJobs.get(db)
  if (!jobs) { jobs = new Map(); pendingJobs.set(db, jobs) }
  const existing = jobs.get(key)
  if (existing) return existing
  const job = (async () => {
    const access = await snapshot()
    // A catalog read before a concurrent publication names another report set.
    if (!access?.teamId || access.reports.length !== ids.size || access.reports.some(report => !ids.has(report.id))) return null
    const body = JSON.parse((await loadTeamReportsResponse(db, store, access)).toString('utf8')) as {
      reports: { filename: string; data: unknown }[]; links?: string[][]
    }
    return remember(db, key, managedTeamAppMetadata(Object.assign(body.reports, { links: body.links ?? [] })))
  })().catch((error: unknown) => {
    if (error instanceof TeamReportsError && [413, 422].includes(error.status)) return remember(db, key, { appMode: false })
    if (!(error instanceof TeamReportsError)) console.warn('managed: team App classification failed:', error)
    return null
  })
  jobs.set(key, job)
  try { return await job } finally { jobs.delete(key) }
}

// Classify a user's catalog, keyed by teamAppKey. `known` carries results from
// an earlier read of the same request, so only changed teams are classified.
export async function teamAppStates(db: ManagedDb, store: BlobStore, sessionId: string, teams: readonly UserTeam[],
  known: ReadonlyMap<string, TeamAppMetadata | null> = new Map()): Promise<Map<string, TeamAppMetadata | null>> {
  const states = new Map(known)
  const missing = [...new Map(teams.map(team => [teamAppKey(team), team])).entries()].filter(([key]) => !states.has(key))
  let next = 0
  await Promise.all(Array.from({ length: Math.min(CLASSIFY_CONCURRENCY, missing.length) }, async () => {
    while (next < missing.length) {
      const [key, team] = missing[next++]!
      states.set(key, await classify(db, store, key, team, () => db.getTeamReportAccessSnapshot(sessionId, Date.now(), team.id)))
    }
  }))
  return states
}

// A public link's workspace is its own access snapshot.
export function sharedTeamApp(db: ManagedDb, store: BlobStore, snapshot: WorkspaceShareSnapshot): Promise<TeamAppMetadata | null> {
  return classify(db, store, JSON.stringify(['share', teamAppKey(snapshot.team)]), snapshot.team, () => Promise.resolve(snapshot))
}
