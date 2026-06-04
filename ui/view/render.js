import { html, render as litRender, nothing } from 'lit'
import { classMap } from 'lit/directives/class-map.js'
import { repeat } from 'lit/directives/repeat.js'
import { styleMap } from 'lit/directives/style-map.js'
import { unsafeHTML } from 'lit/directives/unsafe-html.js'
import { FILE_ICONS } from './file-display.js'
import { listBundles, listWorkspaces, state } from '#client/index.js'
import { isBundleInRemote, isInRemote, remoteCount, triageSync } from './client-sync.js'
import { dropZone, report } from './dom.js'
import { SEVERITIES, configureDepsDir, fileLink, findingDisplayName, formatRunMeta, isModule, lineLink, prettyModel, stripExportMarker } from './format.js'
import { activeTabFor, getMergedGroups, groupKey, groupState, primaryTab, tabKey } from './group.js'
import { NO_REPO_SENTINEL, NULL_ANALYZER_SENTINEL, applyFilters, applySorting, repoOfFinding } from './filters.js'
import { ANALYZER_LABELS } from './analyzer-select.js'
import { FLAG_ICON, badgeLabel, findingCardGid, firstLine } from './render-finding.js'
import { computeFindingCountsByFile, computeTransitiveCounts, fileHasFindings, mergeReportsTree } from './file-counts.js'
import { renderTreeView } from './render-files.js'
import { graph2 } from './graph/state.js'
import { attachGraphLayout, loadedGraphMod } from './graph-attach.js'
import { attachTerminal } from './terminal-attach.js'
import { packageOf } from './graph/utils.js'
import { renderPackagesView } from './render-packages.js'
import { renderRepositoriesView } from './render-repositories.js'
import {
  buildBundleGraphData,
  countBundleTriageBuckets,
  refreshBundleGraphSidebar,
  refreshBundleGraphTopPkgs,
  renderBundleSourceModal,
  renderBundlesList,
  setCurrentBundleGraphPrep,
} from './render-bundle.js'
import { getFocusCode } from './focus-code.js'
import { openSyncUploadDialog } from './dialogs/sync-upload-dialog.js'
import { openObjstoreRecoveryDialog } from './dialogs/objstore-recovery-dialog.js'

// View-mode icons + titles + click handling all live in
// `<view-mode-buttons>` (see view/view-mode-buttons.js); the host
// passes the current `state.viewMode` and listens for
// `view-mode-change` events.

// Build the v2 graph data from the currently-loaded report. Returns
// null when no tree-bearing report is loaded — callers fall back to
// a friendlier state.
//
// Two filters compose:
//   - trash split at the GROUP level (group "deleted" when every
//     member is in state.deletedIds), matching the findings tab so
//     swapping tabs reads consistently.
//   - graph2.showAll then optionally pads the file set with clean
//     files whose subtree contains a (filtered-in) finding,
//     reachable through imports. Off by default so the canvas
//     focuses on issue-bearing code.
export function buildGraph2Data() {
  // Merge the per-report trees so a workspace canvas spans every
  // loaded report — the 1st report's tree alone omits files/edges
  // from the 2nd+ reports whose findings are still merged in below.
  const treeData = mergeReportsTree(state.reports)
  if (!treeData) return null
  const allFiles = Object.keys(treeData)
  const allGroups = getMergedGroups()
  // Filter to live (default) or deleted (trash mode) groups
  // BEFORE counting per-file findings, so the layout, statistics,
  // and severity-row counts all reflect the active tab's split.
  const visibleGroups = allGroups.filter((g) =>
    groupState(g).commonTriage === state.shownTriage)
  const findingCounts = computeFindingCountsByFile(visibleGroups)
  const transitiveCounts = computeTransitiveCounts(treeData, findingCounts)
  // Per-file Sets driving the topbar severity / triage chip counts
  // AND the canvas dim predicate. Each finding contributes its
  // severity tier and marker color (default 'none' when unmarked); a
  // file highlights under a filter iff any of its findings matches —
  // same union semantics as the findings tab's filter, so the canvas
  // tracks "issues the table would have shown".
  const severitySets = new Map()
  const colorSets = new Map()
  // Per-finding `{severity, color}` pairs, so Packages → Issues can
  // count findings filtered by BOTH severity and color at once (an
  // intersection the per-severity totals above can't express). Sets
  // stay separate where set membership alone suffices (dim predicate,
  // chip counts).
  const fileFindings = new Map()
  for (const g of visibleGroups) {
    for (const f of g) {
      if (!severitySets.has(f.file)) severitySets.set(f.file, new Set())
      severitySets.get(f.file).add(f.severity)
      const color = state.triage.get(tabKey(f))?.color ?? 'none'
      if (!colorSets.has(f.file)) colorSets.set(f.file, new Set())
      colorSets.get(f.file).add(color)
      if (!fileFindings.has(f.file)) fileFindings.set(f.file, [])
      fileFindings.get(f.file).push({ severity: f.severity, color })
    }
  }
  // Package-focus mode narrows to files in the focused package, with
  // graph2.showAll still gating the clean-file filter inside that
  // scope (when off, drop files with neither own nor transitive
  // findings — the full-graph predicate applied to the subset).
  // Cross-package imports outside the focus aren't drawn, but their
  // transitive findings still count toward keeping a file in scope
  // (part of the "reachable issues" the user expects represented).
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
  // `prep` is the raw-inputs shape — the lazy `ui/graph.js`
  // module's `buildGraphFromPrep(prep)` does the actual
  // `buildGraph(...)` call. Keeps `graph/data.js` out of the
  // main bundle.
  return {
    prep: {
      treeData, files, ownCounts: findingCounts, transitiveCounts,
      severitySets, colorSets, fileFindings,
    },
    findingCounts,
  }
}

// Surgical sidebar update — keeps the canvas DOM (and its active rAF /
// hover state) alive across a node / neighbor-link click. `litRender`
// diffs against the PartInfo it stamps on the container, so feed it
// the new template directly; clearing `innerHTML` first orphans the
// cache and the next render `insertBefore`s on a null parent
// (TypeError on the next click).
//
// Wrappers — assemble graph data + bundle-context flag from main-
// bundle state, then dispatch into the lazy `ui/graph.js` module for
// the actual `<graph-layout>` shadow-DOM render. No-op when the graph
// was never opened this session (`loadedGraphMod()` null) — no shadow
// tree to refresh.
export function refreshGraph2Sidebar() {
  const mod = loadedGraphMod()
  if (!mod) return
  const data = buildGraph2Data()
  if (!data) return
  mod.refreshSidebar(data.prep, { isBundleContext: state.currentView === 'bundles' })
}

export function refreshGraph2TopPkgs() {
  const mod = loadedGraphMod()
  if (!mod) return
  const data = buildGraph2Data()
  if (!data) return
  mod.refreshTopPkgs(data.prep)
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
    return html`<repo-chip url=${state.repoUrl} editable ?editing=${state.repoEditing} ?empty=${!state.repoUrl}></repo-chip>`
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
// type field carries the `analyzer: ` label and always renders (even
// when null) so the slot is never silently dropped — `analyzer: null`
// reads as "this run had no analyzer subtype". Non-type fields return
// null when the value is missing so the caller can drop them; a bare
// `null` for a missing model / effort / exports just clutters the
// header.
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
// When `model` / `effort` end up as their own chips (i.e. common across
// every combo, so they aren't folded into the varying-tuple chip), they
// surface before the `analyzer:` chip — the run identity reads more
// naturally model-first than analyzer-first. Varying tuples stay at the
// first-varying slot in canonical order so the tuple text keeps reading
// `model · effort · exportsMode`.
//
// Examples (combos as `type · model · effort · exportsMode`):
//   `null · opus 4.7 · max · list` + `null · gpt 5.5 · xhigh · list`
//     → `analyzer: null` `opus 4.7 · max` `gpt 5.5 · xhigh` `list`
//   `null · opus 4.7 · xhigh · isolate` + `null · opus 4.7 · max · list`
//     → `opus 4.7` `analyzer: null` `xhigh · isolate` `max · list`
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

  // Promote common model / effort ahead of the analyzer-type chip; the
  // remaining fields keep their canonical order so varying tuples still
  // emit at the first-varying slot.
  const promoted = ['model', 'effort'].filter((k) => fields.includes(k) && isCommon[k])
  const emitOrder = [...promoted, ...fields.filter((k) => !promoted.includes(k))]

  const tags = []
  let combosEmitted = false
  for (const k of emitOrder) {
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

// Page header. The h1 carries the tool name plus a pill-shaped file
// chip naming the active report; the meta-row underneath strings the
// count followed by the analyzer-combo tags from `buildAnalyzerTags`.
//
// Tool name comes from the source marker when every loaded report
// agrees on one (`Claude Security findings`, `Codex Security
// findings`, `DeepSec findings`); otherwise it's `Findings`.
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
    : (singleSource ? SOURCE_TITLES[singleSource] : 'Findings')

  // File chip: single-file reports get the filename verbatim with a
  // brand sticker for the source bucket (Claude / Codex / DeepSec /
  // DeepView eye for analyzer-native). Multi-report loads (workspace
  // merge) collapse to "N reports" with a GENERIC outline file glyph
  // — even under one shared source, a brand sticker would mis-imply
  // the chip names a single item rather than the collection it is.
  const singleStickerKey = singleSource && FILE_ICONS[singleSource] ? singleSource : 'default'
  const singleSticker = unsafeHTML(FILE_ICONS[singleStickerKey])
  const multiSticker = html`<svg class="file-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/></svg>`
  let fileChip = nothing
  if (fileNames.length === 1) {
    fileChip = html`<span class="file-chip">${singleSticker}<span>${fileNames[0]}</span></span>`
  } else if (fileNames.length > 1) {
    fileChip = html`<span class="file-chip">${multiSticker}<span>${fileNames.length} reports</span></span>`
  }

  const findings = state.reports.flatMap((r) => r.groups.flat())

  // Count covers EVERY loaded finding (live + trashed) — trashed
  // entries are still part of the report, just hidden from the active
  // list. The header stays steady so the load total doesn't shift
  // when the trash toggle flips (the toggle itself signals the mode).
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
    for (const g of getMergedGroups()) {
      const sev = primaryTab(g).severity
      if (sev) sevCounts[sev] = (sevCounts[sev] || 0) + 1
    }
    const presentSevs = SEVERITIES.filter((s) => sevCounts[s] > 0)
    if (presentSevs.length > 0) {
      statusBarTpl = html`<span class="status-bar" aria-hidden="true">${presentSevs.map((s) => {
        const tip = `${sevCounts[s]} ${s.replaceAll('_', ' ')}`
        return html`<span class=${`status-seg sev-${s}`} style=${styleMap({ flexGrow: sevCounts[s] })} title=${tip}></span>`
      })}</span>`
    }
  }

  const repoTpl = repoChipTemplate(repoInputUseful, knownRepo)
  const sep = html`<span class="sep" aria-hidden="true"></span>`

  // Files toggle — sits right after the repo chip in the title row so
  // it's visually tied to the report identity, and operates on/off
  // like the Trash button: clicking flips state.currentView between
  // 'files' and the previous (saved) view. Gated on
  // `treeFileCount > 1`; a single-file tree adds no value.
  const filesActive = state.currentView === 'files'
  const filesBtnTpl = (treeFileCount ?? 0) > 1
    ? html`<button
        type="button"
        class=${classMap({ 'files-toggle-btn': true, active: filesActive })}
        data-action="toggle-files"
        title=${filesActive ? 'exit files view' : 'show files'}
        aria-pressed=${String(filesActive)}
      >${`Files: ${treeFileCount}`}</button>`
    : nothing

  return html`<header class="page-head">
    <div class="page-title">
      <h1>${titleText}${fileChip}${repoTpl}${filesBtnTpl}${syncBadgeTemplate()}</h1>
      <div class="meta-row">
        <span>${countLabel}</span>
        ${statusBarTpl}
        ${tags.length > 0 ? html`${sep}${tags.map((t) => html`<span class="tag">${t}</span>`)}` : nothing}
      </div>
    </div>
  </header>`
}

// Sync-status badge — renders into the title h1 alongside the
// file-chip / repo-chip so it sits on the same baseline. Two
// shapes:
//
//   - Single-file view (state.currentFile in a workspace): one
//     chip with `local` / `cloud` status. The whole element is a
//     <button>; clicking `local` opens the upload-confirmation
//     dialog. (`cloud` chip is non-interactive in v1.)
//
//   - Workspace view: two side-by-side chunks "N cloud / M local"
//     inside an outer <div>. `N` is the workspace's full remote
//     inventory size (synced + remote-only); `M` is the
//     locally-loaded report count (synced + local-only).
//     - Click "cloud" → download dialog scoped to remote-only
//       reports (non-interactive if every remote file is local).
//     - Click "local" → upload dialog scoped to local-only
//       reports (non-interactive if every local file is uploaded).
//
// Gated on `triageSync.status === 'online'` — that's the
// "connection up" signal. The empty-workspace case is intentionally
// supported (mode === 'workspace', state.reports = []) so a user
// who just created a workspace and joined a peer's chain still
// sees the badge and can click "N cloud" to pull the peer's
// reports down. (`reportSyncBadgeTemplate` only hides when BOTH
// local and remote counts are zero.)
function syncBadgeTemplate() {
  if (triageSync.status !== 'online') return nothing
  if (state.currentView !== 'findings' && state.currentView !== 'files') return nothing
  const wsContext = resolveWorkspaceContext()
  if (!wsContext) return nothing
  const { workspaceId, fileNames, mode } = wsContext
  if (mode === 'single') {
    // Single-file view: chip reflects just the active report's
    // status. Bundles aren't represented here — they live in the
    // workspace context, which the user can navigate to via the
    // sidebar to see the combined badge.
    const name = fileNames[0]
    const status = isInRemote(workspaceId, name) ? 'cloud' : 'local'
    return badgeChipButton({
      status,
      label: status,
      title: status === 'cloud'
        ? 'Synced to remote'
        : 'Local only — click to upload',
      onClick: status === 'local'
        ? () => openUploadFromBadge({ workspaceId, items: [{ kind: 'report', identifier: name }] })
        : null,
    })
  }
  // Workspace view — two chunks, "N cloud" and "M local", with
  // each chunk suppressed when its count is zero. Counts:
  //
  //   N (cloud) — full remote inventory size (`remoteCount`), so
  //               the badge surfaces the cloud-side total even
  //               while background `fetchByTag` discovery is
  //               still resolving names. A locally-loaded file
  //               that is ALSO in remote contributes to N, not M
  //               — "cloud" absorbs "synced" because the bytes are
  //               already replicated.
  //   M (local-only) — files in state.reports whose HMAC tag is
  //                    NOT in the remote set. Partitioned via the
  //                    synchronous `isInRemote` so a peer-just-
  //                    uploaded file (whose name hasn't been
  //                    decoded yet) doesn't briefly flicker into
  //                    M and offer a redundant upload (review
  //                    r3242197745).
  //
  // Clickability:
  //   cloud chunk — clickable whenever cloudCount > 0; opens the
  //                 recovery dialog to re-check remote storage.
  //   local chunk — clickable iff M > 0 (there's something to
  //                 upload).
  //
  // Hides entirely when both chunks would render empty (e.g. a
  // freshly-created workspace with no peers and no local
  // reports). Empty-workspace bug fix #4.
  //
  // Aggregate reports + bundles into a single badge: the user sees
  // one "N cloud / M local" pair in the header instead of two
  // side-by-side badges. The "local" chunk opens a unified upload
  // dialog; the "cloud" chunk opens the recovery dialog (re-check +
  // repair missing bytes + optional download of remote-only objects).
  //
  // `cloudCount` is just `remoteCount` (reports + bundles together —
  // the cardinality of remoteTags, which includes both kinds). The
  // recovery dialog the "cloud" chunk opens enumerates the live remote
  // listing itself, so no report-vs-bundle dispatch happens here.
  const ws = listWorkspaces().find((w) => w.id === workspaceId)
  const localBundles = ws && Array.isArray(ws.bundles) ? ws.bundles : []
  const cloudCount = remoteCount(workspaceId)
  const localOnlyReports = fileNames.filter((n) => !isInRemote(workspaceId, n))
  const localOnlyBundles = localBundles.filter((i) => !isBundleInRemote(workspaceId, i))
  const localOnly = [
    ...localOnlyReports.map((n) => ({ kind: 'report', identifier: n })),
    ...localOnlyBundles.map((i) => ({ kind: 'bundle', identifier: i })),
  ]
  if (cloudCount === 0 && localOnly.length === 0) return nothing
  // The "cloud" chunk is clickable whenever there's remote state: it
  // opens the recovery dialog to re-check the remote objstore (re-fetch
  // each object, re-upload any whose bytes went missing, and offer to
  // download healthy objects not stored locally). The "local" chunk is
  // clickable whenever there's something to upload.
  const cloudClickable = cloudCount > 0
  const localClickable = localOnly.length > 0
  const wrapperTitle = [
    cloudCount > 0 ? `${cloudCount} in cloud` : null,
    localOnly.length > 0 ? `${localOnly.length} local-only` : null,
    cloudCount > 0 ? `click "cloud" to re-check storage` : null,
    localOnly.length > 0 ? `click "local" to upload ${localOnly.length}` : null,
  ].filter(Boolean).join(' — ')
  const cloudChunk = cloudCount === 0 ? nothing
    : html`<button
        type="button"
        class="sync-badge-chunk cloud"
        aria-label=${`re-check ${cloudCount} cloud object${cloudCount === 1 ? '' : 's'}`}
        @click=${(e) => { e.stopPropagation(); openObjstoreRecoveryDialog({ workspaceId, cloudCount, localFileNames: fileNames, localBundles }) }}
      >${cloudIconTpl()}<span>${cloudCount} cloud</span></button>`
  const localChunk = localOnly.length === 0 ? nothing
    : html`<button
        type="button"
        class="sync-badge-chunk local"
        aria-label=${`${localOnly.length} items not yet uploaded — open upload dialog`}
        @click=${(e) => { e.stopPropagation(); openUploadFromBadge({ workspaceId, items: localOnly }) }}
      >${localIconTpl()}<span>${localOnly.length} local</span></button>`
  // The divider only shows when BOTH chunks are present.
  const divider = (cloudCount > 0 && localOnly.length > 0)
    ? html`<span class="sync-badge-divider" aria-hidden="true"></span>`
    : nothing
  return html`<div
    class=${`report-sync-badge${cloudClickable || localClickable ? ' report-sync-badge-clickable' : ''}`}
    data-status="mixed"
    title=${wrapperTitle}
  >${cloudChunk}${divider}${localChunk}</div>`
}

function badgeChipButton({ status, label, title, onClick }) {
  const icon = status === 'cloud' ? cloudIconTpl() : localIconTpl()
  const labelTpl = html`<span class="sync-badge-label">${label}</span>`
  if (typeof onClick !== 'function') {
    // Informational chip — render as a `<span>` so it doesn't pick
    // up the disabled-button focus / tab semantics or land in the
    // tab order with a no-op activation. Mirrors the workspace-
    // aggregate non-clickable chunk (review r3242461680).
    return html`<span
      class="report-sync-badge"
      data-status=${status}
      title=${title}
      aria-label=${`report sync status: ${label}`}
    >${icon}${labelTpl}</span>`
  }
  return html`<button
    type="button"
    class="report-sync-badge report-sync-badge-clickable"
    data-status=${status}
    title=${title}
    aria-label=${`report sync status: ${label}`}
    @click=${onClick}
  >${icon}${labelTpl}</button>`
}

function localIconTpl() {
  return html`<svg class="sync-badge-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <rect x="2" y="14" width="20" height="8" rx="2" ry="2"/>
    <line x1="6" y1="18" x2="6.01" y2="18"/>
    <line x1="10" y1="18" x2="10.01" y2="18"/>
    <path d="M6 14V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v10"/>
  </svg>`
}

function cloudIconTpl() {
  return html`<svg class="sync-badge-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M17.5 19a4.5 4.5 0 1 0-1-8.9A6 6 0 0 0 5.07 13.5 4 4 0 0 0 6 21h11.5z"/>
  </svg>`
}

async function openUploadFromBadge({ workspaceId, items }) {
  // Resolve user-friendly labels for the bundle items so the dialog
  // shows the actual sidebar name (e.g. "my-app.js") instead of the
  // sha512 prefix fallback. The bundle metadata `_meta.json` is the
  // source of truth for the local label — pull it once and join.
  const bundleItems = items.filter((i) => i.kind === 'bundle')
  if (bundleItems.length > 0) {
    const meta = await listBundles()
    const labelByIntegrity = new Map(meta.map((b) => [b.integrity, b.name]))
    for (const item of bundleItems) {
      const name = labelByIntegrity.get(item.identifier)
      if (name) item.label = name
    }
  }
  await openSyncUploadDialog({ workspaceId, items })
}

// Resolve which workspace + which loaded report file-names the
// sync-status badge applies to. `mode` differentiates a single-file
// view (one report from a workspace) from a workspace-merged view
// (every loaded report) so the badge template can pick between the
// `local` / `cloud` shape and the "N cloud / M local" aggregate.
// Returns `null` if the active view isn't a report-in-workspace.
function resolveWorkspaceContext() {
  if (state.currentWorkspace) {
    return {
      mode: 'workspace',
      workspaceId: state.currentWorkspace,
      fileNames: state.reports.map((r) => r.fileName).filter((n) => typeof n === 'string'),
    }
  }
  if (state.currentFile) {
    const ws = listWorkspaces().find((w) => Array.isArray(w.reports) && w.reports.includes(state.currentFile))
    if (!ws) return null
    return { mode: 'single', workspaceId: ws.id, fileNames: [state.currentFile] }
  }
  return null
}

// Stats — clickable filter chips: severity on the left, mark-color on
// the right. Both multi-select: empty selection = no filter; multiple
// = union across the ticked chips (ticking every chip == ticking
// none). Zero-count chips hidden so the row stays compact for Claude /
// Codex / JSON dumps that don't carry every tier. The prototype's
// "X shown / All / None" actions group is omitted — the search row's
// `X of Y` count + the per-chip toggle already cover it.
//
// Both strips are StateElement components (`<severity-chips>`,
// `<triage-filter>`) reading the active filter set from `state` via
// observer-util autorun; counts arrive via Lit property binding (the
// parent holds the filter-pipeline output). CSS lives in toolbar.css
// (components render to light DOM so those rules apply). Gating the
// templates at the call site — not just the components' own empty-set
// guards — keeps an empty component from claiming a flex `gap` slot
// between its visible neighbours.
function severityChipsTemplate(counts) {
  const hasAny = Object.values(counts).some((n) => n > 0) || state.filterSeverities.size > 0
  if (!hasAny) return nothing
  // Property binding (`.counts=`) — `<severity-chips>` extends
  // StateElement and reads `state.filterSeverities` directly for
  // the findings kind, so no `selected` prop is needed here.
  return html`<severity-chips .counts=${counts}></severity-chips>`
}

function triageFilterTemplate(colorCounts) {
  const hasAny = Object.values(colorCounts).some((n) => n > 0) || state.filterColors.size > 0
  if (!hasAny) return nothing
  return html`<triage-filter .counts=${colorCounts}></triage-filter>`
}

// `flags` carries per-render applicability: when no finding in the
// current report has confidence / a node_modules path / file or tree
// hash metadata, the corresponding control is omitted entirely (and
// the underlying filter state is forced to its no-op value upstream
// for confidence / source so it can't be left set from a previous
// report). Hides chrome the user can't act on usefully.
// `<triage-selector>` (view/triage-selector.js) reads
// `state.shownTriage` via StateElement and self-gates its visibility,
// so the host drops it in unconditionally.

function toolbarTemplate(filteredCount, allCount, triageCounts, counts, colorCounts, flags, analyzerOptions, repoOptions) {
  const { showSource, showConfidence, showPriority, showGraphMode, showFileSort, kanbanMode, showRepo } = flags
  // The findings tab gains a "graph" view-mode option when a
  // tree-bearing report is loaded (showGraphMode). The focus and
  // kanban modes sit between grouped and graph. Switching to graph
  // replaces the table / list / grouped / focus / kanban body with
  // the graph2 canvas — see the findings-graph slot in render()
  // below.
  const viewModes = showGraphMode ? 'table,list,grouped,focus,kanban,graph' : 'table,list,grouped,focus,kanban'

  return html`<div class="toolbar">
    <div class="toolbar-row">
      <!-- View mode leads the row — <view-mode-buttons> renders the
           table / list / grouped icon group; immediately followed by
           the Sort dropdown with no separator between them. -->
      <view-mode-buttons modes=${viewModes}></view-mode-buttons>
      <!-- Sort dropdown — findings-sort owns the native select +
           the conditional option list. Flags arrive as boolean
           attributes; the component reads state.sortBy via
           StateElement and dispatches sort-change on change. -->
      <findings-sort
        ?show-file=${showFileSort}
        ?show-confidence=${showConfidence}
        ?show-priority=${showPriority}
      ></findings-sort>
      ${showSource ? html`<div class="sep"></div><source-filter></source-filter>` : nothing}
      <div class="sep"></div><flag-filter></flag-filter>
      ${showConfidence ? html`<div class="sep"></div><conf-filter></conf-filter>` : nothing}
      ${kanbanMode ? nothing : html`<triage-selector .counts=${triageCounts}></triage-selector>`}
    </div>
    <!-- Filter row: severity chips + mark-color triage pill + search
         field, all inline so they read as one composable filter strip.
         The "X shown / All / None" actions block from the prototype's
         outer .sev-row is intentionally left off — the result count
         at the row's right edge and the per-chip toggle cover those
         needs. -->
    <div class="toolbar-row sev-row">
      ${severityChipsTemplate(counts)}
      <!-- Analyzer dropdown — visible only when the loaded reports
           involve more than one distinct analyzer (otherwise there is
           nothing to choose between). Single-select with an empty
           default ("All analyzers" = no filter); a finding whose
           effective analyzer is absent (no per-finding type on a
           native dump) gets a synthetic "(none)" option whose value
           is the NULL_ANALYZER_SENTINEL — that sentinel can't collide
           with a legitimate analyzer literally named "null", which
           would otherwise resolve to the same <option value="null">
           and be indistinguishable in the dropdown. Component owns
           its select + the friendly
           ANALYZER_LABELS lookup; reads state.filterAnalyzer itself
           via StateElement and uses live() so stale-filter clears in
           the parent's pipeline actually update the visible
           selection. -->
      ${analyzerOptions.length > 1 ? html`<analyzer-select .options=${analyzerOptions}></analyzer-select>` : nothing}
      <!-- Repo dropdown — only meaningful in workspace view (single-
           file mode usually has one repo). Hidden when the loaded
           reports involve a single repo (no choice to make).
           Component owns its select + the prettyRepoLabel shortening;
           reads state.filterRepo via StateElement and uses live() so
           a stale-filter clear in the parent (workspace switch) lands
           on the actual select.value. -->
      ${showRepo && repoOptions.length > 1 ? html`<repo-filter .options=${repoOptions}></repo-filter>` : nothing}
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
        <toolbar-search kind="findings"></toolbar-search>
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

// Last index the focus view rendered at. After a triage action
// removes the currently-focused finding from view (very common —
// "fix this" / "invalid" / "delete" all drop it out of the
// default live-bucket filter), `state.focusGid` no longer matches
// anything in `filtered`. Re-using the same index lands on the
// item that shifted up into that slot — i.e. the NEXT untriaged
// finding — which is the expected forward-motion of a triage
// session. Resets to 0 when filters / sort produce a fresh list.
let prevFocusedIdx = 0

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

function findingCardPlaceholder(g, inGroup = false, context = null) {
  const gid = findingCardGid(g)
  pendingFindingCards.set(gid, { group: g, inGroup })
  // `context` (currently only `'focus'`) reflects as a `context=`
  // attribute on the host so `<finding-card>`'s shadow CSS can
  // target the focus-view variant — inlined triage menu, expanded
  // action chrome — via `:host([context="focus"])`. The default
  // (no attribute) keeps every existing call site rendering
  // unchanged.
  if (inGroup) {
    return context
      ? html`<finding-card data-gid=${gid} in-group context=${context}></finding-card>`
      : html`<finding-card data-gid=${gid} in-group></finding-card>`
  }
  return context
    ? html`<finding-card data-gid=${gid} context=${context}></finding-card>`
    : html`<finding-card data-gid=${gid}></finding-card>`
}

// Compact kanban card — tiny colored letter-chip + multi-line
// title + file:line. The full card (tabs, action buttons, the
// description body) lives behind a click that opens a centered
// modal (see kanbanDetailTemplate). The whole card is draggable
// in the kanban variant; `data-kanban-source` lets the drop-zone
// predicate in events.js tell us apart from any other element with
// `data-gid`. The same compact template is reused as the focus
// view's right-hand "up next" list — the `focus` variant drops
// drag + adds the `[data-focus-select]` hook the focus click
// handler picks up, plus an `.active` class on the currently-
// focused card.
const SEVERITY_LETTERS = {
  critical:      'C',
  high:          'H',
  medium:        'M',
  low:           'L',
  high_bug:      'H',
  bug:           'B',
  informational: 'i',
}
function kanbanCardTemplate(g, opts = {}) {
  const { variant = 'kanban', active = false } = opts
  const groupSt = groupState(g)
  const activeTab = activeTabFor(g)
  const title = firstLine(stripExportMarker(activeTab.description, activeTab)) || '(untitled finding)'
  const isKanban = variant === 'kanban'
  const classes = {
    'kanban-card': true,
    'has-conflict': groupSt.hasConflict,
    'focus-side-card': !isKanban,
    // Active = the focus-view queue's current card, or (kanban) the
    // card whose detail popover is open. Drives the accent ring so it
    // tracks arrow-key navigation independently of DOM focus.
    'active': active,
  }
  if (!groupSt.hasConflict && groupSt.commonColor) classes[`mark-${groupSt.commonColor}`] = true
  const lineNum = parseInt(activeTab.line, 10)
  const lineSuffix = Number.isFinite(lineNum) ? `:${lineNum}` : ''
  const letter = SEVERITY_LETTERS[activeTab.severity] ?? '?'
  // Attention flag sits directly under the severity badge (top-right
  // of the card). Display-only here — the card is a drag/click target,
  // so toggling lives in the detail popover's finding-card; we only
  // surface the indicator when the active tab is flagged.
  const flagged = state.triage.get(tabKey(activeTab))?.flagged === true
  const inner = html`<div class="kanban-badge-col">
      <span
        class=${`kanban-badge sev-${activeTab.severity}`}
        title=${badgeLabel(activeTab.severity)}
        aria-label=${badgeLabel(activeTab.severity)}
      >${letter}</span>
      ${flagged ? html`<span class="kanban-flag" title="Flagged" aria-label="Flagged">${FLAG_ICON}</span>` : nothing}
    </div>
    <span class="kanban-title">${title}</span>
    <div class="kanban-meta">
      <span class="kanban-loc">${activeTab.file}${lineSuffix}</span>
      ${activeTab.confidence === undefined || activeTab.confidence === null
        ? nothing
        : html`<span class="kanban-conf" title=${`Confidence ${activeTab.confidence}/10`}>${activeTab.confidence}</span>`}
    </div>`
  if (isKanban) {
    return html`<div
      class=${classMap(classes)}
      data-gid=${groupKey(g)}
      data-kanban-source
      draggable="true"
      role="button"
      tabindex="0"
      aria-current=${active ? 'true' : 'false'}
      aria-label=${`Open details for ${title}`}
    >${inner}</div>`
  }
  // Focus variant — the click handler in events.js looks for
  // `.focus-side-card[data-focus-select]` and swaps the centered
  // finding-card to the clicked gid.
  return html`<div
    class=${classMap(classes)}
    data-gid=${groupKey(g)}
    data-focus-select
    role="button"
    tabindex="0"
    aria-current=${active ? 'true' : 'false'}
    aria-label=${`Focus on ${title}`}
  >${inner}</div>`
}

// Per-line rendering for the focus view's inline Code panel.
// Two-column layout (gutter + source) mirroring the bundle source
// viewer's structure — line numbers in a sticky narrow rail, the
// source body as either Prism-highlighted markup (when the
// language is supported) or plain text. The focused finding's line
// gets `.focus-code-line-active` so the row stands out; the panel's
// post-render scroll handler (see events.js) brings it into view.
function focusCodeLinesTemplate(code) {
  const { content, line, highlighted } = code
  const lineCount = content.split('\n').length
  const digits = String(lineCount).length
  return html`<div class="focus-code-lines" style=${styleMap({ '--lineno-width': `${digits}ch` })}>
    <aside class="focus-code-gutter" aria-hidden="true">
      ${Array.from({ length: lineCount }, (_, i) => {
        const ln = i + 1
        const classes = { 'focus-code-lineno': true, 'focus-code-line-active': ln === line }
        return html`<div class=${classMap(classes)} data-focus-code-line=${ln}>${ln}</div>`
      })}
    </aside>
    <pre class="focus-code-source"><code>${typeof highlighted === 'string'
      ? unsafeHTML(highlighted)
      : content}</code></pre>
  </div>`
}

// Detail modal — opens on kanban-card click, wrapped in
// `document.startViewTransition` so the open / close animations
// run as a single view transition (the scale + opacity keyframes
// against `::view-transition-{new|old}(kanban-detail-modal)` in
// findings.css drive the visual). Clicking the backdrop (anywhere
// outside the modal) or pressing Esc clears `state.kanbanPopoverGid`
// — both transitions go through the same renderImpl path so the
// animation is symmetric. The modal carries the source group's
// mark color (or its conflict outline) on its host so a colored
// finding's detail view reads consistently with its card.
function kanbanDetailTemplate(focusGroup) {
  if (!focusGroup) return nothing
  const groupSt = groupState(focusGroup)
  const modalClasses = { 'kanban-detail-modal': true, 'has-conflict': groupSt.hasConflict }
  if (!groupSt.hasConflict && groupSt.commonColor) modalClasses[`mark-${groupSt.commonColor}`] = true
  // The dim sibling is a separate layer (its own view-transition-
  // name) so its opacity fade doesn't drag the modal's clip-path
  // animation with it. The modal animates by clip alone (no opacity
  // shift), keeping its background + border at full alpha throughout
  // the morph between the source card and the centered modal box.
  return html`<div class="kanban-detail-backdrop">
    <div class="kanban-detail-dim"></div>
    <div class=${classMap(modalClasses)} role="dialog" aria-modal="true">
      <button
        type="button"
        class="kanban-detail-close"
        title="Close details"
        aria-label="Close details"
      >×</button>
      <div class="kanban-detail-body">
        ${findingCardPlaceholder(focusGroup, false, 'kanban-detail')}
      </div>
    </div>
  </div>`
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
      ? [...filtered].toSorted((a, b) => {
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
  if (state.viewMode === 'focus') {
    // Focus view: one centered <finding-card> in the main pane, with
    // a vertical "up next" queue of compact kanban-style cards on
    // the right. The same filter pipeline (state.shownTriage +
    // toolbar filters) feeds the queue, so the user can narrow what
    // they're working through with the regular toolbar controls.
    //
    // Selection rules:
    //   - `state.focusGid` matches a group still in the filtered
    //     list  → that group is focused (the explicit pick path:
    //     click in the sidebar, arrow-key navigation, prior-
    //     session leftover when the user returns to the focus view).
    //   - Otherwise fall back to the previous render's index
    //     (clamped to the new list). After a triage on the centered
    //     finding, the previous index now points to the item that
    //     shifted up into its slot — keeping the queue moving
    //     forward instead of teleporting back to position 0.
    // The fallback is read-only here; events.js / render() don't
    // write `state.focusGid` back to the auto-picked group's gid,
    // so the user's last-explicit pick can re-surface if the
    // filter reverts to a set that still contains it.
    if (filtered.length === 0) return nothing
    let focusedIdx = state.focusGid
      ? filtered.findIndex((g) => groupKey(g) === state.focusGid)
      : -1
    if (focusedIdx < 0) {
      // Stale focusGid (never set, OR the focused finding fell out of
      // view via a triage action / filter tightening) → fall back to
      // the previous render's index, clamped (see Selection rules).
      focusedIdx = Math.min(prevFocusedIdx, filtered.length - 1)
      if (focusedIdx < 0) focusedIdx = 0
    }
    prevFocusedIdx = focusedIdx
    const focused = filtered[focusedIdx]
    // Lazy bundle-source fetch for the inline Code panel. Returns
    // `null` when this finding has no bundle code reference,
    // `{ loading: true }` while the first load is in flight (the
    // load triggers render() on settle), or the resolved
    // `{ content, file, line, highlighted }` once ready.
    // The `focusCodeTick` read subscribes any observer-util-tracked
    // ancestor to the cache's settle events so the DOM picks up
    // the new content on the same frame.
    void state.focusCodeTick
    const code = getFocusCode(focused)
    const mainClass = code ? 'focus-main with-code' : 'focus-main'
    const atStart = focusedIdx === 0
    const atEnd = focusedIdx === filtered.length - 1
    return html`<div class="focus-view">
      <div class=${mainClass}>
        <div class="focus-pane focus-pane-card">
          <div class="focus-card-wrapper">
            ${findingCardPlaceholder(focused, false, 'focus')}
          </div>
        </div>
        ${code ? html`<div class="focus-pane focus-pane-code">
          ${code.loading
            ? html`<div class="focus-code-empty">Loading source…</div>`
            : html`<header class="focus-code-bar" title=${code.file}>
                <span class="focus-code-file">${code.file}</span>
                ${code.line ? html`<span class="focus-code-line">:${code.line}</span>` : nothing}
              </header>
              <div class="focus-code-body">${focusCodeLinesTemplate(code)}</div>`}
        </div>` : nothing}
      </div>
      <aside class="focus-sidebar" aria-label="Up next">
        <!-- Sidebar header carries both the queue's label and the
             prev / counter / next controls (consolidated here so the
             position counter and "Up next" count don't duplicate).
             Buttons also respond to ←/→ via the events.js keydown
             handler. -->
        <div class="focus-sidebar-header">
          <span class="label">Up next</span>
          <div class="focus-nav">
            <button
              type="button"
              class="focus-nav-btn"
              data-focus-nav="prev"
              ?disabled=${atStart}
              title="Previous finding (←)"
              aria-label="Previous finding"
            ><svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M10 3 5 8l5 5"/>
            </svg></button>
            <span class="count">${focusedIdx + 1} / ${filtered.length}</span>
            <button
              type="button"
              class="focus-nav-btn"
              data-focus-nav="next"
              ?disabled=${atEnd}
              title="Next finding (→)"
              aria-label="Next finding"
            ><svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M6 3 11 8l-5 5"/>
            </svg></button>
          </div>
        </div>
        <div class="focus-sidebar-body">
          ${repeat(filtered, (g) => groupKey(g), (g) => kanbanCardTemplate(g, {
            variant: 'focus',
            active: groupKey(g) === groupKey(focused),
          }))}
        </div>
      </aside>
    </div>`
  }
  if (state.viewMode === 'kanban') {
    // Status board: one column per triage bucket. Each filtered
    // group lands in exactly one column based on `groupState(g)
    // .commonTriage` — null = the Active column (live, untriaged).
    // The kanban view intentionally bypasses `state.shownTriage`
    // (handled by the caller) so every column is populated from
    // the same filter-respecting input set.
    //
    // Cards are intentionally compact (badge + one-line title +
    // file:line), so a column holds many at a glance. Clicking a
    // card opens a centered popover with the full `<finding-card>`
    // for the same group — the entry point for triage actions,
    // tabs, and comments while the column itself stays uncluttered.
    // Drag-and-drop ([data-kanban-source] / [data-kanban-target])
    // moves the card between status columns; the handler lives in
    // events.js.
    const columns = [
      { key: 'untriaged',  label: 'Untriaged',   target: 'untriaged' },
      { key: 'inprogress', label: 'In progress', target: 'inprogress' },
      { key: 'fixed',      label: 'Fixed',       target: 'fixed' },
      { key: 'invalid',    label: 'Invalid',     target: 'invalid' },
      { key: 'deleted',    label: 'Deleted',     target: 'deleted' },
      { key: 'ignored',    label: 'Ignored',     target: 'ignored' },
    ]
    const buckets = new Map(columns.map((c) => [c.key, []]))
    for (const g of filtered) {
      const t = groupState(g).commonTriage
      const key = t ?? 'untriaged'
      const slot = buckets.get(key)
      if (slot) slot.push(g)
    }
    // Surface the focused group's details modal in the same body
    // template so the popover's lifecycle is bound to the kanban
    // view's lifecycle; switching to a different view-mode unmounts
    // it. The render() caller wraps state.kanbanPopoverGid mutations
    // in `document.startViewTransition` so the modal scales in / out.
    const focusGroup = state.kanbanPopoverGid
      ? filtered.find((g) => groupKey(g) === state.kanbanPopoverGid)
      : null
    return html`<div class="kanban-board">
      ${repeat(columns, (c) => c.key, (c) => {
        const items = buckets.get(c.key)
        return html`<div
          class=${`kanban-column kanban-column-${c.key}`}
          data-kanban-target=${c.target}
        >
          <div class="kanban-column-header">
            <span class="label">${c.label}</span>
            <span class="count">${items.length}</span>
          </div>
          <div class="kanban-column-body">
            ${items.length === 0
              ? html`<div class="kanban-empty">No ${c.label.toLowerCase()} findings.</div>`
              : repeat(items, (g) => groupKey(g), (g) => kanbanCardTemplate(g, {
                  active: groupKey(g) === state.kanbanPopoverGid,
                }))}
          </div>
        </div>`
      })}
    </div>
    ${kanbanDetailTemplate(focusGroup)}`
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
    const fileKeys = state.sortBy === 'file' ? [...byFile.keys()].toSorted() : [...byFile.keys()]
    return html`${repeat(fileKeys, (file) => file, (file) => {
      const items = state.sortBy === 'file'
        ? byFile.get(file).toSorted((a, b) => parseInt(primaryTab(a).line, 10) - parseInt(primaryTab(b).line, 10))
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
          <span>${fileLink(file, probe?.repo?.github, probe?._repoFallback ?? state.repoUrl)}</span>
          <span class="count">${items.length}</span>
        </div>
        <div class="file-body">${repeat(items, (g) => findingCardGid(g), (g) => findingCardPlaceholder(g))}</div>
      </div>`
    })}`
  }
  // Flat mode: each dedup group renders inside its own card
  // (.flat-group) with a small location header on top
  // (file · line · exportName). For the 'file' sort we extend that
  // ordering with line-within-file, which the file-grouped path
  // achieves by sorting per-file.
  const items = state.sortBy === 'file'
    ? [...filtered].toSorted((a, b) => {
      const pa = primaryTab(a), pb = primaryTab(b)
      return pa.file.localeCompare(pb.file) || parseInt(pa.line, 10) - parseInt(pb.line, 10)
    })
    : filtered
  // Each group's location header carries the FULL line row (file +
  // line + exportName + run-meta) for the active tab. The in-body
  // line-row inside the card is hidden by `:host([in-group])
  // .line-row` in view/finding-card.css so the same info doesn't
  // appear twice. Tab switches re-render, so the header tracks the
  // active tab automatically. The print sheet flips both rules
  // around when the group has duplicates (.multi-case) — see
  // styles/print.css and finding-card.css's @media print block.
  return html`${repeat(items, (g) => findingCardGid(g), (g) => {
    const p = activeTabFor(g)
    const lineLinkTpl = lineLink(p.file, p.line, p.repo?.github, p._repoFallback ?? state.repoUrl)
    const meta = formatRunMeta(p)
    const displayName = findingDisplayName(p)
    const multiCase = g.length > 1
    return html`<div class=${classMap({ 'flat-group': true, 'multi-case': multiCase })}>
      <div class="flat-group-loc">
        <span class="file">${fileLink(p.file, p.repo?.github, p._repoFallback ?? state.repoUrl)}</span>
        ${lineLinkTpl === nothing ? nothing : html`<span class="line-num">${lineLinkTpl}</span>`}
        ${displayName ? html`<span class="meta">${displayName}</span>` : nothing}
        ${meta ? html`<span class="run-meta">${meta}</span>` : nothing}
      </div>
      ${findingCardPlaceholder(g, true)}
    </div>`
  })}`
}

// Cross-report packages view — `renderPackagesView` and its internal
// helpers live in `./render-packages.js` (they touch no findings-tab
// state); the orchestrator below dispatches into it for
// `state.currentView === 'packages'`.

// Bundle source viewer overlay — rendered into a top-level slot
// (see index.html) so it can pop over any view: bundles list,
// findings table, packages, repositories. The finding-card's
// `[Code]` shortcut piggybacks on this — set
// `state.bundleSourceFile` + load `state.bundleDetails`, render
// runs, and the overlay picks it up. Keeping the slot outside
// `#report` means the modal survives the report's `innerHTML`
// rebuilds the dispatch branches do.
function mountBundleSourceOverlay() {
  const slot = document.querySelector('#bundle-source-overlay-slot')
  if (slot) litRender(renderBundleSourceModal(), slot)
}

// Wraps a real view switch in `document.startViewTransition` for a
// crossfade. In-place re-renders ('findings' with new filters)
// stay synchronous so callers that read the new DOM right after
// `render()` returns keep working. The initial paint isn't
// animated (`prev` is null on first call).
let prevPaintedView = null

export function render() {
  const prev = prevPaintedView
  prevPaintedView = state.currentView
  const viewChanged = prev !== null && prev !== state.currentView
  if (
    viewChanged &&
    typeof document.startViewTransition === 'function' &&
    !matchMedia('(prefers-reduced-motion: reduce)').matches
  ) {
    document.startViewTransition(() => renderImpl())
    return
  }
  renderImpl()
}

function renderImpl() {
  mountBundleSourceOverlay()
  // Recompute the active deps dir before any helper consults it
  // (isModule / packageOf / stripPackagePrefix / pkgRelative). The
  // detection scans paths in the loaded reports + tree blobs to
  // pick `node_modules` (preferred when present) vs `dependencies`
  // (fallback). Once per render is enough — every helper call below
  // sees the freshly chosen dir.
  configureDepsDir(state.reports)
  // Print-button body class is owned by an observer-util autorun (see
  // view/print-btn-visibility.js) — render() must not touch it.
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
      let slot = document.querySelector('#bundles-slot')
      if (!slot || !report.contains(slot) || report.firstElementChild !== slot) {
        report.innerHTML = '<div id="bundles-slot"></div>'
        slot = document.querySelector('#bundles-slot')
      }
      if (slot) litRender(renderBundlesList(state.bundles), slot)
      // Bundle graph tab — populate the slot emitted by
      // `renderBundleSlide`'s `choose(tab, ...)` ladder (in
      // render-bundle.js) with the same renderGraph2Layout the
      // findings tab uses, fed bundle-synthesised graph data. The
      // two refresh helpers fill the right-panel slots; attaching
      // the canvas wires hover / click / pan / zoom onto the new
      // DOM.
      if (
        state.selectedBundle &&
        state.bundleDetailsTab === 'graph' &&
        state.bundleDetails &&
        (state.bundleDetails.json || state.bundleDetails.bundle)
      ) {
        const graphSlot = document.querySelector('#bundle-graph-slot')
        if (graphSlot) {
          const prep = buildBundleGraphData(state.bundleDetails)
          if (prep) {
            setCurrentBundleGraphPrep(prep)
            // Hide the "All files" toggle when the bundle has no
            // edges to walk (sourcemaps don't carry import info,
            // so the toggle would have nothing to filter against).
            const hideAllFiles = !prep.hasEdges
            const triageCounts = countBundleTriageBuckets(state.bundleDetails)
            // The triage selector inside the bundle graph topbar
            // reads `state.shownTriage` directly (via
            // `<triage-selector>`); the bundle path always uses the
            // 4-bucket form (no `ignored` — that's a per-report
            // concern).
            const options = {
              hideAllFiles,
              triageCounts,
              triageStates: ['inprogress', 'fixed', 'invalid', 'deleted'],
            }
            // First open of the graph tab triggers the dynamic
            // import of `ui/graph.js` (LitElement + ~37 KB shadow
            // CSS + canvas.js); subsequent opens are a no-op
            // module-cache hit. attachGraphLayout owns the
            // post-load sequence: render the host, await its first
            // shadow update, fire the refresh helpers + wire the
            // canvas interaction.
            attachGraphLayout(graphSlot, prep, options,
              refreshBundleGraphSidebar, refreshBundleGraphTopPkgs)
          }
        }
      }
      // Terminal tab — lazy-load `ui/terminal.js` into the slot.
      // The attach helper is idempotent for the same bundle
      // (matched by `integrity`), so flipping tabs in and out
      // preserves the running shell session.
      if (
        state.selectedBundle &&
        state.bundleDetailsTab === 'terminal' &&
        state.bundleDetails &&
        (state.bundleDetails.json || state.bundleDetails.bundle)
      ) {
        const terminalSlot = document.querySelector('#bundle-terminal-slot')
        if (terminalSlot) attachTerminal(terminalSlot, state.bundleDetails)
      }
      report.classList.add('active')
      dropZone.classList.add('hidden')
      document.title = 'DeepView — bundles'
      return
    }
  }
  // Packages view — cross-report aggregation by package, fed by
  // the OPFS-wide finding index (bundle-finding-index.js). Doesn't
  // depend on state.reports — works the moment any report has
  // landed in OPFS, even if it isn't the currently-loaded one.
  if (state.currentView === 'packages') {
    let slot = document.querySelector('#packages-slot')
    if (!slot || !report.contains(slot) || report.firstElementChild !== slot) {
      report.innerHTML = '<div id="packages-slot"></div>'
      slot = document.querySelector('#packages-slot')
    }
    if (slot) litRender(renderPackagesView(), slot)
    report.classList.add('active')
    dropZone.classList.add('hidden')
    document.title = 'DeepView — packages'
    return
  }
  // Repositories view — same pattern as Packages (cross-report
  // aggregation from the OPFS-wide finding index, no dependency
  // on state.reports). Reuses the `packages-slot` shape via the
  // shared `.packages-view` chrome the render-repositories.js
  // module emits.
  if (state.currentView === 'repositories') {
    let slot = document.querySelector('#repositories-slot')
    if (!slot || !report.contains(slot) || report.firstElementChild !== slot) {
      report.innerHTML = '<div id="repositories-slot"></div>'
      slot = document.querySelector('#repositories-slot')
    }
    if (slot) litRender(renderRepositoriesView(), slot)
    report.classList.add('active')
    dropZone.classList.add('hidden')
    document.title = 'DeepView — repositories'
    return
  }
  if (state.reports.length === 0) return
  // Merge across all loaded reports. Every entry is a Finding[] (a dedup
  // group); single findings were wrapped at ingest, so downstream code
  // doesn't branch on shape. The trash-view split happens here, not in
  // applyFilters, so the "X of Y" counter and severity stats reflect
  // the set currently being viewed (live groups, or the trash).
  const mergedGroups = getMergedGroups()
  // Per-bucket counts drive the toolbar's triage-state segmented
  // selector. Conflict groups stay in the "live" bucket (their
  // commonTriage is null) regardless of which states their member
  // tabs carry — matching the original behaviour.
  const triageCounts = { inprogress: 0, fixed: 0, invalid: 0, deleted: 0, ignored: 0 }
  for (const g of mergedGroups) {
    const t = groupState(g).commonTriage
    if (t) triageCounts[t]++
  }
  // Kanban view shows every triage bucket as a column, so it
  // ignores the shownTriage single-bucket filter entirely; every
  // other view-mode (table / list / grouped / graph) honours it.
  const isKanban = state.viewMode === 'kanban'
  const allGroups = isKanban
    ? mergedGroups
    : mergedGroups.filter((g) => groupState(g).commonTriage === state.shownTriage)
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
    const cols = new Set(g.map((f) => state.triage.get(tabKey(f))?.color ?? 'none'))
    for (const c of cols) colorCounts[c] = (colorCounts[c] || 0) + 1
  }

  // Per-render applicability flags. The toolbar hides controls the
   // user can't act on usefully, and the underlying filter state is
   // forced back to its no-op value so a previously-set filter from
   // a prior report can't keep findings hidden silently. Stats /
   // sorting / include-exclude always make sense, so no flags for
   // those.
  // The slider is safe to show only when every finding on screen has
  // a defined spot on the 0–10 scale: either a real `confidence`, or
  // the `critical: true` flag (the boolean — NOT severity 'critical')
  // that matchesFilters treats as confidence=10, so it clears any min
  // floor and is never silently dropped. Anything else (no confidence
  // and not critical) vanishes the moment the user lifts min off 0,
  // so a single such finding blocks the slider for the whole set — a
  // workspace merge of mixed analyzers (one analyzer-native report
  // with confidence + one DeepSec / Claude Security import without)
  // stays gated for exactly that reason. The test is per-finding, not
  // per-report: `critical` varies finding-to-finding, so a lone
  // critical finding must not vouch for unscored, non-critical
  // neighbours that would still be dropped.
  //
  // `allGroups` is already the on-screen set — the current
  // state.shownTriage bucket on every layout but kanban (which shows
  // all buckets at once) — so the gate is status-aware for free:
  // viewing Untriaged with every untriaged finding scored shows the
  // slider even when hidden buckets (fixed / ignored) hold unscored
  // ones.
  const hasAnyConfidence = allGroups.length > 0
    && allGroups.every((g) => g.every((f) => f.confidence !== undefined || f.critical === true))
  const hasAnyPriority = mergedGroups.some((g) => g.some((f) => f.priority !== undefined))
  const hasAnyModulesPath = mergedGroups.some((g) => g.some((f) => isModule(f.file)))
  // File sort is only meaningful across multiple files — a single-file
  // dataset would have nothing to reorder at the file level, so drop
  // the option from the dropdown and guard against a stale selection
  // below (matches the confidence / priority drops).
  const findingFiles = new Set()
  for (const g of mergedGroups) for (const f of g) findingFiles.add(f.file)
  const hasMultipleFiles = findingFiles.size > 1
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
  // Distinct analyzers across the loaded reports — feeds the
  // toolbar's analyzer dropdown. Built from mergedGroups (not the
  // shownTriage-filtered allGroups) so the option list stays stable
  // when the user flips between live and trash views. Sorted for a
  // stable display order: known source-marked imports first (in
  // ANALYZER_LABELS' order), the null sentinel last, the rest
  // alphabetical between them.
  const analyzerSet = new Set()
  for (const g of mergedGroups) {
    for (const f of g) analyzerSet.add(f._analyzer ?? null)
  }
  const knownOrder = Object.keys(ANALYZER_LABELS)
  const analyzerOptions = [...analyzerSet].toSorted((a, b) => {
    const ai = a == null ? Infinity : (knownOrder.indexOf(a) === -1 ? knownOrder.length : knownOrder.indexOf(a))
    const bi = b == null ? Infinity : (knownOrder.indexOf(b) === -1 ? knownOrder.length : knownOrder.indexOf(b))
    if (ai !== bi) return ai - bi
    return String(a ?? '').localeCompare(String(b ?? ''))
  })
  // If the previously-selected analyzer is no longer present (report
  // unload / workspace switch), clear the filter so a stale
  // selection can't silently empty the list. Matches the same
  // guard pattern used for source / confidence / sort below.
  if (state.filterAnalyzer) {
    const want = state.filterAnalyzer === NULL_ANALYZER_SENTINEL ? null : state.filterAnalyzer
    if (!analyzerSet.has(want)) state.filterAnalyzer = ''
  }
  // Distinct repos across the loaded reports — feeds the workspace
  // view's repo dropdown. Same shape as the analyzer set above: built
  // from mergedGroups (not allGroups) so the option list stays stable
  // when the user flips between live and trash views. `null` (no
  // derivable repo for the finding) becomes a synthetic "(no repo)"
  // option in the dropdown via NO_REPO_SENTINEL — picked over the
  // bare word `'null'` so a legitimate repo slug literally named
  // "null" stays distinguishable. Sorted alphabetically with the
  // null bucket pinned last.
  const repoSet = new Set()
  for (const g of mergedGroups) {
    for (const f of g) repoSet.add(repoOfFinding(f))
  }
  const repoOptions = [...repoSet].toSorted((a, b) => {
    if (a == null && b == null) return 0
    if (a == null) return 1
    if (b == null) return -1
    return a.localeCompare(b)
  })
  // Same stale-clear guard as analyzer above — a workspace switch
  // can drop the previously-selected repo from the option list.
  if (state.filterRepo) {
    const want = state.filterRepo === NO_REPO_SENTINEL ? null : state.filterRepo
    if (!repoSet.has(want)) state.filterRepo = ''
  }
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
  if (!hasMultipleFiles && state.sortBy === 'file') state.sortBy = 'severity'

  const filtered = applySorting(applyFilters(allGroups))

  // Two top-level views: the default `findings` (table / list /
  // grouped / graph view-modes — chrome owned by render() below)
  // and `files` (per-file tree, reached via the page-header Files
  // toggle). Files is gated on a tree-bearing report with >1 file;
  // a single-file tree adds no navigation value. Stale state on a
  // report swap (or workspace switch) auto-falls back to findings.
  // `treeData` merges across every loaded report so a workspace
  // with N reports surfaces the union of their files / edges —
  // matches the findings merge above and the canvas merge inside
  // buildGraph2Data.
  const treeData = mergeReportsTree(state.reports)
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
    let fHeader = document.querySelector('#header-slot')
    let treeSlot = document.querySelector('#tree-view-slot')
    if (!fHeader || !treeSlot || !report.contains(fHeader) || !report.contains(treeSlot)) {
      report.innerHTML = '<div id="header-slot"></div><div id="tree-view-slot"></div>'
      fHeader = document.querySelector('#header-slot')
      treeSlot = document.querySelector('#tree-view-slot')
    }
    if (fHeader) litRender(headerTpl, fHeader)
    if (treeSlot) litRender(renderTreeView(treeData, findingCounts), treeSlot)
    report.classList.add('active')
    dropZone.classList.add('hidden')
    document.title = `DeepView — ${typeLabel || 'no analyzer'}`
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
  if (isKanban) wrapperClass += ' with-kanban'
  if (state.viewMode === 'focus') wrapperClass += ' with-focus'

  let toolbarTpl = nothing
  let emptyStateTpl = nothing
  let bodyTemplate = nothing

  if (!renderGraphInBody) {
    toolbarTpl = toolbarTemplate(filtered.length, allGroups.length, triageCounts, counts, colorCounts, {
      showSource: hasAnyModulesPath,
      showConfidence: hasAnyConfidence,
      showPriority: hasAnyPriority,
      showGraphMode: treeAvailable,
      showFileSort: hasMultipleFiles,
      kanbanMode: isKanban,
      // Repo dropdown is workspace-only — single-file mode usually
      // has exactly one repo, so the dropdown would either be empty
      // or single-option, and the per-finding repo URL already
      // shows on the header chip. Workspace merges (multiple
      // reports stacked into one view) are where the user benefits
      // from narrowing to a single repo.
      showRepo: !!state.currentWorkspace,
    }, analyzerOptions, repoOptions)

    // Empty-state line — slot-based so the typeLabel (which can carry
    // user-controlled analyzer-type strings) flows through Lit's
    // auto-escape rather than a hand-rolled `esc()`. Empty template
    // when none of the empty-state branches matches.
    //
    // The last branch splits on whether the report contained any
    // findings at all: an empty report reads as "No X issues found"
    // (clean baseline), but a report whose findings have all been
    // moved to a triage bucket reads as "All X issues triaged" so
    // the user knows they cleared the queue rather than mistaking it
    // for a no-op load.
    if (state.shownTriage && allGroups.length === 0) {
      emptyStateTpl = html`<p style="color:var(--muted); margin: 1rem 0;">No ${state.shownTriage} findings.</p>`
    } else if (filtered.length === 0 && allGroups.length > 0) {
      emptyStateTpl = html`<p style="color:var(--muted); margin: 1rem 0;">No findings match the current filters.</p>`
    } else if (allGroups.length === 0) {
      emptyStateTpl = mergedGroups.length > 0
        ? html`<p style="color:var(--green)">All ${typeLabel} issues triaged.</p>`
        : html`<p style="color:var(--green)">No ${typeLabel} issues found.</p>`
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
  // Track whether we tore the table out of bodySlot — the slot's
  // Lit part-cache still references the now-orphaned `.finding-table-slot`
  // marker (replaceWith'd by the persistent table on the previous
  // render). Lit can't safely diff against that stale tree, so the
  // bodySlot recreate below uses this flag to drop the cache even
  // when this render isn't going back into the table view.
  const detachedPersistentTable = !!(persistentFindingTable && persistentFindingTable.isConnected)
  if (detachedPersistentTable) {
    persistentFindingTable.remove()
  }

  // Slot-reuse: only rebuild the chrome when the structure
  // actually changes (cross-view entry, or switching between
  // graph mode and non-graph mode — the slot set differs). Inside
  // a stable shape, every render() is just litRender into existing
  // slots → Lit diffs in place, scroll / focus / persistent
  // <finding-table> all survive without manual capture-restore.
  let headerSlot = document.querySelector('#header-slot')
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
    headerSlot = document.querySelector('#header-slot')
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
  const toolbarSlot = document.querySelector('#toolbar-slot')
  if (toolbarSlot) litRender(toolbarTpl, toolbarSlot)
  const emptyStateSlot = document.querySelector('#empty-state-slot')
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
  // and can render the body empty (or, when the previous render
  // had a selection-details aside whose `<finding-card>` ChildPart
  // committed primitive text, crashes inside `_commitText` because
  // the cached `_$startNode.nextSibling` was ejected with the
  // detached <finding-table>). Recreating bodySlot resets the
  // cache; we do it whenever we're about to render the table view
  // (pendingTableItems truthy) AND whenever we just detached a
  // previously-mounted persistent table (cache is poisoned even if
  // this render is going to nothing / list / grouped).
  let bodySlot = document.querySelector('#findings-body-slot')
  if (bodySlot && (pendingTableItems || detachedPersistentTable)) {
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
    const graphSlot = document.querySelector('#findings-graph-slot')
    if (graphSlot) {
      const viewModeRow = html`<view-mode-buttons
        modes="table,list,grouped,focus,kanban,graph"
      ></view-mode-buttons>`
      // Triage bucket counts across every loaded report's groups —
      // the findings-tab graph's topbar uses this for its triage
      // selector (In progress / Fixed / Invalid / Deleted / Ignored).
      // Computed here (in the main bundle) rather than inside
      // `renderTopBar` so the lazy `ui/graph.js` bundle stays free
      // of `groupState` / `state` imports.
      const findingsTriageCounts = { inprogress: 0, fixed: 0, invalid: 0, deleted: 0, ignored: 0 }
      for (const g of getMergedGroups()) {
        const t = groupState(g).commonTriage
        if (t) findingsTriageCounts[t]++
      }
      const options = {
        extraTopRow: viewModeRow,
        triageCounts: findingsTriageCounts,
        triageStates: ['inprogress', 'fixed', 'invalid', 'deleted', 'ignored'],
      }
      // First open of the graph view-mode kicks the dynamic
      // import of `ui/graph.js`; subsequent opens reuse the
      // cached module. attachGraphLayout handles render → await
      // updateComplete → fire refresh helpers → wire canvas.
      // Slots are emitted empty by `<graph-layout>` — each refresh
      // helper runs its own `litRender` into the appropriate
      // shadow-DOM slot, so subsequent clicks diff against a
      // single Lit cache per slot.
      attachGraphLayout(graphSlot, g2DataForBody.prep, options,
        refreshGraph2Sidebar, refreshGraph2TopPkgs)
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
  document.title = `DeepView — ${typeLabel || 'no analyzer'}`
}
