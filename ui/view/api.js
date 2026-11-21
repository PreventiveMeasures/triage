import { patchEntry, saveTriage, state } from '#client/index.js'
import { triageSync } from './client-sync.js'
import { render } from './render.js'
import { forceManagedMode } from './sidebar.js'
import { openReportCompareDialog, openTriageExportDialog } from './lazy-dialogs.js'
import { getMergedGroups, triageReadOnly } from './group.js'
import { getTheme, setTheme } from './theme.js'

// `window.DeepView` — a small read-mostly façade over the in-memory state
// for the browser console and external scripts. Findings and groups are
// live getters; triage comes out as fresh Map copies. `triage.set` is the
// one write: it updates `state.triage`, persists and re-renders, and like
// the UI's controls refuses where triage is read-only (triageReadOnly).
//
// IDs are the renderer's (`tabKey(f)` = `f.id ?? String(f._id)`): uuid-shaped
// ones persist, numeric session-local ones don't round-trip.

const TRIAGE_BUCKETS = new Set(['inprogress', 'fixed', 'invalid', 'deleted', 'ignored'])

// One field of the triage map, by id; falsy values (the `false` flag
// tombstone among them) are left out.
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
  get flags() { return projectField('flagged') },

  // Every triage field of one finding, absent ones omitted — the persisted
  // shape. The flag's explicit `false` is kept; only unset is omitted.
  get(id) {
    const e = state.triage.get(id)
    const out = {}
    if (e?.color) out.color = e.color
    if (e?.triage) out.triage = e.triage
    if (e?.comment) out.comment = e.comment
    if (e?.fix) out.fix = e.fix
    if (e?.flagged !== undefined) out.flagged = e.flagged
    return out
  },

  // A partial update: `null` / `''` clears a field, `undefined` leaves it.
  // Resolves to whether anything changed, after persisting.
  async set(id, { color, triage: triageVal, comment, fix, flagged } = {}) {
    if (triageReadOnly()) throw new Error('DeepView.triage.set: triage is read-only on this page')
    let changed = false
    const put = (field, value) => {
      if (state.triage.get(id)?.[field] === value) return
      patchEntry(state.triage, id, { [field]: value })
      changed = true
    }
    const clear = (field) => { if (patchEntry(state.triage, id, { [field]: undefined })) changed = true }
    if (color !== undefined) {
      if (color === null || color === '') clear('color')
      else put('color', color)
    }
    if (triageVal !== undefined) {
      if (triageVal === null || triageVal === '' || triageVal === false) clear('triage')
      else if (TRIAGE_BUCKETS.has(triageVal)) put('triage', triageVal)
      else {
        throw new TypeError(
          `DeepView.triage.set: unknown triage value ${JSON.stringify(triageVal)} ` +
          "(expected 'inprogress' | 'fixed' | 'invalid' | 'deleted' | 'ignored' | null)",
        )
      }
    }
    for (const [field, value] of [['comment', comment], ['fix', fix]]) {
      if (value === undefined) continue
      const text = value ? String(value) : ''
      if (text) put(field, text)
      else clear(field)
    }
    // `true` flags, `false` keeps an explicit "unflagged" tombstone (so the
    // removal syncs), `null` / `''` unsets; other values coerce.
    if (flagged !== undefined) put('flagged', flagged === null || flagged === '' ? undefined : Boolean(flagged))
    if (changed) {
      await saveTriage()
      render()
    }
    return changed
  },
}

window.DeepView = {
  // Live snapshots of the active load; the returned arrays are copies.
  get reports() { return state.reports.slice() },
  get groups() { return getMergedGroups() },
  get findings() { return getMergedGroups().flat() },

  // The active load; both null on the empty drop-zone screen.
  get currentFile() { return state.currentFile },
  get currentWorkspace() { return state.currentWorkspace },

  triage,

  // Temporary managed surface on any server. Pass 'admin', 'manage', 'triage',
  // 'view', or 'none' for a fake @role / Role account without a backend.
  // Clicking managed restores the previous mode; refresh resets the override.
  forceManagedMode,

  // Persists the theme and updates the browser's theme-color tag.
  setTheme,
  get theme() { return getTheme() },

  // WebSocket sync for triage data, off until a server URL is set
  // (`DeepView.triageSync.setServerUrl('wss://your-host')`; see
  // client/triage-sync.js).
  triageSync,

  // Re-render after external code mutates other state (filters, sort, …).
  refresh() { render() },

  // The full-triage backup dialog (export + import); resolves on close.
  export() { return openTriageExportDialog() },

  // Hidden comparison tool for two local/E2E reports. Resolves on close.
  compareReports() { return openReportCompareDialog() },
}
