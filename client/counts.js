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
import { getItem as getSecureItem, setItem as setSecureItem } from './secure-storage.js'

const COUNTS_KEY = 'deepview.fileCounts'

// File-counts blob contains filenames, which we treat as sensitive
// metadata (project names, sample identifiers). Reads go through
// the secure-storage cache (hydrated at boot); writes async-persist.
let cache = null
function load() {
  if (cache) return cache
  try { cache = JSON.parse(getSecureItem(COUNTS_KEY) || '{}') } catch { cache = {} }
  return cache
}
function persist() {
  setSecureItem(COUNTS_KEY, JSON.stringify(cache))
    .catch((err) => console.warn('counts persist:', err))
}

// Normalize a cache entry to the `{ count, source }` shape. Legacy
// entries were bare numbers — accept those and treat the source as
// unknown.
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
// Concurrency model: at most ONE active walk at a time. Re-entrant
// `ensureCounts` calls union their `names` into the active run's
// pending set, picked up as the loop iterates. Must union, not drop:
// a workspace switch firing `ensureCounts(namesB)` mid-walk of
// `namesA` would otherwise silently skip names only in B. Audit
// round-8 H2.
//
// Each caller's `onUpdate` is tracked alongside the names IT asked
// about, so a re-entrant call doesn't replace the original caller's
// callback — both fire for their respective name sets (else the
// first caller's onUpdate stops firing once a second lands; round-9
// L1).
let activeRun = null
let activePending = null      // Set<name> queued during the current run
let activeCallbacks = null    // Array<{ names: Set<name>, onUpdate }>

function fireCallbacksFor(name, count) {
  for (const { names: nset, onUpdate } of activeCallbacks) {
    if (!nset.has(name)) continue
    try { onUpdate(name, count) } catch (err) { console.warn('ensureCounts onUpdate:', err) }
  }
}

export function ensureCounts(names, onUpdate) {
  if (activeRun) {
    if (onUpdate) activeCallbacks.push({ names: new Set(names), onUpdate })
    for (const n of names) activePending.add(n)
    return activeRun
  }
  activePending = new Set(names)
  activeCallbacks = onUpdate ? [{ names: new Set(names), onUpdate }] : []
  activeRun = (async () => {
    // Yield once so the outer `activeRun = (...)()` assignment
    // lands BEFORE the body runs to its `finally`. Without this,
    // a fully-cached call drains the `while` loop synchronously
    // (no `await readFile` ever fires), the finally clears
    // `activeRun = null` + `activeCallbacks = null`, and then
    // the outer assignment overwrites `activeRun` with the
    // already-resolved promise — leaving the next caller with
    // a truthy `activeRun` but a null `activeCallbacks`, so the
    // re-entrant push throws. `Promise.resolve()` is the
    // explicit form of the "yield once" idiom (oxlint's
    // `no-unnecessary-await` rejects the `await null` shorthand).
    await Promise.resolve()
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
          // Re-check after the await: a concurrent setCount (e.g. an
          // ingest landing mid-walk) may have populated c[n] while we
          // were reading. Overwriting it with our freshly-parsed value
          // would clobber the fresher ingest count and persist the
          // stale one — the pre-await guard above, mirrored post-await.
          if (c[n] !== undefined) continue
          const { count, source } = analyzeContent(content)
          c[n] = source ? { count, source } : { count }
          persist()
          fireCallbacksFor(n, count)
        } catch {
          // Leave missing — the sidebar omits the badge for unknown counts.
        }
      }
    } finally {
      activeRun = null
      activePending = null
      activeCallbacks = null
    }
  })()
  return activeRun
}
