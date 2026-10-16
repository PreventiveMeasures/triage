// The code viewer's Activity (render-bundle.js): what happens around a
// repository's code, in six views, each a tab of its own in its route: its
// commits (repository-history.js), its issues and pull requests
// (repository-issues.js), its agents' sessions (repository-agents.js), its
// pulse (repository-pulse.js), and its commits replayed, as Gource plays
// them (repository-replay.js), a play button. The strip shows them as one tab,
// Activity, opening on the view last shown; each view's bar starts with
// their picker, an icon each, which switches between them as the strip's
// tabs do (events.js, `data-bundle-tab`).
import { html, svg } from 'lit'

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

// The views' picker, `tab` the one shown.
export const activityPicker = tab => html`<div class="activity-views" role="group" aria-label="Activity">${ACTIVITY_VIEWS.map(([view, name, glyph]) =>
  html`<button type="button" data-bundle-tab=${view} aria-label=${name} aria-pressed=${String(view === tab)}>${glyph}</button>`)}</div>`
