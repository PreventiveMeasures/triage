// Piolium markdown findings parser. Piolium is Vigolium's agentic
// repository audit agent (https://github.com/vigolium/piolium); it
// writes its artifacts under `piolium/` in the audited repo. The only
// file consumed here is the CONSOLIDATED run report,
// `piolium/final-audit-report.md` — the per-finding
// `piolium/findings/<id>-<slug>/report.md` files are deliberately not a
// supported input (one file per finding doesn't map onto the
// one-file-per-report model the rest of the pipeline assumes, and the
// consolidated report already inlines each finding's summary, impact,
// root cause, and code reference).
//
//   # Security Audit Report: <project>
//   =========================================
//
//   ## Executive Summary
//   …prose…
//
//   ## Methodology Summary
//   - **Static Analysis:** … (ignored — run methodology, not a finding)
//
//   ## Summary of Findings
//
//   | ID | Title | Severity | PoC Status | Parent |
//   |----|-------|----------|------------|--------|
//   | [C1] | Command injection in the build hook | CRITICAL | executed | -- |
//   | [H2] | IDOR variant on /api/invoices | HIGH | executed | C1 |
//
//   ## Technical Findings Detail
//
//   ### [C1] Command injection in the build hook
//   - **Severity:** CRITICAL
//   - **Summary:** <one-sentence description>
//   - **Impact:** <concrete attacker gain>
//   - **Root Cause:** <why the bug exists>
//   - **Key Code Reference:** src/build/hook.js:142 in runHook()
//   - **PoC Status:** executed | theoretical | blocked
//   - **Detailed Report:** piolium/findings/C1-<slug>/report.md
//   - **Proof of Concept:** piolium/findings/C1-<slug>/poc.py
//   - **Evidence:** piolium/findings/C1-<slug>/evidence/
//
//   #### Variants
//
//   | ID | Title | Severity | Location | PoC Status |
//   |----|-------|----------|----------|------------|
//   | [H2] | IDOR variant on /api/invoices | HIGH | src/api/invoices.js:88 | executed |
//
//   ## Conclusion
//   …prose…
//
//   ## Deferred Findings (triage skip)
//   | Slug | Original Severity | Triage Reason |
//
// Returned shape matches the rest of the parser chain:
//   { type, source: 'piolium', findings: [...] }
// or null when the input doesn't look like the format — the caller
// falls through to the next parser.
//
// Two sections are intentionally NOT findings. `## Methodology Summary`
// uses the same `- **Label:** value` bullet shape as a finding body but
// describes the run. `## Deferred Findings (triage skip)` lists drafts
// the triage stage deliberately did not promote (no PoC, absent from
// the Summary of Findings index); surfacing them would inflate the
// report with entries piolium itself excluded. Both are skipped by
// construction — only the `## Technical Findings Detail` blocks, their
// `#### Variants` sub-tables, and the `## Summary of Findings` index
// are read.

// Piolium grades findings CRITICAL / HIGH / MEDIUM (a consistency check
// in its report assembler rejects Low-severity leakage into
// `findings/`), but drafts and deferred entries can carry LOW or INFO,
// so the full ladder is mapped. Anything unrecognized falls back to
// medium, keeping a finding with an odd tier visible rather than
// dropping it — same rule the other markdown parsers use.
function mapSeverity(s) {
  switch ((s || '').trim().toUpperCase()) {
    case 'CRITICAL': return 'critical'
    case 'HIGH': return 'high'
    case 'MEDIUM': return 'medium'
    case 'LOW': return 'low'
    case 'INFO': case 'INFORMATIONAL': return 'informational'
    default: return ''
  }
}

// Finding ids are severity-prefixed and sequential (`C1`, `H2`, `M10`),
// so the prefix letter is a second source for the tier when the
// `- **Severity:**` bullet is missing or unrecognized.
function severityFromId(id) {
  switch ((id || '').trim().charAt(0).toUpperCase()) {
    case 'C': return 'critical'
    case 'H': return 'high'
    case 'M': return 'medium'
    case 'L': return 'low'
    default: return ''
  }
}

function stripBold(text) { return text.replaceAll('**', '') }

// Ids are written bracketed in both the headings (`### [C1] Title`) and
// the index table (`| [C1] |`); the brackets are notation, not part of
// the id. Applied to id cells only — a title can legitimately contain
// square brackets.
function stripBrackets(s) {
  const m = /^\[(.+)\]$/u.exec(s.trim())
  return m ? m[1].trim() : s.trim()
}

// Table cells use `--` (or `-`) for "not applicable" — the Parent
// column of a non-variant row, an unknown location.
function cellValue(s) {
  const v = (s || '').trim()
  return /^-+$/u.test(v) ? '' : v
}

export function parsePioliumFindings(content) {
  const text = content.replaceAll(/\r\n?/gu, '\n').trim()
  // Format guard. Either signal is enough on its own: the H1 is fixed
  // by the template but a project could retitle it, and a partial /
  // hand-trimmed report could drop the prose sections while keeping
  // the findings. Requiring both would reject those; requiring neither
  // would steal plain `# Title` documents from parse-md.js, which
  // accepts any h1-led markdown.
  if (!/^# +Security Audit Report\b/mu.test(text)
    && !/^## +Technical Findings Detail\s*$/mu.test(text)) return null

  const sections = parseSections(text)
  const index = parseIndexTable(sections['summary of findings'] || '')

  const findings = []
  const seen = new Set()
  const push = (id, finding) => {
    findings.push(finding)
    if (id) seen.add(id)
  }

  for (const block of splitBlocks(sections['technical findings detail'] || '')) {
    const parsed = parseBlock(block, index)
    if (!parsed) continue
    push(parsed.id, parsed.finding)
    // Variant children (from piolium's variant-hunting phase) appear
    // ONLY under their parent's detail block — the template explicitly
    // forbids repeating them as standalone entries — so the sub-table
    // is the only place they can be read from.
    for (const v of parsed.variants) push(v.id, v.finding)
  }

  // Anything the index lists but the detail section doesn't describe:
  // emit it from the table row alone. The index is the authoritative
  // finding list, so a report whose detail section was truncated (or
  // which only ever had the table) still triages every finding instead
  // of silently losing the difference.
  for (const row of index.values()) {
    if (seen.has(row.id)) continue
    push(row.id, fromIndexRow(row))
  }

  if (findings.length === 0) return null

  // Repo is stamped per finding, not at the report level: `repo.github`
  // is a per-finding field everywhere downstream (format.js's fileUrl,
  // the repo chip, the Repositories view), and a report-level copy would
  // be read by nothing.
  const repo = repoOf(text)
  if (repo) for (const f of findings) f.repo = { ...repo }

  // Report-level type stays 'security' for the document.title fallback.
  // Per-finding `type` is deliberately unset: piolium categorizes by
  // severity, not by analyzer, so stamping a synthetic category on
  // every finding would print the same word on every run-meta line —
  // the same call parse-deepsec.js and parse-codex.js make. ingest.js's
  // `data.source` gate keeps the report-level type off the findings.
  return { type: 'security', source: 'piolium', findings }
}

// `# Security Audit Report: <project>` names the audited project. When
// that name is a bare `owner/repo` slug it doubles as the repo the
// findings belong to, which is what format.js's fileUrl needs to turn a
// `file` into a source link. Gated tightly — a free-text project name
// ("Acme Payments API") is not a slug and must not become one. Returns
// null when the H1 carries no usable slug.
function repoOf(text) {
  const m = /^# +Security Audit Report *: *(.+)$/mu.exec(text)
  if (!m) return null
  // Trailing `=====` setext underline can land on the same capture when
  // the title and its underline are not newline-separated.
  const name = m[1].trim().replace(/[.=\s]+$/u, '')
  return /^[\w.-]+\/[\w.-]+$/u.test(name) ? { github: name } : null
}

// Split the document into its `## ` sections, keyed by case-folded
// header. Setext-style underlines (`-----` / `=====`) that the template
// puts under each header land at the head of the section body and are
// dropped by the consumers (splitBlocks discards its preamble,
// parseIndexTable only reads `|` rows).
function parseSections(text) {
  const sections = {}
  const parts = text.split(/^## +/mu)
  for (let i = 1; i < parts.length; i++) {
    const part = parts[i]
    const nl = part.indexOf('\n')
    const header = (nl === -1 ? part : part.slice(0, nl)).trim().toLowerCase()
    const body = nl === -1 ? '' : part.slice(nl + 1)
    if (header) sections[header] = body
  }
  return sections
}

// Each finding in the detail section starts at `### `. parts[0] is the
// section preamble (the setext underline), dropped by the slice.
function splitBlocks(detail) {
  return detail.split(/^### +/mu).slice(1).filter((b) => b.trim().length > 0)
}

// Rows of a markdown table, as arrays of trimmed cells. Skips the
// header row's `|---|---|` delimiter and any line that isn't a table
// row, so prose around the table is ignored.
function tableRows(text) {
  const rows = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('|')) continue
    // Delimiter row — dashes, colons and pipes only.
    if (/^\|[\s:|-]*\|?\s*$/u.test(trimmed) && trimmed.includes('-')) continue
    const cells = trimmed.replace(/^\|/u, '').replace(/\|$/u, '').split('|').map((c) => c.trim())
    rows.push(cells)
  }
  return rows
}

// Read a table into `{ <column>: value }` objects keyed by its own
// case-folded header names, so the two documented column sets — the
// assembler's `ID | Title | Severity | PoC Status | Parent` and the
// older `ID | Title | Severity | Status` — both parse without the
// column order being hardcoded.
function tableObjects(text) {
  const rows = tableRows(text)
  if (rows.length < 2) return []
  const header = rows[0].map((h) => h.toLowerCase())
  return rows.slice(1).map((cells) => {
    const obj = {}
    header.forEach((name, i) => { if (name) obj[name] = cells[i] ?? '' })
    return obj
  })
}

// `## Summary of Findings` → id → row. Used both to fill gaps in a
// detail block (the index carries PoC status / parent / verdict that a
// sparse block may omit) and as the finding source of last resort.
function parseIndexTable(text) {
  const index = new Map()
  for (const obj of tableObjects(text)) {
    const id = stripBrackets(obj.id || '')
    if (!id) continue
    index.set(id, {
      id,
      title: cellValue(obj.title),
      severity: cellValue(obj.severity),
      pocStatus: cellValue(obj['poc status']),
      status: cellValue(obj.status),
      parent: stripBrackets(cellValue(obj.parent)),
    })
  }
  return index
}

function parseBlock(block, index) {
  // `### [C1] Command injection in the build hook`
  const newlineIdx = block.indexOf('\n')
  const heading = (newlineIdx === -1 ? block : block.slice(0, newlineIdx)).trim()
  if (!heading) return null
  const body = newlineIdx === -1 ? '' : block.slice(newlineIdx + 1)

  // The id is the leading bracketed token; everything after it is the
  // title. An unbracketed heading is treated as a bare title so a
  // report that drops the notation still yields a finding.
  const idMatch = /^\[([^\]]+)\] *(.*)$/u.exec(heading)
  const id = idMatch ? idMatch[1].trim() : ''
  const title = (idMatch ? idMatch[2] : heading).trim()

  const fields = parseFields(body)
  const row = index.get(id)

  // Severity precedence: the block's own bullet, then the index row,
  // then the id's severity prefix. Medium is the final fallback (an
  // unrecognized tier stays visible rather than being dropped).
  const severity = mapSeverity(fields.severity)
    || mapSeverity(row?.severity)
    || severityFromId(id)
    || 'medium'

  // "Key Code Reference" is the assembler's field name; "Location" is
  // accepted as an alias since that's what piolium's finding drafts and
  // variant tables call the same value.
  const { file, line, locationLink } = parseCodeRef(fields['key code reference'] || fields.location || '')

  const finding = {
    file: file || 'unknown',
    line,
    severity,
    description: buildDescription(title || id, fields),
  }
  if (locationLink) finding.location = locationLink
  // Auxiliary provenance kept as plain string fields. Nothing renders
  // these specifically today, but they let a future view (or a printed
  // export) cite the audit's own artifacts without re-parsing the
  // source — the same reason parse-md.js keeps its branch / status.
  const pocStatus = fields['poc status'] || row?.pocStatus
  if (pocStatus) finding.pocStatus = pocStatus
  if (fields['detailed report']) finding.reportPath = fields['detailed report']
  if (row?.status) finding.status = row.status
  if (row?.parent) finding.parent = row.parent

  return { id, finding, variants: parseVariants(body, index) }
}

// `#### Variants` sub-table inside a parent's detail block. Each row is
// a full finding in its own right (its own id, severity and location),
// linked back through `parent`.
function parseVariants(body, index) {
  const idx = /^#### +Variants\s*$/mu.exec(body)
  if (!idx) return []
  // Stop at the next heading of any level so a section following the
  // table can't be read as more variant rows.
  const rest = body.slice(idx.index + idx[0].length)
  const nextHeading = /^#{1,6} /mu.exec(rest)
  const table = nextHeading ? rest.slice(0, nextHeading.index) : rest

  const variants = []
  for (const obj of tableObjects(table)) {
    const id = stripBrackets(obj.id || '')
    const title = cellValue(obj.title)
    if (!id && !title) continue
    const row = index.get(id)
    const severity = mapSeverity(cellValue(obj.severity))
      || mapSeverity(row?.severity)
      || severityFromId(id)
      || 'medium'
    const { file, line, locationLink } = parseCodeRef(cellValue(obj.location))
    const finding = {
      file: file || 'unknown',
      line,
      severity,
      description: stripBold(title || id),
    }
    if (locationLink) finding.location = locationLink
    const pocStatus = cellValue(obj['poc status']) || row?.pocStatus
    if (pocStatus) finding.pocStatus = pocStatus
    // The parent's id when the index doesn't name one — inside a
    // `#### Variants` table the relationship is structural.
    if (row?.parent) finding.parent = row.parent
    variants.push({ id, finding })
  }
  return variants
}

// A finding known only from the `## Summary of Findings` row. No
// location is available (the index has no path column), so it takes the
// same `unknown` / `?` placeholders the other markdown parsers use when
// the source omits them.
function fromIndexRow(row) {
  const finding = {
    file: 'unknown',
    line: '?',
    severity: mapSeverity(row.severity) || severityFromId(row.id) || 'medium',
    description: stripBold(row.title || row.id),
  }
  if (row.pocStatus) finding.pocStatus = row.pocStatus
  if (row.status) finding.status = row.status
  if (row.parent) finding.parent = row.parent
  return finding
}

// `- **Field:** value` bullets, case-folded. A value runs to the next
// bullet, heading, table row or horizontal rule, so a wrapped
// one-liner keeps its continuation lines instead of being truncated at
// the first newline.
function parseFields(body) {
  const fields = {}
  let key = null
  let buf = []
  const flush = () => {
    if (key && !(key in fields)) fields[key] = buf.join('\n').trim()
    key = null
    buf = []
  }
  for (const line of body.split('\n')) {
    const bullet = /^\s*[-*] +\*\*([^:*]+):\*\*\s*(.*)$/u.exec(line)
    if (bullet) {
      flush()
      key = bullet[1].trim().toLowerCase()
      buf = [bullet[2]]
      continue
    }
    // Structural line — ends the current value without starting one.
    if (/^\s*(?:#{1,6} |\||[-=*_]{3,}\s*$)/u.test(line)) { flush(); continue }
    if (key) buf.push(line)
  }
  flush()
  return fields
}

// The code reference is prose-ish: `src/a.js:142 in runHook()`, a
// backticked path, or a markdown link to the line on GitHub. Pull out
// the path, the line number, and (when linked) the URL — which
// finding-id.js uses as the id discriminator when no fileHash is
// available, so two imports of the same report derive the same uuid and
// share triage.
function parseCodeRef(raw) {
  let text = (raw || '').trim()
  let locationLink = ''
  const link = /\[([^\]]+)\]\(([^)]+)\)/u.exec(text)
  if (link) {
    text = link[1].trim()
    locationLink = link[2].trim()
  }
  text = text.replaceAll('`', '')

  // A `#L<n>` anchor on the link is the most reliable line source.
  let line = ''
  const anchor = /#L(\d+)/u.exec(locationLink)
  if (anchor) line = anchor[1]

  // First token is the path; the template appends a function qualifier
  // (`… in runHook()`) that must not become part of it.
  const file = text.split(/[\s,]+/u).find(Boolean) || ''
  const colon = /^(.+):(\d+)$/u.exec(file)
  if (colon) {
    if (!line) line = colon[2]
    return { file: colon[1], line, locationLink }
  }
  return { file, line: line || '?', locationLink }
}

// Description = heading + the narrative bullets, in report order.
// Labels are kept inline (`Impact: …`) so the expanded card reads like
// the source report; `**bold**` is stripped because the renderer
// escapes HTML and would otherwise print the asterisks literally.
// white-space: pre-line on `.desc` keeps the paragraph breaks.
function buildDescription(title, fields) {
  const parts = [title]
  if (fields.summary) parts.push(fields.summary)
  if (fields.impact) parts.push(`Impact: ${fields.impact}`)
  if (fields['root cause']) parts.push(`Root Cause: ${fields['root cause']}`)
  return stripBold(parts.filter(Boolean).join('\n\n'))
}
