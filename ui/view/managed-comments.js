import { isManagedUiMode, state } from '#client/index.js'
import { roleAtLeast } from '../../common/managed/roles.ts'
import { fetchReportComments, saveReportComment } from './client-managed.js'

export function managedCommentsFor(finding) {
  return isManagedUiMode() ? state.managedComments?.get(finding?.id) ?? [] : []
}

export function canWriteManagedComments() {
  return isManagedUiMode() && state.managedSession != null && roleAtLeast(state.managedSession.role, 'triage')
}

// Capture both report and account identity. A late load/save must never put
// another account's server data into a local or newly navigated report.
export function managedCommentScope(reportId) {
  const reports = state.reports, userId = state.managedSession?.id
  return () => isManagedUiMode() && userId != null && state.managedSession?.id === userId
    && state.reports === reports && state.managedReports.some(report => report.id === reportId)
}

export async function loadManagedReportComments(reportId) {
  const current = managedCommentScope(reportId)
  if (!current()) return false
  const comments = await fetchReportComments(reportId)
  if (!current() || comments == null) return false
  const ids = new Set(state.reports.filter(report => report._managedReportId === reportId)
    .flatMap(report => report.groups.flatMap(group => group.map(finding => finding.id))))
  const grouped = new Map([...ids].map(id => [id, []]))
  for (const comment of comments) if (grouped.has(comment.findingId)) grouped.get(comment.findingId).push(comment)
  for (const [id, entries] of grouped) state.managedComments.set(id, entries)
  return true
}

export async function writeManagedComment(finding, body, original = null) {
  const reportId = finding?._managedReportId
  const current = managedCommentScope(reportId)
  if (!current() || !canWriteManagedComments()) return { status: 403 }
  if (original && original.authorId !== state.managedSession.id) return { status: 403 }
  const result = await saveReportComment(reportId, {
    findingId: finding.id, body, commentId: original?.id, version: original?.version,
  }, state.managedSession.csrfToken)
  if (!current()) return { status: 0 }
  if (result.comment) {
    const comments = state.managedComments.get(finding.id) ?? []
    const next = comments.filter(comment => comment.id !== result.comment.id)
    next.push(result.comment)
    next.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
    state.managedComments.set(finding.id, next)
  }
  return result
}
