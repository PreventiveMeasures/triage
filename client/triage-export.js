import { gunzipToText, gzipText } from '../common/gzip.js'
import { makeIgnoredKey, splitIgnoredKey } from '../common/ignored-key.js'
import { REPO_URLS_KEY, state } from './state.ts'
import { SESSION_ID_RE, buildPersistedTriageEntries, saveTriage } from './triage.js'

// Pure-logic side of the global triage backup. The DOM-touching
// layer (file picker, anchor-click download, dialog) lives in
// `ui/view/triage-export-dialog.js` and calls into here.
//
// Difference from `client/workspace-export.js`: that one slices
// triage by report-membership of a single workspace; this one
// dumps the full persisted-id set and ALL saved repo URLs in one
// shot so a user can move their full triage state to another
// machine / browser. No reports / workspaces ride along — just
// the keyed-by-finding-id triage map and the keyed-by-report-name
// repo URL map.

const EXPORT_VERSION = 1

// Build the export payload object. Reads from in-memory `state.*`
// for triage (mirroring `saveTriage`'s session-id filter) and
// from localStorage for repo URLs (the latter is the source of
// truth — `state.repoUrl` only holds the active report's URL).
export function buildTriageExportPayload() {
  const entries = buildPersistedTriageEntries()

  let repoUrls = {}
  try { repoUrls = JSON.parse(localStorage.getItem(REPO_URLS_KEY) || '{}') } catch {}

  return {
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    triage: entries,
    repoUrls,
  }
}

// Filename uses an ISO-like timestamp so multiple exports sort
// chronologically in the user's downloads folder. Colons / dots
// are illegal on Windows; replaced with hyphens. Seconds-precision
// is enough — same-second exports are exceedingly rare.
function timestampFilename() {
  const dt = new Date().toISOString().replaceAll(/[:.]/gu, '-').slice(0, 19)
  return `deepview-triage-${dt}.json.gz`
}

export async function buildTriageExportGzip() {
  const payload = buildTriageExportPayload()
  const blob = new Blob([await gzipText(JSON.stringify(payload))])
  return { blob, filename: timestampFilename() }
}

export async function parseTriageExportGzip(file) {
  let text
  try {
    text = await gunzipToText(new Uint8Array(await file.arrayBuffer()))
  } catch (err) {
    throw new Error(`Failed to gunzip: ${err.message}`, { cause: err })
  }
  let payload
  try {
    payload = JSON.parse(text)
  } catch (err) {
    throw new Error(`Failed to parse JSON: ${err.message}`, { cause: err })
  }
  if (!payload || typeof payload !== 'object') throw new Error('Invalid backup file (not an object)')
  if (payload.version !== EXPORT_VERSION) {
    throw new Error(`Unsupported backup version: ${payload.version} (expected ${EXPORT_VERSION})`)
  }
  if (!payload.triage || typeof payload.triage !== 'object') {
    throw new Error('Backup is missing the `triage` map')
  }
  if (!payload.repoUrls || typeof payload.repoUrls !== 'object') {
    throw new Error('Backup is missing the `repoUrls` map')
  }
  return payload
}

// Apply an imported payload to the in-memory state + localStorage.
// `mode` is one of:
//   * 'replace'         — drop every persisted-id entry first,
//                         then install the imported set verbatim.
//   * 'prefer-imported' — merge; on key collision the imported
//                         value overwrites the current one.
//   * 'prefer-current'  — merge; on key collision the current
//                         value wins (only fills gaps).
//
// Session-only ids (numeric `_id` from a report without uuids) are
// never touched in any mode — they wouldn't have been in the
// backup anyway, and clearing them mid-session would orphan live
// triage on the open report.
export async function applyTriageImport(payload, mode) {
  if (!['replace', 'prefer-imported', 'prefer-current'].includes(mode)) {
    throw new Error(`Unknown merge mode: ${mode}`)
  }
  // Re-validate payload shape: callers may hand us a programmatically
  // built object that bypassed `parseTriageExportGzip`. Without this,
  // a missing/null `triage` or `repoUrls` would mutate state in
  // `replace` mode and then crash on `Object.entries(undefined)` —
  // half-applied import in memory; the persisted blob diverges. Audit
  // round-14 TE-1.
  if (!payload || typeof payload !== 'object') {
    throw new Error('Invalid payload: not an object')
  }
  if (!payload.triage || typeof payload.triage !== 'object' || Array.isArray(payload.triage)) {
    throw new Error('Invalid payload: missing or non-object `triage`')
  }
  if (!payload.repoUrls || typeof payload.repoUrls !== 'object' || Array.isArray(payload.repoUrls)) {
    throw new Error('Invalid payload: missing or non-object `repoUrls`')
  }
  const imported = payload.triage

  if (mode === 'replace') {
    for (const k of [...state.markers.keys()]) {
      if (!SESSION_ID_RE.test(k)) state.markers.delete(k)
    }
    for (const k of [...state.triageState.keys()]) {
      if (!SESSION_ID_RE.test(k)) state.triageState.delete(k)
    }
    for (const k of [...state.comments.keys()]) {
      if (!SESSION_ID_RE.test(k)) state.comments.delete(k)
    }
    for (const k of [...state.fixes.keys()]) {
      if (!SESSION_ID_RE.test(k)) state.fixes.delete(k)
    }
    for (const key of [...state.ignoredIds]) {
      const parts = splitIgnoredKey(key)
      if (!parts) continue
      const { id } = parts
      if (!SESSION_ID_RE.test(id)) state.ignoredIds.delete(key)
    }
  }

  const keepCurrent = mode === 'prefer-current'

  for (const [id, v] of Object.entries(imported)) {
    if (SESSION_ID_RE.test(id)) continue
    if (!v || typeof v !== 'object') continue

    if (typeof v.color === 'string' && v.color && (!keepCurrent || !state.markers.has(id))) {
      state.markers.set(id, v.color)
    }
    // Triage state — preferred form is `triage:`; legacy `deleted: true`
    // entries map to 'deleted', matching the load path in triage.js.
    let triageVal = null
    if (v.triage === 'fixed' || v.triage === 'invalid' || v.triage === 'deleted') triageVal = v.triage
    else if (v.deleted) triageVal = 'deleted'
    if (triageVal && (!keepCurrent || !state.triageState.has(id))) {
      state.triageState.set(id, triageVal)
    }
    if (typeof v.comment === 'string' && v.comment && (!keepCurrent || !state.comments.has(id))) {
      state.comments.set(id, v.comment)
    }
    if (typeof v.fix === 'string' && v.fix && (!keepCurrent || !state.fixes.has(id))) {
      state.fixes.set(id, v.fix)
    }
    // Per-report ignore: mutex with triage state. Skip the
    // ignoredReports merge when this id ended up with a triage
    // state (same rule the cross-tab apply path enforces).
    if (Array.isArray(v.ignoredReports) && !state.triageState.has(id)) {
      for (const r of v.ignoredReports) {
        if (typeof r !== 'string') continue
        const key = makeIgnoredKey(r, id)
        if (keepCurrent && state.ignoredIds.has(key)) continue
        state.ignoredIds.add(key)
      }
    }
  }

  await saveTriage()

  // Repo URLs — read current map fresh, merge per mode, write
  // back. The keys are OPFS report names; values are URLs.
  let current = {}
  try { current = JSON.parse(localStorage.getItem(REPO_URLS_KEY) || '{}') } catch {}
  let merged
  if (mode === 'replace') merged = { ...payload.repoUrls }
  else if (mode === 'prefer-imported') merged = { ...current, ...payload.repoUrls }
  else merged = { ...payload.repoUrls, ...current }
  try { localStorage.setItem(REPO_URLS_KEY, JSON.stringify(merged)) } catch {}

  return {
    triageEntries: Object.keys(imported).length,
    repoUrls: Object.keys(payload.repoUrls).length,
  }
}
