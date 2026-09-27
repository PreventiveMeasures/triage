import { isManagedUiMode, state } from '#client/index.js'
import { watchTeamFeed } from './client-managed.js'
import { loadManagedReportComments } from './managed-comments.js'
import { refreshManagedReportTriage } from './managed-triage.js'
import { currentViewSignal } from './view-navigation.js'

let active = null
let refreshTeams = () => Promise.resolve(true)
export function setManagedTeamFeedRefresh(refresh) { refreshTeams = refresh }
export function stopManagedTeamFeed() {
  active?.controller.abort()
  active = null
}

// One connection carries the catalog and, after hydration, focused triage.
// Sidebar renders ensure a catalog feed on Home/Manage/bundles without starting
// triage reads in the middle of report hydration. Navigation aborts both.
export function startManagedTeamFeed({ catalogOnly = false } = {}) {
  const session = state.managedSession, view = currentViewSignal()
  const focused = ['findings', 'files', 'links'].includes(state.currentView)
  const teamId = focused && (!catalogOnly || active?.teamId === state.currentManagedTeam && active?.view === view && !active.signal.aborted)
    ? state.currentManagedTeam : null
  if (!isManagedUiMode() || !session || session.role === 'none' || session.publicShare && !teamId) {
    stopManagedTeamFeed(); return
  }
  const reports = state.reports
  const key = JSON.stringify([teamId, session.id, session.role, session.csrfToken])
  if (active?.key === key && active.view === view && !active.signal.aborted) return
  stopManagedTeamFeed()
  const controller = new AbortController(), signal = AbortSignal.any([controller.signal, view])
  const subscription = { key, view, controller, signal, teamId }
  active = subscription
  const current = () => !signal.aborted && active === subscription && isManagedUiMode()
    && (!teamId || state.currentManagedTeam === teamId && state.reports === reports)
    && state.managedSession?.id === session.id && state.managedSession?.role === session.role
  void watchTeamFeed(teamId, {
    signal,
    onTeams: async () => {
      if (!current()) return false
      return await refreshTeams(current, signal) && current()
    },
    onUpdate: async () => {
      if (!current()) { controller.abort(); return false }
      if (!teamId) return true
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
