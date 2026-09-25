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
let calls = []
let pushStatus = 200
// What GET /api/reports/<id>/triage answers, per report id; null = failure.
// A function answers with a promise the test controls.
let serverEntries = {}
const pushes = () => calls.filter((c) => c.fetch === undefined)

mock.module('../client/index.js', { namedExports: {
  state, bucketOf, setEntry,
  setManagedTriageChangeNotifier: (fn) => { notifier = fn },
  saveTriage: () => { saves++; notifier(); return Promise.resolve() },
} })
mock.module('../ui/view/client-managed.js', { namedExports: {
  fetchReportTriage: (id) => {
    calls.push({ fetch: id })
    if (typeof serverEntries === 'function') return serverEntries(id)
    return Promise.resolve(serverEntries == null ? null : (serverEntries[id] ?? {}))
  },
  pushReportTriage: (id, entries, csrfToken) => { calls.push({ id, entries, csrfToken }); return Promise.resolve(pushStatus) },
} })
mock.module('../ui/view/render.js', { namedExports: { render: () => { renders++ } } })
mock.method(console, 'warn', () => {})
const { hydrateManagedReportTriage, initManagedTriagePush, resetManagedTriage } = await import('../ui/view/managed-triage.js')
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
  state.managedSession = { role: 'triage', csrfToken: 'tok' }
  saves = 0; renders = 0; calls = []; pushStatus = 200; serverEntries = {}
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
  serverEntries = { B: { x: { triage: 'invalid' }, z: { comment: 'hi', flagged: false }, w: null } }
  await open('B', ['x', 'y', 'z', 'w'])
  assert.equal(bucketOf(state.triage.get('x')), 'invalid')
  assert.equal(state.triage.get('x').ignoredReports, undefined, 'a bucket clears the per-report ignore (mutex)')
  assert.deepEqual(state.triage.get('z'), { comment: 'hi', flagged: false, ignoredReports: ['old.json'] }, 'no bucket keeps it')
  assert.deepEqual(state.triage.get('w'), { ignoredReports: ['old.json'] }, 'the tombstone clears the entry, keeps the client-local ignore')
  assert.equal(saves, 1)
  assert.equal(renders, 1)
  await drain()
  assert.deepEqual(pushes(), [], 'the adopted entries are the baseline, not edits')
  await edit('x', { comment: 'mine' })
  await drain()
  assert.deepEqual(pushes(), [push('B', { x: { triage: 'invalid', comment: 'mine' } })])
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

test('a view switch inside the debounce window still flushes the edits to the report they were made in', async () => {
  await open('B', ['y'])
  await edit('y', { triage: 'inprogress' })
  state.managedReport = null
  state.reports = []
  await drain()
  assert.deepEqual(pushes(), [push('B', { y: { triage: 'inprogress' } })])
})

test('a comment link to another team preserves an edit made inside the debounce window', async () => {
  const { browser } = browserAt('/teams/first/reports/B')
  const nav = createManagedHistory(browser)
  await nav.start(async route => {
    await open(route.reportSlug, route.reportSlug === 'B' ? ['y'] : ['q'])
    return true
  })
  await edit('y', { triage: 'inprogress' })
  assert.deepEqual(pushes(), [], 'the edit is still waiting for its debounce')
  assert.equal(await browser.click('/teams/second/reports/C#finding=q'), true)
  await settle()
  assert.deepEqual(calls, [{ fetch: 'B' }, push('B', { y: { triage: 'inprogress' } }), { fetch: 'C' }])
  assert.equal(browser.location.pathname, '/teams/second/reports/C')
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
  await edit('x', { comment: 'first report' })
  await edit('y', { comment: 'second report' })
  await drain()
  assert.deepEqual(pushes(), [
    push('A', { x: { triage: 'fixed', comment: 'first report' } }),
    push('B', { y: { color: 'red', comment: 'second report' } }),
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
  await edit('v', { comment: 'x'.repeat(MAX_TRIAGE_TEXT + 1) })
  await edit('w', { fix: '#2' })
  await drain()
  assert.deepEqual(pushes().at(-1), push('B', { w: { color: 'blue', fix: '#2' } }))
  assert.equal(state.triage.get('v').comment.length, MAX_TRIAGE_TEXT + 1, 'kept locally')
})

test('a push is split by entry count and by body size', async () => {
  const ids = Array.from({ length: 230 }, (_, i) => `f${i}`)
  await open('B', ids)
  for (const id of ids) patchEntry(state.triage, id, { color: 'red' })
  await saveTriage()
  await drain()
  assert.deepEqual(pushes().map((p) => Object.keys(p.entries).length), [200, 30])
  calls = []
  const big = Array.from({ length: 40 }, (_, i) => `g${i}`)
  state.reports = [{ groups: big.map((f) => [{ id: f }]) }]
  for (const id of big) patchEntry(state.triage, id, { comment: 'é'.repeat(MAX_TRIAGE_TEXT) })
  await saveTriage()
  await drain()
  const sizes = pushes().map((p) => new TextEncoder().encode(JSON.stringify({ entries: p.entries })).length)
  assert.ok(sizes.length > 1, 'more than one request')
  assert.ok(sizes.every((n) => n <= MAX_TRIAGE_BODY_BYTES), `each within the body cap: ${sizes}`)
  assert.equal(pushes().reduce((n, p) => n + Object.keys(p.entries).length, 0), 40)
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
