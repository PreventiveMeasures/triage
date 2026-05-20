// Turning a stored report's raw content into findings. The same three
// steps — recognise the format, flatten grouped entries, backfill
// missing finding ids — are needed by the finding index, the triage GC
// walk, and the workspace export / import paths. Centralised here as
// composable helpers so those callers can't drift on which formats they
// accept or how they derive ids.
//
// NOTE: `counts.js` deliberately keeps its own dispatch — it counts
// entries (not flattened members), treats valid-but-findingless JSON as
// unrecognised, and never derives ids. Don't fold it in here.

import { parseDeepsecFindings } from './parse-deepsec.js'
import { parseMarkdownFindings } from './parse-md.js'
import { deriveFindingId } from './finding-id.js'

// Parse report `content` into its `{ findings, source, ... }` object:
// analyzer-native JSON first, falling back to the DeepSec / Claude-
// security markdown parsers when `JSON.parse` throws. Returns the parsed
// object (callers read the field they need — `findings`, `groups`,
// `source`) or null/undefined when unrecognised.
export function parseReport(content) {
  try {
    return JSON.parse(content)
  } catch {
    return parseDeepsecFindings(content) ?? parseMarkdownFindings(content)
  }
}

// A report's `findings` (or `groups`) entry is either a single Finding
// or a pre-grouped Finding[]; flatten to the member findings, dropping
// falsy entries.
export function flattenFindings(list) {
  const out = []
  for (const entry of list) {
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
