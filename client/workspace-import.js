import { loadRepoUrlFor, saveRepoUrlFor, state } from './state.js'
import { saveFile } from './storage.js'
import { upsertWorkspace } from './workspaces.js'
import { saveTriage } from './triage.js'
import { analyzeContent, setCount } from './counts.js'
import { deriveFindingId } from '../common/finding-id.js'
import { parseMarkdownFindings } from '../common/parse-md.js'
import { parseDeepsecFindings } from '../common/parse-deepsec.js'

// Pure-logic side of workspace import. The DOM-touching layer
// (gunzip read, conflict-resolution dialog, post-import re-render)
// lives in `ui/view/workspace-import.js` and calls into here. Split
// this way so the merge / migration logic can be exercised from
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

function toGroup(entry) { return Array.isArray(entry) ? entry : [entry] }

export function isWorkspaceExport(data) {
  return Boolean(
    data
    && typeof data === 'object'
    && data.version === EXPORT_VERSION
    && data.workspace
    && typeof data.workspace.id === 'string'
    && typeof data.workspace.name === 'string'
    && typeof data.workspace.privateKey === 'string'
    && Array.isArray(data.reports),
  )
}

async function gunzipText(file) {
  const buf = await file.arrayBuffer()
  const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))
  return await new Response(stream).text()
}

// Parse a workspace `.gz` (or any `Blob`/`File` with a `.arrayBuffer()`):
// gunzip → JSON.parse → shape-validate. Throws with a descriptive
// message at the first failing step so the caller can surface it to
// the user verbatim.
export async function parseWorkspaceGzip(file) {
  let text
  try {
    text = await gunzipText(file)
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
  if (!isWorkspaceExport(data)) {
    throw new Error('not a deepview workspace export')
  }
  return data
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

// First non-empty trimmed line of a description — used by the
// conflict dialog (UI side) to show a one-line preview per finding.
function firstDescriptionLine(text) {
  if (!text) return ''
  for (const line of text.split('\n')) {
    if (line.trim()) return line.trim()
  }
  return ''
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
  if (!triage || typeof triage !== 'object') return
  const conflicts = []
  for (const [id, entry] of Object.entries(triage)) {
    if (!entry || typeof entry !== 'object') continue

    const localColor = state.markers.get(id)
    const importedColor = typeof entry.color === 'string' ? entry.color : undefined
    if (importedColor && localColor && localColor !== importedColor) {
      conflicts.push({ id, property: 'color', local: localColor, imported: importedColor })
    } else if (importedColor) {
      state.markers.set(id, importedColor)
    }

    const localComment = state.comments.get(id) ?? ''
    const importedComment = typeof entry.comment === 'string' ? entry.comment : ''
    if (importedComment && localComment && localComment !== importedComment) {
      conflicts.push({ id, property: 'comment', local: localComment, imported: importedComment })
    } else if (importedComment) {
      state.comments.set(id, importedComment)
    }

    const localFix = state.fixes.get(id) ?? ''
    const importedFix = typeof entry.fix === 'string' ? entry.fix : ''
    if (importedFix && localFix && localFix !== importedFix) {
      conflicts.push({ id, property: 'fix', local: localFix, imported: importedFix })
    } else if (importedFix) {
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
    // No conflict path here since the keys don't collide between
    // local and imported (a key represents "ignored in this
    // report" — both sides setting it is identical).
    const ignoredReports = Array.isArray(entry.ignoredReports) ? entry.ignoredReports : []
    for (const r of ignoredReports) {
      if (typeof r === 'string') state.ignoredIds.add(`${r}\0${id}`)
    }
  }
  if (conflicts.length > 0 && conflictResolver) {
    const decisions = await conflictResolver(conflicts, findingLookup ?? new Map())
    if (decisions) {
      for (const c of conflicts) {
        const key = `${c.id}:${c.property}`
        if (decisions[key] !== 'imported') continue
        if (c.property === 'color') state.markers.set(c.id, c.imported)
        else if (c.property === 'comment') state.comments.set(c.id, c.imported)
        else if (c.property === 'fix') state.fixes.set(c.id, c.imported)
        else if (c.property === 'triage') state.triageState.set(c.id, c.imported)
      }
    }
  }
  await saveTriage()
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
      setCount(r.name, count, source)
      savedNames.push(r.name)
    } catch (err) {
      console.warn(`Workspace import: failed to save ${r.name}: ${err.message}`)
    }
  }

  const ws = upsertWorkspace({
    id: data.workspace.id,
    name: data.workspace.name,
    privateKey: data.workspace.privateKey,
    reports: savedNames,
    createdAt: data.workspace.createdAt,
  })

  // Build the metadata lookup once up front when there's any
  // incoming triage — the dialog (if it surfaces) needs severity /
  // file:line / description per conflicting finding. Skipped when
  // there's nothing to merge: no conflicts are possible.
  const hasIncomingTriage = data.triage && Object.keys(data.triage).length > 0
  const lookup = hasIncomingTriage
    ? await buildImportedFindingLookup(data.reports)
    : new Map()
  await mergeTriage(data.triage, conflictResolver, lookup)

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
