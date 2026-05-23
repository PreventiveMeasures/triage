// Shared styled-tooltip primitive. A single fixed-position element
// is appended to <body> at module load (escapes any view's
// `overflow: hidden`) and repositioned per show. Multiple consumers
// share the element: each calls `showTooltip(el)` / `hideTooltip()`
// and the `[data-tooltip]` attribute drives the text. Replaces the
// native `title=` browser tooltip — `title` reads as a webpage in
// the DeepView app shell (delayed, light gray, OS chrome) while we
// want an instant in-app affordance.
//
// `installGlobalTooltipListener` wires a document-level mouseover /
// mouseout pair that shows / hides for any `[data-tooltip]` element
// in the LIGHT DOM. Shadow-DOM consumers (e.g. the sidebar inside
// `<app-sidebar>`) install their own scoped listener — events don't
// bubble across the shadow boundary with their original target — and
// can drive the same show / hide helpers (`showTooltip(el, …)`).
//
// `gate` lets a caller short-circuit the show: the sidebar's listener
// only shows when the row's label is actually truncated (skip when
// the label fits) while the bundle view shows unconditionally.
//
// Placement: below the mouse cursor. The previous right-of-element
// anchor pushed tooltips off the right edge for any row near the
// viewport right, and overlapped the next column inside the bundle
// Overview grid. Below-cursor naturally stays within the column the
// user is hovering and clamps to the viewport on the horizontal axis.

let tipEl
function ensureEl() {
  if (tipEl) return tipEl
  tipEl = document.createElement('div')
  tipEl.id = 'styled-tooltip'
  document.body.append(tipEl)
  return tipEl
}

let currentTarget = null
let showTimer = null

// Last known cursor position — captured by the passive mousemove
// listener below. The tooltip anchors to this on show so the popup
// follows the cursor's location at the moment the show fires (after
// the SHOW_DELAY_MS hover delay), not the element's geometry.
let lastClientX = 0
let lastClientY = 0
let mouseTracked = false
function ensureMouseTracking() {
  if (mouseTracked) return
  mouseTracked = true
  document.addEventListener('mousemove', (e) => {
    lastClientX = e.clientX
    lastClientY = e.clientY
  }, { passive: true })
}
ensureMouseTracking()

const SHOW_DELAY_MS = 100
// Vertical offset between the cursor and the top of the tooltip.
// Just enough to clear the cursor sprite without feeling detached.
const CURSOR_GAP_PX = 14
// Horizontal margin reserved between the tooltip and the viewport
// edge when clamping.
const VIEWPORT_MARGIN_PX = 8

export function showTooltip(el) {
  const node = ensureEl()
  if (currentTarget === el) return
  const text = el.dataset.tooltip ?? ''
  if (!text) return
  node.textContent = text
  // Position below the cursor's last known location. Measure the
  // tooltip's width first so we can clamp horizontally — without
  // the clamp, hovering an element near the right edge of the
  // viewport (or near the right edge of a narrow column) would
  // push the tooltip past the right edge.
  //
  // The tooltip is `position: fixed`, so clientX / clientY are the
  // right anchor frame (no scroll offset needed).
  node.style.top = `${lastClientY + CURSOR_GAP_PX}px`
  node.style.left = '0px'
  node.classList.add('visible')
  const tipW = node.offsetWidth
  const maxLeft = window.innerWidth - tipW - VIEWPORT_MARGIN_PX
  const left = Math.max(VIEWPORT_MARGIN_PX, Math.min(lastClientX, maxLeft))
  node.style.left = `${Math.round(left)}px`
  currentTarget = el
}

export function hideTooltip() {
  clearTimeout(showTimer)
  showTimer = null
  if (tipEl) tipEl.classList.remove('visible')
  currentTarget = null
}

// Pluggable show predicate. Called pre-display; return false to
// suppress (e.g., sidebar's truncation gate). Default: always show.
export function scheduleTooltip(el, { gate } = {}) {
  if (gate && !gate(el)) return
  clearTimeout(showTimer)
  showTimer = setTimeout(() => { showTooltip(el) }, SHOW_DELAY_MS)
}

// Document-level handler — wires once at boot, covers every
// light-DOM `[data-tooltip]` element. Shadow-DOM consumers attach
// their own listeners (the document handler can't see across shadow
// boundaries via `closest`).
let globalInstalled = false
export function installGlobalTooltipListener() {
  if (globalInstalled) return
  globalInstalled = true
  document.body.addEventListener('mouseover', (e) => {
    const el = e.target.closest('[data-tooltip]')
    if (!el || el === currentTarget) return
    hideTooltip()
    scheduleTooltip(el)
  })
  document.body.addEventListener('mouseout', (e) => {
    if (!currentTarget && !showTimer) return
    if (currentTarget && currentTarget.contains(e.relatedTarget)) return
    hideTooltip()
  })
}
