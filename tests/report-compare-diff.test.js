import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { computeReportDiff, parseComparisonReport, reportClusters, reportPairs, reportValues } from '../ui/view/report-compare-diff.js'

const parse = data => parseComparisonReport(JSON.stringify(data))
const grouped = rows => parse({ groups: rows.map(ids => ids.map(id => ({ id }))) })
const diff = (before, after) => computeReportDiff(grouped(before), grouped(after))

describe('report comparison identity and grouping', () => {
  it('accepts raw arrays, findings and groups without changing the source data', () => {
    const entries = [[{ id: 'a' }, { id: 'b' }, { id: 'a' }], { id: 'c' }]
    for (const data of [entries, { findings: entries }, { groups: entries }]) {
      const original = JSON.stringify(data)
      const report = parse(data)
      assert.deepEqual(report.rows, [['a', 'b'], ['c']])
      assert.equal(report.byId.size, 3)
      assert.equal(report.byId.get('a').length, 2)
      assert.equal(JSON.stringify(data), original)
    }
  })

  it('rejects links before raw-array wrapping while preserving explicit report groups', () => {
    for (const entries of [
      [[{ id: 'a' }, { id: 'b' }]],
      [[{ id: 'a', title: 'Link label', report: 'source.json' }, { id: 'b', severity: 'high' }]],
      [[{ id: 'a', description: 'Finding text', file: 'src/a.js' }]],
      [[{ id: '42' }], []],
      [[]],
    ]) {
      assert.throws(() => parse(entries), /links file.*groups.*findings/u)
      // The wrapper disambiguates report rows even when they contain only ids.
      const asGroups = parse({ groups: entries })
      const asFindings = parse({ findings: entries })
      assert.equal(computeReportDiff(asGroups, asFindings).unchanged, true)
      assert.equal(asGroups.byId.size, new Set(entries.flat().map(finding => finding.id)).size)
    }
  })

  it('counts missing ids without inventing identity or treating malformed entries as findings', () => {
    const report = parse({ findings: [null, 'bad', { title: 'Missing' }, { id: '' }, { id: 'ok' }] })
    assert.equal(report.missingIds, 2)
    assert.deepEqual([...report.byId.keys()], ['ok'])
    assert.throws(() => parse({ unrelated: [] }), /not a report/u)
    assert.throws(() => parseComparisonReport('{'), /Not JSON/u)
    assert.equal(parse([]).byId.size, 0)
  })

  it('ignores row/member order, duplicates and singleton rows when comparing links', () => {
    assert.equal(diff([['a', 'b', 'b'], ['c']], [['c'], ['b', 'a'], ['a']]).unchanged, true)
    assert.equal(reportPairs([['a', 'a'], ['a']]).size, 0)
  })

  it('reports additions and removals without inventing regrouping around new or lost ids', () => {
    const result = diff([['a', 'b', 'old']], [['a', 'b', 'new']])
    assert.deepEqual(result.added, ['new'])
    assert.deepEqual(result.removed, ['old'])
    assert.deepEqual(result.shared, ['a', 'b'])
    assert.deepEqual(result.joined, [])
    assert.deepEqual(result.split, [])
  })

  it('clusters chained changed pairs and keeps simultaneous joins and splits separate', () => {
    const result = diff([['a', 'b'], ['c', 'd']], [['a', 'c'], ['b', 'd']])
    assert.deepEqual(result.joined, [['a', 'c'], ['b', 'd']])
    assert.deepEqual(result.split, [['a', 'b'], ['c', 'd']])
    assert.deepEqual(diff([['a'], ['b'], ['c']], [['a', 'b'], ['b', 'c']]).joined, [['a', 'b', 'c']])
    // Existing paths do not imply an asserted pair: AB + BC is not ABC.
    assert.deepEqual(diff([['a', 'b'], ['b', 'c']], [['a', 'b', 'c']]).joined, [['a', 'c']])
  })

  it('keeps unusual ids unambiguous and reverses directional changes', () => {
    assert.deepEqual(reportClusters(reportPairs([['a\tb', 'c'], ['a', 'b\tc']])), [['a', 'b\tc'], ['a\tb', 'c']])
    const forward = diff([['a'], ['b'], ['old']], [['a', 'b'], ['new']])
    const reverse = diff([['a', 'b'], ['new']], [['a'], ['b'], ['old']])
    assert.deepEqual(forward.joined, reverse.split)
    assert.deepEqual(forward.added, reverse.removed)
    assert.deepEqual(forward.removed, reverse.added)
    assert.equal(diff([], []).unchanged, true)
    assert.deepEqual(diff([['a']], [['b']]).shared, [])
  })
})

describe('report comparison verdicts and ratings', () => {
  it('separates confirmed, refuted and other verdict transitions on shared ids', () => {
    const before = parse({ findings: [
      { id: 'a', revalidate: 'refuted' }, { id: 'b', revalidate: 'confirmed' },
      { id: 'c', revalidate: 'confirmed' }, { id: 'd' },
    ] })
    const after = parse({ findings: [
      { id: 'a', revalidate: 'confirmed' }, { id: 'b', revalidate: 'refuted' },
      { id: 'c' }, { id: 'd', revalidate: 'unreachable' }, { id: 'new', revalidate: 'confirmed' },
    ] })
    const result = computeReportDiff(before, after)
    assert.deepEqual(result.confirmed, [{ id: 'a', before: ['refuted'], after: ['confirmed'] }])
    assert.deepEqual(result.refuted, [{ id: 'b', before: ['confirmed'], after: ['refuted'] }])
    assert.deepEqual(result.otherVerdicts, [
      { id: 'c', before: ['confirmed'], after: [null] }, { id: 'd', before: [null], after: ['unreachable'] },
    ])
    assert.deepEqual(result.added, ['new'])
  })

  it('compares zero confidence, missing ratings, corrected and original severity independently', () => {
    const before = parse({ findings: [
      { id: 'a', confidence: 0, severity: 'high' },
      { id: 'b', confidence: 10, severity: 'low', correctedSeverity: 'medium' },
      { id: 'c', severity: 'high' },
    ] })
    const after = parse({ findings: [
      { id: 'a', confidence: 7, severity: 'high', correctedSeverity: 'low' },
      { id: 'b', severity: 'high', correctedSeverity: 'medium' },
      { id: 'c', severity: 'high', correctedSeverity: 'nonsense' },
    ] })
    const result = computeReportDiff(before, after)
    assert.deepEqual(result.confidence, [{ id: 'a', before: [0], after: [7] }, { id: 'b', before: [10], after: [null] }])
    assert.deepEqual(result.severity, [
      { id: 'a', before: ['high'], after: ['low'], originalBefore: ['high'], originalAfter: ['high'] },
      { id: 'b', before: ['medium'], after: ['medium'], originalBefore: ['low'], originalAfter: ['high'] },
    ])
    assert.equal(result.unchanged, false)
  })

  it('preserves conflicting copies of an id and ignores occurrence order/multiplicity', () => {
    const a = { id: 'a', confidence: 2, revalidate: 'confirmed' }
    const b = { id: 'a', confidence: 9, revalidate: 'refuted' }
    const before = parse([a, b])
    assert.deepEqual(reportValues(before, 'a', 'confidence'), [2, 9])
    assert.equal(computeReportDiff(before, parse([b, a, b])).unchanged, true)
    const result = computeReportDiff(parse([a]), before)
    assert.deepEqual(result.confidence[0].after, [2, 9])
    assert.deepEqual(result.otherVerdicts[0].after, ['confirmed', 'refuted'])
  })

  it('does not confuse presence changes with rating changes or mutate the snapshots', () => {
    const before = parse([{ id: 'old', severity: 'high', confidence: 1 }])
    const after = parse([{ id: 'new', severity: 'low', confidence: 9 }])
    const snapshots = structuredClone([before, after])
    const result = computeReportDiff(before, after)
    assert.deepEqual(result.confidence, [])
    assert.deepEqual(result.severity, [])
    assert.deepEqual([before, after], snapshots)
  })
})
