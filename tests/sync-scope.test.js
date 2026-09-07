// `ui/view/sync-scope.js` — which of a workspace's files the sync
// badge and its upload dialog act on.
//
// The rule is membership ∩ this device, and this suite exists because
// each half of that was got wrong in turn:
//
//   - Reading the set from `state.reports` — the LOADED reports —
//     silently excluded links files. A links file carries no findings,
//     so it never enters `state.reports`, and one added to a workspace
//     stayed local-only forever: never counted by the badge, never
//     listed by the upload dialog, never received by a peer, and with
//     nothing anywhere saying so.
//
//   - Reading it from membership alone would offer to upload a member
//     whose bytes aren't on this device — the muted "missing" row in
//     the sidebar — which is an upload of nothing.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

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
globalThis.localStorage ??= createLocalStorage()

const { syncableMembers } = await import('../ui/view/sync-scope.js')

describe('syncableMembers — what a workspace can upload', () => {
  it('offers every member whose bytes are on this device', () => {
    const members = ['a.json', 'b.md', 'c.json']
    assert.deepEqual(
      syncableMembers(members, ['a.json', 'b.md', 'c.json'], ['a.json', 'b.md', 'c.json']),
      members,
    )
  })

  // The bug this suite exists for. A links file is a workspace member
  // like any other, but it is not a loaded report — so the set has to
  // come from membership, or it drops out.
  it('offers a member that is on disk but not a loaded report', () => {
    assert.deepEqual(
      syncableMembers(['a.json', 'dupes.json'], ['a.json', 'dupes.json'], ['a.json']),
      ['a.json', 'dupes.json'],
      'a links file is a member and is here — it can be uploaded',
    )
  })

  // The regression the same change could have introduced.
  it('skips a member with no bytes on this device', () => {
    assert.deepEqual(
      syncableMembers(['here.json', 'evicted.json'], ['here.json'], ['here.json']),
      ['here.json'],
      "an upload of a file this device doesn't hold is an upload of nothing",
    )
  })

  // The listing is cached on `state.storedFiles` by renderSidebar, so
  // a paint that beats the first OPFS scan sees it empty. A loaded
  // report was read off disk to become loaded, so it is present by
  // construction — which makes it a safe floor, and means this can
  // never offer less than the set it replaced.
  it('still offers the loaded reports when the listing has not landed', () => {
    assert.deepEqual(
      syncableMembers(['a.json', 'dupes.json'], [], ['a.json']),
      ['a.json'],
    )
  })

  it('keeps membership order, and holds up on an empty workspace', () => {
    assert.deepEqual(
      syncableMembers(['z.json', 'a.json'], ['a.json', 'z.json'], []),
      ['z.json', 'a.json'],
    )
    assert.deepEqual(syncableMembers([], ['a.json'], []), [])
  })
})
