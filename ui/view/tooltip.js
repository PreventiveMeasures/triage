// The shared styled tooltip: one fixed-position element on <body> (escaping
// any view's `overflow: hidden`), repositioned per show and driven by a
// target's `[data-tooltip]`. Instant and in-app, where a native `title=`
// reads as a webpage's (delayed, OS chrome).
//
// installGlobalTooltipListener covers the light DOM; a shadow root installs
// its own listener (installShadowTooltipListener), since events don't cross
// the boundary with their original target. A listener's `gate` can veto a
// show (the sidebar's, for a label that isn't truncated); its `placement` is
// 'cursor' (below the cursor, clamped to the viewport — in-column rows),
// 'right' (beside the element's right edge, centered: the sidebar's
// left-pinned rows) or 'right-start' (aligned to its top), and a target can
// override it with `data-tooltip-placement`.
//
// What a target can add to its text:
//   - `prepareTooltip(el)`, a function filling in `data-tooltip-*` once the
//     hover delay has run out, for details too costly to compute per hover;
//   - `data-tooltip-icon` (`commit`), a built-in icon before the text;
//   - `tooltipContent`, a lit template shown in place of the text (Compare's
//     advisories, Socket scores), `data-tooltip` still marking the target;
//   - `data-tooltip-commit-info` (bundleCommitTooltip in
//     bundle-origin-links.js): the tags pointing at `data-tooltip-commit`,
//     then its subject, author and date.

import { render } from 'lit'
import { BUNDLE_ICON_SVG, COMMIT_ICON_SVG, GITHUB_ICON_SVG, TAG_ICON_SVG } from './icons.js'
import { trustedHTML } from './trusted-types.js'
import { bundleCommitHash } from '../../common/bundle-commit.js'

const TEXT_ICONS = { commit: COMMIT_ICON_SVG }

// The tooltip ignores the pointer, so it cannot scroll: a commit with many
// tags (a monorepo's packages) shows the first few and counts the rest. The
// Overview lists them all.
const MAX_TOOLTIP_TAGS = 8

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

// An element of `className` (if any) holding literal `text`.
function textEl(tag, className, text) {
  const el = document.createElement(tag)
  if (className) el.className = className
  if (text !== undefined) el.textContent = text
  return el
}

// A built-in icon (the only markup) before literal text.
function iconText(tag, className, icon, text) {
  const el = textEl(tag, className)
  el.innerHTML = trustedHTML(icon)
  el.append(textEl('span', '', text))
  return el
}

// The commit's subject, then its author and commit date.
function commitDetailsRow({ title, authorName, authorLogin, date }) {
  const author = authorName && authorLogin && authorName !== authorLogin ? `${authorName} (@${authorLogin})` : authorName ?? (authorLogin && `@${authorLogin}`)
  const meta = textEl('span', 'tooltip-commit-meta', [author, date === null ? '' : new Date(date).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })].filter(Boolean).join(' · '))
  const row = textEl('div', 'tooltip-commit-details')
  row.append(...title ? [textEl('span', 'tooltip-commit-message', title)] : [], meta)
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
  const textIcon = Object.hasOwn(TEXT_ICONS, el.dataset.tooltipIcon ?? '') ? el.dataset.tooltipIcon : ''
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
  const rich = el.tooltipContent ?? null
  const content = rich ?? JSON.stringify([text, textIcon, repo, commit, commitInfo, bundle, stats, built, packageName, ecosystem, version, files, loc, size])
  if (!text) { hideTooltip(); return }
  // Some compound controls (for example the language bar) keep one
  // tooltip owner while changing its text as the pointer crosses child
  // segments. Reuse the visible node in that case instead of hiding and
  // re-showing it for every child.
  if (currentTarget === el && currentContent === content) return
  node.textContent = textIcon || rich ? '' : text
  if (rich) {
    const body = textEl('div', 'tooltip-rich')
    render(rich, body)
    node.append(body)
  }
  if (textIcon) node.append(iconText('span', 'tooltip-text', TEXT_ICONS[textIcon], text))
  if (packageName) {
    const row = textEl('div', 'tooltip-package')
    // A target whose first icon is not its package's marks the one to show.
    const icon = (el.querySelector('[data-tooltip-package-icon] svg') ?? el.querySelector('svg'))?.cloneNode(true)
    if (icon) row.append(icon)
    const label = textEl('span', 'tooltip-package-details')
    const count = (value, unit) => /^\d+$/u.test(value) ? `${Number(value).toLocaleString()} ${unit}` : ''
    // The size comes formatted, like `data-tooltip-stats`.
    for (const value of [packageName, version, count(files, files === '1' ? 'file' : 'files'), count(loc, 'LoC'), size].filter(Boolean)) {
      label.append(textEl('span', '', value))
    }
    row.append(label)
    node.append(row)
  }
  if (repo || commit) {
    const row = repo ? iconText('div', 'tooltip-repo', GITHUB_ICON_SVG, repo) : textEl('div', 'tooltip-repo')
    if (commit) row.append(iconText('span', 'tooltip-commit', COMMIT_ICON_SVG, commit.slice(0, 7)))
    node.append(row)
    // Beside a repository path the tags would wrap in whatever width it left;
    // under it they take the tooltip's.
    if (commit && commitInfo?.tags.length) {
      const tags = textEl('div', 'tooltip-tags')
      for (const tag of commitInfo.tags.slice(0, MAX_TOOLTIP_TAGS)) tags.append(iconText('span', 'tooltip-tag', TAG_ICON_SVG, tag))
      if (commitInfo.tags.length > MAX_TOOLTIP_TAGS) {
        tags.append(textEl('span', 'tooltip-tag-more', `+${(commitInfo.tags.length - MAX_TOOLTIP_TAGS).toLocaleString()} more`))
      }
      node.append(tags)
    }
  }
  if (commitInfo?.details) node.append(commitDetailsRow(commitInfo.details))
  if (bundle || stats || built) {
    const type = bundle === 'stasis' ? 'Stasis' : bundle === 'sourcemap' ? 'Sourcemap' : ''
    const label = [type, built ? 'Built on server' : '', stats].filter(Boolean).join(' · ')
    if (bundle === 'stasis') {
      const row = textEl('div', 'tooltip-bundle')
      const icon = document.createElement('img')
      icon.src = './stasis.svg'
      icon.alt = ''
      row.append(icon, textEl('span', '', label))
      node.append(row)
    } else node.append(iconText('div', 'tooltip-bundle', BUNDLE_ICON_SVG, label))
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
