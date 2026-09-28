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
import { migrateStorage, reapEncryptedStorage, reapStorageUploads } from './storage-maintenance.ts'

export async function openManagedStorage(config: ManagedConfig) {
  const options = { triageHistoryLimit: config.triageHistoryLimit }
  const key = parseStorageKey(config.storageEncryptionKey)
  if (config.neonUrl && !config.blobToken) throw new Error('Managed Neon mode requires BLOB_READ_WRITE_TOKEN')
  if (config.serverless && !config.neonUrl) throw new Error('Serverless managed storage requires Neon')
  const db = config.neonUrl ? await openNeonManagedDb(config.neonUrl, options)
    : (await import('./db.ts')).openSqliteManagedDb(config.dbPath, options)
  try {
    const raw = config.neonUrl ? await openVercelObjectStorage(config.blobToken!) : createDiskObjectStorage(dirname(config.dbPath))
    const objects = await createEncryptedObjectStorage(raw, db, key)
    const storage = createManagedStores(objects, !config.neonUrl)
    return { ...storage, db, uploadStore: config.neonUrl ? storage.uploadStore : undefined,
      bundleCache: createBundleCache(storage.cacheStorage, db, storage.bundleStore),
      reportSourcesCache: createReportSourcesCache(storage.reportSourcesStorage, db, storage.reportStore, storage.bundleStore),
      storageEncryptionStatus: () => db.getStorageEncryption(key?.id ?? null),
      migrateStorage: (budget?: { maxObjects?: number; maxMs?: number }) => key ? migrateStorage(raw, db, key, budget) : Promise.resolve(null),
      async reapStorage() {
        if (!key) return
        await migrateStorage(raw, db, key)
        await reapEncryptedStorage(raw, db, key)
      },
      reapUploads: () => reapStorageUploads(raw, db, key),
    }
  } catch (err) {
    await db.close()
    throw err
  }
}
