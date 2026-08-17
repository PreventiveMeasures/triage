// Token-level helpers for the Piolium report parser: severity words,
// finding-id shapes, heading forms, and field-name aliases. Split from
// parse-piolium.js, which owns the document structure; everything here
// is a pure string classifier.

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

// Final-report ids are severity-prefixed and sequential — `C1` / `H2`,
// `H-001` in lite consolidation — so the prefix letter is a second
// source for the tier. Only ids that actually follow that scheme count:
// a bare leading letter is not enough, or `CVE-2024-1234` would read as
// critical, and a draft-phase id (`p10-011`) carries no tier at all.
export function severityFromId(id) {
  const m = /^([CHML])-?\d+$/iu.exec((id || '').trim())
  if (!m) return ''
  return { C: 'critical', H: 'high', M: 'medium', L: 'low' }[m[1].toUpperCase()]
}

// A heading that IS a severity — `Critical`, `HIGH (2)`, `Critical
// Severity`, `High Findings`, `Medium-Risk Findings (3)` — marks a
// severity GROUP whose content is that tier's findings. Anchored to the
// full heading so a finding titled "High memory usage in parser" is
// never mistaken for a group.
export function severityGroupOf(heading) {
  const m = /^(critical|high|medium|low|informational|info)(?:[ -](?:severity|risk))?(?:[ -]findings?)?(?:\s*\(\d+\))?$/iu
    .exec((heading || '').trim())
  return m ? mapSeverity(m[1]) : ''
}

// A leading severity word on an otherwise free-form section header —
// `HIGH — 3 findings`, `High: remaining`, `HIGH (3) — confirmed` — for
// sections recognized by their CONTENT rather than the anchored
// severityGroupOf shape.
export function headerSeverity(header) {
  const m = /^(critical|high|medium|low|informational|info)\b/iu.exec((header || '').trim())
  return m ? mapSeverity(m[1]) : ''
}

// A heading that introduces variants (`#### Variants`, `### Variants
// (2)`), not a finding. Matched wherever finding headings are read, so
// a variants marker never becomes a finding titled "Variants".
export function isVariantsHeading(heading) {
  return /^variants?\s*(?:\(\d+\))?\s*:?$/iu.test((heading || '').trim())
}

// Parse a token as a piolium finding id, optionally carrying the
// directory slug. Two schemes exist: severity-prefixed final ids (`C1`,
// `H-001`, `C1-command-injection`) and draft-phase ids stamped by the
// analysis phases (`p10-011`, `q1-001`, `diff-003`, `r8-002`). The
// phase letters are a closed set with a 2+ digit sequence so prose
// tokens (`UTF-8`, `SHA-256`) never read as ids. Ids normalize to upper
// case so `[c1]` meets its `[C1]` index row and `p12-001` its
// `#### p12-001` entry. Returns null when the token isn't id-shaped.
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

// An id table cell / reference in any of its spellings — bare (`C1`),
// bracketed (`[C1]`), or an anchor link (`[p12-001](#p12-001)`) —
// normalized to the upper-case id.
export function idCell(s) {
  const v = (s || '').trim()
  const link = /^\[([^\]]+)\]\([^)]*\)$/u.exec(v)
  const inner = link ? link[1].trim() : v
  const m = /^\[(.+)\]$/u.exec(inner)
  return (m ? m[1].trim() : inner).toUpperCase()
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
    // still a usable dedupe key for the seen-set even when it isn't a
    // recognized scheme (`[SEC-001]`).
    return { id: bracket[1].trim().toUpperCase(), title: bracket[2].trim(), link }
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

// The document preamble (before the first `## ` section) carries the
// audit's run metadata as `**Label** value` lines:
//
//   # Security Audit Report: owner/repo
//   **Target** `owner/repo` (description)
//   **Commit audited** `<sha>` (prose)
//   **Audit ID** `…` · **Mode** deep (17-phase) · **Report assembled** …
//
// `**Target**` names the audited repository — an explicit declaration,
// unlike the H1 title, whose bare <project> may be a monorepo path and
// is deliberately not trusted on its own. The value is the first
// backtick span (or leading token), accepted only in strict
// `owner/repo` shape; the commit likewise only as plain hex. Audit ID /
// Mode are run bookkeeping with no consumer and are ignored.
export function preambleMeta(head) {
  const meta = {}
  const value = (rest) => (/`([^`]+)`/u.exec(rest)?.[1] ?? rest.split(/\s+/u)[0] ?? '').trim()
  const target = /^\s*(?:[-*] +)?\*\*Target:?\*\*\s*(.*)$/imu.exec(head || '')
  if (target) {
    const v = value(target[1])
    if (/^[\w.-]+\/[\w.-]+$/u.test(v)) meta.repo = v
  }
  const commit = /^\s*(?:[-*] +)?\*\*Commit[^:*]*:?\*\*\s*(.*)$/imu.exec(head || '')
  if (commit) {
    const v = value(commit[1])
    if (/^[0-9a-f]{7,64}$/iu.test(v)) meta.commitHash = v
  }
  return meta
}

// "Key Code Reference" is the assembler's field name for a finding's
// code location; real reports shorten and reword it (`**Key code:**`),
// so the observed spellings are all accepted, most specific first.
// Deliberately absent: `files` — real reports use `**Files:**` for
// attached reproduction data, not the finding's location — and bare
// `code` (matches PoC-code fields).
export const CODE_REF_FIELDS = [
  'key code reference', 'key code', 'code reference', 'location',
  'affected file', 'file', 'path',
]
export function codeRefOf(fields) {
  for (const k of CODE_REF_FIELDS) if (fields[k]) return fields[k]
  return ''
}
