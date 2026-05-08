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
//   1. A tab is "annotated" if it has a color AND/OR is deleted.
//      Unannotated tabs are neutral — they don't contribute to the
//      rollup and can never cause a conflict on their own.
//   2. Among annotated tabs, a conflict exists iff they disagree on
//      color OR on deletion state. "Disagree on color" means two or
//      more distinct non-null colors are present (a tab annotated
//      only via deletion, with no color, never conflicts with a
//      colored tab purely on the basis of its missing color). "Disagree
//      on deletion" means some annotated tabs are deleted and others
//      are not. Conflict → dashed outline on the card; per-tab colors
//      still render on each tab button; the group is kept in the main
//      view (never in trash).
//   3. Otherwise (consistent annotated tabs), the card takes the
//      common color (if any annotated tab is colored); any annotated
//      tab being deleted puts the whole group in trash.
//   4. Click handlers enforce the inverse — see events.js.
// Examples (where A/B/C are tabs in one dedup group):
//   A(green, deleted), B(), C()            → no conflict, in trash, A is green
//   A(green, deleted), B(deleted), C()     → no conflict, in trash, A is green
//   A(green, deleted), B(red), C()         → conflict (colors disagree)
//   A(green), B(blue), C()                 → conflict (colors disagree)
//   A(green, deleted), B(green), C()       → conflict (deleted disagrees)
export function groupState(group) {
  const annotated = group
    .map((f) => ({ color: state.markers.get(tabKey(f)), deleted: state.deletedIds.has(tabKey(f)) }))
    .filter((t) => t.color !== undefined || t.deleted)
  const colors = new Set(annotated.map((t) => t.color).filter((c) => c !== undefined))
  const deletedStates = new Set(annotated.map((t) => t.deleted))
  const hasConflict = colors.size > 1 || deletedStates.size > 1
  const commonColor = !hasConflict && colors.size === 1 ? [...colors][0] : null
  const anyDeleted = annotated.some((t) => t.deleted)
  const allDeleted = annotated.length > 0 && annotated.every((t) => t.deleted)
  return {
    hasConflict, commonColor, anyDeleted, allDeleted,
    // Conflict groups are NEVER counted as deleted (per spec — the
    // group stays in the main view until the user resolves the
    // disagreement per-tab). When non-conflicting, anyDeleted ==
    // allDeleted on annotated tabs, so either form is equivalent.
    isDeleted: !hasConflict && anyDeleted,
  }
}

export function isGroupDeleted(group) { return groupState(group).isDeleted }

export function findGroupById(gid) {
  for (const r of state.reports) {
    for (const g of r.groups) if (groupKey(g) === gid) return g
  }
  return null
}
