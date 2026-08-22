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

// `## Evidence` reports carry no `## Location`, and this snapshot
// predates that section entirely — so their findings key off a
// description with no evidence in it, by file 'unknown' / line '?',
// which is exactly what v1.0.0-alpha.10 derived for the same document.
// Evidence data staying out of the hash is the deliberate trade: an id
// that leaves something out is recoverable, an id that moves is not.
describe('markdown finding ids — the `## Evidence` shape', () => {
  const evidenceReport = (ref, note) => [
    '# Prototype pollution in the config merge',
    '',
    '## Details',
    'The loader trusts input.',
    '',
    '## Evidence',
    `1. ${ref}`,
    `   ${note}`,
    '',
    '## Impact',
    'RCE.',
    '',
    '---',
    '**Severity:** critical',
  ].join('\n')

  const LINKED = evidenceReport('[src/a.ts:10](https://example.com/a.ts#L10)', 'The merge loop.')

  // Golden: what alpha.10's parser + deriveFindingId produced for this
  // document, back when it could see none of its Evidence section.
  const ALPHA_10_ID = '889344d7-2fa6-4482-8506-c540556a1e10'

  it('derives the id alpha.10 derived, evidence excluded', async () => {
    assert.deepEqual(await idsOf(LINKED), [ALPHA_10_ID])
  })

  it('keys by file `unknown` / line `?`, over a description with no evidence', () => {
    const f = parseMarkdownFindings(LINKED).findings[0]
    assert.deepEqual(f._idBasis, {
      severity: 'critical',
      description: [
        'Prototype pollution in the config merge',
        '',
        'The loader trusts input.',
        '',
        'Impact: RCE.',
      ].join('\n'),
      file: 'unknown',
      line: '?',
    })
    // …while the finding itself resolves the evidence row perfectly well.
    assert.equal(f.file, 'src/a.ts')
    assert.equal(f.location, 'https://example.com/a.ts#L10')
  })

  it('does not move when the evidence rows change', async () => {
    const [same] = await idsOf(evidenceReport(
      '[src/b.ts:20](https://example.com/b.ts#L20)', 'A different note.',
    ))
    assert.equal(same, ALPHA_10_ID)
  })
})

// The breadth pin: one document per shape the parser meets, each with
// the uuid v1.0.0-alpha.10 derived for it. Regenerating a value here
// because a test went red is the one thing this file exists to stop —
// a changed uuid means every marker, bucket, comment and fix a user
// stored against that finding has been orphaned.
const ALPHA_10_GOLDEN = [
  ["location, linked", "# T\n\n## Details\nD **bold**.\n\n## Location\n[src/a.ts:42](https://e.com/a.ts#L42)\n\n## Impact\nI.\n\n---\n**Severity:** high",
    ["1727e7c7-d672-4074-838f-46cc4c1b98c4"]],
  ["location, plain text", "# T\n\n## Location\nsrc/a.ts:42\n\n---\n**Severity:** low",
    ["9fa72e7f-0cf6-469e-b174-e8cd1eac85f5"]],
  ["location, backticked", "# T\n\n## Location\n[`src/a.ts:42`](https://e.com/a.ts)\n\n---\n**Severity:** low",
    ["44e18a79-88c0-4c08-acfc-b6c60aa9c8ed"]],
  ["location, escaped path", "# T\n\n## Location\n[a/b/\\_c\\_c/i.js:1](https://e.com/i.js#L1)\n\n---\n**Severity:** medium",
    ["07c25115-f481-4bad-9847-cae38fab9215"]],
  ["location, range", "# T\n\n## Location\n[src/a.ts:10–20](https://e.com/a.ts#L10-L20)\n\n---\n**Severity:** medium",
    ["bebfed90-182b-4529-ac2f-bb65af378049"]],
  ["no location at all", "# T\n\n## Details\nJust prose.\n\n---\n**Severity:** bug",
    ["027a023b-7cd9-43d1-abab-f74de8aaaa49"]],
  ["evidence, linked rows", "# T\n\n## Details\nD.\n\n## Evidence\n1. [src/a.ts:10](https://e.com/a.ts#L10)\n   note a\n2. [src/b.ts:20](https://e.com/b.ts#L20)\n   note b\n\n## Impact\nI.\n\n---\n**Severity:** critical",
    ["9948df4a-b290-4bf8-89dc-41b3c30a8b46"]],
  ["evidence, unlinked row", "# T\n\n## Evidence\n1. src/a.ts:10\n   note\n\n---\n**Severity:** high",
    ["eeaa24fd-b835-4d44-ad9b-fd00ee155924"]],
  ["evidence + location", "# T\n\n## Location\n[src/loc.ts:5](https://e.com/loc.ts#L5)\n\n## Evidence\n1. [src/ev.ts:10](https://e.com/ev.ts#L10)\n\n---\n**Severity:** high",
    ["3aa0baaf-22b5-4309-8ec5-05e7428c9717"]],
  ["evidence, prose only", "# T\n\n## Evidence\nNothing citable.\nOnly prose.\n\n---\n**Severity:** low",
    ["50fe443c-3ccd-49a8-b262-a493cb86461b"]],
  ["all sections + repro", "# T\n\n## Details\nD.\n\n## Location\n[a.ts:1](https://e.com/a.ts#L1)\n\n## Impact\nI.\n\n## Reproduction steps\nR.\n\n## Recommended fix\nF.\n\n---\n**Severity:** critical\n**Repository:** o/r\n**Branch:** main",
    ["349a9342-61d8-450f-aa0f-21e59986011f"]],
  ["two findings, one doc", "# A\n\n## Location\n[a.ts:1](https://e.com/a.ts#L1)\n\n---\n**Severity:** high\n\n# B\n\n## Location\n[b.ts:2](https://e.com/b.ts#L2)\n\n---\n**Severity:** low",
    ["ab8ef4a8-d80d-4a51-b87a-44e2b363eeb9","b4a0bbc7-acdd-47b1-b65b-5ceae738c9a6"]],
  ["crlf + no severity", "# T\r\n\r\n## Details\r\nD.\r\n\r\n## Location\r\n[a.ts:1](https://e.com/a.ts#L1)\r\n\r\n---\r\n**Status:** Open\r\n",
    ["bba7a8a4-e0e2-474d-9a2f-b60562385868"]],
]

describe('markdown finding ids — the alpha.10 golden table', () => {
  for (const [shape, doc, ids] of ALPHA_10_GOLDEN) {
    it(`keys ${shape} exactly as alpha.10`, async () => {
      assert.deepEqual(await idsOf(doc), ids)
    })
  }
})
