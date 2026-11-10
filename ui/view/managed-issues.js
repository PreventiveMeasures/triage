import { isManagedUiMode, state } from '#client/index.js'
import { parseGithubIssueUrl, parseGithubPrUrl } from '../../common/github-pr.ts'

export function managedIssueFor(finding) {
  return isManagedUiMode() && state.currentManagedTeam && state.managedSession && !state.managedSession.publicShare
    ? state.managedIssues.get(finding?.id) ?? null : null
}
export function automaticFixFor(finding) { return managedIssueFor(finding)?.autoFix ?? '' }
// The one link a kanban card has room for: the manual Fix wins, then the
// pull request linked to the saved issue (or the one it duplicates), then the
// issue it was closed as a duplicate of, whose status is the one tracked,
// then the issue itself.
export function cardLinkFor(finding, entry) {
  const issue = managedIssueFor(finding)
  return entry?.fix || issue?.autoFix || issue?.duplicateOf || issue?.url || ''
}

// These read-only values stay separate from triage: editing or clearing Fix
// must never serialize an automatic link as a user's override.
export function applyManagedIssues(ids, issues = {}, expected) {
  let changed = false
  for (const id of ids) {
    if (expected && state.managedIssues.get(id) !== expected.get(id)) continue
    const raw = Object.hasOwn(issues, id) ? issues[id] : null
    const next = parseGithubIssueUrl(raw?.url) ? { url: raw.url, autoFix: parseGithubPrUrl(raw.autoFix) ? raw.autoFix : null,
      duplicateOf: parseGithubIssueUrl(raw.duplicateOf) ? raw.duplicateOf : null } : null
    const previous = state.managedIssues.get(id)
    if (previous?.url === next?.url && previous?.autoFix === next?.autoFix && previous?.duplicateOf === next?.duplicateOf) continue
    if (next) state.managedIssues.set(id, next)
    else state.managedIssues.delete(id)
    changed = true
  }
  return changed
}
