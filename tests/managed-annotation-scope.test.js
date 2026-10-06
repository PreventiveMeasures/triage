import assert from 'node:assert/strict'
import { afterEach, beforeEach, mock, test } from 'node:test'
import { store } from '@rray/frontend/state-management'
import { bucketOf, setEntry } from '../client/triage-entry.ts'
import { beginViewNavigation } from '../ui/view/view-navigation.js'

const state = store({ serverMode: 'managed', localMode: false, triage: new Map(), managedComments: new Map(), managedIssues: new Map() })
const feeds = []
let share = null
mock.module('../client/index.js', { namedExports: {
  state, bucketOf, setEntry, isManagedUiMode: () => true,
  saveTriage: () => Promise.resolve(), setManagedTriageChangeNotifier: () => {},
} })
mock.module('../client/managed/public-share.js', { namedExports: {
  getPublicShare: () => share, publicShareBootstrapPath: () => '/api/shares/link/workspace',
} })
const session = await import('../client/managed/session.js')
mock.module('../ui/view/client-managed.js', { namedExports: {
  ...session,
  watchTeamFeed: (teamId, options) => {
    feeds.push({ teamId, ...options })
    return new Promise(resolve => { options.signal.addEventListener('abort', resolve, { once: true }) })
  },
} })
mock.module('../ui/view/managed-pull-requests.js', { namedExports: { invalidateManagedFixes: () => {}, refreshManagedIssueMetadata: () => {} } })
mock.module('../ui/view/render.js', { namedExports: { render: () => {} } })
const { createManagedAnnotationRead, hydrateManagedReportTriage, resetManagedTriage } = await import('../ui/view/managed-triage.js')
const { loadManagedReportComments } = await import('../ui/view/managed-comments.js')
const { startManagedTeamFeed, stopManagedTeamFeed } = await import('../ui/view/managed-feed.js')

beforeEach(() => {
  stopManagedTeamFeed(); beginViewNavigation(); resetManagedTriage()
  feeds.length = 0
  state.triage.clear()
  state.currentView = 'findings'
  state.currentManagedTeam = 'team'
})
afterEach(() => stopManagedTeamFeed())

function annotationScopeTest(publicShare, reportId) {
  return async t => {
    share = publicShare ? { id: 'link', token: 'test-token' } : null
    const location = Object.getOwnPropertyDescriptor(globalThis, 'location')
    globalThis.location = { origin: 'https://triage.test' }
    t.after(() => { if (location) Object.defineProperty(globalThis, 'location', location); else delete globalThis.location })
    state.managedSession = { id: 'viewer', role: 'view', publicShare }
    state.currentManagedReport = reportId
    const ids = reportId ? [reportId] : ['small', 'other']
    state.managedReports = ids.map(id => ({ id }))
    state.reports = ids.map(id => ({ _managedReportId: id, groups: [[{ id }]] }))
    const requests = []
    let color = 'blue'
    const entries = () => ({ small: { color }, other: { color } })
    const comments = () => ['small', 'other'].map(id => ({ id: `${id}-comment`, findingId: id, body: color }))
    t.mock.method(globalThis, 'fetch', (url, options) => {
      requests.push(url)
      assert.ok(options.signal)
      assert.equal(options.credentials, publicShare ? 'omit' : 'same-origin')
      if (publicShare) assert.equal(options.headers.get('x-deepview-share'), share.token)
      let body
      if (url === '/api/teams/team/annotations') {
        body = { reports: { small: ['small'], other: ['other'] }, entries: entries(), comments: comments() }
      } else if (url === '/api/teams/team/annotations?reportId=small') {
        body = { reports: { small: ['small'] }, entries: { small: { color } }, comments: comments().slice(0, 1) }
      }
      else assert.fail(`Unexpected annotation request: ${url}`)
      return Promise.resolve(Response.json(body))
    })
    const ready = startManagedTeamFeed({ hydrate: async signal => {
      const readAnnotations = createManagedAnnotationRead(state.currentManagedTeam, signal)
      const results = await Promise.all(ids.flatMap(id => [
        hydrateManagedReportTriage(id, { renderView: false, signal, readAnnotations }),
        loadManagedReportComments(id, { signal, readAnnotations }),
      ]))
      return results.every(Boolean)
    } })
    const expected = reportId
      ? ['/api/teams/team/annotations?reportId=small']
      : ['/api/teams/team/annotations']
    assert.equal(await feeds[0].onUpdate(feeds[0].signal), true)
    assert.equal(await ready, true)
    assert.deepEqual(requests.toSorted(), expected, 'hydration reads only the active annotation scope')
    assert.equal(state.triage.get('small').color, 'blue')
    assert.equal(state.managedComments.get('small')[0].body, 'blue')
    requests.length = 0
    color = 'green'
    assert.equal(await feeds[0].onUpdate(feeds[0].signal), true)
    assert.deepEqual(requests.toSorted(), expected, 'live refresh keeps the same scope')
    assert.equal(state.triage.get('small').color, 'green')
    assert.equal(state.managedComments.get('small')[0].body, 'green')
    assert.equal(state.managedComments.has('other'), reportId === null)
    assert.equal(feeds.length, 1, 'annotation reads reuse the team feed')
  }
}

for (const publicShare of [false, true]) {
  for (const reportId of ['small', null]) {
    test(`${publicShare ? 'public' : 'signed-in'} ${reportId ? 'focused report' : 'team'} keeps annotation scope through hydration and feed refresh`,
      annotationScopeTest(publicShare, reportId))
  }
}
