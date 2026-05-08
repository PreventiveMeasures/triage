import { state } from './state.js'
import { saveTriage } from './triage.js'
import { render } from './render.js'
import { listWorkspaces } from './workspaces.js'
import {
  deriveSessionKey,
  deriveSigningKeypair,
  buildAad,
  encryptJson,
  decryptJson,
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
//   client → server  workspace-save     { workspaceTag, base,
//                                          nonce, ciphertext, signature }
//   server → client  workspace-save-ack { workspaceTag, base, id }
//   server → client  workspace-state    { workspaceTag, revisions:
//                                          [{ base, id, nonce,
//                                             ciphertext, signature }, ...] }
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
const SESSION_ID_RE = /^\d+$/u

let serverUrl = ''
let socket = null
let reconnectTimer = null
let reconnectDelayMs = 1_000
const MAX_RECONNECT_DELAY = 30_000
// Re-entrancy guard. Bumped while we're applying remote state so
// the saveTriage at the tail doesn't trigger a notify and bounce
// the same change back at the server.
let suppressNotify = 0
// Active per-workspace session (or null when no workspace is
// loaded). Mutually exclusive with single-file mode.
let session = null

// ─────────── pure state / changeset helpers ───────────

function snapshotEntry(id) {
  const entry = {}
  const color = state.markers.get(id)
  if (color !== undefined) entry.color = color
  if (state.deletedIds.has(id)) entry.deleted = true
  const comment = state.comments.get(id)
  if (comment) entry.comment = comment
  const fix = state.fixes.get(id)
  if (fix) entry.fix = fix
  return entry
}

function buildWorkspaceIds() {
  const ids = new Set()
  for (const r of state.reports) {
    for (const g of r.groups) {
      for (const f of g) {
        const k = f.id ?? String(f._id)
        if (!SESSION_ID_RE.test(k)) ids.add(k)
      }
    }
  }
  return ids
}

function buildLocalState(ids) {
  const out = {}
  for (const id of ids) {
    const entry = snapshotEntry(id)
    if (Object.keys(entry).length > 0) out[id] = entry
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

// Reflect `targetState` into the in-memory state.* containers,
// scoped to `ids`. Entries outside the workspace's scope are left
// alone so single-file triage isn't clobbered.
function applyToReactiveState(targetState, ids) {
  for (const id of ids) {
    const entry = targetState[id] ?? {}
    if (entry.color) state.markers.set(id, entry.color)
    else state.markers.delete(id)
    if (entry.deleted) state.deletedIds.add(id)
    else state.deletedIds.delete(id)
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
function trySendSubscribe() {
  if (!session) return
  if (!socket || socket.readyState !== WebSocket.OPEN) return
  if (session.subscribed) return
  if (!session.signingKey || !session.workspaceTag) return
  const owner = session
  ;(async () => {
    try {
      const signature = await signSubscribePayload(owner.signingKey, owner.workspaceTag)
      if (session !== owner) return
      // Mark subscribed BEFORE sending so re-entrant calls (the
      // ws 'open' handler firing twice during a flaky reconnect,
      // or trySendSave running back-to-back) don't double up.
      session.subscribed = true
      send({
        type: 'workspace-subscribe',
        workspaceTag: session.workspaceTag,
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
function trySendSave() {
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
  // Refresh localState from the live state.* containers in case
  // saveTriage just persisted edits we haven't snapshotted yet.
  session.localState = buildLocalState(session.ids)
  const changeset = computeChangeset(session.baseState, session.localState)
  if (changesetEmpty(changeset)) return
  const sentBase = session.baseRevision
  const owner = session
  session.encrypting = true
  ;(async () => {
    try {
      const aad = buildAad(owner.workspaceTag, sentBase)
      const { nonce, ciphertext } = await encryptJson(owner.key, changeset, aad)
      // Sign the (workspaceTag, base, nonce, ciphertext) tuple —
      // the same canonical bytes any verifier (server or peer)
      // will reconstruct from the wire fields. Holding the
      // signature proves the sender derived the workspace's
      // signing key, i.e. they know the workspace's private key.
      const signature = await signSavePayload(owner.signingKey, {
        publicKeyB64: owner.workspaceTag,
        base: sentBase,
        nonceB64: nonce,
        ciphertextB64: ciphertext,
      })
      // Session may have been closed (or replaced) during the
      // await chain — drop the result if so. baseRevision may
      // have moved if a chain landed during encryption; in that
      // case the ciphertext is bound to a stale base, so requeue.
      if (session !== owner) return
      if (session.baseRevision !== sentBase) {
        session.pendingSave = true
        return
      }
      session.pending = { base: sentBase, changeset }
      session.pendingSave = false
      send({
        type: 'workspace-save',
        workspaceTag: session.workspaceTag,
        base: sentBase,
        nonce,
        ciphertext,
        signature,
      })
    } catch (err) {
      console.warn('Triage sync: encrypt/sign failed:', err)
    } finally {
      if (session === owner) {
        session.encrypting = false
        // If something queued during encrypt (or our own logic
        // bumped pendingSave because base moved), kick it.
        if (session.pendingSave && !session.pending) {
          session.pendingSave = false
          trySendSave()
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
async function applyChainToBase(revisions) {
  for (const rev of revisions) {
    if (!rev || typeof rev !== 'object') continue
    // First-revision allowance: the very first chain we receive
    // (after init) may start from `null` or `0` — accept either.
    const expected = session.baseRevision
    const ok = expected == null
      ? (rev.base == null || rev.base === 0)
      : rev.base === expected
    if (!ok) {
      console.warn(`Triage sync: chain base mismatch (expected ${expected}, got ${rev.base}); resync requested`)
      session.baseRevision = null
      session.baseState = {}
      return false
    }
    // Signature first — confirms the revision came from someone
    // holding the workspace's signing key. A failed signature is a
    // forgery / corruption; skip the bad revision and keep the
    // previous baseState intact (the malicious / broken entry
    // doesn't get to decide our future). Continuity for subsequent
    // revisions still has to hold.
    if (!rev.signature || !rev.nonce || !rev.ciphertext) {
      console.warn('Triage sync: revision missing signature/nonce/ciphertext; skipping')
      session.baseRevision = rev.id
      continue
    }
    const ok2 = await verifySavePayload(
      session.verifyingKey,
      {
        publicKeyB64: session.workspaceTag,
        base: rev.base,
        nonceB64: rev.nonce,
        ciphertextB64: rev.ciphertext,
      },
      rev.signature,
    )
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
    session.baseState = applyChangeset(session.baseState, changeset ?? {})
    session.baseRevision = rev.id
  }
  return true
}

async function rebaseAndPersist() {
  // Capture overlay BEFORE any persistence — any unsynced local
  // edits the user has made on top of the previous baseState need
  // to survive the rebase. localState may already match the new
  // baseState (e.g. ack flow where pending.changeset has been
  // folded into baseState), in which case the overlay is empty.
  const overlay = computeChangeset(session.baseState, session.localState)
  // baseState was already updated by the caller (applyChainToBase
  // or the ack path). Re-apply the user's overlay on top so their
  // unsynced edits remain visible.
  session.localState = applyChangeset(session.baseState, overlay)
  suppressNotify++
  try {
    applyToReactiveState(session.localState, session.ids)
    await saveTriage()
  } finally {
    suppressNotify--
  }
  render()
}

async function handleAck(msg) {
  // The pending save was accepted as revision `msg.id`, built on
  // `msg.base`. Verify the base matches what we sent and fold the
  // pending changeset into baseState so it becomes the new agreed
  // floor.
  if (!session?.pending) return
  if (msg.base !== session.pending.base) {
    console.warn(`Triage sync: ack base mismatch (pending ${session.pending.base}, ack ${msg.base})`)
    return
  }
  session.baseState = applyChangeset(session.baseState, session.pending.changeset)
  session.baseRevision = msg.id
  session.pending = null
  await rebaseAndPersist()
  // The user may have edited during the round-trip; if there's a
  // residual overlay (or pendingSave was raised), flush it.
  if (session.pendingSave || !statesEqual(session.localState, session.baseState)) {
    session.pendingSave = false
    trySendSave()
  }
}

async function handleChain(revisions) {
  if (!Array.isArray(revisions) || revisions.length === 0) return
  if (!session?.key) return  // key not derived yet; bail (a future open will retry)
  if (!await applyChainToBase(revisions)) {
    // Chain didn't apply cleanly. Fall back: pretend our base is
    // empty and resend full state. Next save will rebuild from 0.
    session.pending = null
    session.pendingSave = false
    await rebaseAndPersist()
    trySendSave()
    return
  }
  // If a save was in flight when the chain arrived, the server is
  // implicitly rejecting it (it brought us forward without acking).
  // Clear pending so the next save recomputes the changeset against
  // the freshly-rebased baseState.
  if (session.pending) {
    session.pending = null
    session.pendingSave = true
  }
  await rebaseAndPersist()
  if (session.pendingSave || !statesEqual(session.localState, session.baseState)) {
    session.pendingSave = false
    trySendSave()
  }
}

async function handleMessage(data) {
  let msg
  try { msg = JSON.parse(data) } catch { return }
  if (!msg || typeof msg !== 'object') return
  // Match the message to our active session by tag, not UUID —
  // the wire never sees the UUID. A null tag (key derivation
  // hasn't finished) means we can't match anything yet; drop.
  if (!session || !session.workspaceTag) return
  if (msg.workspaceTag !== session.workspaceTag) return
  if (msg.type === 'workspace-save-ack') {
    await handleAck(msg)
  } else if (msg.type === 'workspace-state') {
    await handleChain(msg.revisions)
  }
}

// ─────────── connection lifecycle ───────────

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
    if (session) {
      // Re-establish against the freshly opened socket. baseState /
      // baseRevision survived the disconnect; subscribed resets so
      // we re-subscribe on this fresh socket; if there's an
      // overlay (or we hadn't sent the initial state yet),
      // trySendSave pushes it.
      session.pending = null
      session.pendingSave = false
      session.subscribed = false
      trySendSubscribe()
      trySendSave()
    }
  })
  ws.addEventListener('message', (e) => handleMessage(e.data))
  ws.addEventListener('close', () => {
    if (socket === ws) socket = null
    if (session) {
      // The pending request is gone with the socket. Mark the slot
      // free; reconnect handler will resend. `subscribed` clears
      // so reconnect can re-subscribe.
      session.pending = null
      session.subscribed = false
      session.pendingSave = !statesEqual(session.localState, session.baseState)
    }
    if (serverUrl) scheduleReconnect()
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
    if (next) openSocket()
  },

  getServerUrl() { return serverUrl },

  get connected() { return socket?.readyState === WebSocket.OPEN },

  // Called by triage.js at the tail of saveTriage(). When inside
  // applyChainToBase / handleAck (suppressNotify > 0), bail — that
  // path already owns persistence. Otherwise schedule a save against
  // the active session; the helper handles the inFlight gating.
  notify() {
    if (suppressNotify > 0) return
    if (!session) return
    trySendSave()
  },

  // Open a per-workspace session. Called by ingest.js after every
  // report in the workspace is loaded into state.reports — so the
  // workspace-id set built here matches the actual content. A
  // second call with the same id is idempotent; a different id
  // closes the previous session first.
  openSession(workspaceId) {
    if (!workspaceId) return
    if (session?.workspaceId === workspaceId) return
    this.closeSession()
    const ws = listWorkspaces().find((w) => w.id === workspaceId)
    if (!ws) return
    const ids = buildWorkspaceIds()
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
      // Until the server tells us its current revision, we have no
      // base. localState is whatever's in state.* right now;
      // baseState is empty so the first save's changeset is the
      // user's full local snapshot vs. nothing.
      baseRevision: null,
      baseState: {},
      localState: buildLocalState(ids),
      pending: null,
      pendingSave: false,
      key: null,
      encrypting: false,
      // Flips true once we ship a `workspace-subscribe` over the
      // current socket; resets on socket close so reconnects
      // re-subscribe. Decoupled from `pending` (saves) because a
      // workspace whose state is in sync still wants broadcasts.
      subscribed: false,
    }
    session = newSession
    // Derive content-encryption key + Ed25519 signing keypair in
    // parallel. Both come off the same private key via HKDF with
    // different domain-separating info strings. If the session
    // gets replaced or closed before derivation finishes, the
    // identity check drops the result.
    Promise.all([
      deriveSessionKey(ws.privateKey),
      deriveSigningKeypair(ws.privateKey, workspaceId),
    ]).then(([key, kp]) => {
      if (session !== newSession) return
      session.key = key
      session.signingKey = kp.privateKey
      session.verifyingKey = kp.publicKey
      session.workspaceTag = kp.publicKeyB64
      // Subscribe + flush any pending save now that we have keys.
      // Subscribe gets us broadcast-eligibility regardless of
      // whether there's anything to push.
      if (socket?.readyState === WebSocket.OPEN) {
        trySendSubscribe()
        trySendSave()
      }
    }).catch((err) => {
      console.warn('Triage sync: key derivation failed:', err)
    })
  },

  closeSession() {
    if (!session) return
    session = null
  },

  // Read-only handle for callers that want to inspect session state
  // (debugging, tests). Not for mutation — that goes through notify
  // / openSession / closeSession above.
  get sessionInfo() {
    if (!session) return null
    return {
      workspaceId: session.workspaceId,
      workspaceTag: session.workspaceTag,
      baseRevision: session.baseRevision,
      pending: session.pending && { base: session.pending.base },
      pendingSave: session.pendingSave,
      keyReady: session.key !== null,
      encrypting: session.encrypting,
      tracked: session.ids.size,
    }
  },
}

// Restore a saved server URL on module load. Does NOT auto-enable
// sync when no URL has ever been set — the feature stays opt-in
// until the user calls `setServerUrl`.
try {
  const saved = localStorage.getItem(STORAGE_KEY) ?? ''
  if (saved) {
    serverUrl = saved
    openSocket()
  }
} catch {}
