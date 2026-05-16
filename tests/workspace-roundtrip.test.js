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

if (globalThis.localStorage === undefined) {
  globalThis.localStorage = createLocalStorage()
}

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
