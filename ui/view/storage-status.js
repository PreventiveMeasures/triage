// The sidebar's storage-status line: the browser evicting best-effort
// storage is the main way a user "loses" reports without touching a delete
// button (client/persistence.js has the per-engine rules), so it shows.
//   1. Warning only: it paints solely with local data to lose (reports or
//      bundles) in a bucket confirmed best-effort. An empty profile, a
//      granted or an unknowable state paints nothing — no "all fine"
//      ornament, no warning about data that doesn't exist.
//   2. Persistent storage is requested once per session, and only once
//      there is data to protect: Firefox prompts on persist(), rude to a
//      first-time visitor with an empty workspace (Chromium and Safari
//      answer silently). Asked at the boot probe and on saves, so the first
//      import triggers it.
//   3. A click asks again under a user gesture: Chromium's silent grant is
//      engagement-based (bookmark, repeat use, install, notifications), so
//      a later ask can succeed where boot's failed.
// Safari can't be helped from script — persist() doesn't exempt a regular
// tab from ITP's 7-day cleanup, only Home Screen / Dock installs — and the
// tooltip says so there rather than pretend the click helps.

import { getStorageInfo, hasAnyBundles, isManagedUiMode, listFiles, onFileMutated, requestPersistentStorage } from '#client/index.js'
import { ensureClientMode } from './sidebar.js'
import { openStoragePersistDialog } from './lazy-dialogs.js'

// The sidebar's button, once initStorageStatus hands it over.
let button = null
// The getStorageInfo snapshot painted; null until the first refresh.
let info = null
// Whether local reports / bundles exist, refreshed with `info`; false until
// then, so the banner can't flash on an empty profile.
let hasLocalData = false
// Guards the one auto-request (and Firefox's prompt) per session.
let autoRequested = false
// A trailing 1s debounce: renderSidebar fires on every mutation burst.
let refreshTimer = 0

// Which grant model this browser follows. Every iOS/iPadOS browser is
// WebKit (CriOS / FxiOS / EdgiOS included) and desktop Safari carries no
// Blink token, so "AppleWebKit and not Blink" is the ITP-governed population;
// the Blink tokens are slash-anchored where a WebKit sibling shares the
// prefix (EdgiOS vs Edg/, OPT vs OPR/). Desktop Firefox alone prompts (FxiOS
// is WebKit, without `Firefox/`); the rest is Chromium's silent heuristics.
// UA sniffing is fine at instruction-copy stakes; the instructions dialog
// reads the same answer, so the copy can't drift apart.
export function persistGrantFlavor() {
  const ua = navigator.userAgent
  if (/AppleWebKit/u.test(ua) && !/Chrome\/|Chromium|Edg\/|OPR\/|Android/u.test(ua)) return 'webkit'
  if (/Firefox\//u.test(ua)) return 'firefox'
  return 'chromium'
}

function isItpGoverned() {
  return persistGrantFlavor() === 'webkit'
}

// navigator.storage.estimate() is fuzzed already: one decimal is plenty.
function formatStorageSize(n) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)} kB`
  return `${n} B`
}

function paint() {
  if (!button) return
  if (isManagedUiMode() || !info || info.persisted !== false || !hasLocalData) {
    button.hidden = true
    return
  }
  button.hidden = false
  const usageDetail = info.usage === null || info.quota === null
    ? ''
    : ` Using ${formatStorageSize(info.usage)} of ${formatStorageSize(info.quota)}.`
  button.querySelector('.storage-label').textContent = 'Storage at risk'
  button.dataset.tooltip = 'Reports, bundles and triage are in best-effort storage — the browser may delete them all under disk pressure or after long inactivity. '
    + (isItpGoverned()
      ? 'Click for how to protect them (on Safari and iOS browsers this needs the app installed to the Home Screen or Dock).'
      : 'Click to request persistent storage — if the browser declines, instructions for enabling it follow.')
    + usageDetail
}

// Chromium's denial is silent, so the breadcrumb says why and what would
// flip it. Plain `localhost` is structural, not a heuristic shortfall:
// Chromium ranks site importance by registerable domain, falling back to the
// host only for IP literals (ImportantSitesUtil::
// GetRegisterableDomainOrIPFromHost), so localhost's signals are all dropped
// and persist() can never be granted there; 127.0.0.1 can pass.
function logRequestOutcome(granted, viaGesture) {
  const suffix = viaGesture ? ' (user gesture)' : ''
  if (granted) {
    console.info(`storage: persistent-storage request granted${suffix}`)
    return
  }
  const localhostNote = !isItpGoverned() && location.hostname === 'localhost'
    ? ' Note: plain localhost can NEVER pass — Chromium keys site importance by registerable domain (IP literals excepted) and localhost has none; for local testing use 127.0.0.1 instead.'
    : ''
  console.info(
    `storage: persistent-storage request not granted${suffix} — `
    + (isItpGoverned()
      ? 'Safari ties persistence to install state; add the app to the Home Screen / Dock.'
      : 'Chromium-based browsers never prompt and silently deny origins they don\'t consider important; installing the app, bookmarking it, allowing notifications, or regular use flips the heuristic (re-evaluated on every request). Firefox shows a prompt instead.')
    + localhostNote,
  )
}

async function refreshStorageStatus() {
  await ensureClientMode()
  if (!button || isManagedUiMode()) { paint(); return }
  // Both halves together, so the banner can't pair stale ones (a warning
  // after the last report went). A failed enumeration reads as no data:
  // for a warning-only surface, failing quiet beats failing loud.
  const [nextInfo, nextHasData] = await Promise.all([
    getStorageInfo(),
    (async () => {
      try { return (await listFiles()).length > 0 || await hasAnyBundles() } catch { return false }
    })(),
  ])
  info = nextInfo
  hasLocalData = nextHasData
  paint()
}

export function scheduleStorageStatusRefresh() {
  if (!button || refreshTimer) return
  refreshTimer = setTimeout(() => {
    refreshTimer = 0
    void refreshStorageStatus()
  }, 1000)
}

// The once-per-session auto-request. Re-checked after the await, so a save
// burst can't ask twice; a failed enumeration (no data) doesn't burn it.
async function maybeAutoRequest() {
  if (autoRequested) return
  await refreshStorageStatus()
  if (isManagedUiMode() || info?.persisted !== false || !hasLocalData || autoRequested) return
  autoRequested = true
  const granted = await requestPersistentStorage()
  // Either way: debugging "reports vanished" needs to know whether this
  // profile's bucket was ever protected.
  logRequestOutcome(granted, false)
  await refreshStorageStatus()
}

async function onClick() {
  if (info && info.persisted === false) {
    autoRequested = true // a manual ask supersedes the auto one
    const granted = await requestPersistentStorage()
    logRequestOutcome(granted, true)
    // A click that visibly does nothing reads as a bug: open the per-engine
    // instructions (whose Try again can itself succeed).
    if (!granted) await openStoragePersistDialog()
  }
  await refreshStorageStatus()
}

export function initStorageStatus(el) {
  button = el
  if (!button) return
  button.addEventListener('click', () => { void onClick() })
  // Each save is a chance at fresher numbers and the one auto-request now
  // that data exists; deletes just refresh.
  onFileMutated((_name, kind) => {
    scheduleStorageStatusRefresh()
    if (kind === 'save') void maybeAutoRequest()
  })
  void maybeAutoRequest()
}
