import { isManagedUiMode, state } from '#client/index.js'
import { FixCache } from '../../client/managed/pull-request-cache.js'
import { fetchFixes } from './client-managed.js'

const listeners = new Set()
export const managedFixes = new FixCache({
  context: () => {
    const session = state.managedSession
    return isManagedUiMode() && session?.id && state.currentManagedTeam ? {
      key: JSON.stringify([session.id, session.role, session.csrfToken]),
      teamId: state.currentManagedTeam,
      teams: state.managedTeams,
    } : null
  },
  fetchWorkspace: fetchFixes,
  changed: () => { for (const notify of listeners) notify() },
})

export function subscribeFixes(notify) {
  listeners.add(notify)
  return () => listeners.delete(notify)
}

export function resetManagedFixes() {
  managedFixes.reset()
  for (const notify of listeners) notify()
}

export function invalidateManagedFixes(teamId) {
  if (state.currentManagedTeam === teamId) resetManagedFixes()
}
