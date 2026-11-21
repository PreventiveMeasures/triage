import { getPublicShare } from '../../client/managed/public-share.js'
import { openManagedShareDialog } from './client-managed.js'
import { LitElement, html, render as litRender, nothing, unsafeCSS } from 'lit'
import { repeat } from 'lit/directives/repeat.js'
import { appMarkup } from './markup.js'
import { LINKS_KIND, addBundleToWorkspace, addReportToWorkspace, analyzeTriageImpact, clientModeLabel, computeLinkHint, configureClientMode, createWorkspace, ensureCounts, getCount, getKind, getPackagesIndex, getRepositoriesIndex, getWorkspaceAppMetadata, getWorkspaceAppModeHint, hasStandaloneProbeHint, hydrateSecureStorage, isCombinedServerMode, isManagedModeLink, isManagedUiMode, listBundles, listFiles, listWorkspaces, mergeSyncServerInfo, migrateLegacyFilenames, onWorkspaceAppMetadataChanged, probeServerInfo, readCachedServerInfo, reloadTriageFromStorage, rememberStandaloneProbe, removeBundleFromWorkspace, removeReportFromWorkspace, renameWorkspace, setLocalMode, state, syncObservedAfterHydrate, toggleClientMode, waitForServerInfo, writeCachedServerInfo } from '#client/index.js'
import { deleteBundleFromRemote, deleteFromRemote as deleteRemote, isBundleInRemoteOrCached, isInRemoteOrCached, loadSync, setSyncForceDisabled, triageSync } from './client-sync.js'
import { clearPreviewRole, fetchManagedBundleCatalog, getPreviewRole, loadManagedBundle, logout as managedLogout, probeSession as managedProbeSession, probeTeams as managedProbeTeams, resetManagedAppState, setManagedAppSession, setManagedReportCatalog, stopViewing } from './client-managed.js'
import { resetManagedFixes } from './managed-pull-requests.js'
import { showToast } from './toast.js'
import { managedHistory } from './managed-history.js'
import { managedBundleEntry, managedBundleRoute, managedCompareLocation, managedTeamBundleEntries, shownManagedBundleId } from './managed-bundle-navigation.js'
import { managedReportViewChanged } from './managed-report-catalog.js'
import { refreshManagedBundleView } from './managed-bundle-refresh.js'
import { openManagedBundle } from './managed-bundle-open.js'
import { openNpmRoute } from './npm-package.js'
import { navigateToRepositoryCode, openRepositoryCodeRoute } from './repository-code.js'
import { createManagedTeamsProbe } from './managed-teams-probe.js'
import { currentViewSignal } from './view-navigation.js'
import { ManagedTeamSections, SectionExpansion, filterManagedTeams, managedBundleStats, managedRepositoryPath, managedTeamCollapses, managedTeamFindings } from './managed-sidebar.js'
import { railLetters } from './sidebar-rail.js'
import { repaintOnVaultChange } from './sidebar-vault-repaint.js'
import { cleanupGraph2 } from './graph/state.js'
import { applyLinkedFilters } from './filters.js'
import { MANAGED_PAGES, managedRouteForIds, resolveManagedRoute } from '../../common/managed/routes.js'
import { ROLES, canReadRepositoryCode, isRole } from '../../common/managed/roles.ts'
import { initManagedTriagePush, resetManagedTriage } from './managed-triage.js'
import { managedTeamFeedLive, setManagedTeamFeedRefresh, startManagedTeamFeed, stopManagedTeamFeed } from './managed-feed.js'
import { announceManagedSession, heardManagedSessions, toldOtherThan, watchManagedSessions } from './managed-session-channel.js'
import sidebarCSS from './sidebar.css'
import fileIconCSS from '../styles/file-icon.css'
import { initEncryptionToggle, refreshEncryptionToggle } from './encryption-toggle.js'
import { initStorageStatus, scheduleStorageStatusRefresh } from './storage-status.js'
import { render } from './render.js'
import { renderLandingWorkspaces } from './landing-workspaces.js'
import { getLoadedWorkspaceAppMetadata } from './workspace-app-load.js'
import { updateManagedLanding } from './landing-managed.js'
import { refreshScanNavigation } from './scan-navigation.js'
import { startIndexWalks } from './index-walks.js'
import { beginViewNavigation, currentViewGeneration, deleteCurrent, deleteCurrentBundle, goHome, leaveWorkspace, persistLastBundle, resetForClientModeTransition, switchToFile, switchToManagedDeduplication, switchToManagedTeam, switchToWorkspace, switchToWorkspaceContent } from './ingest.js'
import { reportWorkspaceFor } from './finding-link.js'
import { maybePromptFirstUse } from './first-import-prompt.js'
import { openDeleteBundleDialog, openDeleteReportDialog, openDetachBundleDialog, openDetachReportDialog, openLeaveWorkspaceDialog, openNewWorkspaceDialog, openPersistenceDegradedDialog, openWorkspaceExportDialog, openWorkspaceShareLinkDialog } from './lazy-dialogs.js'
// Up front, not in the dialogs' bundle (lazy-dialogs.js says why).
import { openProxyAuthDialog } from './dialogs/proxy-auth-dialog.js'
import { FILE_ICONS, displayName, groupOf, isLinksFile, reportGroup } from './file-display.js'
import { BUNDLE_ICON_SVG, MANAGE_ICON_SVG, WORKSPACE_ICON_SVG } from './icons.js'
import { openBundle, selectBundle } from './bundle-load.js'
import { installGlobalTooltipListener, installShadowTooltipListener } from './tooltip.js'
import { bundleCommitTooltip } from './bundle-origin-links.js'
import { revealFinding } from './finding-link-nav.js'

// Set on mount: the `<app-sidebar>` host (light DOM, where the collapse
// class lives), its shadow root (the scope of every delegate and lookup
// below, so `e.target.closest()` works un-retargeted) and `#file-list`.
let hostEl = null
let root = null
let fileList = null

// A first visit has no cached protocol yet. Keep the welcome surface hidden
// during the bounded startup probe so a prompt managed response paints its
// team landing directly. An unavailable server releases the local surface.
function setLandingModePending(pending) {
  const landing = document.querySelector('#drop-zone')
  if (!landing) return
  if (pending) landing.dataset.serverModePending = 'true'
  else delete landing.dataset.serverModePending
}

// The document-level listener for light-DOM `[data-tooltip]`; the shadow
// root wires its own in mount().
installGlobalTooltipListener()

// The sync endpoint a toggle-on primes, at `/api/sync` on the page's origin
// (the relay's namespace, behind nginx or build.js's dev proxy). None on
// GitHub Pages, which can't host a WebSocket; a console
// `DeepView.triageSync.setServerUrl('wss://…')` still overrides either.
const DEFAULT_SYNC_URL = (() => {
  if (typeof location === 'undefined') return ''
  if (location.hostname.endsWith('.github.io')) return ''
  const wsScheme = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${wsScheme}//${location.host}/api/sync`
})()

// Intra-sidebar drag payloads: a report's filename or a bundle's integrity,
// each also as text/plain for browsers that drop a private type across
// frames, and the workspace the row was dragged from ('' when unfiled) —
// captured at dragstart, as a renderSidebar() racing the drop can replace
// the dragged row. OS file drags carry none of these.
const REPORT_DT = 'application/x-deepview-report'
const SOURCE_WS_DT = 'application/x-deepview-source-ws'
const BUNDLE_DT = 'application/x-deepview-bundle'

// The payload types mid-drag, whose Reports / Bundles header shows as the
// detach target even with no unfiled row to sit above. Each kind is held
// apart: one whose dragend was lost stays until a dragend clears both.
const dragging = new Set()

// Section headers per report bucket, in render order. Named buckets carry
// their producer's name (DeepSec is Vercel's tool, Piolium Vigolium's);
// Links, last, is a different kind of file — one naming findings in the
// reports above it (client/linked-findings.js).
const GROUP_LABELS = {
  'default': 'Reports',
  'claude-security': 'Claude Security',
  'codex-security': 'Codex Security',
  'deepsec': 'DeepSec',
  'piolium': 'Piolium',
  'markdown-generic': 'Markdown (generic)',
  [LINKS_KIND]: 'Links',
}
const GROUP_ORDER = Object.keys(GROUP_LABELS)

// The search row's view buttons (sidebar-view-button.js), and the index
// each counts.
const VIEW_BUTTONS = [['packages', getPackagesIndex], ['repositories', getRepositoriesIndex]]

const WORKSPACE_CONTENT_VIEWS = ['workspace-reports', 'workspace-bundles', 'workspace-repositories', 'workspace-dependencies']

// The search box's query: a case-insensitive match on display names, kept
// across file switches.
let searchQuery = ''
let searchActive = false
// App workspaces and teams start compact (managed-sidebar.js).
const workspaceSections = new SectionExpansion()
const teamSections = new ManagedTeamSections()
// The views that show a report.
const REPORT_VIEWS = new Set(['findings', 'files', 'links'])

const plural = (n, noun) => `${n.toLocaleString()} ${noun}${n === 1 ? '' : 's'}`
const setHidden = (selector, hidden) => root?.querySelector(selector)?.toggleAttribute('hidden', hidden)
const hideUserMenu = () => root?.querySelector('#user-menu')?.hidePopover?.()
const bundleName = integrity => (state.bundles ?? []).find((b) => b.integrity === integrity)?.name ?? integrity

function revealFocusedWorkspaceSection(workspaces, force) {
  const bundle = state.currentView === 'bundles' ? state.selectedBundle : null
  const report = REPORT_VIEWS.has(state.currentView) ? state.currentFile : null
  const section = bundle ? 'bundles' : 'reports'
  const reportWorkspace = report ? reportWorkspaceFor(report) : null
  const parents = workspaces.filter((w) => bundle ? w.bundles.includes(bundle) : w.id === reportWorkspace).map((w) => w.id)
  workspaceSections.reveal(JSON.stringify([section, bundle || report, parents]), parents, section, force)
}

// A report row. Under a workspace it carries the workspace id, so a drop on
// it assigns to that workspace; a top-level row's drop falls through to
// "outside any workspace". The bucket stickers are file-display.js's own
// SVG, hence `appMarkup`.
function fileItemTemplate(n, workspaceId = null) {
  const isCurrent = reportRowIsCurrent(n, workspaceId)
  const cls = `file-item${isCurrent ? ' current' : ''}${workspaceId == null ? '' : ' indented'}`
  const label = displayName(n)
  const count = getCount(n)
  const iconHtml = FILE_ICONS[groupOf(n)] ?? FILE_ICONS.default
  return html`<li
    class=${cls}
    data-file=${n}
    data-workspace-id=${workspaceId ?? nothing}
    draggable="true"
  ><button type="button" class="file-name" data-tooltip=${label}>${appMarkup(iconHtml)}<span class="file-label">${label}</span>${count === undefined ? nothing : html`<span class="file-count">${count}</span>`}</button></li>`
}

// Only on a view of the report: browsing bundles, a still-loaded report
// highlighted would read as stale.
function reportRowIsCurrent(n, workspaceId) {
  return n === state.currentFile && workspaceId === reportWorkspaceFor(n)
    && REPORT_VIEWS.has(state.currentView)
}

function groupHeaderTemplate(label, dropTarget = false) {
  const cls = `file-group-header${dropTarget ? ' default-reports' : ''}`
  return html`<li
    class=${cls}
    data-default-reports=${dropTarget ? 'true' : nothing}
  ><span class="group-label">${label}</span></li>`
}

const WORKSPACE_PLUS_ICON = html`<svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M8 3.5v9M3.5 8h9"/></svg>`
const LOGOUT_ICON = html`<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2.5H3.5v11H8M10 5l3 3-3 3M13 8H6"/></svg>`
const BUNDLE_ICON = html`${appMarkup(BUNDLE_ICON_SVG)}`
const WORKSPACE_ICON = html`${appMarkup(WORKSPACE_ICON_SVG)}`
const TEAM_ICON = html`<svg class="team-icon" viewBox="0 0 16 16" width="13" height="13" fill="currentColor" aria-hidden="true"><path d="M5.5 8a2.25 2.25 0 1 0 0-4.5 2.25 2.25 0 0 0 0 4.5Zm0 1C3.2 9 1.75 10.2 1.75 11.6V13h7.5v-1.4C9.25 10.2 7.8 9 5.5 9Zm5.25-1a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm.25 1c-.43 0-.83.05-1.2.15.86.62 1.45 1.5 1.45 2.45V13h3.25v-1.3C14.5 10.1 13.15 9 11 9Z"/></svg>`
// A workspace row's hover actions: export (a tray), leave (a door — not a
// trash bin, which reads as deleting) and share by link (a chain).
const WORKSPACE_EXPORT_ICON = html`<svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2v8M5 7l3 3 3-3M3 13h10"/></svg>`
const WORKSPACE_LEAVE_ICON = html`<svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 3H4v10h5"/><path d="M7 8h7M11 5l3 3-3 3"/></svg>`
const WORKSPACE_SHARE_ICON = html`<svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 9.5L9 7.5"/><path d="M9.5 5.5L10.5 4.5a2.1 2.1 0 1 1 3 3l-1 1"/><path d="M6.5 11.5L5.5 12.5a2.1 2.1 0 1 1-3-3l1-1"/></svg>`

// The signed-in user's teams (managed mode). Opening a team combines its
// reports in a workspace view; repository-owned bundles list alongside.
function teamsSectionTemplate() {
  const teams = filterManagedTeams(state.managedTeams, searchQuery)
  if (teams.length === 0) return nothing
  return html`
    ${groupHeaderTemplate('Teams')}
    ${repeat(teams, ({ team }) => team.id, ({ team: t, reports, bundles }) => {
      const app = t.app
      const compact = managedTeamCollapses(app, (t.reports ?? []).filter(r => r.analyzer !== LINKS_KIND).length)
      const [showReports, showBundles] = shownSections(teamSections, t.id, compact)
      const reportCount = reports.filter(r => r.analyzer !== LINKS_KIND).length
      const findings = managedTeamFindings(app)
      return html`
      <li class=${`file-item team-item${teamIsCurrent(t) ? ' current' : ''}`} data-team-id=${t.id}>
        <div class="workspace-heading">
          <button type="button" class="file-name" @click=${() => void switchToManagedTeam(t)}>${TEAM_ICON}<span class="file-label">${t.name}</span></button>
          ${state.managed?.allowShare && ['admin', 'manage'].includes(state.managedSession?.role) ? html`<button type="button" class="workspace-share" aria-label=${`Share ${t.name} publicly`} @click=${() => void openManagedShareDialog(t)}>${WORKSPACE_SHARE_ICON}</button>` : nothing}
        </div>
        ${compact ? sectionsMetaTemplate(true, findings, reportCount, bundles.length, showReports, showBundles) : nothing}
      </li>
      ${showReports ? repeat(reports, r => r.id, r => teamReportTemplate(t, r)) : nothing}
      ${showBundles ? repeat(bundles, b => b.id, b => teamBundleTemplate(t, b)) : nothing}`
    })}`
}

const shownSections = (sections, id, compact) => ['reports', 'bundles'].map((section) => sections.shown(id, section, compact, searchActive))

// A compact team's or workspace's second row: the findings it counts (none
// where null), and the toggles of its report and bundle sections, disabled
// while a search shows both.
function sectionsMetaTemplate(team, findings, reports, bundles, showReports, showBundles) {
  const toggle = (section, count, shown) => html`<button type="button" data-team-section=${team ? section : nothing} data-workspace-section=${team ? nothing : section}
    aria-expanded=${String(shown)} ?disabled=${searchActive}>${plural(count, section.slice(0, -1))}</button>`
  return html`<div class="workspace-meta">
      ${findings === null ? nothing : html`<span class="workspace-findings">${plural(findings, 'finding')}</span>`}
      <span class="workspace-sections" role="group" aria-label=${team ? 'Team files' : 'Workspace files'}>
        ${toggle('reports', reports, showReports)}
        ${bundles > 0 ? toggle('bundles', bundles, showBundles) : nothing}
      </span>
    </div>`
}

// The collapsed sidebar shows teams (managed) or workspaces alone: each as its
// icon over two letters, opening it as its row does, and current while anything
// of it is open.
function renderRail(label, items, icon, isCurrent, open) {
  const rail = root.querySelector('#sidebar-rail')
  rail.setAttribute('aria-label', label)
  litRender(repeat(items, (item) => item.id, (item) => {
    const current = isCurrent(item)
    return html`<li><button type="button" class=${current ? 'rail-item current' : 'rail-item'} aria-label=${item.name} aria-current=${current ? 'true' : nothing}
    data-tooltip=${item.name} @click=${() => open(item)}>${icon}<span aria-hidden="true">${railLetters(item.name)}</span></button></li>`
  }), rail)
}

function teamIsCurrent(team) {
  return state.currentManagedTeam === team.id && Boolean(state.currentWorkspace)
    && ['findings', 'files', ...WORKSPACE_CONTENT_VIEWS].includes(state.currentView)
}

function teamReportIsCurrent(team, r) {
  return state.currentManagedTeam === team.id && state.currentManagedReport === r.id && ['findings', 'links'].includes(state.currentView)
}

function teamBundleIsCurrent(team, bundle) {
  return state.currentManagedTeam === team.id && shownManagedBundleId(state) === bundle.id
}

// A report row under its team (managed mode). No `data-file`, so the
// file-row delegate ignores it: its own @click renders the report from the
// server, through the same guarded load and triage gate a merged team view
// takes, without caching it to OPFS.
function teamReportTemplate(team, r) {
  const name = displayName(r.filename)
  const current = teamReportIsCurrent(team, r)
  return html`<li class=${`file-item indented team-report-item${r.visible === false ? ' content-hidden' : ''}${current ? ' current' : ''}`}>
    <button type="button" class="file-name" aria-label=${r.visible === false ? `${name} (hidden from teams)` : nothing} data-tooltip=${name} data-tooltip-repo=${managedRepositoryPath(r) || nothing} data-tooltip-placement="right-start" @click=${() => void switchToManagedTeam(team, r.id)}>
      ${appMarkup(FILE_ICONS[reportGroup(r.filename, r.analyzer)])}<span class="file-label">${name}</span>
    </button>
  </li>`
}

// Team bundle rows open the server-backed metadata view. The repository
// tooltip distinguishes similarly named uploads from different repositories.
function teamBundleTemplate(team, bundle) {
  const current = teamBundleIsCurrent(team, bundle)
  return html`<li class=${`file-item indented team-bundle-item${bundle.visible === false ? ' content-hidden' : ''}${current ? ' current' : ''}`}>
    <button type="button" class="file-name" aria-label=${bundle.visible === false ? `${bundle.filename} (hidden from teams)` : nothing} data-managed-bundle=${bundle.id} data-managed-team=${team.id} data-tooltip=${bundle.filename} data-tooltip-repo=${managedRepositoryPath(bundle) || nothing}
      data-tooltip-bundle=${bundle.kind || nothing} data-tooltip-built=${bundle.provenance === 'build' ? 'true' : nothing} data-tooltip-stats=${managedBundleStats(bundle) || nothing} data-tooltip-commit=${bundle.summary?.commit || nothing}
      data-tooltip-commit-info=${bundleCommitTooltip(bundle.commitInfo, bundle.summary?.commit, bundle.repoFullName) ?? nothing} data-tooltip-placement="right-start">
      ${BUNDLE_ICON}<span class="file-label">${bundle.filename}</span>
    </button>
  </li>`
}

function bundleRowIsCurrent(integrity, workspaceId) {
  return state.selectedBundle === integrity && state.currentView === 'bundles'
    && workspaceId === state.selectedBundleWorkspace
}

// A bundle row: indented (and a drop target for its workspace, like a report
// row) under a workspace, flush under Bundles. Its SRI integrity is too long
// to show, so the tooltip tells two same-named bundles apart.
function bundleItemTemplate(bundle, workspaceId = null) {
  const { integrity, name } = bundle
  const isCurrent = bundleRowIsCurrent(integrity, workspaceId)
  const indented = workspaceId != null
  const cls = `file-item bundle-item${indented ? ' indented' : ''}${isCurrent ? ' current' : ''}`
  return html`<li
    class=${cls}
    data-bundle-integrity=${integrity}
    data-workspace-id=${workspaceId ?? nothing}
    draggable="true"
  ><button type="button" class="file-name" data-tooltip=${`${name}\n${integrity}`}>${BUNDLE_ICON}<span class="file-label">${name}</span></button></li>`
}

// A workspace member whose bytes aren't on this device — an imported
// workspace's, or an eviction's with no cloud copy — shown rather than
// silently dropped. Muted and inert: not draggable, no `data-file`, and a
// missing bundle's click is gated (this device can't say what should happen
// to a bundle it doesn't have). Still a drop target for its workspace.
function missingItemTemplate(cls, workspaceId, tooltip, label, integrity = nothing) {
  return html`<li
    class=${`file-item indented ${cls}`}
    data-bundle-integrity=${integrity}
    data-workspace-id=${workspaceId}
    data-tooltip=${tooltip}
  ><span class="file-name"><span class="file-icon" aria-hidden="true">?</span><span class="file-label"><em>missing · ${label}</em></span></span></li>`
}

function workspaceIsCurrent(w) {
  return state.currentWorkspace === w.id
    && ['findings', 'files', 'workspace-reports', 'workspace-bundles'].includes(state.currentView)
}

// A workspace's row, which opens every report in it as one merged view, and,
// unless compact and collapsed, its members. Searched, members filter too; a
// missing bundle has no name to match, so hides. Links files sit in the
// Reports section but don't count as reports. The row's label is a
// `.textContent` binding, not a child interpolation: the dblclick rename
// swaps an <input> into it, which would wipe a child part's markers and crash
// Lit's next `_commitText`. The hover actions — share by link, export, leave
// (this browser only; peers and the server's chain keep it) — have no
// greyed-out delete beside Leave, which would read as the same thing.
function workspaceTemplate(w, nameSet, bundleByIntegrity) {
  const reports = w.reports.filter((r) => matchesSearch(r))
  const presentReports = reports.filter((r) => nameSet.has(r)).toSorted(byReportName)
  const missingReports = reports.filter((r) => !nameSet.has(r)).toSorted(byReportName)
  const presentBundles = w.bundles.map((integ) => bundleByIntegrity.get(integ)).filter((b) => b && matchesSearch(b.name))
  const missingBundles = searchQuery ? [] : w.bundles.filter((integ) => !bundleByIntegrity.has(integ))
  const app = getLoadedWorkspaceAppMetadata(w) ?? getWorkspaceAppMetadata(w)
  const compact = app?.appMode ?? (getWorkspaceAppModeHint(w) === true)
  const [showReports, showBundles] = shownSections(workspaceSections, w.id, compact)
  const reportCount = reports.filter(name => getKind(name) !== LINKS_KIND).length
  const bundleCount = presentBundles.length + missingBundles.length
  return html`
    <li class=${`file-item workspace-item${workspaceIsCurrent(w) ? ' current' : ''}`} data-workspace-id=${w.id}>
      <div class="workspace-heading">
        <button type="button" class="file-name">${WORKSPACE_ICON}<span class="file-label" .textContent=${w.name}></span></button>
        <button type="button" class="workspace-share" data-action="share-workspace" aria-label="Share workspace by link">${WORKSPACE_SHARE_ICON}</button>
        <button type="button" class="workspace-export" data-action="export-workspace" aria-label="Export workspace">${WORKSPACE_EXPORT_ICON}</button>
        <button type="button" class="workspace-leave" data-action="leave-workspace" aria-label="Leave workspace">${WORKSPACE_LEAVE_ICON}</button>
      </div>
      ${compact ? sectionsMetaTemplate(false, app?.appMode ? app.appFindings : null, reportCount, bundleCount, showReports, showBundles) : nothing}
    </li>
    ${showReports ? html`${presentReports.map((r) => fileItemTemplate(r, w.id))}${missingReports.map((r) => missingItemTemplate('report-missing', w.id, 'Report not on this device — it re-downloads automatically if a workspace member has uploaded it.', displayName(r)))}` : nothing}
    ${showBundles ? html`${presentBundles.map((b) => bundleItemTemplate(b, w.id))}${missingBundles.map((integ) => missingItemTemplate('bundle-item bundle-missing', w.id, 'Bundle bytes not on this device — drop the matching bundle to attach.', `${integ.slice(0, 'sha512-'.length + 8)}…`, integ))}` : nothing}
  `
}

function matchesSearch(name) {
  if (!searchQuery) return true
  return displayName(name).toLowerCase().includes(searchQuery)
}

// By the label shown (displayName), as the search matches it.
const byReportName = (a, b) => displayName(a).localeCompare(displayName(b))

// Paint the sidebar: teams (managed), or workspaces, report buckets and
// unfiled bundles, highlighting the open selection. Called after every state
// transition that could change the lists, the selection or the search.
export async function renderSidebar({ revealSelection = false } = {}) {
  await ensureClientMode()
  const modeAtStart = clientModeLabel()
  const modeChanged = () => modeAtStart !== clientModeLabel()
  updateManagedLanding({
    serverMode: modeAtStart, session: state.managedSession, teams: state.managedTeams,
    sessionPending: managedSessionPending, teamsPending: managedTeamsPending,
    alternateMode: isCombinedServerMode(state.serverModeConfig) ? 'e2e' : 'local', onSwitchMode: switchClientMode,
  })
  refreshScanNavigation()
  if (isManagedUiMode()) {
    teamSections.sync(state, revealSelection)
    if (!managedSessionPending && !managedTeamsPending && !managedSessionRefresh && !managedNavigationPending) startManagedTeamFeed({ catalogOnly: true })
    state.bundles = (state.bundles ?? []).filter(entry => entry.managedId || entry.npm || entry.repository)
    state.storedFiles = []
    renderLandingWorkspaces([])
    if (!root) return
    litRender(html`${teamsSectionTemplate()}`, fileList)
    renderRail('Teams', state.managedTeams ?? [], TEAM_ICON, (t) => teamIsCurrent(t) || (t.reports ?? []).some(r => teamReportIsCurrent(t, r))
      || (t.bundles ?? []).some(b => teamBundleIsCurrent(t, b)), (t) => void switchToManagedTeam(t))
    for (const selector of [...VIEW_BUTTONS.map(([kind]) => `sidebar-view-button[kind="${kind}"]`), '#storage-status']) setHidden(selector, true)
    renderSyncStatus()
    return
  }
  teamSections.sync({ managedTeams: [] })
  for (const [kind] of VIEW_BUTTONS) setHidden(`sidebar-view-button[kind="${kind}"]`, false)
  // One-shot migration of `.deepseek` OPFS entries back to `.md`, cached
  // after the first call; awaited so the listing sees the rename.
  await migrateLegacyFilenames()
  if (modeChanged()) return renderSidebar()
  // Fill the OPFS-wide finding and links indexes in the background, which
  // the Packages count and every card's "Duplicates:" row read — though not
  // before the boot's first view is restored (index-walks.js).
  startIndexWalks()
  const names = await listFiles()
  if (modeChanged()) return renderSidebar()
  const workspaces = listWorkspaces()
  revealFocusedWorkspaceSection(workspaces, revealSelection)
  renderLandingWorkspaces(workspaces)
  // A report may be moved into a new workspace without being reopened.
  // Prime parent hints here too, so its next copied link is complete.
  const [bundleNames] = await Promise.all([
    listBundles(),
    ...workspaces.map((w) => computeLinkHint('workspace', w.id)),
  ])
  if (modeChanged()) return renderSidebar()
  // Kept on state for surfaces that paint synchronously: the bundles view
  // (render.js), and the sync badge asking which members are on this device
  // (sync-scope.js).
  state.bundles = bundleNames
  state.storedFiles = names
  scheduleStorageStatusRefresh()
  // Before mount (view.js can render first) only the state above matters;
  // firstUpdated renders again.
  if (!root) return
  // Workspace-claimed reports and bundles render inside their workspace,
  // not in the default buckets.
  const nameSet = new Set(names)
  const claimed = new Set(workspaces.flatMap((w) => w.reports))
  const bundleByIntegrity = new Map(bundleNames.map((b) => [b.integrity, b]))
  const claimedBundles = new Set(workspaces.flatMap((w) => w.bundles))
  const buckets = new Map(GROUP_ORDER.map((g) => [g, []]))
  for (const n of names) {
    if (!claimed.has(n) && matchesSearch(n)) buckets.get(groupOf(n))?.push(n)
  }
  // A search keeps a workspace whose name or a member matches, missing
  // reports included (they keep their filename).
  const visibleWorkspaces = workspaces.filter((w) => !searchQuery
    || w.name.toLowerCase().includes(searchQuery)
    || w.reports.some((r) => matchesSearch(r))
    || w.bundles.some((integ) => {
      const b = bundleByIntegrity.get(integ)
      return b && matchesSearch(b.name)
    }))
  const unfiledBundles = bundleNames.filter(
    (b) => !claimedBundles.has(b.integrity) && matchesSearch(b.name),
  )
  // Unfiled bundles sit under an always-expanded Bundles label, their drop
  // target (as `data-default-reports` is for reports).
  litRender(html`
    <li class="file-group-header workspace-header"><span class="group-label">Workspaces</span><span class="workspace-header-actions"><button type="button" class="workspace-add" data-action="new-workspace" aria-label="Create a new workspace">${WORKSPACE_PLUS_ICON}</button></span></li>
    ${repeat(visibleWorkspaces, (w) => w.id, (w) => workspaceTemplate(w, nameSet, bundleByIntegrity))}
    ${GROUP_ORDER.map((g) => {
      const list = buckets.get(g).toSorted(byReportName)
      const isDefault = g === 'default'
      if (list.length === 0 && !(isDefault && dragging.has(REPORT_DT))) return null
      return html`
        ${groupHeaderTemplate(GROUP_LABELS[g], isDefault)}
        ${list.map((n) => fileItemTemplate(n))}
      `
    })}
    ${unfiledBundles.length > 0 || dragging.has(BUNDLE_DT) ? html`<li class="file-group-header bundles-header" data-default-bundles="true">
    <span class="group-label">Bundles</span>
  </li>` : null}
    ${repeat(unfiledBundles, (b) => b.integrity, (b) => bundleItemTemplate(b))}
  `, fileList)
  renderRail('Workspaces', workspaces, WORKSPACE_ICON, (w) => workspaceIsCurrent(w) || w.reports.some(r => reportRowIsCurrent(r, w.id))
    || w.bundles.some(integrity => bundleRowIsCurrent(integrity, w.id)), (w) => openWorkspace(w.id))
  // The Packages / Repositories buttons highlight themselves from state, but
  // their counts live in module Maps no observer sees: pushed here, and 0
  // hides the button.
  for (const [kind, index] of VIEW_BUTTONS) root.querySelector(`sidebar-view-button[kind="${kind}"]`).count = index().size
  // The sync button shows once a workspace exists.
  renderSyncStatus()
  // Fill missing counts in the background, the badges streaming in.
  ensureCounts(names, scheduleCountsRepaint)
}

// One repaint per frame of landed counts, not one per count: a cold counts
// cache fills a file at a time, and each repaint is a full renderSidebar —
// a storm on the one thread that also paints, for as long as the refill.
let countsRepaintQueued = false
function scheduleCountsRepaint() {
  if (countsRepaintQueued) return
  countsRepaintQueued = true
  requestAnimationFrame(() => {
    countsRepaintQueued = false
    renderSidebar().catch((err) => console.warn('counts repaint:', err))
  })
}

// The encryption row follows the vault's state (view.js re-renders the
// main view on its own).
repaintOnVaultChange(renderSidebar)
onWorkspaceAppMetadataChanged(scheduleCountsRepaint)

async function switchClientMode() {
  hideUserMenu()
  if (forcedManagedReturn) await restoreForcedManagedMode()
  else if (toggleClientMode()) await finishClientModeTransition()
}

// Opening the SAME workspace from another view (Bundles / Packages) drops the
// user back into its findings, mirroring the file-row check in the delegate.
function openWorkspace(id) {
  const onFindings = state.currentView === 'findings' || state.currentView === 'files'
  if (id !== state.currentWorkspace || !onFindings) switchToWorkspace(id)
}

// The full switch to a stored bundle's view: from its row, a workspace's
// list, or Compare's swap (selectBundle clears the prior load's details and
// search boxes).
export function showStoredBundle(integrity, tab, options) {
  selectBundle(integrity, tab, options)
  persistLastBundle(integrity, state.bundleDetailsTab)
  render()
  void renderSidebar()
  return openBundle(integrity)
}

const workspaceOf = (el) => {
  const row = el.closest('[data-workspace-id]')
  return row ? listWorkspaces().find((w) => w.id === row.dataset.workspaceId) : null
}

// `analyzeTriageImpact` propagates OPFS errors rather than counting every
// overlap orphaned: refuse to open the dialog over a wrong count, and let
// the user retry once OPFS settles.
async function triageImpactOf(names) {
  try {
    return await analyzeTriageImpact(names)
  } catch (err) {
    alert(`Couldn't read reports to analyze triage impact: ${err.message}`)
    return null
  }
}

// Every workspace holding `id` whose remote has it, live or per the persisted
// presence cache: a closed or mid-boot workspace's remote tag must go too, or
// `ensureRemoteNames` resurrects the file on its next open.
const remoteHolders = (field, id, inRemote) => listWorkspaces()
  .filter((w) => w[field].includes(id) && inRemote(w.id, id))
  .map((w) => w.id)

// The Leave dialog offers detach-vs-delete for attached reports, and
// keep-vs-wipe for triage they would orphan.
async function leaveWorkspaceRow(el) {
  const ws = workspaceOf(el)
  if (!ws) return
  const triageImpact = await triageImpactOf(ws.reports)
  if (!triageImpact) return
  const { confirmed, mode, triage } = await openLeaveWorkspaceDialog({
    name: ws.name,
    reportCount: ws.reports.length,
    bundleCount: ws.bundles.length,
    triageImpact,
  })
  if (!confirmed) return
  // A sibling tab may have deleted it while the dialog was open.
  if (!listWorkspaces().some((w) => w.id === ws.id)) {
    alert(`Workspace "${ws.name}" was removed elsewhere; nothing to leave.`)
    return
  }
  try { await leaveWorkspace(ws.id, mode, { triage }) }
  catch (err) { alert(`Failed to leave workspace: ${err.message}`) }
}

// Delete current: the bundles view's bundle first (a stale report selection
// can survive a view switch), else the open report. Destruction always goes
// through a dialog, and the selection the user confirmed must still be the
// one shown (a cross-tab switch or sibling-tab delete may have moved it).
// The button is disabled with neither in play, but a synthesized event
// could still land here.
async function deleteCurrentArtifact() {
  if (state.currentView === 'bundles' && state.selectedBundle) {
    const integrity = state.selectedBundle
    const friendly = bundleName(integrity)
    const remoteWorkspaceIds = remoteHolders('bundles', integrity, isBundleInRemoteOrCached)
    const { confirmed } = await openDeleteBundleDialog({
      name: friendly,
      inRemote: remoteWorkspaceIds.length > 0,
    })
    if (!confirmed) return
    if (state.selectedBundle !== integrity) {
      alert(`Active bundle changed during confirmation; aborting delete of "${friendly}".`)
      return
    }
    try {
      await deleteCurrentBundle({ deleteFromRemoteWorkspaceIds: remoteWorkspaceIds })
    } catch (err) { alert(`Failed to delete bundle: ${err.message}`) }
    return
  }
  if (!state.currentFile) return
  const name = state.currentFile
  const triageImpact = await triageImpactOf([name])
  if (!triageImpact) return
  const remoteWorkspaceIds = remoteHolders('reports', name, isInRemoteOrCached)
  // A links file goes through the same dialog but isn't a report, so the
  // prompt doesn't claim findings are about to be lost.
  const kindLabel = isLinksFile(name) ? 'links file' : 'report'
  const { confirmed, triage } = await openDeleteReportDialog({ name, kindLabel, triageImpact, inRemote: remoteWorkspaceIds.length > 0 })
  if (!confirmed) return
  if (state.currentFile !== name) {
    alert(`Active file changed during confirmation; aborting delete of "${name}".`)
    return
  }
  try { await deleteCurrent({ triage, deleteFromRemoteWorkspaceIds: remoteWorkspaceIds }) }
  catch (err) { alert(`Failed to delete ${kindLabel}: ${err.message}`) }
}

// The account menu's rows, which close it before acting.
const USER_MENU_ACTIONS = {
  'manage': () => navigateToAdminPage('manage'),
  'view-as-stop': () => stopViewing(state.managedSession?.csrfToken),
  'my-reviews': () => managedHistory.navigate({ view: 'reviews' }),
  'my-profile': () => managedHistory.navigate({ view: 'profile' }),
}

// Sidebar click delegation: [selector, handler], the first row whose
// selector is the target's `closest` running. Rows inside another row's
// element (a workspace's actions, a team's section toggles) come first.
const SIDEBAR_CLICKS = [
  ['[data-team-section], [data-workspace-section]', async (el) => {
    if (searchActive || el.disabled) return
    const team = el.dataset.teamSection !== undefined
    const id = team ? el.closest('[data-team-id]')?.dataset.teamId : el.closest('[data-workspace-id]')?.dataset.workspaceId
    if (!id && !team) return
    if (id) (team ? teamSections : workspaceSections).toggle(id, team ? el.dataset.teamSection : el.dataset.workspaceSection)
    await renderSidebar()
  }],
  // Anywhere on a team row but its buttons (its name's opens it itself)
  // opens the team, its collapsed second row included, as a workspace row does.
  ['.file-item.team-item[data-team-id]', (el, e) => {
    const team = e.target.closest('button') ? null : state.managedTeams.find(t => t.id === el.dataset.teamId)
    if (team) void switchToManagedTeam(team)
  }],
  ['[data-action="toggle-client-mode"]', () => switchClientMode()],
  // The brand drops back to the welcome screen: only the in-memory selection
  // and the last-file pointer go; OPFS files and triage stay.
  ['[data-action="go-home"]', () => goHome()],
  ['[data-managed-bundle]', (el) => {
    void managedHistory.navigate(managedRouteForIds({ view: 'bundles', teamId: el.dataset.managedTeam,
      bundleId: el.dataset.managedBundle,
      bundleTab: state.currentView === 'bundles' ? state.bundleDetailsTab : 'overview' }, state.managedTeams))
  }],
  // A missing row is inert: opening it would select a bundle openBundle
  // can't find, a phantom selection with no panel.
  ['.file-item[data-bundle-integrity]:not(.bundle-missing)', (el) => {
    const integrity = el.dataset.bundleIntegrity
    const workspaceId = el.dataset.workspaceId ?? null
    if (!bundleRowIsCurrent(integrity, workspaceId)) void showStoredBundle(integrity, undefined, { workspaceId })
  }],
  ['sidebar-view-button', (el) => {
    state.currentView = el.getAttribute('kind')
    render()
    renderSidebar()
  }],
  ['[data-action="new-workspace"]', async () => {
    if (isManagedUiMode()) return
    const name = await openNewWorkspaceDialog()
    if (!name) return
    // The first-use encryption prompt, as a file drop asks it: before the
    // workspace's private key lands on disk.
    await maybePromptFirstUse()
    await createWorkspace(name)
    renderSidebar()
  }],
  // The dialog shows its own errors; it rejects only on a stacked-modal failure.
  ['[data-action="share-workspace"]', (el) => {
    const ws = workspaceOf(el)
    if (ws) {
      openWorkspaceShareLinkDialog({ id: ws.id, name: ws.name, privateKeyBase64: ws.privateKey })
        .catch((err) => alert(`Failed to open share dialog: ${err.message}`))
    }
  }],
  // The dialog collects the password (or explicit opt-out) and downloads.
  ['[data-action="export-workspace"]', (el) => {
    const ws = workspaceOf(el)
    if (ws) openWorkspaceExportDialog({ workspace: ws }).catch((err) => alert(`Failed to open export dialog: ${err.message}`))
  }],
  ['[data-action="leave-workspace"]', leaveWorkspaceRow],
  // The dblclick rename intercepts before this fires.
  ['.file-item.workspace-item[data-workspace-id]', (el) => {
    const id = el.dataset.workspaceId
    if (id) openWorkspace(id)
  }],
  // The same file again re-opens it from another view (Bundles, Files) into
  // its findings; 'links' already shows a links file's row.
  ['.file-item[data-file]', (el) => {
    const name = el.dataset.file
    const showingFile = state.currentView === 'findings' || state.currentView === 'links'
    const workspaceId = el.dataset.workspaceId ?? null
    if (name !== state.currentFile || workspaceId !== state.currentReportWorkspace || !showingFile) {
      switchToFile(name, undefined, { workspaceId })
    }
  }],
  ['sidebar-delete-current', () => deleteCurrentArtifact()],
  // An error retries every session. Off turns sync on, priming the
  // per-origin default URL where none is set; on turns it off. The click
  // flips the persisted flag, not the URL, so a console-set URL survives.
  ['#sync-status', () => {
    if (triageSync.status === 'error') triageSync.dismissError()
    else if (triageSync.status === 'off') {
      if (!triageSync.getServerUrl() && DEFAULT_SYNC_URL) triageSync.setServerUrl(DEFAULT_SYNC_URL)
      triageSync.setEnabled(true)
    } else triageSync.setEnabled(false)
  }],
  [Object.keys(USER_MENU_ACTIONS).map(action => `[data-action="${action}"]`).join(', '), (el) => {
    hideUserMenu()
    void USER_MENU_ACTIONS[el.dataset.action]()
  }],
  // Clears the server session (with the double-submit CSRF token), then
  // reloads so the app re-probes logged out.
  ['[data-action="managed-logout"]', () => { void managedLogout(state.managedSession?.csrfToken) }],
  ['#sidebar-toggle', () => {
    hostEl.classList.toggle('collapsed')
    try { localStorage.setItem('deepview.sidebarCollapsed', hostEl.classList.contains('collapsed') ? '1' : '0') } catch {}
  }],
]

async function onSidebarClick(e) {
  for (const [selector, handle] of SIDEBAR_CLICKS) {
    const el = e.target.closest(selector)
    if (el) {
      await handle(el, e)
      return
    }
  }
}

// The shared styled tooltip, its listener on the shadow root (where the
// search row's view buttons carry tooltips too). Anchored to the row's
// right, as rows sit on the viewport's left edge. A tooltip that is only the
// label shows only when the label is truncated; one that says more (a
// bundle's integrity, a repository) always.
const SIDEBAR_TOOLTIP_OPTIONS = {
  placement: 'right',
  gate: (node) => {
    if (node.dataset.tooltipRepo || node.dataset.tooltipBundle) return true
    const label = node.querySelector('.file-label')
    if (!label) return true
    if ((node.dataset.tooltip ?? '') !== label.textContent) return true
    return label.scrollWidth > label.clientWidth
  },
}

function onSearchInput(e) {
  searchActive = e.target.value.length > 0
  searchQuery = e.target.value.trim().toLowerCase()
  renderSidebar()
}

const SYNC_LABELS = {
  off: 'Sync off',
  online: 'Online',
  offline: 'Offline',
  connecting: 'Connecting…',
  // A session's non-recoverable failure (typically a corrupt key); the
  // click retries (`dismissError()`).
  error: 'Sync error',
}

// Sync is a workspace concept, shown with a usable server URL (configured,
// or the origin's default) and any workspace — an empty one too, freshly
// attached from a share link, so the sender's triage is seen to land.
function syncButtonVisible() {
  const usableUrl = triageSync.getServerUrl() || DEFAULT_SYNC_URL
  if (!usableUrl) return false
  return listWorkspaces().length > 0
}

// Managed account control. The landing page owns sign-in; the sidebar only
// shows the account menu once the managed session probe finds a session.
function renderAuthStatus() {
  const authBtn = root?.querySelector('#auth-status')
  if (!authBtn) return
  const manageBtn = root.querySelector('#manage-status')
  const menu = root.querySelector('#user-menu')
  const session = state.managedSession
  hostEl.toggleAttribute('data-authenticated', session != null)
  hostEl.toggleAttribute('data-workspace-access', session != null && session.role !== 'none')
  renderViewAsStatus(session)
  // A public link has no account to open, so it says what it is in plain text.
  root.querySelector('#public-status').hidden = !session?.publicShare
  authBtn.hidden = session == null || session.publicShare === true
  if (session == null || session.publicShare) {
    manageBtn.hidden = true
    authBtn.removeAttribute('popovertarget')
    if (session == null) {
      authBtn.dataset.authed = '0'
      authBtn.removeAttribute('aria-label')
      litRender(nothing, authBtn)
    }
    litRender(nothing, menu)
    return
  }
  // Logged in: the button keeps the avatar on the left and shows the username
  // beside it, while still opening the account popover.
  const initial = (session.login[0] ?? '?').toUpperCase()
  const accountLabel = typeof session.name === 'string' && /\s/u.test(session.name.trim())
    ? session.name.trim()
    : `@${session.login}`
  authBtn.dataset.authed = '1'
  authBtn.setAttribute('popovertarget', 'user-menu')
  authBtn.setAttribute('aria-label', `Account: ${session.login}`)
  litRender(html`${avatarTemplate(initial, session.id)}<span class="auth-login">${accountLabel}</span>`, authBtn)
  manageBtn.hidden = !(isManagedUiMode() && (session.role === 'admin' || session.role === 'manage'))
  litRender(html`
      <div class="user-card">
        ${avatarTemplate(initial, session.id, true)}
        <span class="user-id">
          <span class="user-login">${session.login}</span>
          ${session.name ? html`<span class="user-name">${session.name}</span>` : nothing}
        </span>
      </div>
      ${session.viewer ? html`<button type="button" class="user-menu-row" data-action="view-as-stop">Return to @${session.viewer.login}</button>` : nothing}
      ${session.role === 'none' ? nothing : html`<button type="button" class="user-menu-row" data-action="my-profile">Profile</button>
        <button type="button" class="user-menu-row" data-action="my-reviews">My reviews</button>`}
      <button type="button" class="user-menu-row" data-action="toggle-client-mode">${isCombinedServerMode(state.serverModeConfig) ? 'e2e mode' : 'Local mode'}</button>
      <button type="button" class="user-menu-row logout-row" data-action="managed-logout">${LOGOUT_ICON}<span>Log out</span></button>
    `, menu)
}

// An admin viewing as another user sees that user's sidebar, plus this banner
// for as long as the view lasts: every change is refused by the server.
function renderViewAsStatus(session) {
  const banner = root.querySelector('#view-as-status')
  banner.hidden = !session?.viewer
  hostEl.toggleAttribute('data-view-as', session?.viewer != null)
  litRender(session?.viewer ? html`<span class="view-as-label"><span>Viewing as <strong>@${session.login}</strong></span>
      <span class="view-as-note">Read only · changes are not saved</span></span>
    <button type="button" class="view-as-stop" data-action="view-as-stop" aria-label=${`Stop viewing as ${session.login}`}>Stop</button>` : nothing, banner)
}

document.addEventListener('managed-view-only', () => {
  const session = state.managedSession
  if (session?.viewer) showToast(`Viewing as @${session.login} is read only: changes are not saved.`, { kind: 'error' })
})

// A name or avatar chosen on the profile shows in the account control at once.
// The avatar's URL stays the user's, so a revision asks for the new image.
let avatarRevision = 0
document.addEventListener('managed-profile-change', (event) => {
  const session = state.managedSession
  if (!session || session.id !== event.detail.userId) return
  if (event.detail.avatarChanged) avatarRevision++
  state.managedSession = { ...session, name: event.detail.name }
  setManagedAppSession(state.managedSession)
  renderAuthStatus()
})

// Avatar disc: the cached avatar (served same-origin from /api/avatar/<id>) over
// a fallback initial that shows when there's no avatar (the img 404s, and is
// hidden as broken). The id in the path keys the browser cache per user — a
// fixed URL would serve the previous user's cached avatar (the browser keeps
// one a while) after a switch.
function avatarTemplate(initial, userId, large = false) {
  const src = `/api/avatar/${encodeURIComponent(userId)}${avatarRevision ? `?v=${avatarRevision}` : ''}`
  return html`<span class=${large ? 'user-avatar user-avatar-lg' : 'user-avatar'}>
    <span class="user-avatar-fallback">${initial}</span>
    ${getPreviewRole() || state.managedSession?.role === 'none' ? nothing : html`<img alt="" src=${src} @error=${(e) => e.currentTarget.classList.add('broken')}>`}
  </span>`
}

// The brand tag names the live server mode, and is a button where there is
// another mode to switch to.
function renderBrandTag() {
  const tag = root?.querySelector('.brand-tag')
  if (!tag) return
  const label = clientModeLabel()
  const switchable = state.serverMode === 'managed' || isCombinedServerMode(state.serverModeConfig)
  tag.textContent = label
  for (const [name, value] of [['role', 'button'], ['tabindex', '0'], ['aria-label', `Switch from ${label} mode`]]) {
    if (switchable) tag.setAttribute(name, value)
    else tag.removeAttribute(name)
  }
}

// The mode is mirrored onto the host so CSS can scope managed-only chrome.
// Managed workspaces own no local artifacts or passkey encryption; the
// nodes stay mounted, so switching back restores the full e2e surface.
function applyModeControls() {
  if (hostEl) hostEl.dataset.mode = clientModeLabel()
  const managed = isManagedUiMode()
  setHidden('sidebar-delete-current', managed)
  setHidden('#encryption-toggle', managed)
  setHidden('#auth-status', !managed)
  if (!managed) {
    for (const selector of ['#manage-status', '#public-status', '#view-as-status']) setHidden(selector, true)
  }
  // Mode isn't a vault-state event, so the encryption toggle refreshes here.
  refreshEncryptionToggle()
}

function renderSyncStatus(status) {
  const btn = root?.querySelector('#sync-status')
  if (!btn) return
  renderBrandTag()
  applyModeControls()
  // Managed sync is session-based, not a toggled socket: the account control
  // stands in for the button (none in managed's local mode). Standalone (no
  // backend) is a purely local app, with neither control.
  if (state.serverMode === 'managed' || state.serverMode === 'standalone') {
    btn.hidden = true
    if (state.serverMode === 'managed') triageSync.setForcedOff(true)
    if (isManagedUiMode()) renderAuthStatus()
    return
  }
  const visible = syncButtonVisible()
  // Not before the server mode is confirmed (cached): a cold first visit
  // defaults to 'e2e', but a managed or standalone server must never pull
  // the client-sync chunk. The /api/config probe caches it before rendering
  // again, so only a first visit waits one probe.
  const modeConfirmed = readCachedServerInfo() != null
  // The lazy client-sync chunk loads only for a visible button and a user
  // who hasn't turned sync off — never at boot. `loadSync` shares one
  // in-flight promise, so this is cheap on every render.
  if (visible && modeConfirmed && triageSync.isEnabled()) {
    loadSync().catch((err) => { console.warn('sync: load failed', err) })
    // A workspace opts into sync, so the first one primes the default URL —
    // unless the user turned sync off, or set a URL from the console.
    if (!triageSync.getServerUrl() && DEFAULT_SYNC_URL) triageSync.setServerUrl(DEFAULT_SYNC_URL)
  }
  // An invisible button pauses the sync layer (no socket, no reconnects),
  // a runtime flag leaving the saved URL and toggle alone.
  triageSync.setForcedOff(!visible)
  btn.hidden = !visible
  if (!visible) return
  const s = status ?? triageSync.status
  btn.dataset.status = s
  // Orthogonal to the connection: local writes can be paused (a newer
  // version's sessions blob, quota, a locked vault) while online. The amber
  // ring shows collapsed too; the tooltip explains, ahead of the auth-proxy
  // redirect's (degraded implies possible data loss). The label stays the
  // status word, the action row being tight.
  const degraded = triageSync.persistenceDegraded
  btn.toggleAttribute('data-degraded', degraded)
  const proxyAuth = triageSync.proxyAuthRequired
  btn.toggleAttribute('data-proxy-auth', proxyAuth)
  const syncTip = degraded
    ? 'Not saving to this browser right now (storage may be full, or another tab is on a newer version). Changes that haven’t synced could be lost on reload.'
    : proxyAuth
      ? 'Can’t reach the sync server — the connection is being redirected to a sign-in proxy (e.g. Cloudflare Access). Reload the page to sign in again.'
      : ''
  // No tooltip at all rather than an empty one the hover would schedule.
  if (syncTip) btn.dataset.tooltip = syncTip
  else delete btn.dataset.tooltip
  btn.querySelector('.sync-label').textContent = SYNC_LABELS[s] ?? ''
}
// A no-op before mount; mount() paints the first status.
triageSync.onStatusChange(renderSyncStatus)

// One explanatory dialog per episode of a sync latch, re-armed when it
// clears (each latch fires on subscribe and every transition, once the lazy
// sync chunk loads). One that can't show — another modal up, or the
// dialogs' bundle unloaded — retries while the latch holds, the badge
// saying it meanwhile.
function episodeDialog(active, open, retryAfter, onShown = () => {}) {
  let inFlight = false
  let shown = false
  const show = async () => {
    if (!active() || shown || inFlight) return
    inFlight = true
    const result = await open()
    inFlight = false
    if (result.shown) {
      shown = true
      onShown(result)
      return
    }
    if (active()) setTimeout(show, retryAfter(result))
  }
  return { show, reset: () => { shown = false } }
}
const degradedDialog = episodeDialog(() => triageSync.persistenceDegraded,
  () => openPersistenceDegradedDialog().catch(() => ({ shown: false, unloaded: true })),
  ({ unloaded }) => unloaded ? 30_000 : 1500)
triageSync.onPersistenceDegraded((degraded) => {
  renderSyncStatus()
  if (degraded) degradedDialog.show()
  else degradedDialog.reset()
})
// Reconnects redirected to a login proxy (e.g. Cloudflare Access): a reload
// re-runs its login and restores the session; triage is persisted locally,
// so nothing is lost.
const proxyAuthDialog = episodeDialog(() => triageSync.proxyAuthRequired, openProxyAuthDialog, () => 1500,
  ({ reload }) => { if (reload) location.reload() })
triageSync.onProxyAuthRequired((required) => {
  renderSyncStatus()
  if (required) proxyAuthDialog.show()
  else proxyAuthDialog.reset()
})

// Double-click a workspace row to rename it inline: Enter or blur commits,
// Escape reverts, and the commit's render paints fresh chrome.
function onSidebarDblclick(e) {
  if (e.target.closest('[data-workspace-section], [data-action]')) return
  const wsRow = e.target.closest('.file-item.workspace-item')
  if (!wsRow) return
  const labelSpan = wsRow.querySelector('.file-label')
  if (!labelSpan || labelSpan.querySelector('input')) return
  const id = wsRow.dataset.workspaceId
  const ws = listWorkspaces().find((w) => w.id === id)
  if (!ws) return
  e.preventDefault()
  const input = document.createElement('input')
  input.type = 'text'
  input.value = ws.name
  input.className = 'workspace-rename-input'
  labelSpan.textContent = ''
  labelSpan.append(input)
  input.focus()
  input.select()
  let done = false
  const finish = async (commit) => {
    if (done) return
    done = true
    try {
      if (commit) await renameWorkspace(id, input.value)
    } catch (err) {
      alert(`Failed to rename workspace: ${err.message}`)
    } finally {
      // Restored explicitly: Lit skips an unchanged `.textContent` binding.
      if (labelSpan.contains(input)) labelSpan.textContent = listWorkspaces().find((w) => w.id === id)?.name ?? ws.name
      renderSidebar()
    }
  }
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); finish(true) }
    else if (ev.key === 'Escape') { ev.preventDefault(); finish(false) }
  })
  input.addEventListener('blur', () => finish(true))
  // Clicking inside the input mustn't open the workspace.
  input.addEventListener('click', (ev) => ev.stopPropagation())
  input.addEventListener('dblclick', (ev) => ev.stopPropagation())
}

// Dragging reports and bundles between workspaces and the unfiled lists.
// Dropped on anything with `[data-workspace-id]` (a workspace row or one of
// its children) assigns to that workspace; anywhere else in the sidebar
// detaches, the Reports / Bundles header lighting up as the target. Only our
// private types count, so OS file drops still reach ingest.js.
function clearDragOver() {
  for (const el of root.querySelectorAll('.drag-over')) el.classList.remove('drag-over')
}

function dragHasOurPayload(e) {
  return e.dataTransfer.types.includes(REPORT_DT)
    || e.dataTransfer.types.includes(BUNDLE_DT)
}

function onSidebarDragstart(e) {
  const row = e.target.closest('.file-item[data-bundle-integrity], .file-item[data-file]')
  if (!row) return
  // A missing bundle's row isn't draggable, but a drag of selected text or
  // its glyph can still start one in some Chromium variants; dropped, it
  // would attach a bundle nobody has locally.
  if (row.classList.contains('bundle-missing')) {
    e.preventDefault()
    return
  }
  const bundle = row.matches('[data-bundle-integrity]')
  const id = bundle ? row.dataset.bundleIntegrity : row.dataset.file
  const type = bundle ? BUNDLE_DT : REPORT_DT
  dragging.add(type)
  e.dataTransfer.effectAllowed = 'move'
  e.dataTransfer.setData(type, id)
  e.dataTransfer.setData(SOURCE_WS_DT, row.dataset.workspaceId ?? '')
  e.dataTransfer.setData('text/plain', id)
  row.classList.add('dragging')
  renderSidebar()
}

function onSidebarDragend() {
  for (const el of root.querySelectorAll('.dragging')) el.classList.remove('dragging')
  clearDragOver()
  if (dragging.size > 0) {
    dragging.clear()
    renderSidebar()
  }
}

function onSidebarDragover(e) {
  if (!dragHasOurPayload(e)) return
  e.preventDefault()
  // A drop onto the workspace the row came from, or outside any workspace
  // for an unfiled row, moves nothing: say so with the cursor and light up
  // nothing.
  const wsTarget = e.target.closest('[data-workspace-id]')
  const sourceWsId = root.querySelector('.dragging')?.closest('[data-workspace-id]')?.dataset.workspaceId ?? null
  const isSelfDrop = (wsTarget && sourceWsId && wsTarget.dataset.workspaceId === sourceWsId) || (!wsTarget && !sourceWsId)
  e.dataTransfer.dropEffect = isSelfDrop ? 'none' : 'move'
  clearDragOver()
  if (isSelfDrop) return
  if (wsTarget) {
    // The whole workspace lights up, row and children, but the dragged row.
    const wsId = wsTarget.dataset.workspaceId
    for (const el of root.querySelectorAll(`[data-workspace-id="${CSS.escape(wsId)}"]:not(.dragging)`)) el.classList.add('drag-over')
  } else {
    root.querySelector(e.dataTransfer.types.includes(BUNDLE_DT) ? '[data-default-bundles]' : '[data-default-reports]')?.classList.add('drag-over')
  }
}

function onSidebarDragleave(e) {
  // Only on leaving the shadow tree: `relatedTarget` is retargeted to the
  // host then, while moves between shadow children re-paint on dragover.
  if (!root.contains(e.relatedTarget)) clearDragOver()
}

// Move a dragged report or bundle from the workspace it came from to the
// target. Membership is additive — "remove from source, add to target", not
// "detach from everywhere" — so a member of two workspaces dragged out of
// one stays in the other. Where the source's remote holds it, a dialog
// confirms dropping that remote copy too, before membership changes, lest
// the source's next open download it back; cancel aborts the move.
const MOVES = {
  [BUNDLE_DT]: { name: bundleName, inRemote: isBundleInRemoteOrCached, confirmDetach: openDetachBundleDialog, deleteRemoteCopy: deleteBundleFromRemote,
    add: addBundleToWorkspace, remove: removeBundleFromWorkspace },
  [REPORT_DT]: { name: (filename) => filename, inRemote: isInRemoteOrCached, confirmDetach: openDetachReportDialog, deleteRemoteCopy: deleteRemote,
    add: addReportToWorkspace, remove: removeReportFromWorkspace },
}

async function moveDragged(id, sourceWsId, targetId, { name, inRemote, confirmDetach, deleteRemoteCopy, add, remove }) {
  if (sourceWsId && sourceWsId !== targetId && inRemote(sourceWsId, id)) {
    const sourceWs = listWorkspaces().find((w) => w.id === sourceWsId)
    const { confirmed } = await confirmDetach({ name, workspaceName: sourceWs?.name ?? '' })
    if (!confirmed) return false
    try { await deleteRemoteCopy(sourceWsId, id) }
    catch (err) { console.warn(`Failed to remove '${name}' from source workspace ${sourceWsId} remote:`, err) }
  }
  if (targetId) await add(id, targetId)
  if (sourceWsId && sourceWsId !== targetId) await remove(id, sourceWsId)
  return true
}

async function onSidebarDrop(e) {
  if (!dragHasOurPayload(e)) return
  e.preventDefault()
  e.stopPropagation()
  clearDragOver()
  const wsTarget = e.target.closest('[data-workspace-id]')
  const targetId = wsTarget ? wsTarget.dataset.workspaceId : null
  // From dragstart's dataTransfer, which survives the DOM: a render racing
  // the drag (a peer's report landing) can replace the `.dragging` row, and
  // the move would silently degrade into an additive add.
  const sourceWsId = e.dataTransfer.getData(SOURCE_WS_DT) || null
  const type = e.dataTransfer.types.includes(BUNDLE_DT) ? BUNDLE_DT : REPORT_DT
  const id = e.dataTransfer.getData(type)
  if (!id) return
  if (!await moveDragged(id, sourceWsId, targetId, { ...MOVES[type], name: MOVES[type].name(id) })) return
  // A report into or out of the active workspace changes its findings too:
  // reload it in place.
  if (type === REPORT_DT && state.currentWorkspace && (state.currentWorkspace === targetId || state.currentWorkspace === sourceWsId)) await switchToWorkspace(state.currentWorkspace)
  else renderSidebar()
}

// The developer override is intentionally module-local: it never changes the
// saved protocol binding or sync preference, and a reload discards it.
let forcedManagedReturn = null
let deferredServerInfo = null
let clientModeGeneration = 0
let managedSessionRequest = 0
let managedSessionRefresh = null
let managedSessionPending = true
let managedTeamsPending = true
let managedNavigationPending = false
let managedBase = null
// The session's catalog read while it is in flight (revalidateManagedSession).
let managedSessionTeams = null
// The session the startup mode probe sent, for the first managed session probe
// in place of GET /api/auth/session. Dropped once taken, or when startup opens
// another protocol, so no later probe takes it stale.
let startupSession

// The same account, in the same role.
const sameAccount = (a, b) => a?.id === b?.id && a?.role === b?.role

async function finishClientModeTransition({ forgetLastView = true, resetNavigation = true } = {}) {
  managedHistory.reset({ force: resetNavigation })
  managedBase?.remove()
  managedBase = null
  const generation = ++clientModeGeneration
  managedTeamsPending = true
  managedNavigationPending = false
  resetManagedAppState()
  resetManagedFixes()
  stopManagedTeamFeed()
  resetManagedTriage()
  setSyncForceDisabled(state.serverMode !== 'e2e')
  triageSync.setForcedOff(true)
  triageSync.setProtocolLocked(state.serverMode !== 'e2e' || Boolean(forcedManagedReturn))
  resetForClientModeTransition({ forgetLastView })
  // Only server annotations may enter a managed report. Local annotations are
  // restored from storage on the return trip, without saving this clear.
  state.triage.clear()
  if (isManagedUiMode()) {
    const session = refreshManagedSession()
    // The console helper resolves with its fake account ready to use. Real
    // server requests remain non-blocking so an outage cannot stall the UI.
    if (getPreviewRole()) {
      await session
      if (generation !== clientModeGeneration) return
    }
  }
  else {
    state.managedSession = null
    state.managedTeams = []
    await hydrateSecureStorage()
    if (generation !== clientModeGeneration) return
    await reloadTriageFromStorage()
    if (generation !== clientModeGeneration) return
    syncObservedAfterHydrate()
  }
  document.dispatchEvent(new CustomEvent('managed-client-mode-change'))
  refreshScanNavigation()
  renderBrandTag()
  renderSyncStatus(triageSync.status)
  render()
  await renderSidebar()
}

// Console: await DeepView.forceManagedMode(), or pass a role such as 'admin'
// to preview a fake account without a backend. Click the managed tag to undo it.
export async function forceManagedMode(role) {
  if (role !== undefined && !isRole(role)) throw new TypeError(`Unknown managed preview role: ${role}. Expected ${ROLES.join(', ')}.`)
  await ensureClientMode()
  if (role === undefined && (forcedManagedReturn || isManagedUiMode())) return
  const generation = clientModeGeneration
  const managed = role === undefined ? null : await loadManagedBundle()
  if (generation !== clientModeGeneration) return
  forcedManagedReturn ??= {
    serverMode: state.serverMode,
    serverModeConfig: state.serverModeConfig,
    serverModeSelection: state.serverModeSelection,
    localMode: state.localMode,
    managed: state.managed,
  }
  if (managed) managed.setPreviewRole(role)
  state.serverMode = 'managed'
  setLocalMode(false)
  // Remove the previous account immediately, including when changing the fake
  // role on a real managed deployment. The refreshed session uses the preview.
  state.managedSession = null
  state.managedTeams = []
  await finishClientModeTransition({ forgetLastView: false })
}

async function restoreForcedManagedMode() {
  const previous = forcedManagedReturn
  const pendingInfo = deferredServerInfo
  forcedManagedReturn = null
  deferredServerInfo = null
  clearPreviewRole()
  Object.assign(state, previous)
  await finishClientModeTransition({ forgetLastView: false })
  // A real configuration response may have arrived during the override. Apply
  // it through the normal protocol checks once the original surface is back.
  if (pendingInfo) applyServerInfo(pendingInfo)
}

// Cache the deployment advertisement, then resolve the active protocol using
// the memory-only selection. A combined mode explicitly permits both isolated
// surfaces. Single-mode deployments can also change freely: managed data is
// server-owned, while existing local data remains available under local/e2e.
function applyServerInfo(info, { runtime = true } = {}) {
  if (forcedManagedReturn) { deferredServerInfo = info; return }
  setLandingModePending(false)
  const hadConfiguration = readCachedServerInfo() != null
  const wasManaged = isManagedUiMode()
  const previousMode = state.serverMode
  // A late single-mode managed response preserves the offline local fallback;
  // combined deployments use their selected protocol or advertised default.
  if (getPublicShare() && info.managed) state.serverModeSelection = 'managed'
  configureClientMode(info.mode)
  if (getPublicShare() && info.managed) setLocalMode(false)
  if (!isManagedUiMode()) startupSession = undefined
  const changed = previousMode !== state.serverMode
  state.managed = info.managed
  // Cached mode hints omit runtime values; only a live response replaces them.
  const labelsChanged = runtime && state.githubNewIssueLabels !== (info.githubNewIssueLabels ?? '')
  if (runtime) state.githubNewIssueLabels = info.githubNewIssueLabels ?? ''
  if (runtime) state.deepviewScanServer = info.mode === 'managed' ? null : info.deepviewScanServer ?? null
  refreshScanNavigation()
  setSyncForceDisabled(state.serverMode !== 'e2e')
  triageSync.setProtocolLocked(state.serverMode !== 'e2e')
  writeCachedServerInfo(info)
  if (wasManaged !== isManagedUiMode()) {
    // renderSidebar waits for mode detection. Release startup before awaiting
    // the transition's final render, or a first managed visit deadlocks.
    void finishClientModeTransition({ forgetLastView: false, resetNavigation: hadConfiguration && !getPublicShare() && !isManagedModeLink(info.mode, location.pathname) }).catch((err) => console.warn('client mode transition:', err))
    return
  }
  renderSyncStatus(triageSync.status)
  if (changed && state.serverMode === 'e2e' && syncButtonVisible() && triageSync.isEnabled()) {
    // Report navigation during the offline fallback queued triage sessions,
    // but skipped remote-presence opens. Resume those alongside triage once
    // the protocol is known, without reloading or replacing the current view.
    void loadSync().then((sync) => {
      if (!sync || state.serverMode !== 'e2e') return undefined
      for (const session of sync.triageSync.openSessions) sync.openWorkspace(session.workspaceId)
      return undefined
    }).catch((err) => console.warn('sync: resume failed', err))
  }
  if (changed) renderSidebar()
  if (labelsChanged) render({ animate: false })
  if (isManagedUiMode()) void refreshManagedSession()
}

// Probe the managed server for the current session (lazy client/managed chunk)
// and repaint the auth control. Only reached in managed mode. `again` asks
// anew though one is in flight, which may have read the cookie before another
// tab changed it: the new one supersedes it (managedSessionRequest).
// `keepTeams` keeps the catalog held where the session is the same and the
// feed live, which tells the catalog as it changes (managedTeamFeedLive).
function refreshManagedSession({ keepTeams = false, again = false } = {}) {
  if (!again && managedSessionRefresh?.generation === clientModeGeneration) return managedSessionRefresh.promise
  managedSessionPending = true
  const refresh = { generation: clientModeGeneration, promise: null }
  managedSessionRefresh = refresh
  refresh.promise = revalidateManagedSession({ keepTeams }).finally(() => {
    if (managedSessionRefresh === refresh) {
      managedSessionRefresh = null
      void renderSidebar()
    }
  })
  return refresh.promise
}

async function revalidateManagedSession({ keepTeams = false } = {}) {
  const generation = clientModeGeneration
  const request = ++managedSessionRequest
  const isCurrent = () => generation === clientModeGeneration && request === managedSessionRequest && isManagedUiMode()
  try {
    const previous = state.managedSession
    const unanswered = {}
    const sent = startupSession
    startupSession = undefined
    // What other tabs told before a probe sent now is older than its answer;
    // the startup session was asked for before this tab could hear.
    const since = sent === undefined ? heardManagedSessions() : undefined
    const probed = await managedProbeSession({ fallback: unanswered, sent })
    if (!isCurrent()) return
    // Unanswered while another tab tells of another session, which the cookie
    // may now name, signed out here or not: nothing is read for this one
    // meanwhile, lest the other's be shown as its own, and it asks again.
    if (probed === unanswered && await toldOtherThan(previous)) {
      if (isCurrent() && sessionRecheck === null) askManagedSessionLater(0)
      return
    }
    const session = probed === unanswered ? previous : probed
    // An answer is told the other tabs before it is shown or read for: one
    // told of another session during the probe, which may then have read the
    // cookie before it changed, has this tab ask again at once, superseding
    // this refresh (managed-session-channel.js).
    if (probed !== unanswered && !getPreviewRole()) await announceManagedSession(session, since)
    if (!isCurrent()) return
    state.managedSession = session
    managedSessionPending = false
    if (!previous || !sameAccount(previous, session)) managedTeamsPending = true
    renderSidebar()
    setManagedAppSession(session)
    if (previous && !sameAccount(previous, session)) {
      state.managedTeams = []
      state.bundles = []
      stopManagedTeamFeed()
      resetManagedTriage()
      managedHistory.reset()
      void goHome({ history: false })
    } else if (Object.hasOwn(MANAGED_PAGES, state.currentView) && canAccessManagedPage(state.currentView)) {
      render({ animate: false })
    }
    renderAuthStatus()
    // Claim the triage change-notifier for the server push — a no-op unless
    // the session's role can write triage (reads still hydrate without it).
    initManagedTriagePush()
    if (!document.querySelector('base')) {
      managedBase = document.createElement('base')
      managedBase.href = '/'
      document.head.prepend(managedBase)
    }
    // The user's teams (sidebar Teams section). probeTeams never throws; empty
    // when logged out. Repaint the sidebar so the section reflects the result.
    // The page opens alongside this read, not after it: Manage, npm and the
    // other pages need only the session, and the routes resolved through a
    // team wait for this read (viewManagedTeams). The read is the session's,
    // not a view's: neither the navigation that opens the page nor leaving
    // that page before the read answers cancels it.
    const kept = keepTeams && sameAccount(previous, session) && managedTeamFeedLive()
    const teams = kept ? null : managedSessionTeams = refreshManagedTeams(isCurrent, { signal: new AbortController().signal })
      .finally(() => { if (managedSessionTeams === teams) managedSessionTeams = null })
    const page = managedHistory.active && Object.hasOwn(MANAGED_PAGES, state.currentView) && !canAccessManagedPage(state.currentView)
      ? managedHistory.navigate({ view: canAccessManagedPage('manage') ? 'manage' : 'home' }, { replace: true })
      : session ? managedHistory.start(restoreManagedPage, { onCancel: cancelManagedRestoration }) : null
    await Promise.all([teams, page])
  } catch (err) {
    console.warn('managed: session probe failed:', err)
  } finally {
    if (isCurrent() && (managedSessionPending || managedTeamsPending)) {
      managedSessionPending = false
      managedTeamsPending = false
      renderSidebar()
    }
  }
}

setManagedTeamFeedRefresh((isCurrent, signal, revision) => refreshManagedTeams(isCurrent, { strict: true, signal, revision }))

const probeManagedTeams = createManagedTeamsProbe(managedProbeTeams)

// A view's catalog: the session's read while it is in flight, waited for
// rather than joined, since a joined read is cancelled with its view
// (createManagedTeamsProbe); otherwise the shared catalog, read if expired.
function viewManagedTeams(isCurrent) {
  return managedSessionTeams ?? refreshManagedTeams(isCurrent, { reuse: true })
}
let managedTeamsUpdate = 0
async function refreshManagedTeams(isCurrent, { strict = false, signal = currentViewSignal(), reuse = false, revision = null } = {}) {
  const generation = clientModeGeneration
  const session = state.managedSession
  const fresh = await probeManagedTeams({ generation, session, signal, reuse, revision })
  const teams = fresh ?? (strict ? null : state.managedTeams)
  if (signal.aborted || teams === null || !isCurrent() || generation !== clientModeGeneration || !isManagedUiMode()) return false
  const previousTeamName = state.managedTeams.find(team => team.id === state.currentManagedTeam)?.name
  const changedReports = setManagedReportCatalog(teams)
  state.managedTeams = teams
  const update = fresh === null ? managedTeamsUpdate : ++managedTeamsUpdate
  managedTeamsPending = false
  // Clear the view, then its URL, unless the user moved on meanwhile.
  const leaveForHome = async () => {
    const cleared = goHome({ history: false })
    const clearing = currentViewGeneration()
    await cleared
    if (clearing === currentViewGeneration() && generation === clientModeGeneration && isCurrent()
      && sameAccount(state.managedSession, session)) managedHistory.replaceRoute({ view: 'home' })
    return isCurrent()
  }
  const bundleId = shownManagedBundleId(state)
  // Route restoration validates its destination itself. A background refresh
  // must never replace that destination with the previously displayed bundle.
  if (fresh !== null && bundleId && !managedNavigationPending) {
    const navigation = currentViewGeneration()
    const bundleIsCurrent = () => isCurrent() && !signal.aborted && !managedNavigationPending
      && update === managedTeamsUpdate && navigation === currentViewGeneration() && generation === clientModeGeneration
      && sameAccount(state.managedSession, session) && isManagedUiMode()
      && shownManagedBundleId(state) === bundleId
    let accessible
    try {
      accessible = await refreshManagedBundleView(state, teams, {
        fetchCatalog: () => fetchManagedBundleCatalog({ signal: AbortSignal.any([signal, currentViewSignal()]) }),
        isCurrent: bundleIsCurrent,
        render: () => render({ animate: false }),
        replaceRoute: route => managedHistory.replaceRoute(route),
      })
    } catch (err) {
      if (!bundleIsCurrent()) return isCurrent()
      if (err.name !== 'AbortError') showToast(`Couldn't refresh bundle access: ${err.message}`, { kind: 'error' })
      renderSidebar()
      return false // Keep the open bundle and retry transient catalogue failures.
    }
    if (!bundleIsCurrent()) return isCurrent()
    if (!accessible) {
      readyManagedView = null
      return leaveForHome()
    }
  }
  // Discard an already-rendered view as well as its cached envelopes. In
  // particular, Findings/Files navigation must not reuse revoked findings.
  if (managedReportViewChanged(state, teams, changedReports)) {
    const team = teams.find(candidate => candidate.id === state.currentManagedTeam)
    const canReopenReport = team && (state.currentManagedReport === null || team.reports.some(report => report.id === state.currentManagedReport))
    const route = canReopenReport ? managedRouteForIds({ view: state.currentView === 'links' ? 'findings' : state.currentView,
      teamId: team.id, reportId: state.currentManagedReport }, teams) : null
    readyManagedView = null
    const cleared = goHome({ history: false })
    const navigation = currentViewGeneration()
    await cleared
    // Drop stale content immediately, then reopen still-accessible content.
    // A user's intervening navigation/account switch always wins.
    if (strict) {
      if (navigation === currentViewGeneration() && generation === clientModeGeneration
        && sameAccount(state.managedSession, session) && isManagedUiMode()) {
        await managedHistory.navigate(route ?? { view: 'home' }, { replace: true })
      }
      return isCurrent() // Same-team navigation can retain the catalog stream.
    }
    if (!isCurrent()) return false
  }
  if (!managedNavigationPending && WORKSPACE_CONTENT_VIEWS.includes(state.currentView) && !teams.some(team => team.id === state.currentManagedTeam)) {
    return leaveForHome()
  }
  if (!managedNavigationPending && (state.currentWorkspace || state.bundleDetails?.npm || previousTeamName !== teams.find(team => team.id === state.currentManagedTeam)?.name)) render({ animate: false })
  renderSidebar()
  return true
}

// Manage pages are the MANAGED_PAGES routes; each key is also the
// `state.currentView` render() paints as its `<managed-admin-*>` element.
// Users, repositories, their risk, teams, import and deduplication are
// admin-only; the rest are also open to managers.
const ADMIN_ONLY_PAGES = new Set(['admin-users', 'manage-repos', 'manage-repo-risk', 'manage-teams', 'manage-import', 'manage-deduplication'])
let readyManagedView = null

function canAccessManagedPage(view) {
  const role = state.managedSession?.role
  if (view === 'manage-links' && !state.managed?.allowShare) return false
  return ['admin', 'manage'].includes(role) && (!ADMIN_ONLY_PAGES.has(view) || role === 'admin')
}

// The latest restoration started owns the pending flag. One a newer
// restoration superseded leaves it to that one, and the latest releases it
// when it ends, unless cancellation released it first.
let managedRestoration = 0

// A tab switch on the page shown cancelled the restoration still loading,
// with no navigation of its own to follow it. Stop the restoration's reads
// and release its hold on catalogue work now, then replay that work for the
// page kept: catalogue revisions it held back were left for the restoration
// to validate its destination with, and it never will.
function cancelManagedRestoration() {
  ++managedRestoration
  managedNavigationPending = false
  beginViewNavigation()
  const generation = clientModeGeneration
  void viewManagedTeams(() => generation === clientModeGeneration && isManagedUiMode())
}

// Navigate to one of the admin / manage pages: load the admin bundle
// (which defines the element render() paints for `view`), then switch
// the view + repaint.
async function restoreManagedPage(route, isCurrent) {
  const restoration = ++managedRestoration
  managedNavigationPending = true
  try { return await restoreManagedPageContent(route, isCurrent) }
  finally {
    if (restoration === managedRestoration) {
      managedNavigationPending = false
      void renderSidebar()
    }
  }
}

async function restoreManagedPageContent(route, isCurrent) {
  const reusableView = readyManagedView === currentViewGeneration() ? readyManagedView : null
  // Cancel the previous view's reads before checking the destination.
  beginViewNavigation()
  // The shared catalog is kept current by feed revisions. Do not read it again
  // just to resolve another route; changed versions invalidate cached content.
  if ((['findings', 'files', 'bundles', ...WORKSPACE_CONTENT_VIEWS].includes(route?.view) || route?.finding)
    && (!(await viewManagedTeams(isCurrent)) || !isCurrent())) return false
  let adminBundles = []
  if (route?.view === 'bundles' && route.teamSlug == null) {
    if (!canAccessManagedPage('manage-bundles')) return false
    adminBundles = await fetchManagedBundleCatalog()
    if (!isCurrent() || !isManagedUiMode()) return false
  }
  route = resolveManagedRoute(route, state.managedTeams, adminBundles)
  if (!route) return false
  const canReuseReport = reusableView !== null && readyManagedView === reusableView
    && state.currentManagedTeam === route.teamId && state.currentManagedReport === route.reportId
  if (!isCurrent() || !isManagedUiMode()) return false
  if (route.view !== 'home' && (!state.managedSession || state.managedSession.role === 'none')) return false
  if (route.finding) {
    const result = await revealFinding({ ...route.finding, teamId: route.teamId, reportId: route.reportId, teamOnly: route.teamOnly }, {
      openManagedReport: (team, reportId) => switchToManagedTeam(team, reportId, { history: false }),
      isCurrent,
    })
    if (!isCurrent()) return false
    if (!result.ok) { if (result.reason) showToast(result.reason); return false }
    readyManagedView = currentViewGeneration()
    startManagedTeamFeed()
    return managedRouteForIds({ view: 'findings', teamId: state.currentManagedTeam, reportId: state.currentManagedReport, finding: { id: route.finding.id } }, state.managedTeams)
  }
  if (WORKSPACE_CONTENT_VIEWS.includes(route.view)) {
    return switchToWorkspaceContent(route.teamId, route.view.slice('workspace-'.length), { history: false, tab: route.dependencyTab ?? 'pulls' })
  }
  if (route.view === 'bundles') {
    const entries = route.teamId == null ? adminBundles.map(managedBundleEntry) : managedTeamBundleEntries(state.managedTeams)
    if (!(await openManagedBundle(route, entries, isCurrent, renderSidebar))) return false
    // The compared bundle stays only as Compare took it.
    const { compareId: _compareId, compareMode: _compareMode, ...opened } = route
    return managedRouteForIds({ ...opened, bundleTab: state.bundleDetailsTab, ...managedCompareLocation(state) }, state.managedTeams, adminBundles)
  }
  if (route.view === 'home') return goHome({ history: false })
  if (route.view === 'npm') return openNpmRoute(route, isCurrent, renderSidebar)
  // The code viewer reads repositories as Create a bundle browses them, for
  // any team member (canReadRepositoryCode).
  if (route.view === 'repository-code') return canReadRepositoryCode(state.managedSession) && openRepositoryCodeRoute(route, isCurrent, renderSidebar)
  if (route.view === 'reviews' || route.view === 'profile') {
    if (state.managedSession.publicShare) return false
    cleanupGraph2()
    state.currentView = route.view
    state.profileLinkError = route.linkError ?? null
    state.currentManagedTeam = null
    state.currentManagedReport = null
    document.body.classList.remove('report-fullscreen')
    render({ animate: false })
    renderSidebar()
    return route
  }
  if (route.view === 'manage-deduplication' && route.linkId) {
    return canAccessManagedPage(route.view) && await switchToManagedDeduplication(route.linkId)
  }
  if (Object.hasOwn(MANAGED_PAGES, route.view)) return navigateToAdminPage(route.view, { ...route, history: false })
  const team = state.managedTeams.find(candidate => candidate.id === route.teamId)
  if (!team) return false
  // Findings/Files are two views of the same hydrated reports. Switching
  // between them must preserve filters and avoid fetching/parsing again.
  // A team link's repository and severity filters are for the board that
  // shows every triage status, Kanban (common/managed/team-filters.js):
  // switched to before the team loads, so it opens as a fresh Kanban board
  // does, its opening filters read off every status, not one view's.
  const linked = route.filters && route.view === 'findings' && route.reportId == null ? route.filters : null
  if (linked) {
    if (state.viewMode === 'graph') cleanupGraph2()
    state.viewMode = 'kanban'
    state.focusGid = null
    state.kanbanPopoverGid = null
  }
  if (!canReuseReport && !(await switchToManagedTeam(team, route.reportId, { history: false }))) return false
  if (!isCurrent()) return false
  if (linked && !state.currentLinks) applyLinkedFilters(linked)
  if (state.currentView !== route.view) cleanupGraph2()
  state.currentView = state.currentLinks ? 'links' : route.view
  document.body.classList.remove('report-fullscreen')
  // Commit page restoration synchronously with its URL, including in a
  // background PWA window where a view transition may wait for a paint.
  render({ animate: false })
  readyManagedView = currentViewGeneration()
  startManagedTeamFeed()
  renderSidebar()
  document.querySelector('#main-content')?.scrollTo({ top: 0 })
  return managedRouteForIds({ ...route, view: state.currentView === 'links' ? 'findings' : state.currentView }, state.managedTeams)
}

document.addEventListener('managed-bundle-open', event => {
  if (isManagedUiMode() && typeof event.detail?.id === 'string') {
    const entry = managedBundleEntry(event.detail)
    const teams = state.managedTeams
    const team = teams.find(candidate => candidate.id === state.currentManagedTeam && candidate.bundles?.some(bundle => bundle.id === entry.managedId))
      ?? teams.find(candidate => candidate.bundles?.some(bundle => bundle.id === entry.managedId))
    void managedHistory.navigate(managedBundleRoute(teams, entry, team?.id,
      state.currentView === 'bundles' ? state.bundleDetailsTab : 'overview'))
  }
})

document.addEventListener('managed-import-complete', () => { void refreshManagedSession() })

// Another tab told of another session than this one's, its cookie changed
// there: this one's asked again at once, superseding one in flight, which may
// have read the cookie before; and, where a probe that failed kept the
// session it had, again later while that tab's still differs, each wait
// longer, to a minute. A refresh outside these whose probe failed so asks
// again after the first wait.
const SESSION_RECHECKS_MS = [5_000, 15_000, 45_000, 60_000]
let sessionRecheck = null
let sessionRechecks = 0
async function recheckManagedSession(attempt = 0) {
  clearTimeout(sessionRecheck)
  sessionRecheck = null
  const chain = ++sessionRechecks
  if (!isManagedUiMode() || getPreviewRole()) return
  await refreshManagedSession({ again: true })
  if (chain !== sessionRechecks || !await toldOtherThan(state.managedSession)) return
  if (chain === sessionRechecks) askManagedSessionLater(attempt)
}
// Asked again after `attempt`'s wait, in place of an ask pending.
function askManagedSessionLater(attempt) {
  clearTimeout(sessionRecheck)
  sessionRecheck = setTimeout(() => { void recheckManagedSession(attempt + 1) }, SESSION_RECHECKS_MS[Math.min(attempt, SESSION_RECHECKS_MS.length - 1)])
}
watchManagedSessions(() => { void recheckManagedSession() })

document.addEventListener('managed-feed-closed', () => {
  managedSessionPending = true
  stopManagedTeamFeed()
  resetManagedTriage()
  void goHome({ history: false }).then(() => refreshManagedSession())
  showToast('Workspace access changed. Refreshing your session.')
})

export async function navigateToAdminPage(view, options = {}) {
  if (options.history !== false && isManagedUiMode()) {
    if (!managedHistory.active) await refreshManagedSession()
    if (managedHistory.active) return managedHistory.navigate({ view, ...(options.actor ? { actor: options.actor } : {}), ...(options.bundleId ? { bundleId: options.bundleId } : {}), ...(['link', 'dependencies'].includes(options.scanMode) ? { scanMode: options.scanMode } : {}), ...(options.linkId ? { linkId: options.linkId } : {}), ...riskRoute(view, options, { keep: true }) })
  }
  if (!Object.hasOwn(MANAGED_PAGES, view) || !isManagedUiMode() || !canAccessManagedPage(view)) return false
  const navigation = beginViewNavigation()
  const generation = clientModeGeneration
  try {
    const managed = await loadManagedBundle()
    if (view === 'manage-import' && canAccessManagedPage(view)) await managed.loadWorkspaceImportPage()
  }
  catch (err) { console.warn(`${view}: managed bundle load failed:`, err); return false }
  if (generation !== clientModeGeneration || navigation !== currentViewGeneration() || !isManagedUiMode() || !canAccessManagedPage(view)) return false
  state.currentView = view
  state.scanSelection = view === 'manage-scans' ? options.scanMode === 'link' ? { mode: 'report', reportMode: 'link' }
    : options.bundleId ? { bundleId: options.bundleId, ...(options.scanMode === 'dependencies' ? { mode: 'dependencies' } : {}) } : null : null
  state.bundleCreationRepoId = view === 'manage-bundles' ? options.createRepoId ?? null : null
  state.riskSelection = view === 'manage-repo-risk' ? riskRoute(view, options) : null
  render({ animate: false })
  renderSidebar()
  // Use the known role and CSRF token immediately; apply session changes when
  // the background check finishes. Rapid navigation shares the pending check.
  // The session is asked each time, as another tab's sign-in or view may have
  // changed the cookie its feed was opened with; the teams only where it
  // changed, or the feed isn't live to tell them.
  void refreshManagedSession({ keepTeams: true })
  // Manage pages share the main scroll container. Start each destination at its
  // header instead of carrying a long list's scroll position into the next page.
  document.querySelector('#main-content')?.scrollTo({ top: 0 })
  if (view === 'manage-history') {
    document.dispatchEvent(new CustomEvent('managed-history-filter', {
      detail: { actor: options.actor ?? '' }, bubbles: true, composed: true,
    }))
  }
  return true
}

// The scope Risk opens on: the one `options` names, else, where it `keep`s
// one and Risk is shown already, the one it shows, so its tab clicked there
// keeps it; none opens All.
function riskRoute(view, options, { keep = false } = {}) {
  if (view !== 'manage-repo-risk') return {}
  const { riskScope, riskTarget } = keep && options.riskScope == null && state.currentView === view ? state.riskSelection ?? {} : options
  return { ...(riskScope == null ? {} : { riskScope }), ...(riskTarget == null ? {} : { riskTarget }) }
}

// Admin pages live in a separate lazy-loaded bundle, so the shared back button
// and management hub communicate through a composed event instead of importing
// the sidebar module into that bundle (which would duplicate application state).
document.addEventListener('managed-notice', event => showToast(event.detail.message, { kind: 'error' }))

document.addEventListener('managed-admin-navigate', (event) => {
  const view = event.detail?.view
  const actor = event.detail?.actor
  if (typeof view === 'string') void navigateToAdminPage(view, { actor, scanMode: event.detail?.scanMode, linkId: event.detail?.linkId, riskScope: event.detail?.riskScope, riskTarget: event.detail?.riskTarget })
})

// A repository's code, from its row on the Repositories page or a team's: at
// its default branch's head, in the directory `path` where the row names one,
// `repo` its name for the header while it opens.
document.addEventListener('managed-repository-code-open', event => {
  const { repoId, repo = null, path = '' } = event.detail ?? {}
  if (isManagedUiMode() && Number.isSafeInteger(repoId) && repoId > 0) {
    navigateToRepositoryCode({ repoId, repo: typeof repo === 'string' && repo ? repo : null, path: typeof path === 'string' ? path : '' })
  }
})

// The protocol fields of a server found unavailable or standalone.
const STANDALONE = { serverMode: 'standalone', serverModeConfig: null, serverModeSelection: null }

// Cold-start mode detection. With nothing cached we don't yet know the server's
// protocol — and a managed server has no WS plane whose connect frame would
// tell us — so GET /api/config to learn it up front and feed the same
// applyServerInfo path. A cached hint releases startup immediately, while
// the HTTP probe still checks it in the background (managed has no WS frame).
let clientModeReady
// Wait only until startup selects a usable surface: a confirmed server mode,
// or offline local mode. Server availability never grants access to local data.
export function ensureClientMode() {
  return clientModeReady ??= detectServerModeIfUnknown().then(() => document.querySelector('app-sidebar')?.removeAttribute('inert'))
}

function probeStartupServerInfo() {
  const probe = probeServerInfo()
  // A probe slower than startup's wait never holds the session: it is asked for.
  startupSession = waitForServerInfo(probe).then(info => info?.session)
  return probe
}

async function detectServerModeIfUnknown() {
  const cached = readCachedServerInfo()
  if (cached) {
    // Another tab may have confirmed the mode since state.ts was evaluated.
    configureClientMode(cached.mode)
    state.managed = cached.managed
    // The cache is a startup hint, not a permanent protocol binding. Today's
    // advertisement replaces it; a failed probe still permits local access.
    void probeStartupServerInfo().then((info) => {
      if (info && info !== 'standalone') return applyServerInfo(info)
      return undefined
    }).catch((err) => console.warn('server mode revalidation:', err))
    return
  }
  setLandingModePending(!hasStandaloneProbeHint())
  const probe = probeStartupServerInfo()
  const info = await waitForServerInfo(probe, hasStandaloneProbeHint() ? 0 : 3000)
  if (info && info !== 'standalone') return applyServerInfo(info)
  // A sync frame or another tab may have confirmed the mode while pending.
  // Adopt it into state as well: the initial e2e default is not confirmation.
  const confirmed = readCachedServerInfo()
  if (confirmed) return applyServerInfo(confirmed, { runtime: false })
  // Unknown or unavailable server: open local data with synchronization off.
  // Do not cache a guessed protocol or modify any saved sync preferences.
  if (info === 'standalone') rememberStandaloneProbe()
  Object.assign(state, STANDALONE)
  setLocalMode(info === null)
  setSyncForceDisabled(true)
  setLandingModePending(false)
  renderSyncStatus(triageSync.status)
  renderSidebar()
  // Keep a slow request alive. Learning the server's protocol later may enable
  // e2e sync, but must not evict a local report or import it into managed mode.
  if (info === null) {
    void probe.then((lateInfo) => {
      const cachedInfo = readCachedServerInfo()
      const latest = lateInfo && lateInfo !== 'standalone' ? lateInfo : cachedInfo ?? lateInfo
      if (latest === 'standalone') {
        rememberStandaloneProbe()
        if (forcedManagedReturn) {
          Object.assign(forcedManagedReturn, STANDALONE, { localMode: false })
          return undefined
        }
        setLocalMode(false)
        renderSyncStatus(triageSync.status)
        return renderSidebar()
      }
      if (latest) return applyServerInfo(latest, { runtime: latest !== cachedInfo })
      return undefined
    }).catch((err) => console.warn('server mode probe:', err))
  }
}

// The account menu is a native popover (top layer); position it just above the
// auth button on open, since popover="auto" otherwise centers in the viewport.
function positionUserMenuOnOpen() {
  const menu = root.querySelector('#user-menu')
  const trigger = root.querySelector('#auth-status')
  menu.addEventListener('beforetoggle', (e) => {
    if (e.newState !== 'open') return
    const r = trigger.getBoundingClientRect()
    menu.style.left = `${Math.round(r.left)}px`
    menu.style.bottom = `${Math.round(window.innerHeight - r.top + 6)}px`
    menu.style.top = 'auto'
    menu.style.right = 'auto'
  })
}

// Wire the delegates onto the shadow root and the search input, hand the
// encryption toggle and storage line their buttons, then paint.
function mount(host) {
  hostEl = host
  root = host.renderRoot
  fileList = root.querySelector('#file-list')
  initEncryptionToggle(root.querySelector('#encryption-toggle'))
  initStorageStatus(root.querySelector('#storage-status'))
  root.addEventListener('click', onSidebarClick)
  root.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.closest?.('[data-action="toggle-client-mode"]')) {
      e.preventDefault()
      void onSidebarClick(e)
    }
  })
  for (const [type, listener] of Object.entries({ dblclick: onSidebarDblclick, dragstart: onSidebarDragstart, dragend: onSidebarDragend,
    dragover: onSidebarDragover, dragleave: onSidebarDragleave, drop: onSidebarDrop })) root.addEventListener(type, listener)
  installShadowTooltipListener(root, SIDEBAR_TOOLTIP_OPTIONS)
  root.querySelector('#sidebar-search-input')?.addEventListener('input', onSearchInput)
  positionUserMenuOnOpen()
  renderSyncStatus(triageSync.status)
  if (!readCachedServerInfo()) setLandingModePending(!hasStandaloneProbeHint())
  renderSidebar()
  // An active e2e connection can refresh its advertisement. Ignore frames
  // arriving after discovery switched to managed and began closing the socket.
  triageSync.onServerInfo((info) => {
    if (state.serverMode !== 'e2e') return
    const cached = readCachedServerInfo()
    const configured = cached && { ...cached, ...(state.deepviewScanServer ? { deepviewScanServer: state.deepviewScanServer } : {}) }
    return applyServerInfo(mergeSyncServerInfo(configured, info))
  })
  // Cold start (mode not yet cached): probe GET /api/config so we detect a
  // managed server, which has no WS connect frame to announce itself.
  void ensureClientMode()
  // If the cached mode is already managed, probe the session now so the auth
  // control paints logged-in/out without waiting for a connect frame.
  if (state.serverMode === 'managed') void refreshManagedSession()
}

// `<app-sidebar>`: shadow DOM, so its stylesheet is scoped to it. The shell
// renders once; `#file-list` (no `${}` inside it, so a re-render never
// wipes it) and the rail are filled imperatively by renderSidebar().
class AppSidebar extends LitElement {
  // `file-icon.css` (the brand stickers' fills) is global for the main
  // content's light DOM; inlined here, as no global rule reaches the rows.
  static styles = [unsafeCSS(fileIconCSS), unsafeCSS(sidebarCSS)]

  render() {
    return html`
      <div class="sidebar-header">
        <h2 class="brand">
          <button class="brand-button" type="button" data-action="go-home">
            <span class="brand-name">Triage</span>
          </button>
          <span class="brand-tag" data-action="toggle-client-mode">${clientModeLabel()}</span>
        </h2>
        <button id="encryption-toggle" type="button" hidden></button>
        <button id="sidebar-toggle" type="button" aria-label="toggle sidebar">
          <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true">
            <path d="M2 4h12v1.5H2zM2 7.25h12v1.5H2zM2 10.5h12V12H2z"/>
          </svg>
        </button>
      </div>
      <button id="sidebar-home" class="rail-item" type="button" data-action="go-home" aria-label="Home" data-tooltip="Home">
        <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M2.5 7.5 8 3l5.5 4.5M4 6.5V13h3V9.5h2V13h3V6.5"/>
        </svg>
      </button>
      <div class="sidebar-search">
        <svg class="sidebar-search-icon" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
          <circle cx="6.5" cy="6.5" r="4.5"/>
          <path d="M9.7 9.7L13 13" stroke-linecap="round"/>
        </svg>
        <input id="sidebar-search-input" type="search" placeholder="Search reports…" aria-label="Search reports" autocomplete="off">
        <sidebar-view-button kind="packages"></sidebar-view-button>
        <sidebar-view-button kind="repositories"></sidebar-view-button>
      </div>
      <ul id="file-list"></ul>
      <ul id="sidebar-rail"></ul>
      <button id="storage-status" type="button" hidden>
        <span class="storage-dot" aria-hidden="true"></span>
        <span class="storage-label"></span>
      </button>
      <div id="view-as-status" role="status" hidden></div>
      <div class="sidebar-actions">
        <sidebar-delete-current></sidebar-delete-current>
        <button id="sync-status" type="button" data-status="off">
          <span class="sync-dot" aria-hidden="true"></span>
          <span class="sync-label">Sync off</span>
        </button>
        <button id="auth-status" type="button" hidden></button>
        <span id="public-status" hidden>Public access link · Read only</span>
        <button id="manage-status" type="button" hidden data-action="manage" aria-label="Manage">${appMarkup(MANAGE_ICON_SVG)}</button>
      </div>
      <div id="user-menu" popover class="user-menu"></div>
    `
  }

  firstUpdated() {
    mount(this)
  }
}
customElements.define('app-sidebar', AppSidebar)
