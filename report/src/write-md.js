// The findings document — what the "Download" button writes: one
// markdown file a person can read top to bottom or jump around in.
//
// The shape, top to bottom:
//
//   <!-- DeepView findings export -->
//   # <title>
//   - **Source:** … / **Report:** … / **Repository:** … / **Analyzer:** …
//   - **Exported:** … / **View:** … / **Filters:** … / **Included:** N of M findings
//
//   ## Summary
//   <severity counts>  <annotation counts>  <index of findings, linked>
//
//   ## Critical (2)
//   ### 1. <finding>              ← write-md-finding.js from here down
//   - **Location:** …             the facts
//   <description>  #### Evidence  #### Impact  …
//
// The header is the honest part. An export is a SELECTION — the triage
// view narrowed by the toolbar filters — and a reader who wasn't at the
// screen has to be told that a file of 12 findings is 12 of 40, and
// which 28 are missing and why. So the filters ride in the header, in
// the confirmation dialog's own words and counts.
//
// The document is also a report this library READS
// (parse-deepview-md.js): the first line marks it, every finding carries
// its id, and what the facts and sections say is what comes back,
// whichever format the findings first arrived in. So a value goes on the
// page in a shape the reader can take back off it — a fact on one line,
// a location in a code span, a line of prose that would read as a
// heading escaped.
//
// `doc` is plain data the caller assembles (ui/view/markdown-export.js,
// or anything else holding findings out of index.js); `hooks` are the
// few answers only the caller has — where a location links, what a
// reader wrote on a finding, which report a case came from. All
// optional: the defaults link what the report linked and annotate
// nothing.
//
//   writeMarkdown({
//     title, workspace, reports: [{ name, source }], repo, generatedAt,
//     view: { bucket, severityMode, revalidation, revalidationDetail },
//     filters: [{ label, value }], counts: { included, total },
//     groups: [ [finding, …], … ],       // display order, primary case first
//   }, { annotation, location, evidence, commit, report })

import { SEVERITIES, displayedSeverity, locationLabel } from './finding.js'
import { SOURCE_LABELS, severityLabel } from './labels.js'
import { analyzerText, findingHeading, groupSection, repoRef } from './write-md-finding.js'
import { anchorSlug, cell, code, escapeBrackets, formatTimestamp, heading, joinBlocks, link, plural, table } from './md-text.js'

// The first line of every document this writes, and what its reader keys
// on: an HTML comment, invisible rendered, and no other format begins
// with one. The reader matches the phrase and reads past what follows,
// so a later document that must be told apart can say so after a comma.
export const DOCUMENT_MARKER = '<!-- DeepView findings export -->'

// What a caller can answer about a finding, and what is assumed when
// it doesn't: a report's own link for a location or an evidence row
// still links, nothing else does, and nothing is annotated.
const DEFAULT_HOOKS = {
  annotation: () => null,
  location: (f) => (typeof f?.location === 'string' ? f.location : null),
  evidence: (row) => (typeof row?.url === 'string' ? row.url : null),
  commit: () => null,
  report: () => null,
}

function withDefaults(hooks) {
  const out = {}
  for (const [name, fallback] of Object.entries(DEFAULT_HOOKS)) {
    out[name] = typeof hooks?.[name] === 'function' ? hooks[name] : fallback
  }
  return out
}

// Which producer a finding came from — a `source` marker, null for the
// analyzer's own dump. Its own when it carries one: a re-imported
// document that mixed products stamps each product's findings, and a
// finding stays that product's whatever report it now sits in.
// Otherwise its report's, found by the `report` hook's name in
// `doc.reports` when the document holds more than one.
function sourceReader(reports, hooks) {
  const own = (f) => (typeof f?.source === 'string' && f.source ? f.source : null)
  if (reports.length === 1) return (f) => own(f) ?? reports[0].source ?? null
  const byName = new Map(reports.map((r) => [r.name, r.source ?? null]))
  return (f) => own(f) ?? byName.get(hooks.report(f)) ?? null
}

// The per-document decisions, made once: the severity lens, whether the
// revalidation layer is applied, and whether the per-finding analyzer
// and report lines say anything — written only where they vary, so a
// single-run report isn't told forty times which run it was.
function buildContext(doc, hooks, cases) {
  const revalidation = doc.view?.revalidation !== false
  const reports = (Array.isArray(doc.reports) ? doc.reports : []).filter((r) => r && typeof r === 'object')
  const sourceOf = sourceReader(reports, hooks)
  const analyzerOf = (f) => analyzerText(f, sourceOf(f), revalidation)
  const analyzers = new Set(cases.map(analyzerOf))
  const names = new Set(cases.map((f) => hooks.report(f)).filter(Boolean))
  return {
    hooks,
    analyzerOf,
    severityMode: doc.view?.severityMode === 'original' ? 'original' : 'corrected',
    revalidation,
    showAnalyzer: analyzers.size > 1,
    showReport: names.size > 1 || reports.length > 1,
    repo: typeof doc.repo === 'string' && doc.repo ? doc.repo : null,
  }
}

// The view the selection was made in, as one line: which triage
// bucket, which severity lens (when the set carries corrections), and
// whether the revalidation pass is applied (when it carries one).
function viewText(view) {
  if (!view) return ''
  const parts = [view.bucket ? `${view.bucket} findings` : 'Live findings']
  if (view.severityMode === 'original') parts.push('original analyzer severities')
  else if (view.severityMode === 'corrected') parts.push('corrected severities')
  if (view.revalidation === false) parts.push('code view — the revalidation pass is not applied')
  else if (view.revalidation === true) {
    // Which app view: the verdict standing in for the rows it re-rated
    // (the default on screen, folded here as there), or the detailed one
    // that lists them. A caller that doesn't track the detail says the
    // layer is applied and no more.
    if (view.revalidationDetail === true) parts.push('detailed app view — the revalidation pass is applied, with the rows it re-rated')
    else if (view.revalidationDetail === false) parts.push('app view — the revalidation pass is applied, standing in for the rows it re-rated')
    else parts.push('app view — the revalidation pass is applied')
  }
  return parts.join(' · ')
}

function includedText(counts) {
  if (!counts) return ''
  const included = Number(counts.included) || 0
  const total = Number(counts.total) || 0
  if (total === 0) return 'no findings'
  if (included >= total) return `all ${plural(total, 'finding')}`
  return `${included} of ${plural(total, 'finding')} (${total - included} filtered out)`
}

// The header list: what was exported, from where, when, and under which
// view and filters. Each line is written only when it has something to
// say, and the filter line says "none" outright, so its absence never
// has to be interpreted.
//
// `Source` names the products the loaded reports came from, `Analyzer`
// what produced the included findings. For one product they are the same
// word and the analyzer line is left out — but only when it would say
// exactly what Source says, the same products and no fewer: two products
// filtered down to one name the one, and a document holding the
// analyzer's own runs lists every analyzer. The reader takes a single
// analyzer named here as every finding's.
function headerList(doc, ctx, cases) {
  const rows = []
  const add = (label, value) => { if (value) rows.push(`- **${label}:** ${value}`) }
  const reports = Array.isArray(doc.reports) ? doc.reports : []
  const sources = [...new Set(reports.map((r) => SOURCE_LABELS[r?.source] ?? '').filter(Boolean))]
  add('Source', sources.join(', '))
  const names = reports.map((r) => r?.name).filter(Boolean)
  add(names.length === 1 ? 'Report' : 'Reports', names.map((n) => code(n)).join(', '))
  add('Workspace', typeof doc.workspace === 'string' ? doc.workspace.trim() : '')
  if (ctx.repo) add('Repository', repoRef(ctx.repo))
  const analyzers = [...new Set(cases.map(ctx.analyzerOf).filter(Boolean))]
  const saidAlready = analyzers.length === sources.length && analyzers.every((a) => sources.includes(a))
  if (analyzers.length > 0 && !saidAlready) add(analyzers.length === 1 ? 'Analyzer' : 'Analyzers', analyzers.join('; '))
  if (doc.generatedAt) add('Exported', formatTimestamp(doc.generatedAt))
  add('View', viewText(doc.view))
  if (Array.isArray(doc.filters)) {
    add('Filters', doc.filters.length > 0 ? doc.filters.map((f) => `${f.label}: ${f.value}`).join(' · ') : 'none')
  }
  add('Included', includedText(doc.counts))
  return rows.join('\n')
}

// The groups bucketed by the severity their primary case displays under,
// in ladder order — an unknown tier last, as the report spelt it —
// numbered through the document, each with its heading and anchor.
function documentEntries(groups, ctx) {
  const buckets = new Map()
  for (const g of groups) {
    const severity = displayedSeverity(g[0], ctx.severityMode) ?? 'informational'
    if (!buckets.has(severity)) buckets.set(severity, [])
    buckets.get(severity).push(g)
  }
  const order = [...SEVERITIES, ...[...buckets.keys()].filter((s) => !SEVERITIES.includes(s))]
  const taken = new Set()
  const entries = []
  for (const severity of order) {
    for (const group of buckets.get(severity) ?? []) {
      const number = entries.length + 1
      const title = findingHeading(group[0])
      const headingText = `${number}. ${title}`
      entries.push({ group, number, severity, title, headingText, slug: anchorSlug(headingText, taken) })
    }
  }
  return entries
}

// Findings per tier, in entry order — which is ladder order, since the
// entries were bucketed that way.
function severityCounts(entries) {
  const counts = new Map()
  for (const e of entries) counts.set(e.severity, (counts.get(e.severity) ?? 0) + 1)
  return counts
}

function annotationSummary(entries, ctx) {
  const tally = { flagged: 0, marked: 0, commented: 0, fixed: 0 }
  for (const { group } of entries) {
    for (const f of group) {
      const a = ctx.hooks.annotation(f)
      if (!a) continue
      if (a.flagged === true) tally.flagged++
      if (a.color) tally.marked++
      if (a.comment) tally.commented++
      if (a.fix) tally.fixed++
    }
  }
  const parts = []
  if (tally.flagged) parts.push(`${tally.flagged} flagged`)
  if (tally.marked) parts.push(`${tally.marked} colour-marked`)
  if (tally.commented) parts.push(`${tally.commented} commented`)
  if (tally.fixed) parts.push(`${tally.fixed} with a fix link`)
  return parts.length > 0 ? `Annotations: ${parts.join(', ')}.` : ''
}

// One row per finding, linked to its section, so a reader sees the whole
// report on one screen and can jump. The confidence column appears only
// when something has a confidence.
function indexTable(entries) {
  const withConfidence = entries.some(({ group }) => group.some((f) => f.confidence !== undefined && f.confidence !== null))
  const headers = ['#', 'Severity', 'Finding', 'Location']
  if (withConfidence) headers.push('Confidence')
  const rows = entries.map((e) => {
    const primary = e.group[0]
    const cases = e.group.length > 1 ? ` (${plural(e.group.length, 'case')})` : ''
    const loc = locationLabel(primary)
    const row = [String(e.number), severityLabel(e.severity), link(cell(escapeBrackets(e.title)), `#${e.slug}`) + cases, loc ? cell(code(loc)) : '']
    if (withConfidence) row.push(primary.confidence === undefined || primary.confidence === null ? '' : `${primary.confidence}/10`)
    return row
  })
  return table(headers, rows, ['right'])
}

function summaryBlocks(entries, ctx) {
  const blocks = [heading(2, 'Summary')]
  if (entries.length === 0) return [...blocks, 'No findings are included.']
  const rows = [...severityCounts(entries)].map(([s, n]) => [severityLabel(s), String(n)])
  rows.push(['**Total**', `**${entries.length}**`])
  blocks.push(table(['Severity', 'Findings'], rows, ['left', 'right']))
  const notes = annotationSummary(entries, ctx)
  if (notes) blocks.push(notes)
  blocks.push(indexTable(entries))
  return blocks
}

// One `## <Severity> (n)` section per tier present, the findings under
// it in the order they arrived — the caller's sort.
function severitySections(entries, ctx) {
  const counts = severityCounts(entries)
  const blocks = []
  let current = null
  for (const e of entries) {
    if (e.severity !== current) {
      current = e.severity
      blocks.push(heading(2, `${severityLabel(current)} (${counts.get(current)})`))
    }
    blocks.push(groupSection(e.group, ctx, { headingText: e.headingText, depth: 3 }))
  }
  return blocks
}

export function writeMarkdown(doc = {}, hooks = {}) {
  const h = withDefaults(hooks)
  const groups = (Array.isArray(doc.groups) ? doc.groups : [])
    .map((g) => (Array.isArray(g) ? g : [g]))
    .map((g) => g.filter((f) => f && typeof f === 'object'))
    .filter((g) => g.length > 0)
  const cases = groups.flat()
  const ctx = buildContext(doc, h, cases)
  const entries = documentEntries(groups, ctx)
  const blocks = [
    DOCUMENT_MARKER,
    heading(1, typeof doc.title === 'string' && doc.title.trim() ? doc.title.trim() : 'Findings'),
    headerList(doc, ctx, cases),
    ...summaryBlocks(entries, ctx),
    ...severitySections(entries, ctx),
  ]
  return `${joinBlocks(blocks)}\n`
}
