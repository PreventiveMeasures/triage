import { state } from './state.js'
import { saveTriage } from './triage.js'
import { render } from './render.js'

// `window.DeepView` — a small read-mostly façade over the in-memory
// state for browser-console / external-script use. Findings + groups
// are exposed as live getters that snapshot the current state on
// each access; triage entries (markers / deleted / comments) come
// out as fresh `Map` / `Set` copies so a caller can iterate without
// risk of mutating the live store. `triage.set(id, …)` is the one
// write-through path: it updates the observed `state.*` containers,
// persists via `saveTriage()`, and re-renders so a console-driven
// triage edit lights up the UI immediately.
//
// IDs follow the same convention the renderer uses (`tabKey(f)` =
// `f.id ?? String(f._id)`): non-numeric values are uuid-shaped
// (analyzer-export id, codex finding-url id, deterministic
// markdown id) and persist; numeric strings are session-only and
// don't round-trip.

const triage = {
  get markers() { return new Map(state.markers) },
  get deletedIds() { return new Set(state.deletedIds) },
  get comments() { return new Map(state.comments) },

  // Bundle every triage field for one finding into a single object,
  // omitting absent properties — matches the persisted shape so a
  // round-trip via JSON is straightforward.
  get(id) {
    const out = {}
    const color = state.markers.get(id)
    if (color !== undefined) out.color = color
    if (state.deletedIds.has(id)) out.deleted = true
    const comment = state.comments.get(id)
    if (comment) out.comment = comment
    return out
  },

  // Apply a partial update. Pass `null` (or `''`) to clear a field;
  // an `undefined` field is left alone. Returns the boolean "did
  // anything change" so callers can short-circuit. Async because the
  // saveTriage write is async; the UI render fires after persistence.
  async set(id, { color, deleted, comment } = {}) {
    let changed = false
    if (color !== undefined) {
      if (color === null || color === '') {
        if (state.markers.delete(id)) changed = true
      } else if (state.markers.get(id) !== color) {
        state.markers.set(id, color)
        changed = true
      }
    }
    if (deleted !== undefined) {
      if (deleted) {
        if (!state.deletedIds.has(id)) { state.deletedIds.add(id); changed = true }
      } else if (state.deletedIds.delete(id)) {
        changed = true
      }
    }
    if (comment !== undefined) {
      const text = comment ? String(comment) : ''
      if (text) {
        if (state.comments.get(id) !== text) {
          state.comments.set(id, text)
          changed = true
        }
      } else if (state.comments.delete(id)) {
        changed = true
      }
    }
    if (changed) {
      await saveTriage()
      render()
    }
    return changed
  },
}

window.DeepView = {
  // Live snapshots of the active load. Each access re-flatten so a
  // caller iterating after a triage edit / file switch sees the
  // current shape. Returns shallow copies — mutating the returned
  // arrays doesn't touch `state`.
  get reports() { return state.reports.slice() },
  get groups() { return state.reports.flatMap((r) => r.groups) },
  get findings() { return state.reports.flatMap((r) => r.groups.flatMap((g) => g)) },

  // Identifies the active load: one of these is set when something
  // is open, both null on the empty drop-zone screen.
  get currentFile() { return state.currentFile },
  get currentWorkspace() { return state.currentWorkspace },

  triage,

  // Force a re-render — useful after external code mutates other
  // state (filters, sort, etc.) without going through the
  // triage.set helper above.
  refresh() { render() },
}
