// E2e-only Vercel deployment: no persistent relay is running in this function.
// The managed deployment routes /api/reap through its top-level app instead.
import { createReapHandler } from '../server-common/reap.ts'
import { databaseUrls } from '../server-common/database-config.ts'
import { reapOrphans } from '../server-e2e/objstore/reaper.ts'
import { openNeonObjstore } from '../server-e2e/objstore/store-neon.ts'
import { openVercelBlobBackend } from '../server-e2e/objstore/blob-vercel.ts'

const handler = createReapHandler({ e2e: async () => {
  const url = databaseUrls().e2e
  const token = process.env['BLOB_READ_WRITE_TOKEN']
  if (!url || !token) throw new Error('E2e cron requires DATABASE_URL or E2E_DATABASE_URL, plus BLOB_READ_WRITE_TOKEN')
  const blob = await openVercelBlobBackend({ token })
  // Stateless Neon HTTP handle: nothing to close, no relay listener or timer.
  await reapOrphans(await openNeonObjstore(url, blob))
} })
export default handler
