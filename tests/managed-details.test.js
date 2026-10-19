import assert from 'node:assert/strict'
import { beforeEach, mock, test } from 'node:test'
import { store } from '@rray/frontend/state-management'

const state = store({ reports: [] })
const toasts = [], workspaces = []
mock.module('../client/index.js', { namedExports: { state } })
mock.module('../client/managed/workspace.js', { namedExports: { setManagedWorkspace: (teamId, workspace) => workspaces.push([teamId, workspace]) } })
mock.module('../ui/view/toast.js', { namedExports: { showToast: message => toasts.push(message) } })
const { awaitManagedDetails, managedDetailsPending, managedDetailsReady } = await import('../ui/view/managed-details.js')
const { findingText } = await import('../ui/view/format.js')

// A report as ingest.js keeps it: its non-empty entries' members, copied.
const lite = { id: 'r', data: { findings: [{ id: 'a', file: 'src/a.js', title: 'A' }, [], [{ id: 'b', file: 'src/b.js', description: 'B' }, { id: 'c', file: 'src/c.js' }]] } }
const whole = { id: 'r', data: { findings: [{ id: 'a', file: 'src/a.js', title: 'A', description: 'alpha body', evidence: [{ file: 'src/x.js' }], fileHash: 'h' }, [],
  [{ id: 'b', file: 'src/b.js', description: 'B\nbeta body', exportName: 'run' }, { id: 'c', file: 'src/c.js', impact: 'gamma' }]] } }
const ingested = () => [{ _managedReportId: 'r', groups: lite.data.findings.map(entry => Array.isArray(entry) ? entry : [entry])
  .filter(group => group.length > 0).map(group => group.map(f => ({ ...f, _id: f.id }))) }]
const settle = () => new Promise(resolve => { setImmediate(resolve) })

beforeEach(() => { workspaces.length = 0; toasts.length = 0; state.reports = ingested() })

test('a team\'s findings wait for their detail, then are filled in where they are, their search text with them', async () => {
  const loaded = [], request = Promise.withResolvers()
  const [a] = state.reports[0].groups[0]
  assert.equal(findingText(a).includes('alpha'), false)
  awaitManagedDetails('team', request.promise, () => true, () => loaded.push(true))
  assert.equal(managedDetailsPending(), true)
  let ready = null
  void (async () => { ready = await managedDetailsReady() })()
  await settle()
  assert.equal(ready, null)
  request.resolve([whole])
  await settle()
  assert.deepEqual(loaded, [true])
  assert.equal(ready, true, 'ready, with their detail')
  assert.equal(await managedDetailsReady(), true)
  assert.equal(managedDetailsPending(), false)
  const [[filledA], [b, c]] = state.reports[0].groups
  assert.strictEqual(filledA, a, 'filled in where it is')
  assert.deepEqual([a.description, a.evidence, a.fileHash], ['alpha body', [{ file: 'src/x.js' }], 'h'])
  assert.deepEqual([b.description, b.exportName, c.impact], ['B\nbeta body', 'run', 'gamma'])
  assert.equal(findingText(a).includes('alpha body'), true, 'a search reads the detail')
  assert.deepEqual(workspaces, [['team', [whole]]], 'the finding index is built again from the whole reports')
})

test('details not matching the findings they would fill leave them as they are', async () => {
  const shifted = { id: 'r', data: { findings: [[{ id: 'b', description: 'wrong' }]] } }
  awaitManagedDetails('team', Promise.resolve([shifted]), () => true, () => {})
  await settle()
  assert.equal(state.reports[0].groups[1][0].description, 'B')
  const renamed = { id: 'r', data: { findings: [{ id: 'z', description: 'wrong' }, [{ id: 'b', description: 'right' }, { id: 'c' }]] } }
  awaitManagedDetails('team', Promise.resolve([renamed]), () => true, () => {})
  await settle()
  assert.equal(Object.hasOwn(state.reports[0].groups[0][0], 'description'), false, 'one whose ID differs is not filled in')
  assert.equal(state.reports[0].groups[1][0].description, 'right')
})

test('details that fail leave the board as it is, telling so; ones answered after the view moved on fill nothing', async () => {
  const loaded = []
  awaitManagedDetails('team', Promise.resolve(null), () => true, () => loaded.push(true))
  await settle()
  assert.deepEqual([loaded, toasts.length, managedDetailsPending()], [[true], 1, false])
  assert.equal(await managedDetailsReady(), false, 'an export does not take the board\'s copy for the details')
  const request = Promise.withResolvers()
  awaitManagedDetails('team', request.promise, () => true, () => assert.fail('another view'))
  state.reports = ingested()
  assert.equal(managedDetailsPending(), false, 'other reports loaded wait for nothing of these')
  assert.equal(await managedDetailsReady(), true)
  request.resolve([whole])
  await settle()
  assert.equal(Object.hasOwn(state.reports[0].groups[0][0], 'evidence'), false)
  assert.deepEqual(workspaces, [])
})
