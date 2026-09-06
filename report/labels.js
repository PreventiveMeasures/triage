// The words the markdown writer uses for the app's enumerations — one
// table per dimension. The viewer's surfaces that describe the same
// things in prose (the export confirmation dialog through
// ui/view/export-summary.js, the toolbar's analyzer dropdown and the
// page header through SOURCE_LABELS) read these too, so a filter the
// dialog lists and the header line the file carries can't disagree on
// a word.

export const SEVERITY_LABELS = {
  critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low',
  high_bug: 'High bug', bug: 'Bug', informational: 'Informational',
}

export const TRIAGE_LABELS = {
  inprogress: 'In progress', fixed: 'Fixed', invalid: 'Invalid',
  deleted: 'Deleted', ignored: 'Ignored',
}

export const COLOR_LABELS = { red: 'Red', blue: 'Blue', green: 'Green', gray: 'Gray', none: 'Unmarked' }

// The producer behind a report's `source` marker — the library's own
// name for each format it reads (index.js MARKDOWN_FORMATS, plus the
// codex splitter). The analyzer's own dump carries none and is
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
