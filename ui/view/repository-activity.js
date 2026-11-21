// The code viewer's Activity (render-bundle.js): six views of what happens
// around a repository's code, each a tab of its own in its route: commits
// (repository-history.js), issues and pull requests (repository-issues.js),
// agents' sessions (repository-agents.js), pulse (repository-pulse.js) and
// replay (repository-replay.js). The strip shows them as one tab, opening on
// the view last shown, each view's bar led by their picker (events.js,
// `data-bundle-tab`); a sub-tab past the first is in the route too
// (routes.js isActivitySubtab), as `/pulse/year`.
import { html, svg } from 'lit'
import { isActivitySubtab } from '../../common/managed/routes.js'
import { managedHistory } from './managed-history.js'

const icon = body => html`<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5"
  stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`

// Each view, `[tab, name, icon]`: a commit on its line, an issue's ring, a
// pull request's branches, an agent's robot head, a pulse's beat, and a
// play button's triangle.
export const ACTIVITY_VIEWS = [
  ['commits', 'Commits', icon(svg`<circle cx="8" cy="8" r="2.75"/><path d="M8 1v4.25M8 10.75V15"/>`)],
  ['issues', 'Issues', icon(svg`<circle cx="8" cy="8" r="6.25"/><circle cx="8" cy="8" r="1.6" fill="currentColor" stroke="none"/>`)],
  ['pulls', 'Pull requests', icon(svg`<circle cx="4" cy="3.5" r="1.75"/><circle cx="4" cy="12.5" r="1.75"/><circle cx="12" cy="12.5" r="1.75"/>
    <path d="M4 5.25v5.5M12 10.75V6.5a2 2 0 0 0-2-2H7.5M9 3 7.5 4.5 9 6"/>`)],
  ['agents', 'Agents', icon(svg`<rect x="2.25" y="4.5" width="11.5" height="9" rx="2.5"/><path d="M8 4.5V2M6 11h4"/>
    <circle cx="5.75" cy="8.25" r="1.1" fill="currentColor" stroke="none"/><circle cx="10.25" cy="8.25" r="1.1" fill="currentColor" stroke="none"/>`)],
  ['pulse', 'Pulse', icon(svg`<path d="M1 8.5h3l1.75-4.5 3 9 2-6.5 1.25 2H15"/>`)],
  ['replay', 'Replay', icon(svg`<path d="M5 3.25v9.5L12.75 8z"/>`)],
]
export const ACTIVITY_TABS = new Set(ACTIVITY_VIEWS.map(([tab]) => tab))

let lastShown = 'commits'

// The view Activity opens on: `tab` where it is one, else the one last shown,
// Commits until one is.
export function activityTab(tab) {
  if (ACTIVITY_TABS.has(tab)) lastShown = tab
  return lastShown
}

// Each view's sub-tab, by its tab, as its route or the reader last named it,
// none for its first, kept across views, directories and repositories; and
// those told as one changes.
const subtabs = new Map()
const subtabListeners = new Set()

// The sub-tab view `tab` shows, null its first.
export const activitySubtab = tab => subtabs.get(tab) ?? null
// A route's sub-tab field for view `tab`, the one it shows; none for its first.
export const activitySubtabField = tab => subtabs.has(tab) ? { subtab: subtabs.get(tab) } : {}
// `listener(tab)` told as view `tab` comes to show another sub-tab.
export const watchActivitySubtabs = listener => { subtabListeners.add(listener) }

// View `tab` showing `subtab` as a route names it, its first where none.
export function showActivitySubtab(tab, subtab) {
  const shown = isActivitySubtab(tab, subtab) ? subtab : null
  if (shown === activitySubtab(tab)) return
  if (shown) subtabs.set(tab, shown)
  else subtabs.delete(tab)
  for (const listener of subtabListeners) listener(tab)
}

// Pulse's periods, each its weeks, name (its sub-tab's, lowercased) and the
// same days a period earlier; and the one shown's weeks, a month by default.
export const PULSE_PERIODS = [[1, 'Week', 'the week before'], [4, 'Month', 'the month before'], [13, 'Quarter', 'the quarter before'], [52, 'Year', 'the year before']]
export const pulseWeeks = () => PULSE_PERIODS.find(([, name]) => name.toLowerCase() === activitySubtab('pulse'))?.[0] ?? 4

// `subtab` of view `tab` picked for the directory shown: shown, and its
// address an entry of its own.
export function pickActivitySubtab({ repoId, commit, path }, tab, subtab) {
  showActivitySubtab(tab, subtab)
  managedHistory?.pushRoute({ view: 'repository-code', repoId, commit, path, bundleTab: tab, ...activitySubtabField(tab) })
}

// The views' picker, `tab` the one shown.
export const activityPicker = tab => html`<div class="activity-views" role="group" aria-label="Activity">${ACTIVITY_VIEWS.map(([view, name, glyph]) =>
  html`<button type="button" data-bundle-tab=${view} aria-label=${name} aria-pressed=${String(view === tab)}>${glyph}</button>`)}</div>`
