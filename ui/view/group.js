import { getPackagesIndex, isReportIgnored, state } from '#client/index.js'
import { SEVERITY_ORDER, displayedSeverity, isRevalidation } from './format.js'
// NOTE: filters.js imports from this module too (primaryTab / tabKey).
// The cycle is deliberate and benign: both sides only call across
// inside function bodies, never during module evaluation, so whichever
// module evaluates first resolves the other's hoisted function
// declarations by the time anything runs.
import { matchesRunFilters } from './filters.js'

// ID helpers. Internally every `state.reports[].groups[i]` is a
// Finding[] (single-finding entries are wrapped at ingest, so code
// downstream never branches on "is it a group?"). `tabKey` identifies
// an individual tab (= finding); `groupKey` identifies the group as a
// whole — uses the first member so it survives tab-sort reordering.
export function tabKey(f) { return f.id ?? String(f._id) }
export function groupKey(group) { return tabKey(group[0]) }
export function toGroup(entry) { return Array.isArray(entry) ? entry : [entry] }

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
export function isIgnored(f) {
  return isReportIgnored(state.triage, tabKey(f), findingReport(f))
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
// result as read-only either way.
export function sortTabs(group) {
  if (group.length <= 1) return group
  return [...group].toSorted((a, b) => {
    const aRevalidation = isRevalidation(a) ? 1 : 0
    const bRevalidation = isRevalidation(b) ? 1 : 0
    if (aRevalidation !== bRevalidation) return bRevalidation - aRevalidation
    const aColored = state.triage.get(tabKey(a))?.color ? 1 : 0
    const bColored = state.triage.get(tabKey(b))?.color ? 1 : 0
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

// Whether a tab (finding) carries an annotation marker — a comment, a
// fix link, or a raised attention flag, i.e. the glyphs the tab strip
// renders after the severity badge (see tabMarksTemplate). Empty-string
// / `false`-tombstone forms count as absent, matching that render and
// the toolbar annotation filters.
export function tabHasMarks(f) {
  const entry = state.triage.get(tabKey(f))
  return Boolean(entry?.comment) || Boolean(entry?.fix) || entry?.flagged === true
}

export function activeTabFor(group) {
  // Single-tab fast path: every branch below resolves to the lone
  // member, so skip the lookups (this runs several times per row/card
  // template). Skipping the state reads is reactivity-safe — the
  // result can't change, so an observer needn't subscribe to them.
  if (group.length === 1) return group[0]
  const stored = state.activeTabByGroup.get(groupKey(group))
  if (stored) {
    const match = group.find((f) => tabKey(f) === stored)
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
  const sorted = sortTabs(group)
  let pool = sorted
  if (state.filterAnalyzer || state.filterModel) {
    const matching = sorted.filter(matchesRunFilters)
    if (matching.length > 0) pool = matching
  }
  return pool.find(tabHasMarks) ?? pool[0]
}

// The repo a finding's file / line links resolve against — the
// `repoFallback` argument `fileUrl` / `findingUrl` / `fileLink` /
// `lineLink` all take. Per-report `_repoFallback` first (stamped at
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

// Repo identifier (slug or URL) for a finding, matching the `Repo:`
// line of the copy / Claude / GitHub-issue handoff block: a
// node_modules file resolves to its package bucket's repo when that
// bucket maps to exactly one upstream, otherwise the per-finding
// `repo.github` / the resolved fallback above. Returns null when
// none of those is known.
export function findingRepo(f) {
  for (const bucket of getPackagesIndex().values()) {
    if (bucket.files.has(f.file)) {
      return (bucket.repos && bucket.repos.size === 1) ? [...bucket.repos][0] : null
    }
  }
  return f.repo?.github || findingRepoFallback(f) || null
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
  // observable reads (state.triage.get per tab; isIgnored only when
  // the entry carries no triage) are unchanged so observer-util
  // dependency tracking stays identical.
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
  for (const f of group) {
    const entry = state.triage.get(tabKey(f))
    const bucket = entry?.triage ?? (isIgnored(f) ? 'ignored' : undefined)
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
    // Convenience flags so downstream code that asks "is this group in
    // the trash bucket" needn't branch on commonTriage.
    isInProgress: commonTriage === 'inprogress',
    isFixed:    commonTriage === 'fixed',
    isInvalid:  commonTriage === 'invalid',
    isDeleted:  commonTriage === 'deleted',
    isIgnored:  commonTriage === 'ignored',
  }
}

export function isGroupDeleted(group) { return groupState(group).isDeleted }
export function groupTriage(group) { return groupState(group).commonTriage }

// Flatten every loaded report's groups into the workspace list,
// applying `state.workspaceMerges` so groups bound by a cross-report
// dedup hint render as a single super-group. Each merge instruction is
// a Set of finding ids in the order the source combined entry listed
// them — that order is canonical (the upstream dedup pass deliberately
// picked a primary), so the super-group sorts members by
// merge-instruction order, falling back to load order for anything no
// instruction mentioned (e.g. a member of a multi-finding source group
// the merge only named once). Per-report `state.reports[*].groups` is
// untouched — single-report views and per-report iteration keep their
// shape; only the merged display uses this view.
export function getMergedGroups() {
  const allGroups = state.reports.flatMap((r) => r.groups)
  const merges = state.workspaceMerges
  if (!merges || merges.length === 0) return allGroups
  const parent = allGroups.map((_, i) => i)
  const find = (i) => {
    let r = i
    while (parent[r] !== r) r = parent[r]
    while (parent[i] !== r) { const next = parent[i]; parent[i] = r; i = next }
    return r
  }
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb }
  const idToIdx = new Map()
  for (let i = 0; i < allGroups.length; i++) {
    for (const f of allGroups[i]) if (f.id) idToIdx.set(f.id, i)
  }
  for (const merge of merges) {
    let first = -1
    for (const id of merge) {
      const idx = idToIdx.get(id)
      if (idx === undefined) continue
      if (first === -1) first = idx
      else union(first, idx)
    }
  }
  // Walk allGroups in order; first hit on each root opens its output
  // slot (so the super-group lands at its earliest member's position).
  // Members are then ordered by merge-instruction order — first-recorded
  // instruction wins; ids no instruction names get appended in load order.
  const seenRoots = new Set()
  const merged = []
  for (let i = 0; i < allGroups.length; i++) {
    const root = find(i)
    if (seenRoots.has(root)) continue
    seenRoots.add(root)
    const findings = []
    for (let j = i; j < allGroups.length; j++) {
      if (find(j) === root) findings.push(...allGroups[j])
    }
    const idSet = new Set(findings.map((f) => f.id).filter(Boolean))
    const canonical = []
    const placed = new Set()
    for (const merge of merges) {
      for (const id of merge) {
        if (placed.has(id)) continue
        if (idSet.has(id)) { canonical.push(id); placed.add(id) }
      }
    }
    if (canonical.length === 0) {
      merged.push(findings)
      continue
    }
    const byId = new Map()
    for (const f of findings) {
      if (f.id && !byId.has(f.id)) byId.set(f.id, f)
    }
    const used = new Set()
    const ordered = []
    for (const id of canonical) {
      const f = byId.get(id)
      if (f) { ordered.push(f); used.add(f) }
    }
    for (const f of findings) {
      if (!used.has(f)) ordered.push(f)
    }
    merged.push(ordered)
  }
  return merged
}

export function findGroupById(gid) {
  for (const g of getMergedGroups()) if (groupKey(g) === gid) return g
  return null
}
