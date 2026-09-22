// Claude Security's markdown findings — a secondary input format,
// supported but deliberately not advertised in the README. Returns what
// ingest.js expects from JSON, `{ type, source, findings }`, or null when
// the text isn't this format, so the caller can surface the JSON parse
// failure instead.
//
// One finding (several are separated by a `---` line):
//
//   # <Title>
//
//   ## Details
//   ## Evidence
//   1. [<name>](<url>)
//      <Description>
//   ## Impact
//   ## Reproduction steps
//   ## Recommended fix
//
//   ---
//   **Severity:** <critical|high|medium|low>
//   **Status:** Open
//   **Category:** <category>
//   **Repository:** <owner/repo>
//   **Branch:** <branch>
//   **Date created:** <YYYY-MM-DD>
//
// A report cites its site as a one-line `## Location` or as an
// `## Evidence` list; both are read, `## Location` winning. Every
// `## …` section is optional — only the title and the metadata block
// carry anything mandatory.

import { frozenIdBasis } from './parse-md-id.js'
import { LIST_MARKER_RE, findMdLink, normalizeNewlines, splitHeadingLine, unescapeMd } from './md-structure.js'

const VALID_SEVERITIES = new Set(['critical', 'high', 'medium', 'low', 'high_bug', 'bug', 'informational'])

export function parseMarkdownFindings(content) {
  const text = normalizeNewlines(content).trim()
  // Format guard: these documents always start with an h1. Anything
  // else returns null, so the caller surfaces the JSON error rather
  // than a misleading markdown one.
  if (!text.startsWith('# ')) return null

  // Each finding starts at a line beginning with `# `; whatever
  // preceded the first one is preamble, and empty chunks drop out.
  const blocks = text.split(/^# /mu).filter((b) => b.trim().length > 0)

  const findings = []
  for (const block of blocks) {
    const f = parseBlock(block)
    if (f) findings.push(f)
  }
  if (findings.length === 0) return null

  // `source` is what the renderer recognises the product by — the page
  // header reads `Claude Security results` — rather than sniffing the
  // extension, which a rename defeats. The report-level `type` is the
  // product's category as for every source-marked producer: this is ONE
  // analyzer, and the per-finding `**Category:**` says what kind of
  // issue a finding is, not which run found it.
  return { type: 'security', source: 'claude-security', findings }
}

function parseBlock(block) {
  const { title, body } = splitHeadingLine(block)
  if (!title) return null

  const { sectionsText, metaText } = splitBody(body)
  const sections = parseSections(sectionsText)
  const meta = parseMeta(metaText)
  const evidence = evidenceRows(sections.evidence || '')
  // `## Location`, else the FIRST `## Evidence` row — the primary site
  // by the format's convention. Every row, this one included, also
  // lands on `finding.evidence` below.
  const { file, line, locationLink } = parseLocation(
    sections.location || evidence[0]?.ref || '',
  )

  // Medium when missing or unrecognized, so an unparsable finding stays
  // visible rather than dropping out silently.
  const sevRaw = (meta.severity || '').toLowerCase()
  const severity = VALID_SEVERITIES.has(sevRaw) ? sevRaw : 'medium'

  const description = buildDescription(title, sections, evidence.length > 0)

  const finding = { file: file || 'unknown', line, severity, description }
  if (locationLink) finding.location = locationLink
  if (evidence.length > 0) finding.evidence = evidence.map(evidenceEntry)
  // Narrative FIELDS, not description — the same two slots a native
  // dump fills, so a report that names them here and one that carries
  // them as fields read alike. The field is also what render-finding.js
  // can collapse into a `<details>`, where a `**Label:**` paragraph in
  // the description is an always-open block. They survive a round trip
  // through this finding's own export, which writes them as sections
  // that parse-deepview-md.js narrativeSplit reads back as fields.
  if (sections['reproduction steps']) {
    finding.reproduction = normalizeStepList(sections['reproduction steps'])
  }
  if (sections['recommended fix']) finding.recommendation = sections['recommended fix']
  if (meta.repository) finding.repo = { github: meta.repository }
  // Auxiliary metadata, kept as plain strings: nothing renders these
  // specifically, but the markdown export prints what a finding carries.
  if (meta.branch) finding.branch = meta.branch
  if (meta['date created']) finding.dateCreated = meta['date created']
  if (meta.status) finding.status = meta.status
  // The issue class the report filed the finding under ("insufficient
  // verification of data authenticity"), as written. NOT the finding's
  // `type`, which is the analyzer run a native dump names — this report
  // has one analyzer, and `source` above says which.
  if (meta.category) finding.category = meta.category
  // The fingerprint is parse-md-id.js's own parse of this same block,
  // not the fields above: those are presentation and free to change, it
  // is not. Nothing this parser resolved is passed in. Read that
  // module's header before touching either side.
  const idBasis = frozenIdBasis(block)
  if (idBasis) finding._idBasis = idBasis

  return finding
}

// The sections half (before the first `---`) and the metadata half
// (from there to the next `---` or the end).
function splitBody(body) {
  const dashRe = /^---\s*$/mu
  const dashMatch = dashRe.exec(body)
  if (!dashMatch) return { sectionsText: body, metaText: '' }
  const sectionsText = body.slice(0, dashMatch.index).trim()
  const rest = body.slice(dashMatch.index + dashMatch[0].length).replace(/^\n/u, '')
  const next = dashRe.exec(rest)
  const metaText = next ? rest.slice(0, next.index) : rest
  return { sectionsText, metaText }
}

// Named sections, split on `## Header`. Whatever precedes the first
// heading is dropped.
function parseSections(sectionsText) {
  const sections = {}
  for (const part of sectionsText.split(/^## /mu).slice(1)) {
    const { title, body } = splitHeadingLine(part)
    const header = title.toLowerCase()
    if (header) sections[header] = body.trim()
  }
  return sections
}

// `**Label:** value` per line, keyed case-folded.
function parseMeta(metaText) {
  const meta = {}
  for (const m of metaText.matchAll(/\*\*([^:]+):\*\*\s*(.+)/gu)) {
    meta[m[1].trim().toLowerCase()] = m[2].trim()
  }
  return meta
}

// One `## Location` line or one `## Evidence` row, a markdown link
// preferred. The line comes from a `#L<n>` anchor in the url, a `:<n>`
// suffix on the name, or nowhere (`?`). A RANGE is kept whole (`10-20`),
// as parse-piolium.js keeps it, with the en / em dashes the Evidence
// template writes normalized to a hyphen.
//
// `locationLink` is the url, or the raw text when there is none:
// finding-id.js keys off it with no fileHash available, so two imports
// of a finding share one uuid and its triage.
function parseLocation(loc) {
  let file = '', line = '?', locationLink = ''
  // Brackets and parens and all: `app/(main)/[id]/page.ts` is an
  // ordinary Next.js path, and a reading that stops at the first `]`
  // finds no link in it — leaving the whole `[…](…)` as the file name,
  // the line `?`, and an evidence row with no url.
  const link = findMdLink(loc)
  if (link) {
    file = link.label.trim()
    locationLink = link.url.trim()
    const lineFromUrl = locationLink.match(/#L(\d+)(?:-L?(\d+))?/u)
    if (lineFromUrl) line = lineFromUrl[2] ? `${lineFromUrl[1]}-${lineFromUrl[2]}` : lineFromUrl[1]
  } else {
    file = loc.trim()
    locationLink = loc.trim()
  }
  // Backticks are notation and a `\_` is the report escaping markdown;
  // the path is the unescaped name, which is what the displays print
  // and what a rebuilt blob URL must address. The url is left exactly
  // as written — reports don't escape there, and it keys the id.
  file = unescapeMd(file.replaceAll('`', '')).trim()
  // A `:42` / `:10–20` suffix: taken only when the anchor gave no line,
  // but shed from the path either way.
  const colonMatch = file.match(/^(.+):(\d+)(?:\s*[-–—]\s*L?(\d+))?$/u)
  if (colonMatch) {
    file = colonMatch[1]
    if (line === '?') line = colonMatch[3] ? `${colonMatch[2]}-${colonMatch[3]}` : colonMatch[2]
  }
  // `linked` says how the row came in, which `locationLink` can't —
  // the fallback puts raw text there, and that is an id discriminator,
  // not an href.
  return { file, line, locationLink, linked: link !== null }
}

// The `## Reproduction steps` section as a reader can follow it. This
// report sometimes writes a whole sequence as ONE list item, in two
// shapes, and neither reads as a list:
//
//   * a RUN-IN enumeration — `1. 1) Save 2) Restart 3) Watch`, which
//     markdown reads as one step whose text holds all the others —
//     becomes a line per step;
//   * a list of ONE step stops being a list, its marker numbering the
//     single thing the section says.
//
// The steps keep the numbers the report gave them, gaps and all: this
// text is printed as written, so a `6)` behind a `4)` is the report's
// own count rather than something to renumber.
//
// Only a section that IS one item is touched — no other line may open a
// list of its own — and the run-in reading is tried behind the outer
// marker (`1. 1) …`) and at the line's own start (`1) … 2) …`), since
// either can carry the enumeration. The id comes from the RAW block
// (parse-md-id.js), so reading the section better moves nothing.
function normalizeStepList(text) {
  const lines = text.split('\n')
  const at = lines.findIndex((line) => line.trim())
  if (at === -1 || !LIST_MARKER_RE.test(lines[at])) return text
  if (lines.some((line, i) => i !== at && LIST_MARKER_RE.test(line))) return text
  const item = lines[at].replace(/^ */u, '')
  const body = item.replace(LIST_MARKER_RE, '')
  if (!body.trim()) return text
  const steps = runInSteps(body) ?? runInSteps(item)
  // An enumeration neither reading could take apart stays as it
  // arrived. Both halves matter: a BODY opening on a marker is the
  // sequence behind an outer one (`1. 3) Later 2) Earlier`), and
  // unwrapping would leave that marker leading the section; an ITEM
  // opening on one is the sequence itself (`3) Later 2) Earlier`),
  // where the marker shed as the item's own is a step number, and
  // unwrapping would drop it and leave the rest of the count behind.
  if (steps === null && (LIST_MARKER_RE.test(body) || RUN_IN_HEAD_RE.test(item))) return text
  const read = steps === null ? [body]
    : steps.length === 1 ? [steps[0].step]
      : steps.map(({ number, step }) => `${number}. ${step}`)
  lines.splice(at, 1, ...read)
  return lines.join('\n')
}

// `1) Save 2) Restart` → a step per marker, or null when the text is no
// run-in list: the first marker has to open it and the numbers have to
// ascend, or a step that merely cites `RFC 2616) …` would split the
// prose around it. A number in parens — `curl(1)`, `(2) results` — is
// not a marker, and a marker with NOTHING behind it — a truncated
// `1) Save 2)` — is a sequence this can't read, not a step of its own.
const RUN_IN_STEP_RE = /(?:^|[ \t])(\d{1,9})\)(?=[ \t]|$)/gu
// The same marker, asked of a text's own start.
const RUN_IN_HEAD_RE = /^\d{1,9}\)(?=[ \t]|$)/u

function runInSteps(text) {
  const marks = [...text.matchAll(RUN_IN_STEP_RE)]
  if (marks.length === 0 || marks[0].index !== 0) return null
  const steps = []
  for (const [i, mark] of marks.entries()) {
    const number = Number(mark[1])
    if (i > 0 && number <= steps[i - 1].number) return null
    const step = text.slice(mark.index + mark[0].length, marks[i + 1]?.index).trim()
    if (!step) return null
    steps.push({ number, step })
  }
  return steps
}

// Rows of an `## Evidence` section, in document order:
//
//   1. [libs/a.ts:10–20](https://github.com/o/r/blob/<sha>/libs/a.ts#L10-L20)
//      Why this line matters.
//
// Only a marker line is a reference — numbered or bulleted — and the
// prose under it is that row's note, left-trimmed, since the renderer
// indents the row itself.
//
// A section with no markers still yields one row when it is a single
// line, or around the first line carrying a link. Free prose yields
// none, and parseBlock leaves it in the description rather than
// promoting a sentence to a path.
const EVIDENCE_ITEM_RE = /^[ \t]*(?:\d+[.)]|[-*+])\s+/u

function evidenceRows(text) {
  const rows = []
  for (const line of text.split('\n')) {
    if (EVIDENCE_ITEM_RE.test(line)) rows.push({ ref: line.replace(EVIDENCE_ITEM_RE, '').trim(), note: [] })
    else if (rows.length > 0 && line.trim()) rows.at(-1).note.push(line.trim())
  }
  if (rows.length === 0) {
    const bare = text.split('\n').map((l) => l.trim()).filter(Boolean)
    const at = bare.findIndex((l) => findMdLink(l) !== null)
    if (at === -1 && bare.length !== 1) return []
    const refAt = at === -1 ? 0 : at
    rows.push({ ref: bare[refAt], note: bare.filter((_, i) => i !== refAt) })
  }
  return rows.filter((r) => r.ref)
}

// One row as it lands on the finding. `url` only where the row carried
// a real link — the raw-text fallback is an id discriminator, not an
// href to hand a renderer.
function evidenceEntry({ ref, note }) {
  const { file, line, locationLink, linked } = parseLocation(ref)
  const entry = { file: file || 'unknown', line }
  if (locationLink && linked) entry.url = locationLink
  const text = note.join('\n')
  if (text) entry.text = text
  return entry
}

// Title + body sections, section labels emitted as `**Label:**` — the
// shape parse-piolium gives its fields, which render-finding.js turns
// into real `<strong>` emphasis and the markdown export re-emits as the
// markdown it is. Everything else survives verbatim, `pre-wrap` on
// `.desc` keeping the shape the report wrote.
function buildDescription(title, sections, hasEvidenceRows) {
  const bodyParts = [title]
  if (sections.details) bodyParts.push(sections.details)
  // An Evidence section that parsed into rows lives on
  // `finding.evidence`, and repeating it here would double it. One that
  // parsed into none is free prose, and stays rather than being lost.
  if (sections.evidence && !hasEvidenceRows) bodyParts.push(`**Evidence:**\n${sections.evidence}`)
  if (sections.impact) bodyParts.push(`**Impact:** ${sections.impact}`)
  return bodyParts.join('\n\n')
}
