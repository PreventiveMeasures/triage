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
const { FILE_ICONS, PRODUCER_LABELS, displayName, groupOf } = await import('../ui/view/file-display.js')

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

// Every bucket `groupOf` can name has to have both a sticker and a
// word: the sidebar row draws the first, and the finding card's
// "Duplicates:" tooltip says the second (a mark with no text beside it
// says nothing to a reader who can't see it). Adding a producer means
// adding to three tables, and this is what notices when only two of
// them got the edit.
describe('every bucket has an icon and a producer name', () => {
  beforeEach(() => { globalThis.localStorage.clear() })

  it('names and draws each bucket a report can land in', () => {
    const buckets = new Set()
    for (const source of ['claude-security', 'codex-security', 'deepsec', 'piolium', undefined]) {
      setCount(`r-${source}.md`, 1, source)
      buckets.add(groupOf(`r-${source}.md`))
    }
    assert.ok(buckets.size > 1, 'sanity: the fixtures span several buckets')
    for (const bucket of buckets) {
      assert.ok(FILE_ICONS[bucket], `no icon for the ${bucket} bucket`)
      assert.ok(PRODUCER_LABELS[bucket], `no producer name for the ${bucket} bucket`)
    }
  })

  // The links bucket is the one exception on the naming side: a links
  // file carries no findings, so it never produces one and never turns
  // up as a duplicate's origin. It still needs its row icon.
  it('draws the links bucket, which produces no findings to name', () => {
    setCount('dupes.json', 3, 'links')
    assert.equal(groupOf('dupes.json'), 'links')
    assert.ok(FILE_ICONS.links)
  })
})

describe('displayName — the label a file row shows', () => {
  it('un-sanitizes a derived codex name and keeps every other one', () => {
    assert.equal(displayName('org__repo:scan-1.codex'), 'org/repo:scan-1')
    assert.equal(displayName('report.md'), 'report.md')
    assert.equal(displayName('dump.json'), 'dump.json')
  })
})
