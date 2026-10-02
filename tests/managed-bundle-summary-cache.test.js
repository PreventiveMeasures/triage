import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Readable } from 'node:stream'
import { setImmediate } from 'node:timers/promises'
import { CacheMissError } from '../server-managed/cache-storage.ts'
import { bundleSummaries } from '../server-managed/bundle-catalog.ts'
import { SUMMARY_FILENAME, createBundleSummaryCache } from '../server-managed/bundle-summary-cache.ts'

function fixture() {
  const files = new Map()
  const storage = {
    exists: (id, file) => Promise.resolve(files.has(`${id}/${file}`)),
    put: (id, file, value) => { files.set(`${id}/${file}`, value); return Promise.resolve() },
    open: (id, file) => files.has(`${id}/${file}`) ? Promise.resolve({ stream: Readable.from([files.get(`${id}/${file}`)]) }) : Promise.reject(new CacheMissError()),
    delete: id => { files.delete(`${id}/${SUMMARY_FILENAME}`); return Promise.resolve() },
  }
  const records = Array.from({ length: 10 }, (_, n) => ({ id: String(n), integrity: `hash-${n}`, kind: 'sourcemap' }))
  return { storage, records, files }
}

test('catalog reads never build; backfill has one bounded batch and resumes remaining hashes later', async () => {
  const { storage, records } = fixture()
  let builds = 0
  const gate = Promise.withResolvers(), started = Promise.withResolvers()
  const cache = createBundleSummaryCache(storage, async () => {
    builds++; started.resolve(); await gate.promise
    return { files: 1, codeFiles: 1, lines: 2 }
  }, () => Promise.resolve(true))
  for (const record of records) assert.equal(await cache.summary(record), null)
  assert.equal(builds, 0)
  const pending = cache.backfill(records)
  await started.promise
  await cache.backfill(records)
  assert.equal(builds, 1, 'another catalog cannot queue a duplicate batch')
  gate.resolve()
  await pending
  assert.equal(builds, 4)
  assert.equal(await cache.summary(records[4]), null)
  await cache.backfill(records)
  assert.equal(builds, 8)
})

test('failed summaries persist backoff across cold starts and retry after the delay', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000 })
  const { storage, records } = fixture()
  let builds = 0
  const build = () => { builds++; return Promise.reject(new Error('malformed bundle')) }
  const exists = () => Promise.resolve(true)
  const cache = createBundleSummaryCache(storage, build, exists)
  await cache.backfill([records[0]])
  assert.equal(builds, 1)
  assert.equal(await cache.summary(records[0]), null)
  assert.deepEqual(await cache.summaryStatus(records[0]), { summary: null, summaryRetryAt: 301_000 })
  const cold = createBundleSummaryCache(storage, build, exists)
  assert.deepEqual(await cold.summaryStatus(records[0]), { summary: null, summaryRetryAt: 301_000 })
  await cold.backfill([records[0]])
  assert.equal(builds, 1, 'malformed bytes are not parsed on the next request or cold start')
  t.mock.timers.tick(5 * 60_000)
  await cold.backfill([records[0]])
  assert.equal(builds, 2, 'a temporary storage failure can recover after backoff')
})

test('deleting a bundle during backfill cannot republish its summary or a failure marker', async () => {
  for (const fail of [false, true]) {
    const { storage, records, files } = fixture()
    const gate = Promise.withResolvers(), started = Promise.withResolvers()
    let exists = true
    const cache = createBundleSummaryCache(storage, async () => {
      started.resolve(); await gate.promise
      if (fail) throw new Error('malformed bundle')
      return { files: 1, codeFiles: 1, lines: 2 }
    }, () => Promise.resolve(exists))
    const pending = cache.backfill([records[0]])
    await started.promise
    exists = false
    const removal = cache.forget(records[0].id)
    gate.resolve()
    await Promise.all([pending, removal])
    assert.equal(files.size, 0)
    assert.equal(await cache.summary(records[0]), null)
  }
})

test('forget waits only for the named bundle, never a later bundle in the same batch', async () => {
  const { storage, records } = fixture()
  const first = Promise.withResolvers(), second = Promise.withResolvers()
  const startedFirst = Promise.withResolvers(), startedSecond = Promise.withResolvers()
  const cache = createBundleSummaryCache(storage, async record => {
    if (record.id === records[0].id) { startedFirst.resolve(); await first.promise }
    else { startedSecond.resolve(); await second.promise }
    return { files: 1, codeFiles: 1, lines: 2 }
  }, () => Promise.resolve(true))
  const pending = cache.backfill(records.slice(0, 2))
  let completed = false
  try {
    await startedFirst.promise
    const removal = cache.forget(records[0].id).then(() => { completed = true; return true })
    await setImmediate()
    assert.equal(completed, false, 'the matching active build must finish before cache removal')
    first.resolve()
    await startedSecond.promise
    await setImmediate()
    assert.equal(completed, true, 'a stalled later build cannot hold up removal')
    await removal
  } finally { first.resolve(); second.resolve(); await pending }
})

test('summary scans avoid HEADs and retain hits when the catalog exceeds the cache', async () => {
  let reads = 0
  const storage = { exists() { assert.fail('summary reads must not HEAD') },
    open() { reads++; return Promise.resolve({ stream: Readable.from(['{"files":1,"codeFiles":1,"lines":2}']) }) } }
  const cache = createBundleSummaryCache(storage, () => { assert.fail('ready summaries must not build') }, () => Promise.resolve(true))
  const records = Array.from({ length: 4100 }, (_, i) => ({ id: String(i), integrity: String(i), kind: 'stasis' }))
  await bundleSummaries(records.slice(0, 300), cache)
  reads = 0
  await bundleSummaries(records.slice(0, 300), cache)
  assert.equal(reads, 0, '300 bundles remain warm')
  await bundleSummaries(records, cache)
  reads = 0
  await bundleSummaries(records, cache)
  assert.equal(reads, 4, 'overflow scans cannot evict the next cached entry')
})

test('summary reads distinguish missing data from storage outages', async () => {
  const record = { id: 'id', integrity: 'hash', kind: 'stasis' }
  for (const error of [new CacheMissError(), new Error('storage unavailable')]) {
    const cache = createBundleSummaryCache({ open: () => Promise.reject(error) }, () => assert.fail('unexpected build'), () => Promise.resolve(true))
    if (error instanceof CacheMissError) assert.equal(await cache.summary(record), null)
    else await assert.rejects(cache.summary(record), /storage unavailable/u)
  }
})
