import { automaticFixFor } from './managed-issues.js'
import { sharedFindingTriage, usesReportIgnore } from '../../client/ignored-triage.js'
import { duplicatesOf, getPackagesIndex, isManagedUiMode, isReportIgnored, patchEntry, state } from '#client/index.js'
import { stampSecurityGroups } from '@preventive/report'
import { SEVERITY_ORDER, canDropRevalidation, depsDirName, displayedSeverity, isRevalidation, isRuledOut } from './format.js'
// filters.js imports this module too. The cycle is benign: both sides only
// call across inside function bodies, never during module evaluation.
import { matchesRunTab } from './filters.js'
import { mergeReportGroups } from '../../common/workspace-groups.js'
import { roleAtLeast } from '../../common/managed/roles.ts'
import { commentAuthorName } from '../../common/managed/comments.ts'
import { getLinksPreview } from './links-preview.js'
import { securityStampOptions } from './security-stamp.js'
import { mergeLinkedWorkspaceGroups } from '../../common/linked-workspace-groups.js'
import { splitRevalidationInputs } from '../../common/revalidation-input-groups.js'
import { tabKey } from '../../common/finding-filters.js'
import { ignoresOwnRepo } from '../../common/finding-repo.js'

// Every `state.reports[].groups[i]` is a Finding[] (wrapped at ingest).
// `tabKey` names a tab (= finding); `groupKey` the group, by its first
// member or the App identity of a separate workspace row, so it survives
// tab sorting.
export { tabKey }
export function groupKey(group) { return group.workspaceKey ?? tabKey(group[0]) }

// The detail stop of the App switch: a group the pass re-examined shows the
// rows it re-rated too, not only the pass's row. In a workspace the rows the
// pass RULED OUT are already gone (workspace-groups.js hideRuledOut), so the
// stop can't bring those back there.
export function underlyingFindingsShown() {
  return state.revalidationDetailed === true
}

// A report without an App layer has no App-specific triage restriction.
// Cached by the reports array: canTriageFinding runs for every tab and
// control on every render.
let appLayerReports = null
let appLayerOn = true
function appLayerAvailable() {
  const reports = state.reports
  if (!Array.isArray(reports) || reports.length === 0) return true
  if (reports !== appLayerReports) {
    appLayerReports = reports
    appLayerOn = canDropRevalidation(reports)
  }
  return appLayerOn
}

// App view neither reads nor writes upstream triage data. The upstream lens
// and code mode expose the dependency's saved annotations without changing them.
export function canTriageFinding(f) {
  return !f.isUpstream || state.showRevalidation === false || state.upstreamOnly === true || !appLayerAvailable()
}

// Public links and the Viewer role read triage but can never save it, so their
// controls stay disabled instead of editing a copy nobody else sees. An admin
// viewing as another account keeps that account's controls: the server refuses
// those writes and the client puts the refused state back.
export function triageReadOnly() {
  const session = state.managedSession
  return isManagedUiMode() && (session?.publicShare === true || !roleAtLeast(session?.role, 'triage'))
}

// Every triage write goes through this; reads keep canTriageFinding.
export function canEditTriage(f) {
  return canTriageFinding(f) && !triageReadOnly()
}

export function triageEntry(f) {
  if (!canTriageFinding(f)) return undefined
  const raw = state.triage.get(tabKey(f))
  const entry = raw?.triage === 'ignored' && usesReportIgnore(f, depsDirName()) ? { ...raw, triage: undefined } : raw
  if (!isManagedUiMode()) return entry
  // A read-only projection keeps search, annotation filters, and copy helpers
  // useful without putting managed comments into the triage/sync write path.
  const comments = state.managedComments?.get(f.id) ?? []
  if (comments.length === 0 && !entry?.comment) return entry
  // Each under who it shows as by (managed-comment.js), as search finds it.
  const told = comment => { const author = commentAuthorName(comment); return author ? `${author}: ${comment.body}` : comment.body }
  return { ...entry, comment: comments.map(told).join('\n\n') }
}

// Per-report ignores are keyed by the finding's source report
// (`_reportName`, stamped at ingest), so an ignore in report A stays there.
export function isIgnored(f) {
  return canTriageFinding(f) && (sharedFindingTriage(f, state.triage.get(tabKey(f)), depsDirName()) === 'ignored'
    || (usesReportIgnore(f, depsDirName()) && isReportIgnored(state.triage, tabKey(f), f?._reportName ?? '')))
}

// The tab's bucket: shared App/own-code triage, or a per-report dependency
// ignore. `entry` is passed when the caller already read it: this is the
// hottest helper of the findings render, and must not read twice per tab.
export function tabTriage(f, entry = triageEntry(f)) {
  if (!canTriageFinding(f)) return undefined
  return sharedFindingTriage(f, entry, depsDirName()) ?? (isIgnored(f) ? 'ignored' : undefined)
}

// The tabs of a group the lens DRAWS. With the detail stop off (the
// default), a group the pass re-examined is the pass's row alone; a group
// it never saw keeps every tab. Through the gate (`isRevalidation`), so off
// the App lens nothing is folded. The folded rows stay IN the group for
// filtering and triage. Returns the group itself when nothing is hidden.
export function drawnTabs(group) {
  // A links preview shows the whole original row, the clicked finding too.
  if (getLinksPreview()?.group === group) return group
  if (group.linkedTabs) return group.linkedTabs
  if (underlyingFindingsShown()) return group
  return foldedTabs(group)
}

// The fold without the detail stop: what a workspace merges by, so the stop
// stays a display choice and never moves a row's identity, active tab or
// status-write scope.
function foldedTabs(group) {
  return group.length > 1 && group.some(isRevalidation) ? group.filter(isRevalidation) : group
}

// Tab order within a group: the revalidation row first (the pass that
// re-examined the finding is what a reader opening it wants), then colored
// tabs, then higher severity, then higher confidence. The first is the
// group's primary: its representative for group sorting and the last-resort
// active tab (activeTabFor). Returns the drawn array itself when there is
// nothing to reorder — this runs several times per group per render.
// Callers treat the result as read-only.
const TAB_RANKS = [
  (f) => (isRevalidation(f) ? 1 : 0),
  (f) => (triageEntry(f)?.color ? 1 : 0),
  (f) => SEVERITY_ORDER[displayedSeverity(f, state.severityMode)] || 0,
  (f) => f.confidence ?? -1,
]
export function sortTabs(group) {
  const tabs = drawnTabs(group)
  if (tabs.length <= 1) return tabs
  return tabs.toSorted((a, b) => {
    for (const rank of TAB_RANKS) {
      const d = rank(b) - rank(a)
      if (d) return d
    }
    return 0
  })
}

export function primaryTab(group) { return group.length === 1 ? group[0] : sortTabs(group)[0] }

// The tab strip's levels, sorted order kept; `isApp` is stamped at ingest.
export function groupTabsByLevel(tabs) {
  const app = [], source = []
  for (const f of tabs) (f.isApp ? app : source).push(f)
  return { app, source }
}

// Whether a tab carries an annotation marker (comment, fix link, raised
// flag) — the glyphs tabMarksTemplate draws; empty / `false` forms count
// as absent, as there and in the toolbar filters.
export function tabHasMarks(f) {
  const entry = triageEntry(f)
  return Boolean(entry?.comment) || Boolean(entry?.fix || automaticFixFor(f)) || entry?.flagged === true
}

export function activeTabFor(group) {
  // Every branch below resolves to a lone member, so skip the reads.
  if (group.length === 1) return group[0]
  // Picked from the DRAWN tabs, the stored pick included: a group parked on
  // a tab the lens has since folded must not open on a tab off the strip.
  const sorted = sortTabs(group)
  if (sorted.length === 1) return sorted[0]
  const stored = state.activeTabByGroup.get(groupKey(group))
  if (stored) {
    const match = sorted.find((f) => tabKey(f) === stored)
    if (match) return match
  }
  // No explicit pick: while the analyzer/model dropdown is set, the tabs it
  // matches (a group shows when ANY does, so it must not open on one it
  // filtered away); else all of them. Within that, the first annotated tab,
  // else the first. The full-strip fallback is for callers resolving groups
  // outside the filtered render path.
  let pool = sorted
  if (state.filterAnalyzer || state.filterModel || state.filterValidationModel) {
    const matching = sorted.filter(matchesRunTab)
    if (matching.length > 0) pool = matching
  }
  return pool.find(tabHasMarks) ?? pool[0]
}

// The repo a finding's links resolve against: its report's `_repoFallback`
// stamp (the report's declared repo, else the URL typed for it), then the
// single-file view's `state.repoUrl`. `||`, not `??`: ingest stamps '' on a
// report with no repo, and that must not stop a URL typed later.
export function findingRepoFallback(f) {
  return f?._repoFallback || state.repoUrl || ''
}

// That repo with its report's `directory` and commit (ingest's
// `_repoDirectory` / `_repoCommit`): the `repoFallback` every file / line /
// evidence link takes. A finding's OWN `repo` is read by fileUrl; the two
// never mix.
export function findingRepoTarget(f) {
  return { github: findingRepoFallback(f), directory: f?._repoDirectory ?? '', commit: f?._repoCommit ?? '' }
}

// The handoff's `Repo:` line: a node_modules file's package bucket's repo
// when it maps to exactly one upstream, else the finding's `repo.github`,
// else the fallback; null when none is known. A `repo` naming the package
// the finding advises against is the report's (common/finding-repo.js).
export function findingRepo(f) {
  if (f._repoIgnored || ignoresOwnRepo(f, findingRepoFallback(f))) return findingRepoFallback(f) || null
  for (const bucket of getPackagesIndex().values()) {
    if (bucket.files.has(f.file)) {
      return bucket.repos?.size === 1 ? [...bucket.repos][0] : null
    }
  }
  return f.repo?.github || findingRepoFallback(f) || null
}

// The members a group's triage speaks for and is read from: the app's own
// members, never the upstream code beneath them. "Fixed" on the app's
// finding means THIS app no longer has it; the dependency is no more fixed
// for everyone else shipping it. Upstream members are triaged on their own,
// under the upstream lens. A group of nothing but upstream members is its
// own set. Returns the group itself when nothing is dropped.
export function triageTabs(group) {
  if (!Array.isArray(group)) return []
  const own = group.filter((f) => !f.isUpstream)
  return own.length === 0 || own.length === group.length ? group : own
}

// Group-level triage rollup over triageTabs:
//   1. A tab is annotated when it has a color and/or a bucket; others are
//      neutral and never conflict.
//   2. Annotated tabs conflict when two distinct colors are present, or
//      their buckets differ (an annotated tab without one counts as its own
//      value). Conflict → dashed outline; the group stays in the live view.
//   3. Otherwise the card takes the common color and the common bucket.
//   4. Click handlers enforce the inverse (events.js).
//   A(green, deleted), B(), C()            → deleted, A green
//   A(green, deleted), B(deleted), C()     → deleted, A green
//   A(green, deleted), B(red), C()         → conflict (colors)
//   A(green, deleted), B(green), C()       → conflict (deleted vs none)
//   A(green, fixed), B(green, deleted), C()→ conflict (fixed vs deleted)
// One allocation-free pass: this runs per group in the orchestrator and
// again per row/card template.
export function groupState(group) {
  const members = triageTabs(group)
  let annotated = 0
  let color
  let bucket
  let hasConflict = false
  let anyTriage = false
  // Every annotated tab carries a shared bucket (a per-report ignore isn't).
  let allBucketed = true
  for (const f of members) {
    const entry = triageEntry(f)
    const tabBucket = tabTriage(f, entry)
    const tabColor = entry?.color
    if (tabColor === undefined && tabBucket === undefined) continue
    if (tabColor !== undefined) {
      if (color === undefined) color = tabColor
      else if (tabColor !== color) hasConflict = true
    }
    if (annotated++ === 0) bucket = tabBucket
    else if (tabBucket !== bucket) hasConflict = true
    if (!tabBucket || (tabBucket === 'ignored' && entry?.triage !== 'ignored')) allBucketed = false
    else anyTriage = true
  }
  // One of 'inprogress' / 'fixed' / 'invalid' / 'deleted' / 'ignored', or null.
  const commonTriage = !hasConflict && bucket ? bucket : null
  return {
    hasConflict,
    commonColor: !hasConflict && color !== undefined ? color : null,
    anyTriage,
    allTriaged: annotated > 0 && allBucketed,
    commonTriage,
    // Every member ignored, dependency members whose per-report ignore a
    // shared one can't level included.
    allIgnored: commonTriage === 'ignored' && annotated === members.length,
    isInProgress: commonTriage === 'inprogress',
    isFixed:    commonTriage === 'fixed',
    isInvalid:  commonTriage === 'invalid',
    isDeleted:  commonTriage === 'deleted',
    isIgnored:  commonTriage === 'ignored',
  }
}

// Whether a fix link edited on one tab can be offered to the group: it has
// at least two editable tabs, each carrying no link or the very link being
// edited (`current`, its value BEFORE the edit, '' for none). Differing
// links mean someone said the members differ. Trimmed on both sides: sync
// peers and imports can store a stray space.
export function canApplyFixToGroup(group, current) {
  if (!Array.isArray(group) || group.length < 2) return false
  const eligible = group.filter(canEditTriage)
  if (eligible.length < 2) return false
  const want = (current ?? '').trim()
  return eligible.every((f) => fixApplies(f, want))
}

// One tab's half of that test, re-asked per tab at write time: a sync peer
// can land a link on a sibling while the dialog is open.
export function fixApplies(f, current) {
  if (!canEditTriage(f)) return false
  const fix = (triageEntry(f)?.fix ?? '').trim()
  return fix === '' || fix === (current ?? '').trim()
}

// What a triage-menu click does: the tabs it applies to, and whether it
// sets or clears — both decided for the GROUP (per tab, a re-click flipped
// each tab instead of switching the state off). `clearing` when the scope
// already shows `action`, and always for 'restore'.
export function triageActionPlan(group, action) {
  // Controls belong to the displayed finding, even when their write would
  // otherwise target eligible siblings. Kanban drops use triageScope directly.
  if (!canEditTriage(activeTabFor(group))) return { targets: [], clearing: false }
  const st = groupState(group)
  return {
    targets: triageScope(group, st),
    clearing: action === 'restore' || scopedTriage(group, st) === action,
  }
}

// Whether a row's status speaks for its app-side members as a whole: a
// linked row, or an App row with underlying dependency members.
function appScoped(group, members = triageTabs(group)) {
  return Boolean(group.linkedTabs) || (members !== group && group.some((f) => f.isApp))
}

// Menu actions and kanban drops never reach underlying dependencies of an
// App row, whatever the active tab or detail stop; a conflicted homogeneous
// group targets its active tab.
export function triageScope(group, st = groupState(group)) {
  const members = triageTabs(group)
  const targets = appScoped(group, members) ? members : st.hasConflict ? [activeTabFor(group)] : members
  return targets.every(canEditTriage) ? targets : targets.filter(canEditTriage)
}

// The state that scope shows: what the menu marks active and a re-click
// clears — one definition, or clicking the marked state would set it again.
// `st` / `active` may be passed precomputed by the render path.
export function scopedTriage(group, st = groupState(group), active = null) {
  if (appScoped(group) || !st.hasConflict) return st.commonTriage ?? null
  return tabTriage(active ?? activeTabFor(group)) ?? null
}

// Level a group's triage: write the bucket its tabs agree on onto the tabs
// that carry none (a group triaged from an active-tab surface holds it on a
// subset, which exports and sync peers see as half in a bucket). Called
// when a finding's details open. Disagreements are the user's to resolve,
// and per-report ignores are left alone. Returns whether it wrote; callers
// persist it, deferred (`queueMicrotask(saveTriage)`), so a whole-map
// serialize can't land between an open and its paint.
export function syncGroupTriage(group) {
  // The rollup's own set: levelling is the rollup written back.
  const tabs = triageTabs(group)
  if (tabs.length < 2) return false
  const bucket = groupState(group).commonTriage
  if (!bucket) return false
  if (bucket === 'ignored' && !tabs.some(f => triageEntry(f)?.triage === 'ignored')) return false
  let changed = false
  for (const f of tabs) {
    if (!canEditTriage(f)) continue
    const key = tabKey(f)
    const entry = state.triage.get(key)
    // Anything off the bucket here carries none: another would conflict.
    if (tabTriage(f, entry) === bucket) continue
    // Shared ignores level only App/own-code tabs. Other buckets retain the
    // mutex, so don't level them over another report's dependency ignore.
    if (bucket === 'ignored' && usesReportIgnore(f, depsDirName())) continue
    if (bucket !== 'ignored' && entry?.ignoredReports?.length) continue
    if (patchEntry(state.triage, key, { triage: bucket })) changed = true
  }
  return changed
}

// The merge model, cached until the reports, workspace merges, known links
// or managed mode change, per lens. Original report rows stay intact; only
// their derived security stamp is updated.
let groupCache = null

export function clearMergedGroups() { groupCache = null }

function groupModel(showRevalidation, upstreamOnly = false, hideRuledOut = false) {
  const reports = state.reports
  const merges = state.workspaceMerges
  const managed = isManagedUiMode()
  if (!groupCache || groupCache.reports.length !== reports.length
      || groupCache.reports.some((r, i) => r !== reports[i])
      || groupCache.merges !== merges || groupCache.mergeCount !== merges.length
      || groupCache.securityLinksTick !== state.linksTick || groupCache.findingIndexTick !== state.findingIndexTick
      || groupCache.managed !== managed) {
    const groups = reports.flatMap((r) => r.groups ?? [])
    stampSecurityGroups(groups, securityStampOptions(groups))
    groupCache = { reports: [...reports], merges, mergeCount: merges.length, managed,
      securityLinksTick: state.linksTick, findingIndexTick: state.findingIndexTick }
  }
  const mode = upstreamOnly ? 'upstream' : showRevalidation ? hideRuledOut ? 'workspace-app' : 'app' : 'code'
  if (!groupCache[mode]) {
    groupCache[mode] = mergeReportGroups(reports, { showRevalidation: showRevalidation && !upstreamOnly, upstreamOnly, hideRuledOut, merges })
  }
  return groupCache[mode]
}

// `list` carrying `from`'s ruled-out ids, as the merge model's lists do.
function withRuledOutIds(list, from) {
  Object.defineProperty(list, 'ruledOutIds', { value: from.ruledOutIds, configurable: true })
  return list
}

// Every group the view COULD show, before the upstream lens narrows it: a
// deep link names a loaded finding whatever lens the reader stands behind
// (`unhideFinding` then takes the lens off, as it clears a filter).
export function linkableGroups() {
  return groupModel(state.showRevalidation !== false).groups
}

export function getRevalidationGroups() { return groupModel(true).groups }
export function getRevalidationConflicts() { return groupModel(true, false, Boolean(state.currentWorkspace)).conflicts }

export function getMergedGroups() {
  const model = groupModel(state.showRevalidation !== false, state.upstreamOnly === true, Boolean(state.currentWorkspace))
  const groups = model.groups
  if (state.showRevalidation === false || state.upstreamOnly) return groups
  if (state.currentWorkspace) {
    // Link grouping runs after visibility, report grouping and conflict
    // detection, and ahead of the detail check: a link is the reader's own
    // statement that two rows are one finding, whatever the stop shows.
    // Which rows may bridge is asked of `foldedTabs` (the same at either
    // stop); only the tabs the merged row keeps follow the stop, so the
    // merge is cached per detail state and links tick.
    const detailed = underlyingFindingsShown()
    if (!model.linkedGroups || model.linksTick !== state.linksTick || model.linkedDetailed !== detailed) {
      model.linkedGroups = mergeLinkedWorkspaceGroups(groups, duplicatesOf, foldedTabs, drawnTabs)
      model.linksTick = state.linksTick
      model.linkedDetailed = detailed
    }
    return model.linkedGroups
  }
  // The detailed app view hands back the ruled-out rows the simplified one
  // hides (a workspace's model dropped them before merging, render.js
  // canDetailLayer).
  if (underlyingFindingsShown()) return groups
  // Hide ruled-out findings before counts, filters, tabs and outcome options
  // are derived. isRuledOut already follows the App/upstream lens.
  return model.visibleGroups ??= withRuledOutIds(groups.flatMap((group) => {
    const kept = group.filter((f) => !isRuledOut(f))
    if (kept.length === group.length) return [group]
    if (kept.length === 0) return []
    kept.workspaceKey = groupKey(group)
    return [kept]
  }), groups)
}

// The merged groups on SCREEN: the triage bucket the reader is in
// (`state.shownTriage`, null for live), or every bucket in kanban — what
// the opening filters (filters.js applyOpeningFilters) are asked of.
// render.js's `allGroups` applies the same rule while counting buckets.
export function getShownGroups() {
  const groups = getMergedGroups()
  if (state.viewMode === 'kanban') return groups
  return withRuledOutIds(groups.filter((g) => groupState(g).commonTriage === state.shownTriage), groups)
}

// A rendered group plus the revalidation rows the lens dropped from it (see
// mergeReportGroups): the group a whole-group WRITE is about, since the
// pass's row is the same issue re-rated. Matched by member, not gid, as
// dropping a pass row can change `g[0]`. With the lens on, nothing was
// dropped.
export function groupWithPassRows(group) {
  if (state.showRevalidation || state.upstreamOnly || !Array.isArray(group) || group.length === 0) return group
  const keys = new Set(group.map(tabKey))
  const whole = new Map()
  for (const g of getRevalidationGroups()) {
    for (const partition of splitRevalidationInputs(g)) {
      if (partition.some((f) => keys.has(tabKey(f)))) for (const f of partition) whole.set(tabKey(f), f)
    }
  }
  if (whole.size === group.length && group.every((f) => whole.get(tabKey(f)) === f)) return group
  return whole.size > 0 ? [...whole.values()] : group
}

export function findGroupById(gid) {
  const previewGroup = getLinksPreview()?.group
  if (previewGroup && groupKey(previewGroup) === gid) return previewGroup
  for (const g of getMergedGroups()) if (groupKey(g) === gid) return g
  return null
}
