import { getPackagesIndex, isReportIgnored, patchEntry, state } from '#client/index.js'
import { SEVERITY_ORDER, displayedSeverity, isRevalidation, isRevalidationRow } from './format.js'
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
export function tabTriage(f, entry = state.triage.get(tabKey(f))) {
  return entry?.triage ?? (isIgnored(f) ? 'ignored' : undefined)
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
    allIgnored: commonTriage === 'ignored' && annotatedCount === group.length,
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
// group. Two conditions: the group has siblings to apply it to, and
// every tab either carries no link or carries the very link being
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
  const want = (current ?? '').trim()
  return group.every((f) => fixApplies(f, want))
}

// One tab's half of that test, so the write can re-ask it per tab at
// the moment it writes — the offer is granted before the dialog opens,
// and a sync peer or another browser tab can land a link on a sibling
// while it sits there.
export function fixApplies(f, current) {
  const fix = (state.triage.get(tabKey(f))?.fix ?? '').trim()
  return fix === '' || fix === (current ?? '').trim()
}

export function isGroupDeleted(group) { return groupState(group).isDeleted }
export function groupTriage(group) { return groupState(group).commonTriage }

// What a triage-menu click does: the tabs it applies to, and whether
// it sets the state or clears it. BOTH are decisions about the group,
// not about individual tabs — deciding per tab inside the apply loop
// turned a re-click into a per-tab flip (a group holding "In progress"
// on one of four tabs answered a second click with the other three,
// then flipped back) instead of the plain on/off a state menu owes the
// user.
//
// Scope: a conflicted group narrows to the active tab, so resolving a
// disagreement doesn't overwrite siblings the user hasn't looked at.
// Everything else applies to every tab.
//
// `clearing` is true when the scope ALREADY shows `action` — a
// re-click switches it off — and always for 'restore', which only
// clears. A group can show a state while holding it on a subset of its
// tabs (see syncGroupTriage), which is exactly why the question is
// asked of the rollup rather than of each tab.
export function triageActionPlan(group, action) {
  const st = groupState(group)
  return {
    targets: triageScope(group, st),
    clearing: action === 'restore' || scopedTriage(group, st) === action,
  }
}

// The tabs a group-level triage write lands on. A conflicted group
// narrows to the active tab, so resolving a disagreement doesn't
// overwrite siblings the user hasn't looked at; everything else applies
// to every tab. Shared with the kanban drop path so a menu click and a
// column drop can't disagree about which tabs they touch.
export function triageScope(group, st = groupState(group)) {
  return st.hasConflict ? [activeTabFor(group)] : group
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
// `commonTriage` is null for any conflicted group, so agreement is
// already the condition for getting past the first guard — including
// a COLOR disagreement, which the rollup folds into the same value. A
// group whose buckets agree but whose colors differ therefore keeps
// its partial state; its tabs keep showing their own (see
// tabTemplate), which is the signal that something is unresolved.
export function syncGroupTriage(group) {
  if (!Array.isArray(group) || group.length < 2) return false
  const st = groupState(group)
  const bucket = st.commonTriage
  if (!bucket || bucket === 'ignored') return false
  let changed = false
  for (const f of group) {
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
// Taking the revalidation layer off (the toolbar's "App" switch, see
// format.js) drops the rows that ARE the pass — and only those. Their
// duplicates stay: a row the pass judged is still the analyzer's
// finding about the code, and the code view is the whole point of the
// switch. A group left with nothing goes with them.
//
// Here rather than in a filter because this is the one list every
// consumer reads — the toolbar counts, the filters, the tab strip, the
// deep links, the file tallies — so the pass's rows are gone from all
// of them at once, instead of surviving in whichever count forgot to
// ask. `isRevalidationRow` reads the raw field on purpose: by the time
// this runs, the gated reader has already stopped seeing them.
//
// Untouched groups keep their identity — the arrays are only rebuilt
// where something actually comes out — so nothing downstream that
// keys off a group re-derives for a set that has no pass rows in it.
function withoutPassRows(groups) {
  if (state.showRevalidation) return groups
  if (!groups.some((g) => g.some(isRevalidationRow))) return groups
  const out = []
  for (const g of groups) {
    const kept = g.filter((f) => !isRevalidationRow(f))
    if (kept.length > 0) out.push(kept.length === g.length ? g : kept)
  }
  return out
}

export function getMergedGroups() {
  const allGroups = state.reports.flatMap((r) => r.groups)
  const merges = state.workspaceMerges
  if (!merges || merges.length === 0) return withoutPassRows(allGroups)
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
  return withoutPassRows(merged)
}

export function findGroupById(gid) {
  for (const g of getMergedGroups()) if (groupKey(g) === gid) return g
  return null
}
