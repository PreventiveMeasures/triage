import { duplicatesOf, getPackagesIndex, isManagedUiMode, isReportIgnored, patchEntry, state } from '#client/index.js'
import { SEVERITY_ORDER, canDropRevalidation, displayedSeverity, isRevalidation, isRuledOut } from './format.js'
// NOTE: filters.js imports from this module too (primaryTab / tabKey).
// The cycle is deliberate and benign: both sides only call across
// inside function bodies, never during module evaluation, so whichever
// module evaluates first resolves the other's hoisted function
// declarations by the time anything runs.
import { matchesRunFilters } from './filters.js'
import { mergeReportGroups } from './workspace-groups.js'
import { getLinksPreview } from './links-preview.js'
import { mergeLinkedWorkspaceGroups } from './linked-workspace-groups.js'
import { splitRevalidationInputs } from './revalidation-input-groups.js'

// ID helpers. Internally every `state.reports[].groups[i]` is a
// Finding[] (single-finding entries are wrapped at ingest, so code
// downstream never branches on "is it a group?"). `tabKey` identifies
// an individual tab (= finding); `groupKey` identifies the group as a
// whole — uses the first member, or the App identity of a separate workspace
// row, so it survives tab-sort reordering without sharing a source-only key.
export function tabKey(f) { return f.id ?? String(f._id) }
export function groupKey(group) { return group.workspaceKey ?? tabKey(group[0]) }
export function toGroup(entry) { return Array.isArray(entry) ? entry : [entry] }

// The detail stop of the App switch: whether a group the pass re-examined
// shows the rows it re-rated, or the pass's row alone speaking for them.
//
// A workspace answers this the same way a report does. Folding is a fact
// about ONE row — a pass row and the analyzer's own rows beneath it, which
// arrive together from one report — so a merged view has the same thing to
// unfold, and the reader asking to see the workings is asking about the rows
// in front of them, not about how many apps contributed them. What a
// workspace cannot hand back is the rows the pass RULED OUT: those are
// dropped before its rows merge (workspace-groups.js hideRuledOut), so that
// one app's refutation can neither bridge two rows nor gap-fill another app's
// answer. render.js does not offer the stop on their account there.
export function underlyingFindingsShown() {
  return state.revalidationDetailed === true
}

export { mergeDuplicateFields, mergeReportDuplicateFields } from './finding-duplicates.js'

// Per-report ignore is keyed by the source report's filename so an
// ignore in report A doesn't propagate to the same finding's
// appearance in report B. The reportName comes from `f._reportName`,
// stamped at ingest (and on bundle index entries). Findings without a
// report (synthetic / single-file loads) fall back to an empty name;
// ignoring still works, but the persistence path can't separate them
// by report.
export function findingReport(f) {
  return f?._reportName ?? ''
}

// A report without an App layer has no App-specific triage restriction. Keep
// this cached by the reports array identity because canTriageFinding() is
// called for every tab and action control during a render.
let revalidationAvailabilityReports = null
let revalidationAvailable = true
function appLayerAvailable() {
  const reports = state.reports
  if (!Array.isArray(reports) || reports.length === 0) return true
  if (reports !== revalidationAvailabilityReports) {
    revalidationAvailabilityReports = reports
    revalidationAvailable = canDropRevalidation(reports)
  }
  return revalidationAvailable
}

// App view neither reads nor writes upstream triage data. The upstream lens
// and code mode expose the dependency's saved annotations without changing them.
export function canTriageFinding(f) {
  return !f.isUpstream || state.showRevalidation === false || state.upstreamOnly === true || !appLayerAvailable()
}

export function triageEntry(f) {
  if (!canTriageFinding(f)) return undefined
  const entry = state.triage.get(tabKey(f))
  if (!isManagedUiMode()) return entry
  // A read-only projection keeps search, annotation filters, and copy helpers
  // useful without putting managed comments into the triage/sync write path.
  const comments = state.managedComments?.get(f.id) ?? []
  if (comments.length === 0 && !entry?.comment) return entry
  return { ...entry, comment: comments.map(comment => `${comment.authorLogin ?? 'Unattributed'}: ${comment.body}`).join('\n\n') }
}

export function isIgnored(f) {
  return canTriageFinding(f) && isReportIgnored(state.triage, tabKey(f), findingReport(f))
}

// One tab's triage "bucket": its triage value if set, else 'ignored'
// when the tab sits in its report's ignore set, else undefined (live).
// Ignore behaves like a fourth bucket for rollup / conflict detection
// but mutates differently (per-report key, its own store), so every
// reader goes through this one definition rather than re-deriving it.
//
// `entry` is the tab's triage entry when the caller has already read it
// — groupState reads it for the color axis anyway, and this is the
// hottest helper in the findings render path, so it must not cost a
// second observable read per tab.
export function tabTriage(f, entry = triageEntry(f)) {
  if (!canTriageFinding(f)) return undefined
  return entry?.triage ?? (isIgnored(f) ? 'ignored' : undefined)
}

// The tabs of a group the App lens DRAWS. Detail off (the default),
// a group the pass re-examined is the pass's row ALONE: the analyzer's
// rows underneath it are what the pass went back and re-rated, and the
// app view is about its answer rather than its workings. The icon
// in the App switch (`state.revalidationDetailed`) brings them back.
//
// Only a group the pass actually spoke about loses anything — a
// finding it never saw has no row above it to stand for it, so it
// keeps every tab it has.
//
// Through the layer's own GATE (`isRevalidation`, not the raw
// the raw revalidation kind the group builder reads): this hides rows only
// while the app view is the one on screen, and off it answers false
// for every row, which is the whole guard it needs. The two readers
// pull in opposite directions on purpose — the group builder has to see
// the pass's rows precisely when the gate has stopped showing them,
// to take them out; this one has nothing to do the moment they are
// gone.
//
// Unlike row-dropping, this leaves the underlying findings IN the group
// for row filtering and triage. Selector stats use this visible projection
// so hidden tabs don't contribute values to the toolbar.
// Row status actions include own source, but leave underlying dependency
// statuses alone (see triageTabs), regardless of this display switch.
//
// Returns the group array itself whenever nothing is hidden, so
// sortTabs's identity note below still holds for every set without a
// pass row in it.
export function drawnTabs(group) {
  // Links previews show the entire original report row, including the
  // clicked finding when the normal App lens would fold it under a pass.
  if (getLinksPreview()?.group === group) return group
  if (group.linkedTabs) return group.linkedTabs
  if (underlyingFindingsShown()) return group
  return foldedTabs(group)
}

// The same fold with the detail stop left out of it — what the app view
// shows of a row when it is speaking for the rows beneath it.
//
// Which rows a workspace MERGES is answered through this rather than
// through `drawnTabs`, so that the detail stop stays what it says it is: a
// display choice about one row, not a change to which rows exist. Answered
// through the drawn projection instead, an explicit link between two rows'
// dependency tabs would join their App rows the moment the reader asked to
// see the workings, and part them again on the way back — moving each
// row's identity, its active tab and the scope of a status write under a
// control that promised to change none of them.
function foldedTabs(group) {
  if (group.length <= 1) return group
  if (!group.some(isRevalidation)) return group
  return group.filter(isRevalidation)
}

// Tab sort order within a group: the revalidation row first, then
// colored tabs (drawing attention to already-triaged cases), then
// higher severity, then higher confidence.
//
// The revalidation row outranks every other key because it is not a
// competing account of the finding — it is the pass that went back and
// re-examined it, so a reader opening the group wants it whatever the
// original rows claim for themselves. Several of them in one group
// (a finding revalidated more than once) fall through to the keys
// below and order among themselves as any other tabs would.
//
// The first tab after sort is the group's "primary" — the
// representative for group-level sorting (file/severity/confidence
// dropdowns) and the last-resort default active tab (the full
// default-tab resolution — explicit pick, analyzer/model-filter match,
// annotation marker — lives in activeTabFor below).
//
// Returns the group array itself for ≤1-tab groups (the overwhelmingly
// common case — most dedup groups hold a single finding): there is
// nothing to reorder, and this helper sits on the hottest render path
// (per group per render, several times per row/card template), so the
// copy + toSorted would be pure allocation churn. Callers treat the
// result as read-only either way — including the array drawnTabs
// builds when the lens folds a group's rows under the pass's.
export function sortTabs(group) {
  const tabs = drawnTabs(group)
  if (tabs.length <= 1) return tabs
  return [...tabs].toSorted((a, b) => {
    const aRevalidation = isRevalidation(a) ? 1 : 0
    const bRevalidation = isRevalidation(b) ? 1 : 0
    if (aRevalidation !== bRevalidation) return bRevalidation - aRevalidation
    const aColored = triageEntry(a)?.color ? 1 : 0
    const bColored = triageEntry(b)?.color ? 1 : 0
    if (aColored !== bColored) return bColored - aColored
    const aSev = SEVERITY_ORDER[displayedSeverity(a, state.severityMode)] || 0
    const bSev = SEVERITY_ORDER[displayedSeverity(b, state.severityMode)] || 0
    if (aSev !== bSev) return bSev - aSev
    const aConf = a.confidence ?? -1
    const bConf = b.confidence ?? -1
    return bConf - aConf
  })
}

export function primaryTab(group) { return group.length === 1 ? group[0] : sortTabs(group)[0] }

// Presentation groups for the tab strip, preserving the sorted order within
// each level. `isApp` is stamped per finding where it is built and answers the same
// question this used to re-derive — including reading the revalidation stamp
// raw, regardless of the App lens.
export function groupTabsByLevel(tabs) {
  const app = [], source = []
  for (const f of tabs) (f.isApp ? app : source).push(f)
  return { app, source }
}

// Whether a tab (finding) carries an annotation marker — a comment, a
// fix link, or a raised attention flag, i.e. the glyphs the tab strip
// renders after the severity badge (see tabMarksTemplate). Empty-string
// / `false`-tombstone forms count as absent, matching that render and
// the toolbar annotation filters.
export function tabHasMarks(f) {
  const entry = triageEntry(f)
  return Boolean(entry?.comment) || Boolean(entry?.fix) || entry?.flagged === true
}

export function activeTabFor(group) {
  // Single-tab fast path: every branch below resolves to the lone
  // member, so skip the lookups (this runs several times per row/card
  // template). Skipping the state reads is reactivity-safe — the
  // result can't change, so an observer needn't subscribe to them.
  if (group.length === 1) return group[0]
  // Every branch below picks from the tabs the lens DRAWS (sortTabs),
  // the stored pick included: a group can be parked on a tab the App
  // lens has since folded under the pass's row, and honouring that
  // would open the card on a row whose tab isn't on the strip to say
  // it is the one showing.
  const sorted = sortTabs(group)
  if (sorted.length === 1) return sorted[0]
  const stored = state.activeTabByGroup.get(groupKey(group))
  if (stored) {
    const match = sorted.find((f) => tabKey(f) === stored)
    if (match) return match
  }
  // No explicit selection yet. Candidate pool: all tabs in display
  // order, narrowed to the tabs matching the analyzer/model dropdown
  // while that filter is active — a group stays visible when ANY tab
  // matches (group-level some() in applyFilters), so without the
  // narrowing a group could open on the very duplicate the user just
  // filtered away from (filter to analyzer B, group still presents
  // its analyzer-A tab). The full-strip fallback when no tab matches
  // is purely defensive under the current wiring — every rendered
  // group passed applyFilters, which embeds this same predicate — but
  // callers that resolve groups outside the filtered render path
  // (gid-based event handlers, future surfaces) must never strand a
  // group without an active tab.
  //
  // Within the pool: prefer the first tab carrying an annotation
  // marker so an annotated sibling opens first; else the pool's first
  // (= primaryTab(group) when unfiltered).
  let pool = sorted
  if (state.filterAnalyzer || state.filterModel) {
    const matching = sorted.filter(matchesRunFilters)
    if (matching.length > 0) pool = matching
  }
  return pool.find(tabHasMarks) ?? pool[0]
}

// The repo a finding's file / line links resolve against, as a bare
// identifier — the handoff block's `Repo:` line, and half of the
// `repoFallback` argument `fileUrl` / `findingUrl` / `fileLink` /
// `lineLink` take (`findingRepoTarget` below pairs it with the
// directory). Per-report `_repoFallback` first (stamped at
// ingest: the report's own `repo.github` declaration when it has one,
// else the URL typed for that report), so a workspace merge resolves
// each report against its own repo; the single-file view's
// `state.repoUrl` fills in behind it.
//
// `||`, not `??`: ingest stamps `''` — not absent — on a report with
// no repo of its own, and `??` would accept that empty string as an
// answer. Every link then stayed dead after the user typed a URL into
// the header chip, because nothing re-stamps the loaded findings and
// the empty stamp short-circuited the chain until a reload. An empty
// repo is not a repo; only a non-empty one ends the chain.
export function findingRepoFallback(f) {
  return f?._repoFallback || state.repoUrl || ''
}

// That repo with the `directory` its report declared beside it — the
// `{ github, directory }` pair format.js's link builders take, and so
// what every caller rendering a file / line / evidence link passes.
// `_repoDirectory` is the ingest stamp of the report header's
// `repo.directory` (report/src/meta.js repoDirectory): where inside
// the repository the tree the report describes sits, which is a fact
// about that report's paths rather than about one repo, so it
// qualifies whichever repo answers for the report above — the one it
// declared, or the URL the reader typed when it declared none.
//
// A finding's OWN `repo` carries its own directory and is read off the
// finding by `fileUrl`; the two are never mixed.
export function findingRepoTarget(f) {
  return { github: findingRepoFallback(f), directory: f?._repoDirectory ?? '' }
}

// Repo identifier (slug or URL) for a finding, matching the `Repo:`
// line of the copy / Claude / GitHub-issue handoff block: a
// node_modules file resolves to its package bucket's repo when that
// bucket maps to exactly one upstream, otherwise the per-finding
// `repo.github` / the resolved fallback above. Returns null when
// none of those is known.
export function findingRepo(f) {
  for (const bucket of getPackagesIndex().values()) {
    if (bucket.files.has(f.file)) {
      return bucket.repos?.size === 1 ? [...bucket.repos][0] : null
    }
  }
  return f.repo?.github || findingRepoFallback(f) || null
}

// The members a group's triage speaks for, and is read from.
//
// A group can hold both halves of one problem: the app's own finding,
// and the upstream code underneath it — the rows the App lens folds
// away and "Show underlying code findings" brings back. They look
// alike on the card and they are not the same claim. "Fixed" on the
// app's finding says THIS app no longer has the problem, usually
// because the dependency was dropped or pinned; the dependency itself
// is no more fixed for that, and everyone else still shipping those
// bytes still has it. Letting one write answer for both is how a
// dependency ends up marked fixed in apps nobody has looked at.
//
// So a group-level write lands on the app's own members only, and the
// rollup reads the same set — what the card shows, which kanban column
// it sits in and which triage filter it answers to are all decided by
// the findings that write would have reached. An upstream member keeps
// whatever it was told directly, which is how it is told anything at
// all: the upstream lens exposes those findings for triage separately.
// A mixed App row never writes to the underlying dependency, even when
// that dependency is the active tab.
//
// A group of nothing BUT upstream members has no second reading to
// prefer — there they are what the card is, and they both decide and
// receive. Returns the group itself whenever nothing is dropped, so
// callers relying on array identity keep it.
export function triageTabs(group) {
  if (!Array.isArray(group)) return []
  const own = group.filter((f) => !f.isUpstream)
  return own.length === 0 || own.length === group.length ? group : own
}

// Group-level triage rollup. User spec:
//   1. A tab is "annotated" if it has a color AND/OR a triage state
//      (inprogress / fixed / invalid / deleted). Unannotated tabs are neutral —
//      they don't contribute to the rollup and can never cause a
//      conflict on their own.
//   2. Among annotated tabs, a conflict exists iff they disagree on
//      color OR on triage state. "Disagree on color" means two or
//      more distinct non-null colors are present (a tab annotated
//      only via triage, with no color, never conflicts with a
//      colored tab purely on the basis of its missing color).
//      "Disagree on triage" means the set of triage values across
//      annotated tabs has size > 1, where an undefined triage on an
//      annotated (color-only) tab counts as its own value. Conflict
//      → dashed outline on the card; per-tab colors still render on
//      each tab button; the group stays in the main (live) view.
//   3. Otherwise (consistent annotated tabs), the card takes the
//      common color (if any annotated tab is colored); any annotated
//      tab carrying a triage state puts the whole group in that
//      bucket (inprogress / fixed / invalid / deleted).
//   4. Click handlers enforce the inverse — see events.js.
// Examples (where A/B/C are tabs in one dedup group):
//   A(green, deleted), B(), C()            → no conflict, deleted, A is green
//   A(green, deleted), B(deleted), C()     → no conflict, deleted, A is green
//   A(green, deleted), B(red), C()         → conflict (colors disagree)
//   A(green), B(blue), C()                 → conflict (colors disagree)
//   A(green, deleted), B(green), C()       → conflict (triage disagrees: deleted vs none)
//   A(green, fixed), B(green, deleted), C()→ conflict (triage disagrees: fixed vs deleted)
export function groupState(group) {
  const statusMembers = triageTabs(group)
  // Per-tab "bucket": triage value if set, else 'ignored' if the
  // tab is in the ignore set, else undefined (live). Ignore behaves
  // like a fourth bucket for rollup / conflict detection but
  // mutates differently (per-report key) and doesn't propagate
  // cross-report at the action layer (see events.js).
  //
  // Single allocation-free pass — this is the hottest helper in the
  // findings render path (once per group in the orchestrator, again
  // per row/card template), so distinct-value tracking happens with
  // first-seen + conflict flags rather than intermediate arrays/Sets.
  // We only ever need "zero / one / more than one distinct values"
  // plus the first member, which the flags capture exactly. The
  // Observable reads follow the active lens: restricted upstream entries
  // are not read until the lens makes their annotations applicable.
  let annotatedCount = 0
  // Distinct non-undefined colors across annotated tabs.
  let colorsConflict = false
  let firstColor
  let sawColor = false
  // Distinct bucket slots across annotated tabs, where "annotated but
  // no bucket" (a colored-only tab, bucket === undefined) counts as
  // its own value so it disagrees with a bucket-bearing sibling —
  // matches the original deleted-vs-not semantic where an
  // annotated-undeleted tab broke consensus with an annotated-deleted
  // one.
  let bucketsConflict = false
  let firstBucketSlot
  let sawBucketSlot = false
  // First truthy bucket in group order (= the rollup's common bucket
  // when there's no conflict).
  let firstTriage = null
  let anyTriage = false
  // Every annotated tab carries a truthy bucket !== 'ignored'.
  let allBucketed = true
  for (const f of statusMembers) {
    const entry = triageEntry(f)
    const bucket = tabTriage(f, entry)
    const color = entry?.color
    if (color === undefined && bucket === undefined) continue
    annotatedCount++
    if (color !== undefined) {
      if (!sawColor) { sawColor = true; firstColor = color }
      else if (color !== firstColor) colorsConflict = true
    }
    if (!sawBucketSlot) { sawBucketSlot = true; firstBucketSlot = bucket }
    else if (bucket !== firstBucketSlot) bucketsConflict = true
    if (bucket) {
      if (firstTriage === null) firstTriage = bucket
      if (bucket === 'ignored') allBucketed = false
      else anyTriage = true
    } else {
      allBucketed = false
    }
  }
  const hasConflict = colorsConflict || bucketsConflict
  const commonColor = !hasConflict && sawColor ? firstColor : null
  const allTriaged = annotatedCount > 0 && allBucketed
  // Common bucket — null when no consensus or live; one of
  // 'inprogress' / 'fixed' / 'invalid' / 'deleted' / 'ignored' otherwise.
  const commonTriage = !hasConflict && firstTriage !== null ? firstTriage : null
  return {
    hasConflict, commonColor, anyTriage, allTriaged, commonTriage,
    // True when EVERY tab is ignored, not just the annotated ones —
    // the one bucket `syncGroupTriage` never levels, so "the rollup says
    // ignored" and "each tab is ignored in its own report" are different
    // facts and the tab glyph has to key off the stricter one (see
    // tabTemplate). Safe as a count comparison: with no conflict, every
    // annotated tab shares the 'ignored' bucket, so a full annotated
    // count means a fully ignored group.
    allIgnored: commonTriage === 'ignored' && annotatedCount === statusMembers.length,
    // Convenience flags so downstream code that asks "is this group in
    // the trash bucket" needn't branch on commonTriage.
    isInProgress: commonTriage === 'inprogress',
    isFixed:    commonTriage === 'fixed',
    isInvalid:  commonTriage === 'invalid',
    isDeleted:  commonTriage === 'deleted',
    isIgnored:  commonTriage === 'ignored',
  }
}

// Whether a fix link edited on one tab can be offered to the whole
// group. Two conditions: the group has eligible siblings to apply it to, and
// every eligible tab either carries no link or carries the very link being
// edited (its value BEFORE this edit). Anywhere else the siblings hold
// references of their own, and a fix link names one specific PR or
// commit — a group whose members already differ is one where someone
// said they differ, so the offer would be to overwrite that.
//
// `current` is the pre-edit value; pass '' when the tab carries none.
// Both sides are trimmed: the dialog writes trimmed values but
// `normalizeEntry` stores whatever a sync peer or an import hands it,
// so a stray space would otherwise read as a different link and
// withhold the offer from a group that agrees.
export function canApplyFixToGroup(group, current) {
  if (!Array.isArray(group) || group.length < 2) return false
  const eligible = group.filter(canTriageFinding)
  if (eligible.length < 2) return false
  const want = (current ?? '').trim()
  return eligible.every((f) => fixApplies(f, want))
}

// One tab's half of that test, so the write can re-ask it per tab at
// the moment it writes — the offer is granted before the dialog opens,
// and a sync peer or another browser tab can land a link on a sibling
// while it sits there.
export function fixApplies(f, current) {
  if (!canTriageFinding(f)) return false
  const fix = (triageEntry(f)?.fix ?? '').trim()
  return fix === '' || fix === (current ?? '').trim()
}

// What a triage-menu click does: the tabs it applies to, and whether
// it sets the state or clears it. BOTH are decisions about the group,
// not about individual tabs — deciding per tab inside the apply loop
// turned a re-click into a per-tab flip (a group holding "In progress"
// on one of four tabs answered a second click with the other three,
// then flipped back) instead of the plain on/off a state menu owes the
// user.
//
// Scope: mixed rows target App and own-source findings; other conflicted rows
// retain the existing active-tab behavior. Source-only rows target sources.
//
// `clearing` is true when the scope ALREADY shows `action` — a
// re-click switches it off — and always for 'restore', which only
// clears. A group can show a state while holding it on a subset of its
// tabs (see syncGroupTriage), which is exactly why the question is
// asked of the rollup rather than of each tab.
export function triageActionPlan(group, action) {
  // Controls belong to the displayed finding, even when their write would
  // otherwise target eligible siblings. Kanban drops use triageScope directly.
  if (!canTriageFinding(activeTabFor(group))) return { targets: [], clearing: false }
  const st = groupState(group)
  return {
    targets: triageScope(group, st),
    clearing: action === 'restore' || scopedTriage(group, st) === action,
  }
}

// Both menu actions and kanban drops skip underlying dependencies in App rows,
// regardless of the active tab or the underlying-detail switch. A homogeneous
// conflicted group retains its active-tab scope.
export function triageScope(group, st = groupState(group)) {
  const members = triageTabs(group)
  const targets = group.linkedTabs || (members !== group && group.some((f) => f.isApp))
    ? members : st.hasConflict ? [activeTabFor(group)] : members
  return targets.every(canTriageFinding) ? targets : targets.filter(canTriageFinding)
}

// The state that scope currently shows — what the menu marks active,
// and what a re-click therefore switches off. One definition for both:
// if the marked item and the cleared item ever came apart, clicking the
// highlighted state would set it again instead of clearing it.
//
// `st` / `active` are accepted precomputed: the render path already
// resolved both for the row, and the conflicted branch would otherwise
// re-sort the group's tabs to find the active one.
export function scopedTriage(group, st = groupState(group), active = null) {
  if (group.linkedTabs || (group.some((f) => f.isApp) && triageTabs(group) !== group)) return st.commonTriage ?? null
  if (!st.hasConflict) return st.commonTriage ?? null
  return tabTriage(active ?? activeTabFor(group)) ?? null
}

// Level a group's triage: write the bucket its tabs agree on onto the
// tabs that carry none. A group can hold its state on a subset of its
// members — triaged from a surface that scoped to the active tab, or
// before the group-wide apply existed — and the rollup then speaks for
// the whole group off that one tab. Nothing on the card betrays it, but
// the STORED state stays ambiguous: exports, sync peers and the
// per-tab glyphs all see a group half in a bucket. Call it when a
// finding's details are opened, so looking at an issue settles it.
//
// Only a group whose tabs agree gets levelled. A real disagreement is
// the user's to resolve — the tab glyphs are there to show it — and
// the per-report ignore flag is left alone either way: it's a decision
// about one finding in one report (see isIgnored), not a verdict on
// the group, and it lives in its own store.
//
// Returns true when it actually wrote something. It does NOT persist:
// callers own that, and they defer it (`queueMicrotask(saveTriage)`)
// so a whole-map serialize can't land between an open and its paint —
// the rule the kanban drop path already follows.
//
// `commonTriage` requires agreement among the status-bearing members.
// Colors and statuses are read from the same non-upstream members.
export function syncGroupTriage(group) {
  // The same set the rollup below was read from: levelling is the
  // rollup written back, so reaching an upstream member here would
  // extend a verdict it never took part in deciding.
  const tabs = triageTabs(group)
  if (tabs.length < 2) return false
  const st = groupState(group)
  const bucket = st.commonTriage
  if (!bucket || bucket === 'ignored') return false
  let changed = false
  for (const f of tabs) {
    if (!canTriageFinding(f)) continue
    const key = tabKey(f)
    const entry = state.triage.get(key)
    // Anything still off the bucket here carries no bucket at all — an
    // annotated tab holding a different one would have conflicted above.
    if (tabTriage(f, entry) === bucket) continue
    // A tab holding an ignore for ANOTHER report reads as unannotated
    // here (isIgnored is per-report) but is not a blank slate: triage
    // and ignoredReports are mutually exclusive on an entry, and the
    // load path resolves a violation by dropping the ignore
    // (client/triage.js — a bucket-bearing entry never re-imports it).
    // Levelling such a tab would silently destroy an ignore the user
    // set somewhere else, so leave it alone; the group stays partial,
    // which is the truth about it.
    if (entry?.ignoredReports?.length) continue
    if (patchEntry(state.triage, key, { triage: bucket })) changed = true
  }
  return changed
}

// Original report rows are immutable. Cache the derived partitions until
// another report arrives; toggling the lens never re-parses reports or discards
// their App rows. Report entries are replaced wholesale by the loading path.
let groupCache = null

export function clearMergedGroups() { groupCache = null }

function groupModel(showRevalidation, upstreamOnly = false, hideRuledOut = false) {
  const reports = state.reports
  const merges = state.workspaceMerges
  if (!groupCache || groupCache.reports.length !== reports.length
      || groupCache.reports.some((r, i) => r !== reports[i])
      || groupCache.merges !== merges || groupCache.mergeCount !== merges.length) {
    groupCache = { reports: [...reports], merges, mergeCount: merges.length }
  }
  const mode = upstreamOnly ? 'upstream' : showRevalidation ? hideRuledOut ? 'workspace-app' : 'app' : 'code'
  if (!groupCache[mode]) {
    groupCache[mode] = mergeReportGroups(reports, { showRevalidation: showRevalidation && !upstreamOnly, upstreamOnly, hideRuledOut, merges })
  }
  return groupCache[mode]
}

// The upstream lens: with it on, the list is the dependencies' own code
// and nothing else.
//
// Every other control in the toolbar CHOOSES BETWEEN groups — a group
// either matches the filter or it doesn't, and the ones that match
// arrive whole. This one reaches inside them, because the thing it is
// about lives there: a card commonly holds the app's finding and the
// upstream rows underneath it in one dedup group, and a reader asking
// for the upstream code does not want the app's row shown as part of
// the answer. So `[app, own, upstream0, upstream1]` comes back as
// `[upstream0, upstream1]`, and a group with no upstream member is
// dropped rather than drawn empty.
//
// Narrowing the group rather than hiding tabs inside it is also what
// carries the verdict across: `triageTabs` sees a group whose every
// member is upstream, so the rollup reads those rows and a group-level
// write lands on them — the same rule as always, from the other side.
//
// Which means the lens can turn a settled row into a CONFLICTED one:
// a group whose app-side members agree, holding two upstream rows that
// don't, reads as agreed with the lens off and as a disagreement with
// it on. That is the truth about it either way — the disagreement was
// always there, in rows the app-side verdict was speaking over — and it
// resolves like any other: `triageScope` narrows to the active tab,
// which under this lens is one of the upstream rows.
//
// Hand back the group itself when nothing was dropped. The merge model keeps
// the full source row available while projecting the upstream members, so
// revalidation input boundaries can still be recovered before that lens
// reaches the cards.
// The list before the upstream lens narrows it — every group the view
// COULD show, which is the set a deep link has to resolve against.
//
// A link names one finding, and whether it exists is a fact about what
// is loaded, not about the lens the reader happens to be standing
// behind. Resolved through the narrowed list instead, a link to an
// app-side finding in a loaded report finds nothing and is reported as
// gone; `unhideFinding` then takes the lens off to show it, the same
// way it clears a filter that excluded its target.
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
    // detection. Status disagreements use groupState, never App-mode gating.
    //
    // Ahead of the detail check below, because a link is the reader's own
    // statement that two rows are one finding — unlike the App and upstream
    // lenses above, which change which findings are on the list at all, the
    // detail stop only changes how much of a row it shows, and a row does
    // not stop being linked because its workings are visible.
    //
    // Which rows may bridge is asked of `foldedTabs`, so the answer is the
    // same at either stop; only the tabs the combined row KEEPS follow the
    // stop, which is why the merge is cached per detail state as well as
    // per links tick.
    const detailed = underlyingFindingsShown()
    if (!model.linkedGroups || model.linksTick !== state.linksTick || model.linkedDetailed !== detailed) {
      model.linkedGroups = mergeLinkedWorkspaceGroups(groups, duplicatesOf, foldedTabs, drawnTabs)
      model.linksTick = state.linksTick
      model.linkedDetailed = detailed
    }
    return model.linkedGroups
  }
  // The detailed app view hands back what the simplified one folded away,
  // ruled-out rows included — so it skips the pass below rather than
  // filtering them straight out again. A workspace never reaches here: its
  // model dropped those rows before merging, which is why the stop is not
  // offered on their account there (render.js canDetailLayer).
  if (underlyingFindingsShown()) return groups
  // Hide ruled-out findings before counts, filters, tabs and outcome options
  // are derived. isRuledOut already follows the App/upstream lens.
  return model.visibleGroups ??= (() => {
    const visibleGroups = groups.flatMap((group) => {
      const kept = group.filter((f) => !isRuledOut(f))
      if (kept.length === group.length) return [group]
      if (kept.length === 0) return []
      kept.workspaceKey = groupKey(group)
      return [kept]
    })
    Object.defineProperty(visibleGroups, 'ruledOutIds', { value: groups.ruledOutIds, configurable: true })
    return visibleGroups
  })()
}

// The merged groups the view actually SHOWS — the triage bucket the
// reader is parked in (`state.shownTriage`, null for the live list),
// or every bucket at once in kanban, which lays them side by side.
// render.js's `allGroups` is this same rule, folded into the pass that
// also counts the buckets.
//
// The distinction matters wherever a question is about the SCREEN
// rather than about the data. The confidence block a load opens on
// (filters.js applyOpeningFilters) is one: it asks what the reader
// will be looking at, and a row marked fixed months ago is no part of
// that answer — it is not on screen for the range to show, nor for an
// outcome to take away.
export function getShownGroups() {
  const groups = getMergedGroups()
  if (state.viewMode === 'kanban') return groups
  const shown = groups.filter((g) => groupState(g).commonTriage === state.shownTriage)
  Object.defineProperty(shown, 'ruledOutIds', { value: groups.ruledOutIds, configurable: true })
  return shown
}

// A rendered group plus the revalidation rows the App lens dropped
// from it (see mergeReportGroups) — the group as the data has it, which
// is what a whole-group WRITE is about. The pass's row is the same
// issue re-rated, so the PR that fixes the base finding fixes that row
// too, and an annotation applied to the group belongs on it whether or
// not the lens is currently drawing it.
//
// Identity is by member, not by gid: dropping a pass row can change
// which finding sits at `g[0]`, so the two lists don't always agree on
// a group's key. With the lens on, nothing was dropped and the group
// is already whole.
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
