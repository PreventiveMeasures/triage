// Triage-sync protocol handlers: `workspace-save` and
// `workspace-subscribe`. Built once at boot with the DB handle plus
// the transport / auth / registry primitives it needs; the WS message
// dispatcher in index.ts calls the returned handlers. Kept out of the
// entrypoint so the protocol logic (the save pipeline, the
// subscribe/catch-up path) is one cohesive, testable unit.

import type { WebSocket } from 'ws'
import { SAVE_ERROR_REASONS, type SaveErrorReason } from '../common/save-error-reason.ts'
import { type Handle, type RevisionRow, chainFrom, commitRevision, revisionExists } from './db.ts'
import { type SaveMsg, type SubscribeMsg, canonicalSave, computeRevisionIdFromCanonical, verifyEd25519, verifySubscribeSig } from './sign.ts'
import { MAX_CIPHERTEXT_LEN, MAX_FIELD_LEN, validCiphertextShape, validNonce, validTagSigBase } from './validation.ts'
import { debugTag } from './util.ts'
import type { UnauthorizedContext } from './auth.ts'

// `chainForWire` accepts the row shape from `chainFrom` (where
// `keyframe` is the SQLite INTEGER 0 / 1) and returns the same fields
// with `keyframe` normalised to a strict boolean for the wire.
type WireRevision = {
  base: string | null
  id: string
  keyframe: boolean
  nonce: string
  ciphertext: string
  signature: string
}

export type SyncHandlersDeps = {
  handle: Handle
  send: (socket: WebSocket, msg: object) => void
  broadcast: (tag: string, msg: object, except: WebSocket | null) => void
  subscribe: (socket: WebSocket, tag: string) => void
  getNonce: (socket: WebSocket) => string | undefined
  requiresAuth: (socket: WebSocket) => boolean
  sendUnauthorized: (socket: WebSocket, ctx: UnauthorizedContext) => void
  workspaceExists: (tag: string) => Promise<boolean>
  // Objstore inventory snapshot for a workspace tag, as wire rows. The
  // `workspace-subscribed` ack carries it. Injected — the objstore store
  // has its own richer `Handle`, so index.ts wires `listLive(
  // objstoreHandle, tag).then(rows => rows.map(objectMetaWire))` rather
  // than coupling this module to that store type. Returns [] for a
  // triage-only tag.
  objstoreResources: (tag: string) => Promise<object[]>
  debug: boolean
}

export type SyncHandlers = {
  handleSave: (socket: WebSocket, msg: SaveMsg) => Promise<void>
  handleSubscribe: (socket: WebSocket, msg: SubscribeMsg) => Promise<void>
  // Exported because the dispatcher's inflight-cap `busy` NACK path
  // emits a save-error too (the only emit site outside this module).
  sendSaveError: (socket: WebSocket, workspaceTag: string, base: string | null, reason: SaveErrorReason) => void
}

export function createSyncHandlers(deps: SyncHandlersDeps): SyncHandlers {
  const { handle, send, broadcast, subscribe, getNonce, requiresAuth, sendUnauthorized, workspaceExists, objstoreResources, debug } = deps

  // Typed wrapper for the three `workspace-save-error` emit sites
  // (too-large at handleSave, stale-base after the catch-up, busy at
  // the inflight-cap drop). Forces `reason` to be a member of
  // `SaveErrorReason` so a typo or a server-side addition that didn't
  // update `common/save-error-reason.ts` fails at compile time rather
  // than turning into a wire-level surprise. The shared taxonomy is
  // pinned by `tests/save-error-reason-taxonomy.test.js`.
  function sendSaveError(
    socket: WebSocket,
    workspaceTag: string,
    base: string | null,
    reason: SaveErrorReason,
  ): void {
    // Runtime guard alongside the compile-time `SaveErrorReason` union —
    // covers the case where the `reason` argument is a variable (not a
    // string literal) and TS's narrowing can't enforce taxonomy
    // membership at the call site. Throws because a server emitting a
    // typo'd reason would be a wire-protocol break the client can't
    // recover from; better to fail fast in the test suite than to
    // silently land bytes the client coerces to `'rejected'`.
    if (!SAVE_ERROR_REASONS.has(reason)) {
      throw new Error(`sendSaveError: reason '${reason}' is not in SAVE_ERROR_REASONS — update common/save-error-reason.ts`)
    }
    send(socket, { type: 'workspace-save-error', workspaceTag, base, reason })
  }

  // Normalise `keyframe` on outbound chain entries to a strict boolean.
  // SQLite stores the column as INTEGER (0/1) and `chainFrom` returns
  // raw rows; the wire contract (and the canonical signing payload)
  // uses strict `=== true` to mark keyframes. Forwarding the integer
  // shape works only because every shipping client coerces via
  // `Boolean(rev.keyframe)` before reconstructing the canonical bytes —
  // fragile if a future client (or test harness) ever strict-compares.
  // Convert once on the send side.
  function chainForWire(revisions: RevisionRow[]): WireRevision[] {
    return revisions.map((r) => ({ ...r, keyframe: r.keyframe === 1 }))
  }

  async function handleSave(socket: WebSocket, msg: SaveMsg): Promise<void> {
    // `base` is `string | null`; null is the keyframe-root marker.
    if (!validTagSigBase(msg.workspaceTag, MAX_FIELD_LEN) || !validNonce(msg.nonce, MAX_FIELD_LEN) || !validCiphertextShape(msg.ciphertext) || !validTagSigBase(msg.signature, MAX_FIELD_LEN) || (msg.base != null && !validTagSigBase(msg.base, MAX_FIELD_LEN))) return
    // Compute canonical bytes + content-addressed id ONCE, then thread
    // both through the precheck → sig verify → commit pipeline:
    //   1. canonicalSave (sync, throws on lone-surrogate input)
    //   2. SHA-256 → id
    //   3. precheck: revisionExists → short-circuit ack on replay
    //      (skips Ed25519 verify; closes the round-9 H1 CPU-DoS vector
    //      where a passive observer floods captured saves)
    //   4. verifyEd25519 against the SAME canonical bytes the id was
    //      hashed from — provably tied
    //   5. ciphertext size policy (post-sig so the explicit error only
    //      reaches a legit signer)
    //   6. commitRevision — re-checks dup + base + inserts via a single
    //      gated INSERT (dup gate + head-equals-base gate + the
    //      server-assigned seq folded into one statement) — NO write
    //      lock. The dup recheck, headFor, base-match and insert all
    //      collapse into that one statement, whose head-check and
    //      MAX(seq) read one snapshot; the `UNIQUE(workspace_tag, seq)`
    //      PK rejects any racer that computed the same seq. So two
    //      concurrent saves with the same `base` and different ids
    //      can't both insert (the loser's `head IS base` gate fails →
    //      `stale-base`, no chain fork even though UNIQUE is on id, not
    //      base), and two concurrent same-id retransmits resolve to one
    //      `inserted` + one `duplicate` with no UNIQUE throw escaping.
    //      See `commitRevisionSqlite` / `tryCommitNeon` in db*.ts.
    let canonical: Uint8Array<ArrayBuffer>
    try { canonical = canonicalSave(msg) } catch { return }
    const id = await computeRevisionIdFromCanonical(canonical)
    const tag = msg.workspaceTag
    if (await revisionExists(handle, tag, id)) {
      if (debug) console.log(`save (precheck dup ${id.slice(0, 8)}…) → ack-only`)
      send(socket, { type: 'workspace-save-ack', workspaceTag: tag, base: msg.base ?? null, id })
      return
    }
    if (!await verifyEd25519(tag, canonical, msg.signature)) {
      if (debug) console.warn('reject save: bad signature', debugTag(tag))
      return
    }
    // Size policy — emit an explicit error so the client can surface
    // the failure to the user. Without this, an oversized save hangs
    // forever in the client's `pending` slot (no ack, no rebase).
    if (msg.ciphertext.length > MAX_CIPHERTEXT_LEN) {
      if (debug) console.warn(`reject save: ciphertext too large (${msg.ciphertext.length} > ${MAX_CIPHERTEXT_LEN})`)
      sendSaveError(socket, tag, msg.base == null || typeof msg.base !== 'string' ? null : msg.base, 'too-large')
      return
    }
    // Auth gate for the FIRST action against a workspace tag that
    // doesn't yet exist on the server (no rows in workspace_revision
    // AND none in workspace_object). Once any row lands, the workspace
    // is established and every signed action flows freely — access
    // control falls back to the Ed25519 signature for the rest of the
    // workspace's lifetime. Checked AFTER sig verify so the
    // `unauthorized` frame only reaches a legitimate signer; shape /
    // sig attacks still drop silently.
    //
    // RACE: `workspaceExists` reads at a different moment than the
    // commit's gated INSERT (a plain TOCTOU — there is no lock spanning
    // the two). Under concurrent saves on a fresh tag, an
    // unauthenticated socket whose `workspaceExists` observes "true"
    // (because an authenticated peer's commit landed between this
    // socket's check and its commit) skips the gate and commits as the
    // second writer. Accepted: the unauthenticated peer still had to
    // produce a valid Ed25519 signature (= holds the workspace seed),
    // and "two concurrent writes both authorising" is the worst case.
    // Tightening would require folding the gate into the commit
    // statement itself and is not worth the layer crossing for the
    // soft-policy guarantee.
    if (requiresAuth(socket) && !await workspaceExists(tag)) {
      if (debug) console.warn(`reject save: unauthorized (new workspace ${debugTag(tag)})`)
      sendUnauthorized(socket, { kind: 'gated', workspaceTag: tag, base: msg.base ?? null })
      return
    }
    // NOTE: Earlier revisions auto-subscribed the sending socket here.
    // That created a replay vector — a passive observer who captured
    // any single valid `workspace-save` frame could replay it from any
    // TCP connection forever to attach as a subscriber and silently
    // mirror every future encrypted broadcast for the workspace,
    // without ever holding the seed (the duplicate-id path returns
    // ack-only and doesn't reject the socket). Audit round-9 H1.
    //
    // The legitimate client always sends an explicit
    // `workspace-subscribe` (see `trySendSubscribe` in
    // `client/triage-sync.js` — fires on key derivation, on socket
    // open, on continuity-break recovery, on dismissError). The
    // subscribe path remains the only way to attach as a subscriber.
    const baseNorm = msg.base ?? null
    // `keyframe === true` is what canonicalSave bound the signature to
    // (strict equality); the signer's intent is unambiguous here.
    const keyframe = msg.keyframe === true
    const commit = await commitRevision(handle, {
      tag, id, base: baseNorm, keyframe,
      nonce: msg.nonce, ciphertext: msg.ciphertext, signature: msg.signature,
    })
    if (commit.kind === 'duplicate') {
      if (debug) console.log(`save (duplicate id ${id.slice(0, 8)}…) → ack-only`)
      send(socket, { type: 'workspace-save-ack', workspaceTag: tag, base: baseNorm, id })
      return
    }
    if (commit.kind === 'stale-base') {
      // Client claimed a base that's no longer head. Catch-up chain is
      // computed OUTSIDE the lock — a concurrent commit landing between
      // lock-release and `chainFrom` only means the catch-up is fresher
      // than the recheck saw, which is benign (clients tolerate extra
      // revisions in the chain).
      //
      // Wire order: send `workspace-state` (catch-up) FIRST, then the
      // typed `workspace-save-error { reason: 'stale-base' }`. The
      // catch-up's handler clears `session.pending`; the subsequent
      // error frame's `handleSaveError` then early-returns on the
      // missing pending and does NOT mark the session errored — exactly
      // what we want, since stale-base is a recoverable race (client
      // rebases + re-saves). The typed frame is for protocol clarity
      // (debug surfaces / explicit rejection signal), not for triggering
      // an error transition. Audit follow-up to round-15 —
      // `sync-server-races.test.js:1105`.
      const revisions = chainForWire(await chainFrom(handle, tag, baseNorm))
      if (debug) console.log(`save (stale base ${baseNorm} vs head ${commit.head}) → chain ${revisions.length}`)
      send(socket, { type: 'workspace-state', workspaceTag: tag, revisions })
      sendSaveError(socket, tag, baseNorm, 'stale-base')
      return
    }
    if (debug) console.log(`save${keyframe ? ' [keyframe]' : ''} → revision ${id.slice(0, 8)}… for ${debugTag(tag)}`)
    send(socket, {
      type: 'workspace-save-ack',
      workspaceTag: tag,
      base: baseNorm,
      id,
    })
    // Carry `keyframe` as a strict boolean on the broadcast wire —
    // peers strict-compare `=== true` (matching the canonical-payload
    // contract). The previous shape emitted `keyframe ? 1 : 0` which a
    // strict check would treat as non-keyframe, making a replayed
    // keyframe look like a regular delta on broadcast paths even though
    // the chain-fetch path (chainFrom → SQLite integer) DID round-trip
    // correctly.
    broadcast(tag, {
      type: 'workspace-state',
      workspaceTag: tag,
      revisions: [{
        base: baseNorm,
        id,
        keyframe,
        nonce: msg.nonce,
        ciphertext: msg.ciphertext,
        signature: msg.signature,
      }],
    }, socket)
  }

  async function handleSubscribe(socket: WebSocket, msg: SubscribeMsg): Promise<void> {
    if (typeof msg.workspaceTag !== 'string') return
    // Same `string | null` contract as `base` in handleSave. The signed
    // canonical uses `String(from)`, but the chain-lookup path
    // (`typeof msg.from === 'string' ? msg.from : null`) treats every
    // non-string as null — so a legit signer sending `from: { … }`
    // would silently take the keyframe-fallback path even though the
    // signature was over a different canonical shape. Reject at the
    // wire gate.
    if (msg.from != null && typeof msg.from !== 'string') return
    // The challenge nonce we issued on this socket is bound into the
    // signed canonical, blocking cross-connection replay of a captured
    // subscribe frame. A subscribe arriving before we sent the
    // challenge (impossible from the legitimate client) has no nonce to
    // verify against — drop. Audit round-9 H2.
    const nonce = getNonce(socket)
    if (typeof nonce !== 'string') return
    const ok = await verifySubscribeSig(msg, nonce)
    if (!ok) {
      if (debug) console.warn('reject subscribe: bad signature', debugTag(msg.workspaceTag))
      return
    }
    // Bail if the socket closed during the verify await. The close
    // handler's `unsubscribeAll(socket)` already ran (when there was
    // nothing to remove yet), and `subscribe()` below would add the
    // dead socket to `subscribers[tag]` — a permanent leak: broadcasts
    // no-op via `send`'s readyState gate, but the Set entry pins the
    // socket reference past close, blocking GC. Audit round-12.
    if (socket.readyState !== socket.OPEN) {
      if (debug) console.warn('reject subscribe: socket closed mid-verify', debugTag(msg.workspaceTag))
      return
    }
    const tag = msg.workspaceTag
    subscribe(socket, tag)
    // Explicit ack — distinguishes "the server processed my subscribe
    // and registered me as a peer" from "the WebSocket is open". A
    // client that sent a malformed / bad-sig subscribe never gets this;
    // a client that did gets one before the chain arrives. Lets the UI
    // surface a `connecting → online` transition based on real handshake
    // completion, not just socket state.
    //
    // The ack also carries the objstore inventory snapshot: the same
    // subscribe that registers this socket for objstore-put / -deleted
    // broadcasts seeds the client's initial inventory in one handshake.
    // The client keeps it live thereafter from those broadcasts.
    // Returns [] for a triage-only workspace.
    const resources = await objstoreResources(tag)
    send(socket, { type: 'workspace-subscribed', workspaceTag: tag, resources })
    // `from` is the last revision id the client claims to have applied —
    // now a base64url string, not an integer. We send only revisions
    // after that. Client lying about `from` just means they get a
    // smaller catch-up — their subsequent saves will reveal stale state
    // on the usual base-mismatch path. Null / missing → full chain.
    const fromId = typeof msg.from === 'string' ? msg.from : null
    const revisions = chainForWire(await chainFrom(handle, tag, fromId))
    if (debug) console.log(`subscribe ${debugTag(tag)} from=${fromId?.slice(0, 8) ?? 'null'} → chain ${revisions.length}`)
    send(socket, { type: 'workspace-state', workspaceTag: tag, revisions })
  }

  return { handleSave, handleSubscribe, sendSaveError }
}
