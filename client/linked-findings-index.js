// OPFS-wide index of the links files the user has dropped — the store
// behind the Links view and behind the "Duplicates:" row a linked
// finding grows on its card.
//
// Two questions, both answered synchronously once the background walk
// has run:
//
//   - `linkFiles()` — every links file and the links it declares, for
//     the view that lists them.
//   - `duplicatesOf(id)` — what a given finding has been linked to,
//     across every links file at once, for the finding card.
//
// Mirrors `bundle-finding-index.js` in shape (background walk,
// idempotent `ensure…`, subscriber notification, `onFileMutated`
// invalidation) and differs in what it walks: a links file is tiny and
// there are few of them, so instead of pruning contributions in place
// the id index is simply rebuilt from the parsed files whenever the set
// changes. Rebuilding is a walk of a handful of Maps; the intricate
// per-name pruning that index needs would buy nothing here.
//
// The walk READS NOTHING. Every answer it needs is already in the
// counts cache: `analyzeContent` recognises a links file, and every
// path that puts one on disk stamps the result through `setCount`, so
// `getKind` names it. A file the cache hasn't classified yet is left
// alone and picked up by a later pass — `ensureCounts` fills the cache
// for every stored file and repaints the sidebar as it goes, and each
// of those repaints calls back in here.
//
// That patience is the whole performance story of this module. Reading
// unclassified files itself meant that whenever the cache was cold —
// a new device, a large import, a counts-version bump — this walk read
// and JSON-parsed every report on disk, alongside the two passes
// (`ensureCounts`, `bundle-finding-index`) already doing exactly that.
// Three readers racing over the same megabytes, on the thread that has
// to paint.

import { LINKS_KIND, collectDuplicates, parseLinkedFindings } from './linked-findings.js'
import { listFiles, onFileMutated, readFile } from './storage.js'
import { getKind } from './counts.js'

// name → `{ groups, skipped }` for the links files, and name → null for
// a file that was read and turned out to be something else. Both are
// "already looked at": the null entries are what keep the walk from
// re-reading every report on every call.
const byFile = new Map()
// finding id → Set of the ids it is linked to. Derived from `byFile`;
// rebuilt by `reindex()` whenever that changes.
let byId = new Map()

// Per-name write generation, bumped by every storage mutation. A read
// in flight when a save lands would otherwise file bytes that are
// already stale under a name the re-walk then skips as "already looked
// at"; `indexOne` captures the token before its read and refuses to
// record against a token that moved. Same guard, and the same reason
// for it, as `writeGen` in storage.js.
const fileGen = new Map()

const listeners = new Set()
let activeRun = null
// Set when an `onFileMutated` lands mid-walk, so the run that was in
// flight when the file changed doesn't finish having missed it.
let needsRescan = false

export function subscribeToLinkedFindings(callback) {
  listeners.add(callback)
  return () => listeners.delete(callback)
}

function notify() {
  for (const cb of listeners) {
    try { cb() } catch (err) { console.warn('linked-findings listener:', err) }
  }
}

function reindex() {
  const next = new Map()
  for (const parsed of byFile.values()) {
    if (parsed) collectDuplicates(parsed.groups, next)
  }
  byId = next
}

// The links files currently indexed, in OPFS listing order, as
// `[{ name, groups, skipped }]`. The arrays are the index's own — the
// view iterates them, it doesn't own them.
export function linkFiles() {
  const out = []
  for (const [name, parsed] of byFile) {
    if (parsed) out.push({ name, groups: parsed.groups, skipped: parsed.skipped })
  }
  // By name, not by when each landed in the Map: a file re-read after
  // an overwrite is re-inserted at the end, and the list the view
  // paints shouldn't reorder itself because someone saved.
  return out.toSorted((a, b) => a.name.localeCompare(b.name))
}

// Whether any links file is indexed — what the finding card asks
// before doing anything about duplicates at all.
export function hasLinkedFindings() {
  return byId.size > 0
}

// Every finding `id` has been linked to, across all links files, in a
// stable order. Empty for a finding nothing links, which is almost
// every finding — so this is the cheap path, one Map lookup.
export function duplicatesOf(id) {
  const set = byId.get(id)
  return set ? [...set] : []
}

// File one name: parse it when the counts cache says it is a links
// file, record "not links" when the cache names anything else, and do
// NOTHING when the cache hasn't looked yet — that name stays
// unclassified so a later walk, after `ensureCounts` has reached it,
// decides.
//
// A read failure also leaves the name unrecorded, so a transient error
// (a locked vault, a sibling tab's delete landing mid-read) isn't
// memoised as "not a links file".
async function indexOne(name) {
  if (byFile.has(name)) return false
  const kind = getKind(name)
  if (kind === undefined) return false
  if (kind !== LINKS_KIND) {
    byFile.set(name, null)
    return false
  }
  const gen = fileGen.get(name) ?? 0
  let content
  try { content = await readFile(name) } catch { return false }
  if (content == null) return false
  // A save or delete landed while we were reading — what we hold is
  // the old file. Record nothing (so the name stays unclassified) and
  // ask for another pass.
  if ((fileGen.get(name) ?? 0) !== gen) { needsRescan = true; return false }
  const parsed = parseLinkedFindings(content)
  byFile.set(name, parsed)
  return parsed !== null
}

// Walk every OPFS file, indexing the links files among them.
// Idempotent — a concurrent caller waits on the same in-flight promise,
// and a later call re-walks the listing so newly-dropped files land
// without re-reading the ones already classified.
export function ensureLinkedFindingsIndexed() {
  if (activeRun) return activeRun
  activeRun = (async () => {
    try {
      do {
        needsRescan = false
        let added = false
        for (const name of await listFiles()) {
          if (await indexOne(name)) added = true
        }
        if (added) { reindex(); notify() }
      } while (needsRescan)
    } finally {
      activeRun = null
    }
  })()
  return activeRun
}

// A save (overwrite) or delete drops what we knew about the name: the
// next walk re-reads it, and a delete simply never sees it again
// because `listFiles` stops returning it. `reindex` runs on the way out
// so a deleted links file's duplicates stop being claimed immediately
// rather than at the next walk.
onFileMutated((name) => {
  fileGen.set(name, (fileGen.get(name) ?? 0) + 1)
  needsRescan = true
  const wasLinks = byFile.get(name) != null
  byFile.delete(name)
  if (!wasLinks) return
  reindex()
  notify()
})
