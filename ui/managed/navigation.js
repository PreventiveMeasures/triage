import { html, nothing } from 'lit'
import { unsafeHTML } from 'lit/directives/unsafe-html.js'
import { BUNDLE_ICON_SVG, REPORT_ICON_SVG, SCAN_ICON_SVG } from '../view/icons.js'

const PAGES = [
  ['manage', 'Overview'],
  ['manage-bundles', 'Bundles'],
  ['manage-scans', 'Scans'],
  ['manage-reports', 'Reports'],
  ['manage-repos', 'Repositories', 'admin'],
  ['admin-users', 'Users', 'admin'],
  ['manage-teams', 'Teams', 'admin'],
  ['manage-history', 'History'],
]

export function adminNavigation(current, role) {
  return html`<nav class="manage-nav" aria-label="Management pages">
    ${PAGES.filter(([, , required]) => required == null || required === role).map(([view, label]) => html`
      <button type="button" aria-current=${current === view ? 'page' : nothing} @click=${() => {
        document.dispatchEvent(new CustomEvent('managed-admin-navigate', { detail: { view }, bubbles: true, composed: true }))
      }}>${label}</button>`)}
  </nav>`
}

export function adminIcon(kind) {
  if (kind === 'bundle') return unsafeHTML(BUNDLE_ICON_SVG)
  if (kind === 'report' || kind === 'preview') return unsafeHTML(REPORT_ICON_SVG)
  if (kind === 'scan') return unsafeHTML(SCAN_ICON_SVG)
  const paths = {
    users: 'M10.75 4.75a2.75 2.75 0 1 1-5.5 0 2.75 2.75 0 0 1 5.5 0ZM3 14v-1.5A3.5 3.5 0 0 1 6.5 9h3a3.5 3.5 0 0 1 3.5 3.5V14',
    team: 'M8.5 5a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0ZM1.5 14v-1.5A3.5 3.5 0 0 1 5 9h2a3.5 3.5 0 0 1 3.5 3.5V14M11 2.75a2.5 2.5 0 0 1 0 4.5m1 2a3 3 0 0 1 2.5 3V14',
    repo: 'M3 12.5V3a1.5 1.5 0 0 1 1.5-1.5H13v13H4.5a1.5 1.5 0 0 1 0-3H13M7 1.5v6l2-1.5 2 1.5v-6',
    history: 'M2 5a6.25 6.25 0 1 1-.25 5M1.5 1.5V5H5M8 4.5V8l3 1.5',
    arrow: 'M3 8h10M9 4l4 4-4 4',
    show: 'M1 8s2.5-4.5 7-4.5S15 8 15 8s-2.5 4.5-7 4.5S1 8 1 8Zm9 0a2 2 0 1 0-4 0 2 2 0 0 0 4 0',
    hide: 'm2 2 12 12M6 3.75A8 8 0 0 1 8 3.5c4.5 0 7 4.5 7 4.5a12 12 0 0 1-2 2.5M3.5 5A13 13 0 0 0 1 8s2.5 4.5 7 4.5a8 8 0 0 0 3-.6',
    download: 'M8 2v8M5 7l3 3 3-3M2 11v3h12v-3',
    upload: 'M8 11V2m-3 3 3-3 3 3M2 10v4h12v-4',
  }
  return html`<svg class=${kind === 'repo' ? 'repo-icon' : nothing} viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d=${paths[kind] ?? paths.repo}/></svg>`
}
