import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { bundleSummaries } from '../server-managed/bundle-catalog.ts'

test('large catalogs bound summary reads, deduplicate hashes, and continue after storage failures', async () => {
  const bundles = Array.from({ length: 1_000 }, (_, id) => ({ id, integrity: `hash-${id}` }))
  const gate = Promise.withResolvers(), started = []
  let active = 0, peak = 0
  const unknown = { summary: null, summaryRetryAt: null }
  const status = id => id % 4 === 0 ? unknown : id % 4 === 1
    ? { summary: null, summaryRetryAt: 301_000 }
    : { summary: { files: id, codeFiles: id, lines: id * 10 }, summaryRetryAt: null }
  const cache = {
    async summaryStatus({ id }) {
      started.push(id)
      peak = Math.max(peak, ++active)
      try {
        await gate.promise
        await setImmediate()
        if (id % 4 === 3) throw new Error('storage unavailable')
        return status(id)
      } finally { active-- }
    },
  }
  const pending = bundleSummaries([...bundles, ...bundles], cache)
  try {
    await setImmediate()
    assert.equal(started.length, 8, 'only one bounded group starts while storage is blocked')
  } finally { gate.resolve() }
  const summaries = await pending
  assert.equal(peak, 8, 'later reads obey the same concurrency bound')
  assert.equal(started.length, bundles.length, 'shared hashes are read once')
  assert.equal(new Set(started).size, bundles.length, 'all unique bundles are processed')
  assert.equal(summaries.size, bundles.length)
  for (const bundle of bundles) {
    assert.deepEqual(summaries.get(bundle.integrity), bundle.id % 4 === 3 ? unknown : status(bundle.id))
  }
})
