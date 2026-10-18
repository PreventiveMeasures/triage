import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { store } from '@rray/frontend/state-management'

// A document whose visibility the test sets, there before managed-feed.js
// listens to it.
const document = Object.assign(new EventTarget(), { hidden: false })
globalThis.document = document
const show = hidden => { document.hidden = hidden; document.dispatchEvent(new Event('visibilitychange')) }

const state = store({ serverMode: 'managed', currentView: 'findings', localMode: false, managedSession: { id: 'user', role: 'triage' },
  currentManagedTeam: 'one', managedReports: [{ id: 'one-report' }], reports: [{ _managedReportId: 'one-report' }] })
const calls = []
mock.module('../client/index.js', { namedExports: { state, isManagedUiMode: () => true } })
mock.module('../ui/view/client-managed.js', { namedExports: {
  watchTeamFeed: (teamId, options) => {
    calls.push({ teamId, ...options })
    return new Promise(resolve => { options.signal.addEventListener('abort', resolve, { once: true }) })
  },
} })
mock.module('../ui/view/managed-triage.js', { namedExports: { createManagedAnnotationRead: () => () => Promise.resolve(null), refreshManagedReportTriage: () => Promise.resolve(true) } })
mock.module('../ui/view/managed-comments.js', { namedExports: { loadManagedReportComments: () => Promise.resolve(true) } })
mock.timers.enable({ apis: ['setTimeout'] })
const { startManagedTeamFeed, stopManagedTeamFeed } = await import('../ui/view/managed-feed.js')

test('a tab hidden a minute lets its feed go, starts the one its view wants once shown, and none while still hidden', () => {
  startManagedTeamFeed()
  assert.equal(calls.length, 1)
  show(true)
  mock.timers.tick(59_000)
  assert.equal(calls[0].signal.aborted, false, 'not yet a minute')
  show(false)
  mock.timers.tick(60_000)
  assert.equal(calls[0].signal.aborted, false, 'shown again before the minute: kept')
  assert.equal(calls.length, 1)

  show(true)
  mock.timers.tick(60_000)
  assert.equal(calls[0].signal.aborted, true, 'let go a minute after it was hidden')
  startManagedTeamFeed({ catalogOnly: true })
  assert.equal(calls.length, 1, 'a sidebar render while hidden starts none')
  show(false)
  assert.equal(calls.length, 2, 'shown, the feed its view wants')
  assert.equal(calls[1].teamId, 'one')
  assert.equal(calls[1].signal.aborted, false)

  // Let go by anything else while hidden: shown again starts none of it.
  show(true)
  stopManagedTeamFeed()
  mock.timers.tick(60_000)
  show(false)
  assert.equal(calls.length, 2)
})
