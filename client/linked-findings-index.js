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
// Counts are persisted separately from file bytes. After an interrupted
// replacement, an old "report" classification may describe a links file.
// Verify the bytes once per page load instead of treating that hint as proof.
// Load known links first so restoring findings need not wait for every report
// in the library. The background walk still verifies all other files: cached
// types are a scheduling hint, never proof that a file cannot contain links.
// `readFile` shares its cache and in-flight reads with workspace loading and
// the counts walk. Ordinary reports are rejected by their leading character,
// without another JSON parse.

import { LINKS_KIND, collectDuplicates, countLinkedIds, parseLinkedFindings } from './linked-findings.js'
import { listFiles, onFileMutated, readFile } from './storage.js'
import { analyzeContent, getKind, setCount } from './counts.js'

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
let knownRun = null
let mutationEpoch = 0
// Set when an `onFileMutated` lands mid-walk, so the run that was in
// flight when the file changed doesn't finish having missed it.
let needsRescan = false
// An empty Map is not proof that the library has no links. A complete walk
// must verify every listed file's bytes. Mutations make that evidence stale
// until the next walk.
let ready = false

export function isLinkedFindingsIndexReady() { return ready }

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

// File one name from its current contents, not its persisted classification.
// A read failure also leaves the name unrecorded, so a transient error
// (a locked vault, a sibling tab's delete landing mid-read) isn't
// memoised as "not a links file".
async function indexOne(name) {
  if (byFile.has(name)) return false
  const gen = fileGen.get(name) ?? 0
  let content
  try { content = await readFile(name) } catch { return false }
  if (content == null) return false
  // A save or delete landed while we were reading — what we hold is
  // the old file. Record nothing (so the name stays unclassified) and
  // ask for another pass.
  if ((fileGen.get(name) ?? 0) !== gen) { needsRescan = true; return false }
  const parsed = /^\s*\[/u.test(content) ? parseLinkedFindings(content) : null
  byFile.set(name, parsed)
  // Repair stale hints for the sidebar too. The ordinary-report fast path
  // does not re-analyze reports whose classification is already consistent.
  if (parsed && getKind(name) !== LINKS_KIND) setCount(name, countLinkedIds(parsed.groups), LINKS_KIND)
  else if (!parsed && getKind(name) === LINKS_KIND) {
    const { count, source } = analyzeContent(content)
    setCount(name, count, source)
  }
  return parsed !== null
}

// The small set already classified as links is needed before the initial
// findings paint. Read their current bytes concurrently and publish them as
// soon as they are available, independent of the full verification walk.
// This does not mark the index ready: unknown or stale report classifications
// may still hide additional links, so App metadata must wait for the full walk.
export function ensureKnownLinkedFindingsIndexed() {
  if (knownRun) return knownRun
  knownRun = (async () => {
    try {
      let names, started
      do {
        started = mutationEpoch
        names = await listFiles()
        if (ready && names.some((name) => !byFile.has(name))) {
          ready = false
          notify()
        }
        const known = names.filter((name) => getKind(name) === LINKS_KIND)
        const added = await Promise.all(known.map((name) => indexOne(name)))
        if (added.some(Boolean)) { reindex(); notify() }
      } while (started !== mutationEpoch)
      return names
    } catch (err) {
      if (ready) { ready = false; notify() }
      throw err
    } finally {
      knownRun = null
    }
  })()
  return knownRun
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
        const names = await ensureKnownLinkedFindingsIndexed()
        let added = false
        for (const name of names) {
          if (await indexOne(name)) added = true
        }
        const nextReady = !needsRescan && names.every((name) => byFile.has(name))
        const readinessChanged = ready !== nextReady
        ready = nextReady
        if (added) reindex()
        if (added || readinessChanged) notify()
      } while (needsRescan)
    } catch (err) {
      if (ready) { ready = false; notify() }
      throw err
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
  const wasReady = ready
  ready = false
  mutationEpoch++
  fileGen.set(name, (fileGen.get(name) ?? 0) + 1)
  needsRescan = true
  const wasLinks = byFile.get(name) != null
  byFile.delete(name)
  if (wasLinks) reindex()
  if (wasLinks || wasReady) notify()
})
