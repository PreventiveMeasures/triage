// The two triage tracks — one answer per app, one about the cause.
//
// A finding id is derived from the source's own bytes, so every app
// shipping a dependency reads the SAME triage entry. Before the split
// that made one word do two jobs: "we removed the dependency" (true
// in one app) was written where "the bug is gone" (true everywhere)
// is read, and the next app to load a report with that dependency in
// it opened on a board that said Fixed.
//
// These tests pin both halves: that a per-app answer stays in its own
// app, and that the cause-level ones ('invalid' / 'deleted' /
// upstream) keep reaching every app — the propagation that is the
// reason to record them once.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import './_polyfills.js'

// Same `@rray/frontend` slot stub group-state.test.js installs: the
// group.js import chain reaches format.js → frontend-global.js, which
// throws at module-load without it.
const slotKey = Symbol.for('@rray/frontend')
if (!globalThis[slotKey]) {
  globalThis[slotKey] = {
    LitElement: class {}, html: () => null, nothing: null, render: () => null,
    unsafeCSS: () => null, StateElement: class {}, classMap: () => null,
    repeat: () => null, styleMap: () => null,
  }
}

const {
  appFixOf, appTriageOf, appsWith, bucketForApp, bucketForApps, clearAppEverywhere,
  entryIsEmpty, normalizeEntry, patchEntry, setAppFix, setAppTriage, setUpstream,
  upstreamOf,
} = await import('../client/triage-entry.ts')
const { mergeAppTracks } = await import('../client/sync/triage-changeset.ts')
const { state } = await import('../client/state.ts')
const {
  findingApp, findingApps, isDependencyFinding, isUnscopedBucket, scopedApps,
  setTabFix, setTabTriage, syncGroupTriage, tabFix, tabTriage, triageAppScope,
} = await import('../ui/view/group.js')

const APP_A = 'acme/web'
const APP_B = 'acme/admin'
const DEP_FILE = 'node_modules/left-pad/index.js'

// One finding as ingest stamps it: `_appKey` names the app the report
// covers, `_reportName` the file it came from.
function finding(id, { app = APP_A, file = DEP_FILE, report = 'a.json' } = {}) {
  return { id, severity: 'high', file, line: '1', description: 'x', _appKey: app, _reportName: report }
}

function reset() {
  state.triage.clear()
}

describe('normalizeEntry / entryIsEmpty over the new fields', () => {
  it('keeps a valid app slot and upstream record', () => {
    const e = normalizeEntry({
      apps: { [APP_A]: { triage: 'fixed', fix: ' https://pr ' } },
      upstream: { state: 'fixed', since: ' 4.17.21 ', link: 'https://u' },
    })
    // The apps map is null-prototype (see the __proto__ case below),
    // so its slots are compared field-wise rather than against an
    // object literal deepEqual would reject on the prototype alone.
    assert.deepEqual(Object.keys(e.apps), [APP_A])
    assert.deepEqual({ ...e.apps[APP_A] }, { triage: 'fixed', fix: 'https://pr' })
    assert.deepEqual(e.upstream, { state: 'fixed', link: 'https://u', since: '4.17.21' })
  })
  it('drops unknown values, empty slots and empty records', () => {
    assert.equal(normalizeEntry({ apps: { [APP_A]: { triage: 'bogus' } } }), undefined)
    assert.equal(normalizeEntry({ apps: { '': { triage: 'fixed' } } }), undefined)
    assert.equal(normalizeEntry({ apps: {} }), undefined)
    assert.equal(normalizeEntry({ upstream: { state: 'maybe' } }), undefined)
    assert.equal(normalizeEntry({ upstream: {} }), undefined)
    // 'invalid' / 'deleted' are claims about the finding, never one
    // app's work on it, so the app track refuses them.
    assert.equal(normalizeEntry({ apps: { [APP_A]: { triage: 'invalid' } } }), undefined)
  })
  it('keeps a bare upstream link with no state — someone pasted the issue first', () => {
    assert.deepEqual(normalizeEntry({ upstream: { link: 'https://u' } }), { upstream: { link: 'https://u' } })
  })
  it('a __proto__ app key lands as an own property, not on the prototype', () => {
    // The keys are app names off a peer's changeset or a persisted
    // blob, and a report file can be named anything. Same class the
    // sync layer's Object.create(null) guards (audit round-12 H6).
    const out = normalizeEntry(JSON.parse('{"apps": {"__proto__": {"triage": "fixed"}}}'))
    assert.equal(Object.getPrototypeOf(out.apps), null)
    assert.deepEqual(Object.keys(out.apps), ['__proto__'])
    assert.equal(({}).triage, undefined, 'Object.prototype is untouched')
  })
  it('routes a __proto__ app key through the setter safely too', () => {
    reset()
    setAppTriage(state.triage, 'f1', '__proto__', 'fixed')
    const apps = state.triage.get('f1').apps
    assert.deepEqual(Object.keys(apps), ['__proto__'])
    assert.equal(appTriageOf(state.triage.get('f1'), '__proto__'), 'fixed')
    assert.equal(appTriageOf(state.triage.get('f1'), 'anything-else'), undefined)
  })
  it('never aliases the source objects', () => {
    const src = { apps: { [APP_A]: { triage: 'fixed' } }, upstream: { state: 'reported' } }
    const out = normalizeEntry(src)
    assert.notEqual(out.apps, src.apps)
    assert.notEqual(out.apps[APP_A], src.apps[APP_A])
    assert.notEqual(out.upstream, src.upstream)
  })
  it('counts either field as a non-empty entry', () => {
    assert.equal(entryIsEmpty({ apps: { [APP_A]: { triage: 'fixed' } } }), false)
    assert.equal(entryIsEmpty({ upstream: { state: 'reported' } }), false)
    assert.equal(entryIsEmpty({ apps: {} }), true)
    assert.equal(entryIsEmpty({ upstream: {} }), true)
  })
})

describe('the app track', () => {
  it('writes and reads one app without touching another', () => {
    reset()
    setAppTriage(state.triage, 'f1', APP_A, 'fixed')
    assert.equal(appTriageOf(state.triage.get('f1'), APP_A), 'fixed')
    assert.equal(appTriageOf(state.triage.get('f1'), APP_B), undefined)
  })
  it('clearing the state keeps that app\'s fix link', () => {
    reset()
    setAppTriage(state.triage, 'f1', APP_A, 'fixed')
    setAppFix(state.triage, 'f1', APP_A, 'https://pr/1')
    setAppTriage(state.triage, 'f1', APP_A, undefined)
    assert.equal(appTriageOf(state.triage.get('f1'), APP_A), undefined)
    assert.equal(appFixOf(state.triage.get('f1'), APP_A), 'https://pr/1')
  })
  it('drops the id once its last slot empties', () => {
    reset()
    setAppTriage(state.triage, 'f1', APP_A, 'fixed')
    setAppTriage(state.triage, 'f1', APP_A, undefined)
    assert.equal(state.triage.has('f1'), false)
  })
  it('gates a no-op write so the reactive map does not churn', () => {
    reset()
    assert.equal(setAppTriage(state.triage, 'f1', APP_A, 'fixed'), true)
    assert.equal(setAppTriage(state.triage, 'f1', APP_A, 'fixed'), false)
    assert.equal(setUpstream(state.triage, 'f1', { state: 'reported' }), true)
    assert.equal(setUpstream(state.triage, 'f1', { state: 'reported' }), false)
  })
  it('lists the apps carrying one state, for the cross-app pages', () => {
    reset()
    setAppTriage(state.triage, 'f1', APP_A, 'fixed')
    setAppTriage(state.triage, 'f1', APP_B, 'inprogress')
    const entry = state.triage.get('f1')
    assert.deepEqual(appsWith(entry, 'fixed'), [APP_A])
    assert.deepEqual(appsWith(entry, 'inprogress'), [APP_B])
    assert.deepEqual(appsWith(undefined, 'fixed'), [])
  })
  it('clearAppEverywhere drops one app across all ids', () => {
    reset()
    setAppTriage(state.triage, 'f1', APP_A, 'fixed')
    setAppTriage(state.triage, 'f1', APP_B, 'fixed')
    setAppTriage(state.triage, 'f2', APP_A, 'inprogress')
    clearAppEverywhere(state.triage, APP_A)
    assert.equal(appTriageOf(state.triage.get('f1'), APP_A), undefined)
    assert.equal(appTriageOf(state.triage.get('f1'), APP_B), 'fixed')
    assert.equal(state.triage.has('f2'), false)
  })
})

describe('bucketForApp precedence', () => {
  it('falls back to the unscoped verdict', () => {
    assert.equal(bucketForApp({ triage: 'fixed' }, APP_A), 'fixed')
  })
  it('prefers this app\'s own answer over the unscoped one', () => {
    const entry = { triage: 'fixed', apps: { [APP_A]: { triage: 'inprogress' } } }
    assert.equal(bucketForApp(entry, APP_A), 'inprogress')
    assert.equal(bucketForApp(entry, APP_B), 'fixed')
  })
  it('lets invalid and deleted answer for every app', () => {
    for (const cause of ['invalid', 'deleted']) {
      const entry = { triage: cause, apps: { [APP_A]: { triage: 'fixed' } } }
      assert.equal(bucketForApp(entry, APP_A), cause)
      assert.equal(bucketForApp(entry, APP_B), cause)
    }
  })
  it('reads the legacy deleted:true form through the same path', () => {
    assert.equal(bucketForApp({ deleted: true, apps: { [APP_A]: { triage: 'fixed' } } }, APP_A), 'deleted')
  })
})

describe('which track a finding writes to', () => {
  it('scopes a dependency finding to its app', () => {
    assert.equal(isDependencyFinding(finding('f1')), true)
    assert.equal(triageAppScope(finding('f1')), APP_A)
  })
  it('leaves the app\'s own code unscoped — the app IS the upstream', () => {
    const own = finding('f1', { file: 'src/server.js' })
    assert.equal(isDependencyFinding(own), false)
    assert.equal(triageAppScope(own), null)
  })
  it('walks past pnpm\'s synthetic dir to the real package', () => {
    const f = finding('f1', { file: 'node_modules/.pnpm/left-pad@1.3.0/node_modules/left-pad/index.js' })
    assert.equal(isDependencyFinding(f), true)
  })
  it('refuses to scope a finding whose report named no app', () => {
    // '' would be one shared bucket for every anonymous report — the
    // conflation this exists to prevent, one level down.
    const f = { id: 'f1', file: DEP_FILE }
    assert.equal(findingApp(f), '')
    assert.equal(triageAppScope(f), null)
  })
  it('falls back to the report name when ingest stamped no app key', () => {
    assert.equal(findingApp({ id: 'f1', _reportName: 'a.json' }), 'a.json')
  })
})

describe('the leak this change closes', () => {
  it('a dependency fixed in one app stays open in the next', () => {
    reset()
    // Same finding id in both apps — same dependency, same bytes.
    const inA = finding('shared-id', { app: APP_A, report: 'a.json' })
    const inB = finding('shared-id', { app: APP_B, report: 'b.json' })
    setAppTriage(state.triage, 'shared-id', APP_A, 'fixed')
    assert.equal(tabTriage(inA), 'fixed')
    assert.equal(tabTriage(inB), undefined)
  })
  it('an unscoped verdict still answers everywhere, and says so', () => {
    reset()
    const inA = finding('shared-id', { app: APP_A })
    const inB = finding('shared-id', { app: APP_B })
    // What a blob written before the split looks like.
    patchEntry(state.triage, 'shared-id', { triage: 'fixed' })
    assert.equal(tabTriage(inA), 'fixed')
    assert.equal(tabTriage(inB), 'fixed')
    assert.equal(isUnscopedBucket(inA), true)
    // Once this app answers for itself, the label goes.
    setAppTriage(state.triage, 'shared-id', APP_A, 'fixed')
    assert.equal(isUnscopedBucket(inA), false)
    assert.equal(isUnscopedBucket(inB), true)
  })
  it('does not label an own-code verdict as unscoped', () => {
    reset()
    const own = finding('f1', { file: 'src/server.js' })
    patchEntry(state.triage, 'f1', { triage: 'fixed' })
    assert.equal(isUnscopedBucket(own), false)
  })
  it('keeps invalid propagating across apps', () => {
    reset()
    const inA = finding('shared-id', { app: APP_A })
    const inB = finding('shared-id', { app: APP_B })
    patchEntry(state.triage, 'shared-id', { triage: 'invalid' })
    assert.equal(tabTriage(inA), 'invalid')
    assert.equal(tabTriage(inB), 'invalid')
  })
  it('keeps the upstream record global — that is what it is for', () => {
    reset()
    setUpstream(state.triage, 'shared-id', { state: 'fixed', since: '4.17.21' })
    // Read through the entry every app shares...
    assert.deepEqual(upstreamOf(state.triage.get('shared-id')), { state: 'fixed', since: '4.17.21' })
    // ...without it moving anyone's card: the board is the app's.
    assert.equal(tabTriage(finding('shared-id', { app: APP_B })), undefined)
  })
})

describe('setTabTriage routes the write', () => {
  it('sends a work state on a dependency to this app\'s slot', () => {
    reset()
    const dep = finding('f1')
    assert.equal(setTabTriage(dep, 'fixed'), true)
    assert.equal(appTriageOf(state.triage.get('f1'), APP_A), 'fixed')
    assert.equal(state.triage.get('f1').triage, undefined)
  })
  it('converts an unscoped verdict on the first re-triage', () => {
    reset()
    const dep = finding('f1')
    patchEntry(state.triage, 'f1', { triage: 'fixed' })
    setTabTriage(dep, 'inprogress')
    assert.equal(state.triage.get('f1').triage, undefined, 'the unscoped verdict is gone')
    assert.equal(appTriageOf(state.triage.get('f1'), APP_A), 'inprogress')
    // ...and the app that never answered is no longer carried along.
    assert.equal(tabTriage(finding('f1', { app: APP_B })), undefined)
  })
  it('sends the cause-level verdicts to the entry, clearing this app\'s slot', () => {
    reset()
    const dep = finding('f1')
    setTabTriage(dep, 'fixed')
    setTabTriage(dep, 'invalid')
    assert.equal(state.triage.get('f1').triage, 'invalid')
    assert.equal(appTriageOf(state.triage.get('f1'), APP_A), undefined)
  })
  it('sends own-code work states to the entry, as before', () => {
    reset()
    const own = finding('f1', { file: 'src/server.js' })
    setTabTriage(own, 'fixed')
    assert.equal(state.triage.get('f1').triage, 'fixed')
    assert.equal(state.triage.get('f1').apps, undefined)
  })
  it('clears both tracks and reports whether anything moved', () => {
    reset()
    const dep = finding('f1')
    setTabTriage(dep, 'fixed')
    assert.equal(setTabTriage(dep, undefined), true)
    assert.equal(state.triage.has('f1'), false)
    assert.equal(setTabTriage(dep, undefined), false)
  })
})

describe('levelling a group keeps the scope', () => {
  it('syncGroupTriage writes each tab\'s own app slot, not the entry', () => {
    reset()
    // Two tabs of one dedup group, from two apps' reports — the shape
    // a cross-report merge produces. One is fixed; levelling used to
    // stamp the unscoped verdict onto the other, putting the leak
    // back a second way.
    const a = finding('t1', { app: APP_A })
    const b = finding('t2', { app: APP_B })
    setTabTriage(a, 'fixed')
    assert.equal(syncGroupTriage([a, b]), true)
    assert.equal(appTriageOf(state.triage.get('t2'), APP_B), 'fixed')
    assert.equal(state.triage.get('t2').triage, undefined)
  })
})

describe('fix links follow the same scope', () => {
  it('a dependency fix stays in its app', () => {
    reset()
    const inA = finding('shared-id', { app: APP_A })
    const inB = finding('shared-id', { app: APP_B })
    setTabFix(inA, 'https://github.com/acme/web/pull/12')
    assert.equal(tabFix(inA), 'https://github.com/acme/web/pull/12')
    assert.equal(tabFix(inB), '')
  })
  it('converts an unscoped link into the app that edited it', () => {
    reset()
    const inA = finding('shared-id', { app: APP_A })
    const inB = finding('shared-id', { app: APP_B })
    patchEntry(state.triage, 'shared-id', { fix: 'https://old' })
    assert.equal(tabFix(inB), 'https://old')
    setTabFix(inA, 'https://new')
    assert.equal(tabFix(inA), 'https://new')
    assert.equal(tabFix(inB), '')
    assert.equal(state.triage.get('shared-id').fix, undefined)
  })
  it('writes own-code links to the entry, as before', () => {
    reset()
    const own = finding('f1', { file: 'src/server.js' })
    setTabFix(own, 'https://pr/1')
    assert.equal(state.triage.get('f1').fix, 'https://pr/1')
    assert.equal(tabFix(own), 'https://pr/1')
  })
  it('clears a link on either track', () => {
    reset()
    const dep = finding('f1')
    setTabFix(dep, 'https://pr/1')
    setTabFix(dep, '')
    assert.equal(tabFix(dep), '')
    assert.equal(state.triage.has('f1'), false)
  })
})

// A dependency finding both apps' reports carry is deduplicated to ONE
// finding object in a workspace — the second occurrence is dropped
// before it can be stamped — so the survivor records every app it
// stands for and has to answer for all of them. Without that, load
// order decided which app owned the card and the other could never be
// recorded at all (Codex review of #260, P1).
describe('a card standing for several apps', () => {
  // What ingest's `recordAppKey` leaves on the survivor.
  const shared = () => finding('shared-id', { app: APP_A })
  const dedupedAcross = (...apps) => ({ ...shared(), _appKeys: apps })

  it('lists every app, and the primary is still the first', () => {
    assert.deepEqual(findingApps(dedupedAcross(APP_A, APP_B)), [APP_A, APP_B])
    assert.deepEqual(scopedApps(dedupedAcross(APP_A, APP_B)), [APP_A, APP_B])
    assert.equal(triageAppScope(dedupedAcross(APP_A, APP_B)), APP_A)
    // The ordinary single-app finding is unchanged.
    assert.deepEqual(findingApps(shared()), [APP_A])
  })

  it('answers for every app it stands for', () => {
    reset()
    const card = dedupedAcross(APP_A, APP_B)
    setTabTriage(card, 'fixed')
    assert.equal(appTriageOf(state.triage.get('shared-id'), APP_A), 'fixed')
    assert.equal(appTriageOf(state.triage.get('shared-id'), APP_B), 'fixed')
    assert.equal(tabTriage(card), 'fixed')
  })

  it('shows a bucket only where the apps agree', () => {
    reset()
    // App A dealt with it in an earlier session; B's report has since
    // loaded and deduplicated onto the same card.
    setAppTriage(state.triage, 'shared-id', APP_A, 'fixed')
    const card = dedupedAcross(APP_A, APP_B)
    assert.equal(tabTriage(card), undefined, 'one app fixed is not a fixed card')
    // The disagreement is what the card's per-app line reports.
    assert.deepEqual(appsWith(state.triage.get('shared-id'), 'fixed'), [APP_A])
    setAppTriage(state.triage, 'shared-id', APP_B, 'fixed')
    assert.equal(tabTriage(card), 'fixed')
  })

  it('clears every app it stands for', () => {
    reset()
    const card = dedupedAcross(APP_A, APP_B)
    setTabTriage(card, 'fixed')
    setTabTriage(card, undefined)
    assert.equal(state.triage.has('shared-id'), false)
  })

  it('bucketForApps falls back to the unscoped verdict with no apps', () => {
    assert.equal(bucketForApps({ triage: 'fixed' }, []), 'fixed')
    assert.equal(bucketForApps({ triage: 'invalid', apps: { [APP_A]: { triage: 'fixed' } } }, [APP_A, APP_B]), 'invalid')
    // An unscoped verdict answers for every app, so they still agree.
    assert.equal(bucketForApps({ triage: 'fixed' }, [APP_A, APP_B]), 'fixed')
    assert.equal(bucketForApp({ triage: 'fixed' }, APP_A), 'fixed')
  })
})

// Concurrent edits to DIFFERENT app slots. The rebase applies the
// local overlay over the chain's new base by replacing whole entries,
// which would drop a peer's slot for another app — work this client
// never had a view on, deleted and then propagated as a deletion on
// the retry (Codex review of #260, P1).
describe('mergeAppTracks', () => {
  const ID = 'shared-id'
  const entry = (apps) => ({ apps })

  it('keeps a peer\'s slot for an app this client did not touch', () => {
    const oldBase = {}
    const newBase = { [ID]: entry({ [APP_A]: { triage: 'fixed' } }) }
    const overlay = { [ID]: entry({ [APP_B]: { triage: 'inprogress' } }) }
    const out = mergeAppTracks(overlay, oldBase, newBase)
    assert.deepEqual(Object.keys(out[ID].apps).toSorted(), [APP_B, APP_A].toSorted())
    assert.equal(out[ID].apps[APP_A].triage, 'fixed', "the peer's app survives")
    assert.equal(out[ID].apps[APP_B].triage, 'inprogress', 'ours survives')
  })

  it('local wins where both edited the same app', () => {
    const oldBase = { [ID]: entry({ [APP_A]: { triage: 'inprogress' } }) }
    const newBase = { [ID]: entry({ [APP_A]: { triage: 'fixed' } }) }
    const overlay = { [ID]: entry({ [APP_A]: { triage: 'inprogress', fix: 'https://mine' } }) }
    const out = mergeAppTracks(overlay, oldBase, newBase)
    assert.equal(out[ID].apps[APP_A].fix, 'https://mine')
  })

  it('a slot this client cleared stays cleared', () => {
    const oldBase = { [ID]: entry({ [APP_A]: { triage: 'fixed' } }) }
    const newBase = { [ID]: entry({ [APP_A]: { triage: 'fixed' } }) }
    const overlay = { [ID]: { color: 'red' } }
    const out = mergeAppTracks(overlay, oldBase, newBase)
    assert.equal(out[ID].apps, undefined)
    assert.equal(out[ID].color, 'red', 'the rest of the entry is untouched')
  })

  it('a delete keeps only what the peer added under a key we never had', () => {
    const oldBase = { [ID]: entry({ [APP_A]: { triage: 'fixed' } }) }
    const newBase = { [ID]: entry({ [APP_A]: { triage: 'fixed' }, [APP_B]: { triage: 'fixed' } }) }
    const out = mergeAppTracks({ [ID]: null }, oldBase, newBase)
    assert.deepEqual(Object.keys(out[ID].apps), [APP_B])
  })

  it('a delete with nothing of the peer\'s stays a delete', () => {
    const oldBase = { [ID]: entry({ [APP_A]: { triage: 'fixed' } }) }
    const newBase = { [ID]: entry({ [APP_A]: { triage: 'fixed' } }) }
    assert.equal(mergeAppTracks({ [ID]: null }, oldBase, newBase)[ID], null)
  })

  it('leaves entries with no app track alone', () => {
    const overlay = { [ID]: { color: 'red' } }
    assert.deepEqual(mergeAppTracks(overlay, {}, {})[ID], { color: 'red' })
  })
})
