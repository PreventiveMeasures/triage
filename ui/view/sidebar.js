import { state } from './state.js'
import { sidebar, fileList } from './dom.js'
import { esc } from './format.js'
import { listFiles } from './storage.js'
import { switchToFile, deleteCurrent } from './ingest.js'
import { getCount, ensureCounts } from './counts.js'
import { listWorkspaces, createWorkspace, setReportWorkspace } from './workspaces.js'

// dataTransfer mime used by intra-sidebar drag-and-drop. The value is
// the report's filename. We carry both this private mime AND
// text/plain so browsers that drop the private mime in cross-frame
// scenarios still have a fallback payload — the type-check below
// uses the private mime so OS file drags (which only carry Files)
// don't accidentally match.
const REPORT_DT = 'application/x-deepview-report'

// Sidebar source-grouping. Each known finding-source format gets its
// own bucket; the JSON bucket renders under "Reports" since that's
// the analyzer's native dump format. Files are grouped by extension
// as a cheap, sync proxy for format detection — `listFiles` only
// returns names, and reading every file just to peek at the format
// on each sidebar render would be wasteful.
function groupOf(name) {
  const lower = name.toLowerCase()
  if (lower.endsWith('.deepseek')) return 'deepseek'
  if (lower.endsWith('.codex')) return 'codex-security'
  if (lower.endsWith('.md')) return 'claude-security'
  return 'default'
}

// Section header label per group. The default JSON bucket renders
// under "Reports" — broad enough to fit any analyzer-native dump
// (deduplicate output, single-run output, etc.) without naming the
// pipeline. Named buckets carry the upstream's product name. The
// `'deepseek'` group key is a legacy internal marker (the parser /
// `.deepseek` extension predate the corrected name) — the upstream
// product is Vercel's DeepSec (https://github.com/vercel-labs/deepsec).
const GROUP_LABELS = {
  'default': 'Reports',
  'claude-security': 'Claude Security',
  'codex-security': 'Codex Security',
  'deepseek': 'DeepSec',
}

// Render order for buckets — default (analyzer dumps) first, then
// named sources in alphabetical-ish reading order.
const GROUP_ORDER = ['default', 'claude-security', 'codex-security', 'deepseek']

// Filename-to-label transform for the bucket-marker suffixes ingest
// stamps on at drop time. `.codex` filenames are derived (e.g.
// `org__repo:scan-suffix.codex`) — un-sanitize the slashes and strip
// the suffix for the visible label so the sidebar reads as the
// original `org/repo:scan-suffix`. `.deepseek` is a renamed `.md`
// drop — strip the marker so the user sees the natural filename.
function displayName(name) {
  const lower = name.toLowerCase()
  if (lower.endsWith('.codex')) return name.slice(0, -'.codex'.length).replace(/__/gu, '/')
  if (lower.endsWith('.deepseek')) return name.slice(0, -'.deepseek'.length)
  return name
}

// Inline `<svg>` for the file-row icon. Outline file-page glyph at
// 14px to match the chrome's other icon buttons. Source-marked
// groups overlay a small brand badge (Anthropic sparkle for Claude
// Security, OpenAI hex for Codex Security, Vercel triangle for
// DeepSec) in the lower-right corner of the file outline; the badge
// fills are themed via the `.brand-claude` / `.brand-codex` /
// `.brand-vercel` classes in sidebar.css. The default JSON bucket
// keeps the plain outline. Re-baked into each row's HTML rather
// than referenced by id so a single `innerHTML` write paints the
// whole list.
const FILE_OUTLINE = '<g fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 2h6l4 4v8H3z"/><path d="M9 2v4h4"/></g>'
const FILE_ICONS = {
  'default': `<svg class="file-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">${FILE_OUTLINE}</svg>`,
  'claude-security': `<svg class="file-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">${FILE_OUTLINE}<path class="brand-claude" d="M11 9.8 L11.5 11 L12.7 11.5 L11.5 12 L11 13.2 L10.5 12 L9.3 11.5 L10.5 11 Z"/></svg>`,
  'codex-security': `<svg class="file-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">${FILE_OUTLINE}<path class="brand-codex" d="M11 9.8 L12.5 10.65 L12.5 12.35 L11 13.2 L9.5 12.35 L9.5 10.65 Z"/></svg>`,
  'deepseek': `<svg class="file-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">${FILE_OUTLINE}<path class="brand-vercel" d="M11 10 L12.7 13 L9.3 13 Z"/></svg>`,
}

// Live module state — the search-box query, applied as a
// case-insensitive substring match on each file's display name.
// Cleared by switchToFile / deleteCurrent indirectly (a fresh render
// starts from this same value), so users can switch files without
// losing their search.
let searchQuery = ''

function fileItemHtml(n, opts = {}) {
  const indented = opts.indented ? ' indented' : ''
  const cls = `file-item${n === state.currentFile ? ' current' : ''}${indented}`
  const label = displayName(n)
  const count = getCount(n)
  const countHtml = count !== undefined ? `<span class="file-count">${count}</span>` : ''
  const icon = FILE_ICONS[groupOf(n)] ?? FILE_ICONS.default
  // Indented rows live inside a workspace; carry the workspace id so a
  // drop onto one of these is treated as "assign to this workspace"
  // (which is idempotent if it's the report's current home, and a
  // move when it isn't). Top-level rows have no workspace attribute,
  // so dropping onto them is treated as "outside any workspace" and
  // falls through to the unfiled-section drop target.
  const wsAttr = opts.workspaceId ? ` data-workspace-id="${esc(opts.workspaceId)}"` : ''
  return `<li class="${cls}" data-file="${esc(n)}"${wsAttr} draggable="true"><button type="button" class="file-name" title="${esc(label)}">${icon}<span class="file-label">${esc(label)}</span>${countHtml}</button></li>`
}

function groupHeaderHtml(label, count, opts = {}) {
  const extraClass = opts.dropTarget ? ' default-reports' : ''
  const dataAttr = opts.dropTarget ? ' data-default-reports="true"' : ''
  return `<li class="file-group-header${extraClass}"${dataAttr}><span class="group-label">${esc(label)}</span><span class="group-count">${count}</span></li>`
}

// Workspaces section header — same chrome as a regular bucket header,
// but the right slot carries a plus button instead of a count chip.
// `data-action="new-workspace"` is what the sidebar click delegate
// dispatches on; the chip's title gives the affordance a tooltip
// mirroring the "Delete current" button below.
const WORKSPACE_PLUS_ICON = '<svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M8 3.5v9M3.5 8h9"/></svg>'
function workspaceHeaderHtml(count) {
  return `<li class="file-group-header workspace-header"><span class="group-label">Workspaces</span><span class="workspace-header-actions"><span class="group-count">${count}</span><button type="button" class="workspace-add" data-action="new-workspace" title="Create a new workspace" aria-label="Create a new workspace">${WORKSPACE_PLUS_ICON}</button></span></li>`
}

const WORKSPACE_ICON = '<svg class="file-icon" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2.5" y="4" width="11" height="9" rx="1.2"/><path d="M6 4V3h4v1"/></svg>'
function workspaceItemHtml(w, reportCount) {
  const countHtml = reportCount > 0 ? `<span class="file-count">${reportCount}</span>` : ''
  return `<li class="file-item workspace-item" data-workspace-id="${esc(w.id)}"><button type="button" class="file-name" title="${esc(w.name)}">${WORKSPACE_ICON}<span class="file-label">${esc(w.name)}</span>${countHtml}</button></li>`
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

  let html = ''
  // Workspaces above Reports. The header itself is filtered by name;
  // each workspace's own reports are filtered too so a name search
  // surfaces matches inside workspaces without the parent disappearing.
  const visibleWorkspaces = workspaces.filter((w) => {
    if (!searchQuery) return true
    if (w.name.toLowerCase().includes(searchQuery)) return true
    return w.reports.some((r) => nameSet.has(r) && matchesSearch(r))
  })
  html += workspaceHeaderHtml(visibleWorkspaces.length)
  for (const w of visibleWorkspaces) {
    const visibleReports = w.reports.filter((r) => nameSet.has(r) && matchesSearch(r))
    html += workspaceItemHtml(w, visibleReports.length)
    for (const r of visibleReports) html += fileItemHtml(r, { indented: true, workspaceId: w.id })
  }

  // Default buckets — render unfiled reports under their format header.
  // The Reports (default JSON) header is also a drop target for "remove
  // from workspace": dropping a workspace-internal report there detaches
  // it back to the unfiled list. When no unfiled JSON reports exist but
  // some workspace has reports, we still render the Reports header (with
  // count 0) so the unassign affordance stays reachable.
  const anyWorkspaceHasReports = workspaces.some((w) => w.reports.some((r) => nameSet.has(r)))
  for (const g of GROUP_ORDER) {
    const list = buckets.get(g) ?? []
    const isDefault = g === 'default'
    if (list.length === 0 && !(isDefault && anyWorkspaceHasReports)) continue
    html += groupHeaderHtml(GROUP_LABELS[g] ?? g, list.length, { dropTarget: isDefault })
    for (const n of list) html += fileItemHtml(n)
  }
  fileList.innerHTML = html

  const deleteBtn = document.getElementById('delete-current')
  if (deleteBtn) deleteBtn.disabled = !state.currentFile

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
