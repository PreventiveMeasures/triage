// Vercel Node function: no listener, signal handlers or detached work. Feed
// timers live only inside their awaited, bounded streaming request.
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createManagedApp } from '../server-managed/index.ts'
import { loadManagedConfig } from '../server-managed/config.ts'
import { withReap } from '../server-common/reap.ts'

let pending: ReturnType<typeof createManagedApp> | undefined
function app() {
  if (!pending) {
    const config = loadManagedConfig()
    config.serverless = true
    pending = createManagedApp(config).catch(err => { pending = undefined; throw err })
  }
  return pending
}

async function handleManaged(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try { await (await app()).handleRequest(req, res) }
  catch (err) {
    console.error('managed function initialization failed:', err)
    if (res.headersSent) { res.destroy(); return }
    res.writeHead(503, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify({ error: 'unavailable' }))
  }
}

const handler = withReap(handleManaged, { managed: async () => { await (await app()).reap() } })
export default handler
