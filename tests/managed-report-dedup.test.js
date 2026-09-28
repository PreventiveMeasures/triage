import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openSqliteManagedDb } from '../server-managed/db.ts'
import { checkReportDedup } from './_managed-report-dedup.js'

test('SQLite report uploads reuse content atomically and preserve legacy copies', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'managed-report-dedup-'))
  const db = openSqliteManagedDb(join(dir, 'db.sqlite'))
  t.after(async () => { await db.close(); await rm(dir, { recursive: true, force: true }) })
  await checkReportDedup(db)
})
