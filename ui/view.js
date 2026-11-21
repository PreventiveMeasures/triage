// Entry point. Modules attach their listeners and `window.__*` hooks as they
// evaluate; sidebar before ingest, so its click delegate exists when
// `addFiles` renders it.
import { dropZone, sidebar } from './view/dom.js'
import { attachSharedWorkspace, ensureKnownLinkedFindingsIndexed, extractFindingRef, extractShareEncoded, getSecureItem, hydrateSecureStorage, isDisablingInThisTab, isEncryptionEnabled, isManagedUiMode, isUnlocked, listFiles, listWorkspaces, onVaultStateChange, setTriageReloadNotifier, state, syncObservedAfterHydrate } from '#client/index.js'
import { onAutoDownloaded, onBundleAutoDownloaded, onChange as onPresenceChange, setRedraw, triageSync } from './view/client-sync.js'
import { ensureClientMode, renderSidebar } from './view/sidebar.js'
import { releaseIndexWalks } from './view/index-walks.js'
import { BUNDLE_TABS, LAST_FILE_KEY, currentViewGeneration, switchToFile, switchToWorkspace, switchToWorkspaceContent } from './view/ingest.js'
import { openBundle, selectBundle } from './view/bundle-load.js'
import { revealFinding } from './view/finding-link-nav.js'
import { decodeReportLocation } from '../client/report-location.js'
import { installHydrationConflictResolver } from './view/hydration-conflict.js'
import { installSyncAuthResolver } from './view/sync-auth.js'
import { runLegacyOriginCheck } from './view/origin-check.js'
import { render } from './view/render.js'
import { openWorkspaceUnlockLinkDialog } from './view/lazy-dialogs.js'
import './view/encryption-toggle.js'
import './view/lock-overlay.js'
import './view/events.js'
import './view/theme.js'
import './view/finding-table.js'
import './view/finding-card.js'
import './view/kanban-rail.js'
import './view/color-marker.js'
import './view/analyzer-select.js'
import './view/conf-filter.js'
import './view/bundle-code-search.js'
import './view/bundle-code-splitter.js'
import './view/bundle-slide-header.js'
import './view/bundle-search.js'
import './view/entity-search.js'
import './view/entity-sort.js'
import './view/findings-sort.js'
import './view/range-slider.js'
import './view/conf-range-mirror.js'
import './view/repo-chip.js'
import './view/annotation-filter.js'
import './view/severity-chips.js'
import './view/severity-mode-switch.js'
import './view/revalidation-switch.js'
import './view/mode-switch.js'
import './view/sidebar-delete-current.js'
import './view/sidebar-view-button.js'
import './view/slide-triage-tabs.js'
import './view/source-filter.js'
import './view/toolbar-search.js'
import './view/repo-filter.js'
import './view/revalidate-filter.js'
import './view/triage-filter.js'
import './view/triage-selector.js'
import './view/view-mode-buttons.js'
import './view/bundle-treemap.js'
import './view/managed-profile.js'
import './view/dependency-review-copy.js'
import './view/download-button.js'
import './view/managed-fix-link.js'
import './view/comment-preview.js'
import './view/api.js'
// Detects native brotli at boot; the worker fallback starts on first use.
import './view/brotli-decompress.js'
import './view/drop-supported-icons.js'
import './view/scan-navigation.js'

// The client/ layer doesn't import ui/: these hooks repaint the view on a
// remote triage update, a sibling tab's triage save (the imperatively
// rendered kanban, counts and buckets don't react on their own), a presence
// change, and a sync status change (the badge shows only while online).
setRedraw(render)
setTriageReloadNotifier(render)
onPresenceChange(render)
triageSync.onStatusChange(render)
// A peer's report saved in the background (only with an open session, so
// never while the vault is locked) refreshes the view showing it.
onAutoDownloaded(async (workspaceId, fileName) => {
  if (state.currentWorkspace === workspaceId) {
    await switchToWorkspace(workspaceId)
  } else if (state.currentFile && state.currentFile === fileName) {
    // An in-place replacement of the open report (objstore-presence.js).
    await switchToFile(fileName)
  } else {
    await renderSidebar()
  }
})
onBundleAutoDownloaded(async () => {
  await renderSidebar()
  if (state.currentView === 'bundles') render()
})
installHydrationConflictResolver()
installSyncAuthResolver()

// `#share=<base64url>`: decrypt `{ id, name, privateKey }` with a password
// and attach it under the SENDER's id, so both ends derive the same signing
// keypair and chain. The fragment (and query) is stripped before the dialog
// opens, so a cancelled or failed attempt leaves no encrypted blob in the
// address bar or history. attachSharedWorkspace refuses a name or id
// collision, which a sibling tab can cause while the dialog is open.
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
    // Worded as the receiver's prompt, so a pasted link doesn't read as corrupt.
    alert(`Couldn't open the share-link unlock prompt: ${err.message}`)
    return false
  }
  if (!payload) return false
  // The check and the write share one Web Lock; the dialog already reported
  // the common collisions inline.
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
    // `existing` is null for a name that sanitises to empty (a hostile payload).
    const existingName = result.existing?.name
    alert(existingName
      ? `A workspace named "${existingName}" already exists. Open the share link again and pick a different name.`
      : 'The shared workspace name is empty or invalid. Ask the sender to re-share with a real name.')
    return false
  }
  // switchToWorkspace renders the sidebar itself.
  if (result.workspace?.id) await switchToWorkspace(result.workspace.id)
  else await renderSidebar()
  return true
}

// `#finding=<id>[&v=<hints>]` (client/finding-link.js): open, un-hide and
// reveal that finding (view/finding-link-nav.js). The fragment is stripped
// before the first await, so a re-entrant hashchange reads an empty hash and
// a later copied URL doesn't point at it. A miss alerts (a link doing
// nothing looks broken) and falls through to the last-file restore.
async function handleFindingHashIfPresent() {
  const ref = extractFindingRef()
  if (!ref) return false
  try {
    history.replaceState(null, '', location.pathname)
  } catch {}
  const result = await revealFinding(ref)
  if (!result.ok) {
    alert(result.reason)
    return false
  }
  return true
}

// Everything touching encrypted data, sync sessions, OPFS or the restored
// view, once per page load: from the boot IIFE, or on a later unlock. Until
// then, with the vault locked, nothing operational runs in this tab (no
// sidebar or OPFS scan, no sync connection, no auto-download); the lock
// overlay is the only interactive surface.
let bootContinuationRan = false

async function continueBoot() {
  await ensureClientMode()
  if (bootContinuationRan) return
  if (!isManagedUiMode() && isEncryptionEnabled() && !isUnlocked()) return
  bootContinuationRan = true
  try {
    await restoreInitialView()
  } finally {
    // The welcome stays hidden while the saved view loads; a restored
    // report adds `.hidden` of its own.
    dropZone.hidden = false
    // The sidebar's full index walks start behind the restored view.
    releaseIndexWalks()
  }
}

async function restoreInitialView() {
  const generation = currentViewGeneration()
  const isCurrent = () => generation === currentViewGeneration() && !isManagedUiMode()
  // Managed mode's reports are on the server: no local cache, OPFS or triage
  // until the user switches to its local surface.
  if (isManagedUiMode()) {
    await renderSidebar()
    return
  }
  // The sidebar and last-file restore read this cache synchronously.
  await hydrateSecureStorage()
  if (!isCurrent()) return
  // Workspaces present at boot are not "created" by the first storage event.
  syncObservedAfterHydrate()
  // The known links index before findings paint; the full walks wait
  // (continueBoot) so unrelated reads stay off the critical path.
  await Promise.all([
    renderSidebar(),
    ensureKnownLinkedFindingsIndexed().catch((err) => console.warn('initial linked findings:', err)),
  ])
  if (!isCurrent()) return
  // A share or finding link takes precedence over the last-file restore.
  const attached = await handleShareHashIfPresent()
  if (attached || !isCurrent()) return
  const revealed = await handleFindingHashIfPresent()
  if (revealed || !isCurrent()) return
  const last = getSecureItem(LAST_FILE_KEY)
  if (last) {
    if (last.startsWith('wbs:') || last.startsWith('wrs:')) {
      await switchToWorkspaceContent(last.slice(4), last.startsWith('wrs:') ? 'reports' : 'bundles')
    } else if (last.startsWith('ws:')) {
      const id = last.slice(3)
      if (listWorkspaces().some((w) => w.id === id)) await switchToWorkspace(id)
    } else if (last.startsWith('b:')) {
      // `b:<integrity>[ <tab>]`, an unknown tab as Overview; a bundle
      // deleted meanwhile leaves the drop zone.
      const rest = last.slice(2)
      const spaceIdx = rest.indexOf(' ')
      const integrity = spaceIdx >= 0 ? rest.slice(0, spaceIdx) : rest
      const savedTab = spaceIdx >= 0 ? rest.slice(spaceIdx + 1) : ''
      const tab = BUNDLE_TABS.has(savedTab) ? savedTab : 'overview'
      if ((state.bundles ?? []).some((b) => b.integrity === integrity)) {
        // The pointer keeps no workspace: restore it when one workspace
        // holds the bundle, as opening it from that row would, so its row
        // and the collapsed sidebar mark it current.
        const owners = listWorkspaces().filter((w) => w.bundles.includes(integrity))
        selectBundle(integrity, tab, { workspaceId: owners.length === 1 ? owners[0].id : null })
        render()
        openBundle(integrity)
        // The first sidebar paint predates selection. Reveal the restored
        // bundle's workspace section even when every count is already cached.
        await renderSidebar()
      }
    } else {
      const names = await listFiles()
      if (!isCurrent()) return
      const savedReport = decodeReportLocation(last)
      if (savedReport && names.includes(savedReport.name)) {
        await switchToFile(savedReport.name, undefined, { workspaceId: savedReport.workspaceId })
      }
    }
  }
}

// Vault state transitions: the first unlock after a locked boot runs
// continueBoot. A sibling tab enabling or re-keying the vault, or disabling
// it (not this tab's own disable, isDisablingInThisTab), reloads this tab:
// its sessions, decrypted state and cache no longer match storage, and a
// sibling's disable would otherwise fire spurious per-workspace deletes as
// the cache empties. Anything else re-renders. The reload notice is an
// alert, not a confirm: declining could do nothing useful under the overlay.
// The baseline is set only once a confirmed mode permits local reads.
let lastSeenEnabled = false
let reloadPending = false
// Managed → local hydrates the cache without changing the vault: reset the
// baseline so a later passkey unlock isn't read as a sibling's enable.
document.addEventListener('managed-client-mode-change', () => {
  lastSeenEnabled = !isManagedUiMode() && isEncryptionEnabled()
})
function scheduleReload(reason) {
  if (reloadPending) return
  reloadPending = true
  // After the caller's render paints the new vault state.
  queueMicrotask(() => {
    alert(reason + ' This tab will reload to refresh its state. Any unsaved edits in this tab will be lost.')
    location.reload()
  })
}
onVaultStateChange(async () => {
  await ensureClientMode()
  if (isManagedUiMode()) {
    render()
    return
  }
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

// A link pasted into an open tab only changes the fragment, so its handlers
// run again here. While locked (before continueBoot) the hash waits for the
// unlock. Each handler strips its fragment before its first await, so a
// re-entry or a hashchange racing boot finds it gone; a `#finding=` hash
// passes the share handler untouched.
window.addEventListener('hashchange', () => {
  if (!bootContinuationRan || isManagedUiMode()) return
  ;(async () => {
    if (await handleShareHashIfPresent()) return
    await handleFindingHashIfPresent()
  })().catch((err) => console.warn('deep-link hashchange:', err))
})

;(async () => {
  // deepaudit.dev redirects to triage.space; this tab is about to unload.
  if (await runLegacyOriginCheck()) return
  await ensureClientMode()
  lastSeenEnabled = !isManagedUiMode() && isEncryptionEnabled()
  try {
    // Under window-controls-overlay the sidebar header carries the OS
    // controls and has no collapse toggle, so the saved collapse applies
    // only outside it, re-applied as the title bar is toggled.
    const appHeader = window.matchMedia?.('(display-mode: window-controls-overlay)')
    const applySavedCollapse = () => {
      let saved = false
      try { saved = localStorage.getItem('deepview.sidebarCollapsed') === '1' } catch {}
      sidebar.classList.toggle('collapsed', saved && !appHeader?.matches)
    }
    applySavedCollapse()
    appHeader?.addEventListener('change', applySavedCollapse)
    // An installed app, as a native one, doesn't page-zoom (wheel, keys, pinch).
    const isInstalled = window.matchMedia?.('(display-mode: standalone)').matches || appHeader?.matches
    if (isInstalled) {
      const viewport = document.querySelector('meta[name="viewport"]')
      if (viewport) viewport.setAttribute('content', 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no')
      // Not passive, so preventDefault holds; element handlers still run first.
      window.addEventListener('wheel', (e) => { if (e.ctrlKey || e.metaKey) e.preventDefault() }, { passive: false })
      window.addEventListener('keydown', (e) => {
        if (!(e.ctrlKey || e.metaKey)) return
        if (e.key === '=' || e.key === '+' || e.key === '-' || e.key === '0') e.preventDefault()
      })
    }
  } catch {}
  // Locked at boot: the lock overlay alone unlocks, and the vault listener
  // above then runs continueBoot.
  if (!isManagedUiMode() && isEncryptionEnabled() && !isUnlocked()) return
  await continueBoot()
})()
