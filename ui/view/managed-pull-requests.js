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
      reportId: state.managedTeams.find(team => team.id === state.currentManagedTeam)?.reports
        .find(report => report.id === state.currentManagedReport && report.visible === false)?.id ?? null,
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

// Warm the batch even in kanban/filter views where the issue itself is not
// rendered. Reuse derived PR metadata from our batch, but request any missing
// PR introduced by another client's annotation update. An issue its finding
// had none of before, as every one has when a team's annotations first load,
// is asked for only where the batch lacks it: the batch read since it was
// linked holds it. One linked in place of another discards the batch.
export function refreshManagedIssueMetadata(teamId, ids, previous) {
  if (state.currentManagedTeam !== teamId) return
  const issues = [...ids].map(id => ({ id, issue: state.managedIssues.get(id) }))
  if (issues.some(({ id, issue }) => previous.has(id) && issue?.url !== previous.get(id).url)) invalidateManagedFixes(teamId)
  for (const { id, issue } of issues) {
    if (issue?.url && !previous.has(id)) managedFixes.read(issue.url, { refreshIfMissing: true })
    if (issue?.autoFix && issue.autoFix !== previous.get(id)?.autoFix) managedFixes.read(issue.autoFix, { refreshIfMissing: true })
  }
  const url = issues.find(({ issue }) => issue?.url)?.issue.url
  if (url) managedFixes.read(url)
}
