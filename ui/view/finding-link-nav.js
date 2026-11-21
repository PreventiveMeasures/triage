// Per-finding deep links, the DOM half: a ref parsed from `#finding=…`
// (client/finding-link.js) navigated to (finding-link-route.js), unhidden
// (finding-link.js), painted, scrolled into view and ringed, the viewer's
// display mode kept.
import { isManagedUiMode, saveTriage, state } from '#client/index.js'
import { report } from './dom.js'
import { unhideFinding } from './finding-link.js'
import { locateLinkedFinding, locateReportFinding } from './finding-link-route.js'
import { findGroupById, groupKey, syncGroupTriage } from './group.js'
import { switchToFile, switchToManagedTeam, switchToWorkspace } from './ingest.js'
import { scrollRootOf } from './lazy-render.js'
import { render } from './render.js'
import { renderSidebar } from './sidebar.js'

// How long the arrived-at finding keeps its ring: caught by the eye after
// the scroll, gone before it reads as a selection.
const FLASH_MS = 1600
const FLASH_CLASS = 'link-target'

// Naming no report: the hints are digests of names never learnt.
const NOT_FOUND = "Couldn't find that finding in any of your reports. "
  + 'Import the report it came from, then open the link again.'

let flashTimer = null

// How many frames an element has to hold still before a scroll counts
// as finished, and how long to wait for that at most (a smooth scroll
// across a long list runs well under two seconds).
const SETTLE_FRAMES = 3
const SETTLE_MAX_FRAMES = 150
// Rounds of correction after the first scroll. Two is the usual
// outcome; the cap is for a target the scroller can't centre (the
// last card in a list), which would otherwise be asked forever.
const SCROLL_ROUNDS = 5

// One thing lit, however many links were followed.
function flash(el) {
  if (flashTimer !== null) clearTimeout(flashTimer)
  for (const prev of document.querySelectorAll(`.${FLASH_CLASS}`)) prev.classList.remove(FLASH_CLASS)
  el.classList.add(FLASH_CLASS)
  flashTimer = setTimeout(() => {
    el.classList.remove(FLASH_CLASS)
    flashTimer = null
  }, FLASH_MS)
}

// Resolves once `el` has stopped moving on screen — the same position
// for a few frames running — or after the cap.
function settled(el) {
  return new Promise((resolve) => {
    let last = null
    let still = 0
    let frames = 0
    const tick = () => {
      const top = Math.round(el.getBoundingClientRect().top)
      still = top === last ? still + 1 : 0
      last = top
      if (still >= SETTLE_FRAMES || ++frames >= SETTLE_MAX_FRAMES) resolve()
      else requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
}

// The part of the screen `el` can be seen in: its scroller's box (the lists
// scroll under the header and toolbar), cut down to the window.
function visibleBox(el) {
  let top = 0
  let bottom = window.innerHeight
  const scroller = scrollRootOf(el)
  if (scroller) {
    const s = scroller.getBoundingClientRect()
    top = Math.max(top, s.top)
    bottom = Math.min(bottom, s.bottom)
  }
  return { top, bottom }
}

// Whether `el` is where a `block: 'center'` scroll leaves it: wholly
// inside its visible box, or — for one taller than the box — around
// its middle.
function inView(el) {
  const r = el.getBoundingClientRect()
  if (r.height === 0) return false
  const { top, bottom } = visibleBox(el)
  if (bottom <= top) return false
  const mid = (top + bottom) / 2
  return (r.top >= top && r.bottom <= bottom) || (r.top <= mid && r.bottom >= mid)
}

// `el` scrolled to the middle of the view, and kept there: the lists only
// estimate what isn't built yet (`contain-intrinsic-size`, lazy-render.js
// shells), so a smooth scroll lands short; once it settles the heights
// around it are real, and an instant one corrects it.
async function scrollToSettled(el) {
  el.scrollIntoView({ block: 'center', behavior: 'smooth' })
  for (let round = 0; round < SCROLL_ROUNDS; round++) {
    await settled(el)
    if (!el.isConnected || inView(el)) return
    el.scrollIntoView({ block: 'center', behavior: 'instant' })
  }
}

// The element standing in for `gid` in the view just painted, where it may
// show twice: the table's row, not its pinned details card (matched on the
// row's `group`, as its `data-gid` lands a microtask after the table's
// update); kanban's board card under the detail modal, so closing it
// leaves the finding in view; the focus card, not its "up next" entry.
async function findRenderedFinding(gid) {
  const escaped = CSS.escape(gid)
  if (state.viewMode === 'table') {
    const table = report.querySelector('finding-table')
    if (table) {
      try { await table.updateComplete } catch {}
      for (const row of table.shadowRoot?.querySelectorAll('finding-row') ?? []) {
        if (row.group && groupKey(row.group) === gid) return row
      }
    }
  }
  if (state.viewMode === 'kanban') {
    const card = report.querySelector(`.kanban-card[data-gid="${escaped}"]`)
    if (card) return card
  }
  return report.querySelector(`finding-card[data-gid="${escaped}"]`)
    ?? report.querySelector(`[data-gid="${escaped}"]`)
}

// A located finding put on screen: unhidden, painted, scrolled to, ringed.
async function focusFound(hit, id, isCurrent = () => true) {
  const gid = unhideFinding(hit.group, id)
  // Opened as by a click, its group levelled as the detail surfaces level
  // it (syncGroupTriage), saved after the paint.
  const shownGroup = findGroupById(gid)
  if (shownGroup && syncGroupTriage(shownGroup)) queueMicrotask(saveTriage)
  render()
  await renderSidebar({ revealSelection: true })
  if (!isCurrent()) return { ok: false }
  const el = await findRenderedFinding(gid)
  if (!isCurrent()) return { ok: false }
  // Nothing painted for it: navigated and selected all the same, only the
  // scroll missing, which the reader couldn't act on.
  if (!el) return { ok: true }
  // A lazy shell built first, so the scroll lands on its real height.
  if (typeof el.ensureRendered === 'function') await el.ensureRendered()
  await scrollToSettled(el)
  if (!isCurrent()) return { ok: false }
  flash(el)
  return { ok: true }
}

// A parsed link ref followed: `{ ok: true }` once on screen, else
// `{ ok: false, reason }`, for the caller to say why.
export async function revealFinding(ref, { openManagedReport = switchToManagedTeam, isCurrent = () => true } = {}) {
  if (!ref?.id) return { ok: false, reason: 'This link is missing a finding id.' }
  const hit = await locateLinkedFinding(ref, {
    openReport: switchToFile,
    openWorkspace: switchToWorkspace,
    openManagedReport,
    isCurrent,
  })
  if (!isCurrent()) return { ok: false }
  if (!hit) return { ok: false, reason: isManagedUiMode() ? "Couldn't find that finding in the team reports you can access." : NOT_FOUND }
  return await focusFound(hit, ref.id, isCurrent)
}

// The Links view names a specific report's copy, even when a workspace
// holds several reports with that id. Open it directly so the selected
// copy retains that report's severity, corrections, and annotations.
export async function revealFindingInReport(id, reportName, managedReportId = null) {
  if (!id || !reportName) return { ok: false, reason: 'Missing finding id or report name.' }
  const hit = await locateReportFinding(id, reportName, managedReportId, {
    openReport: switchToFile,
    openManagedReport: switchToManagedTeam,
  })
  if (!hit) {
    return {
      ok: false,
      reason: managedReportId ? `Could not open that finding in "${reportName}". Open the team and try again.`
        : `Couldn't find that finding in "${reportName}". `
        + 'It may have been re-imported since this links file was written.',
    }
  }
  return await focusFound(hit, id)
}
