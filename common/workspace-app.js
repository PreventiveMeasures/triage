import { revalidateKindOf } from '@preventive/report'
import { activeRevalidateKinds, canLockConfirmed, confirmedCoverage, confirmedIsDefault, defaultConfidenceFloor } from './finding-filters.js'
import { mergeReportGroups } from './workspace-groups.js'
import { mergeLinkedWorkspaceGroups } from './linked-workspace-groups.js'

function appTabs(group) {
  if (group.linkedTabs) return group.linkedTabs
  const app = group.filter((f) => revalidateKindOf(f) === 'revalidation')
  return app.length > 0 ? app : group
}

// Findings imported from another analyzer are App findings by construction,
// and Confirmed counts one its report holds no pass for as shown. A set of
// nothing but those is already its own App view, with no pass to fold anything
// under. The Confirmed lock asks for a pass as well (it has no outcome control
// to offer without one), so this is asked on its own: a team whose permissions
// leave only other analyzers' findings opens as App, as it does unrestricted.
// Such a view opens with no outcome filter, but keeps the confidence range of
// imports that score themselves (DeepSec's do).
function onlyUnjudgedImports(groups) {
  const visible = groups.map(appTabs).filter((g) => g.length > 0)
  return visible.length > 0 && visible.every((g) => g.every((f) => f.isApp && f._source && !f._sourcePass && revalidateKindOf(f) === ''))
}

// Evaluate the entire workspace, independent of triage, filters, or the lens
// left active by another report. Use the same merge and link rules as the view.
// `countFindings` has a workspace that is not App count its rows too, after
// the same merging, for a caller that shows it collapsed (managed teams).
export function workspaceAppMetadata(reports, duplicatesOf = () => [], { countFindings = false } = {}) {
  return metadataOf(appView(reports, duplicatesOf), countFindings)
}

// The IDs of the findings a workspace's basic App view can show: of each row
// its locked Confirmed shows (ui/view/filters.js filterRevalidateKind), the
// App tabs, the rest folded under them; none the pass ruled out. Null where it
// has no such view, or one with no outcome to lock, which shows every row.
export function workspaceAppRows(reports, duplicatesOf = () => []) {
  return rowsOf(appView(reports, duplicatesOf))
}

// Both, of one merge of its rows.
export function workspaceApp(reports, duplicatesOf = () => [], { countFindings = false } = {}) {
  const view = appView(reports, duplicatesOf)
  return { metadata: metadataOf(view, countFindings), rows: rowsOf(view) }
}

function metadataOf({ linked, app }, countFindings) {
  if (!app) return countFindings ? { appMode: false, findings: linked.length } : { appMode: false }
  return {
    appMode: true,
    appFindings: linked.filter((group) => appTabs(group).some((f) => f.isApp)).length,
  }
}

function rowsOf({ linked, app }) {
  if (!app || onlyUnjudgedImports(linked)) return null
  const kinds = activeRevalidateKinds('confirmed', '')
  const confirmed = (f) => kinds.includes(revalidateKindOf(f) || (f._source && !f._sourcePass ? 'revalidation' : ''))
  const ids = new Set()
  for (const group of linked) if (group.some(confirmed)) for (const f of appTabs(group)) ids.add(f.id)
  return ids
}

// Whether a managed report may be switched to open on Confirmed whatever
// Confirmed hides (Manage → Reports, common/finding-filters.js
// confirmedCoverage): only where the switch changes something, a set whose
// pass leaves Confirmed rows of its own to show, but which the opening rule
// keeps on the confidence range, as Confirmed would hide a finding the range
// shows. Asked of the set as the App view merges it, with no copy counted as
// switched already. A set with contradicting verdicts opens with no App
// layer, and so with no Confirmed to open on; one of nothing but other
// analyzers' unjudged findings has no pass to have an answer.
export function confirmedDefaultOffered(reports, duplicatesOf = () => []) {
  const { groups, conflicts } = mergeReportGroups(reports, { hideRuledOut: true })
  if (conflicts.size > 0) return false
  const linked = mergeLinkedWorkspaceGroups(groups, duplicatesOf, appTabs)
  const visible = linked.map(appTabs).filter((g) => g.length > 0)
  const kinds = activeRevalidateKinds('confirmed', '')
  if (!visible.some((g) => g.some((f) => kinds.includes(revalidateKindOf(f))))) return false
  return !confirmedIsDefault(visible, defaultConfidenceFloor(linked, appTabs), confirmedCoverage(linked, appTabs, revalidateKindOf), revalidateKindOf)
}

// A workspace's rows as its basic App view merges them, and whether it has one.
function appView(reports, duplicatesOf) {
  const { groups, conflicts } = mergeReportGroups(reports, { hideRuledOut: true })
  const linked = mergeLinkedWorkspaceGroups(groups, duplicatesOf, appTabs)
  const app = conflicts.size === 0
    && (onlyUnjudgedImports(linked) || canLockConfirmed(linked, { tabs: appTabs, kindOf: revalidateKindOf, severityMode: 'corrected' }))
  return { linked, app }
}
