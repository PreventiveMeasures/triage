import { gunzipToText, gzipText } from '../common/gzip.js'
import { bucketOf, isReportIgnored, patchEntry, setReportIgnored } from './triage-entry.ts'
import { importRepoUrls, readRepoUrlMap, state } from './state.ts'
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
// for triage (mirroring `saveTriage`'s session-id filter) and the
// repo-URL map from secure-storage (the latter is the source of
// truth — `state.repoUrl` only holds the active report's URL).
// `readRepoUrlMap` reads through the secure-storage cache, NOT raw
// localStorage: under an enabled vault the slot holds an encrypted
// envelope that `JSON.parse` can't read, so a raw read would export
// an empty map and silently lose every URL.
export function buildTriageExportPayload() {
  const entries = buildPersistedTriageEntries()

  const repoUrls = readRepoUrlMap()

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

// Apply an imported payload to the in-memory state + persisted
// stores (triage via `saveTriage`, repo URLs via secure-storage).
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
  const map = state.triage

  if (mode === 'replace') {
    for (const id of [...map.keys()]) {
      if (!SESSION_ID_RE.test(id)) map.delete(id)
    }
  }

  const keepCurrent = mode === 'prefer-current'

  for (const [id, v] of Object.entries(imported)) {
    if (SESSION_ID_RE.test(id)) continue
    if (!v || typeof v !== 'object') continue

    if (typeof v.color === 'string' && v.color && (!keepCurrent || !map.get(id)?.color)) {
      patchEntry(map, id, { color: v.color })
    }
    // Triage bucket — preferred form is `triage:`; legacy `deleted: true`
    // entries map to 'deleted', matching the load path in triage.js.
    const triageVal = bucketOf(v)
    if (triageVal && (!keepCurrent || !bucketOf(map.get(id)))) {
      patchEntry(map, id, { triage: triageVal })
    }
    if (typeof v.comment === 'string' && v.comment && (!keepCurrent || !map.get(id)?.comment)) {
      patchEntry(map, id, { comment: v.comment })
    }
    if (typeof v.fix === 'string' && v.fix && (!keepCurrent || !map.get(id)?.fix)) {
      patchEntry(map, id, { fix: v.fix })
    }
    // Tri-state attention flag — adopt both `true` and the explicit
    // `false` tombstone. prefer-current fills only when local has NO flag
    // at all (undefined), not merely when it's `false`.
    if (typeof v.flagged === 'boolean' && (!keepCurrent || map.get(id)?.flagged === undefined)) {
      patchEntry(map, id, { flagged: v.flagged })
    }
    // Per-report ignore: mutex with triage state. Skip the
    // ignoredReports merge when this id ended up with a triage
    // state (same rule the cross-tab apply path enforces).
    if (Array.isArray(v.ignoredReports) && !bucketOf(map.get(id))) {
      for (const r of v.ignoredReports) {
        if (typeof r !== 'string') continue
        if (keepCurrent && isReportIgnored(map, id, r)) continue
        setReportIgnored(map, id, r, true)
      }
    }
  }

  await saveTriage()

  // Repo URLs — merge per mode through secure-storage's per-key Web
  // Lock (keys are OPFS report names, values URLs). The whole RMW
  // runs inside the lock with a fresh in-lock hydrate of the
  // decrypted disk view, so it can't clobber a concurrent cross-tab
  // `saveRepoUrlFor` and never writes plaintext over an encrypted
  // slot. A raw localStorage RMW would also fail to decrypt under an
  // enabled vault (current parses to `{}`, collapsing every mode into
  // an overwrite).
  //
  // Best-effort: the triage entries are already merged and persisted
  // by now, so a SECONDARY repo-URL write failure (e.g. a sibling tab
  // locking the vault mid-import, making secure-storage refuse the
  // plaintext write) must not surface as a blanket "Import failed"
  // that contradicts the triage import that actually landed. Report
  // it in the result instead of throwing.
  let repoUrlsApplied = 0
  let repoUrlError = null
  try {
    await importRepoUrls(payload.repoUrls, mode)
    repoUrlsApplied = Object.keys(payload.repoUrls).length
  } catch (err) {
    console.warn('applyTriageImport: repo-URL import failed:', err)
    repoUrlError = err
  }

  return {
    triageEntries: Object.keys(imported).length,
    repoUrls: repoUrlsApplied,
    repoUrlError,
  }
}
