// Where a request's time goes, told back in its Server-Timing header, which
// DevTools shows beside the request: the database's statements and the time
// spent in its operations (sql.ts), new pooled connections and their
// handshakes (db-neon.ts), GitHub's calls (github-app.ts githubJson), and
// the whole, from the handler's start to its answer's head; an instance's
// first request marked cold. Counts and durations alone, nothing of what was
// asked; a streamed answer's head tells what was known as it was written.
import { AsyncLocalStorage } from 'node:async_hooks'
import { ServerResponse } from 'node:http'

interface Timing {
  started: number
  cold: boolean
  statements: number
  db: number; dbMs: number
  conn: number; connMs: number
  gh: number; ghMs: number
}
const requests = new AsyncLocalStorage<Timing>()
let served = false

// `work` timed, its response's head carrying what it spent where; a test's
// stand-in for a response, not a ServerResponse, is left as it is.
export function runTimed<T>(res: ServerResponse, work: () => T): T {
  const timing: Timing = { started: performance.now(), cold: !served, statements: 0, db: 0, dbMs: 0, conn: 0, connMs: 0, gh: 0, ghMs: 0 }
  served = true
  if (res instanceof ServerResponse) {
    const writeHead = res.writeHead
    res.writeHead = function (this: ServerResponse, ...args: Parameters<ServerResponse['writeHead']>) {
      if (!this.headersSent) this.setHeader('server-timing', header(timing))
      return writeHead.apply(this, args)
    } as ServerResponse['writeHead']
  }
  return requests.run(timing, work)
}

// `work`, its time counted as `kind`'s where a request is timed.
export async function timed<T>(kind: 'db' | 'conn' | 'gh', work: () => Promise<T>): Promise<T> {
  const timing = requests.getStore()
  if (!timing) return work()
  const start = performance.now()
  try { return await work() } finally {
    timing[kind]++
    timing[`${kind}Ms`] += performance.now() - start
  }
}

// A statement sent to the database, where a request is timed.
export function countStatement(): void {
  const timing = requests.getStore()
  if (timing) timing.statements++
}

function header(timing: Timing): string {
  const ms = (value: number) => value.toFixed(1)
  return [
    ...timing.db > 0 || timing.statements > 0 ? [`db;dur=${ms(timing.dbMs)};desc="${timing.statements} statements"`] : [],
    ...timing.conn > 0 ? [`conn;dur=${ms(timing.connMs)}`] : [],
    ...timing.gh > 0 ? [`gh;dur=${ms(timing.ghMs)};desc="${timing.gh} calls"`] : [],
    ...timing.cold ? ['cold;desc="first request of this instance"'] : [],
    `app;dur=${ms(performance.now() - timing.started)}`,
  ].join(', ')
}
