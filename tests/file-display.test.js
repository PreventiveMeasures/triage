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
const { FILE_ICONS, PRODUCER_LABELS, REPORT_LOGOS, displayName, findingBrand, groupOf, loadedBrands } = await import('../ui/view/file-display.js')

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

// The rule behind every surface that marks a finding with WHO wrote
// it — the finding tabs' branded right segment and the workspace
// kanban card's bottom-right corner. Both ask one question ("is there
// a logo to draw here?"), so `null` has to cover the analyzer's own
// findings as squarely as it covers a marker with no artwork.
describe('findingBrand — the producer a finding is marked with', () => {
  it('names the producer a finding carries', () => {
    for (const source of ['claude-security', 'codex-security', 'deepsec', 'piolium']) {
      assert.equal(findingBrand({ _source: source }), source)
    }
  })

  // The finding's OWN marker outranks the report's: a re-imported
  // export can mix a product's findings with the analyzer's own runs,
  // and ingest stamps `_source` per finding for exactly that reason.
  it('reads the finding\'s own marker, falling back to a bare `source`', () => {
    assert.equal(findingBrand({ _source: 'deepsec', source: 'piolium' }), 'deepsec')
    assert.equal(findingBrand({ source: 'piolium' }), 'piolium')
  })

  it('marks nothing for the analyzer\'s own findings', () => {
    assert.equal(findingBrand({ _source: null }), null, 'no producer named — a DeepView dump')
    assert.equal(findingBrand({}), null, 'nothing stamped at all')
    assert.equal(findingBrand({ _source: 'default' }), null, 'the bucket key spelled out')
  })

  it('marks nothing for a producer with no artwork', () => {
    assert.equal(findingBrand({ _source: 'some-new-product' }), null)
  })

  // `Object.hasOwn` and not `in`: a finding whose marker happens to
  // spell an Object.prototype key must not resolve to one.
  it('does not mistake an inherited property for a logo', () => {
    assert.equal(findingBrand({ _source: 'toString' }), null)
    assert.equal(findingBrand({ _source: 'constructor' }), null)
  })

  it('has a producer name for every brand it can return', () => {
    for (const source of ['claude-security', 'codex-security', 'deepsec', 'piolium']) {
      assert.ok(PRODUCER_LABELS[findingBrand({ _source: source })], `no producer name for ${source}`)
    }
  })
})

// The workspace header's chip strip: one chip per product in the load,
// in a fixed order. Reads the REPORT records, so the fixtures here are
// report-shaped (`{ source, groups }`) — `groups` is the nested
// dedup-group list ingest.js builds, hence the extra array level.
const rep = (source, ...findings) => ({ source, groups: findings.map((f) => [f]) })

describe('loadedBrands — the producers a load carries', () => {
  it('names each distinct producer once', () => {
    assert.deepEqual(loadedBrands([
      rep('codex-security', { _source: 'codex-security' }, { _source: 'codex-security' }),
      rep('claude-security', { _source: 'claude-security' }),
    ]), ['claude-security', 'codex-security'])
  })

  // The order is the point: a strip that reshuffled when the sidebar
  // loaded the same reports in another order would read as a change in
  // the data.
  it('orders by the producer table, not by the order reports loaded', () => {
    const order = ['claude-security', 'codex-security', 'deepsec', 'piolium']
    const reports = order.map((s) => rep(s, { _source: s }))
    assert.deepEqual(loadedBrands(reports), order)
    assert.deepEqual(loadedBrands(reports.toReversed()), order, 'same strip either way round')
  })

  // The review finding on #323. A report that parsed but found nothing
  // is a loaded report — the header's file chip counts it — and its
  // `source` survives on the record even with no finding to carry it.
  // Reading findings alone said "no Codex pass here" about a Codex pass
  // that ran and came back clean.
  it('names a product whose pass found nothing', () => {
    assert.deepEqual(loadedBrands([rep('codex-security')]), ['codex-security'])
    assert.deepEqual(loadedBrands([
      rep(null, { _source: null }, { _source: null }),
      rep('piolium'),
    ]), ['piolium'], 'beside a native dump that did find things')
  })

  // …and the converse: a report does not have to be of one product. A
  // re-imported export carries a product's rows beside native ones,
  // each stamped with its own marker, and the strip names both.
  it('names a producer only its findings carry', () => {
    assert.deepEqual(loadedBrands([
      rep(null, { _source: 'deepsec' }, { _source: null }),
    ]), ['deepsec'])
  })

  it('leaves DeepView out — it is the unmarked default', () => {
    assert.deepEqual(loadedBrands([rep(null, { _source: null }, {}, { _source: 'default' })]), [])
    assert.deepEqual(loadedBrands([rep('default'), rep(undefined)]), [], 'declared either way round')
    assert.deepEqual(loadedBrands([rep(null, { _source: null }, { _source: 'deepsec' })]), ['deepsec'])
  })

  it('has nothing to say about an empty load', () => {
    assert.deepEqual(loadedBrands([]), [])
    assert.deepEqual(loadedBrands([rep(null)]), [], 'nor about an empty native dump')
  })

  it('ignores a marker with no artwork, which is no producer at all', () => {
    assert.deepEqual(loadedBrands([
      rep('zzz-unnamed', { _source: 'zzz-unnamed' }),
      rep('piolium', { _source: 'piolium' }),
    ]), ['piolium'])
  })

  // `loadedBrands` ranks a key the library's table doesn't name after
  // the ones it does instead of dropping it. Nothing can reach that
  // branch while the two tables agree — which is the invariant asserted
  // here, and the one that would break if a brand were added to
  // REPORT_BRANDS without a SOURCE_LABELS entry to name it. The branch
  // is what keeps that mistake a mis-sorted chip rather than a missing
  // one; this test is what says the mistake hasn't been made.
  it('has every drawable producer named by the library table', () => {
    const drawable = Object.keys(REPORT_LOGOS).filter((k) => k !== 'default')
    assert.ok(drawable.length >= 4, 'sanity: the producers with artwork')
    assert.deepEqual(loadedBrands(drawable.map((k) => rep(k))).toSorted(), drawable.toSorted(),
      'every brand with a logo is a producer loadedBrands reports')
    for (const k of drawable) assert.ok(PRODUCER_LABELS[k], `no producer name for the ${k} brand`)
  })

  it('has a producer name for every chip it asks for', () => {
    const brands = loadedBrands([
      rep('piolium'), rep('deepsec'),
      rep('codex-security'), rep('claude-security'),
    ])
    assert.equal(brands.length, 4)
    for (const b of brands) assert.ok(PRODUCER_LABELS[b], `no producer name for ${b}`)
  })
})

describe('displayName — the label a file row shows', () => {
  it('un-sanitizes a derived codex name and keeps every other one', () => {
    assert.equal(displayName('org__repo:scan-1.codex'), 'org/repo:scan-1')
    assert.equal(displayName('report.md'), 'report.md')
    assert.equal(displayName('dump.json'), 'dump.json')
  })
})
