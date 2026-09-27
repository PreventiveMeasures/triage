import { isManagedUiMode, state } from '#client/index.js'
import { store } from '@rray/frontend/state-management'
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

// Start reads after the feed's initial invalidation, so it supplies the loading
// baseline instead of immediately repeating the same HTTP reads. A delayed or
// unavailable stream must not prevent HTTP loading; if that fallback wins, the
// eventual feed event still refreshes changes made since those reads began.
function initialHydration(hydrate, signal, current) {
  const { promise, resolve } = Promise.withResolvers()
  let started = false
  const finish = success => {
    clearTimeout(timer)
    signal.removeEventListener('abort', abort)
    resolve(success)
  }
  const abort = () => finish(false)
  const start = () => {
    if (!started && !signal.aborted) {
      started = true
      clearTimeout(timer)
      void Promise.resolve().then(() => current() && hydrate(signal))
        .then(success => finish(!!success && current()), () => finish(false))
    }
    return promise
  }
  const timer = setTimeout(start, 1_000)
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) abort()
  return { promise, start, get started() { return started } }
}

// The connection watchdog cancels only its wait; initial HTTP hydration still
// belongs to the view and must not be repeated by a reconnect while in flight.
function waitForHydration(promise, signal) {
  if (signal.aborted) return Promise.resolve(false)
  return new Promise(resolve => {
    const finish = success => { signal.removeEventListener('abort', abort); resolve(success) }
    const abort = () => finish(false)
    signal.addEventListener('abort', abort, { once: true })
    promise.then(finish)
  })
}

// One connection carries the catalog and focused triage, including hydration.
// Sidebar renders ensure a catalog feed on Home/Manage/bundles without starting
// triage reads in the middle of report hydration. Navigation aborts both.
export function startManagedTeamFeed({ catalogOnly = false, hydrate } = {}) {
  const session = state.managedSession, view = currentViewSignal()
  const focused = ['findings', 'files', 'links'].includes(state.currentView)
  const teamId = focused && (!catalogOnly || active?.teamId === state.currentManagedTeam && active?.view === view && !active.signal.aborted)
    ? state.currentManagedTeam : null
  if (!isManagedUiMode() || !session || session.role === 'none' || session.publicShare && !teamId) {
    stopManagedTeamFeed(); return hydrate ? Promise.resolve(false) : undefined
  }
  // The first reactive render can wrap this array after loading. Normalize its
  // identity now so painting the hydrated view does not invalidate the feed.
  const reports = store(state.reports)
  const key = JSON.stringify([teamId, session.id, session.role, session.csrfToken])
  if (active?.key === key && active.view === view && !active.signal.aborted) return active.ready
  stopManagedTeamFeed()
  const controller = new AbortController(), signal = AbortSignal.any([controller.signal, view])
  const subscription = { key, view, controller, signal, teamId }
  active = subscription
  const current = (requestSignal = signal) => !requestSignal.aborted && !signal.aborted && active === subscription && isManagedUiMode()
    && (!teamId || state.currentManagedTeam === teamId && store(state.reports) === reports)
    && state.managedSession?.id === session.id && state.managedSession?.role === session.role
    && state.managedSession?.csrfToken === session.csrfToken
  const hydration = hydrate ? initialHydration(hydrate, signal, current) : null
  subscription.ready = hydration?.promise
  void watchTeamFeed(teamId, {
    signal,
    onTeams: async requestSignal => {
      const isCurrent = () => current(requestSignal)
      if (!isCurrent()) return false
      return await refreshTeams(isCurrent, requestSignal) && isCurrent()
    },
    onUpdate: async requestSignal => {
      if (!current()) { controller.abort(); return false }
      if (!current(requestSignal)) return false
      if (!teamId) return true
      if (hydration) {
        const first = !hydration.started
        if (!(await waitForHydration(hydration.start(), requestSignal)) || !current(requestSignal)) return false
        if (first) return true
      }
      for (const report of state.managedReports) {
        if (!reports.some(loaded => loaded._managedReportId === report.id)) continue // links
        if (!(await refreshManagedReportTriage(report.id, { signal: requestSignal }))) return false
        if (!current(requestSignal) || !(await loadManagedReportComments(report.id, { signal: requestSignal }))) return false
      }
      return current(requestSignal)
    },
    onClose: () => {
      if (current()) document.dispatchEvent(new Event('managed-feed-closed'))
      controller.abort()
    },
  }).catch(error => { if (current()) console.warn('managed: team feed failed', error) })
    .finally(() => { if (current()) void hydration?.start() }) // preview has no live feed
  return subscription.ready
}
