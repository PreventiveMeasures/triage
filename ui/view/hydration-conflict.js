import { setHydrationConflictResolver } from '../../client/triage-sync.ts'
import { buildFindingLookupForLoadedReports } from '../../client/finding-lookup.js'
import { resolveTriageConflicts } from './triage-conflict-dialog.js'

// Wires the per-finding conflict dialog into the report-attach
// hydration path. Called once at app boot.
//
// When the user attaches a report to a workspace and the chain's
// baseState has triage values (from a peer) that disagree with the
// local state.* for the same finding-id, triage-sync fires the
// resolver registered here. The headless lookup helper builds the
// per-finding metadata map (severity / file:line / description) from
// the already-ingested `state.reports`, then `resolveTriageConflicts`
// drives the lit dialog.

export function installHydrationConflictResolver() {
  setHydrationConflictResolver((conflicts) => {
    const lookup = buildFindingLookupForLoadedReports(conflicts)
    return resolveTriageConflicts(conflicts, lookup, {
      title: 'Synced triage on report attach',
      intro: 'have triage from your workspace that disagrees with your local view on',
      // Disclose that non-conflicting chain values were already
      // gap-filled into state.* before this dialog opened —
      // cancelling only keeps your local values for the conflicting
      // findings shown here, not for everything in the chain.
      // Audit L1 round-5.
      trailingNote: 'Other findings in this report whose chain value didn\'t conflict were applied automatically; this list only covers disagreements. Pick which side to keep.',
      importedSideLabel: 'Apply from chain',
      applyButton: 'Apply',
    })
  })
}
