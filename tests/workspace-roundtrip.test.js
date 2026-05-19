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

import './_polyfills.js'
import './_password-crypto-mock.js'
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { before, beforeEach, describe, it } from 'node:test'

const { state } = await import('../client/state.ts')
const {
  parseWorkspaceJson,
  applyWorkspaceImport,
  parseWorkspaceBundleBytes,
  readImportedTriageBucket,
  isWorkspaceExport,
} = await import('../client/workspace-import.js')
const {
  buildWorkspaceExportPayload,
  buildWorkspaceExportGzip,
  buildWorkspaceExportEncrypted,
  buildWorkspaceExportBundle,
} = await import('../client/workspace-export.js')
const { isEncryptedBundle } = await import('../client/workspace-bundle-crypto.js')
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

function makeWorkspace({ id = 'ws-1', name = 'WS', reports = [], bundles = [] } = {}) {
  return {
    id,
    name,
    privateKey: Buffer.from(new Uint8Array(32)).toString('base64'),
    reports,
    bundles,
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

  it('accepts an explicit `bundles: undefined` (back-compat with pre-bundles exports)', () => {
    // Distinct from "accepts a well-formed payload" above: that test
    // OMITS the field; this one sets it explicitly to undefined. Both
    // must pass through the validator since `data.bundles === undefined`
    // is the back-compat sentinel that triggers preserve-existing on
    // the import side.
    assert.equal(isWorkspaceExport({
      version: 1,
      workspace: { id: 'a', name: 'b', privateKey: 'c' },
      reports: [],
      bundles: undefined,
    }), true)
  })

  it('accepts a well-formed `bundles` array', () => {
    assert.equal(isWorkspaceExport({
      version: 1,
      workspace: { id: 'a', name: 'b', privateKey: 'c' },
      reports: [],
      bundles: ['sha512-AAAA', 'sha512-BBBB'],
    }), true)
  })

  it('rejects a non-array `bundles` field', () => {
    assert.equal(isWorkspaceExport({
      version: 1,
      workspace: { id: 'a', name: 'b', privateKey: 'c' },
      reports: [],
      bundles: 'sha512-X',
    }), false)
    assert.equal(isWorkspaceExport({
      version: 1,
      workspace: { id: 'a', name: 'b', privateKey: 'c' },
      reports: [],
      bundles: { 0: 'sha512-X' },
    }), false)
    assert.equal(isWorkspaceExport({
      version: 1,
      workspace: { id: 'a', name: 'b', privateKey: 'c' },
      reports: [],
      bundles: null,
    }), false)
  })

  it('rejects non-finite `createdAt` values (NaN, Infinity, null)', () => {
    // `typeof NaN === 'number'` and `typeof Infinity === 'number'` —
    // the prior shape check let them through, then JSON.stringify
    // serialized them as `null` on the persisted blob. Tightened to
    // Number.isFinite, which also rejects `null` (Number.isFinite(null)
    // === false) — pin that too so a future loosening can't accept it.
    assert.equal(isWorkspaceExport({
      version: 1,
      workspace: { id: 'a', name: 'b', privateKey: 'c', createdAt: NaN },
      reports: [],
    }), false)
    assert.equal(isWorkspaceExport({
      version: 1,
      workspace: { id: 'a', name: 'b', privateKey: 'c', createdAt: Infinity },
      reports: [],
    }), false)
    assert.equal(isWorkspaceExport({
      version: 1,
      workspace: { id: 'a', name: 'b', privateKey: 'c', createdAt: -Infinity },
      reports: [],
    }), false)
    assert.equal(isWorkspaceExport({
      version: 1,
      workspace: { id: 'a', name: 'b', privateKey: 'c', createdAt: null },
      reports: [],
    }), false)
  })

  it('rejects a `bundles` array exceeding the length cap (audit S-Import-1 DoS guard)', () => {
    // Cap is 1024. A crafted export with K=50000 entries would otherwise
    // run K serial detach calls (each a Web Lock RMW) and could land
    // partial state if the final upsert quotas out. Rejecting at the
    // validator stops the import before any side effects.
    const huge = Array.from({ length: 1025 }, () => 'sha512-X')
    assert.equal(isWorkspaceExport({
      version: 1,
      workspace: { id: 'a', name: 'b', privateKey: 'c' },
      reports: [],
      bundles: huge,
    }), false)
    // 1024 is accepted (boundary).
    const ok = Array.from({ length: 1024 }, () => 'sha512-X')
    assert.equal(isWorkspaceExport({
      version: 1,
      workspace: { id: 'a', name: 'b', privateKey: 'c' },
      reports: [],
      bundles: ok,
    }), true)
  })

  it('rejects an integrity string longer than the per-entry cap', () => {
    // Per-entry length cap is 200 chars — wider than the legit sha512
    // SRI shape ("sha512-" + base64(64 bytes) = ~95 chars) and narrow
    // enough that a single 100MB integrity can't smuggle in.
    const tooLong = 'sha512-' + 'A'.repeat(200)
    assert.equal(isWorkspaceExport({
      version: 1,
      workspace: { id: 'a', name: 'b', privateKey: 'c' },
      reports: [],
      bundles: ['sha512-OK', tooLong],
    }), false)
  })

  it('accepts an integrity string at the per-entry boundary (exactly 200 chars)', () => {
    // Positive boundary — pins the off-by-one. A 200-char string must
    // pass; 201 must fail (covered by the rejection test above).
    const atBoundary = 'A'.repeat(200)
    assert.equal(isWorkspaceExport({
      version: 1,
      workspace: { id: 'a', name: 'b', privateKey: 'c' },
      reports: [],
      bundles: [atBoundary],
    }), true)
  })

  it('rejects a non-string bundles entry at validation (no longer permissive)', () => {
    // Tightened S-Import-3: prior to the fix, non-string entries
    // passed the validator and were silently filtered downstream.
    // The validator is now the line of defense.
    assert.equal(isWorkspaceExport({
      version: 1,
      workspace: { id: 'a', name: 'b', privateKey: 'c' },
      reports: [],
      bundles: ['sha512-OK', 123],
    }), false)
    assert.equal(isWorkspaceExport({
      version: 1,
      workspace: { id: 'a', name: 'b', privateKey: 'c' },
      reports: [],
      bundles: ['sha512-OK', null],
    }), false)
  })

  it('rejects a `reports` array exceeding the length cap (parallel DoS guard)', () => {
    // Symmetric to bundles — without a cap, 50k empty `{findings:[]}`
    // reports gzip small but still pile up K serial detach calls
    // against the Web Lock. Reports content is gzipped on the wire so
    // the cap doubles as belt-and-suspenders alongside transport limits.
    const huge = Array.from({ length: 1025 }, (_, i) => ({ name: `r${i}.json`, content: '{}' }))
    assert.equal(isWorkspaceExport({
      version: 1,
      workspace: { id: 'a', name: 'b', privateKey: 'c' },
      reports: huge,
    }), false)
    const ok = Array.from({ length: 1024 }, (_, i) => ({ name: `r${i}.json`, content: '{}' }))
    assert.equal(isWorkspaceExport({
      version: 1,
      workspace: { id: 'a', name: 'b', privateKey: 'c' },
      reports: ok,
    }), true)
  })

  it('rejects a non-numeric `createdAt` (audit round-14 WI-2)', () => {
    // Pre-fix `createdAt` had no shape check — the field rode through
    // `applyWorkspaceImport` straight into `upsertWorkspace`, then into
    // the persisted workspaces blob. A crafted bundle could embed any
    // value (function-shape string, nested object, NaN). Now only
    // `number` (or omitted) is accepted.
    assert.equal(isWorkspaceExport({
      version: 1,
      workspace: { id: 'a', name: 'b', privateKey: 'c', createdAt: 'evil' },
      reports: [],
    }), false)
    assert.equal(isWorkspaceExport({
      version: 1,
      workspace: { id: 'a', name: 'b', privateKey: 'c', createdAt: { x: 1 } },
      reports: [],
    }), false)
    // Numeric still accepted.
    assert.equal(isWorkspaceExport({
      version: 1,
      workspace: { id: 'a', name: 'b', privateKey: 'c', createdAt: 12345 },
      reports: [],
    }), true)
    // Omitted (undefined) still accepted — upsertWorkspace falls back
    // to Date.now().
    assert.equal(isWorkspaceExport({
      version: 1,
      workspace: { id: 'a', name: 'b', privateKey: 'c' },
      reports: [],
    }), true)
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

  // Per-property positive coverage: a refactor that broke
  // `applyConflictDecisions` for color/comment/fix while leaving
  // triage intact would pass the existing "imported wins" test
  // (which only exercises triage). Pin each branch.
  it('applyConflictDecisions writes color/comment/fix when the user picks "imported"', async () => {
    state.markers.set(FINDING_A, 'green')
    state.comments.set(FINDING_A, 'local note')
    state.fixes.set(FINDING_A, 'local fix')
    const conflictResolver = (conflicts) => {
      const decisions = {}
      for (const c of conflicts) decisions[`${c.id}:${c.property}`] = 'imported'
      return decisions
    }
    const data = parseWorkspaceJson(JSON.stringify({
      version: 1,
      workspace: { id: 'ws-per-prop', name: 'P', privateKey: 'k' },
      reports: [{ name: 'r.json', content: reportContent([FINDING_A]) }],
      triage: {
        [FINDING_A]: { color: 'red', comment: 'imported note', fix: 'imported fix' },
      },
    }))
    await applyWorkspaceImport(data, { conflictResolver })
    assert.equal(state.markers.get(FINDING_A), 'red', 'imported color should win')
    assert.equal(state.comments.get(FINDING_A), 'imported note', 'imported comment should win')
    assert.equal(state.fixes.get(FINDING_A), 'imported fix', 'imported fix should win')
  })

  it('imported decision skipped when state.* changed during the dialog (M-2 stale guard)', async () => {
    // Audit H1 round-5: workspace-import's applyConflictDecisions
    // used to overwrite state.* unconditionally on an 'imported'
    // pick, even if the user (or a peer chain) had mutated the
    // value while the dialog was open. The hydration dialog has
    // had this guard since round-4 M-2; this test pins the
    // symmetric guard for the import path.
    state.markers.set(FINDING_A, 'green')
    state.comments.set(FINDING_A, 'note A')
    // Resolver picks 'imported' for both color and comment, but
    // mutates state.* mid-flight to simulate a user edit (or a peer
    // chain landing) while the dialog is open.
    const conflictResolver = (conflicts) => {
      const decisions = {}
      for (const c of conflicts) decisions[`${c.id}:${c.property}`] = 'imported'
      // Mid-dialog mutation: user types a new comment, peer chain
      // overwrites color.
      state.comments.set(FINDING_A, 'fresh user edit')
      state.markers.set(FINDING_A, 'cyan')
      return decisions
    }
    const data = parseWorkspaceJson(JSON.stringify({
      version: 1,
      workspace: { id: 'ws-stale', name: 'S', privateKey: 'k' },
      reports: [{ name: 'r.json', content: reportContent([FINDING_A]) }],
      triage: { [FINDING_A]: { color: 'red', comment: 'imported note' } },
    }))
    await applyWorkspaceImport(data, { conflictResolver })
    // Both decisions were 'imported' BUT state.* changed mid-dialog.
    // The stale-check skips the writes; mid-dialog edits survive.
    assert.equal(state.markers.get(FINDING_A), 'cyan', 'mid-dialog color edit preserved')
    assert.equal(state.comments.get(FINDING_A), 'fresh user edit', 'mid-dialog comment preserved')
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

  it('round-trips bundle membership as pointers (no bytes shipped)', async () => {
    const integA = 'sha512-AAAA'
    const integB = 'sha512-BBBB'
    const ws = makeWorkspace({ bundles: [integA, integB] })
    const payload = await buildWorkspaceExportPayload(ws)

    // Top-level `bundles` carries integrities, NOT bytes — the export
    // pipeline doesn't touch OPFS for bundle content. Tighter than the
    // earlier assertion: confirm `payload.reports` is EMPTY (no bundle
    // bytes piggybacking onto the reports payload) and that no other
    // top-level field acquired the bundle bytes.
    assert.deepEqual(payload.bundles, [integA, integB])
    assert.deepEqual(payload.reports, [], 'bundle bytes do NOT ride the reports payload')
    // Sanity: serialized payload size is small (bytes-free). Pin a
    // generous upper bound so a future regression that accidentally
    // packed bundle bytes alongside trips this test.
    const size = JSON.stringify(payload).length
    assert.ok(size < 2000, `bytes-free payload should be small; got ${size} chars`)

    const reparsed = parseWorkspaceJson(JSON.stringify(payload))
    await applyWorkspaceImport(reparsed)

    const restored = listWorkspaces().find((w) => w.id === ws.id)
    assert.deepEqual(restored.bundles, [integA, integB],
      'imported workspace re-acquired its bundle pointers')
  })

  it('importing references to bundles not present locally does not crash', async () => {
    // Receiver has no matching bundles in OPFS — the import should
    // still land the workspace with its `bundles` list intact. The
    // sidebar render (a separate concern, tested elsewhere) filters
    // missing integrities at paint time; this test just verifies the
    // import path itself doesn't throw when the references won't
    // resolve.
    const orphan = 'sha512-DOES-NOT-EXIST'
    const ws = makeWorkspace({ bundles: [orphan] })
    const payload = await buildWorkspaceExportPayload(ws)
    const reparsed = parseWorkspaceJson(JSON.stringify(payload))
    await applyWorkspaceImport(reparsed)
    const restored = listWorkspaces().find((w) => w.id === ws.id)
    assert.deepEqual(restored.bundles, [orphan],
      'reference preserved so a later drop of the matching bytes auto-claims')
  })

  it('older exports without a `bundles` field import cleanly (back-compat)', async () => {
    // Simulate a pre-bundles export by hand-rolling the payload
    // shape — the field is omitted entirely, not set to `[]` or
    // `null`.
    const payload = {
      version: 1,
      exportedAt: new Date().toISOString(),
      workspace: {
        id: 'ws-legacy',
        name: 'Legacy',
        privateKey: Buffer.from(new Uint8Array(32)).toString('base64'),
        createdAt: 1,
      },
      reports: [],
      repoUrls: {},
      triage: {},
    }
    const reparsed = parseWorkspaceJson(JSON.stringify(payload))
    await applyWorkspaceImport(reparsed)
    const restored = listWorkspaces().find((w) => w.id === 'ws-legacy')
    assert.deepEqual(restored.bundles, [],
      'missing `bundles` field defaults to [] without crashing')
  })

  it('re-importing a pre-bundles export does NOT wipe locally-attached bundles', async () => {
    // The data-loss regression flagged by audit-lineage review. Pre-fix
    // `applyWorkspaceImport` always sent `bundles: importedBundles` to
    // `upsertWorkspace`, which replaced the field wholesale — so an
    // older export (no `bundles` key) caused `[]` to overwrite local
    // membership. Fix: preserve existing when the field is absent.
    const { upsertWorkspace } = await import('../client/workspaces.js')
    const id = 'ws-preserve'
    // Local state: user dragged bundles onto WS after exporting it.
    await upsertWorkspace({
      id,
      name: 'Preserve',
      privateKey: Buffer.from(new Uint8Array(32)).toString('base64'),
      reports: [],
      bundles: ['sha512-LOCAL-1', 'sha512-LOCAL-2'],
      createdAt: 1,
    })
    // Friend's pre-bundles export — `bundles` field absent.
    const payload = {
      version: 1,
      exportedAt: new Date().toISOString(),
      workspace: {
        id,
        name: 'Preserve',
        privateKey: Buffer.from(new Uint8Array(32)).toString('base64'),
        createdAt: 1,
      },
      reports: [],
      repoUrls: {},
      triage: {},
    }
    const reparsed = parseWorkspaceJson(JSON.stringify(payload))
    await applyWorkspaceImport(reparsed)
    const restored = listWorkspaces().find((w) => w.id === id)
    assert.deepEqual(restored.bundles, ['sha512-LOCAL-1', 'sha512-LOCAL-2'],
      'locally-attached bundles survive a pre-bundles re-import')
  })

  it('import is additive for REPORTS: claimed names stay in any other workspace too', async () => {
    // Multi-workspace membership model: a report can belong to many
    // workspaces simultaneously. An import that claims a fileName
    // already attached to a different workspace MUST NOT steal it —
    // the other workspace's membership row is preserved, and the
    // import target additionally lists the same fileName. The
    // previous single-owner detach pre-pass was removed when the
    // auto-attach path in objstore-presence flipped to additive.
    const { saveFile } = await import('../client/storage.js')
    const { upsertWorkspace } = await import('../client/workspaces.js')
    const wsA = 'ws-A-r-owner'
    const wsB = 'ws-B-r-imported'
    const reportName = `shared-${Date.now()}.json`
    // Save the report and attach it to WS_A.
    await saveFile(reportName, reportContent([FINDING_A]))
    await upsertWorkspace({
      id: wsA,
      name: 'A',
      privateKey: Buffer.from(new Uint8Array(32)).toString('base64'),
      reports: [reportName],
      bundles: [],
      createdAt: 1,
    })
    // Import WS_B claiming the same report.
    const payload = {
      version: 1,
      exportedAt: new Date().toISOString(),
      workspace: {
        id: wsB,
        name: 'B',
        privateKey: Buffer.from(new Uint8Array(32)).toString('base64'),
        createdAt: 1,
      },
      reports: [{ name: reportName, content: reportContent([FINDING_A]) }],
      bundles: [],
      repoUrls: {},
      triage: {},
    }
    const reparsed = parseWorkspaceJson(JSON.stringify(payload))
    await applyWorkspaceImport(reparsed)
    const list = listWorkspaces()
    const a = list.find((w) => w.id === wsA)
    const b = list.find((w) => w.id === wsB)
    assert.deepEqual(a.reports, [reportName], 'WS_A retains the shared report (additive)')
    assert.deepEqual(b.reports, [reportName], 'WS_B also lists the shared report')
  })

  it('import is additive for BUNDLES: claimed integrities stay in any other workspace too', async () => {
    // Bundle twin of the report additive-import test above. Pre-fix
    // the detach pre-pass stripped `sha512-SHARED` from wsA so wsB
    // alone listed it after import; the model now allows both to
    // claim it concurrently and the bytes (content-addressed) are
    // resolved from OPFS by either workspace's view.
    const { upsertWorkspace } = await import('../client/workspaces.js')
    const wsA = 'ws-A-owner'
    const wsB = 'ws-B-imported'
    // WS_A locally has bundle X.
    await upsertWorkspace({
      id: wsA,
      name: 'A',
      privateKey: Buffer.from(new Uint8Array(32)).toString('base64'),
      reports: [],
      bundles: ['sha512-SHARED'],
      createdAt: 1,
    })
    // Import WS_B which also claims X.
    const payload = {
      version: 1,
      exportedAt: new Date().toISOString(),
      workspace: {
        id: wsB,
        name: 'B',
        privateKey: Buffer.from(new Uint8Array(32)).toString('base64'),
        createdAt: 1,
      },
      reports: [],
      bundles: ['sha512-SHARED'],
      repoUrls: {},
      triage: {},
    }
    const reparsed = parseWorkspaceJson(JSON.stringify(payload))
    await applyWorkspaceImport(reparsed)
    const list = listWorkspaces()
    const a = list.find((w) => w.id === wsA)
    const b = list.find((w) => w.id === wsB)
    assert.deepEqual(a.bundles, ['sha512-SHARED'], 'WS_A retains the shared integrity (additive)')
    assert.deepEqual(b.bundles, ['sha512-SHARED'], 'WS_B also lists the shared integrity')
  })

  it('rejects a `bundles` payload containing non-string entries at parse time', () => {
    // The validator now requires every entry to be a string (S-Import-3):
    // a non-string entry under the count cap would otherwise pass shape
    // validation and be silently filtered out by applyWorkspaceImport
    // later, leaving the validator more permissive than its contract
    // implies. parseWorkspaceJson throws upfront — no side effects.
    const payload = {
      version: 1,
      exportedAt: new Date().toISOString(),
      workspace: {
        id: 'ws-malformed',
        name: 'Malformed',
        privateKey: Buffer.from(new Uint8Array(32)).toString('base64'),
        createdAt: 1,
      },
      reports: [],
      bundles: ['sha512-REAL', '', 123, null, { x: 1 }],
      repoUrls: {},
      triage: {},
    }
    assert.throws(
      () => parseWorkspaceJson(JSON.stringify(payload)),
      /bundles entries must be strings/u,
    )
    // No workspace landed.
    assert.equal(listWorkspaces().find((w) => w.id === 'ws-malformed'), undefined)
  })

  it('parseWorkspaceJson surfaces a specific cap-violation message', () => {
    // Validator gates the import at the parse step. The user shouldn't
    // see "not a deepview workspace export" for a file that IS a valid
    // export, just over the size cap — they should see the specific
    // reason.
    const payload = {
      version: 1,
      exportedAt: new Date().toISOString(),
      workspace: {
        id: 'ws-oversize',
        name: 'Oversize',
        privateKey: Buffer.from(new Uint8Array(32)).toString('base64'),
        createdAt: 1,
      },
      reports: [],
      bundles: Array.from({ length: 1025 }, () => 'sha512-X'),
      repoUrls: {},
      triage: {},
    }
    assert.throws(
      () => parseWorkspaceJson(JSON.stringify(payload)),
      /bundles count \(1025\) exceeds cap \(1024\)/u,
    )
  })

  it('oversize import does not partially mutate victim workspaces', async () => {
    // parseWorkspaceJson rejects BEFORE applyWorkspaceImport runs, so
    // victim workspaces' memberships are untouched. Pin the contract:
    // even if a future regression splits the cap check into
    // applyWorkspaceImport (post-saveFile), this test would catch the
    // partial-state leak.
    const { upsertWorkspace } = await import('../client/workspaces.js')
    const victimId = 'ws-victim'
    await upsertWorkspace({
      id: victimId,
      name: 'Victim',
      privateKey: Buffer.from(new Uint8Array(32)).toString('base64'),
      reports: [],
      bundles: ['sha512-VICTIM-1', 'sha512-VICTIM-2'],
      createdAt: 1,
    })
    // Crafted import that, if it ran the detach pass, would strip
    // VICTIM-1 from the victim workspace.
    const payload = {
      version: 1,
      exportedAt: new Date().toISOString(),
      workspace: {
        id: 'ws-oversize-importer',
        name: 'Oversize',
        privateKey: Buffer.from(new Uint8Array(32)).toString('base64'),
        createdAt: 1,
      },
      reports: [],
      // 1024 junk + 'sha512-VICTIM-1' = 1025 → over cap.
      bundles: [...Array.from({ length: 1024 }, (_, i) => `sha512-CRAFT-${i}`), 'sha512-VICTIM-1'],
      repoUrls: {},
      triage: {},
    }
    assert.throws(() => parseWorkspaceJson(JSON.stringify(payload)))
    // Victim's memberships intact.
    const victim = listWorkspaces().find((w) => w.id === victimId)
    assert.deepEqual(victim.bundles, ['sha512-VICTIM-1', 'sha512-VICTIM-2'],
      'victim bundles untouched by rejected import')
    // No new workspace was created.
    assert.equal(listWorkspaces().find((w) => w.id === 'ws-oversize-importer'), undefined)
  })

  it('upsertWorkspace dedupes duplicate-bearing imported bundles', async () => {
    // Distinct from the validator gate above — a payload with all-string
    // duplicates passes parseWorkspaceJson; the dedupe inside
    // upsertWorkspace then collapses to a single entry.
    const integ = 'sha512-DUP'
    const payload = {
      version: 1,
      exportedAt: new Date().toISOString(),
      workspace: {
        id: 'ws-dedup',
        name: 'Dedup',
        privateKey: Buffer.from(new Uint8Array(32)).toString('base64'),
        createdAt: 1,
      },
      reports: [],
      bundles: [integ, integ, integ],
      repoUrls: {},
      triage: {},
    }
    const reparsed = parseWorkspaceJson(JSON.stringify(payload))
    await applyWorkspaceImport(reparsed)
    const restored = listWorkspaces().find((w) => w.id === 'ws-dedup')
    assert.deepEqual(restored.bundles, [integ], 'duplicates collapsed by upsertWorkspace')
  })
})

describe('encrypted bundle export → import round-trip', () => {
  beforeEach(() => clearState())

  it('round-trips a password-encrypted bundle end-to-end', async () => {
    const { saveFile } = await import('../client/storage.js')
    await saveFile('r.json', reportContent([FINDING_A]))
    state.markers.set(FINDING_A, 'red')
    state.triageState.set(FINDING_A, 'fixed')
    state.comments.set(FINDING_A, 'looks good')

    const ws = makeWorkspace({ reports: ['r.json'] })
    const password = 'correct horse battery staple'
    const { blob, filename } = await buildWorkspaceExportEncrypted(ws, password)
    assert.ok(filename.endsWith('.deepview-workspace.enc'))
    const bytes = new Uint8Array(await blob.arrayBuffer())
    assert.equal(isEncryptedBundle(bytes), true)

    state.markers.clear()
    state.triageState.clear()
    state.comments.clear()

    const data = await parseWorkspaceBundleBytes(bytes, password)
    await applyWorkspaceImport(data)

    assert.equal(state.markers.get(FINDING_A), 'red')
    assert.equal(state.triageState.get(FINDING_A), 'fixed')
    assert.equal(state.comments.get(FINDING_A), 'looks good')
  })

  it('parseWorkspaceBundleBytes rejects encrypted bundles when the password is wrong', async () => {
    const { saveFile } = await import('../client/storage.js')
    await saveFile('r.json', reportContent([FINDING_A]))
    const ws = makeWorkspace({ reports: ['r.json'] })

    const { blob } = await buildWorkspaceExportEncrypted(ws, 'right')
    const bytes = new Uint8Array(await blob.arrayBuffer())
    await assert.rejects(
      () => parseWorkspaceBundleBytes(bytes, 'wrong'),
      /wrong password or corrupt bundle/u,
    )
  })

  // The post-decrypt error oracle: a ciphertext that decrypts
  // successfully under the correct password but whose plaintext isn't
  // a valid gzipped JSON workspace must NOT surface a distinct
  // 'gzip decompression failed' / 'not a deepview workspace export'
  // — otherwise an attacker probing crafted ciphertexts can use the
  // distinct error to confirm "the password decrypted my crafted
  // payload" vs "the password is wrong".
  it('parseWorkspaceBundleBytes collapses post-decrypt failures into the wrong-password error', async () => {
    const { encryptBundle } = await import('../client/workspace-bundle-crypto.js')
    // Encrypt non-gzip random bytes with a known password. The
    // wire decrypts cleanly, but gunzip will fail.
    const password = 'pw'
    const wire = await encryptBundle(new Uint8Array(64).fill(0x42), password)
    await assert.rejects(
      () => parseWorkspaceBundleBytes(wire, password),
      /wrong password or corrupt bundle/u,
    )
  })

  // The oracle defense depends on the auth-failure path and the
  // post-decrypt-failure path returning the SAME error message text.
  // A future refactor that diverges the two strings (even subtly —
  // different wording, missing period, etc.) silently re-opens the
  // oracle without breaking the regex-only assertions elsewhere. Pin
  // the exact byte-for-byte equality here.
  it('auth-failure and post-decrypt-failure produce byte-identical bundle error messages', async () => {
    const { encryptBundle } = await import('../client/workspace-bundle-crypto.js')
    const wireGood = await encryptBundle(new Uint8Array(64).fill(0x42), 'right')
    let authErr
    try {
      await parseWorkspaceBundleBytes(wireGood, 'wrong')
    } catch (err) {
      authErr = err
    }
    let postDecryptErr
    try {
      // Non-gzip plaintext but correct password — collapses post-decrypt.
      await parseWorkspaceBundleBytes(wireGood, 'right')
    } catch (err) {
      postDecryptErr = err
    }
    assert.equal(authErr.message, postDecryptErr.message, 'oracle defense requires byte-identical messages')
  })

  it('parseWorkspaceBundleBytes preserves `cause` on the oracle-collapse path', async () => {
    const { encryptBundle } = await import('../client/workspace-bundle-crypto.js')
    const password = 'pw'
    const wire = await encryptBundle(new Uint8Array(64).fill(0x42), password)
    let caught
    try {
      await parseWorkspaceBundleBytes(wire, password)
    } catch (err) {
      caught = err
    }
    assert.ok(caught, 'expected the parse to throw')
    assert.match(caught.message, /wrong password or corrupt bundle/u)
    assert.ok(caught.cause, 'expected the rethrown error to carry `cause`')
  })

  it('parseWorkspaceBundleBytes throws on a missing password for an encrypted bundle', async () => {
    const { saveFile } = await import('../client/storage.js')
    await saveFile('r.json', reportContent([FINDING_A]))
    const ws = makeWorkspace({ reports: ['r.json'] })

    const { blob } = await buildWorkspaceExportEncrypted(ws, 'pw')
    const bytes = new Uint8Array(await blob.arrayBuffer())
    await assert.rejects(
      () => parseWorkspaceBundleBytes(bytes),
      /password required/u,
    )
  })

  it('parseWorkspaceBundleBytes routes plaintext gzip bundles through the existing pipeline', async () => {
    const { saveFile } = await import('../client/storage.js')
    await saveFile('r.json', reportContent([FINDING_A]))
    const ws = makeWorkspace({ reports: ['r.json'] })

    const { blob, filename } = await buildWorkspaceExportGzip(ws)
    assert.ok(filename.endsWith('.deepview-workspace.json.gz'))
    const bytes = new Uint8Array(await blob.arrayBuffer())
    assert.equal(isEncryptedBundle(bytes), false)
    const data = await parseWorkspaceBundleBytes(bytes)
    assert.equal(data.workspace.id, ws.id)
  })

  it('buildWorkspaceExportBundle dispatches by password presence', async () => {
    const { saveFile } = await import('../client/storage.js')
    await saveFile('r.json', reportContent([FINDING_A]))
    const ws = makeWorkspace({ reports: ['r.json'] })

    const plain = await buildWorkspaceExportBundle(ws)
    assert.ok(plain.filename.endsWith('.deepview-workspace.json.gz'))
    const plainBytes = new Uint8Array(await plain.blob.arrayBuffer())
    assert.equal(isEncryptedBundle(plainBytes), false)

    // Empty password matches the dialog's opt-out wiring.
    const empty = await buildWorkspaceExportBundle(ws, { password: '' })
    assert.ok(empty.filename.endsWith('.deepview-workspace.json.gz'))

    const enc = await buildWorkspaceExportBundle(ws, { password: 'pw' })
    assert.ok(enc.filename.endsWith('.deepview-workspace.enc'))
    const encBytes = new Uint8Array(await enc.blob.arrayBuffer())
    assert.equal(isEncryptedBundle(encBytes), true)
  })
})

describe('buildWorkspaceExportPayload — leak / robustness audits (round-13)', () => {
  beforeEach(clearState)

  it('bundles array is filtered to non-empty strings on export (defense in depth)', async () => {
    // Symmetric to the import-side filter test. The export path
    // expects `workspace.bundles` to already be string[] (upsertWorkspace
    // dedupes + the in-memory shape is enforced by listWorkspaces
    // backfill), but the filter is defense in depth — a future API
    // change shouldn't silently leak garbage into someone's export.
    const ws = makeWorkspace({
      bundles: ['sha512-A', '', 'sha512-B', 0, null, undefined, 'sha512-C'],
    })
    const payload = await buildWorkspaceExportPayload(ws)
    assert.deepEqual(
      payload.bundles,
      ['sha512-A', 'sha512-B', 'sha512-C'],
      'empty strings and non-strings dropped',
    )
  })

  it('ignoredReports is filtered against this workspace\'s reports (audit round-13 W-Export-1)', async () => {
    // Pre-fix the loop only checked `claimedIds.has(id)` and
    // pushed `reportName` straight from `state.ignoredIds`. When a
    // shared finding id existed in reports owned by DIFFERENT
    // workspaces, the foreign workspace's report names leaked into
    // the export. Audit round-13 W-Export-1.
    const ownReportName = 'own-report.json'
    const foreignReportName = 'foreign-report.json'
    const { saveFile } = await import(`../client/storage.js?leak=${Date.now()}`)
    await saveFile(ownReportName, reportContent([FINDING_A]))
    await saveFile(foreignReportName, reportContent([FINDING_A]))

    state.ignoredIds.add(`${ownReportName}\0${FINDING_A}`)
    state.ignoredIds.add(`${foreignReportName}\0${FINDING_A}`)

    const ws = makeWorkspace({ reports: [ownReportName] })
    const payload = await buildWorkspaceExportPayload(ws)
    assert.deepEqual(
      payload.triage[FINDING_A].ignoredReports,
      [ownReportName],
      'foreign-workspace report name not leaked into ignoredReports',
    )
  })

  it('a malformed report (non-array `findings`) does not abort the entire export (audit round-13 W-Export-2)', async () => {
    // Pre-fix `data.findings.flatMap(toGroup)` threw `TypeError:
    // flatMap is not a function` when `findings` was a non-array
    // (string, number, plain object). The throw escaped
    // reportFindingIds + buildWorkspaceExportPayload (no try/catch
    // around reportFindingIds), aborting the export.
    const goodName = 'good.json'
    const malformedName = 'malformed.json'
    const { saveFile } = await import(`../client/storage.js?malformed=${Date.now()}`)
    await saveFile(goodName, reportContent([FINDING_A]))
    // `findings` is an OBJECT, not an array — pre-fix would crash.
    await saveFile(malformedName, JSON.stringify({ findings: { id: 'broken' } }))

    state.markers.set(FINDING_A, 'red')
    const ws = makeWorkspace({ reports: [malformedName, goodName] })
    const payload = await buildWorkspaceExportPayload(ws)

    // Export completed despite the malformed report. The good
    // report's claimed ids still surface in triage.
    assert.equal(payload.triage[FINDING_A]?.color, 'red',
      'export survived a malformed sibling report')
  })

  it('mergeTriage rejects an array `triage` (audit round-14 WI-1)', async () => {
    // Pre-fix the shape guard `if (!triage || typeof triage !== 'object')`
    // admitted arrays (typeof [] === 'object'). Object.entries([])
    // yielded stringified indices that got persisted as bogus finding
    // ids in state.markers / state.comments / state.fixes.
    const data = {
      version: 1,
      workspace: { id: 'ws-arr', name: 'A', privateKey: 'k' },
      reports: [{ name: 'r.json', content: reportContent([FINDING_A]) }],
      // An array with one entry that LOOKS like valid triage —
      // pre-fix would write it under id="0".
      triage: [{ color: 'red', triage: 'fixed' }],
    }
    state.markers.clear()
    state.triageState.clear()
    await applyWorkspaceImport(data)
    assert.equal(state.markers.has('0'), false, 'no entry persisted under stringified array index')
    assert.equal(state.triageState.has('0'), false, 'no triage persisted under stringified array index')
    // The valid finding id from reports[] also shouldn't end up
    // marked — the array path returned early before any merge.
    assert.equal(state.markers.has(FINDING_A), false, 'valid id untouched: bogus payload skipped entirely')
  })

  it('mergeTriage skips spurious `.set` calls when imported equals local (audit round-14 WI-3)', async () => {
    // Pre-fix `else if (importedColor)` ran whenever an importedColor
    // was present, regardless of whether it equalled localColor —
    // calling state.markers.set with the SAME value still wakes every
    // reactive observer (sidebar / table / triage-sync subscriber).
    // Now the call only fires when the value actually differs.
    state.markers.set(FINDING_A, 'red')
    state.comments.set(FINDING_A, 'note')
    state.fixes.set(FINDING_A, 'patch')
    let markerSets = 0
    let commentSets = 0
    let fixSets = 0
    const origMarkerSet = state.markers.set.bind(state.markers)
    const origCommentSet = state.comments.set.bind(state.comments)
    const origFixSet = state.fixes.set.bind(state.fixes)
    state.markers.set = function spy(...args) { markerSets += 1; return origMarkerSet(...args) }
    state.comments.set = function spy(...args) { commentSets += 1; return origCommentSet(...args) }
    state.fixes.set = function spy(...args) { fixSets += 1; return origFixSet(...args) }
    try {
      const data = {
        version: 1,
        workspace: { id: 'ws-noop', name: 'N', privateKey: 'k' },
        reports: [{ name: 'r.json', content: reportContent([FINDING_A]) }],
        triage: { [FINDING_A]: { color: 'red', comment: 'note', fix: 'patch' } },
      }
      await applyWorkspaceImport(data)
      assert.equal(markerSets, 0, 'no marker.set when imported color === local')
      assert.equal(commentSets, 0, 'no comment.set when imported comment === local')
      assert.equal(fixSets, 0, 'no fix.set when imported fix === local')
    } finally {
      state.markers.set = origMarkerSet
      state.comments.set = origCommentSet
      state.fixes.set = origFixSet
    }
  })

  it('setCount preserves the cached source when bundle content lacks one (audit round-14 WI-4)', async () => {
    // Pre-fix `setCount(name, count, source)` was called with whatever
    // `analyzeContent` returned — `source` would be `undefined` for
    // analyzer-native JSON dumps that don't carry the source field.
    // setCount then wrote `{ count }` only, dropping any
    // previously-cached source field. The sidebar bucketing for that
    // file would silently regress to "unknown".
    const { setCount, getKind } = await import('../client/counts.js')
    const reportName = `wi4-${Date.now()}.json`
    // Pre-cache a source for this report name (mimics a prior ingest).
    setCount(reportName, 0, 'deepsec')
    assert.equal(getKind(reportName), 'deepsec', 'precondition: source cached')
    const data = {
      version: 1,
      workspace: { id: 'ws-src', name: 'S', privateKey: 'k' },
      // Plain analyzer-native JSON with no `source` field on the data.
      reports: [{ name: reportName, content: reportContent([FINDING_A]) }],
      triage: {},
    }
    await applyWorkspaceImport(data)
    assert.equal(getKind(reportName), 'deepsec', 'cached source preserved when bundle lacks one')
  })

  it('genuine "File not found" still prunes the workspace membership (audit round-13 W-Export-3 positive control)', async () => {
    // Pre-fix `readFile` failing for ANY reason triggered the
    // prune. Now only the genuine `File not found:` case prunes —
    // transient I/O errors / decode failures leave the membership
    // intact. This positive-control test exercises the file-
    // missing path; the transient-error negative case is verified
    // by code review (monkey-patching `readFile` from outside
    // the module isn't possible — ESM bindings are read-only).
    const reportName = `gone-${Date.now()}.json`
    const stamp = `${Date.now()}-${Math.random()}`
    const storageMod = await import(`../client/storage.js?prune-pos=${stamp}`)
    const wsMod = await import(`../client/workspaces.js?prune-pos=${stamp}`)
    const exportMod = await import(`../client/workspace-export.js?prune-pos=${stamp}`)

    await storageMod.saveFile(reportName, reportContent([FINDING_A]))
    const ws = makeWorkspace({ reports: [reportName] })
    await wsMod.upsertWorkspace(ws)

    // Genuinely remove the file so readFile throws
    // `Error: File not found: <name>`.
    await storageMod.deleteFile(reportName)

    await exportMod.buildWorkspaceExportPayload(ws)
    const wsAfter = wsMod.listWorkspaces().find((w) => w.id === ws.id)
    assert.equal(wsAfter?.reports?.includes(reportName), false,
      'genuine file-missing pruned the workspace-report association')
  })
})
