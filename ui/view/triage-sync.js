import { state } from './state.js'
import { saveTriage } from './triage.js'
import { render } from './render.js'

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
//   client → server  workspace-save { workspaceId, base, changeset }
//   server → client  workspace-save-ack { workspaceId, base, id }
//   server → client  workspace-state { workspaceId, revisions:
//                      [{ base, id, changeset }, ...] }
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

function trySendSave() {
  if (!session) return
  if (!socket || socket.readyState !== WebSocket.OPEN) return
  if (session.pending) {
    session.pendingSave = true
    return
  }
  // Refresh localState from the live state.* containers in case
  // saveTriage just persisted edits we haven't snapshotted yet.
  session.localState = buildLocalState(session.ids)
  const changeset = computeChangeset(session.baseState, session.localState)
  if (changesetEmpty(changeset)) return
  session.pending = { base: session.baseRevision, changeset }
  session.pendingSave = false
  send({
    type: 'workspace-save',
    workspaceId: session.workspaceId,
    base: session.baseRevision,
    changeset,
  })
}

// Apply a chain of revisions (each `{ base, id, changeset }`) to
// baseState. Verifies continuity — every revision's `base` must
// equal the current baseRevision before its changeset applies, so
// out-of-order or gappy chains don't silently corrupt state.
// Returns true on success. On failure, baseState is left untouched
// from the failure point onward and we resync (clear baseRevision
// to force the next save to send everything again).
function applyChainToBase(revisions) {
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
    session.baseState = applyChangeset(session.baseState, rev.changeset ?? {})
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
  if (!applyChainToBase(revisions)) {
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
  if (!session || msg.workspaceId !== session.workspaceId) return
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
      // baseRevision survived the disconnect; if there's an overlay
      // (or we hadn't sent the initial state yet), trySendSave
      // pushes it.
      session.pending = null
      session.pendingSave = false
      trySendSave()
    }
  })
  ws.addEventListener('message', (e) => handleMessage(e.data))
  ws.addEventListener('close', () => {
    if (socket === ws) socket = null
    if (session) {
      // The pending request is gone with the socket. Mark the slot
      // free; reconnect handler will resend.
      session.pending = null
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
    const ids = buildWorkspaceIds()
    session = {
      workspaceId,
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
    }
    if (socket?.readyState === WebSocket.OPEN) trySendSave()
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
      baseRevision: session.baseRevision,
      pending: session.pending && { base: session.pending.base },
      pendingSave: session.pendingSave,
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
