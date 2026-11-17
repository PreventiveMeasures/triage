// Jobs worked out each in a worker of its own (server-managed/worker-turns.ts):
// a worker's answer, and what one gone without it is answered for.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { workerTurns } from '../server-managed/worker-turns.ts'

class Failure extends Error {
  constructor(status, code) {
    super(code)
    this.status = status
  }
}

const turns = () => workerTurns({ what: 'test job', active: 1, waiting: 1, error: Failure, busy: 'busy', timeout: 'timeout', failed: 'failed' })
// A worker that runs `code`, `tell` there to tell its parent a thing.
const worker = code => new URL(`data:text/javascript,${encodeURIComponent(`import { parentPort } from 'node:worker_threads'\nconst tell = told => parentPort.postMessage(told)\n${code}`)}`)
const answer = told => (typeof told === 'string' ? told : null)
const early = told => (typeof told === 'number' ? `so far ${told}` : null)
const soon = () => Date.now() + 30_000
const failure = (status, code) => err => err instanceof Failure && err.status === status && err.message === code

test('a worker\'s answer is the one it tells, whatever it told to settle for before', async () => {
  const { run } = turns()
  assert.equal(await run(worker("tell('done')"), {}, answer, soon()), 'done')
  assert.equal(await run(worker("tell(1); tell(2); tell('done'); tell(3)"), {}, answer, soon(), early), 'done', 'its own, and nothing it tells after')
  await assert.rejects(run(worker('tell(1)'), {}, answer, soon()), failure(422, 'failed'), 'none taken, and none to settle for where none is asked for')
  await assert.rejects(run(worker(''), {}, answer, soon(), early), failure(422, 'failed'), 'gone having told nothing')
})

test('a worker gone before its answer, its deadline come or itself ended, is answered for as far as it told', async () => {
  const { run, inTurn } = turns()
  const hung = 'for (;;) {}'
  assert.equal(await run(worker(`tell(1); tell(2); ${hung}`), {}, answer, Date.now() + 500, early), 'so far 2', 'past its deadline, the last it told to settle for')
  await assert.rejects(run(worker(hung), {}, answer, Date.now() + 500, early), failure(504, 'timeout'), 'having told none, it timed out')
  assert.equal(await run(worker('tell(1); process.exit(1)'), {}, answer, soon(), early), 'so far 1', 'ended before its answer')
  assert.equal(await run(worker('tell(1); tell({})'), {}, answer, soon(), early), 'so far 1', 'or telling an answer that is none')
  assert.equal(await inTurn(soon(), () => run(worker(`tell(7); ${hung}`), {}, answer, Date.now() + 500, early)), 'so far 7', 'its turn given up once it is gone')
  assert.equal(await inTurn(soon(), () => run(worker("tell('next')"), {}, answer, soon())), 'next')
})
