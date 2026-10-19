import assert from 'node:assert/strict'
import { beforeEach, mock, test } from 'node:test'
import { store } from '@rray/frontend/state-management'

const state = store({ currentManagedTeam: 'team', currentManagedReport: null, managedTeams: [{ id: 'team', reports: [{ id: 'hidden', visible: false }] }], reports: [] })
const asked = [], toasts = []
let answer
mock.module('../client/index.js', { namedExports: { state } })
mock.module('../ui/view/client-managed.js', { namedExports: { fetchTeamTrees: (teamId, options) => { asked.push([teamId, options.reportId]); return answer.promise } } })
mock.module('../ui/view/toast.js', { namedExports: { showToast: message => toasts.push(message) } })
const { loadManagedTrees, wantsManagedTrees } = await import('../ui/view/managed-trees.js')

beforeEach(() => {
  asked.length = 0; toasts.length = 0
  answer = Promise.withResolvers()
  state.currentManagedTeam = 'team'; state.currentManagedReport = null
  state.reports = [{ _managedReportId: 'a', tree: null, treeFiles: 2 }, { _managedReportId: 'b', tree: null, treeFiles: 3 }, { _managedReportId: 'c', tree: null, treeFiles: null }]
})
const settle = () => new Promise(resolve => { setImmediate(resolve) })

test('a team\'s trees are asked for once while they load, each kept on its report, one the server holds none for left empty', async () => {
  const loaded = []
  assert.equal(wantsManagedTrees(state.reports), true)
  assert.equal(loadManagedTrees(ok => loaded.push(ok)), true)
  assert.equal(loadManagedTrees(ok => loaded.push(ok)), true, 'a render meanwhile asks nothing more')
  assert.deepEqual(asked, [['team', null]])
  answer.resolve(new Map([['a', { 'src/a.js': {} }]]))
  await settle()
  assert.deepEqual(loaded, [true])
  assert.deepEqual(state.reports.map(report => report.tree), [{ 'src/a.js': {} }, {}, null])
  assert.equal(wantsManagedTrees(state.reports), false)
  assert.equal(loadManagedTrees(() => assert.fail('nothing left to ask for')), false)
})

test('a hidden report\'s preview asks for its trees as its reports were read; a failure tells so, and a later view asks again', async () => {
  state.currentManagedReport = 'hidden'
  const loaded = []
  loadManagedTrees(ok => loaded.push(ok))
  assert.deepEqual(asked, [['team', 'hidden']])
  answer.resolve(null)
  await settle()
  assert.deepEqual(loaded, [false])
  assert.equal(toasts.length, 1)
  answer = Promise.withResolvers()
  assert.equal(loadManagedTrees(() => {}), true)
  assert.equal(asked.length, 2)
})

test('trees answered after the view moved on are kept for none', async () => {
  const reports = state.reports
  loadManagedTrees(() => assert.fail('another view'))
  state.reports = [{ _managedReportId: 'd', tree: null, treeFiles: 2 }]
  answer.resolve(new Map([['a', {}], ['d', {}]]))
  await settle()
  assert.equal(reports[0].tree, null)
  assert.equal(state.reports[0].tree, null)
  assert.equal(loadManagedTrees(() => {}), true, 'the view now loaded asks for its own')
  assert.equal(asked.length, 2)
})

test('reports read whole (a local file, a link preview) or outside a team ask for nothing', () => {
  state.reports = [{ tree: { 'src/a.js': {} }, treeFiles: null }]
  assert.equal(loadManagedTrees(() => {}), false)
  state.reports = [{ _managedReportId: 'a', tree: null, treeFiles: 2 }]
  state.currentManagedTeam = null
  assert.equal(loadManagedTrees(() => {}), false)
  assert.deepEqual(asked, [])
})
