import { loadManagedConfig } from './config.ts'
import { openManagedStorageDb } from './storage.ts'

// Require the deployment mode: DB_PATH belongs to e2e in combined deployments.
// Read the database requirement without opening bytes or enabling encryption.
export async function storageCommand(mode: string | undefined): Promise<void> {
  if (mode !== 'managed' && mode !== 'managed-e2e' && mode !== 'e2e-managed') throw new Error('Storage status requires a deployment mode: --storage-encryption-status managed|managed-e2e|e2e-managed')
  const db = await openManagedStorageDb(loadManagedConfig({ combined: mode !== 'managed' }))
  try {
    const status = await db.getStorageEncryption()
    console.log(JSON.stringify(status ? {
      encryption: 'chacha20-poly1305', complete: status.complete === 1, cleanupComplete: status.cleanupComplete === 1,
      migrated: status.migrated, cursor: status.cursor,
    } : { encryption: 'disabled' }))
  } finally { await db.close() }
}
