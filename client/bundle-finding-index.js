// Bundle-side finding index — loads every report stored in OPFS
// (not just the currently-active state.reports) and caches their
// findings keyed by `fileHash`. The bundle details panel
// (Issues tab + Graph view) consults this so a bundle can be
// matched against findings from every report the user has ever
// dropped, not only the one they happen to have open.
//
// Indexing is incremental and idempotent: the first call kicks a
// background walk of `listFiles()`; each report is JSON.parsed and
// scanned for findings carrying `fileHash`. Subsequent calls
// re-scan the OPFS file list so newly-dropped reports get indexed
// without restart, but already-indexed reports skip the readFile.
// Reports that don't parse or don't carry fileHashes (DeepSec /
// Claude Security / Codex CSV imports — those drop fileHashes) are
// silently skipped.
//
// Subscribers fire after each report finishes indexing so the
// open bundle's panel can repaint progressively as findings come
// in (the digests + parses can take a few seconds for large
// workspace dumps).

import { listFiles, readFile } from './storage.js'

const byHash = new Map()
const indexed = new Set()
const listeners = new Set()
let activeRun = null

export function subscribeToBundleFindingIndex(callback) {
  listeners.add(callback)
  return () => listeners.delete(callback)
}

function notify() {
  for (const cb of listeners) {
    try { cb() } catch {}
  }
}

// Synchronous lookup for the open bundle's hash → findings join.
// Returns the same Finding objects we cached during indexing — id /
// severity / description / file / line / repo all preserved so the
// Issues tab and graph dim logic can read them as-is. The bucket's
// internal Set is hidden from callers; just the deduped list is
// exposed.
export function findingsForFileHash(hash) {
  return byHash.get(hash)?.list ?? []
}

function extractFindings(data) {
  // DeepView-native dumps carry findings under `groups` (array of
  // Finding[]) or a flat `findings` array. Either shape works —
  // both yield Finding objects with `fileHash` on the analyzer-
  // stamped ones. Other formats (deepsec / claude-security /
  // codex) get parsed during ingest; their findings rarely carry
  // fileHashes (no source bundle attached during their pipeline)
  // so the array.isArray guard quietly skips them.
  const list = Array.isArray(data?.findings)
    ? data.findings
    : Array.isArray(data?.groups) ? data.groups : null
  if (!list) return []
  const out = []
  for (const entry of list) {
    const members = Array.isArray(entry) ? entry : [entry]
    for (const f of members) {
      if (f && f.fileHash) out.push(f)
    }
  }
  return out
}

// Dedupe key — preferred form is the analyzer's stable `id`; falls
// back to a (severity, description, file, line, fileHash) tuple
// when the report doesn't carry ids (older / hand-rolled inputs).
// Same hash bucket: same source content; same key = same finding,
// so we drop the second copy.
function findingDedupeKey(f) {
  if (f.id) return `id:${f.id}`
  return `c:${f.severity ?? ''}|${f.description ?? ''}|${f.file ?? ''}|${f.line ?? ''}`
}

async function indexOne(name) {
  if (indexed.has(name)) return false
  // Mark up front so concurrent ensureBundleFindingsIndexed calls
  // don't double-process the same report.
  indexed.add(name)
  try {
    const content = await readFile(name)
    const data = JSON.parse(content)
    const findings = extractFindings(data)
    if (findings.length === 0) return false
    let added = false
    for (const f of findings) {
      let bucket = byHash.get(f.fileHash)
      if (!bucket) {
        bucket = { keys: new Set(), list: [] }
        byHash.set(f.fileHash, bucket)
      }
      // Dedupe: the same finding can land here multiple times when
      // the user has both the original report AND a workspace
      // export covering it (or two analyzer runs producing the
      // same id). The bundle Issues tab should still list each
      // finding once.
      const key = findingDedupeKey(f)
      if (bucket.keys.has(key)) continue
      bucket.keys.add(key)
      bucket.list.push(f)
      added = true
    }
    return added
  } catch {
    return false
  }
}

// Kicks a background walk of every OPFS report. Idempotent — a
// concurrent caller waits on the same in-flight promise; subsequent
// calls after that resolves walk listFiles again to pick up any
// newly-dropped reports without re-parsing the ones already
// indexed. Returns when every (currently-listed) report is
// indexed.
export function ensureBundleFindingsIndexed() {
  if (activeRun) return activeRun
  activeRun = (async () => {
    try {
      const names = await listFiles()
      for (const name of names) {
        const added = await indexOne(name)
        if (added) notify()
      }
    } finally {
      activeRun = null
    }
  })()
  return activeRun
}
