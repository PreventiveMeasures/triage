import { getPackagesIndex, isReportIgnored, state } from '#client/index.js'
import { SEVERITY_ORDER } from './format.js'

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

// Tab sort order within a group: colored tabs first (drawing attention
// to already-triaged cases), then higher severity, then higher
// confidence. The first tab after sort is the group's "primary" — used
// as the default active tab AND as the representative for group-level
// sorting (file/severity/confidence dropdowns).
export function sortTabs(group) {
  return [...group].toSorted((a, b) => {
    const aColored = state.triage.get(tabKey(a))?.color ? 1 : 0
    const bColored = state.triage.get(tabKey(b))?.color ? 1 : 0
    if (aColored !== bColored) return bColored - aColored
    const aSev = SEVERITY_ORDER[a.severity] || 0
    const bSev = SEVERITY_ORDER[b.severity] || 0
    if (aSev !== bSev) return bSev - aSev
    const aConf = a.confidence ?? -1
    const bConf = b.confidence ?? -1
    return bConf - aConf
  })
}

export function primaryTab(group) { return sortTabs(group)[0] }

export function activeTabFor(group) {
  const stored = state.activeTabByGroup.get(groupKey(group))
  if (stored) {
    const match = group.find((f) => tabKey(f) === stored)
    if (match) return match
  }
  return primaryTab(group)
}

// Repo identifier (slug or URL) for a finding, matching the `Repo:`
// line of the copy / Claude / GitHub-issue handoff block: a
// node_modules file resolves to its package bucket's repo when that
// bucket maps to exactly one upstream, otherwise the per-finding
// `repo.github` / resolved `_repoFallback` / user-typed
// `state.repoUrl`. Returns null when none of those is known.
export function findingRepo(f) {
  for (const bucket of getPackagesIndex().values()) {
    if (bucket.files.has(f.file)) {
      return (bucket.repos && bucket.repos.size === 1) ? [...bucket.repos][0] : null
    }
  }
  return f.repo?.github ?? f._repoFallback ?? state.repoUrl ?? null
}

// Group-level triage rollup. User spec:
//   1. A tab is "annotated" if it has a color AND/OR a triage state
//      (fixed / invalid / deleted). Unannotated tabs are neutral —
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
//      bucket (fixed / invalid / deleted).
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
  // tab is in the ignore set, else null (live). Ignore behaves
  // like a fourth bucket for rollup / conflict detection but
  // mutates differently (per-report key) and doesn't propagate
  // cross-report at the action layer (see events.js).
  const annotated = group
    .map((f) => {
      const k = tabKey(f)
      const entry = state.triage.get(k)
      const bucket = entry?.triage ?? (isIgnored(f) ? 'ignored' : undefined)
      return { color: entry?.color, bucket }
    })
    .filter((t) => t.color !== undefined || t.bucket !== undefined)
  const colors = new Set(annotated.map((t) => t.color).filter((c) => c !== undefined))
  // Distinct bucket values across annotated tabs. Sentinel for
  // "annotated but no bucket" so a colored-only tab disagrees
  // with a bucket-bearing sibling — matches the original
  // deleted-vs-not semantic where an annotated-undeleted tab
  // broke the consensus with an annotated-deleted one.
  const NONE = Symbol('none')
  const buckets = new Set(annotated.map((t) => t.bucket ?? NONE))
  const hasConflict = colors.size > 1 || buckets.size > 1
  const commonColor = !hasConflict && colors.size === 1 ? [...colors][0] : null
  const bucketVals = annotated.map((t) => t.bucket).filter(Boolean)
  const anyTriage = bucketVals.some((b) => b !== 'ignored')
  const allTriaged = annotated.length > 0 && annotated.every((t) => Boolean(t.bucket) && t.bucket !== 'ignored')
  // Common bucket — null when no consensus or live; one of
  // 'inprogress' / 'fixed' / 'invalid' / 'deleted' / 'ignored' otherwise.
  const commonTriage = !hasConflict && bucketVals.length > 0 ? bucketVals[0] : null
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
