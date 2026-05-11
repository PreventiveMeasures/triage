// Wire-time wrapper around the v1.objstore module — opens the
// storage handle, mints a per-process bearer-token secret, kicks
// off the orphan reaper, and returns the WS handlers + REST deps
// + a teardown callback the index.ts shutdown path calls before
// closing the shared DB handle.

import type { WebSocket } from 'ws'
import type { DatabaseSync } from 'node:sqlite'
import { openObjstore } from './store.ts'
import { reapOrphans } from './reaper.ts'
import { type ObjstoreHandlers, createObjstoreHandlers } from './handlers.ts'
import { type ObjstoreRestDeps } from './rest.ts'
import { newTokenSecret } from './tokens.ts'

export type ObjstoreInitDeps = {
  db: DatabaseSync
  dir: string
  reapIntervalMs: number
  send: (socket: WebSocket, msg: object) => void
  broadcast: (tag: string, msg: object, except: WebSocket | null) => void
  getNonce: (socket: WebSocket) => string | undefined
  debug: boolean
}

export type ObjstoreInit = {
  handlers: ObjstoreHandlers
  restDeps: ObjstoreRestDeps
  startupReap: Promise<void>
  // Cancels the periodic timer AND resolves only after any
  // currently-in-flight sweep has finished, so shutdown can safely
  // close the DB without an outstanding readdir / unlink touching
  // a closed handle. PR #4 review.
  stopReaper: () => Promise<void>
}

export function initObjstore(deps: ObjstoreInitDeps): ObjstoreInit {
  const handle = openObjstore(deps.db, deps.dir)
  const secret = newTokenSecret()
  const handlers = createObjstoreHandlers({
    handle, secret,
    send: deps.send, broadcast: deps.broadcast,
    getNonce: deps.getNonce, debug: deps.debug,
  })
  const restDeps: ObjstoreRestDeps = {
    handle, secret, broadcast: deps.broadcast, debug: deps.debug,
  }
  // Re-entrancy guard for periodic + startup sweeps. Kicking the
  // startup sweep through the same `enqueueSweep` path means the
  // interval ticking before the startup pass finishes naturally
  // short-circuits — no risk of two `reapOrphans()` racing
  // readdir / unlink against the same dirs. PR #4 review.
  let inFlight: Promise<void> | null = null
  function enqueueSweep(): Promise<void> {
    if (inFlight) return inFlight
    // Log reaper failures unconditionally (not gated on `debug`) — a
    // failed sweep means stranded files / staging rows that never get
    // cleaned, and operators need to see it. Inner catch makes the
    // promise resolve so callers (startupReap awaiter + setInterval)
    // don't have to handle rejection.
    const p = reapOrphans(handle).catch((err) => {
      console.warn('objstore reaper error:', (err as Error)?.stack ?? err)
    }).finally(() => { if (inFlight === p) inFlight = null })
    inFlight = p
    return p
  }
  // Caller awaits this before accepting traffic so a fresh boot
  // can't hand out list / fetch / put-begin against a tag whose
  // on-disk state still has stranded files from a prior crash.
  const startupReap = enqueueSweep()
  const reapTimer = setInterval(enqueueSweep, deps.reapIntervalMs)
  reapTimer.unref?.()
  return {
    handlers, restDeps, startupReap,
    stopReaper: async () => {
      clearInterval(reapTimer)
      // Drain whichever sweep is currently running (startup or
      // periodic) — either could be mid-readdir/unlink at SIGTERM
      // time and would otherwise outlive `handle.close()`.
      if (inFlight) await inFlight.catch(() => {})
    },
  }
}
