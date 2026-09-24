import { revalidateKindOf } from '../../report/index.js'
import { canLockConfirmed } from './filters.js'
import { mergeReportGroups } from './workspace-groups.js'
import { mergeLinkedWorkspaceGroups } from './linked-workspace-groups.js'

function appTabs(group) {
  if (group.linkedTabs) return group.linkedTabs
  const app = group.filter((f) => revalidateKindOf(f) === 'revalidation')
  return app.length > 0 ? app : group
}

// Evaluate the entire workspace, independent of triage, filters, or the lens
// left active by another report. Use the same merge and link rules as the view.
export function workspaceAppMetadata(reports, duplicatesOf = () => []) {
  const { groups, conflicts } = mergeReportGroups(reports, { hideRuledOut: true })
  if (conflicts.size > 0) return { appMode: false }
  const linked = mergeLinkedWorkspaceGroups(groups, duplicatesOf, appTabs)
  if (!canLockConfirmed(linked, { tabs: appTabs, kindOf: revalidateKindOf })) return { appMode: false }
  return {
    appMode: true,
    appFindings: linked.filter((group) => appTabs(group).some((f) => f.isApp)).length,
  }
}
