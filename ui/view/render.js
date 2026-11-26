import { html, render as litRender, nothing } from 'lit'
import { literal, html as staticHtml } from 'lit/static-html.js'
import { classMap } from 'lit/directives/class-map.js'
import { repeat } from 'lit/directives/repeat.js'
import { styleMap } from './style-map.js'
import { appMarkup } from './markup.js'
import { FILE_ICONS, PRODUCER_LABELS, REPORT_LOGOS, findingBrand, displayName as reportDisplayName } from './file-display.js'
import { FOCUS_SPLIT_MAX, FOCUS_SPLIT_MIN, createManagedLocalImportSource, getKind, isManagedUiMode, listBundles, listWorkspaces, managedWorkspaceImportDeps, migrateLoadedIgnores, saveTriage, state } from '#client/index.js'
import { openLocalContentImportDialog, openLocalTriageImportDialog, openObjstoreRecoveryDialog, openSyncSuggestDialog, openSyncUploadDialog, openTriageComparisonDialog, openWorkspaceUnlockBundleDialog } from './lazy-dialogs.js'
// Up front, not in the dialogs' bundle (lazy-dialogs.js says why).
import { resolveTriageConflicts } from './dialogs/triage-conflict-dialog.js'
import { differingReports, isBundleInRemote, isInRemote, remoteCount, triageSync } from './client-sync.js'
import { installShadowTooltipListener } from './tooltip.js'
import { dropZone, replaceReport, report, reportSlot } from './dom.js'
import { SEVERITIES, canDropRevalidation, configureDependencyRepos, configureDepsDir, configureRevalidation, depsDirName, displayedSeverity, fileLink, findingDisplayName, findingTitle, formatRunMeta, hasSeverityCorrection, isHttpUrl, isModule, isRevalidation, lineLink, lineRangeLabel, reachableRevalidateFilters, revalidateKind, revalidationShown, stampUpstreamFindings } from './format.js'
import { activeTabFor, canEditTriage, canTriageFinding, clearMergedGroups, drawnTabs, findingRepoTarget, getMergedGroups, getRevalidationGroups, groupKey, groupState, primaryTab, triageEntry, triageScope, underlyingFindingsShown } from './group.js'
import { NO_REPO_SENTINEL, NULL_ANALYZER_SENTINEL, NULL_MODEL_SENTINEL, applyFilters, applyScopeFilters, applySorting, hasSecurityContrast, isAppStackedGroup, isCrossContextGroup, isUnrevalidatedGroup, modelOfFinding, priorityApplies, rangeApplies, repositoryFilterValues, runFilterValue, runFiltersOffered, scopeRows, shouldLockConfirmed } from './filters.js'
import { reportDuplicateIds } from './report-duplicates.js'
import { SOURCE_LABELS, revalidateKindOf } from '@preventive/report'
import { COMBO_FIELDS, buildAnalyzerTags } from './analyzer-tags.js'
import { COMMENT_ICON, FIX_ICON, FLAG_ICON, badgeLabel } from './render-finding.js'
import { computeFindingCountsByFile, computeTransitiveCounts, fileHasFindings, mergeReportsTree } from './file-counts.js'
import { renderTreeView } from './render-files.js'
import { automaticFixFor, cardLinkFor, managedIssueFor } from './managed-issues.js'
import { graph2 } from './graph/state.js'
import { attachGraphLayout, loadedGraphMod } from './graph-attach.js'
import { attachTerminal } from './terminal-attach.js'
import { ensureBundleSources } from './bundle-load.js'
import { bundleNeedsSources } from '../../common/bundle-metadata.js'
import { packageOf, reportOwnSourceFiles } from './graph/utils.js'
import { renderPackagesView } from './render-packages.js'
import { renderRepositoriesView } from './render-repositories.js'
import { renderLinksView } from './render-links.js'
import { closeLinksPreview, getLinksPreview } from './links-preview.js'
import { resolveWorkspaceContext, syncableMembers } from './sync-scope.js'
import {
  buildBundleGraphData,
  countBundleTriageBuckets,
  refreshBundleGraphSidebar,
  refreshBundleGraphTopPkgs,
  renderBundleSourceModal,
  renderBundlesList,
  renderDroppedLockfile,
  renderNpmOpening,
  renderRepositoryCodeOpening,
  setCurrentBundleGraphPrep,
} from './render-bundle.js'
import { focusCodeHistory, getFocusCode } from './focus-code.js'
import { sourceText } from './source-text.js'
import { createSyncSuggester } from './sync-suggest.js'
import { findingDetailGroup, managedFindingSelectionRoute } from './finding-selection.js'
import { managedHistory } from './managed-history.js'
import { npmPackageInput, renderNpmLookup } from './npm-package.js'
import { repositoryCodeName } from './repository-code.js'
import { canViewFindingHistory } from './finding-history.js'
import { filesButtonTemplate, renderWorkspaceContent, teamHeaderTemplate, triageLoadingTemplate, workspaceContent, workspaceContentButton, workspaceTitleTemplate } from './workspace-content.js'
import './team-dependencies.js'
import { createViewRenderer } from './render-transition.js'
import { loadManagedTrees } from './managed-trees.js'
import { managedDetailsFolded, managedDetailsLens, managedDetailsReplacing, managedDetailsWaiting } from './managed-details.js'
import { withCompare } from './compare-load.js'
import { NEXT_ICON, PREV_ICON } from './lit-icons.js'

// Bring the report pane up over the landing page.
function showReport() {
  report.classList.add('active')
  dropZone.classList.add('hidden')
}

// The graph's raw inputs for the loaded reports (`prep`: the lazy
// ui/graph.js builds the graph from it, keeping graph/data.js out of the
// main bundle), or null with no tree. Per-report trees merge, so a
// workspace canvas spans every report. Groups split by the triage tab on
// screen BEFORE counting, so layout, stats and chip counts follow the
// findings tab; package focus narrows the files to one package (their
// findings from outside it still count), and `graph2.showAll` keeps clean
// files.
function buildGraph2Data() {
  const treeData = mergeReportsTree(state.reports)
  if (!treeData) return null
  const visibleGroups = getMergedGroups().filter((g) => groupState(g).commonTriage === state.shownTriage)
  const findingCounts = computeFindingCountsByFile(visibleGroups, state.severityMode)
  const transitiveCounts = computeTransitiveCounts(treeData, findingCounts)
  // Per file, its findings' severities and mark colors (the chip counts and
  // the canvas dim predicate, with the findings filter's union semantics),
  // and each finding's pair, for Packages → Issues to count both at once.
  const severitySets = new Map()
  const colorSets = new Map()
  const fileFindings = new Map()
  const at = (map, file, make) => map.get(file) ?? map.set(file, make()).get(file)
  for (const g of visibleGroups) {
    for (const f of g) {
      const severity = displayedSeverity(f, state.severityMode)
      const color = triageEntry(f)?.color ?? 'none'
      at(severitySets, f.file, () => new Set()).add(severity)
      at(colorSets, f.file, () => new Set()).add(color)
      at(fileFindings, f.file, () => []).push({ severity, color })
    }
  }
  let files = Object.keys(treeData)
  if (graph2.focusedPkg) files = files.filter((f) => (packageOf(f) ?? '__own__') === graph2.focusedPkg)
  if (!graph2.showAll) files = files.filter((f) => fileHasFindings(f, findingCounts, transitiveCounts))
  return {
    treeData, files, ownCounts: findingCounts, transitiveCounts,
    severitySets, colorSets, fileFindings,
    ownSourceFiles: reportOwnSourceFiles(files),
  }
}

// Surgical refreshes of the open graph's panels (in the lazy module's
// shadow DOM), keeping the canvas and its rAF / hover state alive across a
// node click. No-ops when the graph was never opened this session.
export function refreshGraph2Sidebar() {
  const mod = loadedGraphMod()
  const prep = mod && buildGraph2Data()
  if (!prep) return
  const isBundleContext = state.currentView === 'bundles'
  mod.refreshSidebar(prep, { isBundleContext, findingsJump: !(isBundleContext && isManagedUiMode()) })
}

export function refreshGraph2TopPkgs() {
  const mod = loadedGraphMod()
  const prep = mod && buildGraph2Data()
  if (prep) mod.refreshTopPkgs(prep)
}

// The header's `<repo-chip>` (view/repo-chip.js): read-only for the repo
// every loaded report declares (ingest seeds each finding's
// `_repoFallback` with it, so nothing is left to type); none in managed
// mode, whose server owns the assignment; in a workspace, read-only for
// the repo every finding shares; otherwise editable where some non-module
// finding has no repo (`repoInputUseful`), else read-only for the shared one.
function repoChipTemplate(repoInputUseful, knownRepo, declaredRepo) {
  if (declaredRepo) return html`<repo-chip url=${declaredRepo}></repo-chip>`
  if (isManagedUiMode()) return nothing
  if (!state.currentWorkspace && repoInputUseful) {
    return html`<repo-chip url=${state.repoUrl} editable ?editing=${state.repoEditing} ?empty=${!state.repoUrl}></repo-chip>`
  }
  return knownRepo ? html`<repo-chip url=${knownRepo}></repo-chip>` : nothing
}

const MULTI_REPORT_STICKER = html`<svg class="file-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/></svg>`

// The page header. The title is the workspace's, else the producer's where
// every report names the same `source` (`Claude Security findings`, the
// report library's word), else `Findings`; beside it the file chip (a
// workspace's report count, or the branded click-to-copy filename), repo
// chip, Files toggle and sync badge. Under it: the count of EVERY loaded
// finding (trashed ones too, so it holds still as the trash toggles), a
// severity bar by each group's primary tab, and the run-meta tags.
function headerTemplate(mergedGroups, fileNames, repoInputUseful, knownRepo, treeFileCount) {
  const totalCount = mergedGroups.length
  const sources = new Set(state.reports.map((r) => r.source))
  const singleSource = sources.size === 1 ? [...sources][0] : null
  // A workspace deleted between switch and render falls through.
  const ws = state.currentWorkspace ? listWorkspaces().find((w) => w.id === state.currentWorkspace) : null
  const context = workspaceContent(state, ws ? [ws] : [], getKind)
  const titleText = ws ? `Workspace: ${ws.name}` : singleSource ? `${SOURCE_LABELS[singleSource] ?? singleSource} findings` : 'Findings'

  const names = context ? [] : fileNames.map(reportDisplayName)
  const fileChip = context ? workspaceContentButton(context, 'reports', state.currentView)
    : names.length === 1 ? html`<button type="button" class="file-chip" data-copy-report=${names[0]}>${appMarkup(FILE_ICONS[singleSource] ?? FILE_ICONS.default)}<span>${names[0]}</span></button>`
    : names.length > 1 ? html`<button type="button" class="file-chip" data-copy-report=${names.join('\n')}>${MULTI_REPORT_STICKER}<span>${names.length} reports</span></button>`
    : nothing

  const sevCounts = {}
  for (const g of mergedGroups) {
    const sev = displayedSeverity(primaryTab(g), state.severityMode)
    if (sev) sevCounts[sev] = (sevCounts[sev] || 0) + 1
  }
  const presentSevs = SEVERITIES.filter((s) => sevCounts[s] > 0)
  const statusBarTpl = presentSevs.length === 0 ? nothing : html`<span class="status-bar" aria-hidden="true">${presentSevs.map((s) =>
    html`<span class=${`status-seg sev-${s}`} style=${styleMap({ flexGrow: sevCounts[s] })} data-tooltip=${`${sevCounts[s]} ${s.replaceAll('_', ' ')}`}></span>`)}</span>`

  // A team's header is its tabs' (workspace-content.js), naming no
  // repository: its Repositories tab lists them all.
  if (context?.scope === 'team') return teamHeaderTemplate(context, state.currentView, { findings: totalCount, statusBar: statusBarTpl })

  // Analyzer and run metadata belong to individual reports.
  const stripTags = state.currentWorkspace ? [] : loadedAnalyzerTags(Boolean(singleSource))
  // A report-declared repo (`"repo": { "github": … }`, lifted at ingest)
  // speaks for the header only when every loaded report declares the same
  // one; a mixed load falls through to what the findings agree on.
  const declaredRepos = new Set(state.reports.map((r) => r.repo ?? null))
  const declaredRepo = declaredRepos.size === 1 ? [...declaredRepos][0] : null
  // The Files toggle is a report's alone: a workspace's Files opens from
  // its graph.
  const filesBtnTpl = context ? nothing : filesButtonTemplate(treeFileCount, state.currentView)

  return html`<header class="page-head">
    <div class="page-title">
      <h1>${context ? workspaceTitleTemplate(context, state.currentView) : titleText}${fileChip}${workspaceContentButton(context, 'bundles', state.currentView)}${repoChipTemplate(repoInputUseful, knownRepo, declaredRepo)}${filesBtnTpl}${syncBadgeTemplate()}</h1>
      <div class="meta-row">
        <span>${`${totalCount} finding${totalCount === 1 ? '' : 's'}`}</span>
        ${statusBarTpl}
        ${stripTags.length > 0 ? html`${SEP}${stripTags.map((t) => html`<span class="tag">${t}</span>`)}` : nothing}
      </div>
    </div>
  </header>`
}

const SEP = html`<span class="sep" aria-hidden="true"></span>`

// The "Reports out of sync" dialog the badge opens (once per workspace
// until reload — see sync-suggest.js).
const { suggestSync } = createSyncSuggester({ open: (names) => openSyncSuggestDialog({ names }) })

// Where the badge is drawn: the findings page header and the links view's.
// A defence against a third call site where the workspace means nothing.
const SYNC_BADGE_VIEWS = new Set(['findings', 'files', 'links'])

const SYNC_ICONS = {
  local: html`<svg class="sync-badge-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <rect x="2" y="14" width="20" height="8" rx="2" ry="2"/>
    <line x1="6" y1="18" x2="6.01" y2="18"/>
    <line x1="10" y1="18" x2="10.01" y2="18"/>
    <path d="M6 14V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v10"/>
  </svg>`,
  // Two opposed arrows — the local and cloud copies pulling apart.
  differ: html`<svg class="sync-badge-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M7 4v14"/><path d="M3 14l4 4 4-4"/>
    <path d="M17 20V6"/><path d="M13 10l4-4 4 4"/>
  </svg>`,
  cloud: html`<svg class="sync-badge-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M17.5 19a4.5 4.5 0 1 0-1-8.9A6 6 0 0 0 5.07 13.5 4 4 0 0 0 6 21h11.5z"/>
  </svg>`,
}

const differTip = (names) => names.length === 1
  ? `Your copy of "${names[0]}" doesn't match its cloud copy. Click to re-check and bring them in line.`
  : `${names.length} reports don't match their cloud copies. Click to re-check and bring them in line.`
const workspaceBundles = (ws) => ws && Array.isArray(ws.bundles) ? ws.bundles : []

// The sync-status badge in the title row, while sync is online
// (`triageSync.status`). A report opened alone from a workspace shows one
// chip: `differs`, `cloud`, or `local` (click to upload). A workspace shows
// up to three chunks, each only when non-zero:
//   - "N cloud": the full remote inventory, reports and bundles alike, so
//     the total shows while discovery is still naming them; it opens the
//     recovery dialog (re-check, repair, download what isn't local).
//   - "N differ": copies that may differ in a way sync can't settle by
//     itself, which would otherwise read as plain "cloud".
//   - "M local": members on this device the remote lacks, by the
//     synchronous `isInRemote`, so a peer's fresh upload doesn't flicker
//     in; it opens the upload dialog.
// Both counts zero hides it, but an empty workspace joined to a peer's
// chain still shows "N cloud" to pull their reports down.
function syncBadgeTemplate() {
  if (triageSync.status !== 'online' || !SYNC_BADGE_VIEWS.has(state.currentView)) return nothing
  const wsContext = resolveWorkspaceContext()
  if (!wsContext) return nothing
  const { workspaceId, fileNames, mode } = wsContext
  const differing = differingReports(workspaceId)
  const recheck = () => openRecheckFor(workspaceId, mode, fileNames)
  // Say it out loud once, too: a dialog offering to sync.
  if (differing.length > 0) suggestSync(workspaceId, differing, { onSync: recheck, retry: render })
  if (mode === 'single') {
    const name = fileNames[0]
    if (differing.includes(name)) return badgeChipButton({ status: 'differ', label: 'differs', title: differTip([name]), onClick: recheck })
    return isInRemote(workspaceId, name)
      ? badgeChipButton({ status: 'cloud', label: 'cloud', title: 'Synced to remote', onClick: null })
      : badgeChipButton({ status: 'local', label: 'local', title: 'Local only — click to upload',
        onClick: () => openUploadFromBadge({ workspaceId, items: [{ kind: 'report', identifier: name }] }) })
  }
  const localBundles = workspaceBundles(listWorkspaces().find((w) => w.id === workspaceId))
  const cloudCount = remoteCount(workspaceId)
  const localOnly = [
    ...fileNames.filter((n) => !isInRemote(workspaceId, n)).map((n) => ({ kind: 'report', identifier: n })),
    ...localBundles.filter((i) => !isBundleInRemote(workspaceId, i)).map((i) => ({ kind: 'bundle', identifier: i })),
  ]
  if (cloudCount === 0 && localOnly.length === 0) return nothing
  const wrapperTitle = [
    cloudCount > 0 ? `${cloudCount} in cloud` : null,
    localOnly.length > 0 ? `${localOnly.length} local-only` : null,
    differing.length > 0 ? `${differing.length} differ from the cloud` : null,
    cloudCount > 0 ? `click "cloud" to re-check storage` : null,
    localOnly.length > 0 ? `click "local" to upload ${localOnly.length}` : null,
  ].filter(Boolean).join(' — ')
  const chunk = (kind, text, label, onClick, tip = nothing) => html`<button
        type="button"
        class=${`sync-badge-chunk ${kind}`}
        data-tooltip=${tip}
        aria-label=${label}
        @click=${(e) => { e.stopPropagation(); onClick() }}
      >${SYNC_ICONS[kind]}<span>${text}</span></button>`
  const chunks = [
    cloudCount > 0 && chunk('cloud', `${cloudCount} cloud`, `re-check ${cloudCount} cloud object${cloudCount === 1 ? '' : 's'}`,
      () => openObjstoreRecoveryDialog({ workspaceId, cloudCount, localFileNames: fileNames, localBundles })),
    differing.length > 0 && chunk('differ', `${differing.length} differ`,
      `${differing.length} report${differing.length === 1 ? '' : 's'} differ from the cloud — re-check`, recheck, differTip(differing)),
    localOnly.length > 0 && chunk('local', `${localOnly.length} local`, `${localOnly.length} items not yet uploaded — open upload dialog`,
      () => openUploadFromBadge({ workspaceId, items: localOnly })),
  ].filter(Boolean)
  // A divider between each pair of chunks present.
  const divider = html`<span class="sync-badge-divider" aria-hidden="true"></span>`
  return html`<div
    class="report-sync-badge report-sync-badge-clickable"
    data-status="mixed"
    data-tooltip=${wrapperTitle}
  >${chunks.map((c, i) => (i === 0 ? c : html`${divider}${c}`))}</div>`
}

// The re-check the "differ(s)" signals open, already running. Given the
// workspace's members on this device: the dialog offers to download the
// remote reports NOT listed, so a single report's one-name list would
// wrongly offer all the others.
function openRecheckFor(workspaceId, mode, fileNames) {
  const ws = listWorkspaces().find((w) => w.id === workspaceId)
  const localFileNames = mode === 'single'
    ? syncableMembers(ws?.reports ?? [], state.storedFiles ?? [], fileNames)
    : fileNames
  return openObjstoreRecoveryDialog({ workspaceId, cloudCount: remoteCount(workspaceId), localFileNames, localBundles: workspaceBundles(ws), autoRun: true })
}

// A single report's chip: a `<button>` where clicking does something, else
// an informational `<span>`, out of the tab order like the workspace's
// non-clickable chunks.
function badgeChipButton({ status, label, title, onClick }) {
  const labelTpl = html`<span class="sync-badge-label">${label}</span>`
  if (typeof onClick !== 'function') {
    return html`<span
      class="report-sync-badge"
      data-status=${status}
      data-tooltip=${title}
      aria-label=${`report sync status: ${label}`}
    >${SYNC_ICONS[status]}${labelTpl}</span>`
  }
  return html`<button
    type="button"
    class="report-sync-badge report-sync-badge-clickable"
    data-status=${status}
    data-tooltip=${title}
    aria-label=${`report sync status: ${label}`}
    @click=${onClick}
  >${SYNC_ICONS[status]}${labelTpl}</button>`
}

// The upload dialog lists bundles by their sidebar names (from the bundle
// metadata), not the sha512 prefix it would fall back on.
async function openUploadFromBadge({ workspaceId, items }) {
  const bundleItems = items.filter((i) => i.kind === 'bundle')
  if (bundleItems.length > 0) {
    const labelByIntegrity = new Map((await listBundles()).map((b) => [b.integrity, b.name]))
    for (const item of bundleItems) {
      const name = labelByIntegrity.get(item.identifier)
      if (name) item.label = name
    }
  }
  await openSyncUploadDialog({ workspaceId, items })
}

// Whether a filter strip has anything to show: a non-zero count, or an
// active selection to clear. Gated here, not only in the components' own
// empty-set guards, so an empty one claims no flex `gap` slot.
const anyCount = (counts, selected) => Object.values(counts).some((n) => n > 0) || selected.size > 0

// The findings toolbar. Row one: view modes and sort, then the source,
// confidence / outcome and annotation filters, the triage selector, and at
// the end the export button, context filters and App lens. Row two: the
// severity lens and chips, analyzer and repo dropdowns, mark colors and
// the search with its "X of Y". Each control is offered only where it can
// do something (what renderImpl found of the set); the self-gating
// components (`<triage-selector>`, `<download-button>`) go in
// unconditionally.
function toolbarTemplate({ filteredCount, allCount, triageCounts, counts, colorCounts, analyzerSelect, repoOptions, showSource, hasAnyConfidence,
  hasAnyPriority, treeAvailable, hasMultipleFiles, isKanban, hasComment, hasIssue, hasFix, hasFlagged, hasDuplicates, hasCrossContext, hasAppStacked, showSecurity,
  hasCorrectedSeverity, revalidateOptions, showPartial, canDropLayer, canDetailLayer, canUpstreamLens, confirmedLocked }) {
  // Graph replaces the whole body with the graph2 canvas (see render()).
  const viewModes = treeAvailable ? 'kanban,focus,table,list,grouped,graph' : 'kanban,focus,table,list,grouped'
  // The confidence block shows for a range or an outcome to offer; an
  // unscored finding disables the range but leaves the outcome dropdown
  // usable (conf-filter.js). The App switch's stops: can-drop where taking
  // the layer off hands a ruled-out finding back, can-detail where the app
  // view folds rows or holds the partial line back; conflicts swap it for
  // an inspection button. A workspace's stacked reports are where
  // narrowing to one repo helps (a single report's repo is on the header
  // chip); the severity lens shows while a correction exists, or while
  // parked in 'original' so the reader can always flip back.
  return html`<div class="toolbar">
    <div class="toolbar-row">
      <view-mode-buttons modes=${viewModes}></view-mode-buttons>
      <findings-sort
        ?show-file=${hasMultipleFiles}
        ?show-confidence=${hasAnyConfidence}
        ?show-priority=${hasAnyPriority}
      ></findings-sort>
      ${showSource ? html`<source-filter></source-filter>` : nothing}
      ${!confirmedLocked && (hasAnyConfidence || revalidateOptions.length > 0)
        ? html`<conf-filter
            ?range-disabled=${!hasAnyConfidence}
            .revalidateOptions=${revalidateOptions}
            ?has-partial=${showPartial}
          ></conf-filter>`
        : nothing}
      ${hasComment || hasIssue || hasFix || hasFlagged || state.filterComment || state.filterIssue || state.filterFix || state.filterFlagged
        ? html`<annotation-filter .hasComment=${hasComment} .hasIssue=${hasIssue} .hasFix=${hasFix} .hasFlagged=${hasFlagged}></annotation-filter>`
        : nothing}
      ${isKanban ? nothing : html`<triage-selector .counts=${triageCounts}></triage-selector>`}
      <div class="toolbar-end">
        <download-button></download-button>
        ${(!state.currentWorkspace && (hasDuplicates || state.filterDuplicates)) || hasCrossContext || hasAppStacked || showSecurity || state.filterCrossContext || state.filterAppStacked
          ? html`<annotation-filter group="context" .hasDuplicates=${hasDuplicates} .hasCrossContext=${hasCrossContext} .hasAppStacked=${hasAppStacked} .hasSecurityContrast=${showSecurity}></annotation-filter>`
          : nothing}
        ${canDropLayer || state.revalidateConflicts.size > 0
          ? html`<revalidation-switch
              ?can-drop=${canDropLayer}
              ?can-detail=${canDetailLayer}
              ?can-upstream=${canUpstreamLens && canDropLayer}
              .upstreamDisabled=${state.showRevalidation === false && canDropLayer}
            ></revalidation-switch>`
          : nothing}
      </div>
    </div>
    <div class="toolbar-row sev-row">
      ${hasCorrectedSeverity || state.severityMode === 'original' ? html`<severity-mode-switch></severity-mode-switch>` : nothing}
      ${anyCount(counts, state.filterSeverities) ? html`<severity-chips .counts=${counts}></severity-chips>` : nothing}
      ${analyzerSelect.shown
        ? html`<analyzer-select
            .analyzers=${analyzerSelect.analyzers}
            .models=${analyzerSelect.models}
            .validationModels=${analyzerSelect.validationModels}
            .groups=${analyzerSelect.groups}
          ></analyzer-select>`
        : nothing}
      ${state.currentWorkspace && repoOptions.length > 1 ? html`<repo-filter .options=${repoOptions}></repo-filter>` : nothing}
      ${anyCount(colorCounts, state.filterColors) ? html`<triage-filter .counts=${colorCounts}></triage-filter>` : nothing}
      <div class="search-row">
        <toolbar-search kind="findings"></toolbar-search>
        <span class="result-count">${filteredCount} of ${allCount}</span>
      </div>
    </div>
  </div>`
}

// Sort dedup groups by a comparator over each group's primary tab, resolved
// once per group: primaryTab re-sorts a multi-tab group's tabs on every
// call, which dominated large-list renders inside a comparator.
function sortGroupsByPrimary(groups, cmp) {
  return groups
    .map((g) => ({ p: primaryTab(g), g }))
    .toSorted((a, b) => cmp(a.p, b.p))
    .map((x) => x.g)
}

// The flat layouts' order: under the 'file' sort, file → line, as the
// file-grouped layout reads (applySorting orders lines within a file only
// for the other sorts).
const flatOrder = (groups) => state.sortBy === 'file'
  ? sortGroupsByPrimary(groups, (pa, pb) => pa.file.localeCompare(pb.file) || parseInt(pa.line, 10) - parseInt(pb.line, 10))
  : groups

// The table body's sorted groups, for render() to hand the persistent
// <finding-table> once the slots land (a property keeps their identity).
let pendingTableItems = null

// The focus view's last index. A triage that drops the focused finding out
// of the list leaves `state.focusGid` matching nothing; the same index then
// lands on the finding that shifted up into its slot — the next one.
let prevFocusedIdx = 0

// The <finding-table>, kept across renders as a plain child of the body's
// static `.finding-table-slot` div, which Lit never touches: steady table
// renders diff around it while the table, its rows' reactivity and the
// list's scroll position survive. When a render drops the table view the
// slot goes and the table disconnects; this keeps it for the next one.
let persistentFindingTable = null

// One `<finding-card>` for a dedup group, the group a property: an
// unchanged group is a no-op, so the keyed `repeat`s leave its card alone.
// `data-gid` is what finding-link-nav.js finds a card by. `context`
// ('focus' / 'kanban-detail') reflects for the card's shadow CSS; `lazy`,
// for the list surfaces, builds its body only near the viewport
// (view/lazy-render.js); `popup` picks the modal's marker sizing and
// conflict outline.
function findingCardPlaceholder(g, { inGroup = false, context = null, lazy = false, popup = false } = {}) {
  return html`<finding-card
    data-gid=${groupKey(g)}
    .group=${g}
    ?in-group=${inGroup}
    context=${context ?? nothing}
    ?lazy=${lazy}
    ?popup=${popup}
  ></finding-card>`
}

// Corner brackets out / in for "give this the whole space" and "put the
// rest back", in the card action glyphs' 16-unit grid.
const EXPAND_ICON = html`<svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d="M6 2H2v4M10 2h4v4M14 10v4h-4M6 14H2v-4"/>
</svg>`
const COLLAPSE_ICON = html`<svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d="M6 2v4H2M10 2v4h4M10 14v-4h4M6 14v-4H2"/>
</svg>`

const SEVERITY_LETTERS = {
  critical:      'C',
  high:          'H',
  medium:        'M',
  low:           'L',
  high_bug:      'H',
  bug:           'B',
  informational: 'i',
}

// The compact card's variants, each with the click hook events.js listens
// for: the board's (`data-kanban-source`, draggable, opening the detail
// modal), the dialog rail's (`data-kanban-select`) and the focus queue's
// (`data-focus-select`), the last two sharing `.focus-side-card`'s look.
const CARD_LABELS = { 'kanban': 'Open details for', 'kanban-side': 'Show details for', 'focus': 'Focus on' }

// The compact card: a severity letter chip, the title and file:line; the
// full card opens in a modal. `active` (the focus queue's current card, or
// the board card whose modal is open) draws the accent ring, which tracks
// arrow-key navigation apart from DOM focus. The board hands over the
// rollup it bucketed the card by (`groupSt`); the rail asks for its own.
function kanbanCardTemplate(g, opts = {}) {
  const { variant = 'kanban', active = false, expandedTrackLast = false } = opts
  const groupSt = opts.groupSt ?? groupState(g)
  const activeTab = activeTabFor(g)
  const title = findingTitle(activeTab) || '(untitled finding)'
  const isKanban = variant === 'kanban'
  // The producer's mark, on board cards in a workspace only (the one board
  // that mixes analyzers), for a finding some other analyzer produced.
  const brand = isKanban && state.currentWorkspace ? findingBrand(activeTab) : null
  const classes = {
    'kanban-card': true,
    'has-conflict': groupSt.hasConflict,
    'focus-side-card': !isKanban,
    'kanban-expanded-track-last': expandedTrackLast,
    'active': active,
  }
  if (!groupSt.hasConflict && groupSt.commonColor) classes[`mark-${groupSt.commonColor}`] = true
  const lineNum = parseInt(activeTab.line, 10)
  const lineSuffix = Number.isFinite(lineNum) ? `:${lineNum}` : ''
  const kanbanSev = displayedSeverity(activeTab, state.severityMode)
  // `*` marks a corrected severity by shape, not color alone; the tooltip
  // and label spell out the original.
  const sevCorrected = hasSeverityCorrection(activeTab) && state.severityMode !== 'original'
  const activeEntry = triageEntry(activeTab)
  // The board card's one shortcut, a link winning over a comment
  // (cardLinkFor: the manual fix, else the issue's pull request, else its
  // duplicate, else the issue). A URL is a real link; a free-form fix or a
  // comment reuses `.mark-fix` / `.mark-comment`, so events.js's dialog
  // delegates pick the click up (the modal toggle skips `.kanban-action`).
  const fix = cardLinkFor(activeTab, activeEntry)
  const comment = activeEntry?.comment ?? ''
  let action = nothing
  if (isKanban && fix) {
    action = isHttpUrl(fix)
      ? html`<managed-fix-link class="kanban-action kanban-fix-link" compact .url=${fix}>${FIX_ICON}</managed-fix-link>`
      : canEditTriage(activeTab)
      ? html`<button type="button" class="kanban-action mark-fix" data-tooltip=${`Edit fix link: ${fix}`} aria-label=${`Edit fix link: ${fix}`}>${FIX_ICON}</button>`
      : html`<span class="kanban-action kanban-fix-note" role="img" data-tooltip=${`Fix: ${fix}`} aria-label=${`Fix: ${fix}`}>${FIX_ICON}</span>`
  } else if (isKanban && (comment || (isManagedUiMode() && canTriageFinding(activeTab)))) {
    // Managed subscriptions stay mounted before the first remote comment;
    // an empty preview hides itself.
    action = html`<comment-preview class="kanban-action" .finding=${activeTab} .comment=${comment}>${COMMENT_ICON}</comment-preview>`
  }
  const inner = html`<div class="kanban-badge-col">
      <span
        class=${`kanban-badge sev-${kanbanSev}`}
        data-tooltip=${sevCorrected ? `${badgeLabel(kanbanSev)} — corrected from ${badgeLabel(activeTab.severity)}` : nothing}
        aria-label=${sevCorrected ? `Severity ${badgeLabel(kanbanSev)}, corrected from ${badgeLabel(activeTab.severity)}` : `Severity ${badgeLabel(kanbanSev)}`}
      >${SEVERITY_LETTERS[kanbanSev] ?? '?'}${sevCorrected ? '*' : ''}</span>
      ${activeEntry?.flagged === true ? html`<span class="kanban-flag" aria-label="Flagged">${FLAG_ICON}</span>` : nothing}
      ${action}
    </div>
    <span class="kanban-title">${title}</span>
    <div class="kanban-meta">
      <span class="kanban-loc">${activeTab.file}${lineSuffix}</span>
      ${activeTab.confidence === undefined || activeTab.confidence === null
        ? nothing
        : html`<span class="kanban-conf" data-tooltip=${`Confidence ${activeTab.confidence}/10`}>${activeTab.confidence}</span>`}
      ${brand
        ? html`<span class="kanban-analyzer" role="img" data-tooltip=${PRODUCER_LABELS[brand]} aria-label=${PRODUCER_LABELS[brand]}>${appMarkup(REPORT_LOGOS[brand])}</span>`
        : nothing}
    </div>`
  return html`<div
    class=${classMap(classes)}
    data-gid=${groupKey(g)}
    ?data-kanban-source=${isKanban}
    ?data-kanban-select=${variant === 'kanban-side'}
    ?data-focus-select=${variant === 'focus'}
    draggable=${isKanban ? (triageScope(g, groupSt).length > 0 ? 'true' : 'false') : nothing}
    role="button"
    tabindex="0"
    aria-current=${active ? 'true' : 'false'}
    aria-label=${`${CARD_LABELS[variant]} ${title}`}
  >${inner}</div>`
}

// The prev / position / next trio heading the focus queue and the kanban
// dialog's rail (events.js `data-<stem>-nav`, which ←/→ walk too).
const FOCUS_NAV = literal`focus`
const KANBAN_NAV = literal`kanban`
function navTemplate(stem, count, atStart, atEnd) {
  return staticHtml`<div class="focus-nav">
    <button
      type="button"
      class="focus-nav-btn"
      data-${stem}-nav="prev"
      ?disabled=${atStart}
      aria-label="Previous finding"
    >${PREV_ICON}</button>
    <span class="count">${count}</span>
    <button
      type="button"
      class="focus-nav-btn"
      data-${stem}-nav="next"
      ?disabled=${atEnd}
      aria-label="Next finding"
    >${NEXT_ICON}</button>
  </div>`
}

// The Code panel's plain text, kept for the next render of the same file:
// looking for control characters to box takes a while over a large one.
let focusPlain = { content: '', parts: '' }
function focusPlainText(content) {
  if (focusPlain.content !== content) focusPlain = { content, parts: sourceText(content) }
  return focusPlain.parts
}

// The focus Code panel's lines: a sticky gutter of line numbers and the
// source, Prism-highlighted where the language is supported. Every line of
// the cited range is `.focus-code-line-active`; the panel's post-render
// scroll (events.js) brings the first into view, so a span opens at its top.
function focusCodeLinesTemplate(code) {
  const { content, range, highlighted } = code
  const lineCount = content.split('\n').length
  return html`<div class="focus-code-lines" style=${styleMap({ '--lineno-width': `${String(lineCount).length}ch` })}>
    <aside class="focus-code-gutter" aria-hidden="true">
      ${Array.from({ length: lineCount }, (_, i) => {
        const ln = i + 1
        const active = Boolean(range) && ln >= range.start && ln <= range.end
        return html`<div class=${classMap({ 'focus-code-lineno': true, 'focus-code-line-active': active })} data-focus-code-line=${ln}>${ln}</div>`
      })}
    </aside>
    <pre class="focus-code-source" tabindex="-1" aria-label=${code.file}><code>${typeof highlighted === 'string'
      ? appMarkup(highlighted)
      : focusPlainText(content)}</code></pre>
  </div>`
}

function findingHistoryButton(group) {
  if (!group || !canViewFindingHistory(activeTabFor(group))) return nothing
  return html`<button type="button" class="finding-history detail-action" data-finding-history
    data-gid=${groupKey(group)} aria-label="View issue history">
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor"
      stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M2 5a6.25 6.25 0 1 1-.25 5M1.5 1.5V5H5M8 4.5V8l3 1.5"/>
    </svg>
  </button>`
}

// The focus workbench: a finding-card in one pane and, when the analyzer's
// bundle carries the file it cites, that source in another, the draggable
// divider between them. The focus view's, and the kanban dialog's in
// fullscreen, where the card's `Code` shortcut (the bundle overlay, ON TOP
// of everything) is wanted INSTEAD of a panel: the 'focus' card context
// drops that shortcut and sends evidence rows into the panel. `corner`
// floats over the card pane's top-right (the dialog's controls) as a grid
// item of `.focus-main`, so it neither scrolls with the card nor follows
// the divider.
function focusMainTemplate(group, corner = nothing, popup = false) {
  // `null` without a bundle code reference, `{ loading: true }` while the
  // first load runs (render() follows its settle), else the source. The
  // `focusCodeTick` read subscribes a tracked ancestor to those settles.
  void state.focusCodeTick
  const code = getFocusCode(group)
  // Where the panel has been for this finding: empty until the reader
  // follows a reference elsewhere, so the back / forward pair isn't drawn
  // on arrival.
  const codeHistory = focusCodeHistory(group)
  // The split as the divider's percentage (findings.css), bound every
  // render so a committed drag survives one; the drag itself writes the
  // property on this element rather than re-render per pointermove.
  return html`<div class=${code ? 'focus-main with-code' : 'focus-main'} style=${styleMap({ '--focus-split': String(state.focusSplit) })} data-gid=${groupKey(group)}>
      <div class="focus-pane focus-pane-card">
        <div class="focus-card-wrapper">
          ${popup ? nothing : findingHistoryButton(group)}
          ${findingCardPlaceholder(group, { context: 'focus', popup })}
        </div>
      </div>
      ${corner}
      ${code ? html`<div
        class="focus-splitter"
        data-focus-splitter
        role="separator"
        tabindex="0"
        aria-orientation="vertical"
        aria-label="Resize the finding and code panes"
        aria-valuemin=${FOCUS_SPLIT_MIN}
        aria-valuemax=${FOCUS_SPLIT_MAX}
        aria-valuenow=${Math.round(state.focusSplit)}
        data-tooltip="Drag to resize · double-click to reset"
      ></div>
      <div class="focus-pane focus-pane-code" data-focus-code-file=${code.file ?? nothing} data-focus-code-integrity=${code.integrity ?? nothing}>
        ${code.loading
          ? html`<div class="focus-code-empty">Loading source…</div>`
          : html`<header class="focus-code-bar">
              <span class="focus-code-file" data-tooltip-truncated data-tooltip=${code.file}>${code.file}</span>
              ${code.range ? html`<span class="focus-code-line">:${lineRangeLabel(code.range)}</span>` : nothing}
              ${(codeHistory?.stack.length ?? 0) > 1 ? codeHistoryNav(codeHistory) : nothing}
            </header>
            <div class="focus-code-body">${focusCodeLinesTemplate(code)}</div>`}
      </div>` : nothing}
  </div>`
}

// Back / forward through the files the Code panel has shown. The one with
// nowhere to go is DISABLED, not removed: a vanishing button would move the
// other out from under a cursor clicking it repeatedly.
function codeHistoryNav(codeHistory) {
  return html`<div class="focus-code-nav">
                <button
                  type="button"
                  class="focus-code-nav-btn"
                  data-code-history="back"
                  ?disabled=${codeHistory.at === 0}
                  aria-label="Back to the previously shown file"
                >${PREV_ICON}</button>
                <button
                  type="button"
                  class="focus-code-nav-btn"
                  data-code-history="forward"
                  ?disabled=${codeHistory.at === codeHistory.stack.length - 1}
                  aria-label="Forward to the next shown file"
                >${NEXT_ICON}</button>
              </div>`
}

// The detail modal a kanban card opens. render()'s callers wrap
// `state.kanbanPopoverGid` changes in a view transition, so the modal
// morphs from its card (findings.css); the dim backdrop is a layer of its
// own so its fade doesn't drag the modal's clip-path animation along.
//
// The board's `buckets` (key → groups, board order) back the same-column
// rail beside the modal (`focusKey`'s, the open card's), docked to the
// screen's right edge from 1400px up, and its header's picker, the way
// across to another bucket. The rail draws a screen at a time
// (view/kanban-rail.js): a column runs to thousands of cards. Its card
// renderer is a new function each render, so the cards drawn repaint with
// the board. Fullscreen (persisted, state.ts) stretches the modal over
// everything but the rail and swaps the card for the focus workbench; the
// history / expand / close cluster then moves to the card pane's corner.
function kanbanDetailTemplate(focusGroup, buckets = null, focusKey = null, preview = null) {
  if (!focusGroup && !preview) return nothing
  const groupSt = focusGroup ? groupState(focusGroup) : {}
  const full = state.kanbanDetailFullscreen
  // A team's finding shows once its detail is in (managed-details.js).
  const waiting = focusGroup ? managedDetailsWaiting() : null
  const gid = focusGroup ? groupKey(focusGroup) : null
  // A triage state no column claims has no rail.
  const column = buckets && KANBAN_COLUMNS.find((c) => c.key === focusKey)
  const items = column ? buckets.get(column.key) : []
  // -1 can't happen for a group from the same bucket map; were it to, the
  // counter shows the bare total and both arrows stay live.
  const idx = items.findIndex((g) => groupKey(g) === gid)
  // No titles: the native tooltip isn't this app's, and aria-label names them.
  const actions = html`<div class="kanban-detail-actions">
    ${findingHistoryButton(focusGroup)}
    <button
      type="button"
      class="kanban-detail-expand detail-action"
      data-kanban-detail-fullscreen
      aria-pressed=${full ? 'true' : 'false'}
      aria-label=${full ? 'Back to the readable width' : 'Fill the available space'}
    >${full ? COLLAPSE_ICON : EXPAND_ICON}</button>
    <button
      type="button"
      class="kanban-detail-close detail-action"
      aria-label="Close details"
    >×</button>
  </div>`
  return html`<div class=${classMap({ 'kanban-detail-backdrop': true, 'links-preview-backdrop': !!preview })}>
    <div class="kanban-detail-dim"></div>
    <div class=${classMap({ 'kanban-detail-modal': true, fullscreen: full, 'has-conflict': groupSt.hasConflict })} role="dialog" aria-modal="true" aria-label=${preview ? 'Finding preview' : 'Finding details'}>
      ${full && focusGroup ? nothing : actions}
      <div class="kanban-detail-body">
        ${focusGroup && !waiting
          ? (full ? focusMainTemplate(focusGroup, actions, true) : findingCardPlaceholder(focusGroup, { context: 'kanban-detail', popup: true }))
          : html`<div class="links-preview-message" role="status">${preview?.error || (waiting === 'failed' ? DETAILS_FAILED : 'Loading finding…')}</div>`}
      </div>
    </div>
    ${items.length === 0 ? nothing : html`<aside class="kanban-detail-side" aria-label=${`${column.label} findings`}>
      <div class="kanban-detail-side-header">
        <span class="kanban-detail-side-pick">
          <select class="kanban-detail-side-select" data-kanban-column aria-label="Column to show">
            ${KANBAN_COLUMNS.map((c) => {
              // Choosing a column opens its first finding, the rail coming
              // along; an empty one is listed (its count answers "anything
              // in Fixed yet?") but not selectable. `selected` is a
              // PROPERTY: once used, a select's selectedness stops
              // following the attribute.
              const current = c.key === column.key
              const count = buckets.get(c.key).length
              return html`<option
                value=${c.key}
                data-gid=${count > 0 ? groupKey(buckets.get(c.key)[0]) : ''}
                .selected=${current}
                ?disabled=${count === 0}
              >${current ? c.label : `${c.label} (${count})`}</option>`
            })}
          </select></span>${navTemplate(KANBAN_NAV, idx < 0 ? items.length : `${idx + 1} / ${items.length}`, idx === 0, idx === items.length - 1)}
      </div>
      <kanban-rail
        class="kanban-detail-side-body"
        .items=${items}
        .activeKey=${gid}
        .keyOf=${groupKey}
        .renderItem=${(g) => kanbanCardTemplate(g, { variant: 'kanban-side', active: groupKey(g) === gid })}
      ></kanban-rail>
    </aside>`}
  </div>`
}

// Table view: always flat, two columns while a row's details are open.
// The rows are the persistent <finding-table>'s, appended by render() into
// the static (binding-free) `.finding-table-slot`, whose foreign children
// Lit leaves alone.
function tableBody(filtered, selectedGroup) {
  const items = flatOrder(filtered)
  if (items.length === 0) return nothing
  pendingTableItems = items
  return html`<div class=${selectedGroup ? 'findings-table-layout open' : 'findings-table-layout'}>
      <div class="findings-table-list"><div class="finding-table-slot"></div></div>
      ${selectedGroup ? html`<aside class="findings-table-details" id="findings-table-details" aria-label="Finding details">
        <button type="button" class="findings-table-details-close" data-table-deselect aria-label="Close details">×</button>
        <div class="findings-table-details-body">${findingCardPlaceholder(selectedGroup)}</div>
      </aside>` : nothing}
    </div>`
}

// Focus view: one centered card, and an "up next" queue of compact cards
// over the same filtered list. The finding is `state.focusGid` while it is
// still listed, else the previous render's index (findingDetailGroup), so
// a triage moves the queue forward; that pick is never written back, so
// the reader's own can re-surface when the filter brings it back.
function focusBody(filtered, selectedGroup) {
  if (filtered.length === 0) return nothing
  const focusedIdx = filtered.indexOf(selectedGroup)
  prevFocusedIdx = focusedIdx
  return html`<div class="focus-view">
      ${focusMainTemplate(selectedGroup)}
      <aside class="focus-sidebar" aria-label="Up next">
        <div class="focus-sidebar-header">
          <span class="label">Up next</span>${navTemplate(FOCUS_NAV, `${focusedIdx + 1} / ${filtered.length}`, focusedIdx === 0, focusedIdx === filtered.length - 1)}
        </div>
        <div class="focus-sidebar-body">
          ${repeat(filtered, groupKey, (g) => kanbanCardTemplate(g, {
            variant: 'focus',
            active: groupKey(g) === groupKey(selectedGroup),
          }))}
        </div>
      </aside>
    </div>`
}

const KANBAN_COLUMNS = [
  { key: 'untriaged',  label: 'Untriaged' },
  { key: 'inprogress', label: 'In progress' },
  { key: 'fixed',      label: 'Fixed' },
  { key: 'invalid',    label: 'Invalid' },
  { key: 'deleted',    label: 'Deleted' },
  { key: 'ignored',    label: 'Ignored' },
]

// Kanban: a column per triage bucket (`commonTriage`, null = Untriaged),
// over every bucket at once (renderImpl skips `state.shownTriage` for it).
// Cards drag between columns ([data-kanban-source] / [data-kanban-target],
// events.js); a header's toggle gives its column the whole board. The open
// card's modal lives in this template, so leaving the view unmounts it.
// `groupStates` holds the rollups renderImpl read this render.
function kanbanBody(filtered, selectedGroup, groupStates) {
  const buckets = new Map(KANBAN_COLUMNS.map((c) => [c.key, []]))
  const stateOf = (g) => groupStates.get(g) ?? groupStates.set(g, groupState(g)).get(g)
  // A triage state no column claims has no column.
  for (const g of filtered) buckets.get(stateOf(g).commonTriage ?? 'untriaged')?.push(g)
  // A stale key (a renamed bucket) degrades to the normal board.
  const expandedKey = KANBAN_COLUMNS.some((c) => c.key === state.kanbanExpandedColumn) ? state.kanbanExpandedColumn : null
  const shownColumns = expandedKey ? KANBAN_COLUMNS.filter((c) => c.key === expandedKey) : KANBAN_COLUMNS
  // `--kanban-cols` lays an expanded column's cards in as many tracks as
  // the board has columns, so a card's width holds either side of the toggle.
  return html`<div class="kanban-board" style=${styleMap({ '--kanban-cols': String(KANBAN_COLUMNS.length) })}>
      ${repeat(shownColumns, (c) => c.key, (c) => {
        const items = buckets.get(c.key)
        const isExpanded = c.key === expandedKey
        return html`<div
          class=${`kanban-column kanban-column-${c.key}${isExpanded ? ' expanded' : ''}`}
          data-kanban-target=${c.key}
        >
          <div class="kanban-column-header">
            <span class="label">${c.label}</span>
            <span class="count">${items.length}</span>
            <button
              type="button"
              class="kanban-expand"
              data-kanban-expand=${c.key}
              aria-pressed=${isExpanded}
              aria-label=${isExpanded ? 'Show all columns' : `Show only ${c.label}`}
            >${isExpanded ? COLLAPSE_ICON : EXPAND_ICON}</button>
          </div>
          <div class="kanban-column-body">
            ${items.length === 0
              ? html`<div class="kanban-empty">No ${c.label.toLowerCase()} findings.</div>`
              : repeat(items, groupKey, (g, index) => kanbanCardTemplate(g, {
                  active: groupKey(g) === state.kanbanPopoverGid,
                  expandedTrackLast: (index + 1) % KANBAN_COLUMNS.length === 0,
                  groupSt: stateOf(g),
                }))}
          </div>
        </div>`
      })}
    </div>
    ${kanbanDetailTemplate(selectedGroup, buckets, selectedGroup && (stateOf(selectedGroup).commonTriage ?? 'untriaged'))}`
}

// Grouped by file — a dedup group's tabs share one file (dedup runs per
// file hash), and so do their `repo.github` and `_repoFallback`, so the
// first group's primary tab links the header. Files alphabetically under
// the file sort, else by first appearance.
function groupedBody(filtered) {
  const byFile = Map.groupBy(filtered, (g) => primaryTab(g).file)
  const fileKeys = state.sortBy === 'file' ? [...byFile.keys()].toSorted() : [...byFile.keys()]
  return html`${repeat(fileKeys, (file) => file, (file) => {
    const items = state.sortBy === 'file'
      ? sortGroupsByPrimary(byFile.get(file), (pa, pb) => parseInt(pa.line, 10) - parseInt(pb.line, 10))
      : byFile.get(file)
    const probe = primaryTab(items[0])
    return html`<div class="file-group">
        <div class="file-header">
          <span>${fileLink(probe, findingRepoTarget(probe))}</span>
          <span class="count">${items.length}</span>
        </div>
        <div class="file-body">${repeat(items, groupKey, (g) => findingCardPlaceholder(g, { lazy: true }))}</div>
      </div>`
  })}`
}

// Flat list: each group in a `.flat-group` card under a location header
// carrying the active tab's full line row (file · line · export · run
// meta); `:host([in-group]) .line-row` hides the card's own. Print flips
// both for groups with duplicates (.multi-case, styles/print.css).
function flatBody(filtered) {
  const items = flatOrder(filtered)
  return html`${repeat(items, groupKey, (g) => {
    const p = activeTabFor(g)
    const lineLinkTpl = lineLink(p, findingRepoTarget(p))
    const meta = formatRunMeta(p)
    const displayName = findingDisplayName(p)
    return html`<div class=${classMap({ 'flat-group': true, 'multi-case': g.length > 1 })}>
      <div class="flat-group-loc">
        <span class="file">${fileLink(p, findingRepoTarget(p))}</span>
        ${lineLinkTpl === nothing ? nothing : html`<span class="line-num">${lineLinkTpl}</span>`}
        ${displayName ? html`<span class="meta">${displayName}</span>` : nothing}
        ${meta ? html`<span class="run-meta">${meta}</span>` : nothing}
      </div>
      ${findingCardPlaceholder(g, { inGroup: true, lazy: true })}
    </div>`
  })}`
}

// The findings tab's body for the view mode (`applySorting` has ordered
// `filtered`); list, and anything else, is the flat one.
const BODIES = { table: tableBody, focus: focusBody, kanban: kanbanBody, grouped: groupedBody }
function findingsBodyTemplate(filtered, selectedGroup, groupStates) {
  return (BODIES[state.viewMode] ?? flatBody)(filtered, selectedGroup, groupStates)
}

// The bundle source viewer overlay, in a top-level slot (index.html) so it
// pops over any view and survives #report's rebuilds; the finding-card's
// `[Code]` shortcut opens it by setting `state.bundleSourceFile`.
function mountBundleSourceOverlay() {
  if (state.bundleSourceFile) ensureBundleSources().catch(() => {})
  const slot = document.querySelector('#bundle-source-overlay-slot')
  if (slot) litRender(renderBundleSourceModal(), slot)
}

// Paint synchronously, cancelling any detail animation when the view changes.
const renderView = createViewRenderer(renderImpl)

export function render() {
  renderView(state.currentView)
}

// #report's slot divs, reused across renders: Lit's part cache is keyed on
// the container, so a fresh div would rebuild the whole DOM every render
// (scroll lost, layout flashing). Replaced only on arrival from another view.
function ensureReportSlots(...ids) {
  let slots = ids.map((id) => document.querySelector(`#${id}`))
  if (slots.some((slot) => !slot || !report.contains(slot)) || report.firstElementChild !== slots[0]) {
    slots = ids.map((id) => reportSlot(id))
    replaceReport(...slots)
  }
  return slots
}
const ensureReportSlot = (id) => ensureReportSlots(id)[0]

// A view painted whole into its slot of #report: `build()` its template
// (none skips the paint), shown under `title`.
function paint(slotId, build, title) {
  const slot = ensureReportSlot(slotId)
  const template = build()
  if (template) litRender(template, slot)
  showReport()
  document.title = title
}

// A team's or a report's triage loading (ingest.js switchToManagedTeam):
// the status mid-page. A team's sits under its header, Findings selected,
// as its findings will, so moving there from another of its tabs keeps the
// header in place.
export function renderTriageLoading(teamId = null) {
  const team = teamId == null ? null : state.managedTeams.find(t => t.id === teamId)
  const context = team ? workspaceContent({ currentWorkspace: `managed-team:${team.id}`, currentManagedTeam: team.id,
    managedTeams: state.managedTeams, managedSession: state.managedSession }, []) : null
  litRender(triageLoadingTemplate(context), ensureReportSlot('triage-loading-slot'))
}

export function renderEmptyWorkspace() {
  const context = workspaceContent(state, listWorkspaces(), getKind)
  document.title = context ? `${context.title} — findings` : 'DeepView'
  const slot = ensureReportSlot('empty-workspace-slot')
  litRender(html`${headerTemplate([], [], false, null, 0)}<p class="workspace-content-empty">No findings available.</p>`, slot)
  showReport()
}

// The views painted whole into a slot of their own, by `state.currentView`:
// paint()'s arguments off the state, or none where there is nothing to paint.
const PAINTED_VIEWS = {
  // A lockfile dropped in local or e2e mode (lockfile-drop.js), never saved.
  lockfile: ({ droppedLockfile: lockfile }) => lockfile && ['dropped-lockfile-slot', () => renderDroppedLockfile(lockfile), `DeepView — ${lockfile.name}`],
  reviews: () => ['dependency-reviews-slot', () => withCompare(() => html`<dependency-review-list .session=${state.managedSession}></dependency-review-list>`), 'DeepView — my reviews'],
  profile: () => ['managed-profile-slot', () => html`<managed-profile .session=${state.managedSession} .linkError=${state.profileLinkError}></managed-profile>`, 'DeepView — profile'],
  // The npm viewer's lookup page; a package it opens shows as a bundle, its
  // header already while it opens, in the slot it then shows in.
  npm: ({ npmOpening: opening }) => opening
    ? ['bundles-slot', () => renderNpmOpening(opening), `DeepView — ${npmPackageInput(opening.name, opening.spec)}`]
    : ['npm-slot', () => renderNpmLookup(), 'DeepView — npm packages'],
  // A repository's directory opening, or why it didn't; once open it shows
  // as a bundle, in the same slot.
  'repository-code': ({ repositoryCodeOpening: opening }) =>
    ['bundles-slot', () => opening && renderRepositoryCodeOpening(opening), `DeepView — ${opening?.repo ?? 'code'}`],
  // Cross-report aggregations off the OPFS-wide finding index
  // (bundle-finding-index.js), not `state.reports`.
  packages: () => ['packages-slot', renderPackagesView, 'DeepView — packages'],
  repositories: () => ['repositories-slot', renderRepositoriesView, 'DeepView — repositories'],
  // A links file: which findings it ties together and which reports hold
  // them (render-links.js). It carries no findings, so `state.reports` stays
  // empty while it is up. The sync badge is built here, from the workspace /
  // remote state this module holds: a links file is a workspace member
  // like any other.
  links: ({ currentLinks }) => currentLinks && ['links-slot', () => {
    const preview = getLinksPreview()
    return html`${renderLinksView(syncBadgeTemplate())}${preview ? kanbanDetailTemplate(preview.group, null, null, preview) : nothing}`
  }, `DeepView — ${currentLinks.name}`],
}

// The managed admin pages, each a <managed-admin-*> element of the lazily
// loaded admin bundle that fetches and paints itself (the sidebar gates
// them by role), by view: its tag's suffix and the title's word. Each
// renders into `${view}-slot`.
const ADMIN_VIEWS = {
  'manage-deduplication': ['deduplication', 'deduplication'],
  'manage': ['home', 'manage'],
  'admin-users': ['users', 'users'],
  'manage-repos': ['repos', 'repositories'],
  'manage-repo-risk': ['repo-risk', 'repository risk'],
  'manage-reports': ['reports', 'reports'],
  'manage-bundles': ['bundles', 'bundles'],
  'manage-history': ['history', 'history'],
  'manage-teams': ['teams', 'teams'],
  'manage-import': ['import', 'import'],
  'manage-links': ['links', 'links'],
  'manage-scans': ['scans', 'scans'],
}

// A page's shadow roots, which the document-level tooltip listener can't
// see into; a truncated label tips only while it is cut off.
const installTooltips = (root) => installShadowTooltipListener(root, {
  gate: target => !Object.hasOwn(target.dataset, 'tooltipTruncated') || target.scrollWidth > target.clientWidth,
})

// The views a tree draws, left for the findings where there is none to draw.
function leaveTrees() {
  if (state.currentView === 'files') state.currentView = 'findings'
  if (state.viewMode === 'graph') state.viewMode = 'kanban'
}

const loadingTemplate = what => html`<p class="triage-loading" role="status">Loading ${what}…</p>`
const DETAILS_FAILED = 'Could not load finding details. Open the team again to retry.'

// The findings' empty-state lines.
const notice = (style, text) => html`<p style=${styleMap(style)}>${text}</p>`
const MUTED = { color: 'var(--muted)', margin: '1rem 0' }
const GREEN = { color: 'var(--green)' }

// Alphabetical with the null bucket pinned last, for the model and repo
// option lists.
const nullLastCmp = (a, b) => (a == null || b == null ? (a == null) - (b == null) : a.localeCompare(b))

// The analyzer options' order: known source-marked producers first, in
// SOURCE_LABELS' order, then the rest, the null bucket last.
const SOURCE_ORDER = Object.keys(SOURCE_LABELS)
const analyzerRank = (a) => {
  if (a == null) return Infinity
  const i = SOURCE_ORDER.indexOf(a)
  return i === -1 ? SOURCE_ORDER.length : i
}

// `compute`'s last answer, kept while it is called with the same keys (by
// identity): render asks these of every finding on every draw, and what
// they read never changes for the same keys — a report once ingested,
// getMergedGroups' array until the set, a lens or the links change.
function memoized(compute) {
  let keys = null
  let value
  return (...next) => {
    if (keys?.length !== next.length || next.some((k, i) => k !== keys[i])) {
      value = compute(...next)
      keys = next
    }
    return value
  }
}

// What the toolbar offers off the merged rows alone (none of it triage,
// which a render follows without the rows changing), keyed by the deps dir
// and the layer too, which decide `isModule` and the rows priority reads.
const mergedRowFacts = (mergedGroups) => rowFacts(mergedGroups, depsDirName(), revalidationShown())
const rowFacts = memoized((mergedGroups) => {
  const findings = mergedGroups.flat()
  // Analyzers and models off the merged rows, not the triage bucket's, so
  // the lists hold still as the reader changes bucket. A revalidation
  // pass's own row gives its model to the Validation model column (filters.js
  // matchesValidationModel), which only App mode, holding those rows, offers.
  const analyzerSet = new Set()
  const modelSet = new Set()
  const validationModelSet = new Set()
  for (const f of findings) {
    analyzerSet.add(f._analyzer ?? null)
    ;(isRevalidation(f) ? validationModelSet : modelSet).add(modelOfFinding(f))
  }
  // The one `repo.github` every non-module finding carrying one shares,
  // for the read-only repo chip; null for a mixed load.
  const perFindingRepos = new Set(findings.filter((f) => !isModule(f.file) && f.repo?.github).map((f) => f.repo.github))
  return {
    // Only where it can order every row: in App view, App rows need it on
    // an App entry (filters.js priorityApplies).
    hasAnyPriority: priorityApplies(mergedGroups),
    hasAnyModulesPath: findings.some((f) => isModule(f.file)),
    hasAnySourcePath: findings.some((f) => !isModule(f.file)),
    // A single file has nothing to reorder at the file level.
    hasMultipleFiles: findings.some((f) => f.file !== findings[0].file),
    // The repo input helps only a non-module finding without a repo.
    repoInputUseful: findings.some((f) => !f.repo?.github && !isModule(f.file)),
    knownRepo: perFindingRepos.size === 1 ? [...perFindingRepos][0] : null,
    analyzerSet, modelSet, validationModelSet,
    analyzerOptions: [...analyzerSet].toSorted((a, b) => analyzerRank(a) - analyzerRank(b) || String(a ?? '').localeCompare(String(b ?? ''))),
    modelOptions: [...modelSet].toSorted(nullLastCmp),
    validationModelOptions: [...validationModelSet].toSorted(nullLastCmp),
    runFiltersShown: runFiltersOffered(mergedGroups, { analyzers: analyzerSet, models: modelSet, validationModels: validationModelSet }),
  }
})

// What the detail stop of the App switch would hand back (canDetailLayer
// in renderImpl), read raw off the revalidation layer's rows
// (getRevalidationGroups' array, the same until the set or the links change).
const detailLayerFacts = memoized((groups, workspace) => {
  let hasFoldedRows = false
  let hasPartialRow = false
  let hasRuledOutRow = false
  for (const g of groups) {
    let passRow = false
    let ownRow = false
    for (const f of g) {
      const raw = revalidateKindOf(f)
      if (raw === 'partial') hasPartialRow = true
      if (raw === 'unreachable' || raw === 'refuted') {
        hasRuledOutRow = true
        // A workspace dropped this row before its reports' rows merged, so
        // it is no part of what the detail stop could unfold there — and a
        // pass row left alone by it has nothing folded underneath.
        if (workspace) continue
      }
      if (raw === 'revalidation') passRow = true
      else ownRow = true
    }
    if (passRow && ownRow) hasFoldedRows = true
  }
  return { hasFoldedRows, hasPartialRow, hasRuledOutRow }
})

// While a team's board is drawn from a copy leaving rows out, what those
// rows tell the view offers beside its App view (managed-details.js
// managedDetailsLens), in place of what its rows on hand would.
const teamLens = () => state.currentWorkspace ? managedDetailsLens() : null

const droppableLayer = memoized(() => canDropRevalidation(state.reports))
function loadedCanDropRevalidation() {
  const lens = teamLens()
  return lens ? lens.drop : droppableLayer(...state.reports)
}

// Whether any loaded finding is upstream code, its stamps settled first —
// keyed by the deps dir as well, which alone the stamps follow (format.js
// stampUpstreamFindings): with neither changed, the walk would write nothing.
const upstreamFacts = memoized(() => {
  if (stampUpstreamFindings(state.reports)) clearMergedGroups()
  return state.reports.some((r) => (r.groups ?? []).some((g) => g.some((f) => f.isUpstream)))
})
function loadedUpstream() {
  const value = upstreamFacts(depsDirName(), ...state.reports)
  return teamLens()?.upstream ?? value
}

// The header's run-meta chips. Every field they read is the report's own,
// copied onto its findings at ingest (@preventive/report inheritReportMeta),
// a team report's filled in with its findings' detail (managed-details.js).
const analyzerTags = memoized((single) => buildAnalyzerTags(state.reports.flatMap((r) => r.groups.flat()),
  single ? COMBO_FIELDS.filter(f => f !== 'type') : COMBO_FIELDS))
const loadedAnalyzerTags = (single) => analyzerTags(single, managedDetailsWaiting(), ...state.reports)


// The revalidation mode a CONFLICT took away, held until the set carrying
// it is gone: this module's bookkeeping between renders, not view state.
let modeBeforeConflict = null

// Settle the App layer for the loaded set, before anything reads a
// `revalidate` value (format.js configureRevalidation); returns whether the
// switch is offered. A set it isn't offered for goes back ONTO the layer
// (off would only drop the pass's own rows, with no control to bring them
// back); a set whose reports CONTRADICT each other about the pass comes off
// it and stays off, as dedup would keep whichever copy loaded first — the
// mode it took away is given back on leaving that set. `held` where the
// reports are a team board's copy leaving out rows App mode doesn't show
// (managed-details.js managedDetailsFolded): rows that could tell whether
// the layer can come off, or an upstream lens has ground, may be among
// them, so the reader's lens stays as they had it.
export function configureReportRevalidation({ held = false } = {}) {
  const conflicted = state.revalidateConflicts.size > 0
  const canDropLayer = !conflicted && loadedCanDropRevalidation()
  if (conflicted) {
    if (state.showRevalidation !== false) {
      modeBeforeConflict = state.showRevalidation
      state.showRevalidation = false
    }
  } else {
    if (modeBeforeConflict !== null) {
      state.showRevalidation = modeBeforeConflict
      modeBeforeConflict = null
    }
    if (!canDropLayer && state.showRevalidation === false && !held) state.showRevalidation = true
  }
  // A lens left on by a previous report goes before the display and the
  // opening filters are configured for a set without upstream findings.
  if (state.upstreamOnly && !held && (!canDropLayer || state.showRevalidation === false || !loadedUpstream())) {
    state.upstreamOnly = false
  }
  configureRevalidation(state.showRevalidation, state.upstreamOnly)
  return canDropLayer
}

// The bundle Graph tab's live canvas attachment and what it was built
// from, so a re-render that can't change the canvas keeps it.
let bundleGraphAttachment = null

// The bundle Graph tab: the findings graph's canvas fed bundle-synthesised
// data, into the slot render-bundle.js emits. The first open loads the lazy
// ui/graph.js (attachGraphLayout renders the host, then refreshes its
// panels and wires the canvas). With Issues off the canvas draws no
// findings, so a re-render that leaves this bundle's view alone changes at
// most the topbar's Issues switch: the live canvas stays and the host only
// takes its new options. View switches tear it down (cleanupGraph2).
function renderBundleGraph(details) {
  const graphSlot = document.querySelector('#bundle-graph-slot')
  if (!graphSlot) return
  const prep = buildBundleGraphData(state.bundleDetails)
  if (!prep) return
  setCurrentBundleGraphPrep(prep)
  const options = {
    // Every file always shows, so no "All files" toggle.
    hideAllFiles: true,
    triageCounts: countBundleTriageBuckets(state.bundleDetails, new Set(prep.strippedToOrig.values())),
    triageStates: ['inprogress', 'fixed', 'invalid', 'deleted', 'ignored'],
    // Per-file graph or one node per package, offered from 3 packages up.
    showPackagesView: prep.canPackagesView,
    showBundleLayouts: true,
    // The Issues switch, where findings matched this bundle's files.
    hasIssues: prep.hasIssues,
  }
  const attached = bundleGraphAttachment
  const host = graphSlot.querySelector('graph-layout')
  if (!prep.issuesShown && attached && !attached.issuesShown && host
      && attached.state === graph2.graphState && attached.details === details && attached.reason === graph2.bundleReason) {
    host.options = options
    return
  }
  bundleGraphAttachment = null
  void attachGraphLayout(graphSlot, prep, options, refreshBundleGraphSidebar, refreshBundleGraphTopPkgs).then((attachedHost) => {
    if (attachedHost && graph2.graphState) {
      bundleGraphAttachment = { state: graph2.graphState, details, reason: graph2.bundleReason, issuesShown: prep.issuesShown }
    }
    return null
  })
}

function renderImpl() {
  if (!getLinksPreview()) closeLinksPreview()
  mountBundleSourceOverlay()
  // The deps dir (`node_modules`, else `dependencies`) before any helper
  // consults it (isModule / packageOf / …), and the installs whose upstream
  // a loaded finding names at a commit (format.js evidenceUrl).
  configureDepsDir(state.reports)
  configureDependencyRepos(state.reports)
  if (migrateLoadedIgnores()) queueMicrotask(() => { void saveTriage() })
  // With the dir settled, upstream code is stamped (idempotent, and kept for
  // the set and the dir). The upstream lens is offered wherever the SET
  // holds such a finding — read off the reports, not the groups the lens
  // itself left drawn, or it would take its own ground away.
  const canUpstreamLens = loadedUpstream()
  // The App layer's mode, settled before anything reads a `revalidate`
  // value (group.js reads `state.showRevalidation` itself, as getMergedGroups
  // is reachable outside a render).
  const canDropLayer = configureReportRevalidation({ held: Boolean(managedDetailsFolded()) })
  // The paint-only views, which need no loaded report; one with nothing to
  // paint leaves for the findings.
  const painted = PAINTED_VIEWS[state.currentView]
  const toPaint = painted?.(state)
  if (toPaint) return paint(...toPaint)
  if (painted) state.currentView = 'findings'
  if (['workspace-reports', 'workspace-bundles', 'workspace-repositories', 'workspace-dependencies'].includes(state.currentView)) {
    const kind = state.currentView.slice(10)
    const context = workspaceContent(state, listWorkspaces(), getKind)
    const slot = ensureReportSlot('workspace-content-slot')
    litRender(renderWorkspaceContent(context, kind), slot)
    document.title = context ? `${context.title} — ${kind}` : `DeepView — ${kind}`
    return
  }
  // The bundles list paints from `state.bundles` (cached by the sidebar).
  // The last bundle deleted between renders drops back to the findings.
  if (state.currentView === 'bundles' && !state.bundles?.length) state.currentView = 'findings'
  if (state.currentView === 'bundles') {
    if (bundleNeedsSources(state.bundleDetailsTab, state.bundleSourceFile)) ensureBundleSources().catch(() => {})
    const slot = ensureReportSlot('bundles-slot')
    litRender(renderBundlesList(state.bundles), slot)
    const details = state.bundleDetails
    const bundleOpen = state.selectedBundle && details && (details.json || details.bundle)
    if (bundleOpen && state.bundleDetailsTab === 'graph') renderBundleGraph(details)
    // The terminal, in its tab or the Code tab's pane: attaching is
    // idempotent per bundle, so tab flips keep the running shell.
    if (bundleOpen && !details.metadataOnly
        && (state.bundleDetailsTab === 'terminal' || state.bundleDetailsTab === 'code' && state.bundleCodeTerminal)) {
      const terminalSlot = document.querySelector('#bundle-terminal-slot')
      if (terminalSlot) attachTerminal(terminalSlot, state.bundleDetails)
    }
    showReport()
    const { npm, repository } = state.bundles.find(entry => entry.integrity === state.selectedBundle) ?? {}
    document.title = npm ? `DeepView — ${npm.name}@${npm.version}` : repository ? `DeepView — ${repositoryCodeName(repository)}` : 'DeepView — bundles'
    return
  }
  // The optional local/E2E scan surface; its host owns navigation and transport.
  if (state.currentView === 'scan' && customElements.get('local-scan-page')) {
    const slot = ensureReportSlot('scan-slot')
    if (!slot.firstElementChild) {
      const el = document.createElement('local-scan-page')
      el.selection = state.scanSelection
      slot.append(el)
      void el.updateComplete.then(() => installTooltips(el.renderRoot))
    }
    showReport()
    document.title = 'DeepView — scans'
    return
  }
  const adminView = ADMIN_VIEWS[state.currentView]
  if (adminView) {
    const [name, word] = adminView
    const tag = `managed-admin-${name}`
    const slot = ensureReportSlot(`${state.currentView}-slot`)
    slot.classList.add('managed-page-slot')
    // Another session or role gets a fresh page.
    const previous = slot.firstElementChild?.session
    if (previous?.id !== state.managedSession?.id || previous?.role !== state.managedSession?.role) slot.replaceChildren()
    const configure = (el) => {
      el.session = state.managedSession
      el.allowShare = state.managed?.allowShare === true
      if (state.currentView === 'manage-scans') el.selection = state.scanSelection
      if (state.currentView === 'manage-bundles') el.createRepoId = state.bundleCreationRepoId
      if (state.currentView === 'manage-repo-risk') el.selection = state.riskSelection
    }
    if (slot.firstElementChild) {
      configure(slot.firstElementChild)
    } else {
      const el = document.createElement(tag)
      el.localImportSource = createManagedLocalImportSource()
      if (state.currentView === 'manage-import') {
        el.localDeps = managedWorkspaceImportDeps()
        el.promptPassword = openWorkspaceUnlockBundleDialog
        el.resolveConflicts = resolveTriageConflicts
        el.confirmTriageImport = openLocalTriageImportDialog
        el.confirmContentImport = openLocalContentImportDialog
        el.showTriageComparison = openTriageComparisonDialog
      }
      configure(el)
      // Nested pickers get the installer too: pointer transitions inside
      // their shadow root are trimmed before reaching this outer one.
      if (state.currentView === 'manage-bundles') el.installTooltips = installTooltips
      slot.append(el)
      // The admin bundle is its own esbuild entry (no code splitting), so it
      // can't import view/tooltip.js without a second `#styled-tooltip`:
      // wire this bundle's listener once the element has upgraded and painted.
      void (async () => {
        await customElements.whenDefined(tag)
        await el.updateComplete
        installTooltips(el.renderRoot)
      })().catch(() => {})
    }
    showReport()
    document.title = `DeepView — ${word}`
    return
  }
  // Sync / presence notifications can render between clearing the reports
  // and a navigation's load finishing, as can a team's whole reports being
  // ingested in place of its board's copy (managed-details.js): the current
  // surface stays until the navigation replaces it.
  if (state.reports.length === 0 || managedDetailsReplacing()) {
    if (state.reports.length === 0 && state.currentWorkspace && document.querySelector('#empty-workspace-slot')) renderEmptyWorkspace()
    return
  }
  // Every loaded report's dedup groups, merged. The triage bucket splits
  // here, not in applyFilters, so the "X of Y" counter and the stats are
  // the bucket's; kanban shows every bucket as a column. One groupState
  // pass (the priciest per-group helper) tallies the triage selector's
  // counts too; a conflict group counts as live.
  const mergedGroups = getMergedGroups()
  const isKanban = state.viewMode === 'kanban'
  const triageCounts = { inprogress: 0, fixed: 0, invalid: 0, deleted: 0, ignored: 0 }
  const allGroups = []
  const groupStates = new Map()
  for (const g of mergedGroups) {
    const st = groupState(g)
    groupStates.set(g, st)
    const t = st.commonTriage
    if (t) triageCounts[t]++
    if (isKanban || t === state.shownTriage) allGroups.push(g)
  }
  // The Confirmed lock needs the same ruled-out evidence as the opening
  // filters, though a workspace removed those copies before its rows merged.
  Object.defineProperty(allGroups, 'ruledOutIds', { value: mergedGroups.ruledOutIds })
  // Over the whole loaded set: whether any finding carries each annotation
  // (comment / issue / fix / flag chips) or a severity correction (the
  // corrected / original lens).
  let hasComment = false, hasFix = false, hasFlagged = false, hasIssue = false
  let hasCorrectedSeverity = false
  for (const g of mergedGroups) {
    for (const f of g) {
      if (hasSeverityCorrection(f)) hasCorrectedSeverity = true
      const e = triageEntry(f)
      if (managedIssueFor(f)) hasIssue = true
      if (automaticFixFor(f)) hasFix = true
      if (!e) continue
      if (e.comment) hasComment = true
      if (e.fix) hasFix = true
      if (e.flagged === true) hasFlagged = true
    }
  }
  // Unlike the annotation chips, these filters go (and their selection
  // with them) once no qualifying row remains. Duplicates is report-only;
  // cross-context rows are offered outside App mode and App-stacked ones
  // in it, each tested on the tabs the lens left; security needs rows on
  // both sides, tested before filters so a side can't hide its own toggle.
  const duplicateIds = reportDuplicateIds()
  const hasDuplicates = mergedGroups.some((g) => g.some((f) => duplicateIds.has(f.id)))
  if (!hasDuplicates) state.filterDuplicates = ''
  const hasCrossContext = allGroups.some(isCrossContextGroup)
  const hasAppStacked = allGroups.some(isAppStackedGroup)
  if (!hasCrossContext) state.filterCrossContext = ''
  if (!hasAppStacked) state.filterAppStacked = ''
  const showSecurity = hasSecurityContrast(allGroups)
  if (!showSecurity) state.filterSecurity = ''
  // The `revalidate` values on screen, which decide the outcomes the
  // dropdown offers (REVALIDATE_FILTERS), over the bucket the reader is in
  // like the confidence range it shares a block with: walking into a bucket
  // nothing was stamped for hands back the range rather than a list
  // filtered to nothing.
  const revalidateKinds = new Set()
  for (const g of allGroups) {
    for (const f of g) {
      const kind = revalidateKind(f)
      if (kind) revalidateKinds.add(kind)
    }
  }
  // What the switch's DETAIL stop would hand back — rows the simplified
  // app view folds under the pass's (group.js drawnTabs), partial stamps for
  // the chip inside Confirmed — asked of the set, RAW past the layer's
  // gate: gated, both would go empty at the switch's code stop and the
  // control would resize itself mid-click.
  const lens = teamLens()
  const { hasFoldedRows, hasPartialRow, hasRuledOutRow } = lens ? { hasFoldedRows: lens.detail, hasPartialRow: false, hasRuledOutRow: false }
    : detailLayerFacts(getRevalidationGroups(), Boolean(state.currentWorkspace))
  // Types in first-seen order: "security, correctness" reads in load order.
  const typeLabel = [...new Set(state.reports.map((r) => r.type))].join(', ')
  const fileNames = state.reports.map((r) => r.fileName)

  // Controls the reader can't act on usefully are hidden, and their filter
  // state forced back to its no-op value, so a filter left set by a
  // previous report can't silently hide findings.
  //
  // The confidence range is a live control over the rows on screen
  // (filters.js rangeApplies, which the opening auto-tune reads too): every
  // row needs a spot on the 0–10 scale — a real `confidence`, the
  // `critical: true` flag (NOT severity 'critical'), or another producer's
  // row, which carries no confidence because its producer emits none and so
  // reads as 10 — and a set of nothing but unscored rows doesn't establish
  // one. Per finding, not per report, and over `allGroups` (the bucket on
  // screen) so it is status-aware for free.
  const visibleAllGroups = allGroups.map(drawnTabs).filter((g) => g.length > 0)
  const hasAnyConfidence = visibleAllGroups.length > 0 && rangeApplies(visibleAllGroups)
  const {
    hasAnyPriority, hasAnyModulesPath, hasAnySourcePath, hasMultipleFiles, repoInputUseful, knownRepo,
    analyzerSet, modelSet, validationModelSet, analyzerOptions, modelOptions, validationModelOptions, runFiltersShown,
  } = mergedRowFacts(mergedGroups)
  // An analyzer / model no longer present, or whose column stopped varying
  // (the panel omits it then, leaving a vacuous selection no row can
  // clear), would keep the list narrowed: clear it. The validation model's
  // column shows with a single value too, wherever the dropdown does.
  if (state.filterAnalyzer && (!analyzerSet.has(runFilterValue(state.filterAnalyzer, NULL_ANALYZER_SENTINEL)) || analyzerSet.size < 2)) state.filterAnalyzer = ''
  if (state.filterModel && (!modelSet.has(runFilterValue(state.filterModel, NULL_MODEL_SENTINEL)) || modelSet.size < 2)) state.filterModel = ''
  if (state.filterValidationModel && (!validationModelSet.has(runFilterValue(state.filterValidationModel, NULL_MODEL_SENTINEL)) || !runFiltersShown)) {
    state.filterValidationModel = ''
  }
  // Likewise a revalidation outcome the set no longer reaches. Not
  // revalidated joins the outcomes only while the underlying findings are
  // on screen — the simplified view folds them under the pass's row — and
  // some row there carries no outcome; leaving the detail stop clears it.
  const revalidateOptions = reachableRevalidateFilters(revalidateKinds,
    underlyingFindingsShown() && allGroups.some(isUnrevalidatedGroup))
  if (state.filterRevalidate && !revalidateOptions.some((o) => o.value === state.filterRevalidate)) {
    state.filterRevalidate = ''
  }
  const confirmedLocked = shouldLockConfirmed(allGroups)
  if (confirmedLocked) state.filterRevalidate = 'confirmed'
  // The partial switch inside Confirmed (revalidate-filter.js) sorts the
  // stamps on the analyzer's own rows, which only the DETAILED app view
  // keeps on screen; a mode left set elsewhere would narrow Confirmed with
  // no control saying so.
  const showPartial = revalidateKinds.has('partial') && underlyingFindingsShown()
  if (!showPartial) state.filterPartial = ''
  // The switch's detail stop, offered where it would change something: a
  // property of the SET, so the control keeps its stops as the reader moves
  // through them. Ruled-out rows count only outside a workspace, which
  // drops them before its reports' rows merge (workspace-groups.js
  // hideRuledOut), leaving the stop nothing to hand back.
  const canDetailLayer = canDropLayer
    && (hasFoldedRows || hasPartialRow || (!state.currentWorkspace && hasRuledOutRow))
  // The source / dependency lens needs both sides. App mode already speaks
  // for App findings and the upstream view selects only dependencies, so
  // both hide it (resetFilters runs only on a view's first report).
  const appModeActive = canDropLayer && state.showRevalidation !== false
  const showSource = !appModeActive && !state.upstreamOnly && hasAnyModulesPath && hasAnySourcePath
  if (!showSource && state.filterSources.size > 0) state.filterSources.clear()
  // Sorts drop out of the dropdown with what they sort by.
  if (!hasAnyConfidence) {
    state.filterConfMin = 0; state.filterConfMax = 10
    if (state.sortBy === 'confidence-desc' || state.sortBy === 'confidence-asc') state.sortBy = 'severity'
  }
  if (!hasAnyPriority && (state.sortBy === 'priority-desc' || state.sortBy === 'priority-asc')) {
    state.sortBy = 'severity'
  }
  if (!hasMultipleFiles && state.sortBy === 'file') state.sortBy = 'severity'

  // Severity / color stats count each surviving row once per value its
  // visible tabs hold (App mode's folded source tabs excluded).
  const selectorGroups = applyScopeFilters(allGroups)
  const counts = { critical: 0, high: 0, medium: 0, low: 0, high_bug: 0, bug: 0, informational: 0 }
  const colorCounts = { red: 0, blue: 0, green: 0, gray: 0, none: 0 }
  const bump = (tally, key) => { tally[key] = (tally[key] || 0) + 1 }
  for (const g of selectorGroups) {
    for (const sev of new Set(g.map((f) => displayedSeverity(f, state.severityMode)))) bump(counts, sev)
    for (const color of new Set(g.map((f) => triageEntry(f)?.color ?? 'none'))) bump(colorCounts, color)
  }
  // Repository choices within the same selectors and lens; null is the
  // no-repo bucket. A scope filter or workspace change can remove the pick.
  const repoSet = repositoryFilterValues(selectorGroups)
  const repoOptions = [...repoSet].toSorted(nullLastCmp)
  if (state.filterRepo && !repoSet.has(runFilterValue(state.filterRepo, NO_REPO_SENTINEL))) state.filterRepo = ''

  const filtered = applySorting(applyFilters(allGroups))

  // The Files view and the graph view mode need a tree of more than one
  // file, merged across the loaded reports; stale state on a report swap
  // falls back to the findings. A team's reports tell how many files their
  // trees hold, the trees asked for once its graph or Files shows
  // (managed-trees.js), loading meanwhile.
  const treeData = mergeReportsTree(state.reports)
  const treeFileCount = treeData ? Object.keys(treeData).length : state.reports.reduce((sum, r) => sum + (r.treeFiles ?? 0), 0)
  const treesLoading = treeFileCount > 1 && !treeData && (state.currentView === 'files' || state.viewMode === 'graph')
    && loadManagedTrees(loaded => { if (!loaded) leaveTrees(); render() })
  const treeAvailable = treeFileCount > 1
  // A team's board is drawn before its findings have their detail; any
  // other view mode waits for it, saying it is loading or that it never
  // came, as does a lens other than App's where the board's copy folded
  // rows under their App row, and where it holds only the rows its App view
  // shows, any view but that one: the whole team's, on Confirmed
  // (managed-details.js).
  const appLens = revalidationShown() && !underlyingFindingsShown()
  const folded = managedDetailsFolded()
  const drawnFromCopy = !folded || appLens && (folded === 'rows' || Boolean(state.currentWorkspace) && state.filterRevalidate === 'confirmed')
  const detailsWaiting = state.viewMode === 'kanban' && drawnFromCopy ? null : managedDetailsWaiting()
  if (!treeAvailable || !treeData && !treesLoading) leaveTrees()

  const headerTpl = headerTemplate(mergedGroups, fileNames, repoInputUseful, knownRepo, treeFileCount)

  if (state.currentView === 'files') {
    const findingCounts = computeFindingCountsByFile(mergedGroups, state.severityMode)
    // Lit diffs the tree in place (scroll and expand state kept).
    const [fHeader, treeSlot] = ensureReportSlots('header-slot', 'tree-view-slot')
    litRender(headerTpl, fHeader)
    litRender(treeData ? renderTreeView(treeData, findingCounts) : loadingTemplate('files'), treeSlot)
    showReport()
    document.title = `DeepView — ${typeLabel || 'no analyzer'}`
    return
  }

  // The findings body sits in a capped, left-aligned wrapper (the header
  // spans the page); `.with-details` widens it for the table's list +
  // details, and graph mode lifts the cap for the canvas, which brings the
  // view-mode chooser into its own topbar instead of a toolbar above it.
  const tableWithDetails = state.viewMode === 'table' && state.tableSelectedGid && filtered.some((g) => groupKey(g) === state.tableSelectedGid)
  let g2DataForBody = null
  if (state.viewMode === 'graph' && treeData && !detailsWaiting) {
    g2DataForBody = buildGraph2Data()
    // The tree gone since the gate above (a workspace switch race).
    if (!g2DataForBody) state.viewMode = 'kanban'
  }
  const wrapperClass = ['findings-content', tableWithDetails && 'with-details', g2DataForBody && 'with-graph', isKanban && 'with-kanban',
    state.viewMode === 'focus' && 'with-focus'].filter(Boolean).join(' ')
  const selectedGroup = findingDetailGroup(filtered, state, prevFocusedIdx)
  // Reset on every path, so a graph render can't reattach a stale list.
  pendingTableItems = null

  // Outside graph mode, the toolbar, the empty-state line and the body, by
  // slot. The empty-state line, `typeLabel` (analyzer-controlled) escaped
  // by Lit: an empty bucket of a load with findings says they were all
  // triaged. Kanban sits out the filters line: each empty column says it
  // already, and as a flex child of `.with-kanban` the line would push the
  // board down whenever a filter empties the view.
  const bodySlots = g2DataForBody ? null : {
    'toolbar-slot': toolbarTemplate({
      filteredCount: filtered.length, allCount: allGroups.length, triageCounts, counts, colorCounts, repoOptions,
      // Counts use the scope-filtered rows; the option lists stay stable so
      // values those filters exclude can still show zero.
      analyzerSelect: { shown: runFiltersShown, analyzers: analyzerOptions, models: modelOptions, validationModels: validationModelOptions, groups: scopeRows(allGroups) },
      showSource, hasAnyConfidence, hasAnyPriority, treeAvailable, hasMultipleFiles, isKanban, hasComment, hasIssue, hasFix, hasFlagged, hasDuplicates,
      hasCrossContext, hasAppStacked, showSecurity, hasCorrectedSeverity, revalidateOptions, showPartial, canDropLayer, canDetailLayer, canUpstreamLens, confirmedLocked,
    }),
    'empty-state-slot': state.shownTriage && allGroups.length === 0 ? notice(MUTED, `No ${state.shownTriage} findings.`)
      : filtered.length === 0 && allGroups.length > 0 && !isKanban ? notice(MUTED, 'No findings match the current filters.')
      : allGroups.length === 0 ? notice(GREEN, mergedGroups.length > 0 ? `All ${typeLabel} issues triaged.` : `No ${typeLabel} issues found.`)
      : nothing,
    'findings-body-slot': treesLoading ? loadingTemplate('graph') : detailsWaiting === 'loading' ? loadingTemplate('findings')
      : detailsWaiting ? html`<p class="triage-loading" role="status">${DETAILS_FAILED}</p>` : findingsBodyTemplate(filtered, selectedGroup, groupStates),
  }

  // The chrome is rebuilt only when its shape changes (arrival from another
  // view, or into / out of graph mode); within a shape every render diffs
  // into the existing slots, so scroll, focus and the <finding-table>
  // survive without capture-restore.
  const shape = bodySlots ? Object.keys(bodySlots) : ['findings-graph-slot']
  let headerSlot = document.querySelector('#header-slot')
  let wrapper = report.querySelector(':scope > .findings-content')
  if (!headerSlot || !report.contains(headerSlot) || !wrapper?.querySelector(`:scope > #${shape.at(-1)}`)) {
    headerSlot = reportSlot('header-slot')
    wrapper = Object.assign(document.createElement('div'), { className: wrapperClass })
    wrapper.append(...shape.map((id) => reportSlot(id)))
    replaceReport(headerSlot, wrapper)
  } else if (wrapper.className !== wrapperClass) {
    wrapper.className = wrapperClass
  }

  litRender(headerTpl, headerSlot)
  if (bodySlots) {
    // Every slot drawn, `nothing` clearing what the last render left there.
    for (const [id, template] of Object.entries(bodySlots)) litRender(template, document.querySelector(`#${id}`))
  } else {
    // Graph mode: the canvas, the view-mode chooser as an extra row of its
    // own topbar, and the triage counts tallied above (in the main bundle,
    // so the lazy graph bundle stays free of `groupState` / `state`).
    attachGraphLayout(document.querySelector('#findings-graph-slot'), g2DataForBody, {
      extraTopRow: html`<view-mode-buttons modes="kanban,focus,table,list,grouped,graph"></view-mode-buttons>`,
      triageCounts,
      triageStates: ['inprogress', 'fixed', 'invalid', 'deleted', 'ignored'],
    }, refreshGraph2Sidebar, refreshGraph2TopPkgs)
  }

  // Hand the <finding-table> its rows and selection by property (object
  // identity kept, no attribute round trip). It moves into the static slot
  // only when that slot was rebuilt; steady renders update properties only.
  if (pendingTableItems) {
    const slot = report.querySelector('.finding-table-slot')
    if (slot) {
      persistentFindingTable ??= document.createElement('finding-table')
      persistentFindingTable.items = pendingTableItems
      persistentFindingTable.selectedGid = state.tableSelectedGid
      if (persistentFindingTable.parentNode !== slot) slot.append(persistentFindingTable)
    }
  }
  showReport()
  document.title = `DeepView — ${typeLabel || 'no analyzer'}`
  if (isManagedUiMode()) managedHistory?.replaceFindingRoute(managedFindingSelectionRoute(selectedGroup, state))
}
