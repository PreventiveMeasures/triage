// Finding ids for Claude Security (markdown) imports — the uuid every
// piece of stored triage hangs off (markers, buckets, comments, fixes).
//
// `common/parse-md-id.js` freezes that fingerprint against a snapshot of
// the parser as it stood before the `## Evidence` work, so reshaping the
// RENDERED description can never re-key what a user has already triaged.
// The uuids below are the ones the pre-Evidence parser produced for
// these exact documents: they are golden values, not something to
// regenerate when a test fails. A failure here means the ids in users'
// browsers no longer match the ones the app derives.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { deriveFindingId } from '../common/finding-id.js'
import { parseMarkdownFindings } from '../common/parse-md.js'

// The legacy shape: a `## Location` section, bold inside the prose, and
// a second finding carrying no location at all (which the legacy code
// fingerprinted by file / line — 'unknown' / '?').
const LEGACY_REPORT = [
  '# Unsafe deserialization',
  '',
  '## Details',
  'The loader **trusts** input from `config.yml`.',
  '',
  '## Location',
  '[src/load.ts:42](https://github.com/o/r/blob/abc/src/load.ts#L42)',
  '',
  '## Impact',
  'RCE.',
  '',
  '## Reproduction steps',
  'Feed it a crafted file.',
  '',
  '## Recommended fix',
  'Use a safe loader.',
  '',
  '---',
  '**Severity:** critical',
  '**Status:** Open',
  '**Category:** Security',
  '**Repository:** o/r',
  '',
  '# Second finding, no location section',
  '',
  '## Details',
  'Something else.',
  '',
  '---',
  '**Severity:** low',
].join('\n')

const LEGACY_IDS = [
  '9506b995-d8f2-4858-89a3-d51424a50696',
  'a29598b6-024e-49ca-9166-1cacffed2b1a',
]

const idsOf = (md) => Promise.all(parseMarkdownFindings(md).findings.map((f) => deriveFindingId(f)))

describe('markdown finding ids — frozen against the legacy parse', () => {
  it('derives the ids the pre-Evidence parser derived', async () => {
    assert.deepEqual(await idsOf(LEGACY_REPORT), LEGACY_IDS)
  })

  it('keys a located finding off the location, an unlocated one off file / line', () => {
    const [located, unlocated] = parseMarkdownFindings(LEGACY_REPORT).findings
    assert.deepEqual(located._idBasis, {
      severity: 'critical',
      description: located._idBasis.description,
      location: 'https://github.com/o/r/blob/abc/src/load.ts#L42',
    })
    assert.deepEqual(unlocated._idBasis, {
      severity: 'low',
      description: 'Second finding, no location section\n\nSomething else.',
      file: 'unknown',
      line: '?',
    })
  })

  it('fingerprints the LEGACY description, not the rendered one', () => {
    const f = parseMarkdownFindings(LEGACY_REPORT).findings[0]
    // What the card renders today: bold section labels, the report's own
    // emphasis kept. What the id is keyed by: neither.
    assert.match(f.description, /\*\*Impact:\*\* RCE\./u)
    assert.match(f.description, /\*\*trusts\*\*/u)
    assert.equal(f._idBasis.description, [
      'Unsafe deserialization',
      '',
      'The loader trusts input from `config.yml`.',
      '',
      'Impact: RCE.',
      '',
      'Reproduction: Feed it a crafted file.',
    ].join('\n'))
  })

  it('survives a later reshaping of the rendered description', async () => {
    const f = parseMarkdownFindings(LEGACY_REPORT).findings[0]
    const before = await deriveFindingId(f)
    // Stand-in for the next rendering change — sections reordered, a
    // label renamed, prose lifted into a field of its own.
    f.description = 'Something a future renderer produced'
    f.recommendation = 'and a different recommendation'
    assert.equal(await deriveFindingId(f), before)
    assert.equal(before, LEGACY_IDS[0])
  })
})

// `## Evidence` reports carry no `## Location`, so the snapshot alone
// would fingerprint every finding in one report as file 'unknown' /
// line '?' — identical prose would then collapse two findings into one
// id. The basis falls back to the location today's parser resolved (the
// first evidence row) while still keying the TEXT off the snapshot.
describe('markdown finding ids — the `## Evidence` shape', () => {
  const evidenceReport = (...refs) => refs.map((ref) => [
    '# Same title everywhere',
    '',
    '## Details',
    'Identical prose.',
    '',
    '## Evidence',
    `1. ${ref}`,
    '   A note that differs too.',
    '',
    '---',
    '**Severity:** high',
  ].join('\n')).join('\n\n')

  it('tells apart findings whose only difference is the evidence', async () => {
    const [a, b] = await idsOf(evidenceReport(
      '[src/a.ts:10](https://github.com/o/r/blob/abc/src/a.ts#L10)',
      '[src/b.ts:20](https://github.com/o/r/blob/abc/src/b.ts#L20)',
    ))
    assert.notEqual(a, b)
  })

  it('falls back to the row\'s file / line when it carries no link', () => {
    const f = parseMarkdownFindings(evidenceReport('src/a.ts:10')).findings[0]
    assert.deepEqual(f._idBasis, {
      severity: 'high',
      description: 'Same title everywhere\n\nIdentical prose.',
      // The raw text of an unlinked row is what the legacy code kept as
      // its location discriminator, so it stays the discriminator here.
      location: 'src/a.ts:10',
    })
  })

  it('keys off the evidence row, not the note under it', async () => {
    const ref = '[src/a.ts:10](https://github.com/o/r/blob/abc/src/a.ts#L10)'
    const one = parseMarkdownFindings(evidenceReport(ref)).findings[0]
    const other = parseMarkdownFindings(
      evidenceReport(ref).replace('A note that differs too.', 'A completely different note.'),
    ).findings[0]
    assert.equal(await deriveFindingId(one), await deriveFindingId(other))
  })
})
