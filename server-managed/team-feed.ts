import type { ServerResponse } from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import type { ManagedHttpDeps } from './http.ts'
import type { TeamReportAccessSnapshot } from './db.ts'
import { TeamReportsError, teamWorkspaceFindingIds } from './team-reports.ts'

// Short database reads work across instances without pinning a Neon connection.
// All polling belongs to the awaited request; nothing runs after it completes.
export const TEAM_FEED_POLL_MS = 3_000
export const TEAM_FEED_LIFETIME_MS = 240_000 // below the configured Vercel 300s
const HEARTBEAT_MS = 15_000

export async function serveTeamFeed(res: ServerResponse, deps: ManagedHttpDeps,
  snapshot: TeamReportAccessSnapshot, recheck: () => Promise<void>,
  { pollMs = TEAM_FEED_POLL_MS, lifetimeMs = TEAM_FEED_LIFETIME_MS } = {}): Promise<void> {
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
    const ids = [...await teamWorkspaceFindingIds(deps.db, deps.reportStore, snapshot)]
    await recheck()
    if (stopped()) return
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'private, no-store, no-transform', 'x-accel-buffering': 'no',
      'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' })
    res.flushHeaders()
    let heartbeat = Date.now(), previous: string | undefined
    while (!stopped()) {
      await recheck()
      const revision = await deps.db.getAnnotationRevision(ids)
      await recheck()
      if (stopped()) break
      if (revision !== previous) {
        if (!write('event: triage\ndata: {}\n\n')) break
        previous = revision
        heartbeat = Date.now()
      } else if (Date.now() - heartbeat >= HEARTBEAT_MS) {
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
