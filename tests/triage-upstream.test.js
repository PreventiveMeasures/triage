// The cause track: `TriageEntry.upstream` — what a dependency's own
// maintainers did about a finding, as distinct from what an app did
// about shipping it.
//
// The record rides the ordinary entry, so every path that writes one
// — the at-rest blob, the workspace export, the sync apply — carries
// it through `normalizeEntry` with no code of its own. What needs
// proving is the places that DO name the entry's fields: the
// sanitizer, the emptiness test, the two equality checks (local +
// sync), the backup importer, and the load side of the at-rest blob,
// which reads fields by hand where the save side does not.

import assert from 'node:assert/strict'
import { beforeEach, describe, it } from 'node:test'

await import('./_polyfills.js')

const { state } = await import('../client/state.ts')
const { entryIsEmpty, normalizeEntry, patchEntry, upstreamEqual } = await import('../client/triage-entry.ts')
const { applyTriageImport, buildTriageExportPayload } = await import('../client/triage-export.js')
const { rebaseLocalState, statesEqual } = await import('../client/sync/triage-changeset.ts')
const { reloadTriageFromStorage, saveTriage } = await import('../client/triage.js')

const ID = 'dep-lodash-1'
const FIXED = { state: 'fixed', link: 'https://github.com/lodash/lodash/issues/42', since: '4.17.21' }

beforeEach(() => { state.triage.clear() })

describe('normalizing the cause record', () => {
  it('keeps a whole record and trims its free text', () => {
    const e = normalizeEntry({ upstream: { state: 'fixed', link: '  https://u  ', since: ' 4.17.21 ' } })
    assert.deepEqual(e.upstream, { state: 'fixed', link: 'https://u', since: '4.17.21' })
  })

  it('drops a state it does not recognise, and the record when nothing is left', () => {
    assert.equal(normalizeEntry({ upstream: { state: 'maybe' } }), undefined)
    assert.equal(normalizeEntry({ upstream: {} }), undefined)
    assert.equal(normalizeEntry({ upstream: 'fixed' }), undefined)
    // …but a recognised state alone is a record worth keeping.
    assert.deepEqual(normalizeEntry({ upstream: { state: 'wontfix' } }).upstream, { state: 'wontfix' })
  })

  it('counts as content, so an entry holding only one survives', () => {
    assert.equal(entryIsEmpty({ upstream: FIXED }), false)
    assert.equal(entryIsEmpty({}), true)
    patchEntry(state.triage, ID, { upstream: FIXED })
    assert.deepEqual(state.triage.get(ID).upstream, FIXED)
  })

  it('is cleared by writing an empty record, taking the entry with it', () => {
    patchEntry(state.triage, ID, { upstream: FIXED })
    assert.equal(patchEntry(state.triage, ID, { upstream: {} }), true)
    assert.equal(state.triage.has(ID), false)
  })

  it('leaves the rest of the entry alone when it goes', () => {
    patchEntry(state.triage, ID, { color: 'red', upstream: FIXED })
    patchEntry(state.triage, ID, { upstream: {} })
    assert.deepEqual(state.triage.get(ID), { color: 'red' })
  })

  it('suppresses a no-op rewrite but not a real edit', () => {
    patchEntry(state.triage, ID, { upstream: FIXED })
    assert.equal(patchEntry(state.triage, ID, { upstream: { ...FIXED } }), false)
    assert.equal(patchEntry(state.triage, ID, { upstream: { ...FIXED, since: '4.17.22' } }), true)
  })
})

describe('upstreamEqual', () => {
  it('compares the three fields and treats absent as empty', () => {
    assert.equal(upstreamEqual(undefined, undefined), true)
    assert.equal(upstreamEqual(FIXED, { ...FIXED }), true)
    assert.equal(upstreamEqual(FIXED, { ...FIXED, since: '5.0.0' }), false)
    assert.equal(upstreamEqual(undefined, { state: 'reported' }), false)
    assert.equal(upstreamEqual({ state: 'reported' }, { state: 'reported', link: 'https://u' }), false)
  })
})

describe('sync sees an edit to it', () => {
  it('two states differing only in the cause record are not equal', () => {
    // `statesEqual` decides whether a local state still matches the
    // chain. Were the record left out of the comparison, a peer's
    // "fixed in 4.17.21" would read as no change and never be saved.
    const base = { [ID]: { upstream: { state: 'reported' } } }
    const edited = { [ID]: { upstream: FIXED } }
    assert.equal(statesEqual(base, base), true)
    assert.equal(statesEqual(base, edited), false)
    assert.equal(statesEqual({ [ID]: {} }, edited), false)
  })

  it('keeps a local edit through a rebase, and the chain\'s when there was none', () => {
    // The field list `rebaseLocalState` copies is explicit, so a record
    // left out of it is silently dropped every time the chain moves.
    const local = rebaseLocalState({}, { [ID]: { upstream: FIXED } }, {})
    assert.deepEqual(local[ID].upstream, FIXED)
    // Untouched locally: whatever the chain now carries stands.
    const base = { [ID]: { upstream: { state: 'reported' } } }
    const remote = rebaseLocalState(base, base, { [ID]: { upstream: FIXED } })
    assert.deepEqual(remote[ID].upstream, FIXED)
    // Cleared locally: the clear survives the chain's older record.
    const cleared = rebaseLocalState(base, {}, { [ID]: { upstream: FIXED } })
    assert.equal(cleared[ID], undefined)
  })
})

describe('backups carry it', () => {
  it('survives an export / import round trip', async () => {
    patchEntry(state.triage, ID, { upstream: FIXED })
    const payload = buildTriageExportPayload()
    assert.deepEqual(payload.triage[ID].upstream, FIXED)
    state.triage.clear()
    await applyTriageImport(payload, 'replace')
    assert.deepEqual(state.triage.get(ID).upstream, FIXED)
  })

  it('is adopted whole rather than field by field', async () => {
    // The sentence a reader sees ("fixed in 4.17.21") can't be
    // reassembled from three separately-merged fields, so an imported
    // record replaces a local one rather than blending with it.
    patchEntry(state.triage, ID, { upstream: { state: 'reported' } })
    await applyTriageImport({ triage: { [ID]: { upstream: FIXED } }, repoUrls: {} }, 'prefer-imported')
    assert.deepEqual(state.triage.get(ID).upstream, FIXED)
  })

  it('keeps the local record under prefer-current', async () => {
    patchEntry(state.triage, ID, { upstream: { state: 'reported' } })
    await applyTriageImport({ triage: { [ID]: { upstream: FIXED } }, repoUrls: {} }, 'prefer-current')
    assert.deepEqual(state.triage.get(ID).upstream, { state: 'reported' })
  })
})

// `saveTriage` projects the map through `normalizeEntry`, so the blob
// carries the record for free. `applyTriageEntries` does not: it names
// each field, once to adopt what the blob adopts and once to clear what
// the blob has dropped. Both loops need the record, and both are on the
// path a client-mode switch takes — that transition empties the live map
// and restores it from storage, so a record missing from the load side
// would not survive one.
describe('the at-rest blob is read back', () => {
  beforeEach(() => {
    // Both ends of the round trip refuse to touch local storage while a
    // managed surface is up.
    state.serverMode = 'e2e'
    state.localMode = false
  })

  it('restores a record after the live map is emptied', async () => {
    state.triage.set(ID, { upstream: FIXED })
    state.triage.set('dep-other', { comment: 'ordinary', upstream: { state: 'reported' } })
    await saveTriage()
    state.triage.clear()
    await reloadTriageFromStorage()
    assert.deepEqual(state.triage.get(ID)?.upstream, FIXED, 'an entry holding only a record comes back')
    assert.deepEqual(state.triage.get('dep-other')?.upstream, { state: 'reported' }, 'and one sharing the entry with a comment')
  })

  it('clears a record a sibling tab dropped', async () => {
    state.triage.set(ID, { comment: 'keep', upstream: FIXED })
    await saveTriage()
    // The sibling drops the record, keeps the comment, and saves.
    state.triage.set(ID, { comment: 'keep' })
    await saveTriage()
    // This tab still has the record on screen; the reload must take it
    // away, or a cleared record outlives the tab that cleared it.
    state.triage.set(ID, { comment: 'keep', upstream: FIXED })
    await reloadTriageFromStorage()
    assert.equal(state.triage.get(ID)?.upstream, undefined)
    assert.equal(state.triage.get(ID)?.comment, 'keep', 'and leaves the rest of the entry alone')
  })

  it('sanitizes what the blob hands it', async () => {
    // The adopt loop passes the blob's value straight to `patchEntry`,
    // which normalizes — so a hand-edited blob, or one written by a peer
    // running a version that allowed more, cannot land a junk record in
    // live state. Written to the pending key, which `readTriageBlob`
    // prefers and reads as plain JSON.
    localStorage.setItem('deepview.triage.pending', JSON.stringify({
      [ID]: { comment: 'keep', upstream: { state: 'maybe' } },
      'dep-trim': { upstream: { state: 'fixed', since: '  4.17.21  ' } },
      'dep-shell': { comment: 'keep', upstream: {} },
      'dep-scalar': { comment: 'keep', upstream: 'fixed' },
    }))
    state.triage.clear()
    await reloadTriageFromStorage()
    localStorage.removeItem('deepview.triage.pending')
    assert.equal(state.triage.get(ID)?.upstream, undefined, 'an unrecognised state is not a record')
    assert.equal(state.triage.get(ID)?.comment, 'keep', 'and rejecting it costs the entry nothing')
    assert.deepEqual(state.triage.get('dep-trim')?.upstream, { state: 'fixed', since: '4.17.21' }, 'free text is trimmed on the way in')
    assert.equal(state.triage.get('dep-shell')?.upstream, undefined, 'an empty shell is not a record')
    assert.equal(state.triage.get('dep-scalar')?.upstream, undefined, 'and neither is a bare string')
  })
})
