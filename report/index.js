// The report library — one door to every report format this project
// reads, and to the one it writes.
//
// A "report" is whatever an analyzer wrote: the JSON dump this
// project's own analyzer emits, or one of the shapes other tools
// produce — DeepSec and Piolium markdown, Claude Security markdown,
// Codex CSV — or the markdown document this library itself writes
// (write-md.js), read back by parse-deepview-md.js. The parsers beside
// this file each recognise exactly one of those and know nothing about
// each other; this module is the dispatch over them, so "which formats
// do we read, and in what order" is answered in one place instead of
// once per call site.
//
//   import { loadFindings, writeMarkdown } from '../report/index.js'
//   const report = await loadFindings(text)
//   // → { format, data, findings: [ … with ids ] } | null
//   const md = writeMarkdown({ title, groups: report.findings.map((f) => [f]) })
//
// Three entry points for reading, in rising order of how much they do:
//
//   detectFormat  — name the format, parse nothing further
//   readReport    — the parsed report, or the reason it isn't one
//   loadFindings  — parsed, flattened, and every finding carrying an id
//
// `analyzeReport` is `readReport` for a file list — entry count and
// producer — `reportEntries` is a report's entry list whichever of the
// two names it goes under (`findings` or `groups`), for a caller that
// has to keep the grouping rather than flatten it, and
// `backfillFindingIds` is the id step on its own, for a caller that
// has to interleave something with it.
//
// And one for writing: `writeMarkdown` takes findings — the parsers'
// own objects, grouped as the viewer groups them — with whatever the
// caller knows about the selection and the reader's annotations, and
// writes the markdown document the Download button saves (write-md.js
// for the document, write-md-finding.js for one finding, labels.js for
// the words). Both directions read a finding through finding.js, so
// what a parser produced and what the writer prints agree on what a
// finding IS — and the document is itself a report the readers above
// take (parse-deepview-md.js), so what was written can be loaded
// again, with the ids and fields it left with.
//
// Codex is the one format the content doesn't name: its export is a
// CSV, and a CSV is a container — one row per finding across several
// scans — rather than a report. `detectFormat` recognises it by the
// FILENAME (`.csv`) when given one; the readers are single-report and
// don't take it. A codex export goes through `parseCodexCsvToScans`,
// which splits it into one JSON-shaped report per scan, and each of
// those reads through the readers like any other JSON report.
//
// THIS FILE IS THE WHOLE SURFACE. The modules live in `src/` and the
// package exports one path — `@preventive/report`, this file — so
// everything a caller may hold is named here, in one list, and
// everything else is free to move, split or be renamed without
// breaking anyone. A consumer that wants `fenceRanges` or
// `findingTitle` imports it from here beside `loadFindings`; there is
// no second, deeper way in, inside this repo or out of it.
//
// That is a deliberate trade against the old shape, where every module
// was its own entry point. What it costs is the ability to reach past
// this list; what it buys is that the list IS the contract. Nothing is
// pulled in that a caller doesn't use: every module here is
// side-effect-free (`sideEffects: false` in package.json — the whole
// file is declarations), so a bundler drops what a caller never names,
// and `ui/view/format.js` still rides its lazily-loaded chunk.
//
// This directory is its own package (see package.json beside this
// file) and imports nothing outside itself: no DOM, no app state, no
// storage, nothing from the rest of the repo. Text in, data out — and
// data in, text out. That is what makes it reusable outside the
// viewer — the analyzer stamps its ids with the same `findingId` the
// viewer derives them with, so both sides agree on what a finding IS
// — and `node --test` in this directory runs its suite with nothing
// else installed — and nothing outside this directory reaches into it,
// tests included: every test of this library lives in `report/tests/`.
// Those come through the door like any other caller, except where they
// exercise an internal this file doesn't export; those name `../src/`,
// which is what they are testing.

import { parseDeepsecFindings } from './src/parse-deepsec.js'
import { parseDeepviewMarkdown } from './src/parse-deepview-md.js'
import { parseMarkdownFindings } from './src/parse-md.js'
import { parsePioliumFindings } from './src/parse-piolium.js'
import { deriveFindingId } from './src/finding-id.js'

// The rest of the surface, so a consumer needs one import: the codex
// splitter, the id helpers the analyzer shares with the viewer, and the
// run-meta projection a caller applies to the findings it loads.
export { parseCodexCsvToScans } from './src/parse-codex.js'
export { computeFileHash, deriveFindingId, findingId } from './src/finding-id.js'
export { META_FIELDS, inheritReportMeta, reportRepoGithub } from './src/meta.js'
// The writing side: the document writer, and the label tables it
// spells the app's enumerations with, for the viewer's surfaces that
// describe the same things in prose.
export { writeMarkdown } from './src/write-md.js'
export { COLOR_LABELS, SEVERITY_LABELS, SOURCE_LABELS, TRIAGE_LABELS, UPSTREAM_LABELS, severityLabel } from './src/labels.js'

// Reading a finding: what a finding IS, asked of one. The card, the
// row, the filters and the writer all ask the same questions of the
// same object — which tier does this display under, what is its name,
// where does it sit, what did the pass say about it — and they ask
// them here, so a parser's output and every surface that renders it
// can't drift on the answers.
export {
  REVALIDATE_KINDS, SEVERITIES, SEVERITY_ORDER, correctedVariants, descriptionSections,
  displayedSeverity, effectiveSeverity, evidenceNote, findingDisplayName, findingTitle,
  firstLine, hasSeverityCorrection, locationLabel, prettyModel, revalidateKindOf,
  runMetaLine, splitDescription, stripExportMarker, titledDescription,
} from './src/finding.js'

// The structural-markdown helpers, for a caller rendering the prose a
// parser handed back: where the fences are (so a `## ` inside a
// snippet stays in the snippet), and the escapes markdown puts on a
// name. The viewer's own markdown rendering (ui/view/format.js,
// export-view-chunks.js) reads the document's shape with these rather
// than keeping a second, subtly different set.
export { fenceRanges, inFence, unescapeMd } from './src/md-structure.js'
export { isHttpUrl } from './src/md-text.js'

// The markdown chain, in dispatch order: tightest guard first. This
// library's own document opens on a marker line no other format has;
// DeepSec keys off `## SEVERITY (n)` and Piolium off its `# Security
// Audit Report` / `## Technical Findings Detail` headings, while
// parse-md accepts any `# Title` document — so it has to stay last or
// it would swallow the others. Each returns the standard `{ type,
// findings, … }` shape, or null when the text isn't its format.
//
// `format` is this library's name for the document's producer. For the
// three foreign markdown formats it matches the `source` marker the
// parser stamps on what it returns, which is what the viewer reads for
// its header label. 'deepview-md' is the exception that proves the
// rule: the document is this library's, but its findings came from
// whichever producer the document names, and THAT is the `source` it
// carries back (none for the analyzer's own runs). 'json' has no
// marker (the analyzer's own dump carries `type` instead).
const MARKDOWN_FORMATS = [
  ['deepview-md', parseDeepviewMarkdown],
  ['deepsec', parseDeepsecFindings],
  ['piolium', parsePioliumFindings],
  ['claude-security', parseMarkdownFindings],
]

// A report's entries: `findings`, or `groups` for a pre-deduplicated
// dump. Each entry is one finding or a Finding[] group. Null when the
// document carries neither as an array — which is how a JSON file that
// isn't a report at all (or a report with a malformed list) is told
// apart from an empty one.
//
// Exported because a report is two shapes and only one of them is
// called `findings`: a caller reading `data.findings` alone sees an
// empty report wherever the entries are groups — which is every
// deduplicated dump, and every export of a view that merged a finding
// reported twice (parse-deepview-md.js writes `groups` for exactly
// those). `loadFindings` is the answer for a caller that wants the
// member findings; this is the one for a caller that has to keep the
// grouping, as the viewer's ingest does.
export function reportEntries(data) {
  if (Array.isArray(data?.findings)) return data.findings
  if (Array.isArray(data?.groups)) return data.groups
  return null
}

// Which producer wrote `content` — 'json' / 'deepview-md' / 'deepsec' /
// 'piolium' / 'claude-security' / 'codex', or null when nothing
// recognises it.
//
// `filename` is optional and decides only codex: a `.csv` is a codex
// export, and the content is not consulted for it (nothing in a CSV's
// text says whose it is, and no other format arrives as one). Every
// other format is named from the content alone, so a `.md` holding a
// JSON dump is 'json'. Case-insensitive on the extension; strip any
// download-duplicate suffix (`report (1).csv`) before calling if the
// name can carry one after the extension.
export function detectFormat(content, filename) {
  if (typeof filename === 'string' && /\.csv$/iu.test(filename)) return 'codex'
  return readReport(content).format
}

// Parse `content` in whichever format it turns out to be. JSON first —
// the analyzer's native dump is the common case and the only format
// with a cheap, total test — then the markdown chain when `JSON.parse`
// throws. A JSON document counts as a report only when it carries a
// `findings` (or `groups`) array: anything else that parses is some
// other JSON file, not an empty report.
//
// Returns `{ data, format, reason }`: the parsed report and its
// format, or `data: null` with `reason` saying why in one sentence —
// which a caller reporting "this file isn't a report" can show as is.
// The usual cause is a truncated or malformed JSON dump rather than an
// unknown format, so the JSON error rides along in that sentence.
export function readReport(content) {
  let jsonError
  try {
    const data = JSON.parse(content)
    if (reportEntries(data)) return { data, format: 'json', reason: null }
    return { data: null, format: null, reason: 'JSON, but not a report: no findings array' }
  } catch (err) {
    jsonError = err
  }
  for (const [format, parse] of MARKDOWN_FORMATS) {
    const data = parse(content)
    if (data) return { data, format, reason: null }
  }
  return {
    data: null,
    format: null,
    reason: `Not JSON, and not a recognized markdown format. (JSON error: ${jsonError.message})`,
  }
}

// How many entries `content` holds and who produced it, without
// flattening anything or deriving a single id — what a file list wants
// for a badge next to a name. `count` is ENTRIES, not findings: an
// entry is either one finding or a pre-deduplicated group of them, and
// the entry count is what a user sees as rows.
export function analyzeReport(content) {
  const { data } = readReport(content)
  if (!data) return { count: 0, recognized: false }
  return { count: reportEntries(data).length, source: data.source, recognized: true }
}

// Entries → member findings. A group contributes its members; falsy
// and non-object entries (a malformed list's stray strings and nulls)
// are dropped rather than handed on as findings.
function flattenFindings(entries) {
  return entries.flat().filter((f) => f && typeof f === 'object')
}

// Fill in `f.id` for any finding that lacks one, deriving it from the
// same fingerprint the analyzer stamps. Mutates in place. Findings
// whose id can't be derived (a host without crypto.subtle) are left
// untouched. Batched via Promise.all — sequential awaits would
// serialise hundreds of crypto.subtle.digest calls for no reason.
export async function backfillFindingIds(findings) {
  const idLess = findings.filter((f) => !f.id)
  if (idLess.length === 0) return
  const derived = await Promise.all(idLess.map(deriveFindingId))
  idLess.forEach((f, i) => { if (derived[i]) f.id = derived[i] })
}

// Recognise, flatten, and give every finding an id — the whole read
// path in one call. Returns `{ format, data, findings }`, or null when
// nothing recognises the text. The findings are the parser's own
// objects (not copies), so a caller that means to keep them can, and
// one projecting run meta onto them has `inheritReportMeta` and `data`
// to hand.
export async function loadFindings(content) {
  const { data, format } = readReport(content)
  if (!data) return null
  const findings = flattenFindings(reportEntries(data))
  await backfillFindingIds(findings)
  return { format, data, findings }
}
