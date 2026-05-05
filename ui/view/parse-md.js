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
//   ## Location
//   [<name>](<url>)
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
// All five `## …` sections are optional (any missing one is just
// dropped from the description); only the title and the metadata
// block carry mandatory information (severity defaults to medium if
// absent or unrecognized).

const VALID_SEVERITIES = new Set(['critical', 'high', 'medium', 'low'])

export function parseMarkdownFindings(content) {
  const text = content.replace(/\r\n?/g, '\n').trim()
  // Cheap format guard: real markdown findings always start with an
  // h1. Anything else (random text, an empty file, a JSON-shaped blob
  // that failed to parse) returns null so the caller surfaces the
  // JSON error instead of a misleading markdown error.
  if (!text.startsWith('# ')) return null

  // Each finding starts at a line beginning with `# `. Splitting on
  // that pattern gives us per-finding chunks; the first split element
  // is whatever preamble preceded the first `# ` (usually empty).
  const blocks = text.split(/^# /m).filter((b) => b.trim().length > 0)

  const findings = []
  for (const block of blocks) {
    const f = parseBlock(block)
    if (f) findings.push(f)
  }
  if (findings.length === 0) return null

  // Top-level analyzer type — derive from the first finding's
  // category metadata (the JSON shape's `type` field). Falls back to
  // 'analysis' when no category is available, matching the default
  // ingest.js applies to JSON without an explicit type.
  const type = findings[0]._category?.toLowerCase() || 'analysis'
  // Strip the temporary _category we used to seed `type` so it
  // doesn't leak into per-finding state.
  for (const f of findings) delete f._category

  return { type, findings }
}

function parseBlock(block) {
  // First line is the title; the rest is the body (sections + meta).
  const newlineIdx = block.indexOf('\n')
  const title = (newlineIdx === -1 ? block : block.slice(0, newlineIdx)).trim()
  if (!title) return null
  const body = newlineIdx === -1 ? '' : block.slice(newlineIdx + 1)

  // Each finding is body content followed by a `---` separator and
  // a metadata block. The metadata block is itself terminated by
  // either another `---` (between findings) or end of input.
  const dashRe = /^---\s*$/m
  const dashMatch = dashRe.exec(body)
  let sectionsText, metaText
  if (!dashMatch) {
    sectionsText = body
    metaText = ''
  } else {
    sectionsText = body.slice(0, dashMatch.index).trim()
    const rest = body.slice(dashMatch.index + dashMatch[0].length).replace(/^\n/, '')
    const next = dashRe.exec(rest)
    metaText = next ? rest.slice(0, next.index) : rest
  }

  // Split sectionsText into named sections by `## Header`. parts[0]
  // is whatever preceded the first ## (usually a blank line).
  const sections = {}
  const parts = sectionsText.split(/^## /m)
  for (let i = 1; i < parts.length; i++) {
    const part = parts[i]
    const nl = part.indexOf('\n')
    const header = (nl === -1 ? part : part.slice(0, nl)).trim().toLowerCase()
    const content = (nl === -1 ? '' : part.slice(nl + 1)).trim()
    if (header) sections[header] = content
  }

  // Metadata: each line is `**Label:** value`. Field names are
  // case-folded so consumers don't have to mind the source casing.
  const meta = {}
  for (const m of metaText.matchAll(/\*\*([^:]+):\*\*\s*(.+)/g)) {
    meta[m[1].trim().toLowerCase()] = m[2].trim()
  }

  // Location: prefer a markdown link `[name](url)`. The line number
  // can come from a `#L<n>` anchor in the URL, a `:<n>` suffix on the
  // name, or absent altogether (rendered as `?`). The original link
  // (URL when present, raw text otherwise) is preserved on the
  // finding as `location` — the deterministic id derivation in
  // finding-id.js uses it as the discriminator when no fileHash is
  // available, so two MD imports of the same finding produce the
  // same UUID and dedupe / share triage.
  let file = '', line = '?', locationLink = ''
  const loc = sections.location || ''
  const linkMatch = loc.match(/\[([^\]]+)\]\(([^)]+)\)/)
  if (linkMatch) {
    file = linkMatch[1].trim()
    locationLink = linkMatch[2]
    const lineFromUrl = linkMatch[2].match(/#L(\d+)/)
    if (lineFromUrl) line = lineFromUrl[1]
  } else {
    file = loc.trim()
    locationLink = loc.trim()
  }
  // `:42` suffix on the file path — common shorthand. Only consume
  // if we don't already have a line from a `#L<n>` anchor.
  const colonMatch = file.match(/^(.+):(\d+)$/)
  if (colonMatch) {
    file = colonMatch[1]
    if (line === '?') line = colonMatch[2]
  }

  // Severity defaults to medium when missing or unrecognized — keeps
  // an unparsable finding visible rather than dropping it silently.
  const sevRaw = (meta.severity || '').toLowerCase()
  const severity = VALID_SEVERITIES.has(sevRaw) ? sevRaw : 'medium'

  // Build the description from the title + body sections. Strip the
  // simple `**bold**` markdown so the renderer's esc() doesn't print
  // the asterisks literally; everything else (line breaks, list
  // bullets, plain text) survives. white-space: pre-line on the
  // .desc CSS rule keeps the paragraph breaks visible.
  const bodyParts = [title]
  if (sections.details) bodyParts.push(sections.details)
  if (sections.impact) bodyParts.push(`Impact: ${sections.impact}`)
  if (sections['reproduction steps']) bodyParts.push(`Reproduction: ${sections['reproduction steps']}`)
  const description = stripBold(bodyParts.join('\n\n'))
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
  if (meta.category) finding._category = meta.category  // consumed by parseMarkdownFindings for top-level type

  return finding
}

function stripBold(text) { return text.replace(/\*\*/g, '') }
