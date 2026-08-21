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
  // The finding's own location: `## Location` when the report carries
  // one (older format), otherwise the FIRST `## Evidence` row — the
  // primary site, by the convention the newer format follows. The
  // remaining rows ride along in the description (buildDescription).
  const { file, line, locationLink } = parseLocation(
    sections.location || evidenceRefs(sections.evidence || '')[0] || '',
  )

  // Severity defaults to medium when missing or unrecognized — keeps
  // an unparsable finding visible rather than dropping it silently.
  const sevRaw = (meta.severity || '').toLowerCase()
  const severity = VALID_SEVERITIES.has(sevRaw) ? sevRaw : 'medium'

  const description = buildDescription(title, sections)
  const recommendation = sections['recommended fix']
    ? stripBold(sections['recommended fix']) : undefined

  const finding = { file: file || 'unknown', line, severity, description }
  if (locationLink) finding.location = locationLink
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

// The code references of an `## Evidence` section, in document order.
// Each row leads with the reference and carries its own description on
// the lines under it:
//
//   1. [libs/a.ts:10–20](https://github.com/o/r/blob/<sha>/libs/a.ts#L10-L20)
//      Why this line matters.
//
// so only the marker line of each item is a reference; the prose below
// it is not. Numbered (`1.` / `1)`) and bulleted (`-` / `*` / `+`)
// markers both count. A section written without any list marker still
// yields its reference when it is a single line, or when one of its
// lines carries a markdown link — anything else (free prose) yields no
// reference at all, leaving the file 'unknown' rather than promoting a
// sentence to a path.
const EVIDENCE_ITEM_RE = /^[ \t]*(?:\d+[.)]|[-*+])\s+/u
const MD_LINK_RE = /\[[^\]]+\]\([^)\s]+\)/u

function evidenceRefs(text) {
  const lines = text.split('\n')
  const items = lines.filter((l) => EVIDENCE_ITEM_RE.test(l))
    .map((l) => l.replace(EVIDENCE_ITEM_RE, '').trim())
    .filter(Boolean)
  if (items.length > 0) return items
  const bare = lines.map((l) => l.trim()).filter(Boolean)
  const linked = bare.find((l) => MD_LINK_RE.test(l))
  if (linked) return [linked]
  return bare.length === 1 ? bare : []
}

// Build the description from the title + body sections. Strip the
// simple `**bold**` markdown so the renderer's esc() doesn't print the
// asterisks literally; everything else (line breaks, list bullets,
// plain text) survives. white-space: pre-line on the .desc CSS rule
// keeps the paragraph breaks visible.
function buildDescription(title, sections) {
  const bodyParts = [title]
  if (sections.details) bodyParts.push(sections.details)
  // The Evidence list rides along in the body — only its first row
  // becomes the finding's location, so without this every other cited
  // site would be dropped on import. Kept as the report wrote it,
  // markdown links included: the renderer linkifies `[name](url)`
  // refs (render-finding.js renderHighlighted) and the markdown export
  // re-emits the description verbatim.
  if (sections.evidence) bodyParts.push(`Evidence:\n${sections.evidence}`)
  if (sections.impact) bodyParts.push(`Impact: ${sections.impact}`)
  if (sections['reproduction steps']) bodyParts.push(`Reproduction: ${sections['reproduction steps']}`)
  return stripBold(bodyParts.join('\n\n'))
}

function stripBold(text) { return text.replaceAll('**', '') }
