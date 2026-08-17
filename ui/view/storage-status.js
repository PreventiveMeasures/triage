// Sidebar storage-status line — makes the origin's storage-bucket
// state VISIBLE, because browser eviction of best-effort storage is
// the main real-world way a user "loses" reports without ever
// touching a delete button (see client/persistence.js for the
// per-engine rules). Three concerns live here:
//
//   1. Paint: a WARNING-ONLY banner above the sidebar actions row.
//      It renders solely when there is local data to lose (reports
//      or bundles) AND the bucket is confirmed best-effort
//      ("Storage at risk", explanation + usage in the tooltip) —
//      an empty profile, a granted, or an unknowable persistence
//      state paints NOTHING. Healthy storage is the expected steady
//      state; a permanent "everything is fine" ornament is just
//      visual noise, and warning about data that doesn't exist is
//      worse.
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
// Whether any local reports/bundles exist — the "is there anything
// to lose" half of the paint predicate, refreshed together with
// `info`. Defaults to false so the banner can't flash on an empty
// profile before the first probe lands.
let hasLocalData = false
// One auto-request per session (manual clicks are always allowed).
// Guards the Firefox prompt from re-firing on every import.
let autoRequested = false
// Trailing debounce for refresh — renderSidebar fires on every
// mutation burst (drops, deletes, sync downloads), and estimate()
// per keystroke-ish cadence is wasteful. 1s trailing keeps the
// number honest without the spam.
let refreshTimer = 0

// iOS/iPadOS browsers are all WebKit (CriOS / FxiOS / EdgiOS
// included), and desktop Safari carries no Chrome/Edg/OPR token —
// so "WebKit and not a Chromium/Blink UA" is the population
// governed by ITP's 7-day cleanup. The Blink tokens are slash-
// anchored where a WebKit sibling shares the prefix (EdgiOS vs
// Edg/, OPT vs OPR/). UA sniffing is fine at tooltip-copy stakes.
function isItpGoverned() {
  const ua = navigator.userAgent
  return /AppleWebKit/u.test(ua) && !/Chrome\/|Chromium|Edg\/|OPR\/|Android/u.test(ua)
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
  // Warning-only: paint solely when there is local data to lose AND
  // the bucket is CONFIRMED best-effort. An empty profile, a
  // granted, an unknowable, and an unsupported state all hide the
  // banner — no "everything is fine" ornament, no warning about
  // data that doesn't exist.
  if (!info || info.persisted !== false || !hasLocalData) {
    button.hidden = true
    return
  }
  button.hidden = false
  const usageDetail = info.usage === null || info.quota === null
    ? ''
    : ` Using ${formatStorageSize(info.usage)} of ${formatStorageSize(info.quota)}.`
  button.querySelector('.storage-label').textContent = 'Storage at risk'
  button.title = 'Reports, bundles and triage are in best-effort storage — the browser may delete them all under disk pressure or after long inactivity. '
    + (isItpGoverned()
      ? 'On Safari (and all iOS browsers) data is cleared after 7 days without using the site; add this page to your Home Screen or Dock to prevent that.'
      : 'Click to request persistent storage. Firefox asks via a prompt; Chromium-based browsers never prompt and grant it only to sites they consider important — installed as an app, bookmarked, allowed to send notifications, or heavily used.')
    + usageDetail
}

// Chromium's denial is silent, so the breadcrumb explains WHY and
// what would flip it — otherwise a user clicking the banner sees
// "not granted" with no effect and reads it as a bug.
//
// The `localhost` special case is structural, not a heuristic
// shortfall: Chromium's important-sites ranking (which gates the
// grant) keys every signal — engagement, notifications, installed
// app, bookmarks — by REGISTERABLE DOMAIN, with an explicit
// fallback to the host only for IP literals
// (ImportantSitesUtil::GetRegisterableDomainOrIPFromHost). Plain
// `localhost` has no registerable domain and is not an IP, so its
// signals are dropped before ranking and persist() can never be
// granted there, no matter what the user enables. 127.0.0.1 IS an
// IP literal (and still a secure context), so it can pass.
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

export async function refreshStorageStatus() {
  if (!button) return
  // Both halves of the paint predicate refresh together so the
  // banner can't show a stale combination (e.g. warn after the last
  // report was deleted). An enumeration failure reads as "no data"
  // — for a warning-only surface, failing quiet beats failing loud.
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

// Debounced refresh for high-frequency callers (renderSidebar).
export function scheduleStorageStatusRefresh() {
  if (!button || refreshTimer) return
  refreshTimer = setTimeout(() => {
    refreshTimer = 0
    void refreshStorageStatus()
  }, 1000)
}

// The once-per-session auto-request — see the policy note up top.
// The `autoRequested` re-check after the await guards the flip
// synchronously, so a save-burst can't fire persist() twice. An
// enumeration failure inside refreshStorageStatus reads as "no
// data", which also means the one auto-ask isn't burnt on it.
async function maybeAutoRequest() {
  if (autoRequested) return
  await refreshStorageStatus()
  if (info?.persisted !== false || !hasLocalData || autoRequested) return
  autoRequested = true
  const granted = await requestPersistentStorage()
  // Breadcrumb either way — an operator debugging "reports vanished"
  // needs to know whether this profile's bucket was ever protected.
  logRequestOutcome(granted, false)
  await refreshStorageStatus()
}

async function onClick() {
  if (info && info.persisted === false) {
    autoRequested = true // a manual ask supersedes the auto one
    const granted = await requestPersistentStorage()
    logRequestOutcome(granted, true)
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
