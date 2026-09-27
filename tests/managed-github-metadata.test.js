import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { openSqliteManagedDb } from '../server-managed/db.ts'
import { checkGithubMetadataStore } from './_managed-github-metadata.js'

test('SQLite upgrades existing databases and retains GitHub metadata across restarts without eviction', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'triage-github-metadata-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'managed.db')
  await openSqliteManagedDb(path).close()
  const legacy = new DatabaseSync(path)
  legacy.exec('DROP TABLE managed_github_metadata')
  legacy.close()
  const db = openSqliteManagedDb(path)
  const merged = await checkGithubMetadataStore(db)
  await db.close()
  const reopened = openSqliteManagedDb(path)
  try { assert.deepEqual(await reopened.listGithubMetadata([merged.key]), [merged]) }
  finally { await reopened.close() }
})
