import { buildFindingLookupForLoadedReports } from '#client/index.js'
import { setHydrationConflictResolver } from './client-sync.js'
// Up front, not in the dialogs' bundle (lazy-dialogs.js says why).
import { resolveTriageConflicts } from './dialogs/triage-conflict-dialog.js'

// The per-finding conflict dialog for triage-sync, whenever synced triage
// disagrees per property with the user's unsynced local overlay: on a
// report's attach, or a received chain (a peer's broadcast, or our own
// first-sync catch-up). Its `context` picks the strings; the lookup gives
// each finding's severity / file:line / description from `state.reports`.
const DIALOG_BUTTONS = { importedSideLabel: 'Apply from chain', applyButton: 'Apply' }
const DIALOG_STRINGS = {
  attach: {
    title: 'Synced triage on report attach',
    intro: 'have triage from your workspace that disagrees with your local view on',
    // Discloses that non-conflicting chain values were already applied.
    trailingNote: 'Other findings in this report whose chain value didn\'t conflict were applied automatically; this list only covers disagreements. Pick which side to keep.',
    ...DIALOG_BUTTONS,
  },
  chain: {
    title: 'Triage conflict from peer update',
    intro: 'were changed by a peer (or by another tab) in a way that disagrees with your local triage on',
    trailingNote: 'Other findings whose remote value didn\'t conflict were applied automatically; this list only covers disagreements. Pick which side to keep for each — a "keep current" pick re-publishes your local value to the chain on your next save.',
    ...DIALOG_BUTTONS,
  },
}

export function installHydrationConflictResolver() {
  setHydrationConflictResolver(async (conflicts, _baseState, context) => {
    const lookup = buildFindingLookupForLoadedReports(conflicts)
    try {
      return await resolveTriageConflicts(conflicts, lookup, DIALOG_STRINGS[context] ?? DIALOG_STRINGS.attach)
    } catch {
      // Another dialog is open, so the user can't pick: say local was kept
      // (lest a chain catch-up silently override their view), then fall to
      // triage-sync's null-keeps-local path. No "try again": the catch-up is
      // passive, and local wins back to the chain on the next save.
      const n = conflicts.length
      const what = context === 'attach' ? 'A report attach' : 'A workspace sync'
      const recovery = context === 'attach'
        ? 'Detach and re-attach the report to pick again.'
        : 'Your local values will re-publish to the chain on the next change.'
      alert(`${what} had ${n} triage disagreement${n === 1 ? '' : 's'} with your local view. Kept your local values because another dialog is open. ${recovery}`)
      return null
    }
  })
}
