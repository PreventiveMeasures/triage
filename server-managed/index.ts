// Managed auth server boot (SYNC_MODE=managed, auth-only — no api/sync yet).
// Loads config, opens the SQLite store, wires the HTTP router, and installs a
// graceful SIGINT/SIGTERM shutdown that drains in-flight requests + closes the
// DB. Runnable directly (`node server-managed/index.ts`) via the
// `import.meta.main` gate, or through the exported `start()` (see cli.js).
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { createOriginGate } from '../server-common/origin.ts'
import { createDiskAvatarStore } from './avatar-store.ts'
import { createDiskBlobStore } from './blob-store.ts'
import { loadManagedConfig } from './config.ts'
import { openSqliteManagedDb } from './db.ts'
import { createManagedRequestHandler } from './http.ts'

// Expired-session sweep period. Lookups already exclude expired rows
// (`WHERE expires_at > now`), so this is housekeeping, not a security control.
const SESSION_GC_INTERVAL_MS = 3_600_000

export function start(): void {
  const config = loadManagedConfig()
  const db = openSqliteManagedDb(config.dbPath)
  // Avatars cache on disk beside the DB (data/avatars/<uuid>) for now.
  const avatarStore = createDiskAvatarStore(join(dirname(config.dbPath), 'avatars'))
  // Uploaded report + bundle bytes live on disk beside the DB too
  // (data/reports/<uuid>, data/bundles/<uuid>).
  const dataDir = dirname(config.dbPath)
  const reportStore = createDiskBlobStore(join(dataDir, 'reports'))
  const bundleStore = createDiskBlobStore(join(dataDir, 'bundles'))
  const originGate = createOriginGate(config.host, config.trustProxyEnv)

  let shuttingDown = false
  const inFlight = new Set<Promise<unknown>>()
  function track(p: Promise<unknown>): void {
    inFlight.add(p)
    p.finally(() => inFlight.delete(p)).catch(() => {})
  }

  const server = createServer(createManagedRequestHandler({
    config, db, avatarStore, reportStore, bundleStore, originGate, isShuttingDown: () => shuttingDown, track,
  }))

  const gcTimer = setInterval(() => {
    track(db.deleteExpiredSessions(Date.now()).catch((err) => {
      console.warn('managed: session GC failed:', err)
      return 0
    }))
  }, SESSION_GC_INTERVAL_MS)

  async function shutdown(code: number): Promise<void> {
    if (shuttingDown) return
    shuttingDown = true
    clearInterval(gcTimer)
    try { server.closeIdleConnections() } catch {}
    await new Promise<void>((resolve) => { server.close(() => resolve()) })
    if (inFlight.size > 0) await Promise.allSettled([...inFlight])
    await db.close()
    process.exit(code)
  }
  process.on('SIGINT', () => { void shutdown(0) })
  process.on('SIGTERM', () => { void shutdown(0) })

  server.listen(config.port, config.host, () => {
    console.log(`triage managed server listening on http://${config.host}:${config.port} (mode=managed, auth-only)`)
  })
}

if (import.meta.main) start()
