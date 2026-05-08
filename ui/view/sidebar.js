import { html, render as litRender, nothing } from 'lit'
import { unsafeHTML } from 'lit/directives/unsafe-html.js'
import { state } from './state.js'
import { sidebar, fileList } from './dom.js'
import { listFiles } from './storage.js'
import { switchToFile, switchToWorkspace, deleteCurrent } from './ingest.js'
import { getCount, ensureCounts } from './counts.js'
import { listWorkspaces, createWorkspace, setReportWorkspace, renameWorkspace } from './workspaces.js'
import { migrateLegacyFilenames } from './migrate-legacy.js'
import { exportWorkspace } from './workspace-export.js'
import { FILE_ICONS, displayName, groupOf } from './file-display.js'
import { triageSync } from './triage-sync.js'

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
  const cls = `file-item${n === state.currentFile ? ' current' : ''}${opts.indented ? ' indented' : ''}`
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
  ><button type="button" class="file-name" title=${label}>${unsafeHTML(iconHtml)}<span class="file-label">${label}</span>${count !== undefined ? html`<span class="file-count">${count}</span>` : nothing}</button></li>`
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

const WORKSPACE_ICON = html`<svg class="file-icon" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2.5" y="4" width="11" height="9" rx="1.2"/><path d="M6 4V3h4v1"/></svg>`
// Download glyph used by the per-workspace export button — a
// downward arrow over a tray. Sized to match the "+" affordance in
// the section header.
const WORKSPACE_EXPORT_ICON = html`<svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2v8M5 7l3 3 3-3M3 13h10"/></svg>`
function workspaceItemTemplate(w, reportCount) {
  const isCurrent = state.currentWorkspace === w.id
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
  const names = await listFiles()
  const workspaces = listWorkspaces()
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
    if (id && id !== state.currentWorkspace) switchToWorkspace(id)
    return
  }
  const fileEl = e.target.closest('.file-item[data-file]')
  if (fileEl) {
    const name = fileEl.dataset.file
    if (name && name !== state.currentFile) switchToFile(name)
    return
  }
  if (e.target.closest('#delete-current')) {
    deleteCurrent()
    return
  }
  if (e.target.closest('#sync-status')) {
    // Toggle sync between off and the default localhost endpoint.
    // The triageSync module persists the last URL, so a re-toggle
    // on later loads picks up whatever was set most recently.
    if (triageSync.status === 'off') triageSync.setServerUrl(DEFAULT_SYNC_URL)
    else triageSync.setServerUrl('')
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
}
const SYNC_TITLES = {
  off: 'Sync off — click to enable',
  online: 'Online — click to disable sync',
  offline: 'Offline (reconnecting) — click to disable sync',
  connecting: 'Connecting (waiting for server) — click to disable sync',
}

function syncButtonVisible() {
  const usableUrl = triageSync.getServerUrl() || DEFAULT_SYNC_URL
  if (!usableUrl) return false
  return listWorkspaces().some((w) => w.reports.length > 0)
}

function renderSyncStatus(status) {
  const btn = document.getElementById('sync-status')
  if (!btn) return
  if (!syncButtonVisible()) {
    btn.hidden = true
    // The displayed "no button" state has to mean sync IS off — a
    // configured-but-unreachable session would otherwise keep
    // ticking invisibly. setServerUrl('') here also drops the
    // saved URL; the next time the button becomes visible it
    // starts from the per-origin default. Skip the call when
    // status is already 'off' to avoid a no-op write that the
    // status listener would echo back into us.
    if (triageSync.status !== 'off') triageSync.setServerUrl('')
    return
  }
  btn.hidden = false
  const s = status ?? triageSync.status
  btn.dataset.status = s
  btn.title = SYNC_TITLES[s] ?? ''
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
