import { loadRepoUrlFor, saveRepoUrlFor, state } from './state.ts'
import { saveBundle, saveFile } from './storage.js'
import { upsertWorkspace } from './workspaces.js'
import { saveTriage } from './triage.js'
import { analyzeContent, getKind, setCount } from './counts.js'
import { firstDescriptionLine } from './finding-lookup.js'
import { backfillFindingIds, flattenFindings, parseReport } from '../common/report-findings.js'
import { gunzipToText } from '../common/gzip.js'
import { bucketOf, patchEntry, setReportIgnored } from './triage-entry.ts'
import { decryptBundle, isEncryptedBundle } from './workspace-bundle-crypto.js'

// Pure-logic side of workspace import. The DOM-touching layer (unlock
// dialog, conflict-resolution dialog, post-import re-render) lives in
// `ui/view/workspace-import.js` and calls into here. Split so the
// parse / merge / migration logic can be exercised from
// `tests/workspace-roundtrip.test.js` without pulling in lit / DOM.
//
// `parseWorkspaceJson` validates the export shape (version 1) and
// throws on a non-export blob; `applyWorkspaceImport` does the heavy
// lifting: writes each report to OPFS, upserts the workspace, merges
// triage into `state.triage` (deferring to a caller-supplied
// `conflictResolver` when local + imported values disagree), and
// adopts per-report repo URLs without a local entry.
//
// Triage merge rules:
//   - new colors / comments / fixes adopt the imported value;
//   - identical values are no-ops;
//   - imported `triage: 'inprogress'|'fixed'|'invalid'|'deleted'` adopts when the
//     local side has nothing — disagreements queue a conflict;
//   - LEGACY: an export carrying only `deleted: true` (pre-bucket
//     format) migrates to `triage: 'deleted'` on read, so old bundles
//     round-trip into the new triage-state Map without a separate
//     migration pass.

const EXPORT_VERSION = 1

// Caps on the membership arrays. The import runs a serial detach pass
// per identifier (each takes the Web Lock + a writeRaw) — without a
// cap, a crafted export with 50k `bundles` (or 50k empty `reports`)
// would freeze the tab and strip legitimate memberships from victim
// workspaces BEFORE the final upsert hits QuotaExceededError (audit
// S-Import-1). 1024 is well above any plausible legit workspace (the
// user would drag 1024 items by hand) yet keeps the K × lock-RMW pass
// interactive. Reports DO carry content (gzipped), but K empty
// `{findings:[]}` objects gzip small while still triggering K detach
// calls — so the cap applies symmetrically. Bundle per-entry length
// is gated separately so a single 100MB integrity string can't
// smuggle in under the count cap.
const MAX_BUNDLES_PER_EXPORT = 1024
const MAX_REPORTS_PER_EXPORT = 1024
const MAX_BUNDLE_INTEGRITY_LEN = 200
// Per-blob raw-byte ceiling for `bundleBlobs.data`. Bytes are base64
// on the wire (~4/3 expansion), so the encoded cap sits a bit above
// the raw target. 100 MiB raw covers every plausible .map /
// .stasis.code.br from the analyzer and bounds the import's memory —
// a crafted 4 GB blob would otherwise allocate its decoded buffer at
// decode time.
const MAX_BUNDLE_BLOB_BYTES = 100 * 1024 * 1024
const MAX_BUNDLE_BLOB_DATA_LEN = Math.ceil(MAX_BUNDLE_BLOB_BYTES * 4 / 3) + 16
// Display-name cap on `bundleBlobs.name`. Far longer than any
// realistic .map / .stasis filename, shorter than the workspace-name
// cap, so a crafted export can't bloat OPFS bundle metadata.
const MAX_BUNDLE_BLOB_NAME_LEN = 512
// Distinct (tighter) count cap for `bundleBlobs` — bytes-heavy, so
// the 1024-pointer `bundles` cap would otherwise let a payload sit at
// ~136 GiB of gunzipped JSON in memory before validation runs. 64
// covers any realistic workspace (the integrity-pointer side keeps
// the 1024 ceiling for the orphan-pointer carrier shape) while
// bounding worst-case decode-time memory at ~6.4 GiB raw.
const MAX_BUNDLE_BLOBS_PER_EXPORT = 64

// Single source of truth for export-shape validation. Returns `null`
// when acceptable, else a specific error string. `isWorkspaceExport`
// wraps it for a boolean; `parseWorkspaceJson` surfaces the reason so
// a cap violation doesn't read as a generic "not a deepview workspace
// export" format error on a file that IS valid, just oversized.
function validateExportShape(data) {
  if (!data || typeof data !== 'object') return 'payload is not an object'
  if (data.version !== EXPORT_VERSION) return `unsupported export version: ${data.version}`
  if (!data.workspace || typeof data.workspace !== 'object') return 'workspace metadata missing'
  if (typeof data.workspace.id !== 'string') return 'workspace.id must be a string'
  if (typeof data.workspace.name !== 'string') return 'workspace.name must be a string'
  if (typeof data.workspace.privateKey !== 'string') return 'workspace.privateKey must be a string'
  // `createdAt` rides through `applyWorkspaceImport` into
  // `upsertWorkspace` and the persisted blob. A crafted bundle could
  // otherwise embed any value (function-shape string, nested object,
  // NaN, Infinity, null); `Number.isFinite` rejects all of those.
  // `undefined` stays accepted — `upsertWorkspace` falls back to
  // `Date.now()` for missing fields. Audit round-14 WI-2.
  if (data.workspace.createdAt !== undefined && !Number.isFinite(data.workspace.createdAt)) {
    return 'workspace.createdAt must be a finite number or omitted'
  }
  if (!Array.isArray(data.reports)) return 'reports field must be an array'
  if (data.reports.length > MAX_REPORTS_PER_EXPORT) {
    return `reports count (${data.reports.length}) exceeds cap (${MAX_REPORTS_PER_EXPORT})`
  }
  if (data.bundles !== undefined) {
    if (!Array.isArray(data.bundles)) return 'bundles field must be an array when present'
    if (data.bundles.length > MAX_BUNDLES_PER_EXPORT) {
      return `bundles count (${data.bundles.length}) exceeds cap (${MAX_BUNDLES_PER_EXPORT})`
    }
    // Require `typeof === 'string'` AND length cap — a non-string
    // entry under the count cap would otherwise pass here and be
    // silently filtered by applyWorkspaceImport later, leaving the
    // validator more permissive than its contract (audit S-Import-3).
    for (const b of data.bundles) {
      if (typeof b !== 'string') return 'bundles entries must be strings'
      if (b.length > MAX_BUNDLE_INTEGRITY_LEN) {
        return `bundle integrity exceeds per-entry length cap (${MAX_BUNDLE_INTEGRITY_LEN})`
      }
    }
  }
  // `bundleBlobs` carries the bundle bytes (base64) when the sender
  // opts in. Validated symmetrically with `bundles` but with a
  // tighter count cap (bytes are heavy — see
  // MAX_BUNDLE_BLOBS_PER_EXPORT), plus per-entry shape and per-blob
  // size limits so a 4 GB blob can't blow up the import before decode.
  if (data.bundleBlobs !== undefined) {
    if (!Array.isArray(data.bundleBlobs)) return 'bundleBlobs field must be an array when present'
    if (data.bundleBlobs.length > MAX_BUNDLE_BLOBS_PER_EXPORT) {
      return `bundleBlobs count (${data.bundleBlobs.length}) exceeds cap (${MAX_BUNDLE_BLOBS_PER_EXPORT})`
    }
    for (const b of data.bundleBlobs) {
      if (!b || typeof b !== 'object' || Array.isArray(b)) return 'bundleBlobs entries must be objects'
      if (typeof b.integrity !== 'string' || b.integrity.length === 0) {
        return 'bundleBlobs.integrity must be a non-empty string'
      }
      if (b.integrity.length > MAX_BUNDLE_INTEGRITY_LEN) {
        return `bundleBlobs.integrity exceeds per-entry length cap (${MAX_BUNDLE_INTEGRITY_LEN})`
      }
      if (typeof b.name !== 'string' || b.name.length === 0) {
        return 'bundleBlobs.name must be a non-empty string'
      }
      if (b.name.length > MAX_BUNDLE_BLOB_NAME_LEN) {
        return `bundleBlobs.name exceeds per-entry length cap (${MAX_BUNDLE_BLOB_NAME_LEN})`
      }
      // Defence-in-depth: NULs in display names break sidebar lookups
      // and audit-log scraping, and `_meta.json` embeds the name
      // verbatim. The integrity (NOT the name) is the OPFS storage key
      // in saveBundle, so this is downstream-display hygiene, not a
      // storage-boundary check.
      if (b.name.includes('\0')) return 'bundleBlobs.name cannot contain NUL'
      if (typeof b.data !== 'string') return 'bundleBlobs.data must be a base64 string'
      if (b.data.length > MAX_BUNDLE_BLOB_DATA_LEN) {
        return `bundleBlobs.data exceeds per-blob size cap (${MAX_BUNDLE_BLOB_BYTES} bytes raw)`
      }
    }
  }
  return null
}

export function isWorkspaceExport(data) {
  return validateExportShape(data) === null
}

// UI import reads once up front so the magic-byte sniff and the parse
// share one buffer (re-reading would re-stream disk on every unlock-
// dialog retry).
export async function readBundleBytes(file) {
  return new Uint8Array(await file.arrayBuffer())
}

// Dispatches encrypted vs plaintext-gzip by magic byte. Encrypted
// bundles require a non-empty `password`; the unlock dialog owns the
// wrong-password retry loop. Post-decrypt failures (gunzip, JSON
// shape) collapse into the same `wrong password or corrupt bundle`
// error as a genuine auth failure — distinct texts would form an
// oracle confirming "password decrypted successfully" to an attacker
// probing crafted ciphertexts.
export async function parseWorkspaceBundleBytes(bytes, password) {
  if (isEncryptedBundle(bytes)) {
    if (typeof password !== 'string' || !password) {
      throw new TypeError('parseWorkspaceBundleBytes: password required for encrypted bundle')
    }
    const plaintext = await decryptBundle(bytes, password)
    try {
      return parseWorkspaceJson(await gunzipToText(plaintext))
    } catch (err) {
      // Keep `cause` for debugging while the surfaced message stays
      // generic — the oracle defense is at the message layer, not the
      // cause chain.
      throw new Error('wrong password or corrupt bundle', { cause: err })
    }
  }
  let text
  try {
    text = await gunzipToText(bytes)
  } catch (err) {
    throw new Error(`gzip decompression failed: ${err.message}`, { cause: err })
  }
  return parseWorkspaceJson(text)
}

export function parseWorkspaceJson(text) {
  let data
  try {
    data = JSON.parse(text)
  } catch (err) {
    throw new Error(`payload is not JSON: ${err.message}`, { cause: err })
  }
  const reason = validateExportShape(data)
  if (reason === null) return data
  // A cap-violation reason ("bundles count exceeds cap (1025)") is
  // more useful than a generic "not a deepview workspace export" — the
  // file IS valid, just oversized. Wrap with the legacy prefix only
  // for structural failures so existing callers' error-message
  // expectations keep working for the shape-error case.
  const isCapFailure = reason.includes('exceeds cap')
  throw new Error(isCapFailure ? reason : `not a deepview workspace export: ${reason}`)
}

// Read an imported triage entry's bucket. Preferred form is the new
// `triage: 'inprogress'|'fixed'|'invalid'|'deleted'` field; legacy bundles carry
// only `deleted: true`, treated as 'deleted'. Null when the entry has
// no bucket annotation.
export function readImportedTriageBucket(entry) {
  return bucketOf(entry) ?? null
}

// Build an `id → { severity, file, line, description }` map by re-
// parsing the imported reports — same id derivation as ingest.js /
// workspace-export.js so MD-imported findings line up with the
// persisted triage keys. Only drives the conflict dialog UI, so
// callers may skip it when no conflicts are possible.
export async function buildImportedFindingLookup(reportEntries) {
  const lookup = new Map()
  for (const r of reportEntries ?? []) {
    if (typeof r?.content !== 'string') continue
    const data = parseReport(r.content)
    if (!data?.findings) continue
    const all = flattenFindings(data.findings)
    await backfillFindingIds(all)
    for (const f of all) {
      if (!f.id || lookup.has(f.id)) continue
      lookup.set(f.id, {
        severity: f.severity,
        file: f.file,
        line: f.line,
        description: firstDescriptionLine(f.description),
      })
    }
  }
  return lookup
}

// Merge the imported triage into `state.triage`. Non-conflicting
// changes apply immediately. A property-scoped conflict (id+property
// where both sides have a value and they differ) is queued and handed
// to `conflictResolver` — when omitted (or it returns null), local
// wins on every conflict.
async function mergeTriage(triage, conflictResolver, findingLookup) {
  // Reject arrays: `typeof [] === 'object'` passes the lone-typeof
  // guard, and `Object.entries([])` then yields stringified indices
  // persisted as bogus finding ids in `state.triage`. Audit round-14
  // WI-1.
  if (!triage || typeof triage !== 'object' || Array.isArray(triage)) return
  const map = state.triage
  const conflicts = []
  for (const [id, entry] of Object.entries(triage)) {
    if (!entry || typeof entry !== 'object') continue

    // Skip writes when imported equals local — the reactive observers
    // (sidebar / table re-render, M-2 hydration listeners, triage-
    // sync.js subscribers) all fire on every entry mutation, so a
    // bundle re-importing the user's own state would spam them all.
    // `patchEntry` also no-ops unchanged values, but the explicit
    // guards here are needed for conflict detection anyway. Audit
    // round-14 WI-3.
    const localColor = map.get(id)?.color
    const importedColor = typeof entry.color === 'string' ? entry.color : undefined
    if (importedColor && localColor && localColor !== importedColor) {
      conflicts.push({ id, property: 'color', local: localColor, imported: importedColor })
    } else if (importedColor && importedColor !== localColor) {
      patchEntry(map, id, { color: importedColor })
    }

    const localComment = map.get(id)?.comment ?? ''
    const importedComment = typeof entry.comment === 'string' ? entry.comment : ''
    if (importedComment && localComment && localComment !== importedComment) {
      conflicts.push({ id, property: 'comment', local: localComment, imported: importedComment })
    } else if (importedComment && importedComment !== localComment) {
      patchEntry(map, id, { comment: importedComment })
    }

    const localFix = map.get(id)?.fix ?? ''
    const importedFix = typeof entry.fix === 'string' ? entry.fix : ''
    if (importedFix && localFix && localFix !== importedFix) {
      conflicts.push({ id, property: 'fix', local: localFix, imported: importedFix })
    } else if (importedFix && importedFix !== localFix) {
      patchEntry(map, id, { fix: importedFix })
    }

    const importedTriage = readImportedTriageBucket(entry)
    const localTriage = bucketOf(map.get(id)) ?? null
    if (importedTriage && localTriage && localTriage !== importedTriage) {
      conflicts.push({ id, property: 'triage', local: localTriage, imported: importedTriage })
    } else if (importedTriage && !localTriage) {
      // Clear any pre-existing local per-report ignore on this id —
      // triage and ignoredReports are mutually exclusive (same mutex
      // applyConflictDecisions enforces via `ignoredReports:
      // undefined`). Without it, patchEntry's {...cur, ...patch} merge
      // leaves an entry carrying BOTH a triage bucket and a stale
      // ignoredReports set.
      patchEntry(map, id, { triage: importedTriage, ignoredReports: undefined })
    }
    // Per-report ignore — additive merge. Each (reportName, id) is an
    // independent slot; union the imported list into local. No
    // conflict path since keys don't collide between sides (both
    // setting "ignored in this report" is identical). Mutual-exclusion
    // guard: if the id has a triage state locally now (pre-existing or
    // just-imported above), skip the ignored merge to honor the per-
    // tab invariant.
    const ignoredReports = Array.isArray(entry.ignoredReports) ? entry.ignoredReports : []
    if (!bucketOf(map.get(id))) {
      for (const r of ignoredReports) {
        if (typeof r === 'string') setReportIgnored(map, id, r, true)
      }
    }
  }
  if (conflicts.length > 0 && conflictResolver) {
    const decisions = await conflictResolver(conflicts, findingLookup ?? new Map())
    if (decisions) applyConflictDecisions(conflicts, decisions)
  }
  await saveTriage()
}

// Apply per-conflict decisions from `conflictResolver`. The 'triage'
// branch also drops any local `ignoredIds` for the same id — mutex
// with triage that triage-sync.js / triage.js already enforce. Audit
// M8.
//
// The dialog is async (user time), so state.* may have changed while
// it was open (a chain via `applyToReactiveState`, or a saveTriage
// from an action handler). Re-read each property's current local
// value at apply-time and SKIP any 'imported' decision whose `local`
// no longer matches — the user (or another peer's chain) effectively
// re-voted "local". Mirrors the hydration dialog's M-2 round-4 guard.
// Audit H1 round-5.
function applyConflictDecisions(conflicts, decisions) {
  for (const c of conflicts) {
    const key = `${c.id}:${c.property}`
    if (decisions[key] !== 'imported') continue
    if (currentLocalValue(c.id, c.property) !== c.local) continue
    if (c.property === 'color') patchEntry(state.triage, c.id, { color: c.imported })
    else if (c.property === 'comment') patchEntry(state.triage, c.id, { comment: c.imported })
    else if (c.property === 'fix') patchEntry(state.triage, c.id, { fix: c.imported })
    else if (c.property === 'triage') {
      // Clear the per-report ignore on the same id — mutex with triage.
      patchEntry(state.triage, c.id, { triage: c.imported, ignoredReports: undefined })
    }
  }
}

// Mirror the comparison shape `mergeTriage` used at conflict-
// collection time so the M-2 stale-check is meaningful: comment / fix
// normalised via `?? ''`, color / triage raw.
function currentLocalValue(id, property) {
  if (property === 'color') return state.triage.get(id)?.color
  if (property === 'triage') return bucketOf(state.triage.get(id)) ?? null
  if (property === 'comment') return state.triage.get(id)?.comment ?? ''
  if (property === 'fix') return state.triage.get(id)?.fix ?? ''
  return undefined
}

// Persist any base64 bundle bytes riding alongside the integrity
// pointers. The bytes are content-addressed (saveBundle recomputes
// the SHA-512 from the decoded buffer), so a tampered payload lands
// under its TRUE integrity, never an attacker-chosen one. Best-
// effort: a per-blob failure is logged and the import continues,
// mirroring the reports-save loop above.
//
// CRITICAL: bundleBlobs are CONSUMED here and intentionally NOT
// propagated into `upsertWorkspace`'s payload — bundle bytes live in
// OPFS, only integrities ride in the persisted blob. Any future
// caller must keep that invariant or risk inflating the localStorage
// workspaces row by megabytes.
async function persistImportedBundleBlobs(blobs) {
  if (!Array.isArray(blobs)) return
  for (const blob of blobs) {
    let bytes
    try {
      bytes = Uint8Array.fromBase64(blob.data)
    } catch (err) {
      console.warn(`Workspace import: failed to decode bundle ${blob.integrity}: ${err?.message ?? err}`)
      continue
    }
    try {
      const result = await saveBundle(blob.name, bytes)
      // Tamper-resistance invariant: saveBundle ALWAYS keys the OPFS
      // write by the SHA-512 it computes from `bytes`, NEVER by
      // `blob.integrity`. A future refactor MUST preserve this — if a
      // caller trusts the claimed integrity instead of the computed
      // one, a malicious export could plant bytes under a legitimate-
      // looking integrity. The mismatch warn below is an operator-
      // visible breadcrumb (the claimed hash's `bundles` pointer is an
      // orphan after a tamper), not a defence in itself.
      if (result?.integrity !== blob.integrity) {
        console.warn(`Workspace import: bundle ${blob.name} integrity mismatch (claimed ${blob.integrity}, computed ${result?.integrity})`)
      }
    } catch (err) {
      console.warn(`Workspace import: failed to save bundle ${blob.name}: ${err?.message ?? err}`)
    }
  }
}

// Apply a parsed workspace export to the active client state. Returns
// the upserted workspace object so callers can refresh per-workspace
// UI affordances.
export async function applyWorkspaceImport(data, { conflictResolver } = {}) {
  // Save reports first so the workspace's reports[] only references
  // names that landed successfully.
  const savedNames = []
  for (const r of data.reports) {
    if (typeof r?.name !== 'string' || typeof r?.content !== 'string') continue
    try {
      await saveFile(r.name, r.content)
      const { count, source } = analyzeContent(r.content)
      // Preserve the cached source when `analyzeContent` can't detect
      // one — the bundle's `r.content` may be JSON-formatted findings
      // without a `source` field, but our local cache already knows
      // the report kind for this name. Without the fallback,
      // `setCount(name, n, undefined)` overwrites `{count, source}`
      // with `{count}` only, breaking sidebar bucketing for that file.
      // Audit round-14 WI-4.
      setCount(r.name, count, source ?? getKind(r.name))
      savedNames.push(r.name)
    } catch (err) {
      console.warn(`Workspace import: failed to save ${r.name}: ${err.message}`)
    }
  }

  // Persist any inline bundle bytes BEFORE upsertWorkspace so a later
  // sidebar render sees the bytes-on-disk match for the integrity
  // pointers we're about to pin. `data.bundleBlobs` is the ONLY path
  // feeding bundle bytes into local OPFS through import; the
  // `upsertWorkspace` below sees only integrity strings (via
  // `data.bundles`), keeping the workspaces row bytes-free.
  if (Array.isArray(data.bundleBlobs) && data.bundleBlobs.length > 0) {
    await persistImportedBundleBlobs(data.bundleBlobs)
  }

  // Round-9 M1: merge the bundle's triage BEFORE upsertWorkspace.
  // The reverse order fires `onReportMembershipChanged` from
  // upsertWorkspace, whose triage-sync.js listener calls
  // `hydrateStateFromBaseState` (gap-fills state.* from the chain's
  // baseState). mergeTriage running after that would surface every
  // bundle entry disagreeing with the chain as a "local vs imported"
  // conflict — but "local" was really chain values the listener gap-
  // filled ms earlier, so the user got conflict dialogs for
  // disagreements they never made. Merging first writes the bundle's
  // triage into state.*, so the subsequent upsert + hydration (gap-
  // only / local-wins) leaves those values alone. Genuine local-vs-
  // bundle conflicts (real local triage on the same id BEFORE import)
  // still surface via mergeTriage's resolver path.

  // Build the metadata lookup once up front when there's incoming
  // triage — the dialog (if it surfaces) needs severity / file:line /
  // description per conflicting finding. Skipped when there's nothing
  // to merge: no conflicts possible.
  const hasIncomingTriage = data.triage && Object.keys(data.triage).length > 0
  const lookup = hasIncomingTriage
    ? await buildImportedFindingLookup(data.reports)
    : new Map()
  await mergeTriage(data.triage, conflictResolver, lookup)

  // Bundle membership rides as pointers (sha512 integrities). Bytes,
  // when shipped, rode in `data.bundleBlobs` and were persisted to
  // OPFS above; only the integrity strings reach the workspace blob.
  // Filter to non-empty strings so a malformed payload can't seed
  // garbage. Integrities that don't resolve to a locally-stored bundle
  // stay in the `bundles` list — the sidebar render skips them, and a
  // future drop of the matching bytes auto-claims via
  // setBundleWorkspace (content-addressed, same hash = same bundle).
  //
  // `data.bundles` is OPTIONAL — older exports predate it. When
  // omitted, tell upsertWorkspace to PRESERVE the target's existing
  // bundles via `preserveBundles: true` — that flag reads the existing
  // list INSIDE upsertWorkspace's lock, so a sibling tab can't race a
  // detach between our read and write. (Reading outside the lock would
  // let a sibling-tab `setBundleWorkspace(X, null)` get resurrected by
  // our deferred upsert — audit C-Import-1.) Treating "absent" as
  // "empty" would silently detach every locally-attached bundle.
  const bundlesProvided = Array.isArray(data.bundles)
  const importedBundles = bundlesProvided
    ? data.bundles.filter((b) => typeof b === 'string' && b.length > 0)
    : []

  // Membership is additive: a report or bundle can belong to multiple
  // workspaces at once. `upsertWorkspace` touches only the target's
  // `reports` / `bundles`, leaving other workspaces' claims on the
  // same identifier alone — the import grows the target's row without
  // stealing from any prior owner. A file is "detached" only when zero
  // workspaces list it. (No detach pre-pass: the runtime model allows
  // multi-owner membership, primarily exercised by the auto-attach
  // path in `client/sync/objstore-presence.js`.)
  const ws = await upsertWorkspace({
    id: data.workspace.id,
    name: data.workspace.name,
    privateKey: data.workspace.privateKey,
    reports: savedNames,
    bundles: bundlesProvided ? importedBundles : undefined,
    preserveBundles: !bundlesProvided,
    createdAt: data.workspace.createdAt,
  })

  // Per-report repo URLs round-trip in `data.repoUrls`. Only adopt
  // entries that map to reports we saved AND have no local URL —
  // overwriting the user's existing entry would be surprising. If the
  // adopted URL is for the currently-active report, sync
  // `state.repoUrl` so the header chip refreshes immediately.
  const savedSet = new Set(savedNames)
  if (data.repoUrls && typeof data.repoUrls === 'object') {
    for (const [name, url] of Object.entries(data.repoUrls)) {
      if (!savedSet.has(name) || typeof url !== 'string' || !url) continue
      if (loadRepoUrlFor(name)) continue
      saveRepoUrlFor(name, url)
      if (state.currentFile === name) state.repoUrl = url
    }
  }

  return ws
}
