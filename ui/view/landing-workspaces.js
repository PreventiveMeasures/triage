import { html, nothing, render } from 'lit'
import { repeat } from 'lit/directives/repeat.js'
import { unsafeHTML } from 'lit/directives/unsafe-html.js'
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
        ${repeat(top, (w) => w.id, (w) => html`
          <button type="button" class="landing-workspace" data-landing-workspace=${w.id}>
            ${unsafeHTML(WORKSPACE_ICON_SVG)}
            <span class="landing-workspace-text">
              <span class="landing-workspace-name">${w.name}</span>
              <span class="landing-workspace-count">${w.reports.length} ${w.reports.length === 1 ? 'report' : 'reports'}</span>
            </span>
          </button>
        `)}
      </div>
    </nav>
  ` : nothing, slot)
}
