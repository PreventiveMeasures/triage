import assert from 'node:assert/strict'
import { beforeEach, mock, test } from 'node:test'
import { beginViewNavigation } from '../ui/view/view-navigation.js'

const state = { serverMode: 'managed', currentView: 'findings', localMode: false, managedSession: { id: 'user', role: 'triage' } }
const calls = [], refreshes = []
let refresh = () => Promise.resolve(true)
mock.module('../client/index.js', { namedExports: { state, isManagedUiMode: () => state.serverMode === 'managed' && !state.localMode } })
mock.module('../ui/view/client-managed.js', { namedExports: {
  watchTeamFeed: (teamId, options) => {
    calls.push({ teamId, ...options })
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
function open(team) {
  state.currentManagedTeam = team
  state.managedReports = [{ id: `${team}-report` }, { id: `${team}-links` }]
  state.reports = [{ _managedReportId: `${team}-report` }]
  startManagedTeamFeed()
}
beforeEach(() => {
  stopManagedTeamFeed(); beginViewNavigation()
  calls.length = 0; refreshes.length = 0
  state.currentView = 'findings'; state.localMode = false
  state.managedSession = { id: 'user', role: 'triage' }
  refresh = () => Promise.resolve(true)
  setManagedTeamFeedRefresh(() => Promise.resolve(true))
})

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
