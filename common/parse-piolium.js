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
// and by run. Three observed layouts anchor the parser; everything else
// is handled by being liberal within them.
//
// Layout A — the pentest template (skills/audit report-templates.md and
// the report-assembler agent's system prompt): a `## Summary of
// Findings` index table (`| [C1] | Title | CRITICAL | executed | -- |`)
// plus `## Technical Findings Detail` with `### [C1] Title` blocks of
// `- **Severity:** / **Summary:** / **Impact:** / **Root Cause:** /
// **Key Code Reference:** / **PoC Status:**` bullets and an optional
// `#### Variants` sub-table.
//
// Layout B — the mode task outline (modes/balanced.ts L6c and
// modes/deep.ts P15: "Executive Summary, Findings by Severity (with
// links to per-finding report.md), Attack Surface Summary, Coverage
// Gaps, Methodology Notes"): `## Findings by Severity` with severity
// groups (`### Critical`, possibly counted `### HIGH (2)` or promoted
// to `## Critical Findings`) whose findings are `#### ` blocks, an
// id/title table, or a `- [<id>-<slug>](…/report.md): summary` list.
//
// Layout C — real assembler output as observed in the wild: anchored
// draft-phase ids and per-variant entries,
//
//   <a id="p10-011"></a>
//   ### p10-011 — Title
//
//   - **Severity:** HIGH
//   - **Summary:** …
//   - **Impact:** …
//   - **Root cause:** …
//   - **Key code:** `src/a.js:20` (`fnA`) → `src/b.js:600` → `src/c.js`
//   - **PoC:** executed (…)
//   - **Files:** …reproduction attachments, ignored…
//
//   #### Variants
//   | ID | Title | Severity | Location | PoC |
//   |----|-------|----------|----------|-----|
//   | [p12-001](#p12-001) | Variant title | MEDIUM | `src/d.js:50-60` | executed |
//
//   <a id="p12-001"></a>
//   #### p12-001 — Variant title
//   - **Variant of** [p10-011](#p10-011) · **Pattern** `pattern-id`
//   - **Summary:** …
//
// Variants exist BOTH as table rows and as their own full entries; the
// entry is authoritative (it carries the narrative), so table rows are
// deferred and emitted only for ids no entry covered — never twice, and
// never as a finding titled "Variants". Table rows are also registered
// as index rows so an entry adopts its row's severity / PoC / parent.
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
// read. Structural markdown is only recognized OUTSIDE fenced code
// blocks — piolium inlines PoC snippets, and a fenced `## step 2` line
// must not end a section nor a fenced `### run this` fabricate a
// finding (see md-structure.js).

import {
  cellValue, fenceRanges, inFence, parseCodeRef, parseLabelledFields,
  splitByHeading, stripBold, tableObjects,
} from './md-structure.js'
import {
  codeRefOf, idCell, idFromToken, isVariantsHeading, mapSeverity,
  parseHeading, preambleMeta, severityFromId, severityGroupOf, slugTitle,
} from './parse-piolium-tokens.js'

const H3_RE = /^### +(.*)$/gmu
const H4_RE = /^#### +(.*)$/gmu

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
  const meta = preambleMeta(splitLeading(text, /^## +(.*)$/gmu).head)

  const findings = []
  const seen = new Set()
  // Variant-table rows wait here until the whole document is read: the
  // real reports also write each variant as its own full entry, and the
  // entry wins — a row is emitted only when no entry claimed its id.
  const pending = []
  const push = (id, finding) => {
    findings.push(finding)
    if (id) seen.add(id)
  }
  const emit = (list) => { for (const e of list) push(e.id, e.finding) }

  for (const [header, body] of Object.entries(sections)) {
    // `## Critical Findings` — a severity group promoted to the section
    // level.
    const sectionSev = severityGroupOf(header)
    if (sectionSev) { emit(parseSeverityGroup(body, sectionSev, index, pending)); continue }
    if (isDetailHeader(header)) emit(parseDetailSection(body, index, pending))
  }

  for (const v of pending) {
    if (v.id && seen.has(v.id)) continue
    push(v.id, v.finding)
  }

  // Anything the index lists but no block described: emit it from the
  // table row alone. The index is the authoritative finding list, so a
  // report whose detail section was truncated (or which only ever had
  // the table) still triages every finding instead of silently losing
  // the difference.
  for (const row of index.values()) {
    if (seen.has(row.id)) continue
    push(row.id, fromIndexRow(row))
  }

  if (findings.length === 0) return null

  // The preamble's `**Target**` line names the audited repository —
  // stamped per finding (repo.github is a per-finding field everywhere
  // downstream), each with its own object copy. The H1 title ALONE is
  // still not trusted: its <project> holds a monorepo path
  // (`packages/core`) as easily as a slug, and a wrong `repo.github` is
  // worse than none — format.js's fileUrl prefers it over the
  // user-editable repo chip, so a bad guess yields dead source links
  // the user cannot correct. `**Commit audited**` rides along the same
  // way parse-codex keeps its commit_hash column.
  for (const f of findings) {
    if (meta.repo) f.repo = { github: meta.repo }
    if (meta.commitHash && !f.commitHash) f.commitHash = meta.commitHash
  }

  // Report-level type stays 'security' for the document.title fallback.
  // Per-finding `type` is deliberately unset: piolium categorizes by
  // severity, not by analyzer, so stamping a synthetic category on
  // every finding would print the same word on every run-meta line —
  // the same call parse-deepsec.js and parse-codex.js make. ingest.js's
  // `data.source` gate keeps the report-level type off the findings.
  return { type: 'security', source: 'piolium', findings }
}

// One findings-labelled `## ` section: `### ` blocks are findings,
// severity groups, or a `### Variants` block; a section with no `### `
// level at all is treated as one big group (its findings sit directly
// at `#### `, in a table, or in a list).
function parseDetailSection(body, index, pending) {
  const blocks = splitByHeading(body, H3_RE)
  return blocks.length === 0
    ? parseSeverityGroup(body, '', index, pending)
    : parseDetailBlocks(blocks, index, pending, '')
}

// The `### ` blocks of a findings section or of a section-level
// severity group (`## HIGH`), whose tier arrives as `sev`.
function parseDetailBlocks(blocks, index, pending, sev) {
  const out = []
  let lastId = ''
  for (const { heading, body: blockBody } of blocks) {
    const groupSev = severityGroupOf(heading)
    if (groupSev) { out.push(...parseSeverityGroup(blockBody, groupSev, index, pending)); lastId = ''; continue }
    if (isVariantsHeading(heading)) { out.push(...parseVariantsBlock(blockBody, index, lastId, pending, sev)); continue }
    const results = parseFindingBlock(heading, blockBody, index, pending, sev)
    out.push(...results)
    lastId = results[0]?.id || lastId
  }
  return out
}

// A `### ` finding block. The head (before any `#### `) is the finding
// itself; a `#### Variants` sub-heading defers its table rows to
// `pending`, and any other `#### ` sub-heading is a full entry of its
// own (Layout C writes each variant as one, cross-linked via
// `**Variant of**`).
function parseFindingBlock(heading, body, index, pending, sev = '') {
  const { head, subs } = splitLeading(body, H4_RE)
  const out = []
  const parent = parseBlock(heading, head, index, sev)
  if (parent) out.push({ id: parent.id, finding: parent.finding })
  const parentId = parent?.id || ''
  for (const sub of subs) {
    if (isVariantsHeading(sub.heading)) {
      pending.push(...variantFindings(sub.body, index, parentId, sev))
      continue
    }
    const entry = parseBlock(sub.heading, sub.body, index, sev)
    if (entry) out.push({ id: entry.id, finding: entry.finding })
  }
  return out
}

// `### Variants` as its own block: tables defer to pending; `#### <id>`
// sub-blocks are the variants' full entries. `parentId` is the finding
// block preceding this one — the structural parent for rows that don't
// name their own.
function parseVariantsBlock(body, index, parentId, pending, sev = '') {
  const { head, subs } = splitLeading(body, H4_RE)
  pending.push(...variantFindings(head, index, parentId, sev))
  const out = []
  for (const sub of subs) {
    if (isVariantsHeading(sub.heading)) { pending.push(...variantFindings(sub.body, index, '', sev)); continue }
    const entry = parseBlock(sub.heading, sub.body, index, sev)
    if (entry) out.push({ id: entry.id, finding: entry.finding })
  }
  return out
}

// One severity group — a `### Critical` block (or a `## HIGH` /
// `## Critical Findings` section) whose content is that tier's
// findings, in whichever rendering the assembler chose. A group with
// `### ` blocks (a section-level group holding full finding blocks,
// variants tables and all) routes through the same handling as a
// findings section — `### ` MUST win over `#### ` there, or one
// `#### Variants` inside any block would swallow every `### ` sibling
// as its body. Otherwise the findings are `#### ` sub-blocks, an
// id/title table, or a link/bullet list. Also used with sev '' for a
// findings section that has no `### ` level at all. A group of prose
// only ("None identified.") yields nothing.
function parseSeverityGroup(body, sev, index, pending) {
  const h3 = splitByHeading(body, H3_RE)
  if (h3.length > 0) return parseDetailBlocks(h3, index, pending, sev)

  const out = []
  let lastId = ''
  for (const { heading, body: subBody } of splitByHeading(body, H4_RE)) {
    if (isVariantsHeading(heading)) {
      pending.push(...variantFindings(subBody, index, lastId, sev))
      continue
    }
    const parsed = parseBlock(heading, subBody, index, sev)
    if (parsed) {
      out.push({ id: parsed.id, finding: parsed.finding })
      lastId = parsed.id || lastId
    }
  }
  if (out.length > 0) return out

  const rows = tableObjects(body).map(indexRowOf).filter((r) => r.id || r.title)
  if (rows.length > 0) return rows.map((r) => ({ id: r.id, finding: fromIndexRow(r, sev) }))

  return listFindings(body, sev, index)
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

  const { file, line, locationLink } = parseCodeRef(codeRefOf(fields))
  let lineOut = line
  if (lineOut === '?' && (fields.line || fields.lines)) {
    const n = /\d+/u.exec(fields.line || fields.lines)
    if (n) lineOut = n[0]
  }

  // `- **Variant of** [p10-011](#p10-011) · …` — colon-less, so it
  // lands in prose rather than the fields; read the parent from it and
  // keep it (plus `<a id>` anchor chrome) out of the description.
  const variantOf = /\*\*Variant of:?\*\*\s*\[?([^\]\s)]+)/iu.exec(body)
  const proseClean = prose.split('\n')
    .filter((l) => !/^\s*<a\s[^>]*>\s*<\/a>\s*$/iu.test(l) && !/\*\*Variant of:?\*\*/iu.test(l))
    .join('\n').trim()

  const finding = {
    file: file || 'unknown',
    line: lineOut,
    severity,
    description: buildDescription(title || id, fields, proseClean),
  }
  if (locationLink) finding.location = locationLink
  // Last-resort fingerprint discriminator for an unlocated finding —
  // see fromIndexRow for why.
  else if (finding.file === 'unknown' && id) finding.location = `piolium:${id}`
  // Auxiliary provenance kept as plain string fields. Nothing renders
  // these specifically today, but they let a future view (or a printed
  // export) cite the audit's own artifacts without re-parsing the
  // source — the same reason parse-md.js keeps its branch / status.
  const pocStatus = fields['poc status'] || fields.poc || row?.pocStatus
  if (pocStatus) finding.pocStatus = pocStatus
  const reportPath = fields['detailed report'] || (link.endsWith('report.md') ? link : '')
  if (reportPath) finding.reportPath = reportPath
  if (row?.status) finding.status = row.status
  const variantOfField = fields['variant of'] ? idCell(fields['variant of'].split(/\s+/u)[0]) : ''
  const parent = row?.parent || variantOfField || (variantOf ? idCell(variantOf[1]) : '')
  if (parent) finding.parent = parent

  return { id, finding }
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

// Variant-table rows → findings, parented to the enclosing block when
// the row doesn't name a parent. Rows are also REGISTERED as index rows
// so a variant's own `#### <id>` entry adopts the row's severity / PoC
// / parent even in a report with no `## Summary of Findings`. Rows
// without a table fall back to a bullet list at the caller's group
// severity.
function variantFindings(tableText, index, parentId, sevFallback = '') {
  const out = []
  for (const obj of tableObjects(tableText)) {
    const row = indexRowOf(obj)
    if (!row.id && !row.title) continue
    if (!row.parent && parentId) row.parent = parentId
    if (row.id && !index.has(row.id)) index.set(row.id, row)
    out.push({ id: row.id, finding: fromIndexRow(row, sevFallback) })
  }
  if (out.length > 0) return out
  const items = listFindings(tableText, sevFallback, index)
  for (const e of items) {
    if (parentId && !e.finding.parent) e.finding.parent = parentId
  }
  return items
}

// A finding known only from a table row. Rows usually carry no path, so
// they land on the same `unknown` / `?` placeholders — and finding-id.js
// would then derive the SAME uuid for two rows sharing a title and
// tier, letting ingest's dedupe silently swallow one. The report id is
// the only discriminator such a row carries; it is stamped as the
// `location` fingerprint field (preferred over file/line by
// deriveFindingId, and never rendered — its one consumer is the id
// derivation), namespaced so it reads as an opaque token rather than a
// URL. Variant / group tables may carry a Location column; when they
// do, it is parsed like any code reference.
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

// Like splitByHeading, but keeps the content BEFORE the first heading
// (the enclosing block's own body) as `head`.
function splitLeading(body, re) {
  const ranges = fenceRanges(body)
  const first = [...body.matchAll(re)].find((m) => !inFence(ranges, m.index))
  if (!first) return { head: body, subs: [] }
  return { head: body.slice(0, first.index), subs: splitByHeading(body, re) }
}

// Normalize a table-row object to the shared row shape used by the
// index, variant tables, group tables, and the row→finding conversion.
// The PoC column appears both as `PoC Status` and plain `PoC`.
function indexRowOf(obj) {
  return {
    id: idCell(obj.id || ''),
    title: cellValue(obj.title),
    severity: cellValue(obj.severity),
    pocStatus: cellValue(obj['poc status'] || obj.poc),
    status: cellValue(obj.status),
    parent: idCell(cellValue(obj.parent || '')),
    location: cellValue(obj.location),
  }
}

// `## Summary of Findings` → id → row. Used both to fill gaps in a
// finding block (the index carries PoC status / parent / verdict that a
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

// Description = heading + the narrative content, in report order. The
// Summary label AND the unlabelled prose body both contribute — a block
// often carries its labels first and its narrative as the paragraph
// after them, and dropping either loses the summary. Labels are kept
// inline (`Impact: …`) so the expanded card reads like the source
// report; `**bold**` is stripped because the renderer escapes HTML and
// would otherwise print the asterisks literally. white-space: pre-line
// on `.desc` keeps paragraph breaks.
function buildDescription(title, fields, prose) {
  const parts = [title]
  if (fields.summary) parts.push(fields.summary)
  if (prose) parts.push(prose)
  if (fields.details) parts.push(fields.details)
  if (fields.impact) parts.push(`Impact: ${fields.impact}`)
  if (fields['root cause']) parts.push(`Root Cause: ${fields['root cause']}`)
  return stripBold(parts.filter(Boolean).join('\n\n'))
}
