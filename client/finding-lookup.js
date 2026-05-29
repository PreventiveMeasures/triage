import { state } from './state.ts'

// Helpers that build per-finding metadata maps for conflict-resolution
// dialogs (workspace-import + the report-attach hydration path). The
// dialog UI itself lives in `ui/view/triage-conflict-dialog.js`; this
// module is the headless data-shaping side so the same logic is
// reachable from tests and from any future non-DOM consumer.

// First non-empty trimmed line of a description — the dialog shows
// it as a one-line preview per finding so the user can identify the
// row at a glance.
export function firstDescriptionLine(text) {
  if (!text) return ''
  for (const line of text.split('\n')) {
    if (line.trim()) return line.trim()
  }
  return ''
}

// Build `id → { severity, file, line, description }` for the
// conflicting ids by walking every report loaded into `state.reports`.
// Used by the hydration-conflict path: `state.reports` is already
// populated when a report-attach surfaces a conflict, so re-parsing
// raw report content (the workspace-import side) isn't needed.
//
// Terminates early once every wanted id has a lookup entry — most
// reports won't contribute, so a large workspace doesn't pay for
// unnecessary walks.
export function buildFindingLookupForLoadedReports(conflicts) {
  const wanted = new Set(conflicts.map((c) => c.id))
  const lookup = new Map()
  for (const r of state.reports) {
    for (const g of r.groups) {
      for (const f of g) {
        const id = f.id ?? String(f._id)
        if (!wanted.has(id) || lookup.has(id)) continue
        lookup.set(id, {
          severity: f.severity,
          file: f.file,
          line: f.line,
          description: firstDescriptionLine(f.description),
        })
        if (lookup.size === wanted.size) return lookup
      }
    }
  }
  return lookup
}
