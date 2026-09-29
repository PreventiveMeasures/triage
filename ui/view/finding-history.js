import { isManagedUiMode, state } from '#client/index.js'
import { roleAtLeast } from '../../common/managed/roles.ts'

export function canViewFindingHistory(finding) {
  return isManagedUiMode() && !state.managedSession?.publicShare
    && roleAtLeast(state.managedSession?.role, 'triage')
    && Boolean(finding?._managedReportId && finding.id)
}
