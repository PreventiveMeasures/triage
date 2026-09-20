// Finding ids for Piolium imports — the uuid every piece of stored
// triage hangs off.
//
// `report/src/parse-piolium-id.js` derives that fingerprint from its own
// frozen reading of the finding's reference, so what the CARD shows as a
// file, a line and a link is free to improve without re-keying what a
// user has triaged. The uuids below are golden values, captured from the
// parser before that reading was fixed — not something to regenerate
// when a test fails: a failure here means the ids in users' browsers no
// longer match the ones the app derives.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { deriveFindingId } from '../index.js'
import { parsePioliumFindings } from '../src/parse-piolium.js'

const report = (location) => [
  '# Security Audit Report: example-project',
  '',
  '**Target:** acme/app',
  '**Commit audited:** deadbeef',
  '',
  '## Summary of Findings',
  '',
  '| ID | Title | Severity | PoC Status | Parent |',
  '|----|-------|----------|------------|--------|',
  '| [H1] | Unvalidated id reaches the query | HIGH | blocked | -- |',
  '',
  '## Technical Findings Detail',
  '',
  '### [H1] Unvalidated id reaches the query',
  '',
  `**Location:** ${location}`,
  '**Root Cause:** The route handler trusts the segment.',
  '',
].join('\n')

const first = (location) => parsePioliumFindings(report(location)).findings[0]

// The four readings a reference can get, and what each one's id was
// before the link reading could see a bracket.
const GOLDEN = [
  ['a plain path',
    '[`src/load.ts:42`](https://github.com/acme/app/blob/abc/src/load.ts#L42)',
    'efe26530-1961-4413-bb9f-5723e6d9efe1'],
  ['a Next.js route group',
    '[`app/(main)/[id]/page.ts:12`](https://github.com/acme/app/blob/abc/app/%28main%29/%5Bid%5D/page.ts#L12)',
    '944a5664-d958-4808-bc1b-9a1ee591f0f2'],
  ['a dynamic segment',
    '[`src/[id]/route.ts:7`](https://github.com/acme/app/blob/abc/src/%5Bid%5D/route.ts#L7)',
    'cb732d74-98b2-4f9c-8d7a-fb632dae5a37'],
  ['a url whose parens were never encoded',
    '[`src/x.ts:3`](https://github.com/acme/app/blob/abc/app/(main)/x.ts#L3)',
    '761f8e4d-1bfc-4df7-8807-cbe17024d6fc'],
]

describe('piolium finding ids — the frozen fingerprint', () => {
  for (const [name, location, id] of GOLDEN) {
    it(`derives the golden id for ${name}`, async () => {
      assert.equal(await deriveFindingId(first(location)), id)
    })
  }

  // What each of those ids is the hash of. Three of the four keyed off
  // a reading that was WRONG — the whole `[…](…)` text as a file name,
  // no link at all, a url cut short at a paren — and they keep doing
  // so, because an id that is wrong about a path is recoverable and an
  // id that moves is not.
  it('keys off the reference as it was read then, not as it is read now', () => {
    const [, plain] = GOLDEN[0]
    assert.deepEqual(first(plain)._idBasis, {
      severity: 'high',
      description: first(plain)._idBasis.description,
      location: 'https://github.com/acme/app/blob/abc/src/load.ts#L42',
    })

    const [, group] = GOLDEN[1]
    const grouped = first(group)
    assert.equal(grouped._idBasis.location, undefined, 'no link was found in it then')
    // The whole markdown was the file name — de-backticked, since the
    // old reading fell through to "first whitespace token of the
    // de-backticked text" when its link expression matched nothing.
    assert.equal(grouped._idBasis.file,
      '[app/(main)/[id]/page.ts:12](https://github.com/acme/app/blob/abc/app/%28main%29/%5Bid%5D/page.ts#L12)')
    assert.equal(grouped._idBasis.line, '?')

    const [, truncated] = GOLDEN[3]
    assert.equal(first(truncated)._idBasis.location, 'https://github.com/acme/app/blob/abc/app/(main',
      'the url as the old expression cut it')
  })

  // …while the finding itself now carries what the document cited.
  it('hands the card the reference the id could not', () => {
    const [, group] = GOLDEN[1]
    const f = first(group)
    assert.equal(f.file, 'app/(main)/[id]/page.ts')
    assert.equal(f.line, '12')
    assert.equal(f.location, 'https://github.com/acme/app/blob/abc/app/%28main%29/%5Bid%5D/page.ts#L12')

    const [, truncated] = GOLDEN[3]
    assert.equal(first(truncated).location, 'https://github.com/acme/app/blob/abc/app/(main)/x.ts#L3',
      'the whole url, parens and all')
  })

  it('stamps a basis on every finding, however it was located', () => {
    for (const [, location] of GOLDEN) assert.ok(first(location)._idBasis, location)
    assert.ok(first('')._idBasis, 'and on one with no reference at all')
    assert.ok(first('src/bare.ts:9')._idBasis, 'and on one whose reference is not a link')
  })
})
