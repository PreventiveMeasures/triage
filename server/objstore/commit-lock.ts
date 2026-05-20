// Distributed commit lock — cross-replica serialization for mutate
// ops on the v1.objstore (workspace_tag, resource_tag) plane.
//
// Background: the in-process `KeyedAsyncLock` in ./lock.ts is
// sufficient for single-replica deployments (SQLite + local FS or
// Neon + local FS) — every mutator on the same key goes through the
// same process and serializes naturally. The Neon + Vercel Blob
// pairing enables multi-replica deployments, where two replicas
// share the DB + blob store but each holds its OWN
// `KeyedAsyncLock`. Without this module, the following races break
// the protocol:
//
//   1. Concurrent commitPut from two replicas on the same key →
//      both `copy(staging, live)` race (last-write-wins on bytes),
//      `upsertLive` UPSERTs serialize in Postgres (last-write-wins
//      on metadata). The two "last writes" may be different →
//      live row's content_hash / signature don't describe the
//      stored bytes. Silent data corruption.
//   2. Reaper on replica A finds a live blob with no DB row
//      (replica B's `upsertLive` hasn't landed yet — it's between
//      `promoteStagingToLive` and `upsertLive`). A's in-process
//      lock is uncontested; A unlinks the blob; B's upsertLive
//      lands → row points at nothing.
//
// Solution: a TTL-based DB-row mutex held across the entire
// critical section (REST PUT body upload + commit, deleteObject,
// reaper.unlinkLive). Implemented on top of `tryAcquireCommitLock`
// / `releaseCommitLock` on the Handle. Both backends implement the
// same INSERT-or-take-expired semantics so the helper here is
// backend-agnostic.
//
// All lease-time arithmetic happens on the DB server's clock — the
// SQL anchors both `expires_at` and the steal predicate to the
// server's NOW(), NOT the caller's Date.now(). This closes the
// clock-skew steal scenario where a replica with a fast clock
// would read a peer's fresh lease as expired.
//
// The in-process `KeyedAsyncLock` is STILL acquired alongside the
// DB lock — it's free under single-replica load, preserves the
// read-side fd-lifecycle invariants for openLiveReader (which
// doesn't take the DB lock to keep GET latency low), and avoids
// any single-replica race that would surface as a "fail to
// acquire" against ourselves.

import type { Handle } from './store.ts'
import { errMsg, randomId } from '../util.ts'

// Per-process holder id, minted once at module load. Identifies
// THIS process across the cluster; the release predicate uses it
// (WHERE holder = ?) so a crash on one process can't release
// another process's still-valid lease — they wait for TTL.
// 16 bytes random → 22 base64url chars; collision is 1/2^128.
//
// IMPORTANT: same-process callers (e.g. REST PUT, WS DELETE
// handler, and the reaper) share this id. The DB SQL deliberately
// does NOT have a "same-holder transparent refresh" branch —
// otherwise the reaper would silently steal an in-flight REST
// PUT's lock on the same process, defeating the cross-replica
// serialization the lock exists for.
const PROCESS_HOLDER_ID = randomId()

// Tests that simulate multiple replicas in one Node process need
// distinguishable holder ids — pass via the optional `holderId`
// parameter on the helpers below. Production code omits the
// parameter and uses the per-process id.
export function newHolderId(): string {
  return randomId()
}

// Default lease TTL. Tuned for the typical Vercel Function
// execution caps: default 10s, Pro 60s, Pro Max 5min. A 5-min
// lease covers the worst case where a function holds the lock
// for its full allowed runtime; longer is unreachable on Vercel
// because the function would be killed first.
//
// Self-hosted long-running processes (uploads > 5min, e.g. a
// large bundle on a slow link) bump via the env var
// `OBJSTORE_COMMIT_LOCK_LEASE_MS` read in server/index.ts; the
// boot path calls `setDefaultLeaseMs()` here once at start. A
// crashed-held lease without that env override stays
// unrecoverable for at most the lease — shorter is operationally
// better. Graceful shutdown sweeps held leases via
// `releaseAllForThisProcess`, so only SIGKILL / OOM falls back
// to natural TTL.
let defaultLeaseMs = 5 * 60 * 1000

// Boot-time override hook. Setter (not constant) because the env
// var is parsed AFTER this module is imported; called exactly
// once from server/index.ts before any acquire. Tests that need
// a specific lease pass `opts.leaseMs` directly.
//
// A second call with a DIFFERENT value warns — under normal
// operation the module is loaded once per process, so a re-call
// usually signals a test harness re-importing the module after
// state was already established (the second value would silently
// shadow the first for subsequent acquires). Same-value re-calls
// are idempotent no-ops to keep test reloaders quiet.
let defaultLeaseMsSet = false
export function setDefaultLeaseMs(ms: number): void {
  if (!Number.isSafeInteger(ms) || ms <= 0) throw new RangeError(`setDefaultLeaseMs: ${ms} is not a positive integer`)
  if (defaultLeaseMsSet && ms !== defaultLeaseMs) {
    console.warn(`setDefaultLeaseMs called again with a different value (was ${defaultLeaseMs}, now ${ms}); module-level default is being shadowed`)
  }
  defaultLeaseMs = ms
  defaultLeaseMsSet = true
}

// Tracks every (tag, res) this process currently holds a lease
// on, so the shutdown handler can DELETE them in one round-trip
// instead of waiting for natural TTL expiry to free the keys.
// A rolling restart without this leaves every in-flight PUT's
// key pinned for the full lease, visible as 503 contended /
// 410-equivalent until the lease clears.
//
// Set is module-scoped: all production lock acquisitions go
// through `tryAcquireCommitLock` here, so the set + the
// underlying SQL holder are consistent by construction. Tests
// using custom holderIds via opts manage their own state
// (the set tracks PROCESS_HOLDER_ID-held leases only).
const heldKeysForThisProcess = new Set<string>()
function packHeld(tag: string, res: string): string { return `${tag}|${res}` }
function unpackHeld(packed: string): [string, string] {
  const i = packed.indexOf('|')
  return [packed.slice(0, i), packed.slice(i + 1)]
}

export type CommitLock = {
  // The holder id this lease was acquired under — the caller
  // threads it into `commitPut`'s `holder` field so the SQL's
  // `upsertLiveIfHeld` can atomically gate the write on the
  // lease STILL being held by us (server-side clock check). For
  // long-running uploads whose lease silently expired mid-flight,
  // this is the only line of defense against blind metadata
  // overwrite by a racing replica that stole the lease.
  holder: string
  // Releases the lease. Idempotent; safe to call multiple times
  // (e.g. from a `finally` block that also runs on success).
  release(): Promise<void>
}

export type AcquireResult =
  | { ok: true; lock: CommitLock }
  | { ok: false }

// Single-attempt acquire. Returns ok=true with a `release()` handle
// if the lease was taken (new or steal-expired); ok=false if any
// live holder (including this process under a different operation)
// currently holds the key.
//
// Callers MUST `release()` in a finally block. The TTL ensures a
// missed release (process crash) doesn't permanently pin the key.
//
// `opts.holderId` is a test seam — production omits it and the
// process-wide id is used. Tests simulating multiple replicas in
// one Node process pass distinct holder ids per "replica".
export async function tryAcquireCommitLock(
  handle: Handle,
  workspaceTag: string,
  resourceTag: string,
  opts: { leaseMs?: number; holderId?: string } = {},
): Promise<AcquireResult> {
  const leaseMs = opts.leaseMs ?? defaultLeaseMs
  const holderId = opts.holderId ?? PROCESS_HOLDER_ID
  // `leaseMs` is passed twice because the prepared SQL references
  // it in both arms of `INSERT … ON CONFLICT DO UPDATE` and SQLite
  // doesn't let `?N` rebind across them.
  const row = await handle.tryAcquireCommitLock.get(
    workspaceTag, resourceTag, holderId, leaseMs, leaseMs,
  )
  if (!row || row.acquired !== 1) return { ok: false }
  const heldKey = packHeld(workspaceTag, resourceTag)
  if (holderId === PROCESS_HOLDER_ID) heldKeysForThisProcess.add(heldKey)
  let released = false
  return {
    ok: true,
    lock: {
      holder: holderId,
      release: async () => {
        if (released) return
        released = true
        if (holderId === PROCESS_HOLDER_ID) heldKeysForThisProcess.delete(heldKey)
        // Tolerate any backend error during release — the lease
        // will expire naturally via TTL. Logging at the call site
        // is more useful than here (we lack the operation
        // context).
        try { await handle.releaseCommitLock.run(workspaceTag, resourceTag, holderId) }
        catch { /* TTL fallback */ }
      },
    },
  }
}

// Convenience: acquire-or-throw with a typed error so callers can
// branch on "is this a lock contention?" vs other failures. The
// thrown error carries no PII (tags are base64url Ed25519 keys —
// not for operator logs); call sites log only that the lock was
// contended.
export class CommitLockContendedError extends Error {
  constructor() { super('commit-lock-contended'); this.name = 'CommitLockContendedError' }
}

// Try to acquire with bounded server-side wait. Polls the lock at
// jittered intervals up to `waitMs`; returns the lock as soon as
// it's free, or `null` if still contended at the deadline.
// Reduces client-visible contention for the common case where the
// holder finishes within a couple hundred ms; matches the
// REST-PUT critical-section duration for typical small payloads.
export async function tryAcquireCommitLockWithWait(
  handle: Handle,
  workspaceTag: string,
  resourceTag: string,
  opts: { leaseMs?: number; holderId?: string; waitMs?: number } = {},
): Promise<AcquireResult> {
  const waitMs = opts.waitMs ?? 2000
  const deadline = Date.now() + waitMs
  for (;;) {
    const r = await tryAcquireCommitLock(handle, workspaceTag, resourceTag, opts)
    if (r.ok) return r
    const remaining = deadline - Date.now()
    if (remaining <= 0) return r
    // 50–150 ms jittered backoff — short enough to catch a fast
    // commit, long enough to avoid hammering the DB.
    const sleep = 50 + Math.floor(Math.random() * 100)
    await new Promise<void>((resolve) => { setTimeout(resolve, Math.min(sleep, remaining)) })
  }
}

// Run `fn` while holding the lock. Releases on completion (success
// or throw). Throws `CommitLockContendedError` if the lock cannot
// be acquired within `opts.waitMs` (default 2s).
//
// The lock object is passed to `fn` so production write paths can
// extract `lock.holder` and thread it into `commitPut`'s `holder`
// field (gates the atomic `upsertLiveIfHeld` against lease loss
// mid-upload). Read-only / cleanup callers (delete handlers,
// reaper) can ignore the parameter — `fn` is a TS-arity-tolerant
// callback so single-arg `() => Promise<T>` consumers keep working.
export async function withCommitLock<T>(
  handle: Handle,
  workspaceTag: string,
  resourceTag: string,
  fn: (lock: CommitLock) => Promise<T>,
  opts: { leaseMs?: number; holderId?: string; waitMs?: number } = {},
): Promise<T> {
  const acquired = await tryAcquireCommitLockWithWait(handle, workspaceTag, resourceTag, opts)
  if (!acquired.ok) throw new CommitLockContendedError()
  try { return await fn(acquired.lock) }
  finally { await acquired.lock.release() }
}

// Drop every lease this process holds. Called from server/index.ts
// `shutdown()` BEFORE closing the DB so a graceful rolling restart
// doesn't pin keys for the full lease until natural expiry. Errors
// during the per-key DELETE are tolerated (TTL fallback).
//
// The set is cleared either way; this is the LAST thing the
// process does with the lock module.
export async function releaseAllForThisProcess(handle: Handle): Promise<void> {
  const snapshot = [...heldKeysForThisProcess]
  heldKeysForThisProcess.clear()
  if (snapshot.length === 0) return
  // One DELETE WHERE holder = ? covers them all in a single
  // round-trip. The per-key snapshot is only used to size the log
  // line for operator visibility.
  try { await handle.releaseAllCommitLocksFor.run(PROCESS_HOLDER_ID) }
  catch (err) {
    // Fall back to per-key best-effort releases — at least drop
    // any we can before the DB closes.
    console.warn('commit-lock shutdown bulk release failed:', errMsg(err))
    for (const packed of snapshot) {
      const [tag, res] = unpackHeld(packed)
      try { await handle.releaseCommitLock.run(tag, res, PROCESS_HOLDER_ID) } catch {}
    }
  }
}

// Operator visibility: number of leases this process currently
// holds. Exported for the shutdown log line + future metrics.
export function heldLeaseCount(): number { return heldKeysForThisProcess.size }
