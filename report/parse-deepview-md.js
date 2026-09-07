// DeepView markdown findings parser — the reader for the document the
// library's own writer produces (write-md.js: the file the viewer's
// Download button saves). A report exported from the viewer reads back
// in through the same door as every other format (index.js), each
// finding with the id it had — so the triage keyed off it still
// applies — and with its facts in the fields the parser that first read
// it used, whichever format that was: a Claude Security finding comes
// back as one, a DeepSec finding as one, a native dump's finding with
// its run.
//
// The document (write-md.js for the whole shape):
//
//   <!-- DeepView findings export, format 2 -->     ← the guard
//   # <title>
//   - **Source:** Claude Security                     the header list
//   - **Repository:** [o/r](…) / **Analyzer:** …
//   ## Summary                                        tables — skipped
//   ## High (2)                                       a tier's section
//   ### 1. <finding>                                  an entry
//   - **Location:** … / **Severity:** … / **ID:** …   the facts
//   <description>                                     the lead
//   #### Evidence / #### Impact / …                   the sections
//
// and a finding reported several times is an entry of cases:
//
//   ### 2. <finding>
//   2 cases of this finding — reported in `a.json`, `b.json`.
//   #### Case 1 of 2 — `src/a.js:7`
//   - **Location:** … / ##### Impact …
//
// What comes back is the JSON shape the rest of the chain emits:
//
//   { type, source?, model?, effort?, exportsMode?, repo?, findings }
//
// or `groups` in place of `findings` when an entry has several cases
// (a pre-deduplicated dump's shape, index.js entriesOf). The producer
// and the run travel the way a native dump carries them: report-level
// when every finding shares them — `source`, or the `type` / `model` /
// `effort` / `exportsMode` ingest hands down to each finding (meta.js
// inheritReportMeta) — and per finding when they vary. A document that
// mixes products with the analyzer's own runs stamps `source` on each
// finding of a product, which the viewer reads as that finding's
// analyzer.
//
// Not read back: what the reader wrote on a finding (Triage, Fix, the
// Comment section) — annotations live in the viewer's triage store,
// keyed by the id, and follow the id — and the header's own account of
// the export (the view, the filters, the counts): the findings on the
// page ARE the selection. Returns null for any text without the marker
// line, so the chain moves on; the guard reads the phrase and not the
// format number, so a later format is still recognised as this
// library's, and read as well as this reader can. The number decides
// what the reader may take off the prose: from format 2 the writer
// escapes a line of prose that would read as a heading (md-text.js
// prose), and only there is the escape stripped — a format 1 document
// wrote its prose bare, and a `\#` opening a line of it is the
// analyzer's own.

import { locationLabel } from './finding.js'
import { splitByHeading, splitLeading } from './md-structure.js'
import { applyFact, buildDescription, narrativeSplit, readAnalyzer, readEvidence, readProse, readRepository, splitFacts, splitSections, tierOf } from './parse-deepview-fields.js'

const MARKER_RE = /^<!--\s*DeepView findings export\b([^>]*)-->/u
const H2_RE = /^## +(.*)$/gmu
const H3_RE = /^### +(.*)$/gmu
const H4_RE = /^#### +(.*)$/gmu
const CASE_RE = /^Case \d+ of \d+(?:\s|$)/u
const HEADER_FACT_RE = /^- \*\*([^*\n]+?):\*\* ?(.*)$/gmu

// The sections under a case that are not the description's own nor a
// narrative field: the evidence rows, the correction's reason, and the
// reader's comment.
const OWN_SECTIONS = new Set(['evidence', 'severity correction', 'comment'])

export function parseDeepviewMarkdown(content) {
  const text = content.replaceAll(/\r\n?/gu, '\n').trim()
  const marker = MARKER_RE.exec(text)
  if (!marker) return null
  // The format number, 1 when the marker names none; whether the prose
  // carries the writer's heading escape — format 2 on.
  const escaped = (Number(/format\s*(\d+)/u.exec(marker[1])?.[1]) || 1) >= 2
  const { head, subs } = splitLeading(text, H2_RE)
  const entries = []
  for (const { heading, body } of subs) {
    if (heading.trim().toLowerCase() === 'summary') continue
    const tier = sectionTier(heading)
    for (const block of splitByHeading(body, H3_RE)) entries.push(readEntry(block, tier, escaped))
  }
  if (entries.length === 0) return null
  return assemble(readHeader(head), entries)
}

// `High (2)` → 'high'. A section named after no tier gives its findings
// the name as printed — the fact line under each finding is the
// authoritative severity anyway.
function sectionTier(heading) {
  const m = /^(.*?)\s*\(\d+\)\s*$/u.exec(heading.trim())
  return tierOf(m ? m[1] : heading)
}

// The header list: the products the reports came from, the analyzers
// named for the findings, the document's repository. The rest of it —
// report names, the export time, the view, the filters, the counts —
// describes the export, not the findings.
function readHeader(head) {
  const facts = new Map()
  for (const m of head.matchAll(HEADER_FACT_RE)) {
    const key = m[1].trim().toLowerCase()
    if (!facts.has(key)) facts.set(key, m[2].trim())
  }
  return {
    sources: (facts.get('source') ?? '').split(',').map((s) => readAnalyzer(s).source).filter(Boolean),
    analyzers: (facts.get('analyzer') ?? facts.get('analyzers') ?? '').split(';').map((s) => s.trim()).filter(Boolean),
    repo: facts.has('repository') ? readRepository(facts.get('repository')) : '',
  }
}

// One `### N. <finding>` block: a finding, or one with a case per
// `#### Case i of n` under it.
function readEntry({ heading, body }, tier, escaped) {
  const title = heading.trim().replace(/^\d+\.\s+/u, '')
  const cases = splitLeading(body, H4_RE).subs.filter((s) => CASE_RE.test(s.heading.trim()))
  if (cases.length === 0) return [readCase(body, 4, title, tier, escaped)]
  return cases.map((s) => readCase(s.body, 5, title, tier, escaped))
}

// One case's text into a finding: the facts, the description the lead
// and the description's own sections add up to, the evidence, the
// narrative fields. What the Analyzer fact said rides beside the
// finding for `assemble` to settle at the report level.
function readCase(body, depth, entryTitle, tier, escaped) {
  const { title, facts, rest } = splitFacts(body, escaped)
  const { lead, sections } = splitSections(rest, depth)
  const f = { file: 'unknown', line: '?' }
  let analyzer = null
  for (const [label, value] of facts) {
    if (label.trim().toLowerCase() === 'analyzer') analyzer = readAnalyzer(value)
    else applyFact(f, label, value)
  }
  if (!f.severity) f.severity = tier || 'medium'
  // A finding the writer could only head by its location, or by nothing
  // at all, had no name; its description is what the lead says.
  const name = title || entryTitle
  const named = name !== 'Untitled finding' && name !== locationLabel(f)
  const own = sections.filter((s) => !OWN_SECTIONS.has(s.label.toLowerCase()))
    .map((s) => ({ label: s.label, body: readProse(s.body, escaped) }))
  const { paragraphs, fields } = narrativeSplit(own)
  f.description = buildDescription(named ? name : '', readProse(lead, escaped), paragraphs)
  const evidence = sections.filter((s) => s.label.toLowerCase() === 'evidence').flatMap((s) => readEvidence(s.body, escaped))
  if (evidence.length > 0) f.evidence = evidence
  for (const [field, value] of fields) f[field] = value
  const reason = sections.find((s) => s.label.toLowerCase() === 'severity correction')
  if (reason?.body) f.correctedSeverityReason = readProse(reason.body, escaped)
  return { finding: f, analyzer }
}

// The producer and the run for the whole report, from the Analyzer
// facts when the writer had to name one on each finding — a product
// every case shares goes to the report level, each run to its finding,
// and a product some cases came from to those cases — and otherwise
// from the header: the one analyzer named there, or the one product the
// Source line names. The run's pass marker is a per-finding fact and
// not a report-level one.
function settleAnalyzers(header, cases) {
  const out = { source: null, run: {} }
  if (cases.some((c) => c.analyzer !== null)) {
    const sources = new Set(cases.map((c) => c.analyzer?.source ?? null))
    if (sources.size === 1 && !sources.has(null)) [out.source] = sources
    for (const c of cases) {
      if (c.analyzer?.run) Object.assign(c.finding, c.analyzer.run)
      else if (c.analyzer?.source && !out.source) c.finding.source = c.analyzer.source
    }
    return out
  }
  const one = header.analyzers.length === 1 ? readAnalyzer(header.analyzers[0]) : null
  if (one?.source) out.source = one.source
  else if (one?.run) out.run = one.run
  else if (header.analyzers.length === 0 && header.sources.length === 1) [out.source] = header.sources
  return out
}

// The report: what the header and the findings agree on at the top,
// and the findings — grouped only where an entry had cases.
function assemble(header, entries) {
  const cases = entries.flat()
  const { source, run } = settleAnalyzers(header, cases)
  const data = {}
  // The report's `type` is the run's — or, when each finding names its
  // own run, the one mode they all ran in, the way a deduplicated dump
  // keeps the mode in its header while its findings carry their models.
  // A product's report is a security report, as its own parser says.
  const modes = new Set(cases.map((c) => c.finding.type).filter(Boolean))
  const type = run.type ?? (modes.size === 1 ? [...modes][0] : null) ?? (source ? 'security' : null)
  if (type) data.type = type
  if (source) data.source = source
  for (const key of ['model', 'effort', 'exportsMode']) if (run[key]) data[key] = run[key]
  if (header.repo) data.repo = { github: header.repo }
  const groups = entries.map((entry) => entry.map((c) => c.finding))
  if (groups.every((g) => g.length === 1)) data.findings = groups.flat()
  else data.groups = groups
  return data
}
