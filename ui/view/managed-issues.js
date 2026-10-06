import { isManagedUiMode, state } from '#client/index.js'
import { parseGithubIssueUrl, parseGithubPrUrl } from '../../common/github-pr.ts'

export function managedIssueFor(finding) {
  return isManagedUiMode() && state.currentManagedTeam && state.managedSession && !state.managedSession.publicShare
    ? state.managedIssues.get(finding?.id) ?? null : null
}
export function automaticFixFor(finding) { return managedIssueFor(finding)?.autoFix ?? '' }

// These read-only values stay separate from triage: editing or clearing Fix
// must never serialize an automatic link as a user's override.
export function applyManagedIssues(ids, issues = {}, expected) {
  let changed = false
  for (const id of ids) {
    if (expected && state.managedIssues.get(id) !== expected.get(id)) continue
    const raw = Object.hasOwn(issues, id) ? issues[id] : null
    const next = parseGithubIssueUrl(raw?.url) ? { url: raw.url, autoFix: parseGithubPrUrl(raw.autoFix) ? raw.autoFix : null } : null
    const previous = state.managedIssues.get(id)
    if (previous?.url === next?.url && previous?.autoFix === next?.autoFix) continue
    if (next) state.managedIssues.set(id, next)
    else state.managedIssues.delete(id)
    changed = true
  }
  return changed
}
