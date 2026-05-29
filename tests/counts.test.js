// `client/counts.js` — `analyzeContent` is the per-file count + source
// classifier shared by sidebar bucketing, ingest validation, and the
// migrate-legacy / workspace-import flows. The per-cache mutators
// (setCount / getCount / removeCount / getKind) are also exercised
// here through the localStorage shim.
//
// `ensureCounts` is left to integration coverage — it depends on OPFS
// (`readFile`) which our shim doesn't currently model.

import assert from 'node:assert/strict'
import { beforeEach, describe, it } from 'node:test'

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
if (globalThis.localStorage === undefined) {
  globalThis.localStorage = createLocalStorage()
}

const { analyzeContent, getCount, getKind, removeCount, setCount } = await import('../client/counts.js')

const COUNTS_KEY = 'deepview.fileCounts'

describe('analyzeContent — JSON dumps', () => {
  it('counts native analyzer JSON dumps', () => {
    const content = JSON.stringify({ findings: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] })
    assert.deepEqual(analyzeContent(content), {
      count: 3,
      source: undefined,
      recognized: true,
    })
  })

  it('preserves the `source` marker from JSON dumps that carry one', () => {
    const content = JSON.stringify({
      source: 'claude-security',
      findings: [{ id: 'a' }],
    })
    assert.deepEqual(analyzeContent(content), {
      count: 1,
      source: 'claude-security',
      recognized: true,
    })
  })

  it('counts grouped findings as one entry per top-level array slot', () => {
    // Ingest pre-deduped groups arrive as `findings: [Finding[]]`. The
    // sidebar count reflects rows, not flattened members — so a
    // length-1 outer array with 5 inner findings counts as 1.
    const content = JSON.stringify({
      findings: [[{ id: 'a' }, { id: 'b' }, { id: 'c' }]],
    })
    assert.equal(analyzeContent(content).count, 1)
  })

  it('returns recognized: false for JSON without a findings array', () => {
    assert.deepEqual(analyzeContent('{}'), { count: 0, recognized: false })
    assert.deepEqual(analyzeContent('null'), { count: 0, recognized: false })
    assert.deepEqual(analyzeContent('[1,2,3]'), { count: 0, recognized: false })
  })
})

describe('analyzeContent — markdown formats', () => {
  it('recognizes DeepSec markdown', () => {
    const content = [
      '# Vulnerability Scan Report',
      '',
      '## HIGH (1)',
      '',
      '### A finding',
      '',
      '- **File:** `x.js`',
      '- **Lines:** 1',
    ].join('\n')
    const r = analyzeContent(content)
    assert.equal(r.count, 1)
    assert.equal(r.source, 'deepsec')
    assert.equal(r.recognized, true)
  })

  it('recognizes Claude Security markdown', () => {
    const content = '# A title\n\n---\n**Severity:** medium\n'
    const r = analyzeContent(content)
    assert.equal(r.count, 1)
    assert.equal(r.source, 'claude-security')
    assert.equal(r.recognized, true)
  })

  it('returns recognized: false for unstructured text', () => {
    assert.deepEqual(analyzeContent('not a report'), { count: 0, recognized: false })
    assert.deepEqual(analyzeContent(''), { count: 0, recognized: false })
  })

  it('prefers DeepSec when both formats could match', () => {
    // A document that opens with `# Title` AND has `## SEVERITY (n)`
    // would match Claude Security's h1 guard, but DeepSec is checked
    // first so the SEVERITY-section structure wins.
    const content = [
      '# Vulnerability Scan Report',
      '',
      '## HIGH (1)',
      '',
      '### Finding',
      '',
      '- **File:** `x.js`',
      '- **Lines:** 1',
    ].join('\n')
    assert.equal(analyzeContent(content).source, 'deepsec')
  })
})

describe('counts cache (setCount / getCount / removeCount / getKind)', () => {
  beforeEach(() => { globalThis.localStorage.clear() })

  it('round-trips count + source', () => {
    setCount('x.json', 7, 'deepsec')
    assert.equal(getCount('x.json'), 7)
    assert.equal(getKind('x.json'), 'deepsec')
  })

  it('omits the source field when not provided', () => {
    setCount('x.json', 3)
    assert.equal(getCount('x.json'), 3)
    assert.equal(getKind('x.json'), undefined)
  })

  it('removeCount drops both count and source', () => {
    setCount('x.json', 5, 'deepsec')
    removeCount('x.json')
    assert.equal(getCount('x.json'), undefined)
    assert.equal(getKind('x.json'), undefined)
  })

  it('returns undefined for unknown names', () => {
    assert.equal(getCount('never-stored'), undefined)
    assert.equal(getKind('never-stored'), undefined)
  })

  it('survives a corrupt JSON blob in localStorage', () => {
    globalThis.localStorage.setItem(COUNTS_KEY, '{not json')
    // Triggering any accessor must not throw — the catch in load()
    // recovers to an empty cache.
    assert.equal(getCount('whatever'), undefined)
  })

  it('reads legacy bare-number entries via a fresh module instance', async () => {
    // counts.js memoizes its in-process cache, so we need a fresh
    // module instance to exercise the lazy load() path against a
    // pre-existing legacy blob. Cache-bust the import URL to get one.
    // The counts cache reads through secure-storage, so we also need
    // to re-hydrate that layer's cache from the just-written LS
    // value before the fresh import does its first load().
    globalThis.localStorage.clear()
    globalThis.localStorage.setItem(COUNTS_KEY, JSON.stringify({ 'legacy.json': 42 }))
    const { hydrate: hydrateSecureStorage } = await import('../client/secure-storage.js')
    await hydrateSecureStorage()
    const fresh = await import(`../client/counts.js?legacy=${Date.now()}`)
    assert.equal(fresh.getCount('legacy.json'), 42, 'count read from bare-number entry')
    assert.equal(fresh.getKind('legacy.json'), undefined, 'source absent on legacy entry')
  })
})

describe('ensureCounts multi-caller (audit round-9 L1)', () => {
  it('a re-entrant ensureCounts call doesn\'t lose the FIRST caller\'s onUpdate', async () => {
    // Round-9 L1: previously activeOnUpdate was overwritten by the
    // most recent caller, so the FIRST caller's callback stopped
    // firing for any of its still-pending names. Now each caller's
    // callback is tracked alongside the names IT asked about; a
    // re-entrant call appends instead of replacing.
    //
    // Use a fresh module instance so the test sees clean cache +
    // an unused activeRun lane. Stub readFile via a fresh storage
    // module so ensureCounts can drain.
    globalThis.localStorage.clear()
    const stamp = `${Date.now()}-${Math.random()}`
    const storageMod = await import(`../client/storage.js?ec-${stamp}`)
    const countsMod = await import(`../client/counts.js?ec-${stamp}`)

    // Seed two reports so analyzeContent returns a count > 0.
    await storageMod.saveFile(`a-${stamp}.json`, JSON.stringify({ findings: [{ id: '1' }] }))
    await storageMod.saveFile(`b-${stamp}.json`, JSON.stringify({ findings: [{ id: '2' }, { id: '3' }] }))
    // Drop in-memory cache entries so ensureCounts goes through readFile.
    // (Calling getCount won't trigger a re-fetch; we need ensureCounts.)

    const firedFor = (label, recv) => (n, c) => recv.push({ label, name: n, count: c })
    const firstCalls = []
    const secondCalls = []

    // First caller asks about A. Re-entrant second caller asks about B.
    // Both onUpdates must fire for their respective names.
    const firstP = countsMod.ensureCounts([`a-${stamp}.json`], firedFor('first', firstCalls))
    const secondP = countsMod.ensureCounts([`b-${stamp}.json`], firedFor('second', secondCalls))
    await Promise.all([firstP, secondP])

    assert.ok(firstCalls.some((e) => e.name === `a-${stamp}.json`),
      'first caller\'s onUpdate fired for its name')
    assert.ok(secondCalls.some((e) => e.name === `b-${stamp}.json`),
      'second caller\'s onUpdate fired for its name')
    // Round-9 L1 also: the first caller's callback should NOT fire
    // for the second caller's names (each callback is scoped to the
    // names that caller asked about).
    assert.equal(
      firstCalls.filter((e) => e.name === `b-${stamp}.json`).length,
      0,
      'first caller\'s onUpdate does NOT fire for second caller\'s names',
    )
  })

  it('a fully-cached ensureCounts does not poison subsequent calls', async () => {
    // Audit follow-up: when every name passed to `ensureCounts` is
    // already cached, the async IIFE used to drain its `while` loop
    // synchronously (no `await readFile` ever firing). Body ran to
    // completion → finally cleared `activeRun`/`activePending`/
    // `activeCallbacks` → THEN the outer `activeRun = (...)()`
    // assignment overwrote `activeRun` with the resolved promise.
    // The next `ensureCounts` call saw truthy `activeRun` but null
    // `activeCallbacks` and crashed on `activeCallbacks.push(...)`.
    //
    // The fix (commit 659f074) inserts `await Promise.resolve()`
    // at the top of the IIFE so the body yields once before any
    // work — the outer assignment lands first, then the finally
    // clears state cleanly. Pin the regression so a future
    // refactor that drops the yield breaks here, not in
    // production.
    globalThis.localStorage.clear()
    const stamp = `${Date.now()}-${Math.random()}`
    const storageMod = await import(`../client/storage.js?ec-${stamp}`)
    const countsMod = await import(`../client/counts.js?ec-${stamp}`)

    // Seed + populate the cache so every subsequent ensureCounts
    // hits the `c[n] !== undefined` continue and never awaits.
    await storageMod.saveFile(`a-${stamp}.json`, JSON.stringify({ findings: [{ id: '1' }] }))
    countsMod.setCount(`a-${stamp}.json`, 1)

    // First call: fully cached. With the pre-fix shape this corrupts
    // module state silently.
    await countsMod.ensureCounts([`a-${stamp}.json`])

    // Second call: must NOT throw. This is the call that crashed
    // pre-fix, both with and without onUpdate.
    const calls = []
    await countsMod.ensureCounts([`a-${stamp}.json`], (n, c) => calls.push({ n, c }))

    // Sanity — we never went through readFile, so onUpdate
    // legitimately doesn't fire (only fires for fresh fetches).
    // The point is that NEITHER call threw.
    assert.equal(calls.length, 0, 'all-cached call doesn\'t fire onUpdate')
  })

  it('a concurrent setCount landing mid-walk is not clobbered by the stale parse', async (t) => {
    // ensureCounts re-checks the cache AFTER `await readFile(n)`: if an
    // ingest's setCount lands for the same name while the walk is
    // reading the file, the walk must keep the fresher ingest count
    // rather than overwrite it with its now-stale parse result. Mock
    // readFile to fire that concurrent setCount before it resolves.
    globalThis.localStorage.clear()
    const stamp = `${Date.now()}-${Math.random()}`
    let countsMod
    t.mock.module('../client/storage.js', {
      namedExports: {
        readFile: async (n) => {
          // Concurrent ingest lands while we're "reading": count 999.
          countsMod.setCount(n, 999, 'deepsec')
          // ...whereas the walk's own parse would yield count 1.
          return JSON.stringify({ findings: [{ id: '1' }] })
        },
      },
    })
    countsMod = await import(`../client/counts.js?race-${stamp}`)
    const name = `race-${stamp}.json`
    await countsMod.ensureCounts([name])
    assert.equal(
      countsMod.getCount(name),
      999,
      'concurrent setCount(999) survives; the stale parse (count 1) must not clobber it',
    )
  })
})
