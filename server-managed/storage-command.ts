import { loadManagedConfig } from './config.ts'
import { openManagedStorage } from './storage.ts'

// Uses the same bounded, resumable worker as maintenance. No HTTP listener or
// background promise is needed, including when migrating remote Blob storage.
export async function storageCommand(statusOnly: boolean): Promise<void> {
  const storage = await openManagedStorage(loadManagedConfig())
  try {
    let status = await storage.storageEncryptionStatus()
    if (!status && !statusOnly) throw new Error('Set MANAGED_STORAGE_ENCRYPTION_KEY before migrating storage')
    for (;;) {
      if (!statusOnly && status && !status.complete) status = await storage.migrateStorage()
      console.log(JSON.stringify(status ? {
        encryption: 'chacha20-poly1305', complete: status.complete === 1,
        migrated: status.migrated, cursor: status.cursor,
      } : { encryption: 'disabled' }))
      if (statusOnly || !status || status.complete) break
    }
  } finally { await storage.db.close() }
}
