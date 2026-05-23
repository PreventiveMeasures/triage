// Wire-time wrapper around the v1.objstore module — takes a pre-
// opened storage handle (SQLite or Neon, opened one level up
// alongside the workspace_revision handle), mints a per-process
// bearer-token secret, kicks off the orphan reaper, and returns
// the WS handlers + REST deps + a teardown callback the index.ts
// shutdown path calls before closing the shared DB handle.

import type { WebSocket } from 'ws'
import type { Handle } from './store.ts'
import { reapOrphans } from './reaper.ts'
import { type ObjstoreHandlers, createObjstoreHandlers } from './handlers.ts'
import { type ObjstoreRestDeps } from './rest.ts'
import { type TokenSecret, newTokenSecret } from './tokens.ts'
import { errStack } from '../util.ts'

export type ObjstoreInitDeps = {
  // Pre-opened storage handle, sharing the SQLite connection with
  // the workspace_revision handle in server/db.ts.
  handle: Handle
  reapIntervalMs: number
  send: (socket: WebSocket, msg: object) => void
  broadcast: (tag: string, msg: object, except: WebSocket | null) => void
  // Cross-instance pub/sub publishers. SQLite mode passes no-ops; Neon
  // mode passes Postgres LISTEN/NOTIFY-backed implementations. See
  // server/pubsub.ts for the bus design.
  publishObjPut: (tag: string, resourceTag: string) => void
  publishObjDeleted: (tag: string, resourceTag: string, version: number) => void
  getNonce: (socket: WebSocket) => string | undefined
  debug: boolean
  // Auth gate for the FIRST objstore-put-begin against a workspace
  // tag that doesn't yet exist on the server. Returns `true` to
  // DENY (unauthorized), `false` to allow. Called AFTER sig verify
  // so the resulting `unauthorized` frame only reaches a legitimate
  // signer. Falsy/missing → no gating (the no-config default).
  authGate?: (socket: WebSocket, workspaceTag: string) => Promise<boolean>
  sendUnauthorized?: (socket: WebSocket, ctx: { kind: 'gated'; workspaceTag: string; resourceTag: string }) => void
  // HMAC secret for REST bearer tokens. Optional — falls back to a
  // fresh process-local secret if omitted (the historical single-
  // process behaviour). Multi-replica deployments MUST supply a
  // shared secret here so a token minted on one replica's WS plane
  // validates on another replica's REST plane (the WS-to-REST hop
  // is not load-balancer-pinned). See server/index.ts boot logic
  // for the env var (`OBJSTORE_TOKEN_SECRET`).
  tokenSecret?: TokenSecret
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
  const handle = deps.handle
  const secret = deps.tokenSecret ?? newTokenSecret()
  const handlers = createObjstoreHandlers({
    handle, secret,
    send: deps.send, broadcast: deps.broadcast,
    publishObjDeleted: deps.publishObjDeleted,
    getNonce: deps.getNonce, debug: deps.debug,
    ...(deps.authGate ? { authGate: deps.authGate } : {}),
    ...(deps.sendUnauthorized ? { sendUnauthorized: deps.sendUnauthorized } : {}),
  })
  const restDeps: ObjstoreRestDeps = {
    handle, secret, broadcast: deps.broadcast, publishObjPut: deps.publishObjPut, debug: deps.debug,
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
      console.warn('objstore reaper error:', errStack(err))
    }).finally(() => { if (inFlight === p) inFlight = null })
    inFlight = p
    return p
  }
  // Caller awaits this before accepting traffic so a fresh boot
  // can't hand out list / fetch / put-begin against a tag whose
  // on-disk state still has stranded files from a prior crash.
  const startupReap = enqueueSweep()
  // Jittered start of the periodic timer. Multi-replica deploys
  // (Neon + Vercel Blob) commonly boot N replicas in tight lock-
  // step (deploy rollout, cluster restart) and would otherwise
  // sync every replica's reaper at the same wall-clock tick,
  // hammering the DB + blob store with N×readdir+lock-acquire
  // bursts. A random first-interval delay deconcurrencies the
  // cluster without changing the long-term sweep cadence.
  // Jitter range is 0…1× reapIntervalMs (i.e., the next sweep
  // happens at [interval, 2×interval] after boot); subsequent
  // sweeps stay at exactly `reapIntervalMs` apart.
  let reapTimer: ReturnType<typeof setInterval> | null = null
  const jitterMs = Math.floor(Math.random() * deps.reapIntervalMs)
  const firstTimer = setTimeout(() => {
    enqueueSweep()
    reapTimer = setInterval(enqueueSweep, deps.reapIntervalMs)
    reapTimer.unref?.()
  }, deps.reapIntervalMs + jitterMs)
  firstTimer.unref?.()
  return {
    handlers, restDeps, startupReap,
    stopReaper: async () => {
      clearTimeout(firstTimer)
      if (reapTimer) clearInterval(reapTimer)
      // Drain whichever sweep is currently running (startup or
      // periodic) — either could be mid-readdir/unlink at SIGTERM
      // time and would otherwise outlive `handle.close()`.
      if (inFlight) await inFlight.catch(() => {})
    },
  }
}
