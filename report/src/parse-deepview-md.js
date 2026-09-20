// The reader for the document this library's own writer produces
// (write-md.js, what the viewer's Download button saves). An export
// reads back in through the same door as every other format, each
// finding with the id it had — so its triage still applies — and with
// its facts in the fields the parser that first read it used: a Claude
// Security finding comes back as one, a native dump's with its run.
//
// The document (write-md.js for the whole shape):
//
//   <!-- DeepView findings export -->               ← the guard
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
// Out comes the JSON shape the rest of the chain emits:
//
//   { type, source?, model?, effort?, exportsMode?, repo?, findings }
//
// with `groups` in place of `findings` when an entry has several cases —
// a pre-deduplicated dump's shape. The producer and the run travel as a
// native dump carries them: report-level where every finding shares
// them, per finding where they vary. A document mixing products with the
// analyzer's own runs stamps `source` on each product's findings, which
// the viewer reads as that finding's analyzer.
//
// Not read back: what the reader wrote on a finding (Triage, Fix,
// Comment), which lives in the viewer's triage store and follows the id;
// and the header's account of the export (view, filters, counts), since
// the findings on the page ARE the selection. Prose comes back with the
// writer's heading escape off (md-text.js unescapeHeadings).
//
// The marker line is the whole guard: without it the text is not this
// document and returns null, so the chain moves on. The guard reads the
// phrase and not what follows, so a later document that says more there
// is still recognised and read as well as this reader can. A document
// holding NO finding is still the report its header describes — an
// export is a SELECTION and a selection can be empty, which the header
// says outright ("Included: no findings") — so an empty export of a
// Claude Security report reads back as
// `{ type: 'security', source: 'claude-security', findings: [] }`
// rather than as a file no format recognises.

import { locationLabel } from './finding.js'
import { H2_RE, H3_RE, H4_RE, normalizeNewlines, splitByHeading, splitLeading } from './md-structure.js'
import { applyFact, buildDescription, narrativeSplit, readAnalyzer, readEvidence, readProse, readRepository, splitFacts, splitSections, tierOf } from './parse-deepview-fields.js'

const MARKER_RE = /^<!--\s*DeepView findings export\b[^>]*-->/u
const CASE_RE = /^Case \d+ of \d+(?:\s|$)/u
const HEADER_FACT_RE = /^- \*\*([^*\n]+?):\*\* ?(.*)$/gmu

// The sections under a case that are not the description's own nor a
// narrative field: the evidence rows, the correction's reason, and the
// reader's comment.
const OWN_SECTIONS = new Set(['evidence', 'severity correction', 'comment'])

export function parseDeepviewMarkdown(content) {
  const text = normalizeNewlines(content).trim()
  if (!MARKER_RE.test(text)) return null
  const { head, subs } = splitLeading(text, H2_RE)
  const entries = []
  for (const { heading, body } of subs) {
    if (heading.trim().toLowerCase() === 'summary') continue
    const tier = sectionTier(heading)
    for (const block of splitByHeading(body, H3_RE)) entries.push(readEntry(block, tier))
  }
  return assemble(readHeader(head), entries)
}

// `High (2)` → 'high'. A section named after no tier passes its name
// through as printed; the fact line under each finding is authoritative.
function sectionTier(heading) {
  const m = /^(.*?)\s*\(\d+\)\s*$/u.exec(heading.trim())
  return tierOf(m ? m[1] : heading)
}

// The header list: the products the reports came from, the analyzers
// named, the repository. The rest describes the export, not the findings.
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
function readEntry({ heading, body }, tier) {
  const title = heading.trim().replace(/^\d+\.\s+/u, '')
  const cases = splitLeading(body, H4_RE).subs.filter((s) => CASE_RE.test(s.heading.trim()))
  if (cases.length === 0) return [readCase(body, 4, title, tier)]
  return cases.map((s) => readCase(s.body, 5, title, tier))
}

// One case's text into a finding: the facts, the description its lead
// and sections add up to, the evidence, the narrative fields. The
// Analyzer fact rides beside it for `assemble` to settle report-level.
function readCase(body, depth, entryTitle, tier) {
  const { title, facts, rest } = splitFacts(body)
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
    .map((s) => ({ label: s.label, body: readProse(s.body) }))
  const { paragraphs, fields } = narrativeSplit(own)
  f.description = buildDescription(named ? name : '', readProse(lead), paragraphs)
  const evidence = sections.filter((s) => s.label.toLowerCase() === 'evidence').flatMap((s) => readEvidence(s.body))
  if (evidence.length > 0) f.evidence = evidence
  for (const [field, value] of fields) f[field] = value
  const reason = sections.find((s) => s.label.toLowerCase() === 'severity correction')
  if (reason?.body) f.correctedSeverityReason = readProse(reason.body)
  return { finding: f, analyzer }
}

// The producer and the run for the whole report: from the Analyzer facts
// where the writer named one per finding — a product every case shares
// goes report-level, a run to its finding, a product only some cases
// came from to those cases — else from the header's one analyzer or its
// Source line. The pass marker is per-finding, never report-level.
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

// The report: what the header and findings agree on at the top, then the
// findings, grouped only where an entry had cases.
function assemble(header, entries) {
  const cases = entries.flat()
  const { source, run } = settleAnalyzers(header, cases)
  const data = {}
  // The report's `type` is the run's — or, where each finding names its
  // own, the one mode they all ran in, as a deduplicated dump keeps the
  // mode in its header while its findings carry their models. A
  // product's report is a security report, as its own parser says.
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
