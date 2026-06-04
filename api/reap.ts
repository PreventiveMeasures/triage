// Vercel Cron entry point for the objstore orphan reaper.
//
// The relay's in-process reaper (server/objstore/init.ts) is a boot sweep plus
// a periodic setInterval — both need a long-lived process. For a serverless
// deployment (no persistent event loop to host the periodic sweep), or any
// deployment that sets OBJSTORE_REAP_DISABLED to take GC out-of-band, this
// endpoint runs ONE reapOrphans sweep per invocation. Vercel Cron hits it on a
// schedule (see vercel.json). reapOrphans is stateless, lock-free, and safe to
// run concurrently with live traffic and across replicas, so a one-shot
// function is a clean GC driver.
//
// Neon (DATABASE_URL) + Vercel Blob (BLOB_READ_WRITE_TOKEN) only — the local-FS
// / SQLite backend is single-process and reaps in-process. Opens its own
// objstore handle (the Neon HTTP callable is stateless — nothing to close, see
// server/objstore/store.ts) rather than booting the WS/SSE relay.

import type { IncomingMessage, ServerResponse } from 'node:http'
import { env } from 'node:process'
import { reapOrphans } from '../server/objstore/reaper.ts'
import { openNeonObjstore } from '../server/objstore/store-neon.ts'
import { openVercelBlobBackend } from '../server/objstore/blob-vercel.ts'

// Config read once at module load. Vercel sets env at cold start and it's
// fixed for the function instance's lifetime, so there's nothing to re-read
// per request. CRON_SECRET gates the endpoint; DATABASE_URL +
// BLOB_READ_WRITE_TOKEN select the Neon + Vercel Blob backend.
const { CRON_SECRET, DATABASE_URL, BLOB_READ_WRITE_TOKEN } = env

function send(res: ServerResponse, status: number, body: object): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // Require the Vercel-Cron bearer. When CRON_SECRET is configured, Vercel
  // sends `Authorization: Bearer ${CRON_SECRET}` on cron invocations. Fail
  // CLOSED when it's unset or mismatched, so this DB- and blob-touching GC
  // endpoint can't be triggered by arbitrary callers (reapOrphans is
  // idempotent/safe, but the endpoint still shouldn't be open). A 401 in the
  // cron logs is the signal that CRON_SECRET wasn't set on the deployment.
  if (!CRON_SECRET || req.headers['authorization'] !== `Bearer ${CRON_SECRET}`) {
    send(res, 401, { error: 'unauthorized' })
    return
  }
  if (!DATABASE_URL || !BLOB_READ_WRITE_TOKEN) {
    send(res, 500, { error: 'not-configured', detail: 'requires DATABASE_URL + BLOB_READ_WRITE_TOKEN (Neon + Vercel Blob)' })
    return
  }
  const startedAt = Date.now()
  try {
    const blob = await openVercelBlobBackend({ token: BLOB_READ_WRITE_TOKEN })
    const handle = await openNeonObjstore(DATABASE_URL, blob)
    // Handle is stateless (HTTP `neon()` callable) — nothing to close.
    await reapOrphans(handle)
    send(res, 200, { ok: true, ms: Date.now() - startedAt })
  } catch (err) {
    console.error('cron reap failed:', err instanceof Error ? (err.stack ?? err.message) : String(err))
    send(res, 500, { error: 'reap-failed' })
  }
}
