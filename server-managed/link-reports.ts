// Global deduplication reports live entirely in SQL. The payload is authenticated
// ciphertext bound to its row, using the deployment's existing storage key.
import { Buffer } from 'node:buffer'
import { createHash, randomUUID } from 'node:crypto'
import { type StorageKey, unwrapStorageValue, wrapStorageValue } from '../server-common/storage-crypto.ts'
import { parseLinkedFindings } from '../client/linked-findings.js'
import type { ManagedSql } from './sql.ts'
import { ManagedMutationError } from './management.ts'

export const LINK_REPORT_SCHEMA = `
CREATE TABLE IF NOT EXISTS managed_link_report (
  id TEXT PRIMARY KEY, filename TEXT NOT NULL, sha256 TEXT NOT NULL UNIQUE,
  encrypted_groups TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
  group_count INTEGER NOT NULL, finding_count INTEGER NOT NULL,
  uploaded_by TEXT REFERENCES managed_user(id) ON DELETE SET NULL,
  uploaded_by_login TEXT, uploaded_at INTEGER NOT NULL
) STRICT;
`
export interface LinkReport {
  id: string; filename: string; enabled: boolean; groupCount: number; findingCount: number
  uploadedByLogin: string | null; uploadedAt: number
}
export interface LinkReportStore {
  listLegacyLinkReports(): Promise<{ id: string; filename: string }[]>
  migrateLinkReport(id: string, content: string): Promise<boolean>
  listLinkReports(): Promise<LinkReport[]>
  getLinkReport(sessionId: string, id: string): Promise<LinkReport & { groups: string[][] }>
  getLinkRevision(): Promise<string>
  getEnabledLinkGroups(revision: string): Promise<string[][]>
  importLinkReport(sessionId: string, filename: string, content: string): Promise<{ report: LinkReport; reused: boolean }>
  setLinkReportEnabled(sessionId: string, id: string, enabled: boolean): Promise<void>
}
const columns = `id, filename, enabled, group_count AS groupCount, finding_count AS findingCount,
  uploaded_by_login AS uploadedByLogin, uploaded_at AS uploadedAt`
const identity = (id: string) => `managed_link_report.encrypted_groups:${id}`
function decryptGroups(key: StorageKey | null, id: string, payload: string): string[][] {
  if (!key) throw new ManagedMutationError(503, 'storage-encryption-required')
  const plain = unwrapStorageValue(key, identity(id), payload)
  try { return JSON.parse(plain.toString('utf8')) as string[][] } finally { plain.fill(0) }
}
export async function linkRevision(db: ManagedSql): Promise<string> {
  const rows = await db.prepare('SELECT id, sha256 FROM managed_link_report WHERE enabled = 1 ORDER BY id').all()
  return rows.length > 0 ? createHash('sha256').update(JSON.stringify(rows)).digest('base64url') : ''
}
function parseLinkReport(content: string) {
  const parsed = parseLinkedFindings(content)
  if (parsed) return parsed
  // Older managed exports may carry the normalized links envelope.
  try {
    const data = JSON.parse(content)
    if (data?.source !== 'links' || !Array.isArray(data.links) || !Array.isArray(data.findings) || data.findings.length > 0) return null
    return data.links.length === 0 ? { groups: [], skipped: 0 } : parseLinkedFindings(JSON.stringify(data.links))
  } catch { return null }
}
export function linkReportMethods(db: ManagedSql, key: StorageKey | null): LinkReportStore {
  const map = (row: Omit<LinkReport, 'enabled'> & { enabled: number }): LinkReport => ({ ...row, enabled: row.enabled === 1 })
  async function authorize(sessionId: string) {
    const user = await db.prepare(`SELECT u.id, u.login, u.role FROM managed_session s JOIN managed_user u ON u.id = s.user_id
      WHERE s.id = ? AND s.expires_at > ?`).get(sessionId, Date.now()) as { id: string; login: string; role: string } | undefined
    if (!user) throw new ManagedMutationError(401, 'unauthenticated')
    if (user.role !== 'admin') throw new ManagedMutationError(403, 'forbidden')
    return user
  }
  return {
    async listLegacyLinkReports() {
      return await db.prepare("SELECT id, filename FROM managed_report WHERE analyzer = 'links' ORDER BY id").all() as { id: string; filename: string }[]
    },
    async migrateLinkReport(id, content) {
      const row = await db.prepare(`SELECT filename, sha256, visible, uploaded_by AS uploadedBy,
        uploaded_by_login AS uploadedByLogin, uploaded_at AS uploadedAt FROM managed_report WHERE id = ? AND analyzer = 'links'`).get(id) as {
        filename: string; sha256: string; visible: number; uploadedBy: string | null; uploadedByLogin: string | null; uploadedAt: number
      } | undefined
      if (!row) return false
      if (!key) throw new Error('Managed link reports require MANAGED_STORAGE_ENCRYPTION_KEY')
      if (createHash('sha256').update(content).digest('base64url') !== row.sha256) throw new Error('Legacy link report content changed')
      const parsed = parseLinkReport(content)
      if (!parsed) throw new Error('Invalid legacy link report')
      const plain = Buffer.from(JSON.stringify(parsed.groups))
      try {
        const sha256 = createHash('sha256').update(plain).digest('base64url')
        await db.prepare(`INSERT INTO managed_link_report
          (id, filename, sha256, encrypted_groups, enabled, group_count, finding_count, uploaded_by, uploaded_by_login, uploaded_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(sha256) DO NOTHING`).run(
          id, row.filename, sha256, wrapStorageValue(key, identity(id), plain), row.visible,
          parsed.groups.length, new Set(parsed.groups.flat()).size, row.uploadedBy, row.uploadedByLogin, row.uploadedAt)
        await db.prepare('DELETE FROM managed_report WHERE id = ?').run(id)
      } finally { plain.fill(0) }
      return true
    },
    async listLinkReports() {
      return (await db.prepare(`SELECT ${columns} FROM managed_link_report ORDER BY uploaded_at DESC, id`).all() as Parameters<typeof map>[0][]).map(map)
    },
    async getLinkReport(sessionId, id) {
      await authorize(sessionId)
      const row = await db.prepare(`SELECT ${columns}, encrypted_groups AS payload FROM managed_link_report WHERE id = ?`).get(id) as (Parameters<typeof map>[0] & { payload: string }) | undefined
      if (!row) throw new ManagedMutationError(404, 'no-link-report')
      const { payload, ...report } = row
      return { ...map(report), groups: decryptGroups(key, id, payload) }
    },
    getLinkRevision: () => linkRevision(db),
    async getEnabledLinkGroups(revision) {
      if (await linkRevision(db) !== revision) throw new ManagedMutationError(409, 'deduplication-changed')
      const rows = await db.prepare('SELECT id, encrypted_groups AS payload FROM managed_link_report WHERE enabled = 1 ORDER BY id').all() as { id: string; payload: string }[]
      if (rows.length > 0 && !key) throw new Error('Managed link reports require MANAGED_STORAGE_ENCRYPTION_KEY')
      return rows.flatMap(row => decryptGroups(key, row.id, row.payload))
    },
    async importLinkReport(sessionId, filename, content) {
      const user = await authorize(sessionId)
      if (!key) throw new ManagedMutationError(503, 'storage-encryption-required')
      const parsed = parseLinkReport(content)
      if (!parsed || parsed.skipped) throw new ManagedMutationError(400, 'invalid-link-report')
      const plain = Buffer.from(JSON.stringify(parsed.groups))
      const sha256 = createHash('sha256').update(plain).digest('base64url')
      try {
        const existing = await db.prepare(`SELECT ${columns} FROM managed_link_report WHERE sha256 = ?`).get(sha256) as Parameters<typeof map>[0] | undefined
        if (existing) return { report: map(existing), reused: true }
        const id = randomUUID(), uploadedAt = Date.now()
        const findingCount = new Set(parsed.groups.flat()).size, groupCount = parsed.groups.length
        await db.prepare(`INSERT INTO managed_link_report
          (id, filename, sha256, encrypted_groups, group_count, finding_count, uploaded_by, uploaded_by_login, uploaded_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, filename, sha256, wrapStorageValue(key, identity(id), plain), groupCount, findingCount, user.id, user.login, uploadedAt)
        return { report: { id, filename, enabled: true, groupCount, findingCount, uploadedByLogin: user.login, uploadedAt }, reused: false }
      } finally { plain.fill(0) }
    },
    async setLinkReportEnabled(sessionId, id, enabled) {
      await authorize(sessionId)
      if (!(await db.prepare('UPDATE managed_link_report SET enabled = ? WHERE id = ?').run(+enabled, id)).changes) throw new ManagedMutationError(404, 'no-link-report')
    },
  }
}

// Merge complete components BEFORE projecting them onto the response. An ID
// absent from every returned report can still bridge two visible findings.
export function mergeLinkGroups(groups: readonly string[][], present?: ReadonlySet<string>): string[][] {
  const parents = new Map<string, string>()
  const root = (id: string): string => {
    if (!parents.has(id)) parents.set(id, id)
    let value = id
    while (parents.get(value) !== value) {
      parents.set(value, parents.get(parents.get(value)!)!)
      value = parents.get(value)!
    }
    return value
  }
  for (const ids of groups) {
    if (ids.length === 0) continue
    const first = root(ids[0]!)
    for (const id of ids.slice(1)) { const other = root(id); if (other !== first) parents.set(other, first) }
  }
  const merged = new Map<string, string[]>()
  for (const id of parents.keys()) {
    if (present && !present.has(id)) continue
    const key = root(id)
    const ids = merged.get(key) ?? []
    ids.push(id); merged.set(key, ids)
  }
  return [...merged.values()].filter(ids => ids.length >= 2)
}
