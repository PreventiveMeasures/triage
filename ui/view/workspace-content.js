import { html, nothing } from 'lit'
import { classMap } from 'lit/directives/class-map.js'
import { formatBytes } from '../scan/metrics.js'
import { managedBundleEntry } from './managed-bundle-navigation.js'
import { managedTeamFindings } from './managed-sidebar.js'
import { canReadRepositoryCode } from '../../common/managed/roles.ts'
import { REPO_ICON_SVG } from './icons.js'
import { appMarkup } from './markup.js'

// Resolve from the current catalog, so counts and rows share exactly one scope.
export function workspaceContent(state, workspaces, reportKind = () => null) {
  if (!state.currentWorkspace) return null
  if (state.currentManagedTeam) {
    const team = state.managedTeams.find(t => t.id === state.currentManagedTeam)
    if (!team) return null
    const reports = (team.reports ?? []).filter(report => report.analyzer !== 'links').map(report => ({ ...report, managedId: report.id, name: report.filename,
      hidden: report.visible === false, available: true }))
    const bundles = (team.bundles ?? []).map(bundle => ({
      ...managedBundleEntry(bundle), hidden: bundle.visible === false, available: true,
    }))
    const session = state.managedSession
    return { id: team.id, scope: 'team', title: `Team: ${team.name}`, findings: managedTeamFindings(team.app), reports, bundles,
      repositories: teamRepositories(team.repos ?? [], reports, bundles, canReadRepositoryCode(session)), dependencyReview: team.dependencyReview === true }
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

// A team's repositories, one by each it links (`repos`, its links by name
// and path), with the paths it is linked by, none where it is linked whole,
// and how many of its `reports` and `bundles` are in it. `browsable` where
// the reader may open their code (repository-code.js).
function teamRepositories(repos, reports, bundles, browsable) {
  const repositories = new Map()
  for (const { repoId, fullName, path } of repos) {
    const repository = repositories.get(repoId) ?? { repoId, name: fullName, paths: [], reports: 0, bundles: 0, available: browsable }
    if (path) repository.paths.push(path)
    repositories.set(repoId, repository)
  }
  const named = new Map([...repositories.values()].map(repository => [repository.name, repository]))
  for (const report of reports) if (named.has(report.repoFullName)) named.get(report.repoFullName).reports++
  for (const bundle of bundles) if (repositories.has(bundle.repoId)) repositories.get(bundle.repoId).bundles++
  return [...repositories.values()]
}

// What a team shows, the tab of each, and the view it is (Files is its
// findings' too); its dependencies only where its reader reviews them in it.
const TEAM_TABS = [['findings', 'Findings'], ['reports', 'Reports'], ['bundles', 'Bundles'], ['repositories', 'Repositories'], ['dependencies', 'Dependencies']]
const teamTab = view => view === 'findings' || view === 'files' ? 'findings' : view.slice(10)

// A team's header, its title and `statusBar` (its findings' severities) and
// its tabs, each counting what it shows in a bubble, Findings `findings` (the
// team's, as its catalog counts them, where the view has none of its own).
// It is a bundle's slide header, so it shares the native titlebar as they do.
export function teamHeaderTemplate(context, view, { findings = context.findings, statusBar = nothing } = {}) {
  const shown = teamTab(view)
  const counts = { findings, reports: context.reports.length, bundles: context.bundles.length, repositories: context.repositories.length }
  return html`<bundle-slide-header class="bundles-slide-header team-slide-header"><header class="bundles-slide-bar team-slide-bar">
    <h1 class="team-slide-name" data-tooltip-truncated data-tooltip=${context.title}>${context.title}</h1>
    ${statusBar}
    <div class="bundles-slide-tabs" role="tablist" aria-label="Team">${TEAM_TABS.filter(([kind]) => kind !== 'dependencies' || context.dependencyReview)
      .map(([kind, label]) => html`<button type="button"
      class=${classMap({ 'bundles-tab': true, 'team-slide-tab': true, active: shown === kind })} role="tab" aria-selected=${String(shown === kind)}
      data-action=${`workspace-${kind}`}>${label}${counts[kind] == null ? nothing : html`<span class="n">${counts[kind].toLocaleString()}</span>`}</button>`)}</div>
  </header></bundle-slide-header>`
}

// Report triage loading (render.js renderTriageLoading): its status, under
// a team's header, Findings selected, where `context` is a team's.
export function triageLoadingTemplate(context) {
  return html`${context?.scope === 'team' ? teamHeaderTemplate(context, 'findings') : nothing}<p class="triage-loading" role="status">Loading report triage…</p>`
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

export function filesButtonTemplate(count, view) {
  if (!(count > 1)) return nothing
  const active = view === 'files'
  return html`<button type="button" class=${`files-toggle-btn${active ? ' active' : ''}`} data-action="toggle-files" aria-pressed=${String(active)}>${`${count} files`}</button>`
}

// A team's repository, as its Repositories list shows it: by name, the paths
// it is linked by under it, opening its code where the reader may browse it.
function repositoryRowTemplate(item) {
  const stats = [item.reports ? `${item.reports.toLocaleString()} report${item.reports === 1 ? '' : 's'}` : null,
    item.bundles ? `${item.bundles.toLocaleString()} bundle${item.bundles === 1 ? '' : 's'}` : null].filter(Boolean).join(' · ')
  const content = html`<span class="workspace-content-icon">${appMarkup(REPO_ICON_SVG)}</span>
    <span class="workspace-content-label"><span class="workspace-content-name">${item.name}</span>
      ${item.paths.length > 0 ? html`<span class="workspace-content-repo">${item.paths.join(', ')}</span>` : nothing}
    </span>
    <span class="workspace-content-stats">${stats}</span>
    ${item.available ? html`<span class="workspace-content-arrow" aria-hidden="true">→</span>` : nothing}`
  return html`<li>${item.available ? html`<button type="button" class="workspace-content-row" data-workspace-repository=${item.repoId}
    data-repository-name=${item.name} data-repository-path=${item.paths.length === 1 ? item.paths[0] : ''}>${content}</button>`
    : html`<div class="workspace-content-row">${content}</div>`}</li>`
}

export function renderWorkspaceContent(context, kind) {
  if (!context) return html`<p class="workspace-content-empty">This workspace is no longer available.</p>`
  const view = `workspace-${kind}`
  if (kind === 'dependencies' && context.scope === 'team') {
    return html`<section class="workspace-content-view">${teamHeaderTemplate(context, view)}
      ${context.dependencyReview ? html`<team-dependencies .repositories=${context.repositories} .team=${context.id}></team-dependencies>`
        : html`<p class="workspace-content-empty">You review no dependencies in this team.</p>`}</section>`
  }
  const items = context[kind] ?? []
  return html`<section class="workspace-content-view">
    ${context.scope === 'team' ? teamHeaderTemplate(context, view) : html`<header class="page-head"><div class="page-title">
      <h1>${workspaceTitleTemplate(context, view)}${workspaceContentButton(context, 'reports', view)}${workspaceContentButton(context, 'bundles', view)}</h1>
    </div></header>`}
    ${items.length > 0 ? html`<ul class="workspace-content-list">
      ${kind === 'repositories' ? items.map(repositoryRowTemplate) : items.map(item => {
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
