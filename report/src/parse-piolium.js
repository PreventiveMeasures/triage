// Piolium markdown findings parser. Piolium is Vigolium's agentic
// repository audit agent (https://github.com/vigolium/piolium), writing
// its artifacts under `piolium/` in the audited repo. The only file
// read here is the CONSOLIDATED run report,
// `piolium/final-audit-report.md`; the per-finding
// `piolium/findings/<id>-<slug>/report.md` files are deliberately not
// an input — one file per finding doesn't fit the one-file-per-report
// model, and the consolidated report already inlines or links each one.
//
// The report is COMPOSED BY AN AGENT, so its structure varies by mode
// and by run. Three observed layouts anchor the parser; everything else
// is handled by being liberal within them.
//
// Layout A — the pentest template: a `## Summary of Findings` index
// table (`| [C1] | Title | CRITICAL | executed | -- |`) plus
// `## Technical Findings Detail` with `### [C1] Title` blocks of
// `- **Severity:** / **Summary:** / **Impact:** / **Root Cause:** /
// **Key Code Reference:** / **PoC Status:**` bullets and an optional
// `#### Variants` sub-table.
//
// Layout B — the mode task outline (modes/balanced.ts L6c,
// modes/deep.ts P15): `## Findings by Severity` with severity groups
// (`### Critical`, counted `### HIGH (2)`, or promoted to
// `## Critical Findings`) whose findings are `#### ` blocks, an
// id/title table, or a `- [<id>-<slug>](…/report.md): summary` list.
//
// Layout C — real assembler output: anchored draft-phase ids and
// per-variant entries,
//
//   <a id="p10-011"></a>
//   ### p10-011 — Title
//
//   - **Severity:** HIGH
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
//
// Variants exist BOTH as table rows and as their own full entries; the
// entry carries the narrative and wins, so rows are deferred and
// emitted only for ids no entry covered — never twice, and never as a
// finding titled "Variants". Rows are also registered as index rows, so
// an entry adopts its row's severity / PoC / parent.
//
// Returns `{ type, source: 'piolium', findings }`, or null when the
// text isn't this format.
//
// Deliberately NOT findings: `## Methodology Summary` / `Notes` (a
// finding's bullet shape, but about the run), `## Attack Surface
// Summary` and `## Coverage Gaps` (link lists about the audit), and
// `## Deferred Findings (triage skip)` (drafts triage did not promote).
// Only findings-labelled sections, severity groups and the index are
// read — and structural markdown only OUTSIDE fenced code, since
// piolium inlines PoC snippets and a fenced `## step 2` must not end a
// section (md-structure.js).

import { H2_RE, H3_RE, H4_RE, normalizeNewlines, parseCodeRef, parseLabelledFields, splitByHeading, splitLeading, tableObjects } from './md-structure.js'
import { frozenIdBasis } from './parse-piolium-id.js'
import { fromIndexRow, indexRowOf, listFindings, variantFindings } from './parse-piolium-rows.js'
import {
  CODE_REF_FIELDS, codeRefOf, headerSeverity, idCell, idFromToken,
  isVariantsHeading, mapSeverity, parseHeading, preambleMeta,
  severityFromId, severityGroupOf,
} from './parse-piolium-tokens.js'


// Section headers whose body holds the findings. Deliberate non-matches:
// 'summary of findings' (the index, read separately), the excluded
// appendices, and the prose/link sections.
const DETAIL_HEADERS = new Set([
  'technical findings detail', 'technical findings',
  'detailed findings', 'findings detail', 'findings',
])
function isDetailHeader(header) {
  return DETAIL_HEADERS.has(header) || header.startsWith('findings by severity')
}

// Never mined for findings, even carrying id-shaped headings or tables.
const EXCLUDED_HEADERS = /^(?:summary of findings|deferred|methodolog|executive|conclusion|attack surface|coverage|discoveries|scope|table of contents|contents|appendix|recommendation|remediation)/u
function isExcludedHeader(header) {
  return EXCLUDED_HEADERS.test(header)
}

// Section names vary run to run ('## HIGH — 3 findings', '## Confirmed
// Findings', emoji prefixes), so a non-excluded section whose headings
// carry id-shaped tokens holds findings whatever it is called.
function headingHasId(heading) {
  const { id } = parseHeading(heading)
  return Boolean(id && idFromToken(id))
}
function hasIdBlocks(body) {
  const blocks = splitByHeading(body, H3_RE)
  const list = blocks.length > 0 ? blocks : splitByHeading(body, H4_RE)
  return list.some(({ heading }) => headingHasId(heading))
}

export function parsePioliumFindings(content) {
  const text = normalizeNewlines(content).trim()
  // Any one signal is enough: a project can retitle the H1, and a
  // hand-trimmed report can drop the prose sections and keep the
  // findings. Requiring none would steal plain `# Title` documents from
  // parse-md.js, which accepts any h1-led markdown.
  if (!/^# +Security Audit Report\b/mu.test(text)
    && !/^## +Technical Findings Detail\s*$/imu.test(text)
    && !/^## +Findings by Severity\b/imu.test(text)) return null

  const sections = parseSections(text)
  const index = parseIndexTable(sections['summary of findings'] || '')
  const meta = preambleMeta(splitLeading(text, H2_RE).head)

  const findings = []
  const seen = new Set()
  // Variant rows wait here until the document is read out: a row is
  // emitted only where no entry claimed its id.
  const pending = []
  const push = ({ id, finding }) => {
    findings.push(finding)
    if (id) seen.add(id)
  }
  const emit = (entries) => { for (const entry of entries) push(entry) }

  for (const [header, body] of Object.entries(sections)) {
    // A findings section: a severity group promoted to section level
    // (`## Critical Findings`), a findings-labelled header, or the
    // content-based fallback for every other spelling a run invents,
    // where a leading severity word still supplies the tier.
    const groupSev = severityGroupOf(header)
    if (groupSev || isDetailHeader(header)) {
      emit(parseFindingsBody(body, groupSev, index, pending))
    } else if (!isExcludedHeader(header) && hasIdBlocks(body)) {
      emit(parseFindingsBody(body, headerSeverity(header), index, pending))
    }
  }

  for (const entry of pending) {
    if (!entry.id || !seen.has(entry.id)) push(entry)
  }

  // Anything the index lists but no block described, from the row
  // alone: the index is the authoritative list, so a report with a
  // truncated detail section still triages every finding.
  for (const row of index.values()) {
    if (!seen.has(row.id)) push({ id: row.id, finding: fromIndexRow(row) })
  }

  if (findings.length === 0) return null

  // The preamble's `**Target**` names the audited repository, stamped
  // per finding (repo.github is per-finding downstream) with its own
  // object copy. The H1 title alone is not trusted: its <project> holds
  // a monorepo path as easily as a slug, and a wrong `repo.github` is
  // worse than none — format.js's fileUrl prefers it over the editable
  // repo chip, so a bad guess yields dead links the user can't correct.
  // `**Commit audited**` lands as `auditedCommit`, NOT `commitHash`,
  // which the card renders as "introduced in <commit>": the scan commit
  // says where the audit ran, not where the bug landed.
  for (const f of findings) {
    if (meta.repo) f.repo = { github: meta.repo }
    if (meta.commitHash && !f.auditedCommit) f.auditedCommit = meta.commitHash
  }

  // Report-level 'security' for the document.title fallback. No
  // per-finding `type` — piolium categorizes by severity, so a
  // synthetic one would print the same word on every run-meta line, the
  // call parse-deepsec.js and parse-codex.js also make — and ingest.js's
  // `data.source` gate keeps the report-level one off the findings.
  return { type: 'security', source: 'piolium', findings }
}

// The `### ` blocks of a findings section or section-level severity
// group, tier in `sev`: each a finding, a severity group of its own, or
// a `### Variants` block parented to the block before it.
function parseDetailBlocks(blocks, index, pending, sev) {
  const out = []
  let lastId = ''
  for (const { heading, body } of blocks) {
    const groupSev = severityGroupOf(heading)
    if (groupSev) {
      out.push(...parseFindingsBody(body, groupSev, index, pending))
      lastId = ''
    } else if (isVariantsHeading(heading)) {
      out.push(...parseVariantsBlock(body, index, lastId, pending, sev))
    } else {
      const entries = parseFindingBlock(heading, body, index, pending, sev)
      out.push(...entries)
      lastId = entries[0]?.id || lastId
    }
  }
  return out
}

// A `### ` finding block: the head, before any `#### `, is the finding.
// A `#### Variants` sub-heading defers its rows to `pending`; any other
// is a full entry of its own, as Layout C writes each variant.
function parseFindingBlock(heading, body, index, pending, sev) {
  const { head, subs } = splitLeading(body, H4_RE)
  const parent = parseBlock(heading, head, index, sev)
  // A `### ` heading with no id and no index row, over id-shaped
  // `#### ` entries, is a CATEGORY grouping: the entries are the
  // findings, and emitting the heading would add one title-only result
  // per category.
  const isCategory = parent !== null && !parent.id
    && subs.some((s) => !isVariantsHeading(s.heading) && headingHasId(s.heading))
  const out = parent && !isCategory ? [parent] : []
  out.push(...parseEntries(subs, index, pending, sev, parent?.id || ''))
  return out
}

// `### Variants` as its own block: tables defer to pending, `#### <id>`
// sub-blocks are the variants' entries. `parentId` is the block before
// this one, the structural parent for rows naming none.
function parseVariantsBlock(body, index, parentId, pending, sev) {
  const { head, subs } = splitLeading(body, H4_RE)
  pending.push(...variantFindings(head, index, parentId, sev))
  return parseEntries(subs, index, pending, sev, '')
}

// The `#### ` entries of a finding block, a `### Variants` block or a
// severity group — each a finding, except a `#### Variants` table, whose
// rows defer to `pending` under `parentId`, or under the entry before
// the table when they are siblings at group level.
function parseEntries(subs, index, pending, sev, parentId) {
  const out = []
  let lastId = ''
  for (const { heading, body } of subs) {
    if (isVariantsHeading(heading)) {
      pending.push(...variantFindings(body, index, parentId ?? lastId, sev))
      continue
    }
    const entry = parseBlock(heading, body, index, sev)
    if (!entry) continue
    out.push(entry)
    lastId = entry.id || lastId
  }
  return out
}

// The body of a findings section or severity group, holding that tier's
// findings in whichever rendering the assembler chose. A body with
// `### ` blocks routes through parseDetailBlocks, and `### ` MUST win
// over `#### ` there, or one `#### Variants` would swallow every `### `
// sibling as its body. Otherwise the findings are `#### ` sub-blocks, an
// id/title table, or a list. Prose alone ("None identified.") yields
// nothing.
function parseFindingsBody(body, sev, index, pending) {
  const h3 = splitByHeading(body, H3_RE)
  if (h3.length > 0) return parseDetailBlocks(h3, index, pending, sev)

  const out = parseEntries(splitByHeading(body, H4_RE), index, pending, sev, null)
  if (out.length > 0) return out

  // An id/title table here is the INDEX in another position — the real
  // reports put the overview under `## Findings by Severity` and the
  // blocks under per-severity sections — so emitting rows eagerly would
  // double-report every finding. They merge into the index instead, and
  // the gated fallback emits only ids no block claimed. A row with no id
  // can't be index-keyed and defers via pending, as list items do.
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
  // A bare-title heading ADOPTS the index row of the same title, so the
  // block and the row are one finding; without that, the index fallback
  // would emit it a second time.
  if (!id && title) {
    row = [...index.values()].find((r) => r.title.toLowerCase() === title.toLowerCase())
    id = row?.id ?? ''
  }

  const { fields, labels, prose } = parseLabelledFields(body)

  // Precedence: the block's own bullet, the index row, the enclosing
  // group, the id's prefix, then medium — where an unrecognized tier
  // stays visible rather than dropping out.
  const severity = mapSeverity(fields.severity)
    || mapSeverity(row?.severity)
    || groupSeverity
    || severityFromId(id)
    || 'medium'

  const ref = parseCodeRef(codeRefOf(fields))
  // A `**Line:**` / `**Lines:**` bullet supplies the line when the
  // reference itself carries none.
  const lineBullet = /\d+/u.exec(fields.line || fields.lines || '')?.[0] ?? ''
  const line = ref.line === '?' && lineBullet ? lineBullet : ref.line

  // `- **Variant of** [p10-011](#p10-011) · …` names the parent, with or
  // without the colon that would make it a labelled field; read off the
  // raw body either way, and kept out of the description along with
  // `<a id>` anchor chrome.
  const variantOf = /\*\*Variant of:?\*\*\s*\[?([^\]\s)]+)/iu.exec(body)
  const proseClean = prose.split('\n')
    .filter((l) => !/^\s*<a\s[^>]*>\s*<\/a>\s*$/iu.test(l) && !/\*\*Variant of:?\*\*/iu.test(l))
    .join('\n').trim()

  const finding = {
    file: ref.file || 'unknown',
    line,
    severity,
    description: buildDescription(title || id, fields, labels, proseClean),
  }
  if (ref.locationLink) finding.location = ref.locationLink
  // Last-resort fingerprint discriminator for an unlocated finding —
  // see fromIndexRow for why.
  else if (finding.file === 'unknown' && id) finding.location = `piolium:${id}`
  // The id fingerprint is parse-piolium-id.js's own reading of the
  // same reference, not the one above: what `parseCodeRef` makes of a
  // reference is presentation and free to improve, the fingerprint is
  // not. finding-id.js prefers `_idBasis` when deriving the uuid; read
  // that module's header before touching either side.
  finding._idBasis = frozenIdBasis({
    severity, description: finding.description, ref: codeRefOf(fields), lineBullet, id,
  })
  // Auxiliary provenance, kept as plain strings so an export can cite
  // the audit's own artifacts — as parse-md.js keeps branch / status.
  const pocStatus = fields['poc status'] || fields.poc || row?.pocStatus
  if (pocStatus) finding.pocStatus = pocStatus
  const reportPath = fields['detailed report'] || (link.endsWith('report.md') ? link : '')
  if (reportPath) finding.reportPath = reportPath
  if (row?.status) finding.status = row.status
  const parent = row?.parent || (variantOf ? idCell(variantOf[1]) : '')
  if (parent) finding.parent = parent

  return { id, finding }
}

// The `## ` sections, keyed case-folded. A repeated header CONCATENATES
// rather than overwrites, or concatenated runs (`cat a.md b.md`) and an
// index split across tables would keep only the last. Null-prototype, so
// a section named after an Object.prototype member aliases nothing.
function parseSections(text) {
  const sections = Object.create(null)
  for (const { heading, body } of splitByHeading(text, H2_RE)) {
    const header = heading.trim().toLowerCase()
    if (!header) continue
    sections[header] = header in sections ? `${sections[header]}\n${body}` : body
  }
  return sections
}

// `## Summary of Findings` → id → row: both the gap-filler for a sparse
// block (PoC status, parent, verdict) and the source of last resort.
function parseIndexTable(text) {
  const index = new Map()
  for (const obj of tableObjects(text)) {
    const row = indexRowOf(obj)
    if (!row.id) continue
    index.set(row.id, row)
  }
  return index
}

// Mechanical fields, which must not repeat into the description:
// severity / code-reference / PoC plumbing, attachments, cross-links.
// Everything ELSE a report labels — `Impact`, `Root cause`, or an
// invented `Residual risk` — is narrative and belongs in the story.
const NON_NARRATIVE_FIELDS = new Set([
  ...CODE_REF_FIELDS, 'severity', 'summary', 'files', 'poc',
  'poc status', 'line', 'lines', 'detailed report', 'proof of concept',
  'evidence', 'variant of', 'pattern', 'status', 'id', 'title',
])

// Heading + narrative in document order: the Summary, from a label or
// from unlabelled prose — both contribute, since a block often carries
// its labels first and its narrative in the paragraph under them — then
// every narrative label in its ORIGINAL casing, kept `**bold**`, which
// the card renders as real <strong> and the export re-emits as markdown.
function buildDescription(title, fields, labels, prose) {
  const parts = [title]
  if (fields.summary) parts.push(fields.summary)
  if (prose) parts.push(prose)
  for (const [k, v] of Object.entries(fields)) {
    if (!v || NON_NARRATIVE_FIELDS.has(k)) continue
    parts.push(`**${labels[k] || k}:** ${v}`)
  }
  return parts.filter(Boolean).join('\n\n')
}
