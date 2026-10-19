import { reportEntries } from '@preventive/report'

// As much of a name as a heading takes (@preventive/report write-md-finding.js
// HEADING_MAX), about a board card's three lines. A board's copy of a team's
// reports (finding-detail.js) cuts one longer to end in `CUT`, an ellipsis
// once read.
const CUT = '...', NAME_CHARS = 120

export const liteName = name => name.length > NAME_CHARS ? `${name.slice(0, NAME_CHARS - CUT.length)}${CUT}` : name

// A report's data from its board's copy, as read: a name ending in `CUT` ends
// in an ellipsis.
export function readLiteReportData(data) {
  for (const finding of (reportEntries(data) ?? []).flat()) {
    if (typeof finding?.description === 'string' && finding.description.endsWith(CUT)) finding.description = `${finding.description.slice(0, -CUT.length)}…`
  }
  return data
}
