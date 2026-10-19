import { findingTitle } from '@preventive/report'

// A finding's detail: what its popup, the views besides the board and an
// export read, and the board does not. Its narrative and evidence, the hash
// its Code button finds a bundle by, the export it names, the facts its card
// and an export tell (write-md-finding.js PLAIN_FIELDS, CODE_FIELDS, but for
// `priority`, which the board sorts and filters by), and the run meta its
// card's run line and a report's header read (its `model` and `type`, which
// the board's filters read, stay). A team's
// reports are first sent without it (server-managed/team-reports.ts), the
// board drawn from them, and their findings filled in from the whole reports
// (ui/view/managed-details.js).
export const FINDING_DETAIL_FIELDS = Object.freeze([
  'description', 'evidence', 'impact', 'reproduction', 'recommendation', 'confidenceReason', 'revalidateVerdict', 'revalidateRecommendation',
  'fileHash', 'exportName', 'methodName',
  'commitHash', 'auditedCommit', 'detectedAt', 'committedAt', 'dateCreated', 'status', 'branch', 'pocStatus', 'parent', 'slug', 'reportPath',
  'category', 'discoveredIn', 'effort', 'exportsMode',
])
const DETAIL = new Set(FINDING_DETAIL_FIELDS)
// As much of a name as a heading takes (@preventive/report write-md-finding.js
// HEADING_MAX), about a board card's three lines.
const NAME_CHARS = 120

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
