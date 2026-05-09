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
if (typeof globalThis.localStorage === 'undefined') {
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
    globalThis.localStorage.clear()
    globalThis.localStorage.setItem(COUNTS_KEY, JSON.stringify({ 'legacy.json': 42 }))
    const fresh = await import(`../client/counts.js?legacy=${Date.now()}`)
    assert.equal(fresh.getCount('legacy.json'), 42, 'count read from bare-number entry')
    assert.equal(fresh.getKind('legacy.json'), undefined, 'source absent on legacy entry')
  })
})
