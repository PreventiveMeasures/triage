// Markdown findings parser — secondary input format (intentionally
// undocumented; supported as a convenience but not advertised in the
// README). Returns the same shape `ingest.js` expects from JSON:
//   { type, findings: [{ file, line, severity, description, ... }] }
// or null when the input doesn't look like the markdown format, so
// callers can fall back to a JSON parse failure message.
//
// Format (one finding shown; multiple are separated by a `---` line):
//
//   # <Title>
//
//   ## Details
//   <Details>
//
//   ## Evidence
//   1. [<name>](<url>)
//      <Description>
//   2. [<name>](<url>)
//      <Description>
//
//   ## Impact
//   <Impact>
//
//   ## Reproduction steps
//   <Reproduction>
//
//   ## Recommended fix
//   <Recommendation>
//
//   ---
//   **Severity:** <critical|high|medium|low>
//   **Status:** Open
//   **Category:** <category>
//   **Repository:** <owner/repo>
//   **Branch:** <branch>
//   **Date created:** <YYYY-MM-DD>
//
// Older reports carry a single-line `## Location` ([<name>](<url>))
// where newer ones list every cited site under `## Evidence`; both are
// read, and `## Location` wins when a report somehow carries both.
//
// Every `## …` section is optional (any missing one is just dropped
// from the description); only the title and the metadata block carry
// mandatory information (severity defaults to medium if absent or
// unrecognized).

import { frozenIdBasis } from './parse-md-id.js'

const VALID_SEVERITIES = new Set(['critical', 'high', 'medium', 'low', 'high_bug', 'bug', 'informational'])

export function parseMarkdownFindings(content) {
  const text = content.replaceAll(/\r\n?/gu, '\n').trim()
  // Cheap format guard: real markdown findings always start with an
  // h1. Anything else (random text, an empty file, a JSON-shaped blob
  // that failed to parse) returns null so the caller surfaces the
  // JSON error instead of a misleading markdown error.
  if (!text.startsWith('# ')) return null

  // Each finding starts at a line beginning with `# `. Splitting on
  // that pattern gives us per-finding chunks; the first split element
  // is whatever preamble preceded the first `# ` (usually empty).
  const blocks = text.split(/^# /mu).filter((b) => b.trim().length > 0)

  const findings = []
  for (const block of blocks) {
    const f = parseBlock(block)
    if (f) findings.push(f)
  }
  if (findings.length === 0) return null

  // Top-level analyzer type — used as the fallback `data.type` in
  // ingest for findings that don't carry their own `f.type`. With the
  // per-finding category mapped to `f.type` below, this default only
  // matters when a finding is missing its **Category:** line; pick
  // the first such category that appears so the document title /
  // header keep something meaningful in the common single-category
  // case. 'analysis' matches the JSON path's default.
  const type = findings.find((f) => f.type)?.type || 'analysis'

  // `source` lets the renderer recognize Claude-Security-format
  // reports without re-parsing them — used for the page header
  // title (`Claude Security results` instead of the JSON-style
  // `DeepView results, analyzers: …`). Kept under a marker rather
  // than file-extension sniffing so a renamed `.md` file doesn't
  // change behavior, and so a future MD producer with a different
  // identity could opt into its own label.
  return { type, source: 'claude-security', findings }
}

function parseBlock(block) {
  // First line is the title; the rest is the body (sections + meta).
  const newlineIdx = block.indexOf('\n')
  const title = (newlineIdx === -1 ? block : block.slice(0, newlineIdx)).trim()
  if (!title) return null
  const body = newlineIdx === -1 ? '' : block.slice(newlineIdx + 1)

  const { sectionsText, metaText } = splitBody(body)
  const sections = parseSections(sectionsText)
  const meta = parseMeta(metaText)
  const evidence = evidenceRows(sections.evidence || '')
  // The finding's own location: `## Location` when the report carries
  // one (older format), otherwise the FIRST `## Evidence` row — the
  // primary site, by the convention the newer format follows. Every row
  // (this one included) also lands on `finding.evidence` below, which
  // is what the card renders as a list.
  const { file, line, locationLink } = parseLocation(
    sections.location || evidence[0]?.ref || '',
  )

  // Severity defaults to medium when missing or unrecognized — keeps
  // an unparsable finding visible rather than dropping it silently.
  const sevRaw = (meta.severity || '').toLowerCase()
  const severity = VALID_SEVERITIES.has(sevRaw) ? sevRaw : 'medium'

  const description = buildDescription(title, sections, evidence.length > 0)
  const recommendation = sections['recommended fix'] || undefined

  const finding = { file: file || 'unknown', line, severity, description }
  if (locationLink) finding.location = locationLink
  if (evidence.length > 0) finding.evidence = evidence.map(evidenceEntry)
  if (recommendation) finding.recommendation = recommendation
  if (meta.repository) finding.repo = { github: meta.repository }
  // Preserve auxiliary metadata as plain string fields. The renderer
  // doesn't surface these specifically, but keeping them on the
  // finding means a future view (or a printed export) can pick them up
  // without re-parsing the source.
  if (meta.branch) finding.branch = meta.branch
  if (meta['date created']) finding.dateCreated = meta['date created']
  if (meta.status) finding.status = meta.status
  // Per-finding category lands on `type` to match the JSON shape,
  // where each finding can carry its own analyzer type. Lowercased so
  // the header analyzer-breakdown groups consistently regardless of
  // source casing ("Security" vs "security"). Without this mapping,
  // ingest.js would fall back to data.type for every finding and the
  // run-meta line would show the same category for the whole report.
  if (meta.category) finding.type = meta.category.toLowerCase()
  // The id fingerprint is pinned to the pre-Evidence parse of this same
  // block (parse-md-id.js) rather than to the fields above: the
  // description is presentation and has already been reshaped twice,
  // and every reshape silently re-keys the triage users have stored
  // against these findings. finding-id.js prefers this when deriving
  // the uuid. See that module's header before touching any of it.
  const idBasis = frozenIdBasis(block, { location: locationLink, file: finding.file, line })
  if (idBasis) finding._idBasis = idBasis

  return finding
}

// Split a finding body into its sections half (everything before the
// first `---` separator) and its metadata half (the block between that
// separator and either the next `---` or end of input).
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

// Split sectionsText into named sections by `## Header`. parts[0] is
// whatever preceded the first ## (usually a blank line).
function parseSections(sectionsText) {
  const sections = {}
  const parts = sectionsText.split(/^## /mu)
  for (let i = 1; i < parts.length; i++) {
    const part = parts[i]
    const nl = part.indexOf('\n')
    const header = (nl === -1 ? part : part.slice(0, nl)).trim().toLowerCase()
    const content = (nl === -1 ? '' : part.slice(nl + 1)).trim()
    if (header) sections[header] = content
  }
  return sections
}

// Metadata: each line is `**Label:** value`. Field names are case-
// folded so consumers don't have to mind the source casing.
function parseMeta(metaText) {
  const meta = {}
  for (const m of metaText.matchAll(/\*\*([^:]+):\*\*\s*(.+)/gu)) {
    meta[m[1].trim().toLowerCase()] = m[2].trim()
  }
  return meta
}

// A code reference — one `## Location` line or one `## Evidence` row.
// Prefer a markdown link `[name](url)`. The line can come from a
// `#L<n>` / `#L<n>-L<m>` anchor in the URL, a `:<n>` / `:<n>-<m>`
// suffix on the name, or be absent altogether (rendered as `?`). A
// RANGE is kept whole (`10-20`): the file:line displays print it
// verbatim and the link anchors parseInt() it down to the start line,
// matching how parse-piolium.js carries ranges. En / em dashes (the
// Evidence template writes `10–20`) normalize to a plain hyphen so one
// spelling reaches the displays. The original link (URL when present,
// raw text otherwise) is preserved as `locationLink` — the
// deterministic id derivation in finding-id.js uses it as the
// discriminator when no fileHash is available, so two MD imports of
// the same finding produce the same UUID and dedupe / share triage.
function parseLocation(loc) {
  let file = '', line = '?', locationLink = ''
  const linkMatch = loc.match(/\[([^\]]+)\]\(([^)\s]+)\)/u)
  if (linkMatch) {
    file = linkMatch[1].trim()
    locationLink = linkMatch[2].trim()
    const lineFromUrl = locationLink.match(/#L(\d+)(?:-L?(\d+))?/u)
    if (lineFromUrl) line = lineFromUrl[2] ? `${lineFromUrl[1]}-${lineFromUrl[2]}` : lineFromUrl[1]
  } else {
    file = loc.trim()
    locationLink = loc.trim()
  }
  // Backticks some reports wrap the path in are notation, not part of
  // the path itself.
  file = file.replaceAll('`', '').trim()
  // `:42` / `:10–20` suffix on the file path — common shorthand. Only
  // consume the number if we don't already have one from the anchor;
  // the path always sheds it either way.
  const colonMatch = file.match(/^(.+):(\d+)(?:\s*[-–—]\s*L?(\d+))?$/u)
  if (colonMatch) {
    file = colonMatch[1]
    if (line === '?') line = colonMatch[3] ? `${colonMatch[2]}-${colonMatch[3]}` : colonMatch[2]
  }
  return { file, line, locationLink }
}

// Rows of an `## Evidence` section, in document order. A row leads with
// the code reference and carries its own note on the lines under it:
//
//   1. [libs/a.ts:10–20](https://github.com/o/r/blob/<sha>/libs/a.ts#L10-L20)
//      Why this line matters.
//
// so only an item's marker line is a reference; the prose under it is
// that row's note. Numbered (`1.` / `1)`) and bulleted (`-` / `*` /
// `+`) markers both open a row. Note lines are left-trimmed: the
// renderer indents the row (a real `<ol>`, so a note that wraps stays
// under its reference), and the source's own indentation would only
// double up on that.
//
// A section written without any marker still yields one row when it is
// a single line, or around the first line carrying a markdown link —
// free prose yields no rows at all, and parseBlock leaves it in the
// description as written rather than promoting a sentence to a path.
const EVIDENCE_ITEM_RE = /^[ \t]*(?:\d+[.)]|[-*+])\s+/u
const MD_LINK_RE = /\[[^\]]+\]\([^)\s]+\)/u

function evidenceRows(text) {
  const rows = []
  for (const line of text.split('\n')) {
    if (EVIDENCE_ITEM_RE.test(line)) rows.push({ ref: line.replace(EVIDENCE_ITEM_RE, '').trim(), note: [] })
    else if (rows.length > 0 && line.trim()) rows.at(-1).note.push(line.trim())
  }
  if (rows.length === 0) {
    const bare = text.split('\n').map((l) => l.trim()).filter(Boolean)
    const at = bare.findIndex((l) => MD_LINK_RE.test(l))
    if (at === -1 && bare.length !== 1) return []
    const refAt = at === -1 ? 0 : at
    rows.push({ ref: bare[refAt], note: bare.filter((_, i) => i !== refAt) })
  }
  return rows.filter((r) => r.ref)
}

// One row as it lands on the finding: the parsed reference plus the
// report's note. `url` is set only when the row actually carried a
// markdown link — parseLocation's raw-text fallback is an id
// discriminator, not something to hand a renderer as an href.
function evidenceEntry({ ref, note }) {
  const { file, line, locationLink } = parseLocation(ref)
  const entry = { file: file || 'unknown', line }
  if (locationLink && MD_LINK_RE.test(ref)) entry.url = locationLink
  const text = note.join('\n')
  if (text) entry.text = text
  return entry
}

// Build the description from the title + body sections. Section labels
// are emitted as `**Label:**`, the same shape parse-piolium gives its
// labelled fields — render-finding.js's renderHighlighted turns those
// into real `<strong>` emphasis (asterisks dropped) rather than
// printing the markers, and the markdown export re-emits them as the
// markdown they are. The report's own `**bold**` rides along for the
// same treatment; everything else (line breaks, list bullets, indented
// continuation lines) survives verbatim, with white-space: pre-wrap on
// the .desc CSS rule keeping the shape the report wrote.
function buildDescription(title, sections, hasEvidenceRows) {
  const bodyParts = [title]
  if (sections.details) bodyParts.push(sections.details)
  // An Evidence section that parsed into rows belongs to
  // `finding.evidence` — the card renders it as a list and the text
  // surfaces rebuild it from there (format.js evidenceMarkdown), so
  // repeating it here would only duplicate it. A section that parsed
  // into NO rows is free prose: it stays in the body, since dropping
  // it would lose it.
  if (sections.evidence && !hasEvidenceRows) bodyParts.push(`**Evidence:**\n${sections.evidence}`)
  if (sections.impact) bodyParts.push(`**Impact:** ${sections.impact}`)
  if (sections['reproduction steps']) bodyParts.push(`**Reproduction:** ${sections['reproduction steps']}`)
  return bodyParts.join('\n\n')
}
