// When the "Reports out of sync" suggestion (`<sync-suggest-dialog>`) opens.
// The sync badge calls `suggestSync` on every render of a workspace whose
// reports differ from their cloud copies; the dialog opens:
//   - until closed for that workspace (Not now, ×, Esc, or Sync) — in
//     memory only, as a reload is a fresh look, and the badge's "N differ"
//     keeps saying it meanwhile;
//   - one at a time, though renders fire often;
//   - not over another modal: it asks for a re-render a little later and
//     tries again while the reports still differ. Checked up front, as
//     `showModal()` stacks rather than refuses; the helper's `{ shown:
//     false }` is only the fallback (review r4099184485).
// Always off the render path (a `setTimeout`). A factory over the dialog's
// open helper, which render.js passes in, so the policy tests without it.

import { hasOpenModal } from './open-modal.js'

export { hasOpenModal }

const RETRY_AFTER_CONFLICT_MS = 1500

// `open(names)` → `{ shown, sync }`; `later(fn, ms)` schedules; `modalOpen()`
// says whether another dialog is up. Injectable for tests.
export function createSyncSuggester({ open, later = (fn, ms) => setTimeout(fn, ms), modalOpen = () => hasOpenModal() }) {
  const closedFor = new Set()
  let showing = false

  // `onSync()` runs when the user picks "Sync"; `retry()` re-renders so
  // the badge calls back in after a modal conflict.
  function suggestSync(workspaceId, names, { onSync, retry } = {}) {
    if (!workspaceId || !Array.isArray(names) || names.length === 0) return
    if (showing || closedFor.has(workspaceId)) return
    showing = true
    later(async () => {
      let result
      if (modalOpen()) result = { shown: false, sync: false }
      else {
        try { result = await open([...names]) }
        catch { result = { shown: false, sync: false } }
      }
      showing = false
      if (!result.shown) {
        if (typeof retry === 'function') later(retry, RETRY_AFTER_CONFLICT_MS)
        return
      }
      closedFor.add(workspaceId)
      if (result.sync && typeof onSync === 'function') onSync()
    }, 0)
  }

  return { suggestSync, isClosedFor: (workspaceId) => closedFor.has(workspaceId) }
}
