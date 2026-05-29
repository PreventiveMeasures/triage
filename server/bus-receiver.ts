// Cross-instance bus receiver: maps a `BusMessage` envelope (lookup
// hint + sender from the Postgres LISTEN/NOTIFY channel) into a local
// wire broadcast. Pulled out of `server/index.ts` so the rev / objput /
// objdel branches — including the keyframe boolean coercion and the
// `objectMetaWire` shape — are testable without bringing up the whole
// server.
//
// The receiver mirrors the publisher's commit→broadcast→publish
// ordering, just shifted by the bus round-trip:
//   1. NOTIFY lands → bus envelope arrives here.
//   2. For hint-only kinds (rev, objput) re-fetch the row from the
//      shared DB; for self-contained kinds (objdel) skip the fetch.
//   3. Broadcast to LOCAL subscribers via `broadcastLocalRaw` with no
//      `except` — the originator is on a DIFFERENT instance by
//      construction, so it must NOT be filtered out (the symmetric
//      same-instance broadcast already happened on the publisher).

import type { Handle as DbHandle } from './db.ts'
import { type Handle as ObjstoreHandle, getLive, objectMetaWire } from './objstore/store.ts'
import type { BusMessage } from './pubsub.ts'

export type BusReceiverDeps = {
  // Read-side of the workspace_revision Handle (the bus uses only
  // `revisionById`; the publisher path uses the full Handle). Typed
  // as the broader Handle for ease of wiring at the call site.
  handle: DbHandle
  // Read-side of the objstore Handle (used for `getLive` on objput).
  objstoreHandle: ObjstoreHandle
  // Local-only fan-out into this instance's subscriber map. The
  // payload is pre-serialised so the hub can stringify once for N
  // subscribers (mirrors the existing `broadcast` fast path).
  broadcastLocalRaw: (tag: string, payload: string) => void
  debug: boolean
}

export function createBusReceiver(deps: BusReceiverDeps): (msg: BusMessage) => Promise<void> {
  const { handle, objstoreHandle, broadcastLocalRaw, debug } = deps
  return async (msg) => {
    if (msg.kind === 'rev') {
      const row = await handle.revisionById.get(msg.tag, msg.id)
      if (!row) {
        // Not found is expected when a peer instance published a
        // revision id that hasn't replicated to this instance yet —
        // shouldn't happen on a single-primary Neon endpoint, but a
        // future read-replica deployment could see it transiently.
        // Drop the broadcast; the client will reconcile via chain
        // re-pull on its next subscribe.
        if (debug) console.warn(`pubsub: revision ${msg.id.slice(0, 8)}… not found for ${msg.tag.slice(0, 12)}…`)
        return
      }
      broadcastLocalRaw(msg.tag, JSON.stringify({
        type: 'workspace-state',
        workspaceTag: msg.tag,
        // Mirror `chainForWire`'s strict-boolean coercion in
        // ./sync-handlers.ts — the DB stores `keyframe` as an integer
        // (0/1) but the wire contract uses strict `=== true`.
        revisions: [{ ...row, keyframe: row.keyframe === 1 }],
      }))
      return
    }
    if (msg.kind === 'objput') {
      const row = await getLive(objstoreHandle, msg.tag, msg.res)
      if (!row) {
        // Possible after a remote put → remote delete sequence where
        // both NOTIFYs landed by the time we processed the put. The
        // subsequent objdel NOTIFY will (or has) drive the right
        // broadcast — skip silently. Also possible under a future
        // read-replica deployment with replication lag.
        if (debug) console.warn(`pubsub: objput ${msg.res.slice(0, 8)}… missing for ${msg.tag.slice(0, 12)}…`)
        return
      }
      // `getLive` returns the CURRENT live row, which may be a strictly
      // NEWER version than the NOTIFY referred to (two closely-spaced
      // puts on one resourceTag arrive with the DB already showing v2
      // for both). Broadcasting v2 twice is sound — client `putHandlers`
      // already absorb same-instance PUT echoes (rest.ts uses
      // `except: null`), so handlers must be idempotent on
      // (resourceTag, version) anyway.
      broadcastLocalRaw(msg.tag, JSON.stringify({
        type: 'objstore-put',
        workspaceTag: msg.tag,
        ...objectMetaWire(row),
      }))
      return
    }
    // 'objdel' — the row is gone from workspace_object post-commit, so
    // the bus payload itself IS the wire data; no DB lookup.
    broadcastLocalRaw(msg.tag, JSON.stringify({
      type: 'objstore-deleted',
      workspaceTag: msg.tag,
      resourceTag: msg.res,
      version: msg.ver,
    }))
  }
}
