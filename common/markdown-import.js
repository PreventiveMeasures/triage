import { parseGenericMarkdownToReports } from '@preventive/report'

// Both local drops and managed uploads validate all products before the first
// write. JSON subreports carry their repository and producer through reloads.
export function splitMarkdownImport(content, filename) {
  const reports = parseGenericMarkdownToReports(content)
  if (reports === null) return null
  const stem = filename.replace(/\.(?:md|markdown)$/iu, '')
  const names = new Set()
  return reports.map(({ displayName, data }) => {
    // Keep readable names; only characters forbidden in storage need replacing.
    const name = `${stem}: ${displayName}`.replaceAll(/[\\/\p{Cc}]/gu, '_')
    if (names.has(name)) throw new Error(`Markdown (generic): products produce the same report name: ${name}`)
    names.add(name)
    return { name, content: JSON.stringify(data) }
  })
}
