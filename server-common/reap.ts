import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'

type Handler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
type Reapers = Record<string, () => Promise<unknown>>
type Options = { secret?: string; isShuttingDown?: () => boolean }

// Start every cleanup and wait for all of them, including when one fails.
// The caller must not close storage or return success with work still running.
export async function runReapers(reapers: Reapers): Promise<void> {
  const results = await Promise.allSettled(Object.values(reapers).map(reap => Promise.resolve().then(reap)))
  const errors = results.filter(result => result.status === 'rejected').map(result => result.reason)
  if (errors.length > 0) throw new AggregateError(errors, 'Cleanup failed')
}

export function createReapHandler(reapers: Reapers, { secret = process.env['CRON_SECRET'], isShuttingDown = () => false }: Options = {}) {
  const key = randomBytes(32)
  const hash = (value: string) => createHmac('sha256', key).update(value).digest()
  const expected = secret ? hash(`Bearer ${secret}`) : null
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const send = (status: number, body: object, headers = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers })
      res.end(JSON.stringify(body))
    }
    const authorization = req.headers.authorization
    if (!expected || typeof authorization !== 'string' || !timingSafeEqual(hash(authorization), expected)) {
      send(401, { error: 'unauthorized' }); return
    }
    if (req.method !== 'GET') { send(405, { error: 'method-not-allowed' }, { allow: 'GET' }); return }
    if (isShuttingDown()) { send(503, { error: 'shutting-down' }); return }
    const startedAt = Date.now()
    try {
      await runReapers(reapers)
      send(200, { ok: true, reaped: Object.keys(reapers), ms: Date.now() - startedAt })
    } catch (err) {
      console.error('reap failed:', err)
      send(500, { error: 'reap-failed' })
    }
  }
}

// Only top-level servers compose this route. Domain routers stay unaware of
// other modes, and cleanup uses the stores those servers have already opened.
export function withReap(next: Handler, reapers: Reapers, options: Options = {}): Handler {
  const reap = createReapHandler(reapers, options)
  return (req, res) => req.url?.split('?', 1)[0] === '/api/reap' ? reap(req, res) : next(req, res)
}
