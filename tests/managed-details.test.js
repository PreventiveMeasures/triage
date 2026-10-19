import assert from 'node:assert/strict'
import { beforeEach, mock, test } from 'node:test'
import { store } from '@rray/frontend/state-management'

const state = store({ reports: [], revalidateConflicts: new Map() })
const toasts = [], workspaces = []
let clearedMerges = 0
mock.module('../client/index.js', { namedExports: { state } })
mock.module('../client/managed/workspace.js', { namedExports: { setManagedWorkspace: (teamId, workspace) => workspaces.push([teamId, workspace]) } })
mock.module('../ui/view/toast.js', { namedExports: { showToast: message => toasts.push(message) } })
// The conflicts as the merged rows built from the findings now tell them.
mock.module('../ui/view/group.js', { namedExports: {
  clearMergedGroups: () => { clearedMerges++ },
  getRevalidationConflicts: () => new Map(state.reports.flatMap(report => report.groups.flat())
    .filter(f => f.revalidateVerdict === 'disputed').map(f => [f.id, { finding: f, copies: [] }])),
} })
const { awaitManagedDetails, managedDetailsReady, managedDetailsWaiting } = await import('../ui/view/managed-details.js')
const { findingText } = await import('../ui/view/format.js')

// A report as ingest.js keeps it: its non-empty entries' members, copied.
const lite = { id: 'r', data: { findings: [{ id: 'a', file: 'src/a.js', title: 'A' }, [], [{ id: 'b', file: 'src/b.js', description: 'B' }, { id: 'c', file: 'src/c.js' }]] } }
const whole = { id: 'r', data: { findings: [{ id: 'a', file: 'src/a.js', title: 'A', description: 'alpha body', evidence: [{ file: 'src/x.js' }], fileHash: 'h' }, [],
  [{ id: 'b', file: 'src/b.js', description: 'B\nbeta body', exportName: 'run', revalidateVerdict: 'disputed' }, { id: 'c', file: 'src/c.js', impact: 'gamma' }]] } }
const ingested = () => [{ _managedReportId: 'r', groups: lite.data.findings.map(entry => Array.isArray(entry) ? entry : [entry])
  .filter(group => group.length > 0).map(group => group.map(f => ({ ...f, _id: f.id }))) }]
const settle = () => new Promise(resolve => { setImmediate(resolve) })

beforeEach(() => { workspaces.length = 0; toasts.length = 0; clearedMerges = 0; state.reports = ingested(); state.revalidateConflicts = new Map() })

test('a team\'s findings wait for their detail, then are filled in where they are, their search text, merged rows and conflicts with them', async () => {
  const loaded = [], request = Promise.withResolvers()
  const [a] = state.reports[0].groups[0]
  assert.equal(findingText(a).includes('alpha'), false)
  awaitManagedDetails('team', request.promise, () => loaded.push(true))
  assert.equal(managedDetailsWaiting(), 'loading')
  let ready = null
  void (async () => { ready = await managedDetailsReady() })()
  await settle()
  assert.equal(ready, null)
  request.resolve([whole])
  await settle()
  assert.deepEqual(loaded, [true])
  assert.equal(ready, true, 'ready, with their detail')
  assert.equal(await managedDetailsReady(), true)
  assert.equal(managedDetailsWaiting(), null)
  const [[filledA], [b, c]] = state.reports[0].groups
  assert.strictEqual(filledA, a, 'filled in where it is')
  assert.deepEqual([a.description, a.evidence, a.fileHash], ['alpha body', [{ file: 'src/x.js' }], 'h'])
  assert.deepEqual([b.description, b.exportName, c.impact], ['B\nbeta body', 'run', 'gamma'])
  assert.equal(findingText(a).includes('alpha body'), true, 'a search reads the detail')
  assert.deepEqual(workspaces, [['team', [whole]]], 'the finding index is built again from the whole reports')
  assert.equal(clearedMerges, 1, 'merged rows, copies of their findings, are built again')
  assert.deepEqual([...state.revalidateConflicts.keys()], ['b'], 'a conflict told by the pass\'s prose alone is found')
})

test('details not matching every finding they would fill fill none, and never come', async () => {
  const shifted = { id: 'r', data: { findings: [[{ id: 'b', description: 'wrong' }]] } }
  const renamed = { id: 'r', data: { findings: [{ id: 'z', description: 'wrong' }, [{ id: 'b', description: 'right' }, { id: 'c' }]] } }
  const shorter = { id: 'r', data: { findings: [{ id: 'a', description: 'right' }, [{ id: 'b', description: 'right' }]] } }
  for (const workspace of [[shifted], [renamed], [shorter], [{ id: 'other', data: whole.data }]]) {
    state.reports = ingested()
    awaitManagedDetails('team', Promise.resolve(workspace), () => {})
    await settle()
    assert.deepEqual(state.reports[0].groups.flat().map(f => f.description), [undefined, 'B', undefined])
    assert.equal(managedDetailsWaiting(), 'failed')
    assert.equal(await managedDetailsReady(), false)
  }
  assert.deepEqual([workspaces, clearedMerges, toasts.length], [[], 0, 4])
})

test('details that fail leave the board as it is, telling so; ones answered once other reports are loaded fill nothing', async () => {
  const loaded = []
  awaitManagedDetails('team', Promise.resolve(null), () => loaded.push(true))
  await settle()
  assert.deepEqual([loaded, toasts.length, managedDetailsWaiting()], [[true], 1, 'failed'])
  assert.equal(await managedDetailsReady(), false, 'an export does not take the board\'s copy for the details')
  const request = Promise.withResolvers()
  awaitManagedDetails('team', request.promise, () => assert.fail('another view'))
  state.reports = ingested()
  assert.equal(managedDetailsWaiting(), null, 'other reports loaded wait for nothing of these')
  assert.equal(await managedDetailsReady(), true)
  request.resolve([whole])
  await settle()
  assert.equal(Object.hasOwn(state.reports[0].groups[0][0], 'evidence'), false)
  assert.deepEqual(workspaces, [])
})
