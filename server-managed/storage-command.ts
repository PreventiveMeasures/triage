import { loadManagedConfig } from './config.ts'
import { openManagedStorage } from './storage.ts'

// Opening storage enables encryption when a key is configured, just as server
// startup does. All work is awaited without starting an HTTP listener.
export async function storageCommand(command: string): Promise<void> {
  const storage = await openManagedStorage(loadManagedConfig())
  try {
    let status = await storage.storageEncryptionStatus()
    if (command === '--migrate-storage' && !status) throw new Error('Configure MANAGED_STORAGE_ENCRYPTION_KEY before migrating storage')
    for (;;) {
      let retryAt: number | null = null
      if (command === '--migrate-storage' && status && (!status.complete || !status.cleanupComplete)) {
        const result = await storage.migrateStorage()
        status = result
        retryAt = result?.retryAt ?? null
      }
      console.log(JSON.stringify(status ? {
        encryption: 'chacha20-poly1305', complete: status.complete === 1, cleanupComplete: status.cleanupComplete === 1,
        migrated: status.migrated, cursor: status.cursor,
        ...(retryAt === null ? {} : { retryAt }),
      } : { encryption: 'disabled' }))
      if (command !== '--migrate-storage' || !status || (status.complete && status.cleanupComplete) || retryAt !== null) break
    }
  } finally { await storage.db.close() }
}
