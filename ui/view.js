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
import { attachSharedWorkspace, listWorkspaces } from '../client/workspaces.js'
import { setRedraw } from '../client/triage-sync.ts'
import { installHydrationConflictResolver } from './view/hydration-conflict.js'
import { runLegacyOriginCheck } from './view/origin-check.js'
import { render } from './view/render.js'
import { extractShareEncoded } from '../client/workspace-share-link.js'
import { openWorkspaceUnlockLinkDialog } from './view/workspace-unlock-link-dialog.js'
import './view/events.js'
import './view/theme.js'
import './view/finding-table.js'
import './view/finding-card.js'
import './view/color-marker.js'
import './view/range-slider.js'
import './view/conf-range-mirror.js'
import './view/triage-conflict-dialog.js'
import './view/triage-export-dialog.js'
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

// `#share=<base64url>` in the address bar → prompt for the
// password, decrypt to `{ id, name, privateKey }`, then prompt
// for a local name (defaulting to the sender's), and attach the
// workspace under the SENDER's id so sender + recipient derive
// the same Ed25519 signing keypair (sync-crypto derives from
// `(privateKey, workspaceId)`) and end up on the same chain.
//
// The hash fragment is stripped as soon as we've extracted the
// encoded payload — BEFORE the dialog opens — so a Cancel / wrong-
// password / page-share doesn't leave the encrypted blob lingering
// in the address bar, history, or any subsequent "copy current
// URL" action. The user can always paste the link again to retry.
// `location.search` is also dropped: the share-link target page
// doesn't take query params and leaving them in the bar after an
// unlock confuses copy-and-paste of the resulting URL.
//
// The upsert is gated on a final name/id collision check so a
// share-link can't silently clobber an existing workspace's
// reports or rename it under the user's feet. The unlock dialog
// surfaces collisions inline; the check here is defense-in-depth
// against a sibling-tab race during the dialog's user-time.
async function handleShareHashIfPresent() {
  const encoded = extractShareEncoded()
  if (!encoded) return false
  try {
    history.replaceState(null, '', location.pathname)
  } catch {}
  const payload = await openWorkspaceUnlockLinkDialog({ encoded })
  if (!payload) return false
  // `attachSharedWorkspace` performs the id + (sanitised-)name
  // collision check AND the write inside one Web Lock acquisition,
  // so a sibling-tab `createWorkspace` racing the dialog's user-time
  // can't slip a same-name twin past us. The dialog already gave the
  // user inline feedback for the common path; the alerts here only
  // surface if a sibling tab snuck a collision in while the user was
  // typing.
  const result = await attachSharedWorkspace({
    id: payload.id,
    name: payload.name,
    privateKey: payload.privateKeyBase64,
  })
  if (result.status === 'already-attached') {
    alert(`This workspace is already attached as "${result.workspace.name}".`)
    return false
  }
  if (result.status === 'name-collision') {
    // `existing` is null when the sanitised name itself was empty
    // (the dialog rejects empty input but a hostile share payload
    // could have shipped `n: '   '`). Print a generic message
    // rather than an empty-string fallback.
    const existingName = result.existing?.name
    alert(existingName
      ? `A workspace named "${existingName}" already exists. Open the share link again and pick a different name.`
      : 'The shared workspace name is empty or invalid. Ask the sender to re-share with a real name.')
    return false
  }
  // `switchToWorkspace` re-renders the sidebar at its tail, so
  // skip the explicit pre-render — it would just duplicate the
  // OPFS scan and the bundle-findings indexing kick.
  if (result.workspace?.id) await switchToWorkspace(result.workspace.id)
  else await renderSidebar()
  return true
}

;(async () => {
  // Legacy-origin redirect: deepaudit.dev users with no local data
  // bounce silently to triage.space; users with data get a confirm
  // dialog. Either resolves to a navigation that supersedes the rest
  // of this boot, so a `true` return short-circuits the file-restore
  // path below — running it would re-touch OPFS / state.* in a tab
  // that's about to unload.
  if (await runLegacyOriginCheck()) return
  try {
    if (localStorage.getItem('deepview.sidebarCollapsed') === '1') sidebar.classList.add('collapsed')
  } catch {}
  await renderSidebar()
  // Share-link hash takes precedence over the last-file restore so
  // the user lands on the freshly-attached workspace, not whatever
  // they were looking at last time.
  const attached = await handleShareHashIfPresent()
  if (attached) return
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
