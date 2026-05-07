// Entry point — pulls in every module, wires the boot sequence.
// Each module that needs to attach DOM listeners or expose `window.__*`
// hooks does so at evaluation time, so importing them here is what
// actually makes the page interactive. The order is mostly free; we
// import sidebar before ingest so the sidebar click delegate exists by
// the time `addFiles` calls `renderSidebar`.
import { sidebar } from './view/dom.js'
import { listFiles } from './view/storage.js'
import { renderSidebar } from './view/sidebar.js'
import { switchToFile, LAST_FILE_KEY } from './view/ingest.js'
import './view/events.js'
import './view/theme.js'
import './view/finding-table.js'

// On boot: restore the sidebar collapse state, render the file list,
// and switch to the last-viewed file if it's still around. No file
// loaded → drop zone stays visible.
;(async () => {
  try {
    if (localStorage.getItem('deepview.sidebarCollapsed') === '1') sidebar.classList.add('collapsed')
  } catch {}
  await renderSidebar()
  let last = null
  try { last = localStorage.getItem(LAST_FILE_KEY) } catch {}
  if (last) {
    const names = await listFiles()
    if (names.includes(last)) await switchToFile(last)
  }
})()
