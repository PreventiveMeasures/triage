import { revalidateKindOf } from '@preventive/report'
import { canLockConfirmed } from './finding-filters.js'
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
  const { groups, conflicts } = mergeReportGroups(reports, { hideRuledOut: true })
  const linked = mergeLinkedWorkspaceGroups(groups, duplicatesOf, appTabs)
  const notApp = countFindings ? { appMode: false, findings: linked.length } : { appMode: false }
  if (conflicts.size > 0) return notApp
  if (!onlyUnjudgedImports(linked) && !canLockConfirmed(linked, { tabs: appTabs, kindOf: revalidateKindOf, severityMode: 'corrected' })) return notApp
  return {
    appMode: true,
    appFindings: linked.filter((group) => appTabs(group).some((f) => f.isApp)).length,
  }
}
