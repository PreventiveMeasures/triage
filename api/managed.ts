// Vercel Node function: no listener or signal handlers. Register the complete
// request lifetime, including maintenance after the HTTP response has ended.
import type { IncomingMessage, ServerResponse } from 'node:http'
import { waitUntil } from '@vercel/functions'
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
export default function managed(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // Node HTTP listeners do not await returned promises. Vercel needs waitUntil
  // to keep maintenance alive after res.end(), even though we also await it.
  const request = Promise.resolve().then(() => handler(req, res))
  waitUntil(request)
  return request
}
