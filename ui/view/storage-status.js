// Sidebar storage-status line — makes the origin's storage-bucket
// state VISIBLE, because browser eviction of best-effort storage is
// the main real-world way a user "loses" reports without ever
// touching a delete button (see client/persistence.js for the
// per-engine rules). Three concerns live here:
//
//   1. Paint: a dot + short label under the sidebar actions row
//      ("Storage protected · 12.3 MB" / "Storage at risk · …"),
//      with the full explanation in the tooltip. Hidden when the
//      environment can't answer either probe (file://, ancient
//      engines) — an eternally-unknown indicator is noise.
//   2. Auto-request policy: ask for persistent storage once per
//      session, and only once there is local data to protect —
//      Firefox shows a permission prompt on persist(), and popping
//      one at a first-time visitor with an empty workspace is rude.
//      Chromium/Safari resolve silently either way. Wired to the
//      boot probe AND to onFileMutated saves, so the first import
//      (the moment data starts existing) triggers the ask.
//   3. Manual retry: clicking the line re-requests under a user
//      gesture. Chromium's silent grant is engagement-based
//      (bookmark, repeat use, install, notifications), so a later
//      manual attempt can succeed where boot's failed.
//
// Safari can't be fixed from script at all — persist() doesn't
// exempt a regular tab from ITP's 7-day cleanup; only home-screen /
// Dock installs are. The not-persisted tooltip says so on WebKit
// rather than pretending the click can help.

import { getStorageInfo, hasAnyBundles, listFiles, onFileMutated, requestPersistentStorage } from '#client/index.js'

// Set by `initStorageStatus(el)` once the sidebar has rendered the
// `#storage-status` button into its shadow DOM. Before that the
// module's functions no-op on the null button.
let button = null
// Last getStorageInfo snapshot driving the paint. Null until the
// first refresh resolves (button stays hidden).
let info = null
// One auto-request per session (manual clicks are always allowed).
// Guards the Firefox prompt from re-firing on every import.
let autoRequested = false
// Trailing debounce for refresh — renderSidebar fires on every
// mutation burst (drops, deletes, sync downloads), and estimate()
// per keystroke-ish cadence is wasteful. 1s trailing keeps the
// number honest without the spam.
let refreshTimer = 0

// iOS/iPadOS browsers are all WebKit (CriOS / FxiOS included), and
// desktop Safari carries no Chrome/Edg/OPR token — so "WebKit and
// not a Chromium/Blink UA" is the population governed by ITP's
// 7-day cleanup. UA sniffing is fine at tooltip-copy stakes.
function isItpGoverned() {
  const ua = navigator.userAgent
  return /AppleWebKit/u.test(ua) && !/Chrome|Chromium|Edg|OPR|Android/u.test(ua)
}

// Human-scale size for the label; navigator.storage.estimate() is
// already fuzzed by the browser, so one decimal is plenty.
function formatStorageSize(n) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)} kB`
  return `${n} B`
}

function paint() {
  if (!button) return
  // Neither probe answered → nothing truthful to show.
  if (!info || !info.supported || (info.persisted === null && info.usage === null)) {
    button.hidden = true
    return
  }
  button.hidden = false
  const labelEl = button.querySelector('.storage-label')
  const usagePart = info.usage === null ? '' : ` · ${formatStorageSize(info.usage)}`
  const usageDetail = info.usage === null || info.quota === null
    ? ''
    : ` Using ${formatStorageSize(info.usage)} of ${formatStorageSize(info.quota)}.`
  button.toggleAttribute('data-persisted', info.persisted === true)
  if (info.persisted === true) {
    labelEl.textContent = `Storage protected${usagePart}`
    button.title = `Persistent storage granted — the browser won't auto-delete this site's reports, bundles and triage.${usageDetail}`
  } else if (info.persisted === false) {
    labelEl.textContent = `Storage at risk${usagePart}`
    button.title = 'Reports, bundles and triage are in best-effort storage — the browser may delete them all under disk pressure or after long inactivity. '
      + (isItpGoverned()
        ? 'On Safari (and all iOS browsers) data is cleared after 7 days without using the site; add this page to your Home Screen or Dock to prevent that.'
        : 'Click to request persistent storage (browsers grant it silently based on how much you use the site, or after a prompt).')
      + usageDetail
  } else {
    // persisted unknowable but usage known — still worth showing.
    labelEl.textContent = `Storage${usagePart}`
    button.title = `Local storage used by reports, bundles and triage.${usageDetail}`
  }
}

export async function refreshStorageStatus() {
  if (!button) return
  info = await getStorageInfo()
  paint()
}

// Debounced refresh for high-frequency callers (renderSidebar).
export function scheduleStorageStatusRefresh() {
  if (!button || refreshTimer) return
  refreshTimer = setTimeout(() => {
    refreshTimer = 0
    void refreshStorageStatus()
  }, 1000)
}

// The once-per-session auto-request — see the policy note up top.
// Re-entry is guarded by `autoRequested` being flipped BEFORE the
// await, so a save-burst can't fire persist() twice.
async function maybeAutoRequest() {
  if (autoRequested) return
  info = await getStorageInfo()
  paint()
  if (info.persisted !== false) return // granted already, or unknowable
  let hasData = false
  try {
    hasData = (await listFiles()).length > 0 || await hasAnyBundles()
  } catch {
    return // enumeration failed — don't burn the one auto-ask on it
  }
  if (!hasData || autoRequested) return
  autoRequested = true
  const granted = await requestPersistentStorage()
  // Breadcrumb either way — an operator debugging "reports vanished"
  // needs to know whether this profile's bucket was ever protected.
  console.info(`storage: persistent-storage request ${granted ? 'granted' : 'not granted'}`)
  await refreshStorageStatus()
}

async function onClick() {
  if (info && info.persisted === false) {
    autoRequested = true // a manual ask supersedes the auto one
    const granted = await requestPersistentStorage()
    console.info(`storage: persistent-storage request ${granted ? 'granted' : 'not granted'} (user gesture)`)
  }
  await refreshStorageStatus()
}

export function initStorageStatus(el) {
  button = el
  if (!button) return
  button.addEventListener('click', () => { void onClick() })
  // Every report save is a chance to (a) show fresher numbers and
  // (b) fire the one auto-request now that data exists. Deletes
  // just refresh.
  onFileMutated((_name, kind) => {
    scheduleStorageStatusRefresh()
    if (kind === 'save') void maybeAutoRequest()
  })
  void maybeAutoRequest()
}
