import { state } from '#client/index.js'
import { store } from '@rray/frontend/state-management'
import { fetchTeamTrees } from './client-managed.js'
import { showToast } from './toast.js'

// A team's reports tell how many files their trees hold (`treeFiles`), the
// trees asked for apart, once its graph or Files shows (render.js): each kept
// on its report's entry, as a local report's is from its file.
let pending = null

// Whether loaded reports' trees are still to be asked for.
export function wantsManagedTrees(reports) {
  return reports.some(report => report._managedReportId && !report.tree && report.treeFiles > 0)
}

// Asks for the team's trees, once for the reports loaded, then `loaded(ok)`.
// True while they are asked for; false where there are none to ask for.
// The loaded reports are told apart by their array, its identity normalized
// as a reactive render can wrap it (managed-feed.js).
export function loadManagedTrees(loaded) {
  const reports = store(state.reports), teamId = state.currentManagedTeam
  if (!teamId || !wantsManagedTrees(reports)) return false
  if (pending === reports) return true
  pending = reports
  // The same workspace its reports were read as: a hidden report's preview.
  const reportId = state.managedTeams.find(team => team.id === teamId)?.reports
    .find(report => report.id === state.currentManagedReport && report.visible === false)?.id ?? null
  void readTrees(reports, teamId, reportId, loaded)
  return true
}

async function readTrees(reports, teamId, reportId, loaded) {
  const trees = await fetchTeamTrees(teamId, { reportId })
  if (pending === reports) pending = null
  if (store(state.reports) !== reports || state.currentManagedTeam !== teamId) return
  if (!trees) {
    showToast('Could not load the report files. Please try again.')
    loaded(false)
    return
  }
  // One the server holds none for has none to ask for again.
  for (const report of reports) {
    if (report._managedReportId && !report.tree && report.treeFiles > 0) report.tree = trees.get(report._managedReportId) ?? {}
  }
  loaded(true)
}
