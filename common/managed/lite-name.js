import { reportEntries } from '@preventive/report'

// As much of a name as a heading takes (@preventive/report write-md-finding.js
// HEADING_MAX), about a board card's three lines. A board's copy of a team's
// reports (finding-detail.js) cuts one longer to end in `CUT`, an ellipsis
// once read.
const CUT = '...', NAME_CHARS = 120

export const liteName = name => name.length > NAME_CHARS ? `${name.slice(0, NAME_CHARS - CUT.length)}${CUT}` : name

// A report's data from its board's copy, as read: a name cut ends in an
// ellipsis. One as long as a cut leaves it and ending in `CUT` is one; one
// shorter ends as it does.
export function readLiteReportData(data) {
  for (const finding of (reportEntries(data) ?? []).flat()) {
    const name = finding?.description
    if (typeof name === 'string' && name.length === NAME_CHARS && name.endsWith(CUT)) finding.description = `${name.slice(0, -CUT.length)}…`
  }
  return data
}
