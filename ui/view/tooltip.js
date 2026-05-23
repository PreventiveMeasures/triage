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

const SHOW_DELAY_MS = 100

export function showTooltip(el) {
  const node = ensureEl()
  if (currentTarget === el) return
  const text = el.dataset.tooltip ?? ''
  if (!text) return
  node.textContent = text
  const rect = el.getBoundingClientRect()
  node.style.top = `${Math.round(rect.top + rect.height / 2)}px`
  node.style.left = `${Math.round(rect.right + 8)}px`
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
