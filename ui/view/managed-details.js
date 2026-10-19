import { state } from '#client/index.js'
import { store } from '@rray/frontend/state-management'
import { reportEntries } from '@preventive/report'
import { setManagedWorkspace } from '../../client/managed/workspace.js'
import { FINDING_DETAIL_FIELDS } from '../../common/managed/finding-detail.js'
import { forgetFindingText } from './format.js'
import { clearMergedGroups, getRevalidationConflicts } from './group.js'
import { showToast } from './toast.js'

// A team's board is drawn from its reports without their findings' detail
// (`lite`), the whole reports asked for beside them (ingest.js
// switchToManagedTeam). Until they are in, a popup, a view mode other than
// the board and an export wait for them (render.js, events.js); once in,
// each finding is filled in where it is, and the team's finding index
// (client/managed/workspace.js) built again from them.
let current = null

// What a view needing the loaded findings' detail shows in its place: null
// once they have it, or need none; 'loading' while it comes; 'failed' where
// it never will.
export function managedDetailsWaiting() {
  if (current === null || current.reports !== store(state.reports) || current.ok) return null
  return current.done ? 'failed' : 'loading'
}

// Whether the loaded reports' findings have their detail, once they have it
// or never will: false for a team's whose request failed.
export function managedDetailsReady() {
  return current !== null && current.reports === store(state.reports) ? current.ready : Promise.resolve(true)
}

// Fills the loaded reports' findings in from `request`'s whole reports, then
// `loaded()`, as long as they are still loaded; whole reports that fail, or
// do not hold the same findings, leave them as they are, telling so.
export function awaitManagedDetails(teamId, request, loaded) {
  const reports = store(state.reports)
  const entry = current = { reports, done: false, ok: false, ready: null }
  entry.ready = (async () => {
    const workspace = await Promise.resolve(request).catch(() => null)
    entry.done = true
    if (store(state.reports) !== reports) return false
    const fill = workspace && detailsFill(reports, workspace)
    if (fill) {
      fill()
      entry.ok = true
      setManagedWorkspace(teamId, workspace)
      // Merged rows are copies of their findings, built again with the
      // detail; copies disagreeing on what the revalidation pass said are told
      // apart by its prose alone (common/finding-duplicates.js).
      clearMergedGroups()
      state.revalidateConflicts = getRevalidationConflicts()
    } else showToast('Could not load finding details. Open the team again to retry.')
    loaded()
    return entry.ok
  })()
}

// Fills each ingested finding (ingest.js ingestReport) from its report's
// entry's member at the same place, non-empty entries alone. None where a
// loaded report or finding has no match, as when a report changed between the
// two reads: findings are filled all together, or not at all.
function detailsFill(reports, workspace) {
  const whole = new Map(workspace.map(report => [report.id, report.data]))
  const pairs = []
  for (const report of reports) {
    const entries = reportEntries(whole.get(report._managedReportId))
    if (!entries) return null
    const groups = entries.map(entry => Array.isArray(entry) ? entry : [entry]).filter(group => group.length > 0)
    if (groups.length !== report.groups.length) return null
    for (const [index, group] of report.groups.entries()) {
      if (groups[index].length !== group.length) return null
      for (const [member, finding] of group.entries()) {
        const detail = groups[index][member]
        if (detail?.id !== finding.id) return null
        pairs.push([finding, detail])
      }
    }
  }
  return () => {
    for (const [finding, detail] of pairs) {
      for (const field of FINDING_DETAIL_FIELDS) if (Object.hasOwn(detail, field)) finding[field] = detail[field]
      forgetFindingText(finding)
    }
  }
}
