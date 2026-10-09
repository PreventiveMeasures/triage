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
// A target whose details cost too much to compute on every hover can carry
// a `prepareTooltip(el)` function: the show calls it, once the hover delay
// has run out, to fill in the target's `data-tooltip-*` attributes.
//
// A commit a managed bundle records can carry `data-tooltip-commit-info`
// (see `bundleCommitTooltip` in bundle-origin-links.js): its message's first
// line, author and date go below, and the tags that point to it follow the
// `data-tooltip-commit` reference.
//
// Placement: 'cursor' (default) anchors below the cursor and clamps
// horizontally to the viewport — natural for in-column rows where
// right-of-element would overlap the next column. 'right' anchors to
// the hovered element's right edge, vertically centered — for the
// sidebar, whose left-pinned rows leave the main-content gutter free.
// 'right-start' aligns to the row's top instead. A target can override
// its listener's placement with `data-tooltip-placement`.

import { BUNDLE_ICON_SVG, COMMIT_ICON_SVG, GITHUB_ICON_SVG, TAG_ICON_SVG } from './icons.js'
import { bundleCommitHash } from '../../common/bundle-commit.js'

function readCommitInfo(value) {
  let info
  try { info = value ? JSON.parse(value) : null } catch { return null }
  const text = field => typeof field === 'string' && field ? field : null
  return info && {
    tags: Array.isArray(info.tags) ? info.tags.filter(text) : [],
    details: typeof info.title === 'string' ? { title: info.title, authorName: text(info.authorName),
      authorLogin: text(info.authorLogin), date: Number.isSafeInteger(info.date) ? info.date : null } : null,
  }
}

// The message's first line, then its author and commit date.
function commitDetailsRow({ title, authorName, authorLogin, date }) {
  const row = document.createElement('div')
  row.className = 'tooltip-commit-details'
  const headline = document.createElement('span')
  headline.className = 'tooltip-commit-message'
  headline.textContent = title
  const meta = document.createElement('span')
  meta.className = 'tooltip-commit-meta'
  const author = authorName && authorLogin && authorName !== authorLogin ? `${authorName} (@${authorLogin})` : authorName ?? (authorLogin && `@${authorLogin}`)
  meta.textContent = [author, date === null ? '' : new Date(date).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })].filter(Boolean).join(' · ')
  row.append(headline, meta)
  return row
}

let tipEl
function ensureEl() {
  if (tipEl) return tipEl
  tipEl = document.createElement('div')
  tipEl.id = 'styled-tooltip'
  // A manual popover, so it renders in the top layer: an `AppDialog`
  // is a modal `<dialog>` (top layer too), which no z-index can beat,
  // so the tooltip of anything inside one would sit behind it.
  tipEl.setAttribute('popover', 'manual')
  document.body.append(tipEl)
  return tipEl
}

// Put the tooltip on top of the top layer. A modal opened after the
// popover stacks above it, so re-open it on every show — which also
// makes it displayed before `showTooltip` measures its width.
function raise(node) {
  if (typeof node.showPopover !== 'function') return
  if (node.matches(':popover-open')) node.hidePopover()
  node.showPopover()
}

let currentTarget = null
let currentContent = ''
let showTimer = null
let pendingTarget = null

// Last known cursor position — captured by the passive mousemove
// listener below. The default 'cursor' placement anchors to this so
// the popup follows the cursor's location at the moment the show
// fires (after the SHOW_DELAY_MS hover delay), not the element's
// geometry.
let lastClientX = 0
let lastClientY = 0
let lifecycleInstalled = false
function installTooltipLifecycle() {
  if (lifecycleInstalled) return
  lifecycleInstalled = true
  document.addEventListener('mousemove', (e) => {
    lastClientX = e.clientX
    lastClientY = e.clientY
  }, { passive: true })
  // A click, drag, zoom, or scroll invalidates the hovered location, even
  // when the browser doesn't send mouseout (for example after a rerender).
  for (const type of ['pointerdown', 'wheel', 'scroll']) {
    document.addEventListener(type, () => hideTooltip(), { capture: true, passive: true })
  }
  document.addEventListener('keydown', e => { if (e.key === 'Escape') hideTooltip() })
  window.addEventListener('blur', () => hideTooltip())
}

const SHOW_DELAY_MS = 100
// Vertical offset between the cursor and the top of the tooltip.
// Just enough to clear the cursor sprite without feeling detached.
const CURSOR_GAP_PX = 14
// Horizontal gap from the element's right edge in 'right' placement.
const RIGHT_GAP_PX = 8
// Margin reserved between the tooltip and each viewport edge.
const VIEWPORT_MARGIN_PX = 8

export function showTooltip(el, { placement = 'cursor' } = {}) {
  installTooltipLifecycle()
  clearTimeout(showTimer)
  showTimer = null
  pendingTarget = null
  el.prepareTooltip?.(el)
  placement = el.dataset.tooltipPlacement ?? placement
  const node = ensureEl()
  const text = el.dataset.tooltip ?? ''
  const repo = el.dataset.tooltipRepo ?? ''
  const commit = bundleCommitHash(el.dataset.tooltipCommit)
  const commitInfo = readCommitInfo(el.dataset.tooltipCommitInfo)
  const bundle = ['stasis', 'sourcemap'].includes(el.dataset.tooltipBundle) ? el.dataset.tooltipBundle : ''
  const stats = el.dataset.tooltipStats ?? ''
  const built = el.dataset.tooltipBuilt === 'true'
  const packageName = el.dataset.tooltipPackage ?? ''
  const ecosystem = el.dataset.tooltipEcosystem ?? ''
  const version = el.dataset.tooltipVersion ?? ''
  const files = el.dataset.tooltipFiles ?? ''
  const loc = el.dataset.tooltipLoc ?? ''
  const size = el.dataset.tooltipSize ?? ''
  const content = JSON.stringify([text, repo, commit, commitInfo, bundle, stats, built, packageName, ecosystem, version, files, loc, size])
  if (!text) { hideTooltip(); return }
  // Some compound controls (for example the language bar) keep one
  // tooltip owner while changing its text as the pointer crosses child
  // segments. Reuse the visible node in that case instead of hiding and
  // re-showing it for every child.
  if (currentTarget === el && currentContent === content) return
  node.textContent = text
  if (packageName) {
    const row = document.createElement('div')
    row.className = 'tooltip-package'
    // A target whose first icon is not its package's marks the one to show.
    const icon = (el.querySelector('[data-tooltip-package-icon] svg') ?? el.querySelector('svg'))?.cloneNode(true)
    if (icon) row.append(icon)
    const label = document.createElement('span')
    label.className = 'tooltip-package-details'
    const count = (value, unit) => /^\d+$/u.test(value) ? `${Number(value).toLocaleString()} ${unit}` : ''
    // The size comes formatted, like `data-tooltip-stats`.
    for (const value of [packageName, version, count(files, files === '1' ? 'file' : 'files'), count(loc, 'LoC'), size].filter(Boolean)) {
      const field = document.createElement('span')
      field.textContent = value
      label.append(field)
    }
    row.append(label)
    node.append(row)
  }
  if (repo || commit) {
    const row = document.createElement('div')
    row.className = 'tooltip-repo'
    // Only the built-in icon is markup; repository/path stays literal text.
    if (repo) {
      row.innerHTML = GITHUB_ICON_SVG
      const label = document.createElement('span')
      label.textContent = repo
      row.append(label)
    }
    if (commit) {
      const reference = document.createElement('span')
      reference.className = 'tooltip-commit'
      reference.innerHTML = COMMIT_ICON_SVG
      const label = document.createElement('span')
      label.textContent = commit.slice(0, 7)
      reference.append(label)
      row.append(reference)
      for (const tag of commitInfo?.tags ?? []) {
        const chip = document.createElement('span')
        chip.className = 'tooltip-tag'
        chip.innerHTML = TAG_ICON_SVG
        const name = document.createElement('span')
        name.textContent = tag
        chip.append(name)
        row.append(chip)
      }
    }
    node.append(row)
  }
  if (commitInfo?.details) node.append(commitDetailsRow(commitInfo.details))
  if (bundle || stats || built) {
    const row = document.createElement('div')
    row.className = 'tooltip-bundle'
    if (bundle === 'stasis') {
      const icon = document.createElement('img')
      icon.src = './stasis.svg'
      icon.alt = ''
      row.append(icon)
    } else row.innerHTML = BUNDLE_ICON_SVG
    const label = document.createElement('span')
    const type = bundle === 'stasis' ? 'Stasis' : bundle === 'sourcemap' ? 'Sourcemap' : ''
    label.textContent = [type, built ? 'Built on server' : '', stats].filter(Boolean).join(' · ')
    row.append(label)
    node.append(row)
  }
  raise(node)
  // Measure before anchoring: fixed-position auto width can otherwise shrink
  // to the space left beside the sidebar instead of the tooltip's full width.
  node.style.left = '0px'
  node.style.top = '0px'
  node.style.transform = 'none'
  node.classList.add('visible')
  let anchorLeft = lastClientX
  let anchorTop = lastClientY + CURSOR_GAP_PX
  if (placement === 'right' || placement === 'right-start') {
    // Anchor to the element's right edge, centered or aligned to its top.
    const rect = el.getBoundingClientRect()
    anchorLeft = rect.right + RIGHT_GAP_PX
    anchorTop = rect.top + (placement === 'right' ? rect.height / 2 : 0)
  }
  // Both placements must keep long repository paths inside the viewport.
  const maxLeft = window.innerWidth - node.offsetWidth - VIEWPORT_MARGIN_PX
  const left = Math.max(VIEWPORT_MARGIN_PX, Math.min(anchorLeft, maxLeft))
  node.style.left = `${Math.round(left)}px`
  // Measure height at the final horizontal position, after long paths wrap.
  // Preserve the requested alignment, moving inward only when it would hide
  // content above/below the viewport.
  const height = node.offsetHeight
  const preferredTop = placement === 'right' ? anchorTop - height / 2 : anchorTop
  const maxTop = window.innerHeight - height - VIEWPORT_MARGIN_PX
  const top = Math.max(VIEWPORT_MARGIN_PX, Math.min(preferredTop, maxTop))
  node.style.top = `${Math.round(top)}px`
  currentTarget = el
  currentContent = content
}

export function hideTooltip(root) {
  // Components can invalidate their own tooltip without closing one that
  // belongs to a different surface during an unrelated background update.
  if (root && !root.contains(currentTarget) && !root.contains(pendingTarget)) return
  clearTimeout(showTimer)
  showTimer = null
  pendingTarget = null
  if (tipEl) {
    tipEl.classList.remove('visible')
    // Close the popover as well: an open-but-invisible one still matches
    // `:popover-open`, which other code reads as "a popover is up" (the
    // links preview's Escape in events.js; review r4099015016).
    if (typeof tipEl.hidePopover === 'function' && tipEl.matches(':popover-open')) tipEl.hidePopover()
  }
  currentTarget = null
}

// Pluggable show predicate. Called pre-display; return false to
// suppress (e.g., sidebar's truncation gate). Default: always show.
// `placement` is forwarded to `showTooltip` when the timer fires.
export function scheduleTooltip(el, { gate, placement } = {}) {
  installTooltipLifecycle()
  const eligible = () => el.isConnected !== false
    && (!Object.hasOwn(el.dataset, 'tooltipTruncated') || el.scrollWidth > el.clientWidth || el.scrollHeight > el.clientHeight)
    && (!gate || gate(el))
  if (!eligible()) { hideTooltip(); return }
  // Nested roots and child-to-child transitions can report the same hover
  // repeatedly. They must not restart its delay or keep an old tooltip up.
  if (el === currentTarget || el === pendingTarget) return
  hideTooltip()
  pendingTarget = el
  showTimer = setTimeout(() => {
    showTimer = null
    pendingTarget = null
    if (eligible()) showTooltip(el, { placement })
  }, SHOW_DELAY_MS)
}

// The same wiring, scoped to one shadow root. `closest` stops at the
// boundary and the document-level handler sees the host rather than
// the element inside it, so a component that wants the shared tooltip
// has to listen for itself — this is that listener, so each one
// doesn't write it again.
//
// Idempotent per root: components re-render and reconnect, and the
// call sites are lifecycle hooks that run more than once.
const shadowInstalled = new WeakSet()

// The tooltip owner for an event, walking the composed path up to (and
// not past) the listening root.
//
// Why not `closest` on `e.target`: these roots NEST — a repository picker
// can sit inside a managed page. An option's event reaches the page's
// listener retargeted to the picker host, which has no `data-tooltip`.
// The composed path still holds the option label, so both listeners
// resolve the same owner instead of the outer listener hiding its tooltip.
function tooltipOwner(e, root) {
  for (const node of e.composedPath()) {
    if (node === root) break
    if (node.nodeType === 1 && Object.hasOwn(node.dataset, 'tooltip')) return node
  }
  return null
}

export function installShadowTooltipListener(root, options) {
  if (!root || shadowInstalled.has(root)) return
  shadowInstalled.add(root)
  if (root.ownerDocument) installTooltipLifecycle()
  root.addEventListener('mouseover', (e) => {
    if (e.buttons) { hideTooltip(); return }
    const el = tooltipOwner(e, root)
    if (!el) { hideTooltip(); return }
    if (el === currentTarget) return
    scheduleTooltip(el, options)
  })
  root.addEventListener('mouseout', (e) => {
    // Moving WITHIN the element that owns the tooltip (button → its
    // svg) is not leaving it; mouseout bubbles from every child.
    const from = tooltipOwner(e, root)
    const to = e.relatedTarget?.closest?.('[data-tooltip]') ?? null
    if (from && from === to) return
    hideTooltip()
  })
  // Scroll events inside a shadow root are not composed, so the document
  // listener cannot dismiss tooltips on scrolling graph/sidebar content.
  root.addEventListener('scroll', () => hideTooltip(root), { capture: true, passive: true })
}

// Document-level handler — wires once at boot, covers every
// light-DOM `[data-tooltip]` element. Shadow-DOM consumers attach
// their own listeners (`closest` can't cross shadow boundaries).
let globalInstalled = false
export function installGlobalTooltipListener() {
  if (globalInstalled) return
  globalInstalled = true
  installTooltipLifecycle()
  // Components shared with lazy bundles register their roots through the
  // DOM so every surface uses this module's tooltip node and hover state.
  document.addEventListener('tooltip-root-connected', (e) => {
    installShadowTooltipListener(e.composedPath()[0]?.shadowRoot)
  })
  document.body.addEventListener('mouseover', (e) => {
    if (e.target.closest('[data-tooltip-managed]')) return
    if (e.buttons) { hideTooltip(); return }
    const el = e.target.closest('[data-tooltip]')
    if (!el || el === currentTarget) return
    scheduleTooltip(el)
  })
  document.body.addEventListener('mouseout', (e) => {
    if (e.target.closest('[data-tooltip-managed]') || e.relatedTarget?.closest?.('[data-tooltip-managed]')) return
    if (!currentTarget && !showTimer) return
    if ((currentTarget ?? pendingTarget)?.contains(e.relatedTarget)) return
    hideTooltip()
  })
}
