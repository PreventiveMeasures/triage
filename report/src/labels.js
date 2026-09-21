// The words the markdown writer uses for the app's enumerations, one
// table per dimension. The viewer's prose surfaces read them too — the
// export dialog, the analyzer dropdown, the page header — so a filter
// the dialog lists and the header line in the file can't disagree.

export const SEVERITY_LABELS = {
  critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low',
  high_bug: 'High bug', bug: 'Bug', informational: 'Informational',
}

export const TRIAGE_LABELS = {
  inprogress: 'In progress', fixed: 'Fixed', invalid: 'Invalid',
  deleted: 'Deleted', ignored: 'Ignored',
}

// The cause track — what the code's own maintainers did about a
// finding, as distinct from what an app did about shipping it.
export const UPSTREAM_LABELS = {
  reported: 'Reported', fixed: 'Fixed', wontfix: 'Won’t fix',
}

export const COLOR_LABELS = { red: 'Red', blue: 'Blue', green: 'Green', gray: 'Gray', none: 'Unmarked' }

// The producer behind a report's `source` marker, one per format the
// library reads. The analyzer's own dump carries no marker and is
// described by its run meta instead.
export const SOURCE_LABELS = {
  'claude-security': 'Claude Security',
  'codex-security': 'Codex Security',
  'deepsec': 'DeepSec',
  'piolium': 'Piolium',
}

// An unknown tier prints as itself rather than vanishing: a report can
// invent one, and the reader is better served by the word than by a
// blank.
export function severityLabel(severity) {
  return SEVERITY_LABELS[severity] ?? String(severity ?? '')
}
