// Work done in workers of its own, off the event loop (npm-delta.ts,
// rename-diff.ts, type-only.ts): as many at once per process as `active`,
// those waiting their turn past them as many as `waiting`, any more refused
// (429 `busy`), each waiting until its deadline at most (504 `timeout`); a
// worker given until its deadline too, then terminated (504 `timeout`). One
// that can't start is refused (503 `unavailable`), and one gone without an
// answer `accept` takes fails (422 `failed`), each as `error` tells it; `what`
// names them in the log.
import { Worker, type WorkerOptions } from 'node:worker_threads'

export function workerTurns({ what, active, waiting, error: Failure, busy, timeout, failed }: {
  what: string; active: number; waiting: number; error: new (status: number, code: string) => Error; busy: string; timeout: string; failed: string
}) {
  let running = 0
  const queued: Array<() => void> = []
  // A worker's turn, waited for behind those running until `deadline`; given
  // up, it goes to the next one waiting.
  async function turn(deadline: number): Promise<void> {
    if (running < active) { running++; return }
    if (queued.length >= waiting) throw new Failure(429, busy)
    await new Promise<void>((resolve, reject) => {
      const next = () => { clearTimeout(timer); resolve() }
      const timer = setTimeout(() => {
        queued.splice(queued.indexOf(next), 1)
        reject(new Failure(504, timeout))
      }, deadline - Date.now())
      queued.push(next)
    })
  }
  function done() {
    const next = queued.shift()
    if (next) next()
    else running--
  }
  return {
    // `work` done in its turn, held till it settles.
    async inTurn<T>(deadline: number, work: () => Promise<T>): Promise<T> {
      await turn(deadline)
      try { return await work() } finally { done() }
    },
    // The answer of a worker of `url`, as `accept` takes it, or null where
    // it doesn't: settled once the worker is gone, so that its turn is given
    // up only then.
    run<T>(url: URL, options: WorkerOptions, accept: (told: unknown) => T | null, deadline: number): Promise<T> {
      let worker: Worker
      try { worker = new Worker(url, options) } catch (err) {
        console.warn(`managed: a ${what} could not start:`, err)
        throw new Failure(503, 'unavailable')
      }
      return new Promise((resolve, reject) => {
        let answer: T | null = null, failure = new Failure(422, failed)
        const timer = setTimeout(() => { failure = new Failure(504, timeout); void worker.terminate() }, deadline - Date.now())
        worker.once('message', (told: unknown) => {
          answer = accept(told)
          void worker.terminate()
        })
        worker.once('error', err => { console.warn(`managed: a ${what} failed:`, err) })
        // Gone: answered, run out of memory, or terminated.
        worker.once('exit', () => {
          clearTimeout(timer)
          if (answer === null) reject(failure)
          else resolve(answer)
        })
      })
    },
  }
}
