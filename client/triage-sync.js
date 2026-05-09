import { state } from './state.js'
import { saveTriage } from './triage.js'
import { listWorkspaces } from './workspaces.js'
import {
  buildAad,
  computeRevisionId,
  decryptJson,
  deriveSessionKey,
  deriveSigningKeypair,
  encryptJson,
  signSavePayload,
  signSubscribePayload,
  verifySavePayload,
} from './sync-crypto.js'

// Triage sync — per-workspace WebSocket protocol with revision-tracked
// changesets. Disabled by default. `setServerUrl(url)` enables; the
// saved URL also persists in localStorage for next page-load. With
// no URL the session machinery still tracks state internally but no
// message is ever sent — flipping the URL on later resumes from the
// live local state.
//
// Layered design
// --------------
// `notify()` is the only public mutation hook. It's called at the
// tail of `saveTriage()` (so every UI / API mutation routes through
// it) and reads the current `state.markers` / `.deletedIds` /
// `.comments` for the workspace's id scope to derive `localState`.
//
// The session keeps three triage objects (each a plain
// `{ id: { color?, deleted?, comment? } }` map):
//   baseState     last server-acknowledged state.
//   localState    user's current view (= baseState + their edits
//                 since the last ack).
// A changeset between two states is `{ id: entry | null }` where
// `null` means "drop this id". `applyChangeset` and `computeChangeset`
// are pure helpers that translate between state form and changeset
// form; the wire layer never sees a full state, only changesets.
//
// Wire shape
// ----------
//   client → server  workspace-save       { workspaceTag, base,
//                                            keyframe?, nonce,
//                                            ciphertext, signature }
//   client → server  workspace-subscribe  { workspaceTag, from, signature }
//   server → client  workspace-subscribed { workspaceTag }
//   server → client  workspace-save-ack   { workspaceTag, base, id }
//   server → client  workspace-state      { workspaceTag, revisions:
//                                            [{ base, id, keyframe,
//                                               nonce, ciphertext,
//                                               signature }, ...] }
//
// The `keyframe` flag promotes a save's ciphertext from "delta
// against base" to "full state" — the client emits one every
// `keyframeInterval` non-keyframe revisions, and the server uses
// it as the catch-up root for `from=null` subscribers. Bound into
// the signed canonical bytes (see sync-crypto.js's
// `canonicalSavePayload`), so the wire flag MUST match the signed
// flag — the server can't relabel a normal save as a keyframe.
//
// `workspace-subscribed` is sent right after the server registers
// the client as a peer for the workspace; `workspace-state` (with
// the catch-up chain) follows. The ack lets the client distinguish
// "WS open" from "subscribe accepted" — the latter is what
// determines whether broadcasts will actually reach us.
//
// `workspaceTag` is the base64url-encoded Ed25519 public key derived
// from the workspace's private key + UUID — see sync-crypto.js's
// `deriveSigningKeypair`. The server uses it to route messages and
// to verify each save's `signature` before accepting it as a
// revision. Receivers verify the same way. Holders of the workspace's
// private key are the authorized writers; everyone else fails the
// signature check.
//
// `workspace-save-ack` confirms that the client's pending save with
// `base` was accepted as revision `id`. The client already holds the
// changeset (it's `pending.changeset`), so the ack only carries
// metadata.
//
// `workspace-state` is a chain the client applies in order — used for
// initial sync (the first server response when client base=null),
// broadcasts of other clients' changes, and stale-base catch-ups
// after a rejected save. Each revision carries `base` so the client
// can verify continuity. If the client has a `pending` save when a
// chain arrives, that save is treated as rejected: pending.changeset
// is recomputed against the new baseState (preserving the user's
// intent) and re-sent.
//
// Race protocol
// -------------
// One in-flight request per session. Local edits during inFlight
// raise `pendingSave` and flush on the next reply. Every chain /
// ack rebases: the user's overlay (= localState - baseState) is
// captured before swapping baseState, and re-applied after, so
// unsynced edits survive any server push.

const STORAGE_KEY = 'deepview.triageSyncUrl'
// Persisted user toggle — flips between true / false when the user
// clicks the sidebar status button (or via the public API). Stored
// separately from the URL so toggling sync off doesn't forget the
// configured endpoint. Default true: an unconfigured user starts
// "ready to sync the moment a URL exists".
const USER_ENABLED_KEY = 'deepview.sync.userEnabled'
// Per-workspace sync state — `{ [workspaceId]: { serverUrl,
// baseRevision, baseState } }`. Scoped by `serverUrl` because
// revision IDs are per-server: switching to a different relay
// invalidates whatever revision history the previous one assigned.
// Stored as one JSON blob (single localStorage key) for simplicity;
// per-workspace keys would scale better at the cost of enumeration.
//
// Bumped from `deepview.sync.sessions` when revision IDs switched
// from server-assigned integers to client-derived content hashes —
// old persisted entries' integer `baseRevision` is meaningless to
// the new chain check, so a clean key drops them. The `init` block
// at the bottom of this file removes the old key on load to free
// the space.
const SESSION_STATE_KEY = 'deepview.sync.sessions.v2'
const SESSION_STATE_KEY_LEGACY = 'deepview.sync.sessions'
const SESSION_ID_RE = /^\d+$/u

// UI redraw hook — installed once at app boot by ui/view.js so this
// module doesn't need to import from the rendering layer (would be
// the wrong direction: client → ui). Defaults to a no-op so a
// triage-sync update outside a UI context (tests, console scripts)
// doesn't blow up.
let redraw = () => {}

let serverUrl = ''
// User-driven enable/disable, persisted. The sidebar status button
// flips this on click. Distinct from `serverUrl` so toggling doesn't
// drop the configured endpoint; the user can turn sync off and back
// on without re-typing.
let userEnabled = true
// Runtime gate driven by the sidebar's visibility logic — when the
// status button can't be seen (no usable URL or no non-empty
// workspace), the sidebar sets this so the underlying socket stops
// without touching `serverUrl` or `userEnabled`. Re-shown button
// flips it back. Not persisted: visibility recomputes on every
// load, so the runtime state can rebuild itself from scratch.
let forcedOff = false
let socket = null
let reconnectTimer = null
let reconnectDelayMs = 1_000
const MAX_RECONNECT_DELAY = 30_000

// Application-level heartbeat. The browser WebSocket API doesn't
// expose protocol-level ping/pong, and a server that ack'd our
// subscribe but then silently dropped the route (or a half-open TCP
// connection that hasn't fired a FIN yet) would leave us stuck on
// `online` until the next save attempt or TCP keepalive kicked in.
// We send `{ type: 'ping' }` periodically; the server replies
// `{ type: 'pong' }`. A missing pong within `pongTimeoutMs` closes
// the socket — `close` fires immediately, which the existing
// reconnect path picks up.
//
// Mutable so tests can shorten the windows; production timings give
// dead-connection detection within ~20 s without spamming the wire.
let pingIntervalMs = 15_000
let pongTimeoutMs = 5_000
let pingIntervalId = null
let pongTimeoutId = null

// Keyframe cadence. Client decides — server can't fake the flag
// because it's bound into the signed canonical bytes (see
// sync-crypto.js's `canonicalSavePayload`). A keyframe carries the
// FULL state instead of a delta; a `from=null` subscribe returns
// the chain from the most recent keyframe (inclusive), so a fresh
// client catches up by applying just the keyframe + everything
// after.
//
// `session.savesSinceKeyframe` increments on every applied
// non-keyframe revision (own ack or peer broadcast); resets to 0
// on a keyframe. When the counter reaches `keyframeInterval` AND
// there's something to send AND we're about to send, the next save
// is emitted as a keyframe. Persisted alongside baseRevision /
// baseState so a reload doesn't double-trigger.
//
// Mutable so tests can lower the interval without staging 100
// saves; the production threshold is 100.
let keyframeInterval = 100

// Non-recoverable failure threshold. After this many consecutive
// encrypt/sign failures on a session — typically a corrupt or
// otherwise unusable key — we stop retrying, set the session's
// `error` field, and aggregate that into the public `status`
// listener as `'error'` so the UI can show a visible warning.
// Mutable so a test can drop it to 1.
let maxConsecutiveFailures = 5

// True only when all gates align: a URL exists, the user hasn't
// flipped off, and the sidebar isn't suppressing.
function isActive() {
  return userEnabled && !forcedOff && Boolean(serverUrl)
}

// `off` | `offline` | `connecting` | `online`. Public via the API
// for status-bar indicators; emitted via `onStatusChange` whenever
// the value transitions so consumers don't have to poll.
//
// `connecting` covers the window between socket-open and the
// server's `workspace-subscribed` ack landing — useful because a
// dangling open socket without a registered subscription means
// no broadcasts will reach the client even though the WS layer
// looks fine. `online` requires the ack OR no active session
// (the empty state, where there's nothing to subscribe to).
const statusListeners = new Set()
function currentStatus() {
  if (!isActive()) return 'off'
  // Any session in a non-recoverable error state (key derivation
  // failed; encrypt/sign repeatedly threw) takes precedence — the
  // user needs to see this even if the socket is otherwise healthy,
  // because no save under that workspace will ever land.
  for (const session of sessions.values()) {
    if (session.error) return 'error'
  }
  if (!socket || socket.readyState !== WebSocket.OPEN) return 'offline'
  // Any session that's been registered (`subscribed`) but hasn't
  // received the server's ack yet keeps the whole status in
  // `connecting`. Zero sessions = `online` (nothing to subscribe
  // to; the socket is just sitting open).
  for (const session of sessions.values()) {
    if (session.subscribed && !session.subscribeAcked) return 'connecting'
  }
  return 'online'
}
let lastEmittedStatus = 'off'
function emitStatusIfChanged() {
  const status = currentStatus()
  if (status === lastEmittedStatus) return
  lastEmittedStatus = status
  for (const fn of statusListeners) {
    try { fn(status) } catch (err) { console.warn('Triage sync status listener:', err) }
  }
}
// Re-entrancy guard. Bumped while we're applying remote state so
// the saveTriage at the tail doesn't trigger a notify and bounce
// the same change back at the server.
let suppressNotify = 0
// Active per-workspace sessions, keyed by `workspaceId`. The single
// WebSocket connection multiplexes them — every wire message carries
// `workspaceTag`, which routes inbound messages to the right session
// (`getSessionByTag`). Each session has its own keys, baseState,
// baseRevision, savesSinceKeyframe, pending save, etc.; nothing is
// shared between them except the socket and the heartbeat. Sessions
// are added by `openSession(id)` and removed by `closeSession(id)`;
// `openSession` is additive, not replace-the-current.
const sessions = new Map()

// Find the session whose derived public key matches an inbound
// message's `workspaceTag`. Returns null if no session has finished
// key derivation under that tag yet (the wire never sees the UUID,
// so the tag is the only routing identifier we have for inbound).
function getSessionByTag(tag) {
  for (const session of sessions.values()) {
    if (session.workspaceTag === tag) return session
  }
  return null
}

// True iff `session` is still the live entry for its workspaceId in
// the session map. Handlers that await across boundaries (decrypt,
// saveTriage, persistence) must re-check before mutating world state
// — `closeSession(id)` removes the entry, but the handler still
// holds a reference and would otherwise keep writing to state.* /
// localStorage / the socket on behalf of a workspace the user has
// already torn down.
function sessionIsLive(session) {
  return sessions.get(session.workspaceId) === session
}

// ─────────── pure state / changeset helpers ───────────

function snapshotEntry(id) {
  const entry = {}
  const color = state.markers.get(id)
  if (color !== undefined) entry.color = color
  const triage = state.triageState.get(id)
  if (triage) entry.triage = triage
  const comment = state.comments.get(id)
  if (comment) entry.comment = comment
  const fix = state.fixes.get(id)
  if (fix) entry.fix = fix
  return entry
}

// Collect the finding ids that belong to a workspace's reports,
// scoped by the workspace's `reports` filename list (set by
// drag-into-workspace in the sidebar). With multiple workspaces
// open simultaneously, an unscoped iteration over `state.reports`
// would let any session sync changes for ids in another
// workspace's reports — narrowing here is what keeps each
// session's chain to its own findings.
function buildWorkspaceIds(workspaceId) {
  const ids = new Set()
  const ws = listWorkspaces().find((w) => w.id === workspaceId)
  if (!ws) return ids
  const memberFiles = new Set(ws.reports ?? [])
  for (const r of state.reports) {
    if (!memberFiles.has(r.fileName)) continue
    for (const g of r.groups) {
      for (const f of g) {
        const k = f.id ?? String(f._id)
        if (!SESSION_ID_RE.test(k)) ids.add(k)
      }
    }
  }
  return ids
}

// The session's "effective" local state — what the next save
// represents as the workspace's full triage. Starts from
// `baseState` (= the chain we've applied so far, including
// entries for finding-ids belonging to reports the user doesn't
// have loaded — a peer triaged them), then overlays the live
// state.* values for ids the workspace DOES know about. Without
// preserving the unknown-id half, the next save's changeset
// against `baseState` would emit `<unknown>: null` (delete),
// destroying the triage on the server for clients that DO have
// that report. Mirrors the keyframe-emit case as well: the full
// state we sign and ship under `compute({}, localState)` must
// carry every id we've ever seen in the chain, not just the ones
// in our current session.ids scope.
function effectiveLocalState(baseState, ids) {
  const out = { ...baseState }
  for (const id of ids) {
    const entry = snapshotEntry(id)
    if (Object.keys(entry).length > 0) out[id] = entry
    else delete out[id]
  }
  return out
}

function entriesEqual(a, b) {
  return a.color === b.color
    && Boolean(a.deleted) === Boolean(b.deleted)
    && (a.comment ?? '') === (b.comment ?? '')
    && (a.fix ?? '') === (b.fix ?? '')
}

function statesEqual(a, b) {
  const ids = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const id of ids) {
    if (!entriesEqual(a[id] ?? {}, b[id] ?? {})) return false
  }
  return true
}

// Walk a state through a changeset, producing a new state. `null`
// in the changeset means "delete this id from the state".
function applyChangeset(baseState, changeset) {
  const out = { ...baseState }
  for (const [id, entry] of Object.entries(changeset)) {
    if (entry === null) delete out[id]
    else out[id] = entry
  }
  return out
}

// Compute the changeset that turns `base` into `target`. Mirrors
// `applyChangeset` — `null` entries clear, present entries overwrite.
function computeChangeset(base, target) {
  const changeset = {}
  const ids = new Set([...Object.keys(base), ...Object.keys(target)])
  for (const id of ids) {
    const b = base[id] ?? {}
    const t = target[id] ?? {}
    if (!entriesEqual(b, t)) changeset[id] = target[id] ?? null
  }
  return changeset
}

function changesetEmpty(cs) {
  for (const _ in cs) return false
  return true
}

// ─────────── per-workspace session persistence ───────────

function loadAllSessions() {
  try {
    const raw = localStorage.getItem(SESSION_STATE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    return (parsed && typeof parsed === 'object') ? parsed : {}
  } catch { return {} }
}

function saveAllSessions(map) {
  try {
    localStorage.setItem(SESSION_STATE_KEY, JSON.stringify(map))
  } catch (err) {
    // Likely QuotaExceededError — sync just falls back to the
    // "always start from null base" path on next reload.
    console.warn('Triage sync: could not persist session state:', err)
  }
}

// Try to restore previously-persisted base for `workspaceId` against
// the current `serverUrl`. Returns null when nothing's stored OR the
// stored serverUrl differs (revision IDs are per-server, so a stored
// base from another server is meaningless).
function loadPersistedSession(workspaceId, currentServerUrl) {
  if (!currentServerUrl) return null
  const all = loadAllSessions()
  const entry = all[workspaceId]
  if (!entry || entry.serverUrl !== currentServerUrl) return null
  return {
    baseRevision: entry.baseRevision ?? null,
    baseState: (entry.baseState && typeof entry.baseState === 'object') ? entry.baseState : {},
    savesSinceKeyframe: typeof entry.savesSinceKeyframe === 'number' ? entry.savesSinceKeyframe : 0,
  }
}

function persistSession(target) {
  if (!target || !serverUrl) return
  const all = loadAllSessions()
  all[target.workspaceId] = {
    serverUrl,
    baseRevision: target.baseRevision,
    savesSinceKeyframe: target.savesSinceKeyframe ?? 0,
    baseState: target.baseState,
  }
  saveAllSessions(all)
}

// One-shot prune at module load — drop persisted entries for
// workspaces that no longer exist (deleted but their session state
// stayed). Cheap; runs once per page load.
function prunePersistedSessions() {
  const all = loadAllSessions()
  const ids = Object.keys(all)
  if (ids.length === 0) return
  const live = new Set(listWorkspaces().map((w) => w.id))
  let changed = false
  for (const id of ids) {
    if (!live.has(id)) {
      delete all[id]
      changed = true
    }
  }
  if (changed) saveAllSessions(all)
}

// Reflect `targetState` into the in-memory state.* containers,
// scoped to `ids`. Entries outside the workspace's scope are left
// alone so single-file triage isn't clobbered.
function applyToReactiveState(targetState, ids) {
  for (const id of ids) {
    const entry = targetState[id] ?? {}
    if (entry.color) state.markers.set(id, entry.color)
    else state.markers.delete(id)
    // Triage state — preferred form `triage: 'fixed'|'invalid'|'deleted'`.
    // Legacy `deleted: true` from older peers maps to 'deleted'.
    if (entry.triage === 'fixed' || entry.triage === 'invalid' || entry.triage === 'deleted') {
      state.triageState.set(id, entry.triage)
    } else if (entry.deleted) {
      state.triageState.set(id, 'deleted')
    } else {
      state.triageState.delete(id)
    }
    if (entry.comment) state.comments.set(id, entry.comment)
    else state.comments.delete(id)
    if (entry.fix) state.fixes.set(id, entry.fix)
    else state.fixes.delete(id)
  }
}

// ─────────── transport / wire ───────────

function send(msg) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false
  try {
    socket.send(JSON.stringify(msg))
    return true
  } catch (err) {
    console.warn('Triage sync send failed:', err)
    return false
  }
}

// Send a `workspace-subscribe` once per session-on-this-socket. The
// server uses this to register the connection as a subscriber for
// the workspace's broadcasts even when there's no local change to
// push (e.g. a fresh client opening a workspace whose triage is
// already in sync with the server). Idempotent on the client:
// `session.subscribed` flips true on send and resets on socket
// close so a reconnect re-subscribes.
// `force = true` re-sends a subscribe even when `session.subscribed`
// is already true. Used by the continuity-break recovery path:
// re-asking with the current `baseRevision` returns the gap-filling
// catch-up chain, which is the same primitive the initial subscribe
// uses.
function trySendSubscribe(session, force = false) {
  if (!session) return
  if (!socket || socket.readyState !== WebSocket.OPEN) return
  if (!force && session.subscribed) return
  if (!session.signingKey || !session.workspaceTag) return
  // Capture `from` BEFORE the await — chain handlers running
  // during the sign promise could otherwise advance baseRevision
  // out from under us.
  const fromBase = session.baseRevision
  ;(async () => {
    try {
      const signature = await signSubscribePayload(session.signingKey, session.workspaceTag, fromBase)
      // Bail if the session was removed (closeSession) during the
      // sign await. Looking it up by id again is cheap and
      // forgery-proof — workspaceId only resolves to one entry.
      if (sessions.get(session.workspaceId) !== session) return
      // Mark subscribed BEFORE sending so re-entrant calls (the
      // ws 'open' handler firing twice during a flaky reconnect,
      // or trySendSave running back-to-back) don't double up.
      session.subscribed = true
      send({
        type: 'workspace-subscribe',
        workspaceTag: session.workspaceTag,
        from: fromBase,
        signature,
      })
    } catch (err) {
      console.warn('Triage sync: subscribe sign failed:', err)
    }
  })()
}

// Encryption inserts an `await` between "decided to send" and
// "actually sent", so a re-entrancy flag (`encrypting`) keeps a
// second trySendSave from ALSO building a save while the first is
// still cooking its ciphertext. Subsequent calls during that
// window raise pendingSave just like in-flight; the first call's
// completion drains the queue.
function trySendSave(session) {
  if (!session) return
  if (!socket || socket.readyState !== WebSocket.OPEN) return
  if (session.pending || session.encrypting) {
    session.pendingSave = true
    return
  }
  if (!session.key || !session.signingKey) {
    // Key / keypair derivation hasn't finished yet (or it failed).
    // Mark the intent so when keys arrive we send.
    session.pendingSave = true
    return
  }
  // Refresh `session.ids` against the current workspace membership.
  // A report dragged into the workspace mid-session would otherwise
  // never enter `session.ids`, and edits on its findings wouldn't
  // sync. Cheap — iterates state.reports + workspace.reports once.
  session.ids = buildWorkspaceIds(session.workspaceId)
  // Refresh localState from the live state.* containers in case
  // saveTriage just persisted edits we haven't snapshotted yet.
  session.localState = effectiveLocalState(session.baseState, session.ids)
  // Once `keyframeInterval` non-keyframe revisions have piled up
  // since the last keyframe, the next save we'd emit anyway is
  // promoted to a keyframe — its changeset is the diff against an
  // EMPTY base, so the receiver can apply it standalone (the
  // server uses this to answer `from=null` subscribers without
  // replaying the whole chain). Falsy => regular delta save.
  const isKeyframe = (session.savesSinceKeyframe ?? 0) >= keyframeInterval
  const sourceBase = isKeyframe ? {} : session.baseState
  const changeset = computeChangeset(sourceBase, session.localState)
  if (changesetEmpty(changeset)) return
  const sentBase = session.baseRevision
  session.encrypting = true
  ;(async () => {
    try {
      const aad = buildAad(session.workspaceTag, sentBase)
      const { nonce, ciphertext } = await encryptJson(session.key, changeset, aad)
      // Sign the (workspaceTag, base, keyframe, nonce, ciphertext)
      // tuple — the same canonical bytes any verifier (server or
      // peer) will reconstruct from the wire fields. Holding the
      // signature proves the sender derived the workspace's
      // signing key, i.e. they know the workspace's private key.
      // Including keyframe in the signed payload binds the wire
      // flag to the signature so the server can't promote /
      // demote a revision after the fact.
      const payload = {
        publicKeyB64: session.workspaceTag,
        base: sentBase,
        keyframe: isKeyframe,
        nonceB64: nonce,
        ciphertextB64: ciphertext,
      }
      const signature = await signSavePayload(session.signingKey, payload)
      // Pre-compute the content-addressed revision id (SHA-256 of
      // the canonical bytes). The server derives the same id from
      // received content; the ack carries it back, and we use it
      // to a) match this pending save against its ack, and b)
      // verify the server didn't relabel the revision.
      const revisionId = await computeRevisionId(payload)
      // Session may have been removed (closeSession) during the
      // await chain — drop the result if so. baseRevision may
      // have moved if a chain landed during encryption; in that
      // case the ciphertext is bound to a stale base, so requeue.
      if (sessions.get(session.workspaceId) !== session) return
      if (session.baseRevision !== sentBase) {
        session.pendingSave = true
        return
      }
      session.pending = { base: sentBase, id: revisionId, changeset, keyframe: isKeyframe }
      session.pendingSave = false
      const wireMsg = {
        type: 'workspace-save',
        workspaceTag: session.workspaceTag,
        base: sentBase,
        nonce,
        ciphertext,
        signature,
      }
      // Only set the wire flag when truthy — the server treats
      // missing/false the same way, and keeping the message
      // minimal in the common case keeps the wire trace cleaner.
      if (isKeyframe) wireMsg.keyframe = true
      send(wireMsg)
      // Crypto round-trip succeeded — clear any prior error /
      // failure-counter state so the UI moves out of `error` once
      // things are working again.
      session.consecutiveFailures = 0
      if (session.error) {
        session.error = null
        emitStatusIfChanged()
      }
    } catch (err) {
      console.warn('Triage sync: encrypt/sign failed:', err)
      // Persistent encrypt/sign failures are typically a corrupt
      // session.key or signingKey — non-recoverable from inside
      // this loop. Bump the counter and, after the threshold,
      // surface an error so the UI can warn the user instead of
      // silently retrying forever.
      if (sessions.get(session.workspaceId) === session) {
        session.consecutiveFailures = (session.consecutiveFailures ?? 0) + 1
        if (session.consecutiveFailures >= maxConsecutiveFailures) {
          session.error = `encrypt/sign failed: ${err?.message ?? err}`
          emitStatusIfChanged()
        }
      }
    } finally {
      if (sessions.get(session.workspaceId) === session) {
        session.encrypting = false
        // If something queued during encrypt (or our own logic
        // bumped pendingSave because base moved), kick it — but
        // not if we've given up on this session via `error`,
        // otherwise a flaky-key state would just keep looping.
        if (!session.error && session.pendingSave && !session.pending) {
          session.pendingSave = false
          trySendSave(session)
        }
      }
    }
  })()
}

// Apply a chain of revisions (each `{ base, id, nonce,
// ciphertext, signature }`) to baseState. Three checks per
// revision:
//   1. continuity — `base` must equal the current baseRevision so
//      out-of-order or gappy chains don't silently corrupt state.
//      A break here triggers a resync (clear baseRevision; next
//      save resends the full state).
//   2. signature — the Ed25519 sig must verify against the
//      session's public key (= workspaceTag). A revision with a
//      bad sig is dropped and skipped; baseState stays where it
//      is for the next revision in the chain.
//   3. decrypt — AEAD tag check on the ciphertext using AAD
//      derived from (workspaceTag, base). A decrypt failure is
//      similarly skipped, not fatal.
// Skipping malformed individual revisions keeps a single bad
// message from poisoning every reconnecting client; only an
// explicit continuity break (which signature-verified attackers
// can't cause) can request a full resync.
async function applyChainToBase(session, revisions) {
  for (const rev of revisions) {
    if (!rev || typeof rev !== 'object') continue
    // Idempotent skip — the chain from a re-subscribe might begin
    // with a revision we already applied (e.g. our reconnect's
    // `from` was the predecessor, so the first rev returned IS our
    // current baseRevision). Without this we'd fail the continuity
    // check below and trigger an unnecessary resync.
    if (typeof rev.id === 'string' && rev.id === session.baseRevision) continue
    // Continuity check: each revision's `base` must equal our
    // current baseRevision. The very first chain we receive (after
    // init, baseRevision === null) accepts a `null` base.
    const expected = session.baseRevision
    const isKeyframe = Boolean(rev.keyframe)
    // Continuity check. A keyframe arriving against a `null` local
    // baseRevision is the catch-up entry-point used by `from=null`
    // subscribes — its `base` points at some older revision the
    // client doesn't have, but the keyframe's content IS the full
    // state, so we accept it and replace baseState wholesale below.
    const ok = expected == null
      ? (rev.base == null || isKeyframe)
      : rev.base === expected
    if (!ok) {
      console.warn(`Triage sync: chain base mismatch (expected ${expected}, got ${rev.base})`)
      // Do NOT mutate baseRevision / baseState here — the caller
      // (handleChain) will first try to fill the gap by
      // re-subscribing from the current baseRevision; only if THAT
      // chain also breaks does the full reset run.
      return false
    }
    // Signature first — confirms the revision came from someone
    // holding the workspace's signing key. A failed signature is a
    // forgery / corruption; skip the bad revision and keep the
    // previous baseState intact (the malicious / broken entry
    // doesn't get to decide our future). Continuity for subsequent
    // revisions still has to hold.
    if (!rev.signature || !rev.nonce || !rev.ciphertext || typeof rev.id !== 'string') {
      console.warn('Triage sync: revision missing signature/nonce/ciphertext/id; skipping')
      if (typeof rev.id === 'string') session.baseRevision = rev.id
      continue
    }
    const payload = {
      publicKeyB64: session.workspaceTag,
      base: rev.base,
      keyframe: isKeyframe,
      nonceB64: rev.nonce,
      ciphertextB64: rev.ciphertext,
    }
    // Recompute the content-addressed id from the same canonical
    // bytes. A server-claimed id that doesn't match the content
    // hash is the protocol's signal that the server is trying to
    // relabel / re-attribute a revision — drop the rev. The
    // keyframe flag is part of the canonical bytes, so a server
    // that flipped it on/off would also fail this check.
    const expectedId = await computeRevisionId(payload)
    // Session may have been closed during the verify/decrypt awaits
    // — bail before any further mutation of an orphan.
    if (!sessionIsLive(session)) return false
    if (rev.id !== expectedId) {
      console.warn('Triage sync: revision id does not match content hash; skipping')
      session.baseRevision = rev.id
      continue
    }
    const ok2 = await verifySavePayload(
      session.verifyingKey,
      payload,
      rev.signature,
    )
    if (!sessionIsLive(session)) return false
    if (!ok2) {
      console.warn('Triage sync: revision signature did not verify; skipping')
      session.baseRevision = rev.id
      continue
    }
    let changeset
    try {
      const aad = buildAad(session.workspaceTag, rev.base)
      changeset = await decryptJson(session.key, rev.nonce, rev.ciphertext, aad)
    } catch (err) {
      console.warn('Triage sync: decrypt failed; skipping', err)
      session.baseRevision = rev.id
      continue
    }
    if (!sessionIsLive(session)) return false
    // Keyframes carry a changeset computed against an EMPTY base,
    // so applying them is a wholesale replace. Reset the
    // since-last-keyframe counter; bump it on regular revs.
    const applyTo = isKeyframe ? {} : session.baseState
    session.baseState = applyChangeset(applyTo, changeset ?? {})
    session.baseRevision = rev.id
    if (isKeyframe) session.savesSinceKeyframe = 0
    else session.savesSinceKeyframe = (session.savesSinceKeyframe ?? 0) + 1
  }
  return true
}

// Replay a captured user overlay on top of the (already-mutated)
// baseState and sync state.* / persistence. The caller MUST capture
// the overlay BEFORE mutating baseState — `overlay = state.* −
// oldBaseState` — so non-conflicting remote changes from the new
// baseState end up in the resulting localState while the user's
// unsynced edits override on the same id (local-wins merge).
//
// Computing the overlay against a `baseState` that's already been
// mutated would collapse to identity (apply(B, compute(B, T)) ≡ T)
// and silently discard every remote change. See the bug discussion
// in the rebase audit.
async function applyOverlayAndPersist(session, overlay) {
  // Bail if the session was closed before we got here — applying a
  // chain to a torn-down workspace would write to the global state.*
  // / localStorage on its behalf.
  if (!sessionIsLive(session)) return
  session.localState = applyChangeset(session.baseState, overlay)
  suppressNotify++
  try {
    applyToReactiveState(session.localState, session.ids)
    await saveTriage()
  } finally {
    suppressNotify--
  }
  // saveTriage's await may have crossed a closeSession; re-check.
  if (!sessionIsLive(session)) return
  // Persist the rebased base + revision so a reload (or workspace
  // switch back) skips the full-chain replay. Scoped by serverUrl
  // — see `loadPersistedSession`.
  persistSession(session)
  redraw()
  // Cross-session propagation: a finding-id can belong to more than
  // one open workspace. If this session's apply touched state.* for
  // a shared id, every OTHER session whose `ids` set covers that id
  // now has unsynced state.* relative to its own baseState. Kick
  // them so they push the change under their own tag. trySendSave's
  // empty-changeset short-circuit makes the no-overlap case cheap
  // (each session's baseState already matched state.*).
  // The caller (handleAck / handleChain) takes care of the *current*
  // session's follow-up, so we skip it here to avoid double work.
  for (const other of sessions.values()) {
    if (other !== session) trySendSave(other)
  }
}

// Read state.* into `session.localState` and return the overlay
// (= state.* − current baseState). Call this BEFORE mutating
// baseState; the returned overlay is stable across the mutation
// and gets re-applied via `applyOverlayAndPersist` afterwards.
function captureOverlay(session) {
  // Refresh `session.ids` so a chain landing AFTER a new report was
  // dragged in pulls the right scope when reading state.* — without
  // this, the new report's findings would be invisible to the
  // overlay/apply round-trip until the session is reopened.
  session.ids = buildWorkspaceIds(session.workspaceId)
  session.localState = effectiveLocalState(session.baseState, session.ids)
  return computeChangeset(session.baseState, session.localState)
}

async function handleAck(session, msg) {
  // The pending save was accepted as revision `msg.id`, built on
  // `msg.base`. Verify the base matches what we sent and fold the
  // pending changeset into baseState so it becomes the new agreed
  // floor.
  // Match both `base` and `id`: the server can't relabel a
  // revision (id is content-derived), but a stray /
  // out-of-protocol message claiming an id we didn't compute
  // shouldn't fold a phantom changeset into baseState.
  if (
    session.pending
    && msg.base === session.pending.base
    && msg.id === session.pending.id
  ) {
    // Capture overlay BEFORE folding pending into baseState. The
    // overlay also catches edits the user made AFTER the pending
    // save was sent — they're in state.* but not in
    // pending.changeset, and would be lost otherwise.
    const overlay = captureOverlay(session)
    // Keyframes carry a changeset computed against an EMPTY base
    // (= full state); applying them is a wholesale replace.
    // Regular saves stack on the current baseState.
    const applyTo = session.pending.keyframe ? {} : session.baseState
    session.baseState = applyChangeset(applyTo, session.pending.changeset)
    session.baseRevision = msg.id
    session.savesSinceKeyframe = session.pending.keyframe
      ? 0
      : (session.savesSinceKeyframe ?? 0) + 1
    session.pending = null
    await applyOverlayAndPersist(session, overlay)
    // applyOverlayAndPersist self-bails if the session was closed
    // during its awaits, but a follow-up trySendSave on the orphan
    // would still fire — gate it.
    if (!sessionIsLive(session)) return
    // The user may have edited during the round-trip; if there's a
    // residual overlay (or pendingSave was raised), flush it.
    if (session.pendingSave || !statesEqual(session.localState, session.baseState)) {
      session.pendingSave = false
      trySendSave(session)
    }
    return
  }
  if (session.pending) {
    console.warn(`Triage sync: ack mismatch (pending ${session.pending.base}/${session.pending.id?.slice(0, 8)}, ack ${msg.base}/${msg.id?.slice(0, 8)})`)
    return
  }
  // Late ack — pending was already cleared by something else
  // (a chain that advanced baseRevision past us, a reconnect that
  // wiped pending, or an out-of-order delivery the queued
  // handler chain hasn't processed yet). The server believes the
  // save committed at `msg.id`; the changeset is no longer in
  // `pending`, so we can't fold it in. Trigger a fresh save —
  // the server's stale-base path returns the catch-up chain
  // including our committed revision, and we end up at the same
  // place via rebase.
  if (msg.id !== session.baseRevision) {
    console.warn(`Triage sync: late ack for base=${msg.base} id=${msg.id?.slice(0, 8)}…; pending was already cleared`)
    session.pendingSave = true
    trySendSave(session)
  }
}

async function handleChain(session, revisions) {
  if (!Array.isArray(revisions) || revisions.length === 0) return
  // Key not derived yet — bail; a future open will retry once
  // deriveSessionKey lands and trySendSave re-runs.
  if (!session.key) return
  // Capture overlay BEFORE applyChainToBase mutates baseState.
  const overlay = captureOverlay(session)
  const ok = await applyChainToBase(session, revisions)
  // applyChainToBase self-bails on a closed session (returns false
  // without mutating baseRevision); double-check before we touch
  // anything further.
  if (!sessionIsLive(session)) return
  if (!ok) {
    // Continuity break. First try to fill the gap by re-subscribing
    // with `from = current baseRevision`: in the typical case (a
    // broadcast that skipped intermediate revisions, a transient
    // out-of-order delivery), the server's subscribe response is
    // the catch-up chain we need and we keep our state.
    if (!session.resyncAttempted) {
      session.resyncAttempted = true
      console.warn('Triage sync: requesting catch-up from last known baseRevision')
      trySendSubscribe(session, true)
      return
    }
    // The re-subscribed chain also broke continuity — server has
    // either lost our base or is genuinely broken. Fall back to a
    // full state-push: reset baseRevision/baseState (state.* is
    // left alone — applying the empty overlay on top of {} would
    // clear unedited entries) and let the next save's stale-base
    // catch-up rebuild the chain.
    console.warn('Triage sync: catch-up also broke continuity; full state push')
    session.baseRevision = null
    session.baseState = {}
    session.pending = null
    session.pendingSave = false
    session.resyncAttempted = false
    persistSession(session)
    redraw()
    trySendSave(session)
    return
  }
  session.resyncAttempted = false
  // If a save was in flight when the chain arrived, the server is
  // implicitly rejecting it (it brought us forward without acking).
  // Clear pending so the next save recomputes the changeset against
  // the freshly-rebased baseState.
  if (session.pending) {
    session.pending = null
    session.pendingSave = true
  }
  await applyOverlayAndPersist(session, overlay)
  if (!sessionIsLive(session)) return
  if (session.pendingSave || !statesEqual(session.localState, session.baseState)) {
    session.pendingSave = false
    trySendSave(session)
  }
}

async function handleMessage(data) {
  let msg
  try { msg = JSON.parse(data) } catch { return }
  if (!msg || typeof msg !== 'object') return
  // Heartbeat — stateless, no per-session match needed. Cancel the
  // outstanding pong-deadline timer; the next interval will start a
  // fresh round.
  if (msg.type === 'pong') {
    if (pongTimeoutId) { clearTimeout(pongTimeoutId); pongTimeoutId = null }
    return
  }
  // Demultiplex by `workspaceTag` — one socket carries traffic for
  // every open session. A tag we don't recognise means the message
  // is for a session we've already closed (or for a workspace this
  // client never opened); drop silently.
  if (typeof msg.workspaceTag !== 'string') return
  const session = getSessionByTag(msg.workspaceTag)
  if (!session) return
  if (msg.type === 'workspace-save-ack') {
    await handleAck(session, msg)
  } else if (msg.type === 'workspace-state') {
    await handleChain(session, msg.revisions)
  } else if (msg.type === 'workspace-subscribed') {
    // Server confirmed our subscribe was accepted — we're a
    // peer now and broadcasts will reach us. Flip the status
    // out of `connecting`. The chain that follows arrives as
    // a separate `workspace-state` message.
    session.subscribeAcked = true
    emitStatusIfChanged()
  }
}

// ─────────── connection lifecycle ───────────

function startHeartbeat() {
  stopHeartbeat()
  pingIntervalId = setInterval(() => {
    if (!socket || socket.readyState !== WebSocket.OPEN) return
    // Don't double-arm: a previous ping is still awaiting its pong.
    // The existing pongTimeout will close the socket if that one
    // doesn't land.
    if (pongTimeoutId) return
    send({ type: 'ping' })
    pongTimeoutId = setTimeout(() => {
      pongTimeoutId = null
      console.warn('Triage sync: heartbeat timeout; closing socket')
      try { socket?.close() } catch {}
    }, pongTimeoutMs)
  }, pingIntervalMs)
}

function stopHeartbeat() {
  if (pingIntervalId) { clearInterval(pingIntervalId); pingIntervalId = null }
  if (pongTimeoutId) { clearTimeout(pongTimeoutId); pongTimeoutId = null }
}

function clearReconnect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
}

function scheduleReconnect() {
  clearReconnect()
  if (!serverUrl) return
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    openSocket()
  }, reconnectDelayMs)
  reconnectDelayMs = Math.min(reconnectDelayMs * 2, MAX_RECONNECT_DELAY)
}

function openSocket() {
  if (!serverUrl || socket) return
  let ws
  try {
    ws = new WebSocket(serverUrl)
  } catch (err) {
    console.warn('Triage sync: WebSocket constructor failed:', err)
    scheduleReconnect()
    return
  }
  socket = ws
  ws.addEventListener('open', () => {
    reconnectDelayMs = 1_000
    // Re-establish every open session against the freshly opened
    // socket. baseState / baseRevision survived the disconnect;
    // subscribed + subscribeAcked reset so we re-subscribe per
    // session on this fresh socket and walk through `connecting`
    // until each ack arrives; if there's an overlay (or we hadn't
    // sent the initial state yet), trySendSave pushes it.
    for (const session of sessions.values()) {
      session.pending = null
      session.pendingSave = false
      session.subscribed = false
      session.subscribeAcked = false
      session.resyncAttempted = false
      trySendSubscribe(session)
      trySendSave(session)
    }
    startHeartbeat()
    emitStatusIfChanged()
  })
  // Serialize handlers via a Promise chain — handleAck and
  // handleChain both contain awaits (decrypt, saveTriage,
  // persistSession), and the message-event listener fires a fresh
  // async invocation per message, so without the chain two
  // handlers can interleave: one's `rebaseAndPersist` running
  // while the other reads / mutates `session.localState`,
  // double-render(), persistSession with intermediate state, and
  // similar small horrors. The chain forces strictly serial
  // processing so each message sees a settled state before the
  // next runs. Errors are swallowed (logged) so one bad message
  // doesn't break the chain.
  let queue = Promise.resolve()
  ws.addEventListener('message', (e) => {
    queue = queue.then(() => handleMessage(e.data)).catch((err) => {
      console.warn('Triage sync handler error:', err)
    })
  })
  ws.addEventListener('close', () => {
    if (socket === ws) socket = null
    stopHeartbeat()
    // The pending requests are gone with the socket — mark every
    // session's slot free so the reconnect handler resends.
    // `subscribed` / `subscribeAcked` both clear so reconnect
    // re-subscribes and the status walks `offline → connecting →
    // online` again per session.
    for (const session of sessions.values()) {
      session.pending = null
      session.subscribed = false
      session.subscribeAcked = false
      session.resyncAttempted = false
      session.pendingSave = !statesEqual(session.localState, session.baseState)
    }
    emitStatusIfChanged()
    // Only auto-reconnect when sync is actively wanted — a
    // user-disabled or sidebar-forced-off socket should stay
    // closed once it's down.
    if (isActive()) scheduleReconnect()
  })
  ws.addEventListener('error', () => {
    // Close fires right after — let it own the reconnect schedule.
  })
}

function closeSocket() {
  clearReconnect()
  reconnectDelayMs = 1_000
  if (socket) {
    const ws = socket
    socket = null
    try { ws.close() } catch {}
  }
}

// ─────────── public API ───────────

// Wire up the UI's render() function as the post-rebase redraw.
// Called once from the app entry; using a setter (instead of an
// import from this file) keeps the dependency arrow pointing
// ui → client, not the other way.
export function setRedraw(fn) {
  redraw = typeof fn === 'function' ? fn : () => {}
}

// Test-only knob: shortens the heartbeat windows so a unit test
// doesn't have to wait the production 15s/5s. No-op for any field
// that isn't a positive number.
export function setHeartbeatTimings({ pingMs, pongMs } = {}) {
  if (typeof pingMs === 'number' && pingMs > 0) pingIntervalMs = pingMs
  if (typeof pongMs === 'number' && pongMs > 0) pongTimeoutMs = pongMs
  // If a heartbeat is already running (i.e. the socket is open),
  // restart it so the new interval takes effect immediately.
  if (pingIntervalId) startHeartbeat()
}

// Test-only knob: lower the keyframe interval so a test can trigger
// the keyframe path with a handful of saves. Production stays at 100.
export function setKeyframeInterval(n) {
  if (typeof n === 'number' && n >= 1) keyframeInterval = n
}

// Test-only knob: lower the consecutive-failure threshold so a test
// can drive a session into the `error` state with one fault rather
// than five. Production stays at 5.
export function setMaxConsecutiveFailures(n) {
  if (typeof n === 'number' && n >= 1) maxConsecutiveFailures = n
}

export const triageSync = {
  setServerUrl(url) {
    const next = (url ?? '').trim()
    if (next === serverUrl) return
    serverUrl = next
    try {
      if (next) localStorage.setItem(STORAGE_KEY, next)
      else localStorage.removeItem(STORAGE_KEY)
    } catch {}
    closeSocket()
    // Server changed — revision IDs are per-server, so every
    // active session's tracking is stale. Reset each one; if
    // there's persisted state for the NEW server (or null when
    // turning sync off), fold that in. localState rebuilds from
    // state.* per session so unsynced edits survive the reset and
    // replay onto the new base via the rebase path.
    for (const session of sessions.values()) {
      session.pending = null
      session.pendingSave = false
      session.subscribed = false
      session.subscribeAcked = false
      session.resyncAttempted = false
      const restored = next ? loadPersistedSession(session.workspaceId, next) : null
      session.baseRevision = restored?.baseRevision ?? null
      session.baseState = restored?.baseState ?? {}
      session.savesSinceKeyframe = restored?.savesSinceKeyframe ?? 0
      session.localState = effectiveLocalState(session.baseState, session.ids)
    }
    if (isActive()) openSocket()
    emitStatusIfChanged()
  },

  // Persisted user-driven toggle. URL stays put — re-enabling
  // resumes against the same endpoint. closeSocket() bypasses
  // reconnect because `isActive()` is now false.
  setEnabled(value) {
    const next = Boolean(value)
    if (next === userEnabled) return
    userEnabled = next
    try {
      localStorage.setItem(USER_ENABLED_KEY, next ? '1' : '0')
    } catch {}
    if (isActive()) {
      if (!socket) openSocket()
    } else {
      closeSocket()
      for (const session of sessions.values()) {
        session.pending = null
        session.pendingSave = false
        session.subscribed = false
        session.subscribeAcked = false
        session.resyncAttempted = false
      }
    }
    emitStatusIfChanged()
  },

  isEnabled() { return userEnabled },

  // Runtime gate driven by the sidebar's visibility logic. Same
  // close-without-touching-URL semantics as setEnabled, but isn't
  // persisted — the sidebar re-derives visibility on every render
  // from workspace state, so on next load this resets to false
  // and `setForcedOff(true/false)` runs again as appropriate.
  setForcedOff(value) {
    const next = Boolean(value)
    if (next === forcedOff) return
    forcedOff = next
    if (isActive()) {
      if (!socket) openSocket()
    } else {
      closeSocket()
      for (const session of sessions.values()) {
        session.pending = null
        session.pendingSave = false
        session.subscribed = false
        session.subscribeAcked = false
        session.resyncAttempted = false
      }
    }
    emitStatusIfChanged()
  },

  getServerUrl() { return serverUrl },

  get connected() { return socket?.readyState === WebSocket.OPEN },

  // Status flag for connection-state indicators. One of:
  //   'off'      no server URL configured (sync disabled)
  //   'offline'  URL set but socket isn't open (reconnecting / down)
  //   'online'   WebSocket is open
  get status() { return currentStatus() },

  // Subscribe to status transitions. Returns an unsubscribe
  // function. Listeners only fire when the status string changes,
  // so transient open → close → open during a reconnect storm
  // doesn't replay the same value back-to-back.
  onStatusChange(listener) {
    statusListeners.add(listener)
    return () => statusListeners.delete(listener)
  },

  // Called by triage.js at the tail of saveTriage(). When inside
  // applyChainToBase / handleAck (suppressNotify > 0), bail — that
  // path already owns persistence. Otherwise schedule a save for
  // every open session; trySendSave's empty-changeset short-circuit
  // means sessions with no local changes turn into a cheap no-op.
  notify() {
    if (suppressNotify > 0) return
    for (const session of sessions.values()) trySendSave(session)
  },

  // Open a per-workspace session. Additive — calling with a fresh
  // `workspaceId` adds a second session multiplexed over the same
  // socket; calling with an already-open id is idempotent. The
  // single-workspace UI's "switch workspaces" path explicitly calls
  // `closeSession(oldId)` before `openSession(newId)`.
  openSession(workspaceId) {
    if (!workspaceId) return
    if (sessions.has(workspaceId)) return
    const ws = listWorkspaces().find((w) => w.id === workspaceId)
    if (!ws) return
    const ids = buildWorkspaceIds(workspaceId)
    // Persisted state-per-server scope: if we synced this
    // workspace against the current `serverUrl` before, restore
    // the last `baseRevision` + `baseState` so the first
    // round-trip is a delta, not a full replay. Mismatched
    // serverUrl returns null (revision IDs don't carry across
    // servers).
    const restored = loadPersistedSession(workspaceId, serverUrl)
    const newSession = {
      // `workspaceId` is the local UUID — used inside the app
      // (state.currentWorkspace, etc.). `workspaceTag` is the
      // base64url Ed25519 public key derived from the workspace's
      // private key; it's the server-facing identifier AND the
      // verification key for every save signature, so a server
      // (or peer) can both route messages and authenticate that
      // they came from a holder of the workspace's secret.
      // `signingKey` is the matching CryptoKey with sign
      // capability, locked inside WebCrypto — never leaves the
      // module.
      workspaceId,
      workspaceTag: null,
      signingKey: null,
      verifyingKey: null,
      ids,
      // baseRevision / baseState / savesSinceKeyframe come from
      // per-server persistence when present; otherwise null / empty
      // / 0 and the first save sends the full local snapshot.
      baseRevision: restored?.baseRevision ?? null,
      baseState: restored?.baseState ?? {},
      savesSinceKeyframe: restored?.savesSinceKeyframe ?? 0,
      localState: effectiveLocalState(restored?.baseState ?? {}, ids),
      pending: null,
      pendingSave: false,
      key: null,
      encrypting: false,
      // Flips true once we ship a `workspace-subscribe` over the
      // current socket; resets on socket close so reconnects
      // re-subscribe. Decoupled from `pending` (saves) because a
      // workspace whose state is in sync still wants broadcasts.
      subscribed: false,
      // Set when the server's `workspace-subscribed` ack lands.
      // Distinct from `subscribed` (which only means "we sent the
      // request"): the server can drop a request silently on
      // sig-fail / bad-tag, so without an explicit ack the client
      // can't tell registered-as-peer from sent-into-the-void.
      // Drives the `connecting` → `online` status transition.
      subscribeAcked: false,
      // True after the chain's continuity check failed once and
      // we've already issued a re-subscribe to fill the gap. The
      // next continuity break in the same session falls through to
      // the full state-push reset; otherwise a server that keeps
      // sending broken chains would loop us forever.
      resyncAttempted: false,
      // Consecutive crypto failures (encrypt/sign in trySendSave).
      // Reset on a successful round-trip; promoted to `error` once
      // it crosses `maxConsecutiveFailures`. Per-session because
      // the cause is typically the session's own keys.
      consecutiveFailures: 0,
      // Non-recoverable error message, or null. When set, this
      // session stops retrying and `currentStatus()` aggregates to
      // `'error'` so the UI can surface it. `dismissError()`
      // clears it and retries.
      error: null,
    }
    sessions.set(workspaceId, newSession)
    // Derive content-encryption key + Ed25519 signing keypair in
    // parallel. Both come off the same private key via HKDF with
    // different domain-separating info strings. If the session
    // gets removed or replaced before derivation finishes, the
    // identity check drops the result.
    ;(async () => {
      try {
        const [key, kp] = await Promise.all([
          deriveSessionKey(ws.privateKey),
          deriveSigningKeypair(ws.privateKey, workspaceId),
        ])
        if (sessions.get(workspaceId) !== newSession) return
        newSession.key = key
        newSession.signingKey = kp.privateKey
        newSession.verifyingKey = kp.publicKey
        newSession.workspaceTag = kp.publicKeyB64
        // Subscribe + flush any pending save now that we have keys.
        // Subscribe gets us broadcast-eligibility regardless of
        // whether there's anything to push.
        if (socket?.readyState !== WebSocket.OPEN) {
          // Socket isn't open yet — open it lazily so the very
          // first openSession of the page-load brings the
          // connection up. Subsequent openSessions reuse it.
          if (isActive() && !socket) openSocket()
          return
        }
        trySendSubscribe(newSession)
        trySendSave(newSession)
        emitStatusIfChanged()
      } catch (err) {
        console.warn('Triage sync: key derivation failed:', err)
        // Non-recoverable from the sync layer's POV — without
        // signing keys we can't sign any save or subscribe under
        // this workspace. Surface it so the UI can warn the user
        // (typical cause: a corrupt / wrong-length privateKey on
        // the workspace record).
        if (sessions.get(workspaceId) === newSession) {
          newSession.error = `key derivation failed: ${err?.message ?? err}`
          emitStatusIfChanged()
        }
      }
    })()
    if (isActive() && !socket) openSocket()
    emitStatusIfChanged()
  },

  // Close one session (by id) or, with no argument, every open
  // session. The single-workspace UI's "switch workspace" path
  // calls `closeSession(oldId)` before `openSession(newId)`; the
  // page-unload / "log out of sync" paths call it with no arg.
  closeSession(workspaceId) {
    if (workspaceId == null) {
      sessions.clear()
    } else {
      sessions.delete(workspaceId)
    }
    emitStatusIfChanged()
  },

  // Read-only inspector keyed by workspaceId. Returns the same
  // shape the single-session API used to expose, just one entry
  // per open session. `null` for a missing id keeps the test /
  // debug ergonomics that the old getter had.
  sessionInfo(workspaceId) {
    const session = sessions.get(workspaceId)
    if (!session) return null
    return {
      workspaceId: session.workspaceId,
      workspaceTag: session.workspaceTag,
      baseRevision: session.baseRevision,
      pending: session.pending && { base: session.pending.base, keyframe: session.pending.keyframe },
      pendingSave: session.pendingSave,
      keyReady: session.key !== null,
      encrypting: session.encrypting,
      tracked: session.ids.size,
      savesSinceKeyframe: session.savesSinceKeyframe ?? 0,
      error: session.error ?? null,
    }
  },

  // Snapshot of all open sessions — array of `sessionInfo`-shaped
  // entries. Useful for status bars / debug consoles that want to
  // surface the multi-session state at a glance.
  get openSessions() {
    return [...sessions.keys()].map((id) => this.sessionInfo(id))
  },

  // User-driven retry after a non-recoverable failure. Clears the
  // session's error / failure-counter and kicks subscribe + save so
  // the next round-trip attempt happens. With no argument, clears
  // every session's error. The sidebar's sync button wires the
  // no-arg form to "click while in error state".
  dismissError(workspaceId) {
    const ids = workspaceId == null ? [...sessions.keys()] : [workspaceId]
    let changed = false
    for (const id of ids) {
      const session = sessions.get(id)
      if (!session || !session.error) continue
      session.error = null
      session.consecutiveFailures = 0
      changed = true
      if (socket?.readyState === WebSocket.OPEN) {
        trySendSubscribe(session)
        trySendSave(session)
      }
    }
    if (changed) emitStatusIfChanged()
  },
}

// Restore the user's persisted enable flag + saved server URL on
// module load. Sync only auto-starts when both gates open: the URL
// is set AND the user hasn't toggled off.
try {
  const savedEnabled = localStorage.getItem(USER_ENABLED_KEY)
  if (savedEnabled === '0') userEnabled = false
  const saved = localStorage.getItem(STORAGE_KEY) ?? ''
  if (saved) serverUrl = saved
  if (isActive()) openSocket()
} catch {}

// Drop persisted session entries whose workspace was deleted
// while we were away. One-time pass on module load — workspaces
// are loaded synchronously from localStorage so `listWorkspaces()`
// is ready by now.
prunePersistedSessions()

// Discard the pre-content-addressed-id session blob. Its integer
// baseRevisions don't match the new string-id chain check, so we
// drop the legacy key instead of letting orphaned bytes sit.
try { localStorage.removeItem(SESSION_STATE_KEY_LEGACY) } catch {}
