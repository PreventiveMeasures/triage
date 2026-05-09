import { state } from '../../client/state.js'
import { setHydrationConflictResolver } from '../../client/triage-sync.js'
import { resolveTriageConflicts } from './triage-conflict-dialog.js'

// Wires the per-finding conflict dialog into the report-attach
// hydration path. Called once at app boot.
//
// When the user attaches a report to a workspace and the chain's
// baseState has triage values (from a peer) that disagree with the
// local state.* for the same finding-id, triage-sync fires the
// resolver registered here. We build a metadata lookup from the
// loaded reports (so the dialog can show severity / file:line /
// description for each conflicting finding) and hand off to the
// shared `resolveTriageConflicts` dialog.

function firstDescriptionLine(text) {
  if (!text) return ''
  for (const line of text.split('\n')) {
    if (line.trim()) return line.trim()
  }
  return ''
}

// Walk every loaded report to build `id → { severity, file, line,
// description }` for the conflicting ids. We only need entries for
// ids present in the conflicts list, so terminate as soon as
// they're all resolved (most reports won't contribute).
function buildLookupForConflicts(conflicts) {
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
      }
    }
  }
  return lookup
}

export function installHydrationConflictResolver() {
  setHydrationConflictResolver((conflicts) => {
    const lookup = buildLookupForConflicts(conflicts)
    return resolveTriageConflicts(conflicts, lookup, {
      title: 'Synced triage on report attach',
      intro: 'have triage from your workspace that disagrees with your local view on',
      trailingNote: 'Pick which side to keep — the chain has the values your peers see.',
      importedSideLabel: 'Apply from chain',
      applyButton: 'Apply',
    })
  })
}
