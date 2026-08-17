import { LitElement, html, render as litRender, nothing, unsafeCSS } from 'lit'
import { repeat } from 'lit/directives/repeat.js'
import { unsafeHTML } from 'lit/directives/unsafe-html.js'
import { CONFIG_PATH, addBundleToWorkspace, addReportToWorkspace, analyzeTriageImpact, classifyServerMode, createWorkspace, ensureBundleFindingsIndexed, ensureCounts, getCount, getPackagesIndex, getRepositoriesIndex, listBundles, listFiles, listWorkspaces, migrateLegacyFilenames, onVaultStateChange, parseServerInfo, readCachedServerInfo, removeBundleFromWorkspace, removeReportFromWorkspace, renameWorkspace, state, writeCachedServerInfo } from '#client/index.js'
import { deleteBundleFromRemote, deleteFromRemote as deleteRemote, isBundleInRemoteOrCached, isInRemoteOrCached, loadSync, setSyncForceDisabled, triageSync } from './client-sync.js'
import { fetchReport as fetchManagedReport, login as managedLogin, logout as managedLogout, probeSession as managedProbeSession, probeTeams as managedProbeTeams } from './client-managed.js'
import { loadAdminBundlesBundle, loadAdminReportsBundle, loadAdminReposBundle, loadAdminTeamsBundle, loadAdminUsersBundle } from './client-admin.js'
import sidebarCSS from './sidebar.css'
import fileIconCSS from '../styles/file-icon.css'
import { initEncryptionToggle, refreshEncryptionToggle } from './encryption-toggle.js'
import { initStorageStatus, scheduleStorageStatusRefresh } from './storage-status.js'
import { render } from './render.js'

// Set on mount (`<app-sidebar>` firstUpdated). `hostEl` is the
// custom-element host (light DOM — `.classList` collapse/empty
// toggles live here). `root` is its shadow root, the scope for all
// event delegates + `querySelector` lookups; events fired inside it
// reach delegates attached to it with `e.target` un-retargeted, so
// the `e.target.closest(...)` matching below works unchanged.
// `fileList` is the `#file-list` <ul> inside the shadow.
let hostEl = null
let root = null
let fileList = null
import { deleteCurrent, deleteCurrentBundle, goHome, leaveWorkspace, persistLastBundle, switchToFile, switchToWorkspace } from './ingest.js'
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
import { FILE_ICONS, displayName, groupOf } from './file-display.js'
import { BUNDLE_ICON_SVG, WORKSPACE_ICON_SVG } from './icons.js'
import { openBundle } from './bundle-load.js'
import { graph2 } from './graph/state.js'
import { hideTooltip, installGlobalTooltipListener, scheduleTooltip } from './tooltip.js'

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
// Piolium is Vigolium's (https://github.com/vigolium/piolium).
const GROUP_LABELS = {
  'default': 'Reports',
  'claude-security': 'Claude Security',
  'codex-security': 'Codex Security',
  'deepsec': 'DeepSec',
  'piolium': 'Piolium',
}

// Render order for buckets — default (analyzer dumps) first, then
// named sources in alphabetical-ish reading order.
const GROUP_ORDER = ['default', 'claude-security', 'codex-security', 'deepsec', 'piolium']


// Live module state — the search-box query, applied as a
// case-insensitive substring match on each file's display name.
// Cleared by switchToFile / deleteCurrent indirectly (a fresh render
// starts from this same value), so users can switch files without
// losing their search.
let searchQuery = ''

function fileItemTemplate(n, opts = {}) {
  // Suppress the `current` highlight when the user is browsing the
  // bundles view — there's no active report in that mode, so
  // leaving the previously-loaded report visually selected reads
  // as a stale state. The same suppression applies to the
  // workspace-row template below.
  const isCurrent = n === state.currentFile
    && (state.currentView === 'findings' || state.currentView === 'files')
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
function workspaceHeaderTemplate() {
  // Managed mode has no client-side workspace creation — a different management
  // surface is coming — so drop the "+" affordance there.
  const actions = state.serverMode === 'managed'
    ? nothing
    : html`<span class="workspace-header-actions"><button type="button" class="workspace-add" data-action="new-workspace" title="Create a new workspace" aria-label="Create a new workspace">${WORKSPACE_PLUS_ICON}</button></span>`
  return html`<li class="file-group-header workspace-header"><span class="group-label">Workspaces</span>${actions}</li>`
}

// The signed-in user's team memberships (managed mode), rendered ABOVE the
// Workspaces section. Static label rows for now — teams have no dedicated view
// yet. Renders nothing outside managed mode or when the user is in no teams.
function teamsSectionTemplate() {
  if (state.serverMode !== 'managed') return nothing
  const teams = Array.isArray(state.managedTeams) ? state.managedTeams : []
  if (teams.length === 0) return nothing
  return html`
    ${groupHeaderTemplate('Teams')}
    ${repeat(teams, (t) => t.id, (t) => html`
      <li class="file-item team-item"><span class="team-name">${TEAM_ICON}<span class="team-label">${t.name}</span></span></li>
      ${repeat(Array.isArray(t.reports) ? t.reports : [], (r) => r.id, (r) => teamReportTemplate(r))}`)}`
}

// A clickable report row under its team (managed mode). Reuses the indented
// file-row chrome but carries no `data-file`, so the file-click delegate ignores
// it — opening is handled by its own @click, which renders the report from the
// server WITHOUT caching it to OPFS.
function teamReportTemplate(r) {
  return html`<li class="file-item indented team-report-item">
    <button type="button" class="file-name" data-tooltip=${r.filename} @click=${() => void openTeamReport(r)}>
      ${unsafeHTML(FILE_ICONS.default)}<span class="file-label">${r.filename}</span>
    </button>
  </li>`
}

// Fetch a managed team report's content and render it in place via switchToFile
// (which, given content, reads/writes no OPFS — the report is never cached).
async function openTeamReport(r) {
  const content = await fetchManagedReport(r.id)
  if (content == null) { console.warn('managed: could not load team report', r.id); return }
  await switchToFile(r.filename, content)
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
function workspaceItemTemplate(w) {
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
  // property binding leaves no markers inside the span, so the inline
  // mutation is a plain overwrite the next render reapplies.
  // Hover-revealed actions, in row order: Share by link, Export
  // (download .gz bundle), then Leave (drop the workspace from THIS
  // browser — entry, OPFS reports, persisted triage base — without
  // touching the server's chain, so peers and your other devices keep
  // their copy). No placeholder trash icon for the eventual
  // server-side "delete the chain too" (TBD): it would misread as
  // "Delete is the same action as Leave, just greyed out".
  return html`<li class=${cls} data-workspace-id=${w.id}><button type="button" class="file-name">${WORKSPACE_ICON}<span class="file-label" .textContent=${w.name}></span></button><button type="button" class="workspace-share" data-action="share-workspace" title="Share by link" aria-label="Share workspace by link">${WORKSPACE_SHARE_ICON}</button><button type="button" class="workspace-export" data-action="export-workspace" title="Export workspace" aria-label="Export workspace">${WORKSPACE_EXPORT_ICON}</button><button type="button" class="workspace-leave" data-action="leave-workspace" title="Leave workspace" aria-label="Leave workspace">${WORKSPACE_LEAVE_ICON}</button></li>`
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
// file. Disables Delete when nothing's open. Hides the whole sidebar
// when there are no files AND nothing's currently loaded — keeps the
// empty-state drop zone uncluttered. Section headers render for every
// non-empty bucket (including the default Reports group) so the
// vocabulary stays consistent across mixed-format collections. Called
// after every state transition that could change the file list, the
// current selection, or the search query.
export async function renderSidebar() {
  // One-shot migration of `.deepseek` OPFS entries back to `.md`
  // (relic of an earlier build). Cached after the first call so
  // subsequent renders are a no-op; awaiting before listFiles makes
  // sure the listing reflects the post-rename state.
  await migrateLegacyFilenames()
  // Kick the OPFS-wide finding index so the Packages count + page
  // populate in the background without needing the user to open a
  // bundle first. Idempotent — concurrent calls share the same
  // in-flight promise; subsequent calls walk listFiles again to
  // pick up any newly-dropped reports.
  ensureBundleFindingsIndexed().catch(() => {})
  const names = await listFiles()
  const workspaces = listWorkspaces()
  const bundleNames = await listBundles()
  // Stash the bundles list on state so the main view's bundles
  // branch (in render.js) can paint synchronously without redoing
  // the OPFS scan. Updated on every sidebar render — drops, deletes,
  // and switchToFile all refresh through here.
  state.bundles = bundleNames
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
  hostEl.classList.remove('empty')

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
    ${state.serverMode === 'managed' && workspaces.length === 0 ? nothing : workspaceHeaderTemplate()}
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
      return html`
        ${workspaceItemTemplate(w)}
        ${presentReports.map((r) => fileItemTemplate(r, { indented: true, workspaceId: w.id }))}
        ${missingReports.map((r) => missingReportItemTemplate(r, w.id))}
        ${presentBundles.map((b) => bundleItemTemplate(b, { workspaceId: w.id }))}
        ${missingBundles.map((integ) => missingBundleItemTemplate(integ, w.id))}
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
  ensureCounts(names, () => { renderSidebar() })
}

// Re-render the sidebar whenever the passkey vault state flips so
// the encryption row reflects the live state (enable → unlock → lock
// transitions) without waiting for an unrelated event to trigger a
// render. Wired here rather than in view.js because view.js already
// invokes the main `render()` on vault changes — this hook covers
// the sidebar's own template too.
onVaultStateChange(() => { renderSidebar() })

// Sidebar event delegation: file-list click switches; Delete removes
// the current file; toggle collapses / expands; search filters on
// input. The workspace "+" button intercepts BEFORE the file-row
// match because a workspace header is itself a `<li>` that contains
// no `data-file` — but the add button still bubbles to the same
// listener.
async function onSidebarClick(e) {
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
  // bundle and switches to the bundles view. Mirrors the
  // data-select-bundle handler in events.js (per-row setup must
  // clear the prior load's parsed details, search box, and detail-
  // tab choice so the new bundle starts on the Packages tab); the
  // sidebar listener runs the same path so the row is interchangeable
  // with the main-pane list row.
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
    state.currentView = 'bundles'
    state.selectedBundle = integrity
    state.bundleDetails = null
    state.bundleSourceFile = null
    state.bundleSourceFindingIdx = null
    state.bundleCodeSearchQuery = ''
    state.bundleCodeSearchMode = 'files'
    state.bundleSearchQuery = ''
    state.bundleSearchRegex = false
    state.bundleSearchCase = false
    state.bundleSearchContext = true
    state.bundleDetailsTab = 'overview'
    graph2.showAll = true
    state.shownTriage = null
    persistLastBundle(integrity)
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
    if (state.serverMode === 'managed') return
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
    if (name && (name !== state.currentFile || state.currentView !== 'findings')) {
      switchToFile(name)
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
    const { confirmed, triage } = await openDeleteReportDialog({ name, triageImpact, inRemote })
    if (!confirmed) return
    // The active file may have changed under us (cross-tab switch /
    // sibling-tab delete) while the dialog was open. Bail rather than
    // deleting whatever's current now — the user confirmed deletion of
    // the file shown in the dialog, not whatever just slid into place.
    if (state.currentFile !== name) {
      alert(`Active report changed during confirmation; aborting delete of "${name}".`)
      return
    }
    try { await deleteCurrent({ triage, deleteFromRemoteWorkspaceIds: remoteWorkspaceIds }) }
    catch (err) { alert(`Failed to delete report: ${err.message}`) }
    return
  }
  if (e.target.closest('#sync-status')) {
    // Paused on a protocol mismatch: the badge is informational — a click
    // must not churn the (locked) socket or persist toggles. (Clearing it
    // needs an explicit migration; TODO.)
    if (state.serverModeMismatch) return
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
  if (e.target.closest('[data-action="admin-users"]')) {
    // Admin: navigate to the users page (lazily loads the admin bundle that
    // defines the <managed-admin-users> element render() paints).
    root?.querySelector('#user-menu')?.hidePopover?.()
    void navigateToAdminUsers()
    return
  }
  if (e.target.closest('[data-action="manage-repos"]')) {
    // Admin/manage: navigate to the connected-repositories page (same lazy admin
    // bundle, which defines the <managed-admin-repos> element render() paints).
    root?.querySelector('#user-menu')?.hidePopover?.()
    void navigateToManageRepos()
    return
  }
  if (e.target.closest('[data-action="manage-reports"]')) {
    // Admin/manage: navigate to the uploaded-reports page (same lazy admin
    // bundle, which defines the <managed-admin-reports> element render() paints).
    root?.querySelector('#user-menu')?.hidePopover?.()
    void navigateToManageReports()
    return
  }
  if (e.target.closest('[data-action="manage-bundles"]')) {
    // Admin/manage: navigate to the uploaded-bundles page (same lazy admin
    // bundle, which defines the <managed-admin-bundles> element render() paints).
    root?.querySelector('#user-menu')?.hidePopover?.()
    void navigateToManageBundles()
    return
  }
  if (e.target.closest('[data-action="manage-teams"]')) {
    // Admin/manage: navigate to the teams page (same lazy admin bundle, which
    // defines the <managed-admin-teams> element render() paints).
    root?.querySelector('#user-menu')?.hidePopover?.()
    void navigateToManageTeams()
    return
  }
  if (e.target.closest('[data-action="managed-logout"]')) {
    // Logout row inside the account menu — clears the server session (with the
    // double-submit CSRF token) then reloads so the app re-probes logged-out.
    void managedLogout(state.managedSession?.csrfToken)
    return
  }
  if (e.target.closest('#auth-status')) {
    // Logged in → the button is a popovertarget that opens the account menu
    // (the browser toggles it); logged out → it hands off to the OAuth login.
    if (state.managedSession == null) managedLogin(state.managed?.loginPath)
    return
  }
  if (e.target.closest('#sidebar-toggle')) {
    if (state.serverMode === 'managed') return
    hostEl.classList.toggle('collapsed')
    try { localStorage.setItem('deepview.sidebarCollapsed', hostEl.classList.contains('collapsed') ? '1' : '0') } catch {}
  }
}

// Sidebar tooltip wiring — same styled tooltip element the rest of
// the app uses (via `view/tooltip.js`). The mouseover listener
// lives inside the shadow root (events don't reach the document-
// level global handler with their original target across the shadow
// boundary), so we drive show / hide directly here.
//
// Gate: when the tooltip text is just the label text (the common
// case for short report filenames), suppress the tooltip when the
// label actually fits its slot — non-truncated rows stay quiet.
// When the tooltip carries MORE than the label (e.g. bundle rows
// where the tooltip is `name\nintegrity`), show on hover regardless
// of truncation so the integrity stays discoverable.
function onFileListMouseover(e) {
  const el = e.target.closest('[data-tooltip]')
  if (!el) { hideTooltip(); return }
  scheduleTooltip(el, {
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
  })
}

function onFileListMouseout(e) {
  // Don't hide when the cursor moves within the SAME `[data-tooltip]`
  // element (e.g. button → its child span). Mouseout bubbles for
  // every inner element, but we only care when the cursor actually
  // leaves the row that owns the tooltip.
  const fromRow = e.target.closest('[data-tooltip]')
  const toRow = e.relatedTarget?.closest?.('[data-tooltip]') ?? null
  if (fromRow && fromRow === toRow) return
  hideTooltip()
}

function onSearchInput(e) {
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

// Managed-mode auth control — replaces the offline/online toggle. Shows
// "Log in" (→ the server's OAuth entry) when logged out, "Log out (user)"
// when a managed session exists. `state.managedSession` is populated by the
// future managed session probe; until then it stays null (logged out).
function renderAuthStatus() {
  const authBtn = root?.querySelector('#auth-status')
  if (!authBtn) return
  authBtn.hidden = false
  const menu = root?.querySelector('#user-menu')
  const session = state.managedSession
  if (session == null) {
    authBtn.dataset.authed = '0'
    authBtn.removeAttribute('popovertarget')
    authBtn.setAttribute('aria-label', 'Log in')
    litRender(html`Log in`, authBtn)
    if (menu) litRender(nothing, menu)
    return
  }
  // Logged in: the button becomes the avatar, opening the account popover menu.
  const initial = (session.login[0] ?? '?').toUpperCase()
  authBtn.dataset.authed = '1'
  authBtn.setAttribute('popovertarget', 'user-menu')
  authBtn.setAttribute('aria-label', `Account: ${session.login}`)
  litRender(avatarTemplate(initial, session.id), authBtn)
  if (menu) {
    litRender(html`
      <div class="user-card">
        ${avatarTemplate(initial, session.id, true)}
        <span class="user-id">
          <span class="user-login">${session.login}</span>
          ${session.name ? html`<span class="user-name">${session.name}</span>` : nothing}
        </span>
      </div>
      ${session.role === 'admin' || session.role === 'manage' ? html`
        <div class="user-menu-group" role="group" aria-label="Manage">
          <div class="user-menu-group-label">Manage</div>
          ${session.role === 'admin' ? html`<button type="button" class="user-menu-row" data-action="admin-users">Users</button>` : nothing}
          <button type="button" class="user-menu-row" data-action="manage-repos">Repositories</button>
          <button type="button" class="user-menu-row" data-action="manage-reports">Reports</button>
          <button type="button" class="user-menu-row" data-action="manage-bundles">Bundles</button>
          <button type="button" class="user-menu-row" data-action="manage-teams">Teams</button>
        </div>` : nothing}
      <button type="button" class="user-menu-row" data-action="managed-logout">Log out</button>
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
    <img alt="" src=${src} @error=${onAvatarError}>
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
  if (tag) tag.textContent = state.serverMode
}

// Managed mode pins the sidebar open — no collapse affordance (a fuller
// management surface lives here). The mode is mirrored onto the host so CSS can
// hide the collapse toggle.
function applyCollapsibility() {
  if (hostEl) hostEl.dataset.mode = state.serverMode
  if (state.serverMode === 'managed') hostEl?.classList.remove('collapsed')
  // Mode also drives the encryption toggle's visibility (hidden when managed +
  // encryption off); refresh it here since mode isn't a vault-state event.
  refreshEncryptionToggle()
}

function renderSyncStatus(status) {
  const btn = root?.querySelector('#sync-status')
  if (!btn) return
  renderBrandTag()
  applyCollapsibility()
  // A refused cross-mode switch pins sync OFF and explains why — checked
  // FIRST so no later render (visibility / status change) can clear the
  // forced-off and silently reconnect to a wrong-protocol server.
  if (state.serverModeMismatch) {
    const mismatchAuthBtn = root?.querySelector('#auth-status')
    if (mismatchAuthBtn) mismatchAuthBtn.hidden = true
    triageSync.setForcedOff(true)
    triageSync.setProtocolLocked(true)
    btn.hidden = false
    btn.dataset.status = 'paused'
    btn.title = 'This server speaks a different sync protocol than this app is set up for. Switching isn’t supported yet.'
    const mismatchLabel = btn.querySelector('.sync-label')
    if (mismatchLabel) mismatchLabel.textContent = 'Sync paused'
    return
  }
  // Managed mode replaces the offline/online toggle with login/logout (sync
  // is session-based there, not a user-toggled WS): hide the sync button,
  // pause the e2e sync layer, and paint the auth control instead.
  if (state.serverMode === 'managed') {
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
  btn.title = degraded
    ? 'Not saving to this browser right now (storage may be full, or another tab is on a newer version). Changes that haven’t synced could be lost on reload.'
    : proxyAuth
      ? 'Can’t reach the sync server — the connection is being redirected to a sign-in proxy (e.g. Cloudflare Access). Reload the page to sign in again.'
      : ''
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
    if (commit) await renameWorkspace(id, input.value)
    renderSidebar()
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
  renderSidebar()
}

// Wire the event delegates onto the shadow root + the search input,
// hand the encryption-toggle button to its module, then paint. All
// delegates sit on the shadow root (or the in-shadow `#file-list`),
// so an event fired inside the tree reaches them with `e.target`
// un-retargeted — `e.target.closest(...)` matches shadow elements
// directly, exactly as it did against the light-DOM `#sidebar`.
// Apply the server's advertised mode — delivered by its `server-info` connect
// frame via `triageSync.onServerInfo` — to `state`, refusing a cross-mode
// switch (managed↔e2e) until an explicit migration exists. `state.serverMode`
// is seeded from the localStorage cache (see state.ts); this confirms it on
// connect and updates the cache. A MISMATCH is refused — flag it (surfaced in
// the sync badge) and keep sync paused, rather than silently reinterpreting
// local data under the other protocol.
function applyServerInfo(info) {
  const cached = readCachedServerInfo()
  const cls = classifyServerMode(cached ? cached.mode : null, info.mode)
  if (cls === 'mismatch') {
    state.serverModeMismatch = true
    // Fail-closed: pause THIS plane AND hard-lock the SHARED socket so the
    // mode-unaware objstore plane can't keep it open to the wrong server.
    triageSync.setForcedOff(true)
    triageSync.setProtocolLocked(true)
    console.warn(`sync: server is '${info.mode}' but this client is bound to '${cached?.mode}' — refusing to switch (migration not yet supported)`)
    renderSyncStatus(triageSync.status)
    return
  }
  state.serverModeMismatch = false
  // Clear any stale lock from a prior mismatch this session.
  triageSync.setProtocolLocked(false)
  const changed = state.serverMode !== info.mode
  state.serverMode = info.mode
  state.managed = info.managed
  writeCachedServerInfo(info)
  renderSyncStatus(triageSync.status)
  if (changed) renderSidebar()
  if (info.mode === 'managed') void refreshManagedSession()
}

// Probe the managed server for the current session (lazy client/managed chunk)
// and repaint the auth control. Only reached in managed mode.
async function refreshManagedSession() {
  try {
    state.managedSession = await managedProbeSession()
    renderAuthStatus()
    // The user's teams (sidebar Teams section). probeTeams never throws; empty
    // when logged out. Repaint the sidebar so the section reflects the result.
    state.managedTeams = state.managedSession == null ? [] : await managedProbeTeams()
    renderSidebar()
  } catch (err) {
    console.warn('managed: session probe failed:', err)
  }
}

// Navigate to the admin users page: load the admin bundle (which defines the
// <managed-admin-users> element), then switch the view + repaint.
async function navigateToAdminUsers() {
  try { await loadAdminUsersBundle() }
  catch (err) { console.warn('admin: bundle load failed:', err); return }
  state.currentView = 'admin-users'
  render()
  renderSidebar()
}

// Navigate to the connected-repositories page: load the admin bundle (which
// defines <managed-admin-repos>), then switch the view + repaint. Reachable by
// admin and manage roles (the account menu gates the entry point).
async function navigateToManageRepos() {
  try { await loadAdminReposBundle() }
  catch (err) { console.warn('admin: repos bundle load failed:', err); return }
  state.currentView = 'manage-repos'
  render()
  renderSidebar()
}

// Navigate to the uploaded-reports page: load the admin bundle (which defines
// <managed-admin-reports>), then switch the view + repaint. Reachable by admin
// and manage roles (the account menu gates the entry point).
async function navigateToManageReports() {
  try { await loadAdminReportsBundle() }
  catch (err) { console.warn('admin: reports bundle load failed:', err); return }
  state.currentView = 'manage-reports'
  render()
  renderSidebar()
}

// Navigate to the uploaded-bundles page: load the admin bundle (which defines
// <managed-admin-bundles>), then switch the view + repaint. Reachable by admin
// and manage roles (the account menu gates the entry point).
async function navigateToManageBundles() {
  try { await loadAdminBundlesBundle() }
  catch (err) { console.warn('admin: bundles bundle load failed:', err); return }
  state.currentView = 'manage-bundles'
  render()
  renderSidebar()
}

// Navigate to the teams page: load the admin bundle (which defines
// <managed-admin-teams>), then switch the view + repaint. Reachable by admin
// and manage roles (the account menu gates the entry point).
async function navigateToManageTeams() {
  try { await loadAdminTeamsBundle() }
  catch (err) { console.warn('admin: teams bundle load failed:', err); return }
  state.currentView = 'manage-teams'
  render()
  renderSidebar()
}

// Cold-start mode detection. With nothing cached we don't yet know the server's
// protocol — and a managed server has no WS plane whose connect frame would
// tell us — so GET /api/config to learn it up front and feed the same
// applyServerInfo path. Skipped once the mode is known (cached); the WS connect
// frame (kept) then catches any later change.
async function detectServerModeIfUnknown() {
  if (readCachedServerInfo()) return
  let status = 0
  let info = null
  try {
    const res = await fetch(CONFIG_PATH, { credentials: 'same-origin', headers: { accept: 'application/json' } })
    status = res.status
    if (res.ok) info = parseServerInfo(await res.json())
  } catch { /* offline / unreachable — stay on the default until a frame arrives */ }
  if (info) { applyServerInfo(info); return }
  if (status === 404) {
    // No /api/config → a backend-less (standalone) deployment: purely local, no
    // sync. Runtime-only — deliberately NOT cached (a static host could gain a
    // backend later) — and the e2e sync chunk is hard-disabled.
    state.serverMode = 'standalone'
    setSyncForceDisabled(true)
    renderSyncStatus(triageSync.status)
    renderSidebar()
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

function mount(host) {
  hostEl = host
  root = host.renderRoot
  fileList = root.querySelector('#file-list')
  initEncryptionToggle(root.querySelector('#encryption-toggle'))
  initStorageStatus(root.querySelector('#storage-status'))
  root.addEventListener('click', onSidebarClick)
  root.addEventListener('dblclick', onSidebarDblclick)
  root.addEventListener('dragstart', onSidebarDragstart)
  root.addEventListener('dragend', onSidebarDragend)
  root.addEventListener('dragover', onSidebarDragover)
  root.addEventListener('dragleave', onSidebarDragleave)
  root.addEventListener('drop', onSidebarDrop)
  fileList.addEventListener('mouseover', onFileListMouseover)
  fileList.addEventListener('mouseout', onFileListMouseout)
  root.querySelector('#sidebar-search-input')?.addEventListener('input', onSearchInput)
  positionUserMenuOnOpen()
  renderSyncStatus(triageSync.status)
  renderSidebar()
  // Learn the server's protocol from its `server-info` connect frame (refuses
  // a cross-mode switch); state.serverMode is meanwhile seeded from the
  // localStorage cache (see state.ts) so the first paint is mode-correct.
  triageSync.onServerInfo(applyServerInfo)
  // Cold start (mode not yet cached): probe GET /api/config so we detect a
  // managed server, which has no WS connect frame to announce itself.
  void detectServerModeIfUnknown()
  // If the cached mode is already managed, probe the session now so the auth
  // control paints logged-in/out without waiting for a connect frame.
  if (state.serverMode === 'managed') void refreshManagedSession()
}

// `<app-sidebar>` — the report / workspace / bundle picker. Shadow
// DOM so its ~1500-line stylesheet (view/sidebar.css) is scoped to
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
            <span class="brand-name">DeepView</span>
          </button>
          <span class="brand-tag">dev</span>
        </h2>
        <button id="encryption-toggle" type="button" hidden></button>
        <button id="sidebar-toggle" type="button" title="toggle sidebar" aria-label="toggle sidebar">
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
        <input id="sidebar-search-input" type="search" placeholder="Search reports..." autocomplete="off">
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
      </div>
      <div id="user-menu" popover class="user-menu"></div>
    `
  }

  firstUpdated() {
    mount(this)
  }
}
customElements.define('app-sidebar', AppSidebar)
