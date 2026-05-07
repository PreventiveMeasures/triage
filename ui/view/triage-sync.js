import { state } from './state.js'
import { saveTriage } from './triage.js'
import { render } from './render.js'

// Triage sync — pushes local color / deleted / comment edits over a
// WebSocket and applies remote edits back into `state.*`. Disabled by
// default: `setServerUrl(url)` is the entry point. Each message
// (sent and received) carries an array of per-id `{ before, after }`
// pairs so a server (or peer) can detect conflicts and other clients
// can apply only the parts of an update they don't already have.
//
// Wire-up: triage.js calls `triageSync.notify()` at the tail of
// `saveTriage()`. That keeps every local mutation site (events.js,
// workspace-import.js, api.js) covered without each one having to
// remember to send. The cyclic import between triage.js and this
// module resolves cleanly: triage.js's `saveTriage` is read as a
// live binding, only invoked after both modules have finished
// loading (i.e. when a remote message arrives).
//
// Conflict policy is last-write-wins on receive — the `before` field
// in incoming messages is informational. A peer/server that wants to
// reject conflicting writes can use it to compare against its own
// authoritative state and reply with a corrective message.

const STORAGE_KEY = 'deepview.triageSyncUrl'

let serverUrl = ''
let socket = null
let reconnectTimer = null
let reconnectDelayMs = 1_000
const MAX_RECONNECT_DELAY = 30_000
// Re-entrancy guard. Bumped while we're applying a remote change so
// the saveTriage at the tail doesn't bounce the same change back.
let suppressNotify = 0
// Last sent / received state snapshot keyed by finding id; used as
// the `before` baseline for outgoing diffs and re-baselined after
// applying remote messages so we don't echo them.
let lastSnapshot = new Map()

function snapshotEntry(id) {
  const entry = {}
  const color = state.markers.get(id)
  if (color !== undefined) entry.color = color
  if (state.deletedIds.has(id)) entry.deleted = true
  const comment = state.comments.get(id)
  if (comment) entry.comment = comment
  return entry
}

function buildSnapshot() {
  const ids = new Set()
  for (const k of state.markers.keys()) ids.add(k)
  for (const k of state.deletedIds) ids.add(k)
  for (const k of state.comments.keys()) ids.add(k)
  const out = new Map()
  for (const id of ids) out.set(id, snapshotEntry(id))
  return out
}

function entriesEqual(a, b) {
  return a.color === b.color
    && Boolean(a.deleted) === Boolean(b.deleted)
    && (a.comment ?? '') === (b.comment ?? '')
}

function diffSnapshots(before, after) {
  const ids = new Set([...before.keys(), ...after.keys()])
  const changes = []
  for (const id of ids) {
    const b = before.get(id) ?? {}
    const a = after.get(id) ?? {}
    if (!entriesEqual(a, b)) changes.push({ id, before: b, after: a })
  }
  return changes
}

function applyEntry(id, entry) {
  if (entry.color) state.markers.set(id, entry.color)
  else state.markers.delete(id)
  if (entry.deleted) state.deletedIds.add(id)
  else state.deletedIds.delete(id)
  if (entry.comment) state.comments.set(id, entry.comment)
  else state.comments.delete(id)
}

async function handleRemoteMessage(data) {
  let msg
  try { msg = JSON.parse(data) } catch { return }
  if (msg?.type !== 'triage-update' || !Array.isArray(msg.changes)) return
  let touched = false
  suppressNotify++
  try {
    for (const change of msg.changes) {
      if (!change || typeof change.id !== 'string') continue
      const after = change.after ?? {}
      const local = snapshotEntry(change.id)
      if (entriesEqual(local, after)) continue
      applyEntry(change.id, after)
      touched = true
    }
    if (touched) {
      // Re-baseline BEFORE saveTriage so the embedded notify() is a no-op
      // (the diff against `lastSnapshot` would otherwise show our just-
      // -applied remote change as a local change to ship back).
      lastSnapshot = buildSnapshot()
      await saveTriage()
      render()
    }
  } finally {
    suppressNotify--
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
    // Re-baseline on (re)connect — the server may have authoritative
    // state we don't yet know about, but until we get a message
    // about it we trust local and won't ship anything that hasn't
    // changed since now.
    lastSnapshot = buildSnapshot()
  })
  ws.addEventListener('message', (e) => handleRemoteMessage(e.data))
  ws.addEventListener('close', () => {
    if (socket === ws) socket = null
    if (serverUrl) scheduleReconnect()
  })
  ws.addEventListener('error', () => {
    // The 'close' handler will fire right after — let it own the
    // reconnect schedule. Logging here is mostly noise for transient
    // disconnects.
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
  // Configure (or clear) the WebSocket endpoint. Empty / falsy URL
  // disables sync and closes any open connection. The URL is also
  // persisted to localStorage so it survives reloads — pass '' to
  // both disable and forget.
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

  // Connection state for callers / debugging.
  get connected() { return socket?.readyState === WebSocket.OPEN },

  // Called by triage.js at the tail of saveTriage(). Computes the
  // diff against the last shipped/received baseline and pushes a
  // single message with all per-id changes. No-ops when sync is
  // disabled, the socket isn't open, or we're inside an
  // applyRemoteMessage block (suppressNotify>0).
  notify() {
    if (suppressNotify > 0) return
    const next = buildSnapshot()
    const changes = diffSnapshots(lastSnapshot, next)
    if (changes.length === 0) return
    lastSnapshot = next
    const ws = socket
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    try {
      ws.send(JSON.stringify({ type: 'triage-update', changes }))
    } catch (err) {
      console.warn('Triage sync send failed:', err)
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

// Initial baseline — captured after module load so the first
// post-loadTriage notify() doesn't ship the entire persisted set as
// a "change". triage.js's loadTriage promise has fired by the time
// any saveTriage call runs, so this is good enough as a starting
// point.
lastSnapshot = buildSnapshot()
