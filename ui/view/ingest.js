import { state, loadRepoUrlFor, saveRepoUrlFor } from './state.js'
import { dropZone, report } from './dom.js'
import { saveFile, readFile, deleteFile } from './storage.js'
import { toGroup } from './group.js'
import { resetFilters } from './filters.js'
import { loadPromise } from './triage.js'
import { render } from './render.js'
import { renderSidebar } from './sidebar.js'
import { graph2, cleanupGraph2 } from './graph2/state.js'
import { parseMarkdownFindings } from '../../common/parse-md.js'
import { parseCodexCsvToScans } from '../../common/parse-codex.js'
import { parseDeepsecFindings } from '../../common/parse-deepsec.js'
import { deriveFindingId } from '../../common/finding-id.js'
import { setCount, removeCount, analyzeContent } from './counts.js'
import { importWorkspaceFromGzip } from './workspace-import.js'
import { listWorkspaces } from './workspaces.js'

// Run-level meta fields that the analyzer emits at the top of each report
// (and that the deduplicate command stamps on each finding individually).
// `ingestReport` lifts any of these from the report header onto each
// finding at ingest, so the renderer can show per-finding mode info
// uniformly without branching on whether the file came from a
// deduplicated dump.
const META_FIELDS = ['type', 'model', 'think', 'effort', 'exportsMode']
// localStorage key for the last-viewed file — restored on page load so
// the user picks back up where they left off.
export const LAST_FILE_KEY = 'deepview.lastFile'

// Drag/drop entry point. Each file is read, persisted to OPFS (replacing
// any existing entry of the same name), and the LAST one becomes the
// active view. Multiple drops at once still all save, but only the
// final one renders — merging across files is no longer a thing in the
// UI; the user switches via the sidebar.
// `.csv` drops are treated as Codex Security exports — the upstream
// merges several scans into one CSV and we split them at drop time so
// each scan ends up as its own sidebar entry. Slashes in repo names
// are sanitized to `__` because OPFS doesn't accept `/` in filenames;
// sidebar.js converts the substitution back for display. Each scan is
// stored as its derived JSON (the exact shape ingestReport expects),
// so loading later goes through the regular JSON.parse path.
export async function addFiles(files) {
  let last = null
  for (const file of files) {
    try {
      // .gz drops are routed to the workspace-import pipeline. Reading
      // the file as text first would mangle gzip bytes through
      // UTF-8 decoding, so this branch comes BEFORE the file.text()
      // read. importWorkspaceFromGzip throws if the payload doesn't
      // look like our export shape — surface that to the user.
      if (file.name.toLowerCase().endsWith('.gz')) {
        await importWorkspaceFromGzip(file)
        continue
      }
      const content = await file.text()
      if (file.name.toLowerCase().endsWith('.csv')) {
        const scans = parseCodexCsvToScans(content)
        for (const { displayName, data } of scans) {
          const codexName = displayName.replace(/\//gu, '__') + '.codex'
          const json = JSON.stringify(data)
          await saveFile(codexName, json)
          const { count, source } = analyzeContent(json)
          setCount(codexName, count, source)
          last = { name: codexName, content: json }
        }
      } else {
        // The original drop name (and its extension) is preserved.
        // Source detection — DeepSec vs Claude Security vs analyzer-
        // native JSON — is content-based via analyzeContent, and the
        // detected source is stamped into the counts cache so the
        // sidebar can bucket the file without re-parsing.
        await saveFile(file.name, content)
        const { count, source } = analyzeContent(content)
        setCount(file.name, count, source)
        last = { name: file.name, content }
      }
    } catch (err) {
      alert(`Failed to load ${file.name}: ${err.message}`)
    }
  }
  if (last) await switchToFile(last.name, last.content)
  await renderSidebar()
}

// Replace the active view with the named OPFS file. Pre-fetched
// `content` skips a redundant OPFS read (drop path passes it through).
export async function switchToFile(name, content) {
  state.reports = []
  state.currentFile = name
  state.currentWorkspace = null
  // Per-report repo URL (see state.js / saveRepoUrlFor). The user's
  // last-typed URL for THIS file lights up the header repo chip; an
  // unseen file starts empty. Reset before ingest so a stale URL
  // from the previous file doesn't briefly drive the header chip
  // until the new report's findings determine it isn't needed.
  state.repoUrl = loadRepoUrlFor(name)
  state.repoEditing = false
  // Reset graph v2 state so a new report doesn't open with stale
  // selection / hidden packages / a soloed pkg from the previous
  // file. The layout cache also invalidates (a new tree → re-layout).
  graph2.selected = null
  graph2.focusedPkg = null
  graph2.layoutCache = null
  graph2.solo = null
  graph2.hidden.clear()
  graph2.pathFilter = ''
  cleanupGraph2()
  try { localStorage.setItem(LAST_FILE_KEY, name) } catch {}
  if (content === undefined) {
    try {
      content = await readFile(name)
    } catch (err) {
      alert(`Failed to read ${name}: ${err.message}`)
      state.currentFile = null
      await renderSidebar()
      return
    }
  }
  await ingestReport(name, content)
  await renderSidebar()
}

// Replace the active view with the merged contents of an entire
// workspace — every report assigned to the workspace is loaded
// sequentially via `ingestReport`, accumulating in `state.reports`.
// `state.currentFile` is cleared (workspace mode is mutually
// exclusive with single-file mode); `state.currentWorkspace` carries
// the workspace id. Per-report repo URLs round-trip via the
// `_repoFallback` stamp on each finding (see ingestReport above), so
// the global `state.repoUrl` is empty in this mode and the editable
// header chip is omitted. Reports the workspace references but that
// no longer exist in OPFS are skipped silently — no need to disturb
// the rest of the load.
export async function switchToWorkspace(workspaceId) {
  const ws = listWorkspaces().find((w) => w.id === workspaceId)
  if (!ws) return
  state.reports = []
  state.currentFile = null
  state.currentWorkspace = workspaceId
  state.repoUrl = ''
  state.repoEditing = false
  graph2.selected = null
  graph2.focusedPkg = null
  graph2.layoutCache = null
  graph2.solo = null
  graph2.hidden.clear()
  graph2.pathFilter = ''
  cleanupGraph2()
  try { localStorage.setItem(LAST_FILE_KEY, `ws:${workspaceId}`) } catch {}
  for (const name of ws.reports) {
    let content
    try { content = await readFile(name) } catch { continue }
    await ingestReport(name, content)
  }
  await renderSidebar()
}

// Remove the current file from OPFS and close the view. Doesn't
// auto-switch to another — the user picks from the sidebar.
export async function deleteCurrent() {
  if (!state.currentFile) return
  const name = state.currentFile
  await deleteFile(name)
  removeCount(name)
  saveRepoUrlFor(name, '')
  state.currentFile = null
  state.reports = []
  state.repoUrl = ''
  graph2.selected = null
  graph2.focusedPkg = null
  graph2.layoutCache = null
  graph2.solo = null
  graph2.hidden.clear()
  graph2.pathFilter = ''
  cleanupGraph2()
  try { localStorage.removeItem(LAST_FILE_KEY) } catch {}
  report.classList.remove('active')
  report.innerHTML = ''
  dropZone.classList.remove('hidden')
  document.title = 'deepview results'
  document.body.classList.remove('show-print-btn')
  await renderSidebar()
}

// Pure parse + render path — no FileReader, no OPFS. Used both by
// switchToFile (after content is materialized) and by the headless
// print flow (`window.__loadFile`), so that flow can still merge
// multiple inputs by calling repeatedly.
export function ingestReport(name, content) {
  return new Promise((resolve) => {
  ;(async () => {
    try {
      // Persistent triage (markers/deletedIds keyed by uuid) is loaded
      // once at module init; await it before rendering so the first
      // drop already shows stored marks/deletions for matching findings.
      await loadPromise
      // Primary input is JSON (the analyzer's native dump format).
      // When that fails, walk the markdown parser chain: DeepSec
      // first (most specific format guard — `## SEVERITY (n)`), then
      // Claude Security (any `# Title` doc). Each parser returns the
      // standard { type, findings, … } shape, or null when the input
      // doesn't look like its format.
      let data
      try {
        data = JSON.parse(content)
      } catch (jsonErr) {
        data = parseDeepsecFindings(content)
          ?? parseMarkdownFindings(content)
        if (!data) throw new Error(`Not JSON, and not a recognized markdown format. (JSON error: ${jsonErr.message})`)
      }
      // Reset filters whenever this is the first report in the current
      // view (cleared on switchToFile / deleteCurrent, accumulating in
      // the headless print flow). The auto-tune that follows uses the
      // same gate.
      const isFirst = state.reports.length === 0
      // Dedup by exporter-provided uuid id across ALL loaded reports.
      // Input entries are either a single Finding or a Finding[] (a
      // dedup group from an upstream pass). A new group is dropped if
      // ANY of its members' ids match a previously-seen id — one
      // overlap is enough to conclude "already loaded" (groups don't
      // split / reshape across reloads). Findings without an id (legacy
      // JSON or pre-uuid exports) can't be deduped and always pass through.
      const seenIds = new Set()
      for (const r of state.reports) {
        for (const g of r.groups) {
          for (const f of g) if (f.id) seenIds.add(f.id)
        }
      }
      // Derive deterministic ids for any finding that doesn't already
      // carry one — must run BEFORE the dedup loop so MD-imported (and
      // id-less JSON) findings dedupe by content the same way exporter-
      // id'd findings do, and so triage (markers / deletions) persists
      // across reloads of the same source. Mutates the original finding
      // objects in place; `toGroup` returns them by reference, so the
      // ids are visible to the loop below. Batched via Promise.all
      // since crypto.subtle.digest is async — sequential awaits would
      // serialize hundreds of hashes for no reason.
      const rawEntries = data.findings || []
      const idLess = rawEntries.flatMap(toGroup).filter((f) => !f.id)
      if (idLess.length > 0) {
        const computed = await Promise.all(idLess.map(deriveFindingId))
        idLess.forEach((f, i) => { if (computed[i]) f.id = computed[i] })
      }
      // Per-report repo URL stamped on each finding so format.js's
      // fileUrl / lineLink can resolve the right fallback in workspace
      // mode (where state.repoUrl can't represent N reports' settings
      // at once). Empty string for headless / print-flow ingests where
      // the OPFS file isn't backing a saved URL.
      const repoFallback = loadRepoUrlFor(name)
      const groups = []
      let dupeCount = 0
      for (const entry of rawEntries) {
        const members = toGroup(entry)
        if (members.length === 0) continue
        const anyDupe = members.some((f) => f.id && seenIds.has(f.id))
        if (anyDupe) { dupeCount++; continue }
        // Stamp a session-local `_id` on each member as a fallback key
        // for findings that lack the exporter-provided uuid `id`.
        // `tabKey(f)` prefers `f.id` (persistent) and falls back to
        // `String(f._id)`. Register ids as we stamp so duplicate entries
        // WITHIN this drop are caught too. Also fill in run-level meta
        // (type / effort / exportsMode) from the report header — but
        // only when the finding has NO per-finding meta at all. A finding
        // that came out of the deduplicate command already has its own
        // per-source meta stamped (each source report's header projected
        // onto its findings); a missing field there means "that source
        // run didn't have it" and is intentional. Mixing in the dedup
        // dump's top-level meta would mask those gaps with the dedup
        // model's settings (e.g. printing effort=max on a finding whose
        // source run had no effort flag).
        const stamped = members.map((f) => {
          if (f.id) seenIds.add(f.id)
          const filled = { ...f, _id: state.nextFindingId++, _repoFallback: repoFallback, _reportName: name }
          // Inherit run-level meta from the report header onto
          // findings that don't carry their own — but ONLY for native
          // analyzer JSON dumps (no `data.source` marker). For
          // codex / claude-security imports, the report-level type
          // is a category label for the file as a whole, not a
          // per-finding analyzer descriptor; copying it onto each
          // finding produced misleading "security" run-meta rows on
          // codex CSVs where the upstream carries no such field.
          // Source-marked formats opt in to per-finding meta when
          // they want to (parse-md.js sets f.type from **Category:**
          // explicitly), and skip it otherwise.
          if (!data.source) {
            const hasOwnMeta = META_FIELDS.some((k) => filled[k] !== undefined)
            if (!hasOwnMeta) {
              for (const key of META_FIELDS) {
                if (data[key] !== undefined) filled[key] = data[key]
              }
            }
          }
          return filled
        })
        groups.push(stamped)
      }
      if (dupeCount > 0) console.log(`${name}: skipped ${dupeCount} duplicate finding${dupeCount === 1 ? '' : 's'}`)
      state.reports.push({
        type: data.type || 'analysis',
        // `source` is set by the markdown parser ('claude-security')
        // and absent on JSON dumps — render.js uses it to swap the
        // header title for an all-MD report.
        source: data.source ?? null,
        fileName: name,
        groups,
        // Per-file imports / exports / hashes from the analyzer dump
        // (stamped at JSON-export time). The renderer surfaces this as
        // a separate "Tree" tab when more than one file is present.
        tree: data.tree ?? null,
      })
      if (isFirst) {
        resetFilters()
        // Auto-tune the confidence floor so the initial view fits
        // roughly 25 groups. Step up from 6 → 7 → 8 until the visible
        // count is within budget; cap at 8 (the previous static
        // default). Skip the auto-tune entirely when no finding in
        // this report carries a confidence — without that guard,
        // countAtMin(6) returns 0 ≤ 25 and the floor lands at 6,
        // which then excludes every finding (since f.confidence is
        // undefined for all). Clear the floor instead so the filter
        // becomes a no-op; the toolbar hides the control too (see
        // toolbarHtml in render.js).
        //
        // After picking the base, walk DOWN while each lower step
        // would not surface any new groups — i.e. there's a "gap"
        // in the confidence distribution between the chosen floor
        // and the next observed bucket below it. Lowering the floor
        // for free puts the slider at the natural break in the
        // data: e.g. picked 8, no findings at 7 or 6 but some at
        // 5 → settle at 6 (the lowest step that doesn't reveal
        // anything new). Same idea applies down to 0 (= no floor).
        const hasAnyConfidence = groups.some((g) => g.some((f) => f.confidence !== undefined))
        if (hasAnyConfidence) {
          const countAtMin = (min) => groups.reduce((n, g) =>
            n + (g.some((f) => f.confidence !== undefined && f.confidence >= min) ? 1 : 0), 0)
          let base
          if (countAtMin(6) <= 25) base = 6
          else if (countAtMin(7) <= 25) base = 7
          else base = 8
          while (base > 0 && countAtMin(base - 1) === countAtMin(base)) base--
          state.filterConfMin = base
        } else {
          state.filterConfMin = 0
        }
      }
      render()
    } catch (err) {
      alert(`Failed to parse ${name}: ${err.message}`)
    }
    resolve()
  })()
  })
}

// Headless / automated entry point — parses + renders a JSON report
// in-process, no OPFS, no sidebar swap. Returned promise resolves when
// this file's render has run, so callers (the `print` command in
// src/print.js) can await loading of every input before triggering
// print. Repeated calls accumulate (the print pipeline still merges
// multiple inputs that way).
window.__loadFile = (name, content) => ingestReport(name, content)

// Headless filter override — used by the `print` command to apply
// CLI-supplied --severity / --confidence values AFTER all reports are
// loaded (the auto-tuned confidence floor from addReport's first-load
// heuristic gets overridden here when present). `severities` may be an
// array (or null/undefined to leave unchanged); empty array clears the
// filter so all severities show.
window.__setFilters = ({ severities, confMin } = {}) => {
  if (severities !== undefined && severities !== null) state.filterSeverities = new Set(severities)
  if (confMin !== undefined) state.filterConfMin = confMin
  render()
}

// Prevent default drag behavior everywhere. Drops anywhere on the page
// route through addFiles → OPFS save → switch view to the last dropped.
// The drop zone keeps its hover affordance for the empty-state case.
// Global Esc → exit fullscreen mode (mirrors what the toolbar's
// fullscreen-button toggle does, so the user has the canonical browser
// gesture for "give me my chrome back").
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.body.classList.contains('report-fullscreen')) {
    document.body.classList.remove('report-fullscreen')
  }
})

document.addEventListener('dragover', (e) => e.preventDefault())
document.addEventListener('drop', (e) => {
  e.preventDefault()
  if (e.target.closest('#drop-zone')) return // dropZone handler owns this
  addFiles(e.dataTransfer.files)
})

dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('hover') })
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('hover'))
dropZone.addEventListener('drop', (e) => {
  e.preventDefault()
  dropZone.classList.remove('hover')
  addFiles(e.dataTransfer.files)
})
