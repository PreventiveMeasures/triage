// What one finding IS, read off the parsed object — the readers every
// surface that shows a finding shares: the severity it displays under,
// the revalidation stamp it carries, the analyzer run it came from, the
// export marker to strip from its prose, and how its narrative text
// splits into a name, a body and the labelled sections the report wrote.
//
// Lifted out of ui/view/format.js so a writer can read a finding without
// the viewer: the markdown writer beside this file (write-md.js) takes
// the same objects the parsers produce, and this module is where the
// two agree on what those objects mean. Pure — no DOM, no app state — and
// free of anything above `report/`; format.js re-exports every name here
// unchanged, so the viewer's callers never see the move.
//
// Two of these readers answer differently under a viewer-level switch,
// and here the switch is an ARGUMENT rather than module state:
// `displayedSeverity` takes the severity lens, and `runMetaLine` takes
// whether the revalidation layer is applied. format.js wraps both with
// the state it holds.

import { fenceRanges, inFence } from './md-structure.js'

// Severity ranking — higher = more severe. The ladder splits into two
// stacks: vulnerabilities on top (critical → low) and bug-class findings
// below (high_bug → bug), with informational at the bottom. DeepSec maps
// HIGH_BUG to high_bug and plain BUG to bug; the other formats only use
// the vuln tiers + informational. Adding a new tier here is the
// canonical place — every other hardcoded severity list (counts
// initializers, stats chips, chip CSS, etc.) keys off SEVERITIES below.
export const SEVERITY_ORDER = {
  critical: 6, high: 5, medium: 4, low: 3,
  high_bug: 2, bug: 1, informational: 0,
}
// Highest-to-lowest iteration order. The bug tiers sit between low and
// informational so a graph node with only bugs still gets a recognizable
// color hint without competing with vuln tiers in the summary slots.
export const SEVERITIES = ['critical', 'high', 'medium', 'low', 'high_bug', 'bug', 'informational']

// ── Corrected severity ───────────────────────────────────────────────
// A finding may carry an application-specific `correctedSeverity` (plus a
// free-text `correctedSeverityReason`) emitted in the report data — a
// per-report re-rating of the analyzer's intrinsic `severity`. Unlike
// `severity` (which is hashed into the finding id, so it's identical for
// every occurrence of an id — see finding-id.js), the corrected value is
// PER-REPORT: the same finding id can carry a different corrected
// severity in different reports. When the same id is deduped across
// reports at ingest, each occurrence's effective severity is preserved on
// the survivor in `f._correctedByReport` (a { [reportName]: { severity,
// reason } } map) so the divergence stays visible.
//
// These helpers are the SINGLE place every display / count / sort consumer
// resolves severity through, so the original-vs-corrected switch and the
// invalid-tier fallback are defined once. Severity used for IDENTITY
// (the id fingerprint, dedupe keys) must stay raw `f.severity` and never
// route through here.

// A corrected value is honored only when it names a known tier; an
// unrecognised string (some importers don't validate severities) falls
// back to the intrinsic severity rather than sorting to rank 0 and
// rendering an uncolored badge.
function validCorrected(corrected) {
  return corrected != null && corrected in SEVERITY_ORDER ? corrected : null
}

// The finding's own effective severity — its corrected value when valid,
// else the intrinsic severity. The finding object always carries its own
// report's correction (it IS that report's finding), so no report key is
// needed here; cross-report divergence is surfaced via correctedVariants.
export function effectiveSeverity(f) {
  return validCorrected(f?.correctedSeverity) ?? f?.severity
}

// True when the finding carries a valid correction that actually changes
// the tier — the trigger for the dual badge / reason affordance.
export function hasSeverityCorrection(f) {
  const c = validCorrected(f?.correctedSeverity)
  return c != null && c !== f?.severity
}

// Switch-aware accessor: every display / count / sort site calls this with
// the current lens (`state.severityMode` in the viewer) instead of
// reading `f.severity`. `'original'` shows the intrinsic value; anything
// else (default `'corrected'`) shows the effective value.
export function displayedSeverity(f, mode) {
  return mode === 'original' ? f?.severity : effectiveSeverity(f)
}

// Per-report effective-severity map for a deduped survivor, returned ONLY
// when the correction diverges across the reports the id appeared in
// (size > 1 distinct tiers). Drives the "varies across reports" hint and
// its tooltip. `null` when there's no map or no divergence.
export function correctedVariants(f) {
  const byReport = f?._correctedByReport
  if (!byReport) return null
  const tiers = new Set(Object.values(byReport).map((v) => v?.severity))
  return tiers.size > 1 ? byReport : null
}

// ── Revalidation ─────────────────────────────────────────────────────
// A second pass over a finding. A report stamps `revalidate` with what
// that pass concluded — `confirmed` (the finding stands), `partial`
// (part of it does), `refuted` (it doesn't), `unreachable` (nothing
// can get to the code it's in), `unknown` (the pass couldn't tell) —
// and carries its reasoning in `revalidateVerdict`, plus, for a
// refutation, what to do about it in `revalidateRecommendation`.
//
// The remaining value, `revalidation`, marks the row that IS the
// revalidation pass rather than one it judged. It carries no verdict of
// its own.
//
// Values are case-folded and trimmed: these arrive from JSON a report
// generator wrote, and an unrecognised one answers "no stamp" rather
// than leaking into a display.
export const REVALIDATE_KINDS = ['revalidation', 'refuted', 'unreachable', 'confirmed', 'partial', 'unknown']
const REVALIDATE_SET = new Set(REVALIDATE_KINDS)

// The row's revalidation outcome as the DATA has it — case-folded, or ''
// when it carries none (an unrecognised value included). The viewer's
// `revalidateKind` (format.js) is this behind the layer switch; readers
// that must see the field whatever the switch says come here.
export function revalidateKindOf(f) {
  const v = typeof f?.revalidate === 'string' ? f.revalidate.trim().toLowerCase() : ''
  return REVALIDATE_SET.has(v) ? v : ''
}

// ── Run meta ─────────────────────────────────────────────────────────
export function prettyModel(model) {
  if (!model) return model
  return model.replace(/^[^/]+\//u, '').replace(/^claude-/u, '').replaceAll('-', ' ')
}

// One-line per-finding run-meta string — analyzer type, model
// (prettified), reasoning effort, exports mode — joined by ` · ` with
// absent fields elided. The same shape repeats across the finding-card
// body, the table row's secondary line, the flat-group / bundle-source
// meta rows and the markdown export; consolidating here keeps the field
// list, separator, and prettyModel application from drifting.
//
// The revalidation row names itself right after the mode it ran in
// (`security · revalidate · opus 5 · …`): the run that produced it is
// that mode's revalidation pass, and the meta line is where a card says
// which run a row came from. Only that row — a verdict row was produced
// by the pass but is not it. `revalidation` is whether the layer is
// applied: off, the pass's name goes with the rest of it.
export function runMetaLine(f, revalidation = true) {
  const pass = revalidation && revalidateKindOf(f) === 'revalidation' ? 'revalidate' : ''
  return [f?.type, pass, prettyModel(f?.model), f?.effort, f?.exportsMode]
    .filter(Boolean).join(' · ')
}

// ── Export markers ───────────────────────────────────────────────────
// Strip `[export: <name>]` markers from prose when they match the
// finding's own `exportName` or `methodName`. Isolate-mode injects
// these markers into every finding/CRITICAL line of a merged per-file
// response so the merge stays traceable to individual exports (see
// src/isolate.js), but once post-process has lifted the name out into
// `f.exportName` / `f.methodName` the inline marker just duplicates
// metadata already on the finding. Markers whose name does NOT match
// either field are left alone — they're still useful context (e.g.
// "this export affects <other>").
//
// Also strips a leading `` (`<name>`): `` or `(<name>): `` prefix from
// the text when the parenthesised name matches one of the fields —
// same rationale, the parenthesised lead-in is auto-injected and
// duplicates the field already on the finding.
//
// In isolate mode (`f.exportsMode === 'isolate'`) ALSO strip a leading
// `[export: <any>] ` or `(<any>): [export: <any>] ` prefix regardless
// of whether the bracketed name matches the finding — both are
// auto-injected by isolate-mode merging and the name there can be a
// sibling export that doesn't match this finding's own field. This
// pass runs BEFORE the per-name passes so the global `[export: name]`
// strip can't decapitate the prefix and leave the `(...): ` lead-in
// stranded.
export function stripExportMarker(text, f) {
  if (!text) return text
  let result = text
  if (f?.exportsMode === 'isolate') {
    // Parens content may include one level of nested `()` (e.g.
    // `` (first branch of `bar()`) ``). `[^()]|\([^()]*\)` allows
    // either a non-paren char or a balanced inner pair; deeper
    // nesting is rare in auto-injected prefixes and refuses to match
    // (leaves the prose intact rather than over-stripping).
    result = result.replace(/^\((?:[^()]|\([^()]*\))*\): \[export:\s*\w+\] /u, '')
    result = result.replace(/^\[export:\s*\w+\] /u, '')
  }
  const names = [f?.exportName, f?.methodName].filter(Boolean)
  for (const name of names) {
    const escaped = name.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&')
    result = result.replaceAll(new RegExp(`\\[export:\\s*${escaped}\\]\\s*`, 'gu'), '')
  }
  for (const name of names) {
    const escaped = name.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&')
    result = result.replace(new RegExp(`^\\(\`?${escaped}\`?\\): `, 'u'), '')
  }
  return result
}

// User-visible label for a finding's export/method location. When a
// finding carries both `exportName` and `methodName` and they differ,
// the label joins them as `exportName.methodName` (a class export with
// a specific method). Matching values collapse to one. Returns '' when
// neither is set.
export function findingDisplayName(f) {
  const e = f?.exportName
  const m = f?.methodName
  if (e && m && e !== m) return `${e}.${m}`
  return e || m || ''
}

// ── Finding title ────────────────────────────────────────────────────
// What the finding is CALLED. A report may name it outright in a
// `title` field; the formats that have no such field put it in the
// description's first line instead (every markdown import does — the
// finding's heading becomes that line at parse), and JSON findings
// usually carry a one-paragraph description that stands in for one.
// So: the field when it's there, the first line otherwise.
//
// Single source for every surface that shows a finding by name — the
// card's bold heading, the table row, the kanban / focus-queue card,
// the pre-filled GitHub issue title, the markdown export — so a
// report's own title is what the reader sees in all of them or in
// none. The export marker comes off first: it's chrome the exports
// pipeline injects into the prose, not part of what the finding is
// called.
export function firstLine(text) {
  if (!text) return ''
  for (const line of text.split('\n')) {
    if (line.trim()) return line.trim()
  }
  return ''
}

export function findingTitle(f) {
  const own = typeof f?.title === 'string' ? f.title.trim() : ''
  return own || firstLine(stripExportMarker(f?.description, f))
}

// Title + body for a heading-over-body layout.
//
// With a `title` field the split is already made — the whole
// description is body. The one adjustment is a description whose first
// line REPEATS the title (a report carrying the heading in both
// places): printing it as the heading and again as the body's opening
// line reads as a stutter, so an exact repeat is dropped.
//
// Without one, the description's first line is the title — but only
// when there's a non-empty body under it. A single-line description
// stays whole as plain body, so JSON findings whose description is one
// paragraph aren't jarringly bolded; and a description that OPENS on a
// fence keeps its first line, since lifting that line out would leave
// the code block unopened and render its code as prose under a
// `` ```ts `` heading.
export function splitDescription(f) {
  const text = stripExportMarker(f?.description, f) || ''
  const own = typeof f?.title === 'string' ? f.title.trim() : ''
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

// The description with the finding's name in front of it — the shape a
// format WITHOUT a `title` field writes it in, since there the name IS
// the first line. For the surfaces that show one text blob per finding
// rather than a heading over a body. A finding that carries no `title`
// gets its description back untouched.
export function titledDescription(f) {
  const own = typeof f?.title === 'string' ? f.title.trim() : ''
  if (!own) return stripExportMarker(f?.description, f) || ''
  const { body } = splitDescription(f)
  return body ? `${own}\n\n${body}` : own
}

// ── Description sections ─────────────────────────────────────────────
// Split a description body into the sections the report wrote it in.
// A paragraph that OPENS with a `**Label:**` prefix is one: that is how
// every parser emits its narrative fields — parse-piolium's `**Root
// Cause:**` / `**Severity note:**` / `**Note:**` and friends (any label
// the source report carried), parse-md's `**Impact:**` /
// `**Reproduction:**` — so keying off the emitted markup, rather than
// matching label words, picks up whatever a report names its sections.
//
// Everything else is prose: consecutive unlabelled paragraphs stay in
// ONE block so their blank-line spacing survives. A label with nothing
// after it keeps its header and gets an empty body. Returns
// `[{ label, body }]` in document order, `label` null for prose.
const SECTION_LABEL_RE = /^\*\*([^*\n]+):\*\*[ \t]*/u

// Paragraph split — blank lines, but only the ones OUTSIDE a fenced
// code block. A snippet may carry blank lines of its own, and cutting
// there would tear the block in two: the opening fence would end up in
// one section and the closing one in the next, so neither half renders
// as code and both show their bare fence markers.
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
// `file:line` — the shape every location display uses, with the line
// dropped when there isn't a finite one ('?' on the imports that carry
// no line numbers). Takes a finding or an evidence row: both carry
// `file` / `line`, and both print the location the same way. The raw
// `line` goes through, so a range (`10-20`) survives whole.
export function locationLabel(x) {
  return Number.isFinite(parseInt(x?.line, 10)) ? `${x.file}:${x.line}` : (x?.file ?? '')
}

// An evidence row's note. `text` is what parse-md.js writes (the lines a
// markdown report left under the reference); `observation` is the name
// a JSON report may use for the same thing. A row carrying BOTH is not
// a shape any producer here emits, but it costs nothing to read: the
// observation leads and the text follows under it, rather than one
// silently winning. Non-string values are ignored — this reads
// whatever JSON an importer hands us.
export function evidenceNote(row) {
  const str = (v) => (typeof v === 'string' ? v : '')
  return `${str(row?.observation)}\n${str(row?.text)}`.trim()
}
