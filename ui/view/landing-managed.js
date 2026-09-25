import { html, nothing, render } from 'lit'
import { repeat } from 'lit/directives/repeat.js'
import { unsafeHTML } from 'lit/directives/unsafe-html.js'
import { MANAGE_ICON_SVG, SCAN_ICON_SVG, WORKSPACE_ICON_SVG } from './icons.js'

export function updateManagedLanding({ serverMode, session, teams = [] }) {
  const landing = document.querySelector('#drop-zone')
  const slot = landing?.querySelector('.managed-landing')
  if (!slot) return
  const managed = serverMode === 'managed'
  const local = serverMode === 'local'
  landing.dataset.serverMode = managed ? 'managed' : 'local'
  landing.setAttribute('aria-label', managed ? 'Team findings' : 'Drop reports here')
  const localCopy = landing.querySelector('.drop-local-copy')
  if (localCopy) localCopy.textContent = local ? 'Review locally in your browser.' : 'Review locally in your browser. Sync across devices when you need it.'
  const canManage = session?.role === 'admin' || session?.role === 'manage'
  render(managed ? html`
    <div class="managed-landing-hero">
      <p class="drop-eyebrow">Your security workspace</p>
      <h1>Your team's findings, in focus.</h1>
      <p class="drop-prompt-intro">${teams.length > 0
        ? 'Review the security findings shared with your account and turn them into clear next steps.'
        : session ? 'Reports shared with your teams will appear here.' : 'Log in to see the reports shared with your teams.'}</p>
    </div>
    ${teams.length > 0 ? html`
      <nav class="managed-team-list" aria-label="Teams">
        ${repeat(teams, (team) => team.id, (team) => html`
          <button type="button" class="managed-team-button" data-managed-team=${team.id}>
            <span class="managed-team-icon" aria-hidden="true">${unsafeHTML(WORKSPACE_ICON_SVG)}</span>
            <span class="managed-team-copy">
              <strong>${team.name}</strong>
              <span>${team.reports.length} ${team.reports.length === 1 ? 'report' : 'reports'} · Open findings</span>
            </span>
            <svg class="managed-team-arrow" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="m6 4 4 4-4 4"/></svg>
          </button>
        `)}
      </nav>
    ` : session ? html`<p class="managed-landing-empty">No team reports are available yet.</p>` : nothing}
    ${canManage ? html`
      <div class="managed-landing-actions">
        <button type="button" class="managed-manage-button" data-managed-page="manage"><span aria-hidden="true">${unsafeHTML(MANAGE_ICON_SVG)}</span><span>Manage</span></button>
      </div>
      <button type="button" class="managed-scan-button" data-managed-page="manage-scans">${unsafeHTML(SCAN_ICON_SVG)}<span>Scan</span></button>
    ` : session ? nothing : html`<button type="button" class="drop-prompt-action" data-managed-login>Log in</button>`}
  ` : nothing, slot)
}
