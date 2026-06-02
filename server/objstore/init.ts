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
  // Hard off-switch (OBJSTORE_REAP_DISABLED). When true, NEITHER the boot
  // sweep nor the periodic timer runs: `startupReap` resolves immediately
  // and `stopReaper` is a no-op. Orphaned/superseded blobs and stale
  // staging rows then accumulate unbounded — only safe if an external job
  // handles GC. Omitted/false → reaper runs (the default). See config.ts.
  reapDisabled?: boolean
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
  // New-workspace operator gate for the REST put-begin mint — returns
  // `true` to DENY (password configured AND workspace new). The
  // connection-independent analog of `authGate`; the client falls back to
  // the in-band WS put-begin on a deny. Omitted → open (never deny),
  // matching `authGate`'s no-config default.
  restPutGate?: (workspaceTag: string) => Promise<boolean>
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
  // Fail loud on a lopsided auth config. The put-begin gate in
  // handlers.ts only fires when BOTH authGate and sendUnauthorized are
  // present (it needs the reporter to emit the `unauthorized` frame),
  // so wiring authGate WITHOUT sendUnauthorized silently fails OPEN —
  // unauthenticated first-writes to unknown workspaces would be accepted
  // despite the operator's intent to gate them. Reject at boot rather
  // than regress access control silently.
  if (deps.authGate && !deps.sendUnauthorized) {
    throw new Error('initObjstore: authGate requires sendUnauthorized (the put-begin gate needs it to emit the unauthorized frame)')
  }
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
    handle, secret, broadcast: deps.broadcast,
    publishObjPut: deps.publishObjPut, publishObjDeleted: deps.publishObjDeleted,
    restPutGate: deps.restPutGate ?? (() => Promise.resolve(false)),
    debug: deps.debug,
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
  // Hard off-switch (OBJSTORE_REAP_DISABLED). Skip the boot sweep AND the
  // periodic timer entirely: `startupReap` resolves immediately so the
  // index.ts `await startupReap` gate is a no-op, and `stopReaper` has
  // nothing to clear or drain. Loud, unconditional warning — with GC off,
  // orphaned/superseded blobs and stale staging rows are never reclaimed
  // (they accumulate until an external job, if any, collects them).
  if (deps.reapDisabled) {
    console.warn('objstore: reaper DISABLED (OBJSTORE_REAP_DISABLED) — orphaned/superseded blobs and stale staging will NOT be reclaimed')
    return { handlers, restDeps, startupReap: Promise.resolve(), stopReaper: async () => {} }
  }
  // Caller awaits this before accepting traffic so a fresh boot
  // can't hand out list / fetch / put-begin against a tag whose
  // on-disk state still has stranded files from a prior crash.
  const startupReap = enqueueSweep()
  // Jittered start of the periodic timer. Multi-replica deploys
  // (Neon + Vercel Blob) commonly boot N replicas in tight lock-step
  // (deploy rollout, cluster restart), which would otherwise sync every
  // replica's reaper to the same wall-clock tick and hammer the DB +
  // blob store with N×readdir+lock-acquire bursts. A random
  // first-interval delay spreads the cluster out without changing the
  // long-term cadence. Jitter is 0…1× reapIntervalMs (first sweep at
  // [interval, 2×interval] after boot); subsequent sweeps stay exactly
  // `reapIntervalMs` apart.
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
