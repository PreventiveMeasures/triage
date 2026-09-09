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
//   - **Revalidation:** confirmed       (only where the pass ran)
//   - **Reasoning:** what it concluded  (only where the pass ran)
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
// The writer is `packages/deepsec/src/commands/report.ts` in
// vercel-labs/deepsec — the shape above is settled there, and the
// notes below are checked against it.
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

// A field's value reduced to the word it names, whatever punctuation
// it arrived wrapped in — the writer's own `~~false positive~~`, or
// the backticks and emphasis a hand-edited document picks up. '' for
// a field the block didn't carry.
const word = (s) => String(s ?? '').toLowerCase().replaceAll(/[^a-z]+/gu, '')

// DeepSec rates its own findings `high` / `medium` / `low` — a closed
// three-word enum (its findings schema validates it) that the report
// writer prints on every finding. What the words MEAN is nowhere: the
// investigate prompt asks for one of the three and never says what
// separates them, DeepSec's docs call it "the agent's self-rated
// confidence", and nothing in DeepSec reads the value back — it
// filters, sorts and gates nothing there. So there is no probability
// to convert; there are three rungs of an ordinal ladder to place on
// the 0—10 scale this app filters and sorts by, and where they land is
// settled by what that scale means HERE:
//
//   * 0 is where a finding the revalidation pass knocked down reads —
//     a claim withdrawn (ui filters.js voidsConfidence);
//   * 10 is "no doubt for a floor to act on", which an import with no
//     score of its own rides at (confidenceOnScale);
//   * a fresh load opens on a floor of 6, 7 or 8 — by volume — and
//     then walks down through any gap that reveals nothing new
//     (defaultConfidenceFloor).
//
// So `high` is 8: the top of a self-rating whose own adversarial
// second pass still leaves false positives standing is not the app's
// no-doubt 10, but it clears every floor the tune can pick. `medium`
// is 6, the lowest of those floors — where the range is a live
// control over the load, a medium survives a small report's opening
// view and drops out of a big one's, which is the volume rule the
// tune exists for. `low` is 4: clear of the 0 that means refuted,
// because a low-confidence finding is still one the agent chose to
// report rather than one anybody ruled out, and under every floor the
// tune can pick, so a fresh load doesn't open on what the producer
// itself doubted.
//
// The even spacing carries as much as the values do — the walk settles
// in the GAPS, one step under the lowest rung it is keeping: 7 for a
// report big enough that only the highs fit, 5 for a small one that
// keeps its mediums too, 0 for one with nothing under the ladder to
// hide. The 2/5/8 ladder this replaces put medium below every floor
// the tune can pick and left no gap under 8 for the walk to stop in,
// so a DeepSec report's mediums were off screen at open whatever its
// size; and it read low as a 2, next door to the 0 that means the
// pass withdrew the claim, which is not what a self-rated low says.
const CONFIDENCE = new Map([['high', 8], ['medium', 6], ['low', 4]])

// The rung a finding's word names. A word the ladder doesn't know
// reads as the middle rung, for the reason an unrecognized severity
// tier falls back to medium above: a level DeepSec adds later should
// neither vanish under the floor nor — which is what scoring it
// nothing would do — ride the import stand-in at 10, above every
// finding that said `high`. A block with no `Confidence:` line at all
// is a document that rated nothing, and there the stand-in is the
// honest answer, so it keeps no score.
function mapConfidence(s) {
  if (s === undefined) return undefined
  return CONFIDENCE.get(word(s)) ?? CONFIDENCE.get('medium')
}

// The verdict of DeepSec's revalidation pass, as the report writer
// spells it: `confirmed`, `~~false positive~~` struck through in its
// own hand, and `uncertain` for everything else the pass can answer (a
// `fixed` or `duplicate` verdict reaches the document under that word
// too). Onto the app's own outcomes (finding.js REVALIDATE_KINDS),
// where `refuted` is the one that acts on a number: the range reads a
// ruled-out row as 0 whatever confidence it carries.
//
// Which is why this line belongs to the confidence question rather
// than beside it. The `Confidence:` above it is the INVESTIGATE pass's
// self-rating, written before the adversarial pass ever looked at the
// finding; the verdict is that pass's answer to the same question,
// and a report saying `high` on one line and `~~false positive~~` on
// the next is not a finding to put on screen at 8/10.
const REVALIDATION = new Map([
  ['confirmed', 'confirmed'],
  ['falsepositive', 'refuted'],
  ['uncertain', 'unknown'],
])

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
  // What the pass concluded, where the report has been through it:
  // the verdict as an outcome of the app's own, the reasoning the
  // writer prints under it as the pass's remark, and DeepSec named as
  // whose pass said so. Verdict and reasoning are read as a pair
  // because the document writes them as one — a `Reasoning:` line is
  // the pass's line, not the finding's. First line only, like every
  // field here; a reasoning that wrapped leaves its remainder in the
  // prose, where it already was.
  const revalidate = REVALIDATION.get(word(fields.revalidation))
  if (revalidate) {
    finding.revalidate = revalidate
    finding.revalidateSource = 'deepsec'
    if (fields.reasoning) finding.revalidateVerdict = fields.reasoning.replaceAll('**', '')
  }
  if (fields.slug) finding.slug = fields.slug
  return finding
}
