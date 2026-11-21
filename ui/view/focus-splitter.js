// Drag-to-resize for the focus view's finding-card | Code split, kept in
// `state.focusSplit` as the divider's percentage along `.focus-main` (50 is
// 1:1) and reaching the grid as `--focus-split`, bound per render
// (render.js) and moved live here.
//
// A drag never renders: the split is pure layout, and a pointermove-rate
// render would rebuild the card and every highlighted Code line. Writing
// `state.focusSplit` is free (the main render is a plain function, and no
// StateElement reads it), so the CSS property write beside it moves the
// panes, and a render from elsewhere mid-drag paints the live position.
// The value persists to localStorage on release (and after a keyboard nudge
// or reset): a layout preference, like viewMode and severityMode.
import { FOCUS_SPLIT_DEFAULT, FOCUS_SPLIT_KEY, clampFocusSplit, state } from '#client/index.js'

// Percentage points per arrow press on the focused handle — the ARIA
// separator pattern (events.js routes ← / → here before navigateFocus).
export const FOCUS_SPLIT_STEP = 2

// `aria-valuenow` follows the drag, so a screen reader tracking the
// separator hears it, not just its end.
function applySplit(handle, pct) {
  state.focusSplit = pct
  handle.closest('.focus-main')?.style.setProperty('--focus-split', String(pct))
  handle.setAttribute('aria-valuenow', String(Math.round(pct)))
}

function persistSplit() {
  try { localStorage.setItem(FOCUS_SPLIT_KEY, String(state.focusSplit)) } catch {}
}

function setFocusSplit(handle, pct) {
  applySplit(handle, clampFocusSplit(pct))
  persistSplit()
}

export function nudgeFocusSplit(handle, delta) {
  setFocusSplit(handle, state.focusSplit + delta)
}

export function resetFocusSplit(handle) {
  setFocusSplit(handle, FOCUS_SPLIT_DEFAULT)
}

// The handle captures the pointer, so its own move / release listeners see
// the whole gesture, the cursor run off over the Code scroller or past the
// window edge included.
export function startFocusSplitDrag(handle, e) {
  const main = handle.closest('.focus-main')
  if (!main) return
  // No text selection in the pane the pointer began over — and no focus on
  // the handle either: a mouse user still expects ← / → to walk the queue,
  // where focus here would quietly turn them into 2% nudges. Keyboard users
  // tab to the handle, the only way its `:focus-visible` ring shows anyway.
  e.preventDefault()
  handle.classList.add('dragging')
  try { handle.setPointerCapture(e.pointerId) } catch {}

  const onMove = (ev) => {
    const rect = main.getBoundingClientRect()
    if (rect.width === 0) return
    // The cursor's fraction of the pane IS the split: the grid centres the
    // divider on it (findings.css), so the handle stays under the pointer.
    applySplit(handle, clampFocusSplit(((ev.clientX - rect.left) / rect.width) * 100))
  }
  const onEnd = () => {
    handle.removeEventListener('pointermove', onMove)
    handle.removeEventListener('pointerup', onEnd)
    handle.removeEventListener('pointercancel', onEnd)
    handle.classList.remove('dragging')
    persistSplit()
  }
  handle.addEventListener('pointermove', onMove)
  handle.addEventListener('pointerup', onEnd)
  handle.addEventListener('pointercancel', onEnd)
}
