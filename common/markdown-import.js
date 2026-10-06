import { parseGenericMarkdownToReports } from '@preventive/report'

// Both local drops and managed uploads validate all products before the first
// write. JSON subreports carry their repository and producer through reloads.
export function splitMarkdownImport(content, filename) {
  const reports = parseGenericMarkdownToReports(content)
  if (reports === null) return null
  const stem = filename.replace(/\.(?:md|markdown)$/iu, '')
  return reports.map(({ displayName, data }) => ({
    name: `${encodeURIComponent(stem)}: ${encodeURIComponent(displayName)}.generic-md`,
    content: JSON.stringify(data),
  }))
}
