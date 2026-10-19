import { findingTitle, reportEntries, revalidateKindOf } from '@preventive/report'
import { managedTeamRevalidationConflicted } from './team-app.js'

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

const isPass = finding => revalidateKindOf(finding) === 'revalidation'

// A report's data, its findings without their detail. A workspace opening in
// App mode shows of an entry holding the revalidation pass's row that row
// alone (ui/view/group.js foldedTabs): with `fold`, such an entry is sent as
// the pass's rows, the rows beneath them left for the whole reports
// (ui/view/managed-details.js).
export function liteReportData(data, { fold = false } = {}) {
  const key = Array.isArray(data?.findings) ? 'findings' : Array.isArray(data?.groups) ? 'groups' : null
  if (!key) return data
  const entries = data[key].map(entry => {
    if (!Array.isArray(entry)) return liteFinding(entry)
    const shown = fold && entry.length > 1 && entry.some(isPass) ? entry.filter(isPass) : entry
    return shown.map(liteFinding)
  })
  return { ...data, [key]: entries }
}

const rows = data => (reportEntries(data) ?? []).flat().length

// A team's reports as its board is first sent them (server-managed/team-reports.ts),
// each `liteReportData`, folded where nothing in the workspace contradicts the
// revalidation pass, which opens a view of it in App mode
// (ui/view/render.js configureReportRevalidation); `folded` where that left
// rows out.
export function liteWorkspace(reports, links) {
  const fold = !managedTeamRevalidationConflicted(Object.assign(reports.map(({ filename, data }) => ({ filename, data })), { links }))
  const lite = reports.map(report => ({ ...report, data: liteReportData(report.data, { fold }) }))
  return { reports: lite, folded: fold && lite.some((report, index) => rows(report.data) < rows(reports[index].data)) }
}
