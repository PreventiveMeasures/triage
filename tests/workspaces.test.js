// `client/workspaces.js` — workspace registry + listener wiring.
// All persistence is `localStorage['deepview.workspaces']`, so the
// LS shim used by the other tests is enough.
//
// Coverage:
//   - createWorkspace: trim + reject empty, generates id + privateKey
//   - upsertWorkspace: insert vs update; fires create/privateKey/
//     reports listeners under the right conditions only
//   - reportsSetEqual: reordering doesn't fire the membership listener
//   - deleteWorkspace: fires delete listener + removes entry
//   - renameWorkspace: trim, reject empty, no-op on same value
//   - setReportWorkspace: cross-workspace move emits two listener
//     fires (old detach + new attach)
//   - propagateWorkspaceChangesFromStorage: cross-tab diff path —
//     create / delete / privateKey-change / reports-change listeners
//   - listener errors swallowed (one bad subscriber doesn't strand
//     the rest)

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
  createWorkspace,
  deleteWorkspace,
  listWorkspaces,
  onReportMembershipChanged,
  onWorkspaceCreated,
  onWorkspaceDeleted,
  onWorkspacePrivateKeyChanged,
  propagateWorkspaceChangesFromStorage,
  renameWorkspace,
  setReportWorkspace,
  upsertWorkspace,
} = await import('../client/workspaces.js')

const STORAGE_KEY = 'deepview.workspaces'

let counter = 0
function uniqueId(stem = 'ws') {
  counter += 1
  return `${stem}-${Date.now()}-${counter}`
}

function clearAll() {
  globalThis.localStorage.clear()
  // workspaces.js memoizes `lastSeen` from a fresh read at module load;
  // clearing the storage AFTER module-load means the cache is stale.
  // Calling `propagateWorkspaceChangesFromStorage()` re-reads and
  // updates `lastSeen` to match — without it, a subsequent diff would
  // see "delete" events for every workspace in the cache.
  propagateWorkspaceChangesFromStorage()
}

describe('createWorkspace', () => {
  beforeEach(clearAll)

  it('returns null for empty / whitespace name', () => {
    assert.equal(createWorkspace(''), null)
    assert.equal(createWorkspace('   '), null)
    assert.equal(createWorkspace(null), null)
    assert.equal(createWorkspace(undefined), null)
  })

  it('trims surrounding whitespace from the name', () => {
    const ws = createWorkspace('  hello  ')
    assert.equal(ws.name, 'hello')
  })

  it('generates a uuid id and a 32-byte base64-encoded privateKey', () => {
    const ws = createWorkspace('test')
    assert.match(ws.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u)
    // 32 raw bytes → 44 base64 chars (with `=` padding from .toBase64()).
    assert.match(ws.privateKey, /^[A-Za-z0-9+/]{43}=$/u)
  })

  it('persists the new workspace and listWorkspaces returns it', () => {
    const ws = createWorkspace('persist')
    const list = listWorkspaces()
    assert.equal(list.length, 1)
    assert.equal(list[0].id, ws.id)
    assert.deepEqual(list[0].reports, [])
  })
})

describe('upsertWorkspace', () => {
  beforeEach(clearAll)

  it('fires onWorkspaceCreated on first insert', () => {
    let createdId = null
    const unsub = onWorkspaceCreated((id) => { createdId = id })
    const id = uniqueId()
    upsertWorkspace({ id, name: 'fresh', privateKey: 'AA', reports: [] })
    assert.equal(createdId, id)
    unsub()
  })

  it('does not fire create listener on update of existing id', () => {
    const id = uniqueId()
    upsertWorkspace({ id, name: 'fresh', privateKey: 'AA', reports: [] })
    let createdAgain = null
    const unsub = onWorkspaceCreated((wid) => { createdAgain = wid })
    upsertWorkspace({ id, name: 'fresh-renamed', privateKey: 'AA', reports: [] })
    assert.equal(createdAgain, null, 'update did not refire create')
    unsub()
  })

  it('fires onWorkspacePrivateKeyChanged when an existing id\'s privateKey changes', () => {
    const id = uniqueId()
    upsertWorkspace({ id, name: 'rot', privateKey: 'OLD', reports: [] })
    let rotated = null
    const unsub = onWorkspacePrivateKeyChanged((wid) => { rotated = wid })
    upsertWorkspace({ id, name: 'rot', privateKey: 'NEW', reports: [] })
    assert.equal(rotated, id)
    unsub()
  })

  it('does NOT fire privateKey listener when the key is unchanged', () => {
    const id = uniqueId()
    upsertWorkspace({ id, name: 'rot', privateKey: 'KEY', reports: [] })
    let rotated = null
    const unsub = onWorkspacePrivateKeyChanged((wid) => { rotated = wid })
    upsertWorkspace({ id, name: 'rot', privateKey: 'KEY', reports: ['x.json'] })
    assert.equal(rotated, null, 'privateKey listener silent on no-change')
    unsub()
  })

  it('fires onReportMembershipChanged when reports[] changes', () => {
    const id = uniqueId()
    upsertWorkspace({ id, name: 'rep', privateKey: 'K', reports: ['a.json'] })
    let memberFired = null
    const unsub = onReportMembershipChanged((wid) => { memberFired = wid })
    upsertWorkspace({ id, name: 'rep', privateKey: 'K', reports: ['a.json', 'b.json'] })
    assert.equal(memberFired, id)
    unsub()
  })

  it('does NOT fire membership listener on report list reorder (set-equal compare)', () => {
    const id = uniqueId()
    upsertWorkspace({ id, name: 'rep', privateKey: 'K', reports: ['a.json', 'b.json', 'c.json'] })
    let memberFired = null
    const unsub = onReportMembershipChanged((wid) => { memberFired = wid })
    upsertWorkspace({ id, name: 'rep', privateKey: 'K', reports: ['c.json', 'a.json', 'b.json'] })
    assert.equal(memberFired, null, 'reorder is set-equal so no membership change')
    unsub()
  })

  it('createdAt defaults to Date.now() when not provided', () => {
    const before = Date.now()
    const ws = upsertWorkspace({ id: uniqueId(), name: 'now', privateKey: 'K', reports: [] })
    const after = Date.now()
    assert.ok(ws.createdAt >= before && ws.createdAt <= after)
  })

  it('createdAt round-trips when provided', () => {
    const ws = upsertWorkspace({ id: uniqueId(), name: 'fixed', privateKey: 'K', reports: [], createdAt: 12345 })
    assert.equal(ws.createdAt, 12345)
  })

  it('listener errors are swallowed', () => {
    let goodFired = false
    const unsubBad = onWorkspaceCreated(() => { throw new Error('boom') })
    const unsubGood = onWorkspaceCreated(() => { goodFired = true })
    upsertWorkspace({ id: uniqueId(), name: 'swallow', privateKey: 'K', reports: [] })
    assert.equal(goodFired, true, 'good listener fires despite bad one throwing')
    unsubBad()
    unsubGood()
  })
})

describe('deleteWorkspace', () => {
  beforeEach(clearAll)

  it('fires onWorkspaceDeleted and removes the entry', () => {
    const id = uniqueId()
    upsertWorkspace({ id, name: 'doomed', privateKey: 'K', reports: [] })
    let deletedId = null
    const unsub = onWorkspaceDeleted((wid) => { deletedId = wid })
    deleteWorkspace(id)
    assert.equal(deletedId, id)
    assert.equal(listWorkspaces().find((w) => w.id === id), undefined)
    unsub()
  })

  it('is a no-op for an unknown id (no listener fire, no throw)', () => {
    let fired = false
    const unsub = onWorkspaceDeleted(() => { fired = true })
    deleteWorkspace('not-a-real-id')
    assert.equal(fired, false)
    unsub()
  })
})

describe('renameWorkspace', () => {
  beforeEach(clearAll)

  it('returns true on rename, false on empty / whitespace input', () => {
    const id = uniqueId()
    upsertWorkspace({ id, name: 'before', privateKey: 'K', reports: [] })
    assert.equal(renameWorkspace(id, '  after  '), true)
    assert.equal(listWorkspaces().find((w) => w.id === id).name, 'after')
    assert.equal(renameWorkspace(id, ''), false)
    assert.equal(renameWorkspace(id, '   '), false)
  })

  it('returns false when the new value matches the current name', () => {
    const id = uniqueId()
    upsertWorkspace({ id, name: 'same', privateKey: 'K', reports: [] })
    assert.equal(renameWorkspace(id, 'same'), false)
  })

  it('returns false for an unknown id', () => {
    assert.equal(renameWorkspace('not-real', 'whatever'), false)
  })
})

describe('setReportWorkspace', () => {
  beforeEach(clearAll)

  it('attaches a report and fires the membership listener', () => {
    const id = uniqueId()
    upsertWorkspace({ id, name: 'attach', privateKey: 'K', reports: [] })
    let fired = null
    const unsub = onReportMembershipChanged((wid) => { fired = wid })
    setReportWorkspace('foo.json', id)
    assert.equal(fired, id)
    assert.deepEqual(listWorkspaces().find((w) => w.id === id).reports, ['foo.json'])
    unsub()
  })

  it('moving a report between workspaces fires both old + new listeners', () => {
    const a = uniqueId('a')
    const b = uniqueId('b')
    upsertWorkspace({ id: a, name: 'A', privateKey: 'K', reports: ['x.json'] })
    upsertWorkspace({ id: b, name: 'B', privateKey: 'K', reports: [] })
    const fired = []
    const unsub = onReportMembershipChanged((wid) => { fired.push(wid) })
    setReportWorkspace('x.json', b)
    assert.deepEqual(fired.sort(), [a, b].sort(), 'detach + attach both fired')
    unsub()
  })

  it('detach (workspaceId = null) removes the report from any workspace it was in', () => {
    const id = uniqueId()
    upsertWorkspace({ id, name: 'detach', privateKey: 'K', reports: ['gone.json', 'kept.json'] })
    setReportWorkspace('gone.json', null)
    assert.deepEqual(listWorkspaces().find((w) => w.id === id).reports, ['kept.json'])
  })

  it('detach + re-attach to the same workspace ends with the report present', () => {
    // Implementation detail: setReportWorkspace strips the report
    // from every workspace that currently has it, then re-adds it
    // to the target. When the target IS the current owner, the
    // net effect is a no-op for state, but the membership listener
    // fires once (the strip pass marked the workspace affected).
    // The downstream sync layer's empty-changeset short-circuit
    // makes the listener fire cheap, so this is acceptable.
    const id = uniqueId()
    upsertWorkspace({ id, name: 'noop', privateKey: 'K', reports: ['stay.json'] })
    setReportWorkspace('stay.json', id)
    assert.deepEqual(listWorkspaces().find((w) => w.id === id).reports, ['stay.json'])
  })
})

describe('propagateWorkspaceChangesFromStorage (cross-tab)', () => {
  beforeEach(clearAll)

  it('fires onWorkspaceCreated when a sibling tab adds a new workspace', () => {
    const id = uniqueId()
    let createdId = null
    const unsub = onWorkspaceCreated((wid) => { createdId = wid })
    // Simulate a sibling tab writing the blob directly.
    globalThis.localStorage.setItem(STORAGE_KEY, JSON.stringify([
      { id, name: 'sibling-add', privateKey: 'K', reports: [], createdAt: Date.now() },
    ]))
    propagateWorkspaceChangesFromStorage()
    assert.equal(createdId, id)
    unsub()
  })

  it('fires onWorkspaceDeleted when a sibling tab removes a workspace', () => {
    const id = uniqueId()
    upsertWorkspace({ id, name: 'doomed-by-sibling', privateKey: 'K', reports: [] })
    let deletedId = null
    const unsub = onWorkspaceDeleted((wid) => { deletedId = wid })
    // Sibling writes an empty list.
    globalThis.localStorage.setItem(STORAGE_KEY, JSON.stringify([]))
    propagateWorkspaceChangesFromStorage()
    assert.equal(deletedId, id)
    unsub()
  })

  it('fires onWorkspacePrivateKeyChanged when the sibling rotates the key', () => {
    const id = uniqueId()
    upsertWorkspace({ id, name: 'rot', privateKey: 'OLD', reports: [] })
    let rotated = null
    const unsub = onWorkspacePrivateKeyChanged((wid) => { rotated = wid })
    globalThis.localStorage.setItem(STORAGE_KEY, JSON.stringify([
      { id, name: 'rot', privateKey: 'NEW', reports: [], createdAt: Date.now() },
    ]))
    propagateWorkspaceChangesFromStorage()
    assert.equal(rotated, id)
    unsub()
  })

  it('fires onReportMembershipChanged when the sibling changes reports[]', () => {
    const id = uniqueId()
    upsertWorkspace({ id, name: 'rep', privateKey: 'K', reports: ['a.json'] })
    let fired = null
    const unsub = onReportMembershipChanged((wid) => { fired = wid })
    globalThis.localStorage.setItem(STORAGE_KEY, JSON.stringify([
      { id, name: 'rep', privateKey: 'K', reports: ['a.json', 'b.json'], createdAt: Date.now() },
    ]))
    propagateWorkspaceChangesFromStorage()
    assert.equal(fired, id)
    unsub()
  })

  it('does NOT fire membership listener when sibling reorders reports[]', () => {
    const id = uniqueId()
    upsertWorkspace({ id, name: 'rep', privateKey: 'K', reports: ['a.json', 'b.json', 'c.json'] })
    let fired = null
    const unsub = onReportMembershipChanged((wid) => { fired = wid })
    globalThis.localStorage.setItem(STORAGE_KEY, JSON.stringify([
      { id, name: 'rep', privateKey: 'K', reports: ['c.json', 'b.json', 'a.json'], createdAt: Date.now() },
    ]))
    propagateWorkspaceChangesFromStorage()
    assert.equal(fired, null, 'set-equal compare suppresses the listener')
    unsub()
  })
})
