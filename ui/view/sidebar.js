import { html, render as litRender, nothing } from 'lit'
import { unsafeHTML } from 'lit/directives/unsafe-html.js'
import { state } from '../../client/state.js'
import { fileList, sidebar } from './dom.js'
import { listBundles, listFiles } from '../../client/storage.js'
import { render } from './render.js'
import { deleteCurrent, switchToFile, switchToWorkspace } from './ingest.js'
import { ensureCounts, getCount } from '../../client/counts.js'
import { createWorkspace, listWorkspaces, renameWorkspace, setReportWorkspace } from '../../client/workspaces.js'
import { migrateLegacyFilenames } from '../../client/migrate-legacy.js'
import { exportWorkspace } from './workspace-export.js'
import { FILE_ICONS, displayName, groupOf } from './file-display.js'
import { triageSync } from '../../client/triage-sync.js'
import { ensureBundleFindingsIndexed, getPackagesIndex } from '../../client/bundle-finding-index.js'

// Distinct package count across every report the OPFS finding
// index has scanned (NOT just state.reports — Packages aggregates
// across the user's entire drop history, not just what's loaded).
// Cheap walk; sidebar renders aren't on the hot path.
function countLoadedPackages() {
  return getPackagesIndex().size
}

// Default sync endpoint used when the user toggles the sidebar
// status button on. Only populated for pages served from
// `127.0.0.1` — production origins keep this empty so the button
// can't accidentally point at a localhost server that isn't
// reachable from there. A user who wants to point a non-localhost
// page at some other server can still call
// `DeepView.triageSync.setServerUrl('wss://…')` from the console;
// the `null`-default just means there's no toggle-on target by
// default.
const DEFAULT_SYNC_URL = (typeof location !== 'undefined' && location.hostname === '127.0.0.1')
  ? 'ws://127.0.0.1:8765'
  : ''

// dataTransfer mime used by intra-sidebar drag-and-drop. The value is
// the report's filename. We carry both this private mime AND
// text/plain so browsers that drop the private mime in cross-frame
// scenarios still have a fallback payload — the type-check below
// uses the private mime so OS file drags (which only carry Files)
// don't accidentally match.
const REPORT_DT = 'application/x-deepview-report'

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
  ><button type="button" class="file-name" title=${label}>${unsafeHTML(iconHtml)}<span class="file-label">${label}</span>${count === undefined ? nothing : html`<span class="file-count">${count}</span>`}</button></li>`
}

function groupHeaderTemplate(label, count, opts = {}) {
  const cls = `file-group-header${opts.dropTarget ? ' default-reports' : ''}`
  return html`<li
    class=${cls}
    data-default-reports=${opts.dropTarget ? 'true' : nothing}
  ><span class="group-label">${label}</span><span class="group-count">${count}</span></li>`
}

// Workspaces section header — same chrome as a regular bucket header,
// but the right slot carries a plus button instead of a count chip.
// `data-action="new-workspace"` is what the sidebar click delegate
// dispatches on; the chip's title gives the affordance a tooltip
// mirroring the "Delete current" button below.
const WORKSPACE_PLUS_ICON = html`<svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M8 3.5v9M3.5 8h9"/></svg>`
function workspaceHeaderTemplate(count) {
  return html`<li class="file-group-header workspace-header"><span class="group-label">Workspaces</span><span class="workspace-header-actions"><span class="group-count">${count}</span><button type="button" class="workspace-add" data-action="new-workspace" title="Create a new workspace" aria-label="Create a new workspace">${WORKSPACE_PLUS_ICON}</button></span></li>`
}

// Bundles section header — collapsed to a single "BUNDLES (N)"
// strip; clicking it switches the main view to a list of every
// bundle stored in OPFS. Hidden entirely when no bundles have been
// dropped (the user otherwise has nothing to navigate to). The
// `data-action="show-bundles"` is the click delegate's hook.
// Packages section header — collapsed to a single "PACKAGES (N)"
// strip, sitting under the bundles entry. Clicking it switches to
// a cross-report view that aggregates findings by package
// (extracted from each finding's file path the way the graph's
// `packageOf` does). Hidden when no reports are loaded — there's
// nothing to aggregate. The `data-action="show-packages"` is the
// click delegate's hook.
function packagesHeaderTemplate(count) {
  const cls = `file-group-header packages-header${state.currentView === 'packages' ? ' current' : ''}`
  return html`<li class=${cls} data-action="show-packages" role="button" tabindex="0" title="Show packages">
    <span class="group-label">Packages</span><span class="group-count">${count}</span>
  </li>`
}

function bundlesHeaderTemplate(count) {
  // Mark the row "current" while the bundles view is up so the
  // sidebar reads as "you're here" — mirrors how a file row picks
  // up the .current class while its file is loaded.
  const cls = `file-group-header bundles-header${state.currentView === 'bundles' ? ' current' : ''}`
  return html`<li class=${cls} data-action="show-bundles" role="button" tabindex="0" title="Show bundles">
    <span class="group-label">Bundles</span><span class="group-count">${count}</span>
  </li>`
}

const WORKSPACE_ICON = html`<svg class="file-icon" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2.5" y="4" width="11" height="9" rx="1.2"/><path d="M6 4V3h4v1"/></svg>`
// Download glyph used by the per-workspace export button — a
// downward arrow over a tray. Sized to match the "+" affordance in
// the section header.
const WORKSPACE_EXPORT_ICON = html`<svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2v8M5 7l3 3 3-3M3 13h10"/></svg>`
function workspaceItemTemplate(w, reportCount) {
  const isCurrent = state.currentWorkspace === w.id
    && (state.currentView === 'findings' || state.currentView === 'files')
  const cls = `file-item workspace-item${isCurrent ? ' current' : ''}`
  // Clicking the workspace's main button loads every report in the
  // workspace into a single merged view (handled by the `.file-item`
  // click delegate against the dataset.workspaceId). The
  // hover-revealed download exports the workspace as a `.gz` bundle.
  return html`<li class=${cls} data-workspace-id=${w.id}><button type="button" class="file-name" title=${w.name}>${WORKSPACE_ICON}<span class="file-label">${w.name}</span></button><button type="button" class="workspace-export" data-action="export-workspace" title="Export workspace" aria-label="Export workspace">${WORKSPACE_EXPORT_ICON}</button>${reportCount > 0 ? html`<span class="file-count workspace-count">${reportCount}</span>` : nothing}</li>`
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
  // each workspace's own reports are filtered too so a name search
  // surfaces matches inside workspaces without the parent disappearing.
  const visibleWorkspaces = workspaces.filter((w) => {
    if (!searchQuery) return true
    if (w.name.toLowerCase().includes(searchQuery)) return true
    return w.reports.some((r) => nameSet.has(r) && matchesSearch(r))
  })

  // Default buckets — render unfiled reports under their format header.
  // The Reports (default JSON) header is also a drop target for "remove
  // from workspace": dropping a workspace-internal report there detaches
  // it back to the unfiled list. When no unfiled JSON reports exist but
  // some workspace has reports, we still render the Reports header (with
  // count 0) so the unassign affordance stays reachable.
  const anyWorkspaceHasReports = workspaces.some((w) => w.reports.some((r) => nameSet.has(r)))

  litRender(html`
    ${bundleNames.length > 0 ? bundlesHeaderTemplate(bundleNames.length) : null}
    ${countLoadedPackages() > 0 ? packagesHeaderTemplate(countLoadedPackages()) : null}
    ${workspaceHeaderTemplate(visibleWorkspaces.length)}
    ${visibleWorkspaces.map((w) => {
      const visibleReports = w.reports.filter((r) => nameSet.has(r) && matchesSearch(r))
      return html`
        ${workspaceItemTemplate(w, visibleReports.length)}
        ${visibleReports.map((r) => fileItemTemplate(r, { indented: true, workspaceId: w.id }))}
      `
    })}
    ${GROUP_ORDER.map((g) => {
      const list = buckets.get(g) ?? []
      const isDefault = g === 'default'
      if (list.length === 0 && !(isDefault && anyWorkspaceHasReports)) return null
      return html`
        ${groupHeaderTemplate(GROUP_LABELS[g] ?? g, list.length, { dropTarget: isDefault })}
        ${list.map((n) => fileItemTemplate(n))}
      `
    })}
  `, fileList)

  const deleteBtn = document.getElementById('delete-current')
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

// Sidebar event delegation: file-list click switches; Delete removes
// the current file; toggle collapses / expands; search filters on
// input. The workspace "+" button intercepts BEFORE the file-row
// match because a workspace header is itself a `<li>` that contains
// no `data-file` — but the add button still bubbles to the same
// listener.
sidebar.addEventListener('click', (e) => {
  // BUNDLES header → switch the main view to the bundles list. Only
  // fires when bundles exist (the header is suppressed otherwise).
  // The bundles list lives off `state.bundles`, freshly populated by
  // the renderSidebar pass above; render() reads from it so the
  // main view paints synchronously.
  if (e.target.closest('[data-action="show-bundles"]')) {
    state.currentView = 'bundles'
    render()
    // Re-render the sidebar too so the BUNDLES header picks up
    // its `.current` highlight (and any previously-highlighted
    // file/workspace row drops back to the muted state).
    renderSidebar()
    return
  }
  if (e.target.closest('[data-action="show-packages"]')) {
    state.currentView = 'packages'
    render()
    renderSidebar()
    return
  }
  if (e.target.closest('[data-action="new-workspace"]')) {
    const name = window.prompt('Workspace name')
    if (name && name.trim()) {
      createWorkspace(name)
      renderSidebar()
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
    if (ws) exportWorkspace(ws).catch((err) => alert(`Failed to export workspace: ${err.message}`))
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
    deleteCurrent()
    return
  }
  if (e.target.closest('#sync-status')) {
    // Click toggles the persisted user-enabled flag rather than
    // the URL itself — disable then re-enable should resume against
    // the same endpoint, not lose a console-set URL. If no URL is
    // configured yet, prime it with the per-origin default
    // (currently only set for 127.0.0.1; production defaults to
    // empty and the button stays hidden until something sets one).
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

const searchInput = document.getElementById('sidebar-search-input')
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
// Visibility is gated on (a) at least one workspace having a
// non-empty `reports` array — sync is a workspace concept, no
// point in showing it before any workspace actually carries
// content — AND (b) a usable server URL existing, either because
// the user previously configured one or because the page's origin
// has a sensible default (only 127.0.0.1 today; see
// `DEFAULT_SYNC_URL` above). When either condition fails the
// button is hidden so it doesn't read as a broken affordance.
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
const SYNC_TITLES = {
  off: 'Sync off — click to enable',
  online: 'Online — click to disable sync',
  offline: 'Offline (reconnecting) — click to disable sync',
  connecting: 'Connecting (waiting for server) — click to disable sync',
  error: 'Sync error — click to retry',
}

function syncButtonVisible() {
  const usableUrl = triageSync.getServerUrl() || DEFAULT_SYNC_URL
  if (!usableUrl) return false
  return listWorkspaces().some((w) => w.reports.length > 0)
}

function renderSyncStatus(status) {
  const btn = document.getElementById('sync-status')
  if (!btn) return
  const visible = syncButtonVisible()
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
  let title = SYNC_TITLES[s] ?? ''
  if (s === 'error') {
    // Append the first errored session's message so the user sees
    // *what* broke, not just *that* something did. There's only one
    // status string per connection; with multiple sessions the
    // first one wins (typical case is anyway one workspace open).
    const firstErr = triageSync.openSessions.find((info) => info?.error)?.error
    if (firstErr) title = `${title}\n${firstErr}`
  }
  btn.title = title
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
  labelSpan.appendChild(input)
  input.focus()
  input.select()
  let done = false
  const finish = (commit) => {
    if (done) return
    done = true
    if (commit) renameWorkspace(id, input.value)
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

// Intra-sidebar drag-and-drop — move reports between workspaces and
// the unfiled list. The whole sidebar is a drop zone:
//   - drop on any element with `[data-workspace-id]` (workspace row
//     OR one of its indented children) → assign to that workspace
//   - drop anywhere else in the sidebar → detach (back to the unfiled
//     list, where the report's filename extension routes it to the
//     correct format bucket)
// The Reports header lights up as the visual affordance for the
// detach drop (when it's rendered), but the drop works regardless of
// what the cursor is over so "drag back" is forgiving.
//
// OS file drops are NOT mistaken for this: the type check below looks
// for our private mime, which only the dragstart below sets. The
// document-level drop handler in ingest.js still handles OS files
// (its `e.dataTransfer.files` check no-ops on internal drags).
function clearDragOver() {
  for (const el of sidebar.querySelectorAll('.drag-over')) el.classList.remove('drag-over')
}

sidebar.addEventListener('dragstart', (e) => {
  const fileEl = e.target.closest('.file-item[data-file]')
  if (!fileEl) return
  e.dataTransfer.effectAllowed = 'move'
  e.dataTransfer.setData(REPORT_DT, fileEl.dataset.file)
  e.dataTransfer.setData('text/plain', fileEl.dataset.file)
  fileEl.classList.add('dragging')
})

sidebar.addEventListener('dragend', () => {
  for (const el of sidebar.querySelectorAll('.dragging')) el.classList.remove('dragging')
  clearDragOver()
})

sidebar.addEventListener('dragover', (e) => {
  if (!e.dataTransfer.types.includes(REPORT_DT)) return
  e.preventDefault()
  e.dataTransfer.dropEffect = 'move'
  clearDragOver()
  const wsTarget = e.target.closest('[data-workspace-id]')
  if (wsTarget) {
    // Highlight at the workspace level so dropping on either the
    // workspace row or any of its indented children reads as the
    // same target.
    const wsId = wsTarget.dataset.workspaceId
    for (const el of sidebar.querySelectorAll(`[data-workspace-id="${CSS.escape(wsId)}"]`)) {
      el.classList.add('drag-over')
    }
  } else {
    // Anywhere outside a workspace block detaches; mark the Reports
    // header as the visible affordance when it's rendered.
    const indicator = sidebar.querySelector('[data-default-reports]')
    if (indicator) indicator.classList.add('drag-over')
  }
})

sidebar.addEventListener('dragleave', (e) => {
  // Only clear if we've left the sidebar entirely — internal moves
  // between target / non-target elements re-trigger dragover and
  // re-paint the highlight.
  if (!sidebar.contains(e.relatedTarget)) clearDragOver()
})

sidebar.addEventListener('drop', (e) => {
  if (!e.dataTransfer.types.includes(REPORT_DT)) return
  const filename = e.dataTransfer.getData(REPORT_DT)
  if (!filename) {
    clearDragOver()
    return
  }
  e.preventDefault()
  e.stopPropagation()
  clearDragOver()
  const wsTarget = e.target.closest('[data-workspace-id]')
  const targetId = wsTarget ? wsTarget.dataset.workspaceId : null
  setReportWorkspace(filename, targetId)
  renderSidebar()
})
