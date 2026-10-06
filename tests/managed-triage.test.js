// ui/view/managed-triage.js — the managed client's server-side triage
// hydrate/push for team reports. Exercised against a fake client index
// (state, notifier slot, saveTriage) and fake wire calls; the timer is faked
// so the debounce is driven by hand.
import assert from 'node:assert/strict'
import { beforeEach, mock, test } from 'node:test'
import { bucketOf, patchEntry, setEntry } from '../client/triage-entry.ts'
import { MAX_TRIAGE_BODY_BYTES, MAX_TRIAGE_TEXT } from '../common/managed/triage.ts'
import { createManagedHistory } from '../ui/view/managed-history.js'
import { browserAt } from './_managed-browser.js'
import { watchTeamFeed } from '../client/managed/team-feed.js'

const state = {
  serverMode: 'managed',
  managedSession: { role: 'triage', csrfToken: 'tok' },
  managedReport: null,
  managedReports: [],
  reports: [],
  triage: new Map(),
}
let notifier = () => {}
let renders = 0, saves = 0
// The wire, in call order: { fetch: reportId } and { id, entries, csrfToken }.
let calls = [], invalidations = []
let pushStatus = 200
// What GET /api/reports/<id>/triage answers, per report id; null = failure.
// A function answers with a promise the test controls.
let serverEntries = {}
let annotationCalls = [], annotationResult = {}
const pushes = () => calls.filter((c) => c.fetch === undefined)

mock.module('../client/index.js', { namedExports: {
  state, bucketOf, setEntry,
  setManagedTriageChangeNotifier: (fn) => { notifier = fn },
  saveTriage: () => { saves++; notifier(); return Promise.resolve() },
} })
mock.module('../ui/view/client-managed.js', { namedExports: {
  fetchTeamAnnotations: async (teamId, options) => {
    annotationCalls.push({ teamId, options })
    const reports = await (typeof annotationResult === 'function' ? annotationResult() : annotationResult)
    return reports ? id => Object.hasOwn(reports, id) ? reports[id] : null : null
  },
  fetchReportTriage: (id, teamId, options) => {
    calls.push({ fetch: id })
    if (typeof serverEntries === 'function') return serverEntries(id, teamId, options)
    return Promise.resolve(serverEntries == null ? null : (serverEntries[id] ?? {}))
  },
  pushReportTriage: (id, entries, csrfToken, teamId) => { calls.push({ id, entries, csrfToken, ...(teamId ? { teamId } : {}) }); return Promise.resolve(typeof pushStatus === 'function' ? pushStatus() : pushStatus) },
} })
mock.module('../ui/view/managed-pull-requests.js', { namedExports: { invalidateManagedFixes: teamId => { invalidations.push(teamId) } } })
mock.module('../ui/view/render.js', { namedExports: { render: () => { renders++ } } })
mock.method(console, 'warn', () => {})
const { createManagedAnnotationRead, hydrateManagedReportTriage, initManagedTriagePush, resetManagedTriage } = await import('../ui/view/managed-triage.js')
const { saveTriage } = await import('../client/index.js')

mock.timers.enable({ apis: ['setTimeout'] })
// Let the flush chain (promise hops around the async push) settle.
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise((resolve) => { setImmediate(resolve) }) }
const drain = async () => { mock.timers.tick(500); await settle() }

// Open a team report: its findings loaded, the slot claimed, the server's
// entries hydrated — what openTeamReport does after switchToFile.
function load(id, findingIds) {
  state.reports = [{ groups: findingIds.map((f) => [{ id: f }]) }]
  state.managedReport = { id, filename: `${id}.json` }
}
async function open(id, findingIds) {
  load(id, findingIds)
  await hydrateManagedReportTriage(id)
}
async function edit(id, patch) {
  patchEntry(state.triage, id, patch)
  await saveTriage()
}
const push = (id, entries) => ({ id, entries, csrfToken: 'tok' })

beforeEach(async () => {
  await drain()
  resetManagedTriage()
  state.triage.clear(); state.reports = []; state.managedReport = null; state.managedReports = []
  state.localMode = false
  state.currentManagedTeam = null
  state.currentManagedReport = null
  state.managedSession = { role: 'triage', csrfToken: 'tok' }
  saves = 0; renders = 0; calls = []; invalidations = []; pushStatus = 200; serverEntries = {}
  annotationCalls = []; annotationResult = {}
  initManagedTriagePush()
})

test('a local entry the server has never seen is carried up on open; edits push; unchanged saves do not', async () => {
  // Triaged before (another report, or offline) — the same finding id.
  state.triage.set('x', { triage: 'fixed' })
  await open('B', ['x', 'y'])
  await drain()
  assert.deepEqual(pushes(), [push('B', { x: { triage: 'fixed' } })], 'the server learns the local triage of x')
  assert.equal(saves, 0, 'nothing adopted, nothing persisted')
  await edit('y', { color: 'red' })
  await drain()
  assert.deepEqual(pushes().at(-1), push('B', { y: { color: 'red' } }))
  // A save that changes nothing pushes nothing; a re-open of a report whose
  // server copy matches pushes nothing either.
  await saveTriage()
  await drain()
  assert.equal(pushes().length, 2)
  serverEntries = { B: { x: { triage: 'fixed' }, y: { color: 'red' } } }
  await open('B', ['x', 'y'])
  await drain()
  assert.equal(pushes().length, 2)
})

test('server entries win per id on hydrate — a tombstone clears — persist + repaint, and are not echoed back', async () => {
  state.triage.set('x', { triage: 'fixed', ignoredReports: ['old.json'] })
  state.triage.set('z', { ignoredReports: ['old.json'] })
  state.triage.set('w', { color: 'red', ignoredReports: ['old.json'] })
  serverEntries = { B: { x: { triage: 'invalid' }, z: { fix: 'hi', flagged: false }, w: null } }
  await open('B', ['x', 'y', 'z', 'w'])
  assert.equal(bucketOf(state.triage.get('x')), 'invalid')
  assert.equal(state.triage.get('x').ignoredReports, undefined, 'a bucket clears the per-report ignore (mutex)')
  assert.deepEqual(state.triage.get('z'), { fix: 'hi', flagged: false, ignoredReports: ['old.json'] }, 'no bucket keeps it')
  assert.deepEqual(state.triage.get('w'), { ignoredReports: ['old.json'] }, 'the tombstone clears the entry, keeps the client-local ignore')
  assert.equal(saves, 1)
  assert.equal(renders, 1)
  await drain()
  assert.deepEqual(pushes(), [], 'the adopted entries are the baseline, not edits')
  await edit('x', { fix: 'mine' })
  await drain()
  assert.deepEqual(pushes(), [push('B', { x: { triage: 'invalid', fix: 'mine' } })])
})

test('the same id across reports: what landed from one report is not re-sent from the next', async () => {
  await open('A', ['x'])
  await edit('x', { triage: 'fixed' })
  await drain()
  assert.deepEqual(pushes(), [push('A', { x: { triage: 'fixed' } })])
  // The re-scan carries x (the server has it now) and a new finding.
  serverEntries = { B: { x: { triage: 'fixed' } } }
  await open('B', ['x', 'n'])
  await drain()
  assert.equal(pushes().length, 1, 'x is where the server already has it')
  await edit('n', { color: 'red' })
  await drain()
  assert.deepEqual(pushes().at(-1), push('B', { n: { color: 'red' } }))
})

test('managed triage never hydrates or pushes the legacy shared comment field', async () => {
  serverEntries = { A: { x: { color: 'blue', comment: 'old shared text' } } }
  await open('A', ['x'])
  assert.deepEqual(state.triage.get('x'), { color: 'blue' })
  await edit('x', { comment: 'a local projection must not be sent' })
  await drain()
  assert.deepEqual(pushes(), [])
  await edit('x', { color: 'red' })
  await drain()
  assert.deepEqual(pushes(), [push('A', { x: { color: 'red' } })])
})

test('a view switch inside the debounce window still flushes the edits to the report they were made in', async () => {
  await open('B', ['y'])
  await edit('y', { triage: 'inprogress' })
  state.managedReport = null
  state.reports = []
  await drain()
  assert.deepEqual(pushes(), [push('B', { y: { triage: 'inprogress' } })])
})

test('a comment link to another team preserves an edit made inside the debounce window', async () => {
  const { browser } = browserAt('/team/first/report/B')
  const nav = createManagedHistory(browser)
  await nav.start(async route => {
    await open(route.reportSlug, route.reportSlug === 'B' ? ['y'] : ['q'])
    return true
  })
  await edit('y', { triage: 'inprogress' })
  assert.deepEqual(pushes(), [], 'the edit is still waiting for its debounce')
  assert.equal(await browser.click('/team/second/report/C/finding/q'), true)
  await settle()
  assert.deepEqual(calls, [{ fetch: 'B' }, push('B', { y: { triage: 'inprogress' } }), { fetch: 'C' }])
  assert.equal(browser.location.pathname, '/team/second/report/C/finding/q')
  assert.equal(state.managedReport.id, 'C')
})

test('edits in two reports flush as separate batches, each to its own report', async () => {
  await open('B', ['y'])
  await edit('y', { color: 'red' })
  // Opening C flushes B's pending edit first (before C's GET); y is not among
  // C's findings.
  await open('C', ['q'])
  await settle()
  assert.deepEqual(calls, [{ fetch: 'B' }, push('B', { y: { color: 'red' } }), { fetch: 'C' }])
  await edit('q', { fix: '#1' })
  await drain()
  assert.deepEqual(pushes().at(-1), push('C', { q: { fix: '#1' } }))
})

test('pushes wait for the report\'s GET; an edit made meanwhile goes up once it has been read', async () => {
  let answer
  serverEntries = () => new Promise((resolve) => { answer = resolve })
  load('B', ['y'])
  const hydrating = hydrateManagedReportTriage('B')
  await settle()
  await edit('y', { color: 'red' })
  await drain()
  assert.deepEqual(pushes(), [], 'nothing goes up before the server copy is known')
  answer({})
  await hydrating
  await drain()
  assert.deepEqual(pushes(), [push('B', { y: { color: 'red' } })])
})

test('merged team hydration can defer painting and routes edits to each report', async () => {
  state.managedReports = [{ id: 'A' }, { id: 'B' }]
  state.reports = [
    { _managedReportId: 'A', groups: [[{ id: 'x' }]] },
    { _managedReportId: 'B', groups: [[{ id: 'y' }]] },
  ]
  serverEntries = { A: { x: { triage: 'fixed' } }, B: { y: { color: 'red' } } }
  await hydrateManagedReportTriage('A', { renderView: false })
  await hydrateManagedReportTriage('B', { renderView: false })
  assert.equal(renders, 0, 'no partially hydrated team is painted')
  assert.equal(state.triage.get('x').triage, 'fixed')
  assert.equal(state.triage.get('y').color, 'red')
  await drain()
  assert.deepEqual(pushes(), [], 'adopted entries are not echoed back')
  await edit('x', { fix: 'first report' })
  await edit('y', { fix: 'second report' })
  await drain()
  assert.deepEqual(pushes(), [
    push('A', { x: { triage: 'fixed', fix: 'first report' } }),
    push('B', { y: { color: 'red', fix: 'second report' } }),
  ])
})

const hydrationCases = [false, true]
hydrationCases.forEach((changed) => {
  test(`a delayed team report queues edits after hydration (${changed ? 'changed' : 'unchanged'} server entries)`, async () => {
    state.managedReports = [{ id: 'A' }, { id: 'B' }]
    state.reports = [
      { _managedReportId: 'A', groups: [[{ id: 'x' }]] },
      { _managedReportId: 'B', groups: [[{ id: 'y' }, { id: 'z' }]] },
    ]
    await hydrateManagedReportTriage('A', { renderView: false })
    let answer
    serverEntries = () => new Promise((resolve) => { answer = resolve })
    const hydrating = hydrateManagedReportTriage('B', { renderView: false })
    await settle()
    await edit('y', { color: 'red' })
    await drain()
    assert.deepEqual(pushes(), [], 'the second report waits for its own GET')
    answer(changed ? { z: { triage: 'fixed' } } : {})
    await hydrating
    await drain()
    assert.deepEqual(pushes(), [push('B', { y: { color: 'red' } })], 'no extra save is needed')
    assert.equal(renders, 0)
  })
})

test('a failed team hydration reports failure and a retry enables its edits', async () => {
  state.managedReports = [{ id: 'A' }, { id: 'B' }]
  state.reports = [
    { _managedReportId: 'A', groups: [[{ id: 'x' }]] },
    { _managedReportId: 'B', groups: [[{ id: 'y' }]] },
  ]
  assert.equal(await hydrateManagedReportTriage('A', { renderView: false }), true)
  serverEntries = null
  assert.equal(await hydrateManagedReportTriage('B', { renderView: false }), false)
  await edit('y', { color: 'red' })
  await drain()
  assert.deepEqual(pushes(), [])
  assert.equal(renders, 0)
  serverEntries = {}
  assert.equal(await hydrateManagedReportTriage('B', { renderView: false }), true)
  await drain()
  assert.deepEqual(pushes(), [push('B', { y: { color: 'red' } })])
})

test('a delayed triage response cannot hydrate a later visit to the same report', async () => {
  let answer
  serverEntries = () => new Promise((resolve) => { answer = resolve })
  load('B', ['y'])
  const hydrating = hydrateManagedReportTriage('B')
  await settle()
  resetManagedTriage()
  load('B', ['y'])
  answer({ y: { color: 'red' } })
  assert.equal(await hydrating, false)
  assert.equal(state.triage.size, 0)
  assert.equal(renders, 0)
})

test('a triage response arriving in local mode is rejected', async () => {
  let answer
  serverEntries = () => new Promise((resolve) => { answer = resolve })
  load('B', ['y'])
  const hydrating = hydrateManagedReportTriage('B')
  await settle()
  state.localMode = true
  answer({ y: { color: 'red' } })
  assert.equal(await hydrating, false)
  assert.equal(state.triage.size, 0)
  assert.equal(renders, 0)
})

test('initial hydration passes view cancellation to HTTP and rejects a late response even when reports are reused', async () => {
  const controller = new AbortController(), pending = Promise.withResolvers()
  load('B', ['y'])
  state.currentManagedTeam = 'team'
  serverEntries = (id, teamId, { signal }) => {
    assert.equal(id, 'B')
    assert.equal(teamId, 'team')
    assert.equal(signal, controller.signal)
    return pending.promise
  }
  const hydrating = hydrateManagedReportTriage('B', { signal: controller.signal })
  await settle()
  controller.abort()
  pending.resolve({ y: { color: 'red' } })
  assert.equal(await hydrating, false)
  assert.equal(state.triage.size, 0)
  assert.equal(saves, 0)
  assert.equal(renders, 0)
})

const hydrationSessionFields = ['id', 'role']
hydrationSessionFields.forEach(field => {
  test(`initial hydration rejects a response after the session ${field} changes`, async () => {
    const pending = Promise.withResolvers()
    load('B', ['y'])
    serverEntries = () => pending.promise
    const hydrating = hydrateManagedReportTriage('B')
    await settle()
    state.managedSession = { ...state.managedSession, [field]: field === 'role' ? 'view' : 'other' }
    pending.resolve({ y: { fix: 'private' } })
    assert.equal(await hydrating, false)
    assert.equal(state.triage.size, 0)
    assert.equal(saves, 0)
  })
})

test('a transient failure is retried with the next flush; a landed batch is not re-sent', async () => {
  await open('B', ['y', 'w'])
  pushStatus = 0
  await edit('y', { color: 'red' })
  await drain()
  assert.equal(pushes().length, 1)
  pushStatus = 200
  await edit('w', { color: 'blue' })
  await drain()
  assert.deepEqual(pushes().at(-1), push('B', { y: { color: 'red' }, w: { color: 'blue' } }))
  await edit('w', { color: undefined })
  await drain()
  assert.deepEqual(pushes().at(-1), push('B', { w: null }), 'clearing pushes a clear; y already landed')
})

test('a batch the server refuses as sent does not wedge later pushes; an over-cap entry stays local', async () => {
  await open('B', ['y', 'w', 'v'])
  pushStatus = 400
  await edit('y', { color: 'red' })
  await drain()
  assert.equal(pushes().length, 1)
  pushStatus = 200
  await edit('w', { color: 'blue' })
  await drain()
  assert.deepEqual(pushes().at(-1), push('B', { w: { color: 'blue' } }), 'the refused entry is not sent again as is')
  await edit('y', { color: 'green' })
  await drain()
  assert.deepEqual(pushes().at(-1), push('B', { y: { color: 'green' } }), 'until it changes')
  // An entry over the server's caps never goes out (it would be refused), and
  // does not hold the others back.
  await edit('v', { fix: 'x'.repeat(MAX_TRIAGE_TEXT + 1) })
  await edit('w', { fix: '#2' })
  await drain()
  assert.deepEqual(pushes().at(-1), push('B', { w: { color: 'blue', fix: '#2' } }))
  assert.equal(state.triage.get('v').fix.length, MAX_TRIAGE_TEXT + 1, 'kept locally')
})

test('a push is split by entry count and by body size', async () => {
  const ids = Array.from({ length: 230 }, (_, i) => `f${i}`)
  await open('B', ids)
  for (const id of ids) patchEntry(state.triage, id, { color: 'red' })
  await saveTriage()
  await drain()
  assert.deepEqual(pushes().map((p) => Object.keys(p.entries).length), [200, 30])
  assert.deepEqual(invalidations, [], 'bulk color changes do not refresh Fix metadata')
  calls = []
  const big = Array.from({ length: 40 }, (_, i) => `g${i}`)
  state.reports = [{ groups: big.map((f) => [{ id: f }]) }]
  for (const id of big) patchEntry(state.triage, id, { fix: 'é'.repeat(MAX_TRIAGE_TEXT) })
  await saveTriage()
  await drain()
  const sizes = pushes().map((p) => new TextEncoder().encode(JSON.stringify({ entries: p.entries })).length)
  assert.ok(sizes.length > 1, 'more than one request')
  assert.ok(sizes.every((n) => n <= MAX_TRIAGE_BODY_BYTES), `each within the body cap: ${sizes}`)
  assert.equal(pushes().reduce((n, p) => n + Object.keys(p.entries).length, 0), 40)
  assert.deepEqual(invalidations, [null], 'body-limited Fix batches invalidate once after the flush')
})

test('a role below triage hydrates but never pushes; a failed GET keeps the local map and blocks pushes', async () => {
  state.managedSession = { role: 'view', csrfToken: 'tok' }
  serverEntries = { B: { x: { triage: 'fixed' } } }
  await open('B', ['x', 'y'])
  assert.equal(bucketOf(state.triage.get('x')), 'fixed')
  await edit('y', { color: 'red' })
  await drain()
  assert.deepEqual(pushes(), [])
  state.managedSession = { role: 'triage', csrfToken: 'tok' }
  serverEntries = null
  state.triage.set('y', { color: 'green' })
  const before = saves
  await open('B', ['x', 'y'])
  assert.equal(state.triage.get('y').color, 'green')
  assert.equal(saves, before, 'a failed GET adopts nothing')
  await edit('y', { color: 'blue' })
  await drain()
  assert.deepEqual(pushes(), [], 'and nothing goes up blind')
  serverEntries = { B: { x: { triage: 'fixed' } } }
  await open('B', ['x', 'y'])
  await drain()
  assert.deepEqual(pushes(), [push('B', { y: { color: 'blue' } })], 'the next successful open carries it')
})

test('pending triage keeps its original team authorization when the same report opens in another team', async () => {
  state.currentManagedTeam = 'one'
  await open('A', ['x'])
  await edit('x', { color: 'red' })
  state.currentManagedTeam = 'two'
  await open('A', ['x'])
  await drain()
  assert.equal(pushes()[0].teamId, 'one')
  assert.equal(pushes()[0].entries.x.color, 'red')
})


test('saved triage invalidates Fix metadata for the captured workspace only after the save lands', async () => {
  state.currentManagedTeam = 'first'
  await open('B', ['y'])
  await edit('y', { fix: 'https://github.com/org/repo/pull/1' })
  assert.deepEqual(invalidations, [])
  state.currentManagedTeam = 'second'
  await drain()
  assert.deepEqual(invalidations, ['first'])
  await open('C', ['z'])
  pushStatus = 400
  await edit('z', { fix: 'https://github.com/org/repo/pull/2' })
  await drain()
  assert.deepEqual(invalidations, ['first'], 'a refused save does not change the server Fix source')
})


test('bulk color, flag and triage edits leave the Fix cache intact when URLs are unchanged', async () => {
  const ids = Array.from({ length: 230 }, (_, i) => `f${i}`)
  const fix = 'https://github.com/org/repo/issues/1'
  serverEntries = { B: Object.fromEntries(ids.map(id => [id, { fix }])) }
  await open('B', ids)
  for (const id of ids) patchEntry(state.triage, id, { color: 'red', flagged: true, triage: 'fixed' })
  await saveTriage()
  await drain()
  assert.equal(pushes().length, 2)
  assert.ok(pushes().every(batch => Object.values(batch.entries).every(entry => entry.fix === fix)))
  assert.deepEqual(invalidations, [])
})

test('Fix changes across reports and request batches invalidate once after the entire flush lands', async () => {
  state.currentManagedTeam = 'team'
  const ids = Array.from({ length: 230 }, (_, i) => `f${i}`)
  state.managedReports = [{ id: 'A' }, { id: 'B' }]
  state.reports = [
    { _managedReportId: 'A', groups: ids.map(id => [{ id }]) },
    { _managedReportId: 'B', groups: [[{ id: 'last' }]] },
  ]
  await hydrateManagedReportTriage('A', { renderView: false })
  await hydrateManagedReportTriage('B', { renderView: false })
  for (const id of [...ids, 'last']) patchEntry(state.triage, id, { fix: 'https://github.com/org/repo/pull/1' })
  const finalBatch = Promise.withResolvers()
  let count = 0
  pushStatus = () => ++count === 3 ? finalBatch.promise : 200
  await saveTriage()
  await drain()
  const before = [...invalidations]
  finalBatch.resolve(200)
  await settle()
  assert.equal(count, 3)
  assert.deepEqual(before, [], 'a pending final report delays invalidation even after earlier batches land')
  assert.deepEqual(invalidations, ['team'])
})

const partialFailures = [503, 'throw']
partialFailures.forEach(failure => {
  test(`a partially landed Fix flush invalidates once even when a later batch fails (${failure})`, async () => {
    state.currentManagedTeam = 'team'
    const ids = Array.from({ length: 450 }, (_, i) => `f${i}`)
    await open('B', ids)
    for (const id of ids) patchEntry(state.triage, id, { fix: 'https://github.com/org/repo/issues/1' })
    let count = 0
    pushStatus = () => {
      if (++count <= 2) return 200
      if (failure === 'throw') throw new Error('network')
      return failure
    }
    await saveTriage()
    await drain()
    assert.equal(count, 3)
    assert.deepEqual(invalidations, ['team'], 'the successful batches changed persisted Fix values')
  })
})

test('a rejected Fix edit does not hide a later successful change carried by a color edit', async () => {
  state.currentManagedTeam = 'team'
  serverEntries = { B: { x: { fix: 'https://github.com/org/repo/pull/1' } } }
  await open('B', ['x'])
  pushStatus = 400
  await edit('x', { fix: 'https://github.com/org/repo/issues/2' })
  await drain()
  assert.deepEqual(invalidations, [])
  pushStatus = 200
  await edit('x', { color: 'red' })
  await drain()
  assert.deepEqual(invalidations, ['team'], 'compare with the last server-confirmed Fix, not the refused wire entry')
  await edit('x', { fix: '' })
  await drain()
  assert.deepEqual(invalidations, ['team', 'team'], 'clearing a saved Fix also invalidates')
  await edit('x', { flagged: true })
  await drain()
  assert.deepEqual(invalidations, ['team', 'team'], 'later non-Fix changes do not invalidate')
})

const { refreshManagedReportTriage } = await import('../ui/view/managed-triage.js')
test('feed refresh adopts remote changes and purges, preserves ignored reports, and does not echo POSTs', async () => {
  state.currentManagedTeam = 'team'
  serverEntries = { B: { x: { color: 'red' }, y: { triage: 'fixed' } } }
  await open('B', ['x', 'y'])
  state.triage.set('x', { color: 'red', ignoredReports: ['old.json'] })
  serverEntries = { B: { x: { color: 'blue', fix: 'https://github.com/org/repo/pull/1' } } }
  assert.equal(await refreshManagedReportTriage('B'), true)
  assert.equal(state.triage.get('x').color, 'blue')
  assert.deepEqual(state.triage.get('x').ignoredReports, ['old.json'])
  assert.equal(state.triage.get('y'), undefined)
  await drain()
  assert.deepEqual(pushes(), [])
  assert.deepEqual(invalidations, ['team'])
})

test('feed refresh preserves edits made or posted while its GET is pending', async () => {
  await open('B', ['x'])
  const response = Promise.withResolvers()
  serverEntries = () => response.promise
  const refresh = refreshManagedReportTriage('B')
  await settle()
  await edit('x', { color: 'red' })
  await drain()
  response.resolve({ x: { color: 'blue' } })
  assert.equal(await refresh, true)
  assert.equal(state.triage.get('x').color, 'red')
  assert.equal(pushes().length, 1)
})

test('feed refresh preserves failed pending writes and rejects responses after navigation', async () => {
  await open('B', ['x'])
  pushStatus = 503
  await edit('x', { color: 'red' })
  serverEntries = { B: { x: { color: 'blue' } } }
  await refreshManagedReportTriage('B')
  assert.equal(state.triage.get('x').color, 'red')
  const response = Promise.withResolvers()
  serverEntries = () => response.promise
  const controller = new AbortController()
  const refresh = refreshManagedReportTriage('B', { signal: controller.signal })
  await settle()
  controller.abort()
  response.resolve({ x: { color: 'green' } })
  assert.equal(await refresh, false)
  assert.equal(state.triage.get('x').color, 'red')
})

test('the feed watchdog escapes a stalled triage POST without cancelling or replaying the write', async t => {
  await open('B', ['x', 'y'])
  const upload = Promise.withResolvers()
  pushStatus = () => upload.promise
  await edit('x', { color: 'red' })
  await drain()
  const connections = [], controller = new AbortController()
  let catalogs = 0
  t.mock.method(globalThis, 'fetch', (_url, { signal }) => {
    connections.push(signal)
    return Promise.resolve(new Response(new ReadableStream({
      start(stream) {
        stream.enqueue(new TextEncoder().encode('event: teams\ndata: {}\n\nevent: triage\ndata: {}\n\n'))
        signal.addEventListener('abort', () => stream.error(signal.reason), { once: true })
      },
    }), { headers: { 'content-type': 'text/event-stream' } }))
  })
  const done = watchTeamFeed('team', { signal: controller.signal,
    onTeams: () => { catalogs++; return true },
    onUpdate: signal => refreshManagedReportTriage('B', { signal }),
    onClose() { assert.fail('a stalled write must not revoke the subscription') },
  })
  t.after(async () => { controller.abort(); upload.resolve(200); await done; await settle() })
  await settle()
  assert.equal(catalogs, 1)
  assert.deepEqual(calls, [{ fetch: 'B' }, push('B', { x: { color: 'red' } })], 'the feed waits before reading over a pending write')
  mock.timers.tick(45000); await settle()
  mock.timers.tick(1000); await settle()
  assert.equal(connections[0].aborted, true)
  assert.equal(connections.length, 2, 'the feed reconnects while the POST is still pending')
  assert.equal(catalogs, 2, 'catalog events resume without navigation or completing the write')
  assert.equal(controller.signal.aborted, false)
  assert.equal(pushes().length, 1, 'read cancellation neither drops nor replays the pending POST')
  assert.equal(state.triage.get('x').color, 'red')

  serverEntries = { B: { x: { color: 'red' }, y: { color: 'green' } } }
  pushStatus = 200
  upload.resolve(200)
  await settle()
  assert.equal(calls.filter(call => call.fetch).length, 2, 'only the current connection reads after the POST lands')
  assert.equal(state.triage.get('x').color, 'red')
  assert.equal(state.triage.get('y').color, 'green', 'the reconnected feed resumes triage updates')
  await edit('x', { color: 'blue' })
  await drain()
  assert.deepEqual(pushes(), [push('B', { x: { color: 'red' } }), push('B', { x: { color: 'blue' } })])
})

test('team hydration and refresh share one snapshot and preserve edits during the batch', async () => {
  state.currentManagedTeam = 'team'
  state.managedReports = [{ id: 'A' }, { id: 'B' }]
  state.reports = [
    { _managedReportId: 'A', groups: [[{ id: 'x' }]] },
    { _managedReportId: 'B', groups: [[{ id: 'y' }]] },
  ]
  annotationResult = { A: { entries: { x: { color: 'blue' } }, comments: [] }, B: { entries: {}, comments: [] } }
  let readAnnotations = createManagedAnnotationRead('team')
  assert.deepEqual(await Promise.all(['A', 'B'].map(id => hydrateManagedReportTriage(id, { readAnnotations, renderView: false }))), [true, true])
  assert.equal(annotationCalls.length, 1)
  assert.equal(state.triage.get('x').color, 'blue')
  assert.equal(calls.filter(call => call.fetch).length, 0, 'no per-report HTTP reads')
  const response = Promise.withResolvers()
  annotationResult = () => response.promise
  readAnnotations = createManagedAnnotationRead('team')
  const refreshes = ['A', 'B'].map(id => refreshManagedReportTriage(id, { readAnnotations }))
  await settle()
  await edit('y', { color: 'red' })
  await drain()
  response.resolve({ A: { entries: { x: { color: 'green' } }, comments: [] }, B: { entries: { y: { color: 'blue' } }, comments: [] } })
  assert.deepEqual(await Promise.all(refreshes), [true, true])
  assert.equal(annotationCalls.length, 2, 'each refresh gets a new snapshot')
  assert.equal(state.triage.get('x').color, 'green')
  assert.equal(state.triage.get('y').color, 'red', 'the batch cannot undo an edit posted while it was in flight')
})

test('management previews and focused links views retain individual annotation reads', () => {
  state.currentManagedReport = 'A'
  state.managedReports = [{ id: 'A' }]
  assert.equal(createManagedAnnotationRead(null), undefined)
  state.currentManagedReport = 'links'
  state.managedReports = [{ id: 'A' }, { id: 'links' }]
  assert.equal(createManagedAnnotationRead('team'), undefined)
})

test('team annotation reads wait for pending writes and respect cancellation', async () => {
  await open('B', ['x'])
  const write = Promise.withResolvers()
  pushStatus = () => write.promise
  await edit('x', { color: 'red' })
  const controller = new AbortController()
  const read = createManagedAnnotationRead('team', controller.signal)
  const result = read('B')
  await settle()
  assert.equal(annotationCalls.length, 0)
  controller.abort()
  assert.equal(await result, null)
  write.resolve(200)
  await settle()
  assert.equal(annotationCalls.length, 0)
})


test('managed shared ignored persists and hydrates without losing dependency report scopes', async () => {
  await open('A', ['x'])
  await edit('x', { triage: 'ignored', ignoredReports: ['dependency.json'] })
  await drain()
  assert.deepEqual(pushes(), [push('A', { x: { triage: 'ignored' } })])
  serverEntries = { B: { x: { triage: 'ignored' } } }
  await open('B', ['x'])
  assert.deepEqual(state.triage.get('x'), { triage: 'ignored', ignoredReports: ['dependency.json'] })
  await drain()
  assert.equal(pushes().length, 1)
})
