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
import { parseMarkdownFindings } from '../common/parse-md.js'
import { parseDeepsecFindings } from '../common/parse-deepsec.js'

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
      return { count: data.findings.length, source: data.source, recognized: true }
    }
  } catch {}
  const ds = parseDeepsecFindings(content)
  if (ds) return { count: ds.findings.length, source: ds.source, recognized: true }
  const md = parseMarkdownFindings(content)
  if (md) return { count: md.findings.length, source: md.source, recognized: true }
  return { count: 0, recognized: false }
}

// Walk a list of names and populate the cache for any not yet known.
// `onUpdate(name, count)` fires after each file lands so the sidebar
// can re-render incrementally; files that error during read are
// skipped — the sidebar will fall back to no badge.
//
// Concurrency model: at most ONE active walk at a time. While a walk
// is in progress, additional `ensureCounts` calls union their `names`
// into the active run's pending set; when the active loop finishes
// its current iteration it picks up any new names that were enqueued.
// Previous shape used a re-entrance flag that simply DROPPED the
// nested call — a workspace switch firing `ensureCounts(namesB)`
// while an earlier sidebar render's `ensureCounts(namesA)` was still
// running would silently skip every name only in B. Audit round-8 H2.
let activeRun = null
let activePending = null   // Set<name> queued during the current run
let activeOnUpdate = null  // most-recent onUpdate wins (cheap renderer redraw)

export function ensureCounts(names, onUpdate) {
  if (activeRun) {
    if (onUpdate) activeOnUpdate = onUpdate
    for (const n of names) activePending.add(n)
    return activeRun
  }
  activePending = new Set(names)
  activeOnUpdate = onUpdate ?? null
  activeRun = (async () => {
    try {
      const c = load()
      // Walk-and-drain: pull from `activePending` until empty, since
      // new names can be enqueued mid-walk by re-entrant ensureCounts
      // calls. Set iteration is order-preserving in JS, but we delete
      // as we go so the next iteration sees only undone names.
      while (activePending.size > 0) {
        const n = activePending.values().next().value
        activePending.delete(n)
        if (c[n] !== undefined) continue
        try {
          const content = await readFile(n)
          const { count, source } = analyzeContent(content)
          c[n] = source ? { count, source } : { count }
          persist()
          if (activeOnUpdate) activeOnUpdate(n, count)
        } catch {
          // Leave missing — the sidebar omits the badge for unknown counts.
        }
      }
    } finally {
      activeRun = null
      activePending = null
      activeOnUpdate = null
    }
  })()
  return activeRun
}
