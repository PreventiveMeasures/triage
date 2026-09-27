import assert from 'node:assert/strict'
import { beforeEach, mock, test } from 'node:test'

const calls = []
let fetchResponse, preview
mock.module('../client/managed/request.js', { namedExports: {
  getPreviewRole: () => preview,
  managedFetch: (url, options) => { calls.push({ url, ...options }); return fetchResponse(options.signal) },
} })
const { watchTeamFeed } = await import('../client/managed/team-feed.js')
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise(resolve => { setImmediate(resolve) }) }
const encoder = new TextEncoder()
function response(signal, chunks, { hold = false } = {}) {
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      if (hold) signal.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')), { once: true })
      else controller.close()
    },
  }), { headers: { 'content-type': 'text/event-stream; charset=utf-8' } })
}
beforeEach(() => {
  mock.timers.reset()
  mock.timers.enable({ apis: ['setTimeout'] })
  calls.length = 0
  preview = null
})

test('feed parses split SSE frames, uses a same-origin GET, and handles terminal close', async () => {
  fetchResponse = signal => response(signal, ['event: tri', 'age\r', '\ndata: {}\r\n\r\n: beat\n\nevent: close\ndata: {}\n\n'])
  let closed = 0, updates = 0
  await watchTeamFeed('a/b', { signal: new AbortController().signal, onUpdate: () => { updates++ }, onClose: () => { closed++ } })
  assert.equal(updates, 1)
  assert.equal(closed, 1)
  assert.equal(calls[0].url, '/api/teams/a%2Fb/feed')
  assert.equal(calls[0].credentials, 'same-origin')
  assert.equal(calls[0].headers.accept, 'text/event-stream')
  assert.equal(calls[0].signal.aborted, true)
})

test('bounded stream EOF reconnects and refreshes again, then navigation cancels it', async () => {
  fetchResponse = signal => response(signal, ['event: triage\ndata: {}\n\n'], { hold: calls.length > 1 })
  const controller = new AbortController()
  let updates = 0
  const done = watchTeamFeed('team', { signal: controller.signal, onUpdate: () => { updates++ }, onClose() {} })
  await settle()
  assert.equal(updates, 1)
  mock.timers.tick(1000); await settle()
  assert.equal(updates, 2)
  controller.abort(); await done
  mock.timers.tick(100000); await settle()
  assert.equal(calls.length, 2)
  assert.ok(calls.every(call => call.signal.aborted))
})

const deniedStatuses = [401, 403, 404]
deniedStatuses.forEach(status => {
  test(`HTTP ${status} terminates the subscription without retrying`, async () => {
    fetchResponse = () => Promise.resolve(new Response('', { status }))
    let closed = 0
    await watchTeamFeed('team', { signal: new AbortController().signal, onUpdate() { assert.fail() }, onClose() { closed++ } })
    mock.timers.tick(100000); await settle()
    assert.equal(closed, 1)
    assert.equal(calls.length, 1)
  })
})

test('proxy failures and missed heartbeats retry with bounded backoff', async () => {
  fetchResponse = signal => calls.length === 1 ? Promise.resolve(new Response('', { status: 503 })) : response(signal, [], { hold: true })
  const controller = new AbortController()
  const done = watchTeamFeed('team', { signal: controller.signal, onUpdate() {}, onClose() {} })
  await settle()
  mock.timers.tick(1000); await settle()
  assert.equal(calls.length, 2)
  mock.timers.tick(45000); await settle()
  assert.equal(calls[1].signal.aborted, true)
  mock.timers.tick(2000); await settle()
  assert.equal(calls.length, 3)
  controller.abort(); await done
})

test('failed annotation refreshes are retried, and preview never opens a real feed', async () => {
  fetchResponse = signal => response(signal, ['event: triage\ndata: {}\n\n'], { hold: true })
  const controller = new AbortController()
  let updates = 0
  const done = watchTeamFeed('team', { signal: controller.signal, onUpdate() { updates++; return false }, onClose() {} })
  await settle()
  mock.timers.tick(1000); await settle()
  assert.equal(updates, 2)
  controller.abort(); await done
  preview = 'admin'
  await watchTeamFeed('team', { signal: new AbortController().signal, onUpdate() { assert.fail() }, onClose() {} })
  assert.equal(calls.length, 2)
})


test('catalog-only subscriptions dispatch teams before triage and retry failed catalog refreshes', async () => {
  fetchResponse = signal => response(signal, ['event: teams\ndata: {}\n\nevent: triage\ndata: {}\n\n'], { hold: true })
  const controller = new AbortController(), events = []
  const done = watchTeamFeed(null, { signal: controller.signal,
    onTeams: () => { events.push('teams'); return events.length > 1 },
    onUpdate: () => { events.push('triage') }, onClose() {},
  })
  await settle()
  assert.equal(calls[0].url, '/api/teams/feed')
  assert.deepEqual(events, ['teams'], 'failed catalog refresh does not consume the next event')
  mock.timers.tick(1000); await settle()
  assert.deepEqual(events, ['teams', 'teams', 'triage'])
  controller.abort(); await done
})

test('catalog events pass their opaque revisions through split frames; legacy and malformed data invalidate normally', async () => {
  fetchResponse = signal => response(signal, [
    'event: teams\ndata: {"revision":', '"first"}\n\nevent: teams\ndata: {"revision":"next"}\n\n',
    'event: teams\ndata: {}\n\nevent: teams\ndata: malformed\n\nevent: teams\ndata: {"revision":1}\n\n',
    'event: close\ndata: {}\n\n',
  ])
  const revisions = []
  await watchTeamFeed(null, { signal: new AbortController().signal,
    onTeams(signal, revision) { assert.equal(signal, calls[0].signal); revisions.push(revision) },
    onUpdate() { assert.fail() }, onClose() {},
  })
  assert.deepEqual(revisions, ['first', 'next', null, null, null])
})

const stalledEvents = ['teams', 'triage']
stalledEvents.forEach(stalled => {
  test(`the watchdog cancels a stalled ${stalled} refresh and reconnects without navigation`, async t => {
    fetchResponse = signal => response(signal, ['event: teams\ndata: {}\n\nevent: triage\ndata: {}\n\n'], { hold: true })
    const controller = new AbortController(), events = [], signals = []
    const refresh = (event, signal = controller.signal) => {
      events.push(`${calls.length}:${event}`)
      signals.push(signal)
      if (calls.length > 1 || event !== stalled) return true
      // Even a callback that reports success after cancellation must not allow
      // buffered events from the timed-out connection to continue processing.
      return new Promise(resolve => { signal.addEventListener('abort', () => resolve(true), { once: true }) })
    }
    const done = watchTeamFeed('team', { signal: controller.signal,
      onTeams: signal => refresh('teams', signal), onUpdate: signal => refresh('triage', signal),
      onClose() { assert.fail('a watchdog timeout must reconnect, not revoke access') },
    })
    t.after(async () => { controller.abort(); await done })
    await settle()
    const initial = stalled === 'teams' ? ['1:teams'] : ['1:teams', '1:triage']
    assert.deepEqual(events, initial)
    mock.timers.tick(45000); await settle()
    assert.equal(signals[0].aborted, true, 'watchdog cancellation reaches the refresh')
    assert.equal(controller.signal.aborted, false, 'the view remains subscribed')
    assert.deepEqual(events, initial, 'do not process buffered frames after the timeout')
    mock.timers.tick(1000); await settle()
    assert.equal(calls.length, 2)
    assert.deepEqual(events, [...initial, '2:teams', '2:triage'])
    assert.equal(signals.at(-1), calls[1].signal)
    assert.equal(signals.at(-1).aborted, false)
  })
})
