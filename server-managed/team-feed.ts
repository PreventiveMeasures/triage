import type { ServerResponse } from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import type { ManagedHttpDeps } from './http.ts'
import type { StoredUser, TeamReportAccessSnapshot } from './db.ts'
import { TeamReportsError, teamSnapshotKey, teamWorkspaceFindingIds } from './team-reports.ts'

// Short database reads work across instances without pinning a Neon connection.
// All polling belongs to the awaited request; nothing runs after it completes.
export const TEAM_FEED_POLL_MS = 3_000
export const TEAM_FEED_LIFETIME_MS = 240_000 // below the configured Vercel 300s
const HEARTBEAT_MS = 15_000

type FeedOptions = { pollMs?: number; lifetimeMs?: number }
type Publish = (event: 'teams' | 'triage', revision: string | undefined) => boolean

// Public capabilities remain scoped to their single shared workspace.
export async function serveTeamFeed(res: ServerResponse, deps: ManagedHttpDeps,
  snapshot: TeamReportAccessSnapshot, recheck: () => Promise<void>, options: FeedOptions = {}): Promise<void> {
  let ids: string[] | undefined
  await serveFeed(res, deps, async publish => {
    await recheck()
    ids ??= [...await teamWorkspaceFindingIds(deps.db, deps.reportStore, snapshot)]
    const triage = await deps.db.getAnnotationRevision(ids)
    await recheck()
    publish('triage', triage)
  }, options)
}

// Membership and content notifications cover all of the user's teams. Only
// the focused team needs report parsing or annotation reads; null is the
// catalog-only subscription used on landing and management pages.
export async function serveUserTeamFeed(res: ServerResponse, deps: ManagedHttpDeps,
  sessionId: string, user: StoredUser, teamId: string | null, options: FeedOptions = {}): Promise<void> {
  let ids: string[] = [], visibilityKey: string | undefined
  const checkUser = (current: { user: Pick<StoredUser, 'id' | 'role'> } | null) => {
    if (!current) throw new TeamReportsError(401, 'unauthenticated')
    if (current.user.id !== user.id || current.user.role !== user.role || current.user.role === 'none') {
      throw new TeamReportsError(403, 'access-changed')
    }
  }
  await serveFeed(res, deps, async publish => {
    const catalog = await deps.db.getUserTeamFeedSnapshot(sessionId, Date.now())
    checkUser(catalog)
    checkUser(await deps.db.getReportAccessSnapshot(sessionId, Date.now(), []))
    // Publish catalog state before loading any report blobs. A slow or broken
    // focused report must not hide membership/content changes from the client.
    if (!publish('teams', catalog!.revision) || !teamId) return
    let triage: string | undefined
    const snapshot = await deps.db.getTeamReportAccessSnapshot(sessionId, Date.now(), teamId)
    if (!snapshot) throw new TeamReportsError(401, 'unauthenticated')
    checkUser(snapshot)
    const key = teamSnapshotKey(snapshot)
    if (key !== visibilityKey) {
      try {
        ids = snapshot.teamId ? [...await teamWorkspaceFindingIds(deps.db, deps.reportStore, snapshot)] : []
        visibilityKey = key
      } catch {
        // Missing, malformed or temporarily unavailable blobs only suspend
        // triage. Retry visibility on the next poll, even for the same key.
        publish('triage', undefined)
        return
      }
    }
    if (snapshot.teamId) triage = JSON.stringify([key, await deps.db.getAnnotationRevision(ids)])
    const current = await deps.db.getTeamReportAccessSnapshot(sessionId, Date.now(), teamId)
    // A concurrent access/content change discards only the annotation read.
    checkUser(current)
    if (!current || teamSnapshotKey(current) !== key) return
    publish('triage', triage)
  }, options)
}

async function serveFeed(res: ServerResponse, deps: ManagedHttpDeps, read: (publish: Publish) => Promise<void>,
  { pollMs = TEAM_FEED_POLL_MS, lifetimeMs = TEAM_FEED_LIFETIME_MS }: FeedOptions): Promise<void> {
  const controller = new AbortController()
  const close = () => controller.abort()
  res.once('close', close)
  const deadline = setTimeout(close, lifetimeMs)
  const stopped = () => controller.signal.aborted || res.destroyed || deps.isShuttingDown()
  // Notifications carry no annotation bodies, finding IDs, or global cursors.
  // A fresh connection always invalidates, including after a missed update.
  function write(frame: string): boolean {
    if (stopped()) return false
    if (res.write(frame)) return true
    // Slow consumers reconnect and read current state; never queue a backlog.
    res.destroy()
    return false
  }
  try {
    if (stopped()) return
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'private, no-store, no-transform', 'x-accel-buffering': 'no',
      'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' })
    res.flushHeaders()
    let heartbeat = Date.now()
    const previous = new Map<string, string>()
    const publish: Publish = (event, revision) => {
      if (stopped()) return false
      if (revision === undefined) { previous.delete(event); return true }
      if (revision === previous.get(event)) return true
      if (!write(`event: ${event}\ndata: {}\n\n`)) return false
      previous.set(event, revision)
      heartbeat = Date.now()
      return true
    }
    while (!stopped()) {
      await read(publish)
      if (stopped()) break
      if (Date.now() - heartbeat >= HEARTBEAT_MS) {
        if (!write(': keepalive\n\n')) break
        heartbeat = Date.now()
      }
      await delay(pollMs, undefined, { signal: controller.signal }).catch(error => {
        if (!controller.signal.aborted) throw error
      })
    }
  } catch (error) {
    if (!res.headersSent) throw error
    if (error instanceof TeamReportsError) write('event: close\ndata: {}\n\n')
    else if (!stopped()) throw error
  } finally {
    clearTimeout(deadline)
    res.off('close', close)
    if (res.headersSent && !res.destroyed) res.end()
  }
}
