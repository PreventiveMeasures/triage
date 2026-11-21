import { duplicatesOf, hasLinkedFindings, reportsForFindingId, state } from '#client/index.js'

// Report-only row filter: a direct link must resolve outside this report,
// and its target ID must not occur anywhere inside the original report.
// Use the raw rows, including hidden/filtered findings, for that membership.
export function reportDuplicateIds() {
  if (state.currentWorkspace || !hasLinkedFindings()) return new Set()
  const reportName = state.currentFile ?? state.reports[0]?.fileName
  if (!reportName) return new Set()
  const ownIds = new Set(state.reports.filter((report) => report.fileName === reportName)
    .flatMap((report) => report.groups.flat()).filter((finding) => finding.id != null).map((finding) => String(finding.id)))
  return new Set([...ownIds].filter((id) => duplicatesOf(id).some((other) => !ownIds.has(other)
    && reportsForFindingId(other).some((name) => name !== reportName))))
}
