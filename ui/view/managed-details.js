import { state } from '#client/index.js'
import { store } from '@rray/frontend/state-management'
import { reportEntries } from '@preventive/report'
import { setManagedWorkspace } from '../../client/managed/workspace.js'
import { FINDING_DETAIL_FIELDS } from '../../common/managed/finding-detail.js'
import { forgetFindingText } from './format.js'
import { showToast } from './toast.js'

// A team's board is drawn from its reports without their findings' detail
// (`lite`), the whole reports asked for beside them (ingest.js
// switchToManagedTeam). Until they are in, a popup, a view mode other than
// the board and an export wait for them (render.js, events.js); once in,
// each finding is filled in where it is, and the team's finding index
// (client/managed/workspace.js) built again from them.
let current = null

// Whether the loaded reports' findings wait for their detail.
export function managedDetailsPending() {
  return current !== null && !current.done && current.reports === store(state.reports)
}

// Settles once the loaded reports' findings have their detail, or never will.
export function managedDetailsReady() {
  return managedDetailsPending() ? current.ready : Promise.resolve()
}

// Fills the loaded reports' findings in from `request`'s whole reports, then
// `loaded()`, as long as `isCurrent()`; one that fails leaves them as they
// are, telling so.
export function awaitManagedDetails(teamId, request, isCurrent, loaded) {
  const reports = store(state.reports)
  const entry = current = { reports, done: false, ready: null }
  entry.ready = (async () => {
    const workspace = await Promise.resolve(request).catch(() => null)
    entry.done = true
    if (!isCurrent() || store(state.reports) !== reports) return
    if (workspace) {
      fillDetails(reports, workspace)
      setManagedWorkspace(teamId, workspace)
    } else showToast('Could not load finding details. Open the team again to retry.')
    loaded()
  })()
}

// Each ingested finding (ingest.js ingestReport) is its report's entry's
// member at the same place, non-empty entries alone.
function fillDetails(reports, workspace) {
  const whole = new Map(workspace.map(report => [report.id, report.data]))
  for (const report of reports) {
    const data = whole.get(report._managedReportId)
    if (!data) continue
    const groups = (reportEntries(data) ?? []).map(entry => Array.isArray(entry) ? entry : [entry]).filter(group => group.length > 0)
    if (groups.length !== report.groups.length) continue
    for (const [index, group] of report.groups.entries()) {
      for (const [member, finding] of group.entries()) {
        const detail = groups[index][member]
        if (!detail || detail.id !== finding.id) continue
        for (const field of FINDING_DETAIL_FIELDS) if (Object.hasOwn(detail, field)) finding[field] = detail[field]
        forgetFindingText(finding)
      }
    }
  }
}
