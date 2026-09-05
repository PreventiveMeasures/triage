// Vercel DeepSec markdown findings parser. Per-finding shape differs
// from parse-md.js (Claude Security):
//
//   # Vulnerability Scan Report
//
//   …project metadata table…
//
//   ## Summary
//   …summary table…
//
//   ## HIGH (2)
//
//   ### Finding title 1
//
//   - **File:** `path/file.js`
//   - **Recent committers:** … (ignored)
//   - **Lines:** 26, 28
//   - **Slug:** rule-slug
//   - **Confidence:** high
//
//   prose body…
//
//   **Recommendation:** recommendation text
//
//   ---
//
//   ### Finding title 2
//   …
//
//   ## MEDIUM (5)
//   …
//
// Returned shape matches the rest of the parser chain:
//   { type, source: 'deepsec', findings: [...] }
// or null when the input doesn't look like the format (no
// `## SEVERITY (n)` headers anywhere) — caller falls through to the
// next parser.

import { splitHeadingLine } from './md-structure.js'

// The `## SEVERITY (n)` section header — the shape that marks a DeepSec
// document. Splitting on it with the tier captured interleaves tiers
// and content: [preamble, sevA, contentA, sevB, contentB, …], the
// preamble being the H1 + project metadata table + ## Summary block.
const SECTION_RE = /^## ([A-Z][A-Z_]*)\s*\(\d+\)\s*\n/mu

// Map source severity tier to our internal one. Vercel DeepSec
// distinguishes vulnerabilities (CRITICAL / HIGH / MEDIUM / LOW) from
// non-vuln defects (HIGH_BUG and plain BUG). The internal ladder
// preserves that distinction with `high_bug` / `bug` tiers so the
// stats chips and graph indicators show the bug counts separately.
// Anything else falls back to medium so a renamed / new tier still
// stays visible (won't silently disappear).
function mapSeverity(s) {
  switch (s.toUpperCase()) {
    case 'CRITICAL': return 'critical'
    case 'HIGH': return 'high'
    case 'MEDIUM': return 'medium'
    case 'LOW': return 'low'
    case 'HIGH_BUG': return 'high_bug'
    case 'BUG': return 'bug'
    case 'INFO': case 'INFORMATIONAL': return 'informational'
    default: return 'medium'
  }
}

// Confidence is a textual {low, medium, high} in DeepSec — map onto
// the 0-10 numeric scale the rest of the UI uses. Roughly thirds:
// low ~20%, medium ~50%, high ~80%.
function mapConfidence(s) {
  switch ((s || '').toLowerCase()) {
    case 'high': return 8
    case 'medium': return 5
    case 'low': return 2
    default: return undefined
  }
}

export function parseDeepsecFindings(content) {
  const text = content.replaceAll(/\r\n?/gu, '\n').trim()
  // Format guard — without a single `## SEVERITY (n)` header this isn't
  // a DeepSec doc; bail out so the chain moves on to
  // parseMarkdownFindings.
  const parts = text.split(SECTION_RE)
  if (parts.length === 1) return null

  const findings = []
  for (let i = 1; i < parts.length; i += 2) {
    const sev = mapSeverity(parts[i])
    // Each finding inside a severity section starts with `### Title`.
    for (const block of parts[i + 1].split(/^### /mu).slice(1)) {
      const f = parseBlock(block, sev)
      if (f) findings.push(f)
    }
  }
  if (findings.length === 0) return null

  // Report-level type stays 'security' for document.title fallback;
  // per-finding f.type is intentionally NOT set (DeepSec has no
  // per-finding analyzer category beyond severity, same situation as
  // codex). ingest.js's `data.source` gate keeps the report-level
  // type from leaking onto each finding.
  return { type: 'security', source: 'deepsec', findings }
}

function parseBlock(block, severity) {
  // First line is the `### Title` content; the trailing `---` separator
  // that follows each finding within a severity section is shed from
  // the body.
  const { title, body: rawBody } = splitHeadingLine(block)
  if (!title) return null
  const body = rawBody.replace(/\n---\s*$/u, '').trim()

  // Bullet metadata: `- **Field:** value`. Field names case-folded.
  const fields = {}
  for (const m of body.matchAll(/^- \*\*([^:*]+):\*\*\s*(.+)$/gmu)) {
    fields[m[1].trim().toLowerCase()] = m[2].trim()
  }

  // Recommendation is a bold inline label inside the body (NOT a
  // separate `## Recommended fix` H2 like Claude Security uses). Split
  // there to separate prose from recommendation text.
  const recMatch = /^\*\*Recommendation:\*\*\s*/mu.exec(body)
  let prose = body
  let recommendation = ''
  if (recMatch) {
    prose = body.slice(0, recMatch.index)
    recommendation = body.slice(recMatch.index + recMatch[0].length).trim()
  }

  // Description = prose minus the bullet metadata lines, with simple
  // **bold** markdown stripped (renderer escapes HTML, so ** would
  // render literally). white-space: pre-wrap on .desc preserves any
  // remaining paragraph breaks.
  const description = prose
    .split('\n')
    .filter((line) => !/^\s*- \*\*/u.test(line))
    .join('\n')
    .replaceAll('**', '')
    .trim()

  // Title prefix matches the convention used by parse-md / parse-codex
  // so the table view's first-line title shows the headline cleanly.
  const fullDescription = [title, description].filter(Boolean).join('\n\n')

  // The path arrives backticked (`path/file.js`); the backticks are
  // notation, not part of it.
  const file = (fields.file || 'unknown').replace(/^`(.*)`$/u, '$1')
  // First non-empty line only for now — the renderer takes a single
  // `f.line`, and lineLink wraps it as a `#L<n>` anchor when a fileUrl
  // is available. Surfacing additional lines could go into the
  // expanded body later.
  const line = (fields.lines || '').split(',').map((s) => s.trim()).find(Boolean) || '?'

  const finding = { file, line, severity, description: fullDescription }
  if (recommendation) finding.recommendation = recommendation.replaceAll('**', '')
  const confidence = mapConfidence(fields.confidence)
  if (confidence !== undefined) finding.confidence = confidence
  if (fields.slug) finding.slug = fields.slug
  return finding
}
