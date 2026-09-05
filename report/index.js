// The report library — one door to every report format this project
// reads.
//
// A "report" is whatever an analyzer wrote: the JSON dump this
// project's own analyzer emits, or one of the shapes other tools
// produce — DeepSec and Piolium markdown, Claude Security markdown,
// Codex CSV. The parsers beside this file each recognise exactly one of
// those and know nothing about each other; this module is the dispatch
// over them, so "which formats do we read, and in what order" is
// answered in one place instead of once per call site.
//
//   import { loadFindings } from '../report/index.js'
//   const report = await loadFindings(text)
//   // → { format, data, findings: [ … with ids ] } | null
//
// Three entry points, in rising order of how much they do:
//
//   detectFormat  — name the format, parse nothing further
//   readReport    — the parsed report, or the reason it isn't one
//   loadFindings  — parsed, flattened, and every finding carrying an id
//
// `analyzeReport` is `readReport` for a file list — entry count and
// producer — and `backfillFindingIds` is the id step on its own, for a
// caller that has to interleave something with it.
//
// Codex is the one format the content doesn't name: its export is a
// CSV, and a CSV is a container — one row per finding across several
// scans — rather than a report. `detectFormat` recognises it by the
// FILENAME (`.csv`) when given one; the readers are single-report and
// don't take it. A codex export goes through `parseCodexCsvToScans`,
// which splits it into one JSON-shaped report per scan, and each of
// those reads through the readers like any other JSON report.
//
// The pieces stay importable on their own — `report/parse-md.js`,
// `report/md-structure.js`, `report/finding-id.js` — for tests, and for
// a caller that wants one helper without pulling the chain in behind it
// (ui/view/format.js does exactly that: it rides a lazily-loaded bundle
// and takes only the markdown structure helpers). Through the package
// name the same files are `@preventive/report/parse-md.js` and so on.
//
// This directory is its own package (see package.json beside this
// file) and imports nothing outside itself: no DOM, no app state, no
// storage, nothing from the rest of the repo. Text in, data out. That
// is what makes it reusable outside the viewer — the analyzer stamps
// its ids with the same `findingId` the viewer derives them with, so
// both sides agree on what a finding IS — and `node --test` in this
// directory runs its suite with nothing else installed.

import { parseCodexCsvToScans } from './parse-codex.js'
import { parseDeepsecFindings } from './parse-deepsec.js'
import { parseMarkdownFindings } from './parse-md.js'
import { parsePioliumFindings } from './parse-piolium.js'
import { computeFileHash, deriveFindingId, findingId } from './finding-id.js'
import { META_FIELDS, inheritReportMeta, reportRepoGithub } from './meta.js'

// The rest of the surface, so a consumer needs one import: the codex
// splitter, the id helpers the analyzer shares with the viewer, and the
// run-meta projection a caller applies to the findings it loads.
export { parseCodexCsvToScans }
export { computeFileHash, deriveFindingId, findingId }
export { META_FIELDS, inheritReportMeta, reportRepoGithub }

// The markdown chain, in dispatch order: tightest guard first. DeepSec
// keys off `## SEVERITY (n)` and Piolium off its `# Security Audit
// Report` / `## Technical Findings Detail` headings, while parse-md
// accepts any `# Title` document — so it has to stay last or it would
// swallow the other two. Each returns the standard `{ type, findings,
// … }` shape, or null when the text isn't its format.
//
// `format` is this library's name for the producer. It matches the
// `source` marker the markdown parsers stamp on what they return, which
// is what the viewer reads for its header label; 'json' has no marker
// (the analyzer's own dump carries `type` instead).
const MARKDOWN_FORMATS = [
  ['deepsec', parseDeepsecFindings],
  ['piolium', parsePioliumFindings],
  ['claude-security', parseMarkdownFindings],
]

// A report's entries: `findings`, or `groups` for a pre-deduplicated
// dump. Each entry is one finding or a Finding[] group. Null when the
// document carries neither as an array — which is how a JSON file that
// isn't a report at all (or a report with a malformed list) is told
// apart from an empty one.
function entriesOf(data) {
  if (Array.isArray(data?.findings)) return data.findings
  if (Array.isArray(data?.groups)) return data.groups
  return null
}

// Which producer wrote `content` — 'json' / 'deepsec' / 'piolium' /
// 'claude-security' / 'codex', or null when nothing recognises it.
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
    if (entriesOf(data)) return { data, format: 'json', reason: null }
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
  return { count: entriesOf(data).length, source: data.source, recognized: true }
}

// Entries → member findings. A group contributes its members; falsy
// and non-object entries (a malformed list's stray strings and nulls)
// are dropped rather than handed on as findings.
function flattenFindings(entries) {
  const out = []
  for (const entry of entries) {
    for (const f of Array.isArray(entry) ? entry : [entry]) {
      if (f && typeof f === 'object') out.push(f)
    }
  }
  return out
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
  const findings = flattenFindings(entriesOf(data))
  await backfillFindingIds(findings)
  return { format, data, findings }
}
