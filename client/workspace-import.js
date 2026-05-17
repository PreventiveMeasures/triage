import { loadRepoUrlFor, saveRepoUrlFor, state } from './state.ts'
import { saveFile } from './storage.js'
import { upsertWorkspace } from './workspaces.js'
import { saveTriage } from './triage.js'
import { analyzeContent, getKind, setCount } from './counts.js'
import { firstDescriptionLine } from './finding-lookup.js'
import { deriveFindingId } from '../common/finding-id.js'
import { parseMarkdownFindings } from '../common/parse-md.js'
import { parseDeepsecFindings } from '../common/parse-deepsec.js'
import { decryptBundle, isEncryptedBundle } from './workspace-bundle-crypto.js'

// Pure-logic side of workspace import. The DOM-touching layer (unlock
// dialog, conflict-resolution dialog, post-import re-render) lives in
// `ui/view/workspace-import.js` and calls into here. Split this way so
// the parse / merge / migration logic can be exercised from
// `tests/workspace-roundtrip.test.js` without pulling in lit / DOM.
//
// `parseWorkspaceJson` validates the export shape (version 1) and
// throws on a non-export blob; `applyWorkspaceImport` does the heavy
// lifting: it writes each report to OPFS, upserts the workspace,
// merges triage into `state.markers / triageState / comments / fixes`
// (deferring to a caller-supplied `conflictResolver` when local +
// imported values disagree), and adopts per-report repo URLs that
// don't already have a local entry.
//
// Triage merge rules:
//   - new colors / comments / fixes adopt the imported value;
//   - identical values are no-ops;
//   - imported `triage: 'fixed'|'invalid'|'deleted'` adopts when the
//     local side has nothing — disagreements queue a conflict;
//   - LEGACY: an export that only carries `deleted: true` (pre-bucket
//     format) migrates to `triage: 'deleted'` on read, so old
//     bundles round-trip into the new triage-state Map without
//     needing a separate migration pass.

const EXPORT_VERSION = 1

// Caps on the membership arrays. The import path runs a serial detach
// pass per identifier (each takes the Web Lock + a writeRaw) — without
// a cap, a crafted export with a 50k-entry `bundles` (or 50k empty
// `reports`) would freeze the tab and strip legitimate memberships
// from victim workspaces BEFORE the final upsert hits QuotaExceededError
// (audit S-Import-1). 1024 is comfortably above any plausible legit
// workspace (the user would have to drag 1024 items in by hand) and
// small enough that the K × lock-RMW import pass stays interactive.
// Reports DO carry content (gzipped), but a payload of K empty
// `{findings:[]}` objects gzips small while still triggering K detach
// calls — so the cap applies symmetrically to both fields.
// Per-entry length on bundles is gated separately so a single 100MB
// integrity string can't smuggle in under the count cap.
const MAX_BUNDLES_PER_EXPORT = 1024
const MAX_REPORTS_PER_EXPORT = 1024
const MAX_BUNDLE_INTEGRITY_LEN = 200

function toGroup(entry) { return Array.isArray(entry) ? entry : [entry] }

// Single source of truth for export-shape validation. Returns `null`
// when the payload is acceptable, or a specific error string when it
// isn't. `isWorkspaceExport` wraps this for a boolean contract;
// `parseWorkspaceJson` surfaces the specific reason so cap violations
// don't look like a generic "not a deepview workspace export" — that
// reads as a format error on a file that IS valid, just oversized.
function validateExportShape(data) {
  if (!data || typeof data !== 'object') return 'payload is not an object'
  if (data.version !== EXPORT_VERSION) return `unsupported export version: ${data.version}`
  if (!data.workspace || typeof data.workspace !== 'object') return 'workspace metadata missing'
  if (typeof data.workspace.id !== 'string') return 'workspace.id must be a string'
  if (typeof data.workspace.name !== 'string') return 'workspace.name must be a string'
  if (typeof data.workspace.privateKey !== 'string') return 'workspace.privateKey must be a string'
  // `createdAt` rides through `applyWorkspaceImport` straight to
  // `upsertWorkspace`, then into the persisted workspaces blob. A
  // crafted bundle could otherwise embed any value (function-shape
  // string, nested object, NaN, Infinity, null). `Number.isFinite`
  // rejects all of those (and accepts only finite numbers); `undefined`
  // stays accepted because `upsertWorkspace` falls back to `Date.now()`
  // for missing fields. Audit round-14 WI-2.
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
    // Per-entry check requires `typeof === 'string'` AND length cap —
    // a non-string entry under the count cap would otherwise pass
    // validation here and be silently filtered out by
    // applyWorkspaceImport later, leaving the validator more
    // permissive than its contract implies (audit S-Import-3).
    for (const b of data.bundles) {
      if (typeof b !== 'string') return 'bundles entries must be strings'
      if (b.length > MAX_BUNDLE_INTEGRITY_LEN) {
        return `bundle integrity exceeds per-entry length cap (${MAX_BUNDLE_INTEGRITY_LEN})`
      }
    }
  }
  return null
}

export function isWorkspaceExport(data) {
  return validateExportShape(data) === null
}

async function gunzipBytesToText(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))
  return await new Response(stream).text()
}

// UI import reads once up front so the magic-byte sniff and the
// eventual parse share one buffer (re-reading would re-stream the
// disk on every unlock-dialog retry).
export async function readBundleBytes(file) {
  return new Uint8Array(await file.arrayBuffer())
}

// Dispatches encrypted vs plaintext-gzip by magic byte. For encrypted
// bundles a non-empty `password` must be supplied; the unlock dialog
// owns the wrong-password retry loop. Post-decrypt failures (gunzip,
// JSON shape) collapse into the same `wrong password or corrupt bundle`
// error as a genuine auth failure — otherwise the distinct error texts
// would form an oracle confirming "password decrypted successfully" to
// an attacker probing crafted ciphertexts.
export async function parseWorkspaceBundleBytes(bytes, password) {
  if (isEncryptedBundle(bytes)) {
    if (typeof password !== 'string' || !password) {
      throw new TypeError('parseWorkspaceBundleBytes: password required for encrypted bundle')
    }
    const plaintext = await decryptBundle(bytes, password)
    try {
      return parseWorkspaceJson(await gunzipBytesToText(plaintext))
    } catch (err) {
      // Keep `cause` for debugging (DevTools / console) while the
      // surfaced message stays generic — the oracle defense is at
      // the message layer, not the cause chain.
      throw new Error('wrong password or corrupt bundle', { cause: err })
    }
  }
  let text
  try {
    text = await gunzipBytesToText(bytes)
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
  // A cap-violation reason ("bundles count exceeds cap (1025)") is more
  // useful to the user than a generic "not a deepview workspace export"
  // — the file IS a valid export, just over the size limit. Wrap with
  // the legacy prefix only for structural failures so existing callers'
  // error-message expectations keep working for the shape-error case.
  const isCapFailure = reason.includes('exceeds cap')
  throw new Error(isCapFailure ? reason : `not a deepview workspace export: ${reason}`)
}

// Read an imported triage entry's bucket. Preferred form is the
// new `triage: 'fixed'|'invalid'|'deleted'` field; legacy bundles
// only carry `deleted: true`, which we treat as 'deleted'. Returns
// null when the entry has no bucket annotation at all.
export function readImportedTriageBucket(entry) {
  if (entry?.triage === 'fixed' || entry?.triage === 'invalid' || entry?.triage === 'deleted') {
    return entry.triage
  }
  if (entry?.deleted) return 'deleted'
  return null
}

// Build an `id → { severity, file, line, description }` map by
// re-parsing the imported reports — same id derivation as
// ingest.js / workspace-export.js so MD-imported findings line up
// with the persisted triage keys. Only used to drive the conflict
// dialog UI, so callers may skip this when no conflicts are
// possible.
export async function buildImportedFindingLookup(reportEntries) {
  const lookup = new Map()
  for (const r of reportEntries ?? []) {
    if (typeof r?.content !== 'string') continue
    let data
    try {
      data = JSON.parse(r.content)
    } catch {
      data = parseDeepsecFindings(r.content) ?? parseMarkdownFindings(r.content)
    }
    if (!data?.findings) continue
    const all = data.findings.flatMap(toGroup)
    const idLess = all.filter((f) => !f.id)
    if (idLess.length > 0) {
      const computed = await Promise.all(idLess.map(deriveFindingId))
      idLess.forEach((f, i) => { if (computed[i]) f.id = computed[i] })
    }
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

// Merge the imported triage into state.markers / state.triageState /
// state.comments / state.fixes. Non-conflicting changes apply
// immediately. A property-scoped conflict (id+property where both
// sides have a value and they differ) is queued and handed to
// `conflictResolver` — when omitted (or when it returns null), the
// local side wins on every conflict.
async function mergeTriage(triage, conflictResolver, findingLookup) {
  // Reject arrays: `typeof [] === 'object'` so the lone-typeof guard
  // would let an array through, and `Object.entries([])` then yields
  // stringified indices that get persisted as bogus finding ids in
  // `state.markers` / `state.comments` / `state.fixes`. Audit round-14
  // WI-1.
  if (!triage || typeof triage !== 'object' || Array.isArray(triage)) return
  const conflicts = []
  for (const [id, entry] of Object.entries(triage)) {
    if (!entry || typeof entry !== 'object') continue

    // Skip the `.set` calls when the imported value equals the local
    // one — the reactive observers (sidebar / table re-render, M-2
    // hydration listeners, triage-sync.js subscribers) all fire on
    // every Map mutation regardless of whether the value actually
    // changed. A bundle that re-imports the user's own state would
    // otherwise spam every listener for every entry. Audit round-14
    // WI-3.
    const localColor = state.markers.get(id)
    const importedColor = typeof entry.color === 'string' ? entry.color : undefined
    if (importedColor && localColor && localColor !== importedColor) {
      conflicts.push({ id, property: 'color', local: localColor, imported: importedColor })
    } else if (importedColor && importedColor !== localColor) {
      state.markers.set(id, importedColor)
    }

    const localComment = state.comments.get(id) ?? ''
    const importedComment = typeof entry.comment === 'string' ? entry.comment : ''
    if (importedComment && localComment && localComment !== importedComment) {
      conflicts.push({ id, property: 'comment', local: localComment, imported: importedComment })
    } else if (importedComment && importedComment !== localComment) {
      state.comments.set(id, importedComment)
    }

    const localFix = state.fixes.get(id) ?? ''
    const importedFix = typeof entry.fix === 'string' ? entry.fix : ''
    if (importedFix && localFix && localFix !== importedFix) {
      conflicts.push({ id, property: 'fix', local: localFix, imported: importedFix })
    } else if (importedFix && importedFix !== localFix) {
      state.fixes.set(id, importedFix)
    }

    const importedTriage = readImportedTriageBucket(entry)
    const localTriage = state.triageState.get(id) ?? null
    if (importedTriage && localTriage && localTriage !== importedTriage) {
      conflicts.push({ id, property: 'triage', local: localTriage, imported: importedTriage })
    } else if (importedTriage && !localTriage) {
      state.triageState.set(id, importedTriage)
    }
    // Per-report ignore — additive merge. Each (reportName, id) is
    // an independent slot; we union the imported list into local.
    // No conflict path since the keys don't collide between sides
    // (a key represents "ignored in this report" — both sides
    // setting it is identical). Mutual-exclusion guard: if the
    // id has a triage state locally now (whether pre-existing or
    // just-imported above), skip the ignored merge so the local
    // state honors the per-tab invariant.
    const ignoredReports = Array.isArray(entry.ignoredReports) ? entry.ignoredReports : []
    if (!state.triageState.has(id)) {
      for (const r of ignoredReports) {
        if (typeof r === 'string') state.ignoredIds.add(`${r}\0${id}`)
      }
    }
  }
  if (conflicts.length > 0 && conflictResolver) {
    const decisions = await conflictResolver(conflicts, findingLookup ?? new Map())
    if (decisions) applyConflictDecisions(conflicts, decisions)
  }
  await saveTriage()
}

// Apply per-conflict decisions returned by `conflictResolver`. The
// 'triage' branch also drops any local `ignoredIds` for the same
// id — mutex with triage that the apply / load paths in
// triage-sync.js / triage.js already enforce. Audit M8.
//
// The dialog is async (user time), so state.* may have changed
// while it was open — a chain that landed via `applyToReactiveState`
// or a saveTriage from an action handler. Re-read each property's
// current local value at apply-time and SKIP any 'imported'
// decision whose `local` no longer matches: the user (or another
// peer's chain) has effectively voted "local" again. Mirrors the
// hydration dialog's M-2 round-4 guard. Audit H1 round-5.
function applyConflictDecisions(conflicts, decisions) {
  for (const c of conflicts) {
    const key = `${c.id}:${c.property}`
    if (decisions[key] !== 'imported') continue
    if (currentLocalValue(c.id, c.property) !== c.local) continue
    if (c.property === 'color') state.markers.set(c.id, c.imported)
    else if (c.property === 'comment') state.comments.set(c.id, c.imported)
    else if (c.property === 'fix') state.fixes.set(c.id, c.imported)
    else if (c.property === 'triage') {
      state.triageState.set(c.id, c.imported)
      dropIgnoredFor(c.id)
    }
  }
}

// Mirror the comparison shape `mergeTriage` used at conflict-
// collection time so the M-2 stale-check is meaningful: comment /
// fix were normalised via `?? ''`, color / triage came back raw.
function currentLocalValue(id, property) {
  if (property === 'color') return state.markers.get(id)
  if (property === 'triage') return state.triageState.get(id) ?? null
  if (property === 'comment') return state.comments.get(id) ?? ''
  if (property === 'fix') return state.fixes.get(id) ?? ''
  return undefined
}

function dropIgnoredFor(id) {
  for (const k of [...state.ignoredIds]) {
    const sep = k.indexOf('\0')
    if (sep >= 0 && k.slice(sep + 1) === id) state.ignoredIds.delete(k)
  }
}

// Apply a parsed workspace export to the active client state.
// Saves the bundled reports to OPFS, upserts the workspace, merges
// triage (deferring to `conflictResolver` on disagreement), and
// adopts per-report repo URLs that aren't already set locally.
// Returns the upserted workspace object so callers can refresh
// per-workspace UI affordances.
export async function applyWorkspaceImport(data, { conflictResolver } = {}) {
  // Save reports first so the workspace's reports[] only references
  // the names that landed successfully.
  const savedNames = []
  for (const r of data.reports) {
    if (typeof r?.name !== 'string' || typeof r?.content !== 'string') continue
    try {
      await saveFile(r.name, r.content)
      const { count, source } = analyzeContent(r.content)
      // Preserve the cached source when `analyzeContent` couldn't
      // detect one — the bundle's `r.content` may be JSON-formatted
      // findings without a `source` field, but our local cache
      // already knows what kind of report this name is. Without the
      // fallback, `setCount(name, n, undefined)` overwrites
      // `{count, source}` with `{count}` only, breaking the sidebar
      // bucketing for that file. Audit round-14 WI-4.
      setCount(r.name, count, source ?? getKind(r.name))
      savedNames.push(r.name)
    } catch (err) {
      console.warn(`Workspace import: failed to save ${r.name}: ${err.message}`)
    }
  }

  // Round-9 M1: merge the bundle's triage BEFORE upsertWorkspace.
  //
  // The reverse order would fire `onReportMembershipChanged` from
  // upsertWorkspace, whose triage-sync.js listener calls
  // `hydrateStateFromBaseState` (gap-fills state.* from the chain's
  // baseState). When `mergeTriage` then ran against state.*, every
  // bundle triage entry that disagreed with the chain would surface
  // as a "local vs imported" conflict — but the "local" side was
  // really just chain values the listener had silently gap-filled
  // ms earlier. The user got conflict dialogs for disagreements
  // they never made.
  //
  // Doing mergeTriage first writes the bundle's triage into state.*
  // so the subsequent upsertWorkspace + hydration sees state.* as
  // populated and (since hydration is gap-only / local-wins) leaves
  // those values alone. Genuine local-vs-bundle conflicts (the user
  // had real local triage on the same id BEFORE import) still
  // surface via mergeTriage's resolver path.

  // Build the metadata lookup once up front when there's any
  // incoming triage — the dialog (if it surfaces) needs severity /
  // file:line / description per conflicting finding. Skipped when
  // there's nothing to merge: no conflicts are possible.
  const hasIncomingTriage = data.triage && Object.keys(data.triage).length > 0
  const lookup = hasIncomingTriage
    ? await buildImportedFindingLookup(data.reports)
    : new Map()
  await mergeTriage(data.triage, conflictResolver, lookup)

  // Bundle membership rides through as pointers (sha512 integrities);
  // the bundle bytes themselves are NOT in the export. Filter to
  // non-empty strings so a malformed payload can't seed the workspace
  // blob with garbage. Integrities that don't resolve to a locally-
  // stored bundle stay in the workspace's `bundles` list — the sidebar
  // render skips them defensively, and a future drop of the matching
  // bytes auto-claims via setBundleWorkspace (content-addressed, same
  // hash = same bundle).
  //
  // `data.bundles` is OPTIONAL — older exports predate the field. When
  // it's omitted, we tell upsertWorkspace to PRESERVE the target's
  // existing bundles via `preserveBundles: true` — that flag reads the
  // existing list INSIDE upsertWorkspace's lock, so a sibling tab can't
  // race a detach between our read and our write. (Reading outside the
  // lock would let a sibling-tab `setBundleWorkspace(X, null)` get
  // resurrected by our deferred upsert — audit C-Import-1.) Unlike
  // reports, no bundle bytes ride the export, so treating "absent" as
  // "empty" would silently detach every locally-attached bundle.
  const bundlesProvided = Array.isArray(data.bundles)
  const importedBundles = bundlesProvided
    ? data.bundles.filter((b) => typeof b === 'string' && b.length > 0)
    : []

  // Membership is additive: a report or bundle can belong to multiple
  // workspaces at once. `upsertWorkspace` only touches the target
  // workspace's `reports` / `bundles` lists, leaving other workspaces'
  // claims on the same identifier alone — the import grows the target's
  // membership row without stealing from any prior owner. A file is
  // "detached" only when zero workspaces list it; an identifier that
  // also lives in another workspace is not surfaced as unattached.
  // (The previous detach pre-pass enforced an at-most-one-workspace
  // invariant; the runtime model now allows multi-owner membership and
  // the auto-attach path in `ui/view/objstore-presence.js` is the
  // primary writer that exercises it.)
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
  // entries that map to reports we actually saved AND that have no
  // URL set locally — overwriting the user's existing entry would
  // be surprising. If the imported workspace contains the
  // currently-active report and we adopted its URL, sync
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
