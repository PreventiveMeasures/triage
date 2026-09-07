// `client/linked-findings-index.js` — the OPFS-wide store of links
// files. Same substrate as the bundle-finding-index suite: without
// OPFS, `client/storage.js` falls back to gzipped localStorage, so
// `saveFile` / `deleteFile` are a real backing store to walk.
//
// What's worth pinning:
//   - a dropped links file is found by the walk, and a report isn't
//   - `duplicatesOf` unions across files and never names the finding
//     you asked about
//   - deleting a links file takes its claims with it — a card must
//     stop saying "duplicates" the moment the file saying so is gone
//   - the walk reads ONLY what the counts cache calls a links file,
//     which is what keeps it from re-reading (and JSON-parsing) every
//     report on disk whenever that cache is cold

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

function createLocalStorage() {
  const store = new Map()
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)) },
    removeItem: (k) => { store.delete(k) },
    clear: () => { store.clear() },
    get length() { return store.size },
    key: (i) => Array.from(store.keys())[i] ?? null,
  }
}
globalThis.localStorage ??= createLocalStorage()

const { deleteFile, saveFile } = await import('../client/storage.js')
const { setCount } = await import('../client/counts.js')
const { LINKS_KIND } = await import('../client/linked-findings.js')
const {
  duplicatesOf,
  ensureLinkedFindingsIndexed,
  hasLinkedFindings,
  linkFiles,
  subscribeToLinkedFindings,
} = await import('../client/linked-findings-index.js')

// The index keeps module-level state across tests (as the app's does
// across a session), so every test names its own files and its own
// ids and asserts only about those.
let counter = 0
function uniqueName(stem) {
  counter += 1
  return `${stem}-${Date.now()}-${counter}.json`
}
// Uuid-shaped, because the parser only keeps ids the app could
// follow — see the `isLinkableFindingId` cases in
// tests/linked-findings.test.js.
function uniqueId() {
  counter += 1
  const head = String(counter).padStart(8, '0').slice(-8)
  const tail = String(Date.now()).slice(-12).padStart(12, '0')
  return `${head}-0000-4000-8000-${tail}`
}

const linksContent = (...groups) => JSON.stringify(groups.map((g) => g.map((id) => ({ id }))))

// Save a links file the way the app does: bytes on disk AND the kind
// stamped in the counts cache. Every path that writes a file runs
// `analyzeContent` and calls `setCount` with what it found (ingest's
// drop, the workspace import, the objstore download), and the index
// reads none of them without that stamp — see the walk-skips-unknown
// case at the bottom of this file.
async function seedLinks(...groups) {
  const name = uniqueName('links')
  const content = linksContent(...groups)
  await saveFile(name, content)
  setCount(name, groups.length, LINKS_KIND)
  return name
}

describe('linked-findings-index — the walk', () => {
  it('finds a dropped links file and answers for the findings it names', async () => {
    const [a, b] = [uniqueId(), uniqueId()]
    const name = await seedLinks([a, b])
    await ensureLinkedFindingsIndexed()
    assert.ok(linkFiles().some((f) => f.name === name), 'the file is indexed')
    assert.deepEqual(duplicatesOf(a), [b])
    assert.deepEqual(duplicatesOf(b), [a])
    assert.equal(hasLinkedFindings(), true)
  })

  it('leaves reports alone — they are not links files', async () => {
    const name = uniqueName('rpt')
    await saveFile(name, JSON.stringify({ findings: [{ id: 'x' }, { id: 'y' }] }))
    setCount(name, 2, undefined)
    await ensureLinkedFindingsIndexed()
    assert.ok(!linkFiles().some((f) => f.name === name))
    assert.deepEqual(duplicatesOf('x'), [])
  })

  it('notifies subscribers when a links file lands', async () => {
    let fired = 0
    const off = subscribeToLinkedFindings(() => { fired++ })
    try {
      await seedLinks([uniqueId(), uniqueId()])
      await ensureLinkedFindingsIndexed()
      assert.ok(fired > 0, 'the view has to repaint when the index changes')
    } finally { off() }
  })

  it('says nothing about a finding no file links', async () => {
    await ensureLinkedFindingsIndexed()
    assert.deepEqual(duplicatesOf(uniqueId()), [])
  })
})

describe('linked-findings-index — across files', () => {
  // Union, not transitive closure: see the same rule under test in
  // tests/linked-findings.test.js. Here it has to hold across two
  // separately-dropped files.
  it('unions what two links files say without inventing a third claim', async () => {
    const [a, b, c] = [uniqueId(), uniqueId(), uniqueId()]
    await seedLinks([a, b])
    await seedLinks([b, c])
    await ensureLinkedFindingsIndexed()
    assert.deepEqual(duplicatesOf(b).toSorted(), [a, c].toSorted())
    assert.deepEqual(duplicatesOf(a), [b])
    assert.deepEqual(duplicatesOf(c), [b])
  })
})

describe('linked-findings-index — invalidation', () => {
  it('forgets a links file that was deleted', async () => {
    const [a, b] = [uniqueId(), uniqueId()]
    const name = await seedLinks([a, b])
    await ensureLinkedFindingsIndexed()
    assert.deepEqual(duplicatesOf(a), [b])
    await deleteFile(name)
    assert.deepEqual(duplicatesOf(a), [], 'the claim goes with the file that made it')
    assert.ok(!linkFiles().some((f) => f.name === name))
  })

  it('re-reads a links file that was overwritten', async () => {
    const [a, b, c] = [uniqueId(), uniqueId(), uniqueId()]
    const name = await seedLinks([a, b])
    await ensureLinkedFindingsIndexed()
    await saveFile(name, linksContent([a, c]))
    setCount(name, 1, LINKS_KIND)
    await ensureLinkedFindingsIndexed()
    assert.deepEqual(duplicatesOf(a), [c])
    assert.deepEqual(duplicatesOf(b), [], 'the link the old bytes declared is gone')
  })
})

describe('linked-findings-index — the counts cache decides what is read', () => {
  // The walk asks `getKind` before reading, and opens nothing the
  // cache doesn't already call a links file. That is the whole reason
  // this module costs nothing: a cold cache — a new device, a large
  // import, a counts-version bump — used to mean this walk read and
  // JSON-parsed every report on disk, on the thread that has to paint,
  // alongside the two other passes already doing it.
  it('skips a file the counts cache has already classified as a report', async () => {
    const [a, b] = [uniqueId(), uniqueId()]
    const name = uniqueName('mislabelled')
    await saveFile(name, linksContent([a, b]))
    setCount(name, 1, 'deepsec')
    await ensureLinkedFindingsIndexed()
    assert.ok(!linkFiles().some((f) => f.name === name))
    assert.deepEqual(duplicatesOf(a), [])
  })

  // And waits — rather than reading — for a file the cache hasn't
  // reached. `ensureCounts` fills it for every stored file and
  // repaints the sidebar as it goes, and each of those repaints calls
  // back in here, so waiting costs a pass, not the answer.
  it('leaves an unclassified file alone, and takes it once the cache names it', async () => {
    const [a, b] = [uniqueId(), uniqueId()]
    const name = uniqueName('unclassified')
    await saveFile(name, linksContent([a, b]))
    await ensureLinkedFindingsIndexed()
    assert.deepEqual(duplicatesOf(a), [], 'nothing has said what this file is yet')
    assert.ok(!linkFiles().some((f) => f.name === name))
    setCount(name, 1, LINKS_KIND)
    await ensureLinkedFindingsIndexed()
    assert.deepEqual(duplicatesOf(a), [b], 'and now it counts')
  })
})
