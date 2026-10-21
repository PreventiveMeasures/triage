import { findingTitle, reportEntries, revalidateKindOf } from '@preventive/report'
import { managedTeamView } from './team-app.js'
import { liteName } from './lite-name.js'

// A finding's detail: what its popup, the views besides the board and an
// export read, and the board does not. Its narrative and evidence, the hash
// its Code button finds a bundle by, the export it names, the facts its card
// and an export tell (write-md-finding.js PLAIN_FIELDS, CODE_FIELDS, but for
// `priority`, which the board sorts and filters by), and the run meta its
// card's run line and a report's header read (its `model` and `type`, which
// the board's filters read, stay), and the link the report gave its location
// (`location`), which its card does not draw. A team's
// reports are first sent without it (server-managed/team-reports.ts), the
// board drawn from them, and their findings filled in from the whole reports
// (ui/view/managed-details.js).
export const FINDING_DETAIL_FIELDS = Object.freeze([
  'description', 'evidence', 'impact', 'reproduction', 'recommendation', 'confidenceReason', 'revalidateVerdict', 'revalidateRecommendation',
  'fileHash', 'exportName', 'methodName',
  'severityReason', 'commitHash', 'auditedCommit', 'detectedAt', 'committedAt', 'dateCreated', 'status', 'branch', 'pocStatus', 'parent', 'slug', 'reportPath',
  'category', 'discoveredIn', 'effort', 'exportsMode', 'location',
])
const DETAIL = new Set(FINDING_DETAIL_FIELDS)
// A finding without its detail. One without a title of its own is named by its
// description's first line (findingTitle), which it keeps as its description,
// as much of it as a card shows.
function liteFinding(finding) {
  if (!finding || typeof finding !== 'object' || Array.isArray(finding)) return finding
  const lite = Object.fromEntries(Object.entries(finding).filter(([key]) => !DETAIL.has(key)))
  const titled = typeof finding.title === 'string' && finding.title.trim() !== ''
  const title = titled ? '' : findingTitle(finding)
  if (title) lite.description = liteName(title)
  return lite
}

const isPass = finding => revalidateKindOf(finding) === 'revalidation'

// A report's data, its findings without their detail. A workspace opening in
// App mode shows of an entry holding the revalidation pass's row that row
// alone (ui/view/group.js foldedTabs): with `fold`, such an entry is sent as
// the pass's rows, the rows beneath them left for the whole reports
// (ui/view/managed-details.js). With `shown`, the IDs of the findings one
// whose App view locks Confirmed shows (common/workspace-app.js
// workspaceAppRows), those alone are sent.
export function liteReportData(data, { fold = false, shown = null } = {}) {
  const key = Array.isArray(data?.findings) ? 'findings' : Array.isArray(data?.groups) ? 'groups' : null
  if (!key) return data
  if (shown) {
    const kept = entry => (Array.isArray(entry) ? entry : [entry]).filter(finding => shown.has(finding?.id))
    return { ...data, [key]: data[key].map(kept).filter(entry => entry.length > 0).map(entry => entry.map(liteFinding)) }
  }
  const entries = data[key].map(entry => {
    if (!Array.isArray(entry)) return liteFinding(entry)
    const folded = fold && entry.length > 1 && entry.some(isPass) ? entry.filter(isPass) : entry
    return folded.map(liteFinding)
  })
  return { ...data, [key]: entries }
}

const rows = data => (reportEntries(data) ?? []).flat().length

// A team's reports as its board is first sent them (server-managed/team-reports.ts),
// each `liteReportData`: where the workspace's App view locks Confirmed, only
// the rows that view shows (`folded: 'app'`); else, where nothing in it
// contradicts the revalidation pass, which opens a view of it in App mode
// (ui/view/render.js configureReportRevalidation), its entries folded under
// their App rows (`folded: 'rows'`). Folded, the `lens` the rows left out
// tell (team-app.js managedTeamLens). All of it read from `view`, the
// workspace's (team-app.js managedTeamView), where its builder has one.
export function liteWorkspace(reports, links, view = managedTeamView(Object.assign(reports.map(({ filename, data }) => ({ filename, data })), { links }))) {
  const shown = view.rows
  const fold = shown !== null || !view.conflicted()
  const lite = reports.map(report => ({ ...report, data: liteReportData(report.data, { fold, shown }) }))
  if (!fold || !lite.some((report, index) => rows(report.data) < rows(reports[index].data))) return { reports: lite, folded: false, lens: null }
  return { reports: lite, folded: shown ? 'app' : 'rows', lens: view.lens() }
}
