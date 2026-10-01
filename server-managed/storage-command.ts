import { loadManagedConfig } from './config.ts'
import { openManagedStorage } from './storage.ts'

// Opening storage enables encryption when a key is configured, just as server
// startup does. All work is awaited without starting an HTTP listener.
export async function storageCommand(): Promise<void> {
  const storage = await openManagedStorage(loadManagedConfig())
  try {
    const status = await storage.storageEncryptionStatus()
    console.log(JSON.stringify(status ? {
      encryption: 'chacha20-poly1305', complete: status.complete === 1, cleanupComplete: status.cleanupComplete === 1,
      migrated: status.migrated, cursor: status.cursor,
    } : { encryption: 'disabled' }))
  } finally { await storage.db.close() }
}
