// Table rows and list items → findings for the Piolium parser: the
// index, overview and variants tables and the link-list rendering all
// reduce to one row shape and one construction. parse-piolium.js owns
// the document structure and the finding BLOCKS.

import { cellValue, parseCodeRef, stripBold, tableObjects } from './md-structure.js'
import { frozenIdBasis } from './parse-piolium-id.js'
import {
  idCell, leadingId, leadingLink, mapSeverity, severityFromId, slugTitle,
} from './parse-piolium-tokens.js'

// Normalize a table-row object to the shared row shape used by the
// index, variant tables, group tables, and the row→finding conversion.
// The PoC column appears both as `PoC Status` and plain `PoC`.
export function indexRowOf(obj) {
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

// A finding known only from a table row. Rows usually carry no path, so
// they land on the same `unknown` / `?` placeholders, and two rows
// sharing a title and tier would derive the SAME uuid for ingest's
// dedupe to swallow one of. The report id is the only discriminator such
// a row has, so it goes in the `location` fingerprint field — which
// deriveFindingId prefers over file/line and nothing renders —
// namespaced to read as an opaque token rather than a URL. A Location
// column, where a table has one, is parsed like any code reference.
export function fromIndexRow(row, sevFallback = '') {
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
  // The fingerprint reads the same reference its own way — see
  // parse-piolium-id.js.
  finding._idBasis = frozenIdBasis({
    severity, description: finding.description, ref: row.location || '', id: row.id,
  })
  if (row.pocStatus) finding.pocStatus = row.pocStatus
  if (row.status) finding.status = row.status
  if (row.parent) finding.parent = row.parent
  return finding
}

// Findings rendered as a list: the mode outline asks for "links to
// per-finding report.md", so an item leads with a
// `[<id>-<slug>](…/report.md)` link or a bold id, then a summary. Label
// bullets and "none found" placeholders are not findings.
export function listFindings(body, sev, index) {
  const out = []
  for (const line of body.split('\n')) {
    const m = /^\s{0,3}(?:[-*+]|\d{1,3}[.)])\s+(.+)$/u.exec(line)
    if (!m) continue
    let text = m[1].trim()
    if (/^\*\*[^:*]+:\*\*/u.test(text)) continue

    // The item leads with a link or a bold token; either way it reads
    // as plain `<id or title> <summary>` text from here on.
    const linked = leadingLink(text)
    const link = linked?.link ?? ''
    if (linked) {
      text = linked.text
    } else {
      const bold = /^\*\*([^*]+)\*\*\s*[:—–-]*\s*(.*)$/u.exec(text)
      if (bold) text = bold[2] ? `${bold[1].trim()} ${bold[2].trim()}` : bold[1].trim()
    }
    if (/^(?:none\b|no |n\/a\b)/iu.test(text)) continue

    // An id-led item takes its title from the slug and keeps the
    // summary as its body; anything else is title only.
    const lead = leadingId(text)
    const id = lead?.id ?? ''
    let title = text
    if (lead) {
      const slugT = slugTitle(lead.slug)
      title = slugT && lead.rest ? `${slugT}\n\n${lead.rest}` : (lead.rest || slugT || lead.id)
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

// Variant rows → findings, parented to the enclosing block where the row
// names none. They are also REGISTERED as index rows, so a variant's own
// `#### <id>` entry adopts their severity / PoC / parent even with no
// `## Summary of Findings` in the report. No table falls back to a
// bullet list at the caller's group severity.
export function variantFindings(tableText, index, parentId, sevFallback = '') {
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
