// Managed HTTP app and standalone boot. The combined launcher mounts this
// same app on e2e's listener; storage, routing and cleanup stay here.
import { type Server, createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { createOriginGate } from '../server-common/origin.ts'
import { managedStorageLines } from '../server-common/storage-log.ts'
import { runReapers, withReap } from '../server-common/reap.ts'
import { startServer } from '../server-common/standalone.ts'
import { initializeApp } from '../server-common/initialize.ts'
import { type ManagedConfig, loadManagedConfig } from './config.ts'
import { type ManagedHttpDeps, createManagedRequestHandler } from './http.ts'
import { loadManagedStatic } from './static.ts'
import { openManagedStorage } from './storage.ts'

// Housekeeping runs on ordinary traffic too, including serverless instances
// without a timer or cron. Failed sweeps retry on later traffic after a minute.
const REAP_INTERVAL_MS = 3_600_000
const REAP_RETRY_MS = 60_000

type ManagedAppOptions = Partial<Pick<ManagedHttpDeps, 'next' | 'serverInfo' | 'isShuttingDown'>>

export async function createManagedApp(config: ManagedConfig, options: ManagedAppOptions = {}) {
  return await initializeApp(rollback => assembleManagedApp(config, options, rollback))
}

async function assembleManagedApp(config: ManagedConfig, options: ManagedAppOptions, rollback: AsyncDisposableStack) {
  const storage = await openManagedStorage(config)
  const { db, avatarStore, reportStore, bundleStore, bundleCache, reportSourcesCache } = storage
  rollback.defer(() => db.close())
  const originGate = createOriginGate(config.host, config.trustProxyEnv)

  let shuttingDown = false
  const isShuttingDown = () => shuttingDown || options.isShuttingDown?.() === true
  const inFlight = new Set<Promise<unknown>>()
  function track(p: Promise<unknown>): void {
    inFlight.add(p)
    p.finally(() => inFlight.delete(p)).catch(() => {})
  }

  const serveStatic = loadManagedStatic(fileURLToPath(new URL('../out/', import.meta.url)), {
    indexOnly: options.next != null, scanServer: options.serverInfo?.deepviewScanServer ?? null,
  })
  const routeRequest = createManagedRequestHandler({
    ...options, config, db, avatarStore, reportStore, bundleStore, bundleCache, reportSourcesCache, originGate, serveStatic,
    ...('uploadStore' in storage ? { uploadStore: storage.uploadStore } : {}),
    isShuttingDown, track,
  })

  let cleanup: Promise<void> | undefined
  let nextCleanupAt = 0
  function reap(): Promise<void> {
    if (cleanup) return cleanup
    const startedAt = Date.now()
    nextCleanupAt = startedAt + REAP_INTERVAL_MS
    let sessions = 0, uploads = 0
    cleanup = runReapers({
      sessions: async () => { sessions = await db.deleteExpiredSessions(Date.now()) },
      ...('reapUploads' in storage ? { uploads: async () => { uploads = await storage.reapUploads() } } : {}),
    }).then(() => {
      nextCleanupAt = Date.now() + REAP_INTERVAL_MS
      return console.info(`managed-reaper: removed ${sessions} expired session(s), ${uploads} stale upload part(s) in ${Date.now() - startedAt}ms`)
    }, err => {
      nextCleanupAt = Date.now() + REAP_RETRY_MS
      throw err
    }).finally(() => { cleanup = undefined })
    track(cleanup)
    return cleanup
  }
  function automaticReap(): Promise<void> {
    if (isShuttingDown() || cleanup || Date.now() < nextCleanupAt) return Promise.resolve()
    return reap().catch(err => console.warn('managed-reaper: cleanup failed:', err))
  }
  async function handleRequest(req: Parameters<typeof routeRequest>[0], res: Parameters<typeof routeRequest>[1]): Promise<void> {
    const maintenance = automaticReap()
    // Send the normal response without waiting for storage housekeeping, but
    // keep the invocation alive until both finish. No detached serverless work.
    try { await routeRequest(req, res) }
    finally { await maintenance }
  }
  const gcTimer = config.serverless ? null : setInterval(() => {
    void automaticReap()
  }, REAP_INTERVAL_MS)
  rollback.defer(stop)

  function stop(): void {
    shuttingDown = true
    if (gcTimer) clearInterval(gcTimer)
  }

  async function close(): Promise<void> {
    stop()
    if (inFlight.size > 0) await Promise.allSettled([...inFlight])
    await db.close()
  }
  return { handleRequest, reap, isShuttingDown, stop, close }
}

export function logManagedStartup(config: ManagedConfig, port: number, mode = 'managed'): void {
  console.log([
    `DeepView managed server (${mode}):`,
    `  HTTP: http://${config.host}:${port}/`,
    ...managedStorageLines(config),
  ].join('\n'))
}

export async function init(config = loadManagedConfig()): Promise<Server> {
  const app = await createManagedApp(config)
  const server = createServer(withReap(app.handleRequest, { managed: app.reap }, { isShuttingDown: app.isShuttingDown }))
  let disposal: Promise<void> | undefined
  function dispose(): Promise<void> {
    if (!disposal) {
      app.stop()
      disposal = (async () => {
        try {
          if (server.listening) {
            await new Promise<void>((resolve, reject) => {
              server.close(err => { if (err) reject(err); else resolve() })
            })
          }
        } finally {
          try { await app.close() }
          finally {
            server.off('error', onError)
            server.off('close', onClose)
            server.off('listening', onListening)
          }
        }
      })()
    }
    return disposal
  }
  // Embedding hosts can await full cleanup even when they only copied the
  // request listener and never bound this server. Repeated disposal is safe.
  server[Symbol.asyncDispose] = dispose

  function onError(): void { onClose() }
  function onClose(): void {
    if (!disposal) void dispose().catch(err => { console.error('Managed server cleanup failed:', err) })
  }
  function onListening(): void {
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : config.port
    logManagedStartup(config, port)
  }
  server.on('error', onError)
  server.once('close', onClose)
  server.on('listening', onListening)
  return server
}

export async function start(): Promise<void> {
  const config = loadManagedConfig()
  const server = await init(config)
  startServer(server, config)
}

if (import.meta.main) await start()
