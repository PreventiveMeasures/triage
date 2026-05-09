import { html, render as litRender, nothing } from 'lit'
import { unsafeHTML } from 'lit/directives/unsafe-html.js'
import { FILE_ICONS, displayName, groupOf } from './file-display.js'
import { state } from '../../client/state.js'
import { dropZone, report } from './dom.js'
import { SEVERITIES, SEVERITY_ORDER, configureDepsDir, fileLink, formatBytes, isModule, lineLink, prettyModel, stripCommonPathPrefix } from './format.js'
import { activeTabFor, groupKey, groupState, primaryTab, tabKey } from './group.js'
import { applyFilters, applySorting } from './filters.js'
import { findingCardGid } from './render-finding.js'
import { computeFileHash } from '../../common/finding-id.js'
import { ensureBundleFindingsIndexed, findingsForFileHash, getPackagesIndex, reportsForFinding } from '../../client/bundle-finding-index.js'
import { langForPath, highlight as prismHighlight } from './prism-highlight.js'
import { computeFindingCountsByFile, computeTransitiveCounts } from './graph/utils.js'
import { pkgColor } from './graph/utils.js'
import { renderTreeView } from './graph/files.js'
import { graph2 } from './graph2/state.js'
import { buildGraph } from './graph2/data.js'
import { listWorkspaces } from '../../client/workspaces.js'
import { renderFocusOverlay, renderGraph2Layout, renderSelectionCard, renderTopPkgsBlock } from './graph2/render.js'
import { attachGraph2Interaction } from './graph2/canvas.js'
import { fileHasFindings, packageOf } from './graph/utils.js'

// View-mode icons + titles + click handling all live in
// `<view-mode-buttons>` (see view/view-mode-buttons.js); the host
// passes the current `state.viewMode` and listens for
// `view-mode-change` events.

// Build the v2 graph data from the currently-loaded report. Returns
// null when no tree-bearing report is loaded — callers (the tab
// switcher in render(), the "Graph v2" event handler) use that to
// fall back to a friendlier state.
//
// Two filters compose:
//   - state.showDeleted splits findings the same way the findings
//     tab does: live findings by default, deleted findings in trash
//     mode. Visibility is at the GROUP level (a group is "deleted"
//     when every member is in state.deletedIds), matching the
//     findings tab so swapping tabs reads consistently.
//   - graph2.showAll then optionally pads the file set with clean
//     files whose subtree contains a (filtered-in) finding,
//     reachable through imports. Off by default so the canvas
//     focuses on issue-bearing code.
export function buildGraph2Data() {
  const treeData = state.reports[0]?.tree
  if (!treeData) return null
  const allFiles = Object.keys(treeData)
  const allGroups = state.reports.flatMap((r) => r.groups)
  // Filter to live (default) or deleted (trash mode) groups
  // BEFORE counting per-file findings, so the layout, statistics,
  // and severity-row counts all reflect the active tab's split.
  const visibleGroups = allGroups.filter((g) =>
    groupState(g).commonTriage === state.shownTriage)
  const findingCounts = computeFindingCountsByFile(visibleGroups)
  const transitiveCounts = computeTransitiveCounts(treeData, findingCounts)
  // Per-file Sets that drive the topbar severity / triage chip
  // counts AND the canvas dim predicate. Each finding contributes
  // its severity tier and its current marker color (default 'none'
  // when unmarked); a file is highlighted under a filter iff any
  // of its findings matches — same union semantics the findings
  // tab's filter uses, so the canvas highlight tracks "issues that
  // would have been displayed by the table".
  const severitySets = new Map()
  const colorSets = new Map()
  // Per-finding `{severity, color}` pairs, stamped on each node so
  // the Packages → Issues distribution can count findings filtered
  // by BOTH severity and color simultaneously (a count derived from
  // per-severity totals alone can't intersect with the color
  // filter). Sets above stay separate for the canvas dim predicate
  // and the topbar chip counts where set membership is enough.
  const fileFindings = new Map()
  for (const g of visibleGroups) {
    for (const f of g) {
      if (!severitySets.has(f.file)) severitySets.set(f.file, new Set())
      severitySets.get(f.file).add(f.severity)
      const color = state.markers.get(tabKey(f)) ?? 'none'
      if (!colorSets.has(f.file)) colorSets.set(f.file, new Set())
      colorSets.get(f.file).add(color)
      if (!fileFindings.has(f.file)) fileFindings.set(f.file, [])
      fileFindings.get(f.file).push({ severity: f.severity, color })
    }
  }
  // Package-focus mode narrows to files in the focused package.
  // graph2.showAll still gates the clean-file filter inside that
  // scope: when off, drop files that have neither own findings
  // nor a subtree (transitive) finding reachable through imports
  // — same predicate the full-graph view uses, applied to the
  // package subset. The canvas's intra-package import set falls
  // out automatically since buildGraph filters edges to the file
  // set; cross-package imports outside the focus aren't drawn,
  // but their transitive findings still count toward keeping a
  // file in scope (they're part of "reachable issues" the user
  // expects to see represented).
  let files
  if (graph2.focusedPkg) {
    files = allFiles.filter((f) => (packageOf(f) ?? '__own__') === graph2.focusedPkg)
    if (!graph2.showAll) {
      files = files.filter((f) => fileHasFindings(f, findingCounts, transitiveCounts))
    }
  } else {
    files = graph2.showAll
      ? allFiles
      : allFiles.filter((f) => fileHasFindings(f, findingCounts, transitiveCounts))
  }
  return {
    graph: buildGraph(treeData, files, findingCounts, transitiveCounts, severitySets, colorSets, fileFindings),
    findingCounts,
  }
}

// Re-render only the right-panel selection card. Surgical update
// — the canvas DOM (and thus the active rAF / hover state) survives
// a click on a node or a sidebar neighbor link. `litRender` runs its
// own diff against the cached PartInfo it stamps on the container,
// so we feed the new template directly; clearing `innerHTML` first
// would orphan the cache and the next render would try to
// `insertBefore` on a null parent (TypeError on the next click).
export function refreshGraph2Sidebar() {
  const area = document.getElementById('g2-selection-area')
  if (!area) return
  const data = buildGraph2Data()
  if (!data) return
  litRender(renderSelectionCard(data.graph), area)
  // The top-right canvas overlay (drill-in icon button) depends
  // on the same selection / solo / focus state the selection
  // card does, so refresh both from the same trigger. Slot
  // element is rendered unconditionally by renderStage; we just
  // swap its content via the same lit-managed update.
  const focusSlot = document.getElementById('g2-focus-overlay-slot')
  if (focusSlot) litRender(renderFocusOverlay(data.graph), focusSlot)
}

// Re-render only the right-panel "Top packages" block. Called when
// the user flips the Issues/Files mini-tab. Same canvas-preserving
// pattern as refreshGraph2Sidebar — let `litRender` diff against
// its cached PartInfo on the container; manually clearing
// `innerHTML` would break the cache.
export function refreshGraph2TopPkgs() {
  const block = document.getElementById('g2-top-pkgs-block')
  if (!block) return
  const data = buildGraph2Data()
  if (!data) return
  litRender(renderTopPkgsBlock(data.graph), block)
}

// Bundles graph — parallel to buildGraph2Data above, but the data
// source is a parsed bundle (sourcemap / stasis) instead of a
// loaded report. Findings are not attached yet (a follow-up wires
// them by file-hash matching against state.reports). The reused
// pieces below (refreshBundleGraphSidebar / refreshBundleGraphTopPkgs)
// mirror their findings-tab counterparts so the same renderGraph2Layout
// can render against either data source: each call uses the cached
// `_currentBundleGraph` reference to feed the right-panel templates.
let _currentBundleGraph = null

// Per-file content map for the open bundle. Stasis's `json.sources`
// is `{ file: content }` directly; sourcemaps shred sources and
// sourcesContent across two parallel arrays. Returns Map<file,
// content-string>; non-string content is skipped.
function bundleSourcesAsMap(details) {
  const result = new Map()
  if (!details || !details.json) return result
  if (details.kind === 'stasis') {
    for (const [file, content] of Object.entries(details.json.sources ?? {})) {
      if (typeof content === 'string') result.set(file, content)
    }
  } else if (details.kind === 'sourcemap') {
    const srcs = details.json.sources ?? []
    const contents = details.json.sourcesContent ?? []
    for (let i = 0; i < srcs.length; i++) {
      if (typeof contents[i] === 'string') result.set(srcs[i], contents[i])
    }
  }
  return result
}

// File → set of resolved import paths. Stasis carries imports under
// `json.imports['<type>']['<file>']['<spec>']`; we union across all
// resolution kinds (node, import, module-sync, ...) and dedupe per
// file. Sourcemaps have no import info, so the map is empty.
function bundleImportsAsMap(details) {
  const result = new Map()
  if (!details || details.kind !== 'stasis' || !details.json) return result
  for (const byFile of Object.values(details.json.imports ?? {})) {
    for (const [file, specMap] of Object.entries(byFile ?? {})) {
      if (!result.has(file)) result.set(file, new Set())
      for (const resolved of Object.values(specMap ?? {})) {
        if (typeof resolved === 'string') result.get(file).add(resolved)
      }
    }
  }
  return result
}

// Synthesise a treeData blob shaped like the analyzer's tree dump,
// so buildGraph (in graph2/data.js) can chew on it without
// modification. The shared directory prefix (a common build-output
// root) is stripped from every file path BEFORE the tree is built
// so the graph's nodes — and the package buckets the canvas
// derives from them — use compact, prefix-free keys. Imports get
// remapped through the same stripping table so adjacency stays
// intact, and out-of-bundle resolutions are dropped.
//
// Sizes come from the source content (UTF-8 byte length). Returns
// `{ tree, origToStripped }`; callers that also need to translate
// other per-file metadata (e.g. SHA-512 hashes for finding match)
// onto the stripped keys reuse the mapping.
function buildBundleTree(details) {
  const sources = bundleSourcesAsMap(details)
  const imports = bundleImportsAsMap(details)
  const origFiles = [...sources.keys()]
  const { stripped } = stripCommonPathPrefix(origFiles)
  const origToStripped = new Map(origFiles.map((f, i) => [f, stripped[i]]))
  const tree = {}
  for (const [origFile, content] of sources) {
    const file = origToStripped.get(origFile)
    const imps = imports.get(origFile)
    tree[file] = {
      imports: imps
        ? [...imps].map((i) => origToStripped.get(i)).filter(Boolean)
        : [],
      size: new TextEncoder().encode(content).byteLength,
    }
  }
  return { tree, origToStripped }
}

// SHA-512 of each bundle source's content, in the canonical
// `sha512-${base64}` SRI-style form that `computeFileHash`
// (common/finding-id.js) produces — same hashing the analyzer
// stamps on findings, so the two strings compare equal. Async
// because crypto.subtle.digest is. Returns Map<file, integrity>.
export async function computeBundleFileHashes(details) {
  const sources = bundleSourcesAsMap(details)
  const result = new Map()
  for (const [file, content] of sources) {
    result.set(file, await computeFileHash(content))
  }
  return result
}

// Match every indexed finding against the bundle's per-file
// hashes. Returns Map<file, Finding[]>. Pulls from the OPFS-wide
// `bundle-finding-index` (client/bundle-finding-index.js) rather
// than `state.reports` so a bundle is matched against EVERY report
// the user has ever dropped — not only the one they happen to have
// open right now. The index is populated in the background by
// `ensureBundleFindingsIndexed`; this lookup is purely synchronous,
// reading whatever is currently cached.
//
// Multiple findings can share a fileHash (a single source dropped
// in one scan may emit several), and a single hash may map to
// multiple bundle files (rare — duplicate sources).
// Per-bucket counts of bundle-matched findings — drives the graph
// topbar's triage selector visibility / counts. Walks the same
// hash → finding index that bundleFindingsByFile uses, bucketing
// each finding by its triage state (or 'live' when none).
function countBundleTriageBuckets(details) {
  const counts = { fixed: 0, invalid: 0, deleted: 0 }
  if (!details?.fileHashes) return counts
  const seen = new Set()
  for (const hash of details.fileHashes.values()) {
    if (seen.has(hash)) continue
    seen.add(hash)
    for (const f of findingsForFileHash(hash)) {
      const t = state.triageState.get(tabKey(f))
      if (t && counts[t] !== undefined) counts[t]++
    }
  }
  return counts
}

// Bundle-side per-finding filter. Two modes:
//
//   'graph'  — bundle graph view. Filter follows state.shownTriage
//              (null = live + ignored, 'fixed'/'invalid'/'deleted'
//              = exact bucket). Ignore is intentionally NOT
//              considered here: it's a per-report flag and a
//              bundle aggregates findings across reports, so an
//              ignored finding still counts as live in the bundle's
//              non-triaged view. The selector exposes only the
//              three triage buckets accordingly.
//
//   'issues' — bundle Issues list (and the source viewer's per-line
//              dots / panel). Always shows live + fixed + ignored;
//              invalid + deleted are hidden. Rationale: a bundle
//              built before a fix shipped is still affected; a
//              per-report ignore signals "anticipated future
//              removal" but the bundle is still affected today.
//              Invalid / deleted dismiss the issue entirely so we
//              drop them from the bundle list.
function bundleFindingsByFile(fileHashes, mode = 'graph') {
  if (!fileHashes || fileHashes.size === 0) return new Map()
  const result = new Map()
  for (const [file, hash] of fileHashes) {
    const found = findingsForFileHash(hash)
    if (found.length === 0) continue
    const filtered = found.filter((f) => {
      const t = state.triageState.get(tabKey(f)) ?? null
      if (mode === 'issues') return t !== 'invalid' && t !== 'deleted'
      return t === state.shownTriage
    })
    if (filtered.length === 0) continue
    if (!result.has(file)) result.set(file, [])
    const arr = result.get(file)
    for (const f of filtered) arr.push(f)
  }
  return result
}

// BFS-walk the import graph starting from every issue-bearing
// file and return the closure (issue files + every file they
// depend on, directly or transitively). Used by
// `buildBundleGraphData` when `graph2.showAll` is OFF: the file
// set narrows to this closure so clean files that aren't a dep of
// any issue-bearing file get hidden, but every file the issue
// chain depends on stays visible.
function bundleReachableFromIssueFiles(tree, ownCounts) {
  const visible = new Set()
  for (const [file, counts] of ownCounts) {
    if (!counts) continue
    for (const v of Object.values(counts)) {
      if (v > 0) { visible.add(file); break }
    }
  }
  const queue = [...visible]
  while (queue.length > 0) {
    const file = queue.shift()
    const imps = tree[file]?.imports ?? []
    for (const imp of imps) {
      if (!visible.has(imp) && tree[imp]) {
        visible.add(imp)
        queue.push(imp)
      }
    }
  }
  return visible
}

// Build a graph2-shaped graph from the open bundle. When the
// bundle's per-file hashes have been computed (events.js kicks
// the async digest after parse), findings from the loaded reports
// are matched onto bundle files via fileHash equality and rolled
// up into the same `ownCounts` / `severitySet` / `colorSet` /
// `findings` shape buildGraph expects. Without hashes, every node
// is "clean" — the topbar chip counts collapse to zero, but the
// canvas still renders the bundle's import graph.
//
// The tree is keyed by stripped paths (see buildBundleTree); the
// `origToStripped` translation table also re-keys `details.
// fileHashes` so finding match keys line up with the graph's
// node ids (otherwise the graph would never light up findings —
// findings would be looked up under original paths but nodes live
// under stripped ones).
//
// `graph2.showAll === true` (the bundle default): every bundle
// file is a node. `false`: filter to issue-bearing files plus
// every file in their dep tree (so reachable deps stay visible
// while clean unrelated files drop out).
export function buildBundleGraphData(details) {
  const { tree, origToStripped } = buildBundleTree(details)
  const allFiles = Object.keys(tree)
  if (allFiles.length === 0) return null
  let strippedHashes = null
  if (details.fileHashes && details.fileHashes.size > 0) {
    strippedHashes = new Map()
    for (const [orig, hash] of details.fileHashes) {
      const stripped = origToStripped.get(orig)
      if (stripped !== undefined) strippedHashes.set(stripped, hash)
    }
  }
  const findingsByFile = bundleFindingsByFile(strippedHashes)
  const ownCounts = new Map()
  const severitySets = new Map()
  const colorSets = new Map()
  const fileFindings = new Map()
  for (const [file, findings] of findingsByFile) {
    const counts = { critical: 0, high: 0, medium: 0, low: 0, high_bug: 0, bug: 0, informational: 0 }
    const sevs = new Set()
    const cols = new Set()
    const ff = []
    for (const f of findings) {
      counts[f.severity] = (counts[f.severity] || 0) + 1
      sevs.add(f.severity)
      const color = state.markers.get(tabKey(f)) ?? 'none'
      cols.add(color)
      ff.push({ severity: f.severity, color })
    }
    ownCounts.set(file, counts)
    severitySets.set(file, sevs)
    colorSets.set(file, cols)
    fileFindings.set(file, ff)
  }
  const transitiveCounts = computeTransitiveCounts(tree, ownCounts)
  const files = graph2.showAll
    ? allFiles
    : [...bundleReachableFromIssueFiles(tree, ownCounts)]
  // Pass `bundlePkgOf` so node packaging recognizes both
  // `node_modules/` and `dependencies/` regardless of what the
  // global depsDir picked from state.reports — the report-driven
  // depsDir would otherwise miss bundle paths under whichever
  // dir the loaded reports don't use.
  const graph = buildGraph(tree, files, ownCounts, transitiveCounts, severitySets, colorSets, fileFindings, {
    pkgOf: bundlePkgOf,
  })
  // Stash the stripped→original mapping on each node so the
  // selection card's "View source →" button can hand the unstripped
  // path to the source viewer (which reads from bundleSourcesAsMap,
  // which keys by the original path). Findings-tab graph nodes
  // don't get `origFile` populated, so the button stays bundle-only.
  const strippedToOrig = new Map()
  for (const [orig, stripped] of origToStripped) strippedToOrig.set(stripped, orig)
  for (const n of graph.nodes) n.origFile = strippedToOrig.get(n.file)
  return graph
}

export function refreshBundleGraphSidebar() {
  if (!_currentBundleGraph) return
  const area = document.getElementById('g2-selection-area')
  if (area) litRender(renderSelectionCard(_currentBundleGraph), area)
  const focusSlot = document.getElementById('g2-focus-overlay-slot')
  if (focusSlot) litRender(renderFocusOverlay(_currentBundleGraph), focusSlot)
}

export function refreshBundleGraphTopPkgs() {
  if (!_currentBundleGraph) return
  const block = document.getElementById('g2-top-pkgs-block')
  if (block) litRender(renderTopPkgsBlock(_currentBundleGraph), block)
}

export function setCurrentBundleGraph(graph) {
  _currentBundleGraph = graph
}

// Source-specific header titles. Used when every loaded report shares
// the same `source` marker — those reports lack the analyzer
// (model / effort / exportsMode) metadata that the analyzer-combo
// breakdown builds from, so they get a fixed product name instead.
// DeepSec is Vercel's tool (https://github.com/vercel-labs/deepsec).
const SOURCE_TITLES = {
  'claude-security': 'Claude Security findings',
  'codex-security': 'Codex Security findings',
  'deepsec': 'DeepSec findings',
}


// Build the repo-chip element for the page header. The actual visual
// (three modes — editable+collapsed, editable+expanded, read-only)
// lives in the `<repo-chip>` Lit component (see view/repo-chip.js);
// this function picks which props to set based on the load state:
//
//   * Workspace merge (`state.currentWorkspace`) — only the
//     read-only chip when every finding shares a `repo.github`;
//     the per-report URL is stamped on findings as
//     `_repoFallback` so the global `state.repoUrl` doesn't apply.
//   * Single report with `repoInputUseful` true — editable chip
//     fed by `state.repoUrl` / `state.repoEditing`.
//   * Single report with all per-finding `repo.github` known —
//     read-only chip showing the common slug.
//
// `repoInputUseful` is the existing flag computed in the main render
// path — true when at least one non-module finding lacks per-finding
// repo info, so user-typed `state.repoUrl` is needed to build links.
function repoChipTemplate(repoInputUseful, knownRepo) {
  if (state.currentWorkspace) {
    if (knownRepo) return html`<repo-chip url=${knownRepo}></repo-chip>`
    return nothing
  }
  if (repoInputUseful) {
    return html`<repo-chip url=${state.repoUrl} editable ?editing=${state.repoEditing}></repo-chip>`
  }
  if (knownRepo) return html`<repo-chip url=${knownRepo}></repo-chip>`
  return nothing
}

// Canonical order for analyzer-combo fields. Each finding contributes
// one combo (a tuple of these four values lifted off the run-meta at
// ingest); multiple combos arise when the user merges several
// analyzer outputs into a single view.
const COMBO_FIELDS = ['type', 'model', 'effort', 'exportsMode']

// Format a single combo-field value as a tag-display string. The
// type field carries the `analyzer: ` label and always renders
// (even when null) so the slot is never silently dropped — `analyzer:
// null` reads as "this run had no analyzer subtype" the same way the
// DeepView.0 prototype's `<code>null</code>` did. Non-type fields
// return `null` from this function when the value is missing so the
// caller can drop them entirely; rendering a bare `null` for a
// missing model / effort / exports just clutters the header.
function formatComboField(field, value) {
  if (field === 'type') return `analyzer: ${value ?? 'null'}`
  if (value == null) return null
  return value
}

// Project the loaded findings into a list of meta-row tag strings. The
// fields aren't independent flags — they describe one analyzer run
// each — so a naive `Set` per field would drop the cross-field
// relationship. This routine instead:
//
//   1. Builds the list of unique combos across all findings, over
//      whichever subset of `COMBO_FIELDS` the caller requested.
//   2. Marks each field "common" when every combo agrees on its value
//      and "varying" otherwise.
//   3. Walks the slot order, emitting common fields as single-value
//      tags at their natural slot. The first time a varying slot is
//      hit, every combo is emitted as one tag joined by ` · ` over
//      the varying fields only — preserving the cross-field tuple
//      while hiding the common columns that would just repeat.
//
// `formatComboField` runs at every emission point: the type field
// gets the `analyzer: ` prefix, and missing non-type values are
// dropped. A combo whose entire varying-field projection is empty
// (after null filtering) is skipped entirely so a single all-empty
// combo doesn't render an empty tag.
//
// `fields` defaults to all four slots; pass a narrower list (e.g.
// without `type`) to suppress a slot — used for source-marked
// reports where the per-finding `type` is a category, not an
// analyzer name, and the title already conveys the product.
//
// Examples (combos as `type · model · effort · exportsMode`):
//   `null · opus 4.7 · max · list` + `null · gpt 5.5 · xhigh · list`
//     → `analyzer: null` `opus 4.7 · max` `gpt 5.5 · xhigh` `list`
//   `null · opus 4.7 · xhigh · isolate` + `null · opus 4.7 · max · list`
//     → `analyzer: null` `opus 4.7` `xhigh · isolate` `max · list`
//   `correctness · null · null · null`  →  `analyzer: correctness`
function buildAnalyzerTags(findings, fields = COMBO_FIELDS) {
  const comboMap = new Map()
  for (const f of findings) {
    const combo = {}
    for (const k of fields) {
      combo[k] = k === 'model' ? (prettyModel(f.model) ?? null) : (f[k] ?? null)
    }
    const key = fields.map((k) => combo[k] ?? '').join('|')
    if (!comboMap.has(key)) comboMap.set(key, combo)
  }
  const combos = [...comboMap.values()]
  if (combos.length === 0) return []

  const isCommon = {}
  for (const k of fields) {
    isCommon[k] = new Set(combos.map((c) => c[k])).size === 1
  }
  const varyingSlots = fields.filter((k) => !isCommon[k])

  const tags = []
  let combosEmitted = false
  for (const k of fields) {
    if (isCommon[k]) {
      const t = formatComboField(k, combos[0][k])
      if (t != null) tags.push(t)
    } else if (!combosEmitted) {
      for (const combo of combos) {
        const parts = varyingSlots
          .map((s) => formatComboField(s, combo[s]))
          .filter((p) => p != null)
        if (parts.length > 0) tags.push(parts.join(' · '))
      }
      combosEmitted = true
    }
  }
  return tags
}

// Page header — port of the prototype's `.page-head` block. The h1
// carries the tool name plus a pill-shaped file chip naming the
// active report; the meta-row underneath strings together the count
// followed by the analyzer-combo tags from `buildAnalyzerTags`.
//
// Tool name comes from the source marker when every loaded report
// agrees on one (`Claude Security findings`, `Codex Security
// findings`, `DeepSec findings`); otherwise it's `DeepView findings`,
// matching the prior single-vs-mixed selection rule.
function headerTemplate(totalCount, fileNames, repoInputUseful, knownRepo, treeFileCount) {
  const sources = new Set(state.reports.map((r) => r.source))
  const singleSource = sources.size === 1 ? [...sources][0] : null
  // Workspace mode wins over the source-based title — the user
  // picked a named workspace, so the header should say so.
  // Falls through to the source / generic title when the workspace
  // can't be resolved (deleted between switch and render).
  const ws = state.currentWorkspace
    ? listWorkspaces().find((w) => w.id === state.currentWorkspace)
    : null
  const titleText = ws
    ? `Workspace: ${ws.name}`
    : (singleSource ? SOURCE_TITLES[singleSource] : 'DeepView findings')

  // File chip: single-file reports get the filename verbatim with a
  // brand sticker for the source bucket (Claude / Codex / DeepSec /
  // DeepView eye for analyzer-native). Multi-report loads (workspace
  // merge) collapse to "N reports" with a GENERIC outline file
  // glyph — even when every loaded report shares one source, the
  // brand sticker would mis-imply the chip names a single
  // upstream-shaped item, so the generic icon reads as the
  // collection it actually is.
  const singleStickerKey = singleSource && FILE_ICONS[singleSource] ? singleSource : 'default'
  const singleSticker = unsafeHTML(FILE_ICONS[singleStickerKey])
  const multiSticker = html`<svg class="file-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/></svg>`
  let fileChip = nothing
  if (fileNames.length === 1) {
    fileChip = html`<span class="file-chip">${singleSticker}<span>${fileNames[0]}</span></span>`
  } else if (fileNames.length > 1) {
    fileChip = html`<span class="file-chip">${multiSticker}<span>${fileNames.length} reports</span></span>`
  }

  const findings = state.reports.flatMap((r) => r.groups.flatMap((g) => g))

  // Count covers EVERY loaded finding (live + trashed) — the trashed
  // entries are still part of the report, just hidden from the active
  // list. The trash mode toggle button (in the toolbar) is the user's
  // signal that they're in the deleted view; the header stays steady
  // so the load total doesn't visually shift when the toggle flips.
  const findingNoun = `finding${totalCount === 1 ? '' : 's'}`
  const countLabel = `${totalCount} ${findingNoun}`

  // Source-marked reports (claude-security, codex-security, deepsec)
  // carry per-finding `type` as a category, not an analyzer name, so
  // it's omitted from the header tags here — the title already
  // conveys the product (`Claude Security findings`, etc.). The
  // analyzer-prefix label only makes sense for the DeepView native
  // bucket and any mixed loads. Workspace mode also drops the
  // `analyzer:` tag — a merged view of multiple reports tends to
  // accumulate several combos and the prefix tag inflates the
  // header into a visually crowded strip.
  const dropAnalyzerType = singleSource || state.currentWorkspace
  const tagFields = dropAnalyzerType
    ? COMBO_FIELDS.filter((f) => f !== 'type')
    : COMBO_FIELDS
  const tags = buildAnalyzerTags(findings, tagFields)

  // Severity status bar — stacked bar sized proportionally to each
  // severity's group count (using the primary tab's severity, so
  // each group contributes once and the segments sum to totalCount).
  // Gives a quick "how bad is this report overall" signal without
  // scanning the toolbar chips. Rendered for any non-empty load —
  // single reports, merged loads, AND workspace views all benefit
  // from the same one-glance summary.
  let statusBarTpl = nothing
  if (totalCount > 0) {
    const sevCounts = {}
    for (const r of state.reports) {
      for (const g of r.groups) {
        const sev = primaryTab(g).severity
        if (sev) sevCounts[sev] = (sevCounts[sev] || 0) + 1
      }
    }
    const presentSevs = SEVERITIES.filter((s) => sevCounts[s] > 0)
    if (presentSevs.length > 0) {
      statusBarTpl = html`<span class="status-bar" aria-hidden="true">${presentSevs.map((s) => {
        const tip = `${sevCounts[s]} ${s.replace(/_/gu, ' ')}`
        return html`<span class=${`status-seg sev-${s}`} style=${`flex-grow: ${sevCounts[s]}`} title=${tip}></span>`
      })}</span>`
    }
  }

  const repoTpl = repoChipTemplate(repoInputUseful, knownRepo)
  const sep = html`<span class="sep" aria-hidden="true"></span>`

  // Files toggle — replaces the top-of-page Files (N) tab. Sits
  // right after the repo chip in the title row so it's visually
  // tied to the report identity, and operates on/off like the
  // Trash button: clicking flips state.currentView between 'files'
  // and the previous (saved) view. Same `treeFileCount > 1` gate
  // the old Files tab used; a single-file tree adds no value.
  const filesActive = state.currentView === 'files'
  const filesBtnTpl = (treeFileCount ?? 0) > 1
    ? html`<button
        type="button"
        class=${`files-toggle-btn${filesActive ? ' active' : ''}`}
        data-action="toggle-files"
        title=${filesActive ? 'exit files view' : 'show files'}
        aria-pressed=${String(filesActive)}
      >${`Files: ${treeFileCount}`}</button>`
    : nothing

  return html`<header class="page-head">
    <div class="page-title">
      <h1>${titleText}${fileChip}${repoTpl}${filesBtnTpl}</h1>
      <div class="meta-row">
        <span>${countLabel}</span>
        ${statusBarTpl}
        ${tags.length > 0 ? html`${sep}${tags.map((t) => html`<span class="tag">${t}</span>`)}` : nothing}
      </div>
    </div>
  </header>`
}

// Stats — clickable filter chips. Severity chips on the left, mark-color
// chips on the right. Both are multi-select: empty selection = no
// filter; multiple selections = union across the ticked chips (so
// ticking every chip is equivalent to ticking none). A zero-count
// chip is hidden so the row stays compact.
// Severity-filter chips — ported from the DeepView.0 prototype's
// `.sev-chip` design. Each chip pairs a small color square (the
// severity's hue swatch) with the severity name and a count badge.
// Active chips pick up a 50%-alpha border and a 10%-alpha
// background tint of their own severity color, so the active state
// reads as "this severity is highlighted" without overpowering the
// chip's content. Hidden when count is zero — keeps the row tight
// for Claude / Codex / JSON dumps that don't carry every tier.
//
// Unlike the prototype the chips live inside the toolbar block (see
// `toolbarHtml`) rather than in their own outer row, and the
// "X shown / All / None" actions group is intentionally left off:
// the result count + filter-clearing affordances live elsewhere
// (the search row's `X of Y` and the per-chip toggle), so the
// extra summary just duplicates them.
// Severity / mark-color filter strips — these used to be string-
// concatenated blocks here that interpolated counts + active state.
// Both moved to Lit components (`<severity-chips>`,
// `<triage-filter>`) which take the data as JSON-encoded attributes
// and dispatch `severity-toggle` / `color-toggle` events; events.js
// has the matching handlers. The CSS still lives in toolbar.css
// (the components render to light DOM so those rules apply).
function severityChipsTemplate(counts) {
  return html`<severity-chips
    counts=${JSON.stringify(counts)}
    selected=${JSON.stringify([...state.filterSeverities])}
  ></severity-chips>`
}

function triageFilterTemplate(colorCounts) {
  return html`<triage-filter
    counts=${JSON.stringify(colorCounts)}
    selected=${JSON.stringify([...state.filterColors])}
  ></triage-filter>`
}

// `flags` carries per-render applicability: when no finding in the
// current report has confidence / a node_modules path / file or tree
// hash metadata, the corresponding control is omitted entirely (and
// the underlying filter state is forced to its no-op value upstream
// for confidence / source so it can't be left set from a previous
// report). Hides chrome the user can't act on usefully.
// Triage state selector — replaces the prior single Trash button.
// Renders as 3 buttons (Fixed / Invalid / Deleted) showing each
// bucket's count; the active one toggles back to the live view.
// Hidden entirely when every bucket is empty AND the user isn't
// already in a triage view (nothing to switch to). Each button
// carries data-triage-show=<state> so events.js can flip
// state.shownTriage; the live view (no triage filter) is just the
// "all unset" mode reached by clicking the active button again.
function triageSelectorTemplate(triageCounts) {
  const states = ['fixed', 'invalid', 'deleted', 'ignored']
  const total = states.reduce((n, s) => n + (triageCounts[s] ?? 0), 0)
  if (total === 0 && !state.shownTriage) return nothing
  return html`<div class="triage-selector" role="group" aria-label="Triage view">
    ${states.map((s) => {
      const n = triageCounts[s] ?? 0
      const active = state.shownTriage === s
      // Show bucket buttons only when the bucket has entries OR is
      // the currently-active view (so the user can toggle back).
      if (n === 0 && !active) return nothing
      return html`<button
        type="button"
        class=${`triage-state-btn triage-state-${s}${active ? ' active' : ''}`}
        data-triage-show=${s}
        title=${active ? `Exit ${s} view` : `Show ${s} (${n})`}
        aria-pressed=${String(active)}
      >${s.charAt(0).toUpperCase() + s.slice(1)} (${n})</button>`
    })}
  </div>`
}

function toolbarTemplate(filteredCount, allCount, triageCounts, counts, colorCounts, flags) {
  const { showSource, showConfidence, showPriority, showGraphMode } = flags
  // The findings tab gains a 4th "graph" view-mode option when a
  // tree-bearing report is loaded (showGraphMode). Switching to it
  // replaces the table / list / grouped body with the graph2 canvas
  // — see the findings-graph slot in render() below.
  const viewModes = showGraphMode ? 'table,list,grouped,graph' : 'table,list,grouped'
  const sortOpt = (value, label) => html`<option value=${value} ?selected=${state.sortBy === value}>${label}</option>`
  const srcChip = (value, label) => html`<button
    type="button"
    class=${`source-chip${state.filterSources.has(value) ? ' active' : ''}`}
    data-source-toggle=${value}
    aria-pressed=${String(state.filterSources.has(value))}
  >${label}</button>`

  return html`<div class="toolbar">
    <div class="toolbar-row">
      <!-- View mode leads the row — <view-mode-buttons> renders the
           table / list / grouped icon group; immediately followed by
           the Sort dropdown with no separator between them. -->
      <view-mode-buttons mode=${state.viewMode} modes=${viewModes}></view-mode-buttons>
      <!-- Sort dropdown — bare select (no Sort: label preceding it).
           The selected option's text already advertises what it sorts
           by, plus a ↓ / ↑ arrow showing direction. Class
           sort-select lets toolbar.css give the button a touch more
           padding than the generic toolbar select. -->
      <select id="sort-select" class="sort-select" aria-label="Sort findings">
        ${sortOpt('severity', 'Severity ↓')}
        ${sortOpt('file', 'File ↑')}
        ${showConfidence ? html`${sortOpt('confidence-desc', 'Confidence ↓')}${sortOpt('confidence-asc', 'Confidence ↑')}` : nothing}
        ${showPriority ? html`${sortOpt('priority-desc', 'Priority ↓')}${sortOpt('priority-asc', 'Priority ↑')}` : nothing}
      </select>
      ${showSource ? html`<div class="sep"></div>
        <div class="source-toggle" role="group" aria-label="Source filter">
          ${srcChip('own', 'Sources')}
          ${srcChip('modules', 'Dependencies')}
        </div>` : nothing}
      ${showConfidence ? html`<div class="sep"></div>
        <span class="conf-range-label">Confidence</span>
        <!-- Dual-thumb slider replaces the prior min / max select
             pair. Lower bound at 0 means "include findings without a
             confidence rating"; upper bound at 10 means "no upper cap
             (allow >10 outliers)" — both edges are how the user opts
             out of that half of the filter (see filters.js /
             matchesFilters). The conf-range-vals span mirrors the
             live value during drag (events.js patches its textContent
             on range-input); on release a range-change event triggers
             a full re-render and the span gets re-baked here. -->
        <range-slider
          id="conf-range" min="0" max="10" step="1"
          low=${state.filterConfMin}
          high=${state.filterConfMax}
          aria-label="Confidence range"></range-slider>
        <span id="conf-range-vals" class="conf-vals">${state.filterConfMin}–${state.filterConfMax}</span>` : nothing}
      ${triageSelectorTemplate(triageCounts)}
    </div>
    <!-- Filter row: severity chips + mark-color triage pill + search
         field, all inline so they read as one composable filter strip.
         The "X shown / All / None" actions block from the prototype's
         outer .sev-row is intentionally left off — the result count
         at the row's right edge and the per-chip toggle cover those
         needs. -->
    <div class="toolbar-row sev-row">
      ${severityChipsTemplate(counts)}
      ${triageFilterTemplate(colorCounts)}
      <!-- Search field + result count grouped into a single flex item
           so they wrap as a unit — when the row is too narrow to keep
           the strip inline, the search and the X of Y count move to a
           new line together rather than the count clinging to the
           right of the chips while the search drops below alone. See
           the .search-row rule in toolbar.css + the wrapping
           breakpoints under @media (max-width: 1200px) and
           .findings-content.with-details. -->
      <div class="search-row">
        <div class="toolbar-search">
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
            <circle cx="11" cy="11" r="7"/>
            <path d="m20 20-3.5-3.5"/>
          </svg>
          <input
            type="text"
            id="filter-search"
            .value=${state.filterInclude}
            placeholder="Search findings…">
        </div>
        <span class="result-count">${filteredCount} of ${allCount}</span>
      </div>
    </div>
  </div>`
}

// Render the body of the findings tab — table view (compact 2-row
// blocks, never grouped by file) or list view (per-finding cards,
// optionally grouped by file). `applySorting` already ordered
// `filtered` by sortBy.
// Set by findingsBodyHtml's table branch and consumed by render()
// after report.innerHTML lands; passes the sorted dedup-group list
// to the <finding-table> custom element via property assignment so
// item identity survives the trip.
let pendingTableItems = null

// Persistent <finding-table> instance, kept across render() calls so
// the row list (and its StateElement reactivity) survives the
// innerHTML reset. We detach this element BEFORE replacing
// report.innerHTML — the bare `.remove()` is enough to keep it alive
// in JS — and reinsert it into the new HTML's `.finding-table-slot`
// placeholder afterwards. Stays null until the first time the table
// view renders with non-empty items.
let persistentFindingTable = null

// gid → {group, inGroup} for each <finding-card> placeholder emitted
// during HTML build. After innerHTML lands, render() walks every
// `<finding-card>` and assigns `.group` (and reads in-group from the
// attribute set in HTML). Cleared at the top of each render.
const pendingFindingCards = new Map()

function findingCardPlaceholder(g, inGroup = false) {
  const gid = findingCardGid(g)
  pendingFindingCards.set(gid, { group: g, inGroup })
  return inGroup
    ? html`<finding-card data-gid=${gid} in-group></finding-card>`
    : html`<finding-card data-gid=${gid}></finding-card>`
}

function findingsBodyTemplate(filtered) {
  if (state.viewMode === 'table') {
    // Table view is always flat. For 'file' sort we still want
    // line-within-file ordering to match the file-grouped layout's
    // intra-file order; applySorting only handles file→line for
    // severity / confidence sorts. Rows are owned by the
    // <finding-table> Lit component (see view/finding-table.js); we
    // stash the sorted list in pendingTableItems so render() can
    // assign it as a property after innerHTML lands.
    const items = state.sortBy === 'file'
      ? [...filtered].sort((a, b) => {
        const pa = primaryTab(a), pb = primaryTab(b)
        return pa.file.localeCompare(pb.file) || parseInt(pa.line, 10) - parseInt(pb.line, 10)
      })
      : filtered
    if (items.length === 0) return nothing
    // Re-validate against the current filtered set so a stale gid
    // (filter or sort changed, showDeleted flipped) doesn't open the
    // details panel against a row no longer rendered.
    const selectedGroup = state.tableSelectedGid
      ? items.find((g) => groupKey(g) === state.tableSelectedGid)
      : null
    pendingTableItems = items
    // Two-column layout when a row is selected: list on the left
    // (3 fr, capped at 1200px), details panel on the right (2 fr,
    // capped at 800px). Collapses to single-column when no row is
    // selected.
    const layoutClass = selectedGroup ? 'findings-table-layout open' : 'findings-table-layout'
    return html`<div class=${layoutClass}>
      <!-- Placeholder div — render() reattaches the persistent
           <finding-table> here after innerHTML lands. Keeping the
           table element across renders preserves its <finding-row>
           children (and StateElement-driven reactivity inside them),
           avoiding a full shadow-DOM rebuild on every state change. -->
      <div class="findings-table-list"><div class="finding-table-slot"></div></div>
      ${selectedGroup ? html`<aside class="findings-table-details" id="findings-table-details">
        <header class="findings-table-details-bar">
          <span class="findings-table-details-label">Details</span>
          <button type="button" class="findings-table-details-close" data-table-deselect title="Close details" aria-label="Close details">×</button>
        </header>
        <div class="findings-table-details-body">${findingCardPlaceholder(selectedGroup)}</div>
      </aside>` : nothing}
    </div>`
  }
  if (state.viewMode === 'grouped') {
    // Group groups by file. All tabs in a dedup group share the same
    // file (dedup runs per-file by fileHash upstream), so the primary
    // tab's file is a safe representative.
    const byFile = new Map()
    for (const g of filtered) {
      const file = primaryTab(g).file
      if (!byFile.has(file)) byFile.set(file, [])
      byFile.get(file).push(g)
    }
    // For file sort, sort files alphabetically; otherwise preserve
    // first-appearance order.
    const fileKeys = state.sortBy === 'file' ? [...byFile.keys()].sort() : [...byFile.keys()]
    return html`${fileKeys.map((file) => {
      const items = state.sortBy === 'file'
        ? byFile.get(file).sort((a, b) => parseInt(primaryTab(a).line, 10) - parseInt(primaryTab(b).line, 10))
        : byFile.get(file)
      // All findings under one file share the same `repo.github` (it's
      // a property of the source file's package), so probe the first
      // group's primary tab — every other tab in this file would carry
      // the same value or none at all. The per-report `_repoFallback`
      // is also a per-file property (every finding from one report
      // carries the same value), so the same probe gets its fallback.
      const probe = primaryTab(items[0])
      return html`<div class="file-group">
        <div class="file-header">
          <span>${fileLink(file, probe?.repo?.github, probe?._repoFallback)}</span>
          <span class="count">${items.length}</span>
        </div>
        <div class="file-body">${items.map((g) => findingCardPlaceholder(g))}</div>
      </div>`
    })}`
  }
  // Flat mode: each dedup group renders inside its own card
  // (.flat-group) with a small location header on top
  // (file · line · exportName). For the 'file' sort we extend that
  // ordering with line-within-file, which the file-grouped path
  // achieves by sorting per-file.
  const items = state.sortBy === 'file'
    ? [...filtered].sort((a, b) => {
      const pa = primaryTab(a), pb = primaryTab(b)
      return pa.file.localeCompare(pb.file) || parseInt(pa.line, 10) - parseInt(pb.line, 10)
    })
    : filtered
  // Each group's location header carries the FULL line row (file +
  // line + exportName + run-meta) for the active tab. The in-body
  // line-row inside the .finding card is hidden (CSS rule under
  // `.flat-group .finding .line-row`) so the same info doesn't
  // appear twice. Tab switches re-render, so the header tracks the
  // active tab automatically.
  return html`${items.map((g) => {
    const p = activeTabFor(g)
    const lineLinkTpl = lineLink(p.file, p.line, p.repo?.github, p._repoFallback)
    const meta = [p.type, prettyModel(p.model), p.effort, p.exportsMode].filter(Boolean).join(' · ')
    return html`<div class="flat-group">
      <div class="flat-group-loc">
        <span class="file">${fileLink(p.file, p.repo?.github, p._repoFallback)}</span>
        ${lineLinkTpl === nothing ? nothing : html`<span class="line-num">${lineLinkTpl}</span>`}
        ${p.exportName ? html`<span class="meta">${p.exportName}</span>` : nothing}
        ${meta ? html`<span class="run-meta">${meta}</span>` : nothing}
      </div>
      ${findingCardPlaceholder(g, true)}
    </div>`
  })}`
}

// Bundle-side packageOf — recognizes BOTH `node_modules/` and
// `dependencies/` simultaneously. Unlike the report-driven
// `packageOf` in graph/utils.js (which picks ONE active deps dir
// per render based on the loaded report), bundle paths might use
// either or both depending on the build that produced them.
//
// Designed to be called on STRIPPED paths (after
// stripCommonPathPrefix has trimmed the shared directory prefix)
// — that way packages reflect what's actually different between
// files. A path like `dist/src/foo/a.js` would otherwise bucket
// under `dist`, hiding the meaningful `foo`. After stripping
// `dist/`, the same path becomes `src/foo/a.js` → bucket `src`.
//
// Paths with no remaining directory bucket under the synthetic
// `__own__` so the chart still has somewhere to put them.
function bundlePkgOf(path) {
  // Bundle paths land under either `node_modules/<pkg>/...` or
  // `dependencies/<pkg>/...`. pnpm wraps each install in
  // `node_modules/.pnpm/<name>@<version>/node_modules/<name>/...` —
  // matching the first occurrence would bucket every dep under
  // `.pnpm`, so when we hit that synthetic dir we walk past it to
  // the inner `node_modules/<pkg>` segment that names the actual
  // package. Fallback (no `node_modules` / `dependencies` anywhere)
  // takes the first path segment so own-source paths like
  // `src/foo/a.js` still bucket under `src`.
  const re = /(?:^|\/)(?:node_modules|dependencies)\/(@[^/]+\/[^/]+|[^/]+)/gu
  let m
  while ((m = re.exec(path)) !== null) {
    if (m[1] !== '.pnpm') return m[1]
  }
  const slash = path.indexOf('/')
  if (slash > 0) return path.slice(0, slash)
  return '__own__'
}

// Per-package size visualization for the bundles details panel.
// Builds a horizontal stacked bar (segments proportional to each
// package's total source-byte size) plus a sorted breakdown row
// per package. Mirrors the graph2 distribution chrome on the right
// panel — same `pkgColor` palette so the colors carry meaning
// across both views (a `@noble/hashes` package shows the same hue
// in the bundle-size chart and the canvas).
function renderBundleSizeDistribution(items) {
  // items: Array<{path, size}>; size may be 0 / null when the
  // bundle didn't carry per-source content (rare for sourcemaps).
  const totalByPkg = new Map()
  let total = 0
  for (const { path, size } of items) {
    if (typeof size !== 'number' || size <= 0) continue
    const pkg = bundlePkgOf(path)
    totalByPkg.set(pkg, (totalByPkg.get(pkg) ?? 0) + size)
    total += size
  }
  if (total === 0) return nothing
  const sorted = [...totalByPkg.entries()].sort((a, b) => b[1] - a[1])
  return html`<div class="bundles-dist">
    <div class="bundles-dist-bar" aria-hidden="true">
      ${sorted.map(([pkg, size]) => html`<span
        class="bundles-dist-seg"
        style=${`flex-grow: ${size}; background: ${pkgColor(pkg)}`}
        title=${`${pkg}: ${formatBytes(size)}`}
      ></span>`)}
    </div>
    <ul class="bundles-dist-list">
      ${sorted.map(([pkg, size]) => {
        const pct = (size / total * 100).toFixed(1)
        const label = pkg === '__own__' ? 'own source' : pkg
        return html`<li>
          <span class="bundles-dist-dot" style=${`background: ${pkgColor(pkg)}`}></span>
          <span class="bundles-dist-pkg" title=${pkg}>${label}</span>
          <span class="bundles-dist-bar-row" aria-hidden="true">
            <span class="bundles-dist-bar-fill" style=${`width: ${pct}%; background: ${pkgColor(pkg)}`}></span>
          </span>
          <span class="bundles-dist-size">${formatBytes(size)}</span>
          <span class="bundles-dist-percent">${pct}%</span>
        </li>`
      })}
    </ul>
  </div>`
}

// Sources panel for the bundles details view — shared between the
// sourcemap and stasis branches of `renderBundleDetails`. Wraps
// the metadata block + per-package size visualization + flat file
// list, splitting the viz and the list across Packages / Files
// tabs when the bundle has more than 5 packages (a flat layout is
// readable up to that count; beyond it the two views compete for
// vertical space).
//
// `sources` and `sizes` are parallel arrays — same indices, same
// length. Sizes may be null when content wasn't shipped in the
// bundle (uncommon for sourcemaps).
function renderBundleSourcesPanel(meta, extras, sources, sizes) {
  const { prefix, stripped } = stripCommonPathPrefix(sources)
  // Compute packages from the STRIPPED paths so the visualization
  // reflects what differs between files (a shared `dist/src/...`
  // prefix would otherwise bucket everything under `dist`). Paths
  // without a remaining directory map to `__own__`.
  const packages = new Set()
  for (const p of stripped) packages.add(bundlePkgOf(p))
  // Stable alphabetical order — size signal is in the dist viz.
  const order = stripped
    .map((_, i) => i)
    .sort((a, b) => stripped[a].localeCompare(stripped[b]))

  const distItems = stripped.map((p, i) => ({ path: p, size: sizes[i] }))
  const distTpl = renderBundleSizeDistribution(distItems)

  // Issue summary — total findings across the bundle's matched
  // files, broken down by severity (same chip palette the Files
  // tab in the report's tree view uses). Empty when no findings
  // match yet (hashes still computing, no relevant reports
  // indexed). Drives whether the "Issues →" trailing button gets
  // rendered too.
  // Reports — distinct OPFS reports any matched finding came from
  // (preserves walk order via reportsForFinding's Set iteration).
  // Drives the conditional Reports tab below.
  const issueSummary = { critical: 0, high: 0, medium: 0, low: 0, high_bug: 0, bug: 0, informational: 0 }
  let issueTotal = 0
  // Per-report match count — how many of the bundle's matched
  // findings came from each indexed OPFS report. Used by the
  // Reports tab to caption each chip with its contribution. A
  // single finding can show up under multiple reports (the same
  // entry indexed from both a workspace export and the original
  // dump), so each finding counts toward every report it appears
  // in.
  const reportCounts = new Map()
  if (state.bundleDetails?.fileHashes) {
    const matches = bundleFindingsByFile(state.bundleDetails.fileHashes, 'issues')
    for (const findings of matches.values()) {
      for (const f of findings) {
        if (issueSummary[f.severity] !== undefined) issueSummary[f.severity]++
        issueTotal++
        for (const name of reportsForFinding(f.fileHash, f)) {
          reportCounts.set(name, (reportCounts.get(name) ?? 0) + 1)
        }
      }
    }
  }
  const reports = [...reportCounts.keys()].sort()

  // The Graph and Issues tabs open a full-width slide (see
  // renderBundleSlide below) — they don't live in the details
  // panel. Inside the panel we always show the Packages / Files
  // pair so users can flip between the per-package size view and
  // the flat file list regardless of how many packages the bundle
  // has. Reports joins them when at least one OPFS report has
  // findings matching the bundle. Default to Packages; treat
  // anything else as 'packages' so older state slots don't leave
  // the panel blank.
  let activeTab = 'packages'
  if (state.bundleDetailsTab === 'files') activeTab = 'files'
  else if (state.bundleDetailsTab === 'reports' && reports.length > 0) activeTab = 'reports'
  const issueChips = SEVERITIES
    .filter((s) => issueSummary[s] > 0)
    .map((s) => html`<span class=${`tree-count-chip ${s}`}>${issueSummary[s]} ${s.replace(/_/gu, ' ')}</span>`)
  // Each row is a button so the whole strip is a click target +
  // keyboard-focusable; data-bundle-view-source carries the full
  // (un-stripped) path for the source viewer modal. Rows render
  // as buttons regardless of whether the bundle carries content
  // (the click handler checks bundleSourcesAsMap and shows an
  // empty placeholder when content is missing).
  const filesTpl = sources.length > 0 ? html`<ul class="bundles-sources-list">
    ${order.map((i) => {
      const src = sources[i]
      const bareSrc = stripped[i]
      const size = sizes[i]
      return html`<li>
        <button type="button" class="bundles-source-row" data-bundle-view-source=${src} title=${src}>
          <span class="bundles-source-path">${bareSrc}</span>
          ${size == null ? nothing : html`<span class="bundles-source-size">${formatBytes(size)}</span>`}
        </button>
      </li>`
    })}
  </ul>` : nothing
  // Reports list — same brand-sticker chip the Issues tab uses on
  // each row, sized up so it reads as a list rather than a row
  // affordance. data-bundle-issue-report wires into the existing
  // events.js delegate that calls switchToFile.
  const reportsTpl = reports.length > 0 ? html`<ul class="bundles-reports-list">
    ${reports.map((name) => {
      const iconHtml = FILE_ICONS[groupOf(name)] ?? FILE_ICONS.default
      const count = reportCounts.get(name) ?? 0
      return html`<li>
        <button type="button" class="report-chip bundles-report-chip" title=${name} data-bundle-issue-report=${name}>
          ${unsafeHTML(iconHtml)}<span class="report-chip-label">${displayName(name)}</span>
          <span class="bundles-report-count">${count} ${count === 1 ? 'issue' : 'issues'}</span>
        </button>
      </li>`
    })}
  </ul>` : nothing

  return html`${meta}
    <dl class="bundles-detail-meta">
      ${extras}
      <dt>Sources</dt><dd>${sources.length}</dd>
      ${prefix ? html`<dt>Prefix</dt><dd class="mono">${prefix}</dd>` : nothing}
    </dl>
    ${issueTotal > 0 ? html`<div class="bundles-issue-summary tree-count-chips">${issueChips}</div>` : nothing}
    <div class="bundles-tabs" role="tablist">
      <button
        type="button"
        class=${`bundles-tab${activeTab === 'packages' ? ' active' : ''}`}
        data-bundle-tab="packages"
        aria-selected=${String(activeTab === 'packages')}
        role="tab"
      >Packages (${packages.size})</button>
      <button
        type="button"
        class=${`bundles-tab${activeTab === 'files' ? ' active' : ''}`}
        data-bundle-tab="files"
        aria-selected=${String(activeTab === 'files')}
        role="tab"
      >Files (${sources.length})</button>
      ${reports.length > 0 ? html`<button
        type="button"
        class=${`bundles-tab${activeTab === 'reports' ? ' active' : ''}`}
        data-bundle-tab="reports"
        aria-selected=${String(activeTab === 'reports')}
        role="tab"
      >Reports (${reports.length})</button>` : nothing}
      <span class="bundles-tabs-spacer"></span>
      <button
        type="button"
        class="bundles-tab bundles-tab-action"
        data-bundle-tab="graph"
        title="Open the bundle's import graph"
      >Graph →</button>
      ${issueTotal > 0 ? html`<button
        type="button"
        class="bundles-tab bundles-tab-action"
        data-bundle-tab="issues"
        title="Open the bundle's matched issues"
      >Issues →</button>` : nothing}
      <button
        type="button"
        class="bundles-tab bundles-tab-action"
        data-bundle-tab="code"
        title="Browse bundle source"
      >Code →</button>
    </div>
    ${activeTab === 'files' ? filesTpl
      : activeTab === 'reports' ? reportsTpl
      : distTpl}`
}

// Full-width "slide" view for the Graph and Issues tabs. The
// bundles list and the regular details panel both step aside; a
// header bar across the top carries the back button + bundle name
// + integrity, plus a Graph / Issues sub-tab switcher. Body
// renders the active sub-tab's content edge to edge.
// Source viewer overlay — opens on top of any bundles view (regular
// or slide) when state.bundleSourceFile is set. Reads the open
// bundle's source map / stasis content via bundleSourcesAsMap;
// missing entries (sourcemap with no `sourcesContent`, stasis
// without that file) render as a placeholder line. Body is a plain
// `<pre><code>` with a CSS-counter-driven gutter so we don't have
// to slice the source per line — Lit interpolation auto-escapes
// the content, no XSS risk. Click-outside / × button / Escape all
// dismiss; the close handler clears state.bundleSourceFile.
// Cache: integrity\0path → highlighted HTML string (or null when
// prism doesn't support the language / failed). Persists for the
// session so re-opens of the same file are instant.
const _bundleHighlightCache = new Map()
const _bundleHighlightPending = new Set()

// Pick the worst severity (top of SEVERITIES order) among the
// findings on a given line so the gutter dot reads as the most
// urgent issue. Multiple findings on one line still resolve to a
// single dot — clicking it opens the panel which lists all of
// them.
function _topSeverityOf(findings) {
  for (const sev of SEVERITIES) {
    for (const f of findings) {
      if (f.severity === sev) return sev
    }
  }
  return findings[0]?.severity ?? null
}

// Per-line rendering for the source viewer. Renders a sticky
// gutter (one row per line) next to a single `<pre>` holding the
// full source. Two columns rather than per-line interleaving so
// prism's highlighted output (where tokens may span newlines)
// stays valid HTML — the pre takes the highlighted string as-is
// via unsafeHTML, the gutter walks lines by index. line-height
// matches across both columns so the rows align with their lines.
//
// `lineFindings` (Map<line, Finding[]>) drives the per-line dot in
// the gutter. Lines without findings render a plain number.
function renderBundleSourceLines(content, path, integrity, lineFindings) {
  const lineCount = content.split('\n').length
  const digits = String(lineCount).length
  const lang = langForPath(path)
  const cacheKey = `${integrity ?? ''}\0${path}`
  // Trigger prism asynchronously on first sight of this file.
  // The cache value is undefined initially; once the highlight
  // resolves we set it (string for success, null for "no highlight
  // available") and re-render so the unsafeHTML branch picks it up.
  if (lang && !_bundleHighlightCache.has(cacheKey) && !_bundleHighlightPending.has(cacheKey)) {
    _bundleHighlightPending.add(cacheKey)
    // Fire-and-forget: the highlight runs in the background and
    // the next render() call (kicked from inside) injects the
    // result via unsafeHTML. Async IIFE rather than `.then` so
    // the empty `.then` body doesn't trip promise/always-return.
    ;(async () => {
      const highlightedHtml = await prismHighlight(content, lang)
      _bundleHighlightCache.set(cacheKey, highlightedHtml ?? null)
      _bundleHighlightPending.delete(cacheKey)
      // Cheap re-render — the rest of the bundles view rebuilds
      // from the same render() call but Lit only patches what
      // changed, so the cost is the highlighted string getting
      // injected via unsafeHTML on the next pass.
      if (state.bundleSourceFile === path) render()
    })()
  }
  const highlighted = _bundleHighlightCache.get(cacheKey)
  return html`<div class="bundle-source-lines" style=${`--lineno-width:${digits}ch`}>
    <aside class="bundle-source-lineno-col" aria-hidden="true">
      ${Array.from({ length: lineCount }, (_, i) => {
        const ln = i + 1
        const entries = lineFindings.get(ln)
        const sev = entries ? _topSeverityOf(entries.map((e) => e.f)) : null
        const isActive = entries && state.bundleSourceFindingIdx != null
          && entries.some((e) => e.idx === state.bundleSourceFindingIdx)
        return html`<div class="bundle-source-lineno-row" data-line=${ln}>
          ${entries
            ? html`<button
                type="button"
                class=${`bundle-source-dot sev-${sev}${isActive ? ' active' : ''}`}
                data-bundle-source-finding=${entries[0].idx}
                title=${`${entries.length} ${entries.length === 1 ? 'issue' : 'issues'} on line ${ln}`}
                aria-label=${`${entries.length} issues on line ${ln}`}
              ></button>`
            : html`<span class="bundle-source-dot-placeholder"></span>`}
          <span class="bundle-source-lineno-num">${ln}</span>
        </div>`
      })}
    </aside>
    <pre class="bundle-source-code"><code class=${lang ? `language-${lang}` : ''}>${typeof highlighted === 'string'
      ? unsafeHTML(highlighted)
      : content}</code></pre>
  </div>`
}

// Side panel inside the source viewer modal — populated when
// state.bundleSourceFindingIdx points at one of the file's
// findings. Shows the severity badge, description, line, and (if
// any) the OPFS report names that contributed the finding so the
// user can hop over from the viewer.
function renderBundleSourceFindingPanel(findings) {
  const idx = state.bundleSourceFindingIdx
  if (idx == null) return nothing
  const f = findings[idx]
  if (!f) return nothing
  const reports = f.fileHash ? reportsForFinding(f.fileHash, f) : []
  // Display-only triage badge in the header. The bundle Issues
  // filter excludes invalid/deleted, and ignored is per-report
  // (the bundle treats ignored findings as live), so the only
  // status that surfaces here is 'fixed' — every other case
  // (live or ignored) renders without a badge. An "Untriaged"
  // label would conflate live + ignored, which is misleading
  // because the user might have ignored the finding in a report
  // even though the bundle still treats it as active.
  const triage = state.triageState.get(tabKey(f))
  const triageLabel = triage === 'fixed' ? 'Fixed' : null
  // Run meta — analyzer / model / effort / exportsMode chained
  // with `·`, same shape the report's tab-body uses (see
  // render-finding.js's `meta`). Sits to the right of the Line
  // row in the panel body so the header stays compact (just
  // severity + triage badge + close); empty when none of the
  // fields are populated.
  const meta = [f.type, prettyModel(f.model), f.effort, f.exportsMode].filter(Boolean).join(' · ')
  const lineLabel = formatFindingLine(f.line)
  return html`<aside class="bundle-source-panel">
    <header class="bundle-source-panel-bar">
      <span class=${`bundle-source-panel-sev sev-${f.severity}`}>${f.severity.replace(/_/gu, ' ')}</span>
      ${triageLabel ? html`<span class=${`bundle-source-panel-triage triage-${triage}`}>${triageLabel}</span>` : nothing}
      <button
        type="button"
        class="bundle-source-panel-close"
        data-action="bundle-source-panel-close"
        title="Close (Esc)"
        aria-label="Close finding details"
      >×</button>
    </header>
    <div class="bundle-source-panel-body">
      ${(lineLabel || meta) ? html`<div class="bundle-source-panel-line-row">
        ${lineLabel ? html`<span class="bundle-source-panel-line">${lineLabel}</span>` : nothing}
        ${meta ? html`<span class="bundle-source-panel-meta" title=${meta}>${meta}</span>` : nothing}
      </div>` : nothing}
      <div class="bundle-source-panel-desc">${f.description ?? ''}</div>
      ${reports.length > 0 ? html`<div class="bundle-source-panel-reports">
        <div class="bundle-source-panel-reports-label">Reported by</div>
        ${reports.map((name) => {
          const iconHtml = FILE_ICONS[groupOf(name)] ?? FILE_ICONS.default
          return html`<button
            type="button"
            class="report-chip bundle-source-panel-report"
            title=${name}
            data-bundle-issue-report=${name}
          >${unsafeHTML(iconHtml)}<span class="report-chip-label">${displayName(name)}</span></button>`
        })}
      </div>` : nothing}
    </div>
  </aside>`
}

function renderBundleSourceModal() {
  const path = state.bundleSourceFile
  if (!path) return nothing
  // In the Code slide the source already renders inline in the
  // slide body; suppress the modal so it doesn't stack over the
  // slide. The slide owns bundleSourceFile while it's active and
  // resets it on slide exit (events.js's slide-back handler).
  if (state.bundleDetailsTab === 'code') return nothing
  const sources = bundleSourcesAsMap(state.bundleDetails)
  const content = sources.get(path)
  // Find this file's matched findings (live or trash, depending on
  // showDeleted) and bucket by line so the gutter can stamp dots.
  // The map is also passed to the side panel: clicking a dot picks
  // the first finding on that line by default.
  const fileFindings = []
  const lineFindings = new Map()
  if (typeof content === 'string' && state.bundleDetails?.fileHashes) {
    const matches = bundleFindingsByFile(state.bundleDetails.fileHashes, 'issues')
    const onThisFile = matches.get(path) ?? []
    for (let i = 0; i < onThisFile.length; i++) {
      const f = onThisFile[i]
      fileFindings.push(f)
      const ln = parseInt(f.line, 10)
      if (Number.isFinite(ln) && ln > 0) {
        if (!lineFindings.has(ln)) lineFindings.set(ln, [])
        lineFindings.get(ln).push({ f, idx: i })
      }
    }
  }
  return html`<div class="bundle-source-overlay">
    <div class=${`bundle-source-modal${state.bundleSourceFindingIdx == null ? '' : ' with-panel'}`}>
      <header class="bundle-source-bar">
        <div class="bundle-source-title" title=${path}>${path}</div>
        <button
          type="button"
          class="bundle-source-close"
          data-action="bundle-source-close"
          title="Close source viewer (Esc)"
          aria-label="Close source viewer"
        >×</button>
      </header>
      <div class="bundle-source-body">
        <div class="bundle-source-code-wrap">
          ${typeof content === 'string'
            ? renderBundleSourceLines(content, path, state.bundleDetails?.integrity, lineFindings)
            : html`<div class="bundle-source-empty">Source content not bundled.</div>`}
        </div>
        ${renderBundleSourceFindingPanel(fileFindings)}
      </div>
    </div>
  </div>`
}

// Build a directory tree from a flat list of paths so the Code
// slide's left rail can render as nested `<details>` elements.
// Each tree node is `{ name, files: Map<basename, fullpath>,
// dirs: Map<dirname, node> }`. Files are placed under their
// immediate parent; dirs are nested by every '/'-separated
// segment of the prefix. Returns the root node; callers walk
// dirs first (sorted), then files (sorted).
function buildBundleSourceTree(paths) {
  const root = { name: '', files: new Map(), dirs: new Map() }
  for (const p of paths) {
    const parts = p.split('/')
    let node = root
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i]
      let child = node.dirs.get(seg)
      if (!child) {
        child = { name: seg, files: new Map(), dirs: new Map() }
        node.dirs.set(seg, child)
      }
      node = child
    }
    node.files.set(parts[parts.length - 1], p)
  }
  return root
}

// Recursive directory + file rendering for the Code slide's tree
// rail. Open the first level by default; deeper levels collapse
// so the user can drill in. Selected file gets a `current` class
// for the highlight strip; the click target is the data-bundle-
// view-source delegate (same one the Files tab uses).
function renderBundleSourceTree(node, currentPath, depth = 0, issueIndex = null) {
  const dirs = [...node.dirs.entries()].sort(([a], [b]) => a.localeCompare(b))
  const files = [...node.files.entries()].sort(([a], [b]) => a.localeCompare(b))
  // Auto-open dirs that contain the currently selected file so
  // the tree spotlights it on slide-open.
  const containsCurrent = (n) => {
    if (!currentPath) return false
    for (const p of n.files.values()) if (p === currentPath) return true
    for (const d of n.dirs.values()) if (containsCurrent(d)) return true
    return false
  }
  return html`<ul class=${`bundle-code-tree${depth === 0 ? ' root' : ''}`}>
    ${dirs.map(([name, child]) => html`<li class="bundle-code-tree-dir">
      <details ?open=${depth === 0 || containsCurrent(child)}>
        <summary>${name}</summary>
        ${renderBundleSourceTree(child, currentPath, depth + 1, issueIndex)}
      </details>
    </li>`)}
    ${files.map(([name, full]) => {
      // Per-file issue chip — tiny pill with the count, colored by
      // the worst severity present on the file. Skipped when the
      // file has no matched findings (keeps clean files quiet).
      const findings = issueIndex?.get(full)
      const sev = findings && findings.length > 0 ? _topSeverityOf(findings) : null
      const count = findings?.length ?? 0
      return html`<li class="bundle-code-tree-file">
        <button
          type="button"
          class=${`bundle-code-tree-link${full === currentPath ? ' current' : ''}`}
          data-bundle-view-source=${full}
          title=${full}
        >
          <span class="bundle-code-tree-name">${name}</span>
          ${count > 0 ? html`<span class=${`bundle-code-tree-count sev-${sev}`} title=${`${count} ${count === 1 ? 'issue' : 'issues'}`}>${count}</span>` : nothing}
        </button>
      </li>`
    })}
  </ul>`
}

// Files-mode result pane — the directory tree, optionally
// filtered to paths matching `query` (case-insensitive
// substring on the original path). Empty query renders the
// full tree. The filtered tree is rebuilt from scratch (rather
// than hiding nodes) so the auto-open `containsCurrent` logic
// in renderBundleSourceTree falls out naturally on hits.
function renderBundleCodeFilesPanel(tree, currentPath, query, issueIndex) {
  if (!query) return renderBundleSourceTree(tree, currentPath, 0, issueIndex)
  const q = query.toLowerCase()
  const matchingPaths = []
  const collect = (n, prefixParts) => {
    for (const [, child] of n.dirs) collect(child, prefixParts)
    for (const [, full] of n.files) {
      if (full.toLowerCase().includes(q)) matchingPaths.push(full)
    }
  }
  collect(tree, [])
  if (matchingPaths.length === 0) {
    return html`<div class="bundle-code-search-empty">No files match.</div>`
  }
  // Build a fresh tree from the matching original paths so the
  // sub-tree only carries the kept files; reuse the same render
  // helper so visuals match the unfiltered case.
  const filtered = buildBundleSourceTree(matchingPaths)
  return renderBundleSourceTree(filtered, currentPath, 0, issueIndex)
}

// Code-mode result pane — flat list of files, each with up to
// `MAX_HITS_PER_FILE` matching lines underneath. Each hit is a
// click target that selects the file; line text is shown
// truncated. Strict substring search; empty query shows a hint.
function renderBundleCodeContentResults(sources, query, currentPath) {
  if (!query) {
    return html`<div class="bundle-code-search-hint">Type to search across every source in this bundle.</div>`
  }
  const q = query.toLowerCase()
  const MAX_HITS_PER_FILE = 20
  const MAX_FILES = 100
  const results = []
  let totalHits = 0
  for (const [path, content] of sources) {
    if (typeof content !== 'string') continue
    const hits = []
    const lines = content.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (line.toLowerCase().includes(q)) {
        hits.push({ ln: i + 1, text: line })
        totalHits++
        if (hits.length >= MAX_HITS_PER_FILE) break
      }
    }
    if (hits.length > 0) results.push({ path, hits })
    if (results.length >= MAX_FILES) break
  }
  if (results.length === 0) {
    return html`<div class="bundle-code-search-empty">No matches.</div>`
  }
  return html`<div class="bundle-code-search-results">
    <div class="bundle-code-search-summary">${totalHits} ${totalHits === 1 ? 'hit' : 'hits'} in ${results.length} ${results.length === 1 ? 'file' : 'files'}</div>
    ${results.map(({ path: p, hits }) => html`<div class=${`bundle-code-search-file${p === currentPath ? ' current' : ''}`}>
      <button
        type="button"
        class="bundle-code-search-file-name"
        data-bundle-view-source=${p}
        title=${p}
      >${p}</button>
      <ul class="bundle-code-search-hits">
        ${hits.map((h) => html`<li class="bundle-code-search-hit">
          <button
            type="button"
            class="bundle-code-search-hit-link"
            data-bundle-view-source=${p}
            title=${`${p}:${h.ln}`}
          >
            <span class="bundle-code-search-hit-ln">${h.ln}</span>
            <span class="bundle-code-search-hit-text mono">${h.text.slice(0, 200)}</span>
          </button>
        </li>`)}
      </ul>
    </div>`)}
  </div>`
}

// Issues-mode result pane — substring match against the bundle's
// matched findings (severity / file / description). Each hit
// renders as severity badge + path + description; clicking
// selects the file (the source viewer's per-line dot can then
// pick up the specific finding).
function renderBundleCodeIssuesResults(details, query, currentPath, prefix = '') {
  if (!details.fileHashes) {
    return html`<div class="bundle-code-search-empty">Computing file hashes…</div>`
  }
  const matches = bundleFindingsByFile(details.fileHashes, 'issues')
  if (matches.size === 0) {
    return html`<div class="bundle-code-search-empty">No issues match this bundle's files.</div>`
  }
  const q = query.toLowerCase()
  const flat = []
  // Track each finding's per-file index — that's what
  // bundleSourceFindingIdx points at when the source viewer's
  // side panel opens. Stamping it on the click target lets the
  // events.js delegate hand the index back to state directly.
  for (const [file, findings] of matches) {
    for (let i = 0; i < findings.length; i++) {
      const f = findings[i]
      const desc = f.description ?? ''
      if (q && !file.toLowerCase().includes(q)
            && !f.severity.includes(q)
            && !desc.toLowerCase().includes(q)) continue
      flat.push({ file, finding: f, fileIdx: i })
    }
  }
  flat.sort((a, b) => {
    const sa = SEVERITY_ORDER[a.finding.severity] ?? 0
    const sb = SEVERITY_ORDER[b.finding.severity] ?? 0
    if (sb !== sa) return sb - sa
    return a.file.localeCompare(b.file)
  })
  if (flat.length === 0) {
    return html`<div class="bundle-code-search-empty">No matches.</div>`
  }
  return html`<div class="bundle-code-search-results">
    <div class="bundle-code-search-summary">${flat.length} ${flat.length === 1 ? 'issue' : 'issues'}</div>
    <ul class="bundle-code-search-issues">
      ${flat.map(({ file, finding, fileIdx }) => {
        const sev = finding.severity
        // Prefix is shown above the rail (bundle-code-rail-prefix);
        // strip it here so the row's path doesn't repeat the
        // shared root. Falls back to the full path when the file
        // doesn't actually start with prefix (defensive — shouldn't
        // happen since prefix is derived from the same set).
        const bare = prefix && file.startsWith(prefix) ? file.slice(prefix.length) : file
        const isCurrent = file === currentPath && state.bundleSourceFindingIdx === fileIdx
        return html`<li class=${`bundle-code-search-issue${isCurrent ? ' current' : ''}`}>
          <button
            type="button"
            class="bundle-code-search-issue-link"
            data-bundle-view-source=${file}
            data-bundle-view-finding-idx=${fileIdx}
            data-bundle-view-line=${finding.line ?? ''}
            title=${file}
          >
            <div class="bundle-code-search-issue-row">
              <span class=${`bundle-code-search-issue-sev sev-${sev}`}>${sev.replace(/_/gu, ' ')}</span>
              <span class="bundle-code-search-issue-path mono">${bare}${finding.line ? `:${finding.line}` : ''}</span>
            </div>
            <div class="bundle-code-search-issue-desc">${finding.description ?? ''}</div>
          </button>
        </li>`
      })}
    </ul>
  </div>`
}

// Code slide — directory-tree rail on the left + the same
// source-viewer body (line-numbered gutter, prism highlight,
// per-line dot + side panel) on the right. Reuses
// renderBundleSourceLines / renderBundleSourceFindingPanel so the
// inspect features (line dots, finding panel, source highlight)
// behave identically to the modal version. Selection lives on
// state.bundleSourceFile; null shows a placeholder asking the
// user to pick a file.
function renderBundleCodeView(details) {
  if (!details || !details.json) return nothing
  const sources = bundleSourcesAsMap(details)
  if (sources.size === 0) {
    return html`<div class="bundle-code-empty">This bundle doesn't carry any source content.</div>`
  }
  const allPaths = [...sources.keys()].sort()
  const { prefix, stripped } = stripCommonPathPrefix(allPaths)
  // Tree built from STRIPPED paths so the visual hierarchy
  // doesn't waste horizontal space on a shared root prefix.
  // Stripped → original mapping lets the click handlers (and
  // sources.get) recover the full key.
  const strippedToOrig = new Map()
  for (let i = 0; i < allPaths.length; i++) strippedToOrig.set(stripped[i], allPaths[i])
  // Build a tree node whose file values are ORIGINAL paths so the
  // tree-link buttons can hand them to data-bundle-view-source
  // directly. We feed buildBundleSourceTree stripped-keyed paths
  // and remap files at the leaves.
  const tree = buildBundleSourceTree(stripped)
  const remap = (n) => {
    const remappedFiles = new Map()
    for (const [name, p] of n.files) remappedFiles.set(name, strippedToOrig.get(p) ?? p)
    n.files = remappedFiles
    for (const d of n.dirs.values()) remap(d)
  }
  remap(tree)
  const path = state.bundleSourceFile
  const content = path ? sources.get(path) : null
  // Per-file findings + line dots — same source-viewer pipeline
  // the modal uses; the panel renders inside the slide rather
  // than as an overlay so the user can read source + finding
  // details side by side.
  const fileFindings = []
  const lineFindings = new Map()
  if (typeof content === 'string' && details.fileHashes) {
    const matches = bundleFindingsByFile(details.fileHashes, 'issues')
    const onThisFile = matches.get(path) ?? []
    for (let i = 0; i < onThisFile.length; i++) {
      const f = onThisFile[i]
      fileFindings.push(f)
      const ln = parseInt(f.line, 10)
      if (Number.isFinite(ln) && ln > 0) {
        if (!lineFindings.has(ln)) lineFindings.set(ln, [])
        lineFindings.get(ln).push({ f, idx: i })
      }
    }
  }
  // Per-file finding index for the tree's right-side count chips
  // and the Issues-mode hidden-when-empty gate. Computed once and
  // reused — the tree walk reads it as Map<originalPath, Finding[]>.
  const issueIndex = details.fileHashes
    ? bundleFindingsByFile(details.fileHashes, 'issues')
    : new Map()
  // Search state — three modes share a single query field. Issues
  // mode is hidden when the bundle has no matched findings; the
  // selector falls back to Files automatically.
  const hasAnyIssues = issueIndex.size > 0
  const searchModes = hasAnyIssues
    ? ['files', 'code', 'issues']
    : ['files', 'code']
  const searchMode = searchModes.includes(state.bundleCodeSearchMode)
    ? state.bundleCodeSearchMode
    : 'files'
  const query = state.bundleCodeSearchQuery
  return html`<div class="bundle-code-view">
    <aside class="bundle-code-rail">
      <div class="bundle-code-rail-head">
        <span class="bundle-code-rail-label">Files</span>
        <span class="bundle-code-rail-count">${allPaths.length}</span>
      </div>
      ${prefix ? html`<div class="bundle-code-rail-prefix mono" title=${prefix}>${prefix}</div>` : nothing}
      <div class="bundle-code-search">
        <div class="bundle-code-search-modes" role="tablist">
          ${searchModes.map((m) => html`<button
            type="button"
            class=${`bundle-code-search-mode${searchMode === m ? ' active' : ''}`}
            data-bundle-search-mode=${m}
            role="tab"
            aria-selected=${String(searchMode === m)}
          >${m === 'files' ? 'Files' : m === 'code' ? 'Code' : 'Issues'}</button>`)}
        </div>
        <input
          type="text"
          class="bundle-code-search-input"
          id="bundle-code-search-input"
          placeholder=${searchMode === 'files' ? 'filter files…' : searchMode === 'code' ? 'search code…' : 'search issues…'}
          .value=${query}
        >
      </div>
      <div class="bundle-code-rail-body">
        ${searchMode === 'files'
          ? renderBundleCodeFilesPanel(tree, path, query, issueIndex)
          : searchMode === 'code'
            ? renderBundleCodeContentResults(sources, query, path)
            : renderBundleCodeIssuesResults(details, query, path, prefix)}
      </div>
    </aside>
    <div class=${`bundle-code-main${state.bundleSourceFindingIdx == null ? '' : ' with-panel'}`}>
      ${path
        ? html`<header class="bundle-code-main-bar">
            <span class="bundle-code-main-path mono" title=${path}>${path}</span>
          </header>
          <div class="bundle-code-main-body">
            <div class="bundle-source-code-wrap">
              ${typeof content === 'string'
                ? renderBundleSourceLines(content, path, details.integrity, lineFindings)
                : html`<div class="bundle-source-empty">Source content not bundled.</div>`}
            </div>
            ${renderBundleSourceFindingPanel(fileFindings)}
          </div>`
        : html`<div class="bundle-code-placeholder">Pick a file from the tree to view its source.</div>`}
    </div>
  </div>`
}

function renderBundleSlide(entry) {
  const tab = state.bundleDetailsTab
  // Hide the in-slide Graph / Issues switcher when this bundle has
  // zero matched findings — there's nothing to switch to. The
  // Issues entry from the details panel is hidden by the same
  // gate (see renderBundleSourcesPanel), so the slide is only
  // ever reachable via Graph in that case; no switcher needed.
  let hasIssues = false
  if (state.bundleDetails?.fileHashes) {
    const matches = bundleFindingsByFile(state.bundleDetails.fileHashes, 'issues')
    for (const findings of matches.values()) {
      if (findings.length > 0) { hasIssues = true; break }
    }
  }
  return html`<div class="bundles-view bundles-slide-view">
    <header class="bundles-slide-bar">
      <button
        type="button"
        class="bundles-slide-back"
        data-action="bundle-slide-back"
        title="Back to bundles"
        aria-label="Back to bundles"
      >← Back</button>
      <div class="bundles-slide-title">
        <div class="bundles-slide-name">${entry.name}</div>
        <div class="bundles-slide-integrity" title=${entry.integrity}>${entry.integrity}</div>
      </div>
      <div class="bundles-slide-tabs" role="tablist">
        <button
          type="button"
          class=${`bundles-tab${tab === 'graph' ? ' active' : ''}`}
          data-bundle-tab="graph"
          aria-selected=${String(tab === 'graph')}
          role="tab"
        >Graph</button>
        ${hasIssues ? html`<button
          type="button"
          class=${`bundles-tab${tab === 'issues' ? ' active' : ''}`}
          data-bundle-tab="issues"
          aria-selected=${String(tab === 'issues')}
          role="tab"
        >Issues</button>` : nothing}
        <button
          type="button"
          class=${`bundles-tab${tab === 'code' ? ' active' : ''}`}
          data-bundle-tab="code"
          aria-selected=${String(tab === 'code')}
          role="tab"
        >Code</button>
      </div>
    </header>
    <div class="bundles-slide-body">
      ${tab === 'graph'
        ? html`<div id="bundle-graph-slot" class="bundle-graph-slot"></div>`
        : tab === 'code'
          ? renderBundleCodeView(state.bundleDetails)
          : renderBundleIssuesList(state.bundleDetails)}
    </div>
  </div>`
}

// Per-issue list of OPFS reports the finding showed up in. Up to
// two chips render with the brand sticker + display name (mirrors
// the workspace `.report-chip` from render-finding.js); a third+
// report collapses into a trailing ", and more…" hint so the row
// stays readable when a finding is shared across many reports.
// Each chip is clickable — the data attribute hands the report
// name to events.js, which calls switchToFile to navigate.
function bundleIssueReportsTemplate(finding) {
  if (!finding?.fileHash) return nothing
  const reports = reportsForFinding(finding.fileHash, finding)
  if (reports.length === 0) return nothing
  const visible = reports.slice(0, 2)
  const extra = reports.length - visible.length
  return html`<div class="bundle-issue-reports">
    ${visible.map((name) => {
      const iconHtml = FILE_ICONS[groupOf(name)] ?? FILE_ICONS.default
      return html`<button type="button" class="report-chip" title=${name} data-bundle-issue-report=${name}>${unsafeHTML(iconHtml)}<span class="report-chip-label">${displayName(name)}</span></button>`
    })}
    ${extra > 0 ? html`<span class="bundle-issue-reports-more">, and ${extra} more…</span>` : nothing}
  </div>`
}

// Issues tab — flat list of findings matched to the open bundle's
// files via SHA-512 fileHash equality. Sorted by severity (most
// severe first), tie-breaking by file path. Until the async hash
// computation completes (events.js kicks it after parse), shows a
// loading placeholder. No matches → "no issues" line so the user
// knows there isn't a render glitch.
// Human-readable line label for a finding. Accepts either a
// single line ("10" or 10) or a range string ("10-15"); returns
// "Line 10" / "Lines 10-15" / "" when the value isn't usable.
// Skips ranges where end ≤ start (treats them as a single line)
// since those usually come from a malformed source.
function formatFindingLine(line) {
  if (line == null || line === '') return ''
  const s = String(line)
  const dash = s.indexOf('-')
  if (dash > 0) {
    const a = parseInt(s.slice(0, dash), 10)
    const b = parseInt(s.slice(dash + 1), 10)
    if (Number.isFinite(a) && Number.isFinite(b) && b > a) return `Lines ${a}-${b}`
    if (Number.isFinite(a)) return `Line ${a}`
    return ''
  }
  const n = parseInt(s, 10)
  return Number.isFinite(n) ? `Line ${n}` : ''
}

function renderBundleIssuesList(details) {
  if (!details || !details.json) return nothing
  if (!details.fileHashes) {
    return html`<div class="bundle-issues-empty">Computing file hashes…</div>`
  }
  const findingsByFile = bundleFindingsByFile(details.fileHashes, 'issues')
  if (findingsByFile.size === 0) {
    return html`<div class="bundle-issues-empty">No issues match this bundle's files.</div>`
  }
  // Strip the shared root once for the file headers; the leading
  // prefix is shown in the summary line so each file row reads
  // tighter without it.
  const allFiles = [...findingsByFile.keys()]
  const { prefix, stripped } = stripCommonPathPrefix(allFiles)
  const fileToBare = new Map(allFiles.map((f, i) => [f, stripped[i]]))
  // Sort files by worst-severity descending, then by stripped name
  // — surfaces files with critical issues at the top, while
  // alphabetical tie-breaking keeps the list stable.
  const fileEntries = [...findingsByFile.entries()].sort(([fa, ga], [fb, gb]) => {
    const wa = SEVERITY_ORDER[_topSeverityOf(ga)] ?? 0
    const wb = SEVERITY_ORDER[_topSeverityOf(gb)] ?? 0
    if (wb !== wa) return wb - wa
    return (fileToBare.get(fa) ?? fa).localeCompare(fileToBare.get(fb) ?? fb)
  })
  const totalCount = [...findingsByFile.values()].reduce((n, fs) => n + fs.length, 0)
  return html`<div class="bundle-issues">
    <div class="bundle-issues-summary">
      ${totalCount} ${totalCount === 1 ? 'issue' : 'issues'} across
      ${findingsByFile.size} ${findingsByFile.size === 1 ? 'file' : 'files'}
      ${prefix ? html` <span class="mono">${prefix}</span>` : nothing}
    </div>
    <ul class="bundle-issues-list">
      ${fileEntries.map(([file, findings]) => {
        const bare = fileToBare.get(file) ?? file
        // Sort findings within a file by severity desc → line asc
        // so the most urgent surfaces first; line ordering helps
        // when the user scrolls down within the same file.
        const sortedFindings = [...findings].sort((a, b) => {
          const sa = SEVERITY_ORDER[a.severity] ?? 0
          const sb = SEVERITY_ORDER[b.severity] ?? 0
          if (sb !== sa) return sb - sa
          const la = parseInt(a.line, 10) || 0
          const lb = parseInt(b.line, 10) || 0
          return la - lb
        })
        return html`<li class="bundle-issues-file-group">
          <header class="bundle-issues-file-header">
            <button type="button" class="bundle-issues-file-name mono" data-bundle-view-source=${file} title=${file}>${bare}</button>
            <span class="bundle-issues-file-count">${findings.length} ${findings.length === 1 ? 'issue' : 'issues'}</span>
          </header>
          <ul class="bundle-issues-findings">
            ${sortedFindings.map((finding) => {
              // findingIdx is the position in the ORIGINAL per-file
              // findings array (the one bundleFindingsByFile
              // returned); the source viewer's
              // bundleSourceFindingIdx points at that index, so the
              // sorted display order doesn't break the lookup.
              const findingIdx = findings.indexOf(finding)
              const sev = finding.severity
              const triage = state.triageState.get(tabKey(finding))
              const triageLabel = triage === 'fixed' ? 'FIXED' : null
              return html`<li class="bundle-issues-finding">
                <button
                  type="button"
                  class="bundle-issues-finding-link"
                  data-bundle-view-source=${file}
                  data-bundle-view-finding-idx=${findingIdx}
                  data-bundle-view-line=${finding.line ?? ''}
                  title=${file}
                >
                  <div class="bundle-issues-finding-head">
                    <span class=${`bundle-issue-sev sev-${sev}`}>${sev.replace(/_/gu, ' ')}</span>
                    ${(() => { const lbl = formatFindingLine(finding.line); return lbl ? html`<span class="bundle-issues-finding-line">${lbl}</span>` : nothing })()}
                    ${triageLabel ? html`<span class=${`bundle-issues-finding-triage triage-${triage}`}>${triageLabel}</span>` : nothing}
                    <span class="bundle-issues-finding-spacer"></span>
                    ${bundleIssueReportsTemplate(finding)}
                  </div>
                  <div class="bundle-issues-finding-desc">${finding.description ?? ''}</div>
                </button>
              </li>`
            })}
          </ul>
        </li>`
      })}
    </ul>
  </div>`
}

// Bundles view body — flat list of `{integrity, name}` entries.
// Bundle blobs are stored as-is in OPFS keyed by `sha512-${base64}`
// integrity; the catalog row shows the dropped filename first,
// then the integrity in small monospace below so the user can
// distinguish two drops with the same name. Clicking a row opens
// a right-side details panel (parsed for .map sourcemaps; basic
// meta for .stasis bundles); each row also carries a Delete button.
// events.js's data-select-bundle / data-delete-bundle handlers key
// off the integrity (the canonical id in storage.js).
function renderBundlesList(bundles) {
  const selected = state.selectedBundle
  const selectedEntry = selected ? bundles.find((b) => b.integrity === selected) : null
  // Graph and Issues open as a full-width "slide" — the bundles
  // list and details panel both step aside, replaced by a header
  // bar (back button + bundle name) and the active sub-tab's
  // content edge to edge. Anything else (no bundle open, or
  // Packages / Files tab) renders the regular list + details.
  const inSlide = selectedEntry
    && (state.bundleDetailsTab === 'graph' || state.bundleDetailsTab === 'issues' || state.bundleDetailsTab === 'code')
  if (inSlide) return html`${renderBundleSlide(selectedEntry)}${renderBundleSourceModal()}`
  const layoutClass = selectedEntry ? 'bundles-layout open' : 'bundles-layout'
  return html`<div class=${`bundles-view${selectedEntry ? ' with-details' : ''}`}>
    <header class="page-head">
      <div class="page-title">
        <h1>Bundles</h1>
        <div class="meta-row"><span>${bundles.length} ${bundles.length === 1 ? 'bundle' : 'bundles'}</span></div>
      </div>
    </header>
    <div class=${layoutClass}>
      <ul class="bundles-list">
        ${bundles.map(({ integrity, name }) => {
          const isSel = integrity === selected
          return html`<li
            class=${isSel ? 'selected' : ''}
            data-select-bundle=${integrity}
          >
            <div class="bundles-row-text">
              <span class="bundles-name">${name}</span>
              <span class="bundles-integrity" title=${integrity}>${integrity}</span>
            </div>
            <button
              type="button"
              class="bundles-row-action"
              data-bundle-row-code=${integrity}
              title=${`Open ${name} in the code explorer`}
              aria-label=${`Open ${name} in the code explorer`}
            >Code →</button>
            <button
              type="button"
              class="bundles-delete"
              data-delete-bundle=${integrity}
              title=${`Delete ${name}`}
              aria-label=${`Delete ${name}`}
            >Delete</button>
          </li>`
        })}
      </ul>
      ${selectedEntry ? html`<aside class="bundles-details" id="bundles-details">
        <header class="bundles-details-bar">
          <span class="bundles-details-label">Details</span>
          <button type="button" class="bundles-details-close" data-deselect-bundle title="Close details" aria-label="Close details">×</button>
        </header>
        <div class="bundles-details-body">
          ${renderBundleDetails(selectedEntry, state.bundleDetails)}
        </div>
      </aside>` : nothing}
    </div>
    ${renderBundleSourceModal()}
  </div>`
}

// Right-panel content for the open bundle. Until events.js finishes
// the readBundle + parse, `state.bundleDetails` is null (or stale
// for a previous selection); show a Loading… placeholder. For .map
// files we render parsed sourcemap fields (version, output, sources
// list with per-source content sizes). Anything else (stasis
// bundle, unparseable .map) gets the metadata-only fallback.
function renderBundleDetails(entry, details) {
  const meta = html`<dl class="bundles-detail-meta">
    <dt>Name</dt><dd>${entry.name}</dd>
    <dt>Integrity</dt><dd class="mono">${entry.integrity}</dd>
    ${details && details.integrity === entry.integrity
      ? html`<dt>Size</dt><dd>${formatBytes(details.size)}</dd>`
      : nothing}
  </dl>`
  if (!details || details.integrity !== entry.integrity) {
    return html`${meta}<div class="bundles-detail-loading">Loading…</div>`
  }
  if (details.error) {
    return html`${meta}<div class="bundles-detail-error">Failed to parse: ${details.error}</div>`
  }
  if (details.kind === 'sourcemap' && details.json) {
    const json = details.json
    const sources = json.sources ?? []
    const contents = json.sourcesContent ?? []
    const sizes = sources.map((_, i) => typeof contents[i] === 'string'
      ? new TextEncoder().encode(contents[i]).byteLength
      : null)
    const extras = html`
      <dt>Version</dt><dd>${String(json.version ?? '?')}</dd>
      ${json.file ? html`<dt>Output</dt><dd class="mono">${json.file}</dd>` : nothing}
      ${json.sourceRoot ? html`<dt>Source root</dt><dd class="mono">${json.sourceRoot}</dd>` : nothing}
      ${json.names ? html`<dt>Names</dt><dd>${json.names.length}</dd>` : nothing}
    `
    return renderBundleSourcesPanel(meta, extras, sources, sizes)
  }
  if (details.kind === 'stasis' && details.json) {
    const json = details.json
    const sourceMap = json.sources ?? {}
    const sourceNames = Object.keys(sourceMap)
    const importTypes = json.imports ? Object.keys(json.imports) : []
    const sizes = sourceNames.map((s) => typeof sourceMap[s] === 'string'
      ? new TextEncoder().encode(sourceMap[s]).byteLength
      : null)
    const extras = importTypes.length > 0
      ? html`<dt>Resolution kinds</dt><dd>${importTypes.join(', ')}</dd>`
      : nothing
    return renderBundleSourcesPanel(meta, extras, sourceNames, sizes)
  }
  // Stasis without parsed JSON — likely a brotli decompression that
  // failed silently (no error path filled in). Fall back to the
  // metadata block above plus a generic "not parsed" line.
  return html`${meta}<div class="bundles-detail-stasis">Bundle contents not parsed.</div>`
}

// Cross-report packages view. Walks every loaded report's findings,
// buckets them by `packageOf(file)` (same extractor the graph uses
// — recognizes `node_modules/foo` / `node_modules/@scope/foo` /
// `dependencies/foo`, falls back to the top-level dir for own
// source). Each row shows the package's total finding count, a
// per-severity chip strip, and a list of files inside the package
// with their counts. Findings that fall in the same triage bucket
// the findings tab is currently filtered to are counted together
// — flipping the toolbar selector elsewhere would re-render this
// view through state.shownTriage too if that ever wires in;
// today it surfaces every finding regardless of triage so the
// page reads as a complete inventory.
function renderPackagesView() {
  // Pulls from the OPFS-wide finding index (populated by the
  // background scan in bundle-finding-index.js), not state.reports
  // — so the page reflects every report the user has ever
  // dropped, not just the one currently loaded. The first call
  // kicks the scan if it hasn't run yet; the events.js subscriber
  // re-renders progressively as more reports finish indexing.
  //
  // Triage filter: state.shownTriage gates which findings count
  // (null = untriaged, 'fixed' / 'invalid' / 'deleted' = those
  // buckets). Ignore is per-report and intentionally NOT
  // considered here — a finding ignored in some report still
  // counts against its package because the package itself isn't
  // ignored. Same rule the bundle paths follow.
  ensureBundleFindingsIndexed().catch(() => {})
  const buckets = getPackagesIndex()
  // Per-package filtered view + cross-bucket triage counts.
  // `triageCounts` drives the segmented selector visibility +
  // count chips; the filter stays unchanged when shownTriage flips
  // so the user can pivot through the buckets without the page
  // collapsing.
  const triageCounts = { fixed: 0, invalid: 0, deleted: 0 }
  const filtered = []
  for (const [pkg, bucket] of buckets) {
    const findings = []
    const files = new Map()
    for (const f of bucket.findings) {
      const t = state.triageState.get(tabKey(f)) ?? null
      if (t === 'fixed') triageCounts.fixed++
      else if (t === 'invalid') triageCounts.invalid++
      else if (t === 'deleted') triageCounts.deleted++
      if (t !== state.shownTriage) continue
      findings.push(f)
      if (!files.has(f.file)) files.set(f.file, [])
      files.get(f.file).push(f)
    }
    if (findings.length > 0) filtered.push([pkg, { findings, files, reports: bucket.reports }])
  }
  filtered.sort(([a, ba], [b, bb]) => {
    if (bb.findings.length !== ba.findings.length) return bb.findings.length - ba.findings.length
    return a.localeCompare(b)
  })
  const totalFindings = filtered.reduce((n, [, bucket]) => n + bucket.findings.length, 0)
  const totalReports = new Set()
  for (const [, bucket] of filtered) for (const r of bucket.reports) totalReports.add(r)
  // Selection — clear stale picks when the currently-open package
  // dropped out of the filtered set (e.g. the user flipped triage
  // and the row no longer has any findings under the new filter).
  // Mirrors the bundles-view pattern: selectedBundle stays sticky
  // across re-renders unless the entry is gone.
  const selected = state.selectedPackage
  const selectedEntry = selected ? filtered.find(([pkg]) => pkg === selected) ?? null : null
  const layoutClass = selectedEntry ? 'packages-layout open' : 'packages-layout'
  return html`<div class=${`packages-view${selectedEntry ? ' with-details' : ''}`}>
    <header class="page-head">
      <div class="page-title">
        <h1>Packages</h1>
        <div class="meta-row">
          <span>${filtered.length} ${filtered.length === 1 ? 'package' : 'packages'}</span>
          ${totalFindings > 0 ? html`<span>${totalFindings} ${totalFindings === 1 ? 'finding' : 'findings'} across ${totalReports.size} ${totalReports.size === 1 ? 'report' : 'reports'}</span>` : nothing}
        </div>
      </div>
      ${packagesTriageSelectorTemplate(triageCounts)}
    </header>
    ${filtered.length === 0
      ? html`<p style="color:var(--muted)">${buckets.size === 0
          ? 'Indexing reports… this view populates as the OPFS scan finishes.'
          : state.shownTriage
            ? `No ${state.shownTriage} findings in any package.`
            : 'No untriaged findings in any package.'}</p>`
      : html`<div class=${layoutClass}>
          <ul class="packages-list">
            ${filtered.map(([pkg, bucket]) => renderPackageRow(pkg, bucket, pkg === selected))}
          </ul>
          ${selectedEntry ? html`<aside class="packages-details" id="packages-details">
            <header class="packages-details-bar">
              <span class="packages-details-label">Details</span>
              <button type="button" class="packages-details-close" data-deselect-package title="Close details" aria-label="Close details">×</button>
            </header>
            <div class="packages-details-body">
              ${renderPackageDetails(selectedEntry[0], selectedEntry[1])}
            </div>
          </aside>` : nothing}
        </div>`}
  </div>`
}

// Triage selector for the Packages page — same shape the bundle
// graph topbar uses (Fixed / Invalid / Deleted, no Ignored
// because ignore is per-report and treated as untriaged here).
// Hidden when every bucket is empty AND we're in the live view —
// nothing to switch to.
function packagesTriageSelectorTemplate(triageCounts) {
  const states = ['fixed', 'invalid', 'deleted']
  const total = states.reduce((n, s) => n + (triageCounts[s] ?? 0), 0)
  if (total === 0 && !state.shownTriage) return nothing
  return html`<div class="triage-selector packages-triage-selector" role="group" aria-label="Triage view">
    ${states.map((s) => {
      const n = triageCounts[s] ?? 0
      const active = state.shownTriage === s
      if (n === 0 && !active) return nothing
      return html`<button
        type="button"
        class=${`triage-state-btn triage-state-${s}${active ? ' active' : ''}`}
        data-triage-show=${s}
        title=${active ? `Exit ${s} view` : `Show ${s} (${n})`}
        aria-pressed=${String(active)}
      >${s.charAt(0).toUpperCase() + s.slice(1)} (${n})</button>`
    })}
  </div>`
}

// Single package row in the list — compact (one line + chip strip).
// Click-to-select via `data-select-package`; the details panel on
// the right paints the file/report breakdown for the open row.
function renderPackageRow(pkg, bucket, isSel) {
  const sevCounts = { critical: 0, high: 0, medium: 0, low: 0, high_bug: 0, bug: 0, informational: 0 }
  for (const f of bucket.findings) {
    if (sevCounts[f.severity] !== undefined) sevCounts[f.severity]++
  }
  const chips = SEVERITIES.filter((s) => sevCounts[s] > 0)
  const dotColor = pkgColor(pkg)
  return html`<li
    class=${isSel ? 'selected' : ''}
    data-select-package=${pkg}
  >
    <span class="packages-dot" style=${`background:${dotColor}`}></span>
    <div class="packages-row-text">
      <span class="packages-name">${pkg}</span>
      <span class="packages-row-meta">${bucket.findings.length} ${bucket.findings.length === 1 ? 'finding' : 'findings'} · ${bucket.files.size} ${bucket.files.size === 1 ? 'file' : 'files'} · ${bucket.reports.size} ${bucket.reports.size === 1 ? 'report' : 'reports'}</span>
    </div>
    ${chips.length > 0 ? html`<div class="packages-row-chips">
      ${chips.map((s) => html`<span class=${`tree-count-chip ${s}`} title=${s.replace(/_/gu, ' ')}>${sevCounts[s]}</span>`)}
    </div>` : nothing}
  </li>`
}

// Right-panel details for the open package — meta dl + severity
// chip strip + per-file list (full, no slice cap; the panel has
// its own scroll) + the OPFS reports the findings came from.
function renderPackageDetails(pkg, bucket) {
  const sevCounts = { critical: 0, high: 0, medium: 0, low: 0, high_bug: 0, bug: 0, informational: 0 }
  for (const f of bucket.findings) {
    if (sevCounts[f.severity] !== undefined) sevCounts[f.severity]++
  }
  const chips = SEVERITIES.filter((s) => sevCounts[s] > 0)
  const sortedFiles = [...bucket.files.entries()].sort(([fa, a], [fb, b]) => {
    if (b.length !== a.length) return b.length - a.length
    return fa.localeCompare(fb)
  })
  const sortedReports = [...bucket.reports].sort((a, b) => a.localeCompare(b))
  return html`<dl class="packages-detail-meta">
    <dt>Package</dt><dd class="mono">${pkg}</dd>
    <dt>Findings</dt><dd>${bucket.findings.length}</dd>
    <dt>Files</dt><dd>${bucket.files.size}</dd>
    <dt>Reports</dt><dd>${bucket.reports.size}</dd>
  </dl>
  ${chips.length > 0 ? html`<div class="packages-detail-chips">
    ${chips.map((s) => html`<span class=${`tree-count-chip ${s}`}>${sevCounts[s]} ${s.replace(/_/gu, ' ')}</span>`)}
  </div>` : nothing}
  <h3 class="packages-detail-section">Files</h3>
  <ul class="packages-detail-files">
    ${sortedFiles.map(([file, findings]) => {
      const stripped = pkgRelativePath(pkg, file)
      return html`<li class="packages-detail-file">
        <span class="packages-detail-file-path mono" title=${file}>${stripped}</span>
        <span class="packages-detail-file-count">${findings.length}</span>
      </li>`
    })}
  </ul>
  <h3 class="packages-detail-section">Reports</h3>
  <ul class="packages-detail-reports">
    ${sortedReports.map((r) => html`<li class="mono" title=${r}>${displayName(r)}</li>`)}
  </ul>`
}

// Strip the package's `node_modules/<pkg>/` (or `dependencies/<pkg>/`)
// prefix from a file so the row reads as the relative path inside
// the package (e.g. `lib/index.js` rather than
// `node_modules/foo/lib/index.js`). For own-source packages the
// top-level dir + trailing slash gets stripped; for the repo-root
// bucket ('/') the file is shown as-is.
function pkgRelativePath(pkg, file) {
  for (const dep of ['node_modules', 'dependencies']) {
    const anchor = `${dep}/${pkg}/`
    const idx = file.indexOf(anchor)
    if (idx >= 0) return file.slice(idx + anchor.length)
  }
  if (file.startsWith(`${pkg}/`)) return file.slice(pkg.length + 1)
  return file
}

export function render() {
  // Recompute the active deps dir before any helper consults it
  // (isModule / packageOf / stripPackagePrefix / pkgRelative). The
  // detection scans paths in the loaded reports + tree blobs to
  // pick `node_modules` (preferred when present) vs `dependencies`
  // (fallback). Once per render is enough — every helper call below
  // sees the freshly chosen dir.
  configureDepsDir(state.reports)
  // Fixed top-right print icon visibility — only show on the
  // findings view with a report loaded AND a printable view-mode
  // (table / list / grouped). The graph view-mode and the Files
  // view both have non-printable bodies (canvas + per-file tree),
  // so the button hides for those. Toggled via a body class so the
  // button itself doesn't need to re-render.
  document.body.classList.toggle('show-print-btn',
    state.reports.length > 0 &&
    state.currentView === 'findings' &&
    state.viewMode !== 'graph')
  // Bundles view — paints from `state.bundles` (cached by
  // renderSidebar's listBundles call), so it stays paint-only here.
  // Lives before the reports-gate below because the bundles list is
  // independent of any loaded report; the user can browse OPFS
  // bundles even without a finding-bearing JSON open.
  if (state.currentView === 'bundles') {
    if ((state.bundles ?? []).length === 0) {
      // Defensive fallback — the sidebar header that drove the user
      // into this view is suppressed when no bundles exist, but the
      // last bundle could've been deleted between renders. Drop back
      // to findings rather than render an empty list.
      state.currentView = 'findings'
    } else {
      // Reuse the existing #bundles-slot when we're already on the
      // bundles view — `innerHTML = '<div id=...>'` would wipe Lit's
      // part-cache (it's keyed on the container element) and force
      // a full DOM rebuild on every render(), trashing scroll state
      // and triggering a flash of layout. The findings-side render
      // path doesn't touch #bundles-slot, so a stale slot only
      // appears when we just arrived from another view; we replace
      // #report's content only in that case.
      let slot = document.getElementById('bundles-slot')
      if (!slot || !report.contains(slot) || report.firstElementChild !== slot) {
        report.innerHTML = '<div id="bundles-slot"></div>'
        slot = document.getElementById('bundles-slot')
      }
      if (slot) litRender(renderBundlesList(state.bundles), slot)
      // Bundle graph tab — populate the slot left by
      // renderBundleSourcesPanel with the same renderGraph2Layout
      // the findings tab uses, fed bundle-synthesised graph data
      // (no findings yet — wired up in a follow-up). The two
      // refresh helpers fill the right-panel slots; attaching the
      // canvas wires hover / click / pan / zoom onto the new DOM.
      if (
        state.selectedBundle &&
        state.bundleDetailsTab === 'graph' &&
        state.bundleDetails &&
        state.bundleDetails.json
      ) {
        const graphSlot = document.getElementById('bundle-graph-slot')
        if (graphSlot) {
          const graph = buildBundleGraphData(state.bundleDetails)
          if (graph) {
            setCurrentBundleGraph(graph)
            // Hide the "All files" toggle when the bundle has no
            // edges to walk (sourcemaps don't carry import info,
            // so the toggle would have nothing to filter against).
            const hideAllFiles = graph.edges.length === 0
            const triageCounts = countBundleTriageBuckets(state.bundleDetails)
            litRender(renderGraph2Layout(graph, { hideAllFiles, triageCounts }), graphSlot)
            refreshBundleGraphSidebar()
            refreshBundleGraphTopPkgs()
            attachGraph2Interaction(graphSlot, graph, refreshBundleGraphSidebar)
          }
        }
      }
      report.classList.add('active')
      dropZone.classList.add('hidden')
      document.title = 'DeepView results — bundles'
      return
    }
  }
  // Packages view — cross-report aggregation by package, fed by
  // the OPFS-wide finding index (bundle-finding-index.js). Doesn't
  // depend on state.reports — works the moment any report has
  // landed in OPFS, even if it isn't the currently-loaded one.
  if (state.currentView === 'packages') {
    let slot = document.getElementById('packages-slot')
    if (!slot || !report.contains(slot) || report.firstElementChild !== slot) {
      report.innerHTML = '<div id="packages-slot"></div>'
      slot = document.getElementById('packages-slot')
    }
    if (slot) litRender(renderPackagesView(), slot)
    report.classList.add('active')
    dropZone.classList.add('hidden')
    document.title = 'DeepView results — packages'
    return
  }
  if (state.reports.length === 0) return
  // Merge across all loaded reports. Every entry is a Finding[] (a dedup
  // group); single findings were wrapped at ingest, so downstream code
  // doesn't branch on shape. The trash-view split happens here, not in
  // applyFilters, so the "X of Y" counter and severity stats reflect
  // the set currently being viewed (live groups, or the trash).
  const mergedGroups = state.reports.flatMap((r) => r.groups)
  // Per-bucket counts drive the toolbar's triage-state segmented
  // selector. Conflict groups stay in the "live" bucket (their
  // commonTriage is null) regardless of which states their member
  // tabs carry — matching the original behaviour.
  const triageCounts = { fixed: 0, invalid: 0, deleted: 0, ignored: 0 }
  for (const g of mergedGroups) {
    const t = groupState(g).commonTriage
    if (t) triageCounts[t]++
  }
  const allGroups = mergedGroups.filter((g) => groupState(g).commonTriage === state.shownTriage)
  // Preserve first-seen order for the type label so "security, correctness"
  // reads in load order rather than alphabetical.
  const types = [...new Set(state.reports.map((r) => r.type))]
  const typeLabel = types.join(', ')
  const fileNames = state.reports.map((r) => r.fileName)

  // Severity + color stats count GROUPS (not individual tabs). A group is
  // counted under every severity/color that appears in any of its tabs —
  // so sums can exceed the total group count when groups have mixed tabs.
  // This matches the filter semantics (click "high" → all groups where
  // any tab is high; click "red" → all groups with any red-marked tab),
  // and gives a useful preview of filter-click results. Unmarked tabs
  // bucket under `'none'` so the user can isolate unreviewed findings.
  const counts = { critical: 0, high: 0, medium: 0, low: 0, high_bug: 0, bug: 0, informational: 0 }
  const colorCounts = { red: 0, blue: 0, green: 0, gray: 0, none: 0 }
  for (const g of allGroups) {
    const sevs = new Set(g.map((f) => f.severity))
    for (const s of sevs) counts[s] = (counts[s] || 0) + 1
    const cols = new Set(g.map((f) => state.markers.get(tabKey(f)) ?? 'none'))
    for (const c of cols) colorCounts[c] = (colorCounts[c] || 0) + 1
  }

  // Per-render applicability flags. The toolbar hides controls the
   // user can't act on usefully, and the underlying filter state is
   // forced back to its no-op value so a previously-set filter from
   // a prior report can't keep findings hidden silently. Stats /
   // sorting / include-exclude always make sense, so no flags for
   // those.
  // The slider only makes sense when every loaded report has
  // confidence-bearing findings. A single-file load reduces to "any
  // finding has confidence" (one report → its own contribution
  // gates the slider). Workspace-merged views with mixed analyzers
  // (one analyzer-native report with confidence + one DeepSec /
  // Claude Security import without) still hide the slider, because
  // a min>0 would silently drop the no-confidence half — the gate
  // applies per-report so a single confidence-less report blocks
  // the whole workspace.
  const hasAnyConfidence = state.reports.length > 0
    && state.reports.every((r) => r.groups.some((g) => g.some((f) => f.confidence !== undefined)))
  const hasAnyPriority = mergedGroups.some((g) => g.some((f) => f.priority !== undefined))
  const hasAnyModulesPath = mergedGroups.some((g) => g.some((f) => isModule(f.file)))
  // Repo URL input is useful only when at least one finding could
  // benefit from it: non-node_modules AND no per-finding repo.github.
  const repoInputUseful = mergedGroups.some((g) => g.some((f) => !f.repo?.github && !isModule(f.file)))
  // Single common per-finding `repo.github` across every non-module
  // finding — drives the read-only repo chip in the header when the
  // user doesn't need to type anything. `null` for mixed-repo loads
  // (different findings carry different `repo.github`) so we don't
  // mislead by showing one of several.
  const perFindingRepos = new Set()
  for (const g of mergedGroups) {
    for (const f of g) {
      if (!isModule(f.file) && f.repo?.github) perFindingRepos.add(f.repo.github)
    }
  }
  const knownRepo = perFindingRepos.size === 1 ? [...perFindingRepos][0] : null
  // If a previously-loaded report had node_modules and the user
  // narrowed the source filter, switching to a report without any
  // node_modules paths would leave the filter at 'own' or 'modules'
  // and silently empty the list. resetFilters() runs only on isFirst
  // in ingest.js, so guard here too.
  if (!hasAnyModulesPath && state.filterSources.size > 0) state.filterSources.clear()
  if (!hasAnyConfidence) {
    state.filterConfMin = 0; state.filterConfMax = 10
    // Sort options for confidence drop out alongside the filter, so a
    // user-set confidence sort would stay selected against an absent
    // option in the dropdown and applySorting would fall through to
    // its `?? -1` placeholder. Reset to 'file' when that happens.
    if (state.sortBy === 'confidence-desc' || state.sortBy === 'confidence-asc') state.sortBy = 'severity'
  }
  // Same guard for priority — the option drops out of the dropdown
  // when no finding carries it, so a stale state.sortBy would point
  // at a non-existent option and applySorting would shuffle on `?? -1`.
  if (!hasAnyPriority && (state.sortBy === 'priority-desc' || state.sortBy === 'priority-asc')) {
    state.sortBy = 'severity'
  }

  const filtered = applySorting(applyFilters(allGroups))

  // Two top-level views: the default `findings` (table / list /
  // grouped / graph view-modes — chrome owned by render() below)
  // and `files` (per-file tree, reached via the page-header Files
  // toggle). Files is gated on a tree-bearing report with >1 file;
  // a single-file tree adds no navigation value. Stale state on a
  // report swap (or workspace switch) auto-falls back to findings.
  const treeData = state.reports[0]?.tree
  const treeFileCount = treeData ? Object.keys(treeData).length : 0
  const treeAvailable = treeFileCount > 1
  if (!treeAvailable && state.currentView === 'files') state.currentView = 'findings'
  // Same shape as the sort-priority drop above — `graph` is only a
  // valid view-mode while a tree-bearing report is loaded; if the
  // user previously picked it and the underlying data went away
  // (workspace switch, report unload), fall back to the default
  // table layout so a stale selection can't render an empty body.
  if (!treeAvailable && state.viewMode === 'graph') state.viewMode = 'table'

  // `headerTemplate` returns a Lit template — slot reuse below
  // ensures the part-cache survives across renders so Lit can
  // diff in place rather than rebuilding the chrome on every
  // render() (see the slot-reuse PRs in the bundles / files /
  // findings paths).
  const headerTpl = headerTemplate(mergedGroups.length, fileNames, repoInputUseful, knownRepo, treeFileCount)

  if (state.currentView === 'files') {
    const findingCounts = computeFindingCountsByFile(mergedGroups)
    // Reuse the existing slots across renders so Lit's part-cache
    // (keyed on each slot element) survives — without this guard
    // every render() wiped #report, the slot elements were fresh,
    // and the file tree got fully rebuilt instead of diffed (lost
    // scroll, lost expand state). Recreate only on cross-view
    // entry, detected by the slots' presence as #report children.
    let fHeader = document.getElementById('header-slot')
    let treeSlot = document.getElementById('tree-view-slot')
    if (!fHeader || !treeSlot || !report.contains(fHeader) || !report.contains(treeSlot)) {
      report.innerHTML = '<div id="header-slot"></div><div id="tree-view-slot"></div>'
      fHeader = document.getElementById('header-slot')
      treeSlot = document.getElementById('tree-view-slot')
    }
    if (fHeader) litRender(headerTpl, fHeader)
    if (treeSlot) litRender(renderTreeView(treeData, findingCounts), treeSlot)
    report.classList.add('active')
    dropZone.classList.add('hidden')
    document.title = `DeepView results — ${typeLabel || 'no analyzer'}`
    return
  }

  // Wrap the findings-only body in a max-width container so the
  // header + tabs above can span full width (giving the graph
  // tabs more room to breathe), while finding cards stay
  // readable at typewriter widths. The wrapper is left-aligned,
  // not centered: the page reads top-down with the dense tab
  // bar full-bleed and the finding list anchored against the
  // sidebar edge with empty space to the right at wide
  // viewports.
  //
  // When the table view has its details panel open, the wrapper
  // expands to accommodate both the 1200px list + the 800px
  // details panel side-by-side (max 2000px). The .with-details
  // modifier flips the cap; CSS handles the rest.
  const tableWithDetails =
    state.viewMode === 'table' &&
    state.tableSelectedGid &&
    filtered.some((g) => groupKey(g) === state.tableSelectedGid)
  // Graph view-mode within the Findings tab swaps the table/list/grouped
  // body for the same canvas the dedicated Graph tab uses. The
  // wrapper drops its max-width cap so the graph layout (a CSS grid
  // with 1fr stage + 300px sidebar) can spread across the full
  // viewport like the standalone Graph tab does.
  // Graph view-mode within the Findings tab swaps the table/list/grouped
  // body for the same canvas the dedicated Graph tab uses. The
  // wrapper drops its max-width cap so the graph layout (a CSS grid
  // with 1fr stage + 300px sidebar) can spread across the full
  // viewport like the standalone Graph tab does. The view-mode
  // chooser moves INSIDE the graph2 topbar (as an extra row) so
  // there's a single toolbar instead of stacking a Findings-tab
  // toolbar above the graph's own — see the
  // `extraTopRow` argument to renderGraph2Layout below.
  let g2DataForBody = null
  if (state.viewMode === 'graph' && treeData) {
    g2DataForBody = buildGraph2Data()
    // Tree disappeared between the treeAvailable gate and buildGraph2Data
    // (workspace switch race); fall back to the default table view so
    // we don't render an empty graph slot.
    if (!g2DataForBody) state.viewMode = 'table'
  }
  const renderGraphInBody = !!g2DataForBody

  // Wrapper class — modifiers come and go between renders without
  // changing the wrapper's identity, so we update className in
  // place rather than rebuilding the element.
  let wrapperClass = 'findings-content'
  if (tableWithDetails) wrapperClass += ' with-details'
  if (renderGraphInBody) wrapperClass += ' with-graph'

  let toolbarTpl = nothing
  let emptyStateTpl = nothing
  let bodyTemplate = nothing

  if (!renderGraphInBody) {
    toolbarTpl = toolbarTemplate(filtered.length, allGroups.length, triageCounts, counts, colorCounts, {
      showSource: hasAnyModulesPath,
      showConfidence: hasAnyConfidence,
      showPriority: hasAnyPriority,
      showGraphMode: treeAvailable,
    })

    // Empty-state line — slot-based so the typeLabel (which can carry
    // user-controlled analyzer-type strings) flows through Lit's
    // auto-escape rather than a hand-rolled `esc()`. Empty template
    // when none of the empty-state branches matches.
    if (state.shownTriage && allGroups.length === 0) {
      emptyStateTpl = html`<p style="color:var(--muted); margin: 1rem 0;">No ${state.shownTriage} findings.</p>`
    } else if (filtered.length === 0 && allGroups.length > 0) {
      emptyStateTpl = html`<p style="color:var(--muted); margin: 1rem 0;">No findings match the current filters.</p>`
    } else if (allGroups.length === 0) {
      emptyStateTpl = html`<p style="color:var(--green)">No ${typeLabel} issues found.</p>`
    }

    pendingTableItems = null
    pendingFindingCards.clear()
    bodyTemplate = findingsBodyTemplate(filtered)
  }

  // Detach the persistent <finding-table> (if mounted) before any
  // innerHTML reset so the element + its <finding-row> children
  // survive. `.remove()` fires disconnectedCallback on the subtree,
  // but the JS reference keeps everything alive; the reattach below
  // brings the same instances back into the document, where Lit's
  // diff happily reuses the existing children when items / selection
  // change.
  if (persistentFindingTable && persistentFindingTable.isConnected) {
    persistentFindingTable.remove()
  }

  // Slot-reuse: only rebuild the chrome when the structure
  // actually changes (cross-view entry, or switching between
  // graph mode and non-graph mode — the slot set differs). Inside
  // a stable shape, every render() is just litRender into existing
  // slots → Lit diffs in place, scroll / focus / persistent
  // <finding-table> all survive without manual capture-restore.
  let headerSlot = document.getElementById('header-slot')
  let wrapper = report.querySelector(':scope > .findings-content')
  const hadGraphSlot = wrapper && wrapper.querySelector(':scope > #findings-graph-slot')
  const hadBodySlot = wrapper && wrapper.querySelector(':scope > #findings-body-slot')
  const wantedShape = renderGraphInBody ? 'graph' : 'body'
  const haveShape = hadGraphSlot ? 'graph' : (hadBodySlot ? 'body' : null)
  const shapeMatches = wrapper && haveShape === wantedShape
  if (!headerSlot || !wrapper || !report.contains(headerSlot) || !report.contains(wrapper) || !shapeMatches) {
    const inner = renderGraphInBody
      ? '<div id="findings-graph-slot"></div>'
      : '<div id="toolbar-slot"></div><div id="empty-state-slot"></div><div id="findings-body-slot"></div>'
    report.innerHTML = `<div id="header-slot"></div><div class="${wrapperClass}">${inner}</div>`
    headerSlot = document.getElementById('header-slot')
    wrapper = report.querySelector(':scope > .findings-content')
  } else if (wrapper.className !== wrapperClass) {
    wrapper.className = wrapperClass
  }

  if (headerSlot) litRender(headerTpl, headerSlot)
  // Always litRender into existing slots — passing `nothing`
  // clears the slot's prior content. Without this, a slot that
  // was populated last render would keep stale content when the
  // current render's template resolves to `nothing` (e.g. the
  // empty-state line disappearing once findings appear).
  const toolbarSlot = document.getElementById('toolbar-slot')
  if (toolbarSlot) litRender(toolbarTpl, toolbarSlot)
  const emptyStateSlot = document.getElementById('empty-state-slot')
  if (emptyStateSlot) litRender(emptyStateTpl, emptyStateSlot)

  // Now that the slots are in the DOM, litRender the Lit-templated
  // findings body into its placeholder. The body template covers
  // every viewMode (table / list / grouped); the table case still
  // emits a `.finding-table-slot` div inside the template, which
  // the `<finding-table>` reattach below targets.
  // The post-render reattach below mutates `.finding-table-slot`
  // inside the bodyTemplate output (`slot.replaceWith(...)`),
  // which leaves Lit's part-cache for bodySlot pointing at
  // orphaned nodes — next render then diffs against a stale tree
  // and can render the body empty. Recreating bodySlot in the
  // table-view path resets that cache, while the list / grouped
  // paths keep the original element so Lit can diff in place.
  let bodySlot = document.getElementById('findings-body-slot')
  if (bodySlot && pendingTableItems) {
    const fresh = document.createElement('div')
    fresh.id = 'findings-body-slot'
    bodySlot.replaceWith(fresh)
    bodySlot = fresh
  }
  if (bodySlot) litRender(bodyTemplate, bodySlot)

  // Graph view-mode: render the graph2 layout into the
  // findings-graph slot and wire the canvas interaction. The
  // view-mode chooser rides along as an extra row in the graph's
  // own topbar so this view doesn't need a separate toolbar above
  // the canvas.
  if (g2DataForBody) {
    const graphSlot = document.getElementById('findings-graph-slot')
    if (graphSlot) {
      const viewModeRow = html`<view-mode-buttons
        mode=${state.viewMode}
        modes="table,list,grouped,graph"
      ></view-mode-buttons>`
      litRender(renderGraph2Layout(g2DataForBody.graph, { extraTopRow: viewModeRow }), graphSlot)
      // Populate the right-panel selection slot + the top-packages
      // block + the canvas's drill-in overlay slot via the same
      // refresh helpers the canvas's click handlers use later.
      // Slots are emitted empty by renderGraph2Layout — each runs
      // its own `litRender` so subsequent clicks diff against a
      // single Lit cache per slot, instead of the parent layout's
      // cache + the per-slot cache stepping on each other.
      refreshGraph2Sidebar()
      refreshGraph2TopPkgs()
      attachGraph2Interaction(report, g2DataForBody.graph, refreshGraph2Sidebar)
    }
  }

  // Hand the sorted item list and current selection to the
  // <finding-table> custom element after the DOM lands. Stashing the
  // items via a property (rather than serialising through an
  // attribute) keeps object identity and avoids a JSON round-trip on
  // every re-render.
  if (pendingTableItems) {
    const slot = report.querySelector('.finding-table-slot')
    if (slot) {
      if (!persistentFindingTable) {
        persistentFindingTable = document.createElement('finding-table')
      }
      persistentFindingTable.items = pendingTableItems
      persistentFindingTable.selectedGid = state.tableSelectedGid
      slot.replaceWith(persistentFindingTable)
    }
  }
  // Pair each <finding-card> with its dedup group via the gid stamped
  // on the placeholder. The component itself can't know which group
  // it represents from HTML attributes alone (group is a structured
  // object, not a string), so render.js wires it up by gid lookup
  // here. `in-group` is already set as an attribute, so the
  // component's reflective `inGroup` boolean comes from the HTML.
  if (pendingFindingCards.size > 0) {
    for (const card of report.querySelectorAll('finding-card')) {
      const entry = pendingFindingCards.get(card.dataset.gid)
      if (entry) card.group = entry.group
    }
  }
  report.classList.add('active')
  dropZone.classList.add('hidden')
  document.title = `DeepView results — ${typeLabel || 'no analyzer'}`
}

// Re-render while preserving focus + caret position on a text input —
// used by the "Include" / "Exclude" / "Repo" inputs whose every
// keystroke triggers a render. Without this, focus would jump out of
// the box mid-typing because the input element gets recreated.
export function renderKeepFocus(inputId) {
  const prev = document.getElementById(inputId)
  const pos = prev ? prev.selectionStart : 0
  render()
  const el = document.getElementById(inputId)
  if (el) { el.focus(); el.setSelectionRange(pos, pos) }
}
