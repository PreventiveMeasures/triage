// `client/state.js` — repo-URL helpers + cross-tab repo-URL listener.
//
// The state module is mostly a centralised mutable view-state
// container; the repo-URL helpers + cross-tab handler are the only
// pieces with side-effects worth pinning. Round-9 M2 added the
// `state.repoEditing` bail to the cross-tab handler.

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
if (globalThis.localStorage === undefined) {
  globalThis.localStorage = createLocalStorage()
}

const {
  loadRepoUrlFor,
  propagateRepoUrlChangesFromStorage,
  saveRepoUrlFor,
  state,
} = await import('../client/state.ts')

function clearState() {
  globalThis.localStorage.clear()
  state.currentFile = null
  state.repoUrl = ''
  state.repoEditing = false
}

describe('saveRepoUrlFor / loadRepoUrlFor', () => {
  beforeEach(clearState)

  it('round-trips per filename', () => {
    saveRepoUrlFor('a.json', 'https://github.com/o/a')
    saveRepoUrlFor('b.json', 'https://github.com/o/b')
    assert.equal(loadRepoUrlFor('a.json'), 'https://github.com/o/a')
    assert.equal(loadRepoUrlFor('b.json'), 'https://github.com/o/b')
  })

  it('saving an empty value clears the entry', () => {
    saveRepoUrlFor('a.json', 'https://github.com/o/a')
    saveRepoUrlFor('a.json', '')
    assert.equal(loadRepoUrlFor('a.json'), '')
  })

  it('returns "" for unknown names', () => {
    assert.equal(loadRepoUrlFor('never-saved'), '')
  })

  it('returns "" for falsy name input (defensive)', () => {
    assert.equal(loadRepoUrlFor(''), '')
    assert.equal(loadRepoUrlFor(null), '')
  })

  it('survives a corrupt JSON blob in localStorage', () => {
    globalThis.localStorage.setItem('deepview.repoUrls', '{not json')
    assert.equal(loadRepoUrlFor('whatever'), '', 'corrupt blob → empty map')
    saveRepoUrlFor('a.json', 'https://github.com/o/a')
    assert.equal(loadRepoUrlFor('a.json'), 'https://github.com/o/a',
      'next save overwrites the corrupt blob')
  })
})

describe('propagateRepoUrlChangesFromStorage (cross-tab)', () => {
  beforeEach(clearState)

  it('updates state.repoUrl when the active file\'s URL changed in storage', () => {
    state.currentFile = 'active.json'
    state.repoUrl = ''
    saveRepoUrlFor('active.json', 'https://github.com/o/active')
    propagateRepoUrlChangesFromStorage()
    assert.equal(state.repoUrl, 'https://github.com/o/active')
  })

  it('is a no-op when state.currentFile is null', () => {
    state.currentFile = null
    state.repoUrl = ''
    saveRepoUrlFor('whatever.json', 'https://github.com/o/x')
    propagateRepoUrlChangesFromStorage()
    assert.equal(state.repoUrl, '')
  })

  it('bails when state.repoEditing is true (audit round-9 M2)', () => {
    // Round-9 M2: the user has the header chip expanded into its
    // <input> and is mid-typing. A sibling tab's saveRepoUrlFor
    // fires the storage event here; without the bail, state.repoUrl
    // would be overwritten and the user's typed-but-unsaved URL
    // would vanish on the next render.
    state.currentFile = 'active.json'
    state.repoUrl = 'mid-edit-typed-by-user'
    state.repoEditing = true
    saveRepoUrlFor('active.json', 'https://github.com/o/sibling-write')
    propagateRepoUrlChangesFromStorage()
    assert.equal(state.repoUrl, 'mid-edit-typed-by-user',
      'in-progress edit preserved across sibling write')
  })

  it('reads the new URL when repoEditing flips back to false', () => {
    state.currentFile = 'active.json'
    state.repoUrl = ''
    state.repoEditing = true
    saveRepoUrlFor('active.json', 'https://github.com/o/while-editing')
    propagateRepoUrlChangesFromStorage()
    assert.equal(state.repoUrl, '', 'still bailed during edit')
    // User commits / blurs the input → repoEditing=false. Next
    // propagate (e.g. another sibling write) picks up the URL.
    state.repoEditing = false
    saveRepoUrlFor('active.json', 'https://github.com/o/post-edit')
    propagateRepoUrlChangesFromStorage()
    assert.equal(state.repoUrl, 'https://github.com/o/post-edit')
  })
})
