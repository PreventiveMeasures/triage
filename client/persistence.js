// Storage persistence + quota visibility.
//
// Everything the app stores locally — OPFS reports/bundles, the
// localStorage fallback, triage state, workspaces — lives in the
// origin's storage bucket, which is "best-effort" by default: the
// browser may evict the WHOLE bucket (all APIs at once, without
// asking) under disk pressure, and WebKit's ITP additionally deletes
// all of an origin's script-writable storage after 7 days of Safari
// use with no user interaction on the origin. That eviction is the
// main real-world cause of "my reports disappeared".
//
// `navigator.storage.persist()` asks to flip the bucket to
// "persistent", exempting it from automatic eviction. Grant behavior
// differs per engine, which shapes how callers should use this:
//
//   - Chromium: no prompt — silently granted when the origin looks
//     important (bookmarked, high site engagement, installed PWA,
//     notifications permission), silently denied otherwise. Worth
//     re-asking later: engagement accrues with use.
//   - Firefox: shows a permission prompt. Callers should only ask
//     when there is data worth protecting (or on explicit user
//     action), not unconditionally at boot on an empty profile.
//   - Safari: no prompt; effectively tied to install state. A
//     regular tab stays subject to the 7-day ITP cleanup regardless
//     — only home-screen / Dock installs are exempt, so UI should
//     pair a denied/ineffective request with install guidance.
//
// This module is the thin, policy-free API layer: probing and
// requesting only. WHEN to auto-request (and how to surface the
// state) is the UI's call — see ui/view/storage-status.js.

// The Storage API surface exists (secure contexts on all evergreen
// engines). Individual methods are still feature-checked per call —
// engines shipped `estimate` / `persisted` / `persist` at different
// times and workers/iframes can expose a subset.
export function isStorageManagerSupported() {
  return typeof navigator !== 'undefined' && typeof navigator.storage === 'object' && navigator.storage !== null
}

// Ask the browser to mark this origin's bucket persistent. Returns
// true only on a confirmed grant; false covers denied, unsupported,
// and a throwing implementation alike (callers treat all three as
// "still best-effort"). Safe to call repeatedly — a granted state is
// sticky, and re-requesting after a Chromium silent-denial is how a
// later engagement-based grant is picked up.
export async function requestPersistentStorage() {
  if (!isStorageManagerSupported() || typeof navigator.storage.persist !== 'function') return false
  try {
    return await navigator.storage.persist() === true
  } catch {
    return false
  }
}

// Snapshot of the bucket's persistence + usage state:
//   { supported, persisted, usage, quota }
// `persisted` / `usage` / `quota` are null when the corresponding
// probe is unavailable or failed — null means "unknown", NOT "no" /
// zero, so UI can suppress rather than mis-render the field. Usage
// and quota are bytes; both come from `estimate()`, which is
// explicitly an estimate (browsers pad/round to resist
// fingerprinting) — display-grade, not accounting-grade.
export async function getStorageInfo() {
  const info = { supported: isStorageManagerSupported(), persisted: null, usage: null, quota: null }
  if (!info.supported) return info
  if (typeof navigator.storage.persisted === 'function') {
    try { info.persisted = await navigator.storage.persisted() } catch {}
  }
  if (typeof navigator.storage.estimate === 'function') {
    try {
      const est = await navigator.storage.estimate()
      if (typeof est?.usage === 'number') info.usage = est.usage
      if (typeof est?.quota === 'number') info.quota = est.quota
    } catch {}
  }
  return info
}
