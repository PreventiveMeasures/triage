import type { ManagedSql } from './sql.ts'

export const BUNDLE_BUILD_TIMEOUT_MS = 180_000
// Leave time to terminate a timed-out worker before a crashed owner's slot
// becomes reusable. Expiration uses the database clock, not an instance's clock.
const LEASE_MS = BUNDLE_BUILD_TIMEOUT_MS + 60_000
export const BUNDLE_BUILD_LEASE_SCHEMA = `
CREATE TABLE IF NOT EXISTS managed_bundle_build_lease (
  slot INTEGER PRIMARY KEY CHECK (slot IN (1, 2)),
  owner TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL
) STRICT;
`

export interface BundleBuildLeaseStore {
  claimBundleBuildLease(userId: string, owner: string): Promise<boolean>
  releaseBundleBuildLease(owner: string): Promise<void>
}

export function bundleBuildLeaseMethods(db: ManagedSql): BundleBuildLeaseStore {
  return {
    // scopeManagedMethods holds SQLite's write transaction / PostgreSQL's
    // advisory transaction lock across cleanup, inspection, and admission.
    async claimBundleBuildLease(userId, owner) {
      const { now } = await db.prepare("SELECT CAST(unixepoch('subsec') * 1000 AS INTEGER) AS now").get() as { now: number }
      await db.prepare('DELETE FROM managed_bundle_build_lease WHERE expires_at <= ?').run(now)
      const leases = await db.prepare('SELECT slot, user_id AS userId FROM managed_bundle_build_lease').all() as { slot: number; userId: string }[]
      if (leases.length >= 2 || leases.some(lease => lease.userId === userId)) return false
      const slot = leases.some(lease => lease.slot === 1) ? 2 : 1
      await db.prepare('INSERT INTO managed_bundle_build_lease (slot, owner, user_id, expires_at) VALUES (?, ?, ?, ?)')
        .run(slot, owner, userId, now + LEASE_MS)
      return true
    },
    // No user FK: deleting an account must not free a still-running worker's
    // slot. A delayed/crashed owner's cleanup cannot release its successor.
    async releaseBundleBuildLease(owner) {
      await db.prepare('DELETE FROM managed_bundle_build_lease WHERE owner = ?').run(owner)
    },
  }
}
