// Vercel Node function: no listener, signal handlers, timers or detached work.
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createManagedApp } from '../server-managed/index.ts'
import { loadManagedConfig } from '../server-managed/config.ts'

let pending: ReturnType<typeof createManagedApp> | undefined
function app() {
  if (!pending) {
    const config = loadManagedConfig()
    config.serverless = true
    pending = createManagedApp(config).catch(err => { pending = undefined; throw err })
  }
  return pending
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try { await (await app()).handleRequest(req, res) }
  catch (err) {
    console.error('managed function initialization failed:', err)
    if (res.headersSent) { res.destroy(); return }
    res.writeHead(503, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify({ error: 'unavailable' }))
  }
}
