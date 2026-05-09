import { state } from '../../client/state.js'
import { SEVERITY_ORDER } from './format.js'

// ID helpers. Internally every `state.reports[].groups[i]` is a
// Finding[] (single-finding entries are wrapped at ingest, so code
// downstream never branches on "is it a group?"). `tabKey` identifies
// an individual tab (= finding); `groupKey` identifies the group as a
// whole — uses the first member so it survives tab-sort reordering.
export function tabKey(f) { return f.id ?? String(f._id) }
export function groupKey(group) { return tabKey(group[0]) }
export function toGroup(entry) { return Array.isArray(entry) ? entry : [entry] }

// Per-report ignore key — combines the source report's filename
// with the tab's id so an ignore in report A doesn't propagate to
// the same finding's appearance in report B. The reportName comes
// from `f._reportName`, stamped at ingest (and on bundle index
// entries). Findings without a report (synthetic / single-file
// loads) fall back to an empty prefix; ignoring still works, but
// the persistence path can't separate them by report.
export function ignoredKey(f) {
  const r = f?._reportName ?? ''
  return `${r}\0${tabKey(f)}`
}
export function isIgnored(f) {
  return state.ignoredIds.has(ignoredKey(f))
}

// Tab sort order within a group: colored tabs first (drawing attention
// to already-triaged cases), then higher severity, then higher
// confidence. The first tab after sort is the group's "primary" — used
// as the default active tab AND as the representative for group-level
// sorting (file/severity/confidence dropdowns).
export function sortTabs(group) {
  return [...group].sort((a, b) => {
    const aColored = state.markers.has(tabKey(a)) ? 1 : 0
    const bColored = state.markers.has(tabKey(b)) ? 1 : 0
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
      const triage = state.triageState.get(k)
      const bucket = triage ?? (state.ignoredIds.has(ignoredKey(f)) ? 'ignored' : undefined)
      return { color: state.markers.get(k), bucket }
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
  // 'fixed' / 'invalid' / 'deleted' / 'ignored' otherwise.
  const commonTriage = !hasConflict && bucketVals.length > 0 ? bucketVals[0] : null
  return {
    hasConflict, commonColor, anyTriage, allTriaged, commonTriage,
    // Convenience flags mirroring the original API; downstream code
    // that asked "is this group in the trash bucket" continues to
    // work without branching on commonTriage.
    isFixed:    commonTriage === 'fixed',
    isInvalid:  commonTriage === 'invalid',
    isDeleted:  commonTriage === 'deleted',
    isIgnored:  commonTriage === 'ignored',
  }
}

export function isGroupDeleted(group) { return groupState(group).isDeleted }
export function groupTriage(group) { return groupState(group).commonTriage }

export function findGroupById(gid) {
  for (const r of state.reports) {
    for (const g of r.groups) if (groupKey(g) === gid) return g
  }
  return null
}
