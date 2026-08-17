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
  fenceRanges, inFence, parseCodeRef, parseLabelledFields,
  splitByHeading, tableObjects,
} from './md-structure.js'
import { fromIndexRow, indexRowOf, listFindings, variantFindings } from './parse-piolium-rows.js'
import {
  codeRefOf, headerSeverity, idCell, idFromToken, isVariantsHeading,
  mapSeverity, parseHeading, preambleMeta, severityFromId,
  severityGroupOf,
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

// Sections that must never be mined for findings even when they carry
// id-shaped headings or tables: the index (read separately), the
// deliberately-excluded appendices, and the audit's own narrative
// sections.
const EXCLUDED_HEADERS = /^(?:summary of findings|deferred|methodolog|executive|conclusion|attack surface|coverage|discoveries|scope|table of contents|contents|appendix|recommendation|remediation)/u
function isExcludedHeader(header) {
  return EXCLUDED_HEADERS.test(header)
}

// Content-based section recognition: the section names vary run to run
// ('## HIGH — 3 findings', '## Confirmed Findings', emoji prefixes), so
// a non-excluded section whose `### ` (or `#### `) headings carry
// id-shaped tokens holds findings whatever it is called.
function hasIdBlocks(body) {
  const blocks = splitByHeading(body, H3_RE)
  const list = blocks.length > 0 ? blocks : splitByHeading(body, H4_RE)
  return list.some(({ heading }) => {
    const { id } = parseHeading(heading)
    return Boolean(id && idFromToken(id))
  })
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
    if (isDetailHeader(header)) { emit(parseDetailSection(body, index, pending)); continue }
    // Content-based fallback for every other spelling a run invents
    // ('## HIGH — 3 findings', '## 🔴 HIGH', '## Confirmed Findings'):
    // id-shaped block headings mark a findings section, and a leading
    // severity word on the header still supplies the tier.
    if (!isExcludedHeader(header) && hasIdBlocks(body)) {
      emit(parseDetailSection(body, index, pending, headerSeverity(header)))
    }
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
  // the user cannot correct. `**Commit audited**` is kept as
  // `auditedCommit` — deliberately NOT `commitHash`, which the finding
  // card renders as "introduced in <commit>": the scan commit says
  // where the audit ran, not where the bug landed.
  for (const f of findings) {
    if (meta.repo) f.repo = { github: meta.repo }
    if (meta.commitHash && !f.auditedCommit) f.auditedCommit = meta.commitHash
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
function parseDetailSection(body, index, pending, sev = '') {
  const blocks = splitByHeading(body, H3_RE)
  return blocks.length === 0
    ? parseSeverityGroup(body, sev, index, pending)
    : parseDetailBlocks(blocks, index, pending, sev)
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

  // An id/title table here is the INDEX in another position — the real
  // reports put the overview table under `## Findings by Severity` and
  // the full blocks under per-severity sections, so emitting rows
  // eagerly double-reported every finding (bare row + full block). Rows
  // merge into the index instead: blocks adopt their PoC / parent /
  // severity, and the gated index fallback emits only ids no block
  // claimed. Rows without an id can't be index-keyed and defer via
  // pending, as do list items — the same both-forms rule.
  const rows = tableObjects(body).map(indexRowOf).filter((r) => r.id || r.title)
  if (rows.length > 0) {
    for (const r of rows) {
      if (!r.severity && sev) r.severity = sev
      if (r.id && !index.has(r.id)) index.set(r.id, r)
      else if (!r.id) pending.push({ id: '', finding: fromIndexRow(r, sev) })
    }
    return []
  }
  pending.push(...listFindings(body, sev, index))
  return []
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
// after them, and dropping either loses the summary. The Impact / Root
// Cause labels stay `**bold**`, and the source text's own emphasis is
// kept: the finding card's renderHighlighted renders `**…**` spans as
// real <strong> emphasis (and markdown-export emits markdown, where
// they are simply bold). white-space: pre-line on `.desc` keeps the
// paragraph breaks.
function buildDescription(title, fields, prose) {
  const parts = [title]
  if (fields.summary) parts.push(fields.summary)
  if (prose) parts.push(prose)
  if (fields.details) parts.push(fields.details)
  if (fields.impact) parts.push(`**Impact:** ${fields.impact}`)
  if (fields['root cause']) parts.push(`**Root Cause:** ${fields['root cause']}`)
  return parts.filter(Boolean).join('\n\n')
}
