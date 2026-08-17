// Piolium markdown findings parser. Piolium is Vigolium's agentic
// repository audit agent (https://github.com/vigolium/piolium); it
// writes its artifacts under `piolium/` in the audited repo. The only
// file consumed here is the CONSOLIDATED run report,
// `piolium/final-audit-report.md` — the per-finding
// `piolium/findings/<id>-<slug>/report.md` files are deliberately not a
// supported input (one file per finding doesn't map onto the
// one-file-per-report model the rest of the pipeline assumes, and the
// consolidated report already inlines or links each finding).
//
// The report is COMPOSED BY AN AGENT, so its structure varies by mode
// and by run. Two documented layouts anchor the parser; everything else
// is handled by being liberal within them.
//
// Layout A — the pentest template (skills/audit report-templates.md and
// the report-assembler agent's system prompt):
//
//   # Security Audit Report: <project>
//
//   ## Summary of Findings
//   | ID | Title | Severity | PoC Status | Parent |
//   |----|-------|----------|------------|--------|
//   | [C1] | Command injection in the build hook | CRITICAL | executed | -- |
//
//   ## Technical Findings Detail
//
//   ### [C1] Command injection in the build hook
//   - **Severity:** CRITICAL
//   - **Summary:** <one-sentence description>
//   - **Impact:** <concrete attacker gain>
//   - **Root Cause:** <why the bug exists>
//   - **Key Code Reference:** src/build/hook.js:142 in runHook()
//   - **PoC Status:** executed
//   - **Detailed Report:** piolium/findings/C1-<slug>/report.md
//
//   #### Variants
//   | ID | Title | Severity | Location | PoC Status |
//
// Layout B — the mode pipelines (modes/balanced.ts L6c and modes/deep.ts
// P15 both task the assembler with: "Executive Summary, Findings by
// Severity (with links to per-finding report.md), Attack Surface
// Summary, Coverage Gaps, Methodology Notes", referencing findings "by
// their <id>-<slug> directory name"):
//
//   ## Findings by Severity
//
//   ### Critical
//
//   #### [C1-command-injection](findings/C1-command-injection/report.md)
//   <prose summary>
//   **Impact:** <attacker gain>
//
//   ### High
//   - [H1-idor-invoices](findings/H1-idor-invoices/report.md): <summary>
//
// Severity groups may sit at the `##` level too (`## Critical Findings`)
// and may carry counts (`### HIGH (2)`); findings inside a group may be
// `#### ` blocks, an id/title table, or a link/bullet list. A group made
// of prose only ("None identified.") contributes nothing.
//
// Returned shape matches the rest of the parser chain:
//   { type, source: 'piolium', findings: [...] }
// or null when the input doesn't look like the format — the caller
// falls through to the next parser.
//
// Sections that are intentionally NOT findings: `## Methodology
// Summary` / `## Methodology Notes` (same bullet shape as a finding
// body but describes the run), `## Attack Surface Summary` and
// `## Coverage Gaps` (link lists about the audit, not findings), and
// `## Deferred Findings (triage skip)` (drafts the triage stage
// deliberately did not promote). Only findings-labelled sections,
// severity-group sections, and the `## Summary of Findings` index are
// read.
//
// Structural markdown — `## ` / `### ` / `#### ` headings and heading
// terminators — is only recognized OUTSIDE fenced code blocks. Piolium
// inlines PoC snippets, and a shell comment like `## step 2` inside a
// fence must not end the findings section, nor may a fenced `### run
// this` line fabricate a finding. See fenceRanges below.

import {
  cellValue, fenceRanges, inFence, parseCodeRef, parseLabelledFields,
  splitByHeading, stripBold, stripBrackets, tableObjects,
} from './md-structure.js'

// Piolium grades findings CRITICAL / HIGH / MEDIUM (a consistency check
// in its report assembler rejects Low-severity leakage into
// `findings/`), but drafts and deferred entries can carry LOW or INFO,
// so the full ladder is mapped. Anything unrecognized falls back to
// medium at the call sites, keeping a finding with an odd tier visible
// rather than dropping it — same rule the other markdown parsers use.
//
// Only the first whitespace-delimited token is read: bullet values keep
// wrapped continuation lines (see parseLabelledFields) and may carry a
// parenthetical ("CRITICAL (raised after the PoC ran)"), while the tier
// itself is always a single word. Backticks/asterisks are shed so a
// `**CRITICAL**` still reads.
function mapSeverity(s) {
  const first = ((s || '').trim().split(/\s+/u)[0] || '').replaceAll(/[`*]+/gu, '')
  switch (first.toUpperCase()) {
    case 'CRITICAL': return 'critical'
    case 'HIGH': return 'high'
    case 'MEDIUM': return 'medium'
    case 'LOW': return 'low'
    case 'INFO': case 'INFORMATIONAL': return 'informational'
    default: return ''
  }
}

// Finding ids are severity-prefixed and sequential — `C1` / `H2` in the
// final report, `H-001` in lite consolidation — so the prefix letter is
// a second source for the tier. Only ids that actually follow that
// scheme count: a bare leading letter is not enough, or `CVE-2024-1234`
// would read as critical.
function severityFromId(id) {
  const m = /^([CHML])-?\d+$/iu.exec((id || '').trim())
  if (!m) return ''
  return { C: 'critical', H: 'high', M: 'medium', L: 'low' }[m[1].toUpperCase()]
}

// A heading that IS a severity — `Critical`, `HIGH (2)`, `Critical
// Severity`, `High Findings`, `Medium-Risk Findings (3)` — marks a
// severity GROUP whose content is that tier's findings. Anchored to the
// full heading so a finding titled "High memory usage in parser" is
// never mistaken for a group.
function severityGroupOf(heading) {
  const m = /^(critical|high|medium|low|informational|info)(?:[ -](?:severity|risk))?(?:[ -]findings?)?(?:\s*\(\d+\))?$/iu
    .exec((heading || '').trim())
  return m ? mapSeverity(m[1]) : ''
}

// Parse a token as a piolium finding id, optionally carrying the
// directory slug (`C1`, `H-001`, `C1-command-injection`,
// `M-001-idor`). Ids are normalized to upper case so `[c1]` and its
// index row `[C1]` meet. Returns null when the token isn't id-shaped.
function idFromToken(token) {
  const m = /^([CHML]-?\d{1,4})(?:-([A-Za-z0-9][\w-]*))?$/iu.exec(token || '')
  return m ? { id: m[1].toUpperCase(), slug: m[2] || '' } : null
}

// `command-injection` → `command injection` — the human-readable title
// recovered from an <id>-<slug> directory-name reference.
function slugTitle(slug) {
  return (slug || '').replaceAll('-', ' ')
}

// Section headers whose body holds the findings themselves. Deliberate
// non-matches: 'summary of findings' (the index table, read
// separately), 'deferred findings (triage skip)' (excluded appendix),
// and the prose/link sections (methodology, attack surface, coverage
// gaps).
const DETAIL_HEADERS = new Set([
  'technical findings detail', 'technical findings',
  'detailed findings', 'findings detail', 'findings',
])
function isDetailHeader(header) {
  return DETAIL_HEADERS.has(header) || header.startsWith('findings by severity')
}

export function parsePioliumFindings(content) {
  const text = content.replaceAll(/\r\n?/gu, '\n').trim()
  // Format guard. Any one signal is enough on its own: the H1 is the
  // template's but a project could retitle it, and a partial /
  // hand-trimmed report could drop the prose sections while keeping the
  // findings. Requiring more would reject those; requiring none would
  // steal plain `# Title` documents from parse-md.js, which accepts any
  // h1-led markdown.
  if (!/^# +Security Audit Report\b/mu.test(text)
    && !/^## +Technical Findings Detail\s*$/imu.test(text)
    && !/^## +Findings by Severity\b/imu.test(text)) return null

  const sections = parseSections(text)
  const index = parseIndexTable(sections['summary of findings'] || '')

  const findings = []
  const seen = new Set()
  const push = (id, finding) => {
    findings.push(finding)
    if (id) seen.add(id)
  }
  const emit = (list) => { for (const e of list) push(e.id, e.finding) }

  for (const [header, body] of Object.entries(sections)) {
    // `## Critical Findings` — a severity group promoted to the section
    // level.
    const sectionSev = severityGroupOf(header)
    if (sectionSev) { emit(parseSeverityGroup(body, sectionSev, index)); continue }
    if (!isDetailHeader(header)) continue

    const blocks = splitBlocks(body)
    if (blocks.length === 0) {
      // No `### ` level at all — findings sit directly under the `## `
      // as `#### ` blocks, a table, or a bullet list.
      emit(parseSeverityGroup(body, '', index))
      continue
    }
    for (const { heading, body: blockBody } of blocks) {
      const groupSev = severityGroupOf(heading)
      if (groupSev) { emit(parseSeverityGroup(blockBody, groupSev, index)); continue }
      const parsed = parseBlock(heading, blockBody, index)
      if (!parsed) continue
      push(parsed.id, parsed.finding)
      // Variant children (from piolium's variant-hunting phase) appear
      // ONLY under their parent's detail block — the template
      // explicitly forbids repeating them as standalone entries — so
      // the sub-table is the only place they can be read from.
      for (const v of parsed.variants) push(v.id, v.finding)
    }
  }

  // Anything the index lists but the detail sections don't describe:
  // emit it from the table row alone. The index is the authoritative
  // finding list, so a report whose detail section was truncated (or
  // which only ever had the table) still triages every finding instead
  // of silently losing the difference.
  for (const row of index.values()) {
    if (seen.has(row.id)) continue
    push(row.id, fromIndexRow(row))
  }

  if (findings.length === 0) return null

  // Deliberately NO repo derivation from the H1 project name: it holds
  // a monorepo path (`packages/core`) or a free-text label as easily as
  // an `owner/repo` slug, the two are syntactically indistinguishable,
  // and a wrong `repo.github` is worse than none — format.js's fileUrl
  // prefers it over the user-editable repo chip, so a bad guess yields
  // dead source links the user cannot correct. The repo chip is the
  // supported way to attach one.
  //
  // Report-level type stays 'security' for the document.title fallback.
  // Per-finding `type` is deliberately unset: piolium categorizes by
  // severity, not by analyzer, so stamping a synthetic category on
  // every finding would print the same word on every run-meta line —
  // the same call parse-deepsec.js and parse-codex.js make. ingest.js's
  // `data.source` gate keeps the report-level type off the findings.
  return { type: 'security', source: 'piolium', findings }
}

// Split the document into its `## ` sections, keyed by case-folded
// header. A repeated header CONCATENATES rather than overwrites —
// concatenated audit runs (`cat a.md b.md`) and reports that split
// their index into several tables would otherwise silently keep only
// the last section. Null-prototype object so a section named after an
// Object.prototype member can't alias an inherited key.
function parseSections(text) {
  const sections = Object.create(null)
  for (const { heading, body } of splitByHeading(text, /^## +(.*)$/gmu)) {
    const header = heading.trim().toLowerCase()
    if (!header) continue
    sections[header] = header in sections ? `${sections[header]}\n${body}` : body
  }
  return sections
}

// Each finding (or severity group) in a detail section starts at `### `.
function splitBlocks(detail) {
  return splitByHeading(detail, /^### +(.*)$/gmu)
}

// Normalize a table-row object to the shared row shape used by the
// index, group tables, and the row→finding conversion.
function indexRowOf(obj) {
  return {
    id: stripBrackets(obj.id || ''),
    title: cellValue(obj.title),
    severity: cellValue(obj.severity),
    pocStatus: cellValue(obj['poc status']),
    status: cellValue(obj.status),
    parent: stripBrackets(cellValue(obj.parent || '')),
    location: cellValue(obj.location),
  }
}

// `## Summary of Findings` → id → row. Used both to fill gaps in a
// detail block (the index carries PoC status / parent / verdict that a
// sparse block may omit) and as the finding source of last resort.
function parseIndexTable(text) {
  const index = new Map()
  for (const obj of tableObjects(text)) {
    const row = indexRowOf(obj)
    if (!row.id) continue
    index.set(row.id, row)
  }
  return index
}

// A finding heading in any of its observed spellings:
//   `[C1] Title`                       (pentest template)
//   `[C1-command-injection](url)`      (mode outline: linked dir name)
//   `[C1-command-injection](url) rest`
//   `C1-command-injection`             (bare dir name)
//   `C1: Title` / `H-001 — Title`      (id + separator + title)
//   `Title`                            (bare title)
// Returns { id, title, link } — id '' when the heading carries none,
// link '' unless the heading's leading token is a markdown link.
function parseHeading(headingText) {
  let text = headingText
  let link = ''
  const linked = /^\[([^\]]+)\]\(([^)]+)\)\s*[:—–-]*\s*(.*)$/u.exec(text)
  if (linked) {
    link = linked[2].trim()
    text = linked[3] ? `${linked[1].trim()} ${linked[3].trim()}` : linked[1].trim()
  }
  const bracket = /^\[([^\]]+)\] *(.*)$/u.exec(text)
  if (bracket) {
    const tok = idFromToken(bracket[1].trim())
    if (tok) return { id: tok.id, title: bracket[2].trim() || slugTitle(tok.slug) || tok.id, link }
    // Non-id bracket content keeps the loose behavior: the content is
    // still a usable dedupe key for the seen-set even when it isn't
    // severity-prefixed (`[SEC-001]`).
    return { id: bracket[1].trim(), title: bracket[2].trim(), link }
  }
  const space = text.search(/\s/u)
  const first = (space === -1 ? text : text.slice(0, space)).replace(/[:.,—–-]+$/u, '')
  const tok = idFromToken(first)
  if (tok) {
    const rest = (space === -1 ? '' : text.slice(space + 1)).replace(/^[:—–-]+\s*/u, '').trim()
    return { id: tok.id, title: rest || slugTitle(tok.slug) || tok.id, link }
  }
  return { id: '', title: text.trim(), link }
}

function parseBlock(heading, body, index, groupSeverity = '') {
  const headingText = heading.trim()
  if (!headingText) return null

  let { id, title, link } = parseHeading(headingText)
  let row = index.get(id)
  // A bare-title heading ADOPTS the index row carrying the same title,
  // so the block and its row read as one finding (id, severity, PoC
  // status). Without the adoption the index-fallback loop would emit
  // the same finding a second time under its row.
  if (!id && title) {
    for (const r of index.values()) {
      if (r.title.toLowerCase() === title.toLowerCase()) { id = r.id; row = r; break }
    }
  }

  const { fields, prose } = parseLabelledFields(body)

  // Severity precedence: the block's own bullet, then the index row,
  // then the enclosing severity group, then the id's severity prefix.
  // Medium is the final fallback (an unrecognized tier stays visible
  // rather than being dropped).
  const severity = mapSeverity(fields.severity)
    || mapSeverity(row?.severity)
    || groupSeverity
    || severityFromId(id)
    || 'medium'

  // "Key Code Reference" is the assembler's field name; "Location" and
  // "File" are accepted as aliases since that's what the finding drafts
  // and variant tables call the same value.
  const { file, line, locationLink } = parseCodeRef(
    fields['key code reference'] || fields.location || fields.file || '')
  let lineOut = line
  if (lineOut === '?' && fields.line) {
    const n = /\d+/u.exec(fields.line)
    if (n) lineOut = n[0]
  }

  const finding = {
    file: file || 'unknown',
    line: lineOut,
    severity,
    description: buildDescription(title || id, fields, prose),
  }
  if (locationLink) finding.location = locationLink
  // Last-resort fingerprint discriminator for an unlocated finding —
  // see fromIndexRow for why.
  else if (finding.file === 'unknown' && id) finding.location = `piolium:${id}`
  // Auxiliary provenance kept as plain string fields. Nothing renders
  // these specifically today, but they let a future view (or a printed
  // export) cite the audit's own artifacts without re-parsing the
  // source — the same reason parse-md.js keeps its branch / status.
  const pocStatus = fields['poc status'] || row?.pocStatus
  if (pocStatus) finding.pocStatus = pocStatus
  const reportPath = fields['detailed report'] || (link.endsWith('report.md') ? link : '')
  if (reportPath) finding.reportPath = reportPath
  if (row?.status) finding.status = row.status
  if (row?.parent) finding.parent = row.parent

  return { id, finding, variants: parseVariants(body, index, id) }
}

// One severity group — a `### Critical` block (or a `## Critical
// Findings` section) whose content is that tier's findings, in
// whichever of the three renderings the assembler chose: `#### `
// sub-blocks, an id/title table, or a link/bullet list. Also used with
// sev '' for a findings section that has no `### ` level at all. A
// group of prose only ("None identified.") yields nothing.
function parseSeverityGroup(body, sev, index) {
  const out = []
  const subs = splitByHeading(body, /^#### +(.*)$/gmu)
  for (const { heading, body: subBody } of subs) {
    const parsed = parseBlock(heading, subBody, index, sev)
    if (parsed) out.push({ id: parsed.id, finding: parsed.finding })
  }
  if (out.length > 0) return out

  const rows = tableObjects(body).map(indexRowOf).filter((r) => r.id || r.title)
  if (rows.length > 0) return rows.map((r) => ({ id: r.id, finding: fromIndexRow(r, sev) }))

  return listFindings(body, sev, index)
}

// Findings rendered as a list — the mode outline says "with links to
// per-finding report.md", so items usually lead with a
// `[<id>-<slug>](…/report.md)` link or a bold id, followed by a short
// summary. Label bullets (`- **Severity:** …`) and "none found"
// placeholders are not findings.
function listFindings(body, sev, index) {
  const out = []
  for (const line of body.split('\n')) {
    const m = /^\s{0,3}(?:[-*+]|\d{1,3}[.)])\s+(.+)$/u.exec(line)
    if (!m) continue
    let text = m[1].trim()
    if (/^\*\*[^:*]+:\*\*/u.test(text)) continue

    let link = ''
    const linked = /^\[([^\]]+)\]\(([^)]+)\)\s*[:—–-]*\s*(.*)$/u.exec(text)
    if (linked) {
      link = linked[2].trim()
      text = linked[3] ? `${linked[1].trim()} ${linked[3].trim()}` : linked[1].trim()
    } else {
      const bold = /^\*\*([^*]+)\*\*\s*[:—–-]*\s*(.*)$/u.exec(text)
      if (bold) text = bold[2] ? `${bold[1].trim()} ${bold[2].trim()}` : bold[1].trim()
    }
    if (/^(?:none\b|no |n\/a\b)/iu.test(text)) continue

    const space = text.search(/\s/u)
    const first = (space === -1 ? text : text.slice(0, space)).replace(/[:.,—–-]+$/u, '')
    const tok = idFromToken(first)
    let id = ''
    let title = text
    if (tok) {
      id = tok.id
      const rest = (space === -1 ? '' : text.slice(space + 1)).replace(/^[:—–-]+\s*/u, '').trim()
      const slugT = slugTitle(tok.slug)
      title = slugT && rest ? `${slugT}\n\n${rest}` : (rest || slugT || tok.id)
    }

    const row = index.get(id)
    const severity = mapSeverity(row?.severity)
      || sev
      || severityFromId(id)
      || 'medium'
    const finding = { file: 'unknown', line: '?', severity, description: stripBold(title) }
    if (id) finding.location = `piolium:${id}`
    else if (link) finding.location = link
    if (link.endsWith('report.md')) finding.reportPath = link
    if (row?.pocStatus) finding.pocStatus = row.pocStatus
    if (row?.status) finding.status = row.status
    if (row?.parent) finding.parent = row.parent
    out.push({ id, finding })
  }
  return out
}

// `#### Variants` sub-table inside a parent's detail block (Layout A).
// Each row is a full finding in its own right (its own id, severity and
// location), linked back through `parent`.
function parseVariants(body, index, parentId) {
  const ranges = fenceRanges(body)
  const start = [...body.matchAll(/^#### +Variants\s*$/gmu)].find((m) => !inFence(ranges, m.index))
  if (!start) return []
  // Stop at the next heading of any level so a section following the
  // table can't be read as more variant rows.
  const from = start.index + start[0].length
  const next = [...body.matchAll(/^#{1,6} /gmu)].find((m) => m.index > from && !inFence(ranges, m.index))
  const table = body.slice(from, next ? next.index : body.length)

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
    else if (finding.file === 'unknown' && id) finding.location = `piolium:${id}`
    const pocStatus = cellValue(obj['poc status']) || row?.pocStatus
    if (pocStatus) finding.pocStatus = pocStatus
    // The index row's Parent cell when it names one; otherwise the
    // enclosing block's id — inside a `#### Variants` table the
    // relationship is structural even when the index doesn't record it.
    const parent = row?.parent || parentId
    if (parent) finding.parent = parent
    variants.push({ id, finding })
  }
  return variants
}

// A finding known only from a table row. Rows usually carry no path, so
// they land on the same `unknown` / `?` placeholders — and finding-id.js
// would then derive the SAME uuid for two rows sharing a title and
// tier, letting ingest's dedupe silently swallow one. The report id is
// the only discriminator such a row carries; it is stamped as the
// `location` fingerprint field (preferred over file/line by
// deriveFindingId, and never rendered — its one consumer is the id
// derivation), namespaced so it reads as an opaque token rather than a
// URL. Group tables may carry a Location column; when they do, it is
// parsed like any code reference.
function fromIndexRow(row, sevFallback = '') {
  const severity = mapSeverity(row.severity)
    || sevFallback
    || severityFromId(row.id)
    || 'medium'
  const { file, line, locationLink } = parseCodeRef(row.location || '')
  const finding = {
    file: file || 'unknown',
    line,
    severity,
    description: stripBold(row.title || row.id),
  }
  if (locationLink) finding.location = locationLink
  else if (finding.file === 'unknown' && row.id) finding.location = `piolium:${row.id}`
  if (row.pocStatus) finding.pocStatus = row.pocStatus
  if (row.status) finding.status = row.status
  if (row.parent) finding.parent = row.parent
  return finding
}

// Description = heading + the narrative content, in report order.
// Labels are kept inline (`Impact: …`) so the expanded card reads like
// the source report; the unlabelled prose body stands in when there is
// no Summary label (Layout B). `**bold**` is stripped because the
// renderer escapes HTML and would otherwise print the asterisks
// literally. white-space: pre-line on `.desc` keeps paragraph breaks.
function buildDescription(title, fields, prose) {
  const parts = [title]
  if (fields.summary) parts.push(fields.summary)
  else if (prose) parts.push(prose)
  if (fields.details) parts.push(fields.details)
  if (fields.impact) parts.push(`Impact: ${fields.impact}`)
  if (fields['root cause']) parts.push(`Root Cause: ${fields['root cause']}`)
  return stripBold(parts.filter(Boolean).join('\n\n'))
}
