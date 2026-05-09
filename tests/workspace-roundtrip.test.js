// Workspace export/import round-trip tests. Exercises the pure
// pipeline in `client/workspace-export.js` + `client/workspace-import.js`
// against a polyfilled localStorage (no OPFS / no DOM), so the
// triage-merge logic — including the legacy `deleted: true`
// migration that turns pre-bucket exports into the new
// `triage: 'fixed'|'invalid'|'deleted'` shape — is verified
// without spinning up a browser.
//
// Like sync-client.test.js this needs `Uint8Array.fromBase64` /
// `.toBase64` (Node 24+ behind `--js-base-64`). `npm test` already
// passes the flag; running this file directly needs `node
// --js-base-64 --test tests/workspace-roundtrip.test.js`.

import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { before, beforeEach, describe, it } from 'node:test'

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

if (typeof globalThis.localStorage === 'undefined') {
  globalThis.localStorage = createLocalStorage()
}

const { state } = await import('../client/state.js')
const {
  parseWorkspaceJson,
  applyWorkspaceImport,
  readImportedTriageBucket,
  isWorkspaceExport,
} = await import('../client/workspace-import.js')
const { buildWorkspaceExportPayload } = await import('../client/workspace-export.js')
const { listWorkspaces } = await import('../client/workspaces.js')

function clearState() {
  state.markers.clear()
  state.triageState.clear()
  state.comments.clear()
  state.fixes.clear()
  state.ignoredIds.clear()
  state.reports.length = 0
  state.currentFile = null
  state.currentWorkspace = null
  state.repoUrl = ''
  // Storage falls back to localStorage when OPFS is missing — wipe
  // it between tests so files / workspaces / counts / triage from
  // a prior test don't leak in.
  globalThis.localStorage.clear()
}

// Plain inline JSON report so the export path's `reportFindingIds`
// has something to claim — workspaces only export triage entries
// whose id is reachable through one of the workspace's reports.
function reportContent(ids) {
  return JSON.stringify({
    type: 'report',
    findings: ids.map((id) => ({
      id,
      severity: 'high',
      file: 'src/x.js',
      line: 1,
      description: 'finding',
    })),
  })
}

const FINDING_A = '00000000-0000-4000-8000-00000000000a'
const FINDING_B = '00000000-0000-4000-8000-00000000000b'

function makeWorkspace({ id = 'ws-1', name = 'WS', reports = [] } = {}) {
  return {
    id,
    name,
    privateKey: Buffer.from(new Uint8Array(32)).toString('base64'),
    reports,
    createdAt: 1,
  }
}

describe('readImportedTriageBucket', () => {
  it('reads the new triage field verbatim', () => {
    assert.equal(readImportedTriageBucket({ triage: 'fixed' }), 'fixed')
    assert.equal(readImportedTriageBucket({ triage: 'invalid' }), 'invalid')
    assert.equal(readImportedTriageBucket({ triage: 'deleted' }), 'deleted')
  })

  it('migrates legacy {deleted: true} to "deleted"', () => {
    assert.equal(readImportedTriageBucket({ deleted: true }), 'deleted')
  })

  it('returns null for entries without a bucket', () => {
    assert.equal(readImportedTriageBucket({ color: 'red' }), null)
    assert.equal(readImportedTriageBucket({}), null)
    assert.equal(readImportedTriageBucket(null), null)
  })

  it('ignores unknown triage values', () => {
    assert.equal(readImportedTriageBucket({ triage: 'bogus' }), null)
  })
})

describe('isWorkspaceExport', () => {
  it('accepts a well-formed payload', () => {
    assert.equal(isWorkspaceExport({
      version: 1,
      workspace: { id: 'a', name: 'b', privateKey: 'c' },
      reports: [],
    }), true)
  })

  it('rejects wrong version / missing fields / non-array reports', () => {
    assert.equal(isWorkspaceExport(null), false)
    assert.equal(isWorkspaceExport({ version: 2, workspace: { id: 'a', name: 'b', privateKey: 'c' }, reports: [] }), false)
    assert.equal(isWorkspaceExport({ version: 1, reports: [] }), false)
    assert.equal(isWorkspaceExport({ version: 1, workspace: { id: 'a', name: 'b', privateKey: 'c' }, reports: 'x' }), false)
  })
})

describe('parseWorkspaceJson', () => {
  it('throws on non-JSON input', () => {
    assert.throws(() => parseWorkspaceJson('not json {{'), /payload is not JSON/u)
  })

  it('throws on a non-export JSON blob', () => {
    assert.throws(() => parseWorkspaceJson(JSON.stringify({ hello: 'world' })), /not a deepview workspace export/u)
  })

  it('returns the parsed payload when valid', () => {
    const data = parseWorkspaceJson(JSON.stringify({
      version: 1,
      workspace: { id: 'ws', name: 'n', privateKey: 'k' },
      reports: [],
    }))
    assert.equal(data.workspace.id, 'ws')
  })
})

describe('applyWorkspaceImport: triage migration', () => {
  beforeEach(() => clearState())

  it('adopts new-shape triage buckets', async () => {
    const data = parseWorkspaceJson(JSON.stringify({
      version: 1,
      workspace: { id: 'ws-new', name: 'New', privateKey: 'k' },
      reports: [{ name: 'r.json', content: reportContent([FINDING_A, FINDING_B]) }],
      triage: {
        [FINDING_A]: { triage: 'fixed', color: 'red' },
        [FINDING_B]: { triage: 'invalid' },
      },
    }))
    await applyWorkspaceImport(data)
    assert.equal(state.triageState.get(FINDING_A), 'fixed')
    assert.equal(state.triageState.get(FINDING_B), 'invalid')
    assert.equal(state.markers.get(FINDING_A), 'red')
  })

  it('migrates legacy {deleted: true} → triage: "deleted"', async () => {
    const data = parseWorkspaceJson(JSON.stringify({
      version: 1,
      workspace: { id: 'ws-legacy', name: 'Legacy', privateKey: 'k' },
      reports: [{ name: 'r.json', content: reportContent([FINDING_A]) }],
      triage: {
        [FINDING_A]: { deleted: true, color: 'gray' },
      },
    }))
    await applyWorkspaceImport(data)
    assert.equal(state.triageState.get(FINDING_A), 'deleted', 'legacy deleted should land in triageState as "deleted"')
    assert.equal(state.markers.get(FINDING_A), 'gray')
  })

  it('does not call the conflict resolver when there is nothing to merge', async () => {
    let called = false
    const conflictResolver = () => { called = true; return null }
    const data = parseWorkspaceJson(JSON.stringify({
      version: 1,
      workspace: { id: 'ws-empty', name: 'Empty', privateKey: 'k' },
      reports: [{ name: 'r.json', content: reportContent([FINDING_A]) }],
      triage: {
        [FINDING_A]: { triage: 'fixed' },
      },
    }))
    await applyWorkspaceImport(data, { conflictResolver })
    assert.equal(called, false)
    assert.equal(state.triageState.get(FINDING_A), 'fixed')
  })

  it('queues a triage conflict when local + imported disagree and honors "imported"', async () => {
    state.triageState.set(FINDING_A, 'fixed')
    const seen = []
    const conflictResolver = (conflicts) => {
      for (const c of conflicts) seen.push(c)
      const decisions = {}
      for (const c of conflicts) decisions[`${c.id}:${c.property}`] = 'imported'
      return decisions
    }
    const data = parseWorkspaceJson(JSON.stringify({
      version: 1,
      workspace: { id: 'ws-conflict', name: 'C', privateKey: 'k' },
      reports: [{ name: 'r.json', content: reportContent([FINDING_A]) }],
      triage: { [FINDING_A]: { triage: 'invalid' } },
    }))
    await applyWorkspaceImport(data, { conflictResolver })
    assert.equal(seen.length, 1)
    assert.equal(seen[0].property, 'triage')
    assert.equal(seen[0].local, 'fixed')
    assert.equal(seen[0].imported, 'invalid')
    assert.equal(state.triageState.get(FINDING_A), 'invalid', 'imported decision should win')
  })

  it('imported triage decision drops pre-existing local ignored entries (mutex)', async () => {
    // Audit M8: the conflict-resolution loop sets state.triageState
    // when the user picks 'imported' on a triage conflict, but
    // didn't clear pre-existing state.ignoredIds entries for the
    // same id — leaving local state in the forbidden state where
    // triage and per-report ignore coexist on a tab. The mutex
    // applied at every other write/apply path (action handlers,
    // sync apply, load/reload) now also runs here.
    state.triageState.set(FINDING_A, 'fixed')
    state.ignoredIds.add(`r.json\0${FINDING_A}`)
    const conflictResolver = (conflicts) => {
      const decisions = {}
      for (const c of conflicts) decisions[`${c.id}:${c.property}`] = 'imported'
      return decisions
    }
    const data = parseWorkspaceJson(JSON.stringify({
      version: 1,
      workspace: { id: 'ws-mutex', name: 'M', privateKey: 'k' },
      reports: [{ name: 'r.json', content: reportContent([FINDING_A]) }],
      triage: { [FINDING_A]: { triage: 'invalid' } },
    }))
    await applyWorkspaceImport(data, { conflictResolver })
    assert.equal(state.triageState.get(FINDING_A), 'invalid', 'imported triage applied')
    assert.equal(
      state.ignoredIds.has(`r.json\0${FINDING_A}`),
      false,
      'pre-existing local ignored cleared by mutex',
    )
  })

  it('keeps the local value when conflict resolver returns null (cancel)', async () => {
    state.triageState.set(FINDING_A, 'fixed')
    const data = parseWorkspaceJson(JSON.stringify({
      version: 1,
      workspace: { id: 'ws-cancel', name: 'C', privateKey: 'k' },
      reports: [{ name: 'r.json', content: reportContent([FINDING_A]) }],
      triage: { [FINDING_A]: { triage: 'invalid' } },
    }))
    await applyWorkspaceImport(data, { conflictResolver: () => null })
    assert.equal(state.triageState.get(FINDING_A), 'fixed', 'local should stick when resolver cancels')
  })

  it('migrates legacy bundles that conflict with a local triage state via the resolver', async () => {
    // Local already has 'fixed' for FINDING_A; the legacy bundle
    // says { deleted: true }. The conflict resolver must see the
    // conflict in the new-shape ('deleted'), not as raw {deleted}.
    state.triageState.set(FINDING_A, 'fixed')
    const seen = []
    const data = parseWorkspaceJson(JSON.stringify({
      version: 1,
      workspace: { id: 'ws-legacy-conflict', name: 'LC', privateKey: 'k' },
      reports: [{ name: 'r.json', content: reportContent([FINDING_A]) }],
      triage: { [FINDING_A]: { deleted: true } },
    }))
    await applyWorkspaceImport(data, { conflictResolver: (c) => { seen.push(...c); return null } })
    assert.equal(seen.length, 1)
    assert.equal(seen[0].property, 'triage')
    assert.equal(seen[0].imported, 'deleted', 'legacy {deleted} should surface as "deleted" in conflicts')
  })
})

describe('export → import round-trip', () => {
  before(() => clearState())
  beforeEach(() => clearState())

  it('round-trips triage in the new-shape end-to-end', async () => {
    // Seed local state with markers + triage buckets + comments +
    // fixes for two findings. The reports[] is what gives the
    // export pipeline ids to claim — readFile reads from the
    // localStorage fallback after we save them.
    const { saveFile } = await import('../client/storage.js')
    await saveFile('r.json', reportContent([FINDING_A, FINDING_B]))

    state.markers.set(FINDING_A, 'red')
    state.triageState.set(FINDING_A, 'fixed')
    state.comments.set(FINDING_A, 'looks good')
    state.fixes.set(FINDING_A, 'https://example.test/pr/1')
    state.triageState.set(FINDING_B, 'deleted')

    const ws = makeWorkspace({ reports: ['r.json'] })
    const payload = await buildWorkspaceExportPayload(ws)

    // Sanity: payload uses new shape, never legacy.
    assert.equal(payload.triage[FINDING_A].triage, 'fixed')
    assert.equal(payload.triage[FINDING_A].color, 'red')
    assert.equal(payload.triage[FINDING_A].deleted, undefined)
    assert.equal(payload.triage[FINDING_B].triage, 'deleted')
    assert.equal(payload.triage[FINDING_B].deleted, undefined)

    // Wipe local state, then re-import — should reconstruct.
    state.markers.clear()
    state.triageState.clear()
    state.comments.clear()
    state.fixes.clear()

    const reparsed = parseWorkspaceJson(JSON.stringify(payload))
    await applyWorkspaceImport(reparsed)

    assert.equal(state.markers.get(FINDING_A), 'red')
    assert.equal(state.triageState.get(FINDING_A), 'fixed')
    assert.equal(state.comments.get(FINDING_A), 'looks good')
    assert.equal(state.fixes.get(FINDING_A), 'https://example.test/pr/1')
    assert.equal(state.triageState.get(FINDING_B), 'deleted')

    // Workspace was upserted (idempotent — re-importing the same
    // id merges instead of duplicating).
    const wsList = listWorkspaces()
    assert.equal(wsList.filter((w) => w.id === ws.id).length, 1)
  })
})
