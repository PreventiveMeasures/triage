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

const { state, REPO_URLS_KEY } = await import('../client/state.ts')
const {
  applyTriageImport,
  buildTriageExportPayload,
  parseTriageExportGzip,
} = await import('../client/triage-export.js')

function clearState() {
  state.markers.clear()
  state.triageState.clear()
  state.comments.clear()
  state.fixes.clear()
  state.ignoredIds.clear()
  globalThis.localStorage.clear()
}

const FINDING_A = '00000000-0000-4000-8000-00000000000a'
const FINDING_B = '00000000-0000-4000-8000-00000000000b'

describe('buildTriageExportPayload', () => {
  beforeEach(clearState)

  it('skips session-id (numeric) keys in every map', () => {
    state.markers.set('123', 'red')           // numeric → skip
    state.markers.set(FINDING_A, 'green')      // uuid → keep
    state.triageState.set('456', 'fixed')
    state.triageState.set(FINDING_A, 'invalid')
    const payload = buildTriageExportPayload()
    assert.equal(payload.triage['123'], undefined)
    assert.equal(payload.triage['456'], undefined)
    assert.equal(payload.triage[FINDING_A].color, 'green')
    assert.equal(payload.triage[FINDING_A].triage, 'invalid')
  })

  it('groups ignoredReports per id', () => {
    state.ignoredIds.add(`r1.json\0${FINDING_A}`)
    state.ignoredIds.add(`r2.json\0${FINDING_A}`)
    const payload = buildTriageExportPayload()
    assert.deepEqual(payload.triage[FINDING_A].ignoredReports.toSorted(), ['r1.json', 'r2.json'].toSorted())
  })

  it('reads repoUrls from localStorage', () => {
    globalThis.localStorage.setItem(REPO_URLS_KEY, JSON.stringify({ 'r.json': 'https://example.test/repo' }))
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
    state.markers.set(FINDING_A, 'red')
    await assert.rejects(applyTriageImport(null, 'replace'), /Invalid payload: not an object/u)
    assert.equal(state.markers.get(FINDING_A), 'red', 'state untouched on null payload')
  })

  it('throws on missing `triage` BEFORE mutating state in replace mode', async () => {
    // Pre-fix `replace` mode would clear state.markers / state.triageState
    // / state.comments / state.fixes / state.ignoredIds first, then
    // crash on `Object.entries(undefined)`. Half-applied import in
    // memory; the persisted blob diverges. Now the shape check runs
    // before any mutation.
    state.markers.set(FINDING_A, 'red')
    state.triageState.set(FINDING_B, 'fixed')
    state.comments.set(FINDING_A, 'note')
    state.fixes.set(FINDING_A, 'patch')
    state.ignoredIds.add(`r.json\0${FINDING_A}`)
    await assert.rejects(applyTriageImport({ repoUrls: {} }, 'replace'), /missing or non-object `triage`/u)
    // Every map untouched.
    assert.equal(state.markers.get(FINDING_A), 'red')
    assert.equal(state.triageState.get(FINDING_B), 'fixed')
    assert.equal(state.comments.get(FINDING_A), 'note')
    assert.equal(state.fixes.get(FINDING_A), 'patch')
    assert.equal(state.ignoredIds.has(`r.json\0${FINDING_A}`), true)
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
    state.markers.set(FINDING_A, 'red')
    await applyTriageImport({
      version: 1,
      triage: { [FINDING_B]: { color: 'green' } },
      repoUrls: { 'r.json': 'https://example.test' },
    }, 'prefer-imported')
    // FINDING_A pre-existing, FINDING_B newly imported.
    assert.equal(state.markers.get(FINDING_A), 'red', 'pre-existing mark survives in prefer-imported merge')
    assert.equal(state.markers.get(FINDING_B), 'green')
    assert.equal(JSON.parse(globalThis.localStorage.getItem(REPO_URLS_KEY))['r.json'], 'https://example.test')
  })
})

async function gzipBlob(text) {
  const { encodeUtf8 } = await import('../common/utf8.js')
  const stream = new Blob([encodeUtf8(text)]).stream().pipeThrough(new CompressionStream('gzip'))
  return await new Response(stream).blob()
}
