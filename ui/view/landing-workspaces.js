import { html, nothing, render } from 'lit'
import { repeat } from 'lit/directives/repeat.js'
import { unsafeHTML } from 'lit/directives/unsafe-html.js'
import { LINKS_KIND, getKind, getWorkspaceAppMetadata } from '#client/index.js'
import { WORKSPACE_ICON_SVG } from './icons.js'

// Reuse the sidebar's metadata snapshot: shortcuts must not load reports
// or bundles until the user opens a workspace.
export function renderLandingWorkspaces(workspaces) {
  const slot = document.querySelector('#landing-workspaces')
  if (!slot) return
  const top = workspaces.toSorted((a, b) => b.reports.length - a.reports.length
    || a.name.localeCompare(b.name)).slice(0, 5)
  render(top.length > 0 ? html`
    <nav class="landing-workspaces" aria-label="Workspaces">
      <div class="landing-workspace-row">
        ${repeat(top, (w) => w.id, (w) => {
          const app = getWorkspaceAppMetadata(w)
          const reports = w.reports.filter((name) => getKind(name) !== LINKS_KIND).length
          return html`
          <button type="button" class="landing-workspace" data-landing-workspace=${w.id}>
            ${unsafeHTML(WORKSPACE_ICON_SVG)}
            <span class="landing-workspace-text">
              <span class="landing-workspace-name">${w.name}</span>
              <span class="landing-workspace-count">${app?.appMode ? `${app.appFindings.toLocaleString()} finding${app.appFindings === 1 ? '' : 's'} · ` : ''}${reports.toLocaleString()} report${reports === 1 ? '' : 's'}</span>
            </span>
          </button>
        `})}
      </div>
    </nav>
  ` : nothing, slot)
}
