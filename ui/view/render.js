import { html, render as litRender, nothing } from 'lit'
import { classMap } from 'lit/directives/class-map.js'
import { live } from 'lit/directives/live.js'
import { repeat } from 'lit/directives/repeat.js'
import { styleMap } from 'lit/directives/style-map.js'
import { unsafeHTML } from 'lit/directives/unsafe-html.js'
import { FILE_ICONS } from './file-display.js'
import { state } from '../../client/state.ts'
import { dropZone, report } from './dom.js'
import { SEVERITIES, configureDepsDir, fileLink, formatRunMeta, isModule, lineLink, prettyModel } from './format.js'
import { activeTabFor, groupKey, groupState, primaryTab, tabKey } from './group.js'
import { applyFilters, applySorting } from './filters.js'
import { findingCardGid } from './render-finding.js'
import { computeFindingCountsByFile, computeTransitiveCounts } from './graph/utils.js'
import { renderTreeView } from './graph/files.js'
import { graph2 } from './graph2/state.js'
import { buildGraph } from './graph2/data.js'
import { listWorkspaces } from '../../client/workspaces.js'
import { triageSync } from '../../client/triage-sync.ts'
import { isBundleInRemote, isInRemote, remoteCount } from './objstore-presence.js'
import { renderFocusOverlay, renderGraph2Layout, renderSelectionCard, renderTopPkgsBlock } from './graph2/render.js'
import { attachGraph2Interaction } from './graph2/canvas.js'
import { attachTerminal } from './terminal-attach.js'
import { fileHasFindings, packageOf } from './graph/utils.js'
import { renderPackagesView } from './render-packages.js'
import { renderRepositoriesView } from './render-repositories.js'
import {
  buildBundleGraphData,
  countBundleTriageBuckets,
  refreshBundleGraphSidebar,
  refreshBundleGraphTopPkgs,
  renderBundleSourceModal,
  renderBundlesList,
  setCurrentBundleGraph,
} from './render-bundle.js'

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
  const area = document.querySelector('#g2-selection-area')
  if (!area) return
  const data = buildGraph2Data()
  if (!data) return
  litRender(renderSelectionCard(data.graph), area)
  // The top-right canvas overlay (drill-in icon button) depends
  // on the same selection / solo / focus state the selection
  // card does, so refresh both from the same trigger. Slot
  // element is rendered unconditionally by renderStage; we just
  // swap its content via the same lit-managed update.
  const focusSlot = document.querySelector('#g2-focus-overlay-slot')
  if (focusSlot) litRender(renderFocusOverlay(data.graph), focusSlot)
}

// Re-render only the right-panel "Top packages" block. Called when
// the user flips the Issues/Files mini-tab. Same canvas-preserving
// pattern as refreshGraph2Sidebar — let `litRender` diff against
// its cached PartInfo on the container; manually clearing
// `innerHTML` would break the cache.
export function refreshGraph2TopPkgs() {
  const block = document.querySelector('#g2-top-pkgs-block')
  if (!block) return
  const data = buildGraph2Data()
  if (!data) return
  litRender(renderTopPkgsBlock(data.graph), block)
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

  const findings = state.reports.flatMap((r) => r.groups.flat())

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
        const tip = `${sevCounts[s]} ${s.replaceAll('_', ' ')}`
        return html`<span class=${`status-seg sev-${s}`} style=${styleMap({ flexGrow: sevCounts[s] })} title=${tip}></span>`
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
  //   cloud chunk — clickable iff cloudCount > intersection, i.e.
  //                 there's at least one remote-only entry to
  //                 download. We compute intersection as
  //                 (localCount − localOnly.length) which only
  //                 needs the sync `isInRemote` map.
  //   local chunk — clickable iff M > 0 (there's something to
  //                 upload).
  //
  // Hides entirely when both chunks would render empty (e.g. a
  // freshly-created workspace with no peers and no local
  // reports). Empty-workspace bug fix #4.
  //
  // Aggregate reports + bundles into a single badge: the user sees
  // one "N cloud / M local" pair in the header instead of two
  // side-by-side badges. The click handlers fan out to a unified
  // upload / download dialog that lists items of both kinds.
  //
  // `cloudCount` is just `remoteCount` (reports + bundles together
  // — `remoteCount` is the cardinality of remoteTags, which now
  // includes both kinds). The earlier split (`remoteCount -
  // remoteBundleCount + remoteBundleCount`) algebraically collapsed
  // to this; keeping the simpler form pins the relationship clearly.
  // The actual report-vs-bundle dispatch happens in
  // `openDownloadFromBadge`, which fans out both discovery passes
  // and assembles the unified dialog item list.
  const ws = listWorkspaces().find((w) => w.id === workspaceId)
  const localBundles = ws && Array.isArray(ws.bundles) ? ws.bundles : []
  const cloudCount = remoteCount(workspaceId)
  const localOnlyReports = fileNames.filter((n) => !isInRemote(workspaceId, n))
  const localOnlyBundles = localBundles.filter((i) => !isBundleInRemote(workspaceId, i))
  const localOnly = [
    ...localOnlyReports.map((n) => ({ kind: 'report', identifier: n })),
    ...localOnlyBundles.map((i) => ({ kind: 'bundle', identifier: i })),
  ]
  const reportIntersection = fileNames.length - localOnlyReports.length
  const bundleIntersection = localBundles.length - localOnlyBundles.length
  const intersection = reportIntersection + bundleIntersection
  const remoteOnlyCount = Math.max(0, cloudCount - intersection)
  // `remoteOnlyCount` is the authoritative count (derived from the
  // full HMAC-tag inventory). The click handler awaits
  // `discoverRemoteFileNames` to materialize the actual file
  // names before opening the download dialog — so we can drive
  // the badge straight off the HMAC count without waiting for
  // background `fetchByTag` discovery.
  if (cloudCount === 0 && localOnly.length === 0) return nothing
  const cloudClickable = remoteOnlyCount > 0
  const localClickable = localOnly.length > 0
  const wrapperTitle = [
    cloudCount > 0 ? `${cloudCount} in cloud` : null,
    localOnly.length > 0 ? `${localOnly.length} local-only` : null,
    remoteOnlyCount > 0 ? `click "cloud" to download ${remoteOnlyCount}` : null,
    localOnly.length > 0 ? `click "local" to upload ${localOnly.length}` : null,
  ].filter(Boolean).join(' — ')
  const cloudChunk = cloudCount === 0 ? nothing
    : cloudClickable
      ? html`<button
          type="button"
          class="sync-badge-chunk cloud"
          aria-label=${`${remoteOnlyCount} remote items not yet downloaded — open download dialog`}
          @click=${(e) => { e.stopPropagation(); openDownloadFromBadge({ workspaceId, localFileNames: fileNames, localBundles }) }}
        >${cloudIconTpl()}<span>${cloudCount} cloud</span></button>`
      : html`<span class="sync-badge-chunk cloud" aria-label=${`${cloudCount} items in remote`}>
          ${cloudIconTpl()}<span>${cloudCount} cloud</span>
        </span>`
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
    const { listBundles } = await import('../../client/storage.js')
    const meta = await listBundles()
    const labelByIntegrity = new Map(meta.map((b) => [b.integrity, b.name]))
    for (const item of bundleItems) {
      const name = labelByIntegrity.get(item.identifier)
      if (name) item.label = name
    }
  }
  const { openSyncUploadDialog } = await import('./sync-upload-dialog.js')
  await openSyncUploadDialog({ workspaceId, items })
}

async function openDownloadFromBadge({ workspaceId, localFileNames, localBundles }) {
  // Await the full background-discovery pass before opening the
  // dialog. The badge's clickable cloud-chunk count reflects the
  // full HMAC-tag inventory, while the synchronous remote-name /
  // remote-integrity getters only return what `fetchByTag` has
  // already resolved. If we passed the sync lists to the dialog, a
  // partially-decoded inventory would open with fewer entries than
  // the badge advertised — sometimes zero (review r3252019240).
  // `discoverRemote*` awaits every in-flight + queues any not-yet-
  // started discovery, returning the complete decoded set for each
  // kind.
  const {
    discoverRemoteBundleIntegrities,
    discoverRemoteFileNames,
    remoteBundleName,
  } = await import('./objstore-presence.js')
  const [remoteReports, remoteBundles] = await Promise.all([
    discoverRemoteFileNames(workspaceId),
    discoverRemoteBundleIntegrities(workspaceId),
  ])
  const localReportsSet = new Set(localFileNames)
  const localBundlesSet = new Set(localBundles)
  const items = [
    ...remoteReports
      .filter((n) => !localReportsSet.has(n))
      .map((n) => ({ kind: 'report', identifier: n })),
    ...remoteBundles
      .filter((i) => !localBundlesSet.has(i))
      .map((i) => {
        // The discovery worker stashed the user-friendly name when it
        // classified this integrity; surface it as the dialog label
        // so the user sees "my-app.js" instead of the sha512 prefix.
        const label = remoteBundleName(workspaceId, i)
        return label ? { kind: 'bundle', identifier: i, label } : { kind: 'bundle', identifier: i }
      }),
  ]
  const { openSyncDownloadDialog } = await import('./sync-download-dialog.js')
  await openSyncDownloadDialog({ workspaceId, items })
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
        class=${classMap({ 'triage-state-btn': true, [`triage-state-${s}`]: true, active })}
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
    class=${classMap({ 'source-chip': true, active: state.filterSources.has(value) })}
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
           padding than the generic toolbar select. The .sort-wrapper
           around it carries the custom chevron via ::after (pseudo-
           elements don't render on bare <select> in any browser). -->
      <span class="sort-wrapper">
        <select id="sort-select" class="sort-select" aria-label="Sort findings">
          ${sortOpt('severity', 'Severity ↓')}
          ${sortOpt('file', 'File ↑')}
          ${showConfidence ? html`${sortOpt('confidence-desc', 'Confidence ↓')}${sortOpt('confidence-asc', 'Confidence ↑')}` : nothing}
          ${showPriority ? html`${sortOpt('priority-desc', 'Priority ↓')}${sortOpt('priority-asc', 'Priority ↑')}` : nothing}
        </select>
      </span>
      ${showSource ? html`<div class="sep"></div>
        <div class="source-toggle" role="group" aria-label="Source filter">
          ${srcChip('own', 'Sources')}
          ${srcChip('modules', 'Dependencies')}
        </div>` : nothing}
      ${showConfidence ? html`<div class="sep"></div>
        <div class="conf-filter">
          <span class="conf-range-label">Confidence</span>
          <!-- Dual-thumb slider replaces the prior min / max select
               pair. Lower bound at 0 means "include findings without a
               confidence rating"; upper bound at 10 means "no upper cap
               (allow >10 outliers)" — both edges are how the user opts
               out of that half of the filter (see filters.js /
               matchesFilters). The conf-range-mirror element listens
               for range-input events from the slider and patches its
               own text during drag, so the toolbar doesn't re-render
               every tick. On release a range-change event triggers a
               full re-render and the property bindings here re-seed
               the mirror in sync. -->
          <range-slider
            id="conf-range" min="0" max="10" step="1"
            low=${state.filterConfMin}
            high=${state.filterConfMax}
            aria-label="Confidence range"></range-slider>
          <conf-range-mirror id="conf-range-vals" class="conf-vals" for="conf-range" .low=${state.filterConfMin} .high=${state.filterConfMax}></conf-range-mirror>
        </div>` : nothing}
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
            .value=${live(state.filterInclude)}
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
          <span>${fileLink(file, probe?.repo?.github, probe?._repoFallback)}</span>
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
  // line-row inside the .finding card is hidden (CSS rule under
  // `.flat-group .finding .line-row`) so the same info doesn't
  // appear twice. Tab switches re-render, so the header tracks the
  // active tab automatically.
  return html`${repeat(items, (g) => findingCardGid(g), (g) => {
    const p = activeTabFor(g)
    const lineLinkTpl = lineLink(p.file, p.line, p.repo?.github, p._repoFallback)
    const meta = formatRunMeta(p)
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

// Cross-report packages view — `renderPackagesView` plus its
// internal helpers (toolbar / triage selector / sorting / per-row
// + per-file rendering / details / overview / slide) live in
// `./render-packages.js`. The orchestrator below imports the
// entry point and dispatches into it for `state.currentView ===
// 'packages'`. They got lifted out because they touch no
// findings-tab state and read cleaner as a coherent neighbor.

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

export function render() {
  mountBundleSourceOverlay()
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
      let slot = document.querySelector('#bundles-slot')
      if (!slot || !report.contains(slot) || report.firstElementChild !== slot) {
        report.innerHTML = '<div id="bundles-slot"></div>'
        slot = document.querySelector('#bundles-slot')
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
        const graphSlot = document.querySelector('#bundle-graph-slot')
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
      // Terminal tab — lazy-load `ui/terminal.js` into the slot.
      // The attach helper is idempotent for the same bundle
      // (matched by `integrity`), so flipping tabs in and out
      // preserves the running shell session.
      if (
        state.selectedBundle &&
        state.bundleDetailsTab === 'terminal' &&
        state.bundleDetails &&
        state.bundleDetails.json
      ) {
        const terminalSlot = document.querySelector('#bundle-terminal-slot')
        if (terminalSlot) attachTerminal(terminalSlot, state.bundleDetails)
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
    let slot = document.querySelector('#packages-slot')
    if (!slot || !report.contains(slot) || report.firstElementChild !== slot) {
      report.innerHTML = '<div id="packages-slot"></div>'
      slot = document.querySelector('#packages-slot')
    }
    if (slot) litRender(renderPackagesView(), slot)
    report.classList.add('active')
    dropZone.classList.add('hidden')
    document.title = 'DeepView results — packages'
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
    document.title = 'DeepView results — repositories'
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
  const prev = document.querySelector(`#${inputId}`)
  const pos = prev ? prev.selectionStart : 0
  render()
  const el = document.querySelector(`#${inputId}`)
  if (el) { el.focus(); el.setSelectionRange(pos, pos) }
}
