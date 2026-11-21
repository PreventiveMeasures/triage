// Which layer a key press belongs to, for events.js's document-level key
// handlers. Import-free past open-modal.js, so node tests can drive it with a
// stub DOM.
import { hasOpen } from './open-modal.js'

// Whether a key belongs to something else: an open modal dialog, or a field
// being typed in. Walks the composed path, as an input inside a shadow root
// retargets `e.target` to its host. App dialogs render their `<dialog>` in a
// Lit shadow root, out of the querySelector's sight, but showModal() traps
// focus inside, so it is on the path whichever control holds focus.
export function focusNavBlocked(e, root = document) {
  if (root.querySelector('dialog[open]')) return true
  for (const el of e.composedPath()) {
    if (!el || el.nodeType !== 1) continue
    const tag = el.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
    if (tag === 'DIALOG' && el.open) return true
    if (el.isContentEditable) return true
  }
  return false
}

// The browser's own layers: a modal `<dialog>` (an `AppDialog`) and popovers
// (a finding card's triage menu). Each closes itself on Escape once the
// keydown has dispatched, so it is still open while a document listener
// reads the press. The shared hover tooltip is a manual popover that Escape
// only hides (tooltip.js): never one to leave the press to.
const NATIVE_LAYERS = 'dialog:modal, :popover-open:not(#styled-tooltip)'

// Is one of those open? Looked for in the shadow roots the app's dialogs and
// finding cards render into, too.
export const nativeLayerOpen = (root = document) => hasOpen(NATIVE_LAYERS, root)

// Escape unwinds one layer per press, the topmost: a dialog or popover
// (nativeLayerOpen), then the bundle source viewer, whose own listener closes
// its side panel and then itself, then the findings' layers here. `open` says
// which are up; returned is the one this press closes ('links-preview',
// 'kanban-modal' or 'kanban-column'), or null when the press is another's.
export function findingsEscapeLayer(e, open, root = document) {
  const { sourceViewer, linksPreview, kanbanModal, kanbanColumn } = open
  // The walk last: most presses have none of these layers up.
  if (sourceViewer || !(linksPreview || kanbanModal || kanbanColumn) || nativeLayerOpen(root)) return null
  // A field being typed in keeps its Escape, as does a handler that took it.
  if (linksPreview) return e.defaultPrevented || focusNavBlocked(e, root) ? null : 'links-preview'
  return kanbanModal ? 'kanban-modal' : 'kanban-column'
}
