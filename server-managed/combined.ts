// Compose the existing HTTP apps on e2e's listener, including its WS/SSE
// transports and static UI. Managed handles its API, discovery and page HTML;
// assets and other requests fall through to the unchanged e2e HTTP handler.
import { resolve } from 'node:path'
import type { Server } from 'node:http'
import { withReap } from '../server-common/reap.ts'
import { loadConfig } from '../server-e2e/config.ts'
import { createE2eApp } from '../server-e2e/app.ts'
import { loadManagedConfig } from './config.ts'
import { LOGIN_PATH } from './github-oauth.ts'
import { createManagedApp, logManagedStartup } from './index.ts'

export async function init(mode: 'managed+e2e' | 'e2e+managed'): Promise<Server> {
  const config = loadManagedConfig({ combined: true })
  const e2eConfig = loadConfig()
  if (!e2eConfig.neonUrl && !config.neonUrl && config.dbPath !== ':memory:' && resolve(config.dbPath) === resolve(e2eConfig.dbPath)) {
    throw new Error('MANAGED_DB_PATH must differ from e2e DB_PATH in combined mode.')
  }
  const e2e = await createE2eApp(e2eConfig)
  // Replace the assembled server's single
  // request listener; adding a second would write two responses per request.
  const handlers = e2e.httpServer.listeners('request')
  const next = handlers[0]
  if (handlers.length !== 1 || !next) throw new Error('Expected one e2e HTTP request handler')
  const managed = await createManagedApp(config, {
    next: e2e.handleRequest,
    isShuttingDown: e2e.isShuttingDown,
    serverInfo: {
      mode, managed: { loginPath: LOGIN_PATH, cookieName: config.sessionCookieName },
      ...(e2eConfig.deepviewScanServer ? { deepviewScanServer: e2eConfig.deepviewScanServer } : {}),
    },
  }).catch(async err => {
    await e2e.httpServer[Symbol.asyncDispose]()
    throw err
  })
  e2e.onShutdown(managed.close)
  e2e.httpServer.removeListener('request', next)
  e2e.httpServer.on('request', withReap(managed.handleRequest,
    { e2e: e2e.reap, managed: managed.reap }, { isShuttingDown: e2e.isShuttingDown }))
  e2e.httpServer.once('listening', () => {
    const address = e2e.httpServer.address()
    const port = typeof address === 'object' && address ? address.port : config.port
    logManagedStartup(config, port, mode)
  })
  return e2e.httpServer
}
