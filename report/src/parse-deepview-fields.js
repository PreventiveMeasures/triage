// The readers for one case of the DeepView markdown document — the
// fact list under a finding's heading, the sections under that, the
// evidence list, and the description they add up to. The document side
// (which section is a finding, which `####` is a case) lives in
// parse-deepview-md.js; this module knows how write-md-finding.js spelt
// each value, and hands it back into the field it was read from.
//
// Every reader is the inverse of a writer: `readLocation` of
// locationText, `readSeverity` of severityText, `readAnalyzer` of
// analyzerText, `readEvidence` of evidenceList — and `narrativeSplit`
// undoes the one thing the writer folds: a `**Label:**` paragraph the
// description carried and a field of the same name both became a
// section, and which was which is settled by where the writer put them
// (the fields come last, in a fixed order).

import { REVALIDATE_KINDS, firstLine } from './finding.js'
import { SEVERITY_LABELS, SOURCE_LABELS } from './labels.js'
import { fenceRanges, inFence } from './md-structure.js'
import { isHttpUrl, unescapeHeadings } from './md-text.js'

// label (case-folded) → key, for the words the writer spells the app's
// enumerations with (labels.js).
const SEVERITY_KEYS = new Map(Object.entries(SEVERITY_LABELS).map(([k, v]) => [v.toLowerCase(), k]))
const SOURCE_KEYS = new Map(Object.entries(SOURCE_LABELS).map(([k, v]) => [v.toLowerCase(), k]))
const REVALIDATE_SET = new Set(REVALIDATE_KINDS)

// ── Inline forms ─────────────────────────────────────────────────────

// The content of the first code span in `s`, or null when it has none.
// The fence is as many backticks as the writer needed to quote the
// content (md-text.js code) — always more than any run inside it, so
// the first closing run of that length is the fence — and a space of
// padding on each side when the content itself starts or ends on one.
export function codeSpan(s) {
  const m = /(`+)(.+?)\1(?!`)/u.exec(String(s ?? ''))
  if (!m) return null
  const inner = m[2]
  if (inner.length > 2 && inner.startsWith(' ') && inner.endsWith(' ')) {
    const unpadded = inner.slice(1, -1)
    if (unpadded.startsWith('`') || unpadded.endsWith('`')) return unpadded
  }
  return inner
}

// A markdown link at the start of `s` — `[label](url)`, the URL in
// angle brackets when the writer had to (md-text.js link). The label
// may hold a code span with brackets of its own, so it is read lazily
// up to the `](` a destination follows.
export function readLink(s) {
  const m = /^\[(.*?)\]\((?:<([^>]*)>|([^)\s]*))\)/u.exec(String(s ?? ''))
  return m ? { label: m[1], url: m[2] ?? m[3] } : null
}

// A bare `<url>` autolink (md-text.js autolink), or null.
function autolinkUrl(s) {
  const m = /^<(https?:[^>\s]*)>$/u.exec(s.trim())
  return m ? m[1] : null
}

// `file:line` back into its two fields — the line a number or a
// `10-20` range, `?` when the label carried none (finding.js
// locationLabel).
function fileLine(label) {
  const m = /^(.+):(\d+(?:-\d+)?)$/u.exec(label)
  return m ? { file: m[1], line: m[2] } : { file: label, line: '?' }
}

// `exportName.methodName` back into the two names, or the one name
// (finding.js findingDisplayName). A name with no dot is an export.
function exportNames(name) {
  const dot = name.indexOf('.')
  return dot > 0 ? { exportName: name.slice(0, dot), methodName: name.slice(dot + 1) } : { exportName: name }
}

// A tier's key from the word the writer spelt it with; a tier the
// ladder doesn't know was printed as itself and comes back as itself.
export function tierOf(label) {
  const t = String(label ?? '').trim()
  return SEVERITY_KEYS.get(t.toLowerCase()) ?? t
}

// ── The facts ────────────────────────────────────────────────────────

// `[`src/a.js:7`](url) · `Foo.bar`` — the reference, linked or not,
// then the export it sits in (write-md-finding.js locationText). The
// link is the report's own location link (finding.js: `location`),
// which the card links to in preference to anything reconstructed.
export function readLocation(value) {
  const out = {}
  let s = value.trim()
  const named = / · (`+)(.+?)\1$/u.exec(s)
  if (named) {
    Object.assign(out, exportNames(codeSpan(named[0])))
    s = s.slice(0, named.index)
  }
  const link = readLink(s)
  const label = codeSpan(link ? link.label : s)
  if (label !== null) Object.assign(out, fileLine(label))
  if (link && isHttpUrl(link.url)) out.location = link.url
  return out
}

const CRITICAL_FLAG = ' · flagged critical by the analyzer'
const VARIES = ' (varies across reports — '

// `High — corrected from Medium (varies across reports — …) · flagged
// critical by the analyzer` back into severity / correctedSeverity /
// critical (write-md-finding.js severityText). Under the original lens
// the line reads `Medium — corrected to High`; either way it says which
// is which. The per-report variants are the viewer's own bookkeeping
// of a workspace merge, not a finding's field.
export function readSeverity(value) {
  const out = {}
  let s = value.trim()
  if (s.endsWith(CRITICAL_FLAG)) {
    out.critical = true
    s = s.slice(0, -CRITICAL_FLAG.length)
  }
  const varies = s.indexOf(VARIES)
  if (varies !== -1) s = s.slice(0, varies)
  const m = /^(.*?) — corrected (from|to) (.*)$/u.exec(s)
  if (!m) {
    out.severity = tierOf(s)
  } else if (m[2] === 'from') {
    out.severity = tierOf(m[3])
    out.correctedSeverity = tierOf(m[1])
  } else {
    out.severity = tierOf(m[1])
    out.correctedSeverity = tierOf(m[3])
  }
  return out
}

// The reasoning-effort ladder and the import modes a run is described
// with (ui/view/analyzer-tags.js orders the same words) — closed
// vocabularies, which is what lets a run's line be read back by
// position: `<type> · [revalidate] · <model> · <effort> · <mode>`, an
// absent part elided (finding.js runMetaLine).
const EFFORTS = new Set(['max', 'xhigh', 'high', 'medium', 'low', 'minimal'])
const IMPORT_MODES = new Set(['list', 'isolate'])

// A model's pretty name carries a version — `opus 5`, `gpt 5.5` — or
// at least a family; a mode (`security`, `correctness`) carries
// neither. Consulted only when the line leaves one free word, whose
// slot is otherwise ambiguous.
function looksLikeModel(word) {
  return /\d/u.test(word) || /^(?:opus|sonnet|haiku|gpt|gemini|fable|mythos|llama|mistral)\b/iu.test(word)
}

// What produced a finding (write-md-finding.js analyzerText): a
// product's name, back into its `source` key — or the run's meta line,
// back into the run's fields.
export function readAnalyzer(value) {
  const s = value.trim()
  const source = SOURCE_KEYS.get(s.toLowerCase())
  if (source) return { source }
  const run = {}
  const free = []
  for (const word of s.split(' · ').map((w) => w.trim()).filter(Boolean)) {
    if (word === 'revalidate' && !run.revalidate) run.revalidate = 'revalidation'
    else if (IMPORT_MODES.has(word) && !run.exportsMode) run.exportsMode = word
    else if (EFFORTS.has(word) && !run.effort) run.effort = word
    else free.push(word)
  }
  if (free.length > 1) [run.type, run.model] = free
  else if (free.length === 1) run[looksLikeModel(free[0]) ? 'model' : 'type'] = free[0]
  return { run }
}

// A repository reference (write-md-finding.js repoRef): the slug of a
// github.com link, a bare URL, or the text as it was.
export function readRepository(value) {
  const s = value.trim()
  const link = readLink(s)
  if (link) return link.label.trim()
  return autolinkUrl(s) ?? s
}

// The introducing commit (commitText): linked, the short hash in the
// label and the whole one at the end of the URL; unlinked, the hash in
// a code span.
function readCommit(value) {
  const link = readLink(value.trim())
  if (link) {
    const tail = link.url.split('/').at(-1) ?? ''
    if (/^[0-9a-f]{7,64}$/iu.test(tail)) return tail
    return codeSpan(link.label) ?? tail
  }
  return codeSpan(value) ?? value.trim()
}

// `name@version` in a code span, back into the npm package a
// dependency finding sits in.
function readPackage(value) {
  const s = codeSpan(value) ?? value.trim()
  const at = s.lastIndexOf('@')
  return { npm: at > 0 ? { name: s.slice(0, at), version: s.slice(at + 1) } : { name: s } }
}

// The revalidation stamp (metaList): the pass's own row is named in
// words, a verdict by its kind.
function readRevalidation(value) {
  const s = value.trim().toLowerCase()
  if (s === 'the revalidation pass itself') return 'revalidation'
  return REVALIDATE_SET.has(s) ? s : undefined
}

// One fact back onto the finding, keyed by the label the writer gave
// it (write-md-finding.js metaList, PLAIN_FIELDS, CODE_FIELDS). Not
// here: `Analyzer`, which the document settles for all findings at
// once (parse-deepview-md.js); `Triage` / `Fix` (and the `Comment`
// section), the reader's annotations, which live in the viewer's
// triage store keyed by the id and follow the id; and `Report`, which
// names the file a case came from — now this one.
const FACT_READERS = new Map([
  ['location', (f, v) => Object.assign(f, readLocation(v))],
  ['severity', (f, v) => Object.assign(f, readSeverity(v))],
  ['confidence', (f, v) => { const m = /^(\d+(?:\.\d+)?)\/10$/u.exec(v); if (m) f.confidence = Number(m[1]) }],
  ['revalidation', (f, v) => { const kind = readRevalidation(v); if (kind) f.revalidate = kind }],
  ['revalidated by', (f, v) => { const s = v.trim(); if (s) f.revalidateSource = SOURCE_KEYS.get(s.toLowerCase()) ?? s }],
  ['repository', (f, v) => { f.repo = { github: readRepository(v) } }],
  ['introduced in', (f, v) => { f.commitHash = readCommit(v) }],
  ['package', (f, v) => { f.package = readPackage(v) }],
  ['priority', (f, v) => { f.priority = /^-?\d+(?:\.\d+)?$/u.test(v) ? Number(v) : v }],
  ['found while analyzing', (f, v) => { f.discoveredIn = codeSpan(v) ?? v }],
  ['detailed report', (f, v) => { f.reportPath = codeSpan(v) ?? v }],
  ['commit audited', (f, v) => { f.auditedCommit = codeSpan(v) ?? v }],
  ['id', (f, v) => { f.id = codeSpan(v) ?? v }],
  ...[
    ['category', 'category'], ['status', 'status'], ['branch', 'branch'],
    ['date created', 'dateCreated'], ['detected at', 'detectedAt'], ['committed at', 'committedAt'],
    ['poc status', 'pocStatus'], ['variant of', 'parent'], ['slug', 'slug'],
  ].map(([label, field]) => [label, (f, v) => { f[field] = v }]),
])

export function applyFact(f, label, value) {
  const read = FACT_READERS.get(label.trim().toLowerCase())
  if (read) read(f, value.trim())
}

// ── The shape under a heading ────────────────────────────────────────

const FACT_RE = /^- \*\*([^*\n]+?):\*\* ?(.*)$/u

// The fact list at the top of a case: consecutive `- **Label:** value`
// lines. A paragraph BEFORE the list is the case's own title — written
// for a case of a group named differently from its group
// (write-md-finding.js groupSection) — but only when a list follows;
// a case with no facts at all keeps its opening paragraph as prose.
// Prose comes back with the writer's heading escape taken off
// (md-text.js prose / unescapeHeadings) — the title here, an evidence
// note in readEvidence, the lead and the sections' bodies where the
// document reader consumes them (readProse) — so `\## Internal
// detail` is the `## Internal detail` the description held.
export function splitFacts(body) {
  const lines = body.split('\n')
  let i = 0
  const skipBlank = () => { while (i < lines.length && !lines[i].trim()) i++ }
  const readFacts = () => {
    const facts = []
    while (i < lines.length) {
      const m = FACT_RE.exec(lines[i])
      if (!m) break
      facts.push([m[1].trim(), m[2].trim()])
      i++
    }
    return facts
  }
  skipBlank()
  let facts = readFacts()
  if (facts.length > 0) return { title: '', facts, rest: lines.slice(i).join('\n') }
  const para = []
  while (i < lines.length && lines[i].trim()) para.push(lines[i++])
  skipBlank()
  facts = readFacts()
  if (facts.length === 0) return { title: '', facts, rest: body }
  return { title: readProse(para.join('\n').trim()), facts, rest: lines.slice(i).join('\n') }
}

// A run of prose as the description held it: the writer's heading
// escape off, when the document's writer put one on.
export function readProse(text) {
  return unescapeHeadings(text)
}

// A case's sections at `depth` (4 under a finding's heading, 5 under a
// case's): the lead before the first heading and `[{ label, body }]`
// after it — outside fences only, so a `#### ` line in a snippet stays
// in the snippet.
export function splitSections(text, depth) {
  const re = new RegExp(`^#{${depth}} +(.*)$`, 'gmu')
  const ranges = fenceRanges(text)
  const marks = [...text.matchAll(re)].filter((m) => !inFence(ranges, m.index))
  const lead = text.slice(0, marks[0]?.index ?? text.length).trim()
  const sections = marks.map((m, i) => ({
    label: m[1].trim(),
    body: text.slice(m.index + m[0].length, marks[i + 1]?.index).trim(),
  }))
  return { lead, sections }
}

const ITEM_RE = /^(\d+)\. (.*)$/u

// The evidence list (write-md-finding.js evidenceList): a loose
// numbered list, each item's note on the lines under it, indented to
// the item's text. Back into rows of `{ file, line, url, text }` — the
// note under the name parse-md.js gives it, whatever a native dump
// called it (finding.js evidenceNote reads both).
export function readEvidence(text) {
  const items = []
  const ranges = fenceRanges(text)
  let pos = 0
  for (const line of text.split('\n')) {
    const m = inFence(ranges, pos) ? null : ITEM_RE.exec(line)
    pos += line.length + 1
    if (m) items.push({ ref: m[2].trim(), indent: m[1].length + 2, note: [] })
    else if (items.length > 0) items.at(-1).note.push(line)
  }
  return items.map((item) => evidenceRow(item))
}

function evidenceRow({ ref, indent, note }) {
  const row = {}
  const link = readLink(ref)
  const auto = autolinkUrl(ref)
  const label = auto === null ? codeSpan(link ? link.label : ref) : null
  if (label !== null) Object.assign(row, fileLine(label))
  const url = link ? link.url : auto
  if (isHttpUrl(url)) row.url = url
  const text = readProse(note.map((l) => l.slice(Math.min(indent, /^ */u.exec(l)[0].length))).join('\n').trim())
  if (text) row.text = text
  return row
}

// ── The narrative ────────────────────────────────────────────────────

// The narrative fields the writer gives their own sections, in the
// order it writes them (write-md-finding.js NARRATIVE) — AFTER the
// sections the description's own `**Label:**` paragraphs became.
const NARRATIVE = new Map([
  ['impact', 'impact'], ['reproduction', 'reproduction'], ['recommendation', 'recommendation'],
  ['confidence reasoning', 'confidenceReason'], ['revalidation verdict', 'revalidateVerdict'],
  ['revalidation recommendation', 'revalidateRecommendation'],
])
const NARRATIVE_ORDER = [...NARRATIVE.keys()]

// Which sections were fields and which were the description's own. The
// writer prints the description's labelled paragraphs first, whatever
// they are called, then the fields in NARRATIVE order — so the fields
// are the longest run of narrative labels in that order at the END,
// and every section before it goes back into the description as the
// `**Label:**` paragraph it was. A report that wrote `**Impact:**` into
// its prose thus comes back with an `impact` field where a native dump
// would have one — the card and the writer read the two alike — while
// a `**Root Cause:**` paragraph, and any `**Impact:**` written before
// it, stay paragraphs in their place, so a second export reads as the
// first did.
export function narrativeSplit(sections) {
  let start = sections.length
  let last = Infinity
  for (let i = sections.length - 1; i >= 0; i--) {
    const rank = NARRATIVE_ORDER.indexOf(sections[i].label.toLowerCase())
    if (rank === -1 || rank >= last) break
    last = rank
    start = i
  }
  return {
    paragraphs: sections.slice(0, start),
    fields: sections.slice(start).map((s) => [NARRATIVE.get(s.label.toLowerCase()), s.body]),
  }
}

// The description back from its parts: the heading's text as the first
// line — unless the lead already opens with it, which is how a name too
// long for a heading was carried (write-md-finding.js
// descriptionBlocks) — then the lead, then the description's own
// labelled paragraphs, the way every parser writes them. No heading
// text (a finding the writer could only head by its location) leaves
// the lead to speak for itself.
export function buildDescription(title, lead, paragraphs) {
  const parts = []
  const first = firstLine(lead)
  const cut = title.endsWith('…') ? title.slice(0, -1).trimEnd() : ''
  if (!title || first === title || (cut && first.startsWith(cut))) parts.push(lead)
  else parts.push(title, lead)
  for (const { label, body } of paragraphs) parts.push(body ? `**${label}:** ${body}` : `**${label}:**`)
  return parts.filter(Boolean).join('\n\n')
}
