import { state } from '#client/index.js'
import { downloadBlob } from './dom.js'
import { applyFilters } from './filters.js'
import { commonPrefix, correctedVariants, effectiveSeverity, evidenceMarkdown, findingDisplayName, hasSeverityCorrection, revalidateKind, splitDescription, stripExportMarker } from './format.js'
import { groupState, isIgnored, tabKey } from './group.js'

// Markdown serializer for the "download report" toolbar button —
// produces a single `.md` file from `state.reports`, grouped by
// severity tier so the most important findings sit at the top of
// the document. Per-user triage state (triageState / markers /
// ignoredIds / comments) is included where set so the export is a
// snapshot of the viewer's current annotations, not just the raw
// JSON the report was loaded from.
//
// The export honours the active filters the same way the print/PDF
// path does: each report contributes only the findings visible under
// the current triage bucket (live / trash) and toolbar filters
// (severity / source / confidence / search / …), so a downloaded
// report matches what the viewer sees on screen and would get on
// paper. See `visibleGroups` below.

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

// One finding as a markdown subsection. Description / impact /
// reproduction / recommendation / confidenceReason / revalidation
// fields can
// themselves be markdown (claude-security reports are imported from
// `.md` directly) so they're emitted verbatim — escaping would
// corrupt the embedded fences.
function findingToMarkdown(f) {
  const key = tabKey(f)
  const entry = state.triage.get(key)
  const triage = entry?.triage
  const ignored = isIgnored(f)
  const color = entry?.color
  const comment = entry?.comment ?? ''
  const fix = entry?.fix ?? ''
  // Title + body via the same split the card draws: a report that
  // names the finding in a `title` field gets that name emitted as the
  // body's first line, which is exactly where a markdown import would
  // have carried it — so the document reads the same either way.
  const { title, body: description } = splitDescription(f)
  const displayName = findingDisplayName(f)

  const heading = displayName
    ? `### ${locationStr(f)} - ${displayName}`
    : `### ${locationStr(f)}`
  const lines = [heading, '']

  const meta = []
  // Severity correction provenance — the doc has no toggle, so always
  // record both the corrected (effective) tier and the original.
  if (hasSeverityCorrection(f)) {
    const varies = correctedVariants(f) ? ', varies across reports' : ''
    meta.push(`**Severity:** ${severityLabel(effectiveSeverity(f))} (corrected from ${severityLabel(f.severity)}${varies})`)
  }
  if (f.confidence !== undefined) meta.push(`**Confidence:** ${f.confidence}/10`)
  // The revalidation outcome rides the meta line so even the row that
  // IS the pass (`revalidation`, which carries no verdict text of its
  // own) is marked as one in the document.
  const revalidate = revalidateKind(f)
  if (revalidate) meta.push(`**Revalidation:** ${revalidate}`)
  if (triage) meta.push(`**Triage:** ${triage}`)
  else if (ignored) meta.push(`**Ignored**`)
  if (color) meta.push(`**Mark:** ${color}`)
  if (entry?.flagged === true) meta.push(`**Flagged**`)
  if (meta.length > 0) {
    lines.push(meta.join(', '))
    lines.push('')
  }

  if (title) {
    lines.push(title)
    lines.push('')
  }
  if (description) {
    lines.push(description.trim())
    lines.push('')
  }
  // Claude Security's `## Evidence` list lives in structured rows after
  // parse (see common/parse-md.js), so it's rebuilt here rather than
  // riding along inside the description.
  const evidence = evidenceMarkdown(f)
  if (evidence) {
    lines.push(evidence)
    lines.push('')
  }
  if (f.impact) {
    lines.push(`**Impact:** ${stripExportMarker(f.impact, f).trim()}`)
    lines.push('')
  }
  if (f.reproduction) {
    lines.push(`**Reproduction:** ${stripExportMarker(f.reproduction, f).trim()}`)
    lines.push('')
  }
  if (f.recommendation) {
    lines.push(`**Recommendation:** ${stripExportMarker(f.recommendation, f).trim()}`)
    lines.push('')
  }
  if (f.confidenceReason) {
    lines.push(`**Confidence reason:** ${stripExportMarker(f.confidenceReason, f).trim()}`)
    lines.push('')
  }
  if (f.revalidateVerdict) {
    lines.push(`**Revalidation verdict:** ${stripExportMarker(f.revalidateVerdict, f).trim()}`)
    lines.push('')
  }
  if (f.revalidateRecommendation) {
    lines.push(`**Revalidation recommendation:** ${stripExportMarker(f.revalidateRecommendation, f).trim()}`)
    lines.push('')
  }
  if (hasSeverityCorrection(f) && f.correctedSeverityReason) {
    lines.push(`**Severity correction:** ${f.correctedSeverityReason.trim()}`)
    lines.push('')
  }
  // The fix link is a TRIAGE annotation (the wrench dialog writes it
  // into the finding's triage entry, alongside the comment read above)
  // — findings themselves carry no `fix` field, so reading one off `f`
  // exported nothing, ever.
  if (fix) {
    lines.push(`**Fix:** ${fix.trim()}`)
    lines.push('')
  }
  if (comment) {
    lines.push(`**Comment:** ${comment.trim()}`)
    lines.push('')
  }

  return lines.join('\n')
}

// Groups of a report visible under the current view: the active
// triage bucket (live = null / a trash bucket) narrowed by the
// toolbar filters. Mirrors render.js's on-screen set — bucket split
// (`commonTriage === state.shownTriage`) then `applyFilters`, which
// keeps a dedup group when ANY of its tabs matches (group-level
// visibility, same as the table / list / grouped views). This is the
// same set the print/PDF path captures off the rendered DOM.
function visibleGroups(report) {
  const inBucket = (report.groups ?? []).filter(
    (g) => groupState(g).commonTriage === state.shownTriage,
  )
  return applyFilters(inBucket)
}

// One report → markdown. `groups` is the pre-filtered visible set
// (see visibleGroups); findings are flattened from it (a group is a
// list of cases for the same finding, see ingest / group.js) so each
// case is its own subsection, matching the list/grouped views. Sorted
// by severity descending so the doc opens with the most urgent
// findings.
function reportToMarkdown(report, groups) {
  const findings = groups.flat()
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
    const sev = effectiveSeverity(f) ?? 'informational'
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
  // Reports with nothing left after filtering are dropped entirely
  // (no empty "Findings: 0" section), matching the PDF, which prints
  // no page for a report whose findings are all filtered out.
  const sections = []
  for (const report of reports) {
    const groups = visibleGroups(report)
    if (groups.length === 0) continue
    sections.push(reportToMarkdown(report, groups))
  }
  return sections.join('\n---\n\n')
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
