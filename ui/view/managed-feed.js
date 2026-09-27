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
  return { promise, start }
}

// The connection watchdog cancels only its wait; initial HTTP hydration still
// belongs to the view and must not be repeated by a reconnect while in flight.
function waitForHydration(promise, signal) {
  if (signal.aborted) return Promise.resolve(false)
  return new Promise(resolve => {
    const finish = success => { signal.removeEventListener('abort', abort); resolve(success) }
    const abort = () => finish(false)
    signal.addEventListener('abort', abort, { once: true })
    promise.then(finish, () => finish(false))
  })
}

// The connection belongs to the account and team, not to a page. Its annotation
// consumer still belongs to the current view, so navigation cancels stale HTTP
// reads without reconnecting the same stream. A team stream includes the catalog.
export function startManagedTeamFeed({ catalogOnly = false, hydrate } = {}) {
  const session = state.managedSession, view = currentViewSignal()
  const focused = ['findings', 'files', 'links'].includes(state.currentView)
  const teamId = focused && (!catalogOnly || active?.teamId === state.currentManagedTeam && !active.signal.aborted)
    ? state.currentManagedTeam : null
  if (!isManagedUiMode() || !session || session.role === 'none' || session.publicShare && !teamId) {
    stopManagedTeamFeed(); return hydrate ? Promise.resolve(false) : undefined
  }
  const key = JSON.stringify([teamId, session.id, session.role, session.csrfToken, !!session.publicShare])
  if (active?.key !== key || active.signal.aborted) {
    stopManagedTeamFeed()
    const controller = new AbortController()
    const subscription = { key, controller, signal: controller.signal, teamId, version: 0, target: null }
    subscription.current = (signal = subscription.signal) => !signal.aborted && !subscription.signal.aborted
      && active === subscription && isManagedUiMode()
      && state.managedSession?.id === session.id && state.managedSession?.role === session.role
      && state.managedSession?.csrfToken === session.csrfToken && !!state.managedSession?.publicShare === !!session.publicShare
    active = subscription
    watchSubscription(subscription)
  }
  const subscription = active
  // Sidebar renders must not start annotation reads while a report is loading.
  if (catalogOnly || !teamId) return subscription.target?.ready
  // The first reactive render can wrap this array after loading. Normalize its
  // identity so painting the hydrated view does not invalidate its consumer.
  const reports = store(state.reports)
  const previous = subscription.target
  if (previous?.view === view && previous.reports === reports && !previous.signal.aborted) return previous.ready
  previous?.controller.abort()
  const controller = new AbortController(), signal = AbortSignal.any([controller.signal, subscription.signal, view])
  const target = { controller, signal, view, reports, version: previous?.reports === reports ? previous.version : 0 }
  subscription.target = target
  target.current = () => subscription.current() && !signal.aborted && subscription.target === target
    && state.currentManagedTeam === teamId && store(state.reports) === reports
  target.hydration = hydrate ? initialHydration(async hydrationSignal => {
    const version = subscription.version
    const success = await hydrate(hydrationSignal)
    if (success && target.current()) target.version = version
    return success
  }, signal, target.current) : null
  target.ready = target.hydration?.promise
  // A retained connection has already supplied its initial invalidation. The
  // new report can hydrate immediately; no new stream or fallback delay needed.
  if (subscription.version || subscription.finished) {
    if (target.hydration) void target.hydration.start()
    else if (target.version < subscription.version) {
      void refreshTarget(subscription, target, subscription.signal).then(success => {
        // An event received during navigation must not be lost. If catching up
        // fails, reconnect just as the watcher does for a failed live refresh.
        if (!success && target.current()) { stopManagedTeamFeed(); startManagedTeamFeed() }
        return success
      })
    }
  }
  return target.ready
}

function watchSubscription(subscription) {
  const { signal, controller, current } = subscription
  void watchTeamFeed(subscription.teamId, {
    signal,
    onTeams: async (requestSignal, revision) => {
      const isCurrent = () => current(requestSignal)
      if (!isCurrent()) return false
      return await refreshTeams(isCurrent, requestSignal, revision) && isCurrent()
    },
    onUpdate: requestSignal => {
      if (!current(requestSignal)) return false
      subscription.version++
      return refreshTarget(subscription, subscription.target, requestSignal)
    },
    onClose: () => {
      if (current()) document.dispatchEvent(new Event('managed-feed-closed'))
      controller.abort()
    },
  }).catch(error => { if (current()) console.warn('managed: team feed failed', error) })
    .finally(() => {
      subscription.finished = true
      if (current()) void subscription.target?.hydration?.start() // preview has no live feed
    })
}

async function refreshTarget(subscription, target, requestSignal) {
  if (!subscription.current(requestSignal)) return false
  if (!target?.current()) return true // Navigation only detaches annotation reads.
  // Coalesce a live event with catch-up started while attaching a new view.
  // A watchdog cancels the shared live read, but not initial hydration. The
  // next connection must not join that canceled job while it is settling.
  if (!target.refresh || target.refresh.controller.signal.aborted) {
    const controller = new AbortController(), job = { controller, promise: null }
    const signal = AbortSignal.any([controller.signal, target.signal])
    target.refresh = job
    job.promise = readTargetUpdates(subscription, target, signal).catch(() => false)
      .finally(() => { if (target.refresh === job) target.refresh = null })
  }
  const job = target.refresh
  const signal = AbortSignal.any([requestSignal, target.signal, job.controller.signal])
  const abort = () => job.controller.abort()
  requestSignal.addEventListener('abort', abort, { once: true })
  let success
  try { success = await waitForHydration(job.promise, signal) }
  finally { requestSignal.removeEventListener('abort', abort) }
  if (!subscription.current(requestSignal)) return false
  if (!target.current()) return true
  if (!success) return false
  // A coalesced event can arrive while the completed job's promise settles.
  if (target.version < subscription.version) return refreshTarget(subscription, target, requestSignal)
  return true
}

async function readTargetUpdates(subscription, target, signal) {
  if (target.hydration && !(await waitForHydration(target.hydration.start(), signal))) return false
  while (target.current() && !signal.aborted && target.version < subscription.version) {
    const version = subscription.version
    for (const report of state.managedReports) {
      if (!target.reports.some(loaded => loaded._managedReportId === report.id)) continue // links
      if (!(await refreshManagedReportTriage(report.id, { signal }))) return false
      if (!target.current() || signal.aborted || !(await loadManagedReportComments(report.id, { signal }))) return false
    }
    if (!target.current() || signal.aborted) return false
    target.version = version
  }
  return !signal.aborted && target.current()
}
