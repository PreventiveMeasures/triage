// Enter and Space on a focusable element wired for clicks alone, as the
// click it stands in for (events.js clicks it, so the click delegates run
// as for the mouse): render.js's compact cards (`role="button"`: the
// kanban board's, the kanban dialog's rail, the focus queue), the table
// view's `<finding-row>`s and the Files tab's rows.
export const KEY_CLICK_TARGETS = '.kanban-card[role="button"], finding-row, .tree-table-row[data-tree-select]'

// The element a keydown activates, else null. Only one that itself holds
// focus: `composedPath()[0]` is the focused element even in a shadow root
// (`<finding-table>`'s rows reach #report retargeted to the table), and a
// key from a control inside the card or row (an action button, a link, a
// tab, one in a shadow root retargeted to its host) is that control's. Not
// with a modifier, mid-composition, or while a dialog is open: app dialogs
// render their `<dialog>` in a Lit shadow root, out of the querySelector's
// sight, but showModal() traps focus inside, so it is on the path then.
export function keyClickTarget(e, selector = KEY_CLICK_TARGETS, doc = document) {
  if (e.key !== 'Enter' && e.key !== ' ') return null
  if (e.defaultPrevented || e.isComposing || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return null
  const path = e.composedPath()
  const el = path[0]
  if (!el?.matches?.(selector)) return null
  if (doc.querySelector('dialog[open]')) return null
  if (path.some((node) => node?.tagName === 'DIALOG' && node.open)) return null
  return el
}
