// `client/triage-export.js` — full-triage backup pipeline.
// Exercises the build / parse / apply paths against a polyfilled
// localStorage shim. The build path mirrors `saveTriage`'s session-id
// filter (numeric `_id` keys are skipped); the apply path supports
// three merge modes: 'replace', 'prefer-imported', 'prefer-current'.
//
// Like the workspace-roundtrip tests this file pulls in the shared
// `_polyfills.js` so `navigator.locks.request` (used by `saveTriage`'s
// commit phase) works on Node 22 too.

import assert from 'node:assert/strict'
import { beforeEach, describe, it } from 'node:test'

await import('./_polyfills.js')

const { state, REPO_URLS_KEY, loadRepoUrlFor, saveRepoUrlFor } = await import('../client/state.ts')
const {
  applyTriageImport,
  buildTriageExportPayload,
  parseTriageExportGzip,
} = await import('../client/triage-export.js')
const { patchEntry, setReportIgnored, isReportIgnored } = await import('../client/triage-entry.ts')
const { hasEnvelopeMagic } = await import('../client/passkey-crypto.ts')
const vault = await import('../client/passkey-vault.js')
const secureStorage = await import('../client/secure-storage.js')
const { setItem: setSecureItem } = secureStorage

function clearState() {
  state.triage.clear()
  state.currentFile = null
  state.repoUrl = ''
  state.repoEditing = false
  globalThis.localStorage.clear()
  // The secure-storage cache + vault session key are module-level and
  // outlive a single test. Reset both so each test starts with an
  // empty (plaintext, vault-disabled) store rather than inheriting a
  // sibling test's cached URLs or injected session key.
  secureStorage.__test__.reset()
  vault.__test__.reset()
}

const FINDING_A = '00000000-0000-4000-8000-00000000000a'
const FINDING_B = '00000000-0000-4000-8000-00000000000b'

// Simulate an unlocked vault: inject a deterministic content key so
// secure-storage's persist seals envelopes and hydrate decrypts them
// (mirrors passkey-vault.test.js's `injectKey`).
async function injectSessionKey() {
  const { deriveContentKey, importContentKey } = await import('../client/passkey-crypto.ts')
  const raw = await deriveContentKey(new Uint8Array(32).fill(42))
  vault.__test__.setSessionKeyForTesting(await importContentKey(raw))
}

describe('buildTriageExportPayload', () => {
  beforeEach(clearState)

  it('skips session-id (numeric) keys in every map', () => {
    patchEntry(state.triage, '123', { color: 'red' })           // numeric → skip
    patchEntry(state.triage, FINDING_A, { color: 'green' })      // uuid → keep
    patchEntry(state.triage, '456', { triage: 'fixed' })
    patchEntry(state.triage, FINDING_A, { triage: 'invalid' })
    const payload = buildTriageExportPayload()
    assert.equal(payload.triage['123'], undefined)
    assert.equal(payload.triage['456'], undefined)
    assert.equal(payload.triage[FINDING_A].color, 'green')
    assert.equal(payload.triage[FINDING_A].triage, 'invalid')
  })

  it('groups ignoredReports per id', () => {
    setReportIgnored(state.triage, FINDING_A, 'r1.json', true)
    setReportIgnored(state.triage, FINDING_A, 'r2.json', true)
    const payload = buildTriageExportPayload()
    assert.deepEqual(payload.triage[FINDING_A].ignoredReports.toSorted(), ['r1.json', 'r2.json'].toSorted())
  })

  it('reads repoUrls through secure-storage', async () => {
    await setSecureItem(REPO_URLS_KEY, JSON.stringify({ 'r.json': 'https://example.test/repo' }))
    const payload = buildTriageExportPayload()
    assert.deepEqual(payload.repoUrls, { 'r.json': 'https://example.test/repo' })
  })
})

describe('buildTriageExportPayload: encrypted vault (secure-storage routing)', () => {
  beforeEach(clearState)

  it('exports the decrypted URLs when the slot holds an envelope', async () => {
    // Reproduce the data-loss bug: with the vault unlocked, the
    // repo-URL slot in localStorage holds a base64 encrypted envelope,
    // not JSON. The pre-fix raw `JSON.parse(localStorage…)` threw and
    // swallowed the error, exporting an empty map. The fix reads the
    // decrypted value from the secure-storage cache instead.
    await injectSessionKey()
    await setSecureItem(REPO_URLS_KEY, JSON.stringify({ 'r.json': 'https://example.test/repo' }))

    // Confirm the at-rest form really is an opaque envelope (so a raw
    // read would have failed) — this is what makes the test faithful.
    const raw = globalThis.localStorage.getItem(REPO_URLS_KEY)
    assert.ok(!raw.startsWith('{'), 'slot is not plaintext JSON')
    assert.ok(hasEnvelopeMagic(Uint8Array.fromBase64(raw)), 'slot holds an encrypted envelope')

    const payload = buildTriageExportPayload()
    assert.deepEqual(payload.repoUrls, { 'r.json': 'https://example.test/repo' })
  })
})

describe('parseTriageExportGzip', () => {
  it('rejects unsupported version', async () => {
    const payload = { version: 999, triage: {}, repoUrls: {} }
    const blob = await gzipBlob(JSON.stringify(payload))
    await assert.rejects(parseTriageExportGzip(blob), /Unsupported backup version/u)
  })

  it('rejects a payload missing the `triage` map', async () => {
    const blob = await gzipBlob(JSON.stringify({ version: 1, repoUrls: {} }))
    await assert.rejects(parseTriageExportGzip(blob), /missing the `triage` map/u)
  })

  it('rejects a payload missing the `repoUrls` map', async () => {
    const blob = await gzipBlob(JSON.stringify({ version: 1, triage: {} }))
    await assert.rejects(parseTriageExportGzip(blob), /missing the `repoUrls` map/u)
  })

  it('returns the parsed payload on a well-formed input', async () => {
    const orig = { version: 1, triage: { [FINDING_A]: { color: 'red' } }, repoUrls: { 'r.json': 'https://example.test' } }
    const blob = await gzipBlob(JSON.stringify(orig))
    const parsed = await parseTriageExportGzip(blob)
    assert.equal(parsed.version, 1)
    assert.equal(parsed.triage[FINDING_A].color, 'red')
  })
})

describe('applyTriageImport: shape validation (audit round-14 TE-1)', () => {
  beforeEach(clearState)

  it('throws on unknown merge mode', async () => {
    await assert.rejects(applyTriageImport({ triage: {}, repoUrls: {} }, 'bogus'), /Unknown merge mode/u)
  })

  it('throws on a non-object payload BEFORE mutating state', async () => {
    patchEntry(state.triage, FINDING_A, { color: 'red' })
    await assert.rejects(applyTriageImport(null, 'replace'), /Invalid payload: not an object/u)
    assert.equal(state.triage.get(FINDING_A)?.color, 'red', 'state untouched on null payload')
  })

  it('throws on missing `triage` BEFORE mutating state in replace mode', async () => {
    // Pre-fix `replace` mode would clear state.triage first, then
    // crash on `Object.entries(undefined)`. Half-applied import in
    // memory; the persisted blob diverges. Now the shape check runs
    // before any mutation.
    patchEntry(state.triage, FINDING_A, { color: 'red' })
    patchEntry(state.triage, FINDING_B, { triage: 'fixed' })
    patchEntry(state.triage, FINDING_A, { comment: 'note' })
    patchEntry(state.triage, FINDING_A, { fix: 'patch' })
    setReportIgnored(state.triage, FINDING_A, 'r.json', true)
    await assert.rejects(applyTriageImport({ repoUrls: {} }, 'replace'), /missing or non-object `triage`/u)
    // Every map untouched.
    assert.equal(state.triage.get(FINDING_A)?.color, 'red')
    assert.equal(state.triage.get(FINDING_B)?.triage, 'fixed')
    assert.equal(state.triage.get(FINDING_A)?.comment, 'note')
    assert.equal(state.triage.get(FINDING_A)?.fix, 'patch')
    assert.equal(isReportIgnored(state.triage, FINDING_A, 'r.json'), true)
  })

  it('rejects an array `triage` (typeof [] === "object" loophole)', async () => {
    await assert.rejects(applyTriageImport({ triage: [], repoUrls: {} }, 'replace'),
      /missing or non-object `triage`/u)
  })

  it('throws on missing `repoUrls`', async () => {
    await assert.rejects(applyTriageImport({ triage: {} }, 'replace'),
      /missing or non-object `repoUrls`/u)
  })

  it('rejects an array `repoUrls`', async () => {
    await assert.rejects(applyTriageImport({ triage: {}, repoUrls: [] }, 'replace'),
      /missing or non-object `repoUrls`/u)
  })

  it('a well-formed payload still applies as before', async () => {
    patchEntry(state.triage, FINDING_A, { color: 'red' })
    await applyTriageImport({
      version: 1,
      triage: { [FINDING_B]: { color: 'green' } },
      repoUrls: { 'r.json': 'https://example.test' },
    }, 'prefer-imported')
    // FINDING_A pre-existing, FINDING_B newly imported.
    assert.equal(state.triage.get(FINDING_A)?.color, 'red', 'pre-existing mark survives in prefer-imported merge')
    assert.equal(state.triage.get(FINDING_B)?.color, 'green')
    assert.equal(loadRepoUrlFor('r.json'), 'https://example.test')
  })

  it('imports the flagged tri-state, including the false tombstone (replace mode)', async () => {
    // Backup import must carry `flagged` like every other field — and
    // `replace` mode installs the backup verbatim, including the explicit
    // `false` tombstone, not just `true`.
    patchEntry(state.triage, FINDING_A, { flagged: true })  // wiped + re-set by replace
    await applyTriageImport({
      version: 1,
      triage: { [FINDING_A]: { flagged: false }, [FINDING_B]: { flagged: true } },
      repoUrls: {},
    }, 'replace')
    assert.equal(state.triage.get(FINDING_A)?.flagged, false, 'imported false tombstone applied')
    assert.equal(state.triage.get(FINDING_B)?.flagged, true, 'imported flag applied')
  })
})

describe('applyTriageImport: repo-URL merge through secure-storage', () => {
  beforeEach(clearState)

  it('prefer-current preserves pre-existing URLs (plaintext)', async () => {
    saveRepoUrlFor('r.json', 'https://current.test/r')
    await applyTriageImport({
      triage: {},
      repoUrls: { 'r.json': 'https://imported.test/r', 's.json': 'https://imported.test/s' },
    }, 'prefer-current')
    // Existing key wins; new key is filled in.
    assert.equal(loadRepoUrlFor('r.json'), 'https://current.test/r')
    assert.equal(loadRepoUrlFor('s.json'), 'https://imported.test/s')
  })

  it('prefer-imported overwrites on collision but keeps current-only keys', async () => {
    saveRepoUrlFor('r.json', 'https://current.test/r')
    saveRepoUrlFor('keep.json', 'https://current.test/keep')
    await applyTriageImport({
      triage: {},
      repoUrls: { 'r.json': 'https://imported.test/r' },
    }, 'prefer-imported')
    assert.equal(loadRepoUrlFor('r.json'), 'https://imported.test/r')
    assert.equal(loadRepoUrlFor('keep.json'), 'https://current.test/keep')
  })

  it('replace drops every current URL', async () => {
    saveRepoUrlFor('old.json', 'https://current.test/old')
    await applyTriageImport({
      triage: {},
      repoUrls: { 'new.json': 'https://imported.test/new' },
    }, 'replace')
    assert.equal(loadRepoUrlFor('old.json'), '')
    assert.equal(loadRepoUrlFor('new.json'), 'https://imported.test/new')
  })

  it('prefer-current preserves URLs and stays encrypted under an unlocked vault', async () => {
    // The headline bug: pre-fix, the raw read of the encrypted slot
    // parsed to `{}`, so EVERY mode (including prefer-current)
    // degenerated into an overwrite that wiped the user's URLs — and
    // the raw write put plaintext over the encrypted slot. Verify the
    // existing URL survives, the new one merges, and the slot is still
    // a sealed envelope afterward.
    await injectSessionKey()
    await setSecureItem(REPO_URLS_KEY, JSON.stringify({ 'r.json': 'https://current.test/r' }))

    await applyTriageImport({
      triage: {},
      repoUrls: { 'r.json': 'https://imported.test/r', 's.json': 'https://imported.test/s' },
    }, 'prefer-current')

    // prefer-current: existing wins, new key filled.
    assert.equal(loadRepoUrlFor('r.json'), 'https://current.test/r')
    assert.equal(loadRepoUrlFor('s.json'), 'https://imported.test/s')

    // Still encrypted at rest — no plaintext leak over the slot.
    const raw = globalThis.localStorage.getItem(REPO_URLS_KEY)
    assert.ok(hasEnvelopeMagic(Uint8Array.fromBase64(raw)), 'slot remains an encrypted envelope')
  })

  it('reports a repo-URL write failure without throwing or losing the triage import', async () => {
    // Enabled-but-locked vault: metadata present (isEncryptionEnabled
    // → true) with no session key, so secure-storage refuses the
    // plaintext write and importRepoUrls rejects. This mirrors a
    // sibling tab locking the vault mid-import. The triage half has
    // already merged + persisted, so applyTriageImport must NOT throw
    // — it surfaces the repo-URL failure in the result instead.
    globalThis.localStorage.setItem('deepview.passkey.v1', JSON.stringify({
      enabled: true, credentialId: 'c', prfSalt: 's', userId: 'u',
    }))

    const result = await applyTriageImport({
      triage: { [FINDING_A]: { color: 'green' } },
      repoUrls: { 'r.json': 'https://imported.test/r' },
    }, 'prefer-imported')

    // Triage applied despite the repo-URL failure.
    assert.equal(state.triage.get(FINDING_A)?.color, 'green')
    assert.equal(result.triageEntries, 1)
    // Repo URLs not applied; the error is reported, not thrown.
    assert.equal(result.repoUrls, 0)
    assert.ok(result.repoUrlError instanceof Error)
  })

  it('refreshes state.repoUrl for the active report after import', async () => {
    // Point (b) of the audit: the in-tab cache (and the header chip)
    // must reflect an imported URL for the open report without a
    // reload. mutateSecureItem updates the cache; importRepoUrls then
    // re-derives state.repoUrl from it.
    state.currentFile = 'r.json'
    state.repoUrl = ''
    await applyTriageImport({
      triage: {},
      repoUrls: { 'r.json': 'https://imported.test/r' },
    }, 'prefer-current')
    assert.equal(state.repoUrl, 'https://imported.test/r')
  })
})

async function gzipBlob(text) {
  const { encodeUtf8 } = await import('../common/utf8.js')
  const stream = new Blob([encodeUtf8(text)]).stream().pipeThrough(new CompressionStream('gzip'))
  return await new Response(stream).blob()
}
