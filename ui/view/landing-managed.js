import { html, nothing, render } from 'lit'
import { repeat } from 'lit/directives/repeat.js'
import { unsafeHTML } from 'lit/directives/unsafe-html.js'
import { MANAGE_ICON_SVG, SCAN_ICON_SVG, WORKSPACE_ICON_SVG } from './icons.js'

export function updateManagedLanding({ serverMode, session, teams = [], alternateMode = 'local', onSwitchMode }) {
  const landing = document.querySelector('#drop-zone')
  const slot = landing?.querySelector('.managed-landing')
  if (!slot) return
  const managed = serverMode === 'managed'
  const local = serverMode === 'local'
  landing.dataset.serverMode = managed ? 'managed' : 'local'
  landing.setAttribute('aria-label', managed ? session?.role === 'none' ? 'No workspace access' : session ? 'Team findings' : 'Log in' : 'Drop reports here')
  const localCopy = landing.querySelector('.drop-local-copy')
  if (localCopy) localCopy.textContent = local ? 'Review locally in your browser.' : 'Review locally in your browser. Sync across devices when you need it.'
  if (!managed) { render(nothing, slot); return }
  const canManage = session?.role === 'admin' || session?.role === 'manage'
  render(session == null ? html`
    <section class="managed-login" aria-labelledby="managed-login-title">
      <h1 id="managed-login-title">Log in to DeepView</h1>
      <p>Access your team's security reports and findings.</p>
      <button type="button" class="managed-login-button" data-managed-login>
        <svg viewBox="0 0 16 16" width="20" height="20" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>
        <span>Continue with GitHub</span>
      </button>
      <div class="managed-login-alternative">
        <span>or continue to</span>
        <button type="button" @click=${onSwitchMode}>${alternateMode} mode</button>
      </div>
    </section>
  ` : session.role === 'none' ? html`
    <section class="managed-login" aria-labelledby="managed-no-access-title">
      <h1 id="managed-no-access-title">No workspace access</h1>
      <p>Ask an administrator to grant access to this workspace.</p>
    </section>
  ` : html`
    <div class="managed-landing-hero">
      <p class="drop-eyebrow">Your security workspace</p>
      <h1>Your team's findings, in focus.</h1>
      <p class="drop-prompt-intro">${teams.length > 0
        ? 'Review the security findings shared with your account and turn them into clear next steps.'
        : 'Reports shared with your teams will appear here.'}</p>
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
    ` : html`<p class="managed-landing-empty">No team reports are available yet.</p>`}
    ${canManage ? html`
      <div class="managed-landing-actions">
        <button type="button" class="managed-manage-button" data-managed-page="manage"><span aria-hidden="true">${unsafeHTML(MANAGE_ICON_SVG)}</span><span>Manage</span></button>
      </div>
      <button type="button" class="managed-scan-button" data-managed-page="manage-scans">${unsafeHTML(SCAN_ICON_SVG)}<span>Scan</span></button>
    ` : nothing}
  `, slot)
}
