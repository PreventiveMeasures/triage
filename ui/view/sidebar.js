import { state } from './state.js'
import { sidebar, fileList } from './dom.js'
import { esc } from './format.js'
import { listFiles } from './storage.js'
import { switchToFile, deleteCurrent } from './ingest.js'

// Sidebar source-grouping. The default (JSON) bucket renders flush at
// the top with no header — that's the analyzer's native dump format
// and doesn't need a label. Named buckets get headers; today there
// are two:
//   .md     — "Claude Security" (the only producer for the supported
//             markdown findings layout)
//   .codex  — "Codex Security" (per-scan slices saved by ingest.js
//             when a .csv is dropped; one file = one scan)
// Files are grouped by extension as a cheap, sync proxy for format
// detection — `listFiles` only returns names, and reading every file
// just to peek at the format on each sidebar render would be wasteful.
function groupOf(name) {
  const lower = name.toLowerCase()
  if (lower.endsWith('.deepseek')) return 'deepseek'
  if (lower.endsWith('.codex')) return 'codex-security'
  if (lower.endsWith('.md')) return 'claude-security'
  return 'default'
}

const GROUP_LABELS = {
  'claude-security': 'Claude Security',
  'codex-security': 'Codex Security',
  'deepseek': 'DeepSeek',
}

// Render order for named groups: Claude → Codex → DeepSeek.
const NAMED_GROUP_ORDER = ['claude-security', 'codex-security', 'deepseek']

// Filename-to-label transform for the bucket-marker suffixes ingest
// stamps on at drop time. `.codex` filenames are derived (e.g.
// `org__repo:scan-suffix.codex`) — un-sanitize the slashes and strip
// the suffix for the visible label so the sidebar reads as the
// original `org/repo:scan-suffix`. `.deepseek` is a renamed `.md`
// drop — strip the marker so the user sees the natural filename.
function displayName(name) {
  const lower = name.toLowerCase()
  if (lower.endsWith('.codex')) {
    return name.slice(0, -'.codex'.length).replace(/__/gu, '/')
  }
  if (lower.endsWith('.deepseek')) {
    return name.slice(0, -'.deepseek'.length)
  }
  return name
}

function fileItemHtml(n) {
  const cls = `file-item${n === state.currentFile ? ' current' : ''}`
  const label = displayName(n)
  return `<li class="${cls}" data-file="${esc(n)}"><button type="button" class="file-name" title="${esc(label)}">${esc(label)}</button></li>`
}

// Render the OPFS file list into the sidebar. Highlights the active
// file. Disables Delete when nothing's open. Hides the whole sidebar
// when there are no files AND nothing's currently loaded — keeps the
// empty-state drop zone uncluttered. Called after every state
// transition that could change the file list or current selection.
export async function renderSidebar() {
  const names = await listFiles()
  sidebar.classList.toggle('empty', names.length === 0 && !state.currentFile)

  // Bucket by group, preserving the alphabetical order listFiles already
  // returned within each group.
  const buckets = new Map([['default', []]])
  for (const n of names) {
    const g = groupOf(n)
    if (!buckets.has(g)) buckets.set(g, [])
    buckets.get(g).push(n)
  }
  // Only add a group header when more than one group has content —
  // a sidebar of nothing-but-md files reads cleanest as a flat list,
  // same as a sidebar of nothing-but-json. Once the user mixes
  // formats, the headers are what tell them which bucket they're in.
  // Named groups render in NAMED_GROUP_ORDER (Claude above Codex).
  const namedGroups = NAMED_GROUP_ORDER
    .map((g) => [g, buckets.get(g) ?? []])
    .filter(([, list]) => list.length > 0)
  // Show headers as soon as there are 2+ buckets in play (default
  // counts as one). A single-bucket sidebar — only JSON, only Claude,
  // only Codex — reads cleanest flat. With Claude AND Codex but no
  // JSON we still want the section labels so the two named groups
  // are visually separated.
  const groupCount = (buckets.get('default').length > 0 ? 1 : 0) + namedGroups.length
  const showHeaders = groupCount > 1

  let html = ''
  for (const n of buckets.get('default')) html += fileItemHtml(n)
  for (const [g, list] of namedGroups) {
    if (showHeaders) html += `<li class="file-group-header">${esc(GROUP_LABELS[g] ?? g)}</li>`
    for (const n of list) html += fileItemHtml(n)
  }
  fileList.innerHTML = html

  const deleteBtn = document.getElementById('delete-current')
  if (deleteBtn) deleteBtn.disabled = !state.currentFile
}

// Sidebar event delegation: file-list click switches; Delete removes
// the current file; toggle collapses / expands.
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
