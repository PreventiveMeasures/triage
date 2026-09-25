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
  setCount: (name, count, source) => kinds.set(name, { count, source }),
  analyzeContent: () => ({ count: 0 }),
} })
const { duplicatesOf, ensureKnownLinkedFindingsIndexed, ensureLinkedFindingsIndexed, isLinkedFindingsIndexReady, subscribeToLinkedFindings } = await import('../client/linked-findings-index.js')
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

it('verifies unclassified files and cached reports once, including reports with no source marker', async () => {
  add('unknown.json', content([a, b]))
  add('legacy-report.json', '{"findings":[]}')
  kinds.set('legacy-report.json', { count: 0 })
  const reads = []
  read = (name) => { reads.push(name); return Promise.resolve(files.get(name)) }
  await ensureLinkedFindingsIndexed()
  assert.equal(isLinkedFindingsIndexReady(), true)
  assert.deepEqual(reads, ['unknown.json', 'legacy-report.json'])
  assert.deepEqual(duplicatesOf(a), [b])
  await ensureLinkedFindingsIndexed()
  assert.deepEqual(reads, ['unknown.json', 'legacy-report.json'], 'repeat walks reuse verified classifications')
})

it('publishes known links before a slow unrelated report and keeps full readiness separate', async () => {
  add('large-report.json', '{"findings":[]}', 'deepsec')
  add('last-links.json', content([a, b]), 'links')
  const release = Promise.withResolvers(), started = Promise.withResolvers()
  const reads = [], snapshots = []
  read = async (name) => {
    reads.push(name)
    if (name === 'large-report.json') { started.resolve(); await release.promise }
    return files.get(name)
  }
  const unsubscribe = subscribeToLinkedFindings(() => snapshots.push({ ready: isLinkedFindingsIndexReady(), duplicates: duplicatesOf(a) }))
  const walk = ensureLinkedFindingsIndexed()
  try {
    await started.promise
    assert.deepEqual(reads, ['last-links.json', 'large-report.json'])
    assert.deepEqual(duplicatesOf(a), [b], 'finding groups can use verified links while unrelated reports still load')
    assert.equal(isLinkedFindingsIndexReady(), false, 'partial links cannot validate cached App counts')
    assert.ok(snapshots.some((s) => !s.ready && s.duplicates.includes(b)))
    await ensureKnownLinkedFindingsIndexed()
    assert.deepEqual(reads, ['last-links.json', 'large-report.json'], 'initial-view preparation neither waits for nor duplicates the background read')
  } finally { release.resolve(); await walk; unsubscribe() }
  assert.equal(isLinkedFindingsIndexReady(), true)
})

it('shares concurrent known-link loads and reads all known link files together', async () => {
  add('first-links.json', content([a, b]), 'links')
  add('second-links.json', content([b, c]), 'links')
  const release = Promise.withResolvers(), started = Promise.withResolvers()
  const reads = []
  read = async (name) => {
    reads.push(name)
    if (reads.length === 2) started.resolve()
    await release.promise
    return files.get(name)
  }
  const known = ensureKnownLinkedFindingsIndexed()
  assert.equal(ensureKnownLinkedFindingsIndexed(), known)
  try {
    await started.promise
    assert.deepEqual(reads, ['first-links.json', 'second-links.json'])
    assert.deepEqual(duplicatesOf(b), [], 'do not expose only half of the known links batch')
  } finally { release.resolve(); await known }
  assert.deepEqual(duplicatesOf(b).toSorted(), [a, c].toSorted())
  assert.equal(isLinkedFindingsIndexReady(), false)
})

it('does not reuse stale links when a cached Link file now contains an ordinary report', async () => {
  add('former-links.json', '{"findings":[]}', 'links')
  await ensureKnownLinkedFindingsIndexed()
  assert.deepEqual(duplicatesOf(a), [])
  assert.equal(kinds.get('former-links.json').source, undefined)
  assert.equal(isLinkedFindingsIndexReady(), false)
})

async function checkFailedRead(source) {
  add('locked.json', content([a, b]), source)
  read = () => Promise.reject(new Error('vault locked'))
  await ensureLinkedFindingsIndexed()
  assert.equal(isLinkedFindingsIndexReady(), false)
  assert.deepEqual(duplicatesOf(a), [])
  read = (name) => Promise.resolve(files.get(name))
  await ensureLinkedFindingsIndexed()
  assert.equal(isLinkedFindingsIndexReady(), true)
  assert.deepEqual(duplicatesOf(a), [b])
}
for (const source of ['links', 'deepsec']) {
  it(`does not trust a cached ${source} classification after a failed read`, () => checkFailedRead(source))
}

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
