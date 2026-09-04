// Drag-to-resize for the focus view's finding-card | Code split.
//
// The split lives in `state.focusSplit` as the divider's position
// along `.focus-main` in percent (50 = the 1:1 default) and reaches
// the grid as the `--focus-split` custom property, bound per-render
// in render.js and moved live by the drag below.
//
// A drag deliberately does NOT call render(): the split is pure
// layout, and a pointermove-rate render would rebuild the
// finding-card and every highlighted line of the Code panel for it.
// Writing `state.focusSplit` is free here — the main render is a
// plain function, not an observer-util autorun, and no StateElement
// reads the field — so the CSS property write next to it is what
// actually moves the panes. A render() triggered from elsewhere
// mid-drag still paints the live position, since it reads the same
// state the drag has been updating.
//
// The value is persisted to raw localStorage on release (and after a
// keyboard nudge / reset): a non-sensitive layout preference, stored
// like viewMode and severityMode, so the pane widths the user settled
// on survive a reload.
import { FOCUS_SPLIT_DEFAULT, FOCUS_SPLIT_KEY, clampFocusSplit, state } from '#client/index.js'

// Keyboard nudge per arrow press, in percentage points — the ARIA
// separator pattern: while the handle holds focus, ← / → walk the
// divider instead of the "up next" queue (see the keydown handler in
// events.js, which routes the key here before navigateFocus).
export const FOCUS_SPLIT_STEP = 2

// Live-move the divider. `aria-valuenow` is updated in step so a
// screen reader tracking the separator hears the drag, not just its
// endpoint (the next render re-derives the same value from state).
function applySplit(handle, pct) {
  state.focusSplit = pct
  handle.closest('.focus-main')?.style.setProperty('--focus-split', String(pct))
  handle.setAttribute('aria-valuenow', String(Math.round(pct)))
}

function persistSplit() {
  try { localStorage.setItem(FOCUS_SPLIT_KEY, String(state.focusSplit)) } catch {}
}

// Move + persist in one go — the settled-value path behind the
// keyboard nudge and the double-click reset (a drag persists once on
// release instead, see below).
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

// Pointer-driven resize. The handle captures the pointer, so the
// move / release listeners can sit on the handle itself and still see
// the whole gesture when the cursor runs off it — including out over
// the Code panel's scroller or past the window edge.
export function startFocusSplitDrag(handle, e) {
  const main = handle.closest('.focus-main')
  if (!main) return
  // preventDefault stops the drag from starting a text selection in
  // whichever pane the pointer began over. It deliberately doesn't
  // move DOM focus onto the handle either: a mouse user who has just
  // dragged the divider still expects ← / → to walk the queue, and
  // parking focus here would quietly turn those keys into 2% nudges
  // for the rest of the session. Keyboard users reach the same
  // nudges by tabbing to the handle, which is the only way its
  // `:focus-visible` ring shows up anyway.
  e.preventDefault()
  handle.classList.add('dragging')
  try { handle.setPointerCapture(e.pointerId) } catch {}

  const onMove = (ev) => {
    const rect = main.getBoundingClientRect()
    if (rect.width === 0) return
    // The cursor's fraction of the pane IS the split: the grid
    // centres the divider on that percentage (see findings.css), so
    // the handle stays under the pointer wherever it's dropped.
    applySplit(handle, clampFocusSplit(((ev.clientX - rect.left) / rect.width) * 100))
  }
  const onEnd = () => {
    handle.removeEventListener('pointermove', onMove)
    handle.removeEventListener('pointerup', onEnd)
    handle.removeEventListener('pointercancel', onEnd)
    handle.classList.remove('dragging')
    // The moves already wrote `state.focusSplit`; only the trip to
    // localStorage is worth saving for the release.
    persistSplit()
  }
  handle.addEventListener('pointermove', onMove)
  handle.addEventListener('pointerup', onEnd)
  handle.addEventListener('pointercancel', onEnd)
}
