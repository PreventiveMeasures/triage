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
//   // → { format, source, type, findings: [ … with ids ] } | null
//
// Four entry points, in rising order of how much they do:
//
//   detectFormat  — name the format, parse nothing further
//   analyzeReport — how many entries, and from which producer
//   readReport    — the parsed report object + why it failed, if it did
//   loadFindings  — parsed, flattened, and every finding carrying an id
//
// `parseReport` is `readReport` with the diagnosis dropped, kept as the
// short form the app's callers use.
//
// The pieces stay importable on their own — `report/parse-md.js`,
// `report/md-structure.js`, `report/finding-id.js` — for tests, and for
// a caller that wants one helper without pulling the chain in behind it
// (ui/view/format.js does exactly that: it rides a lazily-loaded bundle
// and takes only the markdown structure helpers).
//
// Nothing under this directory touches the DOM, app state or storage:
// text in, data out. That is what makes it reusable outside the viewer
// — the analyzer stamps its ids with the same `findingId` the viewer
// derives them with, so both sides agree on what a finding IS.

import { parseCodexCsvToScans } from './parse-codex.js'
import { parseDeepsecFindings } from './parse-deepsec.js'
import { parseMarkdownFindings } from './parse-md.js'
import { parsePioliumFindings } from './parse-piolium.js'
import { computeFileHash, deriveFindingId, findingId } from './finding-id.js'
import { META_FIELDS, inheritReportMeta, reportRepoGithub } from './meta.js'

// The whole surface, re-exported so a consumer needs one import even
// when it wants a specific parser or the id helpers.
export { parseCodexCsvToScans, parseDeepsecFindings, parseMarkdownFindings, parsePioliumFindings }
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

// Parse `content` in whichever format it turns out to be, and say which
// one that was. JSON first — the analyzer's native dump is the common
// case and the only format with a cheap, total test — then the markdown
// chain when `JSON.parse` throws.
//
// Returns `{ data, format, jsonError }`. `data` is null when nothing
// recognised the text, and `jsonError` is the `JSON.parse` failure that
// sent us down the markdown chain: a caller reporting "this file isn't
// a report" wants it, since the usual cause is a truncated or malformed
// JSON dump rather than an unknown format.
export function readReport(content) {
  let jsonError = null
  try {
    return { data: JSON.parse(content), format: 'json', jsonError }
  } catch (err) {
    jsonError = err
  }
  for (const [format, parse] of MARKDOWN_FORMATS) {
    const data = parse(content)
    if (data) return { data, format, jsonError }
  }
  return { data: null, format: null, jsonError }
}

// The parsed report object, or null when unrecognised. Callers read the
// field they need (`findings`, `groups`, `source`, `type`).
export function parseReport(content) {
  return readReport(content).data
}

// Which producer wrote `content` — 'json' / 'deepsec' / 'piolium' /
// 'claude-security', or null when nothing recognises it.
export function detectFormat(content) {
  return readReport(content).format
}

// How many entries `content` holds and who produced it, without
// flattening anything or deriving a single id — what a file list wants
// for a badge next to a name.
//
// `count` is ENTRIES, not findings: an entry in `findings[]` is either
// one finding or a pre-deduplicated group of them, and the count that
// matches what a user sees as rows is the entry count. A valid JSON
// document with no `findings[]` array counts as unrecognised rather
// than as an empty report — it is far more likely to be some other
// JSON file than a report with nothing in it — and, being valid JSON,
// it never reaches the markdown chain either.
export function analyzeReport(content) {
  try {
    const data = JSON.parse(content)
    if (data && Array.isArray(data.findings)) {
      return { count: data.findings.length, source: data.source, recognized: true }
    }
    return { count: 0, recognized: false }
  } catch {}
  for (const [, parse] of MARKDOWN_FORMATS) {
    const data = parse(content)
    if (data) return { count: data.findings.length, source: data.source, recognized: true }
  }
  return { count: 0, recognized: false }
}

// A report's `findings` (or `groups`) entry is either a single Finding
// or a pre-grouped Finding[]; flatten to the member findings, dropping
// falsy entries.
export function flattenFindings(list) {
  const out = []
  for (const entry of list ?? []) {
    const members = Array.isArray(entry) ? entry : [entry]
    for (const f of members) if (f) out.push(f)
  }
  return out
}

// Fill in `f.id` for any finding that lacks one, deriving it from the
// (severity, description, file, line, fileHash) fingerprint. Mutates in
// place. Findings whose id can't be derived (a host without
// crypto.subtle) are left untouched. Batched via Promise.all —
// sequential awaits would serialise hundreds of crypto.subtle.digest
// calls for no reason.
export async function backfillFindingIds(findings) {
  const idLess = findings.filter((f) => f && !f.id)
  if (idLess.length === 0) return
  const derived = await Promise.all(idLess.map(deriveFindingId))
  idLess.forEach((f, i) => { if (derived[i]) f.id = derived[i] })
}

// Recognise, flatten, and give every finding an id — the whole read
// path in one call, for a consumer that just wants the findings out of
// a file. Returns null when nothing recognises the text.
//
// The findings are the parser's own objects (not copies), so a caller
// that means to keep them can, and one that means to project run meta
// onto them has `inheritReportMeta` to hand. `report` is the parsed
// document itself, for the fields this shape doesn't lift out.
export async function loadFindings(content) {
  const { data, format } = readReport(content)
  if (!data) return null
  const findings = flattenFindings(data.findings ?? data.groups)
  await backfillFindingIds(findings)
  return { format, source: data.source, type: data.type, findings, report: data }
}
