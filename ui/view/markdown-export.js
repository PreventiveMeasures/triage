import { state } from '../../client/state.ts'
import { downloadBlob } from './dom.js'
import { commonPrefix, stripExportMarker } from './format.js'
import { ignoredKey, tabKey } from './group.js'

// Markdown serializer for the "download report" toolbar button —
// produces a single `.md` file from `state.reports`, grouped by
// severity tier so the most important findings sit at the top of
// the document. Per-user triage state (triageState / markers /
// ignoredIds / comments) is included where set so the export is a
// snapshot of the viewer's current annotations, not just the raw
// JSON the report was loaded from.

const SEVERITY_LABELS = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  high_bug: 'High Bug',
  bug: 'Bug',
  informational: 'Informational',
}
const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low', 'high_bug', 'bug', 'informational']

function severityLabel(severity) {
  return SEVERITY_LABELS[severity] ?? severity
}

function severityRank(severity) {
  const i = SEVERITY_ORDER.indexOf(severity)
  return i === -1 ? 999 : i
}

function locationStr(f) {
  const line = parseInt(f.line, 10)
  return Number.isFinite(line) ? `${f.file}:${line}` : f.file
}

// One finding as a markdown subsection. Description / recommendation
// / confidenceReason fields can themselves be markdown (claude-
// security reports are imported from `.md` directly) so they're
// emitted verbatim — escaping would corrupt the embedded fences.
function findingToMarkdown(f) {
  const key = tabKey(f)
  const triage = state.triageState.get(key)
  const ignored = state.ignoredIds.has(ignoredKey(f))
  const color = state.markers.get(key)
  const comment = state.comments.get(key) ?? ''
  const description = stripExportMarker(f.description ?? '', f.exportName)

  const heading = f.exportName
    ? `### ${locationStr(f)} - ${f.exportName}`
    : `### ${locationStr(f)}`
  const lines = [heading, '']

  const meta = []
  if (f.confidence !== undefined) meta.push(`**Confidence:** ${f.confidence}/10`)
  if (triage) meta.push(`**Triage:** ${triage}`)
  else if (ignored) meta.push(`**Ignored**`)
  if (color) meta.push(`**Mark:** ${color}`)
  if (meta.length > 0) {
    lines.push(meta.join(', '))
    lines.push('')
  }

  if (description) {
    lines.push(description.trim())
    lines.push('')
  }
  if (f.recommendation) {
    lines.push(`**Recommendation:** ${stripExportMarker(f.recommendation, f.exportName).trim()}`)
    lines.push('')
  }
  if (f.confidenceReason) {
    lines.push(`**Confidence reason:** ${stripExportMarker(f.confidenceReason, f.exportName).trim()}`)
    lines.push('')
  }
  if (f.fix) {
    lines.push(`**Fix:** ${stripExportMarker(f.fix, f.exportName).trim()}`)
    lines.push('')
  }
  if (comment) {
    lines.push(`**Comment:** ${comment.trim()}`)
    lines.push('')
  }

  return lines.join('\n')
}

// One report → markdown. Findings flattened from groups[] (a
// "group" is a list of cases for the same finding, see ingest /
// group.js — we emit each case as its own subsection so the order
// matches what the user sees in the list/grouped views) and sorted
// by severity descending so the doc opens with the most urgent
// findings.
function reportToMarkdown(report) {
  const findings = (report.groups ?? []).flat()
  const lines = [`# ${report.fileName}`, '']
  if (report.source) {
    lines.push(`**Source:** ${report.source}`)
    lines.push('')
  }
  lines.push(`**Findings:** ${findings.length}`)
  lines.push('')

  if (findings.length === 0) return lines.join('\n')

  const buckets = new Map()
  for (const f of findings) {
    const sev = f.severity ?? 'informational'
    if (!buckets.has(sev)) buckets.set(sev, [])
    buckets.get(sev).push(f)
  }
  const sortedSeverities = [...buckets.keys()].toSorted((a, b) => severityRank(a) - severityRank(b))

  for (const sev of sortedSeverities) {
    const bucket = buckets.get(sev)
    lines.push(`## ${severityLabel(sev)} (${bucket.length})`)
    lines.push('')
    for (const f of bucket) {
      lines.push(findingToMarkdown(f))
    }
  }
  return lines.join('\n').trimEnd() + '\n'
}

export function reportsToMarkdown(reports) {
  // Multiple-report mode: keep each report's H1 and separate them
  // with a horizontal rule. Mirrors how the print button stamps
  // commonPrefix(fileNames) as the document title for batches.
  return reports.map(reportToMarkdown).join('\n---\n\n')
}

// Mirror the print button's filename heuristic: single report uses
// its own name, multiple reports use the common prefix (so a batch
// of `security-foo.json` / `security-bar.json` saves as
// `security-.md`). The `.json` suffix is stripped before appending
// `.md` so we don't end up with `report.json.md`.
function targetFilename(reports) {
  const names = reports.map((r) => r.fileName)
  let target = ''
  if (names.length === 1) target = names[0]
  else if (names.length > 1) target = commonPrefix(names)
  target = target.replace(/\.json$/u, '')
  return `${target || 'deepview-report'}.md`
}

export function downloadReportsAsMarkdown(reports) {
  if (reports.length === 0) return
  const md = reportsToMarkdown(reports)
  const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' })
  downloadBlob(blob, targetFilename(reports))
}
