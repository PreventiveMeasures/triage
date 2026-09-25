import assert from 'node:assert/strict'
import { beforeEach, it, mock } from 'node:test'

const files = new Map(), kinds = new Map()
let list, mutation, read
mock.module('../client/storage.js', { namedExports: {
  listFiles: () => list(),
  readFile: (name) => read(name),
  onFileMutated: (cb) => { mutation = cb },
} })
mock.module('../client/counts.js', { namedExports: {
  getKind: (name) => kinds.get(name)?.source,
  getCount: (name) => kinds.get(name)?.count,
} })
const { duplicatesOf, ensureLinkedFindingsIndexed, isLinkedFindingsIndexReady, subscribeToLinkedFindings } = await import('../client/linked-findings-index.js')
const [a, b, c] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()]
const content = (ids) => JSON.stringify([ids.map((id) => ({ id }))])

beforeEach(async () => {
  for (const name of files.keys()) mutation(name)
  files.clear(); kinds.clear()
  list = () => Promise.resolve([...files.keys()])
  read = (name) => Promise.resolve(files.get(name))
  await ensureLinkedFindingsIndexed()
})

function add(name, value, kind) {
  files.set(name, value)
  if (kind) kinds.set(name, { count: 1, source: kind })
  mutation(name)
}

it('notifies when an empty walk becomes ready without notifying on unchanged repeat walks', async () => {
  mutation('deleted.json')
  assert.equal(isLinkedFindingsIndexReady(), false)
  const states = []
  const unsubscribe = subscribeToLinkedFindings(() => states.push(isLinkedFindingsIndexReady()))
  try {
    await ensureLinkedFindingsIndexed()
    assert.equal(isLinkedFindingsIndexReady(), true)
    assert.deepEqual(states, [true])
    await ensureLinkedFindingsIndexed()
    assert.deepEqual(states, [true])
  } finally { unsubscribe() }
})

it('waits for unknown files but accepts counted reports that have no source marker', async () => {
  add('unknown.json', content([a, b]))
  add('legacy-report.json', '{"findings":[]}')
  kinds.set('legacy-report.json', { count: 0 })
  const reads = []
  read = (name) => { reads.push(name); return Promise.resolve(files.get(name)) }
  await ensureLinkedFindingsIndexed()
  assert.equal(isLinkedFindingsIndexReady(), false)
  assert.deepEqual(reads, [], 'unclassified files and counted ordinary reports are not read by this index')
  kinds.set('unknown.json', { count: 2, source: 'links' })
  await ensureLinkedFindingsIndexed()
  assert.equal(isLinkedFindingsIndexReady(), true)
  assert.deepEqual(reads, ['unknown.json'])
  assert.deepEqual(duplicatesOf(a), [b])
})

it('does not become ready after a failed links read, and recovers on a later walk', async () => {
  add('locked.json', content([a, b]), 'links')
  read = () => Promise.reject(new Error('vault locked'))
  await ensureLinkedFindingsIndexed()
  assert.equal(isLinkedFindingsIndexReady(), false)
  assert.deepEqual(duplicatesOf(a), [])
  read = (name) => Promise.resolve(files.get(name))
  await ensureLinkedFindingsIndexed()
  assert.equal(isLinkedFindingsIndexReady(), true)
  assert.deepEqual(duplicatesOf(a), [b])
})

it('withholds readiness during a new links read and retries a mutation made in flight', async () => {
  // A sibling write can first become visible through the listing, without a
  // same-tab mutation callback. Readiness must drop before awaiting its bytes.
  files.set('new-links.json', content([a, b]))
  kinds.set('new-links.json', { count: 2, source: 'links' })
  const release = Promise.withResolvers(), started = Promise.withResolvers()
  let calls = 0
  read = async (name) => {
    const bytes = files.get(name)
    if (++calls === 1) { started.resolve(); await release.promise }
    return bytes
  }
  const walk = ensureLinkedFindingsIndexed()
  try {
    await started.promise
    assert.equal(isLinkedFindingsIndexReady(), false)
    files.set('new-links.json', content([a, c]))
    mutation('new-links.json')
  } finally { release.resolve(); await walk }
  assert.equal(isLinkedFindingsIndexReady(), true)
  assert.deepEqual(duplicatesOf(a), [c])
  assert.deepEqual(duplicatesOf(b), [])
})

it('drops readiness if the file listing fails and recovers when it can be read', async () => {
  assert.equal(isLinkedFindingsIndexReady(), true)
  list = () => Promise.reject(new Error('storage unavailable'))
  await assert.rejects(ensureLinkedFindingsIndexed(), /storage unavailable/u)
  assert.equal(isLinkedFindingsIndexReady(), false)
  list = () => Promise.resolve([])
  await ensureLinkedFindingsIndexed()
  assert.equal(isLinkedFindingsIndexReady(), true)
})
