// The `flagged` tri-state attention flag: `undefined` (unset) / `true`
// (flagged) / `false` (explicit "unflagged" tombstone). The `false`
// state is deliberately NOT pruned, so un-flagging is a real, syncable
// change that overrides a peer's stale `true` rather than being read as
// "no opinion" and silently undone. These pin that contract across the
// entry helpers and the sync changeset/conflict algebra.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

const { normalizeEntry, entryIsEmpty, patchEntry } = await import('../client/triage-entry.ts')
const { computeChangeset, changesetEmpty, collectChainConflicts } = await import('../client/sync/triage-changeset.ts')

describe('flagged tri-state — normalize / prune', () => {
  it('keeps both true and false (false is a meaningful tombstone)', () => {
    assert.deepEqual(normalizeEntry({ flagged: true }), { flagged: true })
    assert.deepEqual(normalizeEntry({ flagged: false }), { flagged: false })
  })
  it('drops an unset / non-boolean flag', () => {
    assert.equal(normalizeEntry({ flagged: undefined }), undefined)
    assert.equal(normalizeEntry({ flagged: 'yes' }), undefined)
    assert.equal(normalizeEntry({ flagged: 1 }), undefined)
  })
  it('a flagged-only entry is NOT empty (true or false)', () => {
    assert.equal(entryIsEmpty({ flagged: true }), false)
    assert.equal(entryIsEmpty({ flagged: false }), false)
    assert.equal(entryIsEmpty({}), true)
    assert.equal(entryIsEmpty({ flagged: undefined }), true)
  })
})

describe('flagged tri-state — patch toggle', () => {
  it('un-flagging from true records false (entry survives, not deleted)', () => {
    const map = new Map()
    patchEntry(map, 'x', { flagged: true })
    assert.equal(map.get('x')?.flagged, true)
    patchEntry(map, 'x', { flagged: false })
    assert.equal(map.get('x')?.flagged, false, 'false persists as a tombstone')
    assert.ok(map.has('x'), 'entry not dropped when the flag is set to false')
  })
  it('flagging coexists with other triage fields', () => {
    const map = new Map()
    patchEntry(map, 'x', { triage: 'fixed', flagged: true })
    assert.deepEqual(map.get('x'), { triage: 'fixed', flagged: true })
  })
  it('clearing to undefined drops the flag (and empties a flag-only entry)', () => {
    const map = new Map()
    patchEntry(map, 'x', { flagged: true })
    patchEntry(map, 'x', { flagged: undefined })
    assert.equal(map.has('x'), false, 'entry dropped once its only field is unset')
  })
})

describe('flagged tri-state — changeset + conflict (no silent undo)', () => {
  it('true → false is a real change that ships in the changeset', () => {
    const cs = computeChangeset({ X: { flagged: true } }, { X: { flagged: false } })
    assert.equal(changesetEmpty(cs), false, 'un-flag detected as a change')
    assert.deepEqual(cs.X, { flagged: false })
  })
  it('false and undefined are distinct (a flagged:false base vs none ships)', () => {
    assert.equal(changesetEmpty(computeChangeset({ X: { flagged: false } }, {})), false)
    // Two equal sides produce nothing.
    assert.equal(changesetEmpty(computeChangeset({ X: { flagged: false } }, { X: { flagged: false } })), true)
  })
  it('a local flag vs a chain that explicitly un-flags surfaces a conflict', () => {
    // oldBase: unset. local overlay: flagged. chain: explicitly
    // un-flagged. Both moved off the unset baseline and disagree →
    // conflict, so the user resolves rather than a side silently winning.
    const conflicts = collectChainConflicts(
      { X: { flagged: true } },   // overlay (local)
      {},                         // oldBaseState (unset)
      { X: { flagged: false } },  // newBaseState (chain)
    )
    const f = conflicts.find((c) => c.property === 'flagged')
    assert.ok(f, 'flagged conflict surfaced')
    assert.equal(f.local, 'flagged')
    assert.equal(f.imported, 'not flagged')
  })
  it('local un-flag while the chain kept the flag is local-wins (no conflict)', () => {
    // oldBase flagged. local un-flagged (false). chain unchanged (still
    // flagged). Only local moved → no conflict; applyChangeset replays
    // the local false, so the removal is NOT silently undone.
    const conflicts = collectChainConflicts(
      { X: { flagged: false } },
      { X: { flagged: true } },
      { X: { flagged: true } },
    )
    assert.equal(conflicts.filter((c) => c.property === 'flagged').length, 0)
  })
})
