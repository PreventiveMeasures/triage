// Entry point — pulls in every module, wires the boot sequence.
// Each module that needs to attach DOM listeners or expose `window.__*`
// hooks does so at evaluation time, so importing them here is what
// actually makes the page interactive. The order is mostly free; we
// import sidebar before ingest so the sidebar click delegate exists by
// the time `addFiles` calls `renderSidebar`.
import { sidebar } from './view/dom.js'
import { listFiles } from '../client/storage.js'
import { renderSidebar } from './view/sidebar.js'
import { LAST_FILE_KEY, switchToFile, switchToWorkspace } from './view/ingest.js'
import { listWorkspaces } from '../client/workspaces.js'
import { setRedraw } from '../client/triage-sync.js'
import { installHydrationConflictResolver } from './view/hydration-conflict.js'
import { render } from './view/render.js'
import './view/events.js'
import './view/theme.js'
import './view/finding-table.js'
import './view/finding-card.js'
import './view/color-marker.js'
import './view/range-slider.js'
import './view/conf-range-mirror.js'
import './view/triage-conflict-dialog.js'
import './view/repo-chip.js'
import './view/severity-chips.js'
import './view/triage-filter.js'
import './view/view-mode-buttons.js'
import './view/api.js'
// Eager import — registers / unregisters the brotli SW based on
// whether DecompressionStream('br') works natively. The module's
// own side-effect block kicks the detect+register pass at boot;
// nothing else needs to call into it just to trigger setup.
import './view/brotli-decompress.js'

// On boot: restore the sidebar collapse state, render the file list,
// and switch to the last-viewed file if it's still around. No file
// loaded → drop zone stays visible.
// Wire the UI's render() into triage-sync so a remote update
// repaints the view. The client/ layer doesn't import from ui/, so
// this hook bridges the two.
setRedraw(render)
// Same bridge for the report-attach conflict dialog: triage-sync
// surfaces conflicts via a callback the UI installs here.
installHydrationConflictResolver()

;(async () => {
  try {
    if (localStorage.getItem('deepview.sidebarCollapsed') === '1') sidebar.classList.add('collapsed')
  } catch {}
  await renderSidebar()
  let last = null
  try { last = localStorage.getItem(LAST_FILE_KEY) } catch {}
  if (last) {
    if (last.startsWith('ws:')) {
      const id = last.slice(3)
      if (listWorkspaces().some((w) => w.id === id)) await switchToWorkspace(id)
    } else {
      const names = await listFiles()
      if (names.includes(last)) await switchToFile(last)
    }
  }
})()
