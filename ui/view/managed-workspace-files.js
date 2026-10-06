import { workspaceFileCount } from './workspace-content.js'

// Initial list navigation and live catalog refreshes share this read. Capture
// the catalog as well as the view: a response started before an upload or a
// visibility change must not replace the count from the newer catalog.
export async function refreshManagedWorkspaceFiles(state, { fetchReports, signal, isCurrent, render }) {
  const view = state.currentView
  if (!['workspace-reports', 'workspace-bundles'].includes(view) || !isCurrent() || signal.aborted) return true
  const team = state.managedTeams.find(candidate => candidate.id === state.currentManagedTeam)
  if (!team) return true
  const session = state.managedSession
  const current = () => !signal.aborted && isCurrent() && state.currentView === view
    && state.managedSession === session && state.currentManagedTeam === team.id
    && state.managedTeams.find(candidate => candidate.id === team.id) === team
  // Report reads use a shared cache whose request may outlive its consumer.
  // Stop waiting when the view or feed watchdog cancels this refresh.
  const reports = await new Promise(resolve => {
    const finish = value => { signal.removeEventListener('abort', abort); resolve(value) }
    const abort = () => finish(null)
    signal.addEventListener('abort', abort, { once: true })
    Promise.resolve().then(() => signal.aborted ? null : fetchReports(team.id, { signal })).then(finish, () => finish(null))
  })
  if (!current()) return true
  // A failed live read must not leave an obsolete button available. Returning
  // false makes the catalog feed retry, even if its revision is unchanged.
  state.workspaceContentFileCount = reports ? workspaceFileCount(reports.map(entry => entry.data)) : 0
  render()
  return reports !== null
}
