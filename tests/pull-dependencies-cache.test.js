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
  fetchPullDependenciesOf(repoId, numbers) {
    asked.push(numbers)
    return new Promise((resolve, reject) => { pending.push({ resolve: answers => resolve(new Map(numbers.map(number => [number, answers[number]]))), reject }) })
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
  assert.deepEqual(asked, [1, 2, [4, 3]], 'the one asked of a page\'s way first, with the one moved before the background\'s')
  assert.deepEqual(told, [{ repoId: 1, number: 1 }, { repoId: 1, number: 2 }])
  unsubscribe()
  for (const read of pending.splice(0)) read.resolve(answer('c'))
  await setImmediate()
})

test('those of a repository waiting for a turn are read together as it comes, five at most, another\'s or another review\'s apart', async () => {
  asked.length = 0
  for (const number of [1, 2, 3, 4, 5, 6, 7, 8]) pullDependencies(5, number, true)
  pullDependencies(6, 1, true)
  pullDependencies(5, 9, false)
  pullDependencies(5, 10, true, { listed: true })
  assert.deepEqual(asked, [1, 2], 'those first asked read at once')
  pending.shift().resolve(answer('a'))
  await setImmediate()
  assert.deepEqual(asked.at(-1), [3, 4, 5, 6, 7], 'the next five together')
  const together = pending.at(-1)
  pending.shift().resolve(answer('b'))
  await setImmediate()
  assert.equal(asked.at(-1), 8, 'the last of them')
  together.resolve(Object.fromEntries([3, 4, 5, 6, 7].map(number => [number, answer(`p${number}`)])))
  await setImmediate()
  pending.splice(pending.indexOf(together), 1)
  pending.shift().resolve(answer('p8'))
  await setImmediate()
  assert.deepEqual(asked.slice(-2), [1, 9], 'another repository\'s, and another review\'s, each its own')
  pending.shift().resolve(answer('d'))
  await setImmediate()
  assert.equal(asked.at(-1), 10, 'one asked as a tile, by its page\'s commits, its own')
  pending.shift().resolve(answer('e'))
  pending.shift().resolve(answer('tile'))
  await setImmediate()
  assert.equal(pullDependencies(5, 10, true, { listed: true }).status, 'ready')
  pullDependencies(5, 10, true)
  assert.equal(asked.at(-1), 10, 'held apart from one asked as its popup asks, which reads its own')
  assert.equal(asked.length, 8)
  assert.deepEqual(addedVersions(pullDependencies(5, 6, true)).versions.map(pkg => pkg.name), ['p6'])
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

test('those of a repository asked in the background are read together once a turn comes, twenty at most, each told its own answer or failure', async () => {
  asked.length = 0
  pullDependencies(3, 1, true)
  pullDependencies(3, 2, true)
  const numbers = Array.from({ length: 23 }, (_, at) => 10 + at)
  for (const number of numbers) pullDependencies(3, number, true, { background: true })
  pullDependencies(4, 1, true, { background: true })
  assert.deepEqual(asked, [1, 2], 'every turn taken')
  pending.shift().resolve(answer('a'))
  await setImmediate()
  assert.deepEqual(asked.at(-1), numbers.slice(0, 20), 'the repository\'s twenty waiting, together')
  const together = pending.at(-1)
  pending.shift().resolve(answer('b'))
  await setImmediate()
  assert.deepEqual(asked.at(-1), numbers.slice(20), 'the rest of them, together, before another repository\'s')
  together.resolve({ ...Object.fromEntries(numbers.slice(0, 19).map(number => [number, answer(`p${number}`)])), [numbers[19]]: new Error('GitHub has no pull request of that number here.') })
  await setImmediate()
  assert.deepEqual(addedVersions(pullDependencies(3, 10, true)).versions.map(pkg => pkg.name), ['p10'])
  assert.deepEqual([pullDependencies(3, 29, true).status, pullDependencies(3, 29, true).error], ['error', 'GitHub has no pull request of that number here.'])
  for (const read of pending.splice(0)) read.resolve({})
  await setImmediate()
  for (const read of pending.splice(0)) read.resolve(answer('c'))
  await setImmediate()
})

test('a version two directories lock patched alike is told with the patch of one whose lockfile names its file, as only that can be reviewed', () => {
  const hash = 'a'.repeat(64), named = { hash, path: 'patches/pat@1.0.0.patch' }
  const pat = (patch, more = {}) => ({ name: 'pat', version: '1.0.0', source: 'registry', reviews: 0, patch, ...more })
  const ready = { cut: false, review: { required: 1 }, lockfiles: [{ paths: ['a/pnpm-lock.yaml'], added: [pat({ hash })], unreviewed: [pat({ hash }, { name: 'old' })] },
    { paths: ['b/pnpm-lock.yaml'], added: [pat(named, { was: ['0.9.0'] })], unreviewed: [pat(named, { name: 'old' })] },
    { paths: ['c/pnpm-lock.yaml'], added: [pat({ hash, path: 'other.patch' })], unreviewed: [pat({ hash, path: 'other.patch' }, { name: 'old' })] }] }
  assert.deepEqual(addedVersions(ready).versions.map(({ name, patch, was }) => ({ name, patch, was })), [{ name: 'pat', patch: named, was: ['0.9.0'] }])
  assert.deepEqual(unreviewedVersions(ready).versions.map(({ name, patch }) => ({ name, patch })), [{ name: 'old', patch: named }])
})
