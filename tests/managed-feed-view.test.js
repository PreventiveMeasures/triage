import assert from 'node:assert/strict'
import { afterEach, beforeEach, mock, test } from 'node:test'
import { autorun, store } from '@rray/frontend/state-management'
import { beginViewNavigation } from '../ui/view/view-navigation.js'

const state = store({ serverMode: 'managed', currentView: 'findings', localMode: false, managedSession: { id: 'user', role: 'triage' } })
const calls = [], refreshes = []
let refresh = () => Promise.resolve(true)
let preview = false
mock.module('../client/index.js', { namedExports: { state, isManagedUiMode: () => state.serverMode === 'managed' && !state.localMode } })
mock.module('../ui/view/client-managed.js', { namedExports: {
  watchTeamFeed: (teamId, options) => {
    calls.push({ teamId, ...options })
    if (preview) return Promise.resolve()
    return new Promise(resolve => { options.signal.addEventListener('abort', resolve, { once: true }) })
  },
} })
mock.module('../ui/view/managed-triage.js', { namedExports: {
  refreshManagedReportTriage: (id, options) => { refreshes.push(['triage', id]); return refresh(options) },
} })
mock.module('../ui/view/managed-comments.js', { namedExports: {
  loadManagedReportComments: id => { refreshes.push(['comments', id]); return Promise.resolve(true) },
} })
const { startManagedTeamFeed, stopManagedTeamFeed, setManagedTeamFeedRefresh } = await import('../ui/view/managed-feed.js')
function open(team, options) {
  state.currentManagedTeam = team
  state.managedReports = [{ id: `${team}-report` }, { id: `${team}-links` }]
  state.reports = [{ _managedReportId: `${team}-report` }]
  return startManagedTeamFeed(options)
}
beforeEach(() => {
  stopManagedTeamFeed(); beginViewNavigation()
  calls.length = 0; refreshes.length = 0
  state.currentView = 'findings'; state.localMode = false
  state.managedSession = { id: 'user', role: 'triage' }
  refresh = () => Promise.resolve(true)
  preview = false
  setManagedTeamFeedRefresh(() => Promise.resolve(true))
})
afterEach(() => stopManagedTeamFeed())

test('one feed follows the focused team and closes as soon as navigation starts', async () => {
  open('one'); startManagedTeamFeed()
  assert.equal(calls.length, 1)
  assert.equal(await calls[0].onUpdate(calls[0].signal), true)
  assert.deepEqual(refreshes, [['triage', 'one-report'], ['comments', 'one-report']])
  beginViewNavigation()
  assert.equal(calls[0].signal.aborted, true)
  open('two')
  assert.equal(calls.length, 2)
  assert.equal(calls[1].teamId, 'two')
  assert.equal(await calls[0].onUpdate(calls[0].signal), false)
  assert.equal(await calls[1].onUpdate(calls[1].signal), true)
  beginViewNavigation() // Home / bundle / Manage all begin navigation.
  state.currentManagedTeam = null
  startManagedTeamFeed()
  assert.equal(calls[1].signal.aborted, true)
  assert.equal(calls.length, 3)
  assert.equal(calls[2].teamId, null)
})

test('navigation during refresh drops the old continuation and refreshes only the new team', async () => {
  const pending = Promise.withResolvers()
  refresh = () => pending.promise
  open('one')
  const update = calls[0].onUpdate(calls[0].signal)
  beginViewNavigation(); open('two')
  pending.resolve(true)
  assert.equal(await update, false)
  assert.deepEqual(refreshes, [['triage', 'one-report']], 'no comment refresh under the next team scope')
})

test('reused reports restart on the new navigation signal; local mode and account changes stop old subscriptions', () => {
  open('one'); beginViewNavigation(); startManagedTeamFeed()
  assert.equal(calls.length, 2)
  assert.equal(calls[0].signal.aborted, true)
  state.managedSession = { id: 'other', role: 'view' }
  startManagedTeamFeed()
  assert.equal(calls[1].signal.aborted, true)
  assert.equal(calls.length, 3)
  state.localMode = true; startManagedTeamFeed()
  assert.equal(calls[2].signal.aborted, true)
})


test('catalog refresh is awaited, failures retry, and stale callbacks cannot refresh another session', async () => {
  const catalogs = [], pending = Promise.withResolvers()
  setManagedTeamFeedRefresh((current, signal) => { catalogs.push({ current, signal }); return pending.promise })
  state.currentView = 'home'; state.currentManagedTeam = null
  startManagedTeamFeed({ catalogOnly: true })
  assert.equal(calls[0].teamId, null)
  const update = calls[0].onTeams(calls[0].signal)
  assert.equal(catalogs.length, 1)
  pending.resolve(false)
  assert.equal(await update, false)
  state.managedSession = { id: 'other', role: 'view' }
  startManagedTeamFeed({ catalogOnly: true })
  assert.equal(catalogs[0].current(), false)
  assert.equal(catalogs[0].signal.aborted, true)
  assert.equal(await calls[0].onTeams(calls[0].signal), false)
  assert.equal(catalogs.length, 1)
})

test('catalog revisions reach the shared page catalog without changing its connection signal', async () => {
  const revisions = []
  setManagedTeamFeedRefresh((current, signal, revision) => { revisions.push(revision); assert.equal(current(), true); assert.equal(signal, calls[0].signal); return true })
  open('one')
  assert.equal(await calls[0].onTeams(calls[0].signal, 'catalog-v1'), true)
  assert.deepEqual(revisions, ['catalog-v1'])
})

test('sidebar renders keep one feed and do not subscribe to triage before hydration', () => {
  state.currentManagedTeam = 'one'
  startManagedTeamFeed({ catalogOnly: true })
  startManagedTeamFeed({ catalogOnly: true })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].teamId, null)
  open('one')
  startManagedTeamFeed({ catalogOnly: true })
  assert.equal(calls.length, 2)
  assert.equal(calls[0].signal.aborted, true)
  assert.equal(calls[1].teamId, 'one')
  beginViewNavigation(); state.currentView = 'manage'
  startManagedTeamFeed({ catalogOnly: true })
  assert.equal(calls[1].signal.aborted, true)
  assert.equal(calls[2].teamId, null)
})

test('unapproved users and public-share landing never open a user catalog feed', () => {
  for (const session of [{ id: 'user', role: 'none' }, { id: 'share', role: 'view', publicShare: true }, null]) {
    state.managedSession = session
    state.currentView = 'home'
    startManagedTeamFeed({ catalogOnly: true })
  }
  assert.equal(calls.length, 0)
})

test('catalog and triage refreshes use connection cancellation without stopping the subscription', async () => {
  const catalogs = [], connection = new AbortController(), pending = Promise.withResolvers()
  setManagedTeamFeedRefresh((current, signal) => { catalogs.push({ current, signal }); return pending.promise })
  open('one')
  const catalog = calls[0].onTeams(connection.signal)
  assert.equal(catalogs[0].signal, connection.signal)
  connection.abort()
  pending.resolve(true)
  assert.equal(await catalog, false)
  assert.equal(catalogs[0].current(), false)
  assert.equal(calls[0].signal.aborted, false, 'the watcher can reconnect in the same view')

  const next = new AbortController(), triage = Promise.withResolvers()
  refresh = ({ signal }) => { assert.equal(signal, next.signal); return triage.promise }
  const update = calls[0].onUpdate(next.signal)
  next.abort()
  triage.resolve(true)
  assert.equal(await update, false)
  assert.deepEqual(refreshes, [['triage', 'one-report']], 'a timed-out triage read cannot start a comment refresh')
  assert.equal(calls[0].signal.aborted, false)
})

test('the first feed event hydrates once; sidebar renders and its fallback do not repeat annotation reads', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const pending = Promise.withResolvers(), reads = []
  const ready = open('one', { hydrate: signal => { reads.push(signal); return pending.promise } })
  assert.deepEqual(reads, [], 'wait for the initial feed baseline before reading annotations')
  assert.equal(await calls[0].onTeams(calls[0].signal), true)
  assert.deepEqual(reads, [])
  const update = calls[0].onUpdate(calls[0].signal)
  await Promise.resolve()
  assert.equal(reads.length, 1)
  assert.equal(reads[0], calls[0].signal)
  assert.equal(startManagedTeamFeed({ catalogOnly: true }), ready)
  t.mock.timers.tick(5_000)
  pending.resolve(true)
  assert.equal(await ready, true)
  assert.equal(await update, true)
  assert.equal(calls.length, 1)
  assert.equal(reads.length, 1)
  assert.deepEqual(refreshes, [], 'the initial event does not reread triage and comments')
  assert.equal(await calls[0].onUpdate(calls[0].signal), true)
  assert.deepEqual(refreshes, [['triage', 'one-report'], ['comments', 'one-report']], 'later changes still refresh both')
})

test('HTTP fallback loads a stalled feed and a late first event catches changes since loading began', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const pending = Promise.withResolvers()
  let reads = 0
  const ready = open('one', { hydrate: () => { reads++; return pending.promise } })
  t.mock.timers.tick(1_000)
  await Promise.resolve()
  assert.equal(reads, 1)
  const update = calls[0].onUpdate(calls[0].signal)
  assert.deepEqual(refreshes, [], 'live refresh cannot overtake initial hydration')
  pending.resolve(true)
  assert.equal(await ready, true)
  assert.equal(await update, true)
  assert.equal(reads, 1)
  assert.deepEqual(refreshes, [['triage', 'one-report'], ['comments', 'one-report']])
})

test('the first reactive render after hydration keeps the same report scope and live subscription', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const ready = open('one', { hydrate: () => true })
  assert.equal(await calls[0].onUpdate(calls[0].signal), true)
  assert.equal(await ready, true)
  // StateElement renders lazily wrap nested values in reactive proxies.
  const dispose = autorun(() => state.reports.length)
  dispose()
  assert.equal(await calls[0].onTeams(calls[0].signal), true)
  assert.equal(await calls[0].onUpdate(calls[0].signal), true)
  assert.deepEqual(refreshes, [['triage', 'one-report'], ['comments', 'one-report']])
})

test('preview without a feed hydrates immediately without waiting for the fallback timer', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  preview = true
  let reads = 0
  assert.equal(await open('one', { hydrate: () => { reads++; return true } }), true)
  assert.equal(reads, 1)
  t.mock.timers.tick(5_000)
  assert.equal(reads, 1)
})

test('navigation cancels pending initial loading before or during hydration', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let reads = 0
  let ready = open('one', { hydrate: () => { reads++; return true } })
  beginViewNavigation()
  assert.equal(await ready, false)
  t.mock.timers.tick(5_000)
  assert.equal(await calls[0].onUpdate(calls[0].signal), false)
  assert.equal(reads, 0)

  const pending = Promise.withResolvers()
  let signal
  ready = open('two', { hydrate: value => { signal = value; return pending.promise } })
  const update = calls[1].onUpdate(calls[1].signal)
  await Promise.resolve()
  beginViewNavigation()
  assert.equal(signal.aborted, true)
  assert.equal(await ready, false)
  assert.equal(await update, false)
  pending.resolve(true)
  assert.deepEqual(refreshes, [])
})

test('a watchdog timeout releases the feed callback while a reconnect waits for the same initial hydration', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const connection = new AbortController(), pending = Promise.withResolvers()
  let reads = 0, signal
  const ready = open('one', { hydrate: value => { reads++; signal = value; return pending.promise } })
  const update = calls[0].onUpdate(connection.signal)
  await Promise.resolve()
  connection.abort()
  assert.equal(await update, false)
  assert.equal(signal.aborted, false)
  const reconnect = calls[0].onUpdate(new AbortController().signal)
  assert.deepEqual(refreshes, [])
  pending.resolve(true)
  assert.equal(await ready, true)
  assert.equal(await reconnect, true)
  assert.equal(reads, 1)
  assert.deepEqual(refreshes, [['triage', 'one-report'], ['comments', 'one-report']])
})

test('failed initial hydration cannot mark the view ready or apply live refreshes', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const ready = open('one', { hydrate: () => false })
  assert.equal(await calls[0].onUpdate(calls[0].signal), false)
  assert.equal(await ready, false)
  assert.deepEqual(refreshes, [])
})
