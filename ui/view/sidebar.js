import { state } from './state.js'
import { sidebar, fileList } from './dom.js'
import { esc } from './format.js'
import { listFiles } from './storage.js'
import { switchToFile, deleteCurrent } from './ingest.js'

// Render the OPFS file list into the sidebar. Highlights the active
// file. Disables Delete when nothing's open. Hides the whole sidebar
// when there are no files AND nothing's currently loaded — keeps the
// empty-state drop zone uncluttered. Called after every state
// transition that could change the file list or current selection.
export async function renderSidebar() {
  const names = await listFiles()
  sidebar.classList.toggle('empty', names.length === 0 && !state.currentFile)
  fileList.innerHTML = names.map((n) =>
    `<li class="file-item${n === state.currentFile ? ' current' : ''}" data-file="${esc(n)}"><button type="button" class="file-name" title="${esc(n)}">${esc(n)}</button></li>`,
  ).join('')
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
