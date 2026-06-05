// Shared styled-tooltip primitive. A single fixed-position element
// is appended to <body> at module load (escapes any view's
// `overflow: hidden`) and repositioned per show. Consumers share it:
// each calls `showTooltip(el)` / `hideTooltip()` and the
// `[data-tooltip]` attribute drives the text. Used instead of native
// `title=`, which reads as a webpage tooltip in the app shell
// (delayed, light gray, OS chrome); we want an instant in-app one.
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
// Placement: 'cursor' (default) anchors below the cursor and clamps
// horizontally to the viewport — natural for in-column rows where
// right-of-element would overlap the next column. 'right' anchors to
// the hovered element's right edge, vertically centered — for the
// sidebar, whose left-pinned rows leave the main-content gutter free.

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
// listener below. The default 'cursor' placement anchors to this so
// the popup follows the cursor's location at the moment the show
// fires (after the SHOW_DELAY_MS hover delay), not the element's
// geometry.
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
// Horizontal gap from the element's right edge in 'right' placement.
const RIGHT_GAP_PX = 8
// Horizontal margin reserved between the tooltip and the viewport
// edge when clamping.
const VIEWPORT_MARGIN_PX = 8

export function showTooltip(el, { placement = 'cursor' } = {}) {
  const node = ensureEl()
  if (currentTarget === el) return
  const text = el.dataset.tooltip ?? ''
  if (!text) return
  node.textContent = text
  if (placement === 'right') {
    // Anchor to the element's right edge, vertically centered.
    const rect = el.getBoundingClientRect()
    node.style.top = `${Math.round(rect.top + rect.height / 2)}px`
    node.style.left = `${Math.round(rect.right + RIGHT_GAP_PX)}px`
    node.style.transform = 'translateY(-50%)'
  } else {
    // 'cursor' (default) — anchor below the cursor's last known
    // location, then clamp horizontally so the right edge stays
    // inside the viewport. Tooltip is `position: fixed`, so
    // clientX / clientY are the right anchor frame.
    node.style.transform = 'none'
    node.style.top = `${lastClientY + CURSOR_GAP_PX}px`
    node.style.left = '0px'
    node.classList.add('visible')
    const tipW = node.offsetWidth
    const maxLeft = window.innerWidth - tipW - VIEWPORT_MARGIN_PX
    const left = Math.max(VIEWPORT_MARGIN_PX, Math.min(lastClientX, maxLeft))
    node.style.left = `${Math.round(left)}px`
  }
  node.classList.add('visible')
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
// `placement` is forwarded to `showTooltip` when the timer fires.
export function scheduleTooltip(el, { gate, placement } = {}) {
  if (gate && !gate(el)) return
  clearTimeout(showTimer)
  showTimer = setTimeout(() => { showTooltip(el, { placement }) }, SHOW_DELAY_MS)
}

// Document-level handler — wires once at boot, covers every
// light-DOM `[data-tooltip]` element. Shadow-DOM consumers attach
// their own listeners (`closest` can't cross shadow boundaries).
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

