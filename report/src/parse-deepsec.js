// Vercel DeepSec markdown findings parser. Per-finding shape differs
// from parse-md.js (Claude Security):
//
//   # Vulnerability Scan Report
//   …project metadata table… / ## Summary …summary table…
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
//   - **Revalidation:** confirmed       (only where the pass ran)
//   - **Reasoning:** what it concluded  (only where the pass ran)
//
//   prose body…
//
//   **Recommendation:** recommendation text
//
//   ---
//   ### Finding title 2 …  ## MEDIUM (5) …
//
// The writer is `packages/deepsec/src/commands/report.ts` in
// vercel-labs/deepsec; the shape above is settled there.
//
// Returns `{ type, source: 'deepsec', findings }`, or null when no
// `## SEVERITY (n)` header appears and the chain moves on.

import { normalizeNewlines, splitHeadingLine } from './md-structure.js'

// The `## SEVERITY (n)` header that marks a DeepSec document. Splitting
// on it with the tier captured interleaves tiers and content:
// [preamble, sevA, contentA, sevB, …].
const SECTION_RE = /^## ([A-Z][A-Z_]*)\s*\(\d+\)\s*\n/mu

// DeepSec's tiers onto the internal ladder. It separates vulnerabilities
// (CRITICAL … LOW) from non-vuln defects (HIGH_BUG, BUG), and
// `high_bug` / `bug` keep that apart so the chips count them
// separately. Anything else falls back to medium, where a renamed or
// new tier stays visible instead of vanishing.
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

// A field's value as the word it names, whatever punctuation it arrived
// in — the writer's `~~false positive~~`, or a hand-edited document's
// backticks and emphasis.
const word = (s) => String(s ?? '').toLowerCase().replaceAll(/[^a-z]+/gu, '')

// DeepSec's `high` / `medium` / `low` is a closed enum its schema
// validates, and what the words MEAN is nowhere: the investigate prompt
// asks for one of the three without saying what separates them, the docs
// call it "the agent's self-rated confidence", and nothing in DeepSec
// reads it back. So there is no probability to convert, only three rungs
// to place on the app's 0—10 scale — where 0 is a claim the revalidation
// pass withdrew, 10 the no-doubt an unscored import rides at, and a
// fresh load opens on a floor of 6, 7 or 8 by volume, then walks down
// through any gap that reveals nothing new (ui filters.js).
//
// So `high` clears every floor the tune can pick without claiming the
// app's no-doubt 10; `medium` is the lowest of those floors, surviving a
// small report's opening view and dropping out of a big one's; `low`
// sits under every floor but clear of the 0 that means refuted, since
// the agent still chose to report it. The even spacing carries as much —
// the walk settles in the GAPS, one step under the lowest rung it keeps,
// so a rung packed tighter leaves it nowhere to stop and a rung moved
// without its gap puts that tier off screen at open.
const CONFIDENCE = new Map([['high', 8], ['medium', 6], ['low', 4]])

// An unknown word reads as the middle rung, for the reason an
// unrecognized severity falls back to medium: a level DeepSec adds later
// should neither vanish under the floor nor — as scoring it nothing
// would — ride the unscored stand-in at 10, above every `high`. A block
// with no `Confidence:` line rated nothing, and there that stand-in is
// the honest answer.
function mapConfidence(s) {
  if (s === undefined) return undefined
  return CONFIDENCE.get(word(s)) ?? CONFIDENCE.get('medium')
}

// The verdict of DeepSec's revalidation pass as its writer spells it —
// `confirmed`, `~~false positive~~` struck through, `uncertain` for
// everything else it can answer — onto the app's own outcomes
// (finding.js REVALIDATE_KINDS).
//
// It belongs with the confidence question rather than beside it:
// `Confidence:` is the INVESTIGATE pass's self-rating, written before
// the adversarial pass looked at the finding, and `refuted` is the
// outcome that acts on the number — the range reads a ruled-out row as
// 0 whatever it claims. A report saying `high` on one line and
// `~~false positive~~` on the next is not a finding to show at 8/10.
const REVALIDATION = new Map([
  ['confirmed', 'confirmed'],
  ['falsepositive', 'refuted'],
  ['uncertain', 'unknown'],
])

export function parseDeepsecFindings(content) {
  const text = normalizeNewlines(content).trim()
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

  // Report-level 'security' for the document.title fallback. No
  // per-finding `type`: DeepSec categorizes by severity alone, as codex
  // does, and ingest.js's `data.source` gate keeps the report-level one
  // off the findings.
  return { type: 'security', source: 'deepsec', findings }
}

function parseBlock(block, severity) {
  // The `---` separator after each finding in a section is shed.
  const { title, body: rawBody } = splitHeadingLine(block)
  if (!title) return null
  const body = rawBody.replace(/\n---\s*$/u, '').trim()

  // Bullet metadata: `- **Field:** value`. Field names case-folded.
  const fields = {}
  for (const m of body.matchAll(/^- \*\*([^:*]+):\*\*\s*(.+)$/gmu)) {
    fields[m[1].trim().toLowerCase()] = m[2].trim()
  }

  // A bold inline label in the body, not a `## Recommended fix` H2 as
  // Claude Security writes — so the split is there.
  const recMatch = /^\*\*Recommendation:\*\*\s*/mu.exec(body)
  let prose = body
  let recommendation = ''
  if (recMatch) {
    prose = body.slice(0, recMatch.index)
    recommendation = body.slice(recMatch.index + recMatch[0].length).trim()
  }

  // Prose minus the bullet metadata, with `**bold**` stripped — the
  // renderer escapes HTML, so the markers would print literally.
  const description = prose
    .split('\n')
    .filter((line) => !/^\s*- \*\*/u.test(line))
    .join('\n')
    .replaceAll('**', '')
    .trim()

  // Title first, as parse-md and parse-codex write it, so the table
  // view's first line is the headline.
  const fullDescription = [title, description].filter(Boolean).join('\n\n')

  // The path arrives backticked (`path/file.js`); the backticks are
  // notation, not part of it.
  const file = (fields.file || 'unknown').replace(/^`(.*)`$/u, '$1')
  // First non-empty line only — the renderer takes a single `f.line`,
  // and lineLink wraps it as a `#L<n>` anchor when a fileUrl is
  // available. The siblings of a `26, 28` list are dropped.
  const line = (fields.lines || '').split(',').map((s) => s.trim()).find(Boolean) || '?'

  const finding = { file, line, severity, description: fullDescription }
  if (recommendation) finding.recommendation = recommendation.replaceAll('**', '')
  const confidence = mapConfidence(fields.confidence)
  if (confidence !== undefined) finding.confidence = confidence
  // What the pass concluded, where the report has been through it: the
  // verdict as one of the app's outcomes, the reasoning under it as the
  // pass's remark, DeepSec named as whose pass said so. The two are read
  // as a pair because the document writes them as one — a `Reasoning:`
  // line is the pass's, not the finding's. First line only, like every
  // field here; a wrapped remainder stays in the prose where it was.
  const revalidate = REVALIDATION.get(word(fields.revalidation))
  if (revalidate) {
    finding.revalidate = revalidate
    finding.revalidateSource = 'deepsec'
    if (fields.reasoning) finding.revalidateVerdict = fields.reasoning.replaceAll('**', '')
  }
  if (fields.slug) finding.slug = fields.slug
  return finding
}
