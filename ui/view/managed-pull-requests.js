import { isManagedUiMode, state } from '#client/index.js'
import { PullRequestCache } from '../../client/managed/pull-request-cache.js'
import { fetchPullRequests } from './client-managed.js'

const listeners = new Set()
export const managedPullRequests = new PullRequestCache({
  context: () => {
    const session = state.managedSession
    return isManagedUiMode() && session?.id && state.currentManagedTeam ? {
      key: JSON.stringify([session.id, session.role, session.csrfToken]),
      teamId: state.currentManagedTeam,
      teams: state.managedTeams,
    } : null
  },
  fetchWorkspace: fetchPullRequests,
  changed: () => { for (const notify of listeners) notify() },
})

export function subscribePullRequests(notify) {
  listeners.add(notify)
  return () => listeners.delete(notify)
}

export function resetManagedPullRequests() {
  managedPullRequests.reset()
  for (const notify of listeners) notify()
}

export function invalidateManagedPullRequests(teamId) {
  if (state.currentManagedTeam === teamId) resetManagedPullRequests()
}
