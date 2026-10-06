import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseLinkedFindings } from '../client/linked-findings.js'
import { groupLinkedReportRows } from '../ui/view/linked-report-rows.js'
import { isAppFinding } from '@preventive/report'

// Mirror what the index stamps on each member (client/bundle-finding-index.js):
// the layer answer, derived once from the producer and the revalidation stamp.
// Re-applied by the tests that edit those two fields after building a row.
const stampRow = (r) => { for (const f of r.members) f.isApp = isAppFinding(f, f.source); return r }
const row = (report, ids, source = null) =>
  stampRow({ report, index: 0, members: ids.map((id) => ({ id, title: `Finding ${id}`, source })) })
const members = (rows) => rows.map((r) => r.members.map((f) => f.id))

describe('linked report rows', () => {
  it('shows AB, AC, D separately and combines the two reports with AB', () => {
    const { groups } = parseLinkedFindings(JSON.stringify([[{ id: 'A' }, { id: 'B' }, { id: 'C' }, { id: 'D' }]]))
    const input = [row('first', ['A', 'B']), row('second', ['A', 'B']), row('third', ['A', 'C']), row('fourth', ['D'])]
    const original = structuredClone(input)
    const { rows, missing } = groupLinkedReportRows(groups[0], input)
    assert.deepEqual(members(rows), [['A', 'B'], ['A', 'C'], ['D']])
    assert.deepEqual(rows.map((r) => r.reports), [
      [{ name: 'first', findingId: 'A', rowIndex: 0 }, { name: 'second', findingId: 'A', rowIndex: 0 }],
      [{ name: 'third', findingId: 'A', rowIndex: 0 }],
      [{ name: 'fourth', findingId: 'D', rowIndex: 0 }],
    ])
    assert.deepEqual(missing, [])
    assert.deepEqual(input, original)
  })

  it('matches membership independent of order and deduplicates report chips', () => {
    const second = row('second', ['B', 'A'])
    // Equivalent metadata must not depend on object property order or whether
    // an absent revalidation stamp is represented as undefined or empty.
    second.members = second.members.map((f) => ({ source: f.source, revalidate: '', title: f.title, id: f.id }))
    stampRow(second)
    const { rows } = groupLinkedReportRows(['A', 'B'], [
      row('first', ['A', 'B']), second, row('first', ['A', 'B']),
    ])
    assert.deepEqual(members(rows), [['A', 'B']])
    assert.deepEqual(rows[0].reports, [{ name: 'first', findingId: 'A', rowIndex: 0 }, { name: 'second', findingId: 'B', rowIndex: 0 }])
  })

  it('preserves both ignore scopes of an id while merging reordered copies of the row', () => {
    const dependency = { id: 'A', title: 'Dependency', file: 'node_modules/pkg/a.js', isApp: false }
    for (const shared of [{ ...dependency, isApp: true }, { ...dependency, file: 'src/a.js' }]) {
      const first = { report: 'first', index: 0, members: [shared, dependency, { ...dependency }] }
      const second = { report: 'second', index: 0, members: [dependency, shared, { ...shared }] }
      const input = [first, second]
      const original = structuredClone(input)
      const { rows, missing } = groupLinkedReportRows(['A'], input)
      assert.equal(rows.length, 1, 'reordering the scopes must not split identical cards')
      assert.deepEqual(rows[0].members, [shared, dependency], 'keep both scopes and deduplicate within each scope')
      assert.deepEqual(rows[0].reports.map(r => r.name), ['first', 'second'])
      assert.deepEqual(missing, [])
      assert.deepEqual(input, original)
      const reversed = groupLinkedReportRows(['A'], input.toReversed())
      assert.equal(reversed.rows[0].key, rows[0].key, 'the canonical row key includes both scopes regardless of order')
      assert.deepEqual(reversed.rows[0].members, [dependency, shared])
    }
  })

  for (const [field, value] of [['title', 'Updated title'], ['source', 'claude-security'], ['revalidate', 'revalidation']]) {
    it(`keeps report copies separate when a linked member's ${field} differs`, () => {
      const first = row('first', ['A', 'B'])
      const second = row('second', ['A', 'B'])
      second.members[0][field] = value
      stampRow(second)
      const { rows } = groupLinkedReportRows(['A', 'B'], [first, second])
      assert.equal(rows.length, 2)
      assert.notEqual(rows[0].key, rows[1].key)
      assert.deepEqual(rows.map((r) => r.members), [first.members, second.members])
      assert.deepEqual(rows.map((r) => r.reports), [
        [{ name: 'first', findingId: 'A', rowIndex: 0 }],
        [{ name: 'second', findingId: 'A', rowIndex: 0 }],
      ])
    })
  }

  it('preserves titles on visible context members as well as explicitly linked findings', () => {
    const first = row('first', ['A', 'B'], 'codex-security')
    const second = row('second', ['A', 'B'], 'codex-security')
    second.members[1].title = 'A different context title'
    const { rows } = groupLinkedReportRows(['A'], [first, second])
    assert.equal(rows.length, 2)
    assert.deepEqual(rows.map((r) => r.members), [first.members, second.members])
    assert.deepEqual(rows.map((r) => r.reports.map((report) => report.name)), [['first'], ['second']])
  })

  it('keeps unlinked findings from other tools as row context', () => {
    const { rows, missing } = groupLinkedReportRows(['A', 'B', 'missing'], [
      row('first', ['A', 'B', 'X'], 'codex-security'), row('second', ['A', 'B', 'Y'], 'claude-security'), row('unrelated', ['Z']),
    ])
    assert.deepEqual(members(rows), [['A', 'B', 'X'], ['A', 'B', 'Y']])
    assert.deepEqual(missing, ['missing'])
  })

  it('hides only unlinked DeepView findings without a revalidation stamp', () => {
    const input = row('mixed', ['linked', 'original', 'confirmed', 'refuted', 'pass', 'codex', 'deepsec', 'claude', 'piolium'])
    input.members.find((f) => f.id === 'confirmed').revalidate = 'confirmed'
    input.members.find((f) => f.id === 'refuted').revalidate = 'refuted'
    input.members.find((f) => f.id === 'pass').revalidate = 'revalidation'
    for (const [id, source] of [['codex', 'codex-security'], ['deepsec', 'deepsec'], ['claude', 'claude-security'], ['piolium', 'piolium']]) {
      input.members.find((f) => f.id === id).source = source
    }
    stampRow(input)
    const original = structuredClone(input)
    const result = groupLinkedReportRows(['linked', 'missing'], [input])
    assert.deepEqual(members(result.rows), [['linked', 'pass', 'codex', 'deepsec', 'claude', 'piolium']])
    assert.deepEqual(result.missing, ['missing'])
    assert.deepEqual(input, original)
    const explicitlyLinked = groupLinkedReportRows(['original', 'confirmed', 'refuted'], [input])
    assert.deepEqual(members(explicitlyLinked.rows), [['original', 'confirmed', 'refuted', 'pass', 'codex', 'deepsec', 'claude', 'piolium']])
  })

  it('preserves original row boundaries when hidden members differ', () => {
    const { rows } = groupLinkedReportRows(['A', 'B'], [
      row('first', ['A', 'B', 'X']), row('second', ['A', 'B', 'Y']),
    ])
    assert.deepEqual(members(rows), [['A', 'B'], ['A', 'B']])
    assert.notEqual(rows[0].key, rows[1].key)
    assert.deepEqual(rows.map((r) => r.reports.map((p) => p.name)), [['first'], ['second']])
  })

  it('keeps reports separate when the same id is a revalidation in only one', () => {
    const first = row('first', ['A', 'B'])
    const second = row('second', ['A', 'B'])
    second.members[1].revalidate = 'revalidation'
    stampRow(second)
    const { rows } = groupLinkedReportRows(['A'], [first, second])
    assert.deepEqual(members(rows), [['A'], ['A', 'B']])
    assert.deepEqual(rows.map((r) => r.reports.map((p) => p.name)), [['first'], ['second']])
  })

  it('orders cards by the first linked member and keeps unknown IDs', () => {
    const { rows, missing } = groupLinkedReportRows(['D', 'B', 'A', 'unknown'], [
      row('first', ['A']), row('second', ['B']), row('third', ['D']),
    ])
    assert.deepEqual(members(rows), [['D'], ['B'], ['A']])
    assert.deepEqual(missing, ['unknown'])
    assert.deepEqual(groupLinkedReportRows(['A', 'B'], []), { rows: [], missing: ['A', 'B'] })
  })
})
