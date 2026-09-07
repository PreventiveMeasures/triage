// `ui/view/file-display.js` — the sidebar's bucket detection. Which
// section of the file list a report lands in is decided by what the
// CONTENT turned out to be (counts.js caches it at ingest), not by the
// name it was saved under: DeepSec, Piolium and Claude Security all
// ship as `.md`, and so does every export the app itself writes.
//
// The extension is a fallback for one case only — a file nothing has
// analyzed yet — and pinning that boundary is the point of this suite:
// trusting it any further filed every re-imported export under Claude
// Security.

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
globalThis.localStorage ??= createLocalStorage()

const { setCount } = await import('../client/counts.js')
const { displayName, groupOf } = await import('../ui/view/file-display.js')

describe('groupOf — the bucket a file lands in', () => {
  beforeEach(() => { globalThis.localStorage.clear() })

  it('files an analyzed report under the producer its content names', () => {
    for (const source of ['claude-security', 'codex-security', 'deepsec', 'piolium']) {
      setCount(`r-${source}.md`, 1, source)
      assert.equal(groupOf(`r-${source}.md`), source)
    }
  })

  // The bug this suite exists for. The app writes its export as a
  // `.md` whatever the findings came from, so a re-imported export
  // carries the producer of the report it was made FROM — or none at
  // all, for the analyzer's own dump, whose header names its run
  // instead of a product. Either way the extension must not speak.
  it('files a re-imported export by its content, not by its `.md` name', () => {
    setCount('export.md', 4, 'deepsec')
    assert.equal(groupOf('export.md'), 'deepsec')
    setCount('codex-export.md', 4, 'codex-security')
    assert.equal(groupOf('codex-export.md'), 'codex-security', 'the marker the old if-chain never named')
    setCount('native-export.md', 4, undefined)
    assert.equal(groupOf('native-export.md'), 'default', 'no producer named — an analyzer dump, not Claude Security')
  })

  it('files an analyzed dump under the default bucket whatever it is called', () => {
    for (const name of ['dump.json', 'dump.md', 'dump.codex', 'dump']) {
      setCount(name, 2, undefined)
      assert.equal(groupOf(name), 'default', name)
    }
  })

  // A source the sidebar has no section for is still a report, and
  // belongs somewhere: the default bucket, not a header that is never
  // rendered (sidebar.js GROUP_ORDER).
  it('files an unknown marker under the default bucket', () => {
    setCount('future.md', 1, 'some-new-product')
    assert.equal(groupOf('future.md'), 'default')
  })

  // Pre-existing OPFS entries on the first sidebar render, before the
  // lazy fill reaches them: a guess from the extension beats no bucket.
  it('guesses from the extension only while nothing has analyzed the file', () => {
    assert.equal(groupOf('unseen.md'), 'claude-security')
    assert.equal(groupOf('unseen.codex'), 'codex-security')
    assert.equal(groupOf('unseen.json'), 'default')
    assert.equal(groupOf('UNSEEN.MD'), 'claude-security', 'case-insensitive')
  })
})

describe('displayName — the label a file row shows', () => {
  it('un-sanitizes a derived codex name and keeps every other one', () => {
    assert.equal(displayName('org__repo:scan-1.codex'), 'org/repo:scan-1')
    assert.equal(displayName('report.md'), 'report.md')
    assert.equal(displayName('dump.json'), 'dump.json')
  })
})
