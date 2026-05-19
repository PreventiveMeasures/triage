import { html, render as litRender, nothing } from 'lit'
import { repeat } from 'lit/directives/repeat.js'
import { unsafeHTML } from 'lit/directives/unsafe-html.js'
import { addBundleToWorkspace, addReportToWorkspace, analyzeTriageImpact, createWorkspace, deleteFromRemote as deleteRemote, ensureBundleFindingsIndexed, ensureCounts, getCount, getPackagesIndex, getRepositoriesIndex, isInRemote, listBundles, listFiles, listWorkspaces, migrateLegacyFilenames, onVaultStateChange, removeBundleFromWorkspace, removeReportFromWorkspace, renameWorkspace, state, triageSync } from '#client/index.js'
import { fileList, sidebar } from './dom.js'
import { render } from './render.js'
import { deleteCurrent, leaveWorkspace, persistLastBundle, switchToFile, switchToWorkspace } from './ingest.js'
import { exportWorkspace } from './workspace-export.js'
import { maybePromptFirstUse } from './first-import-prompt.js'
import { openNewWorkspaceDialog } from './new-workspace-dialog.js'
import { openLeaveWorkspaceDialog } from './leave-workspace-dialog.js'
import { openWorkspaceShareLinkDialog } from './workspace-share-link-dialog.js'
import { openDeleteReportDialog } from './delete-report-dialog.js'
import { FILE_ICONS, displayName, groupOf } from './file-display.js'
import { openBundle } from './bundle-load.js'
import { graph2 } from './graph/state.js'

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
//     forwards `/api/sync` to `server/index.ts` on :8765, so
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
// DeepSec is Vercel's tool (https://github.com/vercel-labs/deepsec).
const GROUP_LABELS = {
  'default': 'Reports',
  'claude-security': 'Claude Security',
  'codex-security': 'Codex Security',
  'deepsec': 'DeepSec',
}

// Render order for buckets — default (analyzer dumps) first, then
// named sources in alphabetical-ish reading order.
const GROUP_ORDER = ['default', 'claude-security', 'codex-security', 'deepsec']


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

function groupHeaderTemplate(label, count, opts = {}) {
  const cls = `file-group-header${opts.dropTarget ? ' default-reports' : ''}`
  return html`<li
    class=${cls}
    data-default-reports=${opts.dropTarget ? 'true' : nothing}
  ><span class="group-label">${label}</span>${count > 0 ? html`<span class="group-count">${count}</span>` : nothing}</li>`
}

// Workspaces section header — same chrome as a regular bucket header,
// but the right slot carries a plus button instead of a count chip.
// `data-action="new-workspace"` is what the sidebar click delegate
// dispatches on; the chip's title gives the affordance a tooltip
// mirroring the "Delete current" button below.
const WORKSPACE_PLUS_ICON = html`<svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M8 3.5v9M3.5 8h9"/></svg>`
function workspaceHeaderTemplate(count) {
  return html`<li class="file-group-header workspace-header"><span class="group-label">Workspaces</span><span class="workspace-header-actions"><button type="button" class="workspace-add" data-action="new-workspace" title="Create a new workspace" aria-label="Create a new workspace">${WORKSPACE_PLUS_ICON}</button><span class="group-count">${count}</span></span></li>`
}

// Packages + Repositories live as compact icon buttons to the right of
// the sidebar search (see index.html), not as in-list section headers.
// Each button is `hidden` while its index is empty (nothing to navigate
// to) and gets `.active` when its view is the current one — mirrors the
// `.current` highlight a file row picks up while its file is loaded.
function renderViewButton(id, count, viewName) {
  const btn = document.querySelector(id)
  if (!btn) return
  btn.hidden = count === 0
  btn.classList.toggle('active', state.currentView === viewName)
  const badge = btn.querySelector('.view-btn-count')
  if (badge) badge.textContent = String(count)
}

function bundlesHeaderTemplate(count) {
  // Plain label — not a navigation target. The section is an
  // always-expanded category for bundles that don't belong to any
  // workspace, so there's nothing for a click to switch to.
  // `data-default-bundles` flags the header as the unfiled-bundle
  // drop target — same role `data-default-reports` plays for the
  // Reports header. The dragover handler lights it up when a bundle
  // is dragged outside any workspace block; the drop handler then
  // routes to setBundleWorkspace(integrity, null).
  return html`<li class="file-group-header bundles-header" data-default-bundles="true">
    <span class="group-label">Bundles</span>${count > 0 ? html`<span class="group-count">${count}</span>` : nothing}
  </li>`
}

// Generic bundle glyph — a 3D box / package outline. Stroke-based
// (uses currentColor) rather than the `.file-icon.brand-*` filled
// stickers that mark report buckets, so bundles read as a distinct
// kind of artifact in the same column. Sized to match the other
// 14px row icons; picks up `--muted` / `--text` through the shared
// `.file-icon` rule in sidebar.css.
const BUNDLE_ICON = html`<svg class="file-icon" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2 2 5v6l6 3 6-3V5L8 2Z"/><path d="M2 5l6 3 6-3"/><path d="M8 8v6"/></svg>`

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
  ><button type="button" class="file-name" data-tooltip=${name}>${BUNDLE_ICON}<span class="file-label">${name}</span></button></li>`
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

const WORKSPACE_ICON = html`<svg class="file-icon" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2.5" y="4" width="11" height="9" rx="1.2"/><path d="M6 4V3h4v1"/></svg>`
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
function workspaceItemTemplate(w, presentCount, missingCount = 0) {
  const isCurrent = state.currentWorkspace === w.id
    && (state.currentView === 'findings' || state.currentView === 'files')
  const cls = `file-item workspace-item${isCurrent ? ' current' : ''}`
  // Count chip shows the count of locally-resolvable items
  // (reports-on-disk + bundles-on-disk). Missing bundles are surfaced
  // as a parenthetical "+N" suffix when present, so the badge reads
  // "5 +2" — five items the user can act on, two pointers to bundles
  // they don't have. Without the split, a 1-present / 4-missing
  // workspace would advertise "5" while only 1 row is interactive.
  // Clicking the workspace's main button loads every report in the
  // workspace into a single merged view (handled by the `.file-item`
  // click delegate against the dataset.workspaceId). The
  // hover-revealed download exports the workspace as a `.gz` bundle.
  // The .file-label uses a `.textContent` property binding instead
  // of a child interpolation because the dblclick inline-rename
  // handler (below) clears `labelSpan.textContent` and appends an
  // <input> as the temporary edit affordance. A child interpolation
  // would emit Lit marker comments around the text, and clearing
  // textContent would wipe those markers — the next renderSidebar
  // (which always runs on rename commit/cancel) would then crash
  // inside Lit's `_commitText`. The property binding keeps no
  // marker comments inside the span; the inline mutation becomes
  // a plain overwrite that the next render reapplies.
  // Hover-revealed actions on the right side of the row (in row
  // order): Share by link, Export (download .gz bundle), then Leave
  // (drop the workspace from THIS browser — entry, OPFS reports,
  // persisted triage base — without touching the server's chain,
  // so peers and your other devices keep their copy). The eventual
  // server-side "delete the chain too" affordance lives elsewhere
  // (TBD) — we don't park a placeholder trash icon here because
  // that misreads as "Delete is the same action as Leave, just
  // greyed out".
  // When `presentCount === 0 && missingCount > 0`, show just "+N"
  // instead of "0 +N" — the leading zero reads as "0 items, plus 2"
  // which is mildly confusing when the workspace has no interactive
  // rows at all. The hover title still carries the precise count.
  const missingTitle = `${missingCount} bundle pointer${missingCount === 1 ? '' : 's'} not present on this device`
  const countLabel = missingCount > 0
    ? (presentCount > 0
      ? html`${presentCount}<span class="workspace-count-missing" title=${missingTitle}> +${missingCount}</span>`
      : html`<span class="workspace-count-missing" title=${missingTitle}>+${missingCount}</span>`)
    : html`${presentCount}`
  return html`<li class=${cls} data-workspace-id=${w.id}><button type="button" class="file-name">${WORKSPACE_ICON}<span class="file-label" .textContent=${w.name}></span></button><button type="button" class="workspace-share" data-action="share-workspace" title="Share by link" aria-label="Share workspace by link">${WORKSPACE_SHARE_ICON}</button><button type="button" class="workspace-export" data-action="export-workspace" title="Export workspace" aria-label="Export workspace">${WORKSPACE_EXPORT_ICON}</button><button type="button" class="workspace-leave" data-action="leave-workspace" title="Leave workspace" aria-label="Leave workspace">${WORKSPACE_LEAVE_ICON}</button>${presentCount > 0 || missingCount > 0 ? html`<span class="file-count workspace-count">${countLabel}</span>` : nothing}</li>`
}

function matchesSearch(name) {
  if (!searchQuery) return true
  return displayName(name).toLowerCase().includes(searchQuery)
}

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
  // The sidebar always shows now — Workspaces is a first-class feature
  // and its "+" button must be reachable on first launch (before any
  // report or workspace exists). The drop zone still owns the welcome
  // copy in main; the sidebar just exposes the create-workspace
  // affordance alongside.
  sidebar.classList.remove('empty')

  // Reports already claimed by a workspace render INSIDE that workspace
  // and are dropped from the default buckets. Stale entries (a workspace
  // referencing a report that no longer exists in OPFS) are ignored at
  // render time — they round-trip in the JSON until a setReportWorkspace
  // call rewrites the list and prunes them.
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
    if (w.reports.some((r) => nameSet.has(r) && matchesSearch(r))) return true
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
    ${workspaceHeaderTemplate(visibleWorkspaces.length)}
    ${repeat(visibleWorkspaces, (w) => w.id, (w) => {
      const visibleReports = w.reports.filter((r) => nameSet.has(r) && matchesSearch(r))
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
      const presentCount = visibleReports.length + presentBundles.length
      return html`
        ${workspaceItemTemplate(w, presentCount, missingBundles.length)}
        ${visibleReports.map((r) => fileItemTemplate(r, { indented: true, workspaceId: w.id }))}
        ${presentBundles.map((b) => bundleItemTemplate(b, { workspaceId: w.id }))}
        ${missingBundles.map((integ) => missingBundleItemTemplate(integ, w.id))}
      `
    })}
    ${GROUP_ORDER.map((g) => {
      const list = buckets.get(g) ?? []
      const isDefault = g === 'default'
      if (list.length === 0 && !(isDefault && isDraggingReport)) return null
      return html`
        ${groupHeaderTemplate(GROUP_LABELS[g] ?? g, list.length, { dropTarget: isDefault })}
        ${list.map((n) => fileItemTemplate(n))}
      `
    })}
    ${unfiledBundles.length > 0 || isDraggingBundle ? bundlesHeaderTemplate(unfiledBundles.length) : null}
    ${repeat(unfiledBundles, (b) => b.integrity, (b) => bundleItemTemplate(b))}
  `, fileList)

  // Packages + Repositories navigation lives in the search row, not in
  // #file-list — update those buttons here so visibility + counts +
  // active-view highlight track the same render pass.
  renderViewButton('#show-packages-btn', countLoadedPackages(), 'packages')
  renderViewButton('#show-repositories-btn', countLoadedRepositories(), 'repositories')

  const deleteBtn = document.querySelector('#delete-current')
  if (deleteBtn) deleteBtn.disabled = !state.currentFile

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
sidebar.addEventListener('click', async (e) => {
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
    state.bundleDetailsTab = 'packages'
    graph2.showAll = true
    state.shownTriage = null
    persistLastBundle(integrity)
    render()
    renderSidebar()
    openBundle(integrity)
    return
  }
  if (e.target.closest('[data-action="show-packages"]')) {
    state.currentView = 'packages'
    render()
    renderSidebar()
    return
  }
  if (e.target.closest('[data-action="show-repositories"]')) {
    state.currentView = 'repositories'
    render()
    renderSidebar()
    return
  }
  if (e.target.closest('[data-action="new-workspace"]')) {
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
      // Round-1 review #1: `analyzeTriageImpact` now propagates
      // OPFS errors instead of silently treating every overlap
      // as orphaned. Refuse to open the dialog rather than show
      // a wrong "wipe N orphans" count — the user can retry
      // once OPFS settles.
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
    // Round-1 review #3: a sibling tab may have deleted the
    // workspace while our dialog was open. The cached `ws`
    // here is the snapshot we showed the user; re-resolve
    // against the live blob and surface "already gone" rather
    // than silently no-op'ing inside `leaveWorkspace`.
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
  if (e.target.closest('#delete-current')) {
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
      // Round-1 review #1: a transient OPFS error must not
      // silently mis-classify orphans — refuse to open the
      // dialog and let the user retry.
      alert(`Couldn't read reports to analyze triage impact: ${err.message}`)
      return
    }
    // Workspace + remote presence for the deletion dialog: if
    // the report is in this workspace's remote objstore inventory
    // we surface a notice + auto-elect to delete it there too,
    // because a local-only delete would race the next workspace
    // open's auto-download and resurrect the file.
    const owningWorkspace = listWorkspaces().find((w) => Array.isArray(w.reports) && w.reports.includes(name))
    const inRemote = owningWorkspace ? isInRemote(owningWorkspace.id, name) : false
    const { confirmed, triage, deleteFromRemote } = await openDeleteReportDialog({ name, triageImpact, inRemote })
    if (!confirmed) return
    // Round-1 review #3: the active file may have changed under
    // us (cross-tab switch / sibling-tab delete) while the
    // dialog was open. Bail rather than deleting whatever's
    // current now — the user confirmed deletion of the file
    // shown in the dialog, not whatever just slid into place.
    if (state.currentFile !== name) {
      alert(`Active report changed during confirmation; aborting delete of "${name}".`)
      return
    }
    try { await deleteCurrent({ triage, deleteFromRemote: deleteFromRemote ? owningWorkspace?.id : null }) }
    catch (err) { alert(`Failed to delete report: ${err.message}`) }
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
  if (e.target.closest('#sidebar-toggle')) {
    sidebar.classList.toggle('collapsed')
    try { localStorage.setItem('deepview.sidebarCollapsed', sidebar.classList.contains('collapsed') ? '1' : '0') } catch {}
  }
})

// Instant tooltip for truncated sidebar names. A single shared element
// is appended to <body> and repositioned on each hover, replacing the
// native title-attribute tooltip which has a browser-imposed delay.
// Only appears when the .file-label text is actually truncated
// (scrollWidth > clientWidth), so non-truncated names stay quiet.
const _sidebarTip = document.createElement('div')
_sidebarTip.id = 'sidebar-tooltip'
document.body.append(_sidebarTip)

let _tipTarget = null
let _tipTimer = null

function _showSidebarTip(el) {
  _sidebarTip.textContent = el.dataset.tooltip
  const rect = el.getBoundingClientRect()
  _sidebarTip.style.top = `${Math.round(rect.top + rect.height / 2)}px`
  _sidebarTip.style.left = `${Math.round(rect.right + 8)}px`
  _sidebarTip.classList.add('visible')
  _tipTarget = el
}

function _hideSidebarTip() {
  clearTimeout(_tipTimer)
  _tipTimer = null
  _sidebarTip.classList.remove('visible')
  _tipTarget = null
}

fileList.addEventListener('mouseover', (e) => {
  const el = e.target.closest('[data-tooltip]')
  if (el === _tipTarget) return
  _hideSidebarTip()
  if (!el) return
  const label = el.querySelector('.file-label')
  if (label && label.scrollWidth <= label.clientWidth) return
  _tipTimer = setTimeout(() => { _showSidebarTip(el) }, 100)
})

fileList.addEventListener('mouseout', (e) => {
  if (!_tipTarget && !_tipTimer) return
  if (_tipTarget && _tipTarget.contains(e.relatedTarget)) return
  _hideSidebarTip()
})

const searchInput = document.querySelector('#sidebar-search-input')
if (searchInput) {
  searchInput.addEventListener('input', (e) => {
    searchQuery = e.target.value.trim().toLowerCase()
    renderSidebar()
  })
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
  // Any workspace, with or without attached reports. The previous
  // gate required reports.length > 0 — which hid the button on a
  // freshly-attached share-link workspace and prevented the user
  // from seeing the sender's triage land before they'd added
  // their own reports.
  return listWorkspaces().length > 0
}

function renderSyncStatus(status) {
  const btn = document.querySelector('#sync-status')
  if (!btn) return
  const visible = syncButtonVisible()
  // Auto-prime the default sync URL the first time any workspace
  // exists — workspaces opt the user into sync (unattached reports
  // stay local-only), so the offline → online flip shouldn't
  // require a separate sidebar click. Skipped when the user has
  // explicitly turned sync off via the status button (`isEnabled()`
  // reads the persisted toggle, default true) or when a custom URL
  // is already configured via the console API.
  if (visible && !triageSync.getServerUrl() && DEFAULT_SYNC_URL && triageSync.isEnabled()) {
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
  const label = btn.querySelector('.sync-label')
  if (label) label.textContent = SYNC_LABELS[s] ?? ''
}
renderSyncStatus(triageSync.status)
triageSync.onStatusChange(renderSyncStatus)

// Double-click a workspace row → inline rename. Replaces the label
// span with an <input> on the fly; Enter or blur commits, Escape
// reverts. The row's other affordances (open / export / drop
// targets) stay live but a re-render after commit/revert paints
// fresh chrome anyway. Imperative DOM swap rather than a state flag
// because the edit is a one-off, scoped to a single row.
sidebar.addEventListener('dblclick', (e) => {
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
})

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
  for (const el of sidebar.querySelectorAll('.drag-over')) el.classList.remove('drag-over')
}

// Did this drag carry one of OUR mime types? Used by every drag
// handler to filter out OS file drags and unrelated browser drags
// (text selections, links) so the document-level ingest handler still
// handles them.
function dragHasOurPayload(e) {
  return e.dataTransfer.types.includes(REPORT_DT)
    || e.dataTransfer.types.includes(BUNDLE_DT)
}

sidebar.addEventListener('dragstart', (e) => {
  // Bundle rows match BOTH `.file-item[data-file]` (no — they don't
  // carry data-file) and `.file-item[data-bundle-integrity]`, so the
  // bundle branch goes first. Reports carry data-file; bundles carry
  // data-bundle-integrity; an element never carries both.
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
    // bucket. (Review L1 follow-up.)
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
})

sidebar.addEventListener('dragend', () => {
  for (const el of sidebar.querySelectorAll('.dragging')) el.classList.remove('dragging')
  clearDragOver()
  if (isDraggingReport || isDraggingBundle) {
    isDraggingReport = false
    isDraggingBundle = false
    renderSidebar()
  }
})

sidebar.addEventListener('dragover', (e) => {
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
  const sourceWsId = sidebar.querySelector('.dragging')?.closest('[data-workspace-id]')?.dataset.workspaceId ?? null
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
    for (const el of sidebar.querySelectorAll(`[data-workspace-id="${CSS.escape(wsId)}"]`)) {
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
    const indicator = sidebar.querySelector(selector)
    if (indicator) indicator.classList.add('drag-over')
  }
})

sidebar.addEventListener('dragleave', (e) => {
  // Only clear if we've left the sidebar entirely — internal moves
  // between target / non-target elements re-trigger dragover and
  // re-paint the highlight.
  if (!sidebar.contains(e.relatedTarget)) clearDragOver()
})

sidebar.addEventListener('drop', async (e) => {
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
    // Note: unlike the report path we DON'T call any remote-delete
    // here; bundles are content-addressed and may be shared across
    // workspaces / devices, so dragging a bundle out of one
    // workspace must not drop the remote copy. Explicit deletion
    // lives on the bundle row's Delete affordance, not as a side
    // effect of drag-out.
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
  // `deleteRemote` opens the source workspace's presence session
  // on demand if it isn't already active (review r3251765881) —
  // a synchronous `isInRemote` pre-check would silently no-op
  // when dragging from a non-active workspace. The remote
  // delete is idempotent on missing rows, so issuing it for a
  // file that wasn't in remote is a free no-op.
  if (sourceWsId && sourceWsId !== targetId) {
    try { await deleteRemote(sourceWsId, filename) }
    catch (err) { console.warn(`Failed to remove '${filename}' from source workspace ${sourceWsId} remote:`, err) }
  }
  if (targetId) await addReportToWorkspace(filename, targetId)
  if (sourceWsId && sourceWsId !== targetId) await removeReportFromWorkspace(filename, sourceWsId)
  renderSidebar()
})
