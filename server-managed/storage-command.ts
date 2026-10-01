import { loadManagedConfig } from './config.ts'
import { openManagedStorage } from './storage.ts'

// Explicit activation is separate from opening storage, status and migration.
// All work is awaited; the command never starts an HTTP listener.
export async function storageCommand(command: string): Promise<void> {
  const storage = await openManagedStorage(loadManagedConfig())
  try {
    let status = command === '--enable-storage-encryption' ? await storage.enableStorageEncryption() : await storage.storageEncryptionStatus()
    if (command === '--migrate-storage' && !status) throw new Error('Run --enable-storage-encryption before migrating storage')
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
