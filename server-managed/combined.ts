// Compose the existing HTTP apps on e2e's listener, including its WS/SSE
// transports and static UI. Managed handles only its routes plus discovery;
// every other request falls through to the unchanged e2e HTTP handler.
import { resolve } from 'node:path'
import { loadConfig } from '../server-e2e/config.ts'
import { loadManagedConfig } from './config.ts'
import { LOGIN_PATH } from './github-oauth.ts'
import { createManagedApp } from './index.ts'

export async function start(mode: 'managed+e2e' | 'e2e+managed'): Promise<void> {
  const config = loadManagedConfig({ combined: true })
  const e2eConfig = loadConfig()
  if (!e2eConfig.neonUrl && config.dbPath !== ':memory:' && resolve(config.dbPath) === resolve(e2eConfig.dbPath)) {
    throw new Error('MANAGED_DB_PATH must differ from e2e DB_PATH in combined mode.')
  }
  const e2e = await import('../server-e2e/index.ts')
  // index.ts exports its assembled server for wrappers. Replace its single
  // request listener; adding a second would write two responses per request.
  const handlers = e2e.httpServer.listeners('request')
  const next = handlers[0]
  if (handlers.length !== 1 || !next) throw new Error('Expected one e2e HTTP request handler')
  const managed = createManagedApp(config, {
    next: (req, res) => { next.call(e2e.httpServer, req, res) },
    isShuttingDown: e2e.isShuttingDown,
    serverInfo: {
      mode, managed: { loginPath: LOGIN_PATH, cookieName: config.sessionCookieName },
      ...(e2eConfig.deepviewScanServer ? { deepviewScanServer: e2eConfig.deepviewScanServer } : {}),
    },
  })
  e2e.onShutdown(managed.close)
  e2e.httpServer.removeListener('request', next)
  e2e.httpServer.on('request', managed.handleRequest)
  console.log(`triage combined server: mode=${mode}, managed db: ${config.dbPath}`)
  e2e.start()
}
