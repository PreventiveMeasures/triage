import { findingTitle } from '@preventive/report'

// A finding's detail: what its popup, the views besides the board and an
// export read, and the board does not. Its narrative and evidence, the hash
// its Code button finds a bundle by, and the export it names. A team's
// reports are first sent without it (server-managed/team-reports.ts), the
// board drawn from them, and their findings filled in from the whole reports
// (ui/view/managed-details.js).
export const FINDING_DETAIL_FIELDS = Object.freeze(['description', 'evidence', 'impact', 'reproduction', 'recommendation',
  'confidenceReason', 'revalidateVerdict', 'revalidateRecommendation', 'fileHash', 'exportName', 'methodName'])
const DETAIL = new Set(FINDING_DETAIL_FIELDS)
// More of a name than a board card's three lines show.
const NAME_CHARS = 200

// A finding without its detail. One without a title of its own is named by its
// description's first line (findingTitle), which it keeps as its description,
// as much of it as a card shows.
function liteFinding(finding) {
  if (!finding || typeof finding !== 'object' || Array.isArray(finding)) return finding
  const lite = Object.fromEntries(Object.entries(finding).filter(([key]) => !DETAIL.has(key)))
  const titled = typeof finding.title === 'string' && finding.title.trim() !== ''
  const title = titled ? '' : findingTitle(finding)
  if (title) lite.description = title.length > NAME_CHARS ? `${title.slice(0, NAME_CHARS - 1)}…` : title
  return lite
}

// A report's data, its findings without their detail.
export function liteReportData(data) {
  const key = Array.isArray(data?.findings) ? 'findings' : Array.isArray(data?.groups) ? 'groups' : null
  if (!key) return data
  return { ...data, [key]: data[key].map(entry => Array.isArray(entry) ? entry.map(liteFinding) : liteFinding(entry)) }
}
