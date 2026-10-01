// Exercise the same raw backend, encryption boundary and stores as production.
import { openSqliteManagedDb } from '../server-managed/db.ts'
import { openVercelObjectStorage } from '../server-managed/object-storage-vercel.ts'
import { createEncryptedObjectStorage } from '../server-managed/storage-encryption.ts'
import { createManagedStores } from '../server-managed/storage-stores.ts'
import { reapStorageUploads } from '../server-managed/storage-maintenance.ts'

export async function managedStores(t, raw, { db, key = null, disk = false } = {}) {
  if (!db) {
    db = openSqliteManagedDb(':memory:', { storageEncryptionKey: key })
    t.after(() => db.close())
  }
  const stores = createManagedStores(await createEncryptedObjectStorage(raw, db, key), disk)
  return { ...stores, db, raw, reapUploads: now => reapStorageUploads(raw, db, now) }
}
export async function vercelStores(t, token, sdk, db) {
  return managedStores(t, await openVercelObjectStorage(token, sdk), { db })
}
