// Managed HTTP app and standalone boot. The combined launcher mounts this
// same app on e2e's listener; storage, routing and cleanup stay here.
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { createOriginGate } from '../server-common/origin.ts'
import { managedStorageLines } from '../server-common/storage-log.ts'
import { runReapers, withReap } from '../server-common/reap.ts'
import { type ManagedConfig, loadManagedConfig } from './config.ts'
import { type ManagedHttpDeps, createManagedRequestHandler } from './http.ts'
import { loadManagedStatic } from './static.ts'
import { openManagedStorage } from './storage.ts'

// Expired-session sweep period. Lookups already exclude expired rows
// (`WHERE expires_at > now`), so this is housekeeping, not a security control.
const SESSION_GC_INTERVAL_MS = 3_600_000

export async function createManagedApp(config: ManagedConfig, options: Partial<Pick<ManagedHttpDeps, 'next' | 'serverInfo' | 'isShuttingDown'>> = {}) {
  const storage = await openManagedStorage(config)
  const { db, avatarStore, reportStore, bundleStore, bundleCache, reportSourcesCache } = storage
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
  const handleRequest = createManagedRequestHandler({
    ...options, config, db, avatarStore, reportStore, bundleStore, bundleCache, reportSourcesCache, originGate, serveStatic,
    ...('uploadStore' in storage ? { uploadStore: storage.uploadStore } : {}),
    isShuttingDown, track,
  })

  let cleanup: Promise<void> | undefined
  function reap(): Promise<void> {
    if (cleanup) return cleanup
    cleanup = runReapers({
      sessions: () => db.deleteExpiredSessions(Date.now()),
      ...('reapUploads' in storage ? { uploads: () => storage.reapUploads() } : {}),
    }).finally(() => { cleanup = undefined })
    track(cleanup)
    return cleanup
  }
  const gcTimer = config.serverless ? null : setInterval(() => {
    void reap().catch(err => console.warn('managed: maintenance failed:', err))
  }, SESSION_GC_INTERVAL_MS)

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

export async function start(): Promise<void> {
  const config = loadManagedConfig()
  const app = await createManagedApp(config)
  const server = createServer(withReap(app.handleRequest, { managed: app.reap }, { isShuttingDown: app.isShuttingDown }))
  let closing = false
  async function shutdown(code: number): Promise<void> {
    if (closing) return
    closing = true
    app.stop()
    try { server.closeIdleConnections() } catch {}
    if (server.listening) await new Promise<void>((resolve) => { server.close(() => resolve()) })
    await app.close()
    process.exit(code)
  }
  server.on('error', (err) => { console.error('Managed server error:', err); void shutdown(1) })
  process.on('SIGINT', () => { void shutdown(0) })
  process.on('SIGTERM', () => { void shutdown(0) })

  server.listen(config.port, config.host, () => {
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : config.port
    logManagedStartup(config, port)
  })
}

if (import.meta.main) await start()
