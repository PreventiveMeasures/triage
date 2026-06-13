import { state } from '#client/index.js'
import { findingDisplayName, stripExportMarker } from './format.js'
import { isIgnored, tabKey } from './group.js'
import { reportGroupsForExport } from './markdown-export.js'

// CSV serializer for the "download report" dialog's CSV format — one
// row per finding (a dedup group's cases are flattened, same as the
// markdown export) for loading into a spreadsheet. Shares the report
// group-selection (`reportGroupsForExport`, honouring the filtered /
// "export everything" toggle) with markdown-export.js so both formats
// stay in lockstep. Pure serialization (no DOM): the download itself
// lives in download-reports.js.
//
// Columns mix the finding's own fields with the viewer's per-finding
// triage annotations (state / mark / flag / comment / fix), so the CSV
// is a snapshot of the current triage, not just the raw report.

const CSV_COLUMNS = [
  'Report', 'Severity', 'Confidence', 'File', 'Line', 'Name',
  'Triage', 'Mark', 'Flagged', 'Comment', 'Fix', 'Description',
]

// One cell, quoted per RFC 4180 and guarded against spreadsheet
// formula injection. Finding text is untrusted, so a cell that would
// start with `=`, `+`, `-`, `@` (or a leading control char) — which
// Excel / Sheets evaluate as a formula — gets a leading apostrophe
// before the standard quote/escape so it's treated as plain text.
function csvCell(value) {
  let s = value == null ? '' : String(value)
  if (/^[=+\-@\t\r]/u.test(s)) s = `'${s}`
  if (/["\n\r,]/u.test(s)) s = `"${s.replaceAll('"', '""')}"`
  return s
}

function findingToCsvRow(report, f) {
  const entry = state.triage.get(tabKey(f))
  // Triage state column: explicit triage value, else the per-report
  // ignore flag (which is a separate bucket), else blank (live).
  const triage = entry?.triage ?? (isIgnored(f) ? 'ignored' : '')
  return [
    report.fileName,
    f.severity ?? '',
    f.confidence ?? '',
    f.file ?? '',
    f.line ?? '',
    findingDisplayName(f) ?? '',
    triage,
    entry?.color ?? '',
    entry?.flagged === true ? 'yes' : '',
    entry?.comment ?? '',
    entry?.fix ?? '',
    stripExportMarker(f.description ?? '', f).trim(),
  ].map(csvCell).join(',')
}

export function reportsToCsv(reports, { all = false } = {}) {
  const rows = [CSV_COLUMNS.map(csvCell).join(',')]
  for (const report of reports) {
    for (const f of reportGroupsForExport(report, all).flat()) {
      rows.push(findingToCsvRow(report, f))
    }
  }
  // CRLF line terminators per RFC 4180; trailing newline so the file
  // ends on a record boundary.
  return rows.join('\r\n') + '\r\n'
}
