// Backend selection is shared by standalone, combined and function entrypoints.
import { dirname } from 'node:path'
import { parseStorageKey } from '../server-common/storage-crypto.ts'
import { createBundleCache } from './bundle-cache.ts'
import { createReportSourcesCache } from './report-sources.ts'
import { openNeonManagedDb } from './db-neon.ts'
import type { ManagedConfig } from './config.ts'
import { createEncryptedObjectStorage } from './storage-encryption.ts'
import { createManagedStores } from './storage-stores.ts'
import { createDiskObjectStorage } from './object-storage-disk.ts'
import { openVercelObjectStorage } from './object-storage-vercel.ts'
import { migrateStorage, reapStorageUploads } from './storage-maintenance.ts'

// Database-only callers (notably status) must not activate byte encryption.
export async function openManagedStorageDb(config: ManagedConfig) {
  const options = { triageHistoryLimit: config.triageHistoryLimit, storageEncryptionKey: parseStorageKey(config.storageEncryptionKey) }
  return config.neonUrl ? openNeonManagedDb(config.neonUrl, options)
    : (await import('./db.ts')).openSqliteManagedDb(config.dbPath, options)
}

export async function openManagedStorage(config: ManagedConfig) {
  const key = parseStorageKey(config.storageEncryptionKey)
  if (config.storageEncryptionMigrate && !key) throw new Error('MANAGED_STORAGE_ENCRYPTION_MIGRATE requires MANAGED_STORAGE_ENCRYPTION_KEY')
  if (config.neonUrl && !config.blobToken) throw new Error('Managed Neon mode requires BLOB_READ_WRITE_TOKEN')
  if (config.serverless && !config.neonUrl) throw new Error('Serverless managed storage requires Neon')
  const db = await openManagedStorageDb(config)
  try {
    const raw = config.neonUrl ? await openVercelObjectStorage(config.blobToken!) : createDiskObjectStorage(dirname(config.dbPath))
    // Enable before exposing stores or token writers. Concurrent first starts
    // serialize activation in the database and validate the winning key.
    if (key && !await db.getStorageEncryption()) {
      if (config.vercelPreview) throw new Error('Storage encryption must be enabled outside a Vercel preview deployment')
      await db.enableStorageEncryption()
    }
    const objects = await createEncryptedObjectStorage(raw, db, key)
    const storage = createManagedStores(objects, !config.neonUrl)
    return { ...storage, db, uploadStore: config.neonUrl ? storage.uploadStore : undefined,
      bundleCache: createBundleCache(storage.cacheStorage, db, storage.bundleStore),
      reportSourcesCache: createReportSourcesCache(storage.reportSourcesStorage, db, storage.reportStore, storage.bundleStore),
      storageEncryptionStatus: () => db.getStorageEncryption(),
      async reapStorage() {
        if (!config.storageEncryptionMigrate) return
        const state = await db.getStorageEncryption()
        if (state?.complete && state.cleanupComplete) return
        const result = await migrateStorage(raw, db, key!, { maxMs: config.storageEncryptionMigrateMaxMs })
        console.info('managed-storage-migration:', JSON.stringify({
          complete: result.complete === 1, cleanupComplete: result.cleanupComplete === 1,
          migrated: result.migrated, cursor: result.cursor, retryAt: result.retryAt,
        }))
      },
      reapUploads: () => reapStorageUploads(raw, db),
    }
  } catch (err) {
    await db.close()
    throw err
  }
}
