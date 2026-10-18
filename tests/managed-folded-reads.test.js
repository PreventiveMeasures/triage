import { test } from 'node:test'
import { openSqliteManagedDb } from '../server-managed/db.ts'
import { checkFoldedReads } from './_managed-folded-reads.js'

test('SQLite reads folded into one statement answer as the reads they fold', async t => {
  const db = openSqliteManagedDb(':memory:')
  t.after(() => db.close())
  await checkFoldedReads(db)
})
