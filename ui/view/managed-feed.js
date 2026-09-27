import { isManagedUiMode, state } from '#client/index.js'
import { watchTeamFeed } from './client-managed.js'
import { loadManagedReportComments } from './managed-comments.js'
import { refreshManagedReportTriage } from './managed-triage.js'
import { currentViewSignal } from './view-navigation.js'

let active = null
export function stopManagedTeamFeed() {
  active?.controller.abort()
  active = null
}

// Only the hydrated, focused team subscribes. Navigation aborts immediately,
// including while the next team is loading; late reads cannot cross views.
export function startManagedTeamFeed() {
  const session = state.managedSession, teamId = state.currentManagedTeam
  if (!isManagedUiMode() || !teamId || !session || !['findings', 'files', 'links'].includes(state.currentView)) {
    stopManagedTeamFeed(); return
  }
  const reports = state.reports, view = currentViewSignal()
  const key = JSON.stringify([teamId, session.id, session.role, session.csrfToken])
  if (active?.key === key && active.view === view && !active.controller.signal.aborted) return
  stopManagedTeamFeed()
  const controller = new AbortController(), signal = AbortSignal.any([controller.signal, view])
  const subscription = { key, view, controller }
  active = subscription
  const current = () => !signal.aborted && active === subscription && isManagedUiMode()
    && state.currentManagedTeam === teamId && state.reports === reports
    && state.managedSession?.id === session.id && state.managedSession?.role === session.role
  void watchTeamFeed(teamId, {
    signal,
    onUpdate: async () => {
      if (!current()) { controller.abort(); return false }
      for (const report of state.managedReports) {
        if (!reports.some(loaded => loaded._managedReportId === report.id)) continue // links
        if (!(await refreshManagedReportTriage(report.id, { signal }))) return false
        if (!current() || !(await loadManagedReportComments(report.id, { signal }))) return false
      }
      return current()
    },
    onClose: () => {
      if (current()) document.dispatchEvent(new Event('managed-feed-closed'))
      controller.abort()
    },
  }).catch(error => { if (current()) console.warn('managed: team feed failed', error) })
}
