// Backend selection is shared by standalone, combined and function entrypoints.
import { dirname, join } from 'node:path'
import { createDiskAvatarStore } from './avatar-store.ts'
import { createDiskBlobStore } from './blob-store.ts'
import { createDiskBundleStore } from './bundle-store.ts'
import { createBundleCache, createDiskBundleCache } from './bundle-cache.ts'
import { openManagedVercelStorage } from './blob-vercel.ts'
import { openNeonManagedDb } from './db-neon.ts'
import type { ManagedConfig } from './config.ts'

export async function openManagedStorage(config: ManagedConfig) {
  const options = { triageHistoryLimit: config.triageHistoryLimit }
  if (config.neonUrl) {
    if (!config.blobToken) throw new Error('Managed Neon mode requires BLOB_READ_WRITE_TOKEN')
    const storage = await openManagedVercelStorage(config.blobToken)
    const db = await openNeonManagedDb(config.neonUrl, options)
    return { ...storage, db, bundleCache: createBundleCache(storage.cacheStorage, db, storage.bundleStore) }
  }
  if (config.serverless) throw new Error('Serverless managed storage requires Neon')
  const { openSqliteManagedDb } = await import('./db.ts')
  const db = openSqliteManagedDb(config.dbPath, options)
  const dir = dirname(config.dbPath)
  const reportStore = createDiskBlobStore(join(dir, 'reports'))
  const bundleStore = createDiskBundleStore(join(dir, 'bundles'))
  return { db, reportStore, bundleStore,
    avatarStore: createDiskAvatarStore(join(dir, 'avatars')),
    bundleCache: createDiskBundleCache(join(dir, 'cache', 'bundles'), db, bundleStore),
  }
}
