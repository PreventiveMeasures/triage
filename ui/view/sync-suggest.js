// When to auto-open the "Reports out of sync" suggestion
// (`<sync-suggest-dialog>`). The sync badge calls `suggestSync` every
// time it renders a workspace with reports that differ from their
// cloud copies; this decides whether that becomes a dialog:
//
//   - once closed for a workspace — "Not now", ×, Esc, or "Sync" (which
//     moves on to the re-check) — it stays closed for that workspace
//     until the page reloads. Memory only, deliberately: a reload is a
//     fresh look, and the badge's "N differ" chunk keeps saying it
//     quietly meanwhile;
//   - never two at once — renders fire often, the dialog is one;
//   - if another modal is up it doesn't open on top of it: it asks for a
//     re-render a little later and tries again then, as long as the
//     reports still differ. Checked up front (`hasOpenModal`) —
//     `showModal()` stacks a second modal rather than refusing, so the
//     dialog helper's `modal-conflict` / `{ shown: false }` is only a
//     fallback (review r4099184485).
//
// Opened off the render path (a `setTimeout`), never inside one.
//
// A factory over the dialog's open helper, which render.js passes in —
// this module stays free of the dialog (and its CSS imports) so the
// policy is testable on its own.

const RETRY_AFTER_CONFLICT_MS = 1500

// Is a modal dialog open anywhere, including inside the (open) shadow
// roots the app's dialogs render into? `:modal` doesn't see through a
// shadow boundary, so walk into each one.
export function hasOpenModal(root = document) {
  if (root.querySelector(':modal')) return true
  for (const el of root.querySelectorAll('*')) {
    if (el.shadowRoot && hasOpenModal(el.shadowRoot)) return true
  }
  return false
}

// `open(names)` → `{ shown, sync }` (the dialog helper); `later(fn, ms)`
// schedules; `modalOpen()` says whether another dialog is up. Injectable
// for tests.
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
