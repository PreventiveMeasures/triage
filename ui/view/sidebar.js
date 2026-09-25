import { LitElement, html, render as litRender, nothing, unsafeCSS } from 'lit'
import { repeat } from 'lit/directives/repeat.js'
import { unsafeHTML } from 'lit/directives/unsafe-html.js'
import { LINKS_KIND, addBundleToWorkspace, addReportToWorkspace, analyzeTriageImpact, clientModeLabel, computeLinkHint, configureClientMode, createWorkspace, ensureBundleFindingsIndexed, ensureCounts, ensureLinkedFindingsIndexed, getCount, getKind, getPackagesIndex, getRepositoriesIndex, getWorkspaceAppMetadata, getWorkspaceAppModeHint, hasStandaloneProbeHint, hydrateSecureStorage, isCombinedServerMode, isManagedUiMode, listBundles, listFiles, listWorkspaces, mergeSyncServerInfo, migrateLegacyFilenames, onVaultStateChange, onWorkspaceAppMetadataChanged, probeServerInfo, readCachedServerInfo, reloadTriageFromStorage, rememberStandaloneProbe, removeBundleFromWorkspace, removeReportFromWorkspace, renameWorkspace, setLocalMode, state, syncObservedAfterHydrate, toggleClientMode, waitForServerInfo, writeCachedServerInfo } from '#client/index.js'
import { deleteBundleFromRemote, deleteFromRemote as deleteRemote, isBundleInRemoteOrCached, isInRemoteOrCached, loadSync, setSyncForceDisabled, triageSync } from './client-sync.js'
import { clearPreviewRole, getPreviewRole, loadManagedBundle, logout as managedLogout, probeSession as managedProbeSession, probeTeams as managedProbeTeams, resetManagedAppState, setManagedAppSession } from './client-managed.js'
import { showToast } from './toast.js'
import { managedHistory } from './managed-history.js'
import { cleanupGraph2 } from './graph/state.js'
import { MANAGED_PAGES } from '../../common/managed/routes.js'
import { ROLES, isRole } from '../../common/managed/roles.ts'
import { initManagedTriagePush, resetManagedTriage } from './managed-triage.js'
import sidebarCSS from './sidebar.css'
import fileIconCSS from '../styles/file-icon.css'
import { initEncryptionToggle, refreshEncryptionToggle } from './encryption-toggle.js'
import { initStorageStatus, scheduleStorageStatusRefresh } from './storage-status.js'
import { render } from './render.js'
import { renderLandingWorkspaces } from './landing-workspaces.js'
import { getLoadedWorkspaceAppMetadata } from './workspace-app-load.js'
import { updateManagedLanding } from './landing-managed.js'
import { refreshScanNavigation } from './scan-navigation.js'

// Set on mount (`<app-sidebar>` firstUpdated). `hostEl` is the
// custom-element host (light DOM — the `.classList` collapse
// toggle lives here). `root` is its shadow root, the scope for all
// event delegates + `querySelector` lookups; events fired inside it
// reach delegates attached to it with `e.target` un-retargeted, so
// the `e.target.closest(...)` matching below works unchanged.
// `fileList` is the `#file-list` <ul> inside the shadow.
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
import { beginViewNavigation, currentViewGeneration, deleteCurrent, deleteCurrentBundle, goHome, leaveWorkspace, persistLastBundle, resetForClientModeTransition, switchToFile, switchToManagedTeam, switchToWorkspace } from './ingest.js'
import { reportWorkspaceFor } from './finding-link.js'
import { exportWorkspace } from './workspace-export.js'
import { maybePromptFirstUse } from './first-import-prompt.js'
import { openNewWorkspaceDialog } from './dialogs/new-workspace-dialog.js'
import { openLeaveWorkspaceDialog } from './dialogs/leave-workspace-dialog.js'
import { openWorkspaceShareLinkDialog } from './dialogs/workspace-share-link-dialog.js'
import { openDeleteReportDialog } from './dialogs/delete-report-dialog.js'
import { openDeleteBundleDialog } from './dialogs/delete-bundle-dialog.js'
import { openDetachBundleDialog } from './dialogs/detach-bundle-dialog.js'
import { openDetachReportDialog } from './dialogs/detach-report-dialog.js'
import { openPersistenceDegradedDialog } from './dialogs/persistence-degraded-dialog.js'
import { openProxyAuthDialog } from './dialogs/proxy-auth-dialog.js'
import { FILE_ICONS, displayName, groupOf, isLinksFile } from './file-display.js'
import { BUNDLE_ICON_SVG, MANAGE_ICON_SVG, WORKSPACE_ICON_SVG } from './icons.js'
import { openBundle, selectBundle } from './bundle-load.js'
import { installGlobalTooltipListener, installShadowTooltipListener } from './tooltip.js'

// Boot-time install — the document-level handler for any
// light-DOM `[data-tooltip]` element. Sidebar items live in the
// shadow root so they wire their own scoped listener below.
installGlobalTooltipListener()

// Distinct package count across every report the OPFS finding
// index has scanned (NOT just state.reports — Packages aggregates
// across the user's entire drop history, not just what's loaded).
// Cheap walk; sidebar renders aren't on the hot path.
function countLoadedPackages() {
  return getPackagesIndex().size
}

// Mirror for the Repositories view — own-source findings bucketed
// by their `repo.github` (or per-report `_repoFallback`) URL.
// Same OPFS-wide signal as countLoadedPackages so the sidebar
// header hides when the index is empty.
function countLoadedRepositories() {
  return getRepositoriesIndex().size
}

// Default sync endpoint used when the user toggles the sidebar
// status button on. Resolved per-origin:
//   - `.github.io` (and the `typeof location` guard for SSR-style
//     loads) stays empty — GitHub Pages can't host a WebSocket
//     endpoint, so the button would only ever read as broken.
//   - anything else → `${origin}/api/sync` on the matching ws/wss
//     scheme. The `/api/` prefix matches the relay's reserved
//     backend namespace — a fronting nginx (prod) or `build.js`'s
//     dev proxy (local) routes `/api/*` → relay, `/*` → the static
//     UI bundle, no upgrade-header gymnastics. Localhost gets the
//     same shape as a self-hosted deploy: the dev proxy on :8000
//     forwards `/api/sync` to `server-e2e/index.ts` on :8765, so
//     `ws://127.0.0.1:8000/api/sync` Just Works.
// A user who wants to override either default can still call
// `DeepView.triageSync.setServerUrl('wss://…')` from the console;
// the empty default just means there's no toggle-on target.
const DEFAULT_SYNC_URL = (() => {
  if (typeof location === 'undefined') return ''
  if (location.hostname.endsWith('.github.io')) return ''
  const wsScheme = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${wsScheme}//${location.host}/api/sync`
})()

// dataTransfer mime used by intra-sidebar drag-and-drop. The value is
// the report's filename. We carry both this private mime AND
// text/plain so browsers that drop the private mime in cross-frame
// scenarios still have a fallback payload — the type-check below
// uses the private mime so OS file drags (which only carry Files)
// don't accidentally match.
const REPORT_DT = 'application/x-deepview-report'
// Source-workspace mime — encodes the workspace id the dragged row
// originated from, or the empty string when the row was rendered
// under the unfiled bucket. Captured at `dragstart` time so a
// renderSidebar() racing the drop (e.g., onAutoDownloaded firing
// during the drag) can't desync the drop handler's source lookup.
// `dataTransfer` survives DOM mutations within the same drag.
const SOURCE_WS_DT = 'application/x-deepview-source-ws'
// Companion mime for bundles. Value is the bundle's sha512 integrity
// string (same key the bundle metadata + setBundleWorkspace use).
// Separate from REPORT_DT so the drag handlers can tell the two apart
// without re-resolving the payload — bundles and reports have
// disjoint identifier spaces (filename vs `sha512-…`).
const BUNDLE_DT = 'application/x-deepview-bundle'

// Set to true while a report row is being dragged so the Reports
// drop-target header stays visible even when the unfiled list is empty.
let isDraggingReport = false

// Mirror for bundles — keeps the Bundles header visible mid-drag even
// when no unfiled bundle exists (e.g. every bundle is workspace-claimed
// and the user is dragging one OUT). Without this the header would be
// suppressed by its `unfiledBundles.length > 0` gate and the detach
// drop target would have nothing to light up on.
let isDraggingBundle = false

// Section header label per group. The default JSON bucket renders
// under "Reports" — broad enough to fit any analyzer-native dump
// (deduplicate output, single-run output, etc.) without naming the
// pipeline. Named buckets carry the upstream's product name —
// DeepSec is Vercel's tool (https://github.com/vercel-labs/deepsec);
// Piolium is Vigolium's (https://github.com/vigolium/piolium). "Links"
// is the odd one out and deliberately so: it isn't a producer, it's a
// different KIND of file — one that names findings in the reports
// above it rather than carrying any (client/linked-findings.js).
const GROUP_LABELS = {
  'default': 'Reports',
  'claude-security': 'Claude Security',
  'codex-security': 'Codex Security',
  'deepsec': 'DeepSec',
  'piolium': 'Piolium',
  [LINKS_KIND]: 'Links',
}

// Render order for buckets — default (analyzer dumps) first, then
// named sources in alphabetical-ish reading order, and Links last:
// it's about the reports above it, so it reads as their footnote
// rather than as another one of them.
const GROUP_ORDER = ['default', 'claude-security', 'codex-security', 'deepsec', 'piolium', LINKS_KIND]


// Live module state — the search-box query, applied as a
// case-insensitive substring match on each file's display name.
// Cleared by switchToFile / deleteCurrent indirectly (a fresh render
// starts from this same value), so users can switch files without
// losing their search.
let searchQuery = ''
let searchActive = false
// App workspaces start compact. Search temporarily reveals matching children
// without changing the user's independent report/bundle expansion choices.
const expandedWorkspaceSections = new Map()
let lastWorkspaceFocus = ''

function revealFocusedWorkspaceSection(workspaces, force) {
  const bundle = state.currentView === 'bundles' ? state.selectedBundle : null
  const report = ['findings', 'files', 'links'].includes(state.currentView) ? state.currentFile : null
  const section = bundle ? 'bundles' : 'reports'
  const reportWorkspace = report ? reportWorkspaceFor(report) : null
  const parents = workspaces.filter((w) => bundle ? w.bundles.includes(bundle) : w.id === reportWorkspace)
  const focus = JSON.stringify([section, bundle || report, parents.map((w) => w.id)])
  if (!force && focus === lastWorkspaceFocus) return
  lastWorkspaceFocus = focus
  // Reveal on navigation, not every repaint: a user can still collapse the
  // selected section. Search's temporary expansion does not change this state.
  for (const w of parents) {
    const expanded = expandedWorkspaceSections.get(w.id) ?? new Set()
    expanded.add(section)
    expandedWorkspaceSections.set(w.id, expanded)
  }
}

function fileItemTemplate(n, opts = {}) {
  // Suppress the `current` highlight when the user is browsing the
  // bundles view — there's no active report in that mode, so
  // leaving the previously-loaded report visually selected reads
  // as a stale state. The same suppression applies to the
  // workspace-row template below.
  const isCurrent = n === state.currentFile
    && (opts.workspaceId ?? null) === reportWorkspaceFor(n)
    && (state.currentView === 'findings' || state.currentView === 'files'
      || state.currentView === 'links')
  const cls = `file-item${isCurrent ? ' current' : ''}${opts.indented ? ' indented' : ''}`
  const label = displayName(n)
  const count = getCount(n)
  const iconHtml = FILE_ICONS[groupOf(n)] ?? FILE_ICONS.default
  // Indented rows live inside a workspace; carry the workspace id so
  // a drop onto one of these is treated as "assign to this workspace"
  // (which is idempotent if it's the report's current home, and a
  // move when it isn't). Top-level rows have no workspace attribute,
  // so dropping onto them is treated as "outside any workspace" and
  // falls through to the unfiled-section drop target. The brand
  // "sticker" icons in `FILE_ICONS` are SVG fragments authored in
  // file-display.js — controlled-domain content, no user input — so
  // they're piped through `unsafeHTML` to skip Lit's text escape.
  return html`<li
    class=${cls}
    data-file=${n}
    data-workspace-id=${opts.workspaceId ?? nothing}
    draggable="true"
  ><button type="button" class="file-name" data-tooltip=${label}>${unsafeHTML(iconHtml)}<span class="file-label">${label}</span>${count === undefined ? nothing : html`<span class="file-count">${count}</span>`}</button></li>`
}

function groupHeaderTemplate(label, opts = {}) {
  const cls = `file-group-header${opts.dropTarget ? ' default-reports' : ''}`
  return html`<li
    class=${cls}
    data-default-reports=${opts.dropTarget ? 'true' : nothing}
  ><span class="group-label">${label}</span></li>`
}

// Workspaces section header — same chrome as a regular bucket header,
// but the right slot carries a plus button.
// `data-action="new-workspace"` is what the sidebar click delegate
// dispatches on; the chip's title gives the affordance a tooltip
// mirroring the "Delete current" button below.
const WORKSPACE_PLUS_ICON = html`<svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M8 3.5v9M3.5 8h9"/></svg>`
const LOGOUT_ICON = html`<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2.5H3.5v11H8M10 5l3 3-3 3M13 8H6"/></svg>`
function workspaceHeaderTemplate() {
  // Managed mode has no client-side workspace creation — a different management
  // surface is coming — so drop the "+" affordance there.
  const actions = isManagedUiMode()
    ? nothing
    : html`<span class="workspace-header-actions"><button type="button" class="workspace-add" data-action="new-workspace" aria-label="Create a new workspace">${WORKSPACE_PLUS_ICON}</button></span>`
  return html`<li class="file-group-header workspace-header"><span class="group-label">Workspaces</span>${actions}</li>`
}

// The signed-in user's team memberships (managed mode), rendered ABOVE the
// Workspaces section. Opening a team combines its reports in a workspace view;
// repository-owned bundles are listed alongside those reports.
function teamsSectionTemplate() {
  if (!isManagedUiMode()) return nothing
  const teams = Array.isArray(state.managedTeams) ? state.managedTeams : []
  if (teams.length === 0) return nothing
  return html`
    ${groupHeaderTemplate('Teams')}
    ${repeat(teams, (t) => t.id, (t) => html`
      <li class=${`file-item team-item${state.currentManagedTeam === t.id && state.currentWorkspace && state.currentView === 'findings' ? ' current' : ''}`}>
        <button type="button" class="file-name" @click=${() => void switchToManagedTeam(t)}>${TEAM_ICON}<span class="file-label">${t.name}</span></button>
      </li>
      ${repeat(t.reports, (r) => r.id, (r) => teamReportTemplate(t, r))}
      ${repeat(t.bundles ?? [], (b) => b.id, (b) => teamBundleTemplate(b))}`)}`
}

// A clickable report row under its team (managed mode). Reuses the indented
// file-row chrome but carries no `data-file`, so the file-click delegate ignores
// it — opening is handled by its own @click, which renders the report from the
// server WITHOUT caching it to OPFS.
function teamReportTemplate(team, r) {
  const current = state.currentManagedTeam === team.id && state.currentManagedReport === r.id && state.currentView === 'findings'
  return html`<li class=${`file-item indented team-report-item${current ? ' current' : ''}`}>
    <button type="button" class="file-name" data-tooltip=${r.filename} @click=${() => void openTeamReport(team, r)}>
      ${unsafeHTML(FILE_ICONS.default)}<span class="file-label">${r.filename}</span>
    </button>
  </li>`
}

// Single and merged team reports share the same guarded load and triage gate.
function openTeamReport(team, r) {
  return switchToManagedTeam(team, r.id)
}

// Bundles are repository-owned scan inputs. A team member can see the bundle
// when their team can see its repository, but bundles do not open as findings
// views, so keep this row informational and expose the repository in its
// tooltip for similarly-named bundles from different repos.
function teamBundleTemplate(bundle) {
  const repo = typeof bundle.repoFullName === 'string' && bundle.repoFullName !== '' ? bundle.repoFullName : 'Repository'
  return html`<li class="file-item indented team-bundle-item">
    <span class="file-name" data-tooltip=${`${bundle.filename}\n${repo}`}>
      ${BUNDLE_ICON}<span class="file-label">${bundle.filename}</span>
    </span>
  </li>`
}

// Packages + Repositories navigation buttons live as
// `<sidebar-view-button>` StateElements (see
// view/sidebar-view-button.js). Each reads `state.currentView`
// itself for the `.active` highlight and renders `nothing` when
// its `count` property is 0; `renderSidebar()` pushes the count
// on every pass.

function bundlesHeaderTemplate() {
  // Plain label — not a navigation target. The section is an
  // always-expanded category for bundles that don't belong to any
  // workspace, so there's nothing for a click to switch to.
  // `data-default-bundles` flags the header as the unfiled-bundle
  // drop target — same role `data-default-reports` plays for the
  // Reports header. The dragover handler lights it up when a bundle
  // is dragged outside any workspace block; the drop handler then
  // routes to setBundleWorkspace(integrity, null).
  return html`<li class="file-group-header bundles-header" data-default-bundles="true">
    <span class="group-label">Bundles</span>
  </li>`
}

// Generic bundle glyph. Source markup lives in `view/icons.js` so
// the same SVG paints both sidebar rows and the drop-zone's
// supported-formats list; wrap once with `unsafeHTML` so consumers
// can drop `${BUNDLE_ICON}` into their templates as before.
const BUNDLE_ICON = html`${unsafeHTML(BUNDLE_ICON_SVG)}`

// Single bundle row under the always-expanded Bundles header.
// `.current` lights up when this bundle is the open selection in the
// main pane (selectedBundle matches its integrity). The integrity is
// SRI-shaped (sha512-…) and too long to fit; the title surfaces it
// for hover disambiguation when two bundles share a basename.
function bundleItemTemplate(bundle, opts = {}) {
  const { integrity, name } = bundle
  const isCurrent = state.selectedBundle === integrity && state.currentView === 'bundles'
  // `indented` only when the row sits under a workspace — the tree-line
  // decoration anchors it to its parent. Top-level rows under the
  // Bundles category render flush with the other category rows
  // (Reports, DeepSec, …).
  const indented = opts.workspaceId != null
  const cls = `file-item bundle-item${indented ? ' indented' : ''}${isCurrent ? ' current' : ''}`
  // `data-workspace-id` mirrors `fileItemTemplate` — when the row sits
  // INSIDE a workspace, a drop onto it resolves to "this workspace"
  // (so dragging a sibling bundle into the same workspace is a no-op
  // rather than a phantom detach + re-attach). Top-level bundle rows
  // in the Bundles section have no workspace attribute, so a drop on
  // them counts as "outside" and falls through to the detach path.
  return html`<li
    class=${cls}
    data-bundle-integrity=${integrity}
    data-workspace-id=${opts.workspaceId ?? nothing}
    draggable="true"
  ><button type="button" class="file-name" data-tooltip=${`${name}\n${integrity}`}>${BUNDLE_ICON}<span class="file-label">${name}</span></button></li>`
}

// Row for a workspace-claimed bundle whose bytes aren't on this device
// (typically an imported workspace referencing a bundle the recipient
// hasn't dropped yet). Renders muted + non-draggable so the user can
// see WHICH bundles are missing without being misled into thinking
// they can interact with them. The integrity prefix is short enough
// to be human-eyeable for cross-device matching; full integrity is in
// the title for copy-paste. Detach via the Bundles header still works
// (sets `data-workspace-id` so the drop handler finds the owner — but
// `draggable=false` here means the user has to detach from the OTHER
// device first, which is the right UX: this device can't authoritatively
// say what should happen to a bundle it doesn't have.
function missingBundleItemTemplate(integrity, workspaceId) {
  const shortPrefix = integrity.slice(0, 'sha512-'.length + 8)
  return html`<li
    class="file-item indented bundle-item bundle-missing"
    data-bundle-integrity=${integrity}
    data-workspace-id=${workspaceId}
    data-tooltip="Bundle bytes not on this device — drop the matching bundle to attach."
  ><span class="file-name"><span class="file-icon" aria-hidden="true">?</span><span class="file-label"><em>missing · ${shortPrefix}…</em></span></span></li>`
}

// Row for a workspace-claimed report whose bytes aren't on this device
// — the report-side twin of `missingBundleItemTemplate`. A report is
// keyed by its filename (not a content hash), so unlike a missing
// bundle we can show the actual name instead of an integrity prefix.
// Rendered muted + non-interactive: it carries no `data-file` and isn't
// draggable, so the click / dragstart delegates (which match
// `.file-item[data-file]`) skip it without needing a class guard, while
// `data-workspace-id` still makes it a valid assign-to-workspace drop
// target — matching the present rows of the same workspace.
//
// A missing report is usually transient: if a workspace member has the
// report uploaded, the objstore-presence auto-download restores the
// bytes and the next render flips this row to a normal report row. It
// lingers only when no peer copy exists (e.g. an imported workspace that
// references a report nobody re-shared, or an eviction with no cloud
// backup) — which is exactly the state worth surfacing rather than
// silently dropping.
function missingReportItemTemplate(name, workspaceId) {
  return html`<li
    class="file-item indented report-missing"
    data-workspace-id=${workspaceId}
    data-tooltip="Report not on this device — it re-downloads automatically if a workspace member has uploaded it."
  ><span class="file-name"><span class="file-icon" aria-hidden="true">?</span><span class="file-label"><em>missing · ${displayName(name)}</em></span></span></li>`
}

// Workspace glyph — see `BUNDLE_ICON` above for the SVG-source
// rationale; wrapped once at module load with `unsafeHTML`.
const WORKSPACE_ICON = html`${unsafeHTML(WORKSPACE_ICON_SVG)}`
// People glyph for the per-user Teams section (above Workspaces, managed mode).
const TEAM_ICON = html`<svg class="team-icon" viewBox="0 0 16 16" width="13" height="13" fill="currentColor" aria-hidden="true"><path d="M5.5 8a2.25 2.25 0 1 0 0-4.5 2.25 2.25 0 0 0 0 4.5Zm0 1C3.2 9 1.75 10.2 1.75 11.6V13h7.5v-1.4C9.25 10.2 7.8 9 5.5 9Zm5.25-1a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm.25 1c-.43 0-.83.05-1.2.15.86.62 1.45 1.5 1.45 2.45V13h3.25v-1.3C14.5 10.1 13.15 9 11 9Z"/></svg>`
// Download glyph used by the per-workspace export button — a
// downward arrow over a tray. Sized to match the "+" affordance in
// the section header.
const WORKSPACE_EXPORT_ICON = html`<svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2v8M5 7l3 3 3-3M3 13h10"/></svg>`
// Door-with-arrow glyph for the per-workspace Leave button —
// reads as "step out", distinct from a trash bin (which is
// reserved for the report / bundle delete affordances elsewhere
// in the chrome — the sidebar's "Delete current" report button
// and the bundles row's "Delete", both inlined separately to
// avoid a cross-file icon dependency).
const WORKSPACE_LEAVE_ICON = html`<svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 3H4v10h5"/><path d="M7 8h7M11 5l3 3-3 3"/></svg>`
// Chain-link glyph for the "Share by link" affordance — two
// interlocking link-loops, distinct from the download tray icon
// (export) and the door-arrow (leave). Sized to match the other
// hover-revealed action buttons in the workspace row.
const WORKSPACE_SHARE_ICON = html`<svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 9.5L9 7.5"/><path d="M9.5 5.5L10.5 4.5a2.1 2.1 0 1 1 3 3l-1 1"/><path d="M6.5 11.5L5.5 12.5a2.1 2.1 0 1 1-3-3l1-1"/></svg>`
function workspaceItemTemplate(w, { app, compact, reports, bundles, showReports, showBundles }) {
  const isCurrent = state.currentWorkspace === w.id
    && (state.currentView === 'findings' || state.currentView === 'files')
  const cls = `file-item workspace-item${isCurrent ? ' current' : ''}`
  // Clicking the main button loads every report in the workspace
  // into a single merged view (the `.file-item` click delegate
  // against dataset.workspaceId).
  // `.file-label` uses a `.textContent` property binding, NOT a child
  // interpolation: the dblclick inline-rename handler (below) clears
  // `labelSpan.textContent` and appends an <input>. A child
  // interpolation emits Lit marker comments around the text; clearing
  // textContent wipes them, and the next renderSidebar (always runs on
  // rename commit/cancel) then crashes inside Lit's `_commitText`. The
  // property binding leaves no markers inside the span. The rename
  // handler restores the label explicitly: Lit skips an unchanged
  // property value when the edit is cancelled or the name is rejected.
  // Hover-revealed actions, in row order: Share by link, Export
  // (download .gz bundle), then Leave (drop the workspace from THIS
  // browser — entry, OPFS reports, persisted triage base — without
  // touching the server's chain, so peers and your other devices keep
  // their copy). No placeholder trash icon for the eventual
  // server-side "delete the chain too" (TBD): it would misread as
  // "Delete is the same action as Leave, just greyed out".
  return html`<li class=${cls} data-workspace-id=${w.id}>
    <div class="workspace-heading">
      <button type="button" class="file-name">${WORKSPACE_ICON}<span class="file-label" .textContent=${w.name}></span></button>
      <button type="button" class="workspace-share" data-action="share-workspace" data-tooltip="Share by link" aria-label="Share workspace by link">${WORKSPACE_SHARE_ICON}</button>
      <button type="button" class="workspace-export" data-action="export-workspace" data-tooltip="Export workspace" aria-label="Export workspace">${WORKSPACE_EXPORT_ICON}</button>
      <button type="button" class="workspace-leave" data-action="leave-workspace" data-tooltip="Leave workspace" aria-label="Leave workspace">${WORKSPACE_LEAVE_ICON}</button>
    </div>
    ${compact ? html`<div class="workspace-meta">
      ${app?.appMode ? html`<span class="workspace-findings">${app.appFindings.toLocaleString()} finding${app.appFindings === 1 ? '' : 's'}</span>` : nothing}
      <span class="workspace-sections" role="group" aria-label="Workspace files">
        <button type="button" data-workspace-section="reports" aria-expanded=${String(showReports)} ?disabled=${searchActive}>${reports.toLocaleString()} report${reports === 1 ? '' : 's'}</button>
        ${bundles > 0 ? html`<button type="button" data-workspace-section="bundles" aria-expanded=${String(showBundles)} ?disabled=${searchActive}>${bundles.toLocaleString()} bundle${bundles === 1 ? '' : 's'}</button>` : nothing}
      </span>
    </div>` : nothing}
  </li>`
}

function matchesSearch(name) {
  if (!searchQuery) return true
  return displayName(name).toLowerCase().includes(searchQuery)
}

// Alphabetical comparator for report names, keyed on the visible label
// (displayName) rather than the raw OPFS name — the codex bucket's
// on-disk name differs from the row text, and matchesSearch already
// keys off displayName, so ordering matches what the user reads. Plain
// localeCompare mirrors the sort helpers elsewhere in the view.
const byReportName = (a, b) => displayName(a).localeCompare(displayName(b))

// Render the OPFS file list into the sidebar. Highlights the active
// file / workspace / bundle row. (The Delete-current button's disabled
// state is owned by `<sidebar-delete-current>`'s own autorun, and the
// sidebar is always shown — see below.) Section headers render for every
// non-empty bucket (including the default Reports group) so the
// vocabulary stays consistent across mixed-format collections. Called
// after every state transition that could change the file list, the
// current selection, or the search query.
export async function renderSidebar({ revealSelection = false } = {}) {
  await ensureClientMode()
  const modeAtStart = clientModeLabel()
  updateManagedLanding({ serverMode: modeAtStart, session: state.managedSession, teams: state.managedTeams })
  refreshScanNavigation()
  if (isManagedUiMode()) {
    state.bundles = []
    state.storedFiles = []
    renderLandingWorkspaces([])
    if (!root) return
    litRender(html`${teamsSectionTemplate()}`, fileList)
    root.querySelector('sidebar-view-button[kind="packages"]')?.setAttribute('hidden', '')
    root.querySelector('sidebar-view-button[kind="repositories"]')?.setAttribute('hidden', '')
    root.querySelector('#storage-status')?.setAttribute('hidden', '')
    renderSyncStatus()
    return
  }
  root?.querySelector('sidebar-view-button[kind="packages"]')?.removeAttribute('hidden')
  root?.querySelector('sidebar-view-button[kind="repositories"]')?.removeAttribute('hidden')
  // One-shot migration of `.deepseek` OPFS entries back to `.md`
  // (relic of an earlier build). Cached after the first call so
  // subsequent renders are a no-op; awaiting before listFiles makes
  // sure the listing reflects the post-rename state.
  await migrateLegacyFilenames()
  if (modeAtStart !== clientModeLabel()) {
    await renderSidebar()
    return
  }
  // Kick the OPFS-wide finding index so the Packages count + page
  // populate in the background without needing the user to open a
  // bundle first. Idempotent — concurrent calls share the same
  // in-flight promise; subsequent calls walk listFiles again to
  // pick up any newly-dropped reports.
  ensureBundleFindingsIndexed().catch(() => {})
  // Same deal for the links index, and the same reason to kick it
  // here rather than from a view: a finding's "Duplicates:" row is
  // painted by the findings surfaces, which know nothing about links
  // files, so the index has to be filling before the user opens one.
  ensureLinkedFindingsIndexed().catch(() => {})
  const names = await listFiles()
  if (modeAtStart !== clientModeLabel()) {
    await renderSidebar()
    return
  }
  const workspaces = listWorkspaces()
  revealFocusedWorkspaceSection(workspaces, revealSelection)
  renderLandingWorkspaces(workspaces)
  // A report may be moved into a new workspace without being reopened.
  // Prime parent hints here too, so its next copied link is complete.
  const [bundleNames] = await Promise.all([
    listBundles(),
    ...workspaces.map((w) => computeLinkHint('workspace', w.id)),
  ])
  if (modeAtStart !== clientModeLabel()) {
    await renderSidebar()
    return
  }
  // Stash the bundles list on state so the main view's bundles
  // branch (in render.js) can paint synchronously without redoing
  // the OPFS scan. Updated on every sidebar render — drops, deletes,
  // and switchToFile all refresh through here.
  state.bundles = bundleNames
  // Same for the report-directory listing: the sync badge asks which
  // of a workspace's members are on this device (view/sync-scope.js)
  // while painting, and can't await an OPFS scan to find out.
  state.storedFiles = names
  // Keep the storage-status line's usage number roughly in step with
  // whatever mutation triggered this repaint (drops, deletes, bundle
  // ops, sync downloads). Debounced inside the module; no-op before
  // mount.
  scheduleStorageStatusRefresh()
  // Pre-mount calls (boot ordering: view.js's `renderSidebar()`
  // can fire before the `<app-sidebar>` element's first shadow
  // render) still need the `state.bundles` side-effect above, but
  // there's no shadow DOM to paint into yet. Bail before the DOM
  // work — `firstUpdated` re-invokes `renderSidebar()` once mounted.
  if (!root) return
  // The sidebar always shows now — Workspaces is a first-class feature
  // and its "+" button must be reachable on first launch (before any
  // report or workspace exists). The drop zone still owns the welcome
  // copy in main; the sidebar just exposes the create-workspace
  // affordance alongside.

  // Reports already claimed by a workspace render INSIDE that workspace
  // and are dropped from the default buckets. A workspace reference to a
  // report not present in OPFS no longer vanishes silently — it renders
  // as a muted "missing" row inside the workspace (see
  // `missingReportItemTemplate` in the render loop below), mirroring how
  // missing bundles surface. The reference still round-trips in the JSON
  // until a setReportWorkspace call rewrites the list.
  const nameSet = new Set(names)
  const claimed = new Set()
  for (const w of workspaces) {
    for (const r of w.reports) if (nameSet.has(r)) claimed.add(r)
  }
  // Same treatment for bundles — workspace-claimed integrities render
  // inside the workspace and drop out of the top-level Bundles list.
  // The bundle metadata `_meta.json` is the source of truth for which
  // integrities exist on disk; references to bundles that were deleted
  // out from under the workspace stay in the JSON until the next
  // setBundleWorkspace call prunes them, but never render here.
  // `listWorkspaces()` backfills `bundles` to [] for any legacy entry,
  // so the loop below can iterate without a defensive `?? []` guard.
  const bundleByIntegrity = new Map(bundleNames.map((b) => [b.integrity, b]))
  const claimedBundles = new Set()
  for (const w of workspaces) {
    for (const integ of w.bundles) {
      if (bundleByIntegrity.has(integ)) claimedBundles.add(integ)
    }
  }

  // Bucket by group, applying the search filter as we go so empty
  // post-filter groups skip their header entirely.
  const buckets = new Map()
  for (const g of GROUP_ORDER) buckets.set(g, [])
  for (const n of names) {
    if (claimed.has(n)) continue
    if (!matchesSearch(n)) continue
    const g = groupOf(n)
    if (!buckets.has(g)) buckets.set(g, [])
    buckets.get(g).push(n)
  }

  // Workspaces above Reports. The header itself is filtered by name;
  // each workspace's own reports + bundles are filtered too so a name
  // search surfaces matches inside workspaces without the parent
  // disappearing. Missing-bundle pointers have no name to match against,
  // so they don't satisfy a search query — a workspace with only
  // missing bundles disappears under search (recoverable by clearing
  // the query).
  const visibleWorkspaces = workspaces.filter((w) => {
    if (!searchQuery) return true
    if (w.name.toLowerCase().includes(searchQuery)) return true
    // Match present AND missing reports — both keep their filename, so a
    // search query can surface a workspace whose only match is a report
    // that's referenced but not on this device.
    if (w.reports.some((r) => matchesSearch(r))) return true
    return w.bundles.some((integ) => {
      const b = bundleByIntegrity.get(integ)
      return b && matchesSearch(b.name)
    })
  })

  // Default buckets — render unfiled reports under their format header.
  // The Reports (default JSON) header is also a drop target for "remove
  // from workspace": dropping a workspace-internal report there detaches
  // it back to the unfiled list. The visibility of an empty Reports
  // header is gated on `isDraggingReport` (declared at top of file)
  // inside the GROUP_ORDER loop below — so the drop target reappears
  // exactly when the user is mid-drag, and stays out of the way
  // otherwise.

  // The Bundles section is an always-expanded category that hosts
  // every bundle not claimed by a workspace — workspace-claimed ones
  // render under the workspace, matching how reports work. Filter by
  // search query so a name search narrows the visible list (same
  // treatment unfiled reports get at the GROUP_ORDER loop below). The
  // header is gated on `unfiledBundles.length > 0 || isDraggingBundle`
  // (mirrors how the Reports default header gates on
  // `isDraggingReport`) so it stays visible exactly when there's
  // something to host AND reappears mid-drag as the detach drop target
  // even if no unfiled bundle exists right now. Renders at the end of
  // the sidebar, below the report groups.
  const unfiledBundles = bundleNames.filter(
    (b) => !claimedBundles.has(b.integrity) && matchesSearch(b.name),
  )
  litRender(html`
    ${teamsSectionTemplate()}
    ${isManagedUiMode() && workspaces.length === 0 ? nothing : workspaceHeaderTemplate()}
    ${repeat(visibleWorkspaces, (w) => w.id, (w) => {
      // Reports split into present vs missing, mirroring the bundle
      // split below:
      //   - present: the name resolves to an OPFS file → normal row
      //   - missing: claimed by the workspace but no bytes locally
      //              (eviction with no cloud copy, or an imported
      //              workspace referencing a report nobody re-shared)
      //              → muted row so the reference is visible instead of
      //              silently dropped.
      // Unlike missing bundles (which have no name and so can't be
      // matched by a search query), a missing report keeps its filename,
      // so the search filter applies to both buckets uniformly.
      const presentReports = []
      const missingReports = []
      for (const r of w.reports) {
        if (!matchesSearch(r)) continue
        if (nameSet.has(r)) presentReports.push(r)
        else missingReports.push(r)
      }
      // Order each report group alphabetically; bundles stay below,
      // rendered from their own (unsorted) arrays further down.
      presentReports.sort(byReportName)
      missingReports.sort(byReportName)
      // Resolve bundle integrities to their metadata + filter by search.
      // Bundles split into two render paths:
      //   - present:  the integrity matches an OPFS bundle → normal row
      //   - missing:  the integrity is referenced but no bytes locally
      //               (typically an imported workspace from another
      //               device) → muted row so the user sees what's
      //               unresolved instead of silently dropping it.
      // Both bypass the search filter unless a query is active — a
      // search query hides missing rows (no name to match against).
      const presentBundles = []
      const missingBundles = []
      for (const integ of w.bundles) {
        const b = bundleByIntegrity.get(integ)
        if (b) {
          if (!searchQuery || matchesSearch(b.name)) presentBundles.push(b)
        } else if (!searchQuery) {
          missingBundles.push(integ)
        }
      }
      const app = getLoadedWorkspaceAppMetadata(w) ?? getWorkspaceAppMetadata(w)
      const compact = app?.appMode ?? (getWorkspaceAppModeHint(w) === true)
      const sections = expandedWorkspaceSections.get(w.id)
      const showReports = !compact || searchActive || sections?.has('reports') === true
      const showBundles = !compact || searchActive || sections?.has('bundles') === true
      // Link files remain in the Reports section but do not count as reports.
      // The arrays above already apply the sidebar query, so search counts
      // describe exactly the matching children, including missing reports.
      const reports = [...presentReports, ...missingReports].filter(name => getKind(name) !== LINKS_KIND).length
      const bundles = presentBundles.length + missingBundles.length
      return html`
        ${workspaceItemTemplate(w, { app, compact, reports, bundles, showReports, showBundles })}
        ${showReports ? html`${presentReports.map((r) => fileItemTemplate(r, { indented: true, workspaceId: w.id }))}${missingReports.map((r) => missingReportItemTemplate(r, w.id))}` : nothing}
        ${showBundles ? html`${presentBundles.map((b) => bundleItemTemplate(b, { workspaceId: w.id }))}${missingBundles.map((integ) => missingBundleItemTemplate(integ, w.id))}` : nothing}
      `
    })}
    ${GROUP_ORDER.map((g) => {
      // Within each type bucket, list reports alphabetically; the
      // GROUP_ORDER loop preserves the by-type grouping itself.
      const list = (buckets.get(g) ?? []).toSorted(byReportName)
      const isDefault = g === 'default'
      if (list.length === 0 && !(isDefault && isDraggingReport)) return null
      return html`
        ${groupHeaderTemplate(GROUP_LABELS[g] ?? g, { dropTarget: isDefault })}
        ${list.map((n) => fileItemTemplate(n))}
      `
    })}
    ${unfiledBundles.length > 0 || isDraggingBundle ? bundlesHeaderTemplate() : null}
    ${repeat(unfiledBundles, (b) => b.integrity, (b) => bundleItemTemplate(b))}
  `, fileList)

  // Packages + Repositories navigation buttons live to the right of
  // the sidebar search input. Both are `<sidebar-view-button>`
  // StateElements that read `state.currentView` themselves for the
  // `.active` highlight; the cross-report counts aren't observable
  // (the per-bundle finding index lives in a module-internal Map),
  // so we push them as properties here on every sidebar render.
  // The component renders `nothing` when count === 0, so an empty
  // index hides the button automatically.
  const pkgBtn = root.querySelector('sidebar-view-button[kind="packages"]')
  if (pkgBtn) pkgBtn.count = countLoadedPackages()
  const repoBtn = root.querySelector('sidebar-view-button[kind="repositories"]')
  if (repoBtn) repoBtn.count = countLoadedRepositories()

  // `<sidebar-delete-current>` reads `state.currentFile` /
  // `state.selectedBundle` / `state.currentView` itself via its
  // autorun and disables when neither artifact is in play — no
  // imperative update needed here.

  // Sync button visibility tracks workspace state (non-empty
  // workspaces) — re-evaluate on every sidebar render so adding
  // the first report into a workspace, or emptying the last one,
  // toggles it correctly without waiting for a sync-status event.
  renderSyncStatus()

  // Lazy-fill counts for any pre-existing OPFS entries that don't
  // have one cached yet. Re-renders incrementally as each lands so
  // the user sees badges populate progressively rather than waiting
  // for the whole batch. Fire-and-forget — the awaited path here
  // would block initial render for as long as the slowest file's
  // parse takes.
  ensureCounts(names, scheduleCountsRepaint)
}

// Repaint for a batch of landed counts, not for each one.
//
// A cold counts cache — a new device, a big import, a counts-version
// bump — fills one file at a time, and this callback fired per file.
// Each of those was a whole `renderSidebar`: a fresh OPFS directory
// enumeration, a workspaces read, a full re-render of every row, and a
// kick of both background index walks. On a library of any size that
// is a self-inflicted storm on the one thread that also has to paint,
// and it ran for as long as the refill took — which is exactly when
// the app most needs to stay responsive.
//
// A frame is the right granularity: the badges still appear to stream
// in (nobody can see more than one repaint per frame anyway), and the
// work per landed count drops to appending to a Set.
let countsRepaintQueued = false
function scheduleCountsRepaint() {
  if (countsRepaintQueued) return
  countsRepaintQueued = true
  requestAnimationFrame(() => {
    countsRepaintQueued = false
    renderSidebar().catch((err) => console.warn('counts repaint:', err))
  })
}

// Re-render the sidebar whenever the passkey vault state flips so
// the encryption row reflects the live state (enable → unlock → lock
// transitions) without waiting for an unrelated event to trigger a
// render. Wired here rather than in view.js because view.js already
// invokes the main `render()` on vault changes — this hook covers
// the sidebar's own template too.
onVaultStateChange(() => { renderSidebar() })
onWorkspaceAppMetadataChanged(scheduleCountsRepaint)

// Sidebar event delegation: file-list click switches; Delete removes
// the current file; toggle collapses / expands; search filters on
// input. The workspace "+" button intercepts BEFORE the file-row
// match because a workspace header is itself a `<li>` that contains
// no `data-file` — but the add button still bubbles to the same
// listener.
async function onSidebarClick(e) {
  const sectionButton = e.target.closest('[data-workspace-section]')
  if (sectionButton) {
    if (searchActive || sectionButton.disabled) return
    const id = sectionButton.closest('[data-workspace-id]')?.dataset.workspaceId
    if (!id) return
    const section = sectionButton.dataset.workspaceSection
    const expanded = expandedWorkspaceSections.get(id) ?? new Set()
    if (expanded.has(section)) expanded.delete(section)
    else expanded.add(section)
    expandedWorkspaceSections.set(id, expanded)
    await renderSidebar()
    return
  }
  if (e.target.closest('[data-action="toggle-client-mode"]')) {
    if (forcedManagedReturn) await restoreForcedManagedMode()
    else if (toggleClientMode()) {
      await finishClientModeTransition()
    }
    return
  }
  // DeepView brand → drop back to the empty welcome screen so the
  // user can re-read the supported-formats list (or just start
  // over). Non-destructive — `goHome` only clears in-memory
  // selection + secure-storage's last-file pointer; OPFS files
  // and triage stay intact.
  if (e.target.closest('[data-action="go-home"]')) {
    await goHome()
    return
  }
  // Per-bundle row in the expanded Bundles section — selects that
  // bundle and switches to the bundles view. `selectBundle` is the
  // same full bundle switch the `bundle-swap` listener in events.js,
  // the bundle-only drop branch in ingest.js, and the boot restore in
  // view.js perform (per-row setup must clear the prior load's parsed
  // details and search boxes while keeping the current bundle detail tab).
  const bundleEl = e.target.closest('.file-item[data-bundle-integrity]')
  if (bundleEl) {
    // Missing-bundle rows (imported workspace claims an integrity the
    // recipient doesn't have locally) are advertised as non-interactive
    // via muted italic styling + `cursor: help`. Without this gate,
    // clicking flipped the view to bundles and set `state.selectedBundle`
    // to the missing integrity — `openBundle` then silently returned
    // (no matching entry in state.bundles), leaving the user on the
    // bundles list with a phantom selection and no panel content.
    if (bundleEl.classList.contains('bundle-missing')) return
    const integrity = bundleEl.dataset.bundleIntegrity
    if (state.selectedBundle === integrity && state.currentView === 'bundles') return
    selectBundle(integrity)
    persistLastBundle(integrity, state.bundleDetailsTab)
    render()
    renderSidebar()
    openBundle(integrity)
    return
  }
  // `<sidebar-view-button>` clicks bubble through the host as
  // native click events — read the `kind` attribute from the host
  // to route to the matching `state.currentView` mutation. Same
  // closest()-based routing pattern the rest of this delegate uses.
  const viewBtn = e.target.closest('sidebar-view-button')
  if (viewBtn) {
    const kind = viewBtn.getAttribute('kind')
    if (kind === 'packages' || kind === 'repositories') {
      state.currentView = kind
      render()
      renderSidebar()
    }
    return
  }
  if (e.target.closest('[data-action="new-workspace"]')) {
    if (isManagedUiMode()) return
    const name = await openNewWorkspaceDialog()
    if (name) {
      // First-use prompt fires here too (not just on file drop) so
      // a user who starts by setting up a workspace gets the same
      // encryption opt-in before the workspace's private key lands
      // on disk. Same idempotent flag as the drop path; the prompt
      // only fires once.
      await maybePromptFirstUse()
      await createWorkspace(name)
      renderSidebar()
    }
    return
  }
  // Per-workspace share-by-link — open the share dialog with the
  // workspace's current name as the prompt default + its 32-byte
  // private key as the to-encrypt secret. Listed before the export /
  // workspace / file row handlers because the share button lives
  // inside the workspace li and we don't want a stray click to fall
  // through to the workspace switcher.
  const shareEl = e.target.closest('[data-action="share-workspace"]')
  if (shareEl) {
    const wsEl = shareEl.closest('[data-workspace-id]')
    const ws = wsEl ? listWorkspaces().find((w) => w.id === wsEl.dataset.workspaceId) : null
    if (ws) {
      // The dialog handles its own internal errors inline (the
      // `_error` state slot); the returned promise rejects only on
      // stacked-modal failure, which `.catch` surfaces.
      openWorkspaceShareLinkDialog({ id: ws.id, name: ws.name, privateKeyBase64: ws.privateKey })
        .catch((err) => alert(`Failed to open share dialog: ${err.message}`))
    }
    return
  }
  // Per-workspace export — find the enclosing workspace li, look the
  // workspace up, hand it to exportWorkspace. Listed before the
  // workspace / file row handlers below because the export button
  // lives inside the workspace li and we don't want a stray click to
  // fall through to the workspace switcher.
  const exportEl = e.target.closest('[data-action="export-workspace"]')
  if (exportEl) {
    const wsEl = exportEl.closest('[data-workspace-id]')
    const ws = wsEl ? listWorkspaces().find((w) => w.id === wsEl.dataset.workspaceId) : null
    if (ws) exportWorkspace(ws).catch((err) => alert(`Failed to open export dialog: ${err.message}`))
    return
  }
  // Per-workspace Leave — open the confirmation dialog (which
  // surfaces a detach-vs-delete choice when reports are
  // attached, plus a triage keep-vs-wipe choice when orphans
  // would result), then hand off to the leave pipeline. Listed
  // before the workspace row handler so a click on the leave
  // glyph doesn't double as "open the workspace" while the
  // confirmation is open. `analyzeTriageImpact` is computed
  // up front so the dialog can render the appropriate triage
  // section synchronously on open (it parses every kept-side
  // OPFS file on first hit, but short-circuits when no
  // persisted triage exists or none lives on the workspace's
  // reports).
  const leaveEl = e.target.closest('[data-action="leave-workspace"]')
  if (leaveEl) {
    const wsEl = leaveEl.closest('[data-workspace-id]')
    const ws = wsEl ? listWorkspaces().find((w) => w.id === wsEl.dataset.workspaceId) : null
    if (!ws) return
    const reports = Array.isArray(ws.reports) ? ws.reports : []
    let triageImpact
    try {
      triageImpact = await analyzeTriageImpact(reports)
    } catch (err) {
      // `analyzeTriageImpact` propagates OPFS errors rather than
      // treating every overlap as orphaned. Refuse to open the dialog
      // instead of showing a wrong "wipe N orphans" count — the user
      // can retry once OPFS settles.
      alert(`Couldn't read reports to analyze triage impact: ${err.message}`)
      return
    }
    const { confirmed, mode, triage } = await openLeaveWorkspaceDialog({
      name: ws.name,
      reportCount: reports.length,
      bundleCount: ws.bundles.length,
      triageImpact,
    })
    if (!confirmed) return
    // A sibling tab may have deleted the workspace while our dialog
    // was open. The cached `ws` is the snapshot we showed the user;
    // re-resolve against the live blob and surface "already gone"
    // rather than silently no-op'ing inside `leaveWorkspace`.
    if (!listWorkspaces().some((w) => w.id === ws.id)) {
      alert(`Workspace "${ws.name}" was removed elsewhere; nothing to leave.`)
      return
    }
    try { await leaveWorkspace(ws.id, mode, { triage }) }
    catch (err) { alert(`Failed to leave workspace: ${err.message}`) }
    return
  }
  // Workspace row — clicking the name button (or anywhere on the
  // workspace row that isn't an action button) loads every report
  // in the workspace as a merged view. The dblclick handler
  // intercepts before this fires for inline rename.
  const wsRow = e.target.closest('.file-item.workspace-item[data-workspace-id]')
  if (wsRow) {
    const id = wsRow.dataset.workspaceId
    // Re-run when the user clicks the SAME workspace but is on a
    // different view (Bundles / Packages) — the click should drop
    // them back into the findings view for that workspace, mirroring
    // the file-row check below.
    const onFindings = state.currentView === 'findings' || state.currentView === 'files'
    if (id && (id !== state.currentWorkspace || !onFindings)) switchToWorkspace(id)
    return
  }
  const fileEl = e.target.closest('.file-item[data-file]')
  if (fileEl) {
    const name = fileEl.dataset.file
    // Re-run switchToFile when the user clicks the SAME file but
    // is currently on a different view (Bundles / Files header) —
    // the click should drop them back into the findings view for
    // that report. Without the currentView check we'd noop and
    // strand the user on the bundles view.
    //
    // 'links' counts as "already showing this file" alongside
    // 'findings': it IS the view of the clicked row when the row is a
    // links file, so re-clicking it should no-op the way re-clicking
    // an open report does, not re-read and repaint.
    const showingFile = state.currentView === 'findings' || state.currentView === 'links'
    const workspaceId = fileEl.dataset.workspaceId ?? null
    if (name && (name !== state.currentFile || workspaceId !== state.currentReportWorkspace || !showingFile)) {
      switchToFile(name, undefined, { workspaceId })
    }
    return
  }
  if (e.target.closest('sidebar-delete-current')) {
    // Bundle path first: the bundles view's selected bundle takes
    // precedence over `state.currentFile` (a stale report selection
    // can survive a view switch). The button is disabled when
    // neither is in play, but the closest() match could still fire
    // on a synthesized event.
    if (state.currentView === 'bundles' && state.selectedBundle) {
      const integrity = state.selectedBundle
      const friendly = (state.bundles ?? []).find((b) => b.integrity === integrity)?.name ?? integrity
      // A bundle can be claimed by multiple workspaces (content-
      // addressed, so the same integrity may be attached to N
      // workspaces). Walk the membership list and ask each owning
      // workspace's presence layer whether it has the bundle in
      // remote — `isBundleInRemoteOrCached` consults BOTH the live
      // session AND the persisted presence cache, so workspaces
      // whose session isn't currently open (sync disabled, never
      // navigated to, mid-boot) still get picked up. Without the
      // cache fallback the closed workspaces' remote tags would
      // survive the delete and resurrect on the next open via
      // `ensureRemoteNames`' membership-aware fallthrough.
      const remoteWorkspaceIds = listWorkspaces()
        .filter((w) => Array.isArray(w.bundles) && w.bundles.includes(integrity))
        .filter((w) => isBundleInRemoteOrCached(w.id, integrity))
        .map((w) => w.id)
      const { confirmed } = await openDeleteBundleDialog({
        name: friendly,
        inRemote: remoteWorkspaceIds.length > 0,
      })
      if (!confirmed) return
      // The selection may have changed under us (cross-tab switch,
      // sibling-tab delete) while the dialog was open. Bail rather
      // than dropping whatever bundle just slid into place — the
      // user confirmed deletion of the bundle shown in the dialog.
      if (state.selectedBundle !== integrity) {
        alert(`Active bundle changed during confirmation; aborting delete of "${friendly}".`)
        return
      }
      try {
        await deleteCurrentBundle({ deleteFromRemoteWorkspaceIds: remoteWorkspaceIds })
      } catch (err) { alert(`Failed to delete bundle: ${err.message}`) }
      return
    }
    // No active file → nothing to delete; the button is also
    // disabled at render time, but the closest() match could
    // still fire on a synthesized event.
    if (!state.currentFile) return
    const name = state.currentFile
    // Precompute triage impact for THIS report so the dialog's
    // triage section renders synchronously on open. We open the
    // dialog unconditionally — even with no triage attached —
    // so destructive action always goes through an explicit
    // Cancel/Delete prompt.
    let triageImpact
    try {
      triageImpact = await analyzeTriageImpact([name])
    } catch (err) {
      // A transient OPFS error must not silently mis-classify
      // orphans — refuse to open the dialog and let the user retry.
      alert(`Couldn't read reports to analyze triage impact: ${err.message}`)
      return
    }
    // Workspace + remote presence for the deletion dialog. A
    // report can be a member of multiple workspaces (additive add
    // via drag-into-workspace); fan the remote-delete out to every
    // owning workspace whose remote actually holds the report.
    // `isInRemoteOrCached` checks both the live session AND the
    // persisted cache, so closed / mid-boot workspaces are still
    // included — without that fallback their remote tag survives
    // the delete and resurrects on the next open via
    // `ensureRemoteNames`' membership-aware fallthrough.
    const remoteWorkspaceIds = listWorkspaces()
      .filter((w) => Array.isArray(w.reports) && w.reports.includes(name))
      .filter((w) => isInRemoteOrCached(w.id, name))
      .map((w) => w.id)
    const inRemote = remoteWorkspaceIds.length > 0
    // A links file is deleted through the same button and the same
    // dialog, but it is not a report — name it for what it is so the
    // prompt doesn't claim the user is about to lose findings.
    const kindLabel = isLinksFile(name) ? 'links file' : 'report'
    const { confirmed, triage } = await openDeleteReportDialog({ name, kindLabel, triageImpact, inRemote })
    if (!confirmed) return
    // The active file may have changed under us (cross-tab switch /
    // sibling-tab delete) while the dialog was open. Bail rather than
    // deleting whatever's current now — the user confirmed deletion of
    // the file shown in the dialog, not whatever just slid into place.
    if (state.currentFile !== name) {
      alert(`Active file changed during confirmation; aborting delete of "${name}".`)
      return
    }
    try { await deleteCurrent({ triage, deleteFromRemoteWorkspaceIds: remoteWorkspaceIds }) }
    catch (err) { alert(`Failed to delete ${kindLabel}: ${err.message}`) }
    return
  }
  if (e.target.closest('#sync-status')) {
    // Click toggles the persisted user-enabled flag rather than
    // the URL itself — disable then re-enable should resume against
    // the same endpoint, not lose a console-set URL. If no URL is
    // configured yet, prime it with the per-origin default (see
    // `DEFAULT_SYNC_URL` above for the resolution rules).
    if (triageSync.status === 'error') {
      // Distinct affordance: "I see the error, retry" — clears
      // every session's error + failure-counter and kicks the
      // subscribe / save round-trip again. Stays enabled.
      triageSync.dismissError()
    } else if (triageSync.status === 'off') {
      if (!triageSync.getServerUrl() && DEFAULT_SYNC_URL) {
        triageSync.setServerUrl(DEFAULT_SYNC_URL)
      }
      triageSync.setEnabled(true)
    } else {
      triageSync.setEnabled(false)
    }
    return
  }
  // Admin/manage rows in the account menu — close the popover, then
  // navigate (lazily loading the admin bundle that defines the page's
  // element; see ADMIN_PAGES).
  for (const view of Object.keys(ADMIN_PAGES)) {
    if (e.target.closest(`[data-action="${view}"]`)) {
      root?.querySelector('#user-menu')?.hidePopover?.()
      void navigateToAdminPage(view)
      return
    }
  }
  if (e.target.closest('[data-action="managed-logout"]')) {
    // Logout row inside the account menu — clears the server session (with the
    // double-submit CSRF token) then reloads so the app re-probes logged-out.
    void managedLogout(state.managedSession?.csrfToken)
    return
  }
  if (e.target.closest('#sidebar-toggle')) {
    if (isManagedUiMode()) return
    hostEl.classList.toggle('collapsed')
    try { localStorage.setItem('deepview.sidebarCollapsed', hostEl.classList.contains('collapsed') ? '1' : '0') } catch {}
  }
}

// Sidebar tooltip wiring — same styled tooltip element the rest of
// the app uses (via `view/tooltip.js`). The mouseover listener
// lives inside the shadow root (events don't reach the document-
// level global handler with their original target across the shadow
// boundary), so `mount()` attaches the shared scoped listener
// (`installShadowTooltipListener`) to the shadow root with the
// options below. Root-wide rather than `#file-list`-scoped because
// the search row's `<sidebar-view-button>`s carry tooltips too, and
// they sit outside the list; the gate is a no-op for any node without
// a `.file-label`, so file rows behave exactly as they did when the
// listener hung off the list.
//
// Gate: when the tooltip text is just the label text (the common
// case for short report filenames), suppress the tooltip when the
// label actually fits its slot — non-truncated rows stay quiet.
// When the tooltip carries MORE than the label (e.g. bundle rows
// where the tooltip is `name\nintegrity`), show on hover regardless
// of truncation so the integrity stays discoverable.
const SIDEBAR_TOOLTIP_OPTIONS = {
  // Sidebar rows sit on the left edge of the viewport, so anchor
  // the tooltip to the row's right side (vertically centered).
  // The default cursor-anchored placement is for in-column lists
  // in the main pane.
  placement: 'right',
  gate: (node) => {
    const label = node.querySelector('.file-label')
    if (!label) return true
    const tipText = node.dataset.tooltip ?? ''
    // Tooltip differs from label → always show.
    if (tipText !== label.textContent) return true
    // Tooltip is the label text → only show when truncated.
    return label.scrollWidth > label.clientWidth
  },
}

function onSearchInput(e) {
  searchActive = e.target.value.length > 0
  searchQuery = e.target.value.trim().toLowerCase()
  renderSidebar()
}

// Sync-status button at the bottom of the sidebar. Reflects the
// triageSync status (`off` / `offline` / `online`) via a colored
// dot + label; click toggles sync on or off (see the click delegate
// above). Subscribes once at module load so the indicator follows
// every reconnect / setServerUrl change without polling.
//
// Visibility is gated on (a) at least one workspace existing
// — sync is a workspace concept, but it should be reachable for
// an empty workspace too (e.g. one freshly attached via a share
// link, before any reports are dropped in) so the user can see
// incoming triage from peers as it arrives — AND (b) a usable
// server URL existing, either because the user previously
// configured one or because the page's origin has a sensible
// default (see `DEFAULT_SYNC_URL` above for the resolution
// rules). When either condition fails the button is hidden so
// it doesn't read as a broken affordance.
const SYNC_LABELS = {
  off: 'Sync off',
  online: 'Online',
  offline: 'Offline',
  connecting: 'Connecting…',
  // `error` overrides everything else: a session has hit a
  // non-recoverable failure (typically a corrupt key — encrypt /
  // sign repeatedly threw, or the workspace's privateKey couldn't
  // be derived). Surfaces in the title with the per-session error
  // text; clicking the button is wired to `dismissError()` to
  // give the user an explicit retry.
  error: 'Sync error',
}

function syncButtonVisible() {
  const usableUrl = triageSync.getServerUrl() || DEFAULT_SYNC_URL
  if (!usableUrl) return false
  // Any workspace, with or without attached reports — gating on
  // reports.length > 0 would hide the button on a freshly-attached
  // share-link workspace and stop the user seeing the sender's triage
  // land before they'd added their own reports.
  return listWorkspaces().length > 0
}

// Managed account control. The landing page owns sign-in; the sidebar only
// shows the account menu once the managed session probe finds a session.
function renderAuthStatus() {
  const authBtn = root?.querySelector('#auth-status')
  if (!authBtn) return
  const manageBtn = root?.querySelector('#manage-status')
  const menu = root?.querySelector('#user-menu')
  const session = state.managedSession
  hostEl?.toggleAttribute('data-authenticated', session != null)
  authBtn.hidden = session == null
  if (session == null) {
    if (manageBtn) manageBtn.hidden = true
    authBtn.dataset.authed = '0'
    authBtn.removeAttribute('popovertarget')
    authBtn.removeAttribute('aria-label')
    litRender(nothing, authBtn)
    if (menu) litRender(nothing, menu)
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
  if (manageBtn) {
    const canManage = isManagedUiMode() && (session.role === 'admin' || session.role === 'manage')
    manageBtn.hidden = !canManage
  }
  if (menu) {
    litRender(html`
      <div class="user-card">
        ${avatarTemplate(initial, session.id, true)}
        <span class="user-id">
          <span class="user-login">${session.login}</span>
          ${session.name ? html`<span class="user-name">${session.name}</span>` : nothing}
        </span>
      </div>
      <button type="button" class="user-menu-row logout-row" data-action="managed-logout">${LOGOUT_ICON}<span>Log out</span></button>
    `, menu)
  }
}

// Avatar disc: the cached avatar (served same-origin from /api/avatar/<id>) over
// a fallback initial that shows when there's no avatar (the img 404s). The id in
// the path keys the browser cache per user — a fixed URL would serve the
// previous user's cached avatar (cache-control: private, max-age) after a switch.
function avatarTemplate(initial, userId, large = false) {
  const src = `/api/avatar/${encodeURIComponent(userId)}`
  return html`<span class=${large ? 'user-avatar user-avatar-lg' : 'user-avatar'}>
    <span class="user-avatar-fallback">${initial}</span>
    ${getPreviewRole() ? nothing : html`<img alt="" src=${src} @error=${onAvatarError}>`}
  </span>`
}

function onAvatarError(e) {
  // No cached avatar → hide the broken img so the initial fallback shows.
  e.currentTarget.classList.add('broken')
}

// Brand tag shows the live server mode (e2e / managed / standalone) in place of
// the old build label.
function renderBrandTag() {
  const tag = root?.querySelector('.brand-tag')
  if (tag) {
    const switchable = state.serverMode === 'managed' || isCombinedServerMode(state.serverModeConfig)
    tag.textContent = clientModeLabel()
    if (switchable) {
      tag.setAttribute('role', 'button')
      tag.setAttribute('tabindex', '0')
      tag.setAttribute('aria-label', `Switch from ${clientModeLabel()} mode`)
    } else {
      tag.removeAttribute('role')
      tag.removeAttribute('tabindex')
      tag.removeAttribute('aria-label')
    }
  }
}

// Managed mode pins the sidebar open — no collapse affordance (a fuller
// management surface lives here). The mode is mirrored onto the host so CSS can
// hide the collapse toggle.
function applyCollapsibility() {
  if (hostEl) hostEl.dataset.mode = clientModeLabel()
  if (isManagedUiMode()) {
    hostEl?.classList.remove('collapsed')
    // Managed workspaces do not own local artifacts or passkey encryption.
    // Keep the nodes mounted so switching to local can restore the full e2e
    // surface without rebuilding the sidebar component.
    root?.querySelector('sidebar-delete-current')?.setAttribute('hidden', '')
    root?.querySelector('#encryption-toggle')?.setAttribute('hidden', '')
    root?.querySelector('#auth-status')?.removeAttribute('hidden')
  } else {
    root?.querySelector('sidebar-delete-current')?.removeAttribute('hidden')
    root?.querySelector('#encryption-toggle')?.removeAttribute('hidden')
    root?.querySelector('#manage-status')?.setAttribute('hidden', '')
    root?.querySelector('#auth-status')?.setAttribute('hidden', '')
  }
  // Mode also drives the encryption toggle's visibility (managed data is
  // server-owned); refresh it here since mode isn't a vault-state event.
  refreshEncryptionToggle()
}

function renderSyncStatus(status) {
  const btn = root?.querySelector('#sync-status')
  if (!btn) return
  renderBrandTag()
  applyCollapsibility()
  if (state.serverMode === 'managed' && state.localMode) {
    btn.hidden = true
    triageSync.setForcedOff(true)
    const localAuthBtn = root?.querySelector('#auth-status')
    if (localAuthBtn) localAuthBtn.hidden = true
    return
  }
  // Managed mode replaces the offline/online toggle with login/logout (sync
  // is session-based there, not a user-toggled WS): hide the sync button,
  // pause the e2e sync layer, and paint the auth control instead.
  if (isManagedUiMode()) {
    btn.hidden = true
    triageSync.setForcedOff(true)
    renderAuthStatus()
    return
  }
  // Standalone (no backend / no /api/config): a purely local app — no workspace
  // sync, no online/offline toggle, no auth. Hide both controls.
  if (state.serverMode === 'standalone') {
    btn.hidden = true
    const standaloneAuthBtn = root?.querySelector('#auth-status')
    if (standaloneAuthBtn) standaloneAuthBtn.hidden = true
    return
  }
  const authBtn = root?.querySelector('#auth-status')
  if (authBtn) authBtn.hidden = true
  const visible = syncButtonVisible()
  // Don't kick e2e sync until the server mode is CONFIRMED (cached). On a cold
  // first visit `serverMode` defaults to 'e2e', but the server may be managed
  // or standalone — neither of which must ever pull the client-sync chunk. The
  // /api/config probe writes the cache (e2e/managed) before re-rendering, so a
  // returning visitor (cache present) is unaffected; only a first visit waits
  // one probe RTT. (managed/standalone return early above and never reach here.)
  const modeConfirmed = readCachedServerInfo() != null
  // Single trigger for the lazy `client-sync.js` chunk: sync is
  // worth loading only when the status button is visible (a usable
  // URL exists AND at least one workspace exists) AND the user
  // hasn't opted out. Boot does NOT pre-load — so a user with no
  // workspaces, or one who turned sync off, never downloads the
  // chunk. `loadSync` is idempotent (shares one in-flight promise),
  // so re-running on every sidebar render is cheap once kicked.
  if (visible && modeConfirmed && triageSync.isEnabled()) {
    loadSync().catch((err) => { console.warn('sync: load failed', err) })
  }
  // Auto-prime the default sync URL the first time any workspace
  // exists — workspaces opt the user into sync (unattached reports
  // stay local-only), so the offline → online flip shouldn't
  // require a separate sidebar click. Skipped when the user has
  // explicitly turned sync off via the status button (`isEnabled()`
  // reads the persisted toggle, default true) or when a custom URL
  // is already configured via the console API.
  if (visible && modeConfirmed && !triageSync.getServerUrl() && DEFAULT_SYNC_URL && triageSync.isEnabled()) {
    triageSync.setServerUrl(DEFAULT_SYNC_URL)
  }
  // Visibility doubles as an active gate: when the button can't
  // be seen, the sync layer should be paused (no socket, no
  // reconnect attempts) so a configured-but-unreachable session
  // doesn't keep ticking invisibly. Drives a runtime-only flag
  // — `setForcedOff` does NOT touch the saved URL or the
  // persisted user-enabled toggle, so the next time the button
  // becomes visible everything resumes against the same endpoint.
  triageSync.setForcedOff(!visible)
  if (!visible) {
    btn.hidden = true
    return
  }
  btn.hidden = false
  const s = status ?? triageSync.status
  btn.dataset.status = s
  // `persistenceDegraded` is orthogonal to the connection status — the
  // socket can be online while local writes are paused (a future-version
  // sessions blob, quota-exceeded, or a locked vault). Surface it as an
  // amber ring on the dot (visible even when collapsed) + a tooltip. The
  // off→on edge also raises a one-shot dialog; see the
  // onPersistenceDegraded subscription below.
  const degraded = triageSync.persistenceDegraded
  btn.toggleAttribute('data-degraded', degraded)
  // Auth-proxy redirect: reflected so the badge tooltip still explains
  // the stuck-offline cause after the one-shot dialog is dismissed.
  // Degraded takes tooltip precedence (it implies possible data loss);
  // proxy-auth is the next most actionable hint.
  const proxyAuth = triageSync.proxyAuthRequired
  btn.toggleAttribute('data-proxy-auth', proxyAuth)
  // Keep the label to the status word — the action row is tight (it
  // wraps). The amber ring + this tooltip carry the degraded signal in
  // the badge; the one-shot dialog explains it in full.
  // Empty means "no tooltip" — delete the attribute rather than
  // leaving an empty one, so the element stops matching
  // `[data-tooltip]` and the hover never schedules a no-op show.
  const syncTip = degraded
    ? 'Not saving to this browser right now (storage may be full, or another tab is on a newer version). Changes that haven’t synced could be lost on reload.'
    : proxyAuth
      ? 'Can’t reach the sync server — the connection is being redirected to a sign-in proxy (e.g. Cloudflare Access). Reload the page to sign in again.'
      : ''
  if (syncTip) btn.dataset.tooltip = syncTip
  else delete btn.dataset.tooltip
  const label = btn.querySelector('.sync-label')
  if (label) label.textContent = SYNC_LABELS[s] ?? ''
}
// `renderSyncStatus` no-ops until the shadow DOM exists (`root` is
// null pre-mount), so the subscription is safe to register at module
// load; the initial paint happens in `mount()`.
triageSync.onStatusChange(renderSyncStatus)
// Reflect the persistence-degraded latch on the badge, and show a
// one-shot explanatory dialog once per degraded episode. The latch
// fires once on subscribe with the current state and then on every
// transition; the client-sync passthrough defers this until the lazy
// sync chunk loads, so the first fire lands after mount.
//
// `shownThisEpisode` makes it one-shot (not re-shown on unrelated
// re-renders) and resets when the latch clears, so a fresh degradation
// re-notifies. If the dialog can't open because another modal is up
// (modal-conflict → resolves `{ shown: false }`), retry on a short
// delay while still degraded — otherwise the notice would be skipped
// for the whole episode (the amber badge still shows meanwhile).
let degradedDialogInFlight = false
let degradedShownThisEpisode = false
async function showDegradedDialogOnce() {
  if (!triageSync.persistenceDegraded || degradedShownThisEpisode || degradedDialogInFlight) return
  degradedDialogInFlight = true
  const { shown } = await openPersistenceDegradedDialog()
  degradedDialogInFlight = false
  if (shown) { degradedShownThisEpisode = true; return }
  // Couldn't show (another modal was open). Retry while still degraded.
  if (triageSync.persistenceDegraded) setTimeout(showDegradedDialogOnce, 1500)
}
triageSync.onPersistenceDegraded((degraded) => {
  renderSyncStatus()
  if (degraded) showDegradedDialogOnce()
  else degradedShownThisEpisode = false
})

// Auth-proxy (e.g. Cloudflare Access) detection: when triage-sync finds
// that reconnects are being redirected to a login proxy, raise a
// one-shot cancellable popup offering a page reload — the reload re-runs
// the proxy login and restores the session, after which sync resumes.
// One dialog per episode; the latch (and so the episode) clears when the
// connection recovers, per triage-sync's reconcileProxyAuthWatch. Same
// modal-conflict retry dance as the degraded dialog above.
let proxyAuthDialogInFlight = false
let proxyAuthShownThisEpisode = false
async function showProxyAuthDialogOnce() {
  if (!triageSync.proxyAuthRequired || proxyAuthShownThisEpisode || proxyAuthDialogInFlight) return
  proxyAuthDialogInFlight = true
  const { shown, reload } = await openProxyAuthDialog()
  proxyAuthDialogInFlight = false
  if (!shown) {
    // Couldn't show (another modal was open). Retry while still blocked.
    if (triageSync.proxyAuthRequired) setTimeout(showProxyAuthDialogOnce, 1500)
    return
  }
  proxyAuthShownThisEpisode = true
  // The reload re-runs the proxy's login flow; triage is persisted
  // locally so nothing is lost. "Not now" just dismisses.
  if (reload) location.reload()
}
triageSync.onProxyAuthRequired((required) => {
  renderSyncStatus()
  if (required) showProxyAuthDialogOnce()
  else proxyAuthShownThisEpisode = false
})

// Double-click a workspace row → inline rename. Replaces the label
// span with an <input> on the fly; Enter or blur commits, Escape
// reverts. The row's other affordances (open / export / drop
// targets) stay live but a re-render after commit/revert paints
// fresh chrome anyway. Imperative DOM swap rather than a state flag
// because the edit is a one-off, scoped to a single row.
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
      if (labelSpan.contains(input)) labelSpan.textContent = listWorkspaces().find((w) => w.id === id)?.name ?? ws.name
      renderSidebar()
    }
  }
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); finish(true) }
    else if (ev.key === 'Escape') { ev.preventDefault(); finish(false) }
  })
  input.addEventListener('blur', () => finish(true))
  // Stop bubbling so the row's click delegate doesn't fire while the
  // user clicks inside the input (focusing / selecting text shouldn't
  // open the workspace).
  input.addEventListener('click', (ev) => ev.stopPropagation())
  input.addEventListener('dblclick', (ev) => ev.stopPropagation())
}

// Intra-sidebar drag-and-drop — move reports AND bundles between
// workspaces and the unfiled list. The whole sidebar is a drop zone:
//   - drop on any element with `[data-workspace-id]` (workspace row
//     OR one of its indented children) → assign to that workspace
//   - drop anywhere else in the sidebar → detach (back to the unfiled
//     list, where reports route by extension and bundles return to
//     the top-level Bundles section)
// The Reports header lights up as the visual affordance for a report
// detach; the Bundles header plays the same role for a bundle
// detach. The drop works regardless of what the cursor is over so
// "drag back" is forgiving in either case.
//
// OS file drops are NOT mistaken for either: the type check below
// looks for our private mimes, only set by the dragstart handler. The
// document-level drop handler in ingest.js still handles OS files
// (its `e.dataTransfer.files` check no-ops on internal drags).
function clearDragOver() {
  for (const el of root.querySelectorAll('.drag-over')) el.classList.remove('drag-over')
}

// Did this drag carry one of OUR mime types? Used by every drag
// handler to filter out OS file drags and unrelated browser drags
// (text selections, links) so the document-level ingest handler still
// handles them.
function dragHasOurPayload(e) {
  return e.dataTransfer.types.includes(REPORT_DT)
    || e.dataTransfer.types.includes(BUNDLE_DT)
}

function onSidebarDragstart(e) {
  // Reports carry data-file; bundles carry data-bundle-integrity;
  // an element never carries both, so the bundle branch can go first.
  const bundleEl = e.target.closest('.file-item[data-bundle-integrity]')
  if (bundleEl) {
    // Missing-bundle rows must not initiate a drag. The `<li>` carries
    // no `draggable` attribute (defaulting to false in most browsers),
    // but a user-initiated drag of selected text / icon glyph can still
    // fire dragstart in some Chromium variants. Without this guard the
    // handler would write the missing integrity into dataTransfer; a
    // subsequent drop on another workspace would attach a bundle
    // nobody has locally, contradicting the row's "non-interactive"
    // affordance (cursor:help, italic muted styling, click gated).
    if (bundleEl.classList.contains('bundle-missing')) {
      e.preventDefault()
      return
    }
    const integrity = bundleEl.dataset.bundleIntegrity
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData(BUNDLE_DT, integrity)
    // Stash the source workspace ID in dataTransfer so the drop
    // handler doesn't have to re-derive it from a `.dragging`
    // element that may have been swapped out by a renderSidebar()
    // racing the drag. Empty string when dragged from the unfiled
    // bucket.
    e.dataTransfer.setData(SOURCE_WS_DT, bundleEl.dataset.workspaceId ?? '')
    // text/plain fallback — paste-into-an-unrelated-textarea is
    // pointless for an integrity hash but consistent with how the
    // report drag works; some browsers also use it as the "ghost
    // image" caption.
    e.dataTransfer.setData('text/plain', integrity)
    bundleEl.classList.add('dragging')
    isDraggingBundle = true
    renderSidebar()
    return
  }
  const fileEl = e.target.closest('.file-item[data-file]')
  if (!fileEl) return
  e.dataTransfer.effectAllowed = 'move'
  e.dataTransfer.setData(REPORT_DT, fileEl.dataset.file)
  e.dataTransfer.setData(SOURCE_WS_DT, fileEl.dataset.workspaceId ?? '')
  e.dataTransfer.setData('text/plain', fileEl.dataset.file)
  fileEl.classList.add('dragging')
  isDraggingReport = true
  renderSidebar()
}

function onSidebarDragend() {
  for (const el of root.querySelectorAll('.dragging')) el.classList.remove('dragging')
  clearDragOver()
  if (isDraggingReport || isDraggingBundle) {
    isDraggingReport = false
    isDraggingBundle = false
    renderSidebar()
  }
}

function onSidebarDragover(e) {
  if (!dragHasOurPayload(e)) return
  e.preventDefault()
  // If the cursor is over a workspace that already owns the dragged
  // identifier (or outside any workspace while the source is already
  // unfiled), this drop will be a W-4 no-op. Surface as `dropEffect:
  // 'none'` so the cursor reads correctly, and skip the highlight loop
  // so neither the source row (same-workspace) nor the detach indicator
  // (already-unfiled → header) lights up against an operation that
  // won't move anything.
  const wsTarget = e.target.closest('[data-workspace-id]')
  const sourceWsId = root.querySelector('.dragging')?.closest('[data-workspace-id]')?.dataset.workspaceId ?? null
  const sameWorkspaceDrop = wsTarget && sourceWsId && wsTarget.dataset.workspaceId === sourceWsId
  const alreadyUnfiledDrop = !wsTarget && !sourceWsId
  const isSelfDrop = sameWorkspaceDrop || alreadyUnfiledDrop
  e.dataTransfer.dropEffect = isSelfDrop ? 'none' : 'move'
  clearDragOver()
  if (isSelfDrop) return
  if (wsTarget) {
    // Highlight at the workspace level so dropping on either the
    // workspace row or any of its indented children reads as the
    // same target. Skip the dragged source row itself — without the
    // skip a same-workspace drop visually conflates source and
    // target during the drag.
    const wsId = wsTarget.dataset.workspaceId
    for (const el of root.querySelectorAll(`[data-workspace-id="${CSS.escape(wsId)}"]`)) {
      if (el.classList.contains('dragging')) continue
      el.classList.add('drag-over')
    }
  } else {
    // Anywhere outside a workspace block detaches; light up the
    // header matching the drag's payload — Bundles for bundle drags,
    // Reports for report drags. Falls through silently when that
    // header isn't rendered (no unfiled bucket exists).
    const isBundle = e.dataTransfer.types.includes(BUNDLE_DT)
    const selector = isBundle ? '[data-default-bundles]' : '[data-default-reports]'
    const indicator = root.querySelector(selector)
    if (indicator) indicator.classList.add('drag-over')
  }
}

function onSidebarDragleave(e) {
  // Only clear if we've left the shadow tree entirely — internal
  // moves between target / non-target elements re-trigger dragover
  // and re-paint the highlight. `e.relatedTarget` retargets to the
  // host when the pointer leaves the component, so `root.contains`
  // (shadow-root scope) is false then; between shadow children it's
  // a real shadow node and stays true.
  if (!root.contains(e.relatedTarget)) clearDragOver()
}

async function onSidebarDrop(e) {
  if (!dragHasOurPayload(e)) return
  e.preventDefault()
  e.stopPropagation()
  clearDragOver()
  const wsTarget = e.target.closest('[data-workspace-id]')
  const targetId = wsTarget ? wsTarget.dataset.workspaceId : null
  // Source workspace ID — read from `dataTransfer` (stashed at
  // `dragstart` time) instead of from the live `.dragging` element.
  // `dataTransfer` survives DOM mutations within the same drag
  // operation; the `.dragging` element doesn't, so a renderSidebar()
  // racing the drag (e.g., `onAutoDownloaded` firing because a peer's
  // report landed on a non-active workspace) would otherwise wipe
  // the source and silently degrade the move into an additive add.
  // Empty string in the dataTransfer means "dragged from unfiled".
  // Under the multi-workspace membership model the drag operation
  // is "remove from source, add to target" — NOT "detach from
  // everywhere, attach to target" — so a report listed in both wsA
  // and wsB stays in wsA when the user drags it out of wsB onto
  // the unfiled bucket.
  const sourceWsId = e.dataTransfer.getData(SOURCE_WS_DT) || null
  if (e.dataTransfer.types.includes(BUNDLE_DT)) {
    const integrity = e.dataTransfer.getData(BUNDLE_DT)
    if (!integrity) return
    // Same additive-add + scoped-remove shape as the report path
    // below — multi-workspace membership applies to bundles too.
    // When the source workspace has the bundle in its remote
    // inventory, prompt the user via `<detach-bundle-dialog>` and
    // — on confirm — drop the source's remote tag too. This makes
    // bundle drag-out symmetric with the report drag-out: both
    // remove the source workspace's remote copy on detach. Cancel
    // aborts the drag entirely (no detach, no remote touch). When
    // the bundle is NOT in the source's remote there's nothing
    // destructive to confirm, so skip the dialog.
    if (sourceWsId && sourceWsId !== targetId && isBundleInRemoteOrCached(sourceWsId, integrity)) {
      const friendly = (state.bundles ?? []).find((b) => b.integrity === integrity)?.name ?? integrity
      const sourceWs = listWorkspaces().find((w) => w.id === sourceWsId)
      const { confirmed } = await openDetachBundleDialog({
        name: friendly,
        workspaceName: sourceWs?.name ?? '',
      })
      if (!confirmed) return
      try { await deleteBundleFromRemote(sourceWsId, integrity) }
      catch (err) { console.warn(`Failed to remove '${friendly}' from source workspace ${sourceWsId} remote:`, err) }
    }
    if (targetId) await addBundleToWorkspace(integrity, targetId)
    if (sourceWsId && sourceWsId !== targetId) await removeBundleFromWorkspace(integrity, sourceWsId)
    renderSidebar()
    return
  }
  const filename = e.dataTransfer.getData(REPORT_DT)
  if (!filename) return
  // Drag-out of a workspace mirrors the delete dialog's "everywhere"
  // path for the source workspace's REMOTE copy: drop the source's
  // tag BEFORE the membership mutation lands locally so the next
  // openWorkspace(source) doesn't auto-download it back. Each
  // workspace has its own objstore tag (HMAC per workspace key), so
  // a deleteRemote(source) leaves other workspaces' uploads alone.
  //
  // When the source has a remote copy the user gets an explicit
  // `<detach-report-dialog>` confirmation before we touch remote —
  // symmetric with the bundle drag-out path. Reports without a
  // remote copy in the source skip the dialog (nothing destructive
  // to confirm). `isInRemoteOrCached` consults both the live
  // session AND the persisted cache, so a source workspace that's
  // mid-boot (session.list still in flight) or closed entirely
  // still surfaces the dialog — without the cache fallback those
  // cases would silently bypass the confirmation, the membership
  // detach would land, and the next open would resurrect the file
  // via `maybeAutoDownload`.
  if (sourceWsId && sourceWsId !== targetId && isInRemoteOrCached(sourceWsId, filename)) {
    const sourceWs = listWorkspaces().find((w) => w.id === sourceWsId)
    const { confirmed } = await openDetachReportDialog({
      name: filename,
      workspaceName: sourceWs?.name ?? '',
    })
    if (!confirmed) return
    try { await deleteRemote(sourceWsId, filename) }
    catch (err) { console.warn(`Failed to remove '${filename}' from source workspace ${sourceWsId} remote:`, err) }
  }
  if (targetId) await addReportToWorkspace(filename, targetId)
  if (sourceWsId && sourceWsId !== targetId) await removeReportFromWorkspace(filename, sourceWsId)
  // A report dropped into (or out of) the active workspace changes the
  // main findings set as well as the sidebar membership. Re-load that
  // workspace in place so its merged rows, filters, and graph refresh
  // immediately instead of waiting for a navigate-away / navigate-back.
  const activeWorkspaceChanged = state.currentWorkspace
    && (state.currentWorkspace === targetId || state.currentWorkspace === sourceWsId)
  if (activeWorkspaceChanged) await switchToWorkspace(state.currentWorkspace)
  else renderSidebar()
}

// The developer override is intentionally module-local: it never changes the
// saved protocol binding or sync preference, and a reload discards it.
let forcedManagedReturn = null
let deferredServerInfo = null
let clientModeGeneration = 0
let managedSessionRequest = 0
let managedSessionRefresh = null
let managedBase = null

async function finishClientModeTransition({ forgetLastView = true, resetNavigation = true } = {}) {
  managedHistory.reset({ force: resetNavigation })
  managedBase?.remove()
  managedBase = null
  const generation = ++clientModeGeneration
  resetManagedAppState()
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
  configureClientMode(info.mode)
  const changed = previousMode !== state.serverMode
  state.managed = info.managed
  if (runtime) state.deepviewScanServer = info.mode === 'managed' ? null : info.deepviewScanServer ?? null
  refreshScanNavigation()
  setSyncForceDisabled(state.serverMode !== 'e2e')
  triageSync.setProtocolLocked(state.serverMode !== 'e2e')
  writeCachedServerInfo(info)
  if (wasManaged !== isManagedUiMode()) {
    // renderSidebar waits for mode detection. Release startup before awaiting
    // the transition's final render, or a first managed visit deadlocks.
    void finishClientModeTransition({ forgetLastView: false, resetNavigation: hadConfiguration }).catch((err) => console.warn('client mode transition:', err))
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
  if (isManagedUiMode()) void refreshManagedSession()
}

// Probe the managed server for the current session (lazy client/managed chunk)
// and repaint the auth control. Only reached in managed mode.
function refreshManagedSession() {
  if (managedSessionRefresh?.generation === clientModeGeneration) return managedSessionRefresh.promise
  const refresh = { generation: clientModeGeneration, promise: null }
  managedSessionRefresh = refresh
  refresh.promise = revalidateManagedSession().finally(() => {
    if (managedSessionRefresh === refresh) managedSessionRefresh = null
  })
  return refresh.promise
}

async function revalidateManagedSession() {
  const generation = clientModeGeneration
  const request = ++managedSessionRequest
  const isCurrent = () => generation === clientModeGeneration && request === managedSessionRequest && isManagedUiMode()
  try {
    const previous = state.managedSession
    const session = await managedProbeSession({ fallback: previous })
    if (!isCurrent()) return
    state.managedSession = session
    setManagedAppSession(session)
    if (previous && previous.id !== session?.id) {
      state.managedTeams = []
      resetManagedTriage()
      managedHistory.reset()
      void goHome({ history: false })
    } else if (state.currentView in ADMIN_PAGES && canAccessManagedPage(state.currentView)) {
      render({ animate: false })
    }
    renderAuthStatus()
    // Claim the triage change-notifier for the server push — a no-op unless
    // the session's role can write triage (reads still hydrate without it).
    initManagedTriagePush()
    // The user's teams (sidebar Teams section). probeTeams never throws; empty
    // when logged out. Repaint the sidebar so the section reflects the result.
    const teams = session == null ? [] : await managedProbeTeams({ fallback: state.managedTeams })
    if (!isCurrent()) return
    state.managedTeams = teams
    renderSidebar()
    if (!document.querySelector('base')) {
      managedBase = document.createElement('base')
      managedBase.href = '/'
      document.head.prepend(managedBase)
    }
    if (managedHistory.active && Object.hasOwn(MANAGED_PAGES, state.currentView) && !canAccessManagedPage(state.currentView)) {
      await managedHistory.navigate({ view: canAccessManagedPage('manage') ? 'manage' : 'home' }, { replace: true })
    } else if (session) await managedHistory.start(restoreManagedPage)
  } catch (err) {
    console.warn('managed: session probe failed:', err)
  }
}

// Admin / manage pages reachable from the account menu. Keys double
// as the `data-action` value AND the `state.currentView` name (each
// painted by render() as its `<managed-admin-*>` element); the value
// is the console prefix on a failed bundle load. Users, repositories,
// and teams are admin-only; reports and bundles are also reachable by
// managers (the account menu gates the entry points).
const ADMIN_PAGES = {
  manage: 'admin: bundle load failed:',
  'admin-users': 'admin: bundle load failed:',
  'manage-repos': 'admin: repos bundle load failed:',
  'manage-reports': 'admin: reports bundle load failed:',
  'manage-bundles': 'admin: bundles bundle load failed:',
  'manage-history': 'admin: history bundle load failed:',
  'manage-teams': 'admin: teams bundle load failed:',
  'manage-scans': 'admin: scans bundle load failed:',
}
const ADMIN_ONLY_PAGES = new Set(['admin-users', 'manage-repos', 'manage-teams'])
let readyManagedView = null

function canAccessManagedPage(view) {
  const role = state.managedSession?.role
  return ['admin', 'manage'].includes(role) && (!ADMIN_ONLY_PAGES.has(view) || role === 'admin')
}

// Navigate to one of the admin / manage pages: load the admin bundle
// (which defines the element render() paints for `view`), then switch
// the view + repaint.
async function restoreManagedPage(route, isCurrent) {
  const canReuseReport = readyManagedView === currentViewGeneration()
    && state.currentManagedTeam === route.teamId && state.currentManagedReport === route.reportId
  beginViewNavigation()
  if (!isCurrent() || !isManagedUiMode()) return false
  if (route.finding) {
    const { revealFinding } = await import('./finding-link-nav.js')
    if (!isCurrent()) return false
    const result = await revealFinding({ ...route.finding, teamId: route.teamId, reportId: route.reportId }, {
      openManagedReport: (team, reportId) => switchToManagedTeam(team, reportId, { history: false }),
      isCurrent,
    })
    if (!isCurrent()) return false
    if (!result.ok) { if (result.reason) showToast(result.reason); return false }
    readyManagedView = currentViewGeneration()
    return { view: 'findings', teamId: state.currentManagedTeam, reportId: state.currentManagedReport }
  }
  if (route.view === 'home') return goHome({ history: false })
  if (Object.hasOwn(MANAGED_PAGES, route.view)) return navigateToAdminPage(route.view, { ...route, history: false })
  const team = state.managedTeams.find(candidate => candidate.id === route.teamId)
  if (!team) return false
  // Findings/Files are two views of the same hydrated reports. Switching
  // between them must preserve filters and avoid fetching/parsing again.
  if (!canReuseReport && !(await switchToManagedTeam(team, route.reportId, { history: false }))) return false
  if (!isCurrent()) return false
  if (state.currentView !== route.view) cleanupGraph2()
  state.currentView = route.view
  document.body.classList.remove('report-fullscreen')
  // Commit page restoration synchronously with its URL, including in a
  // background PWA window where a view transition may wait for a paint.
  render({ animate: false })
  readyManagedView = currentViewGeneration()
  renderSidebar()
  document.querySelector('#main-content')?.scrollTo({ top: 0 })
  return { ...route, view: state.currentView }
}

export async function navigateToAdminPage(view, options = {}) {
  if (options.history !== false && isManagedUiMode()) {
    if (!managedHistory.active) await refreshManagedSession()
    if (managedHistory.active) return managedHistory.navigate({ view, ...(options.actor ? { actor: options.actor } : {}) })
  }
  if (!(view in ADMIN_PAGES) || !isManagedUiMode() || !canAccessManagedPage(view)) return false
  const navigation = beginViewNavigation()
  const generation = clientModeGeneration
  try { await loadManagedBundle() }
  catch (err) { console.warn(ADMIN_PAGES[view], err); return false }
  if (generation !== clientModeGeneration || navigation !== currentViewGeneration() || !isManagedUiMode() || !canAccessManagedPage(view)) return false
  state.currentView = view
  render({ animate: false })
  renderSidebar()
  // Use the known role and CSRF token immediately; apply session changes when
  // the background check finishes. Rapid navigation shares the pending check.
  void refreshManagedSession()
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

// Admin pages live in a separate lazy-loaded bundle, so the shared back button
// and management hub communicate through a composed event instead of importing
// the sidebar module into that bundle (which would duplicate application state).
document.addEventListener('managed-notice', event => showToast(event.detail.message, { kind: 'error' }))

document.addEventListener('managed-admin-navigate', (event) => {
  const view = event.detail?.view
  const actor = event.detail?.actor
  if (typeof view === 'string') void navigateToAdminPage(view, { actor })
})

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

async function detectServerModeIfUnknown() {
  const cached = readCachedServerInfo()
  if (cached) {
    // Another tab may have confirmed the mode since state.ts was evaluated.
    configureClientMode(cached.mode)
    state.managed = cached.managed
    // The cache is a startup hint, not a permanent protocol binding. Today's
    // advertisement replaces it; a failed probe still permits local access.
    void probeServerInfo().then((info) => {
      if (info && info !== 'standalone') return applyServerInfo(info)
      return undefined
    }).catch((err) => console.warn('server mode revalidation:', err))
    return
  }
  setLandingModePending(!hasStandaloneProbeHint())
  const probe = probeServerInfo()
  const info = await waitForServerInfo(probe, hasStandaloneProbeHint() ? 0 : 3000)
  // A sync frame or another tab may have confirmed the mode while pending.
  // Adopt it into state as well: the initial e2e default is not confirmation.
  const confirmed = readCachedServerInfo()
  if (confirmed) {
    return info && info !== 'standalone' ? applyServerInfo(info) : applyServerInfo(confirmed, { runtime: false })
  }
  if (info && info !== 'standalone') return applyServerInfo(info)
  // Unknown or unavailable server: open local data with synchronization off.
  // Do not cache a guessed protocol or modify any saved sync preferences.
  if (info === 'standalone') rememberStandaloneProbe()
  state.serverMode = 'standalone'
  state.serverModeConfig = null
  state.serverModeSelection = null
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
          forcedManagedReturn.serverMode = 'standalone'
          forcedManagedReturn.serverModeConfig = null
          forcedManagedReturn.serverModeSelection = null
          forcedManagedReturn.localMode = false
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
  const menu = root?.querySelector('#user-menu')
  const trigger = root?.querySelector('#auth-status')
  if (!menu || !trigger) return
  menu.addEventListener('beforetoggle', (e) => {
    if (e.newState !== 'open') return
    const r = trigger.getBoundingClientRect()
    menu.style.left = `${Math.round(r.left)}px`
    menu.style.bottom = `${Math.round(window.innerHeight - r.top + 6)}px`
    menu.style.top = 'auto'
    menu.style.right = 'auto'
  })
}

// Wire the event delegates onto the shadow root + the search input,
// hand the encryption-toggle button to its module, then paint. All
// delegates sit on the shadow root (or the in-shadow `#file-list`),
// so an event fired inside the tree reaches them with `e.target`
// un-retargeted — `e.target.closest(...)` matches shadow elements
// directly, exactly as it did against the light-DOM `#sidebar`.
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
  root.addEventListener('dblclick', onSidebarDblclick)
  root.addEventListener('dragstart', onSidebarDragstart)
  root.addEventListener('dragend', onSidebarDragend)
  root.addEventListener('dragover', onSidebarDragover)
  root.addEventListener('dragleave', onSidebarDragleave)
  root.addEventListener('drop', onSidebarDrop)
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

// `<app-sidebar>` — the report / workspace / bundle picker. Shadow
// DOM so its ~700-line stylesheet (view/sidebar.css) is scoped to
// the component instead of riding the global cascade. The shell
// (header / search / list / actions) is static, so `render()` runs
// once and the dynamic `#file-list` is populated imperatively by
// `renderSidebar()` (no `${}` inside the `<ul>`, so re-renders — if
// any — never wipe the imperatively-rendered rows).
class AppSidebar extends LitElement {
  // `file-icon.css` (the brand-sticker fills) is dual-context — the
  // main content renders the same `.file-icon.brand-*` SVGs in light
  // DOM (page header, finding cards, packages/repos/bundle views, via
  // view.css's global @import), and the sidebar's file rows render
  // them in here. Inlining it into the shadow styles keeps the rows'
  // icons coloured without the global rule being able to reach in.
  static styles = [unsafeCSS(fileIconCSS), unsafeCSS(sidebarCSS)]

  render() {
    return html`
      <div class="sidebar-header">
        <h2 class="brand">
          <button class="brand-button" type="button" data-action="go-home">
            <img class="brand-icon" src="./icon.svg" width="18" height="18" alt="">
            <span class="brand-name">DeepView</span>
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
      <button id="storage-status" type="button" hidden>
        <span class="storage-dot" aria-hidden="true"></span>
        <span class="storage-label"></span>
      </button>
      <div class="sidebar-actions">
        <sidebar-delete-current></sidebar-delete-current>
        <button id="sync-status" type="button" data-status="off">
          <span class="sync-dot" aria-hidden="true"></span>
          <span class="sync-label">Sync off</span>
        </button>
        <button id="auth-status" type="button" hidden></button>
        <button id="manage-status" type="button" hidden data-action="manage" aria-label="Manage">${unsafeHTML(MANAGE_ICON_SVG)}</button>
      </div>
      <div id="user-menu" popover class="user-menu"></div>
    `
  }

  firstUpdated() {
    mount(this)
  }
}
customElements.define('app-sidebar', AppSidebar)
