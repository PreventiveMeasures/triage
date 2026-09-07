// `client/linked-findings.js` — the links file: a JSON document that
// says which findings are the same finding, reported twice.
//
//   [[{"id":"a"},{"id":"b"}], [{"id":"c"},{"id":"d"}]]
//
// Two things are worth pinning here, and they pull against each other.
//
// RECOGNITION has to be tight, because this parser runs against every
// dropped file before the report readers get their turn: anything it
// claims by mistake stops being readable as the report it actually is.
// So the shape test is exact, and the negative cases below are the
// suite's centre of gravity.
//
// NORMALISATION has to be forgiving, because the file comes out of
// whatever produced it: repeated ids, ids this app could never follow,
// links that name only one finding. None of those make the file
// something else — they just carry no information, and get dropped
// while the file stays recognized.
//
// The tail of the suite covers what the rest of the app then does with
// the answer: `analyzeContent` files it under the `links` kind, and
// the sidebar buckets it by that rather than by its `.json` name.

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

const { LINKS_KIND, collectDuplicates, countLinkedIds, parseLinkedFindings } =
  await import('../client/linked-findings.js')
const { analyzeContent, setCount } = await import('../client/counts.js')
const { groupOf } = await import('../ui/view/file-display.js')

// Real uuids: the parser only keeps ids the app could actually follow
// (`isLinkableFindingId`), and a one-letter id from the format's own
// doc comment would be dropped by the numeric / linkable rules the
// moment a test used digits. Spelling them out keeps every fixture
// below unambiguous about WHY an id survived or didn't.
const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
const C = '33333333-3333-4333-8333-333333333333'
const D = '44444444-4444-4444-8444-444444444444'

const links = (...groups) => JSON.stringify(groups.map((g) => g.map((id) => ({ id }))))

describe('parseLinkedFindings — what counts as a links file', () => {
  it('reads the format: an array of arrays of {id}', () => {
    const parsed = parseLinkedFindings(links([A, B], [C, D]))
    assert.deepEqual(parsed, { groups: [[A, B], [C, D]], skipped: 0 })
  })

  it('ignores fields alongside the id — a richer export is a superset, not another format', () => {
    const content = JSON.stringify([
      [{ id: A, title: 'Command injection', report: 'a.json' }, { id: B, severity: 'high' }],
    ])
    assert.deepEqual(parseLinkedFindings(content), { groups: [[A, B]], skipped: 0 })
  })

  // Everything below has to keep reading as what it is. A report that
  // came back as a links file would vanish from the findings view
  // entirely, so these are the cases that matter most.
  it('refuses reports, JSON that is not a report, and text', () => {
    for (const content of [
      JSON.stringify({ findings: [{ id: A }, { id: B }] }),
      JSON.stringify({ groups: [[{ id: A }, { id: B }]] }),
      '{}',
      'null',
      '',
      'not json at all',
      '# Security Audit Report\n\n## Technical Findings Detail\n',
    ]) {
      assert.equal(parseLinkedFindings(content), null, JSON.stringify(content).slice(0, 40))
    }
  })

  it('refuses arrays that are not arrays of link entries', () => {
    for (const content of [
      '[1,2,3]',                                   // a list of numbers
      '[[1,2]]',                                   // a link of numbers
      `[["${A}","${B}"]]`,                         // bare ids, not {id}
      `[[{"id":"${A}"}],${JSON.stringify({ id: B })}]`, // an entry outside a link
      '[[{"name":"a"},{"name":"b"}]]',             // objects, but no id
      '[[{"id":123}]]',                            // id that isn't a string
      '[[[{"id":"x"}]]]',                          // one nesting level too many
    ]) {
      assert.equal(parseLinkedFindings(content), null, content.slice(0, 40))
    }
  })

  // `[]` is every empty JSON list there is. Claiming it would mean any
  // empty array the user drops opens as a links file with nothing in
  // it, which tells them less than "this isn't something I read".
  it('refuses an empty top-level array', () => {
    assert.equal(parseLinkedFindings('[]'), null)
  })
})

describe('parseLinkedFindings — what survives normalisation', () => {
  it('drops an id repeated inside one link', () => {
    assert.deepEqual(parseLinkedFindings(links([A, B, A])), { groups: [[A, B]], skipped: 0 })
  })

  it('drops a link that names fewer than two findings — it links nothing', () => {
    assert.deepEqual(parseLinkedFindings(links([A], [B, C], [])), { groups: [[B, C]], skipped: 0 })
  })

  // A session-local numeric id is re-minted on every load, so a link
  // built on one would point at an arbitrary other finding tomorrow —
  // the same reason the per-finding Link button refuses to offer one.
  it('counts ids the app could never follow as skipped, and keeps the file', () => {
    const parsed = parseLinkedFindings(links([A, '42', B]))
    assert.deepEqual(parsed, { groups: [[A, B]], skipped: 1 })
  })

  it('stays a links file even when every link normalises away', () => {
    assert.deepEqual(parseLinkedFindings(links(['42'], [A])), { groups: [], skipped: 1 })
  })

  it('keeps the order the file wrote, in the links and inside them', () => {
    const parsed = parseLinkedFindings(links([C, A], [D, B]))
    assert.deepEqual(parsed.groups, [[C, A], [D, B]])
  })
})

describe('countLinkedIds — findings, not links', () => {
  it('counts a finding named by two links once', () => {
    assert.equal(countLinkedIds([[A, B], [B, C]]), 3)
  })

  it('is zero for a file with no links left', () => {
    assert.equal(countLinkedIds([]), 0)
  })
})

describe('collectDuplicates — what a finding card is told', () => {
  it('gives every member of a link the others, and never itself', () => {
    const index = collectDuplicates([[A, B, C]], new Map())
    assert.deepEqual([...index.get(A)], [B, C])
    assert.deepEqual([...index.get(B)], [A, C])
    assert.deepEqual([...index.get(C)], [A, B])
  })

  // Union across files, deliberately NOT transitive closure. Two files
  // saying a≡b and b≡c have not said a≡c between them, and a card
  // claiming they did would put a statement in front of the reader
  // that no file they hold ever made.
  it('unions across links without inferring a link nobody wrote', () => {
    const index = collectDuplicates([[B, C]], collectDuplicates([[A, B]], new Map()))
    assert.deepEqual([...index.get(B)].toSorted(), [A, C].toSorted())
    assert.deepEqual([...index.get(A)], [B], 'a was never said to be c')
    assert.deepEqual([...index.get(C)], [B], 'and c was never said to be a')
  })
})

describe('a links file among the reports', () => {
  beforeEach(() => { globalThis.localStorage.clear() })

  // The count is LINKED FINDINGS, not links: it's the number the view
  // leads with, and the one that answers "how much of my triage does
  // this file touch".
  it('is recognized by analyzeContent, under its own kind', () => {
    assert.deepEqual(analyzeContent(links([A, B], [B, C])), {
      count: 3,
      source: LINKS_KIND,
      recognized: true,
    })
  })

  it('is filed in its own sidebar bucket, not with the reports', () => {
    setCount('dupes.json', 3, LINKS_KIND)
    assert.equal(groupOf('dupes.json'), LINKS_KIND)
    // And a JSON dump keeps the default bucket — the two are told
    // apart by content, never by the extension they share.
    setCount('dump.json', 12, undefined)
    assert.equal(groupOf('dump.json'), 'default')
  })
})
