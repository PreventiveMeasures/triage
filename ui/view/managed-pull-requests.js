import { isManagedUiMode, state } from '#client/index.js'
import { PullRequestCache } from '../../client/managed/pull-request-cache.js'
import { fetchPullRequests } from './client-managed.js'

const listeners = new Set()
export const managedPullRequests = new PullRequestCache({
  context: () => {
    const session = state.managedSession
    return isManagedUiMode() && session?.id ? {
      key: JSON.stringify([session.id, session.role, session.csrfToken]),
      csrfToken: session.csrfToken,
      teams: state.managedTeams,
    } : null
  },
  fetchBatch: fetchPullRequests,
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
