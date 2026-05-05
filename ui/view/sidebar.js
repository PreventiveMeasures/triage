import { state } from './state.js'
import { sidebar, fileList } from './dom.js'
import { esc } from './format.js'
import { listFiles } from './storage.js'
import { switchToFile, deleteCurrent } from './ingest.js'

// Sidebar source-grouping. The default (JSON) bucket renders flush at
// the top with no header — that's the analyzer's native dump format
// and doesn't need a label. The markdown bucket gets a "Claude
// Security" header (the only producer for the supported .md layout
// today). Files are grouped by extension as a cheap, sync proxy for
// format detection — `listFiles` only returns names, and reading
// every file just to peek at the format on each sidebar render
// would be wasteful.
function groupOf(name) {
  return name.toLowerCase().endsWith('.md') ? 'claude-security' : 'default'
}

const GROUP_LABELS = { 'claude-security': 'Claude Security' }

function fileItemHtml(n) {
  const cls = `file-item${n === state.currentFile ? ' current' : ''}`
  return `<li class="${cls}" data-file="${esc(n)}"><button type="button" class="file-name" title="${esc(n)}">${esc(n)}</button></li>`
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
  // same as a sidebar of nothing-but-json. Once the user mixes the
  // two, the headers are what tells them which bucket they're in.
  const namedGroups = [...buckets.entries()].filter(([g, list]) => g !== 'default' && list.length > 0)
  const showHeaders = buckets.get('default').length > 0 && namedGroups.length > 0

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
