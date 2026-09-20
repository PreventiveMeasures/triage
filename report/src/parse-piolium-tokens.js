// Token-level helpers for the Piolium report parser: severity words,
// finding-id shapes, heading forms, and field-name aliases. Split from
// parse-piolium.js, which owns the document structure; everything here
// is a pure string classifier.

import { isCommitHash, stripBrackets } from './md-structure.js'
import { isRepoSlug } from './meta.js'

// Piolium grades findings CRITICAL / HIGH / MEDIUM — its assembler
// rejects Low-severity leakage into `findings/` — but drafts and
// deferred entries can carry LOW or INFO, so the full ladder is mapped.
// The call sites fall back to medium, keeping an odd tier visible.
//
// Only the first token is read: a bullet value keeps its continuation
// lines and may carry a parenthetical ("CRITICAL (raised after the PoC
// ran)"), while the tier is one word. Backticks and asterisks are shed,
// so `**CRITICAL**` reads.
export function mapSeverity(s) {
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

// Final-report ids are severity-prefixed and sequential — `C1`, `H2`,
// `H-001` in lite consolidation — so the prefix is a second source for
// the tier. Only that exact scheme counts: a bare leading letter would
// read `CVE-2024-1234` as critical, and a draft id carries no tier.
export function severityFromId(id) {
  const m = /^([CHML])-?\d+$/iu.exec((id || '').trim())
  if (!m) return ''
  return { C: 'critical', H: 'high', M: 'medium', L: 'low' }[m[1].toUpperCase()]
}

// A heading that IS a severity — `Critical`, `HIGH (2)`, `Critical
// Severity`, `Medium-Risk Findings (3)` — marks a GROUP of that tier's
// findings. Anchored to the whole heading, so "High memory usage in
// parser" is never mistaken for one.
export function severityGroupOf(heading) {
  const m = /^(critical|high|medium|low|informational|info)(?:[ -](?:severity|risk))?(?:[ -]findings?)?(?:\s*\(\d+\))?$/iu
    .exec((heading || '').trim())
  return m ? mapSeverity(m[1]) : ''
}

// A leading severity word on a free-form header — `HIGH — 3 findings`,
// `High: remaining` — for sections recognized by their CONTENT rather
// than the anchored severityGroupOf shape.
export function headerSeverity(header) {
  const m = /^(critical|high|medium|low|informational|info)\b/iu.exec((header || '').trim())
  return m ? mapSeverity(m[1]) : ''
}

// A variants heading (`#### Variants`, `### Variants (2)`), not a
// finding — matched wherever finding headings are read.
export function isVariantsHeading(heading) {
  return /^variants?\s*(?:\(\d+\))?\s*:?$/iu.test((heading || '').trim())
}

// A token as a piolium finding id, with the directory slug when it
// carries one. Two schemes: severity-prefixed final ids (`C1`, `H-001`,
// `C1-command-injection`) and draft-phase ids from the analysis phases
// (`p10-011`, `q1-001`, `diff-003`). The phase letters are a closed set
// with a 2+ digit sequence, so prose tokens (`UTF-8`, `SHA-256`) never
// read as ids. Upper-cased, so `[c1]` meets its `[C1]` index row.
export function idFromToken(token) {
  const m = /^([CHML]-?\d{1,4}|(?:p|q|b|r|m|l|x|diff)\d{0,4}-\d{2,4})(?:-([A-Za-z0-9][\w-]*))?$/iu
    .exec(token || '')
  return m ? { id: m[1].toUpperCase(), slug: m[2] || '' } : null
}

// `command-injection` → `command injection` — the human-readable title
// recovered from an <id>-<slug> directory-name reference.
export function slugTitle(slug) {
  return (slug || '').replaceAll('-', ' ')
}

// An id cell in any of its spellings — `C1`, `[C1]`,
// `[p12-001](#p12-001)` — as the upper-case id.
export function idCell(s) {
  const v = (s || '').trim()
  const link = /^\[([^\]]+)\]\([^)]*\)$/u.exec(v)
  return stripBrackets(link ? link[1] : v).toUpperCase()
}

// A heading or item leading with a link —
// `[C1-command-injection](…/report.md): Title` — as plain text with the
// url apart: `{ text: 'C1-command-injection Title', link }`.
export function leadingLink(value) {
  const m = /^\[([^\]]+)\]\(([^)]+)\)\s*[:—–-]*\s*(.*)$/u.exec(value)
  if (!m) return null
  return { text: m[3] ? `${m[1].trim()} ${m[3].trim()}` : m[1].trim(), link: m[2].trim() }
}

// `text` split at its first whitespace when the leading token is an id —
// `p10-011 — Title`, `C1: Title` — as `{ id, slug, rest }`, trailing
// punctuation shed from the token and the separator from the rest.
export function leadingId(text) {
  const space = text.search(/\s/u)
  const first = (space === -1 ? text : text.slice(0, space)).replace(/[:.,—–-]+$/u, '')
  const tok = idFromToken(first)
  if (!tok) return null
  const rest = (space === -1 ? '' : text.slice(space + 1)).replace(/^[:—–-]+\s*/u, '').trim()
  return { id: tok.id, slug: tok.slug, rest }
}

// A finding heading in any of its observed spellings:
//   `[C1] Title`                       (pentest template)
//   `[C1-command-injection](url)`      (mode outline: linked dir name)
//   `C1-command-injection`             (bare dir name)
//   `p10-011 — Title` / `C1: Title`    (id + separator + title)
//   `Title`                            (bare title)
// Returns { id, title, link } — id '' when the heading carries none,
// link '' unless the heading's leading token is a markdown link.
export function parseHeading(headingText) {
  const { text, link } = leadingLink(headingText) ?? { text: headingText, link: '' }
  const bracket = /^\[([^\]]+)\] *(.*)$/u.exec(text)
  if (bracket) {
    const tok = idFromToken(bracket[1].trim())
    if (tok) return { id: tok.id, title: bracket[2].trim() || slugTitle(tok.slug) || tok.id, link }
    // Non-id bracket content is still a usable dedupe key for the
    // seen-set, unrecognized scheme and all (`[SEC-001]`).
    return { id: bracket[1].trim().toUpperCase(), title: bracket[2].trim(), link }
  }
  const lead = leadingId(text)
  if (lead) return { id: lead.id, title: lead.rest || slugTitle(lead.slug) || lead.id, link }
  return { id: '', title: text.trim(), link }
}

// The document preamble (before the first `## ` section) carries the
// audit's run metadata as `**Label** value` lines:
//
//   # Security Audit Report: owner/repo
//   **Target** `owner/repo` (description)
//   **Commit audited** `<sha>` (prose)
//   **Audit ID** `…` · **Mode** deep (17-phase) · **Report assembled** …
//
// `**Target**` declares the audited repository, where the H1 title's
// bare <project> may be a monorepo path and isn't trusted. The value is
// the first backtick span or leading token, taken only in strict
// `owner/repo` shape, the commit only as plain hex. Audit ID and Mode
// are run bookkeeping with no consumer.
export function preambleMeta(head) {
  const meta = {}
  const value = (rest) => (/`([^`]+)`/u.exec(rest)?.[1] ?? rest.split(/\s+/u)[0] ?? '').trim()
  const target = /^\s*(?:[-*] +)?\*\*Target:?\*\*\s*(.*)$/imu.exec(head || '')
  if (target) {
    const v = value(target[1])
    if (isRepoSlug(v)) meta.repo = v
  }
  const commit = /^\s*(?:[-*] +)?\*\*Commit[^:*]*:?\*\*\s*(.*)$/imu.exec(head || '')
  if (commit) {
    const v = value(commit[1])
    if (isCommitHash(v)) meta.commitHash = v
  }
  return meta
}

// "Key Code Reference" is the assembler's name for a finding's code
// location, which real reports shorten and reword, so every observed
// spelling is accepted, most specific first. Deliberately absent:
// `files`, which reports use for reproduction attachments, and bare
// `code`, which matches PoC-code fields.
export const CODE_REF_FIELDS = [
  'key code reference', 'key code', 'code reference', 'location',
  'affected file', 'file', 'path',
]
export function codeRefOf(fields) {
  for (const k of CODE_REF_FIELDS) if (fields[k]) return fields[k]
  return ''
}
