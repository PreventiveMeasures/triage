import { state } from './state.js'
import { saveTriage } from './triage.js'
import { render } from './render.js'

// Triage sync — per-workspace WebSocket protocol that round-trips
// the workspace's color / deleted / comment state through a server
// using monotonically-increasing changeset revisions.
//
// Disabled by default. `setServerUrl(url)` enables; the saved URL
// also persists in localStorage for next page-load. With no URL the
// session machinery still tracks state internally but no message is
// ever sent — flipping the URL on later resumes from the live local
// state.
//
// Messages
// --------
//   client → server  workspace-load  { workspaceId, state, baseRevision }
//                    workspace-save  { workspaceId, state, baseRevision }
//   server → client  workspace-state { workspaceId, state, revision }
//
// A `workspace-state` reply covers both load responses, save acks,
// and broadcasts triggered by other clients — the client treats them
// uniformly: rebase on top, apply local diff, persist, re-render.
//
// Session state
// -------------
//   baseState     Last server-acknowledged state for the workspace.
//   baseRevision  Revision number that goes with baseState.
//   localState    The user's current state (= baseState + their
//                 edits since the last ack).
//   inFlight      A workspace-load or workspace-save is awaiting a
//                 reply. While set, no new request is sent.
//   pendingSave   Local change happened during inFlight — once the
//                 reply lands, send a fresh save.
//
// Race protocol
// -------------
// One in-flight request per session at a time. Local edits during
// in-flight raise `pendingSave`. A new `workspace-state` arriving
// from any source rebases: compute overlay = localState - baseState,
// replace baseState with the server's, replay the overlay on top so
// any unsynced edits survive the rebase. Stale revisions (≤ the
// baseRevision we already applied) are dropped — that handles the
// echo case where the server broadcasts our own ack to us.
//
// On reconnect after a drop the client sends a fresh workspace-load
// with the current localState + baseRevision so the server can
// either accept the snapshot (handing back a new revision) or
// merge it in.

const STORAGE_KEY = 'deepview.triageSyncUrl'
const SESSION_ID_RE = /^\d+$/u

let serverUrl = ''
let socket = null
let reconnectTimer = null
let reconnectDelayMs = 1_000
const MAX_RECONNECT_DELAY = 30_000
// Re-entrancy guard. Bumped while we're applying a remote state so
// the saveTriage at the tail doesn't trigger a notify and bounce
// the same change back at the server.
let suppressNotify = 0
// Active per-workspace session (or null when no workspace is
// loaded). Mutually exclusive with single-file mode — sync is a
// workspace concept here.
let session = null

function snapshotEntry(id) {
  const entry = {}
  const color = state.markers.get(id)
  if (color !== undefined) entry.color = color
  if (state.deletedIds.has(id)) entry.deleted = true
  const comment = state.comments.get(id)
  if (comment) entry.comment = comment
  return entry
}

// Workspace's set of triageable finding ids — every finding loaded
// into state.reports right now, minus the session-only numeric `_id`
// keys that don't round-trip through localStorage either.
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

// Subset of state.markers / .deletedIds / .comments restricted to
// `ids`. Empty entries are omitted so the wire shape only carries
// findings the user has actually triaged.
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

// Per-id changes that turn `base` into `local`. `null` represents
// an explicit deletion of an entry that existed in `base`. Used to
// preserve the user's unsynced edits across a rebase.
function computeOverlay(base, local) {
  const overlay = {}
  const ids = new Set([...Object.keys(base), ...Object.keys(local)])
  for (const id of ids) {
    const b = base[id] ?? {}
    const l = local[id] ?? {}
    if (!entriesEqual(b, l)) overlay[id] = local[id] ?? null
  }
  return overlay
}

function mergeStates(base, overlay) {
  const out = { ...base }
  for (const [id, entry] of Object.entries(overlay)) {
    if (entry === null) delete out[id]
    else out[id] = entry
  }
  return out
}

// Reflect `targetState` into the in-memory state.* containers,
// scoped to `ids` — entries outside the workspace's scope are left
// alone so single-file triage doesn't get clobbered when a
// workspace is open.
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

function trySendInit() {
  if (!session || session.inFlight) return
  if (!send({
    type: 'workspace-load',
    workspaceId: session.workspaceId,
    state: session.localState,
    baseRevision: session.baseRevision,
  })) return
  session.inFlight = true
}

function trySendSave() {
  if (!session) return
  if (session.inFlight) {
    session.pendingSave = true
    return
  }
  // Refresh localState from current state.* in case it drifted
  // since we last touched it (e.g. saveTriage just persisted a
  // change that landed via the user's UI clicks).
  session.localState = buildLocalState(session.ids)
  if (statesEqual(session.localState, session.baseState)) return
  if (!send({
    type: 'workspace-save',
    workspaceId: session.workspaceId,
    state: session.localState,
    baseRevision: session.baseRevision,
  })) return
  session.inFlight = true
  session.pendingSave = false
}

async function applyServerState(remoteState, remoteRevision) {
  if (!session) return
  // Drop stale broadcasts (e.g. the server echoing our own ack
  // back at us after we've already applied it).
  if (
    session.baseRevision != null
    && remoteRevision != null
    && remoteRevision <= session.baseRevision
  ) return
  // Capture the user's unsaved edits before swapping the base.
  const overlay = computeOverlay(session.baseState, session.localState)
  session.baseState = remoteState
  session.baseRevision = remoteRevision
  session.localState = mergeStates(remoteState, overlay)

  suppressNotify++
  try {
    applyToReactiveState(session.localState, session.ids)
    await saveTriage()
  } finally {
    suppressNotify--
  }
  render()
}

async function handleMessage(data) {
  let msg
  try { msg = JSON.parse(data) } catch { return }
  if (!msg || typeof msg !== 'object') return
  if (!session || msg.workspaceId !== session.workspaceId) return
  if (msg.type !== 'workspace-state') return
  await applyServerState(msg.state ?? {}, msg.revision)
  // Reply consumed — request slot is free again.
  session.inFlight = false
  // If the user kept editing during the round-trip OR the rebase
  // left an overlay (we had unsaved changes that the server hasn't
  // seen), follow up with another save.
  if (session.pendingSave || !statesEqual(session.localState, session.baseState)) {
    session.pendingSave = false
    trySendSave()
  }
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
    if (session) {
      // Re-establish the session against the freshly opened socket.
      // baseState / baseRevision survive the disconnect; the load
      // request lets the server merge any updates we missed while
      // offline.
      session.inFlight = false
      session.pendingSave = false
      trySendInit()
    }
  })
  ws.addEventListener('message', (e) => handleMessage(e.data))
  ws.addEventListener('close', () => {
    if (socket === ws) socket = null
    if (session) {
      // The pending request is gone with the socket. Mark the slot
      // free and remember to save once we reconnect.
      session.inFlight = false
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

  // Called by triage.js at the tail of saveTriage(). When inside an
  // applyServerState (suppressNotify > 0), bail — that path already
  // owns the persistence side. Otherwise schedule a save against
  // the active session; the helper handles the inFlight / queue
  // gating.
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
      // Until the first server response lands, we have no idea what
      // the server's revision is. localState is whatever we're
      // currently looking at; baseState is empty so the first load
      // sends the full snapshot up.
      baseRevision: null,
      baseState: {},
      localState: buildLocalState(ids),
      inFlight: false,
      pendingSave: false,
    }
    if (socket?.readyState === WebSocket.OPEN) trySendInit()
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
      inFlight: session.inFlight,
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
