// Resolve location before looking in loaded findings: the same id can
// be visible in a workspace and in each of its reports. A loaded copy
// must not override the report/workspace named by the link.
import { findReportWithFinding, reportForHint, state, workspaceForHint } from '#client/index.js'
import { findLoadedFinding, reportWorkspaceFor } from './finding-link.js'

// Navigation is supplied by the DOM layer so these rules can be tested
// against real stored reports without constructing the whole page.
export async function locateLinkedFinding(ref, { openReport, openWorkspace }) {
  const [name, ws] = await Promise.all([
    reportForHint(ref.report),
    workspaceForHint(ref.workspace),
  ])

  async function inReport(reportName) {
    const workspaceId = reportWorkspaceFor(reportName, ws?.id)
    if (state.currentFile !== reportName || state.currentWorkspace
        || state.currentReportWorkspace !== workspaceId) {
      await openReport(reportName, undefined, { workspaceId })
    }
    return findLoadedFinding(ref.id)
  }

  // Both hints mean workspace → report → finding. Only a workspace
  // hint means workspace → finding. Report-only links also remain
  // report links when the local file has since joined a workspace.
  if (name) {
    const hit = await inReport(name)
    if (hit) return hit
  }
  if (ws) {
    if (state.currentWorkspace !== ws.id) await openWorkspace(ws.id)
    const hit = findLoadedFinding(ref.id)
    if (hit) return hit
  }
  const loadedHit = findLoadedFinding(ref.id)
  if (loadedHit) return loadedHit

  // Hints can be stale or unavailable on this browser. Fall back to a
  // local scan, without forcing an unrelated workspace's merged view.
  const loaded = state.reports.map((r) => r.fileName).filter(Boolean)
  const found = await findReportWithFinding(ref.id, { skip: loaded })
  return found ? await inReport(found) : null
}
