// localStorage-backed cache of per-file finding counts. The sidebar
// renders a count pill on each file row; computing the count means
// reading + parsing the report, which is too expensive to do on
// every sidebar render. Counts are populated when a file is ingested
// (so the active file always has a fresh number) and lazy-filled
// for any pre-existing OPFS entries the first time the sidebar
// surfaces them. Cleared when a file is deleted.
//
// Stored as a single JSON blob under `deepview.fileCounts` so the
// whole map round-trips in one localStorage call. Misses return
// `undefined`, which the sidebar treats as "no badge yet" — the
// lazy fetch then runs in the background and re-renders when each
// count lands.
import { readFile } from './storage.js'
import { parseMarkdownFindings } from '../../common/parse-md.js'
import { parseDeepseekFindings } from '../../common/parse-deepseek.js'

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

export function getCount(name) {
  return load()[name]
}

export function setCount(name, n) {
  const c = load()
  c[name] = n
  persist()
}

export function removeCount(name) {
  const c = load()
  delete c[name]
  persist()
}

// Count entries in raw report content. Each `findings[]` entry may be
// a single Finding or a Finding[] (a pre-deduped group from an upstream
// pass) — the sidebar count reflects entries (matching what the user
// sees as rows in the table view), not flattened member findings. The
// markdown / deepseek parsers each return the standard
// `{ findings: [...] }` shape, so the same indexing applies after
// they run.
export function countFindings(content) {
  try {
    const data = JSON.parse(content)
    if (data && Array.isArray(data.findings)) return data.findings.length
  } catch {}
  const md = parseDeepseekFindings(content) ?? parseMarkdownFindings(content)
  return md?.findings?.length ?? 0
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
        const count = countFindings(content)
        c[n] = count
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
