import { state } from './state.js'
import { sidebar, fileList } from './dom.js'
import { esc } from './format.js'
import { listFiles } from './storage.js'
import { switchToFile, deleteCurrent } from './ingest.js'
import { getCount, ensureCounts } from './counts.js'

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
// pipeline. Named buckets carry the upstream's product name.
const GROUP_LABELS = {
  'default': 'Reports',
  'claude-security': 'Claude Security',
  'codex-security': 'Codex Security',
  'deepseek': 'DeepSeek',
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
// 14px to match the chrome's other icon buttons. Re-baked into each
// row's HTML rather than referenced by id so a single `innerHTML`
// write paints the whole list.
const FILE_ICON_SVG = '<svg class="file-icon" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 2h6l4 4v8H3z"/><path d="M9 2v4h4"/></svg>'

// Live module state — the search-box query, applied as a
// case-insensitive substring match on each file's display name.
// Cleared by switchToFile / deleteCurrent indirectly (a fresh render
// starts from this same value), so users can switch files without
// losing their search.
let searchQuery = ''

function fileItemHtml(n) {
  const cls = `file-item${n === state.currentFile ? ' current' : ''}`
  const label = displayName(n)
  const count = getCount(n)
  const countHtml = count !== undefined ? `<span class="file-count">${count}</span>` : ''
  return `<li class="${cls}" data-file="${esc(n)}"><button type="button" class="file-name" title="${esc(label)}">${FILE_ICON_SVG}<span class="file-label">${esc(label)}</span>${countHtml}</button></li>`
}

function groupHeaderHtml(label, count) {
  return `<li class="file-group-header"><span class="group-label">${esc(label)}</span><span class="group-count">${count}</span></li>`
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
  sidebar.classList.toggle('empty', names.length === 0 && !state.currentFile)

  // Bucket by group, applying the search filter as we go so empty
  // post-filter groups skip their header entirely.
  const buckets = new Map()
  for (const g of GROUP_ORDER) buckets.set(g, [])
  for (const n of names) {
    if (!matchesSearch(n)) continue
    const g = groupOf(n)
    if (!buckets.has(g)) buckets.set(g, [])
    buckets.get(g).push(n)
  }

  let html = ''
  for (const g of GROUP_ORDER) {
    const list = buckets.get(g) ?? []
    if (list.length === 0) continue
    html += groupHeaderHtml(GROUP_LABELS[g] ?? g, list.length)
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
// input.
sidebar.addEventListener('click', (e) => {
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
