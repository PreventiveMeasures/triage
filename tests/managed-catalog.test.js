import { test } from 'node:test'
import { openSqliteManagedDb } from '../server-managed/db.ts'
import { checkManagementCatalog } from './_managed-catalog.js'

test('management catalog snapshots preserve ownership, path grants, links and revocation', async t => {
  const db = openSqliteManagedDb(':memory:')
  t.after(() => db.close())
  await checkManagementCatalog(db)
})
