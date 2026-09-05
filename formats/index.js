// The formats library — what this project WRITES. The mirror of
// report/ (which reads): findings and what a reader made of them in,
// a document out, and nothing above these two directories imported —
// no DOM, no app state, no storage — so the same writer serves the
// viewer's Download button and anything else holding findings out of
// report/index.js.
//
//   import { findingsToMarkdown } from '../formats/index.js'
//   const md = findingsToMarkdown({ title, groups, … }, hooks)
//
// One format so far: markdown, the Download button's file and the text
// the export preview shows (see markdown.js for the document, and
// markdown-finding.js for what one finding becomes). The label tables
// are exported too, so a surface describing the same enumerations in
// prose — the export confirmation dialog — uses the words the file will.

export { findingsToMarkdown } from './markdown.js'
export { COLOR_LABELS, SEVERITY_LABELS, SOURCE_LABELS, TRIAGE_LABELS, severityLabel } from './labels.js'
