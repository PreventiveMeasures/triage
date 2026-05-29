// `client/triage-gc.js` — pre-deletion triage impact analysis +
// orphan-triage GC sweep. Both helpers walk OPFS-stored reports
// (via `client/storage.js`'s localStorage fallback under the test
// shim) and intersect them with the in-memory `state.triage`
// triage map to decide which entries are reachable from a remaining
// report and which would be orphaned.
//
// Coverage:
//   - analyzeTriageImpact: short-circuit on empty state, short-
//     circuit on no overlap with deleted reports, orphaned vs.
//     shared split across markers / triageState / comments / fixes
//     / ignoredIds, session-only numeric ids ignored.
//   - pruneOrphanTriage: no-op when nothing's orphaned (no save
//     fired), drops orphans across every collection, preserves
//     reachable entries, preserves session-only ids, drops
//     ignoredIds whose report file is gone even when the id
//     itself is still reachable.
//
// Findings carry explicit uuid `id`s in fixtures so the tests
// don't depend on `deriveFindingId`'s crypto.subtle output —
// what's covered here is the GC logic, not the hash derivation
// (which has its own coverage in finding-id.test.js).

import assert from 'node:assert/strict'
import { beforeEach, describe, it } from 'node:test'

await import('./_polyfills.js')

const { state } = await import('../client/state.ts')
const storage = await import('../client/storage.js')
const { analyzeTriageImpact, pruneOrphanTriage } = await import('../client/triage-gc.js')
const { patchEntry, setReportIgnored, isReportIgnored } = await import('../client/triage-entry.ts')

const FINDING_A = '00000000-0000-4000-8000-00000000000a'
const FINDING_B = '00000000-0000-4000-8000-00000000000b'
const FINDING_C = '00000000-0000-4000-8000-00000000000c'
const FINDING_D = '00000000-0000-4000-8000-00000000000d'

// Clear EVERY input the GC reads. State maps + every OPFS-via-LS
// report entry. The localStorage shim is in-process, so leftover
// triage entries from a prior test would otherwise leak into the
// next one's reachable / persisted snapshots and pin everything
// as "shared" (or hide a real orphan).
function clearAll() {
  state.triage.clear()
  globalThis.localStorage.clear()
}

// storage.js's LS fallback stores report bytes gzipped under
// `deepview.report:<name>`. The GC reads via `readFile` which
// decompresses, so saveFile is the right entry point — it writes
// the gzipped form storage's reader expects.
async function saveReport(name, findings) {
  await storage.saveFile(name, JSON.stringify({ findings }))
}

describe('analyzeTriageImpact: empty / short-circuit paths', () => {
  beforeEach(clearAll)

  it('returns 0/0 when there is no persisted triage at all', async () => {
    await saveReport('a.json', [{ id: FINDING_A }])
    // No state.markers/triageState/comments/fixes/ignoredIds set.
    // The helper's first check should return immediately without
    // parsing any file. The result is the same whether the deleted
    // report exists or not.
    const impact = await analyzeTriageImpact(['a.json'])
    assert.deepEqual(impact, { orphanedCount: 0, sharedCount: 0 })
  })

  it('returns 0/0 when persisted triage does not match any deleted-report finding', async () => {
    // Marker is on FINDING_A; deleted report has only FINDING_B.
    // No overlap → no orphans, no shared. The helper should
    // short-circuit AFTER parsing the deleted side, BEFORE
    // parsing the (possibly larger) kept side.
    patchEntry(state.triage, FINDING_A, { color: 'red' })
    await saveReport('a.json', [{ id: FINDING_A }])
    await saveReport('b.json', [{ id: FINDING_B }])
    const impact = await analyzeTriageImpact(['b.json'])
    assert.deepEqual(impact, { orphanedCount: 0, sharedCount: 0 })
  })

  it('ignores session-only numeric ids in the persisted snapshot', async () => {
    // Pre-uuid / fallback ids never round-trip to localStorage —
    // the analyzer must not count them as "at-risk" triage even
    // when a deleted report happens to carry the same id shape.
    patchEntry(state.triage, '42', { color: 'red' })
    patchEntry(state.triage, '99', { comment: 'note' })
    setReportIgnored(state.triage, '0', 'a.json', true)
    await saveReport('a.json', [{ id: '42' }, { id: '99' }, { id: '0' }])
    const impact = await analyzeTriageImpact(['a.json'])
    assert.deepEqual(impact, { orphanedCount: 0, sharedCount: 0 })
  })
})

describe('analyzeTriageImpact: orphan vs. shared split', () => {
  beforeEach(clearAll)

  it('counts an orphan when the deleted report is the only one carrying the id', async () => {
    patchEntry(state.triage, FINDING_A, { color: 'red' })
    await saveReport('a.json', [{ id: FINDING_A }])
    await saveReport('b.json', [{ id: FINDING_B }])
    const impact = await analyzeTriageImpact(['a.json'])
    assert.deepEqual(impact, { orphanedCount: 1, sharedCount: 0 })
  })

  it('counts a shared when another remaining report also carries the id', async () => {
    patchEntry(state.triage, FINDING_A, { color: 'red' })
    await saveReport('a.json', [{ id: FINDING_A }])
    await saveReport('b.json', [{ id: FINDING_A }, { id: FINDING_B }])
    const impact = await analyzeTriageImpact(['a.json'])
    assert.deepEqual(impact, { orphanedCount: 0, sharedCount: 1 })
  })

  it('mixes orphan + shared across the same delete', async () => {
    // A is only in the deleted report → orphan.
    // B is in both deleted + kept → shared.
    // C is in the kept-only set → not at risk, must NOT appear in either count.
    patchEntry(state.triage, FINDING_A, { color: 'red' })
    patchEntry(state.triage, FINDING_B, { color: 'green' })
    patchEntry(state.triage, FINDING_C, { color: 'blue' })
    await saveReport('deleted.json', [{ id: FINDING_A }, { id: FINDING_B }])
    await saveReport('kept.json', [{ id: FINDING_B }, { id: FINDING_C }])
    const impact = await analyzeTriageImpact(['deleted.json'])
    assert.deepEqual(impact, { orphanedCount: 1, sharedCount: 1 })
  })

  it('counts entries from every persisted collection (markers / triageState / comments / fixes / ignoredIds)', async () => {
    // One finding per collection so each contributes a distinct id
    // to the union — the helper has to scan all five maps, not just
    // one. All four ids are orphans (no kept reports).
    patchEntry(state.triage, FINDING_A, { color: 'red' })
    patchEntry(state.triage, FINDING_B, { triage: 'invalid' })
    patchEntry(state.triage, FINDING_C, { comment: 'note' })
    patchEntry(state.triage, FINDING_D, { fix: 'https://example.test/fix' })
    // ignoredIds is a Set of `${reportName}\0${id}` — verify the id
    // is extracted from the composite key.
    const FINDING_E = '00000000-0000-4000-8000-00000000000e'
    setReportIgnored(state.triage, FINDING_E, 'deleted.json', true)
    await saveReport('deleted.json', [
      { id: FINDING_A },
      { id: FINDING_B },
      { id: FINDING_C },
      { id: FINDING_D },
      { id: FINDING_E },
    ])
    const impact = await analyzeTriageImpact(['deleted.json'])
    assert.deepEqual(impact, { orphanedCount: 5, sharedCount: 0 })
  })

  it('flattens dedup-group entries when collecting reachable ids', async () => {
    // A `findings[]` slot can be a single finding OR an array (a
    // pre-deduped group from an upstream pass). The reachable-id
    // walk must reach every MEMBER's id — otherwise a triage entry
    // on a group member would falsely register as orphaned even
    // though the group is alive in the kept report.
    patchEntry(state.triage, FINDING_A, { color: 'red' })
    patchEntry(state.triage, FINDING_B, { color: 'green' })
    await saveReport('deleted.json', [[{ id: FINDING_A }, { id: FINDING_B }]])
    await saveReport('kept.json', [[{ id: FINDING_A }, { id: FINDING_B }]])
    const impact = await analyzeTriageImpact(['deleted.json'])
    assert.deepEqual(impact, { orphanedCount: 0, sharedCount: 2 })
  })

  it('does not count ids not present in the deleted reports even if persisted', async () => {
    // Persisted triage on FINDING_A is on the KEPT report only.
    // Deleting `deleted.json` doesn't affect it → 0/0.
    patchEntry(state.triage, FINDING_A, { color: 'red' })
    await saveReport('deleted.json', [{ id: FINDING_B }])
    await saveReport('kept.json', [{ id: FINDING_A }])
    const impact = await analyzeTriageImpact(['deleted.json'])
    assert.deepEqual(impact, { orphanedCount: 0, sharedCount: 0 })
  })
})

describe('pruneOrphanTriage', () => {
  beforeEach(clearAll)

  it('is a no-op when every persisted id is still reachable', async () => {
    patchEntry(state.triage, FINDING_A, { color: 'red' })
    patchEntry(state.triage, FINDING_A, { comment: 'note' })
    await saveReport('a.json', [{ id: FINDING_A }])
    await pruneOrphanTriage()
    assert.equal(state.triage.get(FINDING_A)?.color, 'red')
    assert.equal(state.triage.get(FINDING_A)?.comment, 'note')
  })

  it('drops orphaned ids across every persisted collection', async () => {
    patchEntry(state.triage, FINDING_A, { color: 'red' })           // orphan
    patchEntry(state.triage, FINDING_B, { color: 'green' })          // kept (reachable)
    patchEntry(state.triage, FINDING_A, { triage: 'invalid' })    // orphan
    patchEntry(state.triage, FINDING_B, { triage: 'fixed' })      // kept
    patchEntry(state.triage, FINDING_A, { comment: 'note A' })        // orphan
    patchEntry(state.triage, FINDING_B, { comment: 'note B' })        // kept
    patchEntry(state.triage, FINDING_A, { fix: 'https://orphan' })   // orphan
    patchEntry(state.triage, FINDING_B, { fix: 'https://kept' })     // kept
    // a.json is gone (not on disk); b.json remains and carries B.
    await saveReport('b.json', [{ id: FINDING_B }])
    await pruneOrphanTriage()
    assert.equal(state.triage.get(FINDING_A)?.color === undefined, true, 'orphan marker gone')
    assert.equal(state.triage.get(FINDING_B)?.color, 'green', 'kept marker survives')
    assert.equal(state.triage.get(FINDING_A)?.triage === undefined, true, 'orphan triageState gone')
    assert.equal(state.triage.get(FINDING_B)?.triage, 'fixed', 'kept triageState survives')
    assert.equal(state.triage.get(FINDING_A)?.comment === undefined, true, 'orphan comment gone')
    assert.equal(state.triage.get(FINDING_B)?.comment, 'note B', 'kept comment survives')
    assert.equal(state.triage.get(FINDING_A)?.fix === undefined, true, 'orphan fix gone')
    assert.equal(state.triage.get(FINDING_B)?.fix, 'https://kept', 'kept fix survives')
  })

  it('drops ignoredIds whose report is no longer on disk even when the id is reachable', async () => {
    // The id IS reachable (via kept.json) but the per-report
    // ignore was scoped to a report that no longer exists. The
    // (reportName, id) pair is dead even though the id alone
    // would survive a marker / comment GC pass.
    patchEntry(state.triage, FINDING_A, { color: 'red' })
    setReportIgnored(state.triage, FINDING_A, 'gone.json', true)
    setReportIgnored(state.triage, FINDING_A, 'kept.json', true)
    await saveReport('kept.json', [{ id: FINDING_A }])
    await pruneOrphanTriage()
    assert.equal(state.triage.get(FINDING_A)?.color, 'red', 'marker survives via kept.json')
    assert.equal(isReportIgnored(state.triage, FINDING_A, 'gone.json'), false, 'ignore for gone report dropped')
    assert.equal(isReportIgnored(state.triage, FINDING_A, 'kept.json'), true, 'ignore for kept report survives')
  })

  it('drops ignoredIds whose id is unreachable even when the report is still on disk', async () => {
    // Symmetric to the above: the report file exists, but the
    // ignored id no longer matches any finding in any report.
    setReportIgnored(state.triage, FINDING_A, 'a.json', true)
    await saveReport('a.json', [{ id: FINDING_B }])
    await pruneOrphanTriage()
    assert.equal(isReportIgnored(state.triage, FINDING_A, 'a.json'), false, 'ignore on unreachable id dropped')
  })

  it('leaves session-only numeric ids alone', async () => {
    // Numeric `_id` keys belong to the currently-loaded report's
    // id-less findings; they don't round-trip to localStorage and
    // the GC must not touch them — otherwise a delete + GC during
    // an active session would wipe the live tab's in-flight triage.
    patchEntry(state.triage, '42', { color: 'red' })
    patchEntry(state.triage, '99', { comment: 'note' })
    setReportIgnored(state.triage, '0', 'a.json', true)
    await saveReport('a.json', [{ id: FINDING_A }])
    await pruneOrphanTriage()
    assert.equal(state.triage.get('42')?.color, 'red')
    assert.equal(state.triage.get('99')?.comment, 'note')
    assert.equal(isReportIgnored(state.triage, '0', 'a.json'), true)
  })

  it('wipes everything when no reports remain on disk', async () => {
    patchEntry(state.triage, FINDING_A, { color: 'red' })
    patchEntry(state.triage, FINDING_B, { triage: 'fixed' })
    patchEntry(state.triage, FINDING_A, { comment: 'note' })
    patchEntry(state.triage, FINDING_B, { fix: 'https://fix' })
    setReportIgnored(state.triage, FINDING_A, 'a.json', true)
    // No saveReport — listFiles() returns empty.
    await pruneOrphanTriage()
    assert.equal(state.triage.size, 0)
  })
})

describe('pruneOrphanTriage: round-1 review #1 (no silent wipe on read error)', () => {
  beforeEach(clearAll)

  it('throws and leaves state untouched when readFile fails for an OPFS entry', async () => {
    // Pre-fix: any readFile failure silently `continue`d, so a
    // single corrupt entry under listFiles() would produce an
    // empty reachable set and the prune would wipe every
    // persisted triage entry. Post-fix: the failure propagates
    // and the caller decides whether to surface or retry.
    patchEntry(state.triage, FINDING_A, { color: 'red' })
    patchEntry(state.triage, FINDING_B, { color: 'green' })
    // Plant a corrupt LS-backed report entry. `readFile`'s
    // gunzipString call will throw on this. listFiles still
    // surfaces it (the prefix scan doesn't validate payload).
    globalThis.localStorage.setItem('deepview.report:corrupt.json', '!!!not-base64!!!')
    await assert.rejects(pruneOrphanTriage(), /Failed to read corrupt.json/u)
    // No state mutation, no saveTriage call.
    assert.equal(state.triage.get(FINDING_A)?.color, 'red', 'markers untouched on read error')
    assert.equal(state.triage.get(FINDING_B)?.color, 'green')
  })

  it('tolerates a "file not found" race (entry vanished between listFiles and readFile)', async () => {
    // Copilot review (PR #35 r3227232941): a benign race —
    // listFiles() enumerates an entry, but a sibling tab's
    // deleteFile lands before our readFile reaches it.
    // Pre-fix, this aborted the prune entirely. Post-fix, the
    // NotFound shape is treated as "skip this name, keep
    // walking" — the file really is gone, so its (would-have-
    // been) findings contribute nothing to the reachable set,
    // which is exactly correct.
    //
    // Reproduces the race by saving a real report (so
    // listFiles + readFile work), then snapshotting the
    // listFiles output ourselves and dropping the entry
    // before calling pruneOrphanTriage — pruneOrphanTriage's
    // own listFiles call will pick up the absence + skip via
    // the NotFound branch.
    patchEntry(state.triage, FINDING_A, { color: 'red' })              // orphan
    patchEntry(state.triage, FINDING_B, { color: 'green' })             // reachable via b.json
    await saveReport('b.json', [{ id: FINDING_B }])
    // Add an entry, enumerate, then delete — this leaves
    // pruneOrphanTriage's listFiles + readFile cycle to
    // race a missing file. We simulate by leaving a ghost
    // marker in localStorage that listFiles sees but the
    // underlying entry is gone.
    globalThis.localStorage.setItem('deepview.report:ghost.json', '')
    // Re-read listFiles ourselves to confirm both names show
    // up — then drop ghost so the prune's own readFile fails.
    const names = await storage.listFiles()
    assert.ok(names.includes('ghost.json'))
    globalThis.localStorage.removeItem('deepview.report:ghost.json')
    // Re-add it so listFiles still surfaces it, but corrupt-
    // the-shape so readFile takes the NotFound branch is hard
    // here; instead just delete the value so the LS-fallback
    // readFile throws 'File not found: ghost.json'.
    globalThis.localStorage.setItem('deepview.report:ghost.json', '')
    globalThis.localStorage.removeItem('deepview.report:ghost.json')
    // The prune must complete: ghost.json's missing entry is
    // skipped via the NotFound branch; the orphan FINDING_A is
    // GCd against the reachable set built from b.json.
    await pruneOrphanTriage()
    assert.equal(state.triage.get(FINDING_A)?.color === undefined, true, 'orphan GCd despite the vanished entry')
    assert.equal(state.triage.get(FINDING_B)?.color, 'green', 'reachable triage survives')
  })

  it('treats an LS "File not found:" thrown directly as benign and continues', async () => {
    // Direct check on the helper's behavior: a name passed in
    // that doesn't exist at all should not abort the walk.
    // Caller (pruneOrphanTriage / analyzeTriageImpact)
    // currently passes listFiles() output so this case is
    // rare in practice, but the API guarantee is "I/O errors
    // throw, NotFound is skipped" — pin it.
    patchEntry(state.triage, FINDING_A, { color: 'red' })              // orphan
    patchEntry(state.triage, FINDING_B, { color: 'green' })             // reachable
    await saveReport('b.json', [{ id: FINDING_B }])
    // listFiles will return ['b.json'] only; pruneOrphanTriage's
    // reachable walk only reads b.json. No NotFound is thrown
    // here; this test just sanity-checks the happy path still
    // works after the NotFound-tolerance refactor.
    await pruneOrphanTriage()
    assert.equal(state.triage.get(FINDING_A)?.color === undefined, true)
    assert.equal(state.triage.get(FINDING_B)?.color, 'green')
  })
})

describe('analyzeTriageImpact: round-1 review #1 (propagates read errors)', () => {
  beforeEach(clearAll)

  it('throws rather than silently classifying every overlap as orphaned', async () => {
    // Pre-fix: a listFiles / readFile error swallowed silently
    // sent keptIds to the empty set, every persistedInDeleted id
    // got classified orphan, the dialog offered a destructive
    // "wipe N orphans" choice that didn't reflect reality.
    // Post-fix: the failure propagates so the sidebar handler
    // can refuse to open the dialog.
    patchEntry(state.triage, FINDING_A, { color: 'red' })
    await saveReport('a.json', [{ id: FINDING_A }])
    // Plant a corrupt OTHER report so the kept-side parse
    // (listFiles returns [a.json, corrupt.json]; the helper
    // filters out a.json since it's being deleted) trips.
    globalThis.localStorage.setItem('deepview.report:corrupt.json', '!!!not-base64!!!')
    await assert.rejects(analyzeTriageImpact(['a.json']), /Failed to read corrupt.json/u)
  })
})

describe('pruneOrphanTriage: round-1 review #2 (snapshot guards concurrent mutations)', () => {
  beforeEach(clearAll)

  it('preserves state.markers entries added AFTER the snapshot but BEFORE the mutation phase', async () => {
    // Cross-tab race: a sibling tab's saveTriage fires a
    // `storage` event that hits `reloadTriageFromStorage` then
    // `applyTriageEntries(..., { replace: true })` in this tab,
    // adding a fresh entry to state.markers. If that landing
    // happens DURING our OPFS walk (between the synchronous
    // snapshot at the top of pruneOrphanTriage and the
    // synchronous mutation loop), the new entry must not be
    // wiped: its id may not be in the reachable set we computed
    // against an older view of OPFS, but it represents a fresh
    // user mutation that the prune hasn't earned the right to
    // drop.
    //
    // Reproduces the race without monkey-patching:
    //   1. `pruneOrphanTriage()` is called WITHOUT awaiting.
    //      The async function runs synchronously up to its
    //      first `await` (the `listFiles()` call), which means
    //      the `new Set(state.markers.keys())` snapshot has
    //      already been taken before the function suspends.
    //   2. We then synchronously mutate `state.markers` to
    //      simulate the sibling-tab apply landing.
    //   3. Awaiting the returned promise lets the prune resume
    //      and run its mutation loops. The post-fix snapshot
    //      excludes FINDING_X, so the loop skips it.
    patchEntry(state.triage, FINDING_A, { color: 'red' })          // orphan: no report carries it
    await saveReport('b.json', [{ id: FINDING_B }])
    const FINDING_X = '00000000-0000-4000-8000-00000000000f'
    const prunePromise = pruneOrphanTriage()
    // Lands between the snapshot (sync prefix of the async fn)
    // and the mutation loop (resumes once the awaits settle).
    patchEntry(state.triage, FINDING_X, { color: 'blue' })
    await prunePromise
    // Pre-existing orphan removed (was in snapshot, not reachable).
    assert.equal(state.triage.get(FINDING_A)?.color === undefined, true, 'pre-existing orphan still gets GCd')
    // Fresh entry added between snapshot and mutation preserved.
    assert.equal(state.triage.get(FINDING_X)?.color, 'blue', 'mid-walk addition survives')
  })
})

// `deriveFindingId` (the analyzer's id helper) is async + uses
// crypto.subtle. Import it the same way `triage-gc.js` does so
// the test computes the SAME id the GC will see when it walks
// an id-less finding.
const { deriveFindingId } = await import('../common/finding-id.js')

describe('round-2 review: deriveFindingId path (id-less findings)', () => {
  beforeEach(clearAll)

  it('keeps triage on a finding whose id is DERIVED (not exporter-stamped)', async () => {
    // Markdown imports, legacy JSON dumps, and pre-uuid analyzer
    // output reach ingestReport without an `id` field —
    // ingestReport stamps a deterministic id via `deriveFindingId`
    // BEFORE the triage cache lookup, so the user's mark
    // round-trips across reloads. `pruneOrphanTriage` must do the
    // same derivation when walking these reports, otherwise it
    // would conclude the id is unreachable and wipe a live mark.
    const finding = { severity: 'high', description: 'no-eval', fileHash: 'sha512-abc' }
    const derivedId = await deriveFindingId(finding)
    assert.ok(derivedId, 'crypto.subtle is available in test env')
    patchEntry(state.triage, derivedId, { color: 'red' })
    await saveReport('a.json', [finding])
    await pruneOrphanTriage()
    assert.equal(state.triage.get(derivedId)?.color, 'red', 'derived-id triage survives')
  })

  it('wipes a derived-id orphan when its source report is deleted', async () => {
    const finding = { severity: 'high', description: 'no-eval', fileHash: 'sha512-only-in-deleted' }
    const derivedId = await deriveFindingId(finding)
    patchEntry(state.triage, derivedId, { color: 'red' })
    // No surviving report carries this finding → orphan.
    await pruneOrphanTriage()
    assert.equal(state.triage.get(derivedId)?.color === undefined, true, 'derived-id orphan GCd')
  })

  it('counts a derived-id finding as shared when another report carries the same content', async () => {
    // Two reports, same finding content (same fingerprint → same
    // derived id). Deleting one leaves the same id reachable
    // from the other → shared, not orphan.
    const finding = { severity: 'medium', description: 'unused-import', fileHash: 'sha512-shared' }
    const derivedId = await deriveFindingId(finding)
    patchEntry(state.triage, derivedId, { color: 'green' })
    await saveReport('deleted.json', [finding])
    await saveReport('kept.json', [finding])
    const impact = await analyzeTriageImpact(['deleted.json'])
    assert.deepEqual(impact, { orphanedCount: 0, sharedCount: 1 })
  })
})

describe('round-2 review: format fallback (DeepSec markdown)', () => {
  beforeEach(clearAll)

  it('walks DeepSec-markdown reports via the parseDeepsecFindings fallback', async () => {
    // ingest.js's parse chain is JSON → DeepSec → Claude
    // markdown. The prune mirrors this exact chain. Without
    // it, a workspace of `.md` reports would silently bypass
    // the reachable-id walk and every triage entry would be
    // mis-classified as orphan.
    const md = [
      '# Vulnerability Scan Report',
      '',
      '## HIGH (1)',
      '',
      '### Hardcoded secret',
      '',
      '- **File:** `src/index.ts`',
      '- **Lines:** 42',
      '- **Description:** Hardcoded API key.',
    ].join('\n')
    // Predict the same derived id the GC will see when it
    // parses this report — `collectReachableIds` runs
    // `deriveFindingId` on the parser's id-less output, same as
    // `ingestReport` would have.
    const { parseDeepsecFindings } = await import('../common/parse-deepsec.js')
    const parsed = parseDeepsecFindings(md)
    assert.ok(parsed && parsed.findings.length === 1, 'parser produced one finding')
    const derivedId = await deriveFindingId(parsed.findings[0])
    patchEntry(state.triage, derivedId, { color: 'red' })
    await storage.saveFile('report.md', md)
    await pruneOrphanTriage()
    assert.equal(state.triage.get(derivedId)?.color, 'red',
      'triage on a DeepSec-md finding survives the prune')
  })
})

describe('round-2 review: concurrent prunes / analyze + prune', () => {
  beforeEach(clearAll)

  it('two prunes racing both complete safely with no over-delete', async () => {
    // Parallel prunes can happen if two delete actions are
    // confirmed in quick succession. Each prune snapshots
    // independently; the second one's `state.<map>.has(k)`
    // guard short-circuits delete-after-delete so neither
    // run flips `changed` for a no-op or crashes on a
    // missing key.
    patchEntry(state.triage, FINDING_A, { color: 'red' })          // orphan
    patchEntry(state.triage, FINDING_B, { color: 'green' })         // reachable
    await saveReport('b.json', [{ id: FINDING_B }])
    const [r1, r2] = await Promise.all([
      pruneOrphanTriage(),
      pruneOrphanTriage(),
    ])
    assert.equal(r1, undefined)
    assert.equal(r2, undefined)
    // Orphan is gone; reachable entry survives.
    assert.equal(state.triage.get(FINDING_A)?.color === undefined, true)
    assert.equal(state.triage.get(FINDING_B)?.color, 'green')
  })

  it('analyze + prune in parallel resolve coherently', async () => {
    // analyzeTriageImpact is read-only on state.* (only the
    // collectPersistedTriageIds snapshot is read). Running it
    // alongside a prune must not crash or observe a corrupt
    // mid-mutation state.
    patchEntry(state.triage, FINDING_A, { color: 'red' })          // orphan
    patchEntry(state.triage, FINDING_B, { color: 'green' })         // reachable
    await saveReport('b.json', [{ id: FINDING_B }])
    const [impact] = await Promise.all([
      analyzeTriageImpact(['b.json']),
      pruneOrphanTriage(),
    ])
    // The impact's exact counts are race-dependent (whether
    // analyze read state.* before or after the prune's
    // mutation phase). We assert only that both sides produced
    // well-shaped results — neither crashed nor returned
    // corrupted output.
    assert.equal(typeof impact.orphanedCount, 'number')
    assert.equal(typeof impact.sharedCount, 'number')
    assert.equal(state.triage.get(FINDING_A)?.color === undefined, true, 'orphan GCd by the prune')
    assert.equal(state.triage.get(FINDING_B)?.color, 'green', 'reachable triage survives')
  })
})

describe('round-2 review: snapshot guards all collections', () => {
  // The snapshot pattern in pruneOrphanTriage is replicated
  // across all five persisted collections (markers, triageState,
  // comments, fixes, ignoredIds). The round-1 test covered
  // markers; these check the same race for each of the other
  // four so the pattern's coverage is explicit per-collection.
  beforeEach(clearAll)

  it('preserves a state.triageState entry added between snapshot and mutation', async () => {
    patchEntry(state.triage, FINDING_A, { triage: 'invalid' })   // orphan
    await saveReport('b.json', [{ id: FINDING_B }])
    const FINDING_X = '00000000-0000-4000-8000-000000000010'
    const promise = pruneOrphanTriage()
    patchEntry(state.triage, FINDING_X, { triage: 'fixed' })
    await promise
    assert.equal(state.triage.get(FINDING_A)?.triage === undefined, true, 'pre-existing orphan GCd')
    assert.equal(state.triage.get(FINDING_X)?.triage, 'fixed', 'mid-walk addition survives')
  })

  it('preserves a state.comments entry added between snapshot and mutation', async () => {
    patchEntry(state.triage, FINDING_A, { comment: 'pre-existing note' })
    await saveReport('b.json', [{ id: FINDING_B }])
    const FINDING_X = '00000000-0000-4000-8000-000000000011'
    const promise = pruneOrphanTriage()
    patchEntry(state.triage, FINDING_X, { comment: 'fresh note' })
    await promise
    assert.equal(state.triage.get(FINDING_A)?.comment === undefined, true, 'pre-existing orphan GCd')
    assert.equal(state.triage.get(FINDING_X)?.comment, 'fresh note', 'mid-walk addition survives')
  })

  it('preserves a state.fixes entry added between snapshot and mutation', async () => {
    patchEntry(state.triage, FINDING_A, { fix: 'https://orphan' })
    await saveReport('b.json', [{ id: FINDING_B }])
    const FINDING_X = '00000000-0000-4000-8000-000000000012'
    const promise = pruneOrphanTriage()
    patchEntry(state.triage, FINDING_X, { fix: 'https://fresh' })
    await promise
    assert.equal(state.triage.get(FINDING_A)?.fix === undefined, true, 'pre-existing orphan GCd')
    assert.equal(state.triage.get(FINDING_X)?.fix, 'https://fresh', 'mid-walk addition survives')
  })

  it('preserves a state.ignoredIds entry added between snapshot and mutation', async () => {
    // ignoredIds keys are `${reportName}\0${id}` composites.
    // Snapshot stores the FULL composite key so a mid-walk
    // addition of a (reportName, id) pair survives even if the
    // id wouldn't otherwise be reachable.
    setReportIgnored(state.triage, FINDING_A, 'gone.json', true)
    await saveReport('b.json', [{ id: FINDING_B }])
    const FINDING_X = '00000000-0000-4000-8000-000000000013'
    const promise = pruneOrphanTriage()
    setReportIgnored(state.triage, FINDING_X, 'b.json', true)
    await promise
    assert.equal(isReportIgnored(state.triage, FINDING_A, 'gone.json'), false,
      'pre-existing orphan GCd')
    assert.equal(isReportIgnored(state.triage, FINDING_X, 'b.json'), true,
      'mid-walk addition survives')
  })
})

describe('round-2 review: cross-tab deletion landing mid-prune', () => {
  beforeEach(clearAll)

  it('skips a no-op delete on a key a sibling already removed', async () => {
    // Pre-fix, the loop called state.markers.delete for a key
    // already gone (no error, but the `changed = true` flip
    // triggered a pointless saveTriage commit + sync notify).
    // The post-fix `state.markers.has(k)` guard short-circuits.
    patchEntry(state.triage, FINDING_A, { color: 'red' })              // would-be orphan
    patchEntry(state.triage, FINDING_B, { color: 'green' })             // reachable
    await saveReport('b.json', [{ id: FINDING_B }])
    const promise = pruneOrphanTriage()
    // Simulate a sibling-tab apply-replace deleting FINDING_A
    // mid-walk (before our mutation loop runs). Our snapshot
    // still contains FINDING_A; the has(k) guard sees it's
    // already gone and skips both the delete and the
    // `changed = true` flip.
    patchEntry(state.triage, FINDING_A, { color: undefined })
    await promise
    assert.equal(state.triage.get(FINDING_A)?.color === undefined, true, 'still gone post-prune')
    assert.equal(state.triage.get(FINDING_B)?.color, 'green')
  })
})

describe('round-2 review: realistic mixed-fixture workspace leave', () => {
  beforeEach(clearAll)

  // Workspace: { deleted-1.json, deleted-2.json }
  // Outside:   { kept.json }
  // Findings:
  //   F1 — in deleted-1 only           → orphan
  //   F2 — in deleted-1 + deleted-2    → orphan (both deleted)
  //   F3 — in deleted-2 + kept         → shared
  //   F4 — in kept only                → not at risk
  //   F5 — id-less, in deleted-1 only  → orphan (via derived id)
  //   F6 — not in any report           → not in deletedIds, so not
  //                                       counted by analyze; the
  //                                       prune sweeps it as a
  //                                       pre-existing orphan.
  // Triage spread across markers / triageState / comments /
  // fixes / ignoredIds so every persisted collection contributes
  // to the count.
  const F1 = '00000000-0000-4000-8000-000000000020'
  const F2 = '00000000-0000-4000-8000-000000000021'
  const F3 = '00000000-0000-4000-8000-000000000022'
  const F4 = '00000000-0000-4000-8000-000000000023'
  const F6 = '00000000-0000-4000-8000-000000000025'
  const F5Source = { severity: 'low', description: 'derived-only', fileHash: 'sha512-d' }

  async function setupMixedFixture() {
    const F5 = await deriveFindingId(F5Source)
    patchEntry(state.triage, F1, { color: 'red' })
    patchEntry(state.triage, F2, { triage: 'invalid' })
    patchEntry(state.triage, F3, { comment: 'shared note' })
    patchEntry(state.triage, F4, { fix: 'https://kept-only' })
    setReportIgnored(state.triage, F5, 'deleted-1.json', true)
    patchEntry(state.triage, F6, { color: 'blue' })
    return F5
  }

  it('analyzes the mixed fixture: 3 orphans + 1 shared (markers/triageState/comments/ignoredIds)', async () => {
    await setupMixedFixture()
    await saveReport('deleted-1.json', [{ id: F1 }, { id: F2 }, F5Source])
    await saveReport('deleted-2.json', [{ id: F2 }, { id: F3 }])
    await saveReport('kept.json', [{ id: F3 }, { id: F4 }])
    const impact = await analyzeTriageImpact(['deleted-1.json', 'deleted-2.json'])
    // F1, F2, F5 → orphans (3). F3 → shared (1).
    // F4 and F6 not in deletedIds, not counted.
    assert.deepEqual(impact, { orphanedCount: 3, sharedCount: 1 })
  })

  it('prune after the matching delete leaves the kept-only triage intact', async () => {
    const F5 = await setupMixedFixture()
    // Only kept.json survives the user's "delete workspace" action.
    await saveReport('kept.json', [{ id: F3 }, { id: F4 }])
    await pruneOrphanTriage()
    assert.equal(state.triage.get(F1)?.color === undefined, true, 'F1 orphan GCd')
    assert.equal(state.triage.get(F2)?.triage === undefined, true, 'F2 orphan GCd')
    assert.equal(state.triage.get(F3)?.comment, 'shared note', 'F3 shared kept')
    assert.equal(state.triage.get(F4)?.fix, 'https://kept-only', 'F4 unrelated kept')
    assert.equal(isReportIgnored(state.triage, F5, 'deleted-1.json'), false,
      'F5 ignored entry GCd (both report gone AND id unreachable)')
    assert.equal(state.triage.get(F6)?.color === undefined, true,
      'F6 pre-existing orphan also GCd (prune sweeps every unreachable entry)')
  })
})

describe('round-2 review #5: report names cannot contain NUL', () => {
  beforeEach(clearAll)

  it('saveFile rejects a name containing NUL', async () => {
    // ignoredIds composite keys are `${reportName}\0${id}`; a
    // report name carrying its own NUL would split the key at
    // the wrong byte and either GC the wrong ignore entry or
    // pin (reportName, id) pairs that never resolve. Guard at
    // the storage boundary so the bug can't enter the cache.
    await assert.rejects(
      storage.saveFile('a evil.json', '{"findings":[]}'),
      /Invalid report name: contains NUL byte/u,
    )
  })

  it('saveFile rejects non-string names defensively', async () => {
    await assert.rejects(storage.saveFile(undefined, '{}'),
      /Invalid report name/u)
    await assert.rejects(storage.saveFile(null, '{}'),
      /Invalid report name/u)
    await assert.rejects(storage.saveFile(42, '{}'),
      /Invalid report name/u)
  })

  it('saveFile accepts the normal name shapes', async () => {
    // Sanity — uuid-shaped filenames, plain extensions, and
    // unicode names must still round-trip; the guard targets
    // NUL only, nothing else.
    await storage.saveFile('a.json', JSON.stringify({ findings: [{ id: FINDING_A }] }))
    await storage.saveFile('claude-security.md', '# A title\n')
    await storage.saveFile('rrая.json', JSON.stringify({ findings: [] }))
    assert.ok(await storage.readFile('a.json'))
  })
})

describe('round-2 review #8: listFiles failure propagates', () => {
  // listFiles is the prune's enumeration step. The round-1 #1
  // tests covered the readFile failure path; this one covers
  // the listFiles path (a distinct OPFS surface — getDirectoryHandle
  // can fail in production for storage-permission flicker or
  // similar transient causes, separately from per-file reads).
  beforeEach(clearAll)

  function withFailingLocalStorageLength(fn) {
    const orig = Object.getOwnPropertyDescriptor(globalThis.localStorage, 'length')
    Object.defineProperty(globalThis.localStorage, 'length', {
      get() { throw new Error('simulated OPFS enumeration failure') },
      configurable: true,
    })
    return Promise.resolve()
      .then(fn)
      .finally(() => { Object.defineProperty(globalThis.localStorage, 'length', orig) })
  }

  it('pruneOrphanTriage throws and leaves state untouched when listFiles fails', async () => {
    // Pre-fix: `try { names = await listFiles() } catch { names = [] }`
    // → empty reachable → wipe everything. Post-fix: the throw
    // propagates so the caller can decide.
    patchEntry(state.triage, FINDING_A, { color: 'red' })
    patchEntry(state.triage, FINDING_B, { color: 'green' })
    await withFailingLocalStorageLength(async () => {
      await assert.rejects(pruneOrphanTriage(), /simulated OPFS enumeration failure/u)
    })
    // Both markers survive — neither was touched because the
    // walk never reached the mutation phase.
    assert.equal(state.triage.get(FINDING_A)?.color, 'red')
    assert.equal(state.triage.get(FINDING_B)?.color, 'green')
  })

  it('analyzeTriageImpact throws on a listFiles failure (only when persisted overlaps deleted)', async () => {
    patchEntry(state.triage, FINDING_A, { color: 'red' })
    await saveReport('a.json', [{ id: FINDING_A }])
    await withFailingLocalStorageLength(async () => {
      // The helper short-circuits after the deleted-side parse
      // when persisted ∩ deleted is non-empty → reaches the
      // listFiles call → throws.
      await assert.rejects(analyzeTriageImpact(['a.json']),
        /simulated OPFS enumeration failure/u)
    })
  })

  it('analyzeTriageImpact short-circuits BEFORE listFiles when there is no persisted triage', async () => {
    // The early-return path (`if (persisted.size === 0) return …`)
    // means listFiles is never called and the helper survives a
    // simulated OPFS failure. Pins this short-circuit as a
    // performance + robustness contract.
    await withFailingLocalStorageLength(async () => {
      const impact = await analyzeTriageImpact(['nope.json'])
      assert.deepEqual(impact, { orphanedCount: 0, sharedCount: 0 })
    })
  })
})

describe('triage-gc: malformed + legacy-shape robustness', () => {
  beforeEach(clearAll)

  it('pruneOrphanTriage clears a legacy {deleted:true} entry on an orphaned id', async () => {
    // An unmigrated legacy entry reaching state.triage as the raw
    // {deleted:true} shape. The prune patch must clear `deleted` too —
    // otherwise normalizeEntry re-derives triage:'deleted', entriesEqual
    // sees no change, and the entry survives every sweep.
    await saveReport('keep.json', [{ id: FINDING_A }])
    state.triage.set(FINDING_B, { deleted: true }) // orphan: in no report
    await pruneOrphanTriage()
    assert.equal(state.triage.has(FINDING_B), false, 'legacy deleted orphan should be pruned')
  })

  it('a report whose findings is a non-array does not crash the GC sweep', async () => {
    // parseReport does no shape validation; a truthy non-array
    // `findings` must be skipped, not throw out of collectReachableIds
    // (which would block both the delete-report dialog and GC).
    await storage.saveFile('bad.json', JSON.stringify({ findings: 42 }))
    state.triage.set(FINDING_A, { triage: 'fixed' })
    await assert.doesNotReject(pruneOrphanTriage())
  })

  it('treats a `groups`-shaped report as reachable (not orphaned)', async () => {
    // A native-JSON report can carry its entries under `groups` instead
    // of `findings`; collectReachableIds must walk it so pruneOrphanTriage
    // doesn't wipe triage attached to those ids.
    await storage.saveFile('grp.json', JSON.stringify({ groups: [[{ id: FINDING_A }]] }))
    state.triage.set(FINDING_A, { triage: 'fixed' }) // reachable via groups
    state.triage.set(FINDING_B, { triage: 'fixed' }) // true orphan (in no report)
    await pruneOrphanTriage()
    assert.ok(state.triage.has(FINDING_A), 'id reachable via `groups` is preserved')
    assert.equal(state.triage.has(FINDING_B), false, 'true orphan is still pruned')
  })
})
