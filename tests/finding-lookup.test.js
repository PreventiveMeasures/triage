// `client/finding-lookup.js` — pure metadata-shaping helpers used by
// the conflict-resolution dialogs. `firstDescriptionLine` is a string
// utility; `buildFindingLookupForLoadedReports` walks `state.reports`
// to collect per-id metadata for the conflict ids and stops as soon as
// every wanted id has been resolved.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

const { state } = await import('../client/state.js')
const { firstDescriptionLine, buildFindingLookupForLoadedReports } = await import('../client/finding-lookup.js')

function setReports(reports) {
  state.reports.length = 0
  for (const r of reports) state.reports.push(r)
}

describe('firstDescriptionLine', () => {
  it('returns "" for falsy input', () => {
    assert.equal(firstDescriptionLine(''), '')
    assert.equal(firstDescriptionLine(undefined), '')
    assert.equal(firstDescriptionLine(null), '')
  })

  it('returns the first non-empty trimmed line', () => {
    assert.equal(firstDescriptionLine('hello world'), 'hello world')
    assert.equal(firstDescriptionLine('   spaced   '), 'spaced')
  })

  it('skips leading blank lines', () => {
    assert.equal(firstDescriptionLine('\n\n  \n\nactual\n'), 'actual')
  })

  it('returns "" for whitespace-only multi-line input', () => {
    assert.equal(firstDescriptionLine('\n   \n\t\n   '), '')
  })

  it('does not look past the first non-blank line', () => {
    assert.equal(firstDescriptionLine('line A\nline B\nline C'), 'line A')
  })
})

describe('buildFindingLookupForLoadedReports', () => {
  it('returns an empty Map when conflicts is empty', () => {
    setReports([])
    const lookup = buildFindingLookupForLoadedReports([])
    assert.equal(lookup.size, 0)
  })

  it('returns an empty Map when no loaded report covers any wanted id', () => {
    setReports([{ groups: [[{ id: 'other-id', severity: 'low', file: 'x.js', line: 1 }]] }])
    const lookup = buildFindingLookupForLoadedReports([{ id: 'wanted', property: 'color' }])
    assert.equal(lookup.size, 0)
  })

  it('captures severity, file, line, and first description line', () => {
    setReports([{
      groups: [[{
        id: 'A', severity: 'high', file: 'src/x.js', line: 42,
        description: 'First line\n\nMore detail.',
      }]],
    }])
    const lookup = buildFindingLookupForLoadedReports([{ id: 'A', property: 'color' }])
    assert.deepEqual(lookup.get('A'), {
      severity: 'high',
      file: 'src/x.js',
      line: 42,
      description: 'First line',
    })
  })

  it('matches by `f.id` first, falls back to `String(f._id)`', () => {
    setReports([{
      groups: [[
        { id: 'with-id', severity: 'high', file: 'a.js', line: 1, description: 'A' },
        { _id: 7, severity: 'low', file: 'b.js', line: 2, description: 'B' },
      ]],
    }])
    const lookup = buildFindingLookupForLoadedReports([
      { id: 'with-id', property: 'color' },
      { id: '7', property: 'comment' },
    ])
    assert.equal(lookup.get('with-id')?.file, 'a.js')
    assert.equal(lookup.get('7')?.file, 'b.js')
  })

  it('keeps the FIRST occurrence when the same id appears in multiple reports', () => {
    setReports([
      { groups: [[{ id: 'shared', severity: 'high', file: 'first.js', line: 1, description: 'first hit' }]] },
      { groups: [[{ id: 'shared', severity: 'low', file: 'second.js', line: 2, description: 'second hit' }]] },
    ])
    const lookup = buildFindingLookupForLoadedReports([{ id: 'shared', property: 'color' }])
    assert.equal(lookup.get('shared').file, 'first.js')
    assert.equal(lookup.get('shared').description, 'first hit')
  })

  it('walks all reports until every wanted id is found', () => {
    setReports([
      { groups: [[{ id: 'A', severity: 'high', file: 'a.js', line: 1, description: 'A' }]] },
      { groups: [[{ id: 'B', severity: 'low', file: 'b.js', line: 2, description: 'B' }]] },
      { groups: [[{ id: 'C', severity: 'medium', file: 'c.js', line: 3, description: 'C' }]] },
    ])
    const lookup = buildFindingLookupForLoadedReports([
      { id: 'A', property: 'color' },
      { id: 'B', property: 'color' },
      { id: 'C', property: 'color' },
    ])
    assert.equal(lookup.size, 3)
    assert.equal(lookup.get('A').file, 'a.js')
    assert.equal(lookup.get('B').file, 'b.js')
    assert.equal(lookup.get('C').file, 'c.js')
  })

  it('handles a report with multiple groups + multiple findings per group', () => {
    setReports([{
      groups: [
        [
          { id: 'g1-a', severity: 'high', file: 'g1a.js', line: 1, description: 'first' },
          { id: 'g1-b', severity: 'low', file: 'g1b.js', line: 2, description: 'second' },
        ],
        [
          { id: 'g2-a', severity: 'medium', file: 'g2a.js', line: 3, description: 'third' },
        ],
      ],
    }])
    const lookup = buildFindingLookupForLoadedReports([
      { id: 'g1-b', property: 'color' },
      { id: 'g2-a', property: 'color' },
    ])
    assert.equal(lookup.size, 2)
    assert.equal(lookup.get('g1-b').file, 'g1b.js')
    assert.equal(lookup.get('g2-a').file, 'g2a.js')
  })
})
