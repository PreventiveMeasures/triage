import { duplicatesOf, hasLinkedFindings, reportsForFindingId, state } from '#client/index.js'

// Report-only row filter: a direct link must resolve outside this report,
// and its target ID must not occur anywhere inside the original report.
// Use the raw rows, including hidden/filtered findings, for that membership.
export function reportDuplicateIds() {
  const matched = new Set()
  if (state.currentWorkspace || !hasLinkedFindings()) return matched
  const reportName = state.currentFile ?? state.reports[0]?.fileName
  if (!reportName) return matched
  const ownIds = new Set()
  for (const report of state.reports) {
    if (report.fileName !== reportName) continue
    for (const group of report.groups) {
      for (const finding of group) {
        if (finding.id != null) ownIds.add(String(finding.id))
      }
    }
  }
  for (const id of ownIds) {
    if (duplicatesOf(id).some((other) => !ownIds.has(other)
      && reportsForFindingId(other).some((name) => name !== reportName))) {
      matched.add(id)
    }
  }
  return matched
}
