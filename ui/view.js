// Entry point. Modules attach DOM listeners / expose `window.__*`
// hooks at evaluation time, so importing them here is what makes the
// page interactive. Order is mostly free; sidebar before ingest so the
// sidebar click delegate exists when `addFiles` calls `renderSidebar`.
// MUST be first: publishes lit + StateElement on a Symbol-keyed global
// ahead of every other transitive import. `./view/format.js` (pulled
// in transitively via `./view/dom.js` etc.) reads the slot through
// `./view/frontend-global.js` and throws if it loads before the slot
// is set. Lazy bundles (`ui/terminal.js`, `ui/graph.js`) don't import
// this; they pick up the slot post-boot via the same
// `Symbol.for('@rray/frontend')`.
import './view/frontend-install.js'
import { sidebar } from './view/dom.js'
import { attachSharedWorkspace, extractShareEncoded, getSecureItem, hydrateSecureStorage, isDisablingInThisTab, isEncryptionEnabled, isUnlocked, listFiles, listWorkspaces, onVaultStateChange, setTriageReloadNotifier, state, syncObservedAfterHydrate } from '#client/index.js'
import { onAutoDownloaded, onBundleAutoDownloaded, onChange as onPresenceChange, setRedraw, triageSync } from './view/client-sync.js'
import { renderSidebar } from './view/sidebar.js'
import { BUNDLE_TABS, LAST_FILE_KEY, switchToFile, switchToWorkspace } from './view/ingest.js'
import { openBundle } from './view/bundle-load.js'
import { graph2 } from './view/graph/state.js'
import { installHydrationConflictResolver } from './view/hydration-conflict.js'
import { installSyncAuthResolver } from './view/sync-auth.js'
import { runLegacyOriginCheck } from './view/origin-check.js'
import { render } from './view/render.js'
import { openWorkspaceUnlockLinkDialog } from './view/dialogs/workspace-unlock-link-dialog.js'
import './view/encryption-toggle.js'
import './view/lock-overlay.js'
import './view/events.js'
import './view/theme.js'
import './view/finding-table.js'
import './view/finding-card.js'
import './view/color-marker.js'
import './view/analyzer-select.js'
import './view/conf-filter.js'
import './view/bundle-code-search.js'
import './view/entity-search.js'
import './view/entity-sort.js'
import './view/findings-sort.js'
import './view/range-slider.js'
import './view/conf-range-mirror.js'
import './view/dialogs/triage-conflict-dialog.js'
import './view/dialogs/triage-export-dialog.js'
import './view/repo-chip.js'
import './view/annotation-filter.js'
import './view/severity-chips.js'
import './view/sidebar-delete-current.js'
import './view/sidebar-view-button.js'
import './view/slide-triage-tabs.js'
import './view/source-filter.js'
import './view/toolbar-search.js'
import './view/repo-filter.js'
import './view/triage-filter.js'
import './view/triage-selector.js'
import './view/view-mode-buttons.js'
import './view/bundle-treemap.js'
import './view/bundle-compare.js'
import './view/print-button.js'
import './view/download-button.js'
import './view/api.js'
// Eager side-effect import — registers / unregisters the brotli SW
// based on whether DecompressionStream('br') works natively; kicks the
// detect+register pass at boot itself.
import './view/brotli-decompress.js'
// Side-effect import — paints the empty drop-zone's supported-formats
// list with the same SVG glyphs the sidebar uses for its rows.
import './view/drop-supported-icons.js'

// Wire render() into triage-sync so a remote update repaints the view.
// The client/ layer doesn't import ui/, so this hook bridges the two.
setRedraw(render)
// Same bridge for cross-tab learning: a sibling tab's saveTriage fires
// a `storage` event that reloads the blob straight into the reactive
// `state.triage` (see client/triage.js). The StateElement cards pick
// that up on their own, but the imperatively-rendered surfaces (kanban
// board, toolbar counts, bucket filtering) need an explicit render() —
// without it they stay stale on a sibling edit until the next click.
setTriageReloadNotifier(render)
// objstore-presence cache changes (initial list() snapshot + live
// objstore-put / objstore-deleted broadcasts) repaint the header
// sync-status badge. Full render() rather than a targeted patch — Lit
// reconciles efficiently and the no-active-report early return
// short-circuits before any work.
onPresenceChange(render)
// triage-sync status transitions gate the badge: it renders only while
// sync is `online` — any other state means `isInRemote` can't answer
// trustworthily, so showing "local" would mislead.
triageSync.onStatusChange(render)
// Auto-download bridge — the presence module silently fetches + saves
// peer-uploaded reports it discovers. If the gaining workspace is the
// active view, re-run `switchToWorkspace` so the report lands in
// state.reports + the merged findings list. renderSidebar already
// picks up the attachment via the membership listener; this hop is
// only for the merged-view refresh.
//
// Only fires with an open WS session, which is post-unlock only
// (workspaces come from secure-storage, empty until hydrate in
// continueBoot) — so an auto-download can't land while the vault is
// enabled-but-locked.
onAutoDownloaded(async (workspaceId, fileName) => {
  if (state.currentWorkspace === workspaceId) {
    await switchToWorkspace(workspaceId)
  } else if (state.currentFile && state.currentFile === fileName) {
    // Single-file view of the auto-downloaded report. The
    // replace-refetch path in objstore-presence.js reuses this listener
    // for in-place updates where the active single-file view CAN match
    // the changed file — reload so the user sees the peer's new bytes
    // without a manual navigate.
    await switchToFile(fileName)
  } else {
    await renderSidebar()
  }
})
// Bundle auto-download bridge. Bundles aren't in state.reports, so no
// `switchToWorkspace` — just refresh the sidebar (re-populates
// `state.bundles` via `listBundles()`) and the main view if the
// bundles list is showing.
onBundleAutoDownloaded(async () => {
  await renderSidebar()
  if (state.currentView === 'bundles') render()
})
// Report-attach conflict dialog: triage-sync surfaces conflicts via
// a callback the UI installs here.
installHydrationConflictResolver()
// Operator-side password prompt: triage-sync's first-action gate
// (server's `unauthorized` frame) surfaces here when the cached
// password is absent or was rejected.
installSyncAuthResolver()

// `#share=<base64url>` → prompt for the password, decrypt to
// `{ id, name, privateKey }`, prompt for a local name (default: the
// sender's), and attach under the SENDER's id so both ends derive the
// same Ed25519 signing keypair (sync-crypto derives from `(privateKey,
// workspaceId)`) and land on the same chain.
//
// The hash fragment is stripped right after extracting the payload,
// BEFORE the dialog opens — so a Cancel / wrong-password / page-share
// doesn't leave the encrypted blob in the address bar, history, or a
// "copy current URL" (paste the link again to retry). `location.search`
// is dropped too: the target takes no query params and leaving them
// confuses copy-and-paste of the resulting URL.
//
// The upsert is gated on a final name/id collision check so a share
// link can't silently clobber or rename an existing workspace. The
// dialog surfaces collisions inline; this check is defense-in-depth
// against a sibling-tab race during dialog user-time.
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
    // Dialog-open failure (e.g. stacked-modal) — surface and bail so
    // the caller doesn't proceed with an empty payload. Worded as the
    // receiver-side unlock prompt (not the sender-side share dialog) so
    // a user pasting a link doesn't read it as "corrupt".
    alert(`Couldn't open the share-link unlock prompt: ${err.message}`)
    return false
  }
  if (!payload) return false
  // `attachSharedWorkspace` does the id + (sanitised-)name collision
  // check AND the write inside one Web Lock, so a sibling-tab
  // `createWorkspace` racing the dialog can't slip a same-name twin
  // past us. The dialog already gave inline feedback for the common
  // path; these alerts only surface a collision a sibling tab snuck
  // in while the user was typing.
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
    // `existing` is null when the sanitised name was empty (the dialog
    // rejects empty input, but a hostile payload could ship `n: '   '`).
    // Generic message rather than an empty-string fallback.
    const existingName = result.existing?.name
    alert(existingName
      ? `A workspace named "${existingName}" already exists. Open the share link again and pick a different name.`
      : 'The shared workspace name is empty or invalid. Ask the sender to re-share with a real name.')
    return false
  }
  // `switchToWorkspace` re-renders the sidebar at its tail, so skip the
  // explicit pre-render — it would just duplicate the OPFS scan and the
  // bundle-findings indexing kick.
  if (result.workspace?.id) await switchToWorkspace(result.workspace.id)
  else await renderSidebar()
  return true
}

// Boot continuation — everything that touches encrypted data,
// triage-sync sessions, OPFS reads, or the UI's restored state.
// Gated behind `bootContinuationRan` so it runs once per page load,
// whether via the boot IIFE (vault disabled or unlocked at boot) or
// the vault-state-change listener (unlock dismissed at boot, user
// later unlocks via the overlay).
//
// While `bootContinuationRan === false` and the vault is locked,
// NOTHING operational runs in this tab:
//   - secure-storage cache is empty → workspaces / sync sessions
//     appear empty, no last-file pointer, etc.
//   - The sidebar isn't rendered, so OPFS is never scanned.
//   - triage-sync never opens a WS connection (sessions open only via
//     a workspace's `openSession`, i.e. switchToWorkspace, part of
//     this continuation).
//   - objstore-presence never sees a session, so no auto-download
//     fires — the locked-vault saveFileBytes rejection is
//     defensive-only.
//   - The lock overlay is the only interactive surface; the rest
//     of the app is effectively suspended.
let bootContinuationRan = false

async function continueBoot() {
  if (bootContinuationRan) return
  bootContinuationRan = true
  // Hydrate the encrypted-localStorage cache (workspaces, sync
  // sessions, repoUrls, fileCounts, lastFile). MUST run BEFORE
  // renderSidebar / restore-last-file — those paths read the cache
  // synchronously via getItem(). No-op fast path when the vault is
  // disabled (everything was plaintext on disk, cached verbatim).
  await hydrateSecureStorage()
  // Snapshot the now-decrypted workspaces as "already observed" so the
  // first sibling-tab storage event doesn't fire phantom
  // workspace-created listeners for entries present in storage at boot.
  syncObservedAfterHydrate()
  // Sync chunk loading is driven by the sidebar's `renderSyncStatus`
  // (called from `renderSidebar` below): it loads `ui/client-sync.js`
  // only when the status button is visible (usable URL + ≥1 workspace)
  // and the user hasn't opted out. Boot does NOT pre-load — a user with
  // no workspaces never downloads the sync payload.
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
    } else if (last.startsWith('b:')) {
      // Bundle restore — mirrors the bundle-only-drop branch in
      // `addFiles` / the sidebar's `bundleEl` click handler. The
      // `renderSidebar()` above populated the bundles list, so
      // membership is checked synchronously; missing entries (deleted
      // in another tab between sessions) fall through to the empty
      // drop-zone. A space-delimited suffix encodes the active tab
      // (terminal / treemap / graph / compare / advisories / issues / code); an
      // unknown / missing suffix defaults to Overview (also catching
      // old persisted suffixes for removed values).
      const rest = last.slice(2)
      const spaceIdx = rest.indexOf(' ')
      const integrity = spaceIdx >= 0 ? rest.slice(0, spaceIdx) : rest
      const savedTab = spaceIdx >= 0 ? rest.slice(spaceIdx + 1) : ''
      const tab = BUNDLE_TABS.has(savedTab) ? savedTab : 'overview'
      if ((state.bundles ?? []).some((b) => b.integrity === integrity)) {
        state.currentView = 'bundles'
        state.selectedBundle = integrity
        state.bundleDetails = null
        state.bundleSourceFile = null
        state.bundleSourceFindingIdx = null
        state.bundleCodeSearchQuery = ''
        state.bundleCodeSearchMode = 'files'
        state.bundleDetailsTab = tab
        state.shownTriage = null
        graph2.showAll = true
        render()
        openBundle(integrity)
      }
    } else {
      const names = await listFiles()
      if (names.includes(last)) await switchToFile(last)
    }
  }
}

// Vault state transitions:
//   1. First unlock after a locked-boot → run the deferred
//      continueBoot.
//   2. Mid-session sibling-tab enable / re-key (we were running with
//      no encryption or a different credential, vault now
//      enabled-but-not-unlocked-here) → force reload. Our in-memory
//      state (open WS sessions, decrypted `state.*` maps,
//      secure-storage cache) is stale vs. the just-flipped storage
//      shape and unsafe to keep operating against. The reload restarts
//      this tab in the locked-boot state, overlay covering everything
//      until unlock.
//   3. Mid-session sibling-tab DISABLE (we were operational under an
//      enabled vault, sibling just decrypted-and-cleared metadata) →
//      force reload. Without it, our hydrate runs against sibling's
//      mid-migration disk and `propagate*` listeners fire spurious
//      per-workspace deletes as the cache transiently empties (envelope
//      keys un-decryptable once sibling's `clearMetadata` storage event
//      drops our sessionKey). `isDisablingInThisTab()` distinguishes
//      this from our OWN `disableEncryption` — that user clicked Disable
//      here and expects to continue in this tab.
//   4. Any other transition (intra-tab disable, intra-tab unlock
//      that didn't go through the boot-deferred path) just
//      re-renders.
//
// `alert()` (single "OK") rather than `confirm()` for the reload
// prompts: a decline path is a footgun — the lock overlay's opaque
// backdrop covers everything, so the user can't usefully "stash unsaved
// work" after declining. Acknowledgement-only avoids that trap while
// still giving notice.
let lastSeenEnabled = isEncryptionEnabled()
let reloadPending = false
function scheduleReload(reason) {
  if (reloadPending) return
  reloadPending = true
  // Defer to a microtask so the synchronous `render()` above paints the
  // new vault state BEFORE the alert grabs the event loop — the user
  // sees context for the reload.
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

// A share link opened in a FRESH tab rides the boot pipeline above
// (`continueBoot` → `handleShareHashIfPresent`, off the initial
// `location.hash`). But pasting one into the address bar of an
// ALREADY-OPEN tab only mutates the fragment — no navigation, so boot
// never re-runs and the link used to silently do nothing. Re-run the
// same handler on `hashchange` so it attaches in place.
//
// Gated on `bootContinuationRan`: while the vault is enabled-but-locked
// the continuation hasn't run (workspaces un-hydrated, lock overlay
// up), so leave the hash in the URL for the post-unlock `continueBoot`
// to pick up rather than stacking the unlock dialog over the overlay
// against an empty workspaces list. No re-entrancy flag is needed —
// `handleShareHashIfPresent` strips the fragment synchronously before
// its first await, so a same-hash re-entry reads an empty hash and
// no-ops, and a second DISTINCT link arriving mid-dialog trips the
// dialog's own modal-conflict guard. The same strip also covers a
// hashchange landing mid-boot: `bootContinuationRan` flips true at
// `continueBoot`'s top, BEFORE boot's own one-shot call, so the two can
// race — but only one sees the (then-stripped) payload, leaving at
// worst a redundant last-file restore, never a double-attach. The
// handler swallows its expected failures (dialog-open, collisions)
// internally; the catch here is a
// backstop so an unexpected rejection in an event listener doesn't
// surface as an unhandledrejection.
window.addEventListener('hashchange', () => {
  if (!bootContinuationRan) return
  handleShareHashIfPresent().catch((err) => console.warn('share-link hashchange:', err))
})

;(async () => {
  // Legacy-origin redirect: deepaudit.dev users with no local data
  // bounce silently to triage.space; users with data get a confirm
  // dialog. Either resolves to a navigation that supersedes this boot,
  // so a `true` return short-circuits the file-restore below — running
  // it would re-touch OPFS / state.* in a tab about to unload.
  if (await runLegacyOriginCheck()) return
  try {
    // In WCO mode the sidebar header is the surface the OS controls
    // overlay onto; collapsing it would strand close / min / max over a
    // 32px strip, so ignore the persisted flag and pin the sidebar open.
    const isAppHeader = window.matchMedia?.('(display-mode: window-controls-overlay)').matches
    if (!isAppHeader && localStorage.getItem('deepview.sidebarCollapsed') === '1') sidebar.classList.add('collapsed')
    // Installed-PWA modes (standalone OR window-controls-overlay) —
    // launched as a standalone app, not a browser tab, so app-level
    // page zoom (ctrl/cmd+wheel, ctrl/cmd+ +/-/0, touch-pinch) should be
    // inert as in any native app. Browser tabs keep the default.
    // matchMedia on display-mode is the standard installed-PWA detector.
    const isInstalled = window.matchMedia?.('(display-mode: standalone)').matches || isAppHeader
    if (isInstalled) {
      const viewport = document.querySelector('meta[name="viewport"]')
      if (viewport) viewport.setAttribute('content', 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no')
      // Desktop ctrl/cmd+wheel = browser zoom; passive: false so
      // preventDefault actually inhibits it. Canvas / scroll-container
      // wheel handlers run first (no capture phase here) so their pan /
      // zoom still fires; we just stop the browser from also zooming.
      window.addEventListener('wheel', (e) => { if (e.ctrlKey || e.metaKey) e.preventDefault() }, { passive: false })
      window.addEventListener('keydown', (e) => {
        if (!(e.ctrlKey || e.metaKey)) return
        if (e.key === '=' || e.key === '+' || e.key === '-' || e.key === '0') e.preventDefault()
      })
    }
  } catch {}
  // Vault enabled-but-locked at boot: skip continueBoot and let the
  // lock overlay (`view/lock-overlay.js`) be the sole unlock affordance.
  // Clicking the overlay button opens the unlock dialog; on success the
  // vault-state-change listener above kicks continueBoot. While locked,
  // no operational work happens here — no WS connection, no sidebar
  // render, no auto-download. The dialog appears only on user intent
  // (not auto-opened) so it doesn't stack two unlock surfaces over the
  // overlay.
  if (isEncryptionEnabled() && !isUnlocked()) return
  await continueBoot()
})()
