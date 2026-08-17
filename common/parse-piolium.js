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
//
// Structural markdown — `## ` / `### ` headings and the `#### Variants`
// marker — is only recognized OUTSIDE fenced code blocks. Piolium
// inlines PoC snippets, and a shell comment like `## step 2` inside a
// fence must not end the findings section, nor may a fenced `### run
// this` line fabricate a finding. See fenceRanges below.

// Piolium grades findings CRITICAL / HIGH / MEDIUM (a consistency check
// in its report assembler rejects Low-severity leakage into
// `findings/`), but drafts and deferred entries can carry LOW or INFO,
// so the full ladder is mapped. Anything unrecognized falls back to
// medium at the call sites, keeping a finding with an odd tier visible
// rather than dropping it — same rule the other markdown parsers use.
//
// Only the first whitespace-delimited token is read: bullet values keep
// wrapped continuation lines (see parseFields) and may carry a trailing
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

  for (const { heading, body } of splitBlocks(sections['technical findings detail'] || '')) {
    const parsed = parseBlock(heading, body, index)
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

// Byte ranges of fenced code blocks (``` / ~~~), fences included. The
// closing fence must use the opening marker, so a `~~~` line inside a
// backtick fence stays content. A dangling opening fence runs to end of
// input — the same reading markdown renderers give it. Computed once
// per text and consulted by every structural splitter so a PoC line
// beginning with `## ` / `### ` / `#### ` can't be read as structure.
function fenceRanges(text) {
  const ranges = []
  let open = -1
  let marker = ''
  for (const m of text.matchAll(/^ {0,3}(```|~~~).*$/gmu)) {
    if (open === -1) { open = m.index; marker = m[1] }
    else if (m[1] === marker) { ranges.push([open, m.index + m[0].length]); open = -1 }
  }
  if (open !== -1) ranges.push([open, text.length])
  return ranges
}

function inFence(ranges, index) {
  return ranges.some(([start, end]) => index >= start && index < end)
}

// Split `text` at every line matching `re` (global + multiline, heading
// text in capture 1) that sits outside a code fence. Content before the
// first heading (a setext underline, prose) is dropped, matching the
// split()-based behavior this replaces.
function splitByHeading(text, re) {
  const ranges = fenceRanges(text)
  const marks = [...text.matchAll(re)].filter((m) => !inFence(ranges, m.index))
  return marks.map((m, i) => ({
    heading: m[1],
    body: text.slice(m.index + m[0].length + 1, i + 1 < marks.length ? marks[i + 1].index : text.length),
  }))
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

// Each finding in the detail section starts at `### `.
function splitBlocks(detail) {
  return splitByHeading(detail, /^### +(.*)$/gmu)
}

// Rows of a markdown table, as arrays of trimmed cells. Skips the
// header row's `|---|---|` delimiter and any line that isn't a table
// row, so prose around the table is ignored. The delimiter test is a
// single character class — the previous `[\s:|-]*\|?\s*$` shape had two
// overlapping whitespace quantifiers and backtracked quadratically on a
// long space-padded cell.
function tableRows(text) {
  const rows = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('|')) continue
    if (/^[\s:|-]+$/u.test(trimmed) && trimmed.includes('-')) continue
    const cells = trimmed.replace(/^\|/u, '').replace(/\|$/u, '').split('|').map((c) => c.trim())
    rows.push(cells)
  }
  return rows
}

// Read a table into `{ <column>: value }` objects keyed by its own
// case-folded header names, so the two documented column sets — the
// assembler's `ID | Title | Severity | PoC Status | Parent` and the
// older `ID | Title | Severity | Status` — both parse without the
// column order being hardcoded. A re-stated header row (which is how a
// concatenated duplicate section arrives) is chrome, not data.
function tableObjects(text) {
  const rows = tableRows(text)
  if (rows.length < 2) return []
  const header = rows[0].map((h) => h.toLowerCase())
  const objects = []
  for (const cells of rows.slice(1)) {
    if (cells.length === header.length && cells.every((c, i) => c.toLowerCase() === header[i])) continue
    const obj = {}
    header.forEach((name, i) => { if (name) obj[name] = cells[i] ?? '' })
    objects.push(obj)
  }
  return objects
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

function parseBlock(heading, body, index) {
  // `### [C1] Command injection in the build hook`
  const headingText = heading.trim()
  if (!headingText) return null

  // The id is the leading bracketed token; everything after it is the
  // title. An unbracketed heading is treated as a bare title — and it
  // ADOPTS the index row carrying the same title, so the block and its
  // row read as one finding (id, severity, PoC status). Without the
  // adoption the index-fallback loop below would emit the same finding
  // a second time under its row.
  const idMatch = /^\[([^\]]+)\] *(.*)$/u.exec(headingText)
  let id = idMatch ? idMatch[1].trim() : ''
  const title = (idMatch ? idMatch[2] : headingText).trim()
  let row = index.get(id)
  if (!id && title) {
    for (const r of index.values()) {
      if (r.title.toLowerCase() === title.toLowerCase()) { id = r.id; row = r; break }
    }
  }

  const fields = parseFields(body)

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
  // Last-resort fingerprint discriminator for an unlocated finding —
  // see fromIndexRow for why.
  else if (finding.file === 'unknown' && id) finding.location = `piolium:${id}`
  // Auxiliary provenance kept as plain string fields. Nothing renders
  // these specifically today, but they let a future view (or a printed
  // export) cite the audit's own artifacts without re-parsing the
  // source — the same reason parse-md.js keeps its branch / status.
  const pocStatus = fields['poc status'] || row?.pocStatus
  if (pocStatus) finding.pocStatus = pocStatus
  if (fields['detailed report']) finding.reportPath = fields['detailed report']
  if (row?.status) finding.status = row.status
  if (row?.parent) finding.parent = row.parent

  return { id, finding, variants: parseVariants(body, index, id) }
}

// `#### Variants` sub-table inside a parent's detail block. Each row is
// a full finding in its own right (its own id, severity and location),
// linked back through `parent`.
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

// A finding known only from the `## Summary of Findings` row. The index
// has no path column, so every row here lands on the same `unknown` /
// `?` placeholders — and finding-id.js would then derive the SAME uuid
// for two rows sharing a title and tier, letting ingest's dedupe
// silently swallow one. The report id is the only discriminator the row
// carries; it is stamped as the `location` fingerprint field (preferred
// over file/line by deriveFindingId, and never rendered — its one
// consumer is the id derivation), namespaced so it reads as an opaque
// token rather than a URL.
function fromIndexRow(row) {
  const finding = {
    file: 'unknown',
    line: '?',
    severity: mapSeverity(row.severity) || severityFromId(row.id) || 'medium',
    description: stripBold(row.title || row.id),
  }
  if (row.id) finding.location = `piolium:${row.id}`
  if (row.pocStatus) finding.pocStatus = row.pocStatus
  if (row.status) finding.status = row.status
  if (row.parent) finding.parent = row.parent
  return finding
}

// `- **Field:** value` bullets, case-folded, first occurrence wins. A
// value runs to the next bullet, heading, table row or horizontal rule,
// so a wrapped one-liner keeps its continuation lines instead of being
// truncated at the first newline. Fenced code under a bullet (a PoC
// snippet in a Summary / Evidence value) is all content: fence
// delimiters toggle, and nothing inside is structural. Null-prototype
// object so a label like "Constructor" can't alias an inherited key.
function parseFields(body) {
  const fields = Object.create(null)
  let key = null
  let buf = []
  let fence = ''
  const flush = () => {
    if (key && !(key in fields)) fields[key] = buf.join('\n').trim()
    key = null
    buf = []
  }
  for (const line of body.split('\n')) {
    const fm = /^ {0,3}(```|~~~)/u.exec(line)
    if (fm && (!fence || fm[1] === fence)) {
      fence = fence ? '' : fm[1]
      if (key) buf.push(line)
      continue
    }
    if (fence) {
      if (key) buf.push(line)
      continue
    }
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

  // A `#L<n>` anchor on the link is the most reliable line source (and
  // reads the start line of a `#L88-L95` range).
  let line = ''
  const anchor = /#L(\d+)/u.exec(locationLink)
  if (anchor) line = anchor[1]

  // First token is the path; the template appends a function qualifier
  // (`… in runHook()`) that must not become part of it. A line RANGE
  // (`src/a.js:88-95` — the normal way to cite a multi-line sink) keeps
  // its start line and sheds the range from the path.
  const file = text.split(/[\s,]+/u).find(Boolean) || ''
  const colon = /^(.+):(\d+)(?:-\d+)?$/u.exec(file)
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
