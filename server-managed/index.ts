// Managed HTTP app and standalone boot. The combined launcher mounts this
// same app on e2e's listener; storage, routing and cleanup stay here.
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createOriginGate } from '../server-common/origin.ts'
import { createDiskAvatarStore } from './avatar-store.ts'
import { createDiskBundleCache } from './bundle-cache.ts'
import { createDiskBlobStore } from './blob-store.ts'
import { createDiskBundleStore } from './bundle-store.ts'
import { type ManagedConfig, loadManagedConfig } from './config.ts'
import { openSqliteManagedDb } from './db.ts'
import { type ManagedHttpDeps, createManagedRequestHandler } from './http.ts'
import { loadManagedStatic } from './static.ts'

// Expired-session sweep period. Lookups already exclude expired rows
// (`WHERE expires_at > now`), so this is housekeeping, not a security control.
const SESSION_GC_INTERVAL_MS = 3_600_000

export function createManagedApp(config: ManagedConfig, options: Partial<Pick<ManagedHttpDeps, 'next' | 'serverInfo' | 'isShuttingDown'>> = {}) {
  const db = openSqliteManagedDb(config.dbPath, { triageHistoryLimit: config.triageHistoryLimit })
  // Avatars cache on disk beside the DB (data/avatars/<uuid>) for now.
  const avatarStore = createDiskAvatarStore(join(dirname(config.dbPath), 'avatars'))
  // Uploaded report + bundle bytes live on disk beside the DB too
  // (data/reports/<uuid>, data/bundles/<uuid>[.map.br]).
  const dataDir = dirname(config.dbPath)
  const reportStore = createDiskBlobStore(join(dataDir, 'reports'))
  const bundleStore = createDiskBundleStore(join(dataDir, 'bundles'))
  const bundleCache = createDiskBundleCache(join(dataDir, 'cache', 'bundles'), db, bundleStore)
  const originGate = createOriginGate(config.host, config.trustProxyEnv)

  let shuttingDown = false
  const inFlight = new Set<Promise<unknown>>()
  function track(p: Promise<unknown>): void {
    inFlight.add(p)
    p.finally(() => inFlight.delete(p)).catch(() => {})
  }

  const serveStatic = loadManagedStatic(fileURLToPath(new URL('../out/', import.meta.url)), {
    indexOnly: options.next != null, scanServer: options.serverInfo?.deepviewScanServer ?? null,
  })
  const handleRequest = createManagedRequestHandler({
    ...options, config, db, avatarStore, reportStore, bundleStore, bundleCache, originGate, serveStatic,
    isShuttingDown: () => shuttingDown || options.isShuttingDown?.() === true, track,
  })

  const gcTimer = setInterval(() => {
    track(db.deleteExpiredSessions(Date.now()).catch((err) => {
      console.warn('managed: session GC failed:', err)
      return 0
    }))
  }, SESSION_GC_INTERVAL_MS)

  function stop(): void {
    shuttingDown = true
    clearInterval(gcTimer)
  }

  async function close(): Promise<void> {
    stop()
    if (inFlight.size > 0) await Promise.allSettled([...inFlight])
    await db.close()
  }
  return { handleRequest, stop, close }
}

export function start(): void {
  const config = loadManagedConfig()
  const app = createManagedApp(config)
  const server = createServer(app.handleRequest)
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
    console.log(`triage managed server listening on http://${config.host}:${port} (mode=managed)`)
  })
}

if (import.meta.main) start()
