// Triage-sync protocol handlers: `workspace-save` and
// `workspace-subscribe`. Built once at boot with the DB handle plus
// the transport / auth / registry primitives it needs; the WS message
// dispatcher in index.ts calls the returned handlers. Kept out of the
// entrypoint so the protocol logic (the save pipeline, the
// subscribe/catch-up path) is one cohesive, testable unit.

import type { IncomingMessage, ServerResponse } from 'node:http'
import { Buffer } from 'node:buffer'
import type { WebSocket } from 'ws'
import { SAVE_ERROR_REASONS, type SaveErrorReason } from '../common/save-error-reason.ts'
import { type Handle, type RevisionRow, chainFrom, commitRevision, revisionExists } from './db.ts'
import { type SaveMsg, type SubscribeMsg, canonicalSave, computeRevisionIdFromCanonical, verifyEd25519, verifySubscribeSig } from './sign.ts'
import { MAX_CIPHERTEXT_LEN, MAX_FIELD_LEN, validCiphertextShape, validNonce, validTagSigBase } from './validation.ts'
import { debugTag } from './util.ts'
import type { UnauthorizedContext } from './auth.ts'

// Wire shape `chainForWire` produces from a `chainFrom` row, with
// `keyframe` normalised from the SQLite INTEGER 0/1 to a strict boolean.
type WireRevision = {
  base: string | null
  id: string
  keyframe: boolean
  nonce: string
  ciphertext: string
  signature: string
}

// Structured result of the shared save pipeline (`commitSave`), rendered
// per transport: WS → protocol frames; REST → JSON + HTTP status.
type SaveOutcome =
  | { kind: 'rejected' }                                   // malformed / bad sig → WS drop / REST 400
  | { kind: 'ack'; id: string; base: string | null }       // committed → save-ack / 200
  | { kind: 'duplicate'; id: string; base: string | null } // replay → ack-only / 200
  | { kind: 'too-large'; base: string | null }             // ciphertext over cap → save-error / 413
  | { kind: 'unauthorized'; base: string | null }          // new-workspace gate → unauthorized / 401
  | { kind: 'stale-base'; base: string | null; revisions: WireRevision[] } // conflict → state+error / 409

// Hard cap on a `POST /api/sync/save` JSON body. The save frame is the small
// fields + a base64 ciphertext capped at MAX_CIPHERTEXT_LEN (2 MiB); 4 MiB
// (the WS plane's maxPayload / the SSE plane's maxBodyBytes) leaves headroom
// for the envelope so the in-pipeline size policy — not the reader — decides
// `too-large`. Bounds the read so a hostile client can't stream an unbounded
// body into memory before the parse.
const SAVE_BODY_MAX = 4 * 1024 * 1024

// Read a JSON request body up to `SAVE_BODY_MAX`, returning the parsed value
// or null on overflow / parse failure / read error (mirrors the objstore
// mint reader). The REST save body is the only body this module reads.
async function readSaveBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let total = 0
  try {
    for await (const chunk of req) {
      const buf = chunk as Buffer
      total += buf.length
      if (total > SAVE_BODY_MAX) return null
      chunks.push(buf)
    }
  } catch { return null }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  catch { return null }
}

function respondJson(res: ServerResponse, status: number, obj: object): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(obj))
}

export type SyncHandlersDeps = {
  handle: Handle
  send: (socket: WebSocket, msg: object) => void
  broadcast: (tag: string, msg: object, except: WebSocket | null) => void
  // Cross-instance pub/sub for live broadcasts. Fired alongside the
  // local `broadcast` after a successful commit so peers on OTHER
  // server instances see the new revision in real time. Carries only
  // `(tag, revisionId)` — the receiver re-fetches the row from
  // workspace_revision because the ciphertext can exceed the bus's
  // payload budget. Optional: a SQLite deployment passes a no-op.
  publishRevision: (tag: string, revisionId: string) => void
  subscribe: (socket: WebSocket, tag: string) => void
  getNonce: (socket: WebSocket) => string | undefined
  requiresAuth: (socket: WebSocket) => boolean
  // Whether an operator password is configured. The REST save plane's
  // new-workspace gate (it has no socket to read operator-auth state from)
  // collapses to `passwordConfigured && workspace-new` — the socket-less
  // analog of `requiresAuth`, matching the objstore `restPutGate`.
  passwordConfigured: boolean
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
  // Session-independent REST save plane (`POST /api/sync/save`), wired into
  // the HTTP dispatcher in server-e2e/http.ts. Runs the same pipeline as
  // `handleSave` and renders the outcome as a JSON response.
  handleSaveRest: (req: IncomingMessage, res: ServerResponse) => Promise<void>
  handleSubscribe: (socket: WebSocket, msg: SubscribeMsg) => Promise<void>
  // Exported because the dispatcher's inflight-cap `busy` NACK path
  // emits a save-error too (the only emit site outside this module).
  sendSaveError: (socket: WebSocket, workspaceTag: string, base: string | null, reason: SaveErrorReason) => void
}

export function createSyncHandlers(deps: SyncHandlersDeps): SyncHandlers {
  const { handle, send, broadcast, publishRevision, subscribe, getNonce, requiresAuth, passwordConfigured, sendUnauthorized, workspaceExists, objstoreResources, debug } = deps

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

  // Normalise `keyframe` to a strict boolean on outbound chain entries.
  // SQLite stores the column as INTEGER (0/1) and `chainFrom` returns
  // raw rows; the wire contract (and canonical signing payload) uses
  // strict `=== true`. Convert once on the send side — forwarding the
  // integer relies on clients coercing via `Boolean()` before rebuilding
  // canonical bytes, fragile against any client that strict-compares.
  function chainForWire(revisions: RevisionRow[]): WireRevision[] {
    return revisions.map((r) => ({ ...r, keyframe: r.keyframe === 1 }))
  }

  // Transport-agnostic save pipeline, shared by the WS `handleSave` renderer
  // and the REST `handleSaveRest` renderer. Runs the full validate → precheck
  // → sig-verify → size/auth gates → commit → broadcast pipeline and returns a
  // structured `SaveOutcome` the caller renders for its transport. Two params
  // abstract the transport:
  //   - `authRequired`: the new-workspace gate decision (WS: requiresAuth(
  //     socket); REST: passwordConfigured — a REST request can't be operator-
  //     authorised, so the gate collapses to "password set AND workspace new").
  //   - `except`: the broadcast exclusion — the originating socket on the WS
  //     path (so it isn't echoed its own save), or null on the REST path (the
  //     request isn't a subscriber socket; the originator's own echo lands on
  //     its subscription stream and is an idempotent no-op — applyChainToBase
  //     skips a revision whose id already equals the client's baseRevision,
  //     and a same-content re-apply converges. Matches objstore-deleted's
  //     `except: null`).
  async function commitSave(msg: SaveMsg, authRequired: boolean, except: WebSocket | null): Promise<SaveOutcome> {
    // `base` is `string | null`; null is the keyframe-root marker.
    if (!validTagSigBase(msg.workspaceTag, MAX_FIELD_LEN) || !validNonce(msg.nonce, MAX_FIELD_LEN) || !validCiphertextShape(msg.ciphertext) || !validTagSigBase(msg.signature, MAX_FIELD_LEN) || (msg.base != null && !validTagSigBase(msg.base, MAX_FIELD_LEN))) return { kind: 'rejected' }
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
    //      lock. See `commitRevisionSqlite` / `tryCommitNeon` in db*.ts.
    let canonical: Uint8Array<ArrayBuffer>
    try { canonical = canonicalSave(msg) } catch { return { kind: 'rejected' } }
    const id = await computeRevisionIdFromCanonical(canonical)
    const tag = msg.workspaceTag
    const baseNorm = msg.base ?? null
    if (await revisionExists(handle, tag, id)) {
      if (debug) console.log(`save (precheck dup ${id.slice(0, 8)}…) → ack-only`)
      return { kind: 'duplicate', id, base: baseNorm }
    }
    if (!await verifyEd25519(tag, canonical, msg.signature)) {
      if (debug) console.warn('reject save: bad signature', debugTag(tag))
      return { kind: 'rejected' }
    }
    // Size policy — emit an explicit error so the client can surface
    // the failure to the user. Without this, an oversized save hangs
    // forever in the client's `pending` slot (no ack, no rebase).
    if (msg.ciphertext.length > MAX_CIPHERTEXT_LEN) {
      if (debug) console.warn(`reject save: ciphertext too large (${msg.ciphertext.length} > ${MAX_CIPHERTEXT_LEN})`)
      return { kind: 'too-large', base: baseNorm }
    }
    // Auth gate for the FIRST action against a workspace tag that
    // doesn't yet exist on the server. Checked AFTER sig verify so the
    // `unauthorized` outcome only reaches a legitimate signer; shape /
    // sig attacks still drop silently. The TOCTOU between `workspaceExists`
    // and the commit's gated INSERT is an accepted soft-policy race — a
    // racer still had to produce a valid Ed25519 signature (= holds the
    // seed). Same gate the objstore put-begin applies.
    if (authRequired && !await workspaceExists(tag)) {
      if (debug) console.warn(`reject save: unauthorized (new workspace ${debugTag(tag)})`)
      return { kind: 'unauthorized', base: baseNorm }
    }
    // Save does NOT subscribe the sender — that would be a replay vector
    // (a captured frame replayed from any connection would attach as a
    // subscriber without holding the seed). Explicit `workspace-subscribe`
    // (signs the per-connection nonce) is the ONLY attach path. Round-9 H1.
    //
    // `keyframe === true` is what canonicalSave bound the signature to
    // (strict equality); the signer's intent is unambiguous here.
    const keyframe = msg.keyframe === true
    const commit = await commitRevision(handle, {
      tag, id, base: baseNorm, keyframe,
      nonce: msg.nonce, ciphertext: msg.ciphertext, signature: msg.signature,
    })
    if (commit.kind === 'duplicate') {
      if (debug) console.log(`save (duplicate id ${id.slice(0, 8)}…) → ack-only`)
      return { kind: 'duplicate', id, base: baseNorm }
    }
    if (commit.kind === 'stale-base') {
      // Client claimed a base that's no longer head. The catch-up chain is
      // computed OUTSIDE any lock — a concurrent commit landing here only
      // means the catch-up is fresher (benign; clients tolerate extra
      // revisions). The WS renderer sends `workspace-state` (catch-up) FIRST
      // then the typed `stale-base` error; the REST renderer returns the
      // chain in the 409 body. Either way the catch-up clears the client's
      // pending and the error is a no-op on the now-missing pending (a
      // recoverable race — client rebases + re-saves).
      //
      // The catch-up CAN be empty: a client holding a base from a chain
      // this deployment no longer has (wiped / moved DB, SQLite→Neon
      // migration — head=null, no keyframe, no rows) gets `revisions: []`.
      // The client detects that shape (pending survives the catch-up) and
      // answers with a full-state push re-anchored at base=null, which
      // commits as the new chain root — see the client's
      // `handleSaveError` stale-base branch.
      const revisions = chainForWire(await chainFrom(handle, tag, baseNorm))
      if (debug) console.log(`save (stale base ${baseNorm} vs head ${commit.head}) → chain ${revisions.length}`)
      return { kind: 'stale-base', base: baseNorm, revisions }
    }
    if (debug) console.log(`save${keyframe ? ' [keyframe]' : ''} → revision ${id.slice(0, 8)}… for ${debugTag(tag)}`)
    // Carry `keyframe` as a strict boolean on the broadcast wire — peers
    // strict-compare `=== true` (matching the canonical-payload contract).
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
    }, except)
    // Cross-instance fan-out. The bus payload carries only the revision id —
    // peers on OTHER instances re-fetch the row. SQLite mode passes a no-op;
    // Neon mode publishes via pg_notify. Best-effort.
    publishRevision(tag, id)
    return { kind: 'ack', id, base: baseNorm }
  }

  // WS renderer: run the shared pipeline against this socket and render the
  // outcome as the protocol frames the client expects on its stream. A
  // `rejected` outcome drops silently (matches the prior malformed/bad-sig
  // behaviour). For every non-rejected outcome the tag was validated inside
  // `commitSave`, so the cast to string is sound.
  async function handleSave(socket: WebSocket, msg: SaveMsg): Promise<void> {
    const outcome = await commitSave(msg, requiresAuth(socket), socket)
    if (outcome.kind === 'rejected') return
    const tag = msg.workspaceTag as string
    if (outcome.kind === 'unauthorized') { sendUnauthorized(socket, { kind: 'gated', workspaceTag: tag, base: outcome.base }); return }
    if (outcome.kind === 'too-large') { sendSaveError(socket, tag, outcome.base, 'too-large'); return }
    if (outcome.kind === 'stale-base') {
      // State FIRST (its handler clears pending), then the typed error.
      send(socket, { type: 'workspace-state', workspaceTag: tag, revisions: outcome.revisions })
      sendSaveError(socket, tag, outcome.base, 'stale-base')
      return
    }
    // ack | duplicate
    send(socket, { type: 'workspace-save-ack', workspaceTag: tag, base: outcome.base, id: outcome.id })
  }

  // REST renderer: the session-independent `POST /api/sync/save` plane. Reads
  // the save frame from the JSON body, runs the SAME pipeline (no socket;
  // new-workspace gate = passwordConfigured; broadcast except = null), and
  // maps the outcome to a JSON + HTTP status the client switches on. SSE-mode
  // clients POST here so a save doesn't take over their event-stream; a 401
  // routes them to the in-band frame (which runs the operator auth flow).
  // Mounted + gated (same-origin, shutdown, idle-timeout) in server-e2e/http.ts.
  async function handleSaveRest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readSaveBody(req)
    if (!body || typeof body !== 'object') { respondJson(res, 400, { reason: 'bad-request' }); return }
    const outcome = await commitSave(body as SaveMsg, passwordConfigured, null)
    if (outcome.kind === 'ack' || outcome.kind === 'duplicate') { respondJson(res, 200, { ok: true, id: outcome.id }); return }
    if (outcome.kind === 'stale-base') { respondJson(res, 409, { reason: 'stale-base', revisions: outcome.revisions }); return }
    if (outcome.kind === 'too-large') { respondJson(res, 413, { reason: 'too-large' }); return }
    if (outcome.kind === 'unauthorized') { respondJson(res, 401, { reason: 'unauthorized' }); return }
    respondJson(res, 400, { reason: 'bad-request' })
  }

  async function handleSubscribe(socket: WebSocket, msg: SubscribeMsg): Promise<void> {
    // Mirror handleSave's wire gate: length-cap + base64url-alphabet on
    // workspaceTag / signature / from BEFORE canonicalSubscribe UTF-8-
    // encodes them and verifyEd25519 base64-decodes the signature.
    // Without it a peer can submit up-to-maxPayload strings and force
    // O(n) encode + decode per subscribe before the 32/64-byte length
    // gates reject — a CPU-DoS surface handleSave is already hardened
    // against. `from` keeps the `string | null` contract (null = full-
    // chain catch-up); a legit signer's `from` is a base64url revision
    // id, so any non-string / over-long / wrong-alphabet value can't be
    // one the signature was computed over, and the chain-lookup path
    // (`typeof msg.from === 'string' ? msg.from : null`) still treats a
    // null / absent `from` as the keyframe-fallback.
    if (!validTagSigBase(msg.workspaceTag, MAX_FIELD_LEN) || !validTagSigBase(msg.signature, MAX_FIELD_LEN) || (msg.from != null && !validTagSigBase(msg.from, MAX_FIELD_LEN))) return
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
    // Returns [] for a triage-only workspace. A failing inventory
    // lookup must NOT sink the subscribe — degrade to an empty snapshot
    // (broadcasts will fill it in) so the ack + chain still go out.
    let resources: object[] = []
    try { resources = await objstoreResources(tag) }
    catch (err) { if (debug) console.warn('subscribe: objstore inventory lookup failed', debugTag(tag), err) }
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

  return { handleSave, handleSaveRest, handleSubscribe, sendSaveError }
}
