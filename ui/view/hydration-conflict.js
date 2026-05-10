import { setHydrationConflictResolver } from '../../client/triage-sync.ts'
import { buildFindingLookupForLoadedReports } from '../../client/finding-lookup.js'
import { resolveTriageConflicts } from './triage-conflict-dialog.js'

// Wires the per-finding conflict dialog into both the report-attach
// hydration path AND the chain-receive path (a peer's broadcast — or
// our own first-sync catch-up — that disagrees per-property with the
// user's unsynced overlay). triage-sync calls the resolver with a
// `context` tag so the dialog strings reflect what just happened.
//
// When the user attaches a report to a workspace and the chain's
// baseState has triage values (from a peer) that disagree with the
// local state.* for the same finding-id, triage-sync fires the
// resolver registered here. The headless lookup helper builds the
// per-finding metadata map (severity / file:line / description) from
// the already-ingested `state.reports`, then `resolveTriageConflicts`
// drives the lit dialog.

const DIALOG_STRINGS = {
  attach: {
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
  },
  chain: {
    title: 'Triage conflict from peer update',
    intro: 'were changed by a peer (or by another tab) in a way that disagrees with your local triage on',
    trailingNote: 'Other findings whose remote value didn\'t conflict were applied automatically; this list only covers disagreements. Pick which side to keep — cancelling keeps your local value (which will then propagate back to the chain on your next save).',
    importedSideLabel: 'Apply from chain',
    applyButton: 'Apply',
  },
}

export function installHydrationConflictResolver() {
  setHydrationConflictResolver((conflicts, _baseState, context) => {
    const lookup = buildFindingLookupForLoadedReports(conflicts)
    return resolveTriageConflicts(conflicts, lookup, DIALOG_STRINGS[context] ?? DIALOG_STRINGS.attach)
  })
}
