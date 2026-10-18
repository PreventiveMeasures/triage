// What a pull request's lockfiles add, as the client holds it
// (ui/view/pull-dependencies.js): those a page asks of in the background read
// after those asked otherwise, one asked of meanwhile moved before them; each
// listener told which pull request was read; one grown old shown as it was
// while it is read again; and each answer's versions worked out once.
import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { setImmediate } from 'node:timers/promises'

const state = { managedSession: { id: 's', role: 'triage' } }
const asked = []
const pending = []
mock.module('../client/index.js', { exports: { state } })
mock.module('../ui/view/client-managed.js', { exports: {
  fetchPullDependencies(repoId, number) {
    asked.push(number)
    return new Promise((resolve, reject) => { pending.push({ resolve, reject }) })
  },
} })
const { addedVersions, pullDependencies, reviewFailures, subscribePullDependencies, unreviewedVersions } = await import('../ui/view/pull-dependencies.js')

const answer = name => ({ cut: false, lockfiles: [{ paths: ['package-lock.json'], added: [{ name, version: '1.0.0' }], unreviewed: [{ name: 'old', version: '1.0.0' }] }],
  review: { required: 1 } })

test('those asked in the background are read after the rest, one asked of meanwhile moved before them; each listener told which was read', async () => {
  const told = []
  const unsubscribe = subscribePullDependencies(pull => told.push(pull))
  for (const number of [1, 2, 3]) pullDependencies(1, number, true, { background: true })
  pullDependencies(1, 4, true)
  pullDependencies(1, 3, true)
  assert.deepEqual(asked, [1, 2], 'two at a time')
  pending[0].resolve(answer('a'))
  await setImmediate()
  pending[1].resolve(answer('b'))
  await setImmediate()
  assert.deepEqual(asked, [1, 2, 4, 3], 'the one asked of a page\'s way first, then the one moved before the background\'s')
  assert.deepEqual(told, [{ repoId: 1, number: 1 }, { repoId: 1, number: 2 }])
  unsubscribe()
  for (const read of pending.splice(0)) read.resolve(answer('c'))
  await setImmediate()
})

test('one grown old is shown as it was while read again, its versions worked out once; one whose read is called off kept as it was', async () => {
  mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
  try {
    asked.length = 0
    pullDependencies(2, 1, true)
    pending.shift().resolve(answer('a'))
    await setImmediate()
    const ready = pullDependencies(2, 1, true)
    assert.equal(ready.status, 'ready')
    const versions = addedVersions(ready)
    assert.equal(addedVersions(ready), versions, 'worked out once')
    assert.equal(unreviewedVersions(ready), unreviewedVersions(ready))
    assert.equal(reviewFailures(ready), null)

    mock.timers.setTime(1_000_000 + 5 * 60_000 + 1)
    const old = pullDependencies(2, 1, true)
    assert.deepEqual([old.status, old.refreshing, old.lockfiles === ready.lockfiles], ['ready', true, true], 'shown as it was while read again')
    assert.equal(addedVersions(old), versions, 'its versions as worked out before')
    assert.deepEqual(asked, [1, 1])
    pending.shift().reject(Object.assign(new Error('gone'), { name: 'AbortError' }))
    await setImmediate()
    assert.equal(pullDependencies(2, 1, true).refreshing, true, 'kept as it was, and read again')
    pending.shift().resolve(answer('b'))
    await setImmediate()
    const fresh = pullDependencies(2, 1, true)
    assert.deepEqual([fresh.refreshing, addedVersions(fresh).versions.map(pkg => pkg.name)], [undefined, ['b']])
  } finally {
    mock.timers.reset()
  }
})
