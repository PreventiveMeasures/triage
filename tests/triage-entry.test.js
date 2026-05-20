// `client/triage-entry.ts` — pure operations over the unified triage
// map (`Map<findingId, TriageEntry>`). These hold the immutable-replace
// + prune + legacy-migration invariants the whole triage representation
// rests on, so they're pinned here independent of the live `state`
// proxy and the sync host.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

const {
  bucketOf,
  clearReportEverywhere,
  entryIsEmpty,
  ignoredReportsFor,
  isReportIgnored,
  normalizeEntry,
  patchEntry,
  setEntry,
  setReportIgnored,
} = await import('../client/triage-entry.ts')

describe('bucketOf', () => {
  it('reads the triage bucket', () => {
    assert.equal(bucketOf({ triage: 'fixed' }), 'fixed')
    assert.equal(bucketOf({ triage: 'invalid' }), 'invalid')
    assert.equal(bucketOf({ triage: 'deleted' }), 'deleted')
  })
  it('migrates the legacy deleted:true form', () => {
    assert.equal(bucketOf({ deleted: true }), 'deleted')
  })
  it('prefers an explicit bucket over legacy deleted', () => {
    assert.equal(bucketOf({ triage: 'fixed', deleted: true }), 'fixed')
  })
  it('returns undefined for no / invalid bucket', () => {
    assert.equal(bucketOf({}), undefined)
    assert.equal(bucketOf(undefined), undefined)
    assert.equal(bucketOf({ triage: 'bogus' }), undefined)
    assert.equal(bucketOf({ deleted: false }), undefined)
  })
})

describe('entryIsEmpty', () => {
  it('is true for nothing meaningful', () => {
    assert.equal(entryIsEmpty(undefined), true)
    assert.equal(entryIsEmpty({}), true)
    assert.equal(entryIsEmpty({ color: '', comment: '' }), true)
    assert.equal(entryIsEmpty({ ignoredReports: [] }), true)
    assert.equal(entryIsEmpty({ deleted: false }), true)
  })
  it('is false when any field carries a value', () => {
    assert.equal(entryIsEmpty({ color: 'red' }), false)
    assert.equal(entryIsEmpty({ triage: 'fixed' }), false)
    assert.equal(entryIsEmpty({ deleted: true }), false)
    assert.equal(entryIsEmpty({ comment: 'x' }), false)
    assert.equal(entryIsEmpty({ fix: 'pr' }), false)
    assert.equal(entryIsEmpty({ ignoredReports: ['a'] }), false)
  })
})

describe('normalizeEntry', () => {
  it('drops empty fields and returns undefined when nothing remains', () => {
    assert.equal(normalizeEntry({}), undefined)
    assert.equal(normalizeEntry({ color: '', comment: '', fix: '', ignoredReports: [] }), undefined)
    assert.equal(normalizeEntry(null), undefined)
    assert.equal(normalizeEntry('nope'), undefined)
  })
  it('keeps meaningful fields', () => {
    assert.deepEqual(
      normalizeEntry({ color: 'red', comment: 'c', fix: 'pr', triage: 'fixed' }),
      { color: 'red', triage: 'fixed', comment: 'c', fix: 'pr' },
    )
  })
  it('migrates legacy deleted and never re-emits the boolean', () => {
    assert.deepEqual(normalizeEntry({ deleted: true }), { triage: 'deleted' })
    assert.deepEqual(normalizeEntry({ color: 'blue', deleted: true }), { color: 'blue', triage: 'deleted' })
  })
  it('drops invalid triage and non-string ignored reports', () => {
    assert.equal(normalizeEntry({ triage: 'bogus' }), undefined)
    assert.deepEqual(normalizeEntry({ ignoredReports: ['a', 2, '', 'b'] }), { ignoredReports: ['a', 'b'] })
  })
})

describe('patchEntry', () => {
  it('sets a field and reports the change', () => {
    const map = new Map()
    assert.equal(patchEntry(map, 'x', { color: 'red' }), true)
    assert.deepEqual(map.get('x'), { color: 'red' })
  })
  it('merges over the existing entry without clobbering siblings', () => {
    const map = new Map([['x', { color: 'red', comment: 'c' }]])
    patchEntry(map, 'x', { triage: 'fixed' })
    assert.deepEqual(map.get('x'), { color: 'red', triage: 'fixed', comment: 'c' })
  })
  it('clears a field via undefined / empty and prunes the id when empty', () => {
    const map = new Map([['x', { color: 'red' }]])
    assert.equal(patchEntry(map, 'x', { color: undefined }), true)
    assert.equal(map.has('x'), false)
    const map2 = new Map([['y', { color: 'red' }]])
    patchEntry(map2, 'y', { color: '' })
    assert.equal(map2.has('y'), false)
  })
  it('returns false and leaves the map untouched on a no-op patch', () => {
    const map = new Map([['x', { color: 'red' }]])
    const before = map.get('x')
    assert.equal(patchEntry(map, 'x', { color: 'red' }), false)
    assert.equal(map.get('x'), before)
  })
  it('deleting an absent id is not a change', () => {
    const map = new Map()
    assert.equal(patchEntry(map, 'gone', { color: undefined }), false)
  })
})

describe('setEntry', () => {
  it('replaces the entry wholesale and normalizes', () => {
    const map = new Map([['x', { color: 'red', comment: 'c' }]])
    setEntry(map, 'x', { fix: 'pr', deleted: true })
    assert.deepEqual(map.get('x'), { fix: 'pr', triage: 'deleted' })
  })
  it('deletes the id on an empty entry', () => {
    const map = new Map([['x', { color: 'red' }]])
    assert.equal(setEntry(map, 'x', {}), true)
    assert.equal(map.has('x'), false)
  })
  it('is a no-op when the normalized entry is unchanged', () => {
    const map = new Map([['x', { color: 'red' }]])
    assert.equal(setEntry(map, 'x', { color: 'red' }), false)
  })
})

describe('per-report ignore', () => {
  it('adds, detects, and lists ignored reports', () => {
    const map = new Map()
    setReportIgnored(map, 'x', 'reportA', true)
    assert.equal(isReportIgnored(map, 'x', 'reportA'), true)
    assert.equal(isReportIgnored(map, 'x', 'reportB'), false)
    setReportIgnored(map, 'x', 'reportB', true)
    assert.deepEqual(ignoredReportsFor(map, 'x').toSorted(), ['reportA', 'reportB'])
  })
  it('removing the last report prunes the id (when nothing else is set)', () => {
    const map = new Map()
    setReportIgnored(map, 'x', 'reportA', true)
    setReportIgnored(map, 'x', 'reportA', false)
    assert.equal(map.has('x'), false)
  })
  it('coexists with other triage fields on the same id', () => {
    const map = new Map([['x', { color: 'red' }]])
    setReportIgnored(map, 'x', 'reportA', true)
    assert.deepEqual(map.get('x'), { color: 'red', ignoredReports: ['reportA'] })
    setReportIgnored(map, 'x', 'reportA', false)
    assert.deepEqual(map.get('x'), { color: 'red' })
  })
  it('ignoredReportsFor returns a fresh array (no aliasing)', () => {
    const map = new Map([['x', { ignoredReports: ['a'] }]])
    const got = ignoredReportsFor(map, 'x')
    got.push('mutated')
    assert.deepEqual(map.get('x').ignoredReports, ['a'])
  })
  it('clearReportEverywhere drops one report across all ids', () => {
    const map = new Map([
      ['x', { ignoredReports: ['A', 'B'] }],
      ['y', { color: 'red', ignoredReports: ['A'] }],
      ['z', { ignoredReports: ['B'] }],
    ])
    clearReportEverywhere(map, 'A')
    assert.deepEqual(map.get('x'), { ignoredReports: ['B'] })
    assert.deepEqual(map.get('y'), { color: 'red' })
    assert.deepEqual(map.get('z'), { ignoredReports: ['B'] })
  })
})
