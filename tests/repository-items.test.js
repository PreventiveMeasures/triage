import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { autorun } from '@rray/frontend/state-management'

const state = { managedSession: { id: 's-1', role: 'admin' } }
mock.module('../client/index.js', { exports: { state } })
const { knowItems, knownChanges, knownItem, knownItems, readAtOf } = await import('../ui/view/repository-items.js')

const pull = (number, more = {}) => ({ number, title: `Pull ${number}`, state: 'open', updatedAt: 1, ...more })

test('an issue or pull request is known as the server read it latest: a read older than the one known is none, another repository\'s apart', () => {
  knowItems(7, [pull(5), pull(6)], 1000, 'pulls')
  knowItems(7, [{ ...pull(5, { state: 'merged' }), kind: 'pulls' }], 2000)
  assert.deepEqual(knownItem(7, 5), { item: { ...pull(5, { state: 'merged' }), kind: 'pulls' }, readAt: 2000 }, 'its popup\'s read, later than its list\'s')
  knowItems(7, [pull(5), pull(6, { title: 'Renamed' })], 1500, 'pulls')
  assert.equal(knownItem(7, 5).item.state, 'merged', 'a list kept on the server from before, no news of it')
  assert.equal(knownItem(7, 6).item.title, 'Renamed', 'but of one read before')
  knowItems(8, [{ number: 5, title: 'An issue', state: 'open', kind: 'issues' }], 500)
  assert.deepEqual(knownItems(7, 'pulls').map(({ item }) => [item.number, item.state]), [[5, 'merged'], [6, 'open']])
  assert.deepEqual(knownItems(8, 'issues').map(({ item }) => item.title), ['An issue'])
  assert.deepEqual(knownItems(8, 'pulls'), [])
  assert.equal(knownItem(9, 5), null)
})

test('what reads them is told of each change, one replaced among those it iterates too; another session forgets them', () => {
  const told = []
  const stop = autorun(() => { told.push(knownItems(7, 'pulls').map(({ item }) => item.state).join()) })
  const changes = knownChanges()
  knowItems(7, [pull(6, { state: 'closed' })], 3000, 'pulls')
  assert.equal(told.at(-1), 'merged,closed')
  knowItems(7, [pull(6)], 10, 'pulls')
  assert.equal(knownChanges(), changes + 1, 'none older told')
  stop()
  state.managedSession = { id: 's-2', role: 'admin' }
  assert.equal(knownItem(7, 5), null, 'another session\'s')
  knowItems(7, [pull(1)], 1, 'pulls')
  assert.deepEqual(knownItems(7, 'pulls').map(({ item }) => item.number), [1])
  assert.equal(readAtOf({ readAt: 42 }), 42)
  for (const answer of [{}, { readAt: 'soon' }, { readAt: -1 }, null]) assert.ok(Math.abs(readAtOf(answer) - Date.now()) < 1000, 'answered now, where the server says not when')
})
