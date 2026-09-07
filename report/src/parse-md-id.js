// FROZEN. The id fingerprint of a Claude Security (markdown) finding.
//
// A finding's uuid (finding-id.js) is the key every piece of stored
// triage hangs off — markers, buckets, comments, fixes — so it has to
// be a function of the source document alone, and it has to stay that
// function. `parse-md.js` is not that: what it produces is
// presentation, and it changes whenever the card does.
//
// So the fingerprint comes from a second parse of the same block, the
// one in this file. It reads a fixed subset of the format — the title,
// `## Details`, `## Location`, `## Impact`, `## Reproduction steps` and
// the severity — into severity, description and location of a fixed
// shape. That is what the uuid hashes: parse-md.js stamps it on the
// finding as `_idBasis`, and deriveFindingId uses it in place of the
// finding's own fields.
//
// DO NOT change the behaviour of anything in this file — not to fix a
// bug in it, not to share code with parse-md.js, not to make it read
// better, not to widen the subset it reads. Every byte it emits is
// baked into uuids in users' browsers; the golden values in
// tests/finding-id-md.test.js are what it must keep producing.
//
// `## Evidence` is outside the subset. A finding whose only cited site
// is an evidence row therefore keys by file 'unknown' / line '?' over
// a description with no evidence in it, and two findings in one report
// whose title / details / impact / reproduction and severity are all
// identical share an id. That is the rule, not an oversight: an id
// that leaves data out of the hash is recoverable, an id that moves is
// not.

const VALID_SEVERITIES = new Set(['critical', 'high', 'medium', 'low', 'high_bug', 'bug', 'informational'])

// The fingerprint object `deriveFindingId` hashes for one finding
// block, in a fixed key order (JSON.stringify is order-sensitive, so
// the order IS part of the id). The discriminator is the location when
// the source carries a `## Location`, and file / line otherwise — the
// same two branches deriveFindingId takes for a finding that carries
// no basis.
export function frozenIdBasis(block) {
  const basis = frozenParse(block)
  if (!basis) return null
  const { severity, description, location, file, line } = basis
  return location
    ? { severity, description, location }
    : { severity, description, file, line }
}

// This file's parse of one `# Title` block: severity, description and
// location, from the fixed subset of the format described above.
function frozenParse(block) {
  const newlineIdx = block.indexOf('\n')
  const title = (newlineIdx === -1 ? block : block.slice(0, newlineIdx)).trim()
  if (!title) return null
  const body = newlineIdx === -1 ? '' : block.slice(newlineIdx + 1)

  const { sectionsText, metaText } = splitBody(body)
  const sections = parseSections(sectionsText)
  const meta = parseMeta(metaText)
  const { file, line, locationLink } = parseLocation(sections.location || '')

  const sevRaw = (meta.severity || '').toLowerCase()
  const severity = VALID_SEVERITIES.has(sevRaw) ? sevRaw : 'medium'

  return {
    severity,
    description: buildDescription(title, sections),
    location: locationLink,
    file: file || 'unknown',
    line,
  }
}

// ── The frozen readers ───────────────────────────────────────────────

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

function parseMeta(metaText) {
  const meta = {}
  for (const m of metaText.matchAll(/\*\*([^:]+):\*\*\s*(.+)/gu)) {
    meta[m[1].trim().toLowerCase()] = m[2].trim()
  }
  return meta
}

function parseLocation(loc) {
  let file = '', line = '?', locationLink = ''
  const linkMatch = loc.match(/\[([^\]]+)\]\(([^)]+)\)/u)
  if (linkMatch) {
    file = linkMatch[1].trim()
    locationLink = linkMatch[2]
    const lineFromUrl = linkMatch[2].match(/#L(\d+)/u)
    if (lineFromUrl) line = lineFromUrl[1]
  } else {
    file = loc.trim()
    locationLink = loc.trim()
  }
  // `:42` suffix on the file path — common shorthand. Only consume
  // if we don't already have a line from a `#L<n>` anchor.
  const colonMatch = file.match(/^(.+):(\d+)$/u)
  if (colonMatch) {
    file = colonMatch[1]
    if (line === '?') line = colonMatch[2]
  }
  return { file, line, locationLink }
}

function buildDescription(title, sections) {
  const bodyParts = [title]
  if (sections.details) bodyParts.push(sections.details)
  if (sections.impact) bodyParts.push(`Impact: ${sections.impact}`)
  if (sections['reproduction steps']) bodyParts.push(`Reproduction: ${sections['reproduction steps']}`)
  return stripBold(bodyParts.join('\n\n'))
}

function stripBold(text) { return text.replaceAll('**', '') }
