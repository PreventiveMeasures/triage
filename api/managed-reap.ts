import type { IncomingMessage, ServerResponse } from 'node:http'
import { createHash, timingSafeEqual } from 'node:crypto'
import { openNeonManagedDb } from '../server-managed/db-neon.ts'
import { openManagedVercelStorage } from '../server-managed/blob-vercel.ts'

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const secret = process.env['CRON_SECRET']
  const hash = (value: string) => createHash('sha256').update(value).digest()
  res.setHeader('cache-control', 'no-store')
  res.setHeader('content-type', 'application/json')
  if (!secret || typeof req.headers.authorization !== 'string'
    || !timingSafeEqual(hash(req.headers.authorization), hash(`Bearer ${secret}`))) {
    res.statusCode = 401; res.end(JSON.stringify({ error: 'unauthorized' })); return
  }
  if (req.method !== 'GET') { res.statusCode = 405; res.setHeader('allow', 'GET'); res.end(); return }
  let db
  try {
    const url = process.env['MANAGED_DATABASE_URL'] || process.env['DATABASE_URL']
    const token = process.env['BLOB_READ_WRITE_TOKEN']
    if (!url || !token) throw new Error('Managed cron requires Neon and Vercel Blob')
    db = await openNeonManagedDb(url)
    const deleted = await db.deleteExpiredSessions(Date.now())
    await (await openManagedVercelStorage(token)).reapUploads()
    res.end(JSON.stringify({ ok: true, deleted }))
  } catch (err) {
    console.error('managed cleanup failed:', err)
    res.statusCode = 500; res.end(JSON.stringify({ error: 'reap-failed' }))
  } finally { await db?.close() }
}
