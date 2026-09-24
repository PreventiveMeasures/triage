import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createSyncSuggester } from '../ui/view/sync-suggest.js'

// Deterministic scheduler: queued callbacks run on `flush()`.
function harness(results) {
  const queue = []
  const opened = []
  const later = (fn, ms) => { queue.push({ fn, ms }) }
  const open = (names) => { opened.push(names); return Promise.resolve(results.shift() ?? { shown: true, sync: false }) }
  const flush = async () => {
    while (queue.length > 0) await queue.shift().fn()
  }
  return { queue, opened, flush, suggester: createSyncSuggester({ open, later }) }
}

describe('sync suggestion (auto-opened "Reports out of sync")', () => {
  it('opens for a workspace with differing reports, off the render path', async () => {
    const h = harness([{ shown: true, sync: false }])
    h.suggester.suggestSync('ws1', ['a.json'])
    assert.equal(h.opened.length, 0, 'deferred, not opened inside the render call')
    await h.flush()
    assert.deepEqual(h.opened, [['a.json']])
  })

  it('stays closed for that workspace once closed, until reload (a new suggester)', async () => {
    const h = harness([{ shown: true, sync: false }])
    h.suggester.suggestSync('ws1', ['a.json'])
    await h.flush()
    h.suggester.suggestSync('ws1', ['a.json', 'b.json'])
    await h.flush()
    assert.equal(h.opened.length, 1, 'not re-opened after being closed')
    assert.equal(h.suggester.isClosedFor('ws1'), true)
    // Per workspace: another one still gets its suggestion.
    h.suggester.suggestSync('ws2', ['c.json'])
    await h.flush()
    assert.deepEqual(h.opened.at(-1), ['c.json'])
    // Memory only: a reload builds a fresh suggester with nothing closed.
    assert.equal(harness([]).suggester.isClosedFor('ws1'), false)
  })

  it('"Sync" closes it too and hands over to the re-check', async () => {
    const h = harness([{ shown: true, sync: true }])
    let synced = 0
    h.suggester.suggestSync('ws1', ['a.json'], { onSync: () => { synced += 1 } })
    await h.flush()
    assert.equal(synced, 1)
    h.suggester.suggestSync('ws1', ['a.json'], { onSync: () => { synced += 1 } })
    await h.flush()
    assert.equal(h.opened.length, 1)
  })

  it('never opens two at once while renders keep calling', async () => {
    const h = harness([{ shown: true, sync: false }])
    h.suggester.suggestSync('ws1', ['a.json'])
    h.suggester.suggestSync('ws1', ['a.json'])
    h.suggester.suggestSync('ws2', ['b.json'])
    await h.flush()
    assert.equal(h.opened.length, 1)
  })

  it('another modal in the way: not remembered as closed, retried via a re-render', async () => {
    const h = harness([{ shown: false, sync: false }, { shown: true, sync: false }])
    let retries = 0
    const retry = () => { retries += 1; h.suggester.suggestSync('ws1', ['a.json'], { retry }) }
    h.suggester.suggestSync('ws1', ['a.json'], { retry })
    await h.queue.shift().fn()
    assert.equal(h.suggester.isClosedFor('ws1'), false)
    assert.equal(h.queue.at(-1).ms, 1500, 'retry scheduled after a short delay')
    await h.flush()
    assert.equal(retries, 1)
    assert.equal(h.opened.length, 2, 'shown on the retry')
    assert.equal(h.suggester.isClosedFor('ws1'), true)
  })

  it('does nothing without differing reports', async () => {
    const h = harness([])
    h.suggester.suggestSync('ws1', [])
    h.suggester.suggestSync('', ['a.json'])
    await h.flush()
    assert.equal(h.opened.length, 0)
  })
})
