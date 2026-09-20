// What one finding IS, read off the parsed object: the severity it
// displays under, the revalidation stamp it carries, the run it came
// from, the export marker to strip, how its text splits into a name and
// a body. The viewer and write-md.js beside it both read a parser's
// object through these; format.js re-exports every name. Pure — no DOM,
// no app state, nothing above `report/` — so a viewer switch arrives as
// an argument (`displayedSeverity`, `runMetaLine`).

import { fenceRanges, inFence } from './md-structure.js'
import { SOURCE_LABELS } from './labels.js'

// Severity ranking — higher = more severe. Two stacks: vulnerabilities
// (critical → low) over bug-class findings (high_bug → bug), with
// informational at the bottom; only DeepSec emits the bug tiers. A new
// tier goes here, and every other list keys off SEVERITIES below.
export const SEVERITY_ORDER = {
  critical: 6, high: 5, medium: 4, low: 3,
  high_bug: 2, bug: 1, informational: 0,
}
// Highest-to-lowest iteration order.
export const SEVERITIES = ['critical', 'high', 'medium', 'low', 'high_bug', 'bug', 'informational']

// ── Corrected severity ───────────────────────────────────────────────
// `correctedSeverity`, with a free-text `correctedSeverityReason`, is a
// report's own re-rating of the analyzer's `severity`, and PER-REPORT
// where `severity` is not: the id hashes `severity`, so a dedupe keeps
// each occurrence's corrected value on the survivor in
// `f._correctedByReport`.
//
// Every display, count and sort resolves severity through the helpers
// below; IDENTITY — the id fingerprint, dedupe keys — stays raw.

// Only a known tier counts: an unrecognised one would sort to rank 0 and
// render an uncolored badge, so the intrinsic severity stands instead.
function validCorrected(corrected) {
  return corrected != null && corrected in SEVERITY_ORDER ? corrected : null
}

// The finding's own effective severity. It carries its own report's
// correction — it IS that report's finding — so no report key is needed;
// divergence across reports comes from correctedVariants.
export function effectiveSeverity(f) {
  return validCorrected(f?.correctedSeverity) ?? f?.severity
}

// True when the finding carries a valid correction that actually changes
// the tier — the trigger for the dual badge / reason affordance.
export function hasSeverityCorrection(f) {
  const c = validCorrected(f?.correctedSeverity)
  return c != null && c !== f?.severity
}

// Every display, count and sort site reads severity through this with the
// current lens (`state.severityMode`), not off `f.severity`.
export function displayedSeverity(f, mode) {
  return mode === 'original' ? f?.severity : effectiveSeverity(f)
}

// The per-report map of a deduped survivor, but only where the reports
// disagree — the "varies across reports" hint. null otherwise.
export function correctedVariants(f) {
  const byReport = f?._correctedByReport
  if (!byReport) return null
  const tiers = new Set(Object.values(byReport).map((v) => v?.severity))
  return tiers.size > 1 ? byReport : null
}

// ── Revalidation ─────────────────────────────────────────────────────
// A second pass over a finding. `revalidate` is what it concluded —
// `confirmed` (the finding stands), `partial` (part of it does),
// `refuted` (it doesn't), `unreachable` (nothing can reach the code),
// `unknown` (it couldn't tell) — with its reasoning in
// `revalidateVerdict` and, for a refutation, `revalidateRecommendation`.
// `revalidation` is the odd one out: the row that IS the pass rather
// than one it judged, carrying no verdict. `revalidateSource` names
// WHOSE pass said so, keyed like a report's `source`, and earns its keep
// when dedup carries a stamp onto another report's finding.
//
// One of these words or nothing — an unrecognised value is no stamp.
export const REVALIDATE_KINDS = ['revalidation', 'refuted', 'unreachable', 'confirmed', 'partial', 'unknown']
const REVALIDATE_SET = new Set(REVALIDATE_KINDS)

// The outcome as the DATA has it, '' when there is none; the viewer's
// `revalidateKind` is this behind the layer switch.
//
// Read as written: `Refuted ` is not this field's value. A drifted
// spelling is folded back where a person can edit one — a DOCUMENT
// (parse-deepview-fields.js readRevalidation) — and past that boundary
// case-folding it would say the opposite of what the analyzer wrote.
export function revalidateKindOf(f) {
  return REVALIDATE_SET.has(f?.revalidate) ? f.revalidate : ''
}

// Does this finding belong to the APP layer — the code as the
// application runs it — rather than the source underneath? Another
// product's does by construction: its producer looked at the
// application, and a `source` in labels.js is exactly "not DeepView's own
// dump". DeepView's own are source-layer, except the row that IS its
// revalidation pass, which describes the run and not a line of code.
//
// `source` comes in separately because callers resolve it against the
// report's marker first. The sole definition of the split; readers take
// it off the finding as `isApp`, stamped once.
export function isAppFinding(f, source = f?.source) {
  return Object.hasOwn(SOURCE_LABELS, source) || revalidateKindOf(f) === 'revalidation'
}

// ── Run meta ─────────────────────────────────────────────────────────
export function prettyModel(model) {
  if (!model) return model
  return model.replace(/^[^/]+\//u, '').replace(/^claude-/u, '').replaceAll('-', ' ')
}

// The run a finding came from, as one line — analyzer type, model,
// effort, exports mode, ` · `-joined, absent fields elided. Every
// surface that prints it (card, table row, bundle source rows, the
// markdown export) comes here, so the field list and separator can't
// drift apart.
//
// The revalidation row names itself right after the mode it ran in
// (`security · revalidate · opus 5 · …`) — that row only, not a verdict
// row the pass produced. `revalidation` is whether the layer is
// applied; off, the pass's name goes with the rest of it.
export function runMetaLine(f, revalidation = true) {
  const pass = revalidation && revalidateKindOf(f) === 'revalidation' ? 'revalidate' : ''
  return [f?.type, pass, prettyModel(f?.model), f?.effort, f?.exportsMode]
    .filter(Boolean).join(' · ')
}

// ── Export markers ───────────────────────────────────────────────────
// Isolate mode injects `[export: <name>]` markers and a `(<name>): `
// lead-in so a merged per-file response stays traceable to individual
// exports (src/isolate.js). Once post-process has lifted the name into
// `f.exportName` / `f.methodName`, the inline copy only repeats it, so a
// marker or prefix naming either field comes off; one naming something
// else is context ("this export affects <other>") and stays.
//
// In isolate mode a leading marker or `(<any>): [export: <any>] ` prefix
// comes off whatever it names, since that can be a sibling export. That
// pass runs FIRST, or the per-name strip could decapitate the prefix and
// leave the `(…): ` lead-in stranded.
export function stripExportMarker(text, f) {
  if (!text) return text
  let result = text
  if (f?.exportsMode === 'isolate') {
    // One level of nested `()` — `` (first branch of `bar()`) ``.
    // Deeper nesting doesn't match at all, leaving the prose intact
    // rather than over-stripping it.
    result = result.replace(/^\((?:[^()]|\([^()]*\))*\): \[export:\s*\w+\] /u, '')
    result = result.replace(/^\[export:\s*\w+\] /u, '')
  }
  const names = [f?.exportName, f?.methodName].filter(Boolean)
    .map((name) => name.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&'))
  // Every marker first, then the prefixes. The two passes are ordered,
  // not merely grouped: a `(Foo): ` prefix can sit BEHIND a marker
  // naming the OTHER name — `[export: bar] (Foo): …` — and the prefix
  // strip only ever looks at the front of the text, so a per-name pass
  // that checked the prefix before the other name's marker came off
  // would leave it there.
  for (const name of names) result = result.replaceAll(new RegExp(`\\[export:\\s*${name}\\]\\s*`, 'gu'), '')
  for (const name of names) result = result.replace(new RegExp(`^\\(\`?${name}\`?\\): `, 'u'), '')
  return result
}

// The export/method location as a label: `exportName.methodName` for a
// class export with a specific method, one name when they agree, '' when
// there is neither.
export function findingDisplayName(f) {
  const e = f?.exportName
  const m = f?.methodName
  if (e && m && e !== m) return `${e}.${m}`
  return e || m || ''
}

// ── Finding title ────────────────────────────────────────────────────
// What the finding is CALLED: the `title` field when a report has one,
// else the description's first line — where every markdown import puts
// the finding's heading, and where a JSON finding's one-paragraph
// description stands in for a name. Every surface that names a finding
// comes through here, so a report's own title reaches all of them or
// none. The export marker comes off first, being chrome.
export function firstLine(text) {
  if (!text) return ''
  for (const line of text.split('\n')) {
    if (line.trim()) return line.trim()
  }
  return ''
}

// The `title` a finding carries, trimmed — '' when there is none a
// reader can use. The three readers below all open on it.
function ownTitle(f) {
  return typeof f?.title === 'string' ? f.title.trim() : ''
}

export function findingTitle(f) {
  return ownTitle(f) || firstLine(stripExportMarker(f?.description, f))
}

// Title + body for a heading-over-body layout. With a `title` field the
// split is already made and the description is all body — except a first
// line REPEATING the title, which would stutter under it.
//
// Without one, the first line is the title, but only over a non-empty
// body: a single-line description stays whole rather than being bolded,
// and one that OPENS on a fence keeps its first line, since lifting it
// out would leave the block unopened and render its code as prose.
export function splitDescription(f) {
  const text = stripExportMarker(f?.description, f) || ''
  const own = ownTitle(f)
  if (own) {
    const body = text.trim()
    const nl = body.indexOf('\n')
    const first = (nl < 0 ? body : body.slice(0, nl)).trim()
    if (first !== own) return { title: own, body }
    return { title: own, body: nl < 0 ? '' : body.slice(nl + 1).replace(/^\s+/u, '') }
  }
  if (!text) return { title: '', body: '' }
  const nl = text.indexOf('\n')
  if (nl < 0) return { title: '', body: text }
  // A fence opening at index 0 — the same reading codeBlockSegments
  // gives it (format.js).
  if (fenceRanges(text)[0]?.[0] === 0) return { title: '', body: text }
  const body = text.slice(nl + 1).replace(/^\s+/u, '')
  if (!body) return { title: '', body: text }
  return { title: text.slice(0, nl).trim(), body }
}

// The description with the name in front of it — the shape a format
// without a `title` field already writes, for the surfaces that show one
// blob per finding rather than a heading over a body.
export function titledDescription(f) {
  const own = ownTitle(f)
  if (!own) return stripExportMarker(f?.description, f) || ''
  const { body } = splitDescription(f)
  return body ? `${own}\n\n${body}` : own
}

// ── Description sections ─────────────────────────────────────────────
// A description body split into the sections the report wrote it in: a
// paragraph OPENING with `**Label:**` is one. Every parser emits its
// narrative fields that way, whatever the report called them, so keying
// off the markup rather than a list of label words picks all of them up.
//
// Everything else is prose, and consecutive unlabelled paragraphs stay
// in ONE block so their spacing survives. `[{ label, body }]` in
// document order, `label` null for prose.
const SECTION_LABEL_RE = /^\*\*([^*\n]+):\*\*[ \t]*/u

// Blank lines, but only OUTSIDE a fence. A snippet's own blank line
// would tear the block in two, leaving each half with one bare fence
// marker and neither rendering as code.
function paragraphs(text) {
  const ranges = fenceRanges(text)
  if (ranges.length === 0) return text.split(/\n{2,}/u)
  const parts = []
  let last = 0
  for (const m of text.matchAll(/\n{2,}/gu)) {
    if (inFence(ranges, m.index)) continue
    parts.push(text.slice(last, m.index))
    last = m.index + m[0].length
  }
  parts.push(text.slice(last))
  return parts
}

export function descriptionSections(body) {
  const sections = []
  for (const para of paragraphs(body || '')) {
    if (!para.trim()) continue
    const m = SECTION_LABEL_RE.exec(para)
    if (m) {
      sections.push({ label: m[1].trim(), body: para.slice(m[0].length).trim() })
      continue
    }
    const open = sections.at(-1)
    if (open && open.label === null) open.body += `\n\n${para}`
    else sections.push({ label: null, body: para })
  }
  return sections
}

// ── Locations and evidence ───────────────────────────────────────────
// `file:line`, the line dropped when there isn't a finite one ('?' on
// imports that carry none). Takes a finding or an evidence row — both
// carry the pair and print it alike — and passes `line` through raw, so
// a range (`10-20`) survives whole.
export function locationLabel(x) {
  return Number.isFinite(parseInt(x?.line, 10)) ? `${x.file}:${x.line}` : (x?.file ?? '')
}

// An evidence row's note: `text` is what parse-md.js writes from the
// lines under a reference, `observation` what a JSON report may call the
// same thing. No producer emits both, but a row carrying both reads as
// the observation over the text rather than one silently winning.
// Non-string values are ignored — this reads whatever JSON arrives.
export function evidenceNote(row) {
  const str = (v) => (typeof v === 'string' ? v : '')
  return `${str(row?.observation)}\n${str(row?.text)}`.trim()
}
