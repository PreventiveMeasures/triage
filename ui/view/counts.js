// localStorage-backed cache of per-file finding counts and detected
// source kind. The sidebar renders a count pill on each file row and
// buckets files by source (DeepSec / Claude Security / …); both
// require parsing the report, which is too expensive to do on every
// sidebar render. Entries are populated when a file is ingested (so
// the active file is always fresh) and lazy-filled for any
// pre-existing OPFS entries the first time the sidebar surfaces
// them. Cleared when a file is deleted.
//
// Stored as a single JSON blob under `deepview.fileCounts`. Each entry
// is `{ count, source }`; legacy entries written before the source
// field existed were bare numbers, and `getCount` / `getKind` handle
// that shape transparently. Misses return `undefined`, which the
// sidebar treats as "no badge / unknown bucket yet" — the lazy fetch
// runs in the background and re-renders when each entry lands.
import { readFile } from './storage.js'
import { parseMarkdownFindings } from '../../common/parse-md.js'
import { parseDeepsecFindings } from '../../common/parse-deepsec.js'

const COUNTS_KEY = 'deepview.fileCounts'

let cache = null
function load() {
  if (cache) return cache
  try { cache = JSON.parse(localStorage.getItem(COUNTS_KEY) || '{}') } catch { cache = {} }
  return cache
}
function persist() {
  try { localStorage.setItem(COUNTS_KEY, JSON.stringify(cache)) } catch {}
}

// Normalize a cache entry to the `{ count, source }` shape. Legacy
// entries were bare numbers — accept those and treat the source as
// unknown. Returns `undefined` for unknown entries.
function entryOf(name) {
  const v = load()[name]
  if (v === undefined) return undefined
  if (typeof v === 'number') return { count: v }
  return v
}

export function getCount(name) {
  return entryOf(name)?.count
}

// Returns the cached source marker for a file, e.g. `'deepsec'` or
// `'claude-security'`. `undefined` means "not yet known" — the
// sidebar falls back to extension-based bucketing in that case.
export function getKind(name) {
  return entryOf(name)?.source
}

export function setCount(name, count, source) {
  const c = load()
  c[name] = source ? { count, source } : { count }
  persist()
}

export function removeCount(name) {
  const c = load()
  delete c[name]
  persist()
}

// Count entries in raw report content and identify the source format.
// Each `findings[]` entry may be a single Finding or a Finding[] (a
// pre-deduped group from an upstream pass) — the sidebar count
// reflects entries (matching what the user sees as rows in the table
// view), not flattened member findings. The markdown / deepsec
// parsers each return the standard `{ findings: [...] }` shape, so
// the same indexing applies after they run. `source` mirrors the
// parser's `data.source` ('deepsec' / 'claude-security') and is
// `undefined` for analyzer-native JSON dumps.
export function analyzeContent(content) {
  try {
    const data = JSON.parse(content)
    if (data && Array.isArray(data.findings)) {
      return { count: data.findings.length, source: data.source }
    }
  } catch {}
  const ds = parseDeepsecFindings(content)
  if (ds) return { count: ds.findings.length, source: ds.source }
  const md = parseMarkdownFindings(content)
  if (md) return { count: md.findings.length, source: md.source }
  return { count: 0 }
}

// Walk a list of names and populate the cache for any not yet known.
// `onUpdate(name, count)` fires after each file lands so the sidebar
// can re-render incrementally; files that error during read are
// skipped — the sidebar will fall back to no badge.
//
// The `running` flag is a re-entrance guard: each `onUpdate` call
// triggers a sidebar re-render, which in turn calls back into
// `ensureCounts(names)`. Without the guard those nested calls would
// fork their own sequential walks over the same `missing` list and
// re-fetch every later entry concurrently. With it, the nested call
// short-circuits and the outer loop stays the only fetcher; once it
// finishes, the next renderSidebar finds the cache fully populated
// and the function fast-paths to a no-op.
let running = false
export async function ensureCounts(names, onUpdate) {
  if (running) return
  running = true
  try {
    const c = load()
    for (const n of names) {
      if (c[n] !== undefined) continue
      try {
        const content = await readFile(n)
        const { count, source } = analyzeContent(content)
        c[n] = source ? { count, source } : { count }
        persist()
        if (onUpdate) onUpdate(n, count)
      } catch {
        // Leave missing — the sidebar omits the badge for unknown counts.
      }
    }
  } finally {
    running = false
  }
}
