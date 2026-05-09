import { state } from '../../client/state.js'
import { saveTriage } from '../../client/triage.js'
import { render } from './render.js'
import { triageSync } from '../../client/triage-sync.js'
import { openTriageExportDialog } from './triage-export-dialog.js'

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
  get triageState() { return new Map(state.triageState) },
  get comments() { return new Map(state.comments) },
  get fixes() { return new Map(state.fixes) },

  // Bundle every triage field for one finding into a single object,
  // omitting absent properties — matches the persisted shape so a
  // round-trip via JSON is straightforward.
  get(id) {
    const out = {}
    const color = state.markers.get(id)
    if (color !== undefined) out.color = color
    const triageVal = state.triageState.get(id)
    if (triageVal) out.triage = triageVal
    const comment = state.comments.get(id)
    if (comment) out.comment = comment
    const fix = state.fixes.get(id)
    if (fix) out.fix = fix
    return out
  },

  // Apply a partial update. Pass `null` (or `''`) to clear a field;
  // an `undefined` field is left alone. Returns the boolean "did
  // anything change" so callers can short-circuit. Async because the
  // saveTriage write is async; the UI render fires after persistence.
  async set(id, { color, triage: triageVal, comment, fix } = {}) {
    let changed = false
    if (color !== undefined) {
      if (color === null || color === '') {
        if (state.markers.delete(id)) changed = true
      } else if (state.markers.get(id) !== color) {
        state.markers.set(id, color)
        changed = true
      }
    }
    if (triageVal !== undefined) {
      if (triageVal === null || triageVal === '' || triageVal === false) {
        if (state.triageState.delete(id)) changed = true
      } else if (triageVal === 'fixed' || triageVal === 'invalid' || triageVal === 'deleted') {
        if (state.triageState.get(id) !== triageVal) {
          state.triageState.set(id, triageVal)
          changed = true
        }
      } else {
        // Reject unknown triage values loudly. 'ignored' is a
        // common mistake — the per-report ignore set is keyed by
        // (reportName, id), not by id alone, so it can't be
        // expressed through this id-only API. Use the per-finding
        // ignore button or the workspace import path instead.
        throw new TypeError(
          `DeepView.triage.set: unknown triage value ${JSON.stringify(triageVal)} ` +
          "(expected 'fixed' | 'invalid' | 'deleted' | null)",
        )
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
    if (fix !== undefined) {
      const text = fix ? String(fix) : ''
      if (text) {
        if (state.fixes.get(id) !== text) {
          state.fixes.set(id, text)
          changed = true
        }
      } else if (state.fixes.delete(id)) {
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
  get findings() { return state.reports.flatMap((r) => r.groups.flat()) },

  // Identifies the active load: one of these is set when something
  // is open, both null on the empty drop-zone screen.
  get currentFile() { return state.currentFile },
  get currentWorkspace() { return state.currentWorkspace },

  triage,

  // WebSocket sync for triage data — disabled until a server URL is
  // set. Sends/receives `{ type: 'triage-update', changes: [{ id,
  // before, after }, …] }`. See client/triage-sync.js for details.
  // Console: `DeepView.triageSync.setServerUrl('wss://your-host')`.
  triageSync,

  // Force a re-render — useful after external code mutates other
  // state (filters, sort, etc.) without going through the
  // triage.set helper above.
  refresh() { render() },

  // Opens the full-triage backup dialog (export + import in one
  // place). Bundles every persisted-id triage entry plus all
  // saved repo URLs into a single gzipped JSON; same dialog
  // imports a previously-exported backup with a choice of merge
  // modes. Returns a Promise that resolves when the dialog
  // closes — caller usually doesn't await it (it's a console
  // command), but doing so is harmless.
  export() { return openTriageExportDialog() },
}
