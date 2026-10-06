import { html, nothing } from 'lit'
import { formatBytes } from '../scan/metrics.js'
import { managedBundleEntry } from './managed-bundle-navigation.js'

// Resolve from the current catalog, so counts and rows share exactly one scope.
export function workspaceContent(state, workspaces, reportKind = () => null) {
  if (!state.currentWorkspace) return null
  if (state.currentManagedTeam) {
    const team = state.managedTeams.find(t => t.id === state.currentManagedTeam)
    return team ? { id: team.id, scope: 'team', title: `Team: ${team.name}`,
      reports: (team.reports ?? []).filter(report => report.analyzer !== 'links').map(report => ({ ...report, managedId: report.id, name: report.filename,
        hidden: report.visible === false, available: true })),
      bundles: (team.bundles ?? []).map(bundle => ({
        ...managedBundleEntry(bundle), hidden: bundle.visible === false, available: true,
      })),
    } : null
  }
  const workspace = workspaces.find(w => w.id === state.currentWorkspace)
  if (!workspace) return null
  const entries = new Map(state.bundles.map(bundle => [bundle.integrity, bundle]))
  const files = new Set(state.storedFiles ?? [])
  return { id: workspace.id, scope: 'workspace', title: `Workspace: ${workspace.name}`,
    reports: [...new Set(workspace.reports ?? [])].filter(name => reportKind(name) !== 'links').map(name => ({ name, available: files.has(name) })),
    bundles: [...new Set(workspace.bundles ?? [])].map(integrity => {
      const entry = entries.get(integrity)
      return entry ? { ...entry, available: true } : { integrity, name: `${integrity.slice(0, 24)}…`, available: false }
    }),
  }
}

export function workspaceTitleTemplate(context, view) {
  return view === 'findings' ? context.title
    : html`<button type="button" class="workspace-title-link" data-action="workspace-findings">${context.title}</button>`
}

export function workspaceContentButton(context, kind, view) {
  if (!context) return nothing
  const count = context[kind].length
  if (kind === 'bundles' && count === 0) return nothing
  const active = view === `workspace-${kind}`
  return html`<button type="button" class=${`files-toggle-btn${active ? ' active' : ''}`} data-action=${`workspace-${kind}`} aria-pressed=${String(active)}>${`${count} ${count === 1 ? kind.slice(0, -1) : kind}`}</button>`
}

export function workspaceFileCount(reports) {
  return new Set(reports.flatMap(report => report?.source === 'links' ? [] : Object.keys(report?.tree ?? {}))).size
}

export function filesButtonTemplate(count, view) {
  if (!(count > 1)) return nothing
  const active = view === 'files'
  return html`<button type="button" class=${`files-toggle-btn${active ? ' active' : ''}`} data-action="toggle-files" aria-pressed=${String(active)}>${`${count} files`}</button>`
}

export function renderWorkspaceContent(context, kind, fileCount = 0) {
  if (!context) return html`<p class="workspace-content-empty">This workspace is no longer available.</p>`
  const view = `workspace-${kind}`
  const items = context[kind]
  return html`<section class="workspace-content-view">
    <header class="page-head"><div class="page-title">
      <h1>${workspaceTitleTemplate(context, view)}${workspaceContentButton(context, 'reports', view)}${workspaceContentButton(context, 'bundles', view)}${filesButtonTemplate(fileCount, view)}</h1>
    </div></header>
    ${items.length > 0 ? html`<ul class="workspace-content-list">
      ${items.map(item => {
        const details = [item.kind === 'stasis' ? 'Stasis' : item.kind === 'sourcemap' ? 'Sourcemap' : null,
          Number.isFinite(item.size) ? formatBytes(item.size) : null,
          Number.isFinite(item.summary?.files) ? `${item.summary.files.toLocaleString()} files` : null,
          Number.isFinite(item.summary?.lines) ? `${item.summary.lines.toLocaleString()} LoC` : null,
        ].filter(Boolean).join(' · ')
        const repo = item.repoFullName ? `${item.repoFullName}${item.repoDirectory ? `/${item.repoDirectory}` : ''}` : null
        return html`<li class=${item.hidden ? 'workspace-content-hidden' : ''}>
          <button type="button" class="workspace-content-row"
            data-workspace-report=${kind === 'reports' ? item.managedId ?? item.name : nothing}
            data-workspace-bundle=${kind === 'bundles' ? item.managedId ?? item.integrity : nothing} ?disabled=${!item.available}>
            <svg class="workspace-content-icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
              <path d=${kind === 'bundles' ? 'm12 3 9 5v8l-9 5-9-5V8zM3 8l9 5 9-5M12 13v8M7.5 5.5l9 5' : 'M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6M8 13h8M8 17h5'}/>
            </svg>
            <span class="workspace-content-label"><span class="workspace-content-name">${item.name}${item.hidden ? html` <span class="workspace-content-visibility">Hidden</span>` : nothing}</span>
              ${repo ? html`<span class="workspace-content-repo">${repo}</span>` : nothing}
            </span>
            <span class="workspace-content-stats">${item.available ? details : 'Not available locally'}</span>
            ${item.available ? html`<span class="workspace-content-arrow" aria-hidden="true">→</span>` : nothing}
          </button>
        </li>`
      })}
    </ul>` : html`<p class="workspace-content-empty">No ${kind} in this ${context.scope}.</p>`}
  </section>`
}
