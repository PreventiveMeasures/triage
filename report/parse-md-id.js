// FROZEN. The id fingerprint of a Claude Security (markdown) finding.
//
// `report/finding-id.js` derives a finding's uuid from its severity,
// its DESCRIPTION and its location, and that uuid is the key every
// piece of stored triage hangs off — markers, buckets, comments, fixes.
// The description, though, is presentation: it gained bold section
// labels, then lost its Evidence list to structured rows, and each of
// those edits silently re-keyed every finding a user had already
// triaged.
//
// So the fingerprint no longer rides on what `parse-md.js` renders
// today. The functions below are a verbatim snapshot of that parser as
// it stood BEFORE the `## Evidence` work (v1.0.0-alpha.10, when it
// still lived at `common/parse-md.js`) and they exist for one purpose: to reproduce, byte for byte,
// the description / location / severity that findings were keyed by
// then. Two parses of the same block is the price of stable ids.
//
// DO NOT change the behaviour of anything in this file — not to fix a
// bug in it, not to share code with parse-md.js, not to make it read
// better, not to feed it something the newer format carries. Every byte
// it emits is baked into uuids that already exist in users' browsers.
//
// That holds for the `## Evidence` shape too, which this snapshot
// predates and therefore cannot see: such a report has no
// `## Location`, so its findings fingerprint by file 'unknown' / line
// '?' over a description with no evidence in it — exactly what v1.0.0-
// alpha.10 derived for the same document. Two findings in one report
// whose title / details / impact / reproduction and severity are all
// identical do collide into one id under that rule. That is the old
// behaviour, deliberately kept: an id that leaves data out of the hash
// is recoverable, an id that moves is not.

const VALID_SEVERITIES = new Set(['critical', 'high', 'medium', 'low', 'high_bug', 'bug', 'informational'])

// The fingerprint object `deriveFindingId` hashes for one finding
// block, in the key order the legacy code produced (JSON.stringify is
// order-sensitive, so the order IS part of the id). Nothing but this
// snapshot feeds it: the discriminator is the legacy location when the
// source carried one, and the legacy file / line otherwise — the same
// two branches `deriveFindingId` itself chose between back then.
export function frozenIdBasis(block) {
  const legacy = legacyBasis(block)
  if (!legacy) return null
  const { severity, description, location, file, line } = legacy
  return location
    ? { severity, description, location }
    : { severity, description, file, line }
}

// The legacy parse of one `# Title` block — severity, description and
// location exactly as the pre-Evidence parser computed them.
function legacyBasis(block) {
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

// ── Verbatim snapshot below this line ────────────────────────────────

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
