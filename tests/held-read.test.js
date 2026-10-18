import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import { test } from 'node:test'
import { heldRead } from '../ui/view/held-read.js'

// Reads by `heldRead` over `data`, each answered as the test settles it.
function reads() {
  const asked = [], data = new Map()
  let repaints = 0
  const read = () => heldRead(data, 'key', () => { const answer = Promise.withResolvers(); asked.push(answer); return answer.promise }, {
    ready: value => ({ status: 'ready', until: Date.now() + 1000, value }),
    failed: err => err.name === 'AbortError' ? null : { status: 'error', until: Date.now() + 1000, error: err.message },
    retryMs: 500, repaint: () => { repaints++ },
  })
  return { data, asked, read, repaints: () => repaints }
}

test('a read is loading till it answers, then held while fresh, asked once', async () => {
  const { asked, read, repaints } = reads()
  const loading = read()
  assert.equal(loading.status, 'loading')
  assert.equal(read(), loading, 'one read at a time')
  asked[0].resolve('first')
  await setImmediate()
  const ready = read()
  assert.deepEqual([ready.status, ready.value, asked.length, repaints()], ['ready', 'first', 1, 1])
  assert.equal(read(), ready)
})

test('one gone old is shown while it is read again, replaced only by what that read answers', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 })
  const { asked, read } = reads()
  read()
  asked[0].resolve('first')
  await setImmediate()
  const held = read()
  t.mock.timers.setTime(2000)
  assert.equal(read(), held, 'still shown, not blanked')
  assert.equal(held.rereading, true)
  assert.equal(read(), held)
  assert.equal(asked.length, 2, 'read again once')
  asked[1].resolve('second')
  await setImmediate()
  const next = read()
  assert.deepEqual([next.status, next.value], ['ready', 'second'])
  // Made fresh again while it is read again, as reading its next page does: kept.
  t.mock.timers.setTime(4000)
  read()
  next.until = Date.now() + 1000
  asked[2].resolve('third')
  await setImmediate()
  assert.equal(read(), next, 'what it holds kept, the answer dropped')
  assert.equal(next.rereading, false)
})

test('one whose read again fails is kept, read again a while after; one whose read again is aborted, when next shown', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 })
  const { asked, read } = reads()
  read()
  asked[0].resolve('first')
  await setImmediate()
  const held = read()
  t.mock.timers.setTime(2000)
  read()
  asked[1].reject(new Error('GitHub is down.'))
  await setImmediate()
  assert.equal(read(), held, 'kept, its value shown')
  assert.deepEqual([held.status, held.value, held.rereading, asked.length], ['ready', 'first', false, 2])
  t.mock.timers.setTime(2400)
  read()
  assert.equal(asked.length, 2, 'not before its retry is due')
  t.mock.timers.setTime(2600)
  read()
  assert.equal(asked.length, 3)
  asked[2].reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
  await setImmediate()
  assert.equal(read(), held, 'kept')
  assert.equal(asked.length, 4, 'read again as it is next shown')
})

test('a first read failing holds its error, read again once its retry is due; aborted, none', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 })
  const { data, asked, read } = reads()
  read()
  asked[0].reject(new Error('GitHub is down.'))
  await setImmediate()
  assert.deepEqual(read(), { status: 'error', until: 1000, error: 'GitHub is down.' })
  t.mock.timers.setTime(1001)
  assert.equal(read().status, 'loading', 'an error is not data to keep showing')
  asked[1].reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
  await setImmediate()
  assert.equal(data.has('key'), false)
})
