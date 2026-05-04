import { listFiles, saveFile, readFile, deleteFile } from './storage.js'
import {
  SEVERITY_ORDER,
  esc, isModule, stripPackagePrefix, stripExportMarker, findingText, prettyModel, commonPrefix,
  treeAnchor, computeFindingCountsByFile, computeTransitiveCounts,
} from './utils.js'
import {
  tree, cleanupGraphInteraction,
  renderTreeCanvas, renderTreeSidebarFull, attachTreeGraphInteraction, renderTreeView,
} from './graph.js'

// Run-level meta fields that the analyzer emits at the top of each report
// (and that the deduplicate command stamps on each finding individually).
// `ingestReport` lifts any of these from the report header onto each
// finding at ingest, so the renderer can show per-finding mode info
// uniformly without branching on whether the file came from a
// deduplicated dump.
const META_FIELDS = ['type', 'model', 'think', 'effort', 'exportsMode']
// localStorage key for the last-viewed file — restored on page load so
// the user picks back up where they left off.
const LAST_FILE_KEY = 'deepview.lastFile'
const dropZone = document.getElementById('drop-zone')
const report = document.getElementById('report')
const sidebar = document.getElementById('sidebar')
const fileList = document.getElementById('file-list')

// Exactly one OPFS-backed report is active at a time — the sidebar
// switches between them; merging is gone. Headless callers
// (`window.__loadFile` from src/print.js) bypass OPFS and may call
// `ingestReport` repeatedly, in which case `reports` does accumulate
// (the print pipeline still merges that way). The renderer is shape-
// agnostic.
let reports = []
// Currently-displayed OPFS basename, or null when nothing is loaded
// (drop zone visible). Tracked separately from `reports` so the
// sidebar can highlight the active file even before render finishes.
let currentFile = null
// Top-level tab — 'findings' (default), 'tree' (force-directed graph
// with file info sidebar), or 'files' (the per-file cards listing).
// Tree / files tabs are only visible when the loaded report carries
// a `tree` block with more than one file; switching files / loading
// a tree-less report auto-falls back to 'findings' inside render().
let currentView = 'findings'
// Severity + color filters are multi-select: empty Set = "no filter, show
// everything" (selecting every option individually is equivalent — the
// predicate passes when every finding's value is in the Set). UI-wise
// each .stat card toggles membership independently; no single "all"
// sentinel. `filterColors` stores mark colors (`red|blue|green|gray`)
// plus the literal `'none'` for unmarked findings.
let filterSeverities = new Set()
let filterColors = new Set()
let filterSource = 'all'
let filterConfMin = 8
let filterConfMax = ''
let filterInclude = ''
let filterExclude = ''
let repoUrl = ''
let sortBy = 'file'
// Display toggle — orthogonal to filters (doesn't affect which findings
// show), so it lives outside resetFilters so a filter reset or a new
// report drop doesn't wipe it. Default off for a denser view; flip on
// to inspect the source-hash provenance.
//   showMetadata: `file: <sha> | tree: <sha>` hashes block
// (Line numbers + run-meta used to be gated by an analogous showLines
// toggle, dropped — they're the minimum context needed to act on a
// finding, so always shown.)
let showMetadata = false
// `groupByFile` true (default) renders findings under per-file headers —
// the original behavior, kept by default. When false, every dedup group
// renders flat in sort order with its own location label above it (file
// path + line), so the reader can scan results across files in pure
// severity/confidence/file order without the file-header chrome.
let groupByFile = true
// Per-finding manual annotations. Keyed by `tabKey(f)` = `f.id ?? String(f._id)`:
// the export's derived uuid when available (persists across reloads via
// localStorage), else a session-local numeric id (session-only). See
// saveTriage / loadTriage below — uuid-shaped keys round-trip through a
// single `deepview.triage` localStorage entry; numeric-_id keys do not.
//   markers:     Map<key, 'red' | 'blue' | 'green' | 'gray'>
//   deletedIds:  Set<key> — soft-deleted findings. Hidden from the main
//                view; the Trash button toggles a view that shows only
//                these, with a Restore button to undo.
//   showDeleted: when true, render only findings in `deletedIds`.
// Both are PER-TAB (i.e. per individual finding even within a dedup
// group). Group-level rollup is computed on demand in groupState() —
// mismatched colors across a group's tabs highlight the whole entry;
// matching colors apply to the whole card; deletion of any one tab in
// a conflict-free group flags the whole group.
let markers = new Map()
let deletedIds = new Set()
let showDeleted = false
let nextFindingId = 0
// Ephemeral per-render state — which tab is active within each dedup
// group. Keyed by `groupKey(g)` (the first member's tabKey), value is a
// tabKey within the group. Falls back to the sorted-primary tab when
// absent or when the stored tab no longer exists. Session-only; NOT
// persisted (it's a pure UI focus state, not triage).
let activeTabByGroup = new Map()

// ID helpers. Internally every `reports[].groups[i]` is a Finding[]
// (single-finding entries are wrapped at ingest, so code downstream
// never branches on "is it a group?"). `tabKey` identifies an
// individual tab (= finding); `groupKey` identifies the group as a
// whole — uses the first member so it survives tab-sort reordering.
function tabKey(f) { return f.id ?? String(f._id) }
function groupKey(group) { return tabKey(group[0]) }
function toGroup(entry) { return Array.isArray(entry) ? entry : [entry] }

// Tab sort order within a group: colored tabs first (drawing attention
// to already-triaged cases), then higher severity, then higher
// confidence. The first tab after sort is the group's "primary" — used
// as the default active tab AND as the representative for group-level
// sorting (file/severity/confidence dropdowns).
function sortTabs(group) {
  return [...group].sort((a, b) => {
    const aColored = markers.has(tabKey(a)) ? 1 : 0
    const bColored = markers.has(tabKey(b)) ? 1 : 0
    if (aColored !== bColored) return bColored - aColored
    const aSev = SEVERITY_ORDER[a.severity] || 0
    const bSev = SEVERITY_ORDER[b.severity] || 0
    if (aSev !== bSev) return bSev - aSev
    const aConf = a.confidence ?? -1
    const bConf = b.confidence ?? -1
    return bConf - aConf
  })
}

function primaryTab(group) { return sortTabs(group)[0] }

function activeTabFor(group) {
  const stored = activeTabByGroup.get(groupKey(group))
  if (stored) {
    const match = group.find((f) => tabKey(f) === stored)
    if (match) return match
  }
  return primaryTab(group)
}

// Group-level triage rollup. User spec:
//   1. A tab is "annotated" if it has a color AND/OR is deleted.
//      Unannotated tabs are neutral — they don't contribute to the
//      rollup and can never cause a conflict on their own.
//   2. Among annotated tabs, a conflict exists iff they disagree on
//      color OR on deletion state. "Disagree on color" means two or
//      more distinct non-null colors are present (a tab annotated
//      only via deletion, with no color, never conflicts with a
//      colored tab purely on the basis of its missing color). "Disagree
//      on deletion" means some annotated tabs are deleted and others
//      are not. Conflict → dashed outline on the card; per-tab colors
//      still render on each tab button; the group is kept in the main
//      view (never in trash).
//   3. Otherwise (consistent annotated tabs), the card takes the
//      common color (if any annotated tab is colored); any annotated
//      tab being deleted puts the whole group in trash.
//   4. Click handlers enforce the inverse — see the click handler below.
// Examples (where A/B/C are tabs in one dedup group):
//   A(green, deleted), B(), C()            → no conflict, in trash, A is green
//   A(green, deleted), B(deleted), C()     → no conflict, in trash, A is green
//   A(green, deleted), B(red), C()         → conflict (colors disagree)
//   A(green), B(blue), C()                 → conflict (colors disagree)
//   A(green, deleted), B(green), C()       → conflict (deleted disagrees)
function groupState(group) {
  const annotated = group
    .map((f) => ({ color: markers.get(tabKey(f)), deleted: deletedIds.has(tabKey(f)) }))
    .filter((t) => t.color !== undefined || t.deleted)
  const colors = new Set(annotated.map((t) => t.color).filter((c) => c !== undefined))
  const deletedStates = new Set(annotated.map((t) => t.deleted))
  const hasConflict = colors.size > 1 || deletedStates.size > 1
  const commonColor = !hasConflict && colors.size === 1 ? [...colors][0] : null
  const anyDeleted = annotated.some((t) => t.deleted)
  const allDeleted = annotated.length > 0 && annotated.every((t) => t.deleted)
  return {
    hasConflict, commonColor, anyDeleted, allDeleted,
    // Conflict groups are NEVER counted as deleted (per spec — the
    // group stays in the main view until the user resolves the
    // disagreement per-tab). When non-conflicting, anyDeleted ==
    // allDeleted on annotated tabs, so either form is equivalent.
    isDeleted: !hasConflict && anyDeleted,
  }
}

function isGroupDeleted(group) { return groupState(group).isDeleted }

function findGroupById(gid) {
  for (const r of reports) {
    for (const g of r.groups) if (groupKey(g) === gid) return g
  }
  return null
}

// --- Triage persistence --------------------------------------------------
// Markers + deletions survive page reload via `localStorage['deepview.triage']`.
// Payload shape: `{ <uuid>: { color?, deleted? } }` — one entry per
// triaged finding, color/deleted both optional (omitted when absent so
// a clean finding leaves no trace). JSON-encoded, brotli-compressed,
// base64-encoded. Only keys matching UUID_RE are stored — session-only
// numeric keys are filtered out so a fresh drop of the same report
// re-applies triage under stable ids.
const TRIAGE_KEY = 'deepview.triage'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu

async function compressBrotli(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

async function decompressBrotli(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

async function saveTriage() {
  try {
    const entries = {}
    for (const [k, color] of markers) {
      if (!UUID_RE.test(k)) continue
      entries[k] = { ...(entries[k] || {}), color }
    }
    for (const k of deletedIds) {
      if (!UUID_RE.test(k)) continue
      entries[k] = { ...(entries[k] || {}), deleted: true }
    }
    if (Object.keys(entries).length === 0) {
      localStorage.removeItem(TRIAGE_KEY)
      return
    }
    const bytes = new TextEncoder().encode(JSON.stringify(entries))
    const compressed = await compressBrotli(bytes)
    localStorage.setItem(TRIAGE_KEY, compressed.toBase64())
  } catch (err) {
    console.warn('Failed to save triage:', err)
  }
}

async function loadTriage() {
  try {
    const raw = localStorage.getItem(TRIAGE_KEY)
    if (!raw) return
    const compressed = Uint8Array.fromBase64(raw)
    const decompressed = await decompressBrotli(compressed)
    const entries = JSON.parse(new TextDecoder().decode(decompressed))
    for (const [k, v] of Object.entries(entries)) {
      if (v && v.color) markers.set(k, v.color)
      if (v && v.deleted) deletedIds.add(k)
    }
  } catch (err) {
    console.warn('Failed to load triage:', err)
  }
}

let loadPromise = loadTriage()

// Render the OPFS file list into the sidebar. Highlights the active
// file. Disables Delete when nothing's open. Hides the whole sidebar
// when there are no files AND nothing's currently loaded — keeps the
// empty-state drop zone uncluttered. Called after every state
// transition that could change the file list or current selection.
async function renderSidebar() {
  const names = await listFiles()
  sidebar.classList.toggle('empty', names.length === 0 && !currentFile)
  fileList.innerHTML = names.map((n) =>
    `<li class="file-item${n === currentFile ? ' current' : ''}" data-file="${esc(n)}"><button type="button" class="file-name" title="${esc(n)}">${esc(n)}</button></li>`,
  ).join('')
  const deleteBtn = document.getElementById('delete-current')
  if (deleteBtn) deleteBtn.disabled = !currentFile
}

// Sidebar event delegation: file-list click switches; Delete removes
// the current file; toggle collapses / expands.
sidebar.addEventListener('click', (e) => {
  const fileEl = e.target.closest('.file-item[data-file]')
  if (fileEl) {
    const name = fileEl.dataset.file
    if (name && name !== currentFile) switchToFile(name)
    return
  }
  if (e.target.closest('#delete-current')) {
    deleteCurrent()
    return
  }
  if (e.target.closest('#sidebar-toggle')) {
    sidebar.classList.toggle('collapsed')
    try { localStorage.setItem('deepview.sidebarCollapsed', sidebar.classList.contains('collapsed') ? '1' : '0') } catch {}
  }
})

// On boot: restore the sidebar collapse state, render the file list,
// and switch to the last-viewed file if it's still around. No file
// loaded → drop zone stays visible.
;(async () => {
  try {
    if (localStorage.getItem('deepview.sidebarCollapsed') === '1') sidebar.classList.add('collapsed')
  } catch {}
  await renderSidebar()
  let last = null
  try { last = localStorage.getItem(LAST_FILE_KEY) } catch {}
  if (last) {
    const names = await listFiles()
    if (names.includes(last)) await switchToFile(last)
  }
})()

function resetFilters() {
  filterSeverities = new Set()
  filterColors = new Set()
  filterSource = 'all'
  filterConfMin = 8
  filterConfMax = ''
  filterInclude = ''
  filterExclude = ''
  sortBy = 'file'
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

// Drag/drop entry point. Each file is read, persisted to OPFS (replacing
// any existing entry of the same name), and the LAST one becomes the
// active view. Multiple drops at once still all save, but only the
// final one renders — merging across files is no longer a thing in the
// UI; the user switches via the sidebar.
async function addFiles(files) {
  let last = null
  for (const file of files) {
    try {
      const content = await file.text()
      await saveFile(file.name, content)
      last = { name: file.name, content }
    } catch (err) {
      alert(`Failed to load ${file.name}: ${err.message}`)
    }
  }
  if (last) await switchToFile(last.name, last.content)
  await renderSidebar()
}

// Replace the active view with the named OPFS file. Pre-fetched
// `content` skips a redundant OPFS read (drop path passes it through).
async function switchToFile(name, content) {
  reports = []
  currentFile = name
  // Reset tree-tab state so the new report opens clean: no leftover
  // selection from the previous report's file list, and the layout
  // cache invalidates (a new tree → re-layout).
  tree.selected = null
  tree.layoutCache = null
  cleanupGraphInteraction()
  try { localStorage.setItem(LAST_FILE_KEY, name) } catch {}
  if (content === undefined) {
    try {
      content = await readFile(name)
    } catch (err) {
      alert(`Failed to read ${name}: ${err.message}`)
      currentFile = null
      await renderSidebar()
      return
    }
  }
  await ingestReport(name, content)
  await renderSidebar()
}

// Remove the current file from OPFS and close the view. Doesn't
// auto-switch to another — the user picks from the sidebar.
async function deleteCurrent() {
  if (!currentFile) return
  const name = currentFile
  await deleteFile(name)
  currentFile = null
  reports = []
  tree.selected = null
  tree.layoutCache = null
  cleanupGraphInteraction()
  try { localStorage.removeItem(LAST_FILE_KEY) } catch {}
  report.classList.remove('active')
  report.innerHTML = ''
  dropZone.classList.remove('hidden')
  document.title = 'deepview results'
  await renderSidebar()
}

// Pure parse + render path — no FileReader, no OPFS. Used both by
// switchToFile (after content is materialized) and by the headless
// print flow (`window.__loadFile`), so that flow can still merge
// multiple inputs by calling repeatedly.
function ingestReport(name, content) {
  return new Promise((resolve) => {
  ;(async () => {
    try {
      // Persistent triage (markers/deletedIds keyed by uuid) is loaded
      // once at module init; await it before rendering so the first
      // drop already shows stored marks/deletions for matching findings.
      await loadPromise
      const data = JSON.parse(content)
      // Reset filters whenever this is the first report in the current
      // view (cleared on switchToFile / deleteCurrent, accumulating in
      // the headless print flow). The auto-tune that follows uses the
      // same gate.
      const isFirst = reports.length === 0
      // Dedup by exporter-provided uuid id across ALL loaded reports.
      // Input entries are either a single Finding or a Finding[] (a
      // dedup group from an upstream pass). A new group is dropped if
      // ANY of its members' ids match a previously-seen id — one
      // overlap is enough to conclude "already loaded" (groups don't
      // split / reshape across reloads). Findings without an id (legacy
      // JSON or pre-uuid exports) can't be deduped and always pass through.
      const seenIds = new Set()
      for (const r of reports) {
        for (const g of r.groups) {
          for (const f of g) if (f.id) seenIds.add(f.id)
        }
      }
      const groups = []
      let dupeCount = 0
      for (const entry of (data.findings || [])) {
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
          const filled = { ...f, _id: nextFindingId++ }
          const hasOwnMeta = META_FIELDS.some((k) => filled[k] !== undefined)
          if (!hasOwnMeta) {
            for (const key of META_FIELDS) {
              if (data[key] !== undefined) filled[key] = data[key]
            }
          }
          return filled
        })
        groups.push(stamped)
      }
      if (dupeCount > 0) console.log(`${name}: skipped ${dupeCount} duplicate finding${dupeCount === 1 ? '' : 's'}`)
      reports.push({
        type: data.type || 'analysis',
        fileName: name,
        groups,
        // Per-file imports / exports / hashes from the analyzer dump
        // (stamped at JSON-export time). The renderer surfaces this as
        // a separate "Tree" tab when more than one file is present.
        tree: data.tree ?? null,
      })
      if (isFirst) {
        resetFilters()
        // Auto-tune the confidence floor so the initial view fits roughly
        // 25 groups. Step up from 6 → 7 → 8 until the visible count is
        // within budget; cap at 8 (the previous static default) — going
        // higher hides too much of the report unconditionally. Counts
        // groups, not tabs, matching the filter semantics (`g.some(...)`).
        const countAtMin = (min) => groups.reduce((n, g) =>
          n + (g.some((f) => f.confidence !== undefined && f.confidence >= min) ? 1 : 0), 0)
        if (countAtMin(6) <= 25) filterConfMin = 6
        else if (countAtMin(7) <= 25) filterConfMin = 7
        else filterConfMin = 8
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
  if (severities !== undefined && severities !== null) filterSeverities = new Set(severities)
  if (confMin !== undefined) filterConfMin = confMin
  render()
}

// `githubRepo` (the per-finding `repo.github` value, e.g. `lodash/lodash`)
// wins over the user-typed repo URL when available — it points at the
// actual upstream of a node_modules dependency rather than at the project
// repo, which doesn't carry node_modules sources. Falls back to the
// user-typed repoUrl for own-source files (and when no per-finding repo
// is known).
function fileUrl(file, githubRepo) {
  if (githubRepo) return `https://github.com/${githubRepo}/blob/HEAD/${stripPackagePrefix(file)}`
  if (!repoUrl || isModule(file)) return null
  const base = repoUrl.replace(/\/$/u, '')
  return `${base}/blob/HEAD/${file}`
}

function fileLink(file, githubRepo) {
  const url = fileUrl(file, githubRepo)
  return url ? `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(file)}</a>` : esc(file)
}

function lineLink(file, line, githubRepo) {
  const url = fileUrl(file, githubRepo)
  const text = `line ${esc(String(line))}`
  if (!url) return text
  const lineNum = parseInt(line, 10)
  return `<a href="${esc(url)}#L${lineNum}" target="_blank" rel="noopener">${text}</a>`
}

// Per-tab filter predicate. Factored out so `applyFilters` (group-level)
// can ask "does ANY tab in this group match?" — per the user spec,
// one matching tab keeps the whole group visible.
function matchesFilters(f) {
  const inc = filterInclude.toLowerCase()
  const exc = filterExclude.toLowerCase()
  // Severity + color filters are multi-select Sets: empty = no filter,
  // non-empty = membership required. Unmarked tabs are bucketed under
  // the literal `'none'` so the user can isolate unreviewed findings by
  // ticking only that chip.
  if (filterSeverities.size > 0 && !filterSeverities.has(f.severity)) return false
  if (filterColors.size > 0) {
    const col = markers.get(tabKey(f)) ?? 'none'
    if (!filterColors.has(col)) return false
  }
  if (filterSource === 'own' && isModule(f.file)) return false
  if (filterSource === 'modules' && !isModule(f.file)) return false
  if (filterConfMin !== '' && (f.confidence === undefined || f.confidence < filterConfMin)) return false
  if (filterConfMax !== '' && (f.confidence === undefined || f.confidence > filterConfMax)) return false
  if (inc) { const text = findingText(f); if (!text.includes(inc)) return false }
  if (exc) { const text = findingText(f); if (text.includes(exc)) return false }
  return true
}

function applyFilters(groups) {
  return groups.filter((g) => g.some(matchesFilters))
}

// Group-level sort. For severity/confidence modes we compare on each
// group's primary tab (see sortTabs / primaryTab). 'file' sort is
// handled by the grouping below.
function applySorting(groups) {
  const sorted = [...groups]
  if (sortBy === 'severity') {
    sorted.sort((a, b) => {
      const pa = primaryTab(a), pb = primaryTab(b)
      return (SEVERITY_ORDER[pb.severity] || 0) - (SEVERITY_ORDER[pa.severity] || 0)
        || pa.file.localeCompare(pb.file)
        || parseInt(pa.line) - parseInt(pb.line)
    })
  } else if (sortBy === 'confidence-desc') {
    sorted.sort((a, b) => {
      const pa = primaryTab(a), pb = primaryTab(b)
      return (pb.confidence ?? -1) - (pa.confidence ?? -1) || pa.file.localeCompare(pb.file)
    })
  } else if (sortBy === 'confidence-asc') {
    sorted.sort((a, b) => {
      const pa = primaryTab(a), pb = primaryTab(b)
      return (pa.confidence ?? 11) - (pb.confidence ?? 11) || pa.file.localeCompare(pb.file)
    })
  }
  return sorted
}

// Render a single tab button. Shows the tab's severity badge + conf, and
// carries its own color / deleted classes so per-tab triage is visible
// from the group header.
function renderTab(f, isActive) {
  const key = tabKey(f)
  const color = markers.get(key)
  const deleted = deletedIds.has(key)
  const classes = ['tab']
  if (isActive) classes.push('active')
  if (color) classes.push(`tab-mark-${color}`)
  if (deleted) classes.push('tab-deleted')
  const confPart = f.confidence !== undefined ? `<span class="tab-conf">${f.confidence}/10</span>` : ''
  return `<button type="button" class="${classes.join(' ')}" data-tid="${esc(key)}"><span class="tab-label"><span class="badge ${esc(f.severity)}">${esc(f.severity)}</span> ${confPart}</span></button>`
}

// Render one tab's body (finding-left + content). Only the active tab
// body is shown on screen (CSS `.tab-body.active { display: grid }`);
// on print the CSS overrides to show every body stacked so paper output
// keeps all cases visible.
// `idx` / `total` feed the print-only "N of M" banner; on screen the tab
// strip already conveys group size, so `.print-case-label { display: none }`
// hides it. `.value-label` rows emit "Severity" / "Confidence" sub-captions
// below the badge / score on BOTH screen and paper — small enough to read
// as supporting metadata, big enough that someone unfamiliar with the UI
// conventions doesn't have to guess what a colored chip and a "5/10" mean.
function renderTabBody(f, isActive, idx = 0, total = 1) {
  const key = tabKey(f)
  let html = `<div class="tab-body${isActive ? ' active' : ''}" data-tid="${esc(key)}">`
  if (total > 1) html += `<div class="print-case-label">${idx + 1} of ${total}</div>`
  html += '<div class="finding-left">'
  // Sub-captions sit AFTER their values (below them visually).
  html += `<span class="badge ${esc(f.severity)}">${esc(f.severity)}</span>`
  html += '<div class="value-label">Severity</div>'
  if (f.confidence !== undefined) {
    html += `<div class="conf-score"><strong>${f.confidence}</strong>/10</div>`
    html += '<div class="value-label">Confidence</div>'
  }
  html += '</div>'
  html += '<div>'
  // `.line-row` flexes line numbers (left) against run-meta (right).
  // Empty `.run-meta` collapses so the line-num still sits flush left.
  // In file-grouped mode this row is hidden in favor of the per-finding
  // `.finding-loc` header above the card (CSS rule under .file-group).
  html += '<div class="line-row">'
  // Line number anchor + (when present) the export name the finding lives
  // in, comma-separated. The exportName is plain text — only the line
  // number gets linkified by `lineLink`. Pass `f.repo?.github` so a
  // node_modules finding links to the package's upstream repo rather
  // than the user-typed project URL.
  const exportPart = f.exportName ? `, ${esc(f.exportName)}` : ''
  html += `<span class="line-num">${lineLink(f.file, f.line, f.repo?.github)}${exportPart}</span>`
  if (f.discoveredIn) html += ` <span class="line-num">(found analyzing ${esc(f.discoveredIn)})</span>`
  const meta = [f.type, prettyModel(f.model), f.effort, f.exportsMode].filter(Boolean).join(' · ')
  if (meta) html += `<span class="run-meta">${esc(meta)}</span>`
  html += '</div>'
  html += `<div class="desc">${esc(stripExportMarker(f.description, f.exportName))}</div>`
  if (f.recommendation) html += `<div class="recommendation">Recommendation: ${esc(stripExportMarker(f.recommendation, f.exportName))}</div>`
  if (f.confidenceReason) html += `<div class="conf-reason">${esc(stripExportMarker(f.confidenceReason, f.exportName))}</div>`
  if (f.fileHash || f.treeHash) {
    const parts = []
    if (f.fileHash) parts.push(`file: ${esc(f.fileHash)}`)
    if (f.treeHash) parts.push(`tree: ${esc(f.treeHash)}`)
    html += `<div class="hashes">${parts.join(' | ')}</div>`
  }
  html += '</div></div>'
  return html
}

// Render one group as a `.finding` card. Group-level wrapper carries:
//   - `is-critical` if ANY tab is critical (matches filter semantics)
//   - `has-conflict` if tab colors disagree (accent outline, ignore deleted)
//   - `mark-<color>` if tabs share a common color (no conflict)
//   - `deleted` when in trash view (opacity nudge)
// Marks row at the bottom is group-level: color dots act on the active
// tab; delete acts on the whole group when conflict-free, on the active
// tab when conflicted. See click handler below for the inverse.
function renderGroup(g) {
  const state = groupState(g)
  const sortedTabs = sortTabs(g)
  const active = activeTabFor(g)
  const activeKey = tabKey(active)
  const isCritical = g.some((f) => f.critical || f.severity === 'critical')
  const classes = ['finding']
  if (isCritical) classes.push('is-critical')
  if (state.hasConflict) classes.push('has-conflict')
  else if (state.commonColor) classes.push(`mark-${state.commonColor}`)
  if (showDeleted) classes.push('deleted')
  // `multi-case` is a print-only hook: when there's more than one tab in
  // the group, the print stylesheet uses this class to draw a banner above
  // the stacked cases so a paper reader can tell at a glance that the
  // entries below are reports of one finding, not unrelated findings.
  if (sortedTabs.length > 1) classes.push('multi-case')
  const gid = groupKey(g)

  let html = `<div class="${classes.join(' ')}" data-gid="${esc(gid)}">`
  // Render every tab body so print mode can show them all stacked. Only
  // the active one is display:grid on screen; others are display:none.
  // Pass idx/total so each tab body can emit its own "Case N of M" banner
  // in print (suppressed on single-tab groups via the default args).
  sortedTabs.forEach((f, i) => {
    html += renderTabBody(f, tabKey(f) === activeKey, i, sortedTabs.length)
  })
  // Marks row. Colors reflect the ACTIVE tab (since clicks apply there).
  // Delete button's title changes to signal the per-tab vs. per-group
  // behavior depending on conflict state. The tab strip lives here too
  // (on the left, pushed apart from the dots by `margin-right: auto`
  // in CSS) so multi-tab groups get their tab picker adjacent to the
  // other per-group controls — one action row per finding.
  html += '<div class="marks">'
  // Tab strip — only for multi-tab groups; single findings render
  // without tabs and the dots sit alone on the right.
  if (sortedTabs.length > 1) {
    html += '<div class="tabs">'
    for (const f of sortedTabs) html += renderTab(f, tabKey(f) === activeKey)
    html += '</div>'
  }
  const activeColor = markers.get(activeKey)
  for (const color of ['red', 'blue', 'green', 'gray']) {
    const activeCls = activeColor === color ? ' active' : ''
    const dotTitle = sortedTabs.length > 1
      ? `mark ${color} (applies to active tab)`
      : `mark ${color} (click again to clear)`
    html += `<button class="mark-dot mark-dot-${color}${activeCls}" data-color="${color}" title="${dotTitle}"></button>`
  }
  if (showDeleted) {
    html += `<button class="mark-restore" title="restore whole group">restore</button>`
  } else {
    const xTitle = state.hasConflict
      ? 'delete active tab (colors mismatch — acts per-tab)'
      : (sortedTabs.length > 1 ? 'delete whole group' : 'delete')
    html += `<button class="mark-x" title="${xTitle}">×</button>`
  }
  html += '</div>'
  html += '</div>'
  return html
}

// Refresh just the tree-tab right sidebar in place. Called by graph.js
// after canvas selection changes (and from the click handlers below
// when the selection is driven from the sidebar itself), so we don't
// have to rebuild the canvas DOM and lose hover state.
function refreshTreeSidebar() {
  const infoEl = document.querySelector('.tree-info')
  if (!infoEl || !tree.graphState) return
  const treeData = reports[0]?.tree
  if (!treeData) return
  const findingCounts = computeFindingCountsByFile(reports.flatMap((r) => r.groups))
  const transitiveCounts = computeTransitiveCounts(treeData, findingCounts)
  infoEl.innerHTML = renderTreeSidebarFull(tree.selected, treeData, findingCounts, transitiveCounts)
}

function render() {
  if (reports.length === 0) return
  // Merge across all loaded reports. Every entry is a Finding[] (a dedup
  // group); single findings were wrapped at ingest, so downstream code
  // doesn't branch on shape. The trash-view split happens here, not in
  // applyFilters, so the "X of Y" counter and severity stats reflect
  // the set currently being viewed (live groups, or the trash).
  const mergedGroups = reports.flatMap((r) => r.groups)
  const deletedCount = mergedGroups.reduce((n, g) => n + (isGroupDeleted(g) ? 1 : 0), 0)
  const allGroups = mergedGroups.filter((g) => showDeleted ? isGroupDeleted(g) : !isGroupDeleted(g))
  // Preserve first-seen order for the type label so "security, correctness"
  // reads in load order rather than alphabetical.
  const types = [...new Set(reports.map((r) => r.type))]
  const typeLabel = types.join(', ')
  const fileNames = reports.map((r) => r.fileName)

  // Header analyzer breakdown — one entry per unique
  // `<analyzer> (<model>, <effort>, <exportsMode>)` combo seen across all
  // findings. The parenthetical lists whichever modifiers are set on
  // that combo, in the same order as the per-finding run-meta line so
  // the title and the per-finding annotations read consistently. Source
  // data comes from the run-meta lifted onto each finding at ingest, so
  // a single load can contain several combos when the user merges
  // multiple analyzer outputs. Model name is prettified the same way
  // (provider prefix + `claude-` stripped, dashes → spaces).
  const combos = [...new Set(reports.flatMap((r) =>
    r.groups.flatMap((g) => g.map((f) => {
      const type = f.type ?? 'unknown'
      const parts = []
      const model = prettyModel(f.model)
      if (model) parts.push(model)
      if (f.effort) parts.push(f.effort)
      if (f.exportsMode) parts.push(f.exportsMode)
      return parts.length > 0 ? `${type} (${parts.join(', ')})` : type
    }))
  ))]
  // Singular/plural keyed off the number of distinct combos shown — one
  // combo says "analyzer", any more says "analyzers". Two runs of the
  // same analyzer with different effort/exportsMode count as two combos
  // and pluralize accordingly.
  const analyzerLabel = combos.length === 1 ? 'analyzer' : 'analyzers'
  const headerText = combos.length > 0
    ? `DeepView results, ${analyzerLabel}: ${combos.map(esc).join(', ')}`
    : 'DeepView results'

  // Severity + color stats count GROUPS (not individual tabs). A group is
  // counted under every severity/color that appears in any of its tabs —
  // so sums can exceed the total group count when groups have mixed tabs.
  // This matches the filter semantics (click "high" → all groups where
  // any tab is high; click "red" → all groups with any red-marked tab),
  // and gives a useful preview of filter-click results. Unmarked tabs
  // bucket under `'none'` so the user can isolate unreviewed findings.
  const counts = { critical: 0, high: 0, medium: 0, low: 0 }
  const colorCounts = { red: 0, blue: 0, green: 0, gray: 0, none: 0 }
  for (const g of allGroups) {
    const sevs = new Set(g.map((f) => f.severity))
    for (const s of sevs) counts[s] = (counts[s] || 0) + 1
    const cols = new Set(g.map((f) => markers.get(tabKey(f)) ?? 'none'))
    for (const c of cols) colorCounts[c] = (colorCounts[c] || 0) + 1
  }

  const filtered = applySorting(applyFilters(allGroups))

  let html = '<header>'
  // headerText is pre-escaped (combo strings esc'd above) so it can include
  // mixed safe + interpolated content without re-escaping the whole thing.
  html += `<h1>${headerText}</h1>`
  const reportLabel = reports.length === 1
    ? esc(fileNames[0])
    : `${reports.length} reports: ${esc(fileNames.join(', '))}`
  const findingNoun = `finding${allGroups.length !== 1 ? 's' : ''}`
  const countLabel = showDeleted
    ? `Trash: ${allGroups.length} deleted ${findingNoun}`
    : `${allGroups.length} ${findingNoun}`
  html += `<div class="meta">${reportLabel} &mdash; ${countLabel}</div>`
  html += '</header>'

  // Top-level view switcher. Tree tab only appears for tree-bearing
  // reports with >1 file — a single-file tree adds no navigation value.
  // Both Tree (graph + sidebar) and Files (per-file cards) tabs share
  // the same gate; switching files / loading a tree-less report falls
  // back to 'findings' so the user doesn't end up on a hidden tab.
  const treeData = reports[0]?.tree
  const treeFileCount = treeData ? Object.keys(treeData).length : 0
  const showTreeTab = treeFileCount > 1
  if (!showTreeTab && (currentView === 'tree' || currentView === 'files')) currentView = 'findings'
  if (showTreeTab) {
    html += '<div class="report-tabs">'
    html += `<button type="button" class="report-tab${currentView === 'findings' ? ' active' : ''}" data-view="findings">Findings</button>`
    html += `<button type="button" class="report-tab${currentView === 'tree' ? ' active' : ''}" data-view="tree">Graph</button>`
    html += `<button type="button" class="report-tab${currentView === 'files' ? ' active' : ''}" data-view="files">Files (${treeFileCount})</button>`
    html += '</div>'
  }

  if (currentView === 'tree') {
    // Pre-filter finding counts (total per file, by severity); plus the
    // transitive subtree rollup that drives both the "subtree findings"
    // chips in the sidebar AND the show-all filter (a file with no own
    // findings is still kept when its subtree has some).
    const findingCounts = computeFindingCountsByFile(mergedGroups)
    const transitiveCounts = computeTransitiveCounts(treeData, findingCounts)
    html += '<div class="tree-layout">'
    html += `<div class="tree-canvas">${renderTreeCanvas(treeData, findingCounts, transitiveCounts)}</div>`
    html += `<div class="tree-info">${renderTreeSidebarFull(tree.selected, treeData, findingCounts, transitiveCounts)}</div>`
    html += '</div>'
    report.innerHTML = html
    report.classList.add('active')
    report.classList.toggle('show-metadata', showMetadata)
    dropZone.classList.add('hidden')
    document.title = `DeepView results — ${typeLabel || 'no analyzer'}`
    attachTreeGraphInteraction(report.querySelector('.tree-canvas'), refreshTreeSidebar)
    return
  }

  if (currentView === 'files') {
    const findingCounts = computeFindingCountsByFile(mergedGroups)
    html += renderTreeView(treeData, findingCounts)
    report.innerHTML = html
    report.classList.add('active')
    report.classList.toggle('show-metadata', showMetadata)
    dropZone.classList.add('hidden')
    document.title = `DeepView results — ${typeLabel || 'no analyzer'}`
    return
  }

  // Stats — clickable filter chips. Severity chips on the left, mark-color
  // chips on the right. Both are multi-select: empty selection = no
  // filter; multiple selections = union across the ticked chips (so
  // ticking every chip is equivalent to ticking none). A zero-count
  // chip is hidden so the row stays compact.
  html += '<div class="stats">'
  const statItems = [
    ['critical', counts.critical, '--critical'],
    ['high', counts.high, '--high'],
    ['medium', counts.medium, '--medium'],
    ['low', counts.low, '--low'],
  ]
  for (const [sev, count, color] of statItems) {
    if (!count) continue
    const active = filterSeverities.has(sev) ? ' active' : ''
    html += `<div class="stat${active}" data-sev="${sev}"><strong style="color:var(${color})">${count}</strong>${sev}</div>`
  }
  const colorStatItems = [
    ['red', colorCounts.red, 'red'],
    ['blue', colorCounts.blue, 'blue'],
    ['green', colorCounts.green, 'green'],
    ['gray', colorCounts.gray, 'gray'],
    ['none', colorCounts.none, 'unmarked'],
  ]
  for (const [col, count, label] of colorStatItems) {
    if (!count) continue
    const active = filterColors.has(col) ? ' active' : ''
    html += `<div class="stat${active}" data-color="${col}"><strong>${count}</strong><span class="stat-dot stat-dot-${col}"></span>${label}</div>`
  }
  html += '</div>'

  // Toolbar
  html += '<div class="toolbar">'
  html += '<div class="toolbar-row">'
  html += `<label for="sort-select">Sort:</label>`
  html += `<select id="sort-select">`
  html += `<option value="file"${sortBy === 'file' ? ' selected' : ''}>By file</option>`
  html += `<option value="severity"${sortBy === 'severity' ? ' selected' : ''}>By severity</option>`
  html += `<option value="confidence-desc"${sortBy === 'confidence-desc' ? ' selected' : ''}>Confidence (high first)</option>`
  html += `<option value="confidence-asc"${sortBy === 'confidence-asc' ? ' selected' : ''}>Confidence (low first)</option>`
  html += `</select>`
  html += `<div class="sep"></div>`
  html += `<label for="source-select">Source:</label>`
  html += `<select id="source-select">`
  html += `<option value="all"${filterSource === 'all' ? ' selected' : ''}>All files</option>`
  html += `<option value="own"${filterSource === 'own' ? ' selected' : ''}>Own source</option>`
  html += `<option value="modules"${filterSource === 'modules' ? ' selected' : ''}>node_modules</option>`
  html += `</select>`
  html += `<div class="sep"></div>`
  html += `<label for="conf-min">Confidence:</label>`
  html += `<select id="conf-min">`
  html += `<option value="">min</option>`
  for (let i = 0; i <= 10; i++) html += `<option value="${i}"${filterConfMin === i ? ' selected' : ''}>${i}</option>`
  html += `</select>`
  html += ` &ndash; `
  html += `<select id="conf-max">`
  html += `<option value="">max</option>`
  for (let i = 0; i <= 10; i++) html += `<option value="${i}"${filterConfMax === i ? ' selected' : ''}>${i}</option>`
  html += `</select>`
  html += `<div class="sep"></div>`
  html += `<label class="checkbox-label"><input type="checkbox" id="show-metadata"${showMetadata ? ' checked' : ''}> metadata</label>`
  html += `<label class="checkbox-label"><input type="checkbox" id="group-by-file"${groupByFile ? ' checked' : ''}> group by file</label>`
  const trashTitle = showDeleted ? 'exit trash view' : 'show deleted findings'
  const trashLabel = `Trash${deletedCount ? ` (${deletedCount})` : ''}`
  html += `<button type="button" id="toggle-trash" class="trash-btn${showDeleted ? ' active' : ''}" title="${trashTitle}">${trashLabel}</button>`
  html += `<button type="button" id="print-btn" class="trash-btn" title="print report (sets the document title to the filename / common prefix while printing)">Print</button>`
  html += `<span class="result-count">${filtered.length} of ${allGroups.length}</span>`
  html += '</div>'
  html += '<div class="toolbar-row">'
  html += `<label for="filter-include">Include:</label>`
  html += `<input type="text" id="filter-include" value="${esc(filterInclude)}" placeholder="match text">`
  html += `<label for="filter-exclude">Exclude:</label>`
  html += `<input type="text" id="filter-exclude" value="${esc(filterExclude)}" placeholder="hide text">`
  html += '</div>'
  html += '<div class="toolbar-row">'
  html += `<label for="repo-url">Repo:</label>`
  html += `<input type="text" id="repo-url" value="${esc(repoUrl)}" placeholder="https://github.com/user/repo">`
  html += '</div>'
  html += '</div>'

  if (showDeleted && allGroups.length === 0) {
    html += `<p style="color:var(--muted); margin: 1rem 0;">Trash is empty.</p>`
  } else if (filtered.length === 0 && allGroups.length > 0) {
    html += `<p style="color:var(--muted); margin: 1rem 0;">No findings match the current filters.</p>`
  } else if (allGroups.length === 0) {
    html += `<p style="color:var(--green)">No ${esc(typeLabel)} issues found.</p>`
  }

  if (groupByFile) {
    // Group groups by file. All tabs in a dedup group share the same file
    // (dedup runs per-file by fileHash upstream), so the primary tab's
    // file is a safe representative.
    const byFile = new Map()
    for (const g of filtered) {
      const file = primaryTab(g).file
      if (!byFile.has(file)) byFile.set(file, [])
      byFile.get(file).push(g)
    }

    // For file sort, sort files alphabetically; otherwise preserve first-appearance order
    const fileKeys = sortBy === 'file' ? [...byFile.keys()].sort() : [...byFile.keys()]

    for (const file of fileKeys) {
      const items = sortBy === 'file'
        ? byFile.get(file).sort((a, b) => parseInt(primaryTab(a).line) - parseInt(primaryTab(b).line))
        : byFile.get(file)
      html += '<div class="file-group">'
      // All findings under one file share the same `repo.github` (it's
      // a property of the source file's package), so probe the first
      // group's primary tab — every other tab in this file would carry
      // the same value or none at all.
      const githubRepo = primaryTab(items[0])?.repo?.github
      html += `<div class="file-header"><span>${fileLink(file, githubRepo)}</span><span class="count">${items.length}</span></div>`
      html += '<div class="file-body">'
      for (const g of items) html += renderGroup(g)
      html += '</div></div>'
    }
  } else {
    // Flat mode: each dedup group renders inside its own card (.flat-group)
    // with a small location header on top (file · line · exportName).
    // `applySorting` already ordered `filtered` by the chosen sortBy; for
    // the 'file' sort we extend that ordering with line-within-file, which
    // the file-grouped path achieves by sorting per-file.
    const items = sortBy === 'file'
      ? [...filtered].sort((a, b) => {
        const pa = primaryTab(a), pb = primaryTab(b)
        return pa.file.localeCompare(pb.file) || parseInt(pa.line) - parseInt(pb.line)
      })
      : filtered
    // Each group's location header carries the FULL line row (file +
    // line + exportName + run-meta) for the active tab. The in-body
    // line-row inside the .finding card is hidden (CSS rule under
    // `.flat-group .finding .line-row`) so the same info doesn't
    // appear twice. Tab switches re-render, so the header tracks the
    // active tab automatically.
    for (const g of items) {
      const p = activeTabFor(g)
      const lineHtml = `<span class="line-num">${lineLink(p.file, p.line, p.repo?.github)}</span>`
      const exportHtml = p.exportName ? `<span class="meta">${esc(p.exportName)}</span>` : ''
      const meta = [p.type, prettyModel(p.model), p.effort, p.exportsMode].filter(Boolean).join(' · ')
      const metaHtml = meta ? `<span class="run-meta">${esc(meta)}</span>` : ''
      html += '<div class="flat-group">'
      html += `<div class="flat-group-loc"><span class="file">${fileLink(p.file, p.repo?.github)}</span>${lineHtml}${exportHtml}${metaHtml}</div>`
      html += renderGroup(g)
      html += '</div>'
    }
  }

  report.innerHTML = html
  report.classList.add('active')
  report.classList.toggle('show-metadata', showMetadata)
  dropZone.classList.add('hidden')
  document.title = `DeepView results — ${typeLabel || 'no analyzer'}`
}

function renderKeepFocus(inputId) {
  const prev = document.getElementById(inputId)
  const pos = prev ? prev.selectionStart : 0
  render()
  const el = document.getElementById(inputId)
  if (el) { el.focus(); el.setSelectionRange(pos, pos) }
}

// Event delegation — all interactive elements handled here, no inline handlers
report.addEventListener('click', (e) => {
  // Top-level view switcher (Findings / Tree / Files).
  const viewTab = e.target.closest('.report-tab')
  if (viewTab && viewTab.dataset.view) {
    currentView = viewTab.dataset.view
    render()
    return
  }
  // Tree-tab: click a graph node to select it (drives the sidebar).
  const treeNode = e.target.closest('.tree-canvas-svg .tree-node[data-file]')
  if (treeNode) {
    tree.selected = treeNode.dataset.file
    render()
    return
  }
  // Tree-tab sidebar: importer / import buttons select the linked file.
  const selectFileBtn = e.target.closest('[data-select-file]')
  if (selectFileBtn) {
    tree.selected = selectFileBtn.dataset.selectFile
    // Update canvas selection highlight + sidebar without rebuilding canvas DOM.
    if (tree.graphState) {
      const canvasEl = document.querySelector('#tree-canvas')
      if (canvasEl) canvasEl.dispatchEvent(new CustomEvent('tree-node-select', { bubbles: true }))
    } else {
      render()
    }
    return
  }
  // Tree-tab sidebar: hubs tab toggle (Issues / Imports).
  const hubsTabBtn = e.target.closest('[data-hubs-tab]')
  if (hubsTabBtn) {
    if (tree.graphState) {
      tree.graphState._hubsTab = hubsTabBtn.dataset.hubsTab
      refreshTreeSidebar()
    } else {
      render()
    }
    return
  }
  // Tree-tab toolbar: fullscreen toggle. Adds / removes a class on
  // <body>; the @media-style rules in CSS hide the chrome.
  if (e.target.closest('#tree-fullscreen')) {
    document.body.classList.toggle('report-fullscreen')
    return
  }
  // Tree-tab sidebar: "Open in Findings" resets ALL filters, then narrows
  // to the selected file's path so only that file's findings show.
  const jumpFindingsBtn = e.target.closest('[data-jump-findings]')
  if (jumpFindingsBtn) {
    resetFilters()
    filterConfMin = ''
    filterInclude = jumpFindingsBtn.dataset.jumpFindings
    currentView = 'findings'
    render()
    return
  }
  // Tree-tab sidebar: "Open in Files" jumps to the Files tab and
  // scrolls to the selected file's card.
  const jumpBtn = e.target.closest('[data-jump-file]')
  if (jumpBtn) {
    const targetFile = jumpBtn.dataset.jumpFile
    currentView = 'files'
    render()
    // Wait one frame so the Files tab DOM exists before we look up
    // the anchor (render() rewrote innerHTML).
    requestAnimationFrame(() => {
      const target = document.getElementById(treeAnchor(targetFile))
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' })
    })
    return
  }
  // Tab click — switch the active tab within a group. Re-render because
  // tab highlight + tab body visibility + marks row color all update.
  const tabEl = e.target.closest('.tab')
  if (tabEl && tabEl.closest('.tabs')) {
    const findingEl = tabEl.closest('.finding')
    const gid = findingEl.dataset.gid
    const tid = tabEl.dataset.tid
    activeTabByGroup.set(gid, tid)
    render()
    return
  }
  // Mark-dot: color applies to the ACTIVE tab only (per spec rule 4).
  // This may change tab sort order (colored tabs come first), so a full
  // re-render is necessary — we can't just flip classes in place.
  const dot = e.target.closest('.mark-dot')
  if (dot) {
    const findingEl = dot.closest('.finding')
    const gid = findingEl.dataset.gid
    const group = findGroupById(gid)
    if (!group) return
    const activeKey = tabKey(activeTabFor(group))
    const color = dot.dataset.color
    const current = markers.get(activeKey)
    if (current === color) markers.delete(activeKey)
    else markers.set(activeKey, color)
    saveTriage()
    render()
    return
  }
  // Delete-x: soft-delete (moved to trash, not discarded).
  //   - No color conflict → delete the whole group (spec rule 4 exception).
  //   - Color conflict     → per-tab delete (spec rule 4 general case).
  // Markers are preserved so restore recovers the full prior state.
  const xBtn = e.target.closest('.mark-x')
  if (xBtn) {
    const findingEl = xBtn.closest('.finding')
    const gid = findingEl.dataset.gid
    const group = findGroupById(gid)
    if (!group) return
    const state = groupState(group)
    if (state.hasConflict) {
      deletedIds.add(tabKey(activeTabFor(group)))
    } else {
      for (const f of group) deletedIds.add(tabKey(f))
    }
    saveTriage()
    render()
    return
  }
  // Restore: per spec rule 5, applies to EVERY tab in the group — a
  // user in trash view clicking restore expects the whole entry back,
  // not just one member left behind.
  const restoreBtn = e.target.closest('.mark-restore')
  if (restoreBtn) {
    const findingEl = restoreBtn.closest('.finding')
    const gid = findingEl.dataset.gid
    const group = findGroupById(gid)
    if (!group) return
    for (const f of group) deletedIds.delete(tabKey(f))
    saveTriage()
    render()
    return
  }
  // Trash toggle — switches the render path from "non-deleted" to
  // "deleted only". Filters (severity, confidence, text match) still
  // apply, just against the trash rather than the live set.
  if (e.target.closest('#toggle-trash')) {
    showDeleted = !showDeleted
    render()
    return
  }
  // Severity / color stat toggle. Both are multi-select — click toggles
  // membership in the matching Set, empty Set = no filter.
  const sevStat = e.target.closest('.stat[data-sev]')
  if (sevStat) {
    const sev = sevStat.dataset.sev
    if (filterSeverities.has(sev)) filterSeverities.delete(sev)
    else filterSeverities.add(sev)
    render()
    return
  }
  // Scoped to `.stat[data-color]` so mark-dot buttons (which also carry
  // `data-color` but are `<button>`s, not `.stat` cards) don't match —
  // they were already handled above.
  const colorStat = e.target.closest('.stat[data-color]')
  if (colorStat) {
    const col = colorStat.dataset.color
    if (filterColors.has(col)) filterColors.delete(col)
    else filterColors.add(col)
    render()
    return
  }
  // File header collapse (skip if clicking a link)
  const header = e.target.closest('.file-header')
  if (header && e.target.tagName !== 'A') {
    header.parentElement.classList.toggle('collapsed')
    return
  }
  // Print button — set document.title to the filename (or longest common
  // prefix when multiple files are loaded) so the OS print dialog and any
  // saved PDF default to a meaningful name, then call window.print() and
  // restore the original title. window.print() is synchronous in current
  // browsers (blocks until the dialog is dismissed), so the restore lands
  // before anything else can read the title.
  if (e.target.closest('#print-btn')) {
    const fileNames = reports.map((r) => r.fileName)
    let target = ''
    if (fileNames.length === 1) target = fileNames[0]
    else if (fileNames.length > 1) target = commonPrefix(fileNames)
    // Strip the `.json` suffix so a "Save as PDF" doesn't end up named
    // `<report>.json.pdf`. Also handles a stripped trailing `.` from
    // a partial common prefix like `security-foo.j` — only `.json`
    // exactly at the end gets removed.
    target = target.replace(/\.json$/u, '')
    const oldTitle = document.title
    if (target) document.title = target
    window.print()
    document.title = oldTitle
  }
})

report.addEventListener('change', (e) => {
  const id = e.target.id
  const val = e.target.value
  if (id === 'sort-select') { sortBy = val; render() }
  else if (id === 'source-select') { filterSource = val; render() }
  else if (id === 'conf-min') { filterConfMin = val === '' ? '' : parseInt(val, 10); render() }
  else if (id === 'conf-max') { filterConfMax = val === '' ? '' : parseInt(val, 10); render() }
  // Toggle `show-metadata` on #report without a full re-render —
  // avoids reallocating the checkbox mid-click (which would blur it)
  // and is cheap since this is a pure CSS effect.
  else if (id === 'show-metadata') { showMetadata = e.target.checked; report.classList.toggle('show-metadata', showMetadata) }
  // `group-by-file` reshapes the rendered DOM (per-file headers vs flat
  // location labels), so it goes through a full render — checkbox blur
  // is acceptable here since the change is structural.
  else if (id === 'group-by-file') { groupByFile = e.target.checked; render() }
  // Tree-tab: include clean files in the force graph. Invalidates the
  // cached layout so the next render computes fresh positions.
  else if (id === 'tree-show-all') {
    tree.showAll = e.target.checked
    tree.layoutCache = null
    cleanupGraphInteraction()
    render()
  }
})

report.addEventListener('input', (e) => {
  const id = e.target.id
  const val = e.target.value
  if (id === 'filter-include') { filterInclude = val; renderKeepFocus(id) }
  else if (id === 'filter-exclude') { filterExclude = val; renderKeepFocus(id) }
  else if (id === 'repo-url') { repoUrl = val; renderKeepFocus(id) }
})
