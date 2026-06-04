import { patchEntry, saveTriage, state } from '#client/index.js'
import { triageSync } from './client-sync.js'
import { render } from './render.js'
import { openTriageExportDialog } from './dialogs/triage-export-dialog.js'
import { getMergedGroups } from './group.js'
import { getTheme, setTheme, themes } from './theme.js'

// `window.DeepView` — a small read-mostly façade over the in-memory
// state for browser-console / external-script use. Findings + groups
// are live getters snapshotting current state per access; triage
// entries come out as fresh `Map` / `Set` copies so a caller can
// iterate without mutating the live store. `triage.set(id, …)` is
// the one write-through path: updates the observed `state.*`
// containers, persists via `saveTriage()`, and re-renders so a
// console-driven edit lights up the UI immediately.
//
// IDs follow the renderer's convention (`tabKey(f)` =
// `f.id ?? String(f._id)`): non-numeric values are uuid-shaped
// (analyzer-export, codex finding-url, deterministic markdown id)
// and persist; numeric strings are session-only and don't
// round-trip.

// Project the single triage map back into the per-field Maps the
// façade exposes.
function projectField(field) {
  const m = new Map()
  for (const [id, e] of state.triage) {
    if (e[field]) m.set(id, e[field])
  }
  return m
}

const triage = {
  get markers() { return projectField('color') },
  get triageState() { return projectField('triage') },
  get comments() { return projectField('comment') },
  get fixes() { return projectField('fix') },
  // Set of flagged finding ids (id → true). `projectField` skips the
  // falsy `false` tombstones, so this is the "currently flagged" view.
  get flags() { return projectField('flagged') },

  // Bundle every triage field for one finding into a single object,
  // omitting absent properties — matches the persisted shape so a
  // round-trip via JSON is straightforward.
  get(id) {
    const e = state.triage.get(id)
    const out = {}
    if (e?.color) out.color = e.color
    if (e?.triage) out.triage = e.triage
    if (e?.comment) out.comment = e.comment
    if (e?.fix) out.fix = e.fix
    // Tri-state: surface both `true` and the explicit `false`; only an
    // unset (undefined) flag is omitted.
    if (e?.flagged !== undefined) out.flagged = e.flagged
    return out
  },

  // Apply a partial update. Pass `null` (or `''`) to clear a field;
  // an `undefined` field is left alone. Returns the boolean "did
  // anything change" so callers can short-circuit. Async because the
  // saveTriage write is async; the UI render fires after persistence.
  async set(id, { color, triage: triageVal, comment, fix, flagged } = {}) {
    let changed = false
    if (color !== undefined) {
      if (color === null || color === '') {
        if (patchEntry(state.triage, id, { color: undefined })) changed = true
      } else if (state.triage.get(id)?.color !== color) {
        patchEntry(state.triage, id, { color })
        changed = true
      }
    }
    if (triageVal !== undefined) {
      if (triageVal === null || triageVal === '' || triageVal === false) {
        if (patchEntry(state.triage, id, { triage: undefined })) changed = true
      } else if (triageVal === 'inprogress' || triageVal === 'fixed' || triageVal === 'invalid' || triageVal === 'deleted') {
        if (state.triage.get(id)?.triage !== triageVal) {
          patchEntry(state.triage, id, { triage: triageVal })
          changed = true
        }
      } else {
        // Reject unknown triage values loudly. 'ignored' is a
        // common mistake — the per-report ignore set is keyed by
        // (reportName, id), not id alone, so it can't be expressed
        // through this id-only API. Use the per-finding ignore
        // button or the workspace import path instead.
        throw new TypeError(
          `DeepView.triage.set: unknown triage value ${JSON.stringify(triageVal)} ` +
          "(expected 'inprogress' | 'fixed' | 'invalid' | 'deleted' | null)",
        )
      }
    }
    if (comment !== undefined) {
      const text = comment ? String(comment) : ''
      if (text) {
        if (state.triage.get(id)?.comment !== text) {
          patchEntry(state.triage, id, { comment: text })
          changed = true
        }
      } else if (patchEntry(state.triage, id, { comment: undefined })) {
        changed = true
      }
    }
    if (fix !== undefined) {
      const text = fix ? String(fix) : ''
      if (text) {
        if (state.triage.get(id)?.fix !== text) {
          patchEntry(state.triage, id, { fix: text })
          changed = true
        }
      } else if (patchEntry(state.triage, id, { fix: undefined })) {
        changed = true
      }
    }
    if (flagged !== undefined) {
      // Tri-state: `true` → flagged, `false` → explicit "unflagged"
      // tombstone (kept so the removal still syncs); `null` or `''` →
      // clear to unset (undefined), matching the "pass null/'' to clear"
      // contract the string/bucket fields follow. Other values coerce.
      const next = (flagged === null || flagged === '') ? undefined : Boolean(flagged)
      if (state.triage.get(id)?.flagged !== next) {
        patchEntry(state.triage, id, { flagged: next })
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
  // Live snapshots of the active load — each access re-flattens so a
  // caller iterating after a triage edit / file switch sees the
  // current shape. Shallow copies: mutating the returned arrays
  // doesn't touch `state`.
  get reports() { return state.reports.slice() },
  get groups() { return getMergedGroups() },
  get findings() { return getMergedGroups().flat() },

  // Identifies the active load: one of these is set when something
  // is open, both null on the empty drop-zone screen.
  get currentFile() { return state.currentFile },
  get currentWorkspace() { return state.currentWorkspace },

  triage,

  // Theme switcher. The `<theme-toggle>` chrome button only ever
  // cycles between 'dark' and 'light'; the full `themes` list also
  // includes the 'green' / 'pink' easter-egg themes that are
  // reachable only through `setTheme(name)` here. Persists to
  // localStorage and re-paints the WCO title-bar via the meta
  // theme-color tag. Throws TypeError on an unknown name.
  themes,
  setTheme,
  get theme() { return getTheme() },

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
  // place). Bundles every persisted-id triage entry + all saved
  // repo URLs into a single gzipped JSON; the same dialog imports a
  // previously-exported backup with a choice of merge modes.
  // Returns a Promise resolving on dialog close — caller usually
  // doesn't await it (console command), but doing so is harmless.
  export() { return openTriageExportDialog() },
}
