// Entry point — pulls in every module, wires the boot sequence.
// Each module that needs to attach DOM listeners or expose `window.__*`
// hooks does so at evaluation time, so importing them here is what
// actually makes the page interactive. The order is mostly free; we
// import sidebar before ingest so the sidebar click delegate exists by
// the time `addFiles` calls `renderSidebar`.
import { sidebar } from './view/dom.js'
import { attachSharedWorkspace, extractShareEncoded, getSecureItem, hydrateSecureStorage, isDisablingInThisTab, isEncryptionEnabled, isUnlocked, listFiles, listWorkspaces, onVaultStateChange, setRedraw, state, syncObservedAfterHydrate, triageSync } from '#client/index.js'
import { renderSidebar } from './view/sidebar.js'
import { LAST_FILE_KEY, switchToFile, switchToWorkspace } from './view/ingest.js'
import { installHydrationConflictResolver } from './view/hydration-conflict.js'
import { installSyncAuthResolver } from './view/sync-auth.js'
import { onAutoDownloaded, onBundleAutoDownloaded, onChange as onPresenceChange } from './view/objstore-presence.js'
import { runLegacyOriginCheck } from './view/origin-check.js'
import { render } from './view/render.js'
import { openWorkspaceUnlockLinkDialog } from './view/workspace-unlock-link-dialog.js'
import './view/encryption-toggle.js'
import './view/lock-overlay.js'
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
// objstore-presence's cache changes (initial list() snapshot, plus
// live objstore-put / objstore-deleted broadcasts) repaint the
// header sync-status badge. Re-uses the full render() rather than a
// targeted DOM patch — Lit's `litRender(headerTpl, headerSlot)`
// inside render() reconciles efficiently, and the no-active-report
// early return short-circuits before any work happens.
onPresenceChange(render)
// triage-sync status transitions (off → connecting → online →
// offline) gate the badge: it only renders while sync is `online`
// (any other state means `isInRemote` can't give a trustworthy
// answer, so showing "local" would be misleading).
triageSync.onStatusChange(render)
// Auto-download bridge — the presence module silently fetches +
// saves peer-uploaded reports it discovers. If the workspace that
// gained the new report is the active view, re-run
// `switchToWorkspace` so the report lands in state.reports +
// renders into the merged findings list. (renderSidebar already
// picks up the new attachment via the membership listener; the
// extra hop here is only for the merged-view refresh.)
//
// Note: this listener only fires when triage-sync has an open WS
// session, which can only happen post-unlock (workspaces are read
// from secure-storage which is empty until hydrate runs in
// continueBoot). So an auto-download can never land while the
// vault is enabled-but-locked.
onAutoDownloaded(async (workspaceId) => {
  if (state.currentWorkspace === workspaceId) {
    await switchToWorkspace(workspaceId)
  } else {
    await renderSidebar()
  }
})
// Bundle auto-download bridge. Bundles aren't part of state.reports
// so `switchToWorkspace` isn't needed — just refresh the sidebar
// (which re-populates `state.bundles` via `listBundles()`) and the
// main view if the user is currently looking at the bundles list.
onBundleAutoDownloaded(async () => {
  await renderSidebar()
  if (state.currentView === 'bundles') render()
})
// Same bridge for the report-attach conflict dialog: triage-sync
// surfaces conflicts via a callback the UI installs here.
installHydrationConflictResolver()
// Same bridge for the operator-side password prompt: triage-sync's
// first-action gate (server's `unauthorized` frame) surfaces here
// when the cached password isn't present or was rejected.
installSyncAuthResolver()

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
  let payload
  try {
    payload = await openWorkspaceUnlockLinkDialog({ encoded })
  } catch (err) {
    // Stacked-modal failure (or any other dialog open failure) —
    // surface and bail so the caller doesn't proceed with an empty
    // payload. Call out that this is the receiver-side unlock prompt
    // (not the sender-side share dialog) so a user pasting a share
    // link doesn't read the alert as "the link is corrupt".
    alert(`Couldn't open the share-link unlock prompt: ${err.message}`)
    return false
  }
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

// Boot continuation — everything that touches encrypted data,
// triage-sync sessions, OPFS reads, or the UI's restored state.
// Gated behind `bootContinuationRan` so it only ever runs once
// per page load, whether via the boot IIFE (vault disabled, or
// unlocked at boot) or via the vault-state-change listener
// (unlock dismissed at boot, user later unlocks via the overlay).
//
// While `bootContinuationRan === false` and the vault is locked,
// NOTHING operational runs in this tab:
//   - secure-storage cache is empty → workspaces appears empty,
//     sync sessions appear empty, no last-file pointer, etc.
//   - The sidebar isn't rendered, so OPFS is never scanned.
//   - triage-sync never opens a WS connection (sessions only open
//     when a workspace's `openSession` is called, which happens
//     via switchToWorkspace, which is part of this continuation).
//   - objstore-presence never sees a session opened, so no
//     auto-download can fire — the locked-vault saveFileBytes
//     rejection path is defensive-only.
//   - The lock overlay is the only interactive surface; the rest
//     of the app is effectively suspended.
let bootContinuationRan = false

async function continueBoot() {
  if (bootContinuationRan) return
  bootContinuationRan = true
  // Hydrate the encrypted-localStorage cache (workspaces, sync
  // sessions, repoUrls, fileCounts, lastFile). MUST run BEFORE
  // renderSidebar / restore-last-file because those code paths
  // read from the cache synchronously via getItem(). No-op fast
  // path when the vault is disabled (everything was plaintext on
  // disk and gets cached verbatim).
  await hydrateSecureStorage()
  // Now that secure-storage has the decrypted workspaces in cache,
  // snapshot them as "already observed" so the first sibling-tab
  // storage event doesn't fire phantom workspace-created listeners
  // for entries that were already in storage at boot.
  syncObservedAfterHydrate()
  await renderSidebar()
  // Share-link hash takes precedence over the last-file restore so
  // the user lands on the freshly-attached workspace, not whatever
  // they were looking at last time.
  const attached = await handleShareHashIfPresent()
  if (attached) return
  const last = getSecureItem(LAST_FILE_KEY)
  if (last) {
    if (last.startsWith('ws:')) {
      const id = last.slice(3)
      if (listWorkspaces().some((w) => w.id === id)) await switchToWorkspace(id)
    } else {
      const names = await listFiles()
      if (names.includes(last)) await switchToFile(last)
    }
  }
}

// Vault state transitions:
//   1. First unlock after a locked-boot → run the deferred
//      continueBoot.
//   2. Mid-session sibling-tab enable / re-key (we were running
//      with no encryption, or under a different credential, and
//      now the vault is enabled-but-not-yet-unlocked-here) →
//      force reload. Our in-memory state is stale relative to
//      the just-flipped storage shape (open WS sessions,
//      decrypted `state.*` maps, secure-storage cache) — none of
//      it is safe to keep operating against. The reload restarts
//      this tab in the locked-boot state where the overlay covers
//      everything until unlock.
//   3. Mid-session sibling-tab DISABLE (we were operational under
//      an enabled vault, sibling just decrypted-and-cleared
//      metadata) → force reload. Without this, our hydrate runs
//      against sibling's mid-migration disk and `propagate*`
//      listeners fire spurious deletes for every workspace as the
//      cache transiently empties (envelope keys un-decryptable
//      after sibling's `clearMetadata` storage event drops our
//      sessionKey). `isDisablingInThisTab()` distinguishes this
//      from our OWN `disableEncryption` call — that user clicked
//      Disable here and expects to continue in this tab.
//   4. Any other transition (intra-tab disable, intra-tab unlock
//      that didn't go through the boot-deferred path) just
//      re-renders.
//
// `alert()` (single-button "OK") rather than `confirm()` for the
// reload prompts: decline path is a footgun — the lock overlay
// covers everything with an opaque backdrop, so the user can't
// usefully "stash unsaved work" after declining. Making it
// acknowledgement-only avoids that trap while still giving notice.
let lastSeenEnabled = isEncryptionEnabled()
let reloadPending = false
function scheduleReload(reason) {
  if (reloadPending) return
  reloadPending = true
  // Defer to a microtask so the synchronous `render()` above
  // paints the new vault state BEFORE the alert grabs the event
  // loop — the user sees context for the reload.
  queueMicrotask(() => {
    alert(reason + ' This tab will reload to refresh its state. Any unsaved edits in this tab will be lost.')
    location.reload()
  })
}
onVaultStateChange(() => {
  const wasEnabled = lastSeenEnabled
  const isEnabled = isEncryptionEnabled()
  lastSeenEnabled = isEnabled
  render()
  if (!bootContinuationRan && isUnlocked()) {
    continueBoot().catch((err) => console.warn('continueBoot:', err))
    return
  }
  if (bootContinuationRan && isEnabled && !isUnlocked()) {
    scheduleReload('Encryption was just enabled in another tab.')
    return
  }
  if (bootContinuationRan && wasEnabled && !isEnabled && !isDisablingInThisTab()) {
    scheduleReload('Encryption was disabled in another tab.')
  }
})

;(async () => {
  // Legacy-origin redirect: deepaudit.dev users with no local data
  // bounce silently to triage.space; users with data get a confirm
  // dialog. Either resolves to a navigation that supersedes the rest
  // of this boot, so a `true` return short-circuits the file-restore
  // path below — running it would re-touch OPFS / state.* in a tab
  // that's about to unload.
  if (await runLegacyOriginCheck()) return
  try {
    // In WCO mode the sidebar header is the surface the OS controls
    // overlay onto; collapsing it would strand close / min / max
    // visually over a 32px strip, so ignore the persisted flag and
    // pin the sidebar open.
    const isAppHeader = window.matchMedia?.('(display-mode: window-controls-overlay)').matches
    if (!isAppHeader && localStorage.getItem('deepview.sidebarCollapsed') === '1') sidebar.classList.add('collapsed')
    // Installed-PWA modes (standalone OR window-controls-overlay) —
    // the user launched DeepView as a standalone app, not a browser
    // tab, so app-level page zoom (ctrl/cmd+wheel, ctrl/cmd+ +/-/0,
    // touch-pinch) should be inert the way it is in any native app.
    // Browser tabs keep the default behaviour. matchMedia on
    // display-mode is the standard installed-PWA detector.
    const isInstalled = window.matchMedia?.('(display-mode: standalone)').matches || isAppHeader
    if (isInstalled) {
      const viewport = document.querySelector('meta[name="viewport"]')
      if (viewport) viewport.setAttribute('content', 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no')
      // Desktop ctrl/cmd+wheel = browser zoom; passive: false so
      // preventDefault actually inhibits it. Canvas / scroll-container
      // wheel handlers run first (capture phase isn't used here) so
      // their pan / zoom logic still fires; we just stop the browser
      // from also taking the event as a zoom command.
      window.addEventListener('wheel', (e) => { if (e.ctrlKey || e.metaKey) e.preventDefault() }, { passive: false })
      window.addEventListener('keydown', (e) => {
        if (!(e.ctrlKey || e.metaKey)) return
        if (e.key === '=' || e.key === '+' || e.key === '-' || e.key === '0') e.preventDefault()
      })
    }
  } catch {}
  // Vault enabled-but-locked at boot: skip continueBoot and let
  // the lock overlay (`view/lock-overlay.js`) be the sole unlock
  // affordance. Clicking the overlay button opens the unlock
  // dialog; on successful unlock the vault-state-change listener
  // above kicks continueBoot. While the user remains locked, no
  // operational work happens in this tab — no WS connection, no
  // sidebar render, no auto-download.
  //
  // The boot flow used to auto-open the unlock dialog here, which
  // resulted in TWO unlock surfaces visible simultaneously (the
  // modal dialog AND the overlay behind it). Now the overlay is
  // the only surface, and the dialog appears only on user intent.
  if (isEncryptionEnabled() && !isUnlocked()) return
  await continueBoot()
})()
